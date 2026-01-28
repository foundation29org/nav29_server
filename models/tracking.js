// tracking schema - Patient condition tracking data
'use strict'

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const { conndbdata } = require('../db_connect');

// Schema for individual tracking entries (seizures, glucose readings, etc.)
const TrackingEntrySchema = Schema({
    date: { type: Date, required: true },
    type: { type: String, default: '' },
    duration: { type: Number, default: null }, // in seconds
    severity: { type: Number, min: 1, max: 10, default: null },
    value: { type: Number, default: null }, // for measurements like glucose
    triggers: [{ type: String }],
    notes: { type: String, default: '' },
    customFields: { type: Schema.Types.Mixed, default: {} },
    // SeizureTracker specific fields
    timeHour: { type: Number, default: null },
    timeMin: { type: Number, default: null },
    timeAppm: { type: String, default: '' },
    aura: { type: Boolean, default: false },
    awareness: { type: String, default: '' },
    postictal: { type: Schema.Types.Mixed, default: {} }
}, { _id: true });

// Schema for medications associated with tracking
const TrackingMedicationSchema = Schema({
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

// Main tracking data schema
const TrackingSchema = Schema({
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    conditionType: { 
        type: String, 
        enum: ['epilepsy', 'diabetes', 'migraine', 'custom'],
        default: 'epilepsy'
    },
    entries: [TrackingEntrySchema],
    medications: [TrackingMedicationSchema],
    metadata: {
        source: { 
            type: String, 
            enum: ['seizuretracker', 'manual', 'diabetes_app', 'migraine_app', 'other'],
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
// Cosmos DB automatically indexes all properties by default

// Update timestamp on save
TrackingSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

module.exports = conndbdata.model('Tracking', TrackingSchema);
