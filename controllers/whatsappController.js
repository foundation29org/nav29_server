'use strict'

const User = require('../models/user')
const Patient = require('../models/patient')
const Events = require('../models/events')
const Appointments = require('../models/appointments')
const Document = require('../models/document')
const crypto = require('crypto')
const { graph } = require('../services/agent')
const crypt = require('../services/crypt')
const emailService = require('../services/email')
const f29azureService = require('../services/f29azure')
const bookService = require('../services/books')

/**
 * WhatsApp Integration Controller
 * Handles linking/unlinking WhatsApp accounts and generating verification codes
 */

// In-memory cache for infographic tokens (token -> { imageUrl, expiresAt })
// Tokens expire after 24 hours
const infographicTokens = new Map()

// Cleanup expired tokens every hour
setInterval(() => {
    const now = Date.now()
    for (const [token, data] of infographicTokens.entries()) {
        if (data.expiresAt < now) {
            infographicTokens.delete(token)
        }
    }
}, 60 * 60 * 1000)

/**
 * Generate a short token for infographic access
 */
function generateInfographicToken(imageUrl) {
    const token = crypto.randomBytes(16).toString('hex')
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    infographicTokens.set(token, { imageUrl, expiresAt })
    return token
}

/**
 * Build patient context (metadata) for the agent
 * Similar to how the client builds it in home.component.ts
 * @param {string} patientId - Patient ID
 * @param {object} patientData - Patient basic data (birthDate, gender)
 * @returns {Array} - Context array for the agent
 */
