// appointmentsdb schema
'use strict'

const mongoose = require ('mongoose');
const Schema = mongoose.Schema
const Patient = require('./patient')

const { conndbdata } = require('../db_connect')

const AppointmentsSchema = Schema({
	date: {type: Date, default: null},
	dateInput: {type: Date, default: Date.now},
	notes: {type: String, default: ''},
	createdBy: { type: Schema.Types.ObjectId, ref: "Patient"},
	addedBy: { type: Schema.Types.ObjectId, ref: "User"}
})

module.exports = conndbdata.model('Appointments',AppointmentsSchema)
// we need to export the model so that it is accessible in the rest of the app
