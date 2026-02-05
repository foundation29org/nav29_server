'use strict';

/**
 * Event Filter Service (AI-powered)
 * 
 * Filtra y agrega eventos médicos usando IA.
 * Funciona en cualquier idioma - la IA decide qué es relevante.
 */

const { createModels } = require('./langchain');
const insights = require('./insights');

/**
 * Usa IA para filtrar y agregar eventos, eliminando ruido y duplicados
 * @param {Array} events - Lista de eventos a procesar
 * @param {Object} options - Opciones
 * @returns {Object} - { events: eventos procesados, stats: estadísticas }
 */
async function filterAndAggregateEvents(events, options = {}) {
  const { maxEvents = 60 } = options;

  if (!Array.isArray(events) || events.length === 0) {
    return { 
      events: [], 
      stats: { original: 0, final: 0, reductionPercent: 0 } 
    };
  }

  // Si hay pocos eventos, no vale la pena el costo de la IA
  if (events.length <= 15) {
    return {
      events: events,
      stats: { original: events.length, final: events.length, reductionPercent: 0 }
    };
  }

  try {
    // gpt-4.1-mini: mejor precisión en filtrado/comparación de eventos
    const model = createModels('eventFilter', 'gpt-4.1-mini')['gpt-4.1-mini'];

    const prompt = `You are a medical data curator. Your task is to:
1. FILTER: Remove noise (negative findings, normal values, incidental findings, meaningless text)
2. DEDUPLICATE: Merge events that refer to the same medical concept
3. PRIORITIZE: Keep the most clinically relevant events

INPUT EVENTS (${events.length} total):
${JSON.stringify(events, null, 2)}

RULES:
- REMOVE: Negative findings ("no evidence", "denies", "absent"), normal values, incidental findings, text < 5 chars
- KEEP: Diagnoses, medications, procedures, surgeries, hospitalizations, allergies, abnormal results
- MERGE: Events referring to the same concept (e.g., "Type 2 diabetes" = "Diabetes mellitus tipo 2")
- MAX OUTPUT: ${maxEvents} events

OUTPUT FORMAT - Respond ONLY with a JSON array of the filtered/merged events:
[
  {"name": "event description", "type": "diagnosis|medication|symptom|procedure|other", "date": "YYYY-MM-DD or null"},
  ...
]`;

    const response = await model.invoke(prompt);
    
    let filteredEvents;
    try {
      let content = response.content || '';
      if (content.includes('```json')) {
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      } else if (content.includes('```')) {
        content = content.replace(/```\n?/g, '');
      }
      filteredEvents = JSON.parse(content.trim());
    } catch (parseError) {
      console.error('[EventFilter] Error parsing AI response:', parseError.message);
      insights.error({ message: '[EventFilter] Error parsing AI response', error: parseError.message, textPreview: content?.substring(0, 300), originalEventsCount: events.length });
      // Fallback: devolver eventos sin filtrar (limitados)
      return {
        events: events.slice(0, maxEvents),
        stats: { original: events.length, final: Math.min(events.length, maxEvents), reductionPercent: 0 }
      };
    }

    const finalEvents = Array.isArray(filteredEvents) ? filteredEvents.slice(0, maxEvents) : events.slice(0, maxEvents);
    const reductionPercent = events.length > 0 
      ? Math.round(((events.length - finalEvents.length) / events.length) * 100) 
      : 0;

    console.log(`[EventFilter] ${events.length} → ${finalEvents.length} eventos (${reductionPercent}% reducción)`);

    return {
      events: finalEvents,
      stats: {
        original: events.length,
        final: finalEvents.length,
        reductionPercent
      }
    };

  } catch (error) {
    insights.error({ message: 'Error in AI event filtering', error: error.message });
    // Fallback: devolver eventos sin filtrar (limitados)
    return {
      events: events.slice(0, maxEvents),
      stats: { original: events.length, final: Math.min(events.length, maxEvents), reductionPercent: 0 }
    };
  }
}

module.exports = {
  filterAndAggregateEvents
};
