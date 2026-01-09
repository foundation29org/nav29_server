const {createModels, embeddings} = require('../services/langchain');
const { SearchIndexClient, SearchClient } = require("@azure/search-documents");
const { AzureKeyCredential } = require("@azure/core-auth");
const { suggestionsFromConversation } = require('../services/tools');
const { pull } = require('langchain/hub');
const config = require('../config');
const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = require("@langchain/core/messages");
const { MessagesAnnotation, StateGraph, Annotation } = require("@langchain/langgraph");
const { ToolNode } = require("@langchain/langgraph/prebuilt");
const { perplexityTool, mediSearchTool, clinicalTrialsTool, curateContext } = require('../services/tools');
const { createIndexIfNone } = require('./vectorStoreService');
const { detectIntent, retrieveChunks, deterministicRerank, extractStructuredFacts } = require('./retrievalService');
const { Document } = require("@langchain/core/documents");
const { ChatPromptTemplate } = require("@langchain/core/prompts");
const { setContextVariable } = require("@langchain/core/context");
const Events = require('../models/events');
const Messages = require('../models/messages');
const crypt = require('./crypt');
const { translateToUserLang } = require('./translation');

const AttributesState = Annotation.Root({
  vectorStore: Annotation,
})

const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  ...AttributesState.spec,
})

//const TOOLS = [perplexityTool, mediSearchTool, clinicalTrialsTool];
const TOOLS = [perplexityTool, clinicalTrialsTool];

const vectorStoreAddress = config.SEARCH_API_ENDPOINT;
const vectorStorePassword = config.SEARCH_API_KEY;

const cogsearchIndex = config.cogsearchIndex;

