'use strict'

const User = require('../models/user')
const Patient = require('../models/patient')
const Events = require('../models/events')
const Document = require('../models/document')
const crypto = require('crypto')
const { graph } = require('../services/agent')
const crypt = require('../services/crypt')
const emailService = require('../services/email')

/**
 * WhatsApp Integration Controller
 * Handles linking/unlinking WhatsApp accounts and generating verification codes
 */

// Get WhatsApp linking status for current user (from app)
async function getStatus(req, res) {
    try {
        const userId = req.user
        const user = await User.findById(userId).select('whatsappPhone whatsappLinkedAt')
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        if (user.whatsappPhone) {
            return res.status(200).json({
                linked: true,
                phone: user.whatsappPhone,
                linkedAt: user.whatsappLinkedAt
            })
        } else {
            return res.status(200).json({
                linked: false
            })
        }
    } catch (err) {
        console.error('Error getting WhatsApp status:', err)
        return res.status(500).json({ message: 'Error getting WhatsApp status' })
    }
}

// Get session by phone number (called by bot)
async function getSessionByPhone(req, res) {
    try {
        const phoneNumber = decodeURIComponent(req.params.phoneNumber)
        
        const user = await User.findOne({ whatsappPhone: phoneNumber })
            .select('_id whatsappPhone whatsappLinkedAt')
        
        if (!user) {
            return res.status(200).json({ linked: false })
        }

        // Encrypt userId before sending to bot
        const encryptedUserId = crypt.encrypt(user._id.toString())

        return res.status(200).json({
            linked: true,
            userId: encryptedUserId,
            phone: user.whatsappPhone,
            linkedAt: user.whatsappLinkedAt,
            activePatientId: null, // Bot manages this in its local state/cache
            patientName: null
        })
    } catch (err) {
        console.error('Error getting WhatsApp session:', err)
        return res.status(500).json({ message: 'Error getting session' })
    }
}

// Generate a linking code for WhatsApp (from app)
async function generateCode(req, res) {
    try {
        const userId = req.user
        const user = await User.findById(userId)
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        // Generate 6-character code (3 bytes = 16 million combinations)
        const code = 'NAV-' + crypto.randomBytes(3).toString('hex').toUpperCase()
        
        // Code expires in 3 minutes
        const expires = new Date(Date.now() + 3 * 60 * 1000)
        
        user.whatsappVerificationCode = code
        user.whatsappVerificationExpires = expires
        await user.save()

        return res.status(200).json({
            code: code,
            expires: expires
        })
    } catch (err) {
        console.error('Error generating WhatsApp code:', err)
        return res.status(500).json({ message: 'Error generating code' })
    }
}

// Unlink WhatsApp from current user (from app)
async function unlink(req, res) {
    try {
        const userId = req.user
        const user = await User.findById(userId)
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        // Clear WhatsApp data
        user.whatsappPhone = null
        user.whatsappLinkedAt = null
        user.whatsappVerificationCode = null
        user.whatsappVerificationExpires = null
        await user.save()

        return res.status(200).json({ message: 'WhatsApp unlinked successfully' })
    } catch (err) {
        console.error('Error unlinking WhatsApp:', err)
        return res.status(500).json({ message: 'Error unlinking WhatsApp' })
    }
}

// Unlink by phone number (called by bot)
async function unlinkByPhone(req, res) {
    try {
        const { phoneNumber } = req.body

        if (!phoneNumber) {
            return res.status(400).json({ message: 'Phone number is required' })
        }

        const user = await User.findOne({ whatsappPhone: phoneNumber })
        
        if (!user) {
            return res.status(200).json({ success: true, message: 'No account linked' })
        }

        // Clear WhatsApp data
        user.whatsappPhone = null
        user.whatsappLinkedAt = null
        user.whatsappVerificationCode = null
        user.whatsappVerificationExpires = null
        await user.save()

        return res.status(200).json({ success: true, message: 'WhatsApp unlinked successfully' })
    } catch (err) {
        console.error('Error unlinking WhatsApp by phone:', err)
        return res.status(500).json({ message: 'Error unlinking WhatsApp' })
    }
}

