// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Notes = require('../../../models/notes')
const Patient = require('../../../models/patient')
const crypt = require('../../../services/crypt')
const insights = require('../../../services/insights')


async function getNotes (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		const notes = await Notes.find({"createdBy": patientId}).select('-createdBy -addedBy');
		
		if(!notes || notes.length === 0) return res.status(200).send({notes: []})
		
		let notesArray = notes.map(note => {
			let noteObj = note.toObject();
			noteObj._id = crypt.encrypt(noteObj._id.toString());
			return noteObj;
		});
		return res.status(200).send({notes: notesArray})
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

async function saveNote (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let userId = crypt.decrypt(req.params.userId);
		let notes = new Notes()
		notes.content = req.body.content
		notes.date = new Date();
		notes.createdBy = patientId
		notes.addedBy = userId
		const notesStored = await notes.save();

		let encryptedNoteId = crypt.encrypt(notesStored._id.toString());
		res.status(200).send({message: 'Notes saved', noteId: encryptedNoteId})
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Failed to save in the database: ${err} `})
	}
}

async function updateNote (req, res){
	try {
		let noteId = crypt.decrypt(req.params.noteId);
		let userId = crypt.decrypt(req.params.userId);
		let update = { ...req.body };
		update.addedBy = userId;
		delete update._id;
		delete update.__v;
		await Notes.findByIdAndUpdate(noteId, update);
		res.status(200).send({message: 'Note updated'})
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}


async function deleteNote (req, res){
	try {
		let patientId = crypt.decrypt(req.params.patientId);
		let noteId = crypt.decrypt(req.params.noteId);

		await Notes.findOneAndDelete({"createdBy": patientId, "_id": noteId});
		res.status(200).send({message: `The note has been eliminated`})
	} catch (err) {
		insights.error(err);
		return res.status(500).send({message: `Error making the request: ${err}`})
	}
}

module.exports = {
	getNotes,
	saveNote,
	updateNote,
	deleteNote
}
