// Rarescope Controller
'use strict'

const Rarescope = require('../../../models/rarescope')

/**
 * Guardar datos de Rarescope para un paciente
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const saveRarescopeData = async (req, res) => {
  try {
    const { patientId } = req.params
    const { mainNeed, additionalNeeds, role } = req.body

    // Validar datos requeridos
    if (!patientId) {
      return res.status(400).json({
        success: false,
        error: 'ID del paciente es requerido'
      })
    }

    if (!mainNeed && (!additionalNeeds || additionalNeeds.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'Al menos una necesidad principal o adicional es requerida'
      })
    }

    const roleValue = role !== undefined && role !== null ? String(role) : null
    // Un registro por (patientId, role): clínico y paciente pueden tener su propia lista guardada
    let rarescopeData = await Rarescope.findOne({ patientId, role: roleValue })

    if (rarescopeData) {
      rarescopeData.mainNeed = mainNeed || rarescopeData.mainNeed
      rarescopeData.additionalNeeds = Array.isArray(additionalNeeds) ? additionalNeeds : rarescopeData.additionalNeeds
      rarescopeData.updatedAt = new Date()
    } else {
      rarescopeData = new Rarescope({
        patientId,
        mainNeed: mainNeed || '',
        additionalNeeds: Array.isArray(additionalNeeds) ? additionalNeeds : [],
        role: roleValue,
        updatedAt: new Date()
      })
    }

    await rarescopeData.save()

    res.status(200).json({
      success: true,
      message: 'Datos de Rarescope guardados exitosamente',
      data: rarescopeData
    })

  } catch (error) {
    console.error('Error al guardar datos de Rarescope:', error)
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor al guardar datos de Rarescope'
    })
  }
}

/**
 * Cargar datos de Rarescope para un paciente
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const loadRarescopeData = async (req, res) => {
  try {
    const { patientId } = req.params
    const role = req.query.role !== undefined ? String(req.query.role) : null

    if (!patientId) {
      return res.status(400).json({
        success: false,
        error: 'ID del paciente es requerido'
      })
    }

    // Cargar el guardado para este paciente Y este role (Clinical vs paciente = listas distintas)
    const rarescopeData = await Rarescope.findOne({ patientId, role: role || null })

    if (!rarescopeData) {
      return res.status(200).json({
        success: true,
        message: 'No se encontraron datos de Rarescope para este paciente y rol',
        data: null
      })
    }

    res.status(200).json({
      success: true,
      message: 'Datos de Rarescope cargados exitosamente',
      data: rarescopeData
    })

  } catch (error) {
    console.error('Error al cargar datos de Rarescope:', error)
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor al cargar datos de Rarescope'
    })
  }
}

/**
 * Obtener historial de datos de Rarescope para un paciente
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const getRarescopeHistory = async (req, res) => {
  try {
    const { patientId } = req.params
    const { limit = 10, page = 1 } = req.query

    if (!patientId) {
      return res.status(400).json({
        success: false,
        error: 'ID del paciente es requerido'
      })
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)

    // Buscar historial de datos de Rarescope
    const rarescopeHistory = await Rarescope.find({ patientId })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))

    // Contar total de registros
    const total = await Rarescope.countDocuments({ patientId })

    res.status(200).json({
      success: true,
      message: 'Historial de Rarescope cargado exitosamente',
      data: {
        history: rarescopeHistory,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalRecords: total,
          limit: parseInt(limit)
        }
      }
    })

  } catch (error) {
    console.error('Error al cargar historial de Rarescope:', error)
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor al cargar historial de Rarescope'
    })
  }
}

/**
 * Eliminar datos de Rarescope para un paciente
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const deleteRarescopeData = async (req, res) => {
  try {
    const { patientId } = req.params

    if (!patientId) {
      return res.status(400).json({
        success: false,
        error: 'ID del paciente es requerido'
      })
    }

    // Eliminar todos los registros de Rarescope para el paciente
    const result = await Rarescope.deleteMany({ patientId })

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'No se encontraron datos de Rarescope para eliminar'
      })
    }

    res.status(200).json({
      success: true,
      message: `Se eliminaron ${result.deletedCount} registros de Rarescope exitosamente`
    })

  } catch (error) {
    console.error('Error al eliminar datos de Rarescope:', error)
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor al eliminar datos de Rarescope'
    })
  }
}

module.exports = {
  saveRarescopeData,
  loadRarescopeData,
  getRarescopeHistory,
  deleteRarescopeData
}
