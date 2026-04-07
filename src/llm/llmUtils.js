/**
 * Get effective provider and model based on context and requested provider
 * @param {string} requestedProvider - The requested provider ('auto' or specific provider)
 * @param {string} requestedModel - The requested model (optional)
 * @param {string} context - The context: 'analysis' (for IHLD analysis) or 'code-generation' (for Mule code generation)
 * @returns {object} Object with effectiveProvider and effectiveModel
 */
function getEffectiveProviderAndModel(requestedProvider, requestedModel, context = 'code-generation') {
  // If specific provider is requested (not 'auto'), use it
  if (requestedProvider && requestedProvider !== 'auto') {
    return { effectiveProvider: requestedProvider, effectiveModel: requestedModel };
  }

  // Define priority orders based on context
  const analysisPriority = [
    { name: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
    { name: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' },
    { name: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { name: 'cohere', apiKeyEnv: 'COHERE_API_KEY' },
    { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    { name: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
    { name: 'ollama' },
  ];

  const codeGenerationPriority = [
    { name: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { name: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
    { name: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' },
    { name: 'cohere', apiKeyEnv: 'COHERE_API_KEY' },
    { name: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    { name: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
    { name: 'ollama' },
  ];

  // Select priority order based on context
  const orderedProviders = context === 'analysis' ? analysisPriority : codeGenerationPriority;
  const contextName = context === 'analysis' ? 'IHLD Analysis' : 'Code Generation';

  for (const providerOption of orderedProviders) {
    if (providerOption.apiKeyEnv) {
      if (process.env[providerOption.apiKeyEnv]) {
        console.log(`Auto-detected LLM Provider for ${contextName}: ${providerOption.name} (via ${providerOption.apiKeyEnv})`);
        return { effectiveProvider: providerOption.name, effectiveModel: null };
      }
    } else if (providerOption.name === 'ollama') {
      if (process.env.OLLAMA_BASE_URL) {
        console.log(`Auto-detected LLM Provider for ${contextName}: ${providerOption.name} (via OLLAMA_BASE_URL)`);
        return { effectiveProvider: providerOption.name, effectiveModel: null };
      }
    }
  }

  // Default fallback based on context
  const defaultProvider = context === 'analysis' ? 'groq' : 'anthropic';
  console.warn(`No specific LLM Provider API key found in environment variables. Defaulting to ${defaultProvider} for ${contextName}.`);
  return { effectiveProvider: defaultProvider, effectiveModel: null };
}

export { getEffectiveProviderAndModel };
