const config = require('../config')
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const jwt = require('jwt-simple');
const crypt = require('./crypt');
const hubName = config.WEBPUBSUB.HUB;
const Endpoint = 'Endpoint=https://'+config.WEBPUBSUB.NAME+'.webpubsub.azure.com;AccessKey='+config.WEBPUBSUB.KEY+';Version=1.0;';

const serviceClient = new WebPubSubServiceClient(Endpoint, hubName);

function getToken (req, res){
  (async () => {
    try {
      // Usar userId de la URL (encriptado) como antes para mantener consistencia
      // El cliente envía userId encriptado y los mensajes se envían con userId encriptado
      var userId = req.params.userId;
      
      if (!userId) {
        return res.status(401).json({ message: 'User ID not found' });
      }
      
      const webPubSubToken = await serviceClient.getClientAccessToken({groups: [ userId ]});
      res.json({
        url: webPubSubToken.url
      });
    } catch (error) {
      console.error('Error getting WebPubSub token:', error);
      res.status(500).json({ message: 'Error getting token' });
    }
})();
}

function sendToUser (userId, json_message){
  (async () => {
    try {
      const groupClient = serviceClient.group(userId);    
      const message = JSON.stringify(json_message);
      console.log(`Sending WebPubSub message to user ${userId}:`, json_message);
      await groupClient.sendToAll(message);
      console.log(`WebPubSub message sent successfully to user ${userId}`);
    } catch (error) {
      console.error(`Error sending WebPubSub message to user ${userId}:`, error);
    }
})();
}

module.exports = {
	getToken,
  sendToUser,
}
