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

async function deleteAccount(req, res) {
	const email = (req.body.email).toLowerCase();
	const firebaseUid = req.body.uid;
	
	User.getAuthenticatedByFirebase(email, firebaseUid, async function (err, user, reason) {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: err })
		}
		
		// Verificación exitosa si tenemos usuario
		if (user) {
			try {
				let userId = crypt.decrypt(req.params.userId);
				const patients = await Patient.find({ "createdBy": userId });

				for (const u of patients) {
					var patientId = u._id.toString();
					var containerName = crypt.getContainerName(u._id.toString());
					await deleteEvents(patientId);
					await deleteDocs(patientId);
					await bookService.deleteIndexAzure(patientId);
					await deletePatientAsync(patientId, containerName);
				}
				await deleteAppointments(userId);
				await deleteLocations(userId);
				// Usar firebaseUid del usuario para eliminar de Firebase
				await deleteUserAsync(res, userId, user.firebaseUid || firebaseUid);
			} catch (err) {
				insights.error(err);
				return res.status(500).send({ message: `Error making the request: ${err}` })
			}
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


async function deleteEvents(patientId) {
	try {
		await Events.deleteMany({ 'createdBy': patientId });
	} catch (err) {
		insights.error(err);
		console.log({ message: `Error deleting the events: ${err}` })
	}
}

async function deleteDocs(patientId) {
	try {
		await Document.deleteMany({ 'createdBy': patientId });
	} catch (err) {
		insights.error(err);
		console.log({ message: `Error deleting the documents: ${err}` })
	}
}

async function deletePatientAsync(patientId, containerName) {
	try {
		const patient = await Patient.findById(patientId);
		if (patient) {
			await Patient.deleteOne({ _id: patientId });
		}
		await f29azureService.deleteContainer(containerName);
	} catch (err) {
		insights.error(err);
		console.log({ message: `Error deleting the case: ${err}` })
	}
}

async function deleteAppointments(userId) {
	try {
		await Appointments.deleteMany({ 'addedBy': userId });
	} catch (err) {
		insights.error(err);
		console.log({ message: `Error deleting the appointments: ${err}` })
	}
}

async function deleteLocations(userId) {
	try {
		const patients = await Patient.find({ 'customShare.locations.userId': userId });
		
		for (const patient of patients) {
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
				await patient.save();
				console.log('Successfully updated patient locations');
			}
		}
	} catch (err) {
		insights.error(err);
		console.log({ message: `Error deleting the locations: ${err}` })
	}
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

async function deleteUserAsync(res, userId, uid) {
	try {
		const user = await User.findById(userId);
		if (user) {
			await User.deleteOne({ _id: userId });
			deleteUserFirebase(uid);
			res.status(200).send({ message: `The case has been eliminated` })
		} else {
			return res.status(202).send({ message: 'The case has been eliminated' })
		}
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error deleting the case: ${err}` })
	}
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

async function removePatient(req, res) {
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		const patient = await Patient.findById(patientId).select('-_id -createdBy');
		
		if (!patient) {
			insights.error(`The patient does not exist`);
			return res.status(202).send({ message: `The patient does not exist` })
		}
		
		var containerName = crypt.getContainerName(patientId);
		await deleteEvents(patientId);
		await deleteDocs(patientId);
		await bookService.deleteIndexAzure(patientId);
		await deletePatientAsync(patientId, containerName);
		res.status(200).send({ message: `The case has been eliminated` })
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error making the request: ${err}` })
	}
}

module.exports = {
	deleteAccount,
	verifyToken,
	removePatient
}
