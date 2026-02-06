'use strict'

const serviceAuth = require('../services/auth')
const insights = require('../services/insights')

// Función helper para extraer token SOLO de cookie (más seguro)
// Las cookies HttpOnly no son accesibles desde JavaScript, protegiendo contra XSS
function extractToken(req) {
	// Solo leer de cookie - más seguro para datos médicos
	if (req.cookies && req.cookies.access_token) {
		return req.cookies.access_token;
	}
	return null;
}

function isAuth (roles){

	return function(req, res, next) {
		const token = extractToken(req);

		if (!token){
			return res.status(403).send({ message: 'It does not have authorization'})
		}

		serviceAuth.decodeToken(token, roles)
			.then(response => {
				req.user = response
				next()
			})
			.catch(response => {
				// Rastrear errores inesperados (no 401/403 que son esperados)
				if (response.status !== 401 && response.status !== 403) {
					insights.error({ message: 'Unexpected auth error in isAuth', error: response });
				}
				//res.status(response.status)
				return res.status(response.status).send({message: response.message})
			})
  }


}

function isAuthOwnerPatient (roles){

	return function(req, res, next) {
		const token = extractToken(req);

		if (!token){
			return res.status(403).send({ message: 'It does not have authorization'})
		}

		serviceAuth.decodeTokenOwnerPatient(token, roles, req.params.patientId)
			.then(response => {
				req.user = response
				next()
			})
			.catch(response => {
				// Rastrear errores inesperados (no 401/403 que son esperados)
				if (response.status !== 401 && response.status !== 403) {
					insights.error({ message: 'Unexpected auth error in isAuth', error: response });
				}
				//res.status(response.status)
				return res.status(response.status).send({message: response.message})
			})
  }


}

function isAuthPatient (roles){

	return function(req, res, next) {
		const token = extractToken(req);

		if (!token){
			return res.status(403).send({ message: 'It does not have authorization'})
		}

		serviceAuth.decodeTokenPatient(token, roles, req.params.patientId)
			.then(response => {
				req.user = response
				next()
			})
			.catch(response => {
				// Rastrear errores inesperados (no 401/403 que son esperados)
				if (response.status !== 401 && response.status !== 403) {
					insights.error({ message: 'Unexpected auth error in isAuth', error: response });
				}
				//res.status(response.status)
				return res.status(response.status).send({message: response.message})
			})
  }


}

module.exports = {
	isAuth,
	isAuthPatient,
	isAuthOwnerPatient
}
