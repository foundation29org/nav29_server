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
      return res.status(404).send({ message: 'Paciente no encontrado' });
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
      date: event.dateInput,
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
            summary: 'No hay actividad reciente'
        })
    }else{
        // Obtener el rol del usuario y generar el resumen
        let rolePrompt = '';
        switch(user.role) {
            case 'Clinical':
              rolePrompt = 'Genera un resumen técnico y detallado orientado a profesionales clínicos, incluyendo términos médicos relevantes y destacando hallazgos importantes de los documentos.';
              break;
            case 'User':
              rolePrompt = 'Genera un resumen simple y fácil de entender para pacientes, evitando jerga médica compleja y explicando los conceptos de manera clara.';
              break;
            default:
              rolePrompt = `Genera un resumen orientado a cuidadores que:
              1. Se centre en información práctica y relevante para el cuidado diario
              2. Explique los términos médicos de forma simple y comprensible
              3. Destaque aspectos importantes que requieran atención o seguimiento
              4. Evite detalles técnicos innecesarios
              5. Incluya recomendaciones prácticas si las hay
              6. Resuma los documentos médicos de manera muy simplificada, enfocándose en "qué significa esto para el cuidado del paciente"`;
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

        const activityChunks = chunkActivities(allActivity, MAX_TOKENS);
        let summaries = [];

        for (const chunk of activityChunks) {
            const activityText = chunk.map(item => {
                const date = new Date(item.date).toLocaleString();
                switch(item.type) {
                    case 'event':
                        return `[${date}] ${item.addedBy.userName} añadió un evento: ${item.name}`;
                    case 'document':
                        return `[${date}] ${item.addedBy.userName} subió un documento: ${item.name}${item.summary ? `\nResumen del documento: ${item.summary}` : ''}`;
                    case 'note':
                        return `[${date}] ${item.addedBy.userName} añadió una nota: ${item.content}`;
                }
            }).join('\n\n');

            const promptText = `
            Basándote en la siguiente lista de actividades recientes:

            ${activityText}
            
            ${rolePrompt}
            
            Genera un resumen estructurado en HTML usando las siguientes reglas:
            1. Usa <h4> para los títulos principales
            2. Usa <h5> para subtítulos
            3. Usa <p> para párrafos de texto
            4. Usa <ul> y <li> para listas de elementos
            5. Usa <strong> para enfatizar información importante
            6. Usa <div class="section"> para separar secciones diferentes
            7. El resumen debe ser conciso y mantener una estructura cronológica clara
            8. Incluye una sección de "Actividades Destacadas" al inicio
            9. Si hay documentos médicos, incluye una sección de "Resúmenes Médicos"
            10. Si hay notas, incluye una sección de "Notas Importantes"

            Devuelve solo el HTML en ${responseLanguage}, sin markdown ni otros formatos.`;

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
    return res.status(500).send({ message: `Error obteniendo la actividad reciente: ${err}` });
  }
}

// Función auxiliar para dividir el array de actividades en chunks
function chunkActivities(activities, maxTokens) {
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;

    for (const activity of activities) {
        const activityText = `[${new Date(activity.date).toLocaleString()}] ${activity.addedBy.userName} ${
            activity.type === 'event' ? `añadió un evento: ${activity.name}` :
            activity.type === 'document' ? `subió un documento: ${activity.name}${activity.summary ? `\nResumen del documento: ${activity.summary}` : ''}` :
            `añadió una nota: ${activity.content}`
        }`;

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
      return res.status(404).send({ message: 'Paciente no encontrado' });
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
    return res.status(500).send({ message: `Error obteniendo las citas recientes: ${err}` });
  }
}


module.exports = {
  getRecentActivity,
  getRecentAppointments
} 