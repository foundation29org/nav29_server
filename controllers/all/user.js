// functions for each call of the api on user. Use the user model

'use strict'

// add the user model
const User = require('../../models/user')
const Patient = require('../../models/patient')
const Support = require('../../models/support')
const serviceAuth = require('../../services/auth')
const serviceEmail = require('../../services/email')
const crypt = require('../../services/crypt')
const f29azureService = require("../../services/f29azure")
const bcrypt = require('bcrypt-nodejs')
const insights = require('../../services/insights')
const jwt = require('jwt-simple')

// Helper function para obtener opciones de cookie según el entorno
function getCookieOptions() {
	const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV !== 'development';
	return {
		httpOnly: true,
		secure: isProduction, // Solo HTTPS en producción
		sameSite: isProduction ? 'strict' : 'lax', // Strict en producción, Lax en desarrollo
		// En producción, comparte cookies entre apex y www
		...(isProduction ? { domain: '.nav29.org' } : {}),
		maxAge: 30 * 24 * 60 * 60 * 1000 // 30 días para refresh token
	};
}

// Helper function para establecer cookies de autenticación
function setAuthCookies(res, accessToken, refreshToken) {
	const cookieOptions = getCookieOptions();
	
	// Establecer access token (30 minutos)
	res.cookie('access_token', accessToken, {
		...cookieOptions,
		maxAge: 30 * 60 * 1000 // 30 minutos para access token
	});
	
	// Establecer refresh token (30 días)
	res.cookie('refresh_token', refreshToken, cookieOptions);
}

// Helper function para limpiar cookies de autenticación (logout)
function clearAuthCookies(res) {
	const cookieOptions = getCookieOptions();
	
	// Limpiar cookies estableciendo valores vacíos y expiración en el pasado
	res.cookie('access_token', '', {
		...cookieOptions,
		maxAge: 0
	});
	res.cookie('refresh_token', '', {
		...cookieOptions,
		maxAge: 0
	});
}

function login(req, res) {
	// attempt to authenticate user
	const email = (req.body.email).toLowerCase();
	const firebaseUid = req.body.uid;
	const mode = req.body.mode;
	
	User.getAuthenticatedByFirebase(email, firebaseUid, function (err, user, reason) {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: err })
		}
		
		// login was successful if we have a user
		if (user) {
			const accessToken = serviceAuth.createToken(user);
			const refreshToken = serviceAuth.createRefreshToken(user);
			
			// Establecer cookies de autenticación
			setAuthCookies(res, accessToken, refreshToken);
			
			// También devolver en body para compatibilidad durante migración
			return res.status(200).send({
				message: 'You have successfully logged in',
				token: accessToken, // Mantener por compatibilidad temporal
				lang: user.lang
			})
		}
		
		// Usuario no encontrado
		if (reason === User.failedLogin.NOT_FOUND) {
			// Solo crear cuenta si está en modo registro
			if (mode === 'register') {
				const newUser = new User({
					email: email,
					firebaseUid: firebaseUid,
					role: req.body.role || 'Unknown',
					userName: req.body.name || '',
					lastName: req.body.lastName || '',
					provider: req.body.firebase?.sign_in_provider || '',
					emailVerified: req.body.email_verified || false,
					lang: req.body.lang || 'en',
					picture: req.body.picture || ''
				})
				
				newUser.save((err, userSaved) => {
					if (err) {
						insights.error(err);
						return res.status(500).send({ message: `Error creating the user: ${err}` })
					}
					if (userSaved) {
						const accessToken = serviceAuth.createToken(userSaved);
						const refreshToken = serviceAuth.createRefreshToken(userSaved);
						
						// Establecer cookies de autenticación
						setAuthCookies(res, accessToken, refreshToken);
						
						return res.status(200).send({
							message: 'You have successfully logged in',
							token: accessToken, // Mantener por compatibilidad temporal
							lang: userSaved.lang
						})
					} else {
						return res.status(500).send({ message: 'Error creating the user' })
					}
				})
			} else {
				// Usuario no existe y no está en modo registro
				return res.status(401).send({ message: 'Not found' })
			}
		} else if (reason === User.failedLogin.BLOCKED) {
			return res.status(403).send({ message: 'Account blocked' })
		} else if (reason === User.failedLogin.MAX_ATTEMPTS) {
			return res.status(429).send({ message: 'Too many login attempts. Account temporarily locked.' })
		} else {
			return res.status(401).send({ message: 'Login failed' })
		}
	})
}


