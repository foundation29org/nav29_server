const fetch = require('node-fetch');

class MediSearchClient {
  constructor(apiKey, baseUrl = "https://api.backend.medisearch.io") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.sseEndpoint = `${this.baseUrl}/sse/medichat`;
  }

  async sendUserMessage(conversation, conversationId, language = "English") {
    const payload = {
      event: "user_message",
      conversation,
      key: this.apiKey,
      id: conversationId,
      settings: { language }
    };

    const response = await fetch(this.sseEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Connection": "keep-alive"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MediSearch error: ${response.status} ${response.statusText} - ${text}`);
    }

    return new Promise((resolve, reject) => {
      let buffer = "";
      let finalLlmResponse = null;
      let finalArticles = null;
      let finalError = null;

      const { TextDecoder } = require('util');
      const decoder = new TextDecoder("utf-8");

      response.body.on("data", (chunk) => {
        buffer += decoder.decode(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const content = trimmed.slice(6);
            try {
              const message = JSON.parse(content);
              if (message.event === "llm_response") {
                finalLlmResponse = message;
              } else if (message.event === "articles") {
                finalArticles = message;
              } else if (message.event === "error") {
                finalError = message;
              }
            } catch (_err) {
              // ignorar líneas no JSON
            }
          }
        }
      });

      response.body.on("end", () => {
        if (finalError) return resolve(finalError);
        if (finalArticles && finalLlmResponse) {
          return resolve({ llm_response: finalLlmResponse, articles: finalArticles });
        }
        if (finalLlmResponse) return resolve(finalLlmResponse);
        if (finalArticles) return resolve(finalArticles);
        resolve(null);
      });

      response.body.on("error", (err) => reject(err));
    });
  }
}

module.exports = { MediSearchClient }; 