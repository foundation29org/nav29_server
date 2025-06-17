const Patient = require('../models/patient');
const User = require('../models/user');
const Document = require('../models/document');
const Events = require('../models/events');
const PatientNotes = require('../models/notes');

async function aggregatePatientContext(patientId) {
  try {
    console.log('=== PATIENT CONTEXT DEBUG START ===');
    console.log('Patient ID:', patientId);
    
    const contextData = {};

    // Fetch Patient Profile
    console.log('Fetching patient profile...');
    const patient = await Patient.findById(patientId);
    if (!patient) {
      console.log('ERROR: Patient not found');
      throw new Error('Patient not found');
    }
    console.log('Patient found:', patient.patientName);

    contextData.patientProfile = {
      patientName: patient.patientName,
      birthDate: patient.birthDate,
      gender: patient.gender,
      chronicConditions: patient.chronicConditions,
      allergies: patient.allergies
    };

    const userId = patient.createdBy;
    console.log('User ID from patient:', userId);

    // Fetch User Preferences
    console.log('Fetching user preferences...');
    const user = await User.findById(userId);
    if (!user) {
      console.warn(`User not found for userId: ${userId}`);
    } else {
      console.log('User found:', user.email, 'Role:', user.role);
      contextData.userPreferences = {
        lang: user.lang,
        role: user.role,
        medicalLevel: user.medicalLevel
      };
    }

    // Fetch relevant Documents
    console.log('Fetching documents...');
    const documents = await Document.find({
      createdBy: patientId,
      status: { $in: ['finished', 'processed'] }
    })
    // .sort({ createdDate: -1 }) // TEMP: Comentado por problema de índices en CosmosDB
    .limit(5);

    console.log(`Found ${documents.length} documents`);
    contextData.documents = documents.map(doc => ({
      originalName: doc.originalName,
      categoryTag: doc.categoryTag,
      summary: doc.summary || (doc.extractedText ? doc.extractedText.substring(0, 500) : ''),
      date: doc.createdDate
    }));

    if (contextData.documents.length === 0) {
      console.log(`No documents found for patient ${patientId}`);
    }

    // Fetch key Events
    console.log(`Fetching events for patientId: ${patientId}`);
    let events = [];
    try {
      events = await Events.find({
        createdBy: patientId,
        key: { $in: ['diagnosis', 'medication', 'symptom'] }
      })
      // .sort({ date: -1 }) // TEMP: Comentado por problema de índices en CosmosDB
      .limit(30);
      console.log(`Found ${events.length} events`);
    } catch (eventsError) {
      console.error('Error fetching events:', eventsError);
      console.error('Events query params:', { createdBy: patientId });
      throw eventsError;
    }

    contextData.events = events.map(event => ({
      name: event.name,
      date: event.date,
      key: event.key,
      notes: event.notes && event.notes.length < 200 ? event.notes : ''
    }));

    if (contextData.events.length === 0) {
      console.log(`No events found for patient ${patientId}`);
    }

    // Fetch Patient Notes
    console.log(`Fetching patient notes for patientId: ${patientId}`);
    let patientNotes = [];
    try {
      patientNotes = await PatientNotes.find({
        createdBy: patientId
      })
      // .sort({ date: -1 }) // TEMP: Comentado por problema de índices en CosmosDB
      .limit(10);
      console.log(`Found ${patientNotes.length} patient notes`);
    } catch (notesError) {
      console.error('Error fetching patient notes:', notesError);
      console.error('PatientNotes query params:', { createdBy: patientId });
      throw notesError;
    }

    contextData.patientNotes = patientNotes.map(note => ({
      date: note.date,
      content: note.content
    }));

    if (contextData.patientNotes.length === 0) {
      console.log(`No patient notes found for patient ${patientId}`);
    }

    // Format context data into a structured string
    console.log('Formatting context data...');
    let formattedContext = '';

    // Patient Profile section
    if (contextData.patientProfile) {
      formattedContext += '=== PATIENT PROFILE ===\n';
      formattedContext += `Name: ${contextData.patientProfile.patientName || 'N/A'}\n`;
      formattedContext += `DoB: ${contextData.patientProfile.birthDate ? new Date(contextData.patientProfile.birthDate).toLocaleDateString() : 'N/A'}\n`;
      formattedContext += `Gender: ${contextData.patientProfile.gender || 'N/A'}\n`;
      if (contextData.patientProfile.chronicConditions) {
        formattedContext += `Chronic Conditions: ${contextData.patientProfile.chronicConditions}\n`;
      }
      if (contextData.patientProfile.allergies) {
        formattedContext += `Allergies: ${contextData.patientProfile.allergies}\n`;
      }
      if (contextData.userPreferences && contextData.userPreferences.medicalLevel) {
        formattedContext += `User Medical Knowledge Level: ${contextData.userPreferences.medicalLevel}\n`;
      }
      formattedContext += '\n';
    }

    // Key Medical Events section
    if (contextData.events && contextData.events.length > 0) {
      formattedContext += '=== KEY MEDICAL EVENTS (Recent First) ===\n';
      contextData.events.forEach(event => {
        formattedContext += `- Event: ${event.name} (${event.key}) on ${new Date(event.date).toLocaleDateString()}`;
        if (event.notes) {
          formattedContext += `. Notes: ${event.notes}`;
        }
        formattedContext += '\n';
      });
      formattedContext += '\n';
    }

    // Relevant Documents section
    if (contextData.documents && contextData.documents.length > 0) {
      formattedContext += '=== RELEVANT DOCUMENTS (Summaries) ===\n';
      contextData.documents.forEach(doc => {
        formattedContext += `Document: ${doc.originalName}`;
        if (doc.categoryTag) {
          formattedContext += ` (Category: ${doc.categoryTag})`;
        }
        formattedContext += '\n';
        if (doc.summary) {
          formattedContext += `Summary: ${doc.summary}\n`;
        }
        formattedContext += '\n';
      });
    }

    // Recent Patient Notes section
    if (contextData.patientNotes && contextData.patientNotes.length > 0) {
      formattedContext += '=== RECENT PATIENT NOTES ===\n';
      contextData.patientNotes.forEach(note => {
        formattedContext += `- Note on ${new Date(note.date).toLocaleDateString()}: ${note.content}\n`;
      });
      formattedContext += '\n';
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`Successfully aggregated context for patient ${patientId}, length: ${formattedContext.length} characters`);
    }
    
    console.log('=== PATIENT CONTEXT DEBUG END SUCCESS ===');
    return formattedContext;
  } catch (error) {
    console.log('=== PATIENT CONTEXT DEBUG ERROR ===');
    console.error('Error aggregating patient context:', error);
    console.error('Patient ID:', patientId);
    console.error('Error stack:', error.stack);
    throw error;
  }
}

module.exports = {
  aggregatePatientContext
};