'use strict'

const jwt = require('jwt-simple')
const moment = require('moment')
const config = require('../config')
const crypt = require('./crypt')
const User = require('../models/user')
const Patient = require('../models/patient')

// Access token: corto (30 minutos) para seguridad
function createToken (user){
	var id = user._id.toString();
	var idencrypt= crypt.encrypt(id);
	const payload = {
		//el id siguiente no debería de ser el id privado, así que habrá que cambiarlo
		sub: idencrypt,
		iat: moment().unix(),
		exp: moment().add(30, 'minutes').unix(), // 30 minutos para seguridad
		role: user.role,
		type: 'access'
	}
	return jwt.encode(payload, config.SECRET_TOKEN)
}

// Refresh token: largo (30 días) para renovar access tokens
function createRefreshToken (user){
	var id = user._id.toString();
	var idencrypt= crypt.encrypt(id);
	const payload = {
		sub: idencrypt,
		iat: moment().unix(),
		exp: moment().add(30, 'days').unix(), // 30 días
		role: user.role,
		type: 'refresh'
	}
	return jwt.encode(payload, config.SECRET_TOKEN)
}

  function decodeToken(token, roles){
	const decoded = new Promise(async (resolve, reject) => {
		try{
			const payload = jwt.decode(token, config.SECRET_TOKEN)
			
			// Validar que sea un access token (no refresh token)
			if(payload.type && payload.type !== 'access'){
				return reject({
					status: 401,
					message: 'Invalid token type'
				})
			}
			
			if(roles.includes(payload.role)){
				let userId= crypt.decrypt(payload.sub);
				await User.findById(userId, {"password" : false, "__v" : false, "loginAttempts" : false, "lastLogin" : false}, (err, user) => {
					if(err){
						reject({
							status: 403,
							message: 'Hacker!'
						})
					}else{
						if(user){
							if(user.role!=payload.role || userId!=user._id){
								reject({
									status: 403,
									message: 'Hacker!'
								})
							}
							//comprobar si el tokenes válido
							if (payload.exp <= moment().unix()){
								reject({
									status: 401,
									message: 'Token expired'
								})
							}
							//si el token es correcto, obtenemos el sub, que es el código del usuario
							var subdecrypt= crypt.decrypt(payload.sub.toString());
							resolve(subdecrypt)

						}else{

							reject({
								status: 403,
								message: 'Hacker!'
							})

						}
					}
				})
			}else{
				reject({
					status: 403,
					message: 'Access denied.'
				})
			}
		}catch (err){
			var messageresult='Invalid Token';
			if(err.message == "Token expired"){
				messageresult = err.message;
			}
			reject({
				status: 401,
				message: messageresult
			})
		}
	})
	return decoded
}

