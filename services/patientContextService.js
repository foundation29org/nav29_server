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
const crypt       = require('./crypt');
const f29azure    = require('./f29azure');

/* ------------------------------------------------------------------ */
/* 1 · Helpers                                                        */
/* ------------------------------------------------------------------ */
const toDateStr = d =>
  d ? new Date(d).toLocaleDateString('es-ES') : null;

async function downloadDocumentText(containerName, url) {
  const txtPath = url.replace(/\/[^/]*$/, '/extracted_translated.txt');
  try {
    return await f29azure.downloadBlob(containerName, txtPath);
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
      notes: e.notes ?? ''
    }));
}

async function fetchDocuments(id, limit = 10) {
  const docs = await Document.find({ createdBy: id }).limit(limit).lean();

  /* Descarga OCR en paralelo */
  const blobs = await Promise.allSettled(
    docs.map(d => downloadDocumentText(d.containerName || crypt.encrypt(String(id)).slice(1), d.url))
  );

  return docs.map((d, i) => ({
    name    : path.basename(d.url),
    date    : toDateStr(d.date ?? d.originaldate),
    category: d.categoryTag || 'General',
    text    : blobs[i].status === 'fulfilled' ? blobs[i].value : null
  }))
  .sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0));
}

/* ------------------------------------------------------------------ */
/* 3 · Public API                                                     */
/* ------------------------------------------------------------------ */
async function aggregateClinicalContext(patientId) {
  console.debug(`[CTX] Building raw context for ${patientId}`);
  const [profile, events, documents] = await Promise.all([
    fetchPatient(patientId),
    fetchEvents(patientId),
    fetchDocuments(patientId)
  ]);
  return { profile, events, documents };
}

module.exports = { aggregateClinicalContext };
