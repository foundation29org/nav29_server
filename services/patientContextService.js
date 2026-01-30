/**********************************************************************
 *  patientContext.service.js
 *  -------------------------------------------------------------------
 *  Expone aggregateClinicalContext(patientId) que devuelve:
 *    { profile, events[], documents[] }
 *********************************************************************/
'use strict';

const path        = require('path');
const Patient     = require('../models/patient');
const Document    = require('../models/document');
const Events      = require('../models/events');
const Appointments = require('../models/appointments');
const Notes       = require('../models/notes');
const crypt       = require('./crypt');
const f29azure    = require('./f29azure');

/* ------------------------------------------------------------------ */
/* 1 · Helpers                                                        */
/* ------------------------------------------------------------------ */
const toDateStr = d =>
  d ? new Date(d).toLocaleDateString('es-ES') : null;

async function downloadDocumentText(containerName, url) {
  // Primero intentar obtener el resumen si existe
  const summaryPath = url.replace(/\/[^/]*$/, '/summary_translated.txt');
  try {
    const summary = await f29azure.downloadBlob(containerName, summaryPath);
    if (summary && summary.trim()) {
      return { text: summary, hasSummary: true }; // Usar el resumen si existe
    }
  } catch {
    // Si no hay resumen, continuar con extracted_translated
  }
  
  // Si no hay resumen, usar el texto extraído
  const txtPath = url.replace(/\/[^/]*$/, '/extracted_translated.txt');
  try {
    const text = await f29azure.downloadBlob(containerName, txtPath);
    return { text: text, hasSummary: false };
  } catch {
    console.warn(`↳ OCR no disponible: ${path.basename(url)}`); // sin PHI
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 2 · Queries                                                        */
/* ------------------------------------------------------------------ */
async function fetchPatient(id) {
  const p = await Patient.findById(id).lean();
  if (!p) throw new Error(`Paciente ${id} no encontrado`);
  return {
    name      : p.patientName,
    birthDate : p.birthDate,
    gender    : p.gender,
    chronic   : p.chronicConditions ?? [],
    allergies : p.allergies ?? []
  };
}

async function fetchEvents(id, limit = 50) {
  const rows = await Events
    .find({ createdBy: id, key: { $in: ['diagnosis', 'medication', 'symptom'] } })
    .limit(limit)
    .lean();

  return rows.sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0))
    .map(e => ({
      type : e.key,
      name : e.name,
      date : toDateStr(e.date),
      notes: e.notes ?? '',
      dateConfidence: e.dateConfidence || 'missing'
    }));
}

async function fetchDocuments(id, limit = 10) {
  const docs = await Document.find({ createdBy: id }).limit(limit).lean();

  /* Descarga texto/resumen en paralelo */
  const blobs = await Promise.allSettled(
    docs.map(d => downloadDocumentText(d.containerName || crypt.getContainerName(String(id)), d.url))
  );

  return docs.map((d, i) => {
    const blobResult = blobs[i].status === 'fulfilled' ? blobs[i].value : null;
    // Si blobResult es un objeto con text y hasSummary, usarlo
    // Si es un string (versión antigua), convertirlo
    const text = typeof blobResult === 'object' && blobResult !== null ? blobResult.text : blobResult;
    const hasSummary = typeof blobResult === 'object' && blobResult !== null ? blobResult.hasSummary : false;
    
    return {
      name    : path.basename(d.url),
      date    : toDateStr(d.date ?? d.originaldate),
      category: d.categoryTag || 'General',
      text    : text || null,
      hasSummary: hasSummary // Indicar si tiene resumen pre-generado
    };
  })
  .sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0));
}

async function fetchAppointments(id, limit = 20) {
  const rows = await Appointments
    .find({ createdBy: id })
    .limit(limit)
    .lean();

  // Sort en memoria (evita requerir índice en Cosmos DB)
  return rows
    .sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0))
    .map(a => ({
      date: toDateStr(a.date),
      notes: a.notes ?? ''
    }));
}

async function fetchNotes(id, limit = 20) {
  const rows = await Notes
    .find({ createdBy: id })
    .limit(limit)
    .lean();

  // Sort en memoria (evita requerir índice en Cosmos DB)
  return rows
    .sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0))
    .map(n => ({
      date: toDateStr(n.date),
      content: n.content ?? ''
    }));
}

/* ------------------------------------------------------------------ */
/* 3 · Public API                                                     */
/* ------------------------------------------------------------------ */
/**
 * Agrega el contexto clínico relevante para funciones de IA (DxGPT, Rarescope, etc.)
 * 
 * @param {string} patientId - ID del paciente
 * @param {Object} options - Opciones
 * @param {boolean} options.includeAppointments - Incluir citas (default: false)
 * @param {boolean} options.includeNotes - Incluir notas personales (default: false)
 */
async function aggregateClinicalContext(patientId, options = {}) {
  console.debug(`[CTX] Building raw context for ${patientId}`);
  
  // Datos clínicos principales (siempre se cargan)
  const [profile, events, documents] = await Promise.all([
    fetchPatient(patientId),
    fetchEvents(patientId),
    fetchDocuments(patientId)
  ]);
  
  const result = { profile, events, documents };
  
  // Datos opcionales (diary) - solo si se solicitan explícitamente
  if (options.includeAppointments) {
    result.appointments = await fetchAppointments(patientId);
  }
  if (options.includeNotes) {
    result.notes = await fetchNotes(patientId);
  }
  
  return result;
}

module.exports = { aggregateClinicalContext };
