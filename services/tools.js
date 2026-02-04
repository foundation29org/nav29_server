const OpenAI = require('openai');
const axios = require('axios');
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

const perplexityTool = new DynamicStructuredTool({
  name: "call_perplexity",
  description: "ONLY use this tool when you need VERY RECENT information (2025-2026, latest news, breaking updates) that is NOT in your training data or the patient's documents. Do NOT use this for general medical questions that you can answer with your knowledge or the patient's medical records. Use this ONLY for: (1) Latest research papers published in 2025-2026, (2) Recent news or regulatory approvals from 2025-2026, (3) Very current clinical trial status updates (2025-2026), (4) Information explicitly requested as 'latest', 'recent', 'breaking', or 'new' that you cannot find in patient documents. IMPORTANT: Always include the current year (2026) in your search query to ensure you get the most recent information.",
  schema: z.object({
    question: z.string().describe("The specific question to ask Perplexity about very recent information. MUST include '2025' or '2026' or 'latest' or 'recent' in the query to ensure current information."),
  }),
  func: async ({ question }, config) => {
    try {
      // Asegurar que la pregunta incluya el año actual para forzar búsqueda reciente
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const previousYear = currentYear - 1;
      const currentMonth = currentDate.toLocaleString('en-US', { month: 'long' });
      const currentDay = currentDate.getDate();
      
      // Obtener contexto curado del paciente si está disponible
      const curatedContext = config?.configurable?.curatedContext || '';
      
      // Construir prompt que incluya el contexto del paciente
      // Perplexity se encargará de extraer la información relevante del contexto
      let enhancedQuestion = question;
      
      // Si hay contexto curado, añadirlo al prompt para que Perplexity tenga información del paciente
      // Limitar a 1000 caracteres para no saturar el prompt pero mantener información relevante
      if (curatedContext && curatedContext.length > 0) {
        const contextSnippet = curatedContext.substring(0, 1000);
        enhancedQuestion = `${question}\n\nPatient medical context (for reference): ${contextSnippet}`;
      }
      
      // Si no menciona años recientes, añadirlos
      if (!/\b(202[4-6]|2025|2026|latest|recent|breaking|new)\b/i.test(enhancedQuestion)) {
        enhancedQuestion = `${enhancedQuestion} Focus exclusively on information from ${previousYear} and ${currentYear}. Only include information published or updated in ${previousYear}-${currentYear}. Ignore any information from before ${previousYear}.`;
      } else {
        // Reforzar el año actual si ya menciona años
        enhancedQuestion = `${enhancedQuestion} Prioritize information from ${currentYear} and ${previousYear}. Exclude information from before ${previousYear}.`;
      }
      
      // System prompt que fuerza el uso de información reciente y búsqueda activa
      // Si hay contexto del paciente, enfocarse en su diagnóstico específico
      const hasPatientContext = curatedContext && curatedContext.length > 0;
      const contextInstruction = hasPatientContext 
        ? `\n\nPATIENT-SPECIFIC FOCUS:
- The user's question includes patient medical context. Extract the specific diagnosis, condition, or genetic mutation from the context.
- Focus your search on information relevant to THAT SPECIFIC PATIENT'S CONDITION, not general information.
- If the patient has a specific genetic mutation, disease subtype, or rare condition mentioned in the context, prioritize information about that specific condition.
- Only provide general information if you cannot find information specific to the patient's condition.
- Always relate your findings back to the patient's specific diagnosis when possible.`
        : '';

      const systemPrompt = `You are a medical search engine specialized in finding the LATEST medical information. Today is ${currentMonth} ${currentDay}, ${currentYear}.

CRITICAL INSTRUCTIONS:
1. You MUST search the web actively for information from ${previousYear} and ${currentYear}. Do NOT rely on your training data which may be outdated.
2. Prioritize information published in ${currentYear} over ${previousYear}.
3. If you find information from before ${previousYear}, explicitly state that it is historical context, not current.
4. For medical treatments, FDA approvals, clinical trials, or research papers, ONLY include information from ${previousYear}-${currentYear}.
5. If you cannot find recent information (${previousYear}-${currentYear}), state clearly: "I could not find information from ${previousYear}-${currentYear} on this topic. The following is historical information that may be outdated."
6. Always cite the publication date or year when available.
7. IMPORTANT: If you successfully searched the web and found results, provide them directly. Do NOT say "I attempted to fetch", "I couldn't complete the search", "I wasn't able to retrieve", or similar phrases. Only mention search issues if you genuinely found NO results after searching.
8. Be direct and confident in your answers when you have information from web search.${contextInstruction}

Your goal is to provide the MOST CURRENT medical information available on the web, not information from your training data.`;

      
      // Usar axios directamente con sonar-pro (sin fallback)
      const perplexityResponse = await axios.post('https://api.perplexity.ai/chat/completions', {
        model: 'sonar-pro',
        messages: [
          { 
            role: "system", 
            content: systemPrompt
          },
          { 
            role: "user", 
            content: enhancedQuestion 
          }
        ],
        search_mode: "academic",
        web_search_options: { 
          search_context_size: "medium" // 'low', 'medium', or 'high'
        }
      }, {
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Extraer contenido, citaciones y resultados de búsqueda
      const responseContent = perplexityResponse.data.choices[0]?.message?.content || '';
      const citations = perplexityResponse.data.citations || [];
      const searchResults = perplexityResponse.data.search_results || [];
      
      // Asegurar que el resultado sea texto plano y directo
      if (!responseContent || responseContent.trim().length === 0) {
        console.error('❌ [PERPLEXITY] Empty response');
        return "I searched for recent information but did not find specific results for 2025-2026. Please try rephrasing your question or asking about a more specific topic.";
      }
      
      // Si la respuesta contiene mensajes de error o indica que no pudo buscar, intentar limpiarla
      // Pero solo si realmente no tiene contenido útil
      const hasErrorPhrases = /(?:could not|couldn't|attempted to fetch|failed to|unable to|wasn't able to retrieve)/i.test(responseContent);
      const hasUsefulContent = responseContent.length > 200 && !/(?:no results|no information found|error occurred)/i.test(responseContent);
      
      let cleanedContent = responseContent;
      
      if (hasErrorPhrases && !hasUsefulContent) {
        console.warn('⚠️ [PERPLEXITY] Error indicators, no useful content');
        return `I searched for recent information (2025-2026) but did not find specific updates on this topic. The information available extends to mid-2024. If you need the absolute latest information, please try rephrasing your question or asking about a more specific aspect.`;
      } else if (hasErrorPhrases && hasUsefulContent) {
        console.warn('⚠️ [PERPLEXITY] Error indicators but has useful content, cleaning...');
        cleanedContent = responseContent
          .replace(/(?:I\s+)?(?:wasn't|was not|couldn't|could not)\s+(?:able to\s+)?(?:retrieve|fetch|get|complete|access).*?(?:\.|$)/gi, '')
          .replace(/(?:I\s+)?attempted\s+(?:to\s+)?(?:fetch|retrieve|get|search).*?(?:\.|$)/gi, '')
          .replace(/(?:I\s+)?encountered\s+an\s+error.*?(?:\.|$)/gi, '')
          .trim();
        
        if (cleanedContent.length <= 100) {
          cleanedContent = responseContent; // Si la limpieza fue demasiado agresiva, usar el original
        }
      }
      
      // Si hay citaciones, formatearlas y añadirlas al final
      if (citations && citations.length > 0) {
        // NO remover las referencias numéricas del texto - mantenerlas para que el usuario pueda relacionar
        // Las citaciones al final servirán como referencia completa
        
        // Añadir sección de referencias al final con formato HTML (para que prettify pueda añadir target="_blank")
        let referencesSection = '\n\n---\n\n### Referencias\n\n';
        
        citations.forEach((citation, index) => {
          const citationNum = index + 1;
          if (typeof citation === 'string') {
            // Si es un string (URL), formatearlo como enlace HTML con target="_blank"
            referencesSection += `${citationNum}. <a href="${citation}" target="_blank">${citation}</a>\n`;
          } else if (citation.url) {
            // Si es un objeto con URL y título
            const title = citation.title || citation.url;
            const url = citation.url;
            referencesSection += `${citationNum}. <a href="${url}" target="_blank">${title}</a>\n`;
          } else if (citation.text) {
            // Si tiene texto pero no URL
            referencesSection += `${citationNum}. ${citation.text}\n`;
          } else {
            // Fallback: mostrar el objeto como string
            referencesSection += `${citationNum}. ${JSON.stringify(citation)}\n`;
          }
        });
        
        cleanedContent += referencesSection;
      } else if (searchResults && searchResults.length > 0) {
        // Si no hay citaciones pero hay resultados de búsqueda, usarlos como referencias
        let referencesSection = '\n\n---\n\n### Fuentes consultadas\n\n';
        
        searchResults.forEach((result, index) => {
          const resultNum = index + 1;
          if (typeof result === 'string') {
            referencesSection += `${resultNum}. ${result}\n`;
          } else if (result.url) {
            const title = result.title || result.name || result.url;
            referencesSection += `${resultNum}. <a href="${result.url}" target="_blank">${title}</a>\n`;
          } else {
            referencesSection += `${resultNum}. ${JSON.stringify(result)}\n`;
          }
        });
        
        cleanedContent += referencesSection;
      }
      
      return cleanedContent;
    } catch (error) {
      // Logging de error más visible y claro
      console.error('\n❌❌❌ [PERPLEXITY ERROR] ❌❌❌');
      console.error(`Status: ${error.response?.status || 'N/A'}`);
      console.error(`Message: ${error.message}`);
      console.error(`Response: ${JSON.stringify(error.response?.data || {}, null, 2)}`);
      console.error('❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌\n');
      
      insights.error({ message: 'Error calling Perplexity API', error: error });
      return `I encountered an error while searching for recent information. Please try again or rephrase your question.`;
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
  try {
    let { claude35sonnet } = createModels('default', 'claude35sonnet');
    const suggestionsTemplate = await pull('foundation29/conv_suggestions_base_v1');
    const runnable = suggestionsTemplate.pipe(claude35sonnet);
    const suggestions = await runnable.invoke({
      chat_history: messages
    });
    let suggestionsArray = JSON.parse(suggestions.suggestions);
    return suggestionsArray.suggestions;
  } catch (error) {
    console.error('[suggestionsFromConversation] Error generating suggestions:', error.message);
    insights.error({ message: '[suggestionsFromConversation] Error generating suggestions', error: error.message, stack: error.stack });
    return []; // Devolver array vacío para que el flujo continúe
  }
}

async function processDocs(docs, containerName) {
  let docsSummaries = [];
  
  if (!docs || !Array.isArray(docs) || docs.length === 0) {
    return '';
  }
  
  for (let doc of docs) {
    try {
      // Manejar tanto strings (URLs) como objetos Document
      let docUrl;
      if (typeof doc === 'string') {
        docUrl = doc;
      } else if (doc && typeof doc === 'object' && doc.url) {
        docUrl = doc.url;
      } else {
        console.warn(`[processDocs] Skipping invalid doc format:`, typeof doc);
        continue;
      }
      
      let url = docUrl.replace(/\/[^\/]*$/, '/summary_translated.txt');
      let docSummary = await azure_blobs.downloadBlob(containerName, url);
      if (docSummary) {
        docsSummaries.push(docSummary);
      }
    } catch (error) {
      // Silently skip documents without summaries - this is common
      if (!error.message?.includes('BlobNotFound')) {
        console.warn(`[processDocs] Error downloading summary:`, error.message);
      }
    }
  }
  let docsSummariesString = docsSummaries.map((summary, i) => `<Document Summary ${i+1}>\n${summary}\n</Document Summary ${i+1}>`).join('\n\n');
  return docsSummariesString;
}

async function curateContext(context, memories, containerName, docs, question, selectedChunks = [], structuredFacts = [], appointments = [], notes = [], chatMode = 'fast') {
  try {
  // Seleccionar modelo según chatMode: 
  // Usamos gpt-4.1-nano para ambos modos en curateContext
  // La calidad final la aporta el modelo principal (gpt-5-mini en advanced)
  // Esto ahorra ~5s en modo advanced sin pérdida de calidad significativa
  let model = createModels('default', 'gpt-4.1-nano')['gpt-4.1-nano'];
  
  let contextTemplate;
  try {
    // New version name to avoid affecting production
    contextTemplate = await pull('foundation29/context_curation_v2');
  } catch (e) {
    console.warn("[curateContext] Prompt foundation29/context_curation_v2 not found, using local fallback");
    insights.error({ message: '[curateContext] Prompt not found in LangChain Hub, using fallback', error: e.message });
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

  const runnable = contextTemplate.pipe(model);
  
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
  } catch (error) {
    console.error('[curateContext] Error curating context:', error.message);
    insights.error({ message: '[curateContext] Error curating context', error: error.message, stack: error.stack, question: question?.substring(0, 100) });
    // Devolver un contexto mínimo para que el agente pueda seguir funcionando
    return { content: 'Error processing patient context. Please try again.' };
  }
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
