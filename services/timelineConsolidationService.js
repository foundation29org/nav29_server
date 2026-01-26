'use strict';

/**
 * Timeline Consolidation Service
 * 
 * Genera un timeline consolidado a partir de eventos crudos y chunks.
 * Elimina duplicados, agrupa por concepto clínico y crea una narrativa clara.
 * 
 * MEJORA: Usa búsquedas RAG para validar medicamentos actuales, condiciones crónicas
 * y eventos del timeline antes de generar el consolidado.
 */

const { createModels } = require('./langchain');
const Events = require('../models/events');
const Document = require('../models/document');
const azure_blobs = require('./f29azure');
const crypt = require('./crypt');
const insights = require('./insights');
const { pull } = require('langchain/hub');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { retrieveChunks, RETRIEVAL_PLANS } = require('./retrievalService');

/**
 * Realiza búsquedas RAG para validar información antes de consolidar
 * @param {string} patientId - ID del paciente
 * @returns {Object} - Contexto validado por RAG
 */
async function getRAGValidatedContext(patientId) {
  console.log('[Timeline] Obteniendo contexto validado por RAG...');
  const startTime = Date.now();

  // Definir las 3 búsquedas RAG en paralelo (queries en inglés para mejor embedding matching)
  const ragQueries = [
    {
      key: 'currentMedications',
      query: 'Complete list of current medications the patient is taking, including dosage and frequency',
      plan: RETRIEVAL_PLANS.MEDICATION
    },
    {
      key: 'chronicConditions',
      query: 'Active chronic diseases, confirmed diagnoses and persistent medical conditions of the patient',
      plan: RETRIEVAL_PLANS.FACTUAL
    },
    {
      key: 'timelineEvents',
      query: 'Important medical events: surgeries, hospitalizations, major diagnoses, significant treatments',
      plan: RETRIEVAL_PLANS.TREND
    }
  ];

  try {
    // Ejecutar las 3 búsquedas en paralelo
    const ragResults = await Promise.all(
      ragQueries.map(async ({ key, query, plan }) => {
        try {
          const chunks = await retrieveChunks(query, patientId, plan);
          // Limitar a los chunks más relevantes
          const topChunks = chunks.slice(0, plan.evidence_budget);
          return {
            key,
            chunks: topChunks.map(c => ({
              content: c.pageContent,
              filename: c.metadata.filename,
              date: c.metadata.reportDate
            }))
          };
        } catch (err) {
          console.warn(`[Timeline] Error en búsqueda RAG para ${key}:`, err.message);
          return { key, chunks: [] };
        }
      })
    );

    // Convertir a objeto
    const context = {};
    ragResults.forEach(({ key, chunks }) => {
      context[key] = chunks;
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Timeline] Contexto RAG obtenido en ${elapsed}s: ${context.currentMedications?.length || 0} chunks meds, ${context.chronicConditions?.length || 0} chunks crónicas, ${context.timelineEvents?.length || 0} chunks eventos`);

    return context;
  } catch (error) {
    console.error('[Timeline] Error obteniendo contexto RAG:', error);
    return { currentMedications: [], chronicConditions: [], timelineEvents: [] };
  }
}

/**
 * Formatea los chunks RAG para incluirlos en el prompt
 */
function formatRAGContextForPrompt(ragContext) {
  const sections = [];

  if (ragContext.currentMedications?.length > 0) {
    const medsText = ragContext.currentMedications
      .map(c => `[${c.filename}, ${c.date || 'sin fecha'}]: ${c.content.substring(0, 400)}`)
      .join('\n---\n');
    sections.push(`### VALIDATED CURRENT MEDICATIONS (from RAG search):\n${medsText}`);
  }

  if (ragContext.chronicConditions?.length > 0) {
    const chronicText = ragContext.chronicConditions
      .map(c => `[${c.filename}, ${c.date || 'sin fecha'}]: ${c.content.substring(0, 400)}`)
      .join('\n---\n');
    sections.push(`### VALIDATED CHRONIC CONDITIONS (from RAG search):\n${chronicText}`);
  }

  if (ragContext.timelineEvents?.length > 0) {
    const eventsText = ragContext.timelineEvents
      .map(c => `[${c.filename}, ${c.date || 'sin fecha'}]: ${c.content.substring(0, 400)}`)
      .join('\n---\n');
    sections.push(`### VALIDATED TIMELINE EVENTS (from RAG search):\n${eventsText}`);
  }

  return sections.join('\n\n');
}

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

    // 3. Obtener contexto validado por RAG (medicamentos actuales, condiciones crónicas, eventos)
    const ragContext = await getRAGValidatedContext(patientId);
    const ragContextText = formatRAGContextForPrompt(ragContext);

    // 4. Preparar datos para el LLM
    const eventsForPrompt = rawEvents.map(e => ({
      name: e.name,
      type: e.key,
      date: e.date ? new Date(e.date).toISOString().split('T')[0] : null,
      dateConfidence: e.dateConfidence || 'missing'
    }));

    // 5. Llamar al LLM para consolidar
    const { gpt4omini } = createModels('default', 'gpt4omini');
    
    let consolidationPrompt;
    try {
      consolidationPrompt = await pull('foundation29/timeline_consolidation_v1');
    } catch {
      console.warn('[Timeline] Prompt no encontrado en LangSmith, usando fallback local');
      consolidationPrompt = ChatPromptTemplate.fromMessages([
        ["system", `You are a medical data curator specializing in creating clear, consolidated clinical timelines.

Your task is to transform a list of raw medical events (which may contain duplicates and noise) into a clean, organized timeline.

### CRITICAL - PRIORITIZE VALIDATED DATA:
You will receive TWO types of information:
1. **RAG-validated data**: Information retrieved directly from the patient's documents. THIS IS THE SOURCE OF TRUTH.
2. **Raw events**: Extracted events that may contain errors, outdated info, or duplicates.

**ALWAYS prioritize RAG-validated data over raw events**, especially for:
- Current medications (only include meds confirmed as CURRENT in validated data)
- Chronic conditions (only include conditions confirmed as ACTIVE/ONGOING)
- One-time events like infections (COVID, flu, etc.) should NOT appear as chronic conditions

### RULES:

1. **VALIDATE MEDICATIONS**: Only include a medication in "currentMedications" if:
   - It appears in the RAG-validated medications section as currently active
   - OR it's from a very recent document (last 3 months) and marked as ongoing
   - EXCLUDE medications that were discontinued, changed, or from old reports

2. **VALIDATE CHRONIC CONDITIONS**: Only include a condition in "chronicConditions" if:
   - It's explicitly described as chronic, persistent, or ongoing in validated data
   - Acute infections (COVID-19, flu, pneumonia) are NOT chronic unless explicitly stated as "long COVID" or similar
   - Past resolved conditions should be milestones, not chronic conditions

3. **DEDUPLICATE**: Merge events that refer to the same medical concept, even if worded differently.
   - "Colecistectomía", "Cholecystectomy", "Gallbladder removal" → ONE event

4. **INHERIT DATES**: If an event appears multiple times with different dates:
   - Use the EARLIEST confirmed date as the event date
   - If no confirmed date exists, mark as "undated"

5. **CATEGORIZE**:
   - **Milestones**: One-time events (surgeries, diagnoses, hospitalizations, acute illnesses)
   - **Chronic Conditions**: ONLY truly ongoing conditions (diabetes, hypertension, etc.)
   - **Current Medications**: ONLY medications the patient is currently taking

6. **PRIORITIZE**: Keep only clinically significant events:
   - YES: Diagnoses, surgeries, major treatments, hospitalizations, significant test results
   - NO: Routine checkups, normal findings, minor symptoms, negative findings

7. **LIMIT**: Maximum 30 milestones, 10 chronic conditions, 10 current medications

8. **LANGUAGE**: Respond in the same language as the input events.

9. **DATES**: Use numeric month (1-12) for consistent sorting across languages.

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
        ["human", `{ragContext}

Raw events from database:
{events}

Document summaries for additional context:
{summaries}

Generate the consolidated timeline. Remember: PRIORITIZE the RAG-validated data over raw events for medications and chronic conditions.`]
      ]);
    }

    const chain = consolidationPrompt.pipe(gpt4omini);
    
    const result = await chain.invoke({
      ragContext: ragContextText || 'No RAG-validated context available.',
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
      insights.error({ message: '[Timeline] Error parsing LLM response', error: parseError.message, patientId: patientId, textPreview: (result.content || result)?.substring?.(0, 300) });
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
