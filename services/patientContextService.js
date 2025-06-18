// models
const Patient = require('../models/patient');
const Document = require('../models/document');
const Events = require('../models/events');
const config = require('../config');
const axios = require('axios');
const crypto = require('crypto');

/* =========================================================
 * SIMPLE UTILITIES
 * ========================================================= */

/**
 * Generates a consistent UUID for a patient
 */
function generatePatientUUID(patientId) {
  const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const hash = crypto.createHash('sha1')
    .update(namespace + patientId)
    .digest('hex');
  
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
    hash.substring(20, 32)
  ].join('-');
}

/**
 * Formats a date in a readable way
 */
function formatDate(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-GB');
}

/* =========================================================
 * STEP 1: GET PATIENT DATA
 * ========================================================= */

/**
 * Gets the basic patient profile
 */
async function getPatientProfile(patientId) {
  const patient = await Patient.findById(patientId);
  if (!patient) throw new Error(`Patient ${patientId} not found`);

  return {
    name: patient.patientName,
    birthDate: patient.birthDate,
    gender: patient.gender,
    chronicConditions: patient.chronicConditions,
    allergies: patient.allergies,
  };
}

/* =========================================================
 * STEP 2: GET MEDICAL EVENTS
 * ========================================================= */

/**
 * Gets clinical events (diagnoses, medication, symptoms)
 */
async function getPatientEvents(patientId, limit = 50) {
  const events = await Events
    .find({ 
      createdBy: patientId, 
      key: { $in: ['diagnosis', 'medication', 'symptom'] } 
    })
    .limit(limit);

  const sortedEvents = events.sort((a, b) => {
    const dateA = new Date(a.date || 0);
    const dateB = new Date(b.date || 0);
    return dateB - dateA; // Most recent first
  });

  return sortedEvents.map(event => ({
    type: event.key,
    name: event.name,
    date: event.date,
    notes: event.notes || ''
  }));
}

/* =========================================================
 * STEP 3: GET FULL-CONTENT DOCUMENTS
 * ========================================================= */

/**
 * Gets medical documents with extracted full text
 */
async function getPatientDocuments(patientId, limit = 10) {
  const documents = await Document
    .find({ 
      createdBy: patientId, 
      status: { $in: ['finished', 'processed'] },
      extractedText: { $exists: true, $ne: '' }
    })
    .limit(limit);

  const sortedDocuments = documents.sort((a, b) => {
    const dateA = new Date(a.createdDate || 0);
    const dateB = new Date(b.createdDate || 0);
    return dateB - dateA; // Most recent first
  });

  return sortedDocuments.map(doc => ({
    name: doc.originalName,
    category: doc.categoryTag || 'General',
    fullContent: doc.extractedText,
    date: doc.createdDate
  }));
}

/* =========================================================
 * STEP 4: PROCESS DOCUMENTS WITH AI
 * ========================================================= */

/**
 * Calls the medical summarization API
 */
async function callSummaryAPI(text, patientId) {
  console.log('Calling summary API');
  const url = 'https://dxgpt-apim.azure-api.net/v1/medical/summarize';
  
  const body = {
    description: text,
    myuuid: generatePatientUUID(patientId),
    timezone: 'Europe/Madrid',
    lang: 'es'
  };

  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': config.DXGPT_SUBSCRIPTION_KEY
  };

  try {
    const response = await axios.post(url, body, { headers });
    
    if (response.data.result === 'success') {
      return response.data.data.summary;
    } else {
      throw new Error(response.data.message || 'API error');
    }
  } catch (error) {
    console.error('Error calling summary API:', error.message);
    return null;
  }
}

/**
 * Processes an individual document with AI
 */
async function processDocumentWithAI(document, patientId) {
  if (!document.fullContent || document.fullContent.length < 100) {
    return null;
  }

  console.log(`Processing document: ${document.name}`);
  
  const textWithContext = `
    Medical Document: ${document.name}
    Date: ${formatDate(document.date)}
    
    CONTENT:
    ${document.fullContent}
  `;

  console.log('Text with context:', textWithContext);


  const summary = await callSummaryAPI(textWithContext, patientId);
  
  if (summary) {
    return {
      documentName: document.name,
      date: document.date,
      aiSummary: summary
    };
  }
  
  return null;
}

/**
 * Processes all patient documents with AI
 */
async function processDocumentsWithAI(documents, patientId) {
  const results = [];

  console.log('processDocumentsWithAI: Processing documents with AI');
  
  for (const doc of documents) {
    console.log('processDocumentsWithAI: Processing document:', doc.name);
    const result = await processDocumentWithAI(doc, patientId);
    if (result) {
      results.push(result);
    }
  }
  
  return results;
}

