// eventsdb schema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema
const Patient = require('./patient')

const { conndbdata } = require('../db_connect')

const EventsSchema = Schema({
	name: {type: String, default: ''},
	date: {type: Date, default: null},
	dateInput: {type: Date, default: Date.now},
	notes: {type: String, default: ''},
	key: {type: String, default: null},
	origin: {type: String, default: 'manual'},
	status: {type: String, default: 'false'},
	docId: {type: Schema.Types.ObjectId, ref: 'Document'},
	createdBy: { type: Schema.Types.ObjectId, ref: "Patient"},
	addedBy: { type: Schema.Types.ObjectId, ref: "User"}
})

module.exports = conndbdata.model('Events',EventsSchema)
// we need to export the model so that it is accessible in the rest of the app
