const OpenAI = require('openai');
const { DynamicStructuredTool } = require("@langchain/core/tools");
const {createModels} = require('../services/langchain');
const azure_blobs = require('../services/f29azure');
const pubsub = require('../services/pubsub');
const { pull } = require('langchain/hub');
const { z } = require("zod");
const { ChatPromptTemplate } = require("@langchain/core/prompts");
const config = require('../config');
const { v4: uuidv4 } = require('uuid');
const { MediSearchClient } = require('./medisearch');
const pubsubClient = require('../services/pubsub');
const { LangGraphRunnableConfig } = require("@langchain/langgraph");
const insights = require('./insights');
const { createIndexIfNone, createChunksIndex } = require('./vectorStoreService');

const PERPLEXITY_API_KEY = config.PERPLEXITY_API_KEY;

const {
  AzureAISearchVectorStore,
  AzureAISearchQueryType,
} = require("@langchain/community/vectorstores/azure_aisearch");

const { SearchIndexClient } = require("@azure/search-documents");
const { AzureKeyCredential } = require("@azure/core-auth");

// Polyfill for crypto in Node.js 18 (required by Azure AI Search libraries)
if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
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
  }),
  func: async (_, config) => {
    const userLang = config?.configurable?.userLang || 'en';
    
    const translations = {
      'en': `To find relevant clinical trials, you can use our specialized platform <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, which allows you to search for active studies, filter by location, and verify eligibility criteria in a personalized way.`,
      'es': `Para encontrar ensayos clínicos relevantes, puedes usar nuestra plataforma especializada <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, que te permite buscar estudios activos, filtrar por ubicación y verificar criterios de elegibilidad de forma personalizada.`,
      'fr': `Pour trouver des essais cliniques pertinents, vous pouvez utiliser notre plateforme spécialisée <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, qui vous permet de rechercher des études actives, de filtrer par localisation et de vérifier les critères d'éligibilité de manière personnalisée.`,
      'de': `Um relevante klinische Studien zu finden, können Sie unsere spezialisierte Plattform <a href='https://trialgpt.app' target='_blank'>TrialGPT</a> nutzen, mit der Sie aktive Studien suchen, nach Standort filtern und Zulassungskriterien personalisiert überprüfen können.`,
      'it': `Per trovare studi clinici rilevanti, puoi utilizzare la nostra piattaforma specializzata <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, che ti permette di cercare studi attivi, filtrare per posizione e verificare i criteri di idoneità in modo personalizzato.`,
      'pt': `Para encontrar ensaios clínicos relevantes, você pode usar nossa plataforma especializada <a href='https://trialgpt.app' target='_blank'>TrialGPT</a>, que permite pesquisar estudos ativos, filtrar por localização e verificar critérios de elegibilidade de forma personalizada.`
    };
    
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
  let suggestionsArray = JSON.parse(suggestions.suggestions);
  return suggestionsArray.suggestions;
}

async function processDocs(docs, containerName) {
  let docsSummaries = [];
  for (let doc of docs) {
    let url = doc.replace(/\/[^\/]*$/, '/summary_translated.txt');
    let docSummary = await azure_blobs.downloadBlob(containerName, url);
    docsSummaries.push(docSummary);
  }
  let docsSummariesString = docsSummaries.map((summary, i) => `<Document Summary ${i+1}>\n${summary}\n</Document Summary ${i+1}>`).join('\n\n');
  return docsSummariesString;
}