/**
 * @api {get} https://raitogpt2.azurewebsites.net/api/users/:id Get user
 * @apiName getUser
 * @apiVersion 1.0.0
 * @apiGroup Users
 * @apiDescription This methods read data of a User
 * @apiExample {js} Example usage:
 *   this.http.get('https://raitogpt2.azurewebsites.net/api/users/'+userId)
 *    .subscribe( (res : any) => {
 *      console.log(res.userName);
 *   }, (err) => {
 *     ...
 *   }
 *
 * @apiHeader {String} authorization Users unique access-key. For this, go to  [Get token](#api-Access_token-signIn)
 * @apiHeaderExample {json} Header-Example:
 *     {
 *       "authorization": "Bearer eyJ0eXAiOiJKV1QiLCJhbGciPgDIUzI1NiJ9.eyJzdWIiOiI1M2ZlYWQ3YjY1YjM0ZTQ0MGE4YzRhNmUyMzVhNDFjNjEyOThiMWZjYTZjMjXkZTUxMTA9OGVkN2NlODMxYWY3IiwiaWF0IjoxNTIwMzUzMDMwLCJlcHAiOjE1NTE4ODkwMzAsInJvbGUiOiJVc2VyIiwiZ3JvdDEiOiJEdWNoZW5uZSBQYXJlbnQgUHJfrmVjdCBOZXRoZXJsYW5kcyJ9.MloW8eeJ857FY7-vwxJaMDajFmmVStGDcnfHfGJx05k"
 *     }
 * @apiParam {String} userId User unique ID. More info here:  [Get token and userId](#api-Access_token-signIn)
 * @apiSuccess {String} email Email of the User.
 * @apiSuccess {String} userName UserName of the User.
 * @apiSuccess {String} lang lang of the User.
 * @apiSuccess {Date} signupDate Signup date of the User.
 * @apiError UserNotFound The <code>id</code> of the User was not found.
 * @apiErrorExample {json} Error-Response:
 * HTTP/1.1 404 Not Found
 *     {
 *       "error": "UserNotFound"
 *     }
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * {"user":
 *  {
 *   "email": "John@example.com",
 *   "userName": "Doe",
 *   "lang": "en",
 *   "signupDate": "2018-01-26T13:25:31.077Z"
 *  }
 * }
 *
 */

function getUser(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	//añado  {"_id" : false} para que no devuelva el _id
	User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (!user){
			insights.error("The user does not exist");
			return res.status(404).send({ code: 208, message: `The user does not exist` })
		}

		res.status(200).send({ user })
	})
}

function getUserLang(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	//añado  {"_id" : false} para que no devuelva el _id
	User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (!user){
			insights.error("The user does not exist");
			return res.status(404).send({ code: 208, message: `The user does not exist` })
		}else{
			res.status(200).send({ user: {lang: user.lang} })
		}

		
	})
}

function getUserPreferredLang(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	//añado  {"_id" : false} para que no devuelva el _id
	User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (!user){
			insights.error("The user does not exist");
			return res.status(404).send({ code: 208, message: `The user does not exist` })
		}else{
			res.status(200).send({lang: user.lang, preferredResponseLanguage: user.preferredResponseLanguage})
		}

		
	})
}

//updatePreferredLang
function updatePreferredLang(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	let preferredResponseLanguage = req.body.preferredResponseLanguage;
	User.findByIdAndUpdate(userId, { preferredResponseLanguage: preferredResponseLanguage }, { new: true }, (err, userUpdated) => {
		if (err) {
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		res.status(200).send({ message: 'Updated' })
	})
}

function getSettings(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	//añado  {"_id" : false} para que no devuelva el _id
	User.findById(userId, { "userName": false, "email": false, "signupDate": false, "_id": false, "password": false, "__v": false, "loginAttempts": false, "lastLogin": false }, (err, user) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (!user){
			insights.error("The user does not exist");
			return res.status(404).send({ code: 208, message: `The user does not exist` })
		}
		res.status(200).send({ user: {lang: user.lang, preferredResponseLanguage: user.preferredResponseLanguage, role: user.role, medicalLevel: user.medicalLevel } })
	})
}

function changeLang(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	let update = req.body

	User.findByIdAndUpdate(userId, update, { select: '-_id userName lastName lang email signupDate', new: true }, (err, userUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}else{
			if(userUpdated){
				res.status(200).send({ user: {lang: userUpdated.lang} })
			}else{
				insights.error("The user does not exist");
				return res.status(404).send({ code: 208, message: `The user does not exist` })
			}
			
		}
		
	})
}


