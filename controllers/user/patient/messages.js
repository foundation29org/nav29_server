// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Messages = require('../../../models/messages')
const Patient = require('../../../models/patient')
const crypt = require('../../../services/crypt')
const insights = require('../../../services/insights')


async function getMessages (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let userId = crypt.decrypt(req.params.userId)
		const messages = await Messages.findOne({"createdBy": patientId, "userId": userId}).select('-createdBy');
		
		if(!messages) return res.status(202).send({message: 'There are no messages'})
		
		let messagesArray = messages.toObject()
		return res.status(200).send({
			messages: messagesArray.messages,
			lastSuggestions: messagesArray.lastSuggestions || []
		})
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function saveMessages (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let userId = crypt.decrypt(req.params.userId)
		const messagesUpdated = await Messages.findOne({"createdBy": patientId, "userId": userId});
		
		if(!messagesUpdated){
			let messages = new Messages()
			messages.messages = req.body.messages
			messages.date = new Date();
			messages.createdBy = patientId
			messages.userId = userId
			await messages.save();
			res.status(200).send({message: 'Messages saved'})
		} else {
			messagesUpdated.messages = req.body.messages
			messagesUpdated.date = new Date();
			await Messages.findByIdAndUpdate(messagesUpdated._id, messagesUpdated, {
				projection: { createdBy: 0 },
				new: true
			});
			res.status(200).send({message: 'messages updated'})
		}
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}


async function deleteMessages (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId)
		let userId = crypt.decrypt(req.params.userId)

		const messages = await Messages.findOne({"createdBy": patientId, "userId": userId}).select('-createdBy');
		
		if(messages){
			await Messages.deleteOne({ _id: messages._id });
			res.status(200).send({message: `The messages has been eliminated`})
		} else {
			return res.status(202).send({message: 'The messages does not exist'})
		}
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

module.exports = {
	getMessages,
	saveMessages,
	deleteMessages
}
