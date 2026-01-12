const config = require('../config')

const crypt = require('../services/crypt')
const langchain = require('../services/langchain')
const axios = require('axios');

const azureApiKey = config.O_A_K


async function detectLang(text) {
  return new Promise(async (resolve, reject) => {
      try {
        let substring = text.substring(0, 1000); // Reducir a 1000 caracteres para evitar filtros


        const messages = [
          {
            role: "system",
            content: `Identify the language of the provided text. Respond only with the language code: es, en, fr, de, it, pt, ru, zh, ja, ko. If uncertain, respond "null".`
          },
          {
            role: "user",
            content: `Identify the language of the following text:\n\n${substring}`
          }
        ];
        const apiKey = azureApiKey; // Reemplaza esto con tu clave API real
        const endpoint = 'https://nav29.openai.azure.com/openai/deployments/nav29/chat/completions?api-version=2023-06-01-preview';

        const data = {
          messages: messages,
          temperature: 0,
          frequency_penalty: 0,
          presence_penalty: 0,
          top_p: 1
        };

        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        };
          
        try {
          const response = await axios.post(endpoint, data, { headers: headers });
          let lang = null;
          if (response.data.choices[0].message.content) {
            lang = response.data.choices[0].message.content.trim();
            // console.log(response.data.choices[0])
            resolve(lang);
          } else {
            reject(new Error('Invalid response format from OpenAI'));
          }
        } catch (error) {
          console.error('OpenAI API Error:', error.response?.data || error.message);
          console.error('Status:', error.response?.status);
          console.error('Headers:', error.response?.headers);
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
  // Solo usar extractEvents - el prompt extract_events_v1 ya maneja:
  // - appointments (citas futuras/pasadas)
  // - activity (eventos de vida)
  // - reminder (recordatorios generales) - añadir al prompt en LangSmith
  await langchain.extractEvents(question, answer, userId, patientId, keyEvents);

  res.status(200).send(true)
}

module.exports = {
  detectLang,
  extractEventsNavigator
}
