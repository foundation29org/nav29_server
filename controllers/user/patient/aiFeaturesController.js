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
    console.log('=== DXGPT DEBUG START ===');
    
    // Get and decrypt patientId
    const encryptedPatientId = req.params.patientId;
    const decryptedPatientId = crypt.decrypt(encryptedPatientId);
    console.log('1. Patient ID decrypted:', decryptedPatientId);
    
    // Optional useSummary parameter from request body
    const useSummary = req.body && req.body.useSummary || false;
    console.log('2. UseSummary:', useSummary);
    
    // Get patient context
    console.log('3. Attempting to aggregate patient context...');
    const patientContext = await patientContextService.aggregatePatientContext(decryptedPatientId);
    console.log('4. Context aggregated successfully, length:', patientContext.length);
    console.log('5. Context preview (first 200 chars):', patientContext.substring(0, 200));
    
    // Check if AI services are properly configured
    console.log('6. Checking AI configuration...');
    console.log('   LANGSMITH_API_KEY exists:', !!config.LANGSMITH_API_KEY);
    console.log('   O_A_K exists:', !!config.O_A_K);
    
    if (!config.LANGSMITH_API_KEY || !config.O_A_K) {
      console.log('7. ERROR: AI services not configured');
      return res.status(500).json({ 
        error: 'AI services not configured. Missing LANGSMITH_API_KEY or O_A_K',
        details: {
          langsmith: !config.LANGSMITH_API_KEY,
          openai: !config.O_A_K
        }
      });
    }
    
    console.log('7. AI services configured, preparing prompt...');
    
    // If services are configured, try the full analysis
    const dxGptPromptTemplate = `Actúa como un médico experto en diagnóstico diferencial. Analiza el historial médico del paciente y proporciona un análisis estructurado de posibles diagnósticos.

**INSTRUCCIONES:**
1. Lee cuidadosamente toda la información médica proporcionada
2. Identifica síntomas, signos y hallazgos relevantes
3. Genera una lista de diagnósticos diferenciales ordenada por probabilidad
4. Justifica cada diagnóstico con evidencia del historial
5. Sugiere próximos pasos para confirmar o descartar cada diagnóstico

**FORMATO DE RESPUESTA:**
Usa el siguiente formato con títulos en markdown:

## Resumen del Caso

### Síntomas y Signos Principales
[Lista de los hallazgos más relevantes]

### Diagnóstico Diferencial

#### 1. [Diagnóstico más probable] - Probabilidad: Alta
**Justificación:** [Evidencia del historial que apoya este diagnóstico]
**Criterios diagnósticos:** [Si aplica]
**Próximos pasos:** [Estudios o pruebas recomendadas]

#### 2. [Segundo diagnóstico] - Probabilidad: Media
**Justificación:** [Evidencia]
**Criterios diagnósticos:** [Si aplica]
**Próximos pasos:** [Recomendaciones]

[Continuar con otros diagnósticos relevantes...]

### Estudios Recomendados
[Lista priorizada de estudios o pruebas]

### Consideraciones Adicionales
[Factores de riesgo, antecedentes relevantes, etc.]

**HISTORIAL DEL PACIENTE:**
{context}`;

    const finalPrompt = dxGptPromptTemplate.replace('{context}', patientContext);
    console.log('8. Final prompt prepared, length:', finalPrompt.length);
    
    const projectName = `DXGPT - ${config.LANGSMITH_PROJECT} - ${decryptedPatientId}`;
    const client2 = new Client({
      apiUrl: "https://api.smith.langchain.com",
      apiKey: config.LANGSMITH_API_KEY,
    });
    
    let tracer = new LangChainTracer({
      projectName: projectName,
      client2,
    });
    
    // Get userId from request headers or body
    const userId = req.headers['user-id'] || req.body.userId || 'anonymous';
    console.log('9. UserId:', userId);
    
    console.log('10. Invoking AI agent...');
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
    
    console.log('11. AI agent response received');
    const aiResponse = resAgent.messages[resAgent.messages.length - 1].content;
    console.log('12. AI response length:', aiResponse.length);
    console.log('13. AI response preview (first 200 chars):', aiResponse.substring(0, 200));
    
    console.log('14. Sending success response');
    res.status(200).send({ 
      success: true, 
      analysis: aiResponse 
    });
    
    console.log('=== DXGPT DEBUG END SUCCESS ===');
    
  } catch (error) {
    console.log('=== DXGPT DEBUG ERROR ===');
    console.error('Error processing DxGPT request:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    insights.error(error);
    
    res.status(500).json({
      error: 'Failed to process DxGPT analysis',
      message: error.message,
      code: error.code || 'DXGPT_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

module.exports = {
  handleRarescopeRequest,
  handleDxGptRequest
};