// Verify a linking code (called by the WhatsApp bot)
async function verifyCode(req, res) {
    try {
        const { phoneNumber, code } = req.body

        console.log('[WhatsApp] verifyCode - phoneNumber:', phoneNumber)
        console.log('[WhatsApp] verifyCode - code:', code)

        if (!phoneNumber || !code) {
            return res.status(400).json({ message: 'Phone number and code are required' })
        }

        const user = await User.findOne({
            whatsappVerificationCode: code.toUpperCase(),
            whatsappVerificationExpires: { $gt: new Date() }
        })

        console.log('[WhatsApp] verifyCode - user found:', user ? 'yes' : 'no')

        if (!user) {
            return res.status(400).json({ 
                success: false,
                message: 'Invalid or expired code'
            })
        }

        // Link the phone number
        user.whatsappPhone = phoneNumber
        user.whatsappLinkedAt = new Date()
        user.whatsappVerificationCode = null
        user.whatsappVerificationExpires = null
        await user.save()

        console.log('[WhatsApp] verifyCode - User linked successfully, phone:', phoneNumber)

        // Send confirmation email (async, don't wait)
        emailService.sendMailWhatsAppLinked(
            { email: user.email, lang: user.lang || 'es' },
            phoneNumber
        ).catch(err => {
            console.error('[WhatsApp] Error sending confirmation email:', err)
        })

        // Return encrypted userId
        return res.status(200).json({
            success: true,
            userId: crypt.encrypt(user._id.toString()),
            message: 'WhatsApp linked successfully'
        })
    } catch (err) {
        console.error('Error verifying WhatsApp code:', err)
        return res.status(500).json({ message: 'Error verifying code' })
    }
}

// Get patients for a user (called by bot)
async function getPatients(req, res) {
    try {
        const { phoneNumber } = req.body
        const encryptedUserId = req.params.userId

        console.log('[WhatsApp] getPatients - phoneNumber:', phoneNumber)
        console.log('[WhatsApp] getPatients - encryptedUserId received')

        if (!phoneNumber) {
            return res.status(400).json({ message: 'Phone number is required' })
        }

        // Decrypt the userId
        let userId
        try {
            userId = crypt.decrypt(encryptedUserId)
            console.log('[WhatsApp] getPatients - userId decrypted successfully')
        } catch (e) {
            console.error('[WhatsApp] getPatients - Failed to decrypt userId:', e.message)
            return res.status(400).json({ message: 'Invalid user ID' })
        }

        // Find user and verify phone number matches
        const user = await User.findById(userId).select('email whatsappPhone')
        
        if (!user) {
            console.log('[WhatsApp] getPatients - user not found')
            return res.status(404).json({ message: 'User not found' })
        }

        // Security check: verify the phoneNumber matches the user's linked phone
        if (user.whatsappPhone !== phoneNumber) {
            console.log('[WhatsApp] getPatients - Phone mismatch! Expected:', user.whatsappPhone, 'Got:', phoneNumber)
            return res.status(403).json({ message: 'Unauthorized' })
        }

        console.log('[WhatsApp] getPatients - user email:', user.email)

        const patients = await Patient.find({
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id }
            ]
        }).select('_id patientName')

        console.log('[WhatsApp] getPatients - found:', patients.length, 'patients')

        // Encrypt patient IDs before sending to bot
        return res.status(200).json({
            patients: patients.map(p => ({
                _id: crypt.encrypt(p._id.toString()),
                patientName: p.patientName || 'Sin nombre'
            }))
        })
    } catch (err) {
        console.error('[WhatsApp] getPatients - Error:', err)
        return res.status(500).json({ message: 'Error getting patients' })
    }
}

// Set active patient for WhatsApp session (called by bot)
async function setActivePatient(req, res) {
    try {
        const { phoneNumber, patientId: encryptedPatientId } = req.body

        if (!phoneNumber || !encryptedPatientId) {
            return res.status(400).json({ message: 'Phone number and patient ID are required' })
        }

        // Decrypt the patientId
        let patientId
        try {
            patientId = crypt.decrypt(encryptedPatientId)
        } catch (e) {
            console.error('[WhatsApp] setActivePatient - Failed to decrypt patientId:', e.message)
            return res.status(400).json({ message: 'Invalid patient ID' })
        }

        const user = await User.findOne({ whatsappPhone: phoneNumber })
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        const patient = await Patient.findById(patientId).select('patientName')
        if (!patient) {
            return res.status(404).json({ message: 'Patient not found' })
        }

        // Return encrypted IDs in the session
        return res.status(200).json({
            success: true,
            session: {
                userId: crypt.encrypt(user._id.toString()),
                activePatientId: encryptedPatientId, // Keep encrypted
                patientName: patient.patientName || 'Sin nombre'
            }
        })
    } catch (err) {
        console.error('Error setting active patient:', err)
        return res.status(500).json({ message: 'Error setting patient' })
    }
}

