const {createModels} = require('../services/langchain');
const { suggestionsFromConversation } = require('../services/tools');
const { pull } = require('langchain/hub');
const config = require('../config');
const { OpenAIEmbeddings } = require("@langchain/openai");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const { MessagesAnnotation, StateGraph, Annotation } = require("@langchain/langgraph");
const { ToolNode } = require("@langchain/langgraph/prebuilt");
const { perplexityTool, mediSearchTool, clinicalTrialsTool, createIndexIfNone, curateContext } = require('../services/tools');
const { Document } = require("@langchain/core/documents");
const { setContextVariable } = require("@langchain/core/context");

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

const embeddings = new OpenAIEmbeddings({
    azureOpenAIApiKey: config.O_A_K,
    azureOpenAIApiVersion: config.OPENAI_API_VERSION,
    azureOpenAIApiInstanceName: config.OPENAI_API_BASE,
    azureOpenAIApiDeploymentName: "nav29embeddings-large",
    model: "text-embedding-3-large",
    modelName: "text-embedding-3-large",
});
const cogsearchIndex = config.cogsearchIndex;

// Define the function that calls the model
async function callModel(
  state,
  config,
) {
  /** Call the LLM powering our agent. **/
  const SYSTEM_PROMPT_TEMPLATE = await pull("foundation29/agent_system_prompt_v1");

  // Intentar usar gpt5mini; si no está disponible, caer a gpt-4o
  //let { azuregpt4o } = createModels('default', 'azuregpt4o');
  let { gpt5mini } = createModels('default', 'gpt5mini');
  let baseModel = gpt5mini;


  console.log('cogsearchIndex:', cogsearchIndex);
  let vectorStore = await createIndexIfNone(cogsearchIndex, embeddings, vectorStoreAddress, vectorStorePassword);
  config.configurable.vectorStore = vectorStore;
  // For Azure AI Search, we need to use OData filter syntax
  const filter = {
    filterExpression: `metadata/source eq '${config.configurable.indexName}'`,
    vectorFilterMode: "preFilter"  // Apply filter before vector search for better performance
  };

  const retriever = vectorStore.asRetriever({
    k: 3,
    filter: filter,
    searchType: "similarity"
  });

  const question = state.messages[state.messages.length - 1].content;
  const memories = await retriever.invoke(question);
  const curatedContext = await curateContext(config.configurable.context, memories, config.configurable.containerName, config.configurable.docs, question);
  const model = baseModel.bindTools(TOOLS);
  const prompt = await SYSTEM_PROMPT_TEMPLATE.format({ systemTime: config.configurable.systemTime, curatedContext: curatedContext.content });

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
    return {messages: [response], vectorStore: vectorStore};
  } else {
    const response = await model.invoke([
    {
      role: "system",
      content: prompt,
    },
    ...state.messages,
  ]);

  // We return a list, because this will get added to the existing list
  return { messages: [response], vectorStore: vectorStore };
  }
}

async function saveContext(state, config) {
  input = state.messages[state.messages.length - 2];
  output = state.messages[state.messages.length - 1];

  let message = { "time": new Date().toISOString(), "answer": output.content, "status": "respuesta generada", "step": "navigator", "patientId": config.configurable.patientId }
  config.configurable.pubsubClient.sendToUser(config.configurable.userId, message)

  try {
    message = { "time": new Date().toISOString(), "status": "generando sugerencias", "step": "navigator", "patientId": config.configurable.patientId }
    config.configurable.pubsubClient.sendToUser(config.configurable.userId, message)
    // Convert inputs to only include 'input' but maintain the key
    const formattedSavedMemory = "<start> This is an interaction between the user and Nav29 from " + config.configurable.systemTime + ". <user_input> " + input.content + " </user_input> <nav29_output> " + output.content + " </nav29_output> <end>";

    // Create a new Document with the formatted memory
    const documents = [
      new Document({
        pageContent: formattedSavedMemory,
      })
    ];
    // console.log(documents);
    for (const doc of documents) {  
      doc.metadata = {source: config.configurable.indexName};
    }
    // Add documents to retriever
    await state.vectorStore.addDocuments(documents);

    // Generate suggestionsFromConversation
    const suggestions = await suggestionsFromConversation(state.messages);

    // Send webpubsub message to client (in config)
    message = { "time": new Date().toISOString(), "suggestions": suggestions, "status": "sugerencias generadas", "step": "navigator", "patientId": config.configurable.patientId }
    config.configurable.pubsubClient.sendToUser(config.configurable.userId, message)

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
  // Otherwise end the graph and save the context.
  else {
    config.configurable.pubsubClient.sendToUser(config.configurable.userId, { "time": new Date().toISOString(), "status": "generando respuesta", "step": "navigator", "patientId": config.configurable.patientId });
    // Here we will use the function saveContext() that will save the last pair of messages to the Azure Search
    return "prettify";
  }
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
  config.configurable.pubsubClient.sendToUser(config.configurable.userId, { "time": new Date().toISOString(), "status": "action", "action": ActionDict, "step": "navigator", "patientId": config.configurable.patientId });
  const toolNodeWithConfig = new ToolNode(TOOLS);
  return toolNodeWithConfig.invoke(state);
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
  // This means that after `tools` is called, `callModel` node is called next.
  .addEdge("tools", "callModel")
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