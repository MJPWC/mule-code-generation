import { CohereClient as CohereApi } from "cohere-ai";

class MyCohereClient {
  constructor(config) {
    if (!config.apiKey) {
      throw new Error("Cohere API key is required.");
    }
    this.client = new CohereApi({
      token: config.apiKey,
    });
    this.defaultModel = config.model;
  }

  async chatCompletionsCreate({ model, messages, temperature, max_tokens }) {
    // Cohere API expects messages in a different format than OpenAI's
    // We need to convert the messages array.
    const cohereMessages = messages.map(msg => ({
      role: msg.role === 'user' ? 'User' : 'Chatbot', // Cohere uses 'User' and 'Chatbot'
      message: msg.content
    }));

    // The last message is typically the user's prompt.
    const lastMessage = cohereMessages.pop();

    const response = await this.client.chat({
      model: model || this.defaultModel,
      message: lastMessage.message,
      chatHistory: cohereMessages,
      temperature,
      maxTokens: max_tokens,
    });

    // Convert Cohere's response format to a format similar to OpenAI's
    return {
      choices: [{
        message: {
          content: response.text,
          role: 'assistant'
        }
      }],
      model: response.meta?.api_version?.version // Assuming model info is here
    };
  }
}

export default MyCohereClient;
