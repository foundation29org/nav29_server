'use strict'

// add the user model
const User = require('../../models/user')
const Patient = require('../../models/patient')
const crypt = require('../../services/crypt')
const insights = require('../../services/insights')

function getGeneralShare(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
    Patient.findById(patientId, { "_id": false, "createdBy": false }, (err, patient) => {
        if (err){
            insights.error(err);
            return res.status(500).send({ message: `Error making the request: ${err}` })
        } 
        res.status(200).send({ generalShare: patient.generalShare })
    })
}

async function getCustomShare(req, res) {
    try {
        let patientId = crypt.decrypt(req.params.patientId);
        let patient = await Patient.findById(patientId, { "_id": false }).lean().exec();

        if (!patient) {
            return res.status(404).send({ message: 'Patient not found' });
        }
        // Verificar si el usuario es el propietario
        const isOwner = patient.createdBy.toString() === req.user;
        if (isOwner) {
            let locationPromises = patient.customShare.map(async (element) => {
                let locationPromises = element.locations.map(async (location) => {
                    let user = await User.findOne({ email: location.email }).lean().exec();
                    if (user && user.infoVerified.isVerified) {
                        location.originalName = user.infoVerified.info.firstName + ' ' + user.infoVerified.info.lastName;
                    }else{
                        location.originalName = user.userName;
                    }
                    delete location.idToken;
                    delete location.userId;
                });
                return Promise.all(locationPromises);
            });
    
            await Promise.all(locationPromises);
        }else{
             // Si no es propietario, filtrar solo los customShare donde el usuario tiene una location
             patient.customShare = patient.customShare.filter(share => 
                share.locations.some(loc => loc.userId === req.user)
            ).map(share => ({
                ...share,
                locations: [] // Vaciamos el array de locations para no enviar ninguna
            }));
        }
        

        res.status(200).send({ customShare: patient.customShare,  owner: isOwner });

    } catch (err) {
        insights.error(err);
        res.status(500).send({ message: `Error making the request: ${err}` });
    }
}

async function updatecustomshare(req, res) {
    try {
        let patientId = crypt.decrypt(req.params.patientId);
        
        // Primero verificamos si el usuario es el propietario
        const patient = await Patient.findById(patientId);
        if (!patient) {
            return res.status(404).send({ message: 'Patient not found' });
        }

        const isOwner = patient.createdBy.toString() === req.user;
        if (!isOwner) {
            return res.status(403).send({ message: 'Unauthorized: only the owner can update custom shares' });
        }

        // Si es el propietario, procedemos con la actualización
        if (req.body._id == null) {
            const patientUpdated = await Patient
                .findByIdAndUpdate(
                    patientId, 
                    { $push: { customShare: req.body } }, 
                    { select: '-createdBy', new: true }
                )
                .lean()  // Convertir a objeto plano
                .exec();

            // Limpiar datos sensibles de todas las locations
            const cleanedCustomShare = patientUpdated.customShare.map(share => ({
                ...share,
                locations: share.locations.map(location => {
                    const cleanLocation = { ...location };
                    delete cleanLocation.idToken;
                    delete cleanLocation.userId;
                    return cleanLocation;
                })
            }));

            return res.status(200).send({ 
                message: 'custom share added', 
                customShare: cleanedCustomShare 
            });
        } else {
            const patientUpdated = await Patient
                .findOneAndUpdate(
                    { _id: patientId, 'customShare._id': req.body._id },
                    { $set: { 'customShare.$.notes': req.body.notes } },
                    { select: '-createdBy', new: true }
                )
                .lean()  // Convertir a objeto plano
                .exec();

            // Limpiar datos sensibles de todas las locations
            const cleanedCustomShare = patientUpdated.customShare.map(share => ({
                ...share,
                locations: share.locations.map(location => {
                    const cleanLocation = { ...location };
                    delete cleanLocation.idToken;
                    delete cleanLocation.userId;
                    return cleanLocation;
                })
            }));

            return res.status(200).send({ 
                message: 'custom share updated', 
                customShare: cleanedCustomShare 
            });
        }
    } catch (err) {
        insights.error(err);
        return res.status(500).send({ message: `Error making the request: ${err}` });
    }
}

async function deletecustomshare(req, res) {
    try {
        let patientId = crypt.decrypt(req.params.patientId);
        
        // Primero verificamos si el usuario es el propietario
        const patient = await Patient.findById(patientId);
        if (!patient) {
            return res.status(404).send({ message: 'Patient not found' });
        }

        const isOwner = patient.createdBy.toString() === req.user;
        if (!isOwner) {
            return res.status(403).send({ message: 'Unauthorized: only the owner can delete custom shares' });
        }

        // Si es el propietario, procedemos con la eliminación
        const patientUpdated = await Patient
            .findByIdAndUpdate(
                patientId, 
                { $pull: { customShare: { _id: req.body._id } } }, 
                { select: '-createdBy', new: true }
            )
            .exec();

        res.status(200).send({ message: 'custom share deleted' });

    } catch (err) {
        insights.error(err);
        return res.status(500).send({ message: `Error making the request: ${err}` });
    }
}

