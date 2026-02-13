// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Appointments = require('../../../models/appointments')
const Patient = require('../../../models/patient')
const crypt = require('../../../services/crypt')
const User = require('../../../models/user')
const insights = require('../../../services/insights')

async function getLastAppointments (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		var period = 7;
		var actualDate = new Date();
		actualDate.setDate(actualDate.getDate() -1);
		var actualDateTime = actualDate.getTime();

		var futureDate = new Date(actualDate);
		futureDate.setDate(futureDate.getDate() + period);
		var futureDateDateTime = futureDate.getTime();
		
		const eventsdb = await Appointments.find(
			{"createdBy": patientId, "date":{"$gte": actualDateTime}}
		).select('-createdBy -addedBy');
		
		var listEventsdb = [];
		eventsdb.forEach(function(eventdb) {
			listEventsdb.push(eventdb);
		});
		res.status(200).send(listEventsdb)
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function getAppointments(req, res) {
	let patientId = crypt.decrypt(req.params.patientId);
	try {
		const eventsdb = await Appointments.find(
			{"createdBy": patientId}
		).select('-createdBy');

		const formattedEvents = await Promise.all(eventsdb.map(async (eventdb) => {
			let eventObj = eventdb.toObject();
			const user = await User.findById(eventObj.addedBy).select('userName email');
			return {
				...eventObj,
				_id: crypt.encrypt(eventObj._id.toString()),
				addedBy: {
					_id: crypt.encrypt(eventObj.addedBy.toString()),
					userName: user?.userName || 'Unknown',
					email: user?.email || 'Unknown'
				}
			};
		}));

		res.status(200).send(formattedEvents);
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`});
	}
}


async function saveAppointment(req, res) {
    try {
        let patientId = crypt.decrypt(req.params.patientId);
        let userId = crypt.decrypt(req.params.userId);
        let eventdb = new Appointments();
        eventdb.date = req.body.date;
        eventdb.notes = req.body.notes;
        eventdb.createdBy = patientId;
        eventdb.addedBy = userId;

        const eventdbStored = await eventdb.save();
        
        if (eventdbStored) {
            res.status(200).send({ message: 'Eventdb created'});
        }
    } catch (err) {
        insights.error(err);
        return res.status(500).send({ message: `Failed to save in the database: ${err}` });
    }
}

async function updateAppointment(req, res) {
    try {
        let appointmentId = crypt.decrypt(req.params.appointmentId);
        let submittedUserId = crypt.decrypt(req.body.addedBy._id);

        // Primero, obtener la cita actual para verificar el addedBy
        const appointment = await Appointments.findById(appointmentId);
        
        if (!appointment) {
            return res.status(404).send({ message: 'Appointment not found' });
        }

        // Verificar si el usuario que intenta actualizar es el mismo que creó la cita
        if (appointment.addedBy.toString() !== submittedUserId) {
            return res.status(403).send({ message: 'Not authorized to update this appointment' });
        }

        // Si la verificación es exitosa, actualizar solo date y notes
        const update = {
            date: req.body.date,
            notes: req.body.notes,
			dateInput: Date.now()
        };

        await Appointments.findByIdAndUpdate(
            appointmentId, 
            update, 
            {
                projection: { createdBy: 0 },
                new: true
            }
        );

        res.status(200).send({
            message: 'Appointment updated'
        });

    } catch (err) {
        insights.error(err);
        return res.status(500).send({ message: `Error making the request: ${err}` });
    }
}


async function deleteAppointment (req, res){
	try {
		let appointmentId = crypt.decrypt(req.params.appointmentId);

		const eventdb = await Appointments.findById(appointmentId);
		if (eventdb){
			await Appointments.deleteOne({ _id: appointmentId });
			res.status(200).send({message: `Deleted`})
		} else {
			return res.status(404).send({code: 208, message: `Error deleting the eventdb: not found`})
		}
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error deleting the appointmentId: ${err}`})
	}
}

module.exports = {
	getLastAppointments,
	getAppointments,
	saveAppointment,
	updateAppointment,
	deleteAppointment
}