// Ask Navigator (called by bot) - Synchronous version for WhatsApp
async function ask(req, res) {
    try {
        const { phoneNumber, question, patientId: encryptedPatientId } = req.body

        console.log('[WhatsApp] ask - phoneNumber:', phoneNumber)
        console.log('[WhatsApp] ask - question:', question)
        console.log('[WhatsApp] ask - encryptedPatientId received:', encryptedPatientId ? 'yes' : 'no')

        if (!phoneNumber || !question) {
            return res.status(400).json({ message: 'Phone number and question are required' })
        }

        // Find user by phone
        const user = await User.findOne({ whatsappPhone: phoneNumber })
        console.log('[WhatsApp] ask - user found:', user ? 'yes' : 'no')
        
        if (!user) {
            return res.status(404).json({ error: true, message: 'User not linked' })
        }

        // Decrypt patientId if provided
        let decryptedPatientId = null
        if (encryptedPatientId) {
            try {
                decryptedPatientId = crypt.decrypt(encryptedPatientId)
                console.log('[WhatsApp] ask - patientId decrypted successfully')
            } catch (e) {
                console.error('[WhatsApp] ask - Failed to decrypt patientId:', e.message)
                return res.status(400).json({ error: true, message: 'Invalid patient ID' })
            }
        }

        // If patientId is provided, use it; otherwise fall back to first patient
        let patient
        if (decryptedPatientId) {
            // Validate that the patient belongs to or is shared with this user
            patient = await Patient.findOne({
                _id: decryptedPatientId,
                $or: [
                    { createdBy: user._id },
                    { sharedWith: user._id }
                ]
            }).select('_id patientName country')
            
            if (!patient) {
                console.log('[WhatsApp] ask - Patient not found or not authorized')
                return res.status(400).json({ error: true, message: 'Patient not found or not authorized' })
            }
        } else {
            // Fallback: get first patient
            const patients = await Patient.find({
                $or: [
                    { createdBy: user._id },
                    { sharedWith: user._id }
                ]
            }).select('_id patientName country').limit(1)

            console.log('[WhatsApp] ask - No patientId provided, falling back to first patient')

            if (patients.length === 0) {
                return res.status(400).json({ error: true, message: 'No patients found' })
            }
            patient = patients[0]
        }

        const patientId = patient._id.toString()
        const containerName = crypt.encrypt(patientId).substr(0, 30)
        
        console.log('[WhatsApp] ask - patientId:', patientId)
        console.log('[WhatsApp] ask - patientName:', patient.patientName)
        console.log('[WhatsApp] ask - invoking agent synchronously...')

        // Capture suggestions from agent
        let capturedSuggestions = []

        // Mock pubsub client that captures suggestions (for sync WhatsApp calls)
        const mockPubsub = {
            sendToUser: (userId, message) => {
                if (message.status) {
                    console.log(`[WhatsApp] agent status: ${message.status}`)
                }
                if (message.suggestions && Array.isArray(message.suggestions)) {
                    capturedSuggestions = message.suggestions
                    console.log(`[WhatsApp] captured ${capturedSuggestions.length} suggestions`)
                }
            }
        }

        // Call the agent directly and wait for response (synchronous for WhatsApp)
        const result = await graph.invoke({
            messages: [
                {
                    role: "user",
                    content: question,
                },
            ],
        }, {
            configurable: {
                patientId: patientId,
                systemTime: new Date().toISOString(),
                tracer: null,
                context: [],
                docs: [],
                indexName: patientId,
                containerName: containerName,
                userId: user._id.toString(),
                userLang: user.lang || 'es',
                patientCountry: patient.country || null,
                medicalLevel: user.medicalLevel || '1',
                userRole: user.role || 'User',
                originalQuestion: question,
                pubsubClient: mockPubsub,
                chatMode: 'fast',
                isWhatsApp: true // Flag to skip saving to DB
            },
            callbacks: []
        })

        console.log('[WhatsApp] ask - Agent response received')

        // Extract the answer from the agent result
        let answer = 'No se encontró respuesta.'
        if (result && result.messages && result.messages.length > 0) {
            const lastMessage = result.messages[result.messages.length - 1]
            if (lastMessage && lastMessage.content) {
                answer = lastMessage.content
            }
        }

        return res.status(200).json({
            answer: answer,
            suggestions: capturedSuggestions.slice(0, 4)
        })
    } catch (err) {
        console.error('[WhatsApp] ask - Error:', err.message)
        console.error('[WhatsApp] ask - Stack:', err.stack)
        return res.status(500).json({ error: true, message: 'Error processing question' })
    }
}

// Add event for a patient (called by bot)
async function addEvent(req, res) {
    try {
        const { phoneNumber, patientId: encryptedPatientId, event } = req.body

        console.log('[WhatsApp] addEvent - phoneNumber:', phoneNumber)
        console.log('[WhatsApp] addEvent - event:', JSON.stringify(event))

        if (!phoneNumber || !encryptedPatientId || !event) {
            return res.status(400).json({ message: 'Phone number, patient ID and event are required' })
        }

        // Find user by phone
        const user = await User.findOne({ whatsappPhone: phoneNumber })
        if (!user) {
            return res.status(404).json({ error: true, message: 'User not linked' })
        }

        // Decrypt patientId
        let patientId
        try {
            patientId = crypt.decrypt(encryptedPatientId)
        } catch (e) {
            console.error('[WhatsApp] addEvent - Failed to decrypt patientId:', e.message)
            return res.status(400).json({ error: true, message: 'Invalid patient ID' })
        }

        // Validate that the patient belongs to this user
        const patient = await Patient.findOne({
            _id: patientId,
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id }
            ]
        }).select('_id patientName')

        if (!patient) {
            return res.status(403).json({ error: true, message: 'Patient not authorized' })
        }

        // Validate required event fields
        if (!event.name || !event.key || !event.date) {
            return res.status(400).json({ message: 'Event must have name, key and date' })
        }

        // Valid event keys
        const validKeys = ['diagnosis', 'treatment', 'test', 'appointment', 'symptom', 'medication', 'other']
        if (!validKeys.includes(event.key)) {
            return res.status(400).json({ message: 'Invalid event key' })
        }

        // Create the event
        const Events = require('../models/events')
        const eventdb = new Events({
            date: new Date(event.date),
            dateEnd: event.dateEnd ? new Date(event.dateEnd) : null,
            name: event.name,
            notes: event.notes || '',
            key: event.key,
            origin: 'whatsapp',
            createdBy: patientId,
            addedBy: user._id
        })

        await eventdb.save()

        console.log('[WhatsApp] addEvent - Event saved successfully:', eventdb._id)

        // Clear summary cache (same as in events controller)
        // This is non-critical, so we wrap it carefully and don't let it fail the request
        setImmediate(async () => {
            try {
                const f29azureService = require('../services/f29azure')
                const containerName = crypt.encrypt(patientId).substr(0, 30)
                await f29azureService.deleteSummaryFilesBlobsInFolder(containerName)
                console.log('[WhatsApp] addEvent - Summary cache cleared')
            } catch (e) {
                // Container may not exist if patient never had a summary generated
                console.log('[WhatsApp] addEvent - Could not clear summary cache (non-critical):', e.message)
            }
        })

        return res.status(200).json({
            success: true,
            message: 'Event created successfully',
            eventId: eventdb._id
        })
    } catch (err) {
        console.error('[WhatsApp] addEvent - Error:', err.message)
        return res.status(500).json({ error: true, message: 'Error creating event' })
    }
}