function getUserName(req, res) {
	let userId = crypt.decrypt(req.params.userId);
	//añado  {"_id" : false} para que no devuelva el _id
	User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		var result = "Jhon";
		if (user) {
			res.status(200).send({ userName: user.userName, lastName: user.lastName, idUser: req.params.userId, email: user.email, role: user.role })
		}else{
			res.status(200).send({ userName: '', lastName: '', idUser: req.params.userId, email: '', role: 'Unknown' })
		}
	})
}

function getUserEmail(user) {
	return new Promise(async function (resolve, reject) {
		try {
			let userId = crypt.decrypt(user);
			//añado  {"_id" : false} para que no devuelva el _id
			User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
				if (err){
					resolve(null);
				}
				if (user) {
					resolve(user.email);
				}else{
					resolve(null);
				}
			})
		} catch (error) {
			insights.error({ message: 'Error in getUserEmail', error: error });
			resolve(null);
		}
	
});
}

function getUserEmailAndLand(user) {
	return new Promise(async function (resolve, reject) {
		try {
			let userId = crypt.decrypt(user);
			//añado  {"_id" : false} para que no devuelva el _id
			User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
				if (err){
					resolve(null);
				}
				if (user) {
					resolve({email: user.email, lang: user.lang});
				}else{
					resolve(null);
				}
			})
		} catch (error) {
			insights.error({ message: 'Error in getUserEmailAndLand', error: error });
			resolve(null);
		}
	
});
}

