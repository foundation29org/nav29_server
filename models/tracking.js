// Epilepsy Tracking Schema - Seizure tracking data (SeizureTracker integration)
'use strict'

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const { conndbdata } = require('../db_connect');

// Schema for individual seizure entries
const SeizureEntrySchema = Schema({
    date: { type: Date, required: true },
    type: { type: String, default: '' },  // Tonic Clonic, Absence, Focal, etc.
    duration: { type: Number, default: null }, // in seconds
    severity: { type: Number, min: 1, max: 10, default: null },
    triggers: [{ type: String }],
    notes: { type: String, default: '' },
    // SeizureTracker specific fields
    timeHour: { type: Number, default: null },
    timeMin: { type: Number, default: null },
    timeAppm: { type: String, default: '' },
    aura: { type: Boolean, default: false },
    awareness: { type: String, default: '' },
    postictal: { type: Schema.Types.Mixed, default: {} }
}, { _id: true });

// Schema for anti-epileptic medications
const MedicationSchema = Schema({
    name: { type: String, required: true },
    dose: { type: String, default: '' },
    doseValue: { type: Number, default: null },
    doseUnit: { type: String, default: 'mg' },
    frequency: { type: String, default: '' },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    sideEffects: [{ type: String }],
    notes: { type: String, default: '' }
}, { _id: true });

// Main epilepsy tracking schema
const EpilepsyTrackingSchema = Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    conditionType: { 
        type: String, 
        default: 'epilepsy',
        immutable: true  // Always epilepsy
    },
    entries: [SeizureEntrySchema],
    medications: [MedicationSchema],
    metadata: {
        source: { 
            type: String, 
            enum: ['seizuretracker', 'manual'],
            default: 'manual'
        },
        importDate: { type: Date, default: Date.now },
        originalFile: { type: String, default: '' },
        patientName: { type: String, default: '' },
        downloadVersion: { type: String, default: '' }
    },
    // Cached insights from AI analysis
    insights: [{
        icon: { type: String, default: 'fa-lightbulb-o' },
        title: { type: String },
        description: { type: String },
        generatedAt: { type: Date, default: Date.now }
    }],
    insightsGeneratedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Note: Indexes are managed by Cosmos DB, not Mongoose

// Update timestamp on save
EpilepsyTrackingSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

module.exports = conndbdata.model('Tracking', EpilepsyTrackingSchema);
