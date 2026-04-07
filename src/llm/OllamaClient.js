import fetch from "node-fetch";

class OllamaClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    this.defaultModel = config.model || "llama3.1";
  }

  /**
   * Emulates OpenAI chat.completions.create response
   */
  async chatCompletionsCreate({ model, messages, temperature, max_tokens }) {
    const url = `${this.baseUrl}/api/chat`;
    const body = {
      model: model || this.defaultModel,
      messages,
      options: {
        temperature: temperature,
        // Ollama uses num_predict instead of max_tokens
        ...(max_tokens ? { num_predict: max_tokens } : {})
      },
      stream: false
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      const error = new Error(`Ollama error: ${res.status} ${text}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    // data.message.content contains the final content when stream=false
    const content = data?.message?.content || "";
    return {
      choices: [
        {
          message: { content }
        }
      ]
    };
  }
}

export default OllamaClient;
