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

const { generatePatientUUID } = require('../../../services/uuid');

/*--------------------------------------------------------------------
 * 2. HELPERS ───────────── ✂ ────────────────────────────────────────*/

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
async function summarizeWithDxgpt({ text, name, patientId }) {
  if (!config.DXGPT_SUBSCRIPTION_KEY || !text || text.length < 100) return null;

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
      // Si falla el resumen, devolver los primeros 8000 caracteres
      return contextText.substring(0, 8000);
    }
  } catch (error) {
    console.error('❌ Error al resumir contexto:', error.message);
    // En caso de error, devolver los primeros 8000 caracteres
    return contextText.substring(0, 8000);
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
    out += 'MEDICAL DOCUMENTS INFORMATION:\n';
    for (const doc of documents) {
      const summary = await summarizeWithDxgpt({ ...doc, patientId });
      out += `
  Document: ${doc.name} (${doc.date || 'N/A'})
  ${summary ? `Summary: ${summary}` : '⚠ No summary (short or missing OCR text)'}
`;
    }
  }

  /* ▸ Verificar longitud y resumir si es necesario ------------------ */
  if (out.length > 3000) {
    console.log(`📊 Contexto demasiado largo (${out.length} caracteres), aplicando resumen...`);
    out = await summarizeContext(out, patientId);
  }

  return out;
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
    }

    /* 3 · Prompt -------------------------------------------------------*/
    const prompt = `Actúa como un experto en enfermedades raras. Lee la información clínica y extrae exclusivamente un ARRAY JSON de cadenas, donde cada cadena represente una necesidad no cubierta real y concreta de las personas con enfermedades raras. No añadas explicaciones ni formato extra.

Estas necesidades deben reflejar la falta de diagnóstico, tratamiento, conocimiento o apoyo real que enfrentan los pacientes, más allá de lo que suele declararse superficialmente. Ejemplo de salida válida: ["Necesidad 1","Necesidad 2"]


## Contexto del Paciente
${ctxStr}`.trim();

    /* 4 · Llamada REST a Azure OpenAI ---------------------------------*/
    const deployment = 'gpt-4o';
    const url = `https://${azureInstance}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${config.OPENAI_API_VERSION}`;

    const { data } = await axios.post(
      url,
      {
        messages: [
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
async function handleDxGptRequest(req, res) {
  try {
    // console.log('req.body', req.body);
    const patientId = crypt.decrypt(req.params.patientId);
    const lang      = req.body?.lang || 'en';
    const custom    = req.body?.customMedicalDescription;

    /* ▸ Context (solo si no lo trae el caller) ------------------------- */
    let description = custom;
    if (!description) {
      const raw  = await patientContextService.aggregateClinicalContext(patientId);
      // console.log(`>> (from f:aggregateClinicalContext) raw data from patient ${patientId}:`);
      // console.log(raw);
      description = await buildContextString(raw, patientId);
    }

    const body = {
      description,
      myuuid   : generatePatientUUID(patientId),
      lang,
      timezone : 'Europe/Madrid',
      diseases_list: req.body?.diseases_list || '',
      model    : 'gpt5mini',
      response_mode: 'direct'
    };

    const { data } = await axios.post(
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
    res.json({ success: true, analysis: data });
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
      const raw       = await patientContextService.aggregateClinicalContext(patientId);
      description = await buildContextString(raw, patientId);
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