function decodeTokenPatient(token, roles, reqPatientId) {
	const decoded = new Promise(async (resolve, reject) => {
	  try {
		const payload = jwt.decode(token, config.SECRET_TOKEN);
		if (roles.includes(payload.role)) {
		  let userId = crypt.decrypt(payload.sub);
		  const user = await User.findById(userId, {
			"password": false,
			"__v": false,
			"loginAttempts": false,
			"lastLogin": false
		  }).exec();
		  if (!user || user.role !== payload.role || userId != user._id) {
			return reject({
			  status: 403,
			  message: 'Hacker!'
			});
		  }
  
		  // Verificar si el token ha expirado
		  if (payload.exp <= moment().unix()) {
			return reject({
			  status: 401,
			  message: 'Token expired'
			});
		  }
  
		  // Si el token es correcto, obtenemos el sub, que es el ID del usuario
		  const subdecrypt = crypt.decrypt(payload.sub.toString());
		  // Verificar la relación con el paciente
		  if (reqPatientId) {
			let patientId = crypt.decrypt(reqPatientId);
			const patient = await Patient.findById(patientId).exec();
			if (!patient) {
			  return reject({
				status: 403,
				message: 'Patient not found'
			  });
			}
  
			const isOwnPatient = patient.createdBy.toString() === userId.toString();
			const isSharedPatient = patient.customShare.some(share => 
			  share.locations.some(location => 
			    location.userId === userId && location.status === 'accepted'
			  )
			);
  
			if (!isOwnPatient && !isSharedPatient) {
			  return reject({
				status: 403,
				message: 'Access denied.'
			  });
			}
		  }else{
			return reject({
				status: 403,
				message: 'Access denied.'
			  });
		  }
  
		  resolve(subdecrypt);
  
		} else {
		  return reject({
			status: 403,
			message: 'Access denied.'
		  });
		}
	  } catch (err) {
		const messageresult = err.message === "Token expired" ? err.message : 'Invalid Token';
		return reject({
		  status: 401,
		  message: messageresult
		});
	  }
	});
	return decoded;
  }

  function decodeTokenOwnerPatient(token, roles, reqPatientId) {
	const decoded = new Promise(async (resolve, reject) => {
	  try {
		const payload = jwt.decode(token, config.SECRET_TOKEN);
		if (roles.includes(payload.role)) {
		  let userId = crypt.decrypt(payload.sub);
		  const user = await User.findById(userId, {
			"password": false,
			"__v": false,
			"loginAttempts": false,
			"lastLogin": false
		  }).exec();
		  if (!user || user.role !== payload.role || userId != user._id) {
			return reject({
			  status: 403,
			  message: 'Hacker!'
			});
		  }
  
		  // Verificar si el token ha expirado
		  if (payload.exp <= moment().unix()) {
			return reject({
			  status: 401,
			  message: 'Token expired'
			});
		  }
  
		  // Si el token es correcto, obtenemos el sub, que es el ID del usuario
		  const subdecrypt = crypt.decrypt(payload.sub.toString());
		  // Verificar la relación con el paciente
		  if (reqPatientId) {
			let patientId = crypt.decrypt(reqPatientId);
			const patient = await Patient.findById(patientId).exec();
			if (!patient) {
			  return reject({
				status: 403,
				message: 'Patient not found'
			  });
			}
  
			const isOwnPatient = patient.createdBy.toString() === userId.toString();
  
			if (!isOwnPatient) {
			  return reject({
				status: 403,
				message: 'Access denied.'
			  });
			}
		  }else{
			return reject({
				status: 403,
				message: 'Access denied.'
			  });
		  }
  
		  resolve(subdecrypt);
  
		} else {
		  return reject({
			status: 403,
			message: 'Access denied.'
		  });
		}
	  } catch (err) {
		const messageresult = err.message === "Token expired" ? err.message : 'Invalid Token';
		return reject({
		  status: 401,
		  message: messageresult
		});
	  }
	});
	return decoded;
  }

// Función para decodificar refresh token
function decodeRefreshToken(token) {
	const decoded = new Promise(async (resolve, reject) => {
		try{
			const payload = jwt.decode(token, config.SECRET_TOKEN)
			if(payload.type !== 'refresh'){
				return reject({
					status: 401,
					message: 'Invalid token type'
				})
			}
			// Verificar expiración
			if (payload.exp <= moment().unix()){
				return reject({
					status: 401,
					message: 'Token expired'
				})
			}
			let userId= crypt.decrypt(payload.sub);
			await User.findById(userId, {"password" : false, "__v" : false, "loginAttempts" : false, "lastLogin" : false}, (err, user) => {
				if(err){
					reject({
						status: 403,
						message: 'Invalid token'
					})
				}else{
					if(user && user.role == payload.role){
						resolve({
							userId: userId,
							user: user
						})
					}else{
						reject({
							status: 403,
							message: 'Invalid token'
						})
					}
				}
			})
		}catch (err){
			reject({
				status: 401,
				message: 'Invalid Token'
			})
		}
	})
	return decoded
}

module.exports = {
	createToken,
	createRefreshToken,
	decodeToken,
	decodeRefreshToken,
	decodeTokenPatient,
	decodeTokenOwnerPatient
}
