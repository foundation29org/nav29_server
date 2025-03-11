const config = require('../config')

const crypt = require('../services/crypt')
const langchain = require('../services/langchain')
const axios = require('axios');

const azureApiKey = config.O_A_K


async function detectLang(text) {
  return new Promise(async (resolve, reject) => {
      try {
        let substring = text.substring(0, 5000);

        let content = [
          { role: "system", content: "You are an AI model trained to recognize languages from text snippets. Respond only with the language code of the text. If you cannot identify the language confidently, respond with 'null'." },
          { role: "user", content: "What is the language of this text: 'Hello, how are you?'" },
          { role: "assistant", content: "en" },
          { role: "user", content: "What is the language of this text: 'Bonjour, comment ça va?'" },
          { role: "assistant", content: "fr" },
          { role: "user", content: "What is the language of this text: 'Hola, ¿cómo estás?'" },
          { role: "assistant", content: "es" },
          { role: "user", content: `What is the language of this text: "${substring}"` },
          { role: "assistant", content: "" } // La respuesta del modelo irá aquí
        ];
        const apiKey = azureApiKey; // Reemplaza esto con tu clave API real
        const endpoint = 'https://nav29.openai.azure.com/openai/deployments/nav29/chat/completions?api-version=2023-07-01-preview';

        const data = {
          messages: content,
          max_tokens: 800,
          temperature: 0,
          frequency_penalty: 0,
          presence_penalty: 0,
          top_p: 0.95,
          stop: null
        };

        const headers = {
          'Content-Type': 'application/json',
          'api-key': apiKey
        };
          
        try {
          const response = await axios.post(endpoint, data, { headers: headers });
          let lang = null;
          if (response.data.choices[0].message.content) {
            lang = response.data.choices[0].message.content.trim();
            console.log(response.data.choices[0])
            resolve(lang);
          } else {
            reject(new Error('Invalid response format from OpenAI'));
          }
        } catch (error) {
          reject('Error from OpenAI');
        }

      } catch (e) {
        console.error("[ERROR]: " + e);
        reject(e);
      }
  });
}



async function extractEventsNavigator (req, res){
  const question = req.body.question
  const answer = req.body.answer
  const userId = req.body.userId
  const patientId =  crypt.decrypt(req.body.patientId);
  const keyEvents = req.body.initialEvents

  // let key_events = []
  // if (!initialEvents || initialEvents.length < 3 || initialEvents.some(event => event.insight === null)){
  //   key_events = await langchain.extractInitialEvents(question, answer, userId, patientId)
  // }
  await Promise.all([
    langchain.extractTimelineEvents(question, userId, patientId),
    langchain.extractEvents(question, answer, userId, patientId, keyEvents),
  ]);

  res.status(200).send(true)
}

module.exports = {
  detectLang,
  extractEventsNavigator
}
