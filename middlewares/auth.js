'use strict'

const serviceAuth = require('../services/auth')
const insights = require('../services/insights')

// Extraer token de cookie o header Authorization (fallback para SWA proxy)
function extractToken(req) {
	if (req.cookies && req.cookies.access_token) {
		return req.cookies.access_token;
	}
	const authHeader = req.headers.authorization;
	if (authHeader && authHeader.startsWith('Bearer ')) {
		return authHeader.substring(7);
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