async function changeStatusCustomShare(req, res) {
    try {
        let patientId = crypt.decrypt(req.params.patientId);
        let patient = await Patient.findById(patientId, { "_id": false, "createdBy": false }).exec();

        if (!patient) {
            return res.status(404).send({ message: 'Patient not found' });
        }

        // Encontrar el índice del elemento customShare que contiene la ubicación
        let customShareIndex = patient.customShare.findIndex(share => 
            share.locations.some(location => location._id.equals(req.body._id))
        );

        if (customShareIndex === -1) {
            return res.status(404).send({ message: 'Location not found in customShare' });
        }

        // Encontrar el índice de la ubicación dentro del elemento customShare
        let locationIndex = patient.customShare[customShareIndex].locations.findIndex(location => 
            location._id.equals(req.body._id)
        );

        if (locationIndex === -1) {
            return res.status(404).send({ message: 'Location not found' });
        }

        // Construir la ruta de actualización usando los índices
        let updatePath = `customShare.${customShareIndex}.locations.${locationIndex}.status`;

        // Realizar la actualización
        let update = {};
        update[updatePath] = req.body.status;

        let patientUpdated = await Patient.findOneAndUpdate(
            { _id: patientId, [`customShare.${customShareIndex}.locations._id`]: req.body._id },
            { $set: update },
            { select: '-createdBy', new: true }
        ).exec();

        res.status(200).send({ message: 'custom share status changed' });

    } catch (err) {
        insights.error(err);
        res.status(500).send({ message: `Error making the request: ${err}` });
    }
}

function getIndividualShare(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
    Patient.findById(patientId, { "_id": false, "createdBy": false }, async (err, patient) => {
        if (err){
            insights.error(err);
            return res.status(500).send({ message: `Error making the request: ${err}` })
        }
        if(patient.individualShare.length>0){
            var data = await getInfoUsers(patient.individualShare);
            return res.status(200).send({ individualShare: data })
        }else{
            res.status(200).send({ individualShare: patient.individualShare })
        }
        
    })
}

async function getInfoUsers(individualShares) {
	return new Promise(async function (resolve, reject) {

                var promises = [];
                for (var i = 0; i < individualShares.length; i++) {
                    promises.push(getUserName(individualShares[i]));
                }
                await Promise.all(promises)
                    .then(async function (data) {
                        resolve(data)
                    })
                    .catch(function (err) {
                        console.log('Manejar promesa rechazada (' + err + ') aquí.');
                        insights.error(err);
                        reject('Manejar promesa rechazada (' + err + ') aquí.');
                    });

		

	});
}

function getUserName(individualShare) {
    return new Promise(async function (resolve, reject) {
        if(individualShare.idUser!=null){
            let idUser = crypt.decrypt(individualShare.idUser);
            //añado  {"_id" : false} para que no devuelva el _id
            User.findById(idUser, { "_id": false, "__v": false, "loginAttempts": false, "role": false, "lastLogin": false }, (err, user) => {
                var res = JSON.parse(JSON.stringify(individualShare))
                if (err){
                    insights.error(err);
                    res.userInfo = { userName: '', lastName: '', email: '' }
                    resolve(res)
                }
                if (user) {
                    res.userInfo = { userName: user.userName, lastName: user.lastName, email: user.email }
                    resolve(res)
                }else{
                    res.userInfo = { userName: '', lastName: '', email: '' }
                    resolve(res)
                }
            })
        }else{
            var res = JSON.parse(JSON.stringify(individualShare))
            res.userInfo = { userName: '', lastName: '', email: '' }
            resolve(res)
        }
        
    });
	
}

function setIndividualShare(req, res) {
    let patientId = crypt.decrypt(req.params.patientId);
    var info = {patientId: req.params.patientId, individualShare: req.body.individualShare[req.body.indexUpdated], type: 'Clinician'}
    Patient.findByIdAndUpdate(patientId, { individualShare: req.body.individualShare }, { new: true }, (err, patientUpdated) => {
        if (err) {
            console.log(err);
        }
        if (patientUpdated) {
            res.status(200).send({ message: 'individuals share updated' })
            
        }
    })
}

module.exports = {
    getGeneralShare,
    getCustomShare,
    updatecustomshare,
    deletecustomshare,
    changeStatusCustomShare,
    getIndividualShare,
    setIndividualShare
}