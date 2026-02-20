// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Events = require('../../../models/events')
const Document = require('../../../models/document')
const Patient = require('../../../models/patient')
const crypt = require('../../../services/crypt')
const insights = require('../../../services/insights')
const langchain = require('../../../services/langchain')
const f29azureService = require("../../../services/f29azure")
const { getOrGenerateTimeline, invalidateTimelineCache } = require('../../../services/timelineConsolidationService')
// Aquí puedes añadir más campos si los necesitas...

async function getEventsDate(req, res) {
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		var period = 31;
		if (req.body.rangeDate == 'quarter') {
			period = 90;
		} else if (req.body.rangeDate == 'year') {
			period = 365;
		}
		var actualDate = new Date();
		var actualDateTime = actualDate.getTime();

		var pastDate = new Date(actualDate);
		pastDate.setDate(pastDate.getDate() - period);
		var pastDateDateTime = pastDate.getTime();
		
		const eventsdb = await Events.find(
			{ "createdBy": patientId, "date": { "$gte": pastDateDateTime, "$lt": actualDateTime } }
		).select('-createdBy -addedBy');
		
		var listEventsdb = [];
		eventsdb.forEach(function (eventdb) {
			listEventsdb.push(eventdb);
		});
		res.status(200).send(listEventsdb)
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error making the request: ${err}` })
	}
}

async function getEvents(req, res) {
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		const eventsdb = await Events.find({ "createdBy": patientId }).select('-createdBy -addedBy');
		
		const listEventsdb = eventsdb ? eventsdb
			.filter(event => event.status !== 'deleted')
			.map(event => {
				const eventObj = event.toObject();
				eventObj._id = crypt.encrypt(eventObj._id.toString());
				if (eventObj.docId) {
					eventObj.docId = crypt.encrypt(eventObj.docId.toString());
				}
				// Marcar eventos que necesitan revisión de fecha (sin fecha o con fecha estimada)
				if ((eventObj.date === null && eventObj.dateConfidence === 'missing') || 
				    eventObj.dateConfidence === 'estimated') {
					eventObj.needsDateReview = true;
				}
				return eventObj;
			}) : [];
		res.status(200).send(listEventsdb)
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error making the request: ${err}` })
	}
}

async function getEventsDocument(req, res) {
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let docId = crypt.decrypt(req.body.docId);
		const eventsdb = await Events.find({ "createdBy": patientId, "docId": docId }).select('-createdBy -addedBy');
		
		const listEventsdb = eventsdb ? eventsdb.map(event => {
			const eventObj = event.toObject();
			eventObj._id = crypt.encrypt(eventObj._id.toString());
			if (eventObj.docId) {
				eventObj.docId = crypt.encrypt(eventObj.docId.toString());
			}
			// Marcar eventos que necesitan revisión de fecha (sin fecha o con fecha estimada)
			if ((eventObj.date === null && eventObj.dateConfidence === 'missing') || 
			    eventObj.dateConfidence === 'estimated') {
				eventObj.needsDateReview = true;
			}
			return eventObj;
		}) : [];
		res.status(200).send(listEventsdb)
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error making the request: ${err}` })
	}
}

async function updateEventDocument(req, res) {
	try {
		let eventId = crypt.decrypt(req.params.eventId);
		const eventdbUpdated = await Events.findByIdAndUpdate(eventId, { status: req.body.status }, { new: true });
		if (eventdbUpdated) {
			await invalidateTimelineCache(eventdbUpdated.createdBy.toString()).catch(() => {});
			let containerName = crypt.getContainerName(eventdbUpdated.createdBy.toString());
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			res.status(200).send({ message: 'Eventdb updated' })
		} else {
			res.status(2022).send({ message: `Error updating the eventdb` })
		}
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error making the request: ${err}` });
	}
}

async function getEventsContext(patientId) {
	try {
		const eventsdb = await Events.find(
			{ "createdBy": patientId, "key": { "$exists": true } }
		).select('-createdBy -addedBy');
		return eventsdb || [];
	} catch (err) {
		insights.error(err);
		return [];
	}
}

async function saveEvent(req, res) {
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let userId = crypt.decrypt(req.params.userId);
		let eventdb = new Events()
		eventdb.date = req.body.date
		eventdb.dateEnd = req.body.dateEnd || null
		eventdb.name = req.body.name
		eventdb.notes = req.body.notes
		eventdb.key = req.body.key
		eventdb.createdBy = patientId
		eventdb.addedBy = userId
		const eventdbStored = await eventdb.save();
		
		if (eventdbStored) {
			await invalidateTimelineCache(patientId).catch(() => {});
			let containerName = crypt.getContainerNameFromEncrypted(req.params.patientId);
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			res.status(200).send({ message: 'Eventdb created'})
		} else {
			insights.error('Error saving the eventdb');
			res.status(500).send({ message: `Error saving the eventdb` })
		}
	} catch (err) {
		insights.error(err);
		res.status(500).send({ message: `Failed to save in the database: ${err} ` })
	}
}

