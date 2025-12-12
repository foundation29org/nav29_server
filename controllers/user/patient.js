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


function getPatientsContext (req, res){
	let userId= crypt.decrypt(req.params.userId);

	User.findById(userId, {"_id" : false , "__v" : false, "loginAttempts" : false, "lastLogin" : false}, (err, user) => {
		if (err){
			insights.error(err)
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!user){
			insights.error("The user does not exist")
			return res.status(404).send({code: 208, message: 'The user does not exist'})
		}
		if(user){
			Patient.findOne({"createdBy": userId},async (err, patient) => {
				if (err){
					insights.error(err)
					return res.status(500).send({message: `Error making the request: ${err}`})
				}
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

				try {
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
					
				} catch (error) {
					insights.error(error)
					return res.status(500).send({message: `Error creating patient: ${error}`})
				}
				
			})
		}
	})
}

function addNewPatient(req, res){
	let userId= crypt.decrypt(req.params.userId);

	User.findById(userId, {"_id" : false , "__v" : false, "loginAttempts" : false, "lastLogin" : false}, async (err, user) => {
		if (err){
			insights.error(err)
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!user){
			insights.error("The user does not exist")
			return res.status(404).send({code: 208, message: 'The user does not exist'})
		}
		if(user){
			try{
				let newPatient = await createPatient(userId);
				var id = newPatient._id.toString();
				var idencrypt= crypt.encrypt(id);
				var patientInfo = {sub:idencrypt, patientName: newPatient.patientName, birthDate: newPatient.birthDate, gender: newPatient.gender, owner: true};
				let result = {patientInfo, isVerified: user.infoVerified.isVerified, role: user.role, medicalLevel: user.medicalLevel};
				res.status(200).send(result)
			}catch(error){
				insights.error(error)
				return res.status(500).send({message: `Error creating patient: ${error}`})
			}
		}
	})
}

async function createPatient(userId) {
    return new Promise(async (resolve, reject) => {
        let patient = new Patient()
		patient.patientName = 'Patient'+Math.floor(Math.random() * 1000);
        patient.createdBy = userId
        patient.save(async (err, patientStored) => {
            if (err) {
                console.log(err);
                insights.error(err);
                console.log({ message: `Failed to save in the database: ${err} ` })
                reject(false)
            } else {
                var id = patientStored._id.toString();
                let containerName = crypt.getContainerName(id);
                var result = await f29azureService.createContainers(containerName);
                if (result) {
                    resolve(patientStored)
                } else {
					patientStored.remove(err => {
						resolve(false);
					})
                }
            }
        })
    })
}


/**
 * @api {get} https://raito.care/api/patients-all/:userId Get patient list of a user
 * @apiName getPatientsUser
 * @apiDescription This method read the patient list of a user. For each patient you have, you will get: patientId, name, and last name.
 * @apiGroup Patients
 * @apiVersion 1.0.0
 * @apiExample {js} Example usage:
 *   this.http.get('https://raito.care/api/patients-all/'+userId)
 *    .subscribe( (res : any) => {
 *      console.log('patient list: '+ res.listpatients);
 *      if(res.listpatients.length>0){
 *        console.log("patientId" + res.listpatients[0].sub +", Patient Name: "+ res.listpatients[0].patientName+", Patient surname: "+ res.listpatients[0].surname);
 *      }
 *     }, (err) => {
 *      ...
 *     }
 *
 * @apiHeader {String} authorization Users unique access-key. For this, go to  [Get token](#api-Access_token-signIn)
 * @apiHeaderExample {json} Header-Example:
 *     {
 *       "authorization": "Bearer eyJ0eXAiOiJKV1QiLCJhbGciPgDIUzI1NiJ9.eyJzdWIiOiI1M2ZlYWQ3YjY1YjM0ZTQ0MGE4YzRhNmUyMzVhNDFjNjEyOThiMWZjYTZjMjXkZTUxMTA9OGVkN2NlODMxYWY3IiwiaWF0IjoxNTIwMzUzMDMwLCJlcHAiOjE1NTE4ODkwMzAsInJvbGUiOiJVc2VyIiwiZ3JvdDEiOiJEdWNoZW5uZSBQYXJlbnQgUHJfrmVjdCBOZXRoZXJsYW5kcyJ9.MloW8eeJ857FY7-vwxJaMDajFmmVStGDcnfHfGJx05k"
 *     }
 * @apiParam {String} userId User unique ID. More info here:  [Get token and userId](#api-Access_token-signIn)
 * @apiSuccess {Object} listpatients You get a list of patients (usually only one patient), with your patient id, name, and surname.
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * {"listpatients":
 *  {
 *   "sub": "1499bb6faef2c95364e2f4tt2c9aef05abe2c9c72110a4514e8c4c3fb038ff30",
 *   "patientName": "Jhon",
 *   "surname": "Doe"
 *  },
 *  {
 *   "sub": "5499bb6faef2c95364e2f4ee2c9aef05abe2c9c72110a4514e8c4c4gt038ff30",
 *   "patientName": "Peter",
 *   "surname": "Tosh"
 *  }
 * }
 *
 */

