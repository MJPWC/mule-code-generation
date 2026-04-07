import OpenAI from "openai";

class OpenAIClient {
  constructor(config) {
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.defaultModel = config.model;
  }

  async chatCompletionsCreate({ model, messages, temperature, max_tokens }) {
    return this.client.chat.completions.create({
      model: model || this.defaultModel,
      messages,
      temperature,
      max_tokens
    });
  }
}

export default OpenAIClient;
