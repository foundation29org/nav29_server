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
// Aquí puedes añadir más campos si los necesitas...

function getEventsDate(req, res) {
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
	//Events.find({createdBy: patientId}).sort({ start : 'desc'}).exec(function(err, eventsdb){
	Events.find({ "createdBy": patientId, "date": { "$gte": pastDateDateTime, "$lt": actualDateTime } }, { "createdBy": false, "addedBy": false }, (err, eventsdb) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		var listEventsdb = [];

		eventsdb.forEach(function (eventdb) {
			listEventsdb.push(eventdb);
		});
		res.status(200).send(listEventsdb)
	});
}

async function getEvents(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	Events.find({ "createdBy": patientId }, { "createdBy": false, "addedBy": false }, (err, eventsdb) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		const listEventsdb = eventsdb ? eventsdb
			.filter(event => event.status !== 'deleted')
			.map(event => {
				const eventObj = event.toObject();
				eventObj._id = crypt.encrypt(eventObj._id.toString());
				if (eventObj.docId) {
					eventObj.docId = crypt.encrypt(eventObj.docId.toString());
				}
				return eventObj;
			}) : [];
		res.status(200).send(listEventsdb)
	});
}

async function getEventsDocument(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let docId = crypt.decrypt(req.body.docId);
	Events.find({ "createdBy": patientId, "docId": docId }, { "createdBy": false, "addedBy": false }, (err, eventsdb) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		const listEventsdb = eventsdb ? eventsdb.map(event => {
			const eventObj = event.toObject();
			eventObj._id = crypt.encrypt(eventObj._id.toString());
			if (eventObj.docId) {
				eventObj.docId = crypt.encrypt(eventObj.docId.toString());
			}
			return eventObj;
		}) : [];
		res.status(200).send(listEventsdb)
	});
}

