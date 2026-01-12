'use strict'
const azure_blobs = require('../services/f29azure')
const config = require('./../config')
const crypt = require('../services/crypt')
const axios = require('axios');
const langchain = require('../services/langchain')
const { LangChainTracer } = require("@langchain/core/tracers/tracer_langchain");
const { Client } = require("langsmith");
const suggestions = require('../services/suggestions')
const pubsub = require('../services/pubsub');
const insights = require('../services/insights')
const translate = require('../services/translation');
const openAIserviceCtrl = require('../services/openai')
const { graph } = require('../services/agent')
const userController = require('../controllers/all/user')
const { filterAndAggregateEvents } = require('../services/eventFilterService')
const fs = require('fs');
const { default: createDocumentIntelligenceClient, getLongRunningPoller, isUnexpected } = require("@azure-rest/ai-document-intelligence");
// const { pdf } = require("pdf-to-img");
const {
	SearchClient,
	SearchIndexClient,
	AzureKeyCredential,
	odata,
} = require("@azure/search-documents");

const sas = config.BLOB.SAS;
const endpoint = config.SEARCH_API_ENDPOINT;
const apiKey = config.SEARCH_API_KEY;
const accountname = config.BLOB.NAMEBLOB;
const form_recognizer_key = config.FORM_RECOGNIZER_KEY
const form_recognizer_endpoint = config.FORM_RECOGNIZER_ENDPOINT

const Document = require('../models/document')
const Patient = require('../models/patient')
const User = require('../models/user')


async function analizeDoc(containerName, url, documentId, filename, patientId, userId, saveTimeline, medicalLevel) {
	if (!containerName || !url || !documentId || !filename || !patientId) {
		return;
	}
	// Call the langchain function to summarize the document
	langchain.processDocument(patientId, containerName, url, documentId, filename, userId, saveTimeline, medicalLevel);
	let isDonating = await isDonatingData(patientId);
	if (isDonating) {
		setStateAnonymizedDoc(documentId, 'inProcess')
		let anonymized = await langchain.anonymize(patientId, containerName, url, documentId, filename, userId);
		if (anonymized) {
			setStateAnonymizedDoc(documentId, 'true')
		} else {
			setStateAnonymizedDoc(documentId, 'false')
		}
	}
}


