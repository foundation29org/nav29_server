// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Document = require('../../../models/document')
const Patient = require('../../../models/patient')
const Events = require('../../../models/events')
const crypt = require('../../../services/crypt')
const f29azureService = require("../../../services/f29azure")
const bookService = require("../../../services/books")
const langchain = require('../../../services/langchain')
const insights = require('../../../services/insights')
const path = require('path');
const azure_blobs = require('../../../services/f29azure')

async function getDocuments(req, res) {
	//get docs and events of each doc of the patient
	var result = await getDocs(req.params.patientId, req.user)
	res.status(200).send(result)
}

async function getDocs(encPatientId, userId){
return new Promise(async function (resolve, reject) {
	let patientId = crypt.decrypt(encPatientId);
	const eventsdb = await findDocuments(patientId, userId);
	resolve(eventsdb);
	});
}

function findDocuments(patientId, userId) {
	return new Promise((resolve, reject) => {
		Document.find(
			{ createdBy: patientId },
			null,  // Quitamos la proyección aquí
			(err, eventsdb) => {
				if (err) {
					reject(err);
				} else {
					const plainDocuments = eventsdb ? eventsdb.map((doc) => {
						const docObj = doc.toObject();
						docObj._id = crypt.encrypt(docObj._id.toString());
						docObj.isOwner = !docObj.addedBy || docObj.addedBy.toString() === userId.toString();
						// Eliminamos los campos sensibles después de usarlos
						delete docObj.createdBy;
						delete docObj.addedBy;
						return docObj;
					}) : [];
					resolve(plainDocuments);
				}
			}
		)
	});
}

  async function getDocument(req, res) {
	let documentId = crypt.decrypt(req.params.documentId);
	Document.findById(documentId, { "createdBy": false, "addedBy": false }, (err, documentdb) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		} 
		if (documentdb) {
			const docObj = documentdb.toObject();
			docObj._id = crypt.encrypt(docObj._id.toString());
			res.status(200).send(docObj)
		} else {
			return res.status(404).send({ code: 208, message: `Error getting the document: ${err}` })
		}
	})
}

async function updateDate(req, res) {
	let documentId = crypt.decrypt(req.params.documentId);
	Document.findByIdAndUpdate(documentId, { originaldate: req.body.originaldate }, { new: true }, (err, documentUpdated) => {
		if (err) {
			return res.status(500).send({ message: `Error updating the document: ${err}` })
		}
		res.status(200).send(documentUpdated)
	})
}

async function updateTitle(req, res) {
	let documentId = crypt.decrypt(req.params.documentId);
	// Extraer el nombre original del archivo de la URL
	const originalFileName = req.body.url.split("/").pop();
	if (originalFileName === req.body.title) {
        return res.status(200).send({ message: "No changes needed", newUrl: req.body.url });
    }
	
	// Crear el nuevo path manteniendo la misma ruta pero con el nuevo nombre
	const newUrl = req.body.url.replace(originalFileName, req.body.title);
	
	Document.findByIdAndUpdate(
		documentId, 
		{ 
			url: newUrl
		}, 
		{ new: true }, 
		async (err, documentUpdated) => {
			if (err) {
				insights.error(err);
				return res.status(500).send({ message: `Error updating the document: ${err}` })
			}
			
			try {
				// Renombrar el blob en Azure
				let patientIdEnc = crypt.encrypt(documentUpdated.createdBy.toString());
				let containerName = patientIdEnc.substr(1).toString();
				console.log(containerName)
				await f29azureService.renameBlob(
					containerName,
					req.body.url, // URL original
					newUrl // Nueva URL
				);
				res.status(200).send({ message: "Done" , newUrl: newUrl})
			} catch (error) {
				//restore the original url
				Document.findByIdAndUpdate(documentId, { url: req.body.url }, { new: true }, (err, documentUpdated) => {
					if (err) {
						insights.error(err);
					}
				})
				insights.error(error);
				return res.status(500).send({ message: `Error renaming the blob: ${error}` })
			}
		}
	)
}

function deleteDocument(req, res) {
	let documentId = crypt.decrypt(req.params.documentId)
	let userId = req.user;
	Document.findById(documentId, async (err, documentdb) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (documentdb) {
			// Verificar si el usuario es propietario
			const isOwner = !documentdb.addedBy || documentdb.addedBy.toString() === userId.toString();
			
			if (!isOwner) {
				return res.status(200).send({ message: 'Access denied' });
			}

			let patientIdEnc = crypt.encrypt((documentdb.createdBy).toString());
			let containerName = patientIdEnc.substr(1).toString();
			await f29azureService.deleteBlobsInFolder(containerName, documentdb.url);
			
			documentdb.remove(async err => {
				if (err){
					insights.error(err);
					return res.status(500).send({ message: `Error deleting the document: ${err}` })
				}
				deleteEvents(documentId);
				var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
				res.status(200).send({ message: `The document has been deleted`})
			})
		} else {
			res.status(200).send({ message: `The document has been deleted`, numEvents: 0 })
		}
	})
}

function deleteEvents (docId){
	Events.find({ 'docId': docId }, (err, events) => {
		if (err){
			insights.error(err);
			console.log({message: `Error deleting the events: ${err}`})
		} 
		events.forEach(function(event) {
			event.remove(err => {
				if(err){
					insights.error(err);
					console.log({message: `Error deleting the events: ${err}`})
				}
			})
		});
	})
}

async function uploadFile(req, res) {
	if (req.files != null) {
		let patientId = crypt.decrypt(req.params.patientId);
		var data1 = await saveBlob(req.body.containerName, req.body.url, req.files.thumbnail);
		if (data1) {
			//save document
			var document = await saveDocument(patientId, req.body.url, req.body.userId);
			var tempId = document._id.toString();
			//guardar en una variable docId document._id in lowercase 
			var docId = tempId.toLowerCase();
			if (document != "Doc failed save") {
				//createbook
				const filename = path.basename(req.body.url);
				let isTextFile = false;
				if (req.files.thumbnail.mimetype == 'text/plain') {
					isTextFile = true;
				}
				bookService.form_recognizer(patientId, docId, req.body.containerName, req.body.url, filename, req.body.userId, true, req.body.medicalLevel, isTextFile, req.body.preferredResponseLanguage);
				let docIdEnc = crypt.encrypt(docId);
				res.status(200).send({ message: "Done", docId: docIdEnc })
				

			} else {
				//delete blob
				var data5 = await f29azureService.deleteBlobsInFolder(req.body.containerName, req.body.url);
				insights.error('error saving the document');
				res.status(500).send({ message: `Error` })
			}

		} else {
			insights.error('error saving the document in blob');
			res.status(500).send({ message: `Error` })
		}
	} else {
		insights.error('Error: no files');
		res.status(500).send({ message: `Error: no files` })
	}

}

async function uploadFileWizard(req, res) {
	if (req.files != null) {
		let patientId = crypt.decrypt(req.params.patientId);
		var data1 = await saveBlob(req.body.containerName, req.body.url, req.files.thumbnail);
		if (data1) {
			//save document
			var document = await saveDocument(patientId, req.body.url, req.body.userId);
			var tempId = document._id.toString();
			//guardar en una variable docId document._id in lowercase 
			var docId = tempId.toLowerCase();


			if (document != "Doc failed save") {
				//createbook
				const filename = path.basename(req.body.url);
				let isTextFile = false;
				if (req.files.thumbnail.mimetype == 'text/plain') {
					isTextFile = true;
				}
				let reponse = await bookService.form_recognizerwizard(patientId, docId, req.body.containerName, req.body.url, filename, req.body.userId, true, req.body.medicalLevel, isTextFile, req.body.preferredResponseLanguage);
				let docIdEnc = crypt.encrypt(docId);
				res.status(200).send({ message: reponse.msg, docId: docIdEnc })
			} else {
				//delete blob
				var data5 = await f29azureService.deleteBlobsInFolder(req.body.containerName, req.body.url);
				insights.error('error saving the document');
				res.status(500).send({ message: `Error` })
			}

		} else {
			insights.error('error saving the document in blob');
			res.status(500).send({ message: `Error` })
		}
	} else {
		insights.error('Error: no files');
		res.status(500).send({ message: `Error: no files` })
	}

}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
  }

