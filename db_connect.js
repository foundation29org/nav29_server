'use strict'

const mongoose = require('mongoose')
const config = require('./config')

// Mongoose 9.x - opciones modernas de conexión
const connectionOptions = {
	maxPoolSize: 10,
	serverSelectionTimeoutMS: 30000, // 30s para Cosmos DB (puede tardar en despertar)
	socketTimeoutMS: 45000,
}

const conndbaccounts = mongoose.createConnection(config.dbaccounts, connectionOptions)
const conndbdata = mongoose.createConnection(config.dbdata, connectionOptions)

// Manejo de eventos de conexión
conndbaccounts.on('connected', () => console.log('MongoDB accounts connected'))
conndbaccounts.on('error', (err) => console.error('MongoDB accounts error:', err))

conndbdata.on('connected', () => console.log('MongoDB data connected'))
conndbdata.on('error', (err) => console.error('MongoDB data error:', err))

module.exports = {
	conndbaccounts,
	conndbdata
}
