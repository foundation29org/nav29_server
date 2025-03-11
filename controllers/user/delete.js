// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const User = require('../../models/user')
const Patient = require('../../models/patient')
const crypt = require('../../services/crypt')
const Events = require('../../models/events')
const Document = require('../../models/document')
const Appointments = require('../../models/appointments')
const f29azureService = require("../../services/f29azure")
const bookService = require("../../services/books")
const insights = require('../../services/insights')
var admin = require("firebase-admin");
const config = require('../../config')
var serviceAccount = config.FIREBASE;
admin.initializeApp({
	credential: admin.credential.cert(serviceAccount)
});

function deleteAccount(req, res) {
	req.body.email = (req.body.email).toLowerCase();
	User.getAuthenticated(req.body.email, req.body.uid, function (err, user, reason) {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: err })
		}
		// login was successful if we have a user
		if (user) {
			let userId = crypt.decrypt(req.params.userId);
			Patient.find({ "createdBy": userId }, (err, patients) => {
				if (err) {
					insights.error(err);
					return res.status(500).send({ message: `Error making the request: ${err}` })
				}

				patients.forEach(async function (u) {
					var patientId = u._id.toString();
					var patientIdCrypt = crypt.encrypt(u._id.toString());
					var containerName = patientIdCrypt.substr(1).toString();
					deleteEvents(patientId);
					deleteDocs(patientId);
					await bookService.deleteIndexAzure(patientId);
					deletePatient(res, patientId, containerName);
				});
				deleteAppointments(userId);
				deleteLocations(userId);
				deleteUser(res, userId, req.body.uid);

			})
		} else {
			res.status(200).send({ message: `fail` })
		}
	})


	/*User.findById(userId, (err, user) => {
	})*/
}


function deleteEvents(patientId) {
	Events.find({ 'createdBy': patientId }, (err, events) => {
		if (err) {
			insights.error(err);
			console.log({ message: `Error deleting the events: ${err}` })
		}
		events.forEach(function (event) {
			event.remove(err => {
				if (err) {
					insights.error(err);
					console.log({ message: `Error deleting the events: ${err}` })
				}
			})
		});
	})
}

function deleteDocs(patientId) {
	Document.find({ 'createdBy': patientId }, (err, documents) => {
		if (err) {
			insights.error(err);
			console.log({ message: `Error deleting the documents: ${err}` })
		}
		if (documents) {
			documents.forEach(async function (document) {
				document.remove(err => {
					if (err) {
						insights.error(err);
						console.log({ message: `Error deleting the documents: ${err}` })
					}
				})
			});
		}
	})
}

function deletePatient(res, patientId, containerName) {
	Patient.findById(patientId, (err, patient) => {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: `Error deleting the case: ${err}` })
		}
		if (patient) {
			patient.remove(err => {
				if (err) {
					insights.error(err);
					return res.status(500).send({ message: `Error deleting the case: ${err}` })
				}
				f29azureService.deleteContainer(containerName)
			})
		} else {
			f29azureService.deleteContainer(containerName);
		}
	})
}

function deleteAppointments(userId) {
	Appointments.find({ 'addedBy': userId }, (err, appointments) => {
		if (err) {
			insights.error(err);
			console.log({ message: `Error deleting the appointments: ${err}` })
		}
		appointments.forEach(function (appointment) {
			appointment.remove(err => {
				if (err) {
					insights.error(err);
					console.log({ message: `Error deleting the appointments: ${err}` })
				}
			})
		});
	})
}

function deleteLocations(userId) {
	//delete all the locations on customShare on all the patients
	Patient.find({ 'customShare.locations.userId': userId }, (err, patients) => {
		if (err) {
			insights.error(err);
			console.log({ message: `Error deleting the locations: ${err}` })
			return;
		}
		patients.forEach(function (patient) {
			// Verificar si customShare existe
			if (patient.customShare && Array.isArray(patient.customShare)) {
				// Iterar sobre cada elemento en customShare
				patient.customShare.forEach(share => {
					if (share.locations && Array.isArray(share.locations)) {
						// Filtrar las locations
						share.locations = share.locations.filter(location => {
							// Convertir ambos a string para la comparación
							return String(location.userId) !== String(userId)
						});
					}
				});

				patient.markModified('customShare'); // Marcar el campo como modificado
				patient.save(err => {
					if (err) {
						insights.error(err);
						console.log({ message: `Error deleting the locations: ${err}` })
					} else {
						console.log('Successfully updated patient locations');
					}
				})
			}
		});
	})
}



function deleteUserFirebase(uid) {
	admin.auth().deleteUser(uid)

		.then(() => {
			console.log('Usuario eliminado exitosamente');
		})
		.catch((error) => {
			insights.error(error);
			console.log('Error al eliminar usuario:', error);
		});
}

function deleteUser(res, userId, uid) {
	User.findById(userId, (err, user) => {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: `Error deleting the case: ${err}` })
		}
		if (user) {
			user.remove(err => {
				if (err) {
					insights.error(err);
					return res.status(500).send({ message: `Error deleting the case: ${err}` })
				}
				deleteUserFirebase(uid);
				res.status(200).send({ message: `The case has been eliminated` })
			})
		} else {
			return res.status(202).send({ message: 'The case has been eliminated' })
		}
	})
}

function verifyToken(req, res, next) {
	const idToken = req.body.idToken;
	if (!idToken) {
		return res.status(403).send('No token provided');
	}
	admin.auth().verifyIdToken(idToken)
		.then(decodedToken => {
			// Guarda el uid o cualquier otra información en el objeto req para su uso posterior
			let lang = req.body.lang
			let mode = req.body.mode
			req.body = decodedToken;
			req.body.lang = lang;
			req.body.mode = mode;
			next();
		}).catch(error => {
			console.log(error)
			// Token inválido o ha expirado
			res.status(403).send('Unauthorized');
		});
}

function removePatient(req, res) {

	let patientId = crypt.decrypt(req.params.patientId);

	Patient.findById(patientId, { "_id": false, "createdBy": false }, async (err, patient) => {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (!patient) {
			insights.error(`The patient does not exist`);
			return res.status(202).send({ message: `The patient does not exist` })
		} else {
			var patientIdCrypt = crypt.encrypt(patientId);
			var containerName = patientIdCrypt.substr(1).toString();
			deleteEvents(patientId);
			deleteDocs(patientId);
			await bookService.deleteIndexAzure(patientId)
			deletePatient(res, patientId, containerName);
			res.status(200).send({ message: `The case has been eliminated` })
		}
	})
}

module.exports = {
	deleteAccount,
	verifyToken,
	removePatient
}
