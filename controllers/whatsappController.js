'use strict'

const User = require('../models/user')
const Patient = require('../models/patient')
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

module.exports = {
    getStatus,
    getSessionByPhone,
    generateCode,
    unlink,
    unlinkByPhone,
    verifyCode,
    getPatients,
    setActivePatient,
    ask
}
