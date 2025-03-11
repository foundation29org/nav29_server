'use strict'

const crypt = require('./crypt')
const config = require('../config')
const request = require('request')
const storage = require("@azure/storage-blob")
const insights = require('../services/insights')
const accountname = config.BLOB.NAMEBLOB;
const key = config.BLOB.KEY;
const sharedKeyCredentialGenomics = new storage.StorageSharedKeyCredential(accountname, key);
const blobServiceClientGenomics = new storage.BlobServiceClient(
  // When using AnonymousCredential, following url should include a valid SAS or support public access
  `https://${accountname}.blob.core.windows.net`,
  sharedKeyCredentialGenomics
);

var azure = require('azure-storage');

const User = require('../models/user')
const Patient = require('../models/patient')

var blobService = azure
  .createBlobService(accountname, key);

async function deleteContainer(containerName) {
  const containerClient = await blobServiceClientGenomics.getContainerClient(containerName);
  containerClient.delete();
}

async function createContainers(containerName) {
  return new Promise(async (resolve, reject) => {
    // Create a container
    const containerClient = blobServiceClientGenomics.getContainerClient(containerName);

    const createContainerResponse = await containerClient.createIfNotExists();
    if (createContainerResponse.succeeded) {
      resolve(true);
    } else {
      resolve(false);
    }
  });
}

async function checkBlobExists(containerName, blobName) {
  return new Promise(async (resolve, reject) => {
  const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  const exists = await blobClient.exists();

  if (exists) {

    console.log("The blob exists");
    resolve(true);
  } else {
    console.log("The blob does not exist");
    resolve(false);
  }
});
}

async function createBlob(containerName, url, data) {
  return new Promise(async (resolve, reject) => {
    try {
      const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
      let haveContainer = await containerClient.exists();
      if (!haveContainer) {
        await createContainers(containerName);
      }
      const content = data;
      const blockBlobClient = containerClient.getBlockBlobClient(url);
      const uploadBlobResponse = await blockBlobClient.upload(content, content.length);
      resolve(true);
    } catch (error) {
      insights.error(`Failed to create blob: ${url}`, error);
      reject(error); // Rechaza la promesa si ocurre un error
    }
  });
}

async function createBlobMeta(containerName, url, data, metadata) {
  return new Promise(async (resolve, reject) => {
    const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
    let haveContainer = await containerClient.exists();
    if(!haveContainer){
      await createContainers(containerName);
    }
    const content = data;
    const blockBlobClient = containerClient.getBlockBlobClient(url);
    const options = {
      metadata: metadata // Asegúrate de que metadata es un objeto con los metadatos que deseas añadir, por ejemplo: { key: "value" }
    };
    const uploadBlobResponse = await blockBlobClient.upload(content, content.length, options);
    resolve(true);
    //return uploadBlobResponse;
  });
}

async function createBlobSimple(containerName, url, data) {
  return new Promise((resolve, reject) => {
    blobService.createBlockBlobFromText(
      containerName, 
      url,
      JSON.stringify(data),
      function onResponse(error, result) {
        if(error){
          insights.error(error);
          console.log(error);
          resolve(false)
        }
          resolve(true);
      });
  });
  
}


async function deleteBlobsInFolder(containerName, blobName) {
  return new Promise(async function (resolve, reject) {
    const folderName = blobName.substr(0, blobName.lastIndexOf('/') )
    const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
    const blobsInFolder = containerClient.listBlobsFlat({ prefix: folderName });
  
    const deletePromises = [];
  
    for await (const blob of blobsInFolder) {
      deletePromises.push(deleteBlob(containerName, blob.name));
    }

    //delete summary files
    const blobsInFolder2 = containerClient.listBlobsFlat({ prefix: 'raitofile/summary' });
    for await (const blob2 of blobsInFolder2) {
      deletePromises.push(deleteBlob(containerName, blob2.name));
    }
  
    Promise.all(deletePromises)
      .then((data) => {
        console.log("All blobs in folder deleted");
        resolve(true);
      })
      .catch((err) => {
        resolve(false);
      });
    });
}

async function deleteSummaryFilesBlobsInFolder(containerName) {
  return new Promise(async function (resolve, reject) {
    const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
    const deletePromises = [];
    //delete summary files
    const blobsInFolder2 = containerClient.listBlobsFlat({ prefix: 'raitofile/summary' });
    for await (const blob2 of blobsInFolder2) {
      deletePromises.push(deleteBlob(containerName, blob2.name));
    }
  
    Promise.all(deletePromises)
      .then((data) => {
        resolve(true);
      })
      .catch((err) => {
        resolve(false);
      });
    });
}



async function deleteBlob(containerName, blobName) {
  return new Promise((resolve, reject) => {
    blobService.deleteBlobIfExists(containerName,blobName,function(error){
      if (error != null) {
        resolve(false)
      } else {
        resolve(true)
      }
    })
  });
}

async function downloadBlob(containerName, blobName) {
  const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  // Get blob content from position 0 to the end
  // In Node.js, get downloaded data by accessing downloadBlockBlobResponse.readableStreamBody
  const downloadBlockBlobResponse = await blobClient.download();
  const downloaded = (
    await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
  ).toString();
  return downloaded;
}

async function downloadBlobBuffer(containerName, blobName) {
  const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  const downloadBlockBlobResponse = await blobClient.download();
  const downloaded = await streamToBuffer(downloadBlockBlobResponse.readableStreamBody);
  return downloaded; // Return the buffer directly
}

async function listContainerFiles(containerName) {
  const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
  const files = [];
  for await (const blob of containerClient.listBlobsFlat()) {
    files.push(blob.name);
  }
  return files;
}

async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on("error", reject);
  });
}

function getAzureBlobSasTokenWithContainer(req, res) {
  var containerName = req.params.containerName;

  var startDate = new Date();
  var expiryDate = new Date();
  startDate.setTime(startDate.getTime() - 5 * 60 * 1000);
  expiryDate.setTime(expiryDate.getTime() + 24 * 60 * 60 * 1000);

  var containerSAS = storage.generateBlobSASQueryParameters({
    expiresOn: expiryDate,
    permissions: storage.ContainerSASPermissions.parse("rlc"),//rwdlac
    protocol: storage.SASProtocol.Https,
    containerName: containerName,
    startsOn: startDate,
    version: "2017-11-09"

  }, sharedKeyCredentialGenomics).toString();
  res.status(200).send({ containerSAS: containerSAS })
}

async function listBlobsInRoot(containerName) {
  const containerClient = blobServiceClientGenomics.getContainerClient(containerName);

  let iterator = containerClient.listBlobsFlat();
  let blobItems = [];

  for await (const blob of iterator) {
    // Filtrar para incluir solo blobs en la raíz, excluyendo aquellos en subcarpetas
    if (!blob.name.includes('/')) {
      blobItems.push(blob.name);
    }
  }

  return blobItems;
}

async function moveBlob(containerName, destinationPath, blobName) {
  return new Promise(async (resolve, reject) => {
    const containerClient = blobServiceClientGenomics.getContainerClient(containerName);

  // Asegurarse de que el destinationPath sea correcto.
  // La ruta de destino debe incluir el nombre del archivo si quieres que se renombre,
  // o terminar en '/' si quieres mantener el nombre original del archivo.
  let destinationBlobName;
  if (destinationPath.endsWith('/')) {
    // Si destinationPath termina en '/', se agrega el nombre del archivo al final.
    destinationBlobName = `${destinationPath}${blobName}`;
  } else {
    // Si destinationPath no termina en '/', se asume que ya incluye el nombre del archivo.
    destinationBlobName = destinationPath;
  }

  // Obtener una referencia al blob original y al blob de destino
  const sourceBlobClient = containerClient.getBlobClient(blobName);
  const destinationBlobClient = containerClient.getBlobClient(destinationBlobName);

  // Copiar el blob al destino
  await destinationBlobClient.beginCopyFromURL(sourceBlobClient.url);

  // Esperar a que la copia se complete (opcional, depende de tus necesidades)
  // Aquí podrías implementar una lógica para comprobar el estado de la copia si es necesario

  // Eliminar el blob original después de la copia
  await sourceBlobClient.delete();
    resolve(true);
    //return uploadBlobResponse;
  });
}

async function renameBlob(containerName, oldUrl, newUrl) {
    const oldBlobName = oldUrl.replace(/^.*[\\\/]/, '');
    const newBlobName = newUrl.replace(/^.*[\\\/]/, '');
    const containerClient = blobServiceClientGenomics.getContainerClient(containerName);
    
    const sourceBlob = containerClient.getBlobClient(oldUrl);
    const targetBlob = containerClient.getBlobClient(newUrl);
    
    const response = await targetBlob.beginCopyFromURL(sourceBlob.url);
    await response.pollUntilDone();
    
    await sourceBlob.delete();
    
    return true;
}

module.exports = {
  deleteContainer,
  createContainers,
  checkBlobExists,
  createBlob,
  createBlobMeta,
  createBlobSimple,
  deleteBlobsInFolder,
  deleteSummaryFilesBlobsInFolder,
  deleteBlob,
  downloadBlob,
  downloadBlobBuffer,
  listContainerFiles,
  getAzureBlobSasTokenWithContainer,
  listBlobsInRoot,
  moveBlob,
  renameBlob
}
