const { ChatOpenAI, OpenAIEmbeddings } = require("@langchain/openai");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { ChatPromptTemplate } = require("@langchain/core/prompts");
const Events = require('../models/events')
const Patient = require('../models/patient')
const Document = require('../models/document')
const config = require('../config')
const pubsub = require('../services/pubsub');
const azure_blobs = require('../services/f29azure');
const translate = require('../services/translation');
const crypt = require('../services/crypt');
const email = require('../services/email');
const insights = require('../services/insights');
const countTokens = require('@anthropic-ai/tokenizer');
const { pull } = require("langchain/hub");
const { Client } = require("langsmith");
const { LangChainTracer } = require("@langchain/core/tracers/tracer_langchain");
const { BedrockChat } = require("@langchain/community/chat_models/bedrock");
const { ChatBedrockConverse } = require("@langchain/aws");
const { ChatGoogleGenerativeAI } = require("@langchain/google-genai");
const axios = require('axios');
const { SearchIndexClient, SearchClient } = require("@azure/search-documents");
const { AzureKeyCredential } = require("@azure/core-auth");
const { createChunksIndex } = require('./vectorStoreService');

const O_A_K = config.O_A_K;
const OPENAI_API_VERSION = config.OPENAI_API_VERSION;
const OPENAI_API_BASE = config.OPENAI_API_BASE;
const O_A_K_GPT4O = config.O_A_K_GPT4O;
const OPENAI_API_BASE_GPT4O = config.OPENAI_API_BASE_GPT4O;
const O_A_K_GPT5MINI = config.O_A_K_GPT5MINI;

const embeddings = new OpenAIEmbeddings({
  azureOpenAIApiKey: config.O_A_K,
  azureOpenAIApiVersion: config.OPENAI_API_VERSION,
  azureOpenAIApiInstanceName: config.OPENAI_API_BASE,
  azureOpenAIApiDeploymentName: "nav29embeddings-large",
  model: "text-embedding-3-large",
  modelName: "text-embedding-3-large",
});

const BEDROCK_API_KEY = config.BEDROCK_USER_KEY;
const BEDROCK_API_SECRET = config.BEDROCK_USER_SECRET;


function createModels(projectName, modelType = null) {
  try {
    //console.log('Creating model:', modelType, 'for project:', projectName);
    
   

    let model = null;
    let tracer = null;

    // Si se especifica un tipo de modelo, solo crear ese
    if (modelType) {
      if (projectName !== 'default' && config.LANGSMITH_API_KEY && config.LANGSMITH_API_KEY.trim() !== '') {
        try {
          const client = new Client({
            apiUrl: "https://api.smith.langchain.com",
            apiKey: config.LANGSMITH_API_KEY,
          });
          tracer = new LangChainTracer({
            projectName: projectName,
            client,
          });
        } catch (error) {
          console.warn('LangSmith tracer initialization failed, continuing without tracer:', error.message);
          // Continuar sin tracer - no loguear el error completo para evitar spam
          tracer = null;
        }
      } else if (projectName !== 'default') {
        // Silenciosamente continuar sin tracer si no hay API key
        tracer = null;
      }
      switch(modelType) {
        case 'azuregpt4o':
          model = new ChatOpenAI({
            modelName: "gpt-4o",
            azure: true,
            azureOpenAIApiKey: O_A_K_GPT4O,
            azureOpenAIApiVersion: OPENAI_API_VERSION,
            azureOpenAIApiInstanceName: OPENAI_API_BASE_GPT4O,
            azureOpenAIApiDeploymentName: "gpt-4o",
            temperature: 0,
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          //poner  azureOpenAIEndpoint  undefined
          model.azureOpenAIEndpoint = undefined;
          break;
          case 'gpt4omini':
            model = new ChatOpenAI({
              modelName: "gpt-4o-mini-nav29",
              azure: true,
              azureOpenAIApiKey: O_A_K_GPT4O,
              azureOpenAIApiVersion: OPENAI_API_VERSION,
              azureOpenAIApiInstanceName: OPENAI_API_BASE_GPT4O,
              azureOpenAIApiDeploymentName: "gpt-4o-mini-nav29",
              temperature: 0,
              timeout: 140000,
              callbacks: tracer ? [tracer] : undefined
            });
            //poner  azureOpenAIEndpoint  undefined
            model.azureOpenAIEndpoint = undefined;
            break;
        case 'gpt5mini':
          model = new ChatOpenAI({
            modelName: "gpt-5-mini",
            azure: true,
            azureOpenAIApiKey: O_A_K_GPT5MINI,
            azureOpenAIApiVersion: '2024-12-01-preview',
            // Endpoint completo en región distinta
            azureOpenAIEndpoint: 'https://foundation29-ai-aiservices.cognitiveservices.azure.com/',
            azureOpenAIApiDeploymentName: "gpt-5-mini",
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          break;
        case 'model32k':
          model = new ChatOpenAI({
            modelName: "gpt-4-32k-0613",
            azureOpenAIApiKey: O_A_K,
            azureOpenAIApiVersion: OPENAI_API_VERSION,
            azureOpenAIApiInstanceName: OPENAI_API_BASE,
            azureOpenAIApiDeploymentName: "test32k",
            temperature: 0,
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          model.azureOpenAIEndpoint = undefined;
          break;
        case 'claude3sonnet':
          model = new ChatBedrockConverse({
            model: "anthropic.claude-3-sonnet-20240229-v1:0",
            region: "eu-west-3",
            credentials: {
              accessKeyId: BEDROCK_API_KEY,
              secretAccessKey: BEDROCK_API_SECRET,
            },
            temperature: 0,
            maxTokens: 8191,
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          break;
        case 'gemini25pro':
          model = new ChatGoogleGenerativeAI({
            model: "gemini-2.5-pro",
            apiKey: config.GOOGLE_API_KEY,
            temperature: 0,
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          break;
        case 'gemini3propreview':
          model = new ChatGoogleGenerativeAI({
            model: "gemini-3-pro-preview",
            apiKey: config.GOOGLE_API_KEY,
            temperature: 0,
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          break;
        case 'gemini3flashpreview':
          model = new ChatGoogleGenerativeAI({
            model: "gemini-3-flash-preview",
            apiKey: config.GOOGLE_API_KEY,
            temperature: 0,
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          break;
        case 'gemini25flash':
          model = new ChatGoogleGenerativeAI({
            model: "gemini-flash-latest",
            apiKey: config.GOOGLE_API_KEY,
            temperature: 0,
            timeout: 140000,
            callbacks: tracer ? [tracer] : undefined
          });
          break;
        case 'claude35sonnet':
          model = new ChatBedrockConverse({
            model: "eu.anthropic.claude-3-5-sonnet-20240620-v1:0",
            region: "eu-west-3",
            credentials: {
              accessKeyId: BEDROCK_API_KEY,
              secretAccessKey: BEDROCK_API_SECRET,
            },
            temperature: 0,
            callbacks: tracer ? [tracer] : undefined
          });
          break;
        // Añadir otros casos según necesidad
      }

      // Verificar la configuración del modelo
      if (model) {
        console.log('Model Configuration:', {
          hasAzureKey: !!model.azureOpenAIApiKey,
          instanceName: model.azureOpenAIApiInstanceName,
          deploymentName: model.azureOpenAIApiDeploymentName
        });
      }

      return { [modelType]: model };
    }

    // Si no se especifica tipo, mantener el comportamiento actual
    // ... resto del código actual ...
  } catch (error) {
    console.error('Error in createModels:', error);
    insights.error({ message: 'Error in createModels', error: error });
    throw error;
  }
}

async function getActualEvents(patientId) {
  return new Promise((resolve, reject) => {
    Events.find({ "createdBy": patientId, "status": "true" }, { "createdBy": false }, (err, eventsdb) => {
      if (err) {
        reject(err);
      } else {
        var listEventsdb = [];
        listEventsdb = eventsdb;
        resolve(listEventsdb);
      }
    });
  });
}

async function getAllEvents(patientId) {
  return new Promise((resolve, reject) => {
    Events.find({ "createdBy": patientId }, { "createdBy": false }, (err, eventsdb) => {
      if (err) {
        reject(err);
      } else {
        var listEventsdb = [];
        listEventsdb = eventsdb;
        resolve(listEventsdb);
      }
    });
  });
}

async function getPatientData(patientId) {
  return new Promise((resolve, reject) => {
    // console.log("PatientId: ", patientId);
    Patient.findById(patientId, { "gender": 1, "birthDate": 1, "_id": 0, "patientName": 1 }, (err, eventsdb) => {
      if (err) {
        reject(err);
      } else {
        // console.log("Eventsdb: ", eventsdb.toObject());
        resolve(eventsdb.toObject());
      }
    });
  });
}

async function getMostCommonLanguage(blobs, containerName) {
  try {
    // Get the language of the original documents (download from blob)
    const languageCounts = {};
    for (const blob of blobs) {
      if (blob.endsWith("language.txt")) {
        const language = await azure_blobs.downloadBlob(containerName, blob);
        if (languageCounts[language]) {
          languageCounts[language]++;
        } else {
          languageCounts[language] = 1;
        }
      }
    }

    // Find the language with the highest count
    let mostCommonLanguage = null;
    let highestCount = 0;
    for (const language in languageCounts) {
      if (languageCounts[language] > highestCount) {
        mostCommonLanguage = language;
        highestCount = languageCounts[language];
      }
    }

    return mostCommonLanguage;
  } catch (error) {
    insights.error(error);
    console.error(error);
    throw error;
  }
}

// Function to translate text
async function translateText(text, deepl_code, mostCommonLanguage) {
  // Don't try to translate if text is empty or an empty array
  //if (!text || (Array.isArray(text) && text.length === 0)) {
  if (!text ||
    (typeof text === 'string' && text.trim() === '') ||
    (Array.isArray(text) && text.every(t => typeof t !== 'string' || t.trim() === ''))) {
    return text;
  }
  // Si text es un objeto con propiedades, continua con la traducción
  if (typeof text === 'object' && !Array.isArray(text) && text !== null) {
    // Aquí puedes manejar la traducción para cada propiedad del objeto si es necesario
    // Por ejemplo, traducir cada propiedad del objeto
    /*for (const key in text) {
      if (typeof text[key] === 'string') {
        text[key] = await translate.deepLtranslate(text[key], deepl_code);
      }
    }*/
    for (const key in text) {
      const info = [{ "Text": key }];
      let inverseTranslatedText = await translate.getTranslationDictionaryInvertMicrosoft2(info, deepl_code);
      let translatedKey = inverseTranslatedText[0].translations[0].text
      //let translatedKey = await translate.deepLtranslate(key, deepl_code);
      if (typeof text[key] === 'string') {
        text[translatedKey] = await translate.deepLtranslate(text[key], deepl_code);
      } else {
        text[translatedKey] = text[key];
      }
      if (translatedKey !== key) {
        delete text[key];
      }
    }
    return text;
  }
  if (deepl_code == null) {
    // Do an Inverse Translation
    const info = [{ "Text": text }];
    const inverseTranslatedText = await translate.getTranslationDictionaryInvertMicrosoft2(info, mostCommonLanguage);
    if (inverseTranslatedText.error) {
      return text;
    } else {
      return inverseTranslatedText[0].translations[0].text;
    }
  } else {
    return await translate.deepLtranslate(text, deepl_code);
  }
}

async function summarizeServer(patientId, medicalLevel, docs) {
  // Refactor of the summarize function to be used completely and independently in the server

  const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
  let { gpt5mini } = createModels(projectName, 'gpt5mini');

  const summarize_prompt = await pull("foundation29/summarize-single_prompt_v1");

  const chatPrompt = summarize_prompt.pipe(gpt5mini);
  
  const summary = await chatPrompt.invoke({
    referenceDocs: docs,
    medicalLevel: medicalLevel
  });

  return summary.content;
}

async function extractAndParse(summaryText) {
  // Step 1: Extract Text using Regular Expressions
  const matches = summaryText.match(/<output>([\s\S]*?)<\/output>/);
  if (!matches) {
    console.warn("No matches found in <output> tags.");
    return "[]";
  }

  // Step 2: Convert Extracted Text to JSON
  try {
    // Consider only the first match
    const extractedJson = JSON.parse(matches[1]);
    return JSON.stringify(extractedJson);
  } catch (error) {
    console.warn("Invalid JSON format in <output> tags.");
    return "[]";
  }
}

async function timelineServer(patientId, docs, reportDate) {
  try {
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { gpt5mini } = createModels(projectName, 'gpt5mini');
    
    const reportDateStr = reportDate instanceof Date ? reportDate.toISOString().split('T')[0] : reportDate;

    let timeline_prompt;
    try {
      // Intentamos bajar el prompt del Hub
      timeline_prompt = await pull("foundation29/timeline-single_prompt_v2");
    } catch (e) {
      console.warn("Prompt foundation29/timeline-single_prompt_v2 not found or error pulling, using local fallback");
      timeline_prompt = ChatPromptTemplate.fromMessages([
        ["system", `You are a high-precision medical data extractor. Your goal is to create an EXHAUSTIVE timeline.
        
### MANDATORY RULES:
1. Scan from the very first line (Background/History).
2. ANCHORING FOR CHRONIC CONDITIONS: For items in "BACKGROUND" or "HISTORY" sections with NO year mentioned (e.g., Hiatal hernia, Chondromalacia):
   - Set "date": null
   - Set "present": true
3. REPORT DATE: Use {reportDate} for all findings, tests, and plans described as current or part of today's report.
4. ISO FORMAT: Always convert to YYYY-MM-DD. 
   - If only a year is available, use YYYY-01-01. 
   - If only month and year are available, use YYYY-MM-01.
   - NEVER output just "YYYY" or "YYYY-MM".
   - Always return the date as a STRING enclosed in quotes, never as a number.
5. Extract every surgery, diagnosis, medication, and abnormal test.
6. If unsure of the year for a past event, "null" is mandatory.
7. Write in English. Output MUST be a JSON array inside <output> tags.`],
        ["human", `REFERENCE DATE (Today): {reportDate}
DOCUMENT: {referenceDocs}
TASK: Extract all events into a JSON array inside <output> tags.`]
      ]);
    }

    const chatPrompt = timeline_prompt.pipe(gpt5mini);
    
    // Unimos el contenido de los documentos en un solo string para que el LLM lo vea todo claro
    const fullText = docs.map(d => d.pageContent).join("\n\n");

    const timeline = await chatPrompt.invoke({
      referenceDocs: fullText,
      reportDate: reportDateStr
    });

    // Log para ver qué está respondiendo exactamente el modelo de timeline
    console.log('--- TIMELINE LLM RAW OUTPUT ---');
    console.log(timeline.content);
    console.log('-------------------------------');

    return extractAndParse(timeline.content);
  } catch (error) {
    console.error('Error in timelineServer:', error);
    insights.error({ message: 'Error in timelineServer', error: error });
    throw error;
  }
}

async function anomaliesServer(patientId, docs) {
  // Refactor of the summarize function to be used completely and independently in the server
  try {
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { gpt5mini } = createModels(projectName, 'gpt5mini');

  const anomalies_prompt = await pull("foundation29/anomalies-single_prompt_v1");

  const chatPrompt = anomalies_prompt.pipe(gpt5mini);
  
  const anomalies = await chatPrompt.invoke({
    referenceDocs: docs
  });

    return extractAndParse(anomalies.content);
  } catch (error) {
    console.error('Error in anomaliesServer:', error);
    insights.error({ message: 'Error in anomaliesServer', error: error });
    throw error;
  }
}

async function processDocument(patientId, containerName, url, doc_id, filename, userId, saveTimeline, medicalLevel) {
  if (medicalLevel == "0") {
    medicalLevel = `\n\nThe reader is low literated and does not handle medical terminology. Please provide the summary in a way that is really easy to understand for a non-expert.`;
  } else if (medicalLevel == "1") {
    medicalLevel = `\n\nThe reader is a basic patient and does not handle advanced medical terminology. Please provide the summary in a way that is easy to understand for a non-expert.`;
  } else if (medicalLevel == "2") {
    medicalLevel = `\n\nThe reader is an advanced patient and does handle advanced medical terminology. Please provide the summary in a way that is easy to understand for that level.`;
  } else if (medicalLevel == "3") {
    medicalLevel = `\n\nThe reader is a science expert/clinician and does handle advanced medical terminology. Please provide the summary in a way that is easy to understand for that level.`;
  }

  const sendMessage = (status, additionalData = {}, patientId) => {
    const patientIdCrypt = crypt.encrypt(patientId);
    let docIdEnc = crypt.encrypt(doc_id);
    const message = {
      time: new Date().toISOString(),
      docId: docIdEnc,
      status: status,
      filename: filename,
      ...additionalData,
      patientId: patientIdCrypt
    };
    pubsub.sendToUser(userId, message);
  };

  const handleBlobDownload = async (container, url) => {
    try {
      return await azure_blobs.downloadBlob(container, url);
    } catch (error) {
      try {
        await email.sendMailError(error, "download", patientId, url);
      } catch (error) {
        console.error(`Failed to send email: ${error.message}`);
        insights.error(`Failed to send email: ${error.message}`);
      }
      let erromsg = `Failed to download blob: ${error.message}`;
      throw new Error(erromsg); 
    }
  };

  const updateDocStatus = async (status) => {
    try {
      await updateDocumentStatus(doc_id, status);
    } catch (error) {
      let erromsg = `Failed to update document status to ${status}: ${error.message}`;
      throw new Error(erromsg); 
    }
  };

  try {
    sendMessage("creando resumen", {}, patientId);
    await updateDocStatus('creando resumen');

    let url2 = url.replace(/\/[^\/]*$/, '/clean_translated.txt');
    let url2_raw = url.replace(/\/[^\/]*$/, '/extracted_translated.txt');
    let lang_url = url.replace(/\/[^\/]*$/, '/language.txt');
    let text, raw_text, doc_lang;
    try {
      text = await azure_blobs.downloadBlob(containerName, url2);
    } catch (error) {
      insights.error(error);
      try {
        await email.sendMailError(error, "download", patientId, url)
      } catch (error) {
        console.error(`Failed to send email: ${error.message}`);
      }

      console.error('Error downloading the translated blob:', error);
      let url3 = url.replace(/\/[^\/]*$/, '/extracted.txt');
      text = await handleBlobDownload(containerName, url3);
    }
    raw_text = await handleBlobDownload(containerName, url2_raw);
    doc_lang = await handleBlobDownload(containerName, lang_url);

    const clean_text = text.replace(/{/g, '{{').replace(/}/g, '}}');
    const clean_raw_text = raw_text.replace(/{/g, '{{').replace(/}/g, '}}');

    const document = await Document.findById(doc_id);
    const reportDate = document.originaldate || document.date || new Date();
    const dateStatus = document.originaldate ? 'confirmed' : 'missing';

    // Vectorización de chunks para la nueva arquitectura
    try {
      const chunkSplitter = new RecursiveCharacterTextSplitter({ 
        chunkSize: 3000, 
        chunkOverlap: 200,
        separators: ["\n\n", "\n", ". ", " ", ""]
      });
      
      const chunkDocs = await chunkSplitter.createDocuments([clean_raw_text]);
      
      // Obtener embeddings para todos los chunks
      const texts = chunkDocs.map(d => d.pageContent);
      const embeddingsArrays = await embeddings.embedDocuments(texts);

      const searchClient = new SearchClient(
        config.SEARCH_API_ENDPOINT, 
        config.cogsearchIndexChunks, 
        new AzureKeyCredential(config.SEARCH_API_KEY)
      );

      const chunksToUpload = chunkDocs.map((chunk, index) => {
        const metadata = {
          id: `${doc_id}_${index}`,
          patientId: patientId,
          documentId: doc_id,
          reportDate: reportDate.toISOString(),
          dateStatus: dateStatus,
          filename: filename,
          documentType: 'document_chunk'
        };
        return {
          id: metadata.id,
          patientId: metadata.patientId,
          documentId: metadata.documentId,
          reportDate: metadata.reportDate,
          dateStatus: metadata.dateStatus,
          filename: metadata.filename,
          documentType: metadata.documentType,
          content: chunk.pageContent,
          content_vector: embeddingsArrays[index], // Usamos nombre estándar
          metadata: JSON.stringify(metadata) // Para compatibilidad con LangChain
        };
      });

      // Asegurar que el índice existe primero
      await createChunksIndex(embeddings, config.SEARCH_API_ENDPOINT, config.SEARCH_API_KEY);
      
      // Subir documentos directamente con el cliente de Azure
      await searchClient.uploadDocuments(chunksToUpload);
      
      // Guardar chunks en Blob Storage para futura reindexación sin re-parsear
      try {
        const chunksUrl = url.replace(/\/[^\/]*$/, '/chunks.json');
        await azure_blobs.createBlob(containerName, chunksUrl, JSON.stringify(chunksToUpload));
      } catch (bError) {
        console.warn('No se pudo guardar backup de chunks en blob:', bError.message);
      }

      console.log(`Documento ${doc_id} vectorizado en chunks (${chunksToUpload.length} fragmentos)`);
    } catch (vError) {
      console.error('Error vectorizando chunks:', vError);
      insights.error({ message: 'Error vectorizando chunks', error: vError, docId: doc_id });
      // No bloqueamos el proceso principal si falla la vectorización por ahora
    }

    const textSplitter = new RecursiveCharacterTextSplitter({ 
      chunkSize: 3000, 
      chunkOverlap: 200,
      separators: ["\n\n", "\n", ". ", " ", ""]
    });
    const docs = await textSplitter.createDocuments([clean_text]);
    const raw_docs = await textSplitter.createDocuments([clean_raw_text]);
    // summarizeServer(patientId, medicalLevel, docs),
    const [result, result2, result3] = await Promise.all([
      summarizeServer(patientId, medicalLevel, raw_docs),
      timelineServer(patientId, raw_docs, reportDate),
      anomaliesServer(patientId, raw_docs)
    ]);

    let anomalies;
    try {
      anomalies = JSON.parse(result3);
      sendMessage(anomalies.length > 0 ? "anomalies found" : "no anomalies found", { anomalies }, patientId);
      if (anomalies.length > 0) {
        await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/anomalies.json'), result3);
      }
    } catch (error) {
      insights.error(error);
      try {
        await email.sendMailError(error, "anomalies", patientId, url);
      } catch (error) {
        console.error(`Failed to send email: ${error.message}`);
      }

      sendMessage("error anomalies", { error: error }, patientId);
      await updateDocStatus('failed');
      return;
    }

    let deepl_code;
    try {
      deepl_code = await translate.getDeeplCode(doc_lang);
      await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/timelineEvents.json'), result2);
      if (saveTimeline) {
        let events = JSON.parse(result2);
        for (let event of events) {
          event.keyMedicalEvent = await translateText(event.keyMedicalEvent, deepl_code, doc_lang);
        }
        
        saveEventTimeline(events, patientId, doc_id, userId, filename, reportDate, dateStatus);
        sendMessage("timeline ready", {}, patientId);
      }
    } catch (error) {
      insights.error(error);
      try {
        email.sendMailError(error, "timeline", patientId, url);
      } catch (error) {
        console.error(`Failed to send email: ${error.message}`);
      }

      sendMessage("error timeline", { error: error }, patientId);
      await updateDocStatus('failed');
      return;
    }

    try {
      let summaryText = result; //.summary;
      // let runId = result.run_id;

      // await Document.findByIdAndUpdate(doc_id, { langsmithRunId: runId }, { new: true });

      await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/summary_translated.txt'), summaryText);
      let summaryJson = await translateText(summaryText, deepl_code, doc_lang);
      await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/summary.txt'), summaryJson);

      sendMessage("resumen ready", {}, patientId);
      await updateDocStatus('resumen ready');
    } catch (error) {
      insights.error(error);

      try {
        await email.sendMailError(error, "summarize", patientId, url);
      } catch (error) {
        console.error(`Failed to send email: ${error.message}`);
      }
      sendMessage("error summarize", { error: error }, patientId);
      await updateDocStatus('failed');
      return;
    }
  } catch (error) {
    insights.error({ message: 'Failed to summarize document: '+doc_id, error: error.message || error, stack: error.stack || 'No stack trace available' });
    try {
      email.sendMailError(error, "preparing", patientId, url);
    } catch (error) {
      console.error(`Failed to send email: ${error.message}`);
    }

    sendMessage("failed", { error: error }, patientId);
    await updateDocStatus('failed');
  }
}

function updateDocumentStatus(documentId, status) {
  return new Promise((resolve, reject) => {
    Document.findByIdAndUpdate(documentId, { status: status }, { new: true }, (err, documentUpdated) => {
      if (err) {
        reject(err);
      }
      resolve(documentUpdated);
    }
    )
  });
}

function saveEventTimeline(events, patientId, doc_id, userId, filename, reportDate, dateStatus) {
  for (let event of events) {
    let eventdb = new Events();

    // 1. DETERMINAR LA FECHA DEL EVENTO
    let finalDate = null;
    let finalDateConfidence = 'missing';

    if (event.date) {
      const dateStr = String(event.date);
      // 1. Intentamos validar si es YYYY-MM-DD
      const validDate = validateDate(dateStr);
      if (validDate) {
        finalDate = validDate;
        finalDateConfidence = 'confirmed';
      } else {
        // 2. SOPORTE PARA YYYY-MM (ej: 2021-06)
        const monthMatch = dateStr.match(/^(\d{4})-(\d{2})$/);
        if (monthMatch) {
          finalDate = new Date(`${monthMatch[1]}-${monthMatch[2]}-01`);
          finalDateConfidence = 'confirmed';
        } else {
          // 3. Intentamos validar si es solo un año (YYYY)
          const yearMatch = dateStr.match(/^(\d{4})$/);
          if (yearMatch) {
            finalDate = new Date(`${yearMatch[1]}-01-01`);
            finalDateConfidence = 'confirmed';
          } else {
            // Fallback: usar la del informe pero marcamos la duda
            finalDate = reportDate;
            finalDateConfidence = dateStatus || 'estimated';
          }
        }
      }
    } else if (event.date === null) {
      // Caso explícito de condición crónica sin fecha (del Background)
      finalDate = null;
      finalDateConfidence = 'missing';
    } else {
      // Fallback total: heredamos la del documento
      finalDate = reportDate;
      finalDateConfidence = dateStatus || 'missing';
    }

    eventdb.date = finalDate;
    eventdb.dateConfidence = finalDateConfidence;
    eventdb.status = event.present;

    eventdb.name = event.keyMedicalEvent;
    eventdb.key = event.eventType;
    eventdb.origin = 'automatic';
    eventdb.docId = doc_id;
    eventdb.createdBy = patientId;
    eventdb.addedBy = crypt.decrypt(userId);

    // Nuevos campos de fuente para arquitectura de tres capas
    eventdb.source = {
      kind: 'document',
      documentId: doc_id,
      filename: filename,
      reportDate: reportDate
    };
    
    eventdb.confidence = 0.8; // Valor base para extracciones automáticas

    Events.findOne({ 
      "createdBy": patientId, 
      "name": event.keyMedicalEvent, 
      "key": event.eventType,
      "date": eventdb.date 
    }, { "createdBy": false }, (err, eventdb2) => {
      if (err) {
        insights.error(err);
      }
      if (!eventdb2) {
        eventdb.save((err, eventdbStored) => {
          if (err) {
            insights.error(err);
          }
        });
      } else {
        console.log('Event already exists for this date');
      }
    });
  }
}

async function categorizeDocs(userId, content, patientId, containerName, url, docId, filename) {
  return new Promise(async function (resolve, reject) {
    try {
      const patientIdCrypt = crypt.encrypt(patientId);
      let docIdEnc = crypt.encrypt(docId);
      const message = {"time": new Date().toISOString(), "docId": docIdEnc, "status": "categorizando texto", "filename": filename, "patientId": patientIdCrypt}
      pubsub.sendToUser(userId, message)

      // Create the models
      const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
      let { azuregpt4o } = createModels(projectName, 'azuregpt4o');

      // Format and call the prompt to categorize each document
      clean_doc = content.replace(/{/g, '{{').replace(/}/g, '}}');

      let selectedModel = azuregpt4o;

      chatPrompt = await pull("foundation29/categorize_docs_base_v1");

      const categoryChain = chatPrompt.pipe(selectedModel);
      const category = await categoryChain.invoke({
        doc: clean_doc,
      });

      console.log("Starting JSON parsing process...");
      console.log("category: ", category);
      // Function to attempt JSON parsing
      const attemptParse = (text, method) => {
        try {
          const parsed = JSON.parse(text);
          console.log(`Parsed successfully using ${method}`);
          return parsed;
        } catch (error) {
          console.log(`Failed to parse using ${method}: ${error.message}`);
          return null;
        }
      };

      // Try to parse the JSON object category
      let categoryJSON;

      // console.log("Raw category text:", category.content);

      // First attempt: direct parsing
      categoryJSON = attemptParse(category.content, "direct parsing");

      if (!categoryJSON) {
        // Second attempt: clean escaped quotes and newlines
        const cleanedText = category.content.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\n/g, '');
        categoryJSON = attemptParse(cleanedText, "cleaning escaped quotes");
      }

      if (!categoryJSON) {
        // Third attempt: remove markdown delimiters
        const regex = /^```json\n|\n```$/g;
        const cleanedData = category.content.replace(regex, '');
        categoryJSON = attemptParse(cleanedData, "removing markdown delimiters");
      }

      if (!categoryJSON) {
        // Fourth attempt: aggressive cleaning
        const aggressiveCleanText = category.content.replace(/[^\x20-\x7E]/g, "");
        categoryJSON = attemptParse(aggressiveCleanText, "aggressive cleaning");
      }

      if (categoryJSON) {
        // console.log("Final parsed Category JSON:", JSON.stringify(categoryJSON, null, 2));
        console.log("Finally parsed Category JSON!")
      } else {
        console.error("Failed to parse category JSON using all methods");
        throw new Error("Unable to parse category JSON");
      }

      // console.log("Category JSON: ", categoryJSON);
      // Get the category from the JSON object
      const categoryTag = categoryJSON.category;
      const documentDate = categoryJSON.document_date;

      const blob_response = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/clean_translated.txt'), JSON.stringify(categoryJSON))
      // Alert the client that the summary is ready (change status in the message)
      message["time"] = new Date().toISOString();
      message["status"] = "clean ready"
      message["patientId"] = patientIdCrypt
      pubsub.sendToUser(userId, message)

      const dateValidated = validateDate(documentDate);
      const message2 = {"time": new Date().toISOString(), "docId": docIdEnc, "status": "categoriria done", "filename": filename, "value": categoryTag, "date": dateValidated, "patientId": patientIdCrypt }
      pubsub.sendToUser(userId, message2)
      resolve({ categoryTag, documentDate });

    } catch (error) {
      console.log("Error happened: ", error)
      insights.error(error);
      const patientIdCrypt = crypt.encrypt(patientId);
      let docIdEnc = crypt.encrypt(docId);
      pubsub.sendToUser(userId, { "time": new Date().toISOString(), "docId": docIdEnc, "status": "error cleaning", "filename": filename, "error": error, "patientId": patientIdCrypt })
      reject(error);
    }
  });
}

function validateDate(documentDate) {
  // Verificar el formato básico de la fecha
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(documentDate)) {
    return null;
  }

  // Crear una fecha a partir de la cadena y verificar la validez
  const date = new Date(documentDate);
  const timestamp = Date.parse(documentDate);

  // Verificar que la fecha es válida y que no hay desbordamiento de mes
  if (!isNaN(date.getTime()) && !isNaN(timestamp) && documentDate === date.toISOString().split('T')[0]) {
    return date;
  } else {
    return null;
  }
}

async function anonymize(patientId, containerName, url, docId, filename, userId) {
  return new Promise(async (resolve, reject) => {
    try {
      let url2 = url.replace(/\/[^\/]*$/, '/fast_extracted_translated.txt');
      let lang_url = url.replace(/\/[^\/]*$/, '/language.txt');
      let text, doc_lang;

      try {
        // Try to download the translation
        text = await azure_blobs.downloadBlob(containerName, url2);
        doc_lang = await azure_blobs.downloadBlob(containerName, lang_url);
        //.log("Lang: ", doc_lang);
      } catch (error) {
        insights.error(error);
        console.error('Error downloading the translated blob:', error);
        // Handle the error and make a different call here
        // For example:
        let url3 = url.replace(/\/[^\/]*$/, '/fast_extracted.txt');
        text = await azure_blobs.downloadBlob(containerName, url3);
      }

      // Create the models
      const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
      let { gpt5mini} = createModels(projectName, 'gpt5mini');

      const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 15000 });
      const docs = await textSplitter.createDocuments([text]);

      let anonymize_prompt = await pull("foundation29/anonymize_doc_base_v1");

      // This function creates a document chain prompted to anonymize a set of documents.
      const chain = anonymize_prompt.pipe(gpt5mini);

      const patientIdCrypt = crypt.encrypt(patientId);
      let docIdEnc = crypt.encrypt(docId);
      const message = {"time": new Date().toISOString(), "docId": docIdEnc, "status": "anonimizando documentos", "filename": filename, "step": "anonymize", "patientId": patientIdCrypt }
      pubsub.sendToUser(userId, message)

      // Iterate over the documents and anonymize them, create a complete document with all the anonymized documents
      let anonymized_docs = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const res = await chain.invoke({
          text: doc.pageContent
        });
        anonymized_docs.push(res.content);
      }
      const anonymized_text = anonymized_docs.join("\n\n");

      // Compare the anonymized text with the original text lengths
      const anonymized_text_length = anonymized_text.length;
      const original_text_length = text.length;
      const reduction = (original_text_length - anonymized_text_length) / original_text_length;

      // Create a blob with the summary
      const existFile = await azure_blobs.checkBlobExists(containerName, url2);
      if (existFile) {
        const blob_response = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/anonymized_translated.txt'), anonymized_text)
        // Do an Inverse Translation
        // Check if the doc_lang is available in DeepL
        deepl_code = await translate.getDeeplCode(doc_lang);
        if (deepl_code == null) {
          // Do an Inverse Translation
          const info = [{ "Text": anonymized_text }];
          const inverseTranslatedText = await translate.getTranslationDictionaryInvertMicrosoft2(info, doc_lang);
          source_text = inverseTranslatedText[0].translations[0].text
        } else {
          // Do a Translation
          source_text = await translate.deepLtranslate(anonymized_text, deepl_code);
        }
        const blob_response2 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/anonymized.txt'), source_text)
      }

      // Alert the client that the summary is ready (change status in the message)
      message["time"] = new Date().toISOString();
      message["status"] = "anonymize ready"
      message["patientId"] = patientIdCrypt
      pubsub.sendToUser(userId, message)
      resolve(true);
    } catch (error) {
      console.log("Error happened: ", error)
      insights.error(error);
      const patientIdCrypt = crypt.encrypt(patientId);
      let docIdEnc = crypt.encrypt(docId);
      pubsub.sendToUser(userId, { "time": new Date().toISOString(), "docId": docIdEnc, "status": "error anonymize", "filename": filename, "error": error, "step": "anonymize", "patientId": patientIdCrypt })
      resolve(false);
    };
  });
}

async function summarySuggestions(patientId, containerName, url) {
  return new Promise(async (resolve, reject) => {
    try {
      // This function get the summary of the document and generates 4 suggested questions the patient can select to ask it
      let url2 = url.replace(/\/[^\/]*$/, '/summary_translated.txt');
      text = await azure_blobs.downloadBlob(containerName, url2);

      // Create the models
      const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
      let { azuregpt4o } = createModels(projectName, 'azuregpt4o');

      // Create a langchain prompt with all the summaries to generate a summary
      let summary_suggestions_prompt = await pull("foundation29/summary_suggestions_base_v1");

      const chainSummarySuggestions = summary_suggestions_prompt.pipe(azuregpt4o);
      console.log("Calling summary suggestions chain...");

      const suggestions = await chainSummarySuggestions.invoke({
        summary: text,
      });
      console.log("Suggestions: ", suggestions);
      //resolve(suggestions.content);
      // Normalizar y parsear la salida de forma robusta
      const tryJSON = (text) => {
        try { return JSON.parse(text); } catch { return null; }
      };
      const cleanFences = (text) => {
        if (!text) return "";
        let t = String(text).trim();
        // eliminar ```json ... ```
        if (t.startsWith("```")) {
          t = t.replace(/^```(?:json|JSON)?\s*/i, "").replace(/```$/i, "").trim();
        }
        // eliminar prefijo "suggestions:" o "Suggestions:" si aparece
        t = t.replace(/^\s*suggestions?\s*:\s*/i, "").trim();
        return t;
      };
      const extractArrayFromText = (text) => {
        const cleaned = cleanFences(text);
        // 1) Intento directo
        let parsed = tryJSON(cleaned);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.suggestions)) return parsed.suggestions;
        // 2) Buscar un array JSON dentro del texto
        const match = cleaned.match(/\[\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*\s*\]/s);
        if (match) {
          const arr = tryJSON(match[0]);
          if (Array.isArray(arr)) return arr;
        }
        // 3) Si parece un objeto sin llaves { suggestions: [...] } sin comillas en la clave
        if (/^suggestions\s*:/i.test(String(text).trim())) {
          const maybeObj = tryJSON(`{${String(text).trim()}}`);
          if (maybeObj && Array.isArray(maybeObj.suggestions)) return maybeObj.suggestions;
        }
        return null;
      };

      let finalSuggestions = [];

      // A) Caso 1: estructura ya parseada { suggestions: [...] }
      if (suggestions && Array.isArray(suggestions.suggestions)) {
        finalSuggestions = suggestions.suggestions;
      } else {
        // B) Caso 2: la propiedad suggestions existe pero es string
        if (suggestions && typeof suggestions.suggestions === "string") {
          const fromProp = extractArrayFromText(suggestions.suggestions);
          if (Array.isArray(fromProp)) finalSuggestions = fromProp;
        }
        // C) Caso 3: el contenido viene en .content (AIMessage)
        if (finalSuggestions.length === 0 && suggestions && typeof suggestions.content === "string") {
          const fromContent = extractArrayFromText(suggestions.content);
          if (Array.isArray(fromContent)) finalSuggestions = fromContent;
        }
        // D) Caso 4: intentar con el objeto entero serializado
        if (finalSuggestions.length === 0) {
          const serialized = JSON.stringify(suggestions);
          const fromSerialized = extractArrayFromText(serialized);
          if (Array.isArray(fromSerialized)) finalSuggestions = fromSerialized;
        }
      }

      // E) Último recurso: dividir por '?', evitando restos de comas y comillas
      if (finalSuggestions.length === 0) {
        const baseText = (suggestions?.content || suggestions?.suggestions || "").toString();
        finalSuggestions = baseText
          .split('?')
          .map(q => q.replace(/^[\s,"']+|[\s,"']+$/g, ''))
          .filter(q => q.length > 0)
          .map(q => `${q}?`);
      }

      // Normalizar: quitar espacios, limitar a 4 y asegurar strings
      finalSuggestions = finalSuggestions
        .map(s => typeof s === 'string' ? s.trim() : String(s))
        .filter(Boolean)
        .slice(0, 4);

      resolve(finalSuggestions);
    }
    catch (error) {
      console.log("Error happened: ", error)
      insights.error(error);
      reject(false);
    };
  });
}

async function summarizePatientBrute(patientId, idWebpubsub, medicalLevel, preferredResponseLanguage) {
  return new Promise(async (resolve, reject) => {
    try {
      const patientIdCrypt = crypt.encrypt(patientId);
      const message = { "time": new Date().toISOString(), "status": "patient card started", "step": "summary" , "patientId": patientIdCrypt}
      pubsub.sendToUser(idWebpubsub, message)

      // Create the models
      const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
      let { gemini3propreview } = createModels(projectName, 'gemini3propreview');

      // Obtener nombre del contenedor Azure para este paciente
      const containerName = crypt.getContainerName(patientId);

      // Get all the verified events for this patient
      const events = await getAllEvents(patientId);
      const actualEvents = await getActualEvents(patientId);
      const eventsMinusDeleted = events.filter(event => event.status !== "deleted");
      const patientData = await getPatientData(patientId);

      const gender = patientData.gender;
      const birthDate = patientData.birthDate;
      const patientName = patientData.patientName;

      // Generate the event summary with updated event structure considering new keys
      let event_summary = eventsMinusDeleted.reduce((summary, event) => {
        const formattedDate = event.date ? new Date(event.date).toISOString().split('T')[0] : "unknown";
        return summary + `Event: ${event.name}, Date: ${formattedDate}\n`;
      }, "");

      // Extract the date of birth from the 'name' field of the event with key 'dob', parse it, and calculate the patient's current age
      let age = "";
      if (birthDate) {
        const dob = new Date(birthDate);
        const today = new Date();

        if (dob > today) {
          age = "0 years and 0 months";
        } else {
          let years = today.getFullYear() - dob.getFullYear();
          let months = today.getMonth() - dob.getMonth();
          if (months < 0 || (months === 0 && today.getDate() < dob.getDate())) {
            years--;
            months += 12; // Adjust months when year decrement
          }
          months = today.getDate() < dob.getDate() ? months - 1 : months; // Adjust months for day difference
          age = `${years} years and ${months} months`; // Combine years and months for age
        }
      }

      // Get all the summaries for this patient
      // List all blobs from the patient folder
      const blobs = await azure_blobs.listContainerFiles(containerName);
      const summary_translated_blobs = blobs.filter(blob => blob.endsWith("clean_translated.txt"));
      const summaries = await Promise.all(summary_translated_blobs.map(blob => azure_blobs.downloadBlob(containerName, blob)));
      const clean_patient_info = summaries.map((doc, index) =>
        `<Complete Summary ${index + 1}>\n${JSON.stringify(doc)}\n</Complete Summary ${index + 1}>`
      ).join("\n");

    const tokens = countTokens.countTokens(clean_patient_info + "\n\n" + event_summary);

    let selectedModel;
      if (tokens > 2000000) {
        throw new Error("Input exceeds maximum token limit for available models.");
      } else{
        selectedModel = gemini3propreview; // Gemini 2.5 Pro
      } 

    let medical_level_text = "";
    if (medicalLevel == "0") {
        medical_level_text = `IMPORTANT: The reader has low literacy and does not understand medical terminology. It is CRUCIAL that you provide the summary in extremely simple language, avoiding all medical jargon. Use basic terms and explanations that a child could understand.`;
      } else if (medicalLevel == "1") {
        medical_level_text = `IMPORTANT: The reader is a basic patient with limited understanding of medical terminology. It is ESSENTIAL that you provide the summary in simple, everyday language. Avoid complex medical terms and explain any necessary medical concepts in plain English.`;
      } else if (medicalLevel == "2") {
        medical_level_text = `IMPORTANT: The reader is an advanced patient who understands some medical terminology. While you can use more advanced terms, it is CRITICAL that you still explain complex concepts clearly. Strike a balance between medical accuracy and accessibility.`;
      } else if (medicalLevel == "3") {
        medical_level_text = `IMPORTANT: The reader is a science expert or clinician with advanced medical knowledge. You MUST use precise medical terminology and provide a detailed, scientifically accurate summary. However, ensure that the information is still presented in a clear and organized manner.`;
      }

      // Create a langchain prompt with the summaries of the summaries and the event summary to generate a summary
      let final_card_summary_prompt = await pull("foundation29/final_card_summary_base_v1");

      const chainFinalCardSummary = final_card_summary_prompt.pipe(selectedModel);

      const todayDate = new Date().toISOString().split('T')[0];

      const finalCardSummary = await chainFinalCardSummary.invoke({
        summaries: clean_patient_info,
        todayDate: todayDate,
        patientName: patientName,
        age: age,
        gender: gender,
        birthDate: birthDate,
        medical_level: medical_level_text
      });

      // console.log(finalCardSummary)
      
      /*let mostCommonLanguage = await getMostCommonLanguage(blobs, containerName);
      if(mostCommonLanguage == null){
        mostCommonLanguage = lang
      } */
      let mostCommonLanguage = preferredResponseLanguage;


      let summaryJson = {data: finalCardSummary.content, version: config.version + ' - ' + config.subversion}

      let deepl_code;
      deepl_code = await translate.getDeeplCode(mostCommonLanguage);

      let translatedSummary;
      try {
        translatedSummary = await translatePatientSummary(summaryJson, deepl_code, mostCommonLanguage);
      } catch (error) {
        throw new Error('Failed to translate patient summary');
      }

      try {
        await azure_blobs.createBlob(containerName, 'raitofile/summary/final_card_translated.txt', JSON.stringify(summaryJson));
        await azure_blobs.createBlob(containerName, 'raitofile/summary/final_card.txt', JSON.stringify(translatedSummary));
      } catch (error) {
        throw new Error('Failed to create blob for final card summary');
      }
      message["time"] = new Date().toISOString();
      message["status"] = "patient card ready"
      message["patientId"] = patientIdCrypt
      pubsub.sendToUser(idWebpubsub, message)
      resolve(true);
    } catch (error) {
      insights.error({ message: 'Failed to summarize patient card', error: error.message || error, stack: error.stack || 'No stack trace available' });
      console.error(error);
      const patientIdCrypt = crypt.encrypt(patientId);
      const message = { "time": new Date().toISOString(), "status": "patient card fail", "step": "summary" , "patientId": patientIdCrypt}
      pubsub.sendToUser(idWebpubsub, message)
      reject(error);
    }
  });
}

async function translatePatientSummary(summaryJson, deepl_code, mostCommonLanguage) {
  for (let key in summaryJson) {
    if (Array.isArray(summaryJson[key])) {
      for (let i = 0; i < summaryJson[key].length; i++) {
        if (typeof summaryJson[key][i] === 'object') {
          for (let nestedKey in summaryJson[key][i]) {
            if (nestedKey !== 'type') {
              summaryJson[key][i][nestedKey] = await translateText(summaryJson[key][i][nestedKey], deepl_code, mostCommonLanguage);
            }
          }
        } else {
          summaryJson[key][i] = await translateText(summaryJson[key][i], deepl_code, mostCommonLanguage);
        }
      }
    } else if (typeof summaryJson[key] === 'object') {
      for (let nestedKey in summaryJson[key]) {
        if (nestedKey !== 'type') {
          summaryJson[key][nestedKey] = await translateText(summaryJson[key][nestedKey], deepl_code, mostCommonLanguage);
        }
      }
    } else if (key !== 'type' && key !== 'version') {
      summaryJson[key] = await translateText(summaryJson[key], deepl_code, mostCommonLanguage);
    }
  }
  return summaryJson;
}

const formatToday = () => {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayOfWeek = days[now.getDay()];
  const isoDate = now.toISOString().split('T')[0]; // Formats the date as YYYY-MM-DD
  return { dayOfWeek, isoDate };
};

async function extractEvents(question, answer, userId, patientId, keyEvents) {
  /*
  This functions analyses a pair of question and answer and compares it to the patient's verified events.
  It searchs for new events that are not in the verified events and adds them to the verified events.
  It also checks if the answer contains a date and if it does, it adds it to the date of the event if not use the current date.
  */
  return new Promise(async (resolve, reject) => {
    const patientIdCrypt = crypt.encrypt(patientId);
    pubsub.sendToUser(userId, { "time": new Date().toISOString(), "status": "analizando respuesta", "step": "extract events", "patientId": patientIdCrypt })
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { gpt4omini } = createModels(projectName, 'gpt4omini');
    try {

      // Get all the verified events for this patient
      const events = await getAllEvents(patientId);
      const patientData = await getPatientData(patientId);
      const gender = patientData.gender;
      const birthDate = patientData.birthDate;
      const patientName = patientData.patientName;

      // Generate the event summary with updated event structure considering new keys
      let event_summary = events.reduce((summary, event) => {
        const formattedDate = event.date ? new Date(event.date).toISOString().split('T')[0] : "unknown";
        return summary + `Event: ${event.name}, Date: ${formattedDate}\n`;
      }, "");
      event_summary += `Gender: ${gender}\n`;
      event_summary += `BirthDate: ${birthDate}\n`;
      event_summary += `Name: ${patientName}\n`;

      // Use the function to get today's date and day
      const { dayOfWeek, isoDate } = formatToday();

      // Generate a prompt with the question's user, answer from Navigator and the events and ask the model to extract new events
      let extract_events_prompt = await pull("foundation29/extract_events_v1");

      const chainExtractEvents = extract_events_prompt.pipe(gpt4omini);

      const extractedEvents = await chainExtractEvents.invoke({
        questionText: question,
        events: event_summary,
        dayOfWeek: dayOfWeek,
        isoDate: isoDate
      });

      let eventJson
      try {
        // Eliminar posibles caracteres extra al inicio y al final
        let extractedText = extractedEvents.content.trim();
        if (extractedText.startsWith("```json") && extractedText.endsWith("```")) {
          extractedText = extractedText.slice(7, -3).trim();
        }

        // Intentar parsear el texto
        const parsedData = JSON.parse(extractedText);

        // Verificar si el resultado parseado es un array
        if (Array.isArray(parsedData)) {
          eventJson = parsedData;
        } else {
          eventJson = [];
        }
      } catch (error) {
        eventJson = [];
      }

      // Iterate over the extracted events and add the current date only if the event does not have a proper ISO date or is unknown
      if (Array.isArray(eventJson) && eventJson.length > 0) {
        eventJson.forEach(event => {
          if (!event.date || isNaN(Date.parse(event.date)) || event.date.toLowerCase() === 'unknown') {
            event.date = new Date().toISOString();
          }
        });
      }

      // Remove events with future dates, except for appointments and reminders
      const allowedFutureTypes = ['appointment', 'reminder'];
      eventJson = eventJson.filter(event => {
        const eventDate = new Date(event.date);
        const currentDate = new Date();
        // Allow future dates for appointments and reminders
        if (allowedFutureTypes.includes(event.key)) {
          return true;
        }
        return eventDate <= currentDate;
      });

      pubsub.sendToUser(userId, {
        time: new Date().toISOString(),
        status: "respuesta analizada",
        events: eventJson,
        step: "extract events",
        patientId: patientIdCrypt
      });

      resolve(eventJson);

      // Add the extracted events to the verified events (will require a verification from the user?)
    } catch (error) {
      insights.error(error);
      console.error(error);
    }
  });
}

async function extractInitialEvents(patientId, ogLang) {
  /*
  This function analyses a pair of question and answer and compares it to the patient actual documents.
  This function search for three key events:
  - patient's age
  - patient's gender
  - main diagnosis or brief sintomatology (in case of no diagnosis) 
  - medication
  */
  return new Promise(async (resolve, reject) => {
    // pubsub.sendToUser(userId, {"status": "analizando inicio", "step": "extract events"})
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { azuregpt4o} = createModels(projectName, 'azuregpt4o');
    try {
      // Get all the documents for this patient
      // Obtener nombre del contenedor Azure para este paciente
      const containerName = crypt.getContainerName(patientId);
      // Get all the summaries for this patient
      // Initialize summaries array
      let summaries = [];
      // List all blobs from the patient folder
      const blobs = await azure_blobs.listContainerFiles(containerName);
      // Filter the summaries
      const summary_translated_blobs = blobs.filter(blob => blob.endsWith("extracted_translated.txt"));
      console.log('summary_translated_blobs.length: ', summary_translated_blobs.length)
      if (summary_translated_blobs.length > 0) {
        // Download the summaries if any
        summaries = await Promise.all(summary_translated_blobs.map(blob => azure_blobs.downloadBlob(containerName, blob)));
        // console.log("Summaries: ", summaries);

        const today = new Date().toDateString();

        // Perform the gpt4 search for the missing keys
        let initial_events_prompt = await pull("foundation29/extract_initial_events_v1");

      const tokens = countTokens.countTokens(summaries.join(" "));
      // console.log(tokens)

      if (tokens > 120000) {
        summaries = summaries.map((doc, index) => 
          `<Complete Document ${index + 1}>\n${doc}\n</Complete Document ${index + 1}>`
        ).join("\n").slice(0, 100000);
      } else {
        summaries = summaries.map((doc, index) => 
          `<Document ${index + 1}>\n${doc}\n</Document ${index + 1}>`
        ).join("\n");
      }
  
      const chainExtractEvents = initial_events_prompt.pipe(azuregpt4o);
  
      const extractedEvents = await chainExtractEvents.invoke({
        documents: summaries,
        today: today
      });

        let eventJson
        try {
          eventJson = JSON.parse(extractedEvents.content);
        } catch (error) {
          console.log(error)
          // Sometimes the .content begins with ```json and ends with ```, so we need to remove these before parsing
          let content = extractedEvents.content || '';
          if (content.startsWith("```json") && content.endsWith("```")) {
            content = content.slice(7, -3).trim();
            eventJson = JSON.parse(content);
          } else if (content.startsWith("```") && content.endsWith("```")) {
            // Handle case where it's just ``` without json tag
            content = content.slice(3, -3).trim();
            eventJson = JSON.parse(content);
          } else {
            eventJson = [
              {
                "insight": null,
                "date": null,
                "key": "dob"
              },
              {
                "insight": null,
                "date": null,
                "key": "gender"
              },
              {
                "insight": null,
                "date": null,
                "key": "diagnosis"
              },
              {
                "insight": null,
                "date": null,
                "key": "weightMetric"
              },
              {
                "insight": null,
                "date": null,
                "key": "heightCm"
              },
              {
                "insight": null,
                "date": null,
                "key": "ethnicGroup"
              },
              {
                "insight": null,
                "date": null,
                "key": "chronicConditions"
              },
              {
                "insight": null,
                "date": null,
                "key": "familyHealthHistory"
              },
              {
                "insight": null,
                "date": null,
                "key": "familyHealthHistoryDetails"
              },
              {
                "insight": null,
                "date": null,
                "key": "knownAllergies"
              },
              {
                "insight": null,
                "date": null,
                "key": "allergiesDetails"
              },
              {
                "insight": null,
                "date": null,
                "key": "surgicalHistory"
              },
              {
                "insight": null,
                "date": null,
                "key": "surgicalHistoryDetails"
              },
              {
                "insight": null,
                "date": null,
                "key": "currentMedications"
              },
              {
                "insight": null,
                "date": null,
                "key": "currentMedicationsDetails"
              },
            ];
          }
        }

        // Check if the doc_lang is available in DeepL
        let deeplCode = await translate.getDeeplCode(ogLang);
        console.log(eventJson)
        // Iterate over the extracted events, translate if necessary, and add the current date
        await Promise.all(eventJson.map(async (event) => {
          if (!event.date || isNaN(Date.parse(event.date)) || event.date.toLowerCase() === 'unknown') {
            event.date = new Date().toISOString();
          }
          if (ogLang !== "en") {
            if (["diagnosis", "familyHealthHistoryDetails", "allergiesDetails", "surgicalHistoryDetails", "currentMedicationsDetails"].includes(event.key)) {
              // Translate the string to the original language
              event.insight = await translateText(event.insight, deeplCode, ogLang);
            }
          }
          if (event.key === "currentMedicationsDetails") {
            event.key = "treatment";
          }
        }));
        // Remove event.key === "ethnicGroup" if "insight" is "unknown" or null to avoid errors
        eventJson = eventJson.filter(event => !(event.key === "ethnicGroup" && (event.insight === null || (event.insight && event.insight.toLowerCase() === "unknown"))));
        //filter if insight '' if insight is null or unknown or '', don't include it
        eventJson = eventJson.filter(event => event.insight !== null && event.insight !== "" && event.insight.toLowerCase() !== "unknown");

        resolve(eventJson);
      }else{
        reject('no summaries found');
      }


    }
    catch (error) {
      insights.error(error);
      console.error(error);
      reject(error);
    }
  });
}


async function divideElements(event, patientId) {
  return new Promise(async (resolve, reject) => {
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { model32k } = createModels(projectName, 'model32k');
    try {
      // Generate a prompt with the question's user
      let divide_elements_prompt = await pull("foundation29/divide_elements_v1");

      const chainDivideElements = divide_elements_prompt.pipe(model32k);

      const dividedElements = await chainDivideElements.invoke({
        event: event.name,
      });

      let elements
      try {
        elements = JSON.parse(dividedElements.content);
      } catch (error) {
        elements = [event];
      }

      resolve(elements);
    }
    catch (error) {
      insights.error(error);
      console.error(error);
    }
  });
}

async function explainMedicalEvent(eventDescription, patientId) {
  return new Promise(async (resolve, reject) => {
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { gpt5mini} = createModels(projectName, 'gpt5mini');
    try {
      // Generate a prompt with the medical event
      let explain_event_prompt = await pull("foundation29/explain_medical_event_v1");

      const chainExplainEvent = explain_event_prompt.pipe(gpt5mini);

      const explanation = await chainExplainEvent.invoke({
        eventDescription: eventDescription,
      });

      // Parse the response to get the explanation text
      let explanationText;
      try {
        explanationText = explanation.content.trim();
      } catch (error) {
        explanationText = "An error occurred while generating the explanation. Please try again.";
      }

      resolve(explanationText);
    }
    catch (error) {
      insights.error(error);
      console.error(error);
      reject(error);
    }
  });
}


module.exports = {
  processDocument,
  categorizeDocs,
  anonymize,
  summarizePatientBrute,
  summarySuggestions,
  extractEvents,
  extractInitialEvents,
  divideElements,
  explainMedicalEvent,
  getPatientData,
  createModels,
  embeddings
};