function getPatientsUser (req, res){
	let userId= crypt.decrypt(req.params.userId);


	User.findById(userId, {"_id" : false , "__v" : false, "loginAttempts" : false, "lastLogin" : false}, (err, user) => {
		if (err){
			insights.error(err)
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!user){
			insights.error("The user does not exist")
			return res.status(404).send({code: 208, message: 'The user does not exist'})
		}
		if(user.role == 'User' || user.role == 'Caregiver' || user.role == 'Unknown'){
			Patient.find({"createdBy": userId},(err, patients) => {
				if (err){
					insights.error(err)
					return res.status(500).send({message: `Error making the request: ${err}`})
				}

				var listpatients = [];

				patients.forEach(function(u) {
					var id = u._id.toString();
					var idencrypt= crypt.encrypt(id);
					listpatients.push({sub:idencrypt, patientName: u.patientName, birthDate: u.birthDate, gender: u.gender, owner: true});
				});

				//res.status(200).send({patient, patient})
				// if the two objects are the same, the previous line can be set as follows
				res.status(200).send({listpatients})
			})
		}else if(user.role == 'Clinical' || user.role == 'SuperAdmin' || user.role == 'Admin'){

			//debería de coger los patientes creados por ellos, más adelante, habrá que meter tb los pacientes que les hayan datos permisos
			Patient.find({"createdBy": userId},(err, patients) => {
				if (err){
					insights.error(err)
					return res.status(500).send({message: `Error making the request: ${err}`})
				}

				var listpatients = [];

				patients.forEach(function(u) {
					var id = u._id.toString();
					var idencrypt= crypt.encrypt(id);
					listpatients.push({sub:idencrypt, patientName: u.patientName, surname: u.surname, isArchived: u.isArchived, birthDate: u.birthDate, gender: u.gender, owner: true});
				});

				//res.status(200).send({patient, patient})
				// if the two objects are the same, the previous line can be set as follows
				res.status(200).send({listpatients})
			})
		}else{
			res.status(401).send({message: 'without permission'})
		}
	})


}


async function getStatePatientSummary(req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	const userId = req.body.userId;
	const idWebpubsub = req.body.idWebpubsub;
	const regenerate = req.body.regenerate;
	//if docs.length == 0, and events.length == 0, then return error
	Patient.findById(patientId, (err, patient) => {
		if (err){
			insights.error(err)
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!patient){
			insights.error("The patient does not exist")
			return res.status(202).send({message: `The patient does not exist`})
		}
		if(patient.summary=='false' || (regenerate && patient.summary=='true')){
			setStatePatientSummary(patientId, 'inProcess');
			createPatientSummary(patientId, userId, idWebpubsub);
			res.status(200).send({summary: 'inProcess', summaryDate: patient.summaryDate})
		}else{
			res.status(200).send({summary: patient.summary, summaryDate: patient.summaryDate})
		}
	})
	
}

function setStatePatientSummary(patientId, state) {
	let actualDate = new Date();
	Patient.findByIdAndUpdate(patientId, { summary: state, summaryDate: actualDate}, { new: true }, (err, patientUpdated) => {
		if (err){
			insights.error(err);
			console.log(err)
		} 
		if (!patientUpdated){
			insights.error('Error updating patient summary');
			console.log('Error updating patient summary')
		}
	})
}


async function createPatientSummary(patientId, userId, idWebpubsub) {  
	let userId2 = crypt.decrypt(userId);
	const user = await User.findById(userId2, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "lastLogin": false }).exec();
	let medicalLevel = '1';
	if (user) {
		medicalLevel = user.medicalLevel;
		let preferredLang = user.lang;
		if(user.preferredResponseLanguage != null){
			preferredLang = user.preferredResponseLanguage;
		}
		await langchain.summarizePatientBrute(patientId, idWebpubsub, medicalLevel, preferredLang)
		.then((summary) => {
			setStatePatientSummary(patientId, 'true');
		})
		.catch((err) => {
			insights.error(err);
			console.log(err)
			setStatePatientSummary(patientId, 'false');
		});
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




/**
 * @api {put} https://raito.care/api/patients/:patientId Update Patient
 * @apiName updatePatient
 * @apiDescription This method allows to change the data of a patient.
 * @apiGroup Patients
 * @apiVersion 1.0.0
 * @apiExample {js} Example usage:
 *   var patient = {patientName: '', surname: '', street: '', postalCode: '', citybirth: '', provincebirth: '', countrybirth: null, city: '', province: '', country: null, phone1: '', phone2: '', birthDate: null, gender: null, siblings: [], parents: []};
 *   this.http.put('https://raito.care/api/patients/'+patientId, patient)
 *    .subscribe( (res : any) => {
 *      console.log('patient info: '+ res.patientInfo);
 *     }, (err) => {
 *      ...
 *     }
 *
 * @apiHeader {String} authorization Users unique access-key. For this, go to  [Get token](#api-Access_token-signIn)
 * @apiHeaderExample {json} Header-Example:
 *     {
 *       "authorization": "Bearer eyJ0eXAiOiJKV1QiLCJhbGciPgDIUzI1NiJ9.eyJzdWIiOiI1M2ZlYWQ3YjY1YjM0ZTQ0MGE4YzRhNmUyMzVhNDFjNjEyOThiMWZjYTZjMjXkZTUxMTA9OGVkN2NlODMxYWY3IiwiaWF0IjoxNTIwMzUzMDMwLCJlcHAiOjE1NTE4ODkwMzAsInJvbGUiOiJVc2VyIiwiZ3JvdDEiOiJEdWNoZW5uZSBQYXJlbnQgUHJfrmVjdCBOZXRoZXJsYW5kcyJ9.MloW8eeJ857FY7-vwxJaMDajFmmVStGDcnfHfGJx05k"
 *     }
 * @apiParam {String} patientId Patient unique ID. More info here:  [Get patientId](#api-Patients-getPatientsUser)
 * @apiParam (body) {string="male","female"} gender Gender of the Patient.
 * @apiParam (body) {String} phone1 Phone number of the Patient.
 * @apiParam (body) {String} phone2 Other phone number of the Patient.
 * @apiParam (body) {String} country Country code of residence of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} province Province or region code of residence of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} city City of residence of the Patient.
 * @apiParam (body) {String} [postalCode] PostalCode of residence of the Patient.
 * @apiParam (body) {String} [street] Street of residence of the Patient.
 * @apiParam (body) {String} countrybirth Country birth of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} provincebirth Province birth of the Patient. (<a href="https://github.com/astockwell/countries-and-provinces-states-regions" target="_blank">ISO_3166-2</a>)
 * @apiParam (body) {String} citybirth City birth of the Patient.
 * @apiParam (body) {Date} birthDate Date of birth of the patient.
 * @apiParam (body) {String} patientName Name of the Patient.
 * @apiParam (body) {String} surname Surname of the Patient.
 * @apiParam (body) {Object} [parents] Data about parents of the Patient. The highEducation field can be ... The profession field is a free field
 * @apiParam (body) {Object} [siblings] Data about siblings of the Patient. The affected field can be yes or no. The gender field can be male or female
 * @apiSuccess {Object} patientInfo patientId, name, and surname.
 * @apiSuccess {String} message If the patient has been created correctly, it returns the message 'Patient updated'.
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * {"patientInfo":
 *  {
 *   "sub": "1499bb6faef2c95364e2f4tt2c9aef05abe2c9c72110a4514e8c4c3fb038ff30",
 *   "patientName": "Jhon",
 *   "surname": "Doe"
 *  },
 * "message": "Patient updated"
 * }
 *
 */

function updatePatient (req, res){
	let patientId= crypt.decrypt(req.params.patientId);
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

  Patient.findByIdAndUpdate(patientId, { gender: req.body.gender, birthDate: req.body.birthDate, patientName: req.body.patientName, surname: req.body.surname, relationship: req.body.relationship, country: req.body.country, avatar: avatar }, {new: true}, async (err,patientUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		var id = patientUpdated._id.toString();
		var idencrypt= crypt.encrypt(id);
		var patientInfo = {sub:idencrypt, patientName: patientUpdated.patientName, birthDate: patientUpdated.birthDate, gender: patientUpdated.gender, owner: true};

		res.status(200).send({message: 'Patient updated', patientInfo: patientInfo})
	})
}

function getDonation (req, res){

	let patientId= crypt.decrypt(req.params.patientId);//crypt.decrypt(req.params.patientId);

	Patient.findById(patientId, {"_id" : false , "createdBy" : false }, (err,patient) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		res.status(200).send({donation: patient.donation})

	})
}

function setDonation (req, res){

	let patientId= crypt.decrypt(req.params.patientId);

	Patient.findByIdAndUpdate(patientId, { donation: req.body.donation }, {select: '-createdBy', new: true}, async (err,patientUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
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
	})
}

function findDocumentsWithoutAnonymization(patientId) {
	return new Promise((resolve, reject) => {
	  Document.find(
		{ createdBy: patientId, anonymized: 'false'},
		(err, eventsdb) => {
		  if (err) {
			reject(err);
		  } else {
			const plainDocuments = eventsdb.map((doc) => doc.toObject());
			resolve(plainDocuments);
		  }
		}
	  );
	});
  }

  async function getSharedPatients (req, res){
	let userId= crypt.decrypt(req.params.userId);
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
		  owner: false
		};
	  });
  
	  res.status(200).json(filteredPatients);

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