async function buildPatientContext(patientId, patientData) {
    const metadata = []
    
    try {
        // Add basic patient data
        if (patientData.gender) {
            metadata.push({ name: 'Gender:' + patientData.gender, date: undefined })
        }
        if (patientData.birthDate) {
            metadata.push({ name: 'BirthDate:' + patientData.birthDate, date: undefined })
        }
        
        // Load events
        const events = await Events.find({ createdBy: patientId })
            .select('name date dateEnd key')
            .lean()
        
        for (const event of events) {
            const dateWithoutTime = event.date ? new Date(event.date).toISOString().split('T')[0] : undefined
            const metadataItem = { name: event.name, date: dateWithoutTime }
            if (event.dateEnd) {
                metadataItem.dateEnd = new Date(event.dateEnd).toISOString().split('T')[0]
            }
            metadata.push(metadataItem)
        }
        
        // Load appointments
        const appointments = await Appointments.find({ createdBy: patientId })
            .select('notes date')
            .lean()
        
        for (const appointment of appointments) {
            if (appointment.notes) {
                const dateWithoutTime = appointment.date ? new Date(appointment.date).toISOString().split('T')[0] : undefined
                metadata.push({ name: appointment.notes, date: dateWithoutTime })
            }
        }
        
        console.log(`[WhatsApp] buildPatientContext - Built context with ${metadata.length} items`)
    } catch (err) {
        console.error('[WhatsApp] buildPatientContext - Error:', err.message)
    }
    
    return metadata
}

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

        // Get patients where user is owner, in sharedWith, or has accepted customShare
        const patients = await Patient.find({
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id },
                { 'customShare.locations': { $elemMatch: { userId: userId, status: 'accepted' } } }
            ]
        }).select('_id patientName createdBy')

        console.log('[WhatsApp] getPatients - found:', patients.length, 'patients')

        // Encrypt patient IDs before sending to bot
        // Include isOwner flag to indicate if user owns the patient
        return res.status(200).json({
            patients: patients.map(p => ({
                _id: crypt.encrypt(p._id.toString()),
                patientName: p.patientName || 'Sin nombre',
                isOwner: p.createdBy && p.createdBy.toString() === user._id.toString()
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
        const userId = user._id.toString()
        if (decryptedPatientId) {
            // Validate that the patient belongs to or is shared with this user
            patient = await Patient.findOne({
                _id: decryptedPatientId,
                $or: [
                    { createdBy: user._id },
                    { sharedWith: user._id },
                    { 'customShare.locations': { $elemMatch: { userId: userId, status: 'accepted' } } }
                ]
            }).select('_id patientName country birthDate gender')
            
            if (!patient) {
                console.log('[WhatsApp] ask - Patient not found or not authorized')
                return res.status(400).json({ error: true, message: 'Patient not found or not authorized' })
            }
        } else {
            // Fallback: get first patient
            const patients = await Patient.find({
                $or: [
                    { createdBy: user._id },
                    { sharedWith: user._id },
                    { 'customShare.locations': { $elemMatch: { userId: userId, status: 'accepted' } } }
                ]
            }).select('_id patientName country birthDate gender').limit(1)

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
        
        // Build patient context (events, appointments, basic data)
        const patientContext = await buildPatientContext(patientId, {
            birthDate: patient.birthDate,
            gender: patient.gender
        })
        
        // Build context array for the agent (same format as client)
        const context = patientContext.length > 0 
            ? [{ role: "assistant", content: JSON.stringify(patientContext) }]
            : []
        
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
                context: context,
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
        const userId = user._id.toString()
        const patient = await Patient.findOne({
            _id: patientId,
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id },
                { 'customShare.locations': { $elemMatch: { userId: userId, status: 'accepted' } } }
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

// Get patient summary (real summary from final_card.txt)
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
        const userId = user._id.toString()
        const patient = await Patient.findOne({
            _id: patientId,
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id },
                { 'customShare.locations': { $elemMatch: { userId: userId, status: 'accepted' } } }
            ]
        }).select('patientName birthDate gender summary summaryDate')

        if (!patient) {
            return res.status(403).json({ error: true, message: 'Patient not authorized' })
        }

        // Get the real summary from Azure Blob Storage (final_card.txt)
        const f29azure = require('../services/f29azure')
        const summaryPath = 'raitofile/summary/final_card.txt'
        
        // Try SHA256 container name first
        let containerName = crypt.getContainerName(patientId)
        console.log('[WhatsApp] getSummary - Trying containerName (SHA256):', containerName)
        let exists = await f29azure.checkBlobExists(containerName, summaryPath)
        
        // If not found, try legacy container name
        if (!exists) {
            containerName = crypt.getContainerNameLegacy(patientId)
            console.log('[WhatsApp] getSummary - Trying containerName (Legacy):', containerName)
            exists = await f29azure.checkBlobExists(containerName, summaryPath)
        }
        
        if (!exists) {
            console.log('[WhatsApp] getSummary - Summary file not found, checking if generation is needed')
            
            // Check if patient has any documents or events to generate summary from
            const eventsCount = await Events.countDocuments({ createdBy: patientId })
            
            if (eventsCount === 0) {
                return res.status(200).json({
                    success: false,
                    patientName: patient.patientName,
                    message: 'El paciente no tiene información suficiente para generar un resumen. Añade eventos o documentos primero.'
                })
            }
            
            // Check if summary is already being generated
            if (patient.summary === 'inProcess') {
                return res.status(200).json({
                    success: false,
                    needsGeneration: true,
                    patientName: patient.patientName,
                    message: 'El resumen se está generando. Por favor, espera unos minutos e inténtalo de nuevo.'
                })
            }
            
            // Trigger summary generation asynchronously
            console.log('[WhatsApp] getSummary - Triggering summary generation for patient:', patientId)
            try {
                // Set status to inProcess
                await Patient.findByIdAndUpdate(patientId, { summary: 'inProcess', summaryDate: new Date() })
                
                // Trigger async generation (fire and forget)
                const langchainService = require('../services/langchain')
                setImmediate(async () => {
                    try {
                        await langchainService.createPatientSummary(patientId, user._id.toString(), null)
                        console.log('[WhatsApp] getSummary - Summary generation completed for patient:', patientId)
                    } catch (genError) {
                        console.error('[WhatsApp] getSummary - Summary generation failed:', genError.message)
                        // Reset status on failure
                        await Patient.findByIdAndUpdate(patientId, { summary: 'false' })
                    }
                })
                
                return res.status(200).json({
                    success: false,
                    needsGeneration: true,
                    patientName: patient.patientName,
                    message: 'Generando resumen... Este proceso puede tardar 2-3 minutos. Inténtalo de nuevo en unos minutos.'
                })
            } catch (triggerError) {
                console.error('[WhatsApp] getSummary - Failed to trigger generation:', triggerError.message)
                return res.status(200).json({
                    success: false,
                    patientName: patient.patientName,
                    message: 'No se pudo iniciar la generación del resumen. Inténtalo desde la app Nav29.'
                })
            }
        }
        
        // Download the summary
        const summaryContent = await f29azure.downloadBlob(containerName, summaryPath)
        if (!summaryContent) {
            return res.status(200).json({
                success: false,
                patientName: patient.patientName,
                message: 'El resumen está vacío.'
            })
        }
        
        // Parse the summary JSON
        let summaryData
        try {
            const summaryJson = JSON.parse(summaryContent)
            summaryData = summaryJson.data || summaryContent
        } catch (parseError) {
            summaryData = summaryContent
        }

        console.log('[WhatsApp] getSummary - Success for patient:', patient.patientName)

        return res.status(200).json({
            success: true,
            patientName: patient.patientName,
            summaryDate: patient.summaryDate,
            summary: summaryData
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
        const userId = user._id.toString()
        const patient = await Patient.findOne({
            _id: patientId,
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id },
                { 'customShare.locations': { $elemMatch: { userId: userId, status: 'accepted' } } }
            ]
        }).select('patientName')

        if (!patient) {
            return res.status(403).json({ error: true, message: 'Patient not authorized' })
        }

        // Call the infographic service
        const aiFeaturesCtrl = require('./user/patient/aiFeaturesController')
        const f29azure = require('../services/f29azure')
        
        // Check if patient now has a summary (to decide if we should regenerate a basic infographic)
        const summaryPath = 'raitofile/summary/final_card.txt'
        let containerName = crypt.getContainerName(patientId)
        let hasSummary = await f29azure.checkBlobExists(containerName, summaryPath)
        if (!hasSummary) {
            containerName = crypt.getContainerNameLegacy(patientId)
            hasSummary = await f29azure.checkBlobExists(containerName, summaryPath)
        }
        
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

        // If we got a basic infographic but now have a summary, regenerate
        if (infographicResult?.success && infographicResult.isBasic && hasSummary) {
            console.log('[WhatsApp] getInfographic - Basic infographic found but summary exists, regenerating...')
            mockReq.body.regenerate = true
            infographicResult = null
            await aiFeaturesCtrl.handleInfographicRequest(mockReq, mockRes)
        }

        if (infographicResult && infographicResult.success) {
            console.log('[WhatsApp] getInfographic - Success, imageUrl:', infographicResult.imageUrl?.substring(0, 50) + '...')
            
            // Generate a proxy token for the image
            const proxyToken = generateInfographicToken(infographicResult.imageUrl)
            // Build proxy URL - use request host or fallback to nav29.org
            const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https'
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'nav29.org'
            const baseUrl = `${protocol}://${host}/api`
            const proxyUrl = `${baseUrl}/whatsapp/infographic/view/${proxyToken}`
            
            console.log('[WhatsApp] getInfographic - Proxy URL generated:', proxyUrl)
            
            return res.status(200).json({
                success: true,
                patientName: patient.patientName,
                imageUrl: proxyUrl, // URL proxy limpia
                originalUrl: infographicResult.imageUrl, // URL original (para debug)
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

// Serve infographic image via proxy (public endpoint, no auth needed)
async function serveInfographic(req, res) {
    try {
        const { token } = req.params
        
        if (!token) {
            return res.status(400).send('Token required')
        }
        
        const tokenData = infographicTokens.get(token)
        
        if (!tokenData) {
            return res.status(404).send('Infographic not found or expired')
        }
        
        if (tokenData.expiresAt < Date.now()) {
            infographicTokens.delete(token)
            return res.status(410).send('Infographic expired')
        }
        
        // Fetch the image from Azure and pipe it to the response
        const https = require('https')
        const http = require('http')
        const url = new URL(tokenData.imageUrl)
        const protocol = url.protocol === 'https:' ? https : http
        
        protocol.get(tokenData.imageUrl, (imageResponse) => {
            if (imageResponse.statusCode !== 200) {
                console.error('[WhatsApp] serveInfographic - Azure returned:', imageResponse.statusCode)
                return res.status(502).send('Error fetching image')
            }
            
            // Set content type for PNG image
            res.setHeader('Content-Type', 'image/png')
            res.setHeader('Cache-Control', 'public, max-age=86400') // Cache for 24h
            
            // Pipe the image directly to the response
            imageResponse.pipe(res)
        }).on('error', (err) => {
            console.error('[WhatsApp] serveInfographic - Error fetching image:', err.message)
            res.status(500).send('Error fetching image')
        })
    } catch (err) {
        console.error('[WhatsApp] serveInfographic - Error:', err.message)
        return res.status(500).send('Error serving infographic')
    }
}

/**
 * Upload a document from WhatsApp
 * POST /whatsapp/upload
 * Body: { phoneNumber, patientId, filename, mimeType }
 * File: multipart/form-data with 'file' field
 */
async function uploadDocument(req, res) {
    try {
        const { phoneNumber, patientId, filename, mimeType } = req.body
        
        console.log('[WhatsApp] uploadDocument - Request:', { phoneNumber, patientId, filename, mimeType })
        
        if (!phoneNumber || !patientId) {
            return res.status(400).json({ success: false, message: 'phoneNumber and patientId required' })
        }
        
        if (!req.files || !req.files.file) {
            return res.status(400).json({ success: false, message: 'No file provided' })
        }
        
        // Validate file type - same extensions as client
        const allowedMimeTypes = [
            'image/jpeg',
            'image/jpg', 
            'image/png',
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
            'text/plain'
        ]
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.docx', '.txt']
        
        const fileMimeType = mimeType || req.files.file.mimetype
        const fileExtension = filename ? '.' + filename.split('.').pop().toLowerCase() : ''
        
        const isValidMime = allowedMimeTypes.includes(fileMimeType)
        const isValidExtension = allowedExtensions.includes(fileExtension)
        
        if (!isValidMime && !isValidExtension) {
            console.log('[WhatsApp] uploadDocument - Invalid file type:', { fileMimeType, fileExtension })
            return res.status(400).json({ 
                success: false, 
                message: 'Tipo de archivo no permitido. Formatos válidos: JPG, PNG, PDF, DOCX, TXT',
                allowedTypes: allowedExtensions 
            })
        }
        
        // Validate file size (max 100MB, same as Azure blob limit)
        const maxFileSize = 100 * 1024 * 1024 // 100MB
        if (req.files.file.size > maxFileSize) {
            return res.status(400).json({ 
                success: false, 
                message: 'Archivo demasiado grande. Máximo 100MB.' 
            })
        }
        
        // Validate user is linked (use whatsappPhone like other functions)
        const user = await User.findOne({ whatsappPhone: phoneNumber })
        if (!user) {
            console.log('[WhatsApp] uploadDocument - User not found for phone:', phoneNumber)
            return res.status(401).json({ success: false, message: 'User not linked' })
        }
        
        console.log('[WhatsApp] uploadDocument - User found:', user.email)
        
        // Decrypt and validate patientId
        let decryptedPatientId
        try {
            decryptedPatientId = crypt.decrypt(patientId)
        } catch (err) {
            return res.status(400).json({ success: false, message: 'Invalid patientId' })
        }
        
        // Verify user has access to this patient
        const patient = await Patient.findById(decryptedPatientId)
        if (!patient) {
            return res.status(404).json({ success: false, message: 'Patient not found' })
        }
        
        const isOwner = patient.createdBy.toString() === user._id.toString()
        const isShared = user.sharedPatients && user.sharedPatients.some(sp => sp.patientId.toString() === decryptedPatientId)
        
        if (!isOwner && !isShared) {
            return res.status(403).json({ success: false, message: 'Access denied to patient' })
        }
        
        // Check for pending documents (max 5 allowed, same as client)
        const MAX_PENDING_DOCUMENTS = 5
        const pendingCount = await Document.countDocuments({
            createdBy: decryptedPatientId,
            status: 'inProcess'
        })
        
        if (pendingCount >= MAX_PENDING_DOCUMENTS) {
            console.log('[WhatsApp] uploadDocument - Too many pending documents:', pendingCount)
            return res.status(429).json({ 
                success: false, 
                message: `Hay ${pendingCount} documento(s) en proceso. Espera a que terminen antes de subir más.`,
                pendingCount: pendingCount,
                maxAllowed: MAX_PENDING_DOCUMENTS
            })
        }
        
        // Generate unique URL for the document
        const timestamp = Date.now()
        const safeFilename = (filename || 'document').replace(/[^a-zA-Z0-9.-]/g, '_')
        const documentUrl = `whatsapp/${timestamp}_${safeFilename}`
        
        // Get container name from encrypted patientId
        const containerName = crypt.getContainerNameFromEncrypted(patientId)
        
        // Save file to Azure Blob Storage
        const uploadResult = await f29azureService.createBlob(containerName, documentUrl, req.files.file.data)
        if (!uploadResult) {
            console.error('[WhatsApp] uploadDocument - Error saving to blob storage')
            return res.status(500).json({ success: false, message: 'Error saving file' })
        }
        
        // Create document record in database
        const document = new Document({
            url: documentUrl,
            createdBy: decryptedPatientId,
            addedBy: user._id
        })
        
        await document.save()
        
        // Start document processing (OCR, etc.)
        const docId = document._id.toString().toLowerCase()
        const isTextFile = mimeType === 'text/plain'
        
        // Obtener configuración del usuario
        const medicalLevel = user.medicalLevel || '1'
        const preferredResponseLanguage = user.preferredResponseLanguage || user.lang || 'es'
        
        // userId must be encrypted for form_recognizer (same as client sends)
        const encryptedUserId = crypt.encrypt(user._id.toString())
        
        bookService.form_recognizer(
            decryptedPatientId, 
            docId, 
            containerName, 
            documentUrl, 
            safeFilename, 
            encryptedUserId, 
            true, 
            medicalLevel,
            isTextFile,
            preferredResponseLanguage
        )
        
        console.log('[WhatsApp] uploadDocument - Success. DocId:', docId)
        
        res.status(200).json({ 
            success: true, 
            message: 'Document uploaded successfully',
            docId: crypt.encrypt(docId),
            filename: safeFilename
        })
        
    } catch (err) {
        console.error('[WhatsApp] uploadDocument - Error:', err.message)
        res.status(500).json({ success: false, message: 'Error processing upload' })
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
    getInfographic,
    serveInfographic,
    uploadDocument
}
