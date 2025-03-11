// functions for each call of the api on user. Use the user model

'use strict'

// add the user model
const User = require('../../models/user')
const Support = require('../../models/support')
const Document = require('../../models/document')
const serviceEmail = require('../../services/email')
const crypt = require('../../services/crypt')
const insights = require('../../services/insights')
const Generalfeedback = require('../../models/generalfeedback')
const config = require('../../config')
const { Client } = require("langsmith");
const client = new Client({
	apiUrl: "https://api.smith.langchain.com",
	apiKey: config.LANGSMITH_API_KEY,
  });

function sendMsgSupport(req, res) {
	let userId = crypt.decrypt(req.body.userId);

	User.findOne({ '_id': userId }, function (err, user) {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: 'Error searching the user' })
		}
		if (user) {

			let support = new Support()
			support.type = req.body.type
			support.subject = req.body.subject
			support.description = req.body.description
			support.createdBy = userId
			support.save((err, supportStored) => {
				if (err) {
					insights.error(err);
					return res.status(500).send({ message: 'Error saving the msg' })
				}
				serviceEmail.sendMailSupport(user.email, user.lang, support)
					.then(response => {
						return res.status(200).send({ message: 'Email sent' })
					})
					.catch(response => {
						//create user, but Failed sending email.
						//res.status(200).send({ token: serviceAuth.createToken(user),  message: 'Fail sending email'})
						insights.error(response);
						res.status(500).send({ message: 'Fail sending email' })
					})
			})


		} else {
			return res.status(500).send({ message: 'user not exists' })
		}
	})
}

function sendMsgLogoutSupport(req, res) {
	let support = new Support()
	//support.type = 'Home form'
	support.subject = 'Nav29 support'
	support.description = 'Name: ' + req.body.userName + ', Email: ' + req.body.email + ', Description: ' + req.body.description
	support.createdBy = "5c77d0492f45d6006c142ab3";
	//enviamos Email
	serviceEmail.sendMailSupport(req.body.email, 'en', support)
		.then(response => {
			return res.status(200).send({ message: 'Email sent' })
		})
		.catch(response => {
			//create user, but Failed sending email.
			//res.status(200).send({ token: serviceAuth.createToken(user),  message: 'Fail sending email'})
			insights.error(response);
			res.status(500).send({ message: 'Fail sending email' })
		})
}

function getUserMsgs(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	Support.find({ "createdBy": userId }, (err, msgs) => {

		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}

		var listmsgs = [];

		msgs.forEach(function (u) {
			if (u.platform == 'Nav29' || u.platform == undefined) {
				listmsgs.push({ subject: u.subject, description: u.description, date: u.date, status: u.status, type: u.type });
			}
		});

		//res.status(200).send({patient, patient})
		// if the two objects are the same, the previous line can be set as follows
		res.status(200).send({ listmsgs })
	})
}

function sendGeneralFeedback(req, res) {

	(async () => {
	  try {
		let patientId = crypt.decrypt(req.params.patientId);
		let generalfeedback = new Generalfeedback()
		generalfeedback.value = req.body.value
		generalfeedback.type = req.body.type
		generalfeedback.lang = req.body.lang
		generalfeedback.documents = Array.isArray(req.body.documents) ? req.body.documents : [];
		generalfeedback.version = config.version + ' - ' + config.subversion
		generalfeedback.createdBy = patientId
		var d = new Date(Date.now());
		var a = d.toString();
		generalfeedback.date = a;

		// Log the documents
		if(req.body.type == 'individual'){
			let documentId = crypt.decrypt(req.body.documents[0]._id);
			const updatedDocument = await Document.findById(documentId);
			let runId = updatedDocument.langsmithRunId;
			if(runId!=''){
				// console.log("RunId: ", runId);
				// run-0e1720d0-2df6-46d6-b4aa-e70638d801e4-0 need to be 0e1720d0-2df6-46d6-b4aa-e70638d801e4 we need to remove before the first - and the last -
				let cleanRunId = runId.split('-')[1]+'-'+runId.split('-')[2]+'-'+runId.split('-')[3]+'-'+runId.split('-')[4]+'-'+runId.split('-')[5];
				// console.log("RunId: ", cleanRunId);
				await client.createFeedback(cleanRunId, "human-feedback", {
				score: req.body.value.pregunta1,
				comment: req.body.value.freeText,
				});
			}
		}
		
		

		//sendFlow(generalfeedback, req.body.lang)
		generalfeedback.save((err, generalfeedbackStored) => {
			if (err) {
			  insights.error(err);
			  console.log(err)
			}
		})
  
		res.status(200).send({ send: true })
	  } catch (e) {
		insights.error(e);
		console.error("[ERROR] OpenAI responded with status: " + e)
		res.status(500).send('error')
	  }
  
	})();
  }

	async function getGeneralFeedback(req, res) {
		try {
			let patientId = crypt.decrypt(req.params.patientId);
			let version = config.version + ' - ' + config.subversion;
			//let version = config.version;
			let documents = req.body;
	
			/*if (!Array.isArray(documents) || documents.length === 0) {
				return res.status(200).send({
					individualFeedbacks: [],
					generalFeedback: null
			});
			}*/
	
			let feedbacks = await Generalfeedback.find({
				createdBy: patientId,
				version: { $regex: `^${version}` }
			}).select('-createdBy').exec();
	
			if (feedbacks.length === 0) {
				return res.status(200).send({
					individualFeedbacks: [],
					generalFeedback: null
				});
			}
	
			// Filtrar y ordenar feedbacks generales por fecha descendente
			let generalFeedbacks = feedbacks.filter(feedback => feedback.type === 'general');
			generalFeedbacks.sort((a, b) => new Date(b.date) - new Date(a.date));
	
			// Obtener el feedback general más reciente que tenga exactamente todos los documentos
			let mostRecentGeneralFeedback = generalFeedbacks.find(feedback => {
				const feedbackDocIds = feedback.documents.map(fd => fd._id.toString());
				return documents.length === feedbackDocIds.length && documents.every(doc => feedbackDocIds.includes(doc._id));
			});
	
			// Obtener el último feedback individual para cada documento
			let individualFeedbacks = feedbacks.filter(feedback => feedback.type === 'individual');
			let latestIndividualFeedbacks = {};
	
			individualFeedbacks.forEach(feedback => {
				feedback.documents.forEach(doc => {
					if (!latestIndividualFeedbacks[doc._id] || new Date(feedback.date) > new Date(latestIndividualFeedbacks[doc._id].date)) {
						latestIndividualFeedbacks[doc._id] = feedback;
					}
				});
			});
	
			// Preparar los resultados finales
			let result = {
				individualFeedbacks: [],
				generalFeedback: mostRecentGeneralFeedback ? mostRecentGeneralFeedback : null
			};
	
			documents.forEach(doc => {
				if (latestIndividualFeedbacks[doc._id]) {
					result.individualFeedbacks.push(latestIndividualFeedbacks[doc._id]);
				}
			});
	
			res.status(200).send(result);
	
		} catch (e) {
			insights.error(e);
			console.error("[ERROR] OpenAI responded with status: " + e);
			res.status(500).send('error');
		}
	}
	

module.exports = {
	sendMsgSupport,
	sendMsgLogoutSupport,
	getUserMsgs,
	sendGeneralFeedback,
	getGeneralFeedback
}
