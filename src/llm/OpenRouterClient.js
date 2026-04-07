import fetch from "node-fetch";

class OpenRouterClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.model;
    this.site = config.site;
    this.appName = config.appName;
  }

  async chatCompletionsCreate({ model, messages, temperature, max_tokens }) {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`
    };
    if (this.site) headers["HTTP-Referer"] = this.site;
    if (this.appName) headers["X-Title"] = this.appName;

    const body = {
      model: model || this.defaultModel,
      messages,
      temperature,
      max_tokens
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      const error = new Error(`OpenRouter error: ${res.status} ${text}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    return data; // already in OpenAI-compatible shape
  }
}

export default OpenRouterClient;
