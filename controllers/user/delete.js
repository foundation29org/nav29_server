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
	const email = (req.body.email).toLowerCase();
	const firebaseUid = req.body.uid;
	
	User.getAuthenticatedByFirebase(email, firebaseUid, function (err, user, reason) {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: err })
		}
		
		// Verificación exitosa si tenemos usuario
		if (user) {
			let userId = crypt.decrypt(req.params.userId);
			Patient.find({ "createdBy": userId }, (err, patients) => {
				if (err) {
					insights.error(err);
					return res.status(500).send({ message: `Error making the request: ${err}` })
				}

				patients.forEach(async function (u) {
					var patientId = u._id.toString();
					var containerName = crypt.getContainerName(u._id.toString());
					deleteEvents(patientId);
					deleteDocs(patientId);
					await bookService.deleteIndexAzure(patientId);
					deletePatient(res, patientId, containerName);
				});
				deleteAppointments(userId);
				deleteLocations(userId);
				// Usar firebaseUid del usuario para eliminar de Firebase
				deleteUser(res, userId, user.firebaseUid || firebaseUid);
			})
		} else {
			// Manejar diferentes razones de fallo
			if (reason === User.failedLogin.NOT_FOUND) {
				res.status(404).send({ message: 'User not found' })
			} else if (reason === User.failedLogin.BLOCKED) {
				res.status(403).send({ message: 'Account blocked' })
			} else {
				res.status(401).send({ message: 'Authentication failed' })
			}
		}
	})
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
			// Extraer datos del body ANTES de reemplazarlo
			const bodyEmail = req.body.email;
			const lang = req.body.lang;
			const mode = req.body.mode;
			
			// Usar SIEMPRE el email del token de Firebase (verificado y seguro)
			const verifiedEmail = decodedToken.email;
			
			// Verificación de seguridad: si el cliente envió un email, debe coincidir
			if (bodyEmail && verifiedEmail && bodyEmail.toLowerCase() !== verifiedEmail.toLowerCase()) {
				console.log(`Security warning: Email mismatch. Body: ${bodyEmail}, Token: ${verifiedEmail}`);
				return res.status(403).send('Email mismatch');
			}
			
			// Verificar que el token tiene email (algunos providers podrían no tenerlo)
			if (!verifiedEmail) {
				console.log('Token does not contain email');
				return res.status(403).send('Token does not contain email');
			}
			
			// Reemplazar body con datos verificados del token
			req.body = {
				// Datos verificados del token de Firebase (SEGUROS)
				uid: decodedToken.uid,
				email: verifiedEmail,
				email_verified: decodedToken.email_verified,
				name: decodedToken.name || '',
				picture: decodedToken.picture || '',
				firebase: decodedToken.firebase,
				// Datos adicionales del body original (no sensibles)
				lang: lang,
				mode: mode
			};
			
			next();
		}).catch(error => {
			console.log('Token verification error:', error.message);
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
			var containerName = crypt.getContainerName(patientId);
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
