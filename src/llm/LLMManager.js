import GeminiClient from './GeminiClient.js';
import OpenAIClient from './OpenAIClient.js';
import AnthropicClient from './AnthropicClient.js';
import OpenRouterClient from './OpenRouterClient.js';
import GroqClient from './GroqClient.js';
import OllamaClient from './OllamaClient.js';
import MyCohereClient from './CohereClient.js';
import Config from '../config/config.js';

class LLMManager {
  static instance = null;

  constructor(initialClientConfigs = null, options = {}) {
    if (LLMManager.instance && !initialClientConfigs && !options.provider) { // Only return singleton if no custom configs are provided and no specific provider is requested
      return LLMManager.instance;
    }

    this.config = new Config({ provider: options.provider, model: options.model }); // Pass provider/model to internal Config
    this.clients = new Map();
    this.primaryClient = null;
    this.fallbackClients = [];

    this.initializeClients(initialClientConfigs);

    // Ensure currentProvider and defaultModel are set after clients are initialized
    this.currentProvider = this.getClientKey(this.primaryClient);
    this.defaultModel = this.primaryClient?.defaultModel || 'llama-3.3-70b-versatile';

    if (!initialClientConfigs && !options.provider) { // Only set as singleton if no custom configs and no specific provider
      LLMManager.instance = this;
    }
  }

  // Refactored to accept custom client configurations
  initializeClients(customClientConfigs = null) {
    // Define clients in the exact fallback order (Anthropic -> Groq -> Gemini -> Cohere -> OpenRouter -> OpenAI -> Ollama)
    const clientConfigs = customClientConfigs || this.getDefaultClientConfigs();

    // Initialize clients in the specified order
    for (const { key, class: ClientClass, config, priority } of clientConfigs) {
      if (config.apiKey || key === 'ollama') {  // ollama might not need an API key
        // Explicitly check for API key presence for better debugging
        if (!config.apiKey && key !== 'ollama') {
          console.warn(`⚠️ Skipping LLM client ${key}: API key is missing or not configured.`);
          continue; // Skip this client if API key is missing
        }

        try {
          const client = new ClientClass(config);
          this.clients.set(key, client);

          if (!this.primaryClient) {
            this.primaryClient = client;
            console.log(`✅ Primary LLM set to: ${key}`);
          } else {
            this.fallbackClients.push({ client, priority, key });
            console.log(`✅ Added fallback LLM: ${key} (priority ${priority})`);
          }
        } catch (error) {
          console.error(`❌ Failed to initialize ${key} client:`, error.message);
        }
      }
    }

    // After all clients are initialized, if Gemini ended up as primary, register all fallbacks
    if (this.primaryClient instanceof GeminiClient && this.fallbackClients.length > 0) {
      console.log('🔗 Registering fallback clients with Gemini...');
      this.fallbackClients
        .sort((a, b) => a.priority - b.priority)
        .forEach(({ client, priority, key: fbKey }) => {
          console.log(`   - ${fbKey} (priority ${priority})`);
          GeminiClient.registerFallback(client, priority);
        });
    }
  }

  // New method to provide default client configurations
  getDefaultClientConfigs() {
    return [
      {
        key: 'anthropic',
        class: AnthropicClient,
        config: {
          apiKey: this.config.anthropicApiKey,
          model: this.config.anthropicModel
        },
        priority: 1 // Anthropic is the primary LLM provider
      },
      {
        key: 'groq',
        class: GroqClient,
        config: {
          apiKey: this.config.groqApiKey,
          model: this.config.groqModel
        },
        priority: 2
      },
      {
        key: 'gemini',
        class: GeminiClient,
        config: {
          apiKey: this.config.geminiApiKey || (this.config.geminiApiKeys && this.config.geminiApiKeys[0]),
          apiKeys: this.config.geminiApiKeys,
          model: this.config.geminiModel
        },
        priority: 3
      },
      {
        key: 'cohere',
        class: MyCohereClient,
        config: {
          apiKey: this.config.cohereApiKey,
          model: this.config.cohereModel
        },
        priority: 4
      },
      {
        key: 'openrouter',
        class: OpenRouterClient,
        config: {
          apiKey: this.config.openrouterApiKey,
          model: this.config.openrouterModel,
          baseUrl: this.config.openrouterBaseUrl,
          site: this.config.openrouterSite,
          appName: this.config.openrouterAppName
        },
        priority: 5
      },
      {
        key: 'openai',
        class: OpenAIClient,
        config: {
          apiKey: this.config.openaiApiKey,
          model: this.config.openaiModel
        },
        priority: 6
      },
      {
        key: 'ollama',
        class: OllamaClient,
        config: {
          baseUrl: this.config.ollamaBaseUrl,
          model: this.config.ollamaModel
        },
        priority: 7
      }
    ];
  }

  async chatCompletionsCreate(params) {
    // Try primary client first
    if (this.primaryClient) {
      const provider = this.getClientKey(this.primaryClient) || 'primary';
      console.log(`🔄 Using LLM provider: ${provider}`);

      try {
        const primaryParams = {
          ...params,
          model: params.model || this.primaryClient.defaultModel
        };
        console.log(`🔧 Using model: ${primaryParams.model} for provider: ${provider}`);
        const result = await this.primaryClient.chatCompletionsCreate(primaryParams);
        try {
          const preview = (result?.choices?.[0]?.message?.content || '').slice(0, 300).replace(/\s+/g, ' ').trim();
          console.log(`📤 Provider ${provider} response preview: ${preview}`);
        } catch (_) { /* noop */ }
        // Attach metadata about which provider was used
        if (result && typeof result === 'object') {
          result._providerUsed = provider;
          result._modelUsed = primaryParams.model;
        }
        return result;
      } catch (error) {
        const status = error?.status || error?.response?.status;
        const errorData = error?.response?.data || {};
        const errorMessage = errorData?.error?.message || error.message || 'Unknown error';
        
        // Determine failure reason
        let failureReason = '';
        if (status === 429) {
          const tpmInfo = errorMessage.match(/Limit (\d+), (?:Used (\d+), )?Requested (\d+)/);
          if (tpmInfo) {
            failureReason = `Rate limit exceeded (TPM: Limit ${tpmInfo[1]}, Requested ${tpmInfo[3]})`;
          } else {
            failureReason = 'Rate limit exceeded (429)';
          }
        } else if (status === 413) {
          failureReason = 'Request too large (413) - Token limit exceeded';
        } else if (status === 400) {
          failureReason = `Bad request (400): ${errorMessage}`;
        } else if (status === 401) {
          failureReason = 'Authentication failed (401) - Invalid API key';
        } else if (status === 403) {
          failureReason = 'Access forbidden (403) - Check API permissions';
        } else if (status >= 500 && status < 600) {
          failureReason = `Server error (${status}): ${errorMessage}`;
        } else {
          failureReason = errorMessage;
        }
        
        console.error(`❌ ${provider} failed: ${failureReason}`);
        if (error.response) {
          console.error(`   Status: ${status}`);
          if (errorData?.error) {
            console.error(`   Error type: ${errorData.error.type || 'unknown'}`);
            console.error(`   Error code: ${errorData.error.code || 'unknown'}`);
          }
        }

        // Only fall back for retryable statuses: 429, 413, or 5xx
        const isRetryable = status === 429 || status === 413 || (status >= 500 && status < 600);
        if (!isRetryable) {
          throw error; // Do not switch provider on 4xx like 400/401
        }
        
        // Log that we're falling back with specific reason
        if (status === 429) {
          console.warn(`⚠️ ${provider} rate limited. Reason: ${failureReason}`);
          console.warn(`⚠️ Falling back to next available provider...`);
        } else if (status === 413) {
          console.warn(`⚠️ ${provider} request too large. Reason: ${failureReason}`);
          console.warn(`⚠️ Falling back to next available provider...`);
        } else if (status >= 500 && status < 600) {
          console.warn(`⚠️ ${provider} server error. Reason: ${failureReason}`);
          console.warn(`⚠️ Falling back to next available provider...`);
        }
      }
    }

    // Try fallback clients in priority order
    const sortedFallbacks = [...this.fallbackClients].sort((a, b) => a.priority - b.priority);

    for (const { client, key } of sortedFallbacks) {
      try {
        console.log(`🔄 Trying fallback LLM: ${key}`);
        // Create a new params object with the client's default model
        const fallbackParams = {
          ...params,
          model: client.defaultModel // Always use the client's default model
        };
        console.log(`🔧 Using model: ${fallbackParams.model} for fallback: ${key}`);
        const result = await client.chatCompletionsCreate(fallbackParams);
        try {
          const preview = (result?.choices?.[0]?.message?.content || '').slice(0, 300).replace(/\s+/g, ' ').trim();
          console.log(`📤 Fallback ${key} response preview: ${preview}`);
        } catch (_) { /* noop */ }
        // Attach metadata about which provider was actually used (fallback)
        if (result && typeof result === 'object') {
          result._providerUsed = key;
          result._modelUsed = fallbackParams.model;
        }
        return result;
      } catch (error) {
        console.error(`❌ Fallback ${key} failed: ${error.message}`);
        // Log more details for debugging
        if (error.response) {
          console.error('Error details:', {
            status: error.response.status,
            data: error.response.data
          });
        }

        // Only continue to next fallback for retryable errors
        const status = error?.status || error?.response?.status;
        const isRetryable = status === 429 || status === 413 || (status >= 500 && status < 600);
        if (!isRetryable) {
          throw error; // Stop fallback chain on non-retryable client error
        }
      }
    }

    throw new Error('All LLM providers failed. Please check your API keys and network connection.');
  }

  // Helper to get client key from the clients map
  getClientKey(client) {
    if (!client) return 'unknown';
    for (const [key, value] of this.clients.entries()) {
      if (value === client) return key;
    }
    return 'unknown';
  }

  async testConnection() {
    // Attempt a simple chat completion to verify connection
    try {
      await this.chatCompletionsCreate({
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 10 // Request a very small response
      });
      console.log('✅ LLMManager: Connection test successful.');
      return true;
    } catch (error) {
      console.error('❌ LLMManager: Connection test failed:', error.message);
      return false;
    }
  }

  static getInstance() {
    if (!LLMManager.instance) {
      LLMManager.instance = new LLMManager();
    }
    return LLMManager.instance;
  }
}

export default LLMManager;
