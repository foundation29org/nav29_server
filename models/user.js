// user schema
'use strict'

const mongoose = require('mongoose')
const Schema = mongoose.Schema

const { conndbaccounts } = require('../db_connect')

const MAX_LOGIN_ATTEMPTS = 5
const LOCK_TIME = 2 * 60 * 60 * 1000


const InfoVerifiedSchema = Schema({
	isVerified: {type: Boolean, default: false},
	status: { type: String, default: 'Not started' },
	url: { type: String, default: null },
	info: {type: Object, default: {}}
})

const UserSchema = Schema({
	email: {
		type: String,
		index: true,
		trim: true,
		lowercase: true,
		unique: true,
		required: 'Email address is required',
		match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please fill a valid email address']
	},
	firebaseUid: { type: String, index: true, sparse: true }, // UID de Firebase para autenticación
	role: { type: String, required: true, enum: ['User', 'Clinical', 'Caregiver', 'Unknown'], default: 'Unknown' },
	medicalLevel: { type: String, required: true, enum: ['0', '1', '2', '3'], default: '1' },
	signupDate: { type: Date, default: Date.now },
	lastLogin: { type: Date, default: null },
	userName: { type: String, default: '' },
	lastName: { type: String, default: '' },
	loginAttempts: { type: Number, required: true, default: 0 },
	lockUntil: { type: Number },
	lang: { type: String, required: true, default: 'en' },
	preferredResponseLanguage: { type: String, default: null },
	massunit: { type: String, required: true, default: 'kg' },
	lengthunit: { type: String, required: true, default: 'cm' },
	blockedaccount: { type: Boolean, default: false },
	countryselectedPhoneCode: { type: String, default: '' },
	phone: { type: String, default: '' },
	provider: { type: String, default: '' },
	emailVerified: { type: Boolean, default: false },
	picture: { type: String, default: '' },
	infoVerified:{
		type: InfoVerifiedSchema, default:{
			isVerified:false,
			info: {}
		}
	},
	// WhatsApp integration fields
	whatsappPhone: { type: String, sparse: true, unique: true, default: null },
	whatsappLinkedAt: { type: Date, default: null },
	whatsappVerificationCode: { type: String, default: null },
	whatsappVerificationExpires: { type: Date, default: null }
})



UserSchema.virtual('isLocked').get(function () {
	// check for a future lockUntil timestamp
	return !!(this.lockUntil && this.lockUntil > Date.now());
});

UserSchema.methods.incLoginAttempts = async function () {
	// if we have a previous lock that has expired, restart at 1
	if (this.lockUntil && this.lockUntil < Date.now()) {
		this.loginAttempts = 1;
		this.lockUntil = undefined;
		return this.save();
	}
	// otherwise we're incrementing
	this.loginAttempts += 1;
	// lock the account if we've reached max attempts and it's not locked already
	if (this.loginAttempts >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
		this.lockUntil = Date.now() + LOCK_TIME;
	}
	return this.save();
};

// expose enum on the model, and provide an internal convenience reference
var reasons = UserSchema.statics.failedLogin = {
	NOT_FOUND: 0,
	FIREBASE_UID_MISMATCH: 1, // Firebase UID no coincide con el registrado
	MAX_ATTEMPTS: 2,
	UNACTIVATED: 3,
	BLOCKED: 4,
};

/**
 * Autenticación por Firebase UID - Método principal recomendado
 * Busca usuario por email y verifica que el firebaseUid coincida
 */
UserSchema.statics.getAuthenticatedByFirebase = async function (email, firebaseUid, cb) {
	try {
		const user = await this.findOne({ email: email })
			.select('_id email loginAttempts lockUntil lastLogin role userName lang blockedaccount firebaseUid');
		
		// Verificar que el usuario existe
		if (!user) {
			return cb(null, null, reasons.NOT_FOUND);
		}
		
		// Verificar cuenta bloqueada
		if (user.blockedaccount) {
			return cb(null, null, reasons.BLOCKED);
		}
		
		// Verificar si la cuenta está bloqueada temporalmente
		if (user.isLocked) {
			await user.incLoginAttempts();
			return cb(null, null, reasons.MAX_ATTEMPTS);
		}
		
		// Verificar firebaseUid
		if (user.firebaseUid && user.firebaseUid === firebaseUid) {
			// Login exitoso - resetear intentos y actualizar último login
			user.loginAttempts = 0;
			user.lastLogin = Date.now();
			user.lockUntil = undefined;
			await user.save();
			return cb(null, user);
		} else if (!user.firebaseUid) {
			// Usuario existe pero no tiene firebaseUid (migración pendiente)
			// Actualizar con el firebaseUid y hacer login
			user.firebaseUid = firebaseUid;
			user.loginAttempts = 0;
			user.lastLogin = Date.now();
			user.lockUntil = undefined;
			await user.save();
			return cb(null, user);
		} else {
			// firebaseUid no coincide - incrementar intentos fallidos
			await user.incLoginAttempts();
			return cb(null, null, reasons.FIREBASE_UID_MISMATCH);
		}
	} catch (err) {
		return cb(err);
	}
};

module.exports = conndbaccounts.model('User', UserSchema)
// we need to export the model so that it is accessible in the rest of the app
