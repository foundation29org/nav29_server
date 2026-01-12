'use strict';

/**
 * Helper para crear modelos de IA para los servicios de eventos
 * Separado de langchain.js para evitar dependencias circulares
 */

const { ChatOpenAI } = require("@langchain/openai");
const config = require('../config');

/**
 * Crea una instancia de gpt4omini para filtrado/agregación de eventos
 * @returns {ChatOpenAI} - Modelo configurado
 */
function createGpt4oMini() {
  return new ChatOpenAI({
    azureOpenAIApiKey: config.O_A_K_GPT4O,
    azureOpenAIApiInstanceName: config.OPENAI_API_BASE_GPT4O.match(/https:\/\/(.+?)\.openai/)?.[1] || '',
    azureOpenAIApiDeploymentName: "gpt-4o-mini",
    azureOpenAIApiVersion: config.OPENAI_API_VERSION,
    temperature: 0.2, // Bajo para consistencia
    maxTokens: 2000,
  });
}

module.exports = {
  createGpt4oMini
};
