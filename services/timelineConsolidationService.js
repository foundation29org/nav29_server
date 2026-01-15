'use strict';

/**
 * Timeline Consolidation Service
 * 
 * Genera un timeline consolidado a partir de eventos crudos y chunks.
 * Elimina duplicados, agrupa por concepto clínico y crea una narrativa clara.
 */

const { createModels } = require('./langchain');
const Events = require('../models/events');
const Document = require('../models/document');
const azure_blobs = require('./f29azure');
const crypt = require('./crypt');
const insights = require('./insights');
const { pull } = require('langchain/hub');
const { ChatPromptTemplate } = require('@langchain/core/prompts');

/**
 * Genera un timeline consolidado para un paciente
 * @param {string} patientId - ID del paciente
 * @param {string} userLang - Idioma del usuario (para traducción)
 * @returns {Object} - Timeline consolidado
 */
async function generateConsolidatedTimeline(patientId, userLang = 'es') {
  const startTime = Date.now();
  console.log(`[Timeline] Generando timeline consolidado para paciente ${patientId}`);

  try {
    // 1. Obtener eventos crudos de la BD
    const rawEvents = await Events.find({
      createdBy: patientId,
      status: { $ne: 'deleted' }
    }).lean().exec();

    console.log(`[Timeline] ${rawEvents.length} eventos crudos obtenidos`);

    if (rawEvents.length === 0) {
      return {
        success: true,
        generatedAt: new Date().toISOString(),
        milestones: [],
        chronicConditions: [],
        currentMedications: [],
        stats: { rawEvents: 0, consolidatedMilestones: 0 }
      };
    }

    // 2. Obtener resúmenes de documentos para contexto adicional
    const containerName = crypt.getContainerName(patientId);
    const documents = await Document.find({ createdBy: patientId }).lean();
    
    let documentSummaries = [];
    try {
      const summaryPromises = documents.slice(0, 10).map(async (doc) => {
        try {
          const summaryPath = doc.url.replace(/\/[^/]*$/, '/summary_translated.txt');
          const summary = await azure_blobs.downloadBlob(containerName, summaryPath);
          return {
            filename: doc.url.split('/').pop(),
            date: doc.originaldate || doc.date,
            summary: summary ? summary.substring(0, 500) : null
          };
        } catch {
          return null;
        }
      });
      documentSummaries = (await Promise.all(summaryPromises)).filter(s => s && s.summary);
    } catch (err) {
      console.warn('[Timeline] Error obteniendo resúmenes:', err.message);
    }

    // 3. Preparar datos para el LLM
    const eventsForPrompt = rawEvents.map(e => ({
      name: e.name,
      type: e.key,
      date: e.date ? new Date(e.date).toISOString().split('T')[0] : null,
      dateConfidence: e.dateConfidence || 'missing'
    }));

    // 4. Llamar al LLM para consolidar
    const { gpt4omini } = createModels('default', 'gpt4omini');
    
    let consolidationPrompt;
    try {
      consolidationPrompt = await pull('foundation29/timeline_consolidation_v1');
    } catch {
      console.warn('[Timeline] Prompt no encontrado en LangSmith, usando fallback local');
      consolidationPrompt = ChatPromptTemplate.fromMessages([
        ["system", `You are a medical data curator specializing in creating clear, consolidated clinical timelines.

Your task is to transform a list of raw medical events (which may contain duplicates and noise) into a clean, organized timeline.

### RULES:

1. **DEDUPLICATE**: Merge events that refer to the same medical concept, even if worded differently.
   - "Colecistectomía", "Cholecystectomy", "Gallbladder removal" → ONE event
   - "Metástasis hepática de tumor neuroendocrino" appearing 5 times → ONE event with the earliest confirmed date

2. **INHERIT DATES**: If an event appears multiple times with different dates:
   - Use the EARLIEST confirmed date as the event date
   - If no confirmed date exists, mark as "undated"

3. **CATEGORIZE**:
   - **Milestones**: One-time events (surgeries, diagnoses, hospitalizations)
   - **Chronic Conditions**: Ongoing conditions without specific start date
   - **Current Medications**: Active medications (from most recent mentions)

4. **PRIORITIZE**: Keep only clinically significant events:
   - YES: Diagnoses, surgeries, major treatments, hospitalizations, significant test results
   - NO: Routine checkups, normal findings, minor symptoms, negative findings

5. **LIMIT**: Maximum 30 milestones, 10 chronic conditions, 10 current medications

6. **LANGUAGE**: Respond in the same language as the input events.

7. **DATES**: Use numeric month (1-12) for consistent sorting across languages.

### OUTPUT FORMAT (JSON):
{{
  "milestones": [
    {{
      "year": 2017,
      "month": 3,
      "events": [
        {{ "icon": "💉", "title": "Resección quirúrgica de tumor neuroendocrino", "type": "procedure", "details": "Ki-67: 5%" }}
      ]
    }}
  ],
  "chronicConditions": [
    {{ "name": "Pancreatitis crónica", "since": "2013" }}
  ],
  "currentMedications": [
    {{ "name": "Everolimus 10mg", "since": "Abril 2024" }}
  ]
}}`],
        ["human", `Raw events:
{events}

Document summaries for additional context:
{summaries}

Generate the consolidated timeline:`]
      ]);
    }

    const chain = consolidationPrompt.pipe(gpt4omini);
    
    const result = await chain.invoke({
      events: JSON.stringify(eventsForPrompt, null, 2),
      summaries: documentSummaries.map(s => `[${s.filename}, ${s.date}]: ${s.summary}`).join('\n\n')
    });

    // 5. Parsear respuesta
    let consolidatedTimeline;
    try {
      let content = result.content || result;
      if (typeof content === 'string') {
        // Limpiar posibles bloques de código
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        consolidatedTimeline = JSON.parse(content);
      } else {
        consolidatedTimeline = content;
      }
    } catch (parseError) {
      console.error('[Timeline] Error parseando respuesta del LLM:', parseError.message);
      // Fallback: devolver eventos agrupados sin consolidación
      return generateFallbackTimeline(rawEvents);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Timeline] Timeline consolidado en ${elapsed}s: ${consolidatedTimeline.milestones?.length || 0} hitos`);

    // Ordenar milestones por fecha descendente (más reciente primero)
    let sortedMilestones = consolidatedTimeline.milestones || [];
    if (sortedMilestones.length > 0) {
      sortedMilestones = sortedMilestones.sort((a, b) => {
        // Si no hay año, ponerlo al final
        if (!a.year) return 1;
        if (!b.year) return -1;
        
        // Comparar años (descendente)
        if (b.year !== a.year) return b.year - a.year;
        
        // Si mismo año, comparar meses (numéricos 1-12)
        const monthA = typeof a.month === 'number' ? a.month : parseInt(a.month) || 0;
        const monthB = typeof b.month === 'number' ? b.month : parseInt(b.month) || 0;
        
        return monthB - monthA;
      });
    }

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      milestones: sortedMilestones,
      chronicConditions: consolidatedTimeline.chronicConditions || [],
      currentMedications: consolidatedTimeline.currentMedications || [],
      stats: {
        rawEvents: rawEvents.length,
        consolidatedMilestones: countMilestoneEvents(consolidatedTimeline.milestones),
        processingTimeSeconds: parseFloat(elapsed)
      }
    };

  } catch (error) {
    insights.error({ message: 'Error generando timeline consolidado', error: error.message });
    console.error('[Timeline] Error:', error);
    throw error;
  }
}

/**
 * Cuenta el total de eventos en los milestones
 */
function countMilestoneEvents(milestones) {
  if (!milestones || !Array.isArray(milestones)) return 0;
  return milestones.reduce((total, m) => total + (m.events?.length || 0), 0);
}

/**
 * Genera un timeline de fallback agrupando eventos sin LLM
 */
function generateFallbackTimeline(rawEvents) {
  const milestonesByYear = {};
  const chronicConditions = [];
  const currentMedications = [];

  rawEvents.forEach(event => {
    if (!event.date) {
      // Eventos sin fecha van a condiciones crónicas
      if (event.key === 'diagnosis') {
        chronicConditions.push({ name: event.name, since: 'Desconocido' });
      } else if (event.key === 'medication') {
        currentMedications.push({ name: event.name, since: 'Desconocido' });
      }
      return;
    }

    const date = new Date(event.date);
    const year = date.getFullYear();
    const month = date.toLocaleString('es-ES', { month: 'short' });

    const key = `${year}-${month}`;
    if (!milestonesByYear[key]) {
      milestonesByYear[key] = {
        year,
        month,
        events: []
      };
    }

    const icon = getEventIcon(event.key);
    milestonesByYear[key].events.push({
      icon,
      title: event.name,
      type: event.key
    });
  });

  // Convertir a array ordenado
  const milestones = Object.values(milestonesByYear)
    .sort((a, b) => b.year - a.year || b.month.localeCompare(a.month));

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    milestones,
    chronicConditions: chronicConditions.slice(0, 10),
    currentMedications: currentMedications.slice(0, 10),
    stats: {
      rawEvents: rawEvents.length,
      consolidatedMilestones: countMilestoneEvents(milestones),
      fallback: true
    }
  };
}

function getEventIcon(type) {
  const icons = {
    'diagnosis': '🩺',
    'treatment': '💉',
    'test': '🔬',
    'appointment': '📅',
    'symptom': '🤒',
    'medication': '💊',
    'other': '🔍'
  };
  return icons[type] || '📌';
}

/**
 * Obtiene el timeline cacheado o genera uno nuevo
 * @param {string} patientId - ID del paciente
 * @param {boolean} forceRegenerate - Forzar regeneración
 * @returns {Object} - Timeline consolidado
 */
async function getOrGenerateTimeline(patientId, userLang = 'es', forceRegenerate = false) {
  const containerName = crypt.getContainerName(patientId);
  const cachePath = `timeline_consolidated_${userLang}.json`;

  // Intentar obtener del caché
  if (!forceRegenerate) {
    try {
      const cached = await azure_blobs.downloadBlob(containerName, cachePath);
      if (cached) {
        const timeline = JSON.parse(cached);
        // Verificar que no sea muy antiguo (más de 24 horas)
        const generatedAt = new Date(timeline.generatedAt);
        const hoursSinceGeneration = (Date.now() - generatedAt.getTime()) / (1000 * 60 * 60);
        
        if (hoursSinceGeneration < 24) {
          console.log('[Timeline] Usando timeline cacheado');
          timeline.fromCache = true;
          return timeline;
        }
      }
    } catch {
      // No hay caché o error al leer, generar nuevo
    }
  }

  // Generar nuevo timeline
  const timeline = await generateConsolidatedTimeline(patientId, userLang);

  // Guardar en caché
  try {
    await azure_blobs.createBlob(containerName, cachePath, JSON.stringify(timeline));
    console.log('[Timeline] Timeline cacheado guardado');
  } catch (cacheError) {
    console.warn('[Timeline] Error guardando caché:', cacheError.message);
  }

  return timeline;
}

/**
 * Invalida el caché del timeline (llamar cuando se suban nuevos documentos)
 */
async function invalidateTimelineCache(patientId) {
  const containerName = crypt.getContainerName(patientId);
  try {
    // Intentar eliminar ambos idiomas comunes
    await azure_blobs.deleteBlob(containerName, 'timeline_consolidated_es.json').catch(() => {});
    await azure_blobs.deleteBlob(containerName, 'timeline_consolidated_en.json').catch(() => {});
    console.log('[Timeline] Caché invalidado para paciente', patientId);
  } catch (err) {
    console.warn('[Timeline] Error invalidando caché:', err.message);
  }
}

module.exports = {
  generateConsolidatedTimeline,
  getOrGenerateTimeline,
  invalidateTimelineCache
};
