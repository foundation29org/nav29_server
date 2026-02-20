// functions for each call of the api on patient. Use the patient model

'use strict'

// add the patient model
const Patient = require('../../models/patient')
const Document = require('../../models/document')
const User = require('../../models/user')
const crypt = require('../../services/crypt')
const f29azureService = require("../../services/f29azure")
const bookService = require("../../services/books")
const langchain = require('../../services/langchain')
const insights = require('../../services/insights')
const pubsub = require('../../services/pubsub');
const document = require('./patient/documents')
const Events = require('./patient/events')


async function getPatientsContext (req, res){
	try {
		let userId = crypt.decrypt(req.params.userId);

		const user = await User.findById(userId).select('-_id -__v -loginAttempts -lastLogin');
		
		if(!user){
			insights.error("The user does not exist")
			return res.status(404).send({code: 208, message: 'The user does not exist'})
		}
		
		let patient = await Patient.findOne({"createdBy": userId});
		let hasPatients = false;
		if(patient){
			hasPatients = true;
		}
		
		//comprobar si el usuario tiene un paciente que le han compartido
		console.log(userId)
		const patientsShared = await Patient.find({
			'customShare.locations': {
				$elemMatch: {
					userId: userId,
					status: 'accepted'
				}
			}
		});
		if(patientsShared.length > 0){
			hasPatients = true;
			patient = patientsShared[0];
		}
		let preferredLang = user.lang;
		if(user.preferredResponseLanguage != null){
			preferredLang = user.preferredResponseLanguage;
		}

		if(hasPatients){
			var id = patient._id.toString();
			var idencrypt= crypt.encrypt(id);
			var patientInfo = {sub:idencrypt, patientName: patient.patientName, birthDate: patient.birthDate, gender: patient.gender, owner: true};
			let result = {patientInfo, hasPatients: hasPatients, isVerified: user.infoVerified.isVerified, role: user.role, medicalLevel: user.medicalLevel, preferredResponseLanguage: preferredLang};
			return res.status(200).send(result)
		}else{
			let newPatient = await createPatient(userId);
			var id = newPatient._id.toString();
			var idencrypt= crypt.encrypt(id);
			var patientInfo = {sub:idencrypt, patientName: newPatient.patientName, birthDate: newPatient.birthDate, gender: newPatient.gender, owner: true};
			let result = {patientInfo, hasPatients: hasPatients, isVerified: user.infoVerified.isVerified, role: user.role, medicalLevel: user.medicalLevel, preferredResponseLanguage: preferredLang};
			res.status(200).send(result)
		}
	} catch (err) {
		insights.error(err);
		if (f29azureService.isContainerBeingDeletedError && f29azureService.isContainerBeingDeletedError(err)) {
			return res.status(409).send({ code: 'ContainerBeingDeleted', message: 'El contenedor se está eliminando. Espera unos segundos e intenta de nuevo.' });
		}
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function addNewPatient(req, res){
	try {
		let userId = crypt.decrypt(req.params.userId);

		const user = await User.findById(userId).select('-_id -__v -loginAttempts -lastLogin');
		
		if(!user){
			insights.error("The user does not exist")
			return res.status(404).send({code: 208, message: 'The user does not exist'})
		}
		
		let newPatient = await createPatient(userId);
		var id = newPatient._id.toString();
		var idencrypt= crypt.encrypt(id);
		var patientInfo = {sub:idencrypt, patientName: newPatient.patientName, birthDate: newPatient.birthDate, gender: newPatient.gender, owner: true};
		let result = {patientInfo, isVerified: user.infoVerified.isVerified, role: user.role, medicalLevel: user.medicalLevel};
		res.status(200).send(result)
	} catch (err) {
		insights.error(err);
		if (f29azureService.isContainerBeingDeletedError && f29azureService.isContainerBeingDeletedError(err)) {
			return res.status(409).send({ code: 'ContainerBeingDeleted', message: 'El contenedor se está eliminando. Espera unos segundos e intenta de nuevo.' });
		}
		return res.status(500).send({message: `Error creating patient: ${err}`})
	}
}

async function createPatient(userId) {
	let patient = new Patient()
	patient.patientName = 'Patient'+Math.floor(Math.random() * 1000);
	patient.createdBy = userId
	
	try {
		const patientStored = await patient.save();
		var id = patientStored._id.toString();
		let containerName = crypt.getContainerName(id);
		var result = await f29azureService.createContainers(containerName);
		if (result) {
			return patientStored;
		} else {
			await Patient.deleteOne({ _id: patientStored._id });
			return false;
		}
	} catch (err) {
		console.log(err);
		insights.error(err);
		console.log({ message: `Failed to save in the database: ${err} ` })
		throw err;
	}
}


async function getPatientsUser (req, res){
	try {
		let userId = crypt.decrypt(req.params.userId);

		const user = await User.findById(userId).select('-_id -__v -loginAttempts -lastLogin');
		
		if(!user){
			insights.error("The user does not exist")
			return res.status(404).send({code: 208, message: 'The user does not exist'})
		}
		
		if(user.role == 'User' || user.role == 'Caregiver' || user.role == 'Unknown'){
			const patients = await Patient.find({"createdBy": userId});

			var listpatients = [];

			patients.forEach(function(u) {
				var id = u._id.toString();
				var idencrypt= crypt.encrypt(id);
				listpatients.push({sub:idencrypt, patientName: u.patientName, birthDate: u.birthDate, gender: u.gender, country: u.country, owner: true});
			});

			res.status(200).send({listpatients})
		}else if(user.role == 'Clinical' || user.role == 'SuperAdmin' || user.role == 'Admin'){
			const patients = await Patient.find({"createdBy": userId});

			var listpatients = [];

			patients.forEach(function(u) {
				var id = u._id.toString();
				var idencrypt= crypt.encrypt(id);
				listpatients.push({sub:idencrypt, patientName: u.patientName, surname: u.surname, isArchived: u.isArchived, birthDate: u.birthDate, gender: u.gender, country: u.country, owner: true});
			});

			res.status(200).send({listpatients})
		}else{
			res.status(401).send({message: 'without permission'})
		}
	} catch (err) {
		insights.error(err)
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}


async function getStatePatientSummary(req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		const userId = req.body.userId;
		const idWebpubsub = req.body.idWebpubsub;
		const regenerate = req.body.regenerate;
		
		const patient = await Patient.findById(patientId);
		
		if(!patient){
			insights.error("The patient does not exist")
			return res.status(202).send({message: `The patient does not exist`})
		}
		
		if(patient.summary=='false' || (regenerate && patient.summary=='true')){
			await setStatePatientSummary(patientId, 'inProcess');
			createPatientSummary(patientId, userId, idWebpubsub);
			res.status(200).send({summary: 'inProcess', summaryDate: patient.summaryDate})
		}else{
			res.status(200).send({summary: patient.summary, summaryDate: patient.summaryDate})
		}
	} catch (err) {
		insights.error(err)
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function setStatePatientSummary(patientId, state) {
	try {
		let actualDate = new Date();
		const patientUpdated = await Patient.findByIdAndUpdate(
			patientId, 
			{ summary: state, summaryDate: actualDate}, 
			{ new: true }
		);
		
		if (!patientUpdated){
			insights.error('Error updating patient summary');
			console.log('Error updating patient summary')
		}
	} catch (err) {
		insights.error(err);
		console.log(err)
	}
}


async function createPatientSummary(patientId, userId, idWebpubsub) {  
	let userId2 = crypt.decrypt(userId);
	const user = await User.findById(userId2).select('-_id -password -__v -loginAttempts -lastLogin');
	let medicalLevel = '1';
	if (user) {
		medicalLevel = user.medicalLevel;
		let preferredLang = user.lang;
		if(user.preferredResponseLanguage != null){
			preferredLang = user.preferredResponseLanguage;
		}
		try {
			await langchain.summarizePatientBrute(patientId, idWebpubsub, medicalLevel, preferredLang);
			await setStatePatientSummary(patientId, 'true');
		} catch (err) {
			insights.error(err);
			console.log(err)
			await setStatePatientSummary(patientId, 'false');
		}
	}else{
		insights.error({ message: 'user dont exists'});
		//crypt patientId
		const patientIdCrypt = crypt.encrypt(patientId);
		const message = { "time": new Date().toISOString(), "status": "patient card fail", "step": "summary", "patientId": patientIdCrypt }
      	pubsub.sendToUser(idWebpubsub, message)
	}
}

async function getPatientData (req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	const patientData = await langchain.getPatientData(patientId);
	res.status(200).send(patientData)
}




async function updatePatient (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let update = req.body
		var avatar = '';
		if(req.body.avatar==undefined){
			if(req.body.gender!=undefined){
				if(req.body.gender=='male'){
					avatar='boy-0'
				}else if(req.body.gender=='female'){
					avatar='girl-0'
				}
			}
		}else{
			avatar = req.body.avatar;
		}

		const patientUpdated = await Patient.findByIdAndUpdate(
			patientId, 
			{ gender: req.body.gender, birthDate: req.body.birthDate, patientName: req.body.patientName, surname: req.body.surname, relationship: req.body.relationship, country: req.body.country, avatar: avatar }, 
			{new: true}
		);
		
		var id = patientUpdated._id.toString();
		var idencrypt= crypt.encrypt(id);
		var patientInfo = {sub:idencrypt, patientName: patientUpdated.patientName, birthDate: patientUpdated.birthDate, gender: patientUpdated.gender, country: patientUpdated.country, owner: true};

		res.status(200).send({message: 'Patient updated', patientInfo: patientInfo})
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function getDonation (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);

		const patient = await Patient.findById(patientId).select('-_id -createdBy');
		res.status(200).send({donation: patient.donation})
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function setDonation (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);

		const patientUpdated = await Patient.findByIdAndUpdate(
			patientId, 
			{ donation: req.body.donation }, 
			{projection: { createdBy: 0 }, new: true}
		);
		
		if(req.body.donation){
			//ver si tiene documentos pendientes de anonimizar
			const documents = await findDocumentsWithoutAnonymization(patientId);
			if(documents.length>0){
				bookService.anonymizeBooks(documents);
				res.status(200).send({message: 'donation changed', documents: documents.length})
			}else{
				res.status(200).send({message: 'donation changed'})
			}
		}else{
			res.status(200).send({message: 'donation changed'})
		}
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function findDocumentsWithoutAnonymization(patientId) {
	try {
		const eventsdb = await Document.find({ createdBy: patientId, anonymized: 'false'});
		const plainDocuments = eventsdb.map((doc) => doc.toObject());
		return plainDocuments;
	} catch (err) {
		insights.error(err);
		throw err;
	}
}

async function getSharedPatients (req, res){
	try {
		let userId = crypt.decrypt(req.params.userId);
		const patients = await Patient.find({
			'customShare.locations': {
				$elemMatch: {
					userId: userId,
					status: 'accepted'
				}
			}
		});
	  
		const filteredPatients = patients.map(patient => {
			const id = patient._id.toString();
			const idencrypt = crypt.encrypt(id);
			return {
				sub: idencrypt,
				patientName: patient.patientName,
				birthDate: patient.birthDate,
				gender: patient.gender,
				country: patient.country,
				owner: false
			};
		});
	  
		res.status(200).json(filteredPatients);
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

module.exports = {
	getPatientsContext,
	addNewPatient,
	getPatientsUser,
	getPatientData,
	getStatePatientSummary,
	setStatePatientSummary,
	updatePatient,
	getDonation,
	setDonation,
	getSharedPatients
}
