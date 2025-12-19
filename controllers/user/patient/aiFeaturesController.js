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

const { generatePatientUUID } = require('../../../services/uuid');

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
      const raw = await patientContextService.aggregateClinicalContext(patientId);
      ctxStr = await buildContextString(raw, patientId);
      // Optimizar contexto con IA para diferenciar permanente/crónico de puntual
      // Solo si el contexto es suficientemente largo (>= 2000 chars)
      if (ctxStr.length >= 2000) {
        ctxStr = await prioritizeContextWithAI(ctxStr, patientId);
      }
    }

    /* 3 · Prompt -------------------------------------------------------*/
    const prompt = `Act as an expert in rare diseases. Read the clinical information and extract exclusively a JSON ARRAY of strings, where each string represents a real and concrete unmet need of people with rare diseases. Do not add explanations or extra formatting.

These needs should reflect the lack of diagnosis, treatment, knowledge, or real support that patients face, beyond what is usually superficially declared. Valid output example: ["Need 1","Need 2"]

IMPORTANT: Respond in the SAME LANGUAGE as the patient context provided below.

## Patient Context
${ctxStr}`.trim();

    /* 4 · Llamada REST a Azure OpenAI ---------------------------------*/
    const deployment = 'gpt-4o';
    const url = `https://${azureInstance}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${config.OPENAI_API_VERSION}`;

    const { data } = await axios.post(
      url,
      {
        messages: [
          { role: 'system', content: 'You are an expert in rare diseases. Always respond in the same language as the provided patient context.' },
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
      if (!useEventsAndDocuments) {
        // Usar resumen del paciente
        pubsub.sendToUser(encryptedUserId, {
          type: 'dxgpt-processing',
          taskId,
          patientId: encryptedPatientId,
          status: 'loading-summary',
          message: 'Cargando resumen del paciente...',
          progress: 5
        });
        
        const patientSummary = await getPatientSummaryIfExists(patientId);
        if (patientSummary) {
          description = patientSummary;
          console.log('📋 Usando resumen del paciente (final_card.txt)');
          
          pubsub.sendToUser(encryptedUserId, {
            type: 'dxgpt-processing',
            taskId,
            patientId: encryptedPatientId,
            status: 'summary-loaded',
            message: 'Resumen cargado, preparando análisis...',
            progress: 15
          });
        } else {
          useEventsAndDocuments = true;
        }
      }
      
      if (useEventsAndDocuments) {
        // Obtener datos raw para contar documentos
        const raw = await patientContextService.aggregateClinicalContext(patientId);
        const documentCount = raw.documents?.length || 0;
        
        // Enviar actualización de progreso
        pubsub.sendToUser(encryptedUserId, {
          type: 'dxgpt-processing',
          taskId,
          patientId: encryptedPatientId,
          status: 'building-context',
          message: `Construyendo contexto desde ${documentCount} documentos...`,
          progress: 10
        });
        
        // Construir contexto con actualizaciones de progreso
        description = await buildContextStringWithProgress(raw, patientId, userId, taskId, documentCount);
        const originalLength = description.length;
        
        // Optimizar contexto con IA
        if (description.length >= 2000) {
          pubsub.sendToUser(encryptedUserId, {
            type: 'dxgpt-processing',
            taskId,
            patientId: encryptedPatientId,
            status: 'optimizing',
            message: 'Optimizando contexto con IA...',
            progress: 70
          });
          
          description = await prioritizeContextWithAI(description, patientId);
          
          if (description.length < 300 && originalLength > 2000) {
            console.warn('⚠️ Contexto optimizado demasiado corto, usando contexto original');
            description = await buildContextString(raw, patientId);
          }
        }
        
        // Validación final: Si el contexto excede 2000 caracteres, resumirlo
        const MAX_DXGPT_CHARS = 2000;
        if (description && description.length > MAX_DXGPT_CHARS) {
          console.warn(`⚠️ [Async] Contexto demasiado largo (${description.length} chars), aplicando resumen final...`);
          pubsub.sendToUser(encryptedUserId, {
            type: 'dxgpt-processing',
            taskId,
            patientId: encryptedPatientId,
            status: 'summarizing-final',
            message: 'Resumiendo contexto final para cumplir límite de caracteres...',
            progress: 75
          });
          
          description = await summarizeContext(description, patientId);
          console.log(`✅ [Async] Contexto resumido a ${description.length} caracteres`);
        }
      }
    }
    
    // Validar que tenemos descripción
    if (!description || !description.trim()) {
      throw new Error('No se pudo obtener la descripción del paciente');
    }
    
    // Validación final adicional (por si acaso): Si el contexto excede 2000 caracteres, resumirlo
    // Esto es una capa de seguridad adicional después de la validación dentro del bloque useEventsAndDocuments
    const MAX_DXGPT_CHARS_FINAL = 2000;
    if (description.length > MAX_DXGPT_CHARS_FINAL) {
      console.warn(`⚠️ [Async] Contexto aún demasiado largo después de optimización (${description.length} chars), aplicando resumen final...`);
      pubsub.sendToUser(encryptedUserId, {
        type: 'dxgpt-processing',
        taskId,
        patientId: encryptedPatientId,
        status: 'summarizing-final',
        message: 'Resumiendo contexto final para cumplir límite de caracteres...',
        progress: useEventsAndDocuments ? 82 : 77
      });
      
      description = await summarizeContext(description, patientId);
      console.log(`✅ [Async] Contexto resumido a ${description.length} caracteres`);
    }
    
    // Llamar a DxGPT API
    pubsub.sendToUser(encryptedUserId, {
      type: 'dxgpt-processing',
      taskId,
      patientId: encryptedPatientId,
      status: 'calling-api',
      message: 'Consultando DxGPT API...',
      progress: useEventsAndDocuments ? 85 : 80
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

async function handleDxGptRequest(req, res) {
  try {
    // console.log('req.body', req.body);
    const patientId = crypt.decrypt(req.params.patientId);
    const lang      = req.body?.lang || 'en';
    const custom    = req.body?.customMedicalDescription;
    const userId     = req.user; // userId del usuario autenticado
    const useEventsAndDocuments = req.body?.useEventsAndDocuments === true;

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
      if (!useEventsAndDocuments) {
        // Primero intentar obtener el resumen del paciente si existe
        const patientSummary = await getPatientSummaryIfExists(patientId);
        if (patientSummary) {
          // Usar el resumen existente directamente
          description = patientSummary;
          console.log('📋 Usando resumen del paciente (final_card.txt)');
        } else {
          // Si no hay resumen, construir el contexto desde cero
          useEventsAndDocuments = true;
        }
      }
      
      if (useEventsAndDocuments) {
        // Construir el contexto desde eventos y documentos
        console.log('📋 Construyendo contexto desde eventos y documentos');
        const raw  = await patientContextService.aggregateClinicalContext(patientId);
        // console.log(`>> (from f:aggregateClinicalContext) raw data from patient ${patientId}:`);
        // console.log(raw);
        description = await buildContextString(raw, patientId);
        const originalLength = description.length;
        
        // Optimizar contexto con IA para diferenciar permanente/crónico de puntual
        // Solo si el contexto es suficientemente largo (>= 2000 chars)
        if (description.length >= 2000) {
          description = await prioritizeContextWithAI(description, patientId);
          
          // Validar que el contexto optimizado no sea demasiado corto
          if (description.length < 300 && originalLength > 2000) {
            console.warn('⚠️ Contexto optimizado demasiado corto, usando contexto original');
            description = await buildContextString(raw, patientId);
          }
        }
      }
    }

    // Validación final: Si el contexto excede 2000 caracteres, resumirlo
    const MAX_DXGPT_CHARS = 2000;
    if (description && description.length > MAX_DXGPT_CHARS) {
      console.warn(`⚠️ Contexto demasiado largo (${description.length} chars), aplicando resumen final antes de enviar a DxGPT...`);
      description = await summarizeContext(description, patientId);
      console.log(`✅ Contexto resumido a ${description.length} caracteres`);
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
      // Primero intentar obtener el resumen del paciente si existe
      const patientSummary = await getPatientSummaryIfExists(patientId);
      
      if (patientSummary) {
        // Usar el resumen existente directamente
        description = patientSummary;
        console.log('📋 Usando resumen del paciente (final_card.txt)');
      } else {
        // Si no hay resumen, construir el contexto desde cero
        const raw       = await patientContextService.aggregateClinicalContext(patientId);
        description = await buildContextString(raw, patientId);
        // Optimizar contexto con IA para diferenciar permanente/crónico de puntual
        // Solo si el contexto es suficientemente largo (>= 2000 chars)
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
 * 4. EXPORTS
 *------------------------------------------------------------------*/
module.exports = {
  handleRarescopeRequest,
  handleDxGptRequest,
  handleDiseaseInfoRequest
};