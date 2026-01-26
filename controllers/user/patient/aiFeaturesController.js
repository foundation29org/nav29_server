/**
 * =========================================================
 *  AI FEATURES CONTROLLER
 *  ---------------------------------------------------------
 *  Orquestra los distintos flujos de IA (Rarescope, DxGPT…)
 *  ▸ Obtiene el contexto RAW del paciente
 *  ▸ Opcionalmente resume documentos (DxGPT)
 *  ▸ Construye prompts y lanza las peticiones a LLMs
 * =========================================================
 */
'use strict';

/*--------------------------------------------------------------------
 * 1. DEPENDENCIAS
 *------------------------------------------------------------------*/
const patientContextService = require('../../../services/patientContextService');
const crypt                 = require('../../../services/crypt');
const config                = require('../../../config');
const pubsub                = require('../../../services/pubsub');
const insights              = require('../../../services/insights');
const axios                 = require('axios');
const f29azure              = require('../../../services/f29azure');
const { retrieveChunks, extractStructuredFacts } = require('../../../services/retrievalService');
const { curateContext } = require('../../../services/tools');

const { generatePatientUUID } = require('../../../services/uuid');
const { generatePatientInfographic } = require('../../../services/langchain');

/*--------------------------------------------------------------------
 * 2. HELPERS ───────────── ✂ ────────────────────────────────────────*/

/** (0.1) Limpia HTML del texto, convirtiéndolo a texto plano */
function cleanHtmlFromText(htmlText) {
  if (!htmlText || typeof htmlText !== 'string') return htmlText;
  
  let cleaned = htmlText;
  
  // Reemplazar etiquetas de bloque comunes por saltos de línea
  cleaned = cleaned.replace(/<h[1-6][^>]*>/gi, '\n\n');
  cleaned = cleaned.replace(/<\/h[1-6]>/gi, '\n');
  cleaned = cleaned.replace(/<p[^>]*>/gi, '\n\n');
  cleaned = cleaned.replace(/<\/p>/gi, '\n');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');
  cleaned = cleaned.replace(/<div[^>]*>/gi, '\n');
  cleaned = cleaned.replace(/<\/div>/gi, '\n');
  cleaned = cleaned.replace(/<ul[^>]*>/gi, '\n');
  cleaned = cleaned.replace(/<\/ul>/gi, '\n');
  cleaned = cleaned.replace(/<li[^>]*>/gi, '\n- ');
  cleaned = cleaned.replace(/<\/li>/gi, '');
  
  // Eliminar todas las demás etiquetas HTML
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  
  // Decodificar entidades HTML comunes
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&apos;/g, "'");
  
  // Limpiar espacios en blanco múltiples y saltos de línea
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n'); // Máximo 2 saltos de línea seguidos
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' '); // Múltiples espacios a uno solo
  cleaned = cleaned.replace(/^\s+|\s+$/gm, ''); // Trim por línea
  
  return cleaned.trim();
}

/** (0) Obtiene el resumen del paciente si existe (final_card.txt) */
async function getPatientSummaryIfExists(patientId) {
  try {
    const summaryPath = 'raitofile/summary/final_card.txt';
    
    // Intentar con el método nuevo (SHA256) primero
    let containerName = crypt.getContainerName(patientId);
    console.log('🔍 Intentando containerName (SHA256):', containerName);
    let exists = await f29azure.checkBlobExists(containerName, summaryPath);
    
    // Si no existe, intentar con el método legacy
    if (!exists) {
      containerName = crypt.getContainerNameLegacy(patientId);
      console.log('🔍 Intentando containerName (Legacy):', containerName);
      exists = await f29azure.checkBlobExists(containerName, summaryPath);
    }
    
    if (!exists) {
      console.log('📋 No existe resumen del paciente, usando contexto construido');
      return null;
    }
    
    console.log('✅ Resumen encontrado en containerName:', containerName);
    
    // Descargar el resumen
    const summaryContent = await f29azure.downloadBlob(containerName, summaryPath);
    if (!summaryContent) {
      console.log('📋 Resumen vacío, usando contexto construido');
      return null;
    }
    
    // El resumen viene como JSON string, parsearlo
    let summary;
    try {
      summary = JSON.parse(summaryContent);
      // El resumen puede tener estructura {data: "...", version: "..."}
      const summaryData = summary.data || summaryContent;
      
      // Limpiar HTML del resumen antes de devolverlo
      const cleanedSummary = cleanHtmlFromText(summaryData);
      console.log('✅ Usando resumen del paciente existente (HTML limpiado)');
      return cleanedSummary;
    } catch (parseError) {
      // Si no es JSON, usar el contenido directamente pero limpiar HTML
      const cleanedSummary = cleanHtmlFromText(summaryContent);
      console.log('✅ Usando resumen del paciente existente (texto plano, HTML limpiado)');
      return cleanedSummary;
    }
  } catch (error) {
    console.warn('⚠️ Error al obtener resumen del paciente, usando contexto construido:', error.message);
    return null;
  }
}

/** (a) Formatea edad (en años o meses) */
const getAge = birthDate => {
  if (!birthDate) return 'N/A';
  const now   = new Date();
  const birth = new Date(birthDate);
  let years   = now.getFullYear() - birth.getFullYear();
  const mDiff = now.getMonth() - birth.getMonth();
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < birth.getDate())) years--;
  if (years < 2) {
    const months = years * 12 + (now.getMonth() - birth.getMonth());
    return `${months} months`;
  }
  return `${years} years`;
};

/** (b) Resumen IA de un documento largo (>100 chars) */
async function summarizeWithDxgpt({ text, name, patientId, hasSummary = false }) {
  // Si el texto ya es un resumen (viene de summary_translated.txt), usarlo directamente
  if (hasSummary && text && text.trim()) {
    console.debug(`    ↳ Usando resumen existente para "${name}" (${text.length} chars)`);
    return text.trim();
  }
  
  // Si no hay texto o es muy corto, no resumir
  if (!config.DXGPT_SUBSCRIPTION_KEY || !text || text.length < 100) return null;

  // Si el texto es muy largo, resumirlo con DxGPT
  console.debug(`    ↳ Summarising "${name}" (${text.length} chars)…`);
  const { data } = await axios.post(
    'https://dxgpt-apim.azure-api.net/api/medical/summarize',
    {
      description: text,
      myuuid: generatePatientUUID(patientId),
      timezone: 'Europe/Madrid',
      lang: 'es'
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY,
        'X-Tenant-Id': 'Nav29 AI'
      }
    }
  );
  return data?.result === 'success' ? data.data.summary : null;
}

