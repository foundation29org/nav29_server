/**
 * Tracking Service
 * Handles patient tracking data: import, parsing, analysis, and insights generation
 */

'use strict';

const Tracking = require('../models/tracking');
const { createModels } = require('./langchain');

/**
 * Parse SeizureTracker JSON format and normalize to our schema
 * @param {Object} rawData - Raw JSON from SeizureTracker
 * @returns {Object} Normalized tracking data
 */
function parseSeizureTrackerData(rawData) {
    const result = {
        conditionType: 'epilepsy',
        entries: [],
        medications: [],
        metadata: {
            source: 'seizuretracker',
            importDate: new Date(),
            originalFile: '',
            patientName: '',
            downloadVersion: ''
        }
    };

    // Parse Info section
    if (rawData.Info && rawData.Info[0]) {
        const info = rawData.Info[0];
        result.metadata.patientName = `${info['First Name'] || ''} ${info['Last Name'] || ''}`.trim();
        result.metadata.downloadVersion = info['Download version'] || '';
        if (info['Download date']) {
            result.metadata.importDate = new Date(info['Download date']);
        }
    }

    // Parse Seizures
    if (rawData.Seizures && Array.isArray(rawData.Seizures)) {
        result.entries = rawData.Seizures.map(seizure => {
            const entry = {
                date: seizure.Date_Time ? new Date(seizure.Date_Time) : new Date(),
                type: seizure.type || 'Unknown',
                duration: calculateDurationSeconds(seizure),
                triggers: extractTriggers(seizure),
                notes: seizure.descriptnotes || seizure.triggernotes || '',
                timeHour: parseInt(seizure.time_hour) || null,
                timeMin: parseInt(seizure.time_min) || null,
                timeAppm: seizure.time_appm || '',
                aura: !!seizure.descriptaura,
                awareness: seizure.descriptawareness || '',
                postictal: {
                    lossComm: seizure.postlosscommuni,
                    eventRecollection: seizure.posteventrecalection,
                    muscleWeakness: seizure.postmusweakness,
                    sleepy: seizure.postsleepy
                },
                customFields: {
                    vnsActive: seizure.VNSProfileDate_Active,
                    flagged: seizure.flagged,
                    location: seizure.EventLocationLAT && seizure.EventLocationLNG 
                        ? { lat: seizure.EventLocationLAT, lng: seizure.EventLocationLNG }
                        : null
                }
            };
            return entry;
        }).filter(e => e.date && !isNaN(e.date.getTime()));
    }

    // Parse Medications - SeizureTracker uses fields with spaces
    if (rawData.Medications && Array.isArray(rawData.Medications)) {
        result.medications = rawData.Medications.map(med => ({
            name: med.Medication || med.name || med.Name || '',
            dose: med['Total Daily Dose'] || med.dose || med.Dose || '',
            doseValue: parseFloat(med['Total Daily Dose']) || parseFloat(med.doseValue) || null,
            doseUnit: med.Units || med.doseUnit || 'mg',
            frequency: med['Number of Doses per day'] || med.frequency || '',
            startDate: med['Start Date'] ? new Date(med['Start Date']) : (med.startDate ? new Date(med.startDate) : null),
            endDate: med['End Date'] ? new Date(med['End Date']) : (med.endDate ? new Date(med.endDate) : null),
            sideEffects: med['Side Effects'] ? med['Side Effects'].split(',').map(s => s.trim()).filter(s => s && s !== 'Not Visited') : (med.sideEffects || []),
            notes: med.Notes || med.notes || ''
        })).filter(m => m.name);
    }

    // Sort entries by date (newest first)
    result.entries.sort((a, b) => b.date - a.date);

    return result;
}

/**
 * Calculate duration in seconds from SeizureTracker format
 */
