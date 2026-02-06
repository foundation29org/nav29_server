const Events = require('../../../models/events')
const Document = require('../../../models/document')
const Notes = require('../../../models/notes')
const User = require('../../../models/user')
const Patient = require('../../../models/patient')
const crypt = require('../../../services/crypt')
const insights = require('../../../services/insights')
const langchain = require('../../../services/langchain')
const azure_blobs =  require('../../../services/f29azure')
const config = require('../../../config')
const { HumanMessage } = require("@langchain/core/messages");
const countTokens = require('@anthropic-ai/tokenizer');
const Appointments = require('../../../models/appointments')

const MAX_TOKENS = 900000; // Dejamos margen para el prompt y la respuesta

// Helper function to format dates based on language
function formatDate(date, lang = 'en') {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    
    // Spanish and similar languages: DD/MM/YYYY
    // English and others: YYYY-MM-DD (ISO format, universally understood)
    const spanishLocales = ['es', 'es-ES', 'es-MX', 'es-AR', 'pt', 'pt-BR', 'fr', 'it', 'de'];
    
    if (spanishLocales.some(locale => lang?.toLowerCase().startsWith(locale.toLowerCase()))) {
        return `${day}/${month}/${year} ${hours}:${minutes}`;
    }
    return `${month}/${day}/${year} ${hours}:${minutes}`;
}

