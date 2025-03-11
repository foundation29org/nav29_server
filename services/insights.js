const config = require('../config')
let appInsights = require("applicationinsights");
appInsights.setup(config.INSIGHTS)
.setSendLiveMetrics(false)
.setAutoCollectRequests(false)
.setAutoCollectDependencies(false)
.start(); 
let client = appInsights.defaultClient;

function error(message) {
  //client.trackTrace({message: message});
  if(config.client_server == 'http://localhost:4200'){
    console.log('AppInsights tracking:')
    console.log(message)
  }else{
    let stringException;
    if (message instanceof Error) {
      stringException = message.stack || message.message; // Incluye el stack trace si está disponible
    } else if (typeof message === 'string') {
      stringException = message;
    } else if (typeof message === 'object') {
      stringException = JSON.stringify(message);
    } else {
      stringException = message.toString();
    }
    client.trackException({exception: new Error(stringException)});
  }
  
}

module.exports = {
    error
}