async function translateText(text, deepl_code, doc_lang) {
	try {
		if (deepl_code == null) {
			// Do an Inverse Translation
			const info = [{ "Text": text }];
			const TranslatedText = await translate.getTranslationDictionary(info, doc_lang);
			if (TranslatedText.error) {
				return text;
			} else {
				return TranslatedText[0].translations[0].text;
			}
		} else {
			// Do a Translation
			return await translate.deepLtranslate(text, "EN-US");
		}
	} catch (error) {
		console.log(error);
		insights.error({ message: 'Error in translateToEnglish', error: error });
		return text;
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

const updateDocStatus = async (doc_id, status) => {
    try {
      await updateDocumentStatus(doc_id, status);
    } catch (error) {
      let erromsg = `Failed to update document status to ${status}: ${error.message}`;
      throw new Error(erromsg);
    }
  };
  
async function form_recognizer(patientId, documentId, containerName, url, filename, userId, saveTimeline, medicalLevel, isTextFile, preferredResponseLanguage) {
	return new Promise(async function (resolve, reject) {
		try {
			const patientIdCrypt = crypt.encrypt(patientId);
			let docIdEnc = crypt.encrypt(documentId);
			pubsub.sendToUser(userId, { "time": new Date().toISOString(), "docId": docIdEnc, "status": "inProcess", "filename": filename, "patientId": patientIdCrypt });
			await updateDocStatus(documentId, 'inProcess');
			let content = null;
			if(!isTextFile){
				var url2 = "https://" + accountname + ".blob.core.windows.net/" + containerName + "/" + url + sas;
				const modelId = "prebuilt-layout"; // replace with your model id
	
				const clientIntelligence = createDocumentIntelligenceClient(form_recognizer_endpoint, { key: form_recognizer_key });
				const initialResponse = await clientIntelligence
					.path("/documentModels/{modelId}:analyze", modelId).post({
						contentType: "application/json",
						body: { urlSource: url2 },
						queryParameters: { outputContentFormat: "markdown" }
					});
	
				if (isUnexpected(initialResponse)) {
					throw initialResponse.body.error;
				}
	
				const poller = await getLongRunningPoller(clientIntelligence, initialResponse);
	
				const result = (await poller.pollUntilDone()).body;
	
				// console.log(result); 
	
				if (result.status === 'failed') {
					const errorDetails = result.error || { code: 'Unknown', message: 'Document analysis failed' };
					console.error('Error in analyzing document:', errorDetails);
					
					// Detectar si es DOCX basándose en el filename
					const isDocxFile = filename && (filename.toLowerCase().endsWith('.docx') || filename.toLowerCase().endsWith('.doc'));
					const errorCode = errorDetails.code || 'InternalServerError';
					
					// Si es DOCX y falla, lanzar error con key corto
					if (isDocxFile && errorCode === 'InternalServerError') {
						console.error('DOCX file failed to process:', filename);
						throw new Error('messages.error.docx.convertToPdf');
					}
					
					// Para otros tipos de archivo o errores, usar mensaje genérico
					throw new Error('messages.error.document.processingFailed');
				} else {
					content = result.analyzeResult.content;
				}
			}else{
				content = await azure_blobs.downloadBlob(containerName, url);
			}
			// // 4. Traducir el contenido del documento
			let doc_lang;
			try {
			  doc_lang = await openAIserviceCtrl.detectLang(content);
			  console.log('Detected language:', doc_lang);
			} catch (error) {
			  console.error('Error detecting language:', error);
			  throw error; // Propaga el error para ser manejado por el catch principal
			}
			/*let lang_response = await translate.getDetectLanguage(content)
			  let doc_lang = lang_response[0].language;*/
			let deepl_code = null;
			let translatedContent = null;
			if (doc_lang != "en") {
				deepl_code = await translate.getDeeplCode(doc_lang);
				translatedContent = await translateText(content, deepl_code, doc_lang);
			} else {
				translatedContent = content;
			}

			// 5. Upload the document to Azure Blob Storage
			const azureResponse = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/language.txt'), preferredResponseLanguage);
			// console.log(`Language stored in Azure: ${azureResponse}`);

			const azureResponse2 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/extracted.txt'), content);
			// console.log(`OCR stored in Azure: ${azureResponse2}`);
			let message = { "time": new Date().toISOString(), "docId": docIdEnc, "status": "extracted done", "filename": filename, "patientId": patientIdCrypt };
			pubsub.sendToUser(userId, message);
			await updateDocStatus(documentId, 'extracted done');

			const azureResponse3 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/extracted_translated.txt'), translatedContent);
			// console.log(`OCR translation stored in Azure: ${azureResponse3}`);

			message["time"] = new Date().toISOString();
			message["status"] = "extracted_translated done";
			message["patientId"] = patientIdCrypt
			pubsub.sendToUser(userId, message);
			await updateDocStatus(documentId, 'extracted_translated done');

			let categoryTag, documentDate;
			try {
				({ categoryTag, documentDate } = await langchain.categorizeDocs(userId, translatedContent, patientId, containerName, url, documentId, filename));
			  } catch (error) {
				console.error('Error categorizing document:', error);
				throw new Error('Error categorizing document: ' + error.message);
			  }

			Document.findByIdAndUpdate(documentId, { categoryTag: categoryTag, originaldate: validateDate(documentDate) }, { new: true }, (err, documentUpdated) => {
				if (err) {
					insights.error(err);
					console.log(err)
				}
				// console.log('Updated Document:', documentUpdated);
			});

			// Call the Node server
			analizeDoc(containerName, url, documentId, filename, patientId, userId, saveTimeline, medicalLevel);

			var response = { "msg": "done", "status": 200 }
			resolve(response);

		} catch (error) {
			console.log(error);
			insights.error(error);
			const patientIdCrypt = crypt.encrypt(patientId);
			let docIdEnc = crypt.encrypt(documentId);
			
			// Usar el mensaje del error si está disponible (ya será amigable si viene de nuestro manejo)
			let errorMessage = error.message || error.toString();
			
			let message2 = { 
				"time": new Date().toISOString(), 
				"docId": docIdEnc, 
				"status": "failed", 
				"filename": filename, 
				"patientId": patientIdCrypt,
				"error": errorMessage
			};
			
			pubsub.sendToUser(userId, message2);
			try {
				await updateDocStatus(documentId, 'failed');
			} catch (error) {
				console.log(`Error updating document status to failed:`, error);
				insights.error(error);
			}
			//reject(error);
		}
	});
}

async function form_recognizerwizard(patientId, documentId, containerName, url, filename, userId, saveTimeline, medicalLevel, isTextFile, preferredResponseLanguage) {
	return new Promise(async function (resolve, reject) {
		try {
			const patientIdCrypt = crypt.encrypt(patientId);
			let docIdEnc = crypt.encrypt(documentId);
			pubsub.sendToUser(userId, { "time": new Date().toISOString(), "docId": docIdEnc, "status": "inProcess", "filename": filename, "patientId": patientIdCrypt });
			await updateDocStatus(documentId, 'inProcess');
			let content = null;
			if(!isTextFile){
				var url2 = "https://" + accountname + ".blob.core.windows.net/" + containerName + "/" + url + sas;
				const modelId = "prebuilt-layout"; // replace with your model id
	
				const clientIntelligence = createDocumentIntelligenceClient(form_recognizer_endpoint, { key: form_recognizer_key });
				const initialResponse = await clientIntelligence
					.path("/documentModels/{modelId}:analyze", modelId).post({
						contentType: "application/json",
						body: { urlSource: url2 },
						queryParameters: { outputContentFormat: "markdown" }
					});
	
				if (isUnexpected(initialResponse)) {
					throw initialResponse.body.error;
				}
	
				const poller = await getLongRunningPoller(clientIntelligence, initialResponse);
	
				const result = (await poller.pollUntilDone()).body;
	
				// console.log(result); 
	
				if (result.status === 'failed') {
					const errorDetails = result.error || { code: 'Unknown', message: 'Document analysis failed' };
					console.error('Error in analyzing document (wizard):', errorDetails);
					
					// Detectar si es DOCX basándose en el filename
					const isDocxFile = filename && (filename.toLowerCase().endsWith('.docx') || filename.toLowerCase().endsWith('.doc'));
					const errorCode = errorDetails.code || 'InternalServerError';
					
					// Si es DOCX y falla, lanzar error con key corto
					if (isDocxFile && errorCode === 'InternalServerError') {
						console.error('DOCX file failed to process (wizard):', filename);
						throw new Error('messages.error.docx.convertToPdf');
					}
					
					// Para otros tipos de archivo o errores, usar mensaje genérico
					throw new Error('messages.error.document.processingFailed');
				} else {
					content = result.analyzeResult.content;
				}
			}else{
				content = await azure_blobs.downloadBlob(containerName, url);
			}
			
			// // 4. Traducir el contenido del documento
			let doc_lang;
			try {
			  doc_lang = await openAIserviceCtrl.detectLang(content);
			  console.log('Detected language:', doc_lang);
			} catch (error) {
			  console.error('Error detecting language:', error);
			  throw error; // Propaga el error para ser manejado por el catch principal
			}
			/*let lang_response = await translate.getDetectLanguage(content)
			  let doc_lang = lang_response[0].language;*/
			let deepl_code = null;
			let translatedContent = null;
			if (doc_lang != "en") {
				deepl_code = await translate.getDeeplCode(doc_lang);
				translatedContent = await translateText(content, deepl_code, doc_lang);
			} else {
				translatedContent = content;
			}

			// 5. Upload the document to Azure Blob Storage
			const azureResponse = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/language.txt'), preferredResponseLanguage);
			// console.log(`Language stored in Azure: ${azureResponse}`);

			const azureResponse2 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/extracted.txt'), content);
			// console.log(`OCR stored in Azure: ${azureResponse2}`);
			let message = { "time": new Date().toISOString(), "docId": docIdEnc, "status": "extracted done", "filename": filename, "patientId": patientIdCrypt };
			pubsub.sendToUser(userId, message);
			await updateDocStatus(documentId, 'extracted done');

			const azureResponse3 = await azure_blobs.createBlob(containerName, url.replace(/\/[^\/]*$/, '/extracted_translated.txt'), translatedContent);
			// console.log(`OCR translation stored in Azure: ${azureResponse3}`);

			message["time"] = new Date().toISOString();
			message["status"] = "extracted_translated done";
			message["patientId"] = patientIdCrypt
			pubsub.sendToUser(userId, message);
			await updateDocStatus(documentId, 'extracted_translated done');
			var response = { "msg": "Done" }
			resolve(response);
		} catch (error) {
			console.log(error);
			insights.error(error);
			const patientIdCrypt = crypt.encrypt(patientId);
			let docIdEnc = crypt.encrypt(documentId);
			
			// Usar el mensaje del error si está disponible (ya será amigable si viene de nuestro manejo)
			let errorMessage = error.message || error.toString();
			
			let message2 = { 
				"time": new Date().toISOString(), 
				"docId": docIdEnc, 
				"status": "failed", 
				"filename": filename, 
				"patientId": patientIdCrypt,
				"error": errorMessage
			};
			
			pubsub.sendToUser(userId, message2);
			try {
				await updateDocStatus(documentId, 'failed');
			} catch (error) {
				console.log(`Error updating document status to failed:`, error);
				insights.error(error);
			}
			//reject(error);
			var response = { "msg": "failed" }
			resolve(response);
		}
	});
}

function validateDate(documentDate) {
	if (!documentDate || documentDate === 'YYYY-MM-DD') {
		return null;  // Retorna null si la fecha no es válida o es un placeholder
	}
	const date = new Date(documentDate);
	if (isNaN(date.getTime())) {
		return null;
	} else {
		return date;
	}
}

async function isDonatingData(patientId) {
	return new Promise(async function (resolve, reject) {
		Patient.findById(patientId, { "_id": false, "createdBy": false }, (err, patient) => {
			if (err) resolve(false)
			if (patient) {
				if (patient.donation) {
					resolve(true);
				} else {
					resolve(false);
				}
			} else {
				resolve(false);
			}

		})
	});
}

async function anonymizeBooks(documents) {
	return new Promise(async function (resolve, reject) {
		const promises = [];
		for (let i = 0; i < documents.length; i++) {
			let document = documents[i];
			promises.push(anonymizeDocument(document));
		}
		Promise.all(promises)
			.then((data) => {
				resolve(data);
			})
			.catch((err) => {
				insights.error(err);
				respu.message = err;
				resolve(respu);
			});
	});

}

async function anonymizeDocument(document) {
	return new Promise(async function (resolve, reject) {
		if (document.anonymized == 'false') {
			let userId = await getUserId(document.createdBy);
			if (userId != null) {
				userId = crypt.encrypt(userId.toString());
				let patientId = document.createdBy.toString();
				let containerName = crypt.getContainerName(patientId);
				let filename = document.url.split("/").pop();
				setStateAnonymizedDoc(document._id, 'inProcess')
				let docId = document._id.toString();
				let anonymized = await langchain.anonymize(patientId, containerName, document.url, docId, filename, userId);
				if (anonymized) {
					setStateAnonymizedDoc(document._id, 'true')
				} else {
					setStateAnonymizedDoc(document._id, 'false')
				}
				resolve(true);
			}
		} else {
			resolve(true);
		}
	});

}

function setStateAnonymizedDoc(documentId, state) {
	Document.findByIdAndUpdate(documentId, { anonymized: state }, { new: true }, (err, documentUpdated) => {
		if (err) {
			insights.error(err);
			console.log(err)
		}
		if (!documentUpdated) {
			insights.error('Error updating document');
			console.log('Error updating document')
		}
	})
}

async function getUserId(patientId) {
	return new Promise(async function (resolve, reject) {
		Patient.findById(patientId, { "_id": false }, (err, patient) => {
			if (err) {
				insights.error(err);
				console.log(err)
				resolve(null)
			}
			if (patient) {
				resolve(patient.createdBy);
			} else {
				insights.error('No patient found');
				console.log('No patient found')
				resolve(null)
			}
		})
	});
}

async function deleteIndexAzure(indexName) {
	return new Promise(async function (resolve, reject) {
		try {	
			// Primero verificamos si el índice existe
			console.log('config.cogsearchIndex: ', config.cogsearchIndex);
			let cogsearchIndex = config.cogsearchIndex;
			const indexClient = new SearchClient(endpoint, cogsearchIndex, new AzureKeyCredential(apiKey));
			
		try {

			// Intentamos primero con la estructura nueva (source como campo de primer nivel)
			let documents = await indexClient.search("*", { 
				select: ["id"], 
				filter: `source eq '${indexName}'`
			});

			// Si no hay resultados, intentamos con la estructura antigua (index_name)
			if (documents.results.length === 0) {
				documents = await indexClient.search("*", { 
					select: ["id"], 
					filter: `index_name eq '${indexName}'`
				});
			}
				
				// Si llegamos aquí, el índice existe, procedemos con la eliminación
				let docsToDelete = [];
				for await (const result of documents.results) {
					docsToDelete.push({ id: result.document.id });
				}
				
				if (docsToDelete.length > 0) {
					await indexClient.deleteDocuments(docsToDelete);
				}
				resolve(true);
				
			} catch (error) {
				// Si el error es porque el índice no existe, no lo consideramos un error fatal
				if (error.message && error.message.includes("was not found")) {
					console.log(`Index ${config.cogsearchIndex} does not exist, skipping deletion`);
					resolve(true);
				} else {
					throw error; // Propagar otros tipos de errores
				}
			}
		} catch (error) {
			console.log(`Error deleting index ${indexName}:`, error);
			insights.error(error);
			reject(error);
		}
	});
}

async function callNavigator(req, res) {
	try{
	var index = crypt.decrypt(req.body.index);
	var patientId = index; // Usar el ID desencriptado (ObjectId de MongoDB)
		// Calcular containerName desde patientId encriptado (usar req.params.patientId)
		var containerName = crypt.getContainerNameFromEncrypted(req.params.patientId);
		var content = req.body.context;
		var docs = req.body.docs;
		var originalQuestion = req.body.question;

		// Filtrar eventos del contexto si hay muchos (reducir ruido para el agente)
		try {
			if (content && Array.isArray(content) && content.length > 0) {
				// Buscar el mensaje que contiene los eventos (generalmente el primero con role "assistant")
				const eventsMessageIndex = content.findIndex(msg => 
					msg.role === 'assistant' && msg.content && typeof msg.content === 'string'
				);
				
				if (eventsMessageIndex !== -1) {
					let eventsContent = content[eventsMessageIndex].content;
					
					// Intentar parsear como JSON (los eventos vienen serializados)
					try {
						let events = JSON.parse(eventsContent);
						
						// Si es un array con muchos eventos, filtrar con IA
						if (Array.isArray(events) && events.length > 60) {
							console.log(`[callNavigator] Filtrando eventos: ${events.length} eventos en contexto`);
							
							const filterResult = await filterAndAggregateEvents(events, { maxEvents: 60 });
							
							// Reemplazar con eventos filtrados
							content[eventsMessageIndex].content = JSON.stringify(filterResult.events);
							console.log(`[callNavigator] Eventos filtrados: ${filterResult.stats.original} → ${filterResult.stats.final} (${filterResult.stats.reductionPercent}% reducción)`);
						}
					} catch (parseError) {
						// No es JSON válido, probablemente es texto normal - ignorar
					}
				}
			}
		} catch (filterError) {
			console.error('[callNavigator] Error filtrando eventos (continuando sin filtrar):', filterError.message);
			// Continuar sin filtrar si hay error
		}
		
		// Get user language - try from request body first (detectedLang from client), then from user model
		let userLang = req.body.detectedLang || req.body.lang || req.body.userLang || 'en';
		if (!req.body.detectedLang && !req.body.lang && req.body.userId) {
			try {
				const userId = crypt.decrypt(req.body.userId);
				const user = await User.findById(userId, { "lang": true, "preferredResponseLanguage": true });
				if (user) {
					userLang = user.preferredResponseLanguage || user.lang || 'en';
				}
			} catch (error) {
				console.log('Error getting user language:', error);
			}
		}
		
		// Detectar idioma del mensaje y traducir si es necesario (usando las mismas funciones que el cliente)
		let questionToProcess = originalQuestion;
		if (originalQuestion && originalQuestion.length > 0) {
			try {
				// Detectar idioma usando Microsoft Translator API (igual que el cliente)
				const detectedLangResult = await translate.getDetectLanguage(originalQuestion);
				
				// Verificar que la respuesta sea válida y tenga el formato esperado
				if (detectedLangResult && Array.isArray(detectedLangResult) && detectedLangResult[0] && detectedLangResult[0].language) {
					const detectedLanguage = detectedLangResult[0].language;
					const confidenceScore = detectedLangResult[0].score || 0;
					const confidenceThreshold = 0.7;
					
					// Si el idioma detectado no es inglés y tiene confianza suficiente, traducir a inglés
					if (detectedLanguage !== 'en' && confidenceScore >= confidenceThreshold) {
						const info = [{ "Text": originalQuestion }];
						const translatedResult = await translate.getTranslationDictionary(info, detectedLanguage);
						
						if (translatedResult && !translatedResult.error && translatedResult[0] && translatedResult[0].translations && translatedResult[0].translations[0]) {
							questionToProcess = translatedResult[0].translations[0].text;
							console.log(`Translated question from ${detectedLanguage} to en: ${originalQuestion.substring(0, 50)}... -> ${questionToProcess.substring(0, 50)}...`);
						} else {
							console.log('Translation failed, using original question');
						}
					} else if (confidenceScore < confidenceThreshold) {
						console.log(`Low confidence in language detection (${confidenceScore}), using original question`);
					} else {
						console.log(`Question is already in English, using original`);
					}
				} else {
					console.log('Language detection failed or invalid response, using original question');
				}
			} catch (error) {
				console.log('Error detecting/translating language:', error);
				insights.error(error);
				// En caso de error, usar el mensaje original
				questionToProcess = originalQuestion;
			}
		}
		
		const projectName = `AGENT - ${config.LANGSMITH_PROJECT} - ${patientId}`;
		console.log("projectName: ", projectName);
		console.log("config.LANGSMITH_API_KEY: ", config.LANGSMITH_API_KEY);
		
		// Crear tracer solo si la API key es válida
		let tracer = null;
		if (config.LANGSMITH_API_KEY && config.LANGSMITH_API_KEY.trim() !== '') {
			try {
				const client2 = new Client({
					apiUrl: "https://api.smith.langchain.com",
					apiKey: config.LANGSMITH_API_KEY,
				});

				tracer = new LangChainTracer({
					projectName: projectName,
					client: client2,
				});
			} catch (error) {
				console.warn('LangSmith tracer initialization failed, continuing without tracer:', error.message);
				insights.error({ message: 'LangSmith tracer initialization failed', error: error });
				tracer = null;
			}
		} else {
			console.warn('LANGSMITH_API_KEY not configured, continuing without tracer');
		}
		//console.log('client2:', client2);
		
		// Log para debugging: identificar llamadas duplicadas
		const requestId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
		console.log(`[${requestId}] Invoking agent with questionToProcess:`, questionToProcess.substring(0, 100));
		console.log(`[${requestId}] Request details:`, { 
			userId: req.body.userId?.substring(0, 20), 
			patientId: patientId?.substring(0, 20),
			timestamp: new Date().toISOString()
		});
		
		// Enviar respuesta "Processing" inmediatamente - la respuesta real viene por WebPubSub
		res.status(200).send({ "action": "Processing", "message": "Response will be sent via WebPubSub" });
		
		// Invocar el agente de forma asíncrona - la respuesta se enviará por WebPubSub
		graph.invoke({
			messages: [
				{
				role: "user",
				content: questionToProcess,
				},
			],
			},
			{ configurable: { patientId: patientId, 
				systemTime: new Date().toISOString(), 
				tracer: tracer, 
				context: content, 
				docs: docs, 
				indexName: index,
				containerName: containerName,
				userId: req.body.userId,
				userLang: userLang,
				originalQuestion: originalQuestion,
				pubsubClient: pubsub
			},
			callbacks: tracer ? [tracer] : [] 
		}).catch(error => {
			console.error('Error invoking agent:', error);
			insights.error({ message: 'Error invoking agent', error: error });
			// Notificar al usuario que algo ha ido mal para que no se quede colgado
			pubsub.sendToUser(req.body.userId, { 
				"time": new Date().toISOString(), 
				"status": "error", 
				"message": "ERROR_PROCESSING_REQUEST",
				"step": "navigator", 
				"patientId": patientId 
			});
		});
	} catch (error) {
		console.error(error);
		insights.error(error);
		res.status(500).send({ message: `Error` })
	}
}

async function getInitialEvents(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let lang = req.body.lang;
	patientId = String(patientId);
	let initialEvents = [
		{
			"insight": "",
			"date": "",
			"key": "gender"
		},
		{
			"insight": "",
			"date": "",
			"key": "dob"
		},
		{
			"insight": "",
			"date": "",
			"key": "diagnosis"
		},
		{
			"insight": [],
			"date": "",
			"key": "medication"
		},
	]
	try {
		initialEvents = await langchain.extractInitialEvents(patientId, lang);
		res.status(200).send(initialEvents);

	} catch (error) {
		console.log(`Error:`, error);
		insights.error({ message: 'Error in extractInitialEvents', error: error });
		res.status(200).send(initialEvents);
	}
}




module.exports = {
	analizeDoc,
	form_recognizer,
	form_recognizerwizard,
	anonymizeBooks,
	deleteIndexAzure,
	callNavigator,
	anonymizeDocument,
	getInitialEvents
}
