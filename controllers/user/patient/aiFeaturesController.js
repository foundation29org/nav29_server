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
const { graph }             = require('../../../services/agent');
const crypt                 = require('../../../services/crypt');
const config                = require('../../../config');
const pubsub                = require('../../../services/pubsub');
const insights              = require('../../../services/insights');
const axios                 = require('axios');

const { Client }            = require('langsmith');
const { LangChainTracer }   = require('@langchain/core/tracers/tracer_langchain');

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
        'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY
      }
    }
  );
  return data?.result === 'success' ? data.data.summary : null;
}

/** (c) Construye string legible a partir del contexto RAW */
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
    /* STEP 0 · Security -------------------------------------------------- */
    const encryptedId   = req.params.patientId;
    const patientId     = crypt.decrypt(encryptedId);
    console.log(`🩺  RARESCOPE » Patient ${patientId}`);

    /* STEP 1 · Context RAW ---------------------------------------------- */
    const rawCtx = await patientContextService.aggregateClinicalContext(patientId);
    const ctxStr = await buildContextString(rawCtx, patientId);

    /* STEP 2 · LLM Prompt ------------------------------------------------ */
    const prompt = `
Actúa como un especialista médico experto en enfermedades raras. Analiza los documentos médicos del paciente y proporciona un resumen estructurado.

**INSTRUCCIONES**
1. Lee cuidadosamente todos los documentos médicos proporcionados
2. Crea un resumen completo y bien estructurado de la información médica
3. Identifica y lista los fenotipos clave observados
4. Sugiere posibles diagnósticos o enfermedades raras candidatas basándote en los síntomas y hallazgos
5. Presenta la información de forma clara y organizada

**FORMATO DE RESPUESTA**
## Resumen del Caso
### Información del Paciente
### Resumen de Documentos Médicos
### Hallazgos Principales
### Fenotipos Identificados
### Posibles Diagnósticos
### Recomendaciones

**CONTEXTO DEL PACIENTE**
${ctxStr}`.trim();

    /* STEP 3 · LangSmith Tracing ---------------------------------------- */
    if (!config.LANGSMITH_API_KEY || !config.O_A_K) {
      return res.status(500).json({
        error: 'AI services not configured. Missing LANGSMITH_API_KEY or O_A_K',
        details: {
          langsmith: !config.LANGSMITH_API_KEY,
          openai   : !config.O_A_K
        }
      });
    }
    const projectName = `RARESCOPE - ${config.LANGSMITH_PROJECT} - ${patientId}`;
    const tracer      = new LangChainTracer({
      projectName,
      client2: new Client({
        apiUrl: 'https://api.smith.langchain.com',
        apiKey: config.LANGSMITH_API_KEY
      })
    });

    /* STEP 4 · LLM Call -------------------------------------------------- */
    const userId   = req.headers['user-id'] || req.query.userId || 'anonymous';
    const response = await graph.invoke(
      { messages: [{ role: 'user', content: prompt }] },
      {
        configurable: {
          patientId,
          systemTime  : new Date().toISOString(),
          tracer,
          context     : rawCtx,  // raw object for advanced chains
          docs        : rawCtx.documents,
          indexName   : patientId,
          containerName: '',
          userId,
          pubsubClient: pubsub
        },
        callbacks: [tracer]
      }
    );

    const aiAnswer = response.messages.at(-1).content;
    res.json({ success: true, analysis: aiAnswer });
  } catch (err) {
    console.error('❌ RAREScope error:', err);
    insights.error(err);
    res.status(500).json({
      error: 'Failed to process Rarescope analysis',
      message: err.message,
      code: err.code || 'RARESCOPE_ERROR',
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
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
      model    : 'gpt4o'
    };

    const { data } = await axios.post(
      'https://dxgpt-apim.azure-api.net/api/diagnose',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY
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
          'Content-Type': 'application/json'
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