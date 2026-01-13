const { createModels, embeddings } = require('./langchain');
const { createChunksIndex, createIndexIfNone } = require('./vectorStoreService');
const config = require('../config');
const { AzureAISearchQueryType } = require("@langchain/community/vectorstores/azure_aisearch");
const { pull } = require('langchain/hub');
const { ChatPromptTemplate } = require("@langchain/core/prompts");

/**
 * Retrieval Plans - Internal logic in English
 */
const RETRIEVAL_PLANS = {
  FACTUAL: {
    id: 'FACTUAL',
    k_candidates: 25,
    evidence_budget: 5,
    description: "Specific clinical data points (cholesterol, dosage, results)"
  },
  TREND: {
    id: 'TREND',
    k_candidates: 60,
    evidence_budget: 10,
    description: "Evolution, history or trends over time"
  },
  COMPARISON: {
    id: 'COMPARISON',
    k_candidates: 50,
    evidence_budget: 8,
    description: "Comparing periods or states (before/after)"
  },
  EXPLANATION: {
    id: 'EXPLANATION',
    k_candidates: 25,
    evidence_budget: 6,
    description: "Medical explanations or interpretations"
  },
  LOCATE: {
    id: 'LOCATE',
    k_candidates: 30,
    evidence_budget: 6,
    description: "Finding the exact source or document for a fact"
  },
  MEDICATION: {
    id: 'MEDICATION',
    k_candidates: 40,
    evidence_budget: 10,
    description: "Questions about medications, drugs and doses"
  },
  AMBIGUOUS: {
    id: 'AMBIGUOUS',
    k_candidates: 40,
    evidence_budget: 6,
    description: "General, broad or unclear questions"
  }
};

/**
 * Detects intent using an LLM (GPT-4o-Mini) to support any language
 */
async function detectIntent(question, patientId) {
  try {
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId} - Intent`;
    let { gpt5mini } = createModels(projectName, 'gpt5mini');
    
    // Attempt to pull from Hub
    let intentPrompt;
    try {
      intentPrompt = await pull("foundation29/detect_intent_v1");
    } catch (e) {
      console.warn("Prompt foundation29/detect_intent_v1 not found, using local fallback");
      intentPrompt = ChatPromptTemplate.fromMessages([
        ["system", `You are an expert clinical intent classifier for a medical RAG system.
        Your task is to analyze the user's question and assign it to exactly one of the following category IDs.

        ### CATEGORIES:
        - FACTUAL: Specific clinical values, latest results, or isolated data points (e.g., "What's my glucose?", "Give me my latest cholesterol").
        - TREND: Evolution, history, or trends over time (e.g., "How has my weight changed?", "Show me the evolution of my tests this year").
        - COMPARISON: Comparing two or more periods, states, or specific events (e.g., "before vs after treatment", "compare this report with the one from 2022").
        - EXPLANATION: Medical explanations, interpretations of symptoms, or general medical knowledge (e.g., "what does this diagnosis mean?", "is this value dangerous?").
        - LOCATE: Finding the exact source, date, or document where something was mentioned (e.g., "where does it say I have anemia?", "which report mentions the biopsy?").
        - MEDICATION: Questions about drugs, dosages, prescriptions, or treatments (e.g., "how much metformin should I take?", "list my active meds").
        - AMBIGUOUS: General, broad, or unclear questions that don't fit the above.

        ### RULES:
        1. Output ONLY the uppercase ID (e.g., TREND).
        2. No preamble, no punctuation, no explanations.
        3. If multiple categories apply, choose the one that requires the HIGHEST number of documents (TREND > COMPARISON > FACTUAL).
        4. The user may ask in any language; classify the intent regardless of the language.`],
        ["human", "User Question: {question}\nID:"]
      ]);
    }

    const chain = intentPrompt.pipe(gpt5mini);
    const response = await chain.invoke({ question });
    const detectedId = response.content.trim().toUpperCase();
    
    return RETRIEVAL_PLANS[detectedId] || RETRIEVAL_PLANS.AMBIGUOUS;
  } catch (error) {
    console.error("Error detecting intent with LLM:", error);
    return RETRIEVAL_PLANS.AMBIGUOUS;
  }
}

/**
 * Performs a hybrid search on the chunks index using native Azure Search Client
 */
async function retrieveChunks(question, patientId, plan) {
  const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
  const { Document } = require("@langchain/core/documents");
  
  const vectorStoreAddress = config.SEARCH_API_ENDPOINT;
  const vectorStorePassword = config.SEARCH_API_KEY;
  const indexName = config.cogsearchIndexChunks;
  
  // Crear SearchClient nativo para control total
  const searchClient = new SearchClient(
    vectorStoreAddress,
    indexName,
    new AzureKeyCredential(vectorStorePassword)
  );
  
  // Generar embedding de la pregunta
  const queryEmbedding = await embeddings.embedQuery(question);
  
  // Búsqueda híbrida (vectorial + filtro por patientId)
  const searchResults = await searchClient.search(question, {
    filter: `patientId eq '${patientId}'`,
    vectorSearchOptions: {
      queries: [{
        kind: 'vector',
        vector: queryEmbedding,
        kNearestNeighborsCount: plan.k_candidates,
        fields: ['content_vector']
      }]
    },
    select: ['id', 'content', 'filename', 'reportDate', 'dateStatus', 'documentId', 'documentType', 'patientId'],
    top: plan.k_candidates
  });
  
  // Convertir resultados a formato Document de LangChain
  const documents = [];
  for await (const result of searchResults.results) {
    const doc = new Document({
      pageContent: result.document.content || '',
      metadata: {
        id: result.document.id,
        filename: result.document.filename,
        reportDate: result.document.reportDate,
        dateStatus: result.document.dateStatus,
        documentId: result.document.documentId,
        documentType: result.document.documentType,
        patientId: result.document.patientId,
        score: result.score
      }
    });
    documents.push(doc);
  }
  
  return documents;
}

/**
 * Reranks and selects evidence based on the plan
 */
function deterministicRerank(chunks, plan) {
  const sorted = [...chunks].sort((a, b) => {
    const dateA = new Date(a.metadata.reportDate || 0);
    const dateB = new Date(b.metadata.reportDate || 0);
    return dateB - dateA;
  });

  const selected = [];
  const docCounts = {};
  
  for (const chunk of sorted) {
    const docId = chunk.metadata.documentId;
    docCounts[docId] = (docCounts[docId] || 0) + 1;
    
    // If it's a trend question, we allow a bit more document diversity
    const maxPerDoc = plan.id === 'TREND' ? 2 : 3;
    
    if (docCounts[docId] <= maxPerDoc) {
      selected.push(chunk);
    }
    
    if (selected.length >= plan.evidence_budget) break;
  }

  return selected;
}

/**
 * Extracts structured facts from chunks using an LLM
 * @param {string} chatMode - 'fast' uses gpt4omini, 'advanced' uses gpt5mini
 */
async function extractStructuredFacts(chunks, question, patientId, chatMode = 'fast') {
  try {
    const projectName = `${config.LANGSMITH_PROJECT} - ${patientId} - Extraction`;
    // Seleccionar modelo según chatMode
    let model;
    if (chatMode === 'advanced') {
      const { gpt5mini } = createModels(projectName, 'gpt5mini');
      model = gpt5mini;
    } else {
      const { gpt4omini } = createModels(projectName, 'gpt4omini');
      model = gpt4omini;
    }
    
    let extractionPrompt;
    try {
      extractionPrompt = await pull("foundation29/extract_structured_facts_v1");
    } catch (e) {
      console.warn("Prompt foundation29/extract_structured_facts_v1 not found, using local fallback");
      extractionPrompt = ChatPromptTemplate.fromMessages([
        ["system", `You are a medical data extraction expert. Your goal is to extract clinical facts from the provided fragments (chunks) that are relevant to the user's question.

        ### OUTPUT FORMAT:
        Return ONLY a JSON array of objects. 
        Each object must have these exact keys:
        - "fact": Short description of the finding.
        - "value": The numerical value (if any, otherwise null).
        - "unit": The unit of measurement (if any, otherwise null).
        - "date": The date mentioned in the chunk or report (YYYY-MM-DD).
        - "source": The filename or ID of the document.

        ### CONTEXT CHUNKS:
        {context}

        ### USER QUESTION:
        {question}`],
        ["human", "Extract the relevant facts in JSON format."]
      ]);
    }

    const chunksText = chunks.map((c, i) => `[Chunk ${i+1}] (Doc: ${c.metadata.filename}, Fecha: ${c.metadata.reportDate})\n${c.pageContent}`).join('\n\n');
    
    const runnable = extractionPrompt.pipe(model);
    const result = await runnable.invoke({
      context: chunksText,
      question: question
    });

    let structuredData = [];
    try {
      let content = result.content.trim();
      if (content.startsWith("```json")) content = content.slice(7, -3).trim();
      else if (content.startsWith("```")) content = content.slice(3, -3).trim();
      structuredData = JSON.parse(content);
    } catch (parseError) {
      console.error("Error parseando extracción estructurada:", parseError);
    }

    return structuredData;
  } catch (error) {
    console.error("Error en extractStructuredFacts:", error);
    return [];
  }
}

module.exports = {
  detectIntent,
  RETRIEVAL_PLANS,
  retrieveChunks,
  deterministicRerank,
  extractStructuredFacts
};