/* =========================================================
 * STEP 5: BUILD CONTEXT FOR DIAGNOSIS
 * ========================================================= */

/**
 * Builds the patient profile section
 */
function buildProfileSection(profile) {
  let text = 'PATIENT DATA:\n';
  
  if (profile.name) text += `- Name: ${profile.name}\n`;
  if (profile.birthDate) {
    const age = calculateAge(profile.birthDate);
    text += `- Age: ${age}\n`;
    text += `- Birthdate: ${formatDate(profile.birthDate)}\n`;
  }
  if (profile.gender) text += `- Gender: ${profile.gender}\n`;
  if (profile.chronicConditions) text += `- Chronic Conditions: ${profile.chronicConditions}\n`;
  if (profile.allergies) text += `- Allergies: ${profile.allergies}\n`;
  
  return text + '\n';
}

/**
 * Calculates the patient's age
 */
function calculateAge(birthDate) {
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const month = today.getMonth() - birth.getMonth();
  
  if (month < 0 || (month === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  if (age < 2) {
    const months = (today.getFullYear() - birth.getFullYear()) * 12 + 
                  (today.getMonth() - birth.getMonth());
    return `${months} months`;
  }
  
  return `${age} years`;
}

/**
 * Builds the medical events section
 */
function buildEventsSection(events) {
  if (!events || events.length === 0) return '';
  
  let text = 'MEDICAL HISTORY:\n';
  
  const diagnoses = events.filter(e => e.type === 'diagnosis');
  const symptoms = events.filter(e => e.type === 'symptom');
  const medications = events.filter(e => e.type === 'medication');
  
  if (diagnoses.length > 0) {
    text += '\nDiagnoses:\n';
    diagnoses.forEach(d => {
      text += `- ${d.name} (${formatDate(d.date)})`;
      if (d.notes) text += `. ${d.notes}`;
      text += '\n';
    });
  }
  
  if (symptoms.length > 0) {
    text += '\nReported Symptoms:\n';
    symptoms.forEach(s => {
      text += `- ${s.name} (${formatDate(s.date)})`;
      if (s.notes) text += `. ${s.notes}`;
      text += '\n';
    });
  }
  
  if (medications.length > 0) {
    text += '\nMedications:\n';
    medications.forEach(m => {
      text += `- ${m.name} (${formatDate(m.date)})`;
      if (m.notes) text += `. ${m.notes}`;
      text += '\n';
    });
  }
  
  return text + '\n';
}

/**
 * Builds the processed documents section
 */
function buildDocumentsSection(processedDocuments) {
  if (!processedDocuments || processedDocuments.length === 0) return '';
  
  let text = 'MEDICAL DOCUMENTS INFORMATION:\n';
  
  processedDocuments.forEach(doc => {
    text += `\nDocument: ${doc.documentName} (${formatDate(doc.date)})\n`;
    text += `Summary: ${doc.aiSummary}\n`;
  });
  
  return text + '\n';
}

/* =========================================================
 * MAIN FUNCTION
 * ========================================================= */

/**
 * Aggregates the complete clinical context for a patient
 * @param {string} patientId - Patient ID
 * @returns {Promise<string>} Full clinical context as text
 */
async function aggregateClinicalContext(patientId) {
  try {
    console.log(`Starting context aggregation for patient: ${patientId}`);
    
    const profile = await getPatientProfile(patientId);
    const events = await getPatientEvents(patientId);
    const documents = await getPatientDocuments(patientId);
    
    let processedDocuments = [];
    console.log('DXGPT_SUBSCRIPTION_KEY:', config.DXGPT_SUBSCRIPTION_KEY);
    console.log('documents:', documents);
    if (config.DXGPT_SUBSCRIPTION_KEY) {
      console.log('Processing documents with AI');
      processedDocuments = await processDocumentsWithAI(documents, patientId);
    } else {
      console.log('DXGPT_SUBSCRIPTION_KEY not configured - skipping AI processing');
      console.warn('DXGPT_SUBSCRIPTION_KEY not configured - skipping AI processing');
    }
    
    let finalContext = '';
    finalContext += buildProfileSection(profile);
    finalContext += buildEventsSection(events);
    finalContext += buildDocumentsSection(processedDocuments);
    
    console.log(`Context successfully generated. Length: ${finalContext.length} characters`);
    
    return finalContext;
    
  } catch (error) {
    console.error('Error aggregating clinical context:', error);
    throw error;
  }
}

/* =========================================================
 * EXPORT
 * ========================================================= */

module.exports = {
  aggregateClinicalContext
};
