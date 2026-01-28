/**
 * Tracking Controller
 * Handles patient tracking data endpoints
 */

'use strict';

const Tracking = require('../../../models/tracking');
const trackingService = require('../../../services/trackingService');
const insights = require('../../../services/insights');
const crypt = require('../../../services/crypt');

/**
 * Get all tracking data for a patient (all conditions)
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
    
    const conditionType = req.query.conditionType;
    
    try {
        let allTracking;
        
        if (conditionType) {
            // Get specific condition
            allTracking = await Tracking.find({ patientId, conditionType }).lean();
        } else {
            // Get all conditions for patient (no sort - Cosmos DB doesn't support it without index)
            allTracking = await Tracking.find({ patientId }).lean();
        }
        
        if (!allTracking || allTracking.length === 0) {
            return res.status(200).json({
                success: true,
                data: null,
                allConditions: []
            });
        }
        
        // Sort in memory by updatedAt (descending)
        allTracking.sort((a, b) => {
            const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return dateB - dateA;
        });
        
        // Return the most recently updated condition as primary, plus list of all
        return res.status(200).json({
            success: true,
            data: allTracking[0],
            allConditions: allTracking.map(t => ({
                conditionType: t.conditionType,
                entriesCount: t.entries ? t.entries.length : 0,
                lastUpdated: t.updatedAt
            }))
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
 * Import tracking data from JSON file
 * POST /api/tracking/:patientId/import
 */
async function importTrackingData(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    const { rawData, detectedType, userId } = req.body;
    
    if (!rawData) {
        return res.status(400).json({
            success: false,
            message: 'No data provided'
        });
    }
    
    try {
        const tracking = await trackingService.importTrackingData(patientId, rawData, detectedType);
        
        console.log('Tracking data imported:', { 
            patientId, 
            userId,
            entriesCount: tracking.entries.length,
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
 * Add a manual entry to tracking
 * POST /api/tracking/:patientId/entry
 */
async function addEntry(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    const { entry, userId } = req.body;
    
    if (!entry || !entry.date) {
        return res.status(400).json({
            success: false,
            message: 'Entry date is required'
        });
    }
    
    try {
        const tracking = await trackingService.addManualEntry(patientId, entry);
        
        console.log('Manual tracking entry added:', { 
            patientId, 
            userId,
            conditionType: tracking.conditionType
        });
        
        return res.status(200).json({
            success: true,
            data: tracking,
            message: 'Entry saved successfully'
        });
    } catch (error) {
        console.error('Error adding tracking entry:', error);
        insights.error({ message: 'Error adding tracking entry', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error saving entry'
        });
    }
}

/**
 * Generate AI insights for tracking data
 * POST /api/tracking/:patientId/insights
 */
async function generateInsights(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    const { lang, userId } = req.body;
    
    try {
        const tracking = await Tracking.findOne({ patientId });
        
        if (!tracking || tracking.entries.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No tracking data available'
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
        
        console.log('Tracking insights generated:', { 
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
        console.error('Error generating tracking insights:', error);
        insights.error({ message: 'Error generating tracking insights', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error generating insights'
        });
    }
}

/**
 * Get tracking statistics
 * GET /api/tracking/:patientId/stats
 */
async function getStatistics(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    
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
        console.error('Error getting tracking statistics:', error);
        insights.error({ message: 'Error getting tracking statistics', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error retrieving statistics'
        });
    }
}

/**
 * Delete tracking data for a patient
 * DELETE /api/tracking/:patientId
 * Query params: conditionType (optional) - if provided, deletes only that condition
 */
async function deleteTrackingData(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    const { conditionType } = req.query;
    
    try {
        if (conditionType) {
            // Delete specific condition
            await trackingService.deleteTrackingByCondition(patientId, conditionType);
            console.log('Tracking condition deleted:', { patientId, conditionType });
        } else {
            // Delete all conditions for patient
            await Tracking.deleteMany({ patientId });
            console.log('All tracking data deleted:', { patientId });
        }
        
        return res.status(200).json({
            success: true,
            message: 'Tracking data deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting tracking data:', error);
        insights.error({ message: 'Error deleting tracking data', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: 'Error deleting tracking data'
        });
    }
}

/**
 * Delete entries in a date range
 * DELETE /api/tracking/:patientId/entries-range
 */
async function deleteEntriesInRange(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    const { conditionType, startDate, endDate } = req.body;
    
    if (!conditionType || !startDate || !endDate) {
        return res.status(400).json({
            success: false,
            message: 'conditionType, startDate and endDate are required'
        });
    }
    
    try {
        const tracking = await trackingService.deleteEntriesInRange(
            patientId, 
            conditionType, 
            new Date(startDate), 
            new Date(endDate)
        );
        
        console.log('Entries deleted in range:', { patientId, conditionType, startDate, endDate });
        
        return res.status(200).json({
            success: true,
            data: tracking,
            message: 'Entries deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting entries in range:', error);
        insights.error({ message: 'Error deleting entries in range', error: error.message, patientId });
        return res.status(500).json({
            success: false,
            message: error.message || 'Error deleting entries'
        });
    }
}

/**
 * Delete a specific entry from tracking
 * DELETE /api/tracking/:patientId/entry/:entryId
 */
async function deleteEntry(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    const { entryId } = req.params;
    
    try {
        const tracking = await Tracking.findOne({ patientId });
        
        if (!tracking) {
            return res.status(404).json({
                success: false,
                message: 'Tracking data not found'
            });
        }
        
        tracking.entries = tracking.entries.filter(e => e._id.toString() !== entryId);
        await tracking.save();
        
        return res.status(200).json({
            success: true,
            data: tracking,
            message: 'Entry deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting tracking entry:', error);
        insights.error({ message: 'Error deleting tracking entry', error: error.message, patientId, entryId });
        return res.status(500).json({
            success: false,
            message: 'Error deleting entry'
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
