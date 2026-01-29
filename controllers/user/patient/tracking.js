/**
 * Epilepsy Tracking Controller
 * Handles seizure tracking data endpoints (SeizureTracker integration)
 */

'use strict';

const Tracking = require('../../../models/tracking');
const trackingService = require('../../../services/trackingService');
const insights = require('../../../services/insights');
const crypt = require('../../../services/crypt');

/**
 * Get epilepsy tracking data for a patient
 * GET /api/tracking/:patientId/data
 */
async function getTrackingData(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    try {
        const tracking = await Tracking.findOne({ patientId }).lean();
        
        if (!tracking) {
            return res.status(200).json({
                success: true,
                data: null
            });
        }
        
        return res.status(200).json({
            success: true,
            data: tracking
        });
    } catch (error) {
        console.error('Error getting tracking data:', error.message);
        insights.error({ message: 'Error getting tracking data', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error retrieving tracking data'
        });
    }
}

/**
 * Import seizure data from SeizureTracker JSON file
 * POST /api/tracking/:patientId/import
 */
async function importTrackingData(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    const { rawData, detectedType, userId } = req.body;
    
    if (!rawData) {
        return res.status(400).json({
            success: false,
            message: 'No data provided'
        });
    }
    
    try {
        const tracking = await trackingService.importTrackingData(patientId, rawData, detectedType);
        
        console.log('Seizure data imported:', { 
            patientId, 
            userId,
            seizuresCount: tracking.entries.length,
            medicationsCount: tracking.medications.length,
            source: tracking.metadata.source
        });
        
        return res.status(200).json({
            success: true,
            data: tracking,
            message: 'Data imported successfully'
        });
    } catch (error) {
        console.error('Error importing tracking data:', error);
        insights.error({ message: 'Error importing tracking data', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: error.message || 'Error importing data'
        });
    }
}

/**
 * Add a manual seizure entry
 * POST /api/tracking/:patientId/entry
 */
async function addEntry(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    const { entry, userId } = req.body;
    
    if (!entry || !entry.date) {
        return res.status(400).json({
            success: false,
            message: 'Seizure date is required'
        });
    }
    
    try {
        const tracking = await trackingService.addManualEntry(patientId, entry);
        
        console.log('Manual seizure entry added:', { 
            patientId, 
            userId,
            seizureType: entry.type
        });
        
        return res.status(200).json({
            success: true,
            data: tracking,
            message: 'Seizure saved successfully'
        });
    } catch (error) {
        console.error('Error adding seizure entry:', error);
        insights.error({ message: 'Error adding seizure entry', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error saving seizure'
        });
    }
}

/**
 * Generate AI insights for seizure data
 * POST /api/tracking/:patientId/insights
 */
async function generateInsights(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    const { lang, userId } = req.body;
    
    try {
        const tracking = await Tracking.findOne({ patientId });
        
        if (!tracking || tracking.entries.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No seizure data available'
            });
        }
        
        // Check if we have recent insights (less than 1 hour old)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (tracking.insightsGeneratedAt && tracking.insightsGeneratedAt > oneHourAgo && tracking.insights.length > 0) {
            return res.status(200).json({
                success: true,
                insights: tracking.insights,
                cached: true
            });
        }
        
        // Generate new insights
        const generatedInsights = await trackingService.generateInsights(tracking, lang || 'en');
        
        // Save insights to database
        tracking.insights = generatedInsights;
        tracking.insightsGeneratedAt = new Date();
        await tracking.save();
        
        console.log('Seizure insights generated:', { 
            patientId, 
            userId,
            insightsCount: generatedInsights.length
        });
        
        return res.status(200).json({
            success: true,
            insights: generatedInsights,
            cached: false
        });
    } catch (error) {
        console.error('Error generating seizure insights:', error);
        insights.error({ message: 'Error generating seizure insights', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error generating insights'
        });
    }
}

/**
 * Get seizure statistics
 * GET /api/tracking/:patientId/stats
 */
async function getStatistics(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    try {
        const tracking = await Tracking.findOne({ patientId });
        
        if (!tracking) {
            return res.status(200).json({
                success: true,
                stats: trackingService.calculateStatistics([])
            });
        }
        
        const stats = trackingService.calculateStatistics(tracking.entries);
        
        return res.status(200).json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Error getting seizure statistics:', error);
        insights.error({ message: 'Error getting seizure statistics', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error retrieving statistics'
        });
    }
}

/**
 * Delete all seizure tracking data for a patient
 * DELETE /api/tracking/:patientId
 */
async function deleteTrackingData(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    try {
        await Tracking.deleteOne({ patientId });
        console.log('Seizure tracking data deleted:', { patientId });
        
        return res.status(200).json({
            success: true,
            message: 'Seizure data deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting seizure data:', error);
        insights.error({ message: 'Error deleting seizure data', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error deleting seizure data'
        });
    }
}

/**
 * Delete seizures in a date range
 * POST /api/tracking/:patientId/delete-range
 */
async function deleteEntriesInRange(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    const { startDate, endDate } = req.body;
    
    if (!startDate || !endDate) {
        return res.status(400).json({
            success: false,
            message: 'startDate and endDate are required'
        });
    }
    
    try {
        const tracking = await Tracking.findOne({ patientId });
        
        if (!tracking) {
            return res.status(404).json({
                success: false,
                message: 'No seizure data found'
            });
        }
        
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        const originalCount = tracking.entries.length;
        tracking.entries = tracking.entries.filter(e => {
            const entryDate = new Date(e.date);
            return entryDate < start || entryDate > end;
        });
        const deletedCount = originalCount - tracking.entries.length;
        
        tracking.updatedAt = new Date();
        await tracking.save();
        
        console.log('Seizures deleted in range:', { patientId, startDate, endDate, deletedCount });
        
        return res.status(200).json({
            success: true,
            data: tracking,
            deletedCount,
            message: `${deletedCount} seizures deleted successfully`
        });
    } catch (error) {
        console.error('Error deleting seizures in range:', error);
        insights.error({ message: 'Error deleting seizures in range', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error deleting seizures'
        });
    }
}

/**
 * Delete a specific seizure entry
 * DELETE /api/tracking/:patientId/entry/:entryId
 */
async function deleteEntry(req, res) {
    let patientId;
    try {
        patientId = crypt.decrypt(req.params.patientId);
    } catch (decryptError) {
        console.error('Error decrypting patientId:', decryptError);
        return res.status(400).json({
            success: false,
            message: 'Invalid patient ID'
        });
    }
    
    const { entryId } = req.params;
    
    try {
        const tracking = await Tracking.findOne({ patientId });
        
        if (!tracking) {
            return res.status(404).json({
                success: false,
                message: 'No seizure data found'
            });
        }
        
        const originalLength = tracking.entries.length;
        tracking.entries = tracking.entries.filter(e => e._id.toString() !== entryId);
        
        if (tracking.entries.length === originalLength) {
            return res.status(404).json({
                success: false,
                message: 'Seizure entry not found'
            });
        }
        
        await tracking.save();
        
        return res.status(200).json({
            success: true,
            data: tracking,
            message: 'Seizure deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting seizure entry:', error);
        insights.error({ message: 'Error deleting seizure entry', error: error.message, patientId, entryId });
        return res.status(500).json({
            success: false,
            message: 'Error deleting seizure'
        });
    }
}

module.exports = {
    getTrackingData,
    importTrackingData,
    addEntry,
    generateInsights,
    getStatistics,
    deleteTrackingData,
    deleteEntry,
    deleteEntriesInRange
};