// Define the function that calls the model
async function callModel(
  state,
  config,
) {
  /** Call the LLM powering our agent. **/
  let systemPromptTemplate;
  try {
    // New version name to avoid affecting production
    systemPromptTemplate = await pull("foundation29/agent_system_prompt_v2");
  } catch (e) {
    console.warn("Prompt foundation29/agent_system_prompt_v2 not found, using local fallback");
    systemPromptTemplate = ChatPromptTemplate.fromMessages([
      ["system", `Nav29 is an advanced medical assistant designed to help patients understand their health data with high precision and empathy. You are powered by Foundation29.org.

### MISSION:
Your primary mission is to answer patient questions using the provided "Curated Patient Context". This context is a synthesis of literal document evidence, structured facts, and conversation history.

### GROUNDING & CITATIONS (NotebookLM Style):
- ALWAYS prioritize data from the "Curated Patient Context".
- When mentioning a specific clinical value (e.g., lab result, diagnosis, medication dose, date), you MUST cite the source using this EXACT format:
  * [filename, YYYY-MM-DD] if the date is confirmed
  * [filename, undated] if the date is missing or uncertain
- Example: "Your cholesterol is 260 mg/dL [Analítica 14-04-25.pdf, 2025-04-14]"
- If the curated context already includes citations in square brackets, preserve them EXACTLY as provided.
- If the curated context mentions that a date is "missing" or "estimated", communicate this uncertainty to the patient (e.g., "According to an undated report...").
- Do NOT invent data points, dates, or citations not present in the curated context.

### RESPONSE STRUCTURE:
1. Direct Answer: Start with a clear, concise answer to the patient's question.
2. Clinical Context: Provide relevant medical explanation if needed.
3. Actionable Recommendations: Suggest next steps if appropriate (e.g., consult with doctor, lifestyle changes).
4. Citations: Ensure all clinical data is properly cited as described above.

### GUIDELINES:
- Be empathetic but maintain clinical accuracy.
- If you cannot find the answer in the provided context, state it clearly: "I don't have that information in your medical records."
- Use the patient's demographic data (age, gender, weight, height) from the context when relevant to provide personalized advice.

### CONTEXT:
TODAY'S DATE: {systemTime}

<curated_patient_context>
{curatedContext}
</curated_patient_context>`]
    ]);
  }

  let { gpt5mini } = createModels('default', 'gpt5mini');
  let baseModel = gpt5mini;

  const question = state.messages[state.messages.length - 1].content;
  const originalQuestion = config.configurable.originalQuestion || question;
  const patientId = config.configurable.patientId;

  // 1. Detección de intención (usamos la original para mejor detección de erratas médicas)
  const plan = await detectIntent(originalQuestion, patientId);
  console.log(`Intento detectado: ${plan.id} para la pregunta: "${originalQuestion}"`);

  // 2. Recuperación de memorias de conversación (k=3, filtro por source)
  let conversationVectorStore = await createIndexIfNone(cogsearchIndex, embeddings, vectorStoreAddress, vectorStorePassword);
  
  const conversationFilter = {
    filterExpression: `source eq '${config.configurable.indexName}'`,
    vectorFilterMode: "preFilter"
  };
  const conversationRetriever = conversationVectorStore.asRetriever({
    k: 3,
    filter: conversationFilter,
    searchType: "similarity"
  });
  const memories = await conversationRetriever.invoke(question);

  // 3. Recuperación de Document Chunks (Candidatos)
  // Si la pregunta traducida es muy diferente, pasamos ambas al retriever para búsqueda híbrida
  const searchQuery = question !== originalQuestion ? `${question} ${originalQuestion}` : question;
  const candidateChunks = await retrieveChunks(searchQuery, patientId, plan);
  console.log(`Recuperados ${candidateChunks.length} candidatos para chunks usando: "${searchQuery}"`);

  // 4. Re-ranking determinista y Selección de evidencia
  const selectedChunks = deterministicRerank(candidateChunks, plan);
  console.log(`Seleccionados ${selectedChunks.length} chunks de evidencia final`);

  // DEBUG: Verificar metadata de chunks seleccionados
  if (selectedChunks.length > 0) {
    console.log('\n📋 METADATA DE CHUNKS SELECCIONADOS:');
    selectedChunks.slice(0, 3).forEach((chunk, i) => {
      console.log(`Chunk ${i + 1}:`);
      console.log(`  - filename: ${chunk.metadata?.filename || 'MISSING'}`);
      console.log(`  - reportDate: ${chunk.metadata?.reportDate || 'MISSING'}`);
      console.log(`  - documentId: ${chunk.metadata?.documentId || 'MISSING'}`);
    });
    console.log('');
  }

  // 5. Extracción estructurada (Fase 7)
  const structuredFacts = await extractStructuredFacts(selectedChunks, searchQuery, patientId);

  // 6. Curación de contexto (Pasamos memorias, chunks seleccionados y hechos estructurados)
  const curatedContext = await curateContext(
    config.configurable.context, 
    memories, 
    config.configurable.containerName, 
    config.configurable.docs, 
    question,
    selectedChunks,
    structuredFacts
  );

  // Guardar el contexto curado en el config para que esté disponible en las herramientas
  config.configurable.curatedContext = curatedContext.content;

  const model = baseModel.bindTools(TOOLS);
  const prompt = await systemPromptTemplate.format({ 
    systemTime: config.configurable.systemTime, 
    curatedContext: curatedContext.content 
  });
  
  if (config.configurable.context.length > 1) {
    let context = config.configurable.context.slice(1);
    let inputMessages = [];
    for (let i = 0; i < context.length; i++) {
      if (i % 2 == 0) {
        inputMessages.push(new HumanMessage(context[i]));
      } else {
        inputMessages.push(new AIMessage(context[i]));
      }
    }
    const response = await model.invoke([
      {
        role: "system",
        content: prompt,
      },
      ...inputMessages,
      ...state.messages,
    ]);
    return {messages: [response], vectorStore: conversationVectorStore};
  } else {
    const response = await model.invoke([
    {
      role: "system",
      content: prompt,
    },
    ...state.messages,
  ]);

  // We return a list, because this will get added to the existing list
  return { messages: [response], vectorStore: conversationVectorStore };
  }
}