async function curateContext(context, memories, containerName, docs, question, selectedChunks = [], structuredFacts = []) {
  const { gemini25pro } = createModels('default', 'gemini25pro');
  
  let contextTemplate;
  try {
    // New version name to avoid affecting production
    contextTemplate = await pull('foundation29/context_curation_v2');
  } catch (e) {
    console.warn("Prompt foundation29/context_curation_v2 not found, using local fallback");
    contextTemplate = ChatPromptTemplate.fromMessages([
      ["system", `You are a high-precision medical context curator. Your goal is to synthesize multiple sources of patient information into a single, coherent "Source of Truth" for a specific medical question.

      ### HIERARCHY OF TRUTH (Follow strictly):
      1. CONVERSATION CONTEXT: Contains demographic data (age, gender, weight, height), lifestyle, and recent user-provided updates. USE THIS FIRST for patient demographics.
      2. EVIDENCE CHUNKS & STRUCTURED FACTS: Primary sources for clinical values. Use literal text and exact numbers from here.
      3. DOCUMENT SUMMARIES: Use these for general clinical background and context.
      4. LONG-TERM MEMORIES: Use this to understand previous conversations.

      ### YOUR TASKS:
      - Extract and ALWAYS include demographic data from CONVERSATION CONTEXT (age, gender, weight, height, lifestyle) if present.
      - Summarize only the information relevant to the user's specific question.
      - When citing a clinical value from EVIDENCE CHUNKS, ALWAYS format as: [filename, YYYY-MM-DD]
      - If the reportDate is missing or null, use: [filename, undated]
      - If there are multiple values for the same test (e.g., cholesterol), highlight the most recent one but also mention the historical trend if found.
      - If there is a contradiction between a summary and a literal chunk, prioritize the chunk.

      ### CITATION FORMAT (CRITICAL - EXAMPLES):
      CORRECT: "cholesterol is 260 mg/dL [Analítica 14-04-25.pdf, 2025-04-14]"
      CORRECT: "hernia diagnosed [Report March 2020.pdf, undated]"
      WRONG: "cholesterol is 260 mg/dL [indefinido]"
      WRONG: "cholesterol is 260 mg/dL" (missing citation)

      ### OUTPUT FORMAT:
      Your output will be directly injected into the agent's context. Structure it as:
      
      PATIENT PROFILE:
      [Include age, gender, height, weight, lifestyle if available from conversation context]
      
      RELEVANT CLINICAL DATA:
      [Cite each value with [filename, date] format]
      
      HISTORICAL CONTEXT:
      [Include trends or past values if relevant to the question]

      ### CONSTRAINTS:
      - Do NOT hallucinate values or dates.
      - Keep the tone professional and clinical.
      - Output ONLY the curated context. No preamble or explanations about your process.
      - ALWAYS cite sources for clinical data using the [filename, date] format.`],
      ["human", `Question: {question}

      <conversation_context_with_demographics>
      {context}
      </conversation_context_with_demographics>

      <clinical_evidence_chunks>
      {chunks}
      </clinical_evidence_chunks>

      <extracted_structured_facts>
      {facts}
      </extracted_structured_facts>

      <document_summaries>
      {docs}
      </document_summaries>

      <long_term_memories>
      {memories}
      </long_term_memories>

      CURATED CONTEXT:`]
    ]);
  }

  const runnable = contextTemplate.pipe(gemini25pro);
  
  let docsSummaries = await processDocs(docs, containerName);
  let contextContent = context.map(c => `${c.role}: ${JSON.stringify(c.content)}`).join('\n\n');
  let memoriesString = memories.map((m, i) => `<Recent Conversation Memory ${i+1}>\n${m.pageContent}\n</Recent Conversation Memory ${i+1}>`).join('\n\n');
  
  let chunksString = selectedChunks.map((c, i) => {
    // Formatear reportDate a ISO simple (YYYY-MM-DD) si existe
    let formattedDate = 'undated';
    if (c.metadata?.reportDate) {
      try {
        const date = new Date(c.metadata.reportDate);
        formattedDate = date.toISOString().split('T')[0];
      } catch (e) {
        formattedDate = 'undated';
      }
    }
    return `<Evidence Chunk ${i+1} (Doc: ${c.metadata?.filename || 'unknown'}, Fecha: ${formattedDate})>\n${c.pageContent}\n</Evidence Chunk ${i+1}>`;
  }).join('\n\n');
  
  // DEBUG: Verificar formato de chunks antes de pasar al prompt
  console.log('\n🔍 CHUNKS FORMATEADOS PARA CURACIÓN:');
  console.log(chunksString.substring(0, 500) + '...\n');
  
  let factsString = JSON.stringify(structuredFacts, null, 2);

  let curatedContext = await runnable.invoke({
    context: contextContent,
    memories: memoriesString,
    docs: docsSummaries,
    question: question,
    chunks: chunksString,
    facts: factsString
  });

  return curatedContext;
}

module.exports = { 
    perplexityTool,
    mediSearchTool,
    clinicalTrialsTool,
    createIndexIfNone,
    createChunksIndex,
    suggestionsFromConversation,
    curateContext
};
