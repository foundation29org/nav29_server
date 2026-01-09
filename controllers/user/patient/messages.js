// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Messages = require('../../../models/messages')
const Patient = require('../../../models/patient')
const crypt = require('../../../services/crypt')
const insights = require('../../../services/insights')


function getMessages (req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	let userId = crypt.decrypt(req.params.userId)
	Messages.findOne({"createdBy": patientId, "userId": userId}, {"createdBy" : false }, (err, messages) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!messages) return res.status(202).send({message: 'There are no messages'})
	    let messagesArray = messages.toObject()
		return res.status(200).send({
			messages: messagesArray.messages,
			lastSuggestions: messagesArray.lastSuggestions || []
		})
	})
}

function saveMessages (req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	let userId = crypt.decrypt(req.params.userId)
	Messages.findOne({"createdBy": patientId, "userId": userId}, (err,messagesUpdated) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!messagesUpdated){
			let messages = new Messages()
			messages.messages = req.body.messages
			messages.date = new Date();
			messages.createdBy = patientId
			messages.userId = userId
			messages.save((err, messagesStored) => {
				if (err){
					insights.error(err);
					return res.status(500).send({message: `Failed to save in the database: ${err} `})
				}
		
				res.status(200).send({message: 'Messages saved'})
		
			})
		}
		if(messagesUpdated){
			messagesUpdated.messages = req.body.messages
			messagesUpdated.date = new Date();
			Messages.findByIdAndUpdate(messagesUpdated._id, messagesUpdated, {select: '-createdBy', new: true}, (err,messagesUpdated) => {
				if (err){
					insights.error(err);
					return res.status(500).send({message: `Error making the request: ${err}`})
				}
		
				res.status(200).send({message: 'messages updated'})
		
			})
		}
	})
	
}


function deleteMessages (req, res){
	let patientId = crypt.decrypt(req.params.patientId)
	let userId = crypt.decrypt(req.params.userId)

	Messages.findOne({"createdBy": patientId, "userId": userId}, {"createdBy" : false }, (err, messages) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(messages){
			messages.remove(err => {
				if(err){
					insights.error(err);
					return res.status(500).send({message: `Error deleting the messages: ${err}`})
				}
				res.status(200).send({message: `The messages has been eliminated`})
			})
		}else{
			 return res.status(202).send({message: 'The messages does not exist'})
		}
	})
}

module.exports = {
	getMessages,
	saveMessages,
	deleteMessages
}
