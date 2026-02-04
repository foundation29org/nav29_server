'use strict';

/**
 * JSON Parser Service
 * 
 * Servicio para parsear y reparar JSONs malformados.
 * Estrategia de 3 capas:
 * 1. JSON.parse directo
 * 2. jsonrepair library
 * 3. GPT como último recurso
 */

const { jsonrepair } = require('jsonrepair');
const { createModels } = require('./langchain');
const insights = require('./insights');

/**
 * Tipos de JSON soportados para reparación con GPT
 */
const JSON_TYPES = {
  TIMELINE_EVENTS: 'timeline_events',
  MEDICAL_SUMMARY: 'medical_summary',
  ANOMALIES: 'anomalies',
  SUGGESTIONS: 'suggestions',
  STRUCTURED_FACTS: 'structured_facts',
  GENERIC_ARRAY: 'generic_array',
  GENERIC_OBJECT: 'generic_object',
  GENERIC: 'generic'
};

/**
 * Limpia el texto de respuesta antes de parsear
 * @param {string} text - Texto a limpiar
 * @returns {string} - Texto limpio
 */
function cleanJsonResponse(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  let cleaned = text.trim();
  
  // Eliminar bloques de código markdown
  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  
  // Eliminar BOM y caracteres invisibles
  cleaned = cleaned.replace(/^\uFEFF/, '');
  
  // Intentar extraer JSON si hay texto antes/después
  const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (jsonMatch) {
    cleaned = jsonMatch[1];
  }
  
  return cleaned.trim();
}

/**
 * Parsea JSON con estrategia de 3 capas de recuperación
 * @param {string} jsonText - Texto JSON a parsear
 * @param {string} jsonType - Tipo de JSON para guiar la reparación GPT
 * @param {Object} options - Opciones adicionales
 * @param {boolean} options.useGptFallback - Si usar GPT como último recurso (default: true)
 * @param {string} options.context - Contexto adicional para logging
 * @returns {Promise<any>} - JSON parseado
 */
async function parseJson(jsonText, jsonType = JSON_TYPES.GENERIC, options = {}) {
  const { useGptFallback = true, context = '' } = options;
  
  if (!jsonText || typeof jsonText !== 'string') {
    console.warn('[parseJson] Empty or invalid input');
    return jsonType.includes('array') ? [] : {};
  }
  
  const cleanedText = cleanJsonResponse(jsonText);
  
  if (!cleanedText) {
    console.warn('[parseJson] Cleaned text is empty');
    return jsonType.includes('array') ? [] : {};
  }
  
  // Capa 1: JSON.parse directo
  try {
    return JSON.parse(cleanedText);
  } catch (parseError) {
    console.debug('[parseJson] Direct parse failed, trying jsonrepair...');
  }
  
  // Capa 2: jsonrepair
  try {
    const repaired = jsonrepair(cleanedText);
    return JSON.parse(repaired);
  } catch (repairError) {
    console.warn('[parseJson] jsonrepair failed:', repairError.message);
    insights.error({
      message: '[parseJson] jsonrepair failed',
      error: repairError.message,
      jsonType: jsonType,
      context: context,
      textPreview: cleanedText.substring(0, 200)
    });
  }
  
  // Capa 3: GPT como último recurso
  if (useGptFallback) {
    try {
      console.log('[parseJson] Attempting GPT repair...');
      return await repairJsonWithGPT(cleanedText, jsonType);
    } catch (gptError) {
      console.error('[parseJson] GPT repair failed:', gptError.message);
      insights.error({
        message: '[parseJson] GPT repair failed',
        error: gptError.message,
        jsonType: jsonType,
        context: context,
        textPreview: cleanedText.substring(0, 500)
      });
    }
  }
  
  // Si todo falla, devolver estructura vacía según el tipo
  console.error('[parseJson] All repair attempts failed, returning empty structure');
  return getEmptyStructure(jsonType);
}

/**
 * Devuelve una estructura vacía según el tipo de JSON
 * @param {string} jsonType - Tipo de JSON
 * @returns {any} - Estructura vacía apropiada
 */
function getEmptyStructure(jsonType) {
  switch (jsonType) {
    case JSON_TYPES.TIMELINE_EVENTS:
    case JSON_TYPES.ANOMALIES:
    case JSON_TYPES.SUGGESTIONS:
    case JSON_TYPES.STRUCTURED_FACTS:
    case JSON_TYPES.GENERIC_ARRAY:
      return [];
    case JSON_TYPES.MEDICAL_SUMMARY:
    case JSON_TYPES.GENERIC_OBJECT:
      return {};
    default:
      return null;
  }
}

/**
 * Repara JSON usando GPT como último recurso
 * @param {string} brokenJson - JSON malformado
 * @param {string} jsonType - Tipo de JSON para guiar la reparación
 * @returns {Promise<any>} - JSON reparado y parseado
 */
async function repairJsonWithGPT(brokenJson, jsonType) {
  const { structureHint, instructions } = getRepairInstructions(jsonType);
  
  const repairPrompt = `You are a JSON repair assistant. Fix the following broken JSON to make it valid.

${structureHint}

Broken JSON:
${brokenJson.substring(0, 8000)}

Instructions:
${instructions}

Return ONLY the fixed JSON, no explanations, no markdown code blocks:`;

  try {
    const model = createModels('default', 'gpt-4.1-mini')['gpt-4.1-mini'];
    
    const response = await model.invoke([
      { role: 'user', content: repairPrompt }
    ]);
    
    let repairedText = response.content?.trim() || '';
    
    // Limpiar posibles bloques de código
    repairedText = repairedText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    
    return JSON.parse(repairedText);
  } catch (error) {
    throw new Error(`GPT repair failed: ${error.message}`);
  }
}

