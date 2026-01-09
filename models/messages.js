// eventsdb schema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema
const Patient = require('./patient')

const { conndbdata } = require('../db_connect')

const MessagesSchema = Schema({
	date: {type: Date, default: Date.now},
	messages: {type: Object, default: []},
	lastSuggestions: {type: [String], default: []},
	createdBy: { type: Schema.Types.ObjectId, ref: "Patient"},
	userId: {type: String}
})

module.exports = conndbdata.model('Messages',MessagesSchema)
// we need to export the model so that it is accessible in the rest of the app
