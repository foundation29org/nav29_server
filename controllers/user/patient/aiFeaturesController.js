'use strict'

const patientContextService = require('../../../services/patientContextService');
const { graph } = require('../../../services/agent');
const crypt = require('../../../services/crypt');
const insights = require('../../../services/insights');
const { LangChainTracer } = require("@langchain/core/tracers/tracer_langchain");
const { Client } = require("langsmith");
const config = require('../../../config');
const pubsub = require('../../../services/pubsub');

async function handleRarescopeRequest(req, res) {
  try {
    // Get and decrypt patientId
    const encryptedPatientId = req.params.patientId;
    const decryptedPatientId = crypt.decrypt(encryptedPatientId);
    
    // Get patient context
    const patientContext = await patientContextService.aggregatePatientContext(decryptedPatientId);
    
    // Check if AI services are properly configured
    if (!config.LANGSMITH_API_KEY || !config.O_A_K) {
      return res.status(500).json({ 
        error: 'AI services not configured. Missing LANGSMITH_API_KEY or O_A_K',
        details: {
          langsmith: !config.LANGSMITH_API_KEY,
          openai: !config.O_A_K
        }
      });
    }
    
    // If services are configured, try the full analysis
    const rarescopePromptTemplate = `Actúa como un especialista médico experto en enfermedades raras. Analiza los documentos médicos del paciente y proporciona un resumen estructurado.

**INSTRUCCIONES:**
1. Lee cuidadosamente todos los documentos médicos proporcionados
2. Crea un resumen completo y bien estructurado de la información médica
3. Identifica y lista los fenotipos clave observados
4. Sugiere posibles diagnósticos o enfermedades raras candidatas basándote en los síntomas y hallazgos
5. Presenta la información de forma clara y organizada

**FORMATO DE RESPUESTA:**
Usa el siguiente formato con títulos en markdown:

## Resumen del Caso

### Información del Paciente
[Resumen de datos demográficos y contexto relevante]

### Resumen de Documentos Médicos
[Síntesis de la información más relevante de los documentos]

### Hallazgos Principales
[Lista de los hallazgos médicos más significativos]

### Fenotipos Identificados
[Lista detallada de fenotipos observados con códigos HPO si es posible]

### Posibles Diagnósticos
[Lista de enfermedades raras candidatas con justificación breve]

### Recomendaciones
[Sugerencias para próximos pasos o estudios adicionales]

**CONTEXTO DEL PACIENTE:**
{context}`;
    const finalPrompt = rarescopePromptTemplate.replace('{context}', patientContext);
    
    const projectName = `RARESCOPE - ${config.LANGSMITH_PROJECT} - ${decryptedPatientId}`;
    const client2 = new Client({
      apiUrl: "https://api.smith.langchain.com",
      apiKey: config.LANGSMITH_API_KEY,
    });
    
    let tracer = new LangChainTracer({
      projectName: projectName,
      client2,
    });
    
    // Get userId from request headers or params (not body since it's a GET request)
    const userId = req.headers['user-id'] || req.query.userId || 'anonymous';
    
    const resAgent = await graph.invoke({
      messages: [
        {
          role: "user",
          content: finalPrompt,
        },
      ],
    },
    { 
      configurable: { 
        patientId: decryptedPatientId,
        systemTime: new Date().toISOString(),
        tracer: tracer,
        context: [],
        docs: [],
        indexName: decryptedPatientId,
        containerName: '',
        userId: userId,
        pubsubClient: pubsub
      },
      callbacks: [tracer]
    });
    
    const aiResponse = resAgent.messages[resAgent.messages.length - 1].content;
    
    res.status(200).send({ 
      success: true, 
      analysis: aiResponse 
    });
    
  } catch (error) {
    console.error('Error processing Rarescope request:', error);
    insights.error(error);
    
    res.status(500).json({
      error: 'Failed to process Rarescope analysis',
      message: error.message,
      code: error.code || 'RARESCOPE_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

async function handleDxGptRequest(req, res) {
  try {
    // 1. Step: Get and decrypt patientId
    const encryptedPatientId = req.params.patientId;
    const decryptedPatientId = crypt.decrypt(encryptedPatientId);
    
    // 2. Step: Get language from request (default to 'en')
    const lang = req.body && req.body.lang || 'en';
    
    // 3. Step: Check if DxGPT API is properly configured
    if (!config.DXGPT_SUBSCRIPTION_KEY) {
      return res.status(500).json({ 
        error: 'DxGPT service not configured. Missing DXGPT_SUBSCRIPTION_KEY'
      });
    }
    
    // 4. Step: Get patient context
    const patientContext = await patientContextService.aggregatePatientContext(decryptedPatientId);
    
    // 5. Step: Prepare DxGPT API request
    const body = {
      description: "El paciente tiene trece meses. Primera convulsión focal a los tres meses. Convulsiones múltiples tónico-clónicas. Convulsiones febriles. Un estado epiléptico a los ocho meses.", // Using raw context as description
      myuuid: generateUUID(),
      lang: lang,
      timezone: 'Europe/Madrid',
      diseases_list: '',
      model: 'gpt4o'
    };
    
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY
    };
    
    // 6. Step: Make API call to DxGPT
    const axios = require('axios');
    const response = await axios.post('https://dxgpt-apim.azure-api.net/api/diagnose', body, { headers });
    
    // 7. Step: Return response
    res.status(200).send({ 
      success: true, 
      analysis: response.data 
    });
    
  } catch (error) {
    console.error('Error processing DxGPT request:', error);
    insights.error(error);
    
    res.status(500).json({
      error: 'Failed to process DxGPT analysis',
      message: error.message,
      code: error.code || 'DXGPT_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Helper function to generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

module.exports = {
  handleRarescopeRequest,
  handleDxGptRequest
};