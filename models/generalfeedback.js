// Support schema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema

const { conndbaccounts } = require('../db_connect')

const GeneralfeedbackSchema = Schema({
	value: {type: Object, default: {}},
	type: String,
	lang: {type: String, default: 'en'},
	documents: {type: Object, default: []},
	date: {type: Date, default: Date.now},
	version: {type: String, default: null},
	createdBy: { type: Schema.Types.ObjectId, ref: "Patient"}
})

module.exports = conndbaccounts.model('Generalfeedback',GeneralfeedbackSchema)
// we need to export the model so that it is accessible in the rest of the app