async function saveEventDoc(req, res) {
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let userId = crypt.decrypt(req.params.userId);
		let eventdb = new Events()
		eventdb.date = req.body.date
		eventdb.dateEnd = req.body.dateEnd || null
		eventdb.name = req.body.name
		eventdb.key = req.body.key
		eventdb.createdBy = patientId
		eventdb.docId = crypt.decrypt(req.body.docId)
		eventdb.status = req.body.status
		eventdb.addedBy = userId
		const eventdbStored = await eventdb.save();
		
		if (eventdbStored) {
			await invalidateTimelineCache(patientId).catch(() => {});
			let containerName = crypt.getContainerNameFromEncrypted(req.params.patientId);
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			res.status(200).send({ message: 'Eventdb created'})
		} else {
			insights.error('Error saving the eventdb');
			console.log(eventdbStored);
			res.status(500).send({ message: `Error saving the eventdb` })
		}
	} catch (err) {
		insights.error(err);
		res.status(500).send({ message: `Failed to save in the database: ${err} ` })
	}
}

async function saveEventForm(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
	let userId = crypt.decrypt(req.params.userId);
	let events = req.body.events; // Suponiendo que los eventos vienen en un arreglo en req.body.events

    let promises = events.map(async (event) => {
        let eventdb = new Events();
        eventdb.date = event.date || new Date(); // Asignar fecha actual si no se proporciona
        eventdb.dateEnd = event.dateEnd || null;
        eventdb.name = event.name;
        eventdb.notes = event.notes || '';
        eventdb.key = event.key;
        eventdb.origin = 'wizard';
        eventdb.createdBy = patientId;
		eventdb.addedBy = userId;

        if (eventdb.key == 'diagnosis' || eventdb.key == 'medication') {
            let list = await langchain.divideElements(eventdb, patientId);
            let itemPromises = list.map((item) => {
                let eventdb2 = new Events();
                eventdb2.date = eventdb.date;
                eventdb2.dateEnd = eventdb.dateEnd;
                eventdb2.name = item;
                eventdb2.notes = eventdb.notes;
                eventdb2.key = eventdb.key;
                eventdb2.origin = 'wizard';
                eventdb2.createdBy = patientId;
				eventdb2.addedBy = userId;
                return saveOne(eventdb2);
            });
            return Promise.all(itemPromises);
        } else {
            return saveOne(eventdb);
        }
    });

    try {
        let results = await Promise.all(promises);
        // Aplanar el arreglo de resultados en caso de que haya sub-arreglos de promesas resueltas
        let flattenedResults = results.flat();
        await invalidateTimelineCache(patientId).catch(() => {});
        res.status(200).send({ message: 'Eventdb created', eventdb: flattenedResults });
    } catch (err) {
        insights.error(err);
        res.status(500).send({ message: `Failed to save in the database: ${err}` });
    }
}

async function saveOne(eventdb){
	try {
		await eventdb.save();
		return { message: 'Eventdb created' };
	} catch (err) {
		insights.error(err);
		return { message: `Failed to save in the database: ${err} ` };
	}
}

