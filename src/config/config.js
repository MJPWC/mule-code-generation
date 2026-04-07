import dotenv from "dotenv";

dotenv.config();

/**
 * Configuration manager for the LLM Agent
 * Loads and validates environment variables
 */
class Config {
  constructor(customConfig = null) {
    // If custom config provided, use it; otherwise use environment variables
    if (customConfig && customConfig.provider) {
      this.provider = customConfig.provider.toLowerCase();
      this.customModel = customConfig.model;
      this.isCustomProvider = true;
    } else {
      this.provider = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
      this.customModel = null;
      this.isCustomProvider = false;
    }

    // Common options
    this.maxTokens = parseInt(process.env.MAX_TOKENS || "1000");
    this.temperature = parseFloat(process.env.TEMPERATURE || "0.7");

    // OpenAI
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.openaiModel = (this.customModel && this.provider === "openai") ? this.customModel : (process.env.OPENAI_MODEL || "gpt-3.5-turbo");

    // Ollama
    this.ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    this.ollamaModel = (this.customModel && this.provider === "ollama") ? this.customModel : (process.env.OLLAMA_MODEL || "llama3.1");

    // OpenRouter
    this.openrouterApiKey = process.env.OPENROUTER_API_KEY;
    this.openrouterModel = (this.customModel && this.provider === "openrouter") ? this.customModel : (process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct");
    this.openrouterBaseUrl = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    this.openrouterSite = process.env.OPENROUTER_SITE; // optional Referer
    this.openrouterAppName = process.env.OPENROUTER_APP_NAME; // optional X-Title

    // In src/config/config.js, add these configurations after the OpenRouter config:

    // Cohere
    this.cohereApiKey = process.env.COHERE_API_KEY;
    this.cohereModel = (this.customModel && this.provider === "cohere") ? this.customModel : (process.env.COHERE_MODEL || "command-a-03-2025");

    // Gemini
    this.geminiApiKey = process.env.GEMINI_API_KEY;
    this.geminiModel = (this.customModel && this.provider === "gemini")
      ? this.customModel
      : (process.env.GEMINI_MODEL || "gemini-2.0-flash");

    // Support multiple Gemini API keys (GEMINI_API_KEY_1..4)
    this.geminiApiKeys = [];
    for (let i = 1; i <= 4; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`];
      if (key) {
        this.geminiApiKeys.push(key);
      }
    }
    // Backward compatibility: if only GEMINI_API_KEY is set, use it
    if (!this.geminiApiKeys.length && this.geminiApiKey) {
      this.geminiApiKeys.push(this.geminiApiKey);
    }

    // Groq
    this.groqApiKey = process.env.GROQ_API_KEY;
    this.groqModel = (this.customModel && this.provider === "groq")
      ? this.customModel
      : (process.env.GROQ_MODEL || "llama-3.3-70b-versatile");

    // Anthropic
    this.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    this.anthropicModel = (this.customModel && this.provider === "anthropic")
      ? this.customModel
      : (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929");
      
    this.validate();
  }

  /**
   * Validate required configuration
   */
  // In src/config/config.js, update the validate() method to include all providers
  validate() {
    if (this.provider === "openai") {
      if (!this.openaiApiKey) {
        throw new Error(
          "OPENAI_API_KEY is required when LLM_PROVIDER=openai. Get one at https://platform.openai.com/"
        );
      }
    } else if (this.provider === "ollama") {
      if (!this.ollamaBaseUrl) {
        throw new Error("OLLAMA_BASE_URL is required for Ollama provider");
      }
    } else if (this.provider === "openrouter") {
      if (!this.openrouterApiKey) {
        throw new Error(
          "OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter. Get one at https://openrouter.ai/"
        );
      }
    } else if (this.provider === "gemini") {
      const hasSingleKey = !!this.geminiApiKey;
      const hasMultiKeys = Array.isArray(this.geminiApiKeys) && this.geminiApiKeys.length > 0;
      if (!hasSingleKey && !hasMultiKeys) {
        throw new Error(
          "At least one GEMINI_API_KEY or GEMINI_API_KEY_1..4 is required when LLM_PROVIDER=gemini. Get one at https://ai.google.com/"
        );
      }
    } else if (this.provider === "groq") {
      if (!this.groqApiKey) {
        throw new Error(
          "GROQ_API_KEY is required when LLM_PROVIDER=groq. Get one at https://groq.com/"
        );
      }
    } else if (this.provider === "anthropic") {
      if (!this.anthropicApiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic. Get one at https://www.anthropic.com/"
        );
      }
    } else if (this.provider === "cohere") {
      if (!this.cohereApiKey) {
        throw new Error(
          "COHERE_API_KEY is required when LLM_PROVIDER=cohere. Get one at https://cohere.com/"
        );
      }
    } else {
      throw new Error(`Unknown LLM_PROVIDER: ${this.provider}`);
    }
  }

  /**
   * Get OpenAI configuration
   */
  getProvider() {
    return this.provider;
  }

  getOpenAIConfig() {
    return {
      apiKey: this.openaiApiKey,
      model: this.openaiModel,
      maxTokens: this.maxTokens,
      temperature: this.temperature
    };
  }

  getOllamaConfig() {
    return {
      baseUrl: this.ollamaBaseUrl,
      model: this.ollamaModel,
      maxTokens: this.maxTokens,
      temperature: this.temperature
    };
  }

  getOpenRouterConfig() {
    return {
      baseUrl: this.openrouterBaseUrl,
      apiKey: this.openrouterApiKey,
      model: this.openrouterModel,
      site: this.openrouterSite,
      appName: this.openrouterAppName,
      maxTokens: this.maxTokens,
      temperature: this.temperature
    };
  }

  // Add these methods to the Config class
  getGeminiConfig() {
    return {
      apiKey: (this.geminiApiKeys && this.geminiApiKeys.length
        ? this.geminiApiKeys[0]
        : this.geminiApiKey),
      apiKeys: this.geminiApiKeys,
      model: this.customModel || process.env.GEMINI_MODEL || "gemini-2.0-flash",
    };
  }

  getGroqConfig() {
    return {
      apiKey: this.groqApiKey,
      model: this.customModel || process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    };
  }

  getAnthropicConfig() {
    return {
      apiKey: this.anthropicApiKey,
      model: this.customModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
    };
  }

  // Add these methods to the Config class
  getCohereConfig() {
    return {
      apiKey: this.cohereApiKey,
      model: this.customModel || process.env.COHERE_MODEL || "command-a-03-2025",
    };
  }

}

export default Config;

