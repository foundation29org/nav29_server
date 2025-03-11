// Patient schema
'use strict'

const mongoose = require ('mongoose')
const Schema = mongoose.Schema
const User = require('./user')

const { conndbaccounts } = require('../db_connect')

const locationSchema = Schema({
	platform: {type: String, default: ''},
	userAgent: {type: String, default: ''},
	city: {type: String, default: ''},
	country: {type: String, default: ''},
	latitude: {type: Number, default: 0},
	longitude: {type: Number, default: 0},
	postal_code: {type: String, default: ''},
	idToken: {type: String, default: ''},
	userId: {type: String, default: ''},
	status: {type: String, default: ''},
	email: {type: String, default: ''},
	date: {type: Date, default: Date.now},
	lastAccess: {type: Date, default: Date.now},
	lastUpdated: {type: Date, default: null}
})


const generalShareSchema = Schema({
	data:{},
	notes: {type: String, default: ''},
	date: {type: Date, default: Date.now},
	token: {type: String, default: ''},
	locations: [locationSchema],
	lastAccess: {type: Date, default: Date.now},
})

const individualShareSchema = Schema({
	data:{},
	notes: {type: String, default: ''},
	date: {type: Date, default: Date.now},
	token: {type: String, default: ''},
	idUser: {type: String, default: null},
	status: {type: String, default: 'Pending'},
	verified: {type: String, default: ''}
})

const PatientSchema = Schema({
	patientName: {type: String, default: ''},
	surname: {type: String, default: ''},
	birthDate: {type: Date, default: null},
	citybirth: String,
	provincebirth: String,
	countrybirth: String,
	street: {type: String, default: null},
	postalCode: {type: String, default: null},
	city: {type: String, default: null},
	province: {type: String, default: null},
	country: {type: String, default: null},
	phone: String,
	gender: {type: String, default: null},
	createdBy: { type: Schema.Types.ObjectId, ref: "User"},
	death: Date,
	lastAccess: {type: Date, default: Date.now},
	lastUpdated: {type: Date, default: null},
	creationDate: {type: Date, default: Date.now},
	donation: {type: Boolean, default: false},
	summary: {type: String, default: 'false'},
	summaryDate: {type: Date, default: null},
	generalShare:{
		type: generalShareSchema, default:{
			data:{},
			notes: '',
			date: null,
			token: ''
		}
	},
	customShare: [generalShareSchema],
	individualShare: [individualShareSchema],
})

module.exports = conndbaccounts.model('Patient',PatientSchema)
// we need to export the model so that it is accessible in the rest of the app