async function continueanalizedocs(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let documents = req.body.documents;
  
	// Responder inmediatamente al cliente
	res.status(200).send({ message: "Processing started" });
  
	// Procesar los documentos en segundo plano
	process.nextTick(async () => {
	  for (const document of documents) {
		console.log(document.dataFile.url);
		document.docId = crypt.decrypt(document.docId);
		let url2 = document.dataFile.url.replace(/\/[^\/]*$/, '/extracted_translated.txt');
		let containerName = req.params.patientId.substr(1).toString();
		let urlsummary = document.dataFile.url.replace(/\/[^\/]*$/, '/summary_translated.txt');
  
		try {
		  // Verificar si el archivo summary_translated.txt existe en el blob
		  const existFile = await azure_blobs.checkBlobExists(containerName, urlsummary);
		  if (existFile) {
			console.log('The file exists: ' + document.dataFile.url);
			continue;
		  }
  
		  let text = await azure_blobs.downloadBlob(containerName, url2);
		  
		  let categoryTag, documentDate;
		  try {
			({ categoryTag, documentDate } = await langchain.categorizeDocs(req.body.userId, text, patientId, containerName, document.dataFile.url, document.docId, document.dataFile.name));
		  } catch (error) {
			console.error('Error categorizing document:', error);
			insights.error(error);
			await updateDocumentStatus(document.docId, 'failed');
			continue; // Continúa con el siguiente documento
		  }
  
		  Document.findByIdAndUpdate(document.docId, { categoryTag: categoryTag, originaldate: validateDate(documentDate) }, { new: true }, (err, documentUpdated) => {
			if (err) {
			  insights.error(err);
			  console.log(err);
			}
		  });
  
		  bookService.analizeDoc(containerName, document.dataFile.url, document.docId, document.dataFile.name, patientId, req.body.userId, true, req.body.medicalLevel);
  
		  // Retardo de 5 segundos
		  await sleep(5000);
  
		} catch (error) {
		  console.error('Error processing document:', error);
		  insights.error(error);
		  await updateDocumentStatus(document.docId, 'failed');
		}
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

async function saveBlob(containerName, url, thumbnail) {
	return new Promise(async function (resolve, reject) {
		// Save file to Blob
		var result = await f29azureService.createBlob(containerName, url, thumbnail.data);
		if (result) {
			resolve(true);
		} else {
			resolve(false);
		}
	});
}

function saveDocument(patientId, url, userId) {
	return new Promise(async function (resolve, reject) {
		let userIdDecrypted = crypt.decrypt(userId);
		let eventdb = new Document()
		eventdb.url = url;
		eventdb.createdBy = patientId
		eventdb.addedBy = userIdDecrypted;

		// when you save, returns an id in eventdbStored to access that document
		eventdb.save((err, eventdbStored) => {
			if (err) {
				resolve('Doc failed save');
			}
			if (eventdbStored) {
				resolve(eventdbStored);
			}
		})

	});
}

function updateDocumentStatus(documentId, status) {
	return new Promise((resolve, reject) => {
		Document.findByIdAndUpdate(documentId, { status: status }, { new: true }, (err, documentUpdated) => {
			if (err) {
				resolve(false);
			}
			resolve(documentUpdated);
		}
		)
	});
}

async function trySummarize(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	//create blob
	var document = await findDocument(req.body.docId);
	if (document) {
		if(patientId == document.createdBy){
			//get the role of the user in the ddbb
			// Get the role of the user in the database
			let userId = crypt.decrypt(req.body.userId);
			const user = await User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "lastLogin": false }).exec();
			let medicalLevel = "1";
			if (user) {
				medicalLevel = user.medicalLevel;
			}

			langchain.processDocument(patientId, req.body.containerName, document.url, req.body.docId, req.body.docName, req.body.userId, true, medicalLevel);
			res.status(200).send({ message: "Done", docId: req.body.docId })
		}else{
			insights.error("Error 1 trySummarize");
			res.status(500).send({ message: `Error` })
		}
		
	} else {
		insights.error("Error 2 trySummarize");
		res.status(500).send({ message: `Error` })
	}

}

async function summarySuggest(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let documentId = crypt.decrypt(req.params.documentId);
	var document = await findDocument(documentId);
	if (document) {
		if(patientId == document.createdBy){
			let suggestions = await langchain.summarySuggestions(patientId, req.body.containerName, document.url);
			res.status(200).send({ message: "Done", docId: req.params.documentId, suggestions: suggestions})
		}else{
			console.log("Error 1")
			insights.error("Error 1 summarySuggest");
			res.status(500).send({ message: `Error` })
		}
		
	} else {
		console.log("Error 2")
		insights.error("Error 2 summarySuggest");
		res.status(500).send({ message: `Error` })
	}

}

function findDocument(docId) {
	return new Promise((resolve, reject) => {
		Document.findById(docId, (err, document) => {
			if (err) {
				resolve(false);
			}
			resolve(document);
		}
		)
	});
  }

async function anonymizeDocument(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let documentId = crypt.decrypt(req.body.docId);
	Document.findById(documentId, (err, document) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (document && patientId == document.createdBy) {
			bookService.anonymizeDocument(document);
			res.status(200).send({ message: 'Done' })
		} else {
			insights.error("Error 2 anonymizeDocument");
			return res.status(404).send({ code: 208, message: `Error anonymizing the document: ${err}` })
		}

	})
}

function deleteSummary(req, res) {
	let containerName = req.params.patientId.substr(1);
	let patientId = crypt.decrypt(req.params.patientId);
	Patient.findById(patientId, async (err, patientdb) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (patientdb) {
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			res.status(200).send({ message: `The summary has been deleted`})
		} else {
			res.status(200).send({ message: `The summary has been deleted`})
			/*insights.error('error deleting the document')
			return res.status(404).send({ code: 208, message: `Error deleting the document: ${err}` })*/
		}

	})
}

module.exports = {
	getDocuments,
	getDocs,
	getDocument,
	updateDate,
	updateTitle,
	deleteDocument,
	uploadFile,
	uploadFileWizard,
	continueanalizedocs,
	updateDocumentStatus,
	trySummarize,
	summarySuggest,
	anonymizeDocument,
	deleteSummary
}