/**
 * Obtiene las instrucciones de reparación según el tipo de JSON
 * @param {string} jsonType - Tipo de JSON
 * @returns {Object} - { structureHint, instructions }
 */
function getRepairInstructions(jsonType) {
  let structureHint = '';
  let instructions = '';
  
  const baseInstructions = `1. Fix all JSON syntax errors (missing quotes, brackets, commas, etc.)
2. Ensure all strings are properly quoted.
3. Ensure all arrays are properly closed with ].
4. Ensure all objects are properly closed with }.
5. Return ONLY valid JSON, no explanations, no markdown, no code blocks.
6. Maintain the original meaning as much as possible.`;

  switch (jsonType) {
    case JSON_TYPES.TIMELINE_EVENTS:
      structureHint = `The JSON must be an array of medical events, each with this structure:
[
  {
    "keyMedicalEvent": "event description",
    "date": "YYYY-MM-DD or null",
    "type": "diagnosis|medication|procedure|symptom|other"
  }
]`;
      instructions = baseInstructions + `
7. Do NOT remove events unless they are completely unusable.
8. If a date is missing, use null.
9. Preserve all medical information.`;
      break;
      
    case JSON_TYPES.ANOMALIES:
      structureHint = `The JSON must be an array of anomalies/concerns found in medical documents:
[
  {
    "finding": "description of the anomaly",
    "severity": "high|medium|low",
    "recommendation": "suggested action"
  }
]`;
      instructions = baseInstructions + `
7. Preserve all anomaly findings.
8. If severity is missing, infer from context or use "medium".`;
      break;
      
    case JSON_TYPES.SUGGESTIONS:
      structureHint = `The JSON must be an array of suggestion strings:
["Suggestion 1", "Suggestion 2", "Suggestion 3"]`;
      instructions = baseInstructions + `
7. Maintain all suggestions from the original.`;
      break;
      
    case JSON_TYPES.STRUCTURED_FACTS:
      structureHint = `The JSON must be an array of clinical facts:
[
  {
    "fact": "description",
    "value": "numerical value or null",
    "unit": "unit or null",
    "date": "YYYY-MM-DD or null",
    "source": "filename"
  }
]`;
      instructions = baseInstructions + `
7. Preserve all clinical facts.
8. If values are missing, use null.`;
      break;
      
    case JSON_TYPES.MEDICAL_SUMMARY:
      structureHint = `The JSON must be a valid object with medical summary information.`;
      instructions = baseInstructions + `
7. Preserve all medical information.
8. Maintain the original structure.`;
      break;
      
    case JSON_TYPES.GENERIC_ARRAY:
      structureHint = `The JSON must be a valid array.`;
      instructions = baseInstructions;
      break;
      
    case JSON_TYPES.GENERIC_OBJECT:
      structureHint = `The JSON must be a valid object.`;
      instructions = baseInstructions;
      break;
      
    default:
      structureHint = `The JSON must be valid JSON (array or object).`;
      instructions = baseInstructions;
  }
  
  return { structureHint, instructions };
}

/**
 * Parseo rápido sin fallback GPT (para casos donde la velocidad es crítica)
 * @param {string} jsonText - Texto JSON a parsear
 * @param {any} defaultValue - Valor por defecto si falla
 * @returns {any} - JSON parseado o valor por defecto
 */
function parseJsonFast(jsonText, defaultValue = null) {
  if (!jsonText || typeof jsonText !== 'string') {
    return defaultValue;
  }
  
  const cleanedText = cleanJsonResponse(jsonText);
  
  // Capa 1: JSON.parse directo
  try {
    return JSON.parse(cleanedText);
  } catch (parseError) {
    // Capa 2: jsonrepair
    try {
      const repaired = jsonrepair(cleanedText);
      return JSON.parse(repaired);
    } catch (repairError) {
      console.warn('[parseJsonFast] Failed to parse:', repairError.message);
      return defaultValue;
    }
  }
}

/**
 * Valida que un JSON tenga la estructura esperada
 * @param {any} json - JSON a validar
 * @param {string} jsonType - Tipo esperado
 * @returns {boolean} - Si el JSON es válido para el tipo
 */
function validateJsonStructure(json, jsonType) {
  if (json === null || json === undefined) {
    return false;
  }
  
  switch (jsonType) {
    case JSON_TYPES.TIMELINE_EVENTS:
    case JSON_TYPES.ANOMALIES:
    case JSON_TYPES.SUGGESTIONS:
    case JSON_TYPES.STRUCTURED_FACTS:
    case JSON_TYPES.GENERIC_ARRAY:
      return Array.isArray(json);
      
    case JSON_TYPES.MEDICAL_SUMMARY:
    case JSON_TYPES.GENERIC_OBJECT:
      return typeof json === 'object' && !Array.isArray(json);
      
    default:
      return true;
  }
}

module.exports = {
  parseJson,
  parseJsonFast,
  cleanJsonResponse,
  validateJsonStructure,
  JSON_TYPES
};
