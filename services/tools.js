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
      throw error;
    }
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
  const { gemini2flash_thinking_exp } = createModels('default', 'gemini2flash_thinking_exp');//gemini15flash_2
  const contextTemplate = await pull('foundation29/context_curation_base_v1');
  const runnable = contextTemplate.pipe(gemini2flash_thinking_exp);
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
    createIndexIfNone,
    suggestionsFromConversation,
    curateContext
};
