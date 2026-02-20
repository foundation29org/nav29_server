const config = require('../config')
const storage = require("@azure/storage-blob")
const insights = require('../services/insights')
const accountnameOpenDx = config.BLOB.NAMEBLOB;
const keyOpenDx = config.BLOB.KEY;
const sharedKeyCredentialOpenDx = new storage.StorageSharedKeyCredential(accountnameOpenDx, keyOpenDx);
const blobServiceOpenDx = new storage.BlobServiceClient(
    `https://${accountnameOpenDx}.blob.core.windows.net`,
    sharedKeyCredentialOpenDx
  );

function vote(req, res) {
  (async () => {
    try {
      const { vote, userId, patientId, lang, comment } = req.body;
      createBlobOpenVote(req.body);

      insights.trackEvent({
        name: 'ChatFeedback',
        properties: {
          vote: vote ? 'positive' : 'negative',
          userId: userId || 'unknown',
          patientId: patientId || 'unknown',
          lang: lang || 'unknown',
          hasComment: !!comment
        }
      });

      res.status(200).send({ send: true })
    } catch (e) {
      insights.error(e);
      console.error("[ERROR] feedback vote: " + e);
      res.status(500).send(e)
    }
  })();
}

async function createBlobOpenVote(body) {
  var info = JSON.stringify(body);
  var now = new Date();
  var y = now.getFullYear();
  var m = now.getMonth() + 1;
  var d = now.getDate();
  var h = now.getHours();
  var mm = now.getMinutes();
  var ss = now.getSeconds();
  var ff = Math.round(now.getMilliseconds() / 10);
  var date = '' + y.toString().substr(-2) + (m < 10 ? '0' : '') + m + (d < 10 ? '0' : '') + d + (h < 10 ? '0' : '') + h + (mm < 10 ? '0' : '') + mm + (ss < 10 ? '0' : '') + ss + (ff < 10 ? '0' : '') + ff;
  var fileNameNcr = 'info.json';
  var name = body.userId + '/' + date;
  var url = y.toString().substr(-2) + '/' + (m < 10 ? '0' : '') + m + '/' + (d < 10 ? '0' : '') + d + '/' + name;
  var tempUrl = '0feedback' + '/' + url;
  await createBlob(tempUrl, info, fileNameNcr);
}

async function createBlob(containerName, data, fileNameToSave) {
  const containerClient = blobServiceOpenDx.getContainerClient(containerName);
  const content = data;
  const blockBlobClient = containerClient.getBlockBlobClient(fileNameToSave);
  await blockBlobClient.upload(content, content.length);
}

module.exports = {
  vote
}
