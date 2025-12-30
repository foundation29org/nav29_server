const OpenAI = require('openai');
const { DynamicStructuredTool } = require("@langchain/core/tools");
const {createModels} = require('../services/langchain');
const azure_blobs = require('../services/f29azure');
const pubsub = require('../services/pubsub');
const { pull } = require('langchain/hub');
const { z } = require("zod");
const config = require('../config');
const { v4: uuidv4 } = require('uuid');
const { MediSearchClient } = require('./medisearch');
const pubsubClient = require('../services/pubsub');
const { LangGraphRunnableConfig } = require("@langchain/langgraph");
const insights = require('./insights');

const PERPLEXITY_API_KEY = config.PERPLEXITY_API_KEY;

const {
  AzureAISearchVectorStore,
  AzureAISearchQueryType,
} = require("@langchain/community/vectorstores/azure_aisearch");

const { SearchIndexClient } = require("@azure/search-documents");
const { AzureKeyCredential } = require("@azure/core-auth");

async function createIndexIfNone(indexName, embeddings, vectorStoreAddress, vectorStorePassword) {
  const sampleEmbedding = await embeddings.embedQuery("Text");

  const fields = [
    {
      name: "id",
      type: "Edm.String", 
      key: true,
      filterable: true
    },
    {
      name: "content",
      type: "Edm.String",
      searchable: true
    },
    {
      name: "content_vector",
      type: "Collection(Edm.Single)",
      searchable: true,
      dimensions: sampleEmbedding.length,
      vectorSearchProfile: "myHnswProfile"
    },
    {
      name: "metadata",
      type: "Edm.String",
      searchable: true,
      filterable: true
    }
  ];

  const indexClient = new SearchIndexClient(vectorStoreAddress, new AzureKeyCredential(vectorStorePassword));
  
  try {
    const index = await indexClient.getIndex(indexName);
    const indexExists = index !== undefined;

    let vectorStore;
    if (!indexExists) {
      vectorStore = new AzureAISearchVectorStore(embeddings, {
        indexName: indexName,
        endpoint: vectorStoreAddress,
        key: vectorStorePassword,
        fields: fields
      });
      // console.log("Index created", vectorStore);
    } else {
      // console.log("Index already exists");
      vectorStore = new AzureAISearchVectorStore(embeddings, {
        indexName: indexName,
        endpoint: vectorStoreAddress,
        key: vectorStorePassword,
        search: {
          type: AzureAISearchQueryType.Similarity
        }
      });
    }
    return vectorStore;
  } catch (error) {
    if (error.message.includes("No index with the name")) {
      console.log("Index not found, creating new index");
      vectorStore = new AzureAISearchVectorStore(embeddings, {
        indexName: indexName,
        endpoint: vectorStoreAddress,
        key: vectorStorePassword,
        fields: fields
      });
      return vectorStore;
    } else {
      console.error("Error creating/accessing index:", error);
      throw error;
    }
  }
}

const perplexity = new OpenAI({
  apiKey: PERPLEXITY_API_KEY,
  baseURL: 'https://api.perplexity.ai',
});

const perplexityTool = new DynamicStructuredTool({
  name: "call_perplexity",
  description: "Use this default tool get an answer to a live web search question. You can also use this tool to get answers about medication, papers, clinical trials, etc. You can also use this for general web search questions.",
  schema: z.object({
    question: z.string().describe("The question to ask Perplexity"),
  }),
  func: async ({ question }) => {
    try {
      const response = await perplexity.chat.completions.create({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [{ role: "user", content: question }],
      });
      console.log(response);
      return response.choices[0].message.content || "No response from Perplexity";
    } catch (error) {
      console.error('Error calling Perplexity API:', error);
      insights.error({ message: 'Error calling Perplexity API', error: error });
      throw error;
    }
  },
});

const mediSearchTool = new DynamicStructuredTool({
  name: "call_medisearch",
  description: "Default tool for general medical question-answering search. Use this one first. MediSearch is a SOTA medical question-answering system.",
  schema: z.object({
    question: z.string().describe("The medical question to ask MediSearch in English"),
  }),
  func: async ({ question }) => {
    try {
      const conversationId = uuidv4();
      const client = new MediSearchClient(config.MEDISEARCH_API_KEY);
      
      // console.log("Sending question to MediSearch:", question);

      const response = await client.sendUserMessage(
        [question], // conversation array with just the current question
        conversationId,
        "English"
      );
      
      if (response.event === "error") {
        throw new Error(response.text || "MediSearch error");
      }
      
      return response.text;
    } catch (error) {
      console.error('Error calling MediSearch:', error);
      insights.error({ message: 'Error calling MediSearch', error: error });
      throw error;
    }
  },
});

