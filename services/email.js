'use strict'

const { TRANSPORTER_OPTIONS, client_server, blobAccessToken } = require('../config')
const insights = require('../services/insights')
const nodemailer = require('nodemailer')
var hbs = require('nodemailer-express-handlebars')

var options = {
     viewEngine: {
         extname: '.hbs',
         layoutsDir: 'views/email/',
         defaultLayout : 'template'
     },
     viewPath: 'views/email/',
     extName: '.hbs'
 };

 var transporter = nodemailer.createTransport(TRANSPORTER_OPTIONS);
 transporter.use('compile', hbs(options));

function sendMailSupport (email, lang, supportStored){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de NAV29',
      template: 'mail_support/_es',
      context: {
        email : email,
        lang : lang,
        info: supportStored.toObject()
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailDev (params){
  const decoded = new Promise((resolve, reject) => {

    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: 'dev@foundation29.org',
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: params.subject,
      template: 'mail_dev/_es',
      context: {
        data : JSON.stringify(params.data)
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailError (error, type, patientId, url){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje de error de Nav29 - '+type,
      template: 'mail_error_catch/_es',
      context: {
        type: type,
        info: error,
        patientId: patientId,
        url: url
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailControlCall (req){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];

    var mailOptions = {
      to: TRANSPORTER_OPTIONS.auth.user,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: 'Mensaje para soporte de Nav29 - ControlCall',
      template: 'mail_error_control_call/_es',
      context: {
        info: JSON.stringify(req)
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailAccess (userInfo, location, notes){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];
    var subjectlang='New Device Notification - Access to Your Medical Information - Nav 29';
    if(userInfo.lang === 'es'){
      subjectlang='Notificación de nuevo dispositivo - Acceso a su información médica - Nav 29';
    }
    var mailOptions = {
      to: userInfo.email,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: subjectlang,
      template: 'mail_access/_'+userInfo.lang,
      context: {
        email : userInfo.email,
        lang : userInfo.lang,
        notes: notes,
        info: location
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log(error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        resolve("ok")
      }
    });

  });
  return decoded
}

function sendMailWhatsAppLinked (userInfo, phoneNumber){
  const decoded = new Promise((resolve, reject) => {
    var maillistbcc = [
      TRANSPORTER_OPTIONS.auth.user
    ];
    
    // Mask phone number for privacy (show last 4 digits)
    const maskedPhone = phoneNumber.length > 4 
      ? '***' + phoneNumber.slice(-4) 
      : phoneNumber;
    
    const lang = userInfo.lang || 'es';
    var subjectlang = 'WhatsApp Account Linked - Nav29';
    if(lang === 'es'){
      subjectlang = 'Cuenta WhatsApp vinculada - Nav29';
    }
    
    var mailOptions = {
      to: userInfo.email,
      from: TRANSPORTER_OPTIONS.auth.user,
      bcc: maillistbcc,
      subject: subjectlang,
      template: 'mail_whatsapp_linked/_' + lang,
      context: {
        phone: maskedPhone,
        date: new Date().toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', { 
          dateStyle: 'long', 
          timeStyle: 'short' 
        })
      }
    };

    transporter.sendMail(mailOptions, function(error, info){
      if (error) {
        insights.error(error);
        console.log('[Email] Error sending WhatsApp linked email:', error);
        reject({
          status: 401,
          message: 'Fail sending email'
        })
      } else {
        console.log('[Email] WhatsApp linked email sent to:', userInfo.email);
        resolve("ok")
      }
    });

  });
  return decoded
}

module.exports = {
  sendMailSupport,
  sendMailDev,
  sendMailControlCall,
  sendMailError,
  sendMailAccess,
  sendMailWhatsAppLinked
}
