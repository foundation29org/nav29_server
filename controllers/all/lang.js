// functions for each call of the api on Lang. Use the Lang model

'use strict'

// add the lang model
const Lang = require('../../models/lang')

/**
 * @api {get} https://raitogpt2.azurewebsites.net/api/langs/ Get languages
 * @apiName getLangs
 * @apiDescription This method return the languages available in raito. you get a list of languages, and for each one you have the name and the code.
 * We currently have 5 languages, but we will include more. The current languages are:
 * * English: en
 * * Spanish: es
 * * German: de
 * * Dutch: nl
 * * Portuguese: pt
 * @apiGroup Languages
 * @apiVersion 1.0.0
 * @apiExample {js} Example usage:
 *   this.http.get('https://raitogpt2.azurewebsites.net/api/langs)
 *    .subscribe( (res : any) => {
 *      console.log('languages: '+ res.listLangs);
 *     }, (err) => {
 *      ...
 *     }
 *
 * @apiSuccessExample Success-Response:
 * HTTP/1.1 200 OK
 * [
 *   {
 *     "name": "English",
 *     "code": "en"
 *   },
 *   {
 *     "name": "Español,Castellano",
 *     "code": "es"
 *   },
 *   {
 *     "name": "Deutsch",
 *     "code": "de"
 *   },
 *   {
 *     "name": "Nederlands,Vlaams",
 *     "code": "nl"
 *   },
 *   {
 *     "name": "Português",
 *     "code": "pt"
 *   }
 * ]
 */
async function getLangs (req, res){
	// Verificar que la conexión a MongoDB esté lista
	const { conndbaccounts } = require('../../db_connect');
	const dbState = conndbaccounts.readyState;
	
	// Estados: 0 = desconectado, 1 = conectado, 2 = conectando, 3 = desconectando
	if (dbState !== 1) {
		// Retornar lista por defecto si MongoDB no está listo
		const defaultLangs = [
			{name: 'English', code: 'en'},
			{name: 'Español,Castellano', code: 'es'},
			{name: 'Deutsch', code: 'de'},
			{name: 'Português', code: 'pt'},
			{name: 'Français', code: 'fr'},
			{name: 'Italiano', code: 'it'}
		];
		return res.status(200).send(defaultLangs);
	}
	
	try {
		const langs = await Lang.find({});
		var listLangs = [];

		if(langs !== undefined){
			langs.forEach(function(lang) {
				if(lang.code !== 'nl'){
					listLangs.push({name: lang.name, code: lang.code});
				}
			});
		}
		
		res.status(200).send(listLangs)
	} catch (err) {
		console.error('Error al obtener lenguajes:', err);
		return res.status(500).json({ error: 'Error al obtener lenguajes', message: err.message });
	}
}

module.exports = {
	getLangs
}