function calculateDurationSeconds(seizure) {
    const hours = parseInt(seizure.length_hr) || 0;
    const minutes = parseInt(seizure.length_min) || 0;
    const seconds = parseInt(seizure.length_sec) || 0;
    return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Extract triggers from SeizureTracker seizure object
 */
function extractTriggers(seizure) {
    const triggers = [];
    const triggerMappings = {
        'triggerstress': 'Stress',
        'triggertired': 'Sleep deprivation',
        'triggerchangeinmed': 'Medication change',
        'triggerAlcDruguse': 'Alcohol/Drug use',
        'triggerlight': 'Light sensitivity',
        'triggerdiet': 'Diet',
        'triggeroverheated': 'Overheated',
        'triggerhormonal': 'Hormonal',
        'triggersick': 'Illness'
    };

    for (const [key, label] of Object.entries(triggerMappings)) {
        if (seizure[key] && seizure[key] !== '' && seizure[key] !== 'false') {
            triggers.push(label);
        }
    }

    if (seizure.triggerother && seizure.triggerothervalue) {
        triggers.push(seizure.triggerothervalue);
    }

    return triggers;
}

/**
 * Parse and validate seizure tracking data
 * @param {Object} rawData - Raw JSON data
 * @param {string} detectedType - Type detected by frontend
 * @returns {Object} Normalized tracking data
 */
function parseTrackingData(rawData, detectedType) {
    // SeizureTracker format detection (primary supported format)
    if (rawData.Seizures && Array.isArray(rawData.Seizures)) {
        return parseSeizureTrackerData(rawData);
    }

    // Unsupported format - only SeizureTracker is supported
    throw new Error('Formato no soportado. Por favor usa un archivo exportado desde SeizureTracker.');
}

/**
 * Calculate statistics from tracking entries
 * @param {Array} entries - Array of tracking entries
 * @returns {Object} Calculated statistics
 */
function calculateStatistics(entries) {
    if (!entries || entries.length === 0) {
        return {
            totalEvents: 0,
            daysSinceLast: 0,
            monthlyAvg: 0,
            trend: null,
            trendPercent: 0,
            mostCommonType: null,
            mostCommonHour: null
        };
    }

    const sortedEntries = [...entries].sort((a, b) => 
        new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const now = new Date();
    const lastEventDate = new Date(sortedEntries[0].date);
    const daysSinceLast = Math.floor((now - lastEventDate) / (1000 * 60 * 60 * 24));

    // Monthly average
    const firstDate = new Date(sortedEntries[sortedEntries.length - 1].date);
    const months = Math.max(1, (now - firstDate) / (1000 * 60 * 60 * 24 * 30));
    const monthlyAvg = entries.length / months;

    // Trend calculation (last 3 months vs previous 3 months)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const recentCount = entries.filter(e => new Date(e.date) >= threeMonthsAgo).length;
    const previousCount = entries.filter(e => {
        const date = new Date(e.date);
        return date >= sixMonthsAgo && date < threeMonthsAgo;
    }).length;

    let trend = null;
    let trendPercent = 0;
    if (previousCount > 0) {
        const diff = recentCount - previousCount;
        trendPercent = Math.abs(Math.round((diff / previousCount) * 100));
        trend = diff < 0 ? 'improving' : (diff > 0 ? 'worsening' : 'stable');
    }

    // Most common type
    const typeCounts = {};
    entries.forEach(e => {
        if (e.type) {
            typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
        }
    });
    const mostCommonType = Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Most common hour
    const hourCounts = new Array(24).fill(0);
    entries.forEach(e => {
        const hour = new Date(e.date).getHours();
        hourCounts[hour]++;
    });
    const maxHourCount = Math.max(...hourCounts);
    const mostCommonHour = maxHourCount > 0 ? hourCounts.indexOf(maxHourCount) : null;

    return {
        totalEvents: entries.length,
        daysSinceLast,
        monthlyAvg: Math.round(monthlyAvg * 10) / 10,
        trend,
        trendPercent,
        mostCommonType,
        mostCommonHour,
        typeCounts,
        hourCounts
    };
}

/**
 * Generate AI insights for tracking data
 * @param {Object} trackingData - Full tracking data object
 * @param {string} lang - Language for insights
 * @returns {Promise<Array>} Array of insight objects
 */
async function generateInsights(trackingData, lang = 'en') {
    const stats = calculateStatistics(trackingData.entries);
    
    if (stats.totalEvents < 3) {
        return [{
            icon: 'fa-info-circle',
            title: lang === 'es' ? 'Datos insuficientes' : 'Insufficient data',
            description: lang === 'es' 
                ? 'Necesitas al menos 3 eventos registrados para generar análisis significativos.'
                : 'You need at least 3 recorded events to generate meaningful insights.'
        }];
    }

    try {
        const model = createModels('tracking-insights', 'gpt-4.1-mini')['gpt-4.1-mini'];
        
        const conditionLabel = {
            epilepsy: 'epilepsy/seizures',
            diabetes: 'diabetes/glucose',
            migraine: 'migraine/headaches',
            custom: 'health events'
        }[trackingData.conditionType] || 'health events';

        const prompt = `Analyze this ${conditionLabel} tracking data and provide 3-4 actionable medical insights.

Data summary:
- Total events: ${stats.totalEvents}
- Days since last event: ${stats.daysSinceLast}
- Monthly average: ${stats.monthlyAvg}
- Trend: ${stats.trend || 'unknown'} (${stats.trendPercent}% change)
- Most common type: ${stats.mostCommonType || 'N/A'}
- Most common hour: ${stats.mostCommonHour !== null ? stats.mostCommonHour + ':00' : 'N/A'}
- Condition type: ${trackingData.conditionType}

Recent entries (last 10):
${trackingData.entries.slice(0, 10).map(e => 
    `- ${new Date(e.date).toISOString().split('T')[0]} ${new Date(e.date).getHours()}:00: ${e.type || 'event'}${e.triggers?.length ? ', triggers: ' + e.triggers.join(', ') : ''}`
).join('\n')}

${trackingData.medications?.length ? `Medications:\n${trackingData.medications.map(m => `- ${m.name} ${m.dose}`).join('\n')}` : ''}

Return a JSON array with insights. Each insight should have:
- icon: FontAwesome icon class (e.g., "fa-clock", "fa-chart-line", "fa-exclamation-triangle", "fa-lightbulb-o")
- title: Short title (max 5 words)
- description: Actionable insight (1-2 sentences)

Language for response: ${lang === 'es' ? 'Spanish' : lang === 'de' ? 'German' : lang === 'fr' ? 'French' : lang === 'it' ? 'Italian' : lang === 'pt' ? 'Portuguese' : 'English'}

Return ONLY the JSON array, no markdown or explanation.`;

        const response = await model.invoke(prompt);
        const content = response.content || response;
        
        // Parse the response
        let insights;
        try {
            // Clean up the response
            let cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            insights = JSON.parse(cleanContent);
        } catch (parseError) {
            console.error('Error parsing insights response:', parseError);
            // Return basic insights based on stats
            insights = generateBasicInsights(stats, trackingData.conditionType, lang);
        }

        return insights;
    } catch (error) {
        console.error('Error generating AI insights:', error);
        return generateBasicInsights(stats, trackingData.conditionType, lang);
    }
}

/**
 * Generate basic insights without AI (fallback)
 */
function generateBasicInsights(stats, conditionType, lang) {
    const insights = [];
    const isSpanish = lang === 'es';

    // Trend insight
    if (stats.trend === 'improving') {
        insights.push({
            icon: 'fa-arrow-down',
            title: isSpanish ? 'Tendencia positiva' : 'Positive trend',
            description: isSpanish 
                ? `Los eventos han disminuido un ${stats.trendPercent}% en los últimos 3 meses.`
                : `Events have decreased by ${stats.trendPercent}% in the last 3 months.`
        });
    } else if (stats.trend === 'worsening') {
        insights.push({
            icon: 'fa-arrow-up',
            title: isSpanish ? 'Aumento de eventos' : 'Increase in events',
            description: isSpanish
                ? `Los eventos han aumentado un ${stats.trendPercent}% en los últimos 3 meses. Consulta con tu médico.`
                : `Events have increased by ${stats.trendPercent}% in the last 3 months. Consult your doctor.`
        });
    }

    // Time pattern insight
    if (stats.mostCommonHour !== null) {
        const hourLabel = stats.mostCommonHour < 6 ? (isSpanish ? 'madrugada' : 'early morning') :
                          stats.mostCommonHour < 12 ? (isSpanish ? 'mañana' : 'morning') :
                          stats.mostCommonHour < 18 ? (isSpanish ? 'tarde' : 'afternoon') :
                          (isSpanish ? 'noche' : 'evening');
        insights.push({
            icon: 'fa-clock-o',
            title: isSpanish ? 'Patrón horario' : 'Time pattern',
            description: isSpanish
                ? `La mayoría de eventos ocurren por la ${hourLabel} (alrededor de las ${stats.mostCommonHour}:00).`
                : `Most events occur in the ${hourLabel} (around ${stats.mostCommonHour}:00).`
        });
    }

    // Days since last
    if (stats.daysSinceLast > 30) {
        insights.push({
            icon: 'fa-calendar-check-o',
            title: isSpanish ? 'Buen período' : 'Good period',
            description: isSpanish
                ? `Han pasado ${stats.daysSinceLast} días desde el último evento. ¡Sigue así!`
                : `It's been ${stats.daysSinceLast} days since the last event. Keep it up!`
        });
    }

    return insights.length > 0 ? insights : [{
        icon: 'fa-info-circle',
        title: isSpanish ? 'Seguimiento activo' : 'Active tracking',
        description: isSpanish
            ? `Tienes ${stats.totalEvents} eventos registrados con un promedio de ${stats.monthlyAvg} por mes.`
            : `You have ${stats.totalEvents} recorded events with an average of ${stats.monthlyAvg} per month.`
    }];
}

/**
 * Get or create epilepsy tracking data for a patient
 * @param {string} patientId - Patient ID
 * @returns {Promise<Object>} Tracking document
 */
async function getOrCreateTracking(patientId) {
    let tracking = await Tracking.findOne({ patientId });
    
    if (!tracking) {
        tracking = new Tracking({
            patientId,
            conditionType: 'epilepsy',
            entries: [],
            medications: [],
            metadata: {
                source: 'manual',
                importDate: new Date()
            }
        });
        await tracking.save();
    }
    
    return tracking;
}

/**
 * Import seizure data from SeizureTracker for a patient
 * @param {string} patientId - Patient ID
 * @param {Object} rawData - Raw JSON data from SeizureTracker
 * @param {string} detectedType - Detected format type
 * @returns {Promise<Object>} Updated tracking document
 */
async function importTrackingData(patientId, rawData, detectedType) {
    const parsedData = parseTrackingData(rawData, detectedType);
    
    // Find existing tracking for this patient
    let tracking = await Tracking.findOne({ patientId });
    
    if (tracking) {
        // Merge with existing data
        // Add new entries (avoid duplicates by date)
        const existingDates = new Set(tracking.entries.map(e => new Date(e.date).getTime()));
        const newEntries = parsedData.entries.filter(e => !existingDates.has(new Date(e.date).getTime()));
        tracking.entries = [...tracking.entries, ...newEntries];
        
        // Sort by date (newest first)
        tracking.entries.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        // Update medications
        if (parsedData.medications.length > 0) {
            tracking.medications = parsedData.medications;
        }
        
        // Update metadata
        tracking.metadata = {
            ...tracking.metadata,
            ...parsedData.metadata,
            importDate: new Date()
        };
        
        tracking.updatedAt = new Date();
    } else {
        // Create new tracking
        tracking = new Tracking({
            patientId,
            conditionType: 'epilepsy',
            ...parsedData
        });
    }
    
    await tracking.save();
    return tracking;
}

/**
 * Add a manual seizure entry
 * @param {string} patientId - Patient ID
 * @param {Object} entry - Seizure entry data
 * @returns {Promise<Object>} Updated tracking document
 */
async function addManualEntry(patientId, entry) {
    let tracking = await getOrCreateTracking(patientId);
    
    // Add the new seizure entry
    tracking.entries.unshift({
        date: new Date(entry.date),
        type: entry.type || '',
        duration: entry.duration || null,
        severity: entry.severity || null,
        triggers: entry.triggers || [],
        notes: entry.notes || '',
        aura: entry.aura || false,
        awareness: entry.awareness || ''
    });
    
    // Sort by date (newest first)
    tracking.entries.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    tracking.updatedAt = new Date();
    await tracking.save();
    
    return tracking;
}

module.exports = {
    parseSeizureTrackerData,
    parseTrackingData,
    calculateStatistics,
    generateInsights,
    getOrCreateTracking,
    importTrackingData,
    addManualEntry
};