// Get patient summary (quick overview)
async function getSummary(req, res) {
    try {
        const { phoneNumber, patientId: encryptedPatientId } = req.body

        console.log('[WhatsApp] getSummary - phoneNumber:', phoneNumber)

        if (!phoneNumber || !encryptedPatientId) {
            return res.status(400).json({ message: 'Phone number and patient ID are required' })
        }

        // Find user by phone
        const user = await User.findOne({ whatsappPhone: phoneNumber })
        if (!user) {
            return res.status(404).json({ error: true, message: 'User not linked' })
        }

        // Decrypt patientId
        let patientId
        try {
            patientId = crypt.decrypt(encryptedPatientId)
        } catch (e) {
            console.error('[WhatsApp] getSummary - Failed to decrypt patientId:', e.message)
            return res.status(400).json({ error: true, message: 'Invalid patient ID' })
        }

        // Validate that the patient belongs to this user
        const patient = await Patient.findOne({
            _id: patientId,
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id }
            ]
        }).select('patientName birthDate gender')

        if (!patient) {
            return res.status(403).json({ error: true, message: 'Patient not authorized' })
        }

        // Get events for summary
        // Note: Avoid .sort() in MongoDB query as it may fail on CosmosDB without proper index
        const eventsRaw = await Events.find({ createdBy: patientId }).lean()
        // Sort in JavaScript instead
        const events = eventsRaw
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 50)

        // Count events by type
        const diagnosisCount = events.filter(e => e.key === 'diagnosis').length
        const medicationCount = events.filter(e => e.key === 'medication').length
        const appointmentCount = events.filter(e => e.key === 'appointment').length
        const testCount = events.filter(e => e.key === 'test').length
        const symptomCount = events.filter(e => e.key === 'symptom').length

        // Get recent diagnoses (last 5)
        const recentDiagnoses = events
            .filter(e => e.key === 'diagnosis')
            .slice(0, 5)
            .map(e => e.name)

        // Get current medications (last 5)
        const currentMedications = events
            .filter(e => e.key === 'medication')
            .slice(0, 5)
            .map(e => e.name)

        // Get upcoming appointments
        const now = new Date()
        const upcomingAppointments = events
            .filter(e => e.key === 'appointment' && new Date(e.date) >= now)
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(0, 3)
            .map(e => ({
                name: e.name,
                date: e.date
            }))

        // Get last event
        const lastEvent = events[0] ? {
            name: events[0].name,
            type: events[0].key,
            date: events[0].date
        } : null

        // Get documents count
        const documentsCount = await Document.countDocuments({ createdBy: patientId })

        console.log('[WhatsApp] getSummary - Success for patient:', patient.patientName)

        return res.status(200).json({
            success: true,
            patientName: patient.patientName,
            birthDate: patient.birthDate,
            gender: patient.gender,
            stats: {
                diagnoses: diagnosisCount,
                medications: medicationCount,
                appointments: appointmentCount,
                tests: testCount,
                symptoms: symptomCount,
                documents: documentsCount
            },
            recentDiagnoses,
            currentMedications,
            upcomingAppointments,
            lastEvent
        })
    } catch (err) {
        console.error('[WhatsApp] getSummary - Error:', err.message)
        return res.status(500).json({ error: true, message: 'Error getting summary' })
    }
}

// Generate infographic for patient
async function getInfographic(req, res) {
    try {
        const { phoneNumber, patientId: encryptedPatientId, lang = 'es' } = req.body

        console.log('[WhatsApp] getInfographic - phoneNumber:', phoneNumber)

        if (!phoneNumber || !encryptedPatientId) {
            return res.status(400).json({ message: 'Phone number and patient ID are required' })
        }

        // Find user by phone
        const user = await User.findOne({ whatsappPhone: phoneNumber })
        if (!user) {
            return res.status(404).json({ error: true, message: 'User not linked' })
        }

        // Decrypt patientId
        let patientId
        try {
            patientId = crypt.decrypt(encryptedPatientId)
        } catch (e) {
            console.error('[WhatsApp] getInfographic - Failed to decrypt patientId:', e.message)
            return res.status(400).json({ error: true, message: 'Invalid patient ID' })
        }

        // Validate that the patient belongs to this user
        const patient = await Patient.findOne({
            _id: patientId,
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id }
            ]
        }).select('patientName')

        if (!patient) {
            return res.status(403).json({ error: true, message: 'Patient not authorized' })
        }

        // Call the infographic service
        const aiFeaturesCtrl = require('./user/patient/aiFeaturesController')
        
        // Create a mock request/response to call the existing controller
        const mockReq = {
            params: { patientId: encryptedPatientId },
            body: { lang, regenerate: false }
        }
        
        let infographicResult = null
        const mockRes = {
            json: (data) => { infographicResult = data },
            status: function(code) { this.statusCode = code; return this }
        }
        
        await aiFeaturesCtrl.handleInfographicRequest(mockReq, mockRes)

        if (infographicResult && infographicResult.success) {
            console.log('[WhatsApp] getInfographic - Success, imageUrl:', infographicResult.imageUrl?.substring(0, 50) + '...')
            return res.status(200).json({
                success: true,
                patientName: patient.patientName,
                imageUrl: infographicResult.imageUrl,
                cached: infographicResult.cached,
                isBasic: infographicResult.isBasic
            })
        } else {
            console.error('[WhatsApp] getInfographic - Failed:', infographicResult)
            return res.status(500).json({ error: true, message: 'Failed to generate infographic' })
        }
    } catch (err) {
        console.error('[WhatsApp] getInfographic - Error:', err.message)
        return res.status(500).json({ error: true, message: 'Error generating infographic' })
    }
}

module.exports = {
    getStatus,
    getSessionByPhone,
    generateCode,
    unlink,
    unlinkByPhone,
    verifyCode,
    getPatients,
    setActivePatient,
    ask,
    addEvent,
    getSummary,
    getInfographic
}