function setaccesstopatient(req, res) {
	const payload = jwt.decode(req.body.idToken, null, true);
	if(payload.email_verified && payload.email!=''){
		let patientId = crypt.decrypt(req.params.patientId);
		Patient.findById(patientId, (err, patient) => {
			if (err){
				insights.error(err);
				return res.status(500).send({ message: `Error making the request: ${err}` })
			}
			if (!patient){
				insights.error(err);
				return res.status(404).send({ code: 208, message: `The patient does not exist` })
			}
			if(patient){
				if(patient.customShare.length>0){
					var found = false;
					var alow = true;
					var notes = '';
					patient.customShare.forEach((element, index) => {
						var splittoken = element.token.split('token=');
						if(splittoken[1] == req.body.token){
							notes = element.notes;
							let locations = element.locations.toObject();
							req.body.location.status = 'accepted';
							req.body.location.email = payload.email;
							req.body.location.date = new Date();
							req.body.location.lastAccess = new Date();
							if(locations.length>0){
								//y mirar ademas si la localizacion está aprobada o rechazada
								if(areLocationsEqual(req.body.location, locations)=='true') {
									found = true;
									//update de lastAccess
									let indexLocation = getIndexLocation(req.body.location, locations);
									if(indexLocation!=-1){
										locations[indexLocation].lastAccess = new Date();
										patient.customShare[index].locations = locations;
									}
	
								}else if(areLocationsEqual(req.body.location, locations)=='deny'){
									alow = false;
								}else{
									req.body.location.userId =  crypt.decrypt(req.body.location.userId);
									locations.push(req.body.location);
									patient.customShare[index].locations = locations;
								}
							}else{
								req.body.location.userId =  crypt.decrypt(req.body.location.userId);
								locations.push(req.body.location);
								patient.customShare[index].locations = locations;
							}
							
							
						}
					  });
					if(found){
						Patient.findByIdAndUpdate(patientId, {customShare: patient.customShare}, {new: true}, async (err, patientUpdated) => {
							if (err) {
								console.log('Error al actualizar la fecha de acceso del usuario')
							}
							if(!patientUpdated){
								console.log('Error al actualizar la fecha de acceso del usuario 2')
							}
						}
						);
						let userId = crypt.encrypt((patient.createdBy).toString());
						res.status(200).send({ userid: userId, message: 'Done' })
					}else{
						if(alow){

							Patient.findByIdAndUpdate(patientId, {customShare: patient.customShare}, {new: true}, async (err, patientUpdated) => {
								if (err) {
									console.log(err)
									res.status(500).send({ message: `Error making the request: ${err}` })
								}
								if(!patientUpdated){
									console.log('Error making the request')
									res.status(500).send({ message: `Error making the request: ${err}` })
								}else{
									//send email to the user
									let userId = crypt.encrypt((patient.createdBy).toString());
									let userInfo = await getUserEmailAndLand(userId);
									if(userInfo!=null){
										try {
											serviceEmail.sendMailAccess(userInfo, req.body.location, notes);
										  } catch (emailError) {
											console.log('Fail sending email');
										  }
										
									}
									res.status(200).send({ userid: userId, message: 'Done' })
								}
							}
							);
						}else{
							res.status(403).send({ message: 'Forbidden' })
						}
						
					}
					
				}else{
					return res.status(403).send({message: 'Forbidden'})
				}
			}
			
		})
	}else{
		return res.status(403).send({message: 'Forbidden'})
	}
	
}
function areLocationsEqual(loc1, locationsArray) {
	for (const location of locationsArray) {
	  if (loc1.email === location.email) {
		if(loc1.status === location.status){
			return 'true';
		}else{
			return 'deny';
		}
	  }
	}
	return 'false';
  }

  function getIndexLocation(loc1, locationsArray) {
	for (let i = 0; i < locationsArray.length; i++) {
	  if (loc1.email === locationsArray[i].email) {
		return i; // Devuelve el índice en lugar del elemento
	  }
	}
	return -1; // Devuelve -1 si no se encuentra
  }

	function isVerified(req, res) {
		let userId = crypt.decrypt(req.params.userId);
		//añado  {"_id" : false} para que no devuelva el _id
		User.findById(userId, { "_id": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
			if (err) return res.status(500).send({ message: `Error making the request: ${err}` })
			var result = false;
			if (user) {
				result = user.infoVerified;
			}
			res.status(200).send({ infoVerified: result })
		})
	}
	
	function setInfoVerified(req, res) {
	
		let userId = crypt.decrypt(req.params.userId);
		var infoVerified = req.body.infoVerified;
		User.findByIdAndUpdate(userId, { infoVerified: infoVerified }, { new: true }, (err, userUpdated) => {
			if (userUpdated) {
				res.status(200).send({ message: 'Updated' })
			} else {
				console.log(err);
				res.status(200).send({ message: 'error' })
			}
		})
	}

	function setRoleMedicalLevel(req, res) {
		let userId = crypt.decrypt(req.params.userId);
		var role = req.body.role;
		var medicalLevel = '1';
		if (role == "Clinical") {
			medicalLevel = '3';
		}
		User.findByIdAndUpdate(userId, { role: role, medicalLevel: medicalLevel }, { new: true }, (err, userUpdated) => {
			if (userUpdated) {
				const accessToken = serviceAuth.createToken(userUpdated);
				const refreshToken = serviceAuth.createRefreshToken(userUpdated);
				
				// Establecer cookies de autenticación
				setAuthCookies(res, accessToken, refreshToken);
				
				res.status(200).send({
					message: 'You have successfully logged in',
					token: accessToken,
					lang: userUpdated.lang
				})
			} else {
				console.log(err);
				res.status(200).send({ message: 'error' })
			}
		})
	}

	function setRole(req, res) {
		let userId = crypt.decrypt(req.params.userId);
		var role = req.body.role;
		User.findByIdAndUpdate(userId, { role: role }, { new: true }, (err, userUpdated) => {
			if (userUpdated) {
				const accessToken = serviceAuth.createToken(userUpdated);
				const refreshToken = serviceAuth.createRefreshToken(userUpdated);
				
				// Establecer cookies de autenticación
				setAuthCookies(res, accessToken, refreshToken);
				
				res.status(200).send({
					message: 'You have successfully logged in',
					token: accessToken,
					lang: userUpdated.lang
				})
			} else {
				console.log(err);
				res.status(200).send({ message: 'error' })
			}
		})
	}

	function getRoleMedicalLevel(req, res) {
		let userId = crypt.decrypt(req.params.userId);
		//return the role
		User.findById(userId, { "_id": false, "password": false, "__v": false, "loginAttempts": false, "lastLogin": false }, (err, user) => {
			if (err) return res.status(500).send({ message: `Error making the request: ${err}` })
			var result = "Unknown";
			var medicalLevel = '1';
			var preferredResponseLanguage = 'en';
			var lang = 'en';
			if (user) {
				result = user.role;
				medicalLevel = user.medicalLevel;
				preferredResponseLanguage = user.lang;
				if(user.preferredResponseLanguage != null){
					preferredResponseLanguage = user.preferredResponseLanguage;
				}
				lang = user.lang;
			}
			res.status(200).send({ role: result, medicalLevel: medicalLevel, preferredResponseLanguage: preferredResponseLanguage, lang: lang })
		})
	}

	function setMedicalLevel(req, res) {
		let userId = crypt.decrypt(req.params.userId);
		var medicalLevel = req.body.medicalLevel;
		User.findByIdAndUpdate(userId, { medicalLevel: medicalLevel }, { new: true }, (err, userUpdated) => {
			if (userUpdated) {
				res.status(200).send({ message: 'Updated' })
			} else {
				console.log(err);
				res.status(200).send({ message: 'error' })
			}
		})
	}

	function saveSettings(req, res) {
		let userId = crypt.decrypt(req.params.userId);
		var lang = req.body.lang;
		var preferredResponseLanguage = req.body.preferredResponseLanguage;
		var role = req.body.role;
		var medicalLevel = req.body.medicalLevel;
		User.findByIdAndUpdate(userId, { lang: lang, preferredResponseLanguage: preferredResponseLanguage, role: role, medicalLevel: medicalLevel }, { new: true }, (err, userUpdated) => {
			if (userUpdated) {
				const accessToken = serviceAuth.createToken(userUpdated);
				const refreshToken = serviceAuth.createRefreshToken(userUpdated);
				
				// Establecer cookies de autenticación
				setAuthCookies(res, accessToken, refreshToken);
				
				res.status(200).send({
					message: 'You have successfully logged in',
					token: accessToken,
					lang: userUpdated.lang
				})
			} else {
				console.log(err);
				res.status(200).send({ message: 'error' })
			}
		})
	}

	// Endpoint para refrescar tokens usando refresh token
	function refreshToken(req, res) {
		const refreshTokenValue = req.cookies?.refresh_token;
		
		if (!refreshTokenValue) {
			return res.status(401).send({ message: 'No refresh token provided' });
		}
		
		serviceAuth.decodeRefreshToken(refreshTokenValue)
			.then(({ userId, user }) => {
				const accessToken = serviceAuth.createToken(user);
				const newRefreshToken = serviceAuth.createRefreshToken(user);
				
				// Establecer cookies de autenticación
				setAuthCookies(res, accessToken, newRefreshToken);
				
				res.status(200).send({
					message: 'Token refreshed successfully',
					token: accessToken // Mantener por compatibilidad
				});
			})
			.catch((error) => {
				insights.error(error);
				return res.status(error.status || 401).send({ message: error.message || 'Invalid refresh token' });
			});
	}

	// Endpoint para obtener información de la sesión actual
	function getSession(req, res) {
		// Solo leer de cookie - más seguro para datos médicos
		const token = req.cookies?.access_token;
		
		if (!token) {
			return res.status(401).send({ message: 'No token provided' });
		}
		
		const jwt = require('jwt-simple');
		const config = require('../../config');
		
		try {
			const payload = jwt.decode(token, config.SECRET_TOKEN);
			if (payload.type !== 'access') {
				return res.status(401).send({ message: 'Invalid token type' });
			}
			
			let userId = crypt.decrypt(payload.sub);
			// Incluir _id porque lo necesitamos para encriptarlo y devolverlo como userId
			User.findById(userId, { "password": false, "__v": false, "loginAttempts": false, "lastLogin": false }, (err, user) => {
				if (err) {
					insights.error(err);
					return res.status(500).send({ message: `Error making the request: ${err}` });
				}
				if (!user) {
					return res.status(404).send({ message: 'User not found' });
				}
				
				res.status(200).send({
					userId: crypt.encrypt(user._id.toString()),
					role: user.role,
					lang: user.lang,
					preferredResponseLanguage: user.preferredResponseLanguage || user.lang,
					medicalLevel: user.medicalLevel,
					userName: user.userName,
					lastName: user.lastName,
					email: user.email
				});
			});
		} catch (err) {
			insights.error({ message: 'Error verifying token', error: err });
			return res.status(401).send({ message: 'Invalid token' });
		}
	}

	// Endpoint para logout
	function logout(req, res) {
		// Limpiar cookies de autenticación
		clearAuthCookies(res);
		
		res.status(200).send({ message: 'Logged out successfully' });
	}

module.exports = {
	login,
	getUser,
	getUserLang,
	getUserPreferredLang,
	updatePreferredLang,
	getSettings,
	changeLang,
	getUserName,
	getUserEmail,
	setaccesstopatient,
	isVerified,
	setInfoVerified,
	setRoleMedicalLevel,
	setRole,
	getRoleMedicalLevel,
	setMedicalLevel,
	saveSettings,
	refreshToken,
	getSession,
	logout
}
