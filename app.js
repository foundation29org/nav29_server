/*
* EXPRESS CONFIGURATION FILE
*/
'use strict'

const express = require('express')
const compression = require('compression');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const fileUpload = require('express-fileupload');
const app = express()
app.use(compression());
app.use(cookieParser());
const serviceEmail = require('./services/email')
const insights = require('./services/insights')
const api = require ('./routes')
const path = require('path')
const config= require('./config')
const allowedOrigins = config.allowedOrigins;
const wellKnownPath = config.wellKnownPath;

function setCrossDomain(req, res, next) {
  const origin = req.headers.origin;
  
  // En desarrollo, permitir peticiones sin origin (Postman, curl, etc.)
  const isDevelopment = config.client_server === 'http://localhost:4200';
  
  // Siempre indicar al navegador que la respuesta depende del origen
  res.header('Vary', 'Origin');

  // Si no hay origin, permitir en desarrollo o si es GET/HEAD
  if (!origin) {
    if (isDevelopment || req.method === 'GET' || req.method === 'HEAD') {
      return next();
    }
    
    // Permitir rutas del bot de WhatsApp que usan API key (sin origin)
    // Estas rutas son llamadas desde el servidor del bot, no desde un navegador
    const isWhatsAppBotRoute = req.url.startsWith('/api/whatsapp/') && 
                               req.headers['x-api-key'] === config.Server_Key;
    if (isWhatsAppBotRoute) {
      return next();
    }
    
    // En producción sin origin, rechazar métodos no seguros
    return res.status(403).json({ error: 'Origin header required' });
  }

  const isAllowed = allowedOrigins.includes(origin);

  if (isAllowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'HEAD,GET,PUT,POST,DELETE,OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Access-Control-Allow-Origin, Accept, Accept-Language, Origin, User-Agent, x-api-key, X-Gocertius-Token'
    );
    // Responder rápido a los preflight
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  }

  // Origin no permitido - solo enviar email en producción
  if (!isDevelopment) {
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const requestInfo = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      origin: origin,
      body: req.body,
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
  }
  res.status(401).json({ error: 'Origin not allowed' });
}



app.use(bodyParser.urlencoded({limit: '50mb', extended: false}))
app.use(bodyParser.json({limit: '50mb'}))
app.use(setCrossDomain);
app.use(fileUpload());

app.use('/.well-known/microsoft-identity-association.json', express.static(path.join(__dirname, wellKnownPath)));

// use the forward slash with the module api api folder created routes
app.use('/api',api)

//ruta angular, poner carpeta dist publica
app.use(express.static(path.join(__dirname, 'dist')));
//app.use(express.static(path.join(__dirname, 'raito_resources')));
// Send all other requests to the Angular app
app.get('*', function (req, res, next) {
    res.sendFile('dist/index.html', { root: __dirname });
 });

module.exports = app