async function saveContext(state, langGraphConfig) {
  input = state.messages[state.messages.length - 2];
  output = state.messages[state.messages.length - 1];

  const patientIdCrypt = crypt.encrypt(langGraphConfig.configurable.patientId);
  const userLang = langGraphConfig.configurable.userLang || 'en';
  
  // Traducir la respuesta al idioma del usuario antes de emitir y guardar
  let translatedAnswer = output.content;
  if (userLang && userLang !== 'en') {
    try {
      translatedAnswer = await translateToUserLang(output.content, userLang);
      console.log(`Translated answer from en to ${userLang}`);
    } catch (translateError) {
      console.error('Error translating answer:', translateError);
      // Si falla la traducción, usar la respuesta original
    }
  }
  
  let message = { "time": new Date().toISOString(), "answer": translatedAnswer, "status": "respuesta generada", "step": "navigator", "patientId": patientIdCrypt }
  langGraphConfig.configurable.pubsubClient.sendToUser(langGraphConfig.configurable.userId, message)

  try {

    message = { "time": new Date().toISOString(), "status": "generando sugerencias", "step": "navigator", "patientId": patientIdCrypt }
    langGraphConfig.configurable.pubsubClient.sendToUser(langGraphConfig.configurable.userId, message)
    // Convert inputs to only include 'input' but maintain the key
    const formattedSavedMemory = "<start> This is an interaction between the user and Nav29 from " + langGraphConfig.configurable.systemTime + ". <user_input> " + input.content + " </user_input> <nav29_output> " + output.content + " </nav29_output> <end>";

    // Generar embedding para la memoria
    const memoryEmbedding = await embeddings.embedQuery(formattedSavedMemory);

    const searchClient = new SearchClient(
      config.SEARCH_API_ENDPOINT, 
      config.cogsearchIndex, 
      new AzureKeyCredential(config.SEARCH_API_KEY)
    );

    const memoryId = `mem_${Date.now()}`;
    const metadata = {
      source: langGraphConfig.configurable.indexName,
      timestamp: langGraphConfig.configurable.systemTime
    };

    const documentToUpload = {
      id: memoryId,
      content: formattedSavedMemory,
      source: metadata.source,
      content_vector: memoryEmbedding, // Usamos nombre estándar
      metadata: JSON.stringify(metadata)
    };

    // Subir directamente con cliente de Azure para asegurar campos de primer nivel
    await searchClient.uploadDocuments([documentToUpload]);

    // Generate suggestionsFromConversation
    const suggestionsRaw = await suggestionsFromConversation(state.messages);
    
    // Traducir las sugerencias al idioma del usuario
    let suggestions = suggestionsRaw;
    if (userLang && userLang !== 'en' && Array.isArray(suggestionsRaw)) {
      try {
        suggestions = await Promise.all(
          suggestionsRaw.map(s => translateToUserLang(s, userLang))
        );
        console.log(`Translated ${suggestions.length} suggestions to ${userLang}`);
      } catch (translateError) {
        console.error('Error translating suggestions:', translateError);
        suggestions = suggestionsRaw;
      }
    }

    // Send webpubsub message to client (in config)
    message = { "time": new Date().toISOString(), "suggestions": suggestions, "status": "sugerencias generadas", "step": "navigator", "patientId": patientIdCrypt }
    langGraphConfig.configurable.pubsubClient.sendToUser(langGraphConfig.configurable.userId, message)

    // Guardar los mensajes y sugerencias en la BD para que estén disponibles cuando el usuario vuelva
    try {
      const patientId = langGraphConfig.configurable.patientId;
      // Desencriptar userId para mantener consistencia con el formato anterior de la BD
      const userId = crypt.decrypt(langGraphConfig.configurable.userId);
      const now = Date.now(); // Unix timestamp en milisegundos
      
      // Crear los objetos de mensaje con el formato original del frontend
      const userMessage = {
        isNew: false,
        timestamp: now,
        isUser: true,
        text: langGraphConfig.configurable.originalQuestion || input.content
      };
      const assistantMessage = {
        isNew: false,
        timestamp: now,
        isUser: false,
        text: translatedAnswer,
        loading: false
      };
      
      await Messages.findOneAndUpdate(
        { createdBy: patientId, userId: userId },
        { 
          $push: { messages: { $each: [userMessage, assistantMessage] } },
          $set: { lastSuggestions: suggestions, date: new Date() }
        },
        { upsert: true } // Crear el documento si no existe
      );
    } catch (dbError) {
      console.error("Error saving messages to DB:", dbError);
      // No bloqueamos el flujo si falla el guardado
    }

    // console.log("Successfully saved context");
    return {vectorStore: state.vectorStore};
  } catch (error) {
    console.error("Error saving context:", error);
    return {vectorStore: state.vectorStore};
  }
}