async function getRecentActivity(req, res) {
  try {
    let patientId = crypt.decrypt(req.params.patientId);
    let userId = crypt.decrypt(req.params.userId);
    
    // Obtener el paciente y el usuario
    const [patient, user] = await Promise.all([
      Patient.findById(patientId),
      User.findById(userId)
    ]);

    if (!patient) {
      return res.status(404).send({ message: 'Patient not found' });
    }

    // Determinar la fecha desde la cual obtener actividad
    let startDate;
    //const oneDayAgo = new Date(Date.now() - 240 * 60 * 60 * 1000);
    if (patient.createdBy.toString() === userId) {
      // Si es el propietario, usar lastUpdated del paciente
      startDate = patient.lastUpdated || patient.createdAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás como máximo
    } else {
      // Buscar en customShare
      const customShareLocation = patient.customShare?.find(share => 
        share.locations?.some(loc => loc.userId === userId)
      )?.locations?.find(loc => loc.userId === userId);

      startDate = customShareLocation?.lastUpdated || customShareLocation?.date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }
    
    // Obtener eventos, documentos y notas desde startDate
    const [recentEvents, recentDocs, recentNotes] = await Promise.all([
      Events.find({
        createdBy: patientId,
        dateInput: { $gte: startDate },
        addedBy: { $ne: userId, $exists: true }
      }).exec(),
      
      Document.find({
        createdBy: patientId,
        date: { $gte: startDate },
        addedBy: { $ne: userId, $exists: true }
      }).exec(),
      
      Notes.find({
        createdBy: patientId,
        date: { $gte: startDate },
        addedBy: { $ne: userId, $exists: true }
      }).exec()
    ]);

    // Obtener información de usuarios después de tener los resultados
    const userIds = Array.from(new Set([
      ...recentEvents.map(event => event.addedBy),
      ...recentDocs.map(doc => doc.addedBy),
      ...recentNotes.map(note => note.addedBy)
    ]));

    const users = await User.find(
      { _id: { $in: userIds } },
      { userName: 1, email: 1 }
    ).exec();

    const userMap = new Map(users.map(user => [user._id.toString(), user]));

    // Obtener los resúmenes de los documentos
    const containerName = crypt.getContainerNameFromEncrypted(req.params.patientId);
    const documentSummaries = await Promise.all(recentDocs.map(async doc => {
      try {
        //const summaryUrl = doc.url.replace(/\/[^\/]*$/, '/summary_translated.txt');
        //const summaryUrl = doc.url.replace(/\/[^\/]*$/, '/extracted_translated.txt');
        const summaryUrl = doc.url.replace(/\/[^\/]*$/, '/extracted.txt');
        const summary = await azure_blobs.downloadBlob(containerName, summaryUrl);
        return { docId: doc._id, summary };
      } catch (error) {
        insights.error(`Error getting summary for document ${doc._id}: ${error}`);
        return { docId: doc._id, summary: null };
      }
    }));

    const docSummaryMap = new Map(documentSummaries.map(doc => [doc.docId.toString(), doc.summary]));

    // Formatear la respuesta con los resúmenes incluidos
    const formattedEvents = recentEvents.map(event => ({
      type: 'event',
      name: event.name,
      date: event.dateInput,      // When the event was added
      eventDate: event.date,       // When the event will occur (e.g., appointment date)
      addedBy: {
        userName: userMap.get(event.addedBy.toString())?.userName || 'Unknown',
        email: userMap.get(event.addedBy.toString())?.email || 'Unknown'
      }
    }));

    const formattedDocs = recentDocs.map(doc => ({
      type: 'document',
      name: doc.url.split('/').pop(),
      date: doc.date,
      summary: docSummaryMap.get(doc._id.toString()),
      addedBy: {
        userName: userMap.get(doc.addedBy.toString())?.userName || 'Unknown',
        email: userMap.get(doc.addedBy.toString())?.email || 'Unknown'
      }
    }));

    const formattedNotes = recentNotes.map(note => ({
      type: 'note',
      content: note.content,
      date: note.date,
      addedBy: {
        userName: userMap.get(note.addedBy.toString())?.userName || 'Unknown',
        email: userMap.get(note.addedBy.toString())?.email || 'Unknown'
      }
    }));

    // Combinar y ordenar por fecha
    const allActivity = [...formattedEvents, ...formattedDocs, ...formattedNotes]
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    if(allActivity.length == 0){
        return res.status(200).send({
            activity: allActivity,
            summary: 'No recent activity'
        })
    }else{
        // Obtener el rol del usuario y generar el resumen
        let rolePrompt = '';
        switch(user.role) {
            case 'Clinical':
              rolePrompt = 'Generate a technical and detailed summary aimed at clinical professionals, including relevant medical terms and highlighting important findings from the documents.';
              break;
            case 'User':
              rolePrompt = 'Generate a simple and easy-to-understand summary for patients, avoiding complex medical jargon and explaining concepts clearly.';
              break;
            default:
              rolePrompt = `Generate a caregiver-oriented summary that:
              1. Focuses on practical and relevant information for daily care
              2. Explains medical terms in a simple and understandable way
              3. Highlights important aspects that require attention or follow-up
              4. Avoids unnecessary technical details
              5. Includes practical recommendations if available
              6. Summarizes medical documents in a very simplified way, focusing on "what this means for patient care"`;
          }

        // Obtener el idioma preferido del usuario
        const responseLanguage = user.preferredResponseLanguage || user.lang;

        const projectName = `${config.LANGSMITH_PROJECT} - ${patientId}`;
        const { gemini3propreview } = await langchain.createModels(projectName, 'gemini3propreview');

        // Actualizar lastUpdated
        const now = new Date();
        if (patient.createdBy.toString() === userId) {
          await Patient.findByIdAndUpdate(patientId, { lastUpdated: now });
        } else {
          const customShareIndex = patient.customShare?.findIndex(share => 
            share.locations?.some(loc => loc.userId === userId)
          );

          if (customShareIndex !== -1) {
            const locationIndex = patient.customShare[customShareIndex].locations.findIndex(
              loc => loc.userId === userId
            );

            if (locationIndex !== -1) {
              await Patient.findOneAndUpdate(
                { _id: patientId },
                { 
                  $set: { 
                    [`customShare.${customShareIndex}.locations.${locationIndex}.lastUpdated`]: now 
                  } 
                }
              );
            }
          }
        }

        // Calcular el período de tiempo
        const diffTime = Math.abs(now - startDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        let timePeriod;
        if (diffDays <= 1) {
          timePeriod = 'last24h';
        } else if (diffDays <= 7) {
          timePeriod = 'lastWeek';
        } else if (diffDays <= 30) {
          timePeriod = 'lastMonth';
        } else {
          // Si es más de un mes, devolvemos la fecha exacta
          timePeriod = 'fromDate';
        }

        const activityChunks = chunkActivities(allActivity, MAX_TOKENS, responseLanguage);
        let summaries = [];

        for (const chunk of activityChunks) {
            const activityText = chunk.map(item => {
                const createdDate = formatDate(item.date, responseLanguage);
                switch(item.type) {
                    case 'event':
                        const eventDateStr = item.eventDate ? formatDate(item.eventDate, responseLanguage) : null;
                        if (eventDateStr) {
                            return `[Added on ${createdDate}] ${item.addedBy.userName} scheduled an event for ${eventDateStr}: ${item.name}`;
                        }
                        return `[Added on ${createdDate}] ${item.addedBy.userName} added an event: ${item.name}`;
                    case 'document':
                        return `[Added on ${createdDate}] ${item.addedBy.userName} uploaded a document: ${item.name}${item.summary ? `\nDocument summary: ${item.summary}` : ''}`;
                    case 'note':
                        return `[Added on ${createdDate}] ${item.addedBy.userName} added a note: ${item.content}`;
                }
            }).join('\n\n');

            const promptText = `
            Based on the following list of recent activities:

            ${activityText}
            
            ${rolePrompt}
            
            IMPORTANT: Each activity shows two dates:
            - "Added on [date]" = when the activity was registered in the system
            - "scheduled for [date]" = when the event/appointment will actually occur (this is the important date for the patient)
            
            When summarizing events/appointments, always emphasize the SCHEDULED DATE (when it will occur), not the creation date.
            
            Generate a structured summary in HTML using the following rules:
            1. Use <h4> for main titles
            2. Use <h5> for subtitles
            3. Use <p> for text paragraphs
            4. Use <ul> and <li> for item lists
            5. Use <strong> to emphasize important information, especially scheduled dates
            6. Use <div class="section"> to separate different sections
            7. The summary should be concise and maintain a clear chronological structure
            8. Include a "Highlighted Activities" section at the beginning
            9. If there are medical documents, include a "Medical Summaries" section
            10. If there are notes, include an "Important Notes" section
            11. For appointments/events, clearly state when they will occur using the scheduled date

            Return only the HTML in ${responseLanguage}, without markdown or other formats.`;

            const messages = [new HumanMessage({ content: promptText })];
            const summary = await gemini3propreview.invoke(messages);
            summaries.push(summary.content.replace(/```html/g, '').replace(/```/g, ''));
        }

        // Combinar los resúmenes
        const combinedSummary = `
        <div class="combined-summary">
            ${summaries.join('\n<hr class="summary-separator">\n')}
        </div>`;

        res.status(200).send({ 
            activity: allActivity,
            summary: combinedSummary,
            patientId: req.params.patientId,
            period: {
                type: timePeriod,
                days: diffDays,
                startDate: startDate.toISOString()
            }
        });
    }
    

  } catch (err) {
    insights.error(err);
    return res.status(500).send({ message: `Error getting recent activity: ${err}` });
  }
}

// Helper function to split activity array into chunks
function chunkActivities(activities, maxTokens, lang = 'en') {
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;

    for (const activity of activities) {
        let activityDescription;
        const createdDate = formatDate(activity.date, lang);
        
        if (activity.type === 'event') {
            const eventDateStr = activity.eventDate ? formatDate(activity.eventDate, lang) : null;
            activityDescription = eventDateStr 
                ? `scheduled an event for ${eventDateStr}: ${activity.name}`
                : `added an event: ${activity.name}`;
        } else if (activity.type === 'document') {
            activityDescription = `uploaded a document: ${activity.name}${activity.summary ? `\nDocument summary: ${activity.summary}` : ''}`;
        } else {
            activityDescription = `added a note: ${activity.content}`;
        }
        
        const activityText = `[Added on ${createdDate}] ${activity.addedBy.userName} ${activityDescription}`;

        const tokens = countTokens.countTokens(activityText);
        
        if (currentTokens + tokens > maxTokens) {
            chunks.push(currentChunk);
            currentChunk = [activity];
            currentTokens = tokens;
        } else {
            currentChunk.push(activity);
            currentTokens += tokens;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

async function getRecentAppointments(req, res) {
  try {
    let patientId = crypt.decrypt(req.params.patientId);
    let userId = crypt.decrypt(req.params.userId);

     // Obtener el paciente y el usuario
     const [patient] = await Promise.all([
      Patient.findById(patientId)
    ]);

    if (!patient) {
      return res.status(404).send({ message: 'Patient not found' });
    }

    // Determinar la fecha desde la cual obtener actividad
    let startDate;
    //const oneDayAgo = new Date(Date.now() - 240 * 60 * 60 * 1000);
    if (patient.createdBy.toString() === userId) {
      // Si es el propietario, usar lastUpdated del paciente
      startDate = patient.lastUpdated || patient.createdAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 días atrás como máximo
    } else {
      // Buscar en customShare
      const customShareLocation = patient.customShare?.find(share => 
        share.locations?.some(loc => loc.userId === userId)
      )?.locations?.find(loc => loc.userId === userId);

      startDate = customShareLocation?.lastUpdated || customShareLocation?.date || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }
    

    const appointments = await Appointments.find({
      createdBy: patientId,
      dateInput: { $gte: startDate },
      addedBy: { $ne: userId, $exists: true }
    }).exec();

    // Actualizar lastUpdated
    const now = new Date();
    if (patient.createdBy.toString() === userId) {
      await Patient.findByIdAndUpdate(patientId, { lastUpdated: now });
    } else {
      const customShareIndex = patient.customShare?.findIndex(share => 
        share.locations?.some(loc => loc.userId === userId)
      );

      if (customShareIndex !== -1) {
        const locationIndex = patient.customShare[customShareIndex].locations.findIndex(
          loc => loc.userId === userId
        );

        if (locationIndex !== -1) {
          await Patient.findOneAndUpdate(
            { _id: patientId },
            { 
              $set: { 
                [`customShare.${customShareIndex}.locations.${locationIndex}.lastUpdated`]: now 
              } 
            }
          );
        }
      }
    }

    res.status(200).send({patientId: req.params.patientId, 
      appointments: appointments.length > 0 ? appointments : []
    });

  } catch (err) {
    insights.error(err);
    return res.status(500).send({ message: `Error getting recent appointments: ${err}` });
  }
}


module.exports = {
  getRecentActivity,
  getRecentAppointments
} 