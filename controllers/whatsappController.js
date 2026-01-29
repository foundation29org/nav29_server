'use strict'

const User = require('../models/user')
const Patient = require('../models/patient')
const crypto = require('crypto')
const { graph } = require('../services/agent')
const crypt = require('../services/crypt')

/**
 * WhatsApp Integration Controller
 * Handles linking/unlinking WhatsApp accounts and generating verification codes
 */

// Get WhatsApp linking status for current user (from app)
async function getStatus(req, res) {
    try {
        const userId = req.user // req.user contains the userId from the decoded token
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

        // TODO: Get active patient from WhatsAppSession model if exists
        // For now, return basic user info
        return res.status(200).json({
            linked: true,
            userId: user._id,
            phone: user.whatsappPhone,
            linkedAt: user.whatsappLinkedAt,
            activePatientId: null, // TODO: Implement session persistence
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
        const userId = req.user // req.user contains the userId from the decoded token
        const user = await User.findById(userId)
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        // Check if already linked
        if (user.whatsappPhone) {
            return res.status(400).json({ message: 'WhatsApp already linked' })
        }

        // Generate a random 4-character alphanumeric code
        const code = 'NAV-' + crypto.randomBytes(2).toString('hex').toUpperCase()
        
        // Code expires in 10 minutes
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

        // Save code to user
        user.whatsappVerificationCode = code
        user.whatsappVerificationExpires = expiresAt
        await user.save()

        return res.status(200).json({
            code: code,
            expiresAt: expiresAt
        })
    } catch (err) {
        console.error('Error generating WhatsApp code:', err)
        return res.status(500).json({ message: 'Error generating code' })
    }
}

// Unlink WhatsApp from user account (from app)
async function unlink(req, res) {
    try {
        const userId = req.user // req.user contains the userId from the decoded token
        const user = await User.findById(userId)
        
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        if (!user.whatsappPhone) {
            return res.status(400).json({ message: 'WhatsApp not linked' })
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

        console.log('[WhatsApp] verifyCode - user found:', user ? user._id : 'null')
        console.log('[WhatsApp] verifyCode - user email:', user ? user.email : 'null')

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

        console.log('[WhatsApp] verifyCode - User linked successfully:', user._id, 'phone:', phoneNumber)

        return res.status(200).json({
            success: true,
            userId: user._id,
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
        const userId = req.params.userId
        const mongoose = require('mongoose')

        console.log('[WhatsApp] getPatients - userId:', userId)

        // Convert to ObjectId if valid
        let userObjectId
        try {
            userObjectId = new mongoose.Types.ObjectId(userId)
        } catch (e) {
            console.log('[WhatsApp] getPatients - Invalid ObjectId, using string')
            userObjectId = userId
        }

        // Log user info for debugging
        const user = await User.findById(userObjectId).select('email')
        console.log('[WhatsApp] getPatients - user email:', user ? user.email : 'not found')

        const patients = await Patient.find({
            $or: [
                { createdBy: userObjectId },
                { sharedWith: userObjectId }
            ]
        }).select('_id patientName')

        console.log('[WhatsApp] getPatients - found:', patients.length, 'patients')

        return res.status(200).json({
            patients: patients.map(p => ({
                _id: p._id,
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
        const { phoneNumber, patientId } = req.body

        if (!phoneNumber || !patientId) {
            return res.status(400).json({ message: 'Phone number and patient ID are required' })
        }

        const user = await User.findOne({ whatsappPhone: phoneNumber })
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        const patient = await Patient.findById(patientId).select('patientName')
        if (!patient) {
            return res.status(404).json({ message: 'Patient not found' })
        }

        // TODO: Store active patient in WhatsAppSession model
        // For now, just return the session info
        return res.status(200).json({
            success: true,
            session: {
                userId: user._id,
                activePatientId: patientId,
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
        const { phoneNumber, question } = req.body

        console.log('[WhatsApp] ask - phoneNumber:', phoneNumber)
        console.log('[WhatsApp] ask - question:', question)

        if (!phoneNumber || !question) {
            return res.status(400).json({ message: 'Phone number and question are required' })
        }

        // Find user by phone
        const user = await User.findOne({ whatsappPhone: phoneNumber })
        console.log('[WhatsApp] ask - user found:', user ? user._id : 'null')
        
        if (!user) {
            return res.status(404).json({ error: true, message: 'User not linked' })
        }

        // Get patients to find active one (for now, use first one)
        const patients = await Patient.find({
            $or: [
                { createdBy: user._id },
                { sharedWith: user._id }
            ]
        }).select('_id patientName country').limit(1)

        console.log('[WhatsApp] ask - patients count:', patients.length)

        if (patients.length === 0) {
            return res.status(400).json({ error: true, message: 'No patients found' })
        }

        const patient = patients[0]
        const patientId = patient._id.toString()
        const containerName = crypt.encrypt(patientId).substr(0, 30) // Simplified container name
        
        console.log('[WhatsApp] ask - patientId:', patientId)
        console.log('[WhatsApp] ask - invoking agent synchronously...')

        // Capture suggestions from agent
        let capturedSuggestions = []

        // Mock pubsub client that captures suggestions (for sync WhatsApp calls)
        const mockPubsub = {
            sendToUser: (userId, message) => {
                // Log status updates for debugging
                if (message.status) {
                    console.log(`[WhatsApp] agent status: ${message.status}`)
                }
                // Capture suggestions when they are generated
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
                context: [], // TODO: Load patient context for full functionality
                docs: [],
                indexName: patientId,
                containerName: containerName,
                userId: user._id.toString(),
                userLang: user.lang || 'es',
                patientCountry: patient.country || null,
                medicalLevel: user.medicalLevel || '1',
                userRole: user.role || 'User',
                originalQuestion: question,
                pubsubClient: mockPubsub, // Mock pubsub for sync calls
                chatMode: 'fast',
                isWhatsApp: true // Flag to skip saving to DB
            },
            callbacks: []
        })

        console.log('[WhatsApp] ask - Agent response received')

        // Extract the answer from the agent result
        let answer = 'No se encontró respuesta.'
        if (result && result.messages && result.messages.length > 0) {
            // Get the last AI message
            const lastMessage = result.messages[result.messages.length - 1]
            if (lastMessage && lastMessage.content) {
                answer = lastMessage.content
            }
        }

        return res.status(200).json({
            answer: answer,
            suggestions: capturedSuggestions.slice(0, 4) // Max 4 suggestions
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