async function prettify(state, config) {
  /*
  This function is used to clean up the output of the LLM.
  It removes the ```html ``` tags and the ``` ``` tags.
  */
  const { azuregpt4o } = createModels('default', 'azuregpt4o');
  output = state.messages[state.messages.length - 1];
  
  // Check if this is a TrialGPT response - if so, use it directly without reformatting
  /*if (/https:\/\/trialgpt\.app/.test(output.content) && /<a\s+href=/.test(output.content)) {
    const cleanOutput = output.content.replace(
      /<a\s+href=(["'])https:\/\/trialgpt\.app\1(?![^>]*target=)/gi,
      '<a href="https://trialgpt.app" target="_blank"'
    );
    state.messages[state.messages.length - 1].content = cleanOutput;
    return state;
  }*/
  
  
  // For other content, proceed with normal formatting
  const htmlFormatter = await pull("foundation29/html_formatter_v1");
  const runnable = htmlFormatter.pipe(azuregpt4o);
  const formattedOutput = await runnable.invoke({ content: output.content });
  // TODO: Also use the medicalLevel variable to improve the readability of the output
  // Clean the ```html ``` tags
  let cleanOutput = formattedOutput.content.replace(/```html/g, '').replace(/```/g, '');
  
  // Convertir enlaces Markdown a HTML con target="_blank" para trialgpt.app
  // Detecta formato [texto](https://trialgpt.app) y lo convierte a HTML
  cleanOutput = cleanOutput.replace(
    /\[([^\]]+)\]\((https:\/\/trialgpt\.app)\)/gi,
    '<a href="$2" target="_blank">$1</a>'
  );
  
  // Asegurar que los enlaces HTML a trialgpt.app tengan target="_blank"
  // Busca enlaces <a href="https://trialgpt.app" o <a href='https://trialgpt.app' que no tengan ya target=
  cleanOutput = cleanOutput.replace(
    /<a\s+href=['"]https:\/\/trialgpt\.app['"](?![^>]*target=)/gi,
    '<a href="https://trialgpt.app" target="_blank"'
  );

  // Asegurar que TODOS los enlaces externos (http/https) tengan target="_blank"
  // Esto incluye las citaciones de Perplexity y cualquier otro enlace externo
  cleanOutput = cleanOutput.replace(
    /<a\s+href=['"](https?:\/\/[^'"]+)['"](?![^>]*target=)/gi,
    '<a href="$1" target="_blank"'
  );

  state.messages[state.messages.length - 1].content = cleanOutput;
  return state;
}

// Define the function that determines whether to continue or not
async function routeModelOutput(state, config) {
  const messages = state.messages;
  const lastMessage = messages[messages.length - 1];

  // If the LLM is invoking tools, route there.
  if (lastMessage.tool_calls?.length || 0 > 0) {
    return "tools";
  }
  
  // Si el último mensaje es un AIMessage y el penúltimo es un ToolMessage,
  // significa que toolNodeWithGraphState ya añadió la respuesta final (clinical_trials_search o perplexity)
  // Ir directamente a prettify sin volver a callModel
  if (lastMessage instanceof AIMessage && !lastMessage.tool_calls?.length) {
    const secondLastMessage = messages.length > 1 ? messages[messages.length - 2] : null;
    if (secondLastMessage && (secondLastMessage instanceof ToolMessage || secondLastMessage.getType?.() === 'tool')) {
      // Es una respuesta de una herramienta que ya tiene su respuesta final, ir directamente a prettify
      const patientIdCrypt = crypt.encrypt(config.configurable.patientId);
      config.configurable.pubsubClient.sendToUser(config.configurable.userId, { 
        "time": new Date().toISOString(), 
        "status": "generando respuesta", 
        "step": "navigator", 
        "patientId": patientIdCrypt 
      });
      return "prettify";
    }
  }
  
  // Si el último mensaje es un ToolMessage, forzar que el LLM genere una respuesta final
  // Esto asegura que después de ejecutar cualquier herramienta (excepto clinical_trials_search),
  // siempre se genere una respuesta
  if (lastMessage instanceof ToolMessage || lastMessage.getType?.() === 'tool') {
    // Volver a callModel para que el LLM procese el resultado de la herramienta
    return "callModel";
  }
  
  // Otherwise end the graph and save the context.
  const patientIdCrypt = crypt.encrypt(config.configurable.patientId);
  config.configurable.pubsubClient.sendToUser(config.configurable.userId, { "time": new Date().toISOString(), "status": "generando respuesta", "step": "navigator", "patientId": patientIdCrypt });
  // Here we will use the function saveContext() that will save the last pair of messages to the Azure Search
  return "prettify";
}

