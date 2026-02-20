// Rarescope schema
'use strict'

const mongoose = require('mongoose')
const Schema = mongoose.Schema

const { conndbdata } = require('../db_connect')

const RarescopeSchema = Schema({
  patientId: { 
    type: String, 
    required: true,
    index: true 
  },
  mainNeed: { 
    type: String, 
    default: '' 
  },
  additionalNeeds: [{ 
    type: String 
  }],
  role: { type: String, default: null }, // 'Clinical' | paciente, etc.; con qué perspectiva se generó/guardó
  updatedAt: { 
    type: Date, 
    default: Date.now 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
})

// Índice para cargar por (patientId, role) — puede haber uno para Clinical y otro para paciente
RarescopeSchema.index({ patientId: 1, role: 1 })
RarescopeSchema.index({ patientId: 1, updatedAt: -1 })

module.exports = conndbdata.model('Rarescope', RarescopeSchema)