/** (c) Resumir contexto completo cuando es demasiado largo */
async function summarizeContext(contextText, patientId) {
  try {
    console.log(`🔄 Iniciando resumen de contexto (${contextText.length} caracteres)...`);
    
    const { data } = await axios.post(
      'https://dxgpt-apim.azure-api.net/api/medical/summarize',
      {
        description: contextText,
        myuuid: generatePatientUUID(patientId),
        timezone: 'Europe/Madrid',
        lang: 'es'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY,
          'X-Tenant-Id': 'Nav29 AI'
        }
      }
    );

    if (data?.result === 'success' && data.data?.summary) {
      const summary = data.data.summary;
      console.log(`✅ Contexto resumido exitosamente (${summary.length} caracteres)`);
      return summary;
    } else {
      console.warn('⚠️ No se pudo resumir el contexto, usando contexto original truncado');
      // Si falla el resumen, devolver los primeros 2000 caracteres
      return contextText.substring(0, 2000);
    }
  } catch (error) {
    console.error('❌ Error al resumir contexto:', error.message);
    // En caso de error, devolver los primeros 2000 caracteres
    return contextText.substring(0, 2000);
  }
}

/** (d) Construye string legible a partir del contexto RAW */
async function buildContextString(raw, patientId) {
  const { profile, events, documents } = raw;

  /* ▸ Perfil ------------------------------------------------------ */
  let out = `PATIENT DATA:
- Name: ${profile.name}
- Age: ${getAge(profile.birthDate)}
- Birthdate: ${profile.birthDate ? new Date(profile.birthDate).toLocaleDateString('en-GB') : 'N/A'}
- Gender: ${profile.gender}
- Chronic Conditions: ${profile.chronicConditions || 'N/A'}
- Allergies: ${profile.allergies || 'N/A'}

`;

  /* ▸ Eventos ----------------------------------------------------- */
  if (events.length) {
    const section = { diagnosis: 'Diagnoses', symptom: 'Symptoms', medication: 'Medications' };
    out += 'MEDICAL HISTORY:\n';
    for (const type of ['diagnosis', 'symptom', 'medication']) {
      const rows = events.filter(e => e.type === type);
      if (!rows.length) continue;
      out += `  ${section[type]}:\n`;
      rows.forEach(e =>
        out += `  - ${e.name} (${e.date || 'N/A'})${e.notes ? `. ${e.notes}` : ''}\n`
      );
    }
    out += '\n';
  }

  /* ▸ Documentos -------------------------------------------------- */
  if (documents.length) {
    const documentsWithSummary = [];
    for (const doc of documents) {
      // Si el documento ya tiene un resumen pre-generado, usarlo directamente
      // Si no, resumir el texto extraído con DxGPT
      const summary = await summarizeWithDxgpt({ 
        text: doc.text, 
        name: doc.name, 
        patientId,
        hasSummary: doc.hasSummary || false
      });
      // Solo incluir documentos que tengan resumen útil
      if (summary) {
        documentsWithSummary.push({ ...doc, summary });
      }
    }
    
    // Solo añadir la sección si hay documentos con resumen
    if (documentsWithSummary.length > 0) {
      out += 'MEDICAL DOCUMENTS INFORMATION:\n';
      for (const doc of documentsWithSummary) {
        out += `
  Document: ${doc.name} (${doc.date || 'N/A'})
  Summary: ${doc.summary}
`;
      }
    }
  }

  /* ▸ Verificar longitud y resumir si es necesario ------------------ */
  // NOTA: summarizeContext está comentado porque prioritizeContextWithAI hace un trabajo más inteligente
  // diferenciando permanente/crónico de puntual. Si necesitas volver a usarlo, descomenta las líneas siguientes:
  // if (out.length > 3000) {
  //   console.log(`📊 Contexto demasiado largo (${out.length} caracteres), aplicando resumen...`);
  //   out = await summarizeContext(out, patientId);
  // }

  return out;
}

