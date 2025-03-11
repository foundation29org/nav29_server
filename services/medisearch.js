const WebSocket = require('ws');

class MediSearchClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.url = "wss://public.backend.medisearch.io:443/ws/medichat/api";
  }

  async sendUserMessage(conversation, conversationId, language = "English") {
    return new Promise((resolve, reject) => {
      try {
        const socket = new WebSocket(this.url);

        socket.on('open', () => {
          const payload = {
            event: "user_message",
            conversation: conversation,
            key: this.apiKey,
            id: conversationId,
            settings: {
              language: language
            }
          };
          
          socket.send(JSON.stringify(payload));
        });

        let finalResponse = null;

        socket.on('message', (data) => {
          const response = JSON.parse(data);
          if (response.event === "llm_response") {
            finalResponse = response;
          }
          
          if (response.event === "articles" || response.event === "error") {
            socket.close();
            resolve(finalResponse || response);
          }
        });

        socket.on('error', (error) => {
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }
}

module.exports = { MediSearchClient }; 