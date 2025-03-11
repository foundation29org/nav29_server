// functions for each call of the api on social-info. Use the social-info model

'use strict'

// add the social-info model
const Notes = require('../../../models/notes')
const Patient = require('../../../models/patient')
const crypt = require('../../../services/crypt')
const insights = require('../../../services/insights')


function getNotes (req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	Notes.find({"createdBy": patientId}, {"createdBy" : false, "addedBy": false}, (err, notes) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		if(!notes || notes.length === 0) return res.status(200).send({notes: []})
	    let notesArray = notes.map(note => {
			let noteObj = note.toObject();
			noteObj._id = crypt.encrypt(noteObj._id.toString());
			return noteObj;
		});
		return res.status(200).send({notes: notesArray})
	})
}

function saveNote (req, res){
	let patientId= crypt.decrypt(req.params.patientId);
	let userId = crypt.decrypt(req.params.userId);
	let notes = new Notes()
	notes.content = req.body.content
	notes.date = new Date();
	notes.createdBy = patientId
	notes.addedBy = userId
	notes.save((err, notesStored) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Failed to save in the database: ${err} `})
		}

		let encryptedNoteId = crypt.encrypt(notesStored._id.toString());
		res.status(200).send({message: 'Notes saved', noteId: encryptedNoteId})

	})
}

function updateNote (req, res){
	let noteId = crypt.decrypt(req.params.noteId);
	let userId = crypt.decrypt(req.params.userId);
	let update = { ...req.body };
	update.addedBy = userId;
	delete update._id;
	delete update.__v;
	Notes.findByIdAndUpdate(noteId, update, (err, noteUpdated) => {
		if (err) {
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}
		res.status(200).send({message: 'Note updated'})
	})
}


function deleteNote (req, res){
	let patientId = crypt.decrypt(req.params.patientId);
	let noteId = crypt.decrypt(req.params.noteId);

	Notes.findOneAndRemove({"createdBy": patientId, "_id": noteId}, (err, note) => {
		if (err){
			insights.error(err);
			return res.status(500).send({message: `Error making the request: ${err}`})
		}else{
			res.status(200).send({message: `The note has been eliminated`})
		}
	})
}

module.exports = {
	getNotes,
	saveNote,
	updateNote,
	deleteNote
}
