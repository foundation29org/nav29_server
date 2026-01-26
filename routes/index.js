// file that contains the routes of the api
'use strict'

const express = require('express')
const insights = require('../services/insights')

const userCtrl = require('../controllers/all/user')
const patientCtrl = require('../controllers/user/patient')
const activityCtrl = require('../controllers/user/patient/activity')
const langCtrl = require('../controllers/all/lang')

const deleteAccountCtrl = require('../controllers/user/delete')
const translationCtrl = require('../services/translation')
const openAIserviceCtrl = require('../services/openai')

const bookServiceCtrl = require('../services/books')
const supportCtrl = require('../controllers/all/support')
const feedbackDevCtrl = require('../controllers/all/feedback_dev')
const docsCtrl = require('../controllers/user/patient/documents')
const messagesCtrl = require('../controllers/user/patient/messages')
const notesCtrl = require('../controllers/user/patient/notes')

const pubsubCtrl = require('../services/pubsub')

const eventsCtrl = require('../controllers/user/patient/events')
const appointmentsCtrl = require('../controllers/user/patient/appointments')
const aiFeaturesCtrl = require('../controllers/user/patient/aiFeaturesController')
const rarescopeCtrl = require('../controllers/user/patient/rarescope')
const f29azureserviceCtrl = require('../services/f29azure')
const openShareCtrl = require('../controllers/all/openshare')
const feedbackCtrl = require('../services/feedback')
const gocertiusCtrl = require('../services/gocertius')
const auth = require('../middlewares/auth')
const roles = require('../middlewares/roles')
const cors = require('cors');
const serviceEmail = require('../services/email')
const api = express.Router()
const config= require('../config')
const myApiKey = config.Server_Key;
const whitelist = config.allowedOrigins;

function corsWithOptions(req, res, next) {
  const corsOptions = {
    origin: function (origin, callback) {
      if (whitelist.includes(origin)) {
        callback(null, true);
      } else {
          // La IP del cliente
          const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
          const requestInfo = {
              method: req.method,
              url: req.url,
              headers: req.headers,
              origin: origin,
              body: req.body, // Asegúrate de que el middleware para parsear el cuerpo ya haya sido usado
              ip: clientIp,
              params: req.params,
              query: req.query,
            };
          try {
            serviceEmail.sendMailControlCall(requestInfo)
          } catch (emailError) {
            console.log('Fail sending email');
            insights.error({ message: 'Failed to send control email in CORS check', error: emailError });
          }
          callback(new Error('Not allowed by CORS'));
      }
    },
  };

  cors(corsOptions)(req, res, next);
}

const checkApiKey = (req, res, next) => {
    // Permitir explícitamente solicitudes de tipo OPTIONS para el "preflight" de CORS
    if (req.method === 'OPTIONS') {
      return next();
    } else {
      const apiKey = req.get('x-api-key');
      if (apiKey && apiKey === myApiKey) {
        return next();
      } else {
        return res.status(401).json({ error: 'API Key no válida o ausente' });
      }
    }
  };

// user routes, using the controller user, this controller has methods
//routes for login-logout
api.post('/login', deleteAccountCtrl.verifyToken, userCtrl.login)
api.post('/refresh', userCtrl.refreshToken)
api.get('/session', auth.isAuth(roles.All), checkApiKey, userCtrl.getSession)
api.post('/logout', userCtrl.logout)

