/**
 * =========================================================
 *  PATIENT CONTEXT – RAW AGGREGATOR
 *  ---------------------------------------------------------
 *  Devuelve, SIN NINGÚN TIPO DE FORMATO NI RESUMEN,
 *  toda la información clínica disponible (perfil, eventos,
 *  documentos con OCR) para un paciente.
 * =========================================================
 */
'use strict';

/*--------------------------------------------------------------------
 * 1. DEPENDENCIAS
 *------------------------------------------------------------------*/
const Patient   = require('../models/patient');
const Document  = require('../models/document');
const Events    = require('../models/events');
const crypt     = require('./crypt');
const f29azure  = require('./f29azure');
const path      = require('path');

/*--------------------------------------------------------------------
 * 2. UTILIDADES INTERNAS
 *------------------------------------------------------------------*/
/** Convierte fecha ISO → DD/MM/YYYY; null → null */
const toDateStr = date =>
  date ? new Date(date).toLocaleDateString('en-GB') : null;

/** Descarga el .txt OCR de un documento (si existe)            */
async function downloadDocumentText(containerName, url) {
  try {
    const txtPath = url.replace(/\/[^/]*$/, '/extracted_translated.txt');
    return await f29azure.downloadBlob(containerName, txtPath);
  } catch (err) {
    console.warn(`  ↳ OCR missing for ${url}`);
    return null;
  }
}

/*--------------------------------------------------------------------
 * 3. ACCESO A BBDD
 *------------------------------------------------------------------*/
async function fetchPatient(patientId) {
  const patient = await Patient.findById(patientId).lean();
  if (!patient) throw new Error(`Patient ${patientId} not found`);
  return {
    name:              patient.patientName,
    birthDate:         patient.birthDate,
    gender:            patient.gender,
    chronicConditions: patient.chronicConditions,
    allergies:         patient.allergies
  };
}

async function fetchEvents(patientId, limit = 50) {
  const rows = await Events.find({
    createdBy: patientId,
    key: { $in: ['diagnosis', 'medication', 'symptom'] }
  }).limit(limit).lean();

  return rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
             .map(e => ({
               type : e.key,
               name : e.name,
               date : toDateStr(e.date),
               notes: e.notes || ''
             }));
}

async function fetchDocuments(patientId, limit = 10) {
  const containerName = crypt.encrypt(String(patientId)).substring(1);

  const docs = await Document.find({
      createdBy: patientId,
    })
    .limit(limit)
    .lean();

  console.log(`>> Docs from patient ${patientId}:`);
  console.log(docs.length);

  const out = [];
  for (const d of docs) {
    const text = await downloadDocumentText(containerName, d.url);
    out.push({
      name    : path.basename(d.url),
      date    : toDateStr(d.date || d.originaldate),
      category: d.categoryTag || 'General',
      text
    });
  }
  return out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

/*--------------------------------------------------------------------
 * 4. FUNCIÓN PRINCIPAL
 *------------------------------------------------------------------*/
/**
 * Reúne todos los datos del paciente y los devuelve **sin procesar**.
 * @returns { profile, events[], documents[] }
 */
async function aggregateClinicalContext(patientId) {
  console.debug(`[CTX] → Building raw context for ${patientId}`);
  const [profile, events, documents] = await Promise.all([
    fetchPatient(patientId),
    fetchEvents(patientId),
    fetchDocuments(patientId)
  ]);

  return { profile, events, documents };
}

/*--------------------------------------------------------------------
 * 5. EXPORTS
 *------------------------------------------------------------------*/
module.exports = { aggregateClinicalContext };