const toolNodeWithGraphState = async (state, config) => {
  // We set a context variable before invoking the tool node and running our tool.
  setContextVariable("currentState", state);
  setContextVariable("config", config);
  // console.log(state);

  const ActionDict =  {
    'action': state.messages[state.messages.length - 1].tool_calls[0].name,
    'action_input': state.messages[state.messages.length - 1].tool_calls[0].args,
    'log': state.messages[state.messages.length - 1].tool_calls[0],
  }
  const patientIdCrypt = crypt.encrypt(config.configurable.patientId);
  config.configurable.pubsubClient.sendToUser(config.configurable.userId, { "time": new Date().toISOString(), "status": "action", "action": ActionDict, "step": "navigator", "patientId": patientIdCrypt });
  
  // Crear ToolNode con config para que las herramientas tengan acceso al contexto curado
  const toolNodeWithConfig = new ToolNode(TOOLS);
  // Pasar el config al invoke para que las herramientas puedan acceder a él
  const result = await toolNodeWithConfig.invoke(state, { configurable: config.configurable });
  
  // Para clinical_trials_search y perplexity: añadir un AIMessage después del ToolMessage con el resultado
  // Esto permite que el flujo continúe sin volver a callModel (el AIMessage se usará directamente)
  // Ambos devuelven contenido formateado que debe mostrarse directamente
  const toolName = state.messages[state.messages.length - 1].tool_calls[0].name;
  if (toolName === 'clinical_trials_search' || toolName === 'call_perplexity') {
    // Obtener el resultado de la herramienta (último mensaje ToolMessage)
    const toolResult = result.messages[result.messages.length - 1];
    if (toolResult && toolResult.content) {
      // Crear una respuesta final usando el resultado de la herramienta directamente
      // Añadimos un AIMessage después del ToolMessage (NO reemplazamos el ToolMessage)
      const finalResponse = new AIMessage({
        content: toolResult.content
        // No incluimos tool_calls, por lo que routeModelOutput irá a "prettify"
      });
      
      // Añadir el AIMessage después del ToolMessage (mantener el ToolMessage para la secuencia correcta)
      result.messages.push(finalResponse);
    }
  }
  // Para mediSearch: el ToolMessage se mantiene y routeModelOutput
  // detectará que es un ToolMessage y forzará que el LLM genere una respuesta final
  
  return result;
};


const workflow = new StateGraph(AgentState)
  // Define the two nodes we will cycle between
  .addNode("callModel", callModel)
  .addNode("tools", toolNodeWithGraphState)
  .addNode("prettify", prettify)
  .addNode("saveContext", saveContext)
  // Set the entrypoint as `callModel`
  // This means that this node is the first one called
  .addEdge("__start__", "callModel")
  .addConditionalEdges(
    // First, we define the edges' source node. We use `callModel`.
    // This means these are the edges taken after the `callModel` node is called.
    "callModel",
    // Next, we pass in the function that will determine the sink node(s), which
    // will be called after the source node is called.
    routeModelOutput,
  )
  // Look in context-docs node (prio 1)
  // Look in long-term-memory node (prio 2)
  // After that, use the required tool if needed or answer directly
  // Después de tools, usar routeModelOutput para decidir si volver a callModel o ir a prettify
  .addConditionalEdges(
    "tools",
    routeModelOutput,
  )
  .addEdge("prettify", "saveContext")
  .addEdge("saveContext", "__end__");


// Finally, we compile it!
const graph = workflow.compile({
  interruptBefore: [], // if you want to update the state before calling the tools
  interruptAfter: [],
});

module.exports = {
  graph,
};