async function updateEvent(req, res) {
	try {
		let eventId = crypt.decrypt(req.params.eventId);
		let userId = crypt.decrypt(req.params.userId);
		let update = { ...req.body };
		update.addedBy = userId;
		// Eliminar _id y __v del objeto de actualización
		delete update._id;
		delete update.__v;
		// Desencriptar docId si existe
		if (update.docId) {
			update.docId = crypt.decrypt(update.docId);
		}

		// Si se está actualizando la fecha y antes era null/missing o estimated, marcar como user_provided
		if (update.date !== undefined && update.date !== null) {
			// Obtener el evento actual para verificar su estado anterior
			const currentEvent = await Events.findById(eventId);
			if (currentEvent && (currentEvent.date === null || 
			    currentEvent.dateConfidence === 'missing' || 
			    currentEvent.dateConfidence === 'estimated')) {
				update.dateConfidence = 'user_provided';
			}
		}

		const eventdbUpdated = await Events.findByIdAndUpdate(eventId, update, { new: true });
		if (!eventdbUpdated) {
			return res.status(404).send({ message: 'Event not found' });
		}

		const eventObj = eventdbUpdated.toObject();
		eventObj._id = crypt.encrypt(eventObj._id.toString());
		if (eventObj.docId) {
			eventObj.docId = crypt.encrypt(eventObj.docId.toString());
		}
		// Marcar si aún necesita revisión (sin fecha o con fecha estimada)
		if ((eventObj.date === null && eventObj.dateConfidence === 'missing') || 
		    eventObj.dateConfidence === 'estimated') {
			eventObj.needsDateReview = true;
		}
		await invalidateTimelineCache(eventdbUpdated.createdBy.toString()).catch(() => {});
		let containerName = crypt.getContainerName(eventdbUpdated.createdBy.toString());
		var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
		//dont return the createdBy field
		delete eventObj.createdBy;
		delete eventObj.addedBy;
		res.status(200).send({ message: 'Eventdb updated', eventdb: eventObj })
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error making the request: ${err}` })
	}
}


async function deleteEvent(req, res) {
	try {
		let eventId = crypt.decrypt(req.params.eventId)

		const eventdb = await Events.findById(eventId);
		if (eventdb) {
			await invalidateTimelineCache(eventdb.createdBy.toString()).catch(() => {});
			let containerName = crypt.getContainerName(eventdb.createdBy.toString());
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			await Events.deleteOne({ _id: eventId });
			res.status(200).send({ message: `The eventdb has been deleted` })
		} else {
			insights.error('Error deleting the eventdb: eventdb not found');
			return res.status(404).send({ code: 208, message: `Error deleting the eventdb: not found` })
		}
	} catch (err) {
		insights.error(err);
		return res.status(500).send({ message: `Error making the request: ${err}` })
	}
}

async function deleteAllEvents(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
    try {
        await Events.deleteMany({ 'createdBy': patientId });
        await invalidateTimelineCache(patientId).catch(() => {});
        res.status(200).send({ message: `The eventdb has been deleted` });
    } catch (err) {
		insights.error(err);
        console.log({message: `Error finding the events: ${err}`});
        res.status(500).send({ message: `Error deleting events: ${err}` });
    }
}

async function deleteEvents(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
    let eventsSelected = req.body.eventsIds.map(id => crypt.decrypt(id));
    
    try {
        await Events.deleteMany({ 
            'createdBy': patientId,
            '_id': { $in: eventsSelected }
        });
        
        await invalidateTimelineCache(patientId).catch(() => {});
        let containerName = crypt.getContainerNameFromEncrypted(req.params.patientId);
        var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
        res.status(200).send({ message: `The eventdb has been deleted` });
    } catch (err) {
        insights.error(err);
        console.log({message: `Error finding the events: ${err}`});
        res.status(500).send({ message: `Error deleting events: ${err}` });
    }
}


async function explainMedicalEvent(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let input = req.body.input
	try {
		let explain = await langchain.explainMedicalEvent(input, patientId);
		res.status(200).send({msg: explain })
	} catch (err) {
		insights.error(err);
		res.status(500).send({ message: `Failed to explain: ${err} ` })
	}

}

/**
 * GET /api/timeline/consolidated/:patientId
 * Obtiene el timeline consolidado (cacheado o generado)
 */
async function getConsolidatedTimeline(req, res) {
	try {
		const patientId = crypt.decrypt(req.params.patientId);
		const userLang = req.query.lang || 'es';
		const forceRegenerate = req.query.regenerate === 'true';
		
		console.log(`[Timeline] Solicitando timeline consolidado para ${patientId}, lang=${userLang}, force=${forceRegenerate}`);
		
		const timeline = await getOrGenerateTimeline(patientId, userLang, forceRegenerate);
		
		res.status(200).json(timeline);
	} catch (error) {
		console.error('[Timeline] Error:', error);
		insights.error({ message: 'Error getting consolidated timeline', error: error.message });
		res.status(500).json({ 
			success: false, 
			message: 'Error generating timeline',
			error: error.message 
		});
	}
}

/**
 * POST /api/timeline/regenerate/:patientId
 * Fuerza la regeneración del timeline consolidado
 */
async function regenerateConsolidatedTimeline(req, res) {
	try {
		const patientId = crypt.decrypt(req.params.patientId);
		const userLang = req.body.lang || req.query.lang || 'es';
		
		console.log(`[Timeline] Regenerando timeline para ${patientId}`);
		
		// Invalidar caché primero
		await invalidateTimelineCache(patientId);
		
		// Generar nuevo
		const timeline = await getOrGenerateTimeline(patientId, userLang, true);
		
		res.status(200).json(timeline);
	} catch (error) {
		console.error('[Timeline] Error regenerando:', error);
		insights.error({ message: 'Error regenerating timeline', error: error.message });
		res.status(500).json({ 
			success: false, 
			message: 'Error regenerating timeline',
			error: error.message 
		});
	}
}

module.exports = {
	getEventsDate,
	getEvents,
	getEventsDocument,
	updateEventDocument,
	getEventsContext,
	saveEvent,
	saveEventDoc,
	saveEventForm,
	updateEvent,
	deleteEvent,
	deleteAllEvents,
	deleteEvents,
	explainMedicalEvent,
	getConsolidatedTimeline,
	regenerateConsolidatedTimeline
}
