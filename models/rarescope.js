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
  updatedAt: { 
    type: Date, 
    default: Date.now 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
})

// Índice compuesto para búsquedas eficientes
RarescopeSchema.index({ patientId: 1, updatedAt: -1 })

module.exports = conndbdata.model('Rarescope', RarescopeSchema)