const clinicalTrialsTool = new DynamicStructuredTool({
  name: "clinical_trials_search",
  description: "Use this tool to search for clinical trials, medical studies, research protocols or clinical trials for patients",
  schema: z.object({
    // No input parameters required - condition is now optional and will be handled internally
  }),
  func: async (_, config) => {
    // Get user language from configuration
    const userLang = config?.configurable?.userLang || 'en';
    
    // Define translations for different languages
    const translations = {
      'en': `To find relevant clinical trials, you can use our specialized platform <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, which allows you to search for active studies, filter by location, and verify eligibility criteria in a personalized way.`,
      'es': `Para encontrar ensayos clínicos relevantes, puedes usar nuestra plataforma especializada <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, que te permite buscar estudios activos, filtrar por ubicación y verificar criterios de elegibilidad de forma personalizada.`,
      'fr': `Pour trouver des essais cliniques pertinents, vous pouvez utiliser notre plateforme spécialisée <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, qui vous permet de rechercher des études actives, de filtrer par localisation et de vérifier les critères d'éligibilité de manière personnalisée.`,
      'de': `Um relevante klinische Studien zu finden, können Sie unsere spezialisierte Plattform <a href='https://trialgpt.app' target='_blank'>TrialGPT</a> nutzen, mit der Sie aktive Studien suchen, nach Standort filtern und Zulassungskriterien personalisiert überprüfen können.`,
      'it': `Per trovare studi clinici rilevanti, puoi utilizzare la nostra piattaforma specializzata <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, che ti permette di cercare studi attivi, filtrare per posizione e verificare i criteri di idoneità in modo personalizzato.`,
      'pt': `Para encontrar ensaios clínicos relevantes, você pode usar nossa plataforma especializada <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, que permite pesquisar estudos ativos, filtrar por localização e verificar critérios de elegibilidade de forma personalizada.`
    };
    
    // Return message in user's language, default to English if language not supported
    return translations[userLang] || translations['en'];
  },
});

async function suggestionsFromConversation(messages) {
  let { claude35sonnet } = createModels('default', 'claude35sonnet');
  const suggestionsTemplate = await pull('foundation29/conv_suggestions_base_v1');
  const runnable = suggestionsTemplate.pipe(claude35sonnet);
  const suggestions = await runnable.invoke({
    chat_history: messages
  });
  // console.log(suggestions);
  let suggestionsArray = JSON.parse(suggestions.suggestions);
  return suggestionsArray.suggestions;
}

async function processDocs(docs, containerName) {
  // Let's process the data first
  let docsSummaries = [];
  for (let doc of docs) {
    let url = doc.replace(/\/[^\/]*$/, '/summary_translated.txt');
    let docSummary = await azure_blobs.downloadBlob(containerName, url);
    docsSummaries.push(docSummary);
  }
  let docsSummariesString = docsSummaries.map((summary, i) => `<Document Summary ${i+1}>\n${summary}\n</Document Summary ${i+1}>`).join('\n\n');
  return docsSummariesString;
}

async function curateContext(context, memories, containerName, docs, question) {
  const { gemini25pro } = createModels('default', 'gemini25pro');
  const contextTemplate = await pull('foundation29/context_curation_base_v1');
  const runnable = contextTemplate.pipe(gemini25pro);
  // Let's process the data first
  let docsSummaries = await processDocs(docs, containerName);
  let contextContent = context.map(c => `${c.role}: ${JSON.stringify(c.content)}`).join('\n\n'); // fix
  let memoriesString = memories.map((m, i) => `<Relevant Memory ${i+1}>\n${m.pageContent}\n</Relevant Memory ${i+1}>`).join('\n\n');
  
  let curatedContext = await runnable.invoke({
    context: contextContent,
    memories: memoriesString,
    docs: docsSummaries,
    question: question
  });

  return curatedContext;
}

module.exports = { 
    perplexityTool,
    mediSearchTool,
    clinicalTrialsTool,
    createIndexIfNone,
    suggestionsFromConversation,
    curateContext
};