async function updateEventDocument(req, res) {
	try {
		let eventId = crypt.decrypt(req.params.eventId);
		const eventdbUpdated = await Events.findByIdAndUpdate (eventId,{ status: req.body.status}, { new: true });
		if (eventdbUpdated) {
			let patientIdEncrypted = crypt.encrypt(eventdbUpdated.createdBy.toString());
			let containerName = patientIdEncrypted.substr(1).toString();
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
	return new Promise(async function (resolve, reject) {
		Events.find({ "createdBy": patientId, "key": { "$exists": true } }, { "createdBy": false, "addedBy": false }, (err, eventsdb) => {
			var listEventsdb = [];
			if (err){
				insights.error(err);
				resolve(listEventsdb);
			}else{
				listEventsdb = eventsdb;
				resolve(listEventsdb);
			}
		});
	});
}

function saveEvent(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let userId = crypt.decrypt(req.params.userId);
	let eventdb = new Events()
	eventdb.date = req.body.date
	eventdb.name = req.body.name
	eventdb.notes = req.body.notes
	eventdb.key = req.body.key
	eventdb.createdBy = patientId
	eventdb.addedBy = userId
	eventdb.save(async (err, eventdbStored) => {
		if (err) {
			insights.error(err);
			res.status(500).send({ message: `Failed to save in the database: ${err} ` })
		}
		if (eventdbStored) {
			let containerName = req.params.patientId.substr(1).toString();
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			res.status(200).send({ message: 'Eventdb created'})
		}else{
			insights.error('Error saving the eventdb');
			res.status(500).send({ message: `Error saving the eventdb` })
		}
	})
}

function saveEventDoc(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	let userId = crypt.decrypt(req.params.userId);
	let eventdb = new Events()
	eventdb.date = req.body.date
	eventdb.name = req.body.name
	eventdb.key = req.body.key
	eventdb.createdBy = patientId
	eventdb.docId = crypt.decrypt(req.body.docId)
	eventdb.status = req.body.status
	eventdb.addedBy = userId
	eventdb.save(async (err, eventdbStored) => {
		if (err) {
			insights.error(err);
			res.status(500).send({ message: `Failed to save in the database: ${err} ` })
		}
		if (eventdbStored) {
			let containerName = req.params.patientId.substr(1).toString();
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			res.status(200).send({ message: 'Eventdb created'})
		}else{
			insights.error('Error saving the eventdb');
			console.log(eventdbStored);
			res.status(500).send({ message: `Error saving the eventdb` })
		}
	})
}

async function saveEventForm(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
	let userId = crypt.decrypt(req.params.userId);
	let events = req.body.events; // Suponiendo que los eventos vienen en un arreglo en req.body.events

    let promises = events.map(async (event) => {
        let eventdb = new Events();
        eventdb.date = event.date || new Date(); // Asignar fecha actual si no se proporciona
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
        res.status(200).send({ message: 'Eventdb created', eventdb: flattenedResults });
    } catch (err) {
        insights.error(err);
        res.status(500).send({ message: `Failed to save in the database: ${err}` });
    }
}

function saveOne(eventdb){
	return new Promise(function (resolve, reject) {
	// when you save, returns an id in eventdbStored to access that social-info
	eventdb.save((err, eventdbStored) => {
		if (err) {
			insights.error(err);
			resolve({ message: `Failed to save in the database: ${err} ` })
		} 
		resolve({ message: 'Eventdb created' })
	})});
}

function updateEvent(req, res) {
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

	Events.findByIdAndUpdate(eventId, update, { new: true }, async (err, eventdbUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}

		const eventObj = eventdbUpdated.toObject();
		eventObj._id = crypt.encrypt(eventObj._id.toString());
		if (eventObj.docId) {
			eventObj.docId = crypt.encrypt(eventObj.docId.toString());
		}
		let patientIdEncrypted = crypt.encrypt(eventdbUpdated.createdBy.toString());
		let containerName = patientIdEncrypted.substr(1).toString();
		var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
		//dont return the createdBy field
		delete eventObj.createdBy;
		delete eventObj.addedBy;
		res.status(200).send({ message: 'Eventdb updated', eventdb: eventObj })

	})
}


function deleteEvent(req, res) {
	let eventId = crypt.decrypt(req.params.eventId)

	Events.findById(eventId, async (err, eventdb) => {
		if (err){
			insights.error(err);
			return res.status(500).send({ message: `Error making the request: ${err}` })
		}
		if (eventdb) {
			let patientIdEncrypted = crypt.encrypt(eventdb.createdBy.toString());
			let containerName = patientIdEncrypted.substr(1).toString();
			var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
			eventdb.remove(err => {
				if (err){
					insights.error(err);
					return res.status(500).send({ message: `Error deleting the eventdb: ${err}` })
				}
				
				res.status(200).send({ message: `The eventdb has been deleted` })
			})
		} else {
			insights.error('Error deleting the eventdb: eventdb not found');
			return res.status(404).send({ code: 208, message: `Error deleting the eventdb: ${err}` })
		}

	})
}

async function deleteAllEvents(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
    try {
        const events = await Events.find({ 'createdBy': patientId }).exec();
        for (let event of events) {
            try {
                await event.remove();
            } catch (err) {
				insights.error(err);
                console.log({message: `Error deleting an event: ${err}`});
            }
        }
        res.status(200).send({ message: `The eventdb has been deleted` });
    } catch (err) {
		insights.error(err);
        console.log({message: `Error finding the events: ${err}`});
    }
}

async function deleteEvents(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
    let eventsSelected = req.body.eventsIds.map(id => crypt.decrypt(id));
    
    try {
        const events = await Events.find({ 'createdBy': patientId }).exec();
        for (let event of events) {
            try {
                if(eventsSelected.includes(event._id.toString())){
                    await event.remove();
                }
            } catch (err) {
                insights.error(err);
                console.log({message: `Error deleting an event: ${err}`});
            }
        }
        let containerName = req.params.patientId.substr(1).toString();
        var result = await f29azureService.deleteSummaryFilesBlobsInFolder(containerName);
        res.status(200).send({ message: `The eventdb has been deleted` });
    } catch (err) {
        insights.error(err);
        console.log({message: `Error finding the events: ${err}`});
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
	explainMedicalEvent
}
