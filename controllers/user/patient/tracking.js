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
 * Get tracking data for a patient
 * GET /api/tracking/:patientId/data
 */
async function getTrackingData(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    
    try {
        const tracking = await trackingService.getOrCreateTracking(patientId);
        
        return res.status(200).json({
            success: true,
            data: tracking
        });
    } catch (error) {
        console.error('Error getting tracking data:', error);
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
 */
async function deleteTrackingData(req, res) {
    const patientId = crypt.decrypt(req.params.patientId);
    
    try {
        await Tracking.deleteOne({ patientId });
        
        console.log('Tracking data deleted:', { patientId });
        
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
    deleteEntry
};
