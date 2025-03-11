const config = require('../config')
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const hubName = config.WEBPUBSUB.HUB;
const Endpoint = 'Endpoint=https://'+config.WEBPUBSUB.NAME+'.webpubsub.azure.com;AccessKey='+config.WEBPUBSUB.KEY+';Version=1.0;';

const serviceClient = new WebPubSubServiceClient(Endpoint, hubName);

function getToken (req, res){
  (async () => {
    var userId= req.params.userId;
    const token = await serviceClient.getClientAccessToken({groups: [ userId ]});
    res.json({
      url: token.url
    });
})();
}

function sendToUser (userId, json_message){
  (async () => {
    const groupClient = serviceClient.group(userId);    
    const message = JSON.stringify(json_message);
    await groupClient.sendToAll(message);
})();
}

module.exports = {
	getToken,
  sendToUser,
}
