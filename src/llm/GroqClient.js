import fetch from "node-fetch";

class GroqClient {
  constructor(config) {
    this.baseUrl = (config.baseUrl || "https://api.groq.com").replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.model || "llama-3.3-70b-versatile";
  }

  async chatCompletionsCreate({ model, messages, temperature, max_tokens }, retryCount = 0) {
    const url = `${this.baseUrl}/openai/v1/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`
    };

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
      let errorData;
      try {
        errorData = JSON.parse(text);
      } catch {
        errorData = { message: text };
      }
      
      // Handle rate limit (429) with retry logic
      if (res.status === 429 && retryCount < 2) {
        // Extract retry-after from error message if available
        let retryAfter = 5; // Default 5 seconds
        const retryAfterMatch = text.match(/try again in ([\d.]+)s/i);
        if (retryAfterMatch) {
          retryAfter = Math.ceil(parseFloat(retryAfterMatch[1])) + 1; // Add 1 second buffer
        }
        
        console.warn(`⚠️ Groq rate limit (429). Retrying in ${retryAfter}s (attempt ${retryCount + 1}/2)...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return this.chatCompletionsCreate({ model, messages, temperature, max_tokens }, retryCount + 1);
      }
      
      const err = new Error(`Groq error: ${res.status} ${text}`);
      err.status = res.status;
      err.response = { status: res.status, data: errorData };
      throw err;
    }

    return await res.json(); // OpenAI-compatible shape
  }
}

export default GroqClient;
