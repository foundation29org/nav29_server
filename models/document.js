// eventsdb schema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema
const Patient = require('./patient')

const { conndbdata } = require('../db_connect')

const DocumentSchema = Schema({
	url: {type: String, default: ''},
	status: {type: String, default: ''},
	date: {type: Date, default: Date.now},
	originaldate: Date,
	cured: {type: Boolean, default: false},
	anonymized: {type: String, default: 'false'},
	categoryTag: {type: String, default: ''},
	langsmithRunId: {type: String, default: ''},
	createdBy: { type: Schema.Types.ObjectId, ref: "Patient"},
	addedBy: { type: Schema.Types.ObjectId, ref: "User"}
})

module.exports = conndbdata.model('Document',DocumentSchema)
// we need to export the model so that it is accessible in the rest of the app