api.get('/users/lang/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.getUserLang)
api.put('/users/lang/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.changeLang)
api.get('/getPreferredLang/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.getUserPreferredLang)
api.put('/updatePreferredLang/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.updatePreferredLang)
api.get('/users/settings/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.getSettings)
api.get('/users/name/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.getUserName)
api.post('/setaccesstopatient/:patientId', auth.isAuth(roles.All), checkApiKey, userCtrl.setaccesstopatient)
api.get('/verified/:userId', auth.isAuth(roles.All), userCtrl.isVerified)
api.post('/verified/:userId', auth.isAuth(roles.All), userCtrl.setInfoVerified)
api.get('/users/rolemedicallevel/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.getRoleMedicalLevel)
api.put('/users/role/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.setRole)
api.put('/users/medicallevel/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.setMedicalLevel)
api.put('/users/settings/:userId', auth.isAuth(roles.All), checkApiKey, userCtrl.saveSettings)

// patient routes, using the controller patient, this controller has methods
api.get('/getcontext/:userId', auth.isAuth(roles.All), checkApiKey, patientCtrl.getPatientsContext)
api.get('/createpatient/:userId', auth.isAuth(roles.All), checkApiKey, patientCtrl.addNewPatient)
api.get('/patients-all/:userId', auth.isAuth(roles.All), checkApiKey, patientCtrl.getPatientsUser)
api.get('/patients/basic/:patientId', auth.isAuthPatient(roles.All), checkApiKey, patientCtrl.getPatientData)
api.put('/patients/:patientId', auth.isAuthOwnerPatient(roles.All), checkApiKey, patientCtrl.updatePatient)
api.delete('/patient/:patientId', auth.isAuthOwnerPatient(roles.All), checkApiKey, deleteAccountCtrl.removePatient)
api.get('/patient/donation/:patientId', auth.isAuthOwnerPatient(roles.All), checkApiKey, patientCtrl.getDonation)
api.put('/patient/donation/:patientId', auth.isAuthOwnerPatient(roles.All), checkApiKey, patientCtrl.setDonation)
api.post('/patient/summary/:patientId', auth.isAuthPatient(roles.All), checkApiKey, patientCtrl.getStatePatientSummary)
api.get('/sharedpatients/:userId', auth.isAuth(roles.All), checkApiKey, patientCtrl.getSharedPatients)

api.get('/patient/:patientId/recent-activity/:userId', auth.isAuthPatient(roles.All), checkApiKey, activityCtrl.getRecentActivity)
api.get('/patient/:patientId/recent-appointments/:userId', auth.isAuthPatient(roles.All), checkApiKey, activityCtrl.getRecentAppointments)

//delete account
api.post('/deleteaccount/:userId', auth.isAuth(roles.All), checkApiKey,deleteAccountCtrl.verifyToken, deleteAccountCtrl.deleteAccount)

// lang routes, using the controller lang, this controller has methods
api.get('/langs/',  langCtrl.getLangs)


//Support
api.post('/support/', auth.isAuth(roles.All), checkApiKey, supportCtrl.sendMsgSupport)
api.post('/homesupport/', supportCtrl.sendMsgLogoutSupport)
api.get('/support/:userId', auth.isAuth(roles.All), checkApiKey, supportCtrl.getUserMsgs)
api.post('/generalfeedback/set/:patientId', auth.isAuthPatient(roles.All), checkApiKey, supportCtrl.sendGeneralFeedback)
api.post('/generalfeedback/get/:patientId', auth.isAuthPatient(roles.All), checkApiKey, supportCtrl.getGeneralFeedback)

//service feedback
api.post('/feedbackdev', auth.isAuth(roles.All), checkApiKey, feedbackDevCtrl.sendMsgDev)


// documentsCtrl routes, using the controller documents, this controller has methods
api.get('/documents/:patientId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.getDocuments)
api.get('/document/:patientId/:documentId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.getDocument)
api.delete('/document/:patientId/:documentId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.deleteDocument)
api.post('/document/updatedate/:patientId/:documentId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.updateDate)
api.post('/document/updatetitle/:patientId/:documentId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.updateTitle)
api.post('/summarysuggest/:patientId/:documentId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.summarySuggest)
api.post('/upload/:patientId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.uploadFile)
api.post('/uploadwizard/:patientId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.uploadFileWizard)
api.post('/continueanalizedocs/:patientId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.continueanalizedocs)
api.post('/trysummarize/:patientId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.trySummarize)
api.post('/anonymizedocument/:patientId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.anonymizeDocument)
api.delete('/deletesummary/:patientId', auth.isAuthPatient(roles.All), checkApiKey, docsCtrl.deleteSummary)

api.post('/callnavigator/:patientId', auth.isAuthPatient(roles.All), checkApiKey, bookServiceCtrl.callNavigator)
api.post('/getinitialevents/:patientId', auth.isAuthPatient(roles.All), checkApiKey, bookServiceCtrl.getInitialEvents)

// AI features routes
api.post('/ai/rarescope/:patientId', auth.isAuthPatient(roles.All), checkApiKey, aiFeaturesCtrl.handleRarescopeRequest)
api.post('/ai/dxgpt/:patientId', auth.isAuthPatient(roles.All), checkApiKey, aiFeaturesCtrl.handleDxGptRequest)
api.post('/ai/disease-info/:patientId', auth.isAuthPatient(roles.All), checkApiKey, aiFeaturesCtrl.handleDiseaseInfoRequest)
api.post('/ai/infographic/:patientId', auth.isAuthPatient(roles.All), checkApiKey, aiFeaturesCtrl.handleInfographicRequest)
api.post('/ai/soap/questions/:patientId', auth.isAuthPatient(roles.All), checkApiKey, aiFeaturesCtrl.handleSoapQuestionsRequest)
api.post('/ai/soap/report/:patientId', auth.isAuthPatient(roles.All), checkApiKey, aiFeaturesCtrl.handleSoapReportRequest)

// Rarescope routes
api.post('/rarescope/save/:patientId', auth.isAuthPatient(roles.All), checkApiKey, rarescopeCtrl.saveRarescopeData)
api.get('/rarescope/load/:patientId', auth.isAuthPatient(roles.All), checkApiKey, rarescopeCtrl.loadRarescopeData)
api.get('/rarescope/history/:patientId', auth.isAuthPatient(roles.All), checkApiKey, rarescopeCtrl.getRarescopeHistory)
api.delete('/rarescope/delete/:patientId', auth.isAuthPatient(roles.All), checkApiKey, rarescopeCtrl.deleteRarescopeData)

//services OPENAI
api.post('/eventsnavigator', auth.isAuth(roles.All), checkApiKey, openAIserviceCtrl.extractEventsNavigator)

//translations
api.post('/translationinvert', auth.isAuth(roles.All), checkApiKey, translationCtrl.getTranslationDictionaryInvert)
api.post('/translationtimeline', auth.isAuth(roles.All), checkApiKey, translationCtrl.getTranslationTimeline)
api.post('/deepltranslationinvert', auth.isAuth(roles.All), checkApiKey, translationCtrl.getdeeplTranslationDictionaryInvert)

//events
api.post('/events/dates/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.getEventsDate)
api.get('/events/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.getEvents)
api.post('/eventsfromdoc/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.getEventsDocument)
api.post('/updateeventfromdoc/:patientId/:eventId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.updateEventDocument)
api.get('/eventscontext/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.getEventsContext)
api.post('/events/:patientId/:userId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.saveEvent)
api.post('/eventsdoc/:patientId/:userId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.saveEventDoc)
api.post('/eventsform/:patientId/:userId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.saveEventForm)
api.put('/events/:patientId/:eventId/:userId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.updateEvent)
api.delete('/events/:patientId/:eventId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.deleteEvent)
api.post('/deleteevents/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.deleteEvents)
api.post('/explainmedicalevent/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.explainMedicalEvent)

// Timeline consolidado (genera timeline limpio a partir de eventos crudos)
api.get('/timeline/consolidated/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.getConsolidatedTimeline)
api.post('/timeline/regenerate/:patientId', auth.isAuthPatient(roles.All), checkApiKey, eventsCtrl.regenerateConsolidatedTimeline)

api.get('/lastappointments/:patientId', auth.isAuthPatient(roles.All), checkApiKey, appointmentsCtrl.getLastAppointments)
api.get('/appointments/:patientId', auth.isAuthPatient(roles.All), checkApiKey, appointmentsCtrl.getAppointments)
api.post('/appointments/:patientId/:userId', auth.isAuthPatient(roles.All), checkApiKey, appointmentsCtrl.saveAppointment)
api.put('/appointments/:patientId/:appointmentId', auth.isAuthPatient(roles.All), checkApiKey, appointmentsCtrl.updateAppointment)
api.delete('/appointments/:patientId/:appointmentId', auth.isAuthPatient(roles.All), checkApiKey, appointmentsCtrl.deleteAppointment)


//messages
api.get('/messages/:userId/:patientId', auth.isAuthPatient(roles.All), checkApiKey, messagesCtrl.getMessages)
api.post('/messages/:userId/:patientId', auth.isAuthPatient(roles.All), checkApiKey, messagesCtrl.saveMessages)
api.delete('/messages/:userId/:patientId', auth.isAuthPatient(roles.All), checkApiKey, messagesCtrl.deleteMessages)

//notes
api.get('/notes/:patientId', auth.isAuthPatient(roles.All), checkApiKey, notesCtrl.getNotes)
api.post('/notes/:patientId/:userId', auth.isAuthPatient(roles.All), checkApiKey, notesCtrl.saveNote)
api.put('/notes/:patientId/:noteId/:userId', auth.isAuthPatient(roles.All), checkApiKey, notesCtrl.updateNote)
api.delete('/notes/:patientId/:noteId', auth.isAuthPatient(roles.All), checkApiKey, notesCtrl.deleteNote)

//gettoken
api.get('/gettoken/', (req, res) => {
  return res.status(401).json({ message: 'User ID is required' });
});
api.get('/gettoken/:userId', auth.isAuth(roles.All), checkApiKey, pubsubCtrl.getToken)

//azureservices
api.get('/getAzureBlobSasTokenWithContainer/:containerName', auth.isAuth(roles.All), checkApiKey, f29azureserviceCtrl.getAzureBlobSasTokenWithContainer)
api.get('/getAzureBlobSasTokenForPatient/:patientId', auth.isAuth(roles.All), checkApiKey, f29azureserviceCtrl.getAzureBlobSasTokenForPatient)

// Speech recognition
const speechCtrl = require('../controllers/user/patient/speech')
api.get('/speech/token', auth.isAuth(roles.All), checkApiKey, speechCtrl.getSpeechToken)

// share
api.get('/share/patient/generalshare/:patientId', auth.isAuthPatient(roles.All), checkApiKey, openShareCtrl.getGeneralShare)
api.get('/share/patient/customshare/:patientId', auth.isAuthPatient(roles.All), checkApiKey, openShareCtrl.getCustomShare)
api.post('/share/patient/updatecustomshare/:patientId', auth.isAuthPatient(roles.All), checkApiKey, openShareCtrl.updatecustomshare)
api.post('/share/patient/deletecustomshare/:patientId', auth.isAuthPatient(roles.All), checkApiKey, openShareCtrl.deletecustomshare)
api.post('/share/patient/changestatuscustomshare/:patientId', auth.isAuthPatient(roles.All), checkApiKey, openShareCtrl.changeStatusCustomShare)
api.get('/share/patient/individualshare/:patientId', auth.isAuthPatient(roles.All), checkApiKey, openShareCtrl.getIndividualShare)
api.post('/share/patient/individualshare/:patientId', auth.isAuthPatient(roles.All), checkApiKey, openShareCtrl.setIndividualShare)

//gocertius
api.get('/gocertius/gettoken', checkApiKey, gocertiusCtrl.getToken)
api.post('/gocertius/createcasefile', checkApiKey, gocertiusCtrl.createCasefile)
api.get('/gocertius/getcasefile/:caseFileId', checkApiKey, gocertiusCtrl.getCasefile)
api.post('/gocertius/updatecasefile/:caseFileId', checkApiKey, gocertiusCtrl.updateCasefile)
api.post('/gocertius/createevidencegroup/:caseFileId', checkApiKey, gocertiusCtrl.createEvidenceGroup)
api.post('/gocertius/createevidence/:caseFileId/:evidenceGroupId', checkApiKey, gocertiusCtrl.createEvidence)
api.get('/gocertius/getevidenceuploadurl/:caseFileId/:evidenceGroupId/:evidenceId', checkApiKey, gocertiusCtrl.getEvidenceUploadUrl)
api.get('/gocertius/getevidencelist', checkApiKey, gocertiusCtrl.getEvidenceList)
api.get('/gocertius/getevidencegrouplist', checkApiKey, gocertiusCtrl.getEvidenceGroupList)
api.get('/gocertius/getevidencegroup/:caseFileId/:evidenceGroupId', checkApiKey, gocertiusCtrl.getEvidenceGroup)
api.post('/gocertius/closeevidencegroup/:caseFileId/:evidenceGroupId', checkApiKey, gocertiusCtrl.closeEvidenceGroup)
api.post('/gocertius/generatereport/:caseFileId', checkApiKey, gocertiusCtrl.generateReport)
api.get('/gocertius/getreportpdfurl/:reportId', checkApiKey, gocertiusCtrl.getReportPdfUrl)
api.get('/gocertius/getreportzip/:reportId', checkApiKey, gocertiusCtrl.getReportZip)

api.post('/vote', feedbackCtrl.vote)

/*api.get('/testToken', auth, (req, res) => {
	res.status(200).send(true)
})*/
//ruta privada
api.get('/private', auth.isAuth(roles.All), checkApiKey, (req, res) => {
	res.status(200).send({ message: 'You have access' })
})

module.exports = api
