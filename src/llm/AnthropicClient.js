import fetch from "node-fetch";

class AnthropicClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.model || "claude-sonnet-4-5-20250929";
    this.apiVersion = config.apiVersion || "2023-06-01";
  }

  // Normalized to OpenAI chat.completions.create-like signature
  async chatCompletionsCreate({ model, messages, temperature, max_tokens }) {
    const url = `${this.baseUrl}/v1/messages`;

    // Transform OpenAI-style messages to Anthropic Messages format
    const anthropicMessages = (messages || []).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: m.content }]
    }));

    // Anthropic API requires max_tokens. Use passed value, or fallback to reasonable default.
    // Note: Callers should always provide max_tokens via Config or options.
    const effectiveMaxTokens = max_tokens || 4096; // 4096 is a safe default for Anthropic models
    if (!max_tokens) {
      console.warn('⚠️  AnthropicClient: max_tokens not provided, using default 4096. Consider setting MAX_TOKENS in config.');
    }

    const body = {
      model: model || this.defaultModel,
      max_tokens: effectiveMaxTokens,
      temperature: temperature,
      messages: anthropicMessages
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Anthropic error: ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    // data.content is an array of blocks; concatenate text blocks
    const content = (data?.content || [])
      .map(block => (block?.text ? block.text : ""))
      .join("");

    return {
      choices: [
        {
          message: { content }
        }
      ]
    };
  }
}

export default AnthropicClient;
