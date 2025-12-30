const { ChatOpenAI } = require("@langchain/openai");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
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

const O_A_K = config.O_A_K;
const OPENAI_API_VERSION = config.OPENAI_API_VERSION;
const OPENAI_API_BASE = config.OPENAI_API_BASE;
const O_A_K_GPT4O = config.O_A_K_GPT4O;
const OPENAI_API_BASE_GPT4O = config.OPENAI_API_BASE_GPT4O;
const O_A_K_GPT5MINI = config.O_A_K_GPT5MINI;

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
  let { azuregpt4o } = createModels(projectName, 'azuregpt4o');

  const summarize_prompt = await pull("foundation29/summarize-single_prompt_v1");

  const chatPrompt = summarize_prompt.pipe(azuregpt4o);
  
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

async function timelineServer(patientId, docs) {
  // Refactor of the summarize function to be used completely and independently in the server
  try {
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { azuregpt4o } = createModels(projectName, 'azuregpt4o');

  const timeline_prompt = await pull("foundation29/timeline-single_prompt_v1");

  const chatPrompt = timeline_prompt.pipe(azuregpt4o);
  
  const timeline = await chatPrompt.invoke({
    referenceDocs: docs
  });

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
    let { azuregpt4o } = createModels(projectName, 'azuregpt4o');

  const anomalies_prompt = await pull("foundation29/anomalies-single_prompt_v1");

  const chatPrompt = anomalies_prompt.pipe(azuregpt4o);
  
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

    const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 500000 });
    const docs = await textSplitter.createDocuments([clean_text]);
    const raw_docs = await textSplitter.createDocuments([clean_raw_text]);

    const [result, result2, result3] = await Promise.all([
      summarizeServer(patientId, medicalLevel, docs),
      timelineServer(patientId, docs),
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
        saveEventTimeline(events, patientId, doc_id, userId);
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

function saveEventTimeline(events, patientId, doc_id, userId) {
  for (let event of events) {
    let eventdb = new Events();

    // Validar y convertir la fecha usando la función mejorada
    const validDate = validateDate(event.date);
    if (validDate) {
      eventdb.date = validDate;
    } else {
      //send patientId, doc_id, event.date to insights.error
      let params = 'PatientId: ' + patientId + ' DocId: ' + doc_id + ' EventDate: ' + event.date;
      insights.error(`Invalid date format for event: ${params}`);
      insights.error(event);
      console.log(event)
      //set the actual date in YYYY-MM-DD format
      eventdb.date = new Date().toISOString().split('T')[0];
      //continue; // Saltar este evento si la fecha no es válida
    }
    eventdb.status = event.present;

    eventdb.name = event.keyMedicalEvent;
    eventdb.key = event.eventType;
    eventdb.origin = 'automatic';
    eventdb.docId = doc_id;
    eventdb.createdBy = patientId;
    eventdb.addedBy = crypt.decrypt(userId);

    Events.findOne({ "createdBy": patientId, "name": event.keyMedicalEvent, "key": event.eventType }, { "createdBy": false }, (err, eventdb2) => {
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
        console.log('Event already exists');
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
      let { model32k} = createModels(projectName, 'model32k');

      const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 15000 });
      const docs = await textSplitter.createDocuments([text]);

      let anonymize_prompt = await pull("foundation29/anonymize_doc_base_v1");

      // This function creates a document chain prompted to anonymize a set of documents.
      const chain = anonymize_prompt.pipe(model32k);

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

async function extractTimelineEvents(question, userId, patientId) {
  /*
  This functions analyses the user question and try to extract a timeline of events from the patient's documents.
  It uses the model32k to do so. It returns a JSON object with the timeline of events.
  The timeline should be structured as a list of events, with each individual event containing a date, type and an small description of the event.

  */
  return new Promise(async (resolve, reject) => {
    const patientIdCrypt = crypt.encrypt(patientId);
    pubsub.sendToUser(userId, { "time": new Date().toISOString(), "status": "analizando respuesta timeline", "step": "extract events", "patientId": patientIdCrypt })
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { model32k } = createModels(projectName, 'model32k');
    try {
      // Use the function to get today's date and day
      const { dayOfWeek, isoDate } = formatToday();

      // Generate a prompt with the question's user
      let extract_events_prompt = await pull("foundation29/extract_timeline_events_v1");

      const chainExtractEvents = extract_events_prompt.pipe(model32k);

      const extractedEvents = await chainExtractEvents.invoke({
        questionText: question,
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

      pubsub.sendToUser(userId, {
        time: new Date().toISOString(),
        status: "respuesta timeline analizada",
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
    let { model32k } = createModels(projectName, 'model32k');
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

      const chainExtractEvents = extract_events_prompt.pipe(model32k);

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

      // Remove events with future dates
      eventJson = eventJson.filter(event => {
        const eventDate = new Date(event.date);
        const currentDate = new Date();
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
  /*
  This functions analyses a text and divides it into elements. Using the model32k to do so. It returns a list of elements.
  */
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
  /*
  This function analyzes a medical event description and provides a detailed explanation of the event.
  It uses the model32k to do so and returns the explanation in a user-friendly format, limited to one paragraph.
  The explanation will be in the same language as the input event description.
  */
  return new Promise(async (resolve, reject) => {
    // Create the models
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
    let { model32k} = createModels(projectName, 'model32k');
    try {
      // Generate a prompt with the medical event
      let explain_event_prompt = await pull("foundation29/explain_medical_event_v1");

      const chainExplainEvent = explain_event_prompt.pipe(model32k);

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
  extractTimelineEvents,
  extractInitialEvents,
  divideElements,
  explainMedicalEvent,
  getPatientData,
  createModels
};