const { SearchIndexClient, SearchClient } = require("@azure/search-documents");
const { AzureKeyCredential } = require("@azure/core-auth");

// Polyfill for crypto in Node.js 18
if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

const { AzureAISearchVectorStore, AzureAISearchQueryType } = require("@langchain/community/vectorstores/azure_aisearch");
const config = require('../config');

async function createIndexIfNone(indexName, embeddings, vectorStoreAddress, vectorStorePassword) {
  const indexClient = new SearchIndexClient(vectorStoreAddress, new AzureKeyCredential(vectorStorePassword));
  
  const fields = [
    { name: "id", type: "Edm.String", key: true, filterable: true },
    { name: "content", type: "Edm.String", searchable: true },
    { name: "source", type: "Edm.String", filterable: true, searchable: true },
    {
      name: "content_vector", // Usamos el estándar de LangChain por defecto
      type: "Collection(Edm.Single)",
      searchable: true,
      retrievable: true, // ✅ Permitir recuperar para reindexación
      vectorSearchDimensions: 3072,
      vectorSearchProfileName: "myHnswProfile"
    },
    { name: "metadata", type: "Edm.String", searchable: true, filterable: true }
  ];

  try {
    const existingIndex = await indexClient.getIndex(indexName);
    const hasSource = existingIndex.fields.some(f => f.name === 'source');
    const hasStandardVector = existingIndex.fields.some(f => f.name === 'content_vector');
    
    if (!hasSource || !hasStandardVector) {
      console.warn(`Warning: Index ${indexName} schema mismatch. Recreating with standard names...`);
      await indexClient.deleteIndex(indexName);
      throw { statusCode: 404 };
    }
  } catch (error) {
    if (error.statusCode === 404 || error.message?.includes("not found")) {
      console.log(`Creating/Recreating index ${indexName} with standard schema...`);
      await indexClient.createIndex({
        name: indexName,
        fields: fields,
        vectorSearch: {
          profiles: [{ name: "myHnswProfile", algorithmConfigurationName: "myHnsw" }],
          algorithms: [{ name: "myHnsw", kind: "hnsw" }]
        }
      });
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      throw error;
    }
  }

  return new AzureAISearchVectorStore(embeddings, {
    indexName: indexName,
    endpoint: vectorStoreAddress,
    key: vectorStorePassword,
    // Dejamos que LangChain use sus nombres por defecto para máxima estabilidad
    search: {
      type: AzureAISearchQueryType.Similarity
    }
  });
}

async function createChunksIndex(embeddings, vectorStoreAddress, vectorStorePassword) {
  const indexName = config.cogsearchIndexChunks;
  const indexClient = new SearchIndexClient(vectorStoreAddress, new AzureKeyCredential(vectorStorePassword));

  const fields = [
    { name: "id", type: "Edm.String", key: true, filterable: true },
    { name: "patientId", type: "Edm.String", filterable: true },
    { name: "documentId", type: "Edm.String", filterable: true },
    { name: "reportDate", type: "Edm.DateTimeOffset", filterable: true, sortable: true },
    { name: "dateStatus", type: "Edm.String", filterable: true },
    { name: "documentType", type: "Edm.String", filterable: true },
    { name: "filename", type: "Edm.String", filterable: true, searchable: true },
    { name: "content", type: "Edm.String", searchable: true },
    {
      name: "content_vector", // Unificado al estándar
      type: "Collection(Edm.Single)",
      searchable: true,
      retrievable: true, // ✅ Permitir recuperar para reindexación
      vectorSearchDimensions: 3072,
      vectorSearchProfileName: "myHnswProfile"
    },
    { name: "metadata", type: "Edm.String", filterable: true }
  ];

  try {
    const existingIndex = await indexClient.getIndex(indexName);
    const hasStandardVector = existingIndex.fields.some(f => f.name === 'content_vector');
    if (!hasStandardVector) {
      console.warn(`Warning: Index ${indexName} is missing standard vector field. Recreating...`);
      await indexClient.deleteIndex(indexName);
      throw { statusCode: 404 };
    }
  } catch (error) {
    if (error.statusCode === 404 || error.message?.includes("not found")) {
      console.log(`Creating chunks index ${indexName} with standard schema...`);
      await indexClient.createIndex({
        name: indexName,
        fields: fields,
        vectorSearch: {
          profiles: [{ name: "myHnswProfile", algorithmConfigurationName: "myHnsw" }],
          algorithms: [{ name: "myHnsw", kind: "hnsw" }]
        }
      });
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      throw error;
    }
  }

  return new AzureAISearchVectorStore(embeddings, {
    indexName: indexName,
    endpoint: vectorStoreAddress,
    key: vectorStorePassword,
    search: { type: AzureAISearchQueryType.Similarity },
    // Configuración de campos para que LangChain mapee correctamente
    textFieldName: "content",
    vectorFieldName: "content_vector",
    // Indicamos que queremos recuperar estos campos de primer nivel como metadata
    additionalSearchResultFields: ["filename", "reportDate", "dateStatus", "documentId", "documentType", "patientId"]
  });
}

async function reindexDocumentMetadata(documentId, patientId, newMetadata) {
  const indexName = config.cogsearchIndexChunks;
  const vectorStoreAddress = config.SEARCH_API_ENDPOINT;
  const vectorStorePassword = config.SEARCH_API_KEY;
  const searchClient = new SearchClient(vectorStoreAddress, indexName, new AzureKeyCredential(vectorStorePassword));

  try {
    const searchResults = await searchClient.search("*", {
      filter: `documentId eq '${documentId}' and patientId eq '${patientId}'`,
      select: ["id", "content", "content_vector", "metadata", "patientId", "documentId", "documentType", "filename"]
    });

    const documentsToUpdate = [];
    for await (const result of searchResults.results) {
      documentsToUpdate.push({
        ...result.document,
        reportDate: newMetadata.reportDate,
        dateStatus: newMetadata.dateStatus
      });
    }

    if (documentsToUpdate.length > 0) {
      await searchClient.uploadDocuments(documentsToUpdate);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Error reindexando:`, error);
    throw error;
  }
}

module.exports = { createIndexIfNone, createChunksIndex, reindexDocumentMetadata };