/** (e) Usa IA para priorizar y filtrar contexto: diferencia permanente/crónico de puntual */
async function prioritizeContextWithAI(contextText, patientId) {
  try {
    // Validar configuración
    const azureInstance = config.OPENAI_API_BASE_GPT4O || config.OPENAI_API_BASE;
    const azureKey = config.O_A_K_GPT4O || config.O_A_K;
    if (!azureInstance || !azureKey) {
      console.warn('⚠️ Azure OpenAI no configurado, devolviendo contexto original');
      return contextText;
    }

    // Si el contexto es muy corto, no necesita filtrado
    // Umbral mínimo: 2000 caracteres (evita gastar tokens en contextos pequeños)
    if (!contextText || contextText.length < 2000) {
      return contextText;
    }

    console.log(`🤖 Aplicando priorización inteligente (GPT-4o) a contexto de ${contextText.length} caracteres...`);

    const deployment = 'gpt-4o';
    const url = `https://${azureInstance}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${config.OPENAI_API_VERSION}`;

    const prompt = `You are a medical expert analyzing clinical records. Your task is to filter and prioritize patient information, differentiating between:

1. **PERMANENT/CHRONIC INFORMATION** (always relevant):
   - Active chronic conditions
   - Permanent allergies
   - Diagnoses that remain relevant
   - Current or continuous-use medications
   - Persistent or recurrent symptoms

2. **RECENT/RELEVANT INFORMATION** (last 6-12 months):
   - Recent medical events
   - Current symptoms
   - Recent medications
   - Recent medical documents

3. **HISTORICAL/PUNCTUAL INFORMATION** (can be omitted if not critical):
   - Old resolved diseases
   - Old medications not related to current conditions
   - Past resolved punctual symptoms
   - Very old documents without current relevance

**CRITICAL INSTRUCTIONS:**
- **MANDATORY**: Keep COMPLETE patient profile section (PATIENT DATA) with ALL fields: Name, Age, Birthdate, Gender, Chronic Conditions, Allergies. NEVER remove or omit any field, even if it shows "N/A" or is empty.
- Prioritize information relevant for current diagnosis or treatment
- Remove redundant, obsolete, or punctual information that does not affect current status
- Maintain the original structure and section headers (PATIENT DATA, MEDICAL HISTORY, MEDICAL DOCUMENTS INFORMATION)
- If in doubt about whether something is chronic or punctual, include it (better to include than exclude important information)
- Preserve dates when relevant to understand chronology
- Keep the exact format: "PATIENT DATA:", "MEDICAL HISTORY:", "MEDICAL DOCUMENTS INFORMATION:"
- Note: Only documents with valid summaries are included in the context (documents without summaries are already filtered out)

**OUTPUT FORMAT:**
Return ONLY the filtered and optimized context, without additional explanations or headers like "## Contexto optimizado del paciente:". Start directly with "PATIENT DATA:".
Maintain the same structured format as the input.
IMPORTANT: Respond in the SAME LANGUAGE as the patient context provided below.

## Original Patient Context:
${contextText}`;

    const { data } = await axios.post(
      url,
      {
        messages: [
          { role: 'system', content: 'You are a medical assistant expert in clinical record analysis. You MUST preserve ALL patient profile fields (Name, Age, Birthdate, Gender, Chronic Conditions, Allergies) even if they are empty or show "N/A". Always respond in the same language as the provided context and maintain the exact structure with section headers.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3, // Baja temperatura para mayor precisión
        max_tokens: 4000
      },
      {
        headers: {
          'api-key': azureKey,
          'Content-Type': 'application/json'
        }
      }
    );

    const optimizedContext = data?.choices?.[0]?.message?.content?.trim() || '';
    
    if (optimizedContext && optimizedContext.length > 100) {
      console.log(`✅ Contexto optimizado con IA (${optimizedContext.length} caracteres, reducción: ${((1 - optimizedContext.length / contextText.length) * 100).toFixed(1)}%)`);
      return optimizedContext;
    } else {
      console.warn('⚠️ La IA no devolvió un contexto válido, usando contexto original');
      return contextText;
    }
  } catch (error) {
    console.error('❌ Error al priorizar contexto con IA:', error.message);
    // En caso de error, devolver el contexto original
    return contextText;
  }
}

/*--------------------------------------------------------------------
 * 3. CONTROLADORES MAIN
 *------------------------------------------------------------------*/

/*--------------------------------------------*
 * 3.1  RARESCOPE                             *
 *--------------------------------------------*/
async function handleRarescopeRequest(req, res) {
  try {
    /* 0 · Validación configuración básica ------------------------------*/
    const azureInstance = config.OPENAI_API_BASE_GPT4O || config.OPENAI_API_BASE;
    const azureKey      = config.O_A_K_GPT4O          || config.O_A_K;
    if (!azureInstance || !azureKey) {
      return res.status(500).json({ error: 'Azure OpenAI not configured' });
    }

    /* 1 · Seguridad ----------------------------------------------------*/
    const patientId = crypt.decrypt(req.params.patientId);

    /* 2 · Descripción clínica (puede venir del caller) -----------------*/
    const customDescription = req.body?.customPatientDescription || req.body?.customMedicalDescription;
    let ctxStr = customDescription;
    if (!ctxStr) {
      console.log('📋 Usando nueva arquitectura RAG para Rarescope');
      
      try {
        const searchQuery = "Complete clinical history, symptoms, medical needs and quality of life indicators for a patient with a rare disease";
        const retrievalResult = await retrieveChunks(patientId, searchQuery, "AMBIGUOUS");
        const selectedChunks = retrievalResult.selectedChunks || [];
        
        const structuredFacts = await extractStructuredFacts(selectedChunks, searchQuery, patientId);
        
        const curatedResult = await curateContext(
          [], 
          [], 
          crypt.getContainerName(patientId), 
          [], 
          searchQuery,
          selectedChunks,
          structuredFacts
        );
        
        ctxStr = curatedResult.content;

        // 🚨 FALLBACK DE SEGURIDAD PARA RARESCOPE: Si el RAG es pobre, reforzar con hechos de la timeline
        if (ctxStr.length < 800) {
          console.warn('⚠️ Contexto RAG corto para Rarescope, reforzando con timeline...');
          const raw = await patientContextService.aggregateClinicalContext(patientId);
          const legacyCtx = await buildDxGptContextString(raw, patientId);
          ctxStr = `[CLINICAL SUMMARY]\n${ctxStr}\n\n[DETAILED CLINICAL HISTORY]\n${legacyCtx}`;
        }

        console.log(`✅ Contexto RAG generado para Rarescope (${ctxStr.length} caracteres)`);
      } catch (ragError) {
        console.error('❌ Error en arquitectura RAG para Rarescope, usando fallback legacy:', ragError);
        // Fallback legacy
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        ctxStr = await buildContextString(raw, patientId);
        if (ctxStr.length >= 2000) {
          ctxStr = await prioritizeContextWithAI(ctxStr, patientId);
        }
      }
    }

    /* 3 · Prompt -------------------------------------------------------*/
    const prompt = `Act as a medical expert specializing in patient advocacy and clinical needs assessment. Read the clinical information and extract exclusively a JSON ARRAY of strings, where each string represents a real and concrete unmet need of THIS SPECIFIC PATIENT based on their medical history. Do not add explanations or extra formatting.

These needs should reflect challenges such as lack of specific treatment options for their condition, need for specialized follow-up, management of chronic symptoms, psychological support, or information gaps that the patient faces. Valid output example: ["Need 1","Need 2"]

IMPORTANT: 
- Tailor the needs to the actual diagnoses, treatments, and symptoms mentioned in the patient context.
- You may use your medical knowledge to identify if the condition requires specialized care typical of rare or complex diseases, but focus on the patient's specific evidence.
- Base your analysis on what is explicitly stated in the clinical history, not on assumptions.
- Respond in the SAME LANGUAGE as the patient context provided below.

## Patient Context
${ctxStr}`.trim();

    /* 4 · Llamada REST a Azure OpenAI ---------------------------------*/
    const deployment = 'gpt-4o';
    const url = `https://${azureInstance}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${config.OPENAI_API_VERSION}`;

    const { data } = await axios.post(
      url,
      {
        messages: [
          { role: 'system', content: 'You are a medical expert assistant. Always respond in the same language as the provided patient context.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 800
      },
      {
        headers: {
          'api-key': azureKey,
          'Content-Type': 'application/json'
        }
      }
    );

    let answerRaw = data?.choices?.[0]?.message?.content?.trim() || '';

    let unmetNeeds;
    try {
      unmetNeeds = JSON.parse(answerRaw);
      if (!Array.isArray(unmetNeeds)) throw new Error('Not array');
    } catch (e) {
      // Fallback: split by newline or semicolon
      unmetNeeds = answerRaw.split(/\n|\r|\u2028|\u2029/)
        .map(s => s.replace(/^[\-•\d\.\s]+/, '').trim())
        .filter(Boolean);
    }

    console.log('### Unmet Needs', unmetNeeds); // ARRAY
    console.log('### Unmet Needs Type:', typeof unmetNeeds, 'Is Array:', Array.isArray(unmetNeeds));
    res.json({
      success: true,
      unmetNeeds,
      analysis: unmetNeeds
    });
  } catch (err) {
    console.error('❌ RAREScope error:', err);
    res.status(500).json({
      error: 'Failed to process Rarescope analysis',
      message: err.message
    });
  }
}

/*--------------------------------------------*
 * 3.2  DXGPT – GLOBAL DIAGNÓSTICO            *
 *--------------------------------------------*/
/** (3.1) Procesa DxGPT de forma asíncrona cuando hay muchos documentos */
async function processDxGptAsync(patientId, lang, custom, diseasesList, userId, useEventsAndDocuments) {
  const taskId = `dxgpt-${patientId}-${Date.now()}`;
  // Encriptar patientId para que el cliente pueda validarlo
  const encryptedPatientId = crypt.encrypt(patientId);
  // Encriptar userId para WebPubSub (el cliente se suscribe con userId encriptado)
  const encryptedUserId = crypt.encrypt(userId);
  
  try {
    // Enviar notificación de inicio
    pubsub.sendToUser(encryptedUserId, {
      type: 'dxgpt-processing',
      taskId,
      patientId: encryptedPatientId, // Añadir patientId encriptado para validación
      status: 'started',
      message: 'Iniciando análisis de diagnóstico diferencial...'
    });
    
    let description = custom;
    if (!description) {
      pubsub.sendToUser(encryptedUserId, {
        type: 'dxgpt-processing',
        taskId,
        patientId: encryptedPatientId,
        status: 'retrieving-chunks',
        message: 'Buscando información relevante en tus documentos...',
        progress: 10
      });

      try {
        // 1. Recuperar chunks relevantes (usamos TREND para traer más evidencia)
        const searchQuery = "Complete clinical history, medical conditions, symptoms, laboratory results, imaging findings and current treatments";
        const retrievalResult = await retrieveChunks(patientId, searchQuery, "TREND");
        const selectedChunks = retrievalResult.selectedChunks || [];

        pubsub.sendToUser(encryptedUserId, {
          type: 'dxgpt-processing',
          taskId,
          patientId: encryptedPatientId,
          status: 'extracting-facts',
          message: `Analizando ${selectedChunks.length} fragmentos de evidencia médica...`,
          progress: 40
        });

        // 2. Extraer hechos estructurados
        const structuredFacts = await extractStructuredFacts(selectedChunks, searchQuery, patientId);

        pubsub.sendToUser(encryptedUserId, {
          type: 'dxgpt-processing',
          taskId,
          patientId: encryptedPatientId,
          status: 'curating-context',
          message: 'Sintetizando historial médico optimizado...',
          progress: 70
        });

        // 3. Curar contexto
        const curatedResult = await curateContext(
          [], // context
          [], // memories
          crypt.getContainerName(patientId),
          [], // docs
          searchQuery,
          selectedChunks,
          structuredFacts
        );

        description = curatedResult.content;

        // 4. 🚨 FALLBACK DE SEGURIDAD ASYNC
        if (description.length < 600) {
          console.warn('⚠️ [Async] Contexto RAG corto, reforzando con timeline...');
          const raw = await patientContextService.aggregateClinicalContext(patientId);
          const legacyCtx = await buildDxGptContextString(raw, patientId);
          description = `[PATIENT PROFILE & CLINICAL HISTORY]\n${legacyCtx}\n\n[ADDITIONAL FINDINGS FROM DOCUMENTS]\n${description}`;
        }

        // 🚨 LIMITE ESTRICTO DXGPT (2000 caracteres)
        if (description.length > 2000) {
          console.log('✂️ Acortando descripción a 2000 caracteres para DxGPT');
          description = description.substring(0, 2000);
        }
        
        pubsub.sendToUser(encryptedUserId, {
          type: 'dxgpt-processing',
          taskId,
          patientId: encryptedPatientId,
          status: 'context-ready',
          message: 'Contexto médico preparado para diagnóstico.',
          progress: 85
        });
      } catch (ragError) {
        console.error('❌ Error en arquitectura RAG (Async), usando fallback legacy:', ragError);
        // Fallback legacy
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        description = await buildContextString(raw, patientId);
        if (description.length >= 2000) {
          description = await prioritizeContextWithAI(description, patientId);
        }
        if (description.length > 2000) {
          description = await summarizeContext(description, patientId);
        }
      }
    }
    
    // Validar que tenemos descripción
    if (!description || !description.trim()) {
      throw new Error('No se pudo obtener la descripción del paciente');
    }
    
    // Llamar a DxGPT API
    pubsub.sendToUser(encryptedUserId, {
      type: 'dxgpt-processing',
      taskId,
      patientId: encryptedPatientId,
      status: 'calling-api',
      message: 'Consultando DxGPT API...',
      progress: 90
    });
    
    console.log(`🚀 [Async] Llamando a DxGPT API para paciente ${patientId}...`);
    console.log(`📋 Tamaño final del contexto: ${description.length} caracteres`);
    const body = {
      description,
      myuuid: generatePatientUUID(patientId),
      lang,
      timezone: 'Europe/Madrid',
      diseases_list: diseasesList || '',
      model: 'gpt5mini',
      response_mode: 'direct'
    };
    
    const response = await axios.post(
      'https://dxgpt-apim.azure-api.net/api/diagnose',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY,
          'X-Tenant-Id': 'Nav29 AI'
        }
      }
    );
    
    console.log(`✅ [Async] DxGPT API respondió para paciente ${patientId}`);
    console.log(`📤 [Async] Enviando resultado por WebPubSub:`);
    console.log(`  - userId (sin encriptar): ${userId}`);
    console.log(`  - userId (encriptado): ${encryptedUserId}`);
    console.log(`  - patientId (sin encriptar): ${patientId}`);
    console.log(`  - patientId (encriptado): ${encryptedPatientId}`);
    console.log(`  - taskId: ${taskId}`);
    
    // Enviar resultado final
    pubsub.sendToUser(encryptedUserId, {
      type: 'dxgpt-result',
      taskId,
      patientId: encryptedPatientId,
      status: 'completed',
      success: true,
      analysis: response.data
    });
    
    console.log(`✅ [Async] Resultado enviado por WebPubSub para paciente ${patientId}`);
    
  } catch (error) {
    console.error(`❌ Error en procesamiento asíncrono de DxGPT para paciente ${patientId}:`, error);
    console.error('Stack:', error.stack);
    
    // Encriptar userId para WebPubSub (el cliente se suscribe con userId encriptado)
    const encryptedUserId = crypt.encrypt(userId);
    
    pubsub.sendToUser(encryptedUserId, {
      type: 'dxgpt-result',
      taskId,
      patientId: encryptedPatientId,
      status: 'error',
      success: false,
      error: error.message || 'Error al procesar el análisis'
    });
  }
}

/** (3.2) Construye contexto con actualizaciones de progreso */
async function buildContextStringWithProgress(raw, patientId, userId, taskId, documentCount) {
  // Encriptar patientId para que el cliente pueda validarlo
  const encryptedPatientId = crypt.encrypt(patientId);
  // Encriptar userId para WebPubSub (el cliente se suscribe con userId encriptado)
  const encryptedUserId = crypt.encrypt(userId);
  const { profile, events, documents } = raw;
  
  // Construir perfil y eventos (rápido)
  let out = `PATIENT DATA:
- Name: ${profile.name}
- Age: ${getAge(profile.birthDate)}
- Birthdate: ${profile.birthDate ? new Date(profile.birthDate).toLocaleDateString('en-GB') : 'N/A'}
- Gender: ${profile.gender}
- Chronic Conditions: ${profile.chronicConditions || 'N/A'}
- Allergies: ${profile.allergies || 'N/A'}

`;
  
  if (events.length) {
    const section = { diagnosis: 'Diagnoses', symptom: 'Symptoms', medication: 'Medications' };
    out += 'MEDICAL HISTORY:\n';
    for (const type of ['diagnosis', 'symptom', 'medication']) {
      const rows = events.filter(e => e.type === type);
      if (!rows.length) continue;
      out += `  ${section[type]}:\n`;
      rows.forEach(e =>
        out += `  - ${e.name} (${e.date || 'N/A'})${e.notes ? `. ${e.notes}` : ''}\n`
      );
    }
    out += '\n';
  }
  
  // Procesar documentos con actualizaciones de progreso
  if (documents.length) {
    const documentsWithSummary = [];
    const totalDocs = documents.length;
    
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      
      // Enviar actualización de progreso cada documento
      const progress = 10 + Math.floor((i / totalDocs) * 50); // 10-60%
      pubsub.sendToUser(encryptedUserId, {
        type: 'dxgpt-processing',
        taskId,
        patientId: encryptedPatientId,
        status: 'summarizing-documents',
        message: `Resumiendo documento ${i + 1} de ${totalDocs}: ${doc.name}...`,
        progress
      });
      
      try {
        // Si el documento ya tiene un resumen pre-generado, usarlo directamente
        // Si no, resumir el texto extraído con DxGPT
        const summary = await summarizeWithDxgpt({ 
          text: doc.text, 
          name: doc.name, 
          patientId,
          hasSummary: doc.hasSummary || false
        });
        if (summary) {
          documentsWithSummary.push({ ...doc, summary });
        }
      } catch (summaryError) {
        console.error(`⚠️ Error al resumir documento "${doc.name}":`, summaryError.message);
        // Continuar con el siguiente documento aunque este falle
      }
    }
    
    if (documentsWithSummary.length > 0) {
      out += 'MEDICAL DOCUMENTS INFORMATION:\n';
      for (const doc of documentsWithSummary) {
        out += `
  Document: ${doc.name} (${doc.date || 'N/A'})
  Summary: ${doc.summary}
`;
      }
    }
  }
  
  return out;
}

/** (3.3) Versión optimizada de contexto para DxGPT (sin resúmenes de documentos) */
async function buildDxGptContextString(raw, patientId) {
  const { profile, events } = raw;
  
  let out = `PATIENT DETAILS:
- Age: ${profile.age || 'N/A'}
- Gender: ${profile.gender || 'N/A'}
- Birthdate: ${profile.birthDate ? (typeof profile.birthDate === 'string' ? profile.birthDate.substring(0, 10) : new Date(profile.birthDate).toISOString().substring(0, 10)) : 'N/A'}

CLINICAL HISTORY (SYMPTOMS & DIAGNOSES):\n`;

  if (events && events.length > 0) {
    // Filtrar por tipos relevantes para diagnóstico y ordenar por fecha (más reciente primero)
    const sortedEvents = [...events].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    for (const ev of sortedEvents) {
      const dateStr = ev.date ? new Date(ev.date).toLocaleDateString() : 'N/A';
      out += `- ${ev.name} (${dateStr})\n`;
    }
  } else {
    out += '- No specific events recorded.\n';
  }

  return out;
}

async function handleDxGptRequest(req, res) {
  try {
    // console.log('req.body', req.body);
    const patientId = crypt.decrypt(req.params.patientId);
    const lang      = req.body?.lang || 'en';
    const custom    = req.body?.customMedicalDescription;
    const userId     = req.user; // userId del usuario autenticado
    let useEventsAndDocuments = req.body?.useEventsAndDocuments === true;

    /* ▸ Verificar si necesita procesamiento asíncrono ----------------- */
    // Si se usa "eventos y documentos" (no el resumen), SIEMPRE usar WebPubSub
    if (useEventsAndDocuments && !custom) {
      console.log('📊 Usando procesamiento asíncrono con WebPubSub para eventos y documentos');
      
      try {
        // Obtener datos raw para contar documentos (solo para el mensaje)
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        const documentCount = raw.documents?.length || 0;
        const eventCount = raw.events?.length || 0;
        
        // Responder INMEDIATAMENTE antes de iniciar el procesamiento
        console.log('📤 Enviando respuesta asíncrona al cliente...');
        res.json({
          success: true,
          async: true,
          message: `Procesando ${documentCount} documentos y ${eventCount} eventos. Recibirás una notificación cuando el análisis esté listo.`,
          taskId: `dxgpt-${patientId}-${Date.now()}`
        });
        console.log('✅ Respuesta asíncrona enviada al cliente');
        
        // Iniciar procesamiento asíncrono (no esperar, después de responder)
        processDxGptAsync(patientId, lang, custom, req.body?.diseases_list, userId, useEventsAndDocuments)
          .catch(err => {
            console.error('❌ Error en procesamiento asíncrono:', err);
          });
        
        return; // Importante: salir aquí para no continuar con el procesamiento síncrono
      } catch (contextError) {
        console.error('❌ Error al obtener contexto para respuesta asíncrona:', contextError);
        // Si hay error al obtener el contexto, responder con error pero no asíncrono
        return res.status(500).json({
          success: false,
          error: 'Error al obtener el contexto del paciente',
          message: contextError.message
        });
      }
    }

    /* ▸ Verificar si necesita procesamiento asíncrono para resumen ----------------- */
    // Si se usa el resumen (no eventos/documentos), también usar WebPubSub
    if (!useEventsAndDocuments && !custom) {
      const patientSummary = await getPatientSummaryIfExists(patientId);
      if (patientSummary) {
        console.log('📊 Usando procesamiento asíncrono con WebPubSub para resumen del paciente');
        console.log('📊 userId:', userId);
        console.log('📊 patientId (sin encriptar):', patientId);
        console.log('📊 patientId (encriptado):', crypt.encrypt(patientId));
        
        try {
          // Responder INMEDIATAMENTE antes de iniciar el procesamiento
          console.log('📤 Enviando respuesta asíncrona al cliente (resumen)...');
          res.json({
            success: true,
            async: true,
            message: 'Procesando análisis con resumen del paciente. Recibirás una notificación cuando el análisis esté listo.',
            taskId: `dxgpt-${patientId}-${Date.now()}`
          });
          console.log('✅ Respuesta asíncrona enviada al cliente (resumen)');
          
          // Iniciar procesamiento asíncrono (no esperar, después de responder)
          processDxGptAsync(patientId, lang, custom, req.body?.diseases_list, userId, false)
            .catch(err => {
              console.error('❌ Error en procesamiento asíncrono (resumen):', err);
            });
          
          return; // Importante: salir aquí para no continuar con el procesamiento síncrono
        } catch (error) {
          console.error('❌ Error al iniciar procesamiento asíncrono (resumen):', error);
          // Si hay error, continuar con procesamiento síncrono
        }
      }
    }

    /* ▸ Context (solo si no lo trae el caller) ------------------------- */
    let description = custom;
    if (!description) {
      console.log('📋 Usando arquitectura RAG Híbrida para DxGPT');
      
      try {
        // 1. Recuperar chunks relevantes con un presupuesto más alto para diagnóstico
        const searchQuery = "Complete clinical history, medical conditions, symptoms, laboratory results, imaging findings and current treatments";
        const retrievalResult = await retrieveChunks(patientId, searchQuery, "TREND"); // Usamos TREND para traer más contexto histórico
        const selectedChunks = retrievalResult.selectedChunks || [];
        
        // 2. Obtener también eventos de la timeline para reforzar el contexto
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        const structuredFacts = await extractStructuredFacts(selectedChunks, searchQuery, patientId);
        
        // 3. Curar contexto (pasamos también los eventos del 'raw')
        const curatedResult = await curateContext(
          [], // context
          [], // memories
          crypt.getContainerName(patientId), 
          req.body?.docs || [], 
          searchQuery,
          selectedChunks,
          structuredFacts
        );
        
        description = curatedResult.content;

        // 4. 🚨 FALLBACK DE SEGURIDAD: Si el RAG es demasiado pobre, añadir el contexto de la timeline (SIN resúmenes de documentos)
        if (description.length < 600) {
          console.warn('⚠️ Contexto RAG muy corto, reforzando con hechos de la timeline...');
          // Usamos buildContextString pero SIN incluir los resúmenes de documentos para DxGPT
          const legacyCtx = await buildDxGptContextString(raw, patientId);
          description = `[PATIENT PROFILE & CLINICAL HISTORY]\n${legacyCtx}\n\n[ADDITIONAL FINDINGS FROM DOCUMENTS]\n${description}`;
        }

        // 🚨 LIMITE ESTRICTO DXGPT (2000 caracteres)
        if (description.length > 2000) {
          console.log('✂️ Acortando descripción a 2000 caracteres para DxGPT');
          description = description.substring(0, 2000);
        }

        console.log(`✅ Contexto Híbrido generado (${description.length} caracteres)`);
      } catch (ragError) {
        console.error('❌ Error en arquitectura RAG, usando fallback legacy total:', ragError);
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        description = await buildContextString(raw, patientId);
        if (description.length >= 2000) {
          description = await prioritizeContextWithAI(description, patientId);
        }
      }
    }

    console.log('📋 Description length:', description?.length || 0);
    console.log('📋 Description preview:', description?.substring(0, 200) || 'N/A');

    const body = {
      description,
      myuuid   : generatePatientUUID(patientId),
      lang,
      timezone : 'Europe/Madrid',
      diseases_list: req.body?.diseases_list || '',
      model    : 'gpt5mini',
      response_mode: 'direct'
    };

    console.log('🚀 Calling DxGPT API...');
    let data;
    try {
      const response = await axios.post(
        'https://dxgpt-apim.azure-api.net/api/diagnose',
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY,
            'X-Tenant-Id': 'Nav29 AI'
          }
        }
      );
      data = response.data;
      console.log('✅ DxGPT API response received');
      console.log('data', data);
    } catch (apiError) {
      console.error('❌ DxGPT API error details:');
      console.error('  - Status:', apiError.response?.status);
      console.error('  - Status Text:', apiError.response?.statusText);
      console.error('  - Response Data:', apiError.response?.data);
      console.error('  - Error Message:', apiError.message);
      
      // Si hay una respuesta del servidor, intentar devolverla
      if (apiError.response?.data) {
        return res.status(apiError.response.status || 500).json({
          error: 'DxGPT API error',
          details: apiError.response.data,
          message: apiError.message
        });
      }
      
      // Si no hay respuesta, relanzar el error
      throw apiError;
    }

    // Si no hay datos personales detectados, devolver el texto original como anonymizedText
    try {
      if (data && data.anonymization && data.anonymization.hasPersonalInfo === false) {
        data.anonymization.anonymizedText = description;
      }
    } catch (_) {
      // sin-op
    }
    
    console.log('📤 Enviando respuesta al cliente...');
    const response = { success: true, analysis: data };
    console.log('📤 Response payload size:', JSON.stringify(response).length, 'bytes');
    res.json(response);
    console.log('✅ Respuesta enviada al cliente');
  } catch (err) {
    console.error('❌ DxGPT error:', err);
    insights.error(err);
    res.status(500).json({
      error: 'Failed to process DxGPT analysis',
      message: err.message,
      code: err.code || 'DXGPT_ERROR',
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

/*--------------------------------------------*
 * 3.3  DXGPT – INFO SOBRE ENFERMEDAD         *
 *--------------------------------------------*/
async function handleDiseaseInfoRequest(req, res) {
  try {
    const patientId = crypt.decrypt(req.params.patientId);
    const { questionType, disease, lang = 'en', medicalDescription } = req.body;

    /* ▸ Validaciones --------------------------------------------------- */
    if (questionType === undefined || !disease)
      return res.status(400).json({ error: 'Missing questionType or disease' });

    if (questionType < 0 || questionType > 4)
      return res.status(400).json({ error: 'questionType must be 0-4' });

    /* ▸ Context para 3/4 ---------------------------------------------- */
    let description = medicalDescription;
    if ((questionType === 3 || questionType === 4) && !description) {
      console.log(`📋 Usando nueva arquitectura RAG para Disease Info (Type ${questionType})`);
      
      try {
        const searchQuery = `Detailed clinical information for patient with ${disease} for diagnostic and treatment context`;
        const retrievalResult = await retrieveChunks(patientId, searchQuery, "AMBIGUOUS");
        const selectedChunks = retrievalResult.selectedChunks || [];
        
        const structuredFacts = await extractStructuredFacts(selectedChunks, searchQuery, patientId);
        
        const curatedResult = await curateContext(
          [], 
          [], 
          crypt.getContainerName(patientId), 
          [], 
          searchQuery,
          selectedChunks,
          structuredFacts
        );
        
        description = curatedResult.content;
        console.log(`✅ Contexto RAG generado (${description.length} caracteres)`);
      } catch (ragError) {
        console.error('❌ Error en arquitectura RAG para Disease Info, usando fallback legacy:', ragError);
        // Fallback legacy
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        description = await buildContextString(raw, patientId);
        if (description.length >= 2000) {
          description = await prioritizeContextWithAI(description, patientId);
        }
      }
      
      if (!description.trim())
        return res.status(400).json({ error: 'Medical description required' });
    }

    /* ▸ Call DxGPT ----------------------------------------------------- */
    const body = {
      questionType,
      disease,
      lang,
      myuuid: generatePatientUUID(patientId),
      timezone: req.body.timezone || 'UTC',
      ...(description ? { medicalDescription: description } : {})
    };

    const { data } = await axios.post(
      'https://dxgpt-apim.azure-api.net/api/disease/info',
      body,
      {
        headers: {
          'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY,
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'Nav29 AI'
        }
      }
    );
    res.json(data);
  } catch (err) {
    console.error('❌ DiseaseInfo error:', err);
    res.status(500).json({
      error: 'Error processing disease info request',
      details: err.message
    });
  }
}

/*--------------------------------------------------------------------
 * 3.4 INFOGRAPHIC REQUEST
 *------------------------------------------------------------------*/

/** Helper: Buscar infografía existente en blob storage */
async function findExistingInfographic(containerName) {
  try {
    const files = await f29azure.listContainerFiles(containerName);
    // Buscar archivos de infografía ordenados por fecha (más reciente primero)
    const infographicFiles = files
      .filter(f => f.startsWith('raitofile/infographic/patient_infographic_') && f.endsWith('.png'))
      .sort((a, b) => {
        // Extraer timestamp del nombre del archivo
        const tsA = parseInt(a.match(/patient_infographic_(\d+)\.png/)?.[1] || '0');
        const tsB = parseInt(b.match(/patient_infographic_(\d+)\.png/)?.[1] || '0');
        return tsB - tsA; // Ordenar descendente (más reciente primero)
      });
    
    if (infographicFiles.length > 0) {
      const latestFile = infographicFiles[0];
      // Extraer timestamp del nombre
      const timestampMatch = latestFile.match(/patient_infographic_(\d+)\.png/);
      const generatedAt = timestampMatch ? new Date(parseInt(timestampMatch[1])).toISOString() : null;
      return { blobPath: latestFile, generatedAt };
    }
    return null;
  } catch (error) {
    console.warn('[Infographic] Error searching for existing infographic:', error.message);
    return null;
  }
}

/**
 * Genera una infografía visual del paciente usando Gemini 3 Pro Image Preview
 * @route POST /api/ai/infographic/:patientId
 */
async function handleInfographicRequest(req, res) {
  const patientId = crypt.decrypt(req.params.patientId);
  const lang = req.body.lang || 'en';
  const regenerate = req.body.regenerate || false;
  const userId = req.body.userId ? crypt.decrypt(req.body.userId) : null;
  
  console.log(`[Infographic] Request for patient ${patientId}, lang: ${lang}, regenerate: ${regenerate}`);
  
  try {
    const containerName = crypt.getContainerName(patientId);
    
    /* ▸ Verificar si ya existe una infografía (si no se pide regenerar) --- */
    if (!regenerate) {
      const existing = await findExistingInfographic(containerName);
      if (existing) {
        console.log(`[Infographic] Found existing infographic: ${existing.blobPath}`);
        
        // Generar URL con SAS token
        const sasToken = f29azure.generateSasToken(containerName);
        const imageUrl = `${sasToken.blobAccountUrl}${containerName}/${existing.blobPath}${sasToken.sasToken}`;
        
        return res.json({
          success: true,
          imageUrl: imageUrl,
          blobPath: existing.blobPath,
          generatedAt: existing.generatedAt,
          cached: true,
          message: 'Existing infographic found'
        });
      }
    }
    
    /* ▸ Obtener el resumen del paciente --------------------------------- */
    let patientSummary = null;
    
    // Primero intentar obtener el resumen existente (final_card.txt)
    patientSummary = await getPatientSummaryIfExists(patientId);
    
    // Si no existe resumen, construir contexto desde eventos y documentos
    if (!patientSummary) {
      console.log('[Infographic] No existing summary, building context from RAG...');
      
      try {
        // Usar arquitectura RAG para obtener contexto
        const searchQuery = "Complete patient health overview: diagnoses, medications, symptoms, treatments, and medical history";
        const retrievalResult = await retrieveChunks(patientId, searchQuery, "TREND");
        const selectedChunks = retrievalResult.selectedChunks || [];
        
        // Obtener eventos de la timeline
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        const structuredFacts = await extractStructuredFacts(selectedChunks, searchQuery, patientId);
        
        // Curar contexto
        const curatedResult = await curateContext(
          [],
          [],
          selectedChunks,
          raw.events || [],
          structuredFacts,
          patientId,
          raw.profile || {}
        );
        
        patientSummary = curatedResult.content;
        console.log(`[Infographic] Context built from RAG (${patientSummary.length} chars)`);
      } catch (ragError) {
        console.warn('[Infographic] RAG failed, using basic context:', ragError.message);
        
        // Fallback: usar contexto básico
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        
        // Construir resumen básico
        const summaryParts = [];
        
        if (raw.profile) {
          if (raw.profile.gender) summaryParts.push(`Gender: ${raw.profile.gender}`);
          if (raw.profile.birthDate) summaryParts.push(`Birth Date: ${raw.profile.birthDate}`);
          if (raw.profile.chronic && raw.profile.chronic.length > 0) {
            summaryParts.push(`Chronic Conditions: ${raw.profile.chronic.join(', ')}`);
          }
        }
        
        if (raw.events && raw.events.length > 0) {
          const diagnoses = raw.events.filter(e => e.type === 'diagnosis').slice(0, 10);
          const medications = raw.events.filter(e => e.type === 'medication').slice(0, 10);
          const symptoms = raw.events.filter(e => e.type === 'symptom').slice(0, 10);
          
          if (diagnoses.length > 0) {
            summaryParts.push(`Diagnoses: ${diagnoses.map(d => d.name).join(', ')}`);
          }
          if (medications.length > 0) {
            summaryParts.push(`Medications: ${medications.map(m => m.name).join(', ')}`);
          }
          if (symptoms.length > 0) {
            summaryParts.push(`Symptoms: ${symptoms.map(s => s.name).join(', ')}`);
          }
        }
        
        patientSummary = summaryParts.join('\n\n');
      }
    }
    
    // Verificar que tenemos contenido suficiente
    if (!patientSummary || patientSummary.trim().length < 50) {
      return res.status(400).json({
        success: false,
        error: 'Not enough patient data to generate an infographic. Please upload more medical documents.'
      });
    }
    
    /* ▸ Generar la infografía ------------------------------------------- */
    console.log(`[Infographic] Generating infographic with summary (${patientSummary.length} chars)...`);
    
    const result = await generatePatientInfographic(patientId, patientSummary, lang);
    
    if (result.success) {
      // Guardar la imagen en Azure Blob Storage
      const generatedAt = new Date();
      const blobPath = `raitofile/infographic/patient_infographic_${generatedAt.getTime()}.png`;
      
      try {
        // Convertir base64 a buffer y subir
        const imageBuffer = Buffer.from(result.imageData, 'base64');
        await f29azure.createBlob(containerName, blobPath, imageBuffer);
        
        console.log(`[Infographic] Image saved to ${blobPath}`);
        
        // Generar URL con SAS token para acceder a la imagen
        const sasToken = f29azure.generateSasToken(containerName);
        const imageUrl = `${sasToken.blobAccountUrl}${containerName}/${blobPath}${sasToken.sasToken}`;
        
        res.json({
          success: true,
          imageUrl: imageUrl,
          blobPath: blobPath,
          generatedAt: generatedAt.toISOString(),
          cached: false,
          message: 'Infographic generated successfully'
        });
      } catch (uploadError) {
        console.warn('[Infographic] Failed to save to blob, returning image data:', uploadError.message);
        // Si falla el guardado, devolver la imagen base64 como fallback
        res.json({
          success: true,
          imageData: result.imageData,
          mimeType: result.mimeType,
          cached: false,
          message: 'Infographic generated (not saved to storage)'
        });
      }
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to generate infographic'
      });
    }
    
  } catch (error) {
    console.error('[Infographic] Error:', error.message);
    insights.error({ 
      message: '[Infographic] Error handling request', 
      error: error.message, 
      patientId 
    });
    res.status(500).json({
      success: false,
      error: 'Error generating infographic',
      details: error.message
    });
  }
}

/*--------------------------------------------------------------------
 * 4. EXPORTS
 *------------------------------------------------------------------*/
module.exports = {
  handleRarescopeRequest,
  handleDxGptRequest,
  handleDiseaseInfoRequest,
  handleInfographicRequest
};