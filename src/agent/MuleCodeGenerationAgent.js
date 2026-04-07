import LLMManager from "../llm/LLMManager.js";
import Config from "../config/config.js"; // Import Config class
import { muleCodeConfig } from "../config/muleCodeConfig.js";
import { getEffectiveProviderAndModel } from "../llm/llmUtils.js";
import { validateMuleXml } from '../mule/muleValidator.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_CONCURRENT_FILES = 5;
/** Max length of IHLD analysis in context to avoid token overflow; code gen gets RAML + this (loophole #6). */
const MAX_IHLD_ANALYSIS_CONTEXT_CHARS = 4000;

/**
 * Mule Code Generation Agent
 * Generates Mule application code based on RAML specifications
 */
class MuleCodeGenerationAgent {
  constructor(baseConfig = null) {
    try {
      this.llmManager = LLMManager.getInstance(); // Get singleton LLMManager first
      this.config = baseConfig || new Config({ provider: this.llmManager.currentProvider, model: this.llmManager.defaultModel });
      
      // Validate LLM configuration
      this.validateLLMConfiguration();
      
      // Initialize provider and check health
      this.initializeProvider();
      
      // Track provider usage for analytics and debugging
      this.providerAttempts = [];
      this.fallbackHistory = [];
      
      this.conversationHistory = [];
      this.maxRetries = 3;
      this.initialBackoffMs = 1000; // 1 second initial backoff
      this.maxBackoffMs = 30000; // 30 seconds max backoff
      
      console.log('✅ MuleCodeGenerationAgent initialized with LLM fallback support');
    } catch (error) {
      console.error('❌ Failed to initialize MuleCodeGenerationAgent:', error.message);
      throw error; // Re-throw to prevent silent failures
    }

    // Set agent metadata (using the renamed config)
    this.name = muleCodeConfig.name;
    this.description = muleCodeConfig.description;
    this.conversationStarters = muleCodeConfig.conversationStarters;
    this.knowledge = muleCodeConfig.knowledge;

    // Set system prompt (instructions)
    this.systemPrompt = muleCodeConfig.instructions;
  }

  async initializeProvider() {
    try {
      this.client = this.llmManager;
      this.defaultModel = this.llmManager.defaultModel;
      this.currentProvider = this.llmManager.currentProvider;
      
      // Perform initial health check
      const isHealthy = await this.isAnyProviderAvailable();
      if (!isHealthy) {
        console.warn('⚠️  No healthy LLM providers available. Some features may not work as expected.');
      }
      
      console.log(`✅ Mule Code Generation initialized with LLMManager ` +
        `(Primary: ${this.currentProvider}, Model: ${this.defaultModel}, ` +
        `Fallbacks: ${this.llmManager.fallbackClients.length})`);
        
      return isHealthy;
    } catch (error) {
      console.error('❌ Error initializing LLM provider:', error);
      throw error;
    }
  }
  
  /**
   * Check if any LLM provider is available
   * @returns {Promise<boolean>} True if at least one provider is healthy
   */
  async isAnyProviderAvailable() {
    if (!this.llmManager) {
      console.error('LLM Manager is not initialized');
      return false;
    }
    
    try {
      // The LLMManager's testConnection method will try all available providers
      const isConnected = await this.llmManager.testConnection();
      if (isConnected) {
        console.log('✅ At least one LLM provider is available.');
        return true;
      }
    } catch (error) {
      console.error('❌ Error during LLMManager connection test:', error.message);
    }
    return false;
  }
  
  /**
   * Track provider usage for analytics and debugging
   */
  trackProviderUsage(provider, success, durationMs, error = null) {
    const usage = {
      provider,
      success,
      durationMs,
      timestamp: new Date().toISOString(),
      error: error ? error.toString() : null
    };
    
    this.providerAttempts.push(usage);
    
    // Keep only the last 100 attempts to prevent memory leaks
    if (this.providerAttempts.length > 100) {
      this.providerAttempts.shift();
    }
    
    if (success) {
      console.log(`✅ Successfully used ${provider} in ${durationMs}ms`);
    } else {
      console.warn(`❌ Failed using ${provider} after ${durationMs}ms: ${error}`);
    }
  }
  
  /**
   * Validate LLM configuration and throw if invalid
   * @throws {Error} If configuration is invalid
   */
  validateLLMConfiguration() {
    if (!this.llmManager) {
      throw new Error('LLM Manager is not initialized');
    }
    
    if (!this.llmManager.primaryClient) {
      throw new Error('No primary LLM provider is configured. Please check your API keys and configuration.');
    }
    
    if (this.llmManager.fallbackClients.length === 0) {
      console.warn('⚠️  No fallback LLM providers configured. Consider adding fallbacks for better reliability.');
    }
  }

  /**
   * Validate and warn about potentially low max_tokens values
   * @param {number} maxTokens - The max_tokens value to validate
   * @param {string} taskType - Type of task (e.g., 'code-generation', 'question-generation')
   * @param {number} recommendedMin - Recommended minimum for this task type
   */
  validateMaxTokens(maxTokens, taskType = 'general', recommendedMin = 1000) {
    if (!maxTokens || maxTokens < recommendedMin) {
      console.warn(
        `⚠️  WARNING: max_tokens (${maxTokens || 'undefined'}) may be too low for ${taskType}. ` +
        `Recommended minimum: ${recommendedMin}. Response may be truncated.`
      );
    }
  }

  /**
   * Detect if an LLM response was truncated
   * @param {string} response - The LLM response to check
   * @param {number} maxTokens - The max_tokens limit that was used
   * @returns {object} { isTruncated: boolean, reason: string, suggestions: string[] }
   */
  detectTruncation(response, maxTokens = null) {
    if (!response || response.length === 0) {
      return { isTruncated: false, reason: null, suggestions: [] };
    }

    const issues = [];
    const suggestions = [];

    // Check 1: Incomplete XML tags
    const xmlTagPattern = /<[^/>]+(?!\/>)[^>]*$/;
    if (xmlTagPattern.test(response.trim())) {
      issues.push('Incomplete XML tag detected at end of response');
    }

    // Check 2: Unclosed XML tags (count opening vs closing)
    const openTags = (response.match(/<[^/!?][^>]*>/g) || []).length;
    const closeTags = (response.match(/<\/[^>]+>/g) || []).length;
    if (openTags > closeTags) {
      issues.push(`Unclosed XML tags detected (${openTags} open, ${closeTags} closed)`);
    }

    // Check 3: Incomplete JSON (unclosed braces/brackets)
    const openBraces = (response.match(/\{/g) || []).length;
    const closeBraces = (response.match(/\}/g) || []).length;
    const openBrackets = (response.match(/\[/g) || []).length;
    const closeBrackets = (response.match(/\]/g) || []).length;
    if (openBraces !== closeBraces || openBrackets !== closeBrackets) {
      issues.push(`Incomplete JSON detected (braces: ${openBraces}/${closeBraces}, brackets: ${openBrackets}/${closeBrackets})`);
    }

    // Check 4: Incomplete file delimiter (>>> filepath without closing <<< or content)
    const fileDelimiterPattern = />>>\s*[^\n<]+?\s*$/m;
    if (fileDelimiterPattern.test(response)) {
      issues.push('Incomplete file delimiter detected (>>> filepath without content or closing <<<)');
    }

    // Check 5: Response ends mid-sentence or mid-word (common truncation pattern)
    const trimmedResponse = response.trim();
    const lastChar = trimmedResponse[trimmedResponse.length - 1];
    const sentenceEnders = ['.', '!', '?', '>', '}', ']', ')', '"', "'"];
    const lastWord = trimmedResponse.split(/\s+/).pop() || '';
    
    // If response doesn't end with a sentence ender and last word looks incomplete
    if (!sentenceEnders.includes(lastChar) && lastWord.length > 0 && lastWord.length < 3) {
      // Check if it's not a valid short word
      const validShortWords = ['if', 'or', 'to', 'is', 'as', 'at', 'be', 'do', 'go', 'no', 'so', 'up', 'we', 'it', 'of', 'on', 'in', 'an', 'am', 'id'];
      if (!validShortWords.includes(lastWord.toLowerCase())) {
        issues.push('Response appears to end mid-word or mid-sentence');
      }
    }

    // Check 6: Incomplete Maven POM (common case)
    if (response.includes('<project') && !response.includes('</project>')) {
      issues.push('Incomplete pom.xml detected (missing closing </project> tag)');
    }

    // Check 7: Incomplete Mule XML (common case)
    if (response.includes('<mule') && !response.includes('</mule>')) {
      issues.push('Incomplete Mule XML detected (missing closing </mule> tag)');
    }

    // Check 8: Response ends with incomplete code block
    if (trimmedResponse.includes('```') && (trimmedResponse.match(/```/g) || []).length % 2 !== 0) {
      issues.push('Incomplete code block detected (unclosed ```)');
    }

    const isTruncated = issues.length > 0;

    if (isTruncated) {
      suggestions.push('Response appears to be truncated. Possible causes:');
      suggestions.push('1. max_tokens limit was too low');
      if (maxTokens) {
        suggestions.push(`   Current max_tokens: ${maxTokens}`);
        suggestions.push(`   Suggested: Increase max_tokens to ${Math.max(maxTokens * 2, 8000)} or higher`);
      }
      suggestions.push('2. Input prompt was too long, leaving insufficient tokens for response');
      suggestions.push('3. LLM provider rate limit or token limit reached');
    }

    return {
      isTruncated,
      reason: issues.length > 0 ? issues.join('; ') : null,
      issues,
      suggestions
    };
  }

  /**
   * Send a prompt to the LLM
   * @param {string} prompt - The user's prompt
   * @param {object} options - Additional options
   * @returns {Promise<string>} The LLM's response
   */
  async ask(prompt, options = {}) {
    const messages = this.buildMessages(prompt);
    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    
    // Validate max_tokens for general tasks
    this.validateMaxTokens(maxTokens, 'general', 1000);
    
    const params = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: maxTokens
    };

    const response = await this.requestWithRetry(params);
    const answer = response.choices[0].message.content;
    
    // Detect truncation
    const truncationCheck = this.detectTruncation(answer, maxTokens);
    if (truncationCheck.isTruncated) {
      console.error('❌ TRUNCATION DETECTED in LLM response:');
      console.error(`   Reason: ${truncationCheck.reason}`);
      console.error(`   Issues found: ${truncationCheck.issues.join(', ')}`);
      truncationCheck.suggestions.forEach(suggestion => console.warn(`   ${suggestion}`));
      console.error('   ⚠️  Response may be incomplete. Generated code may be invalid or missing files.');
    }
    
    this.addToHistory(prompt, answer);
    return answer;
  }

  /**
   * Ask with system prompt
   */
  async askWithSystemPrompt(systemPrompt, userPrompt, options = {}) {
    const messages = [
      { role: "system", content: systemPrompt },
      ...this.buildMessages(userPrompt)
    ];

    const maxTokens = options.maxTokens ?? this.config.maxTokens;
    
    // Validate max_tokens - use task-specific recommendation if provided
    const taskType = options.taskType || 'general';
    const recommendedMin = options.recommendedMinTokens || 1000;
    this.validateMaxTokens(maxTokens, taskType, recommendedMin);

    const params = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: maxTokens
    };
    console.log(`Requested model: ${params.model} (LLMManager may override per provider)`);
    if (maxTokens) {
      console.log(`Using max_tokens: ${maxTokens} for task: ${taskType}`);
    }

    const response = await this.requestWithRetry(params);
    const answer = response.choices[0].message.content;
    
    // Detect truncation
    const truncationCheck = this.detectTruncation(answer, maxTokens);
    if (truncationCheck.isTruncated) {
      console.error('❌ TRUNCATION DETECTED in LLM response:');
      console.error(`   Reason: ${truncationCheck.reason}`);
      console.error(`   Issues found: ${truncationCheck.issues.join(', ')}`);
      truncationCheck.suggestions.forEach(suggestion => console.warn(`   ${suggestion}`));
      console.error('   ⚠️  Response may be incomplete. Generated code may be invalid or missing files.');
    }
    
    this.addToHistory(userPrompt, answer);
    return answer;
  }

  /**
   * Build messages array
   */
  buildMessages(prompt) {
    const messages = [];

    this.conversationHistory.forEach(entry => {
      messages.push({ role: "user", content: entry.prompt });
      messages.push({ role: "assistant", content: entry.answer });
    });

    messages.push({ role: "user", content: prompt });
    return messages;
  }

  /**
   * Add to conversation history
   */
  addToHistory(prompt, answer) {
    this.conversationHistory.push({ prompt, answer });

    if (this.conversationHistory.length > 10) {
      this.conversationHistory.shift();
    }
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  getHistory() {
    return this.conversationHistory;
  }

  /**
   * Internal: Request with retry/backoff on 429/5xx
   */
  /**
   * Enhanced request method with detailed error tracking and fallback handling
   */
  async requestWithRetry(params) {
    let attempt = 0;
    const errors = [];
    let lastError;
    
    // Reset provider attempts for this request
    this.providerAttempts = [];

    // Ensure LLMManager is initialized
    if (!this.client) {
      await this.initializeProvider();
    }

    // Check if any providers are available
    const isHealthy = await this.isAnyProviderAvailable();
    if (!isHealthy) {
      throw new Error('No healthy LLM providers available. Please check your configuration.');
    }

    while (attempt <= this.maxRetries) {
      const attemptStartTime = Date.now();
      
      try {
        const currentProvider = this.client.currentProvider || 'unknown';
        console.log(`🔍 LLM request attempt ${attempt + 1} using ${currentProvider}...`);
        
        const response = await this.client.chatCompletionsCreate({
          ...params,
          model: params.model || this.defaultModel
        });
        
        // Get the actual provider that was used (may be different if fallback occurred)
        const actualProvider = response?._providerUsed || currentProvider;
        const actualModel = response?._modelUsed || (params.model || this.defaultModel);
        
        // Log successful provider usage with the actual provider used
        this.trackProviderUsage(actualProvider, true, Date.now() - attemptStartTime);
        
        // Log if fallback was used
        if (actualProvider !== currentProvider) {
          console.log(`✅ Successfully used fallback provider: ${actualProvider} (model: ${actualModel})`);
        }
        
        return response;
        
      } catch (error) {
        const status = error?.status || error?.response?.status || 'unknown';
        const currentProvider = this.client?.currentProvider || 'unknown';
        const errorMessage = error.message || 'Unknown error';
        
        // Track failed attempt
        this.trackProviderUsage(currentProvider, false, Date.now() - attemptStartTime, errorMessage);
        
        // Store error details
        errors.push({
          provider: currentProvider,
          status,
          message: errorMessage,
          attempt,
          timestamp: new Date().toISOString()
        });
        
        lastError = error;
        const isRateLimited = status === 429;
        const isServerError = status >= 500 && status < 600;

        // Check if we should try another provider
        // If we get here, either no fallback was available or we hit max retries
        if (isRateLimited || isServerError) {
          console.warn(`⚠️  ${currentProvider} returned ${status}, checking for fallback providers...`);
        } else { // Only increment attempt if not a retryable error that could trigger a fallback
          attempt++;
        }
        if (attempt > this.maxRetries) {
          throw new Error(
            `LLM request failed after ${this.maxRetries + 1} attempts. ` +
            `Tried providers: ${errors.map(e => e.provider).join(', ')}. ` +
            `Last error: ${lastError?.message || 'Unknown error'}. ` +
            `Details: ${errors.map(e => `${e.provider} (${e.status}): ${e.message}`).join('; ')}`
          );
        }
        // If we get here, either no fallback was available or we hit max retries
        if (attempt === this.maxRetries) {
          const errorDetails = errors.map(e => 
            `${e.provider} (${e.status}): ${e.message}`
          ).join('; ');
          
          throw new Error(
            `LLM request failed after ${this.maxRetries + 1} attempts. ` +
            `Tried providers: ${errors.map(e => e.provider).join(', ')}. ` +
            `Last error: ${lastError?.message || 'Unknown error'}. ` +
            `Details: ${errorDetails}`
          );
        }

        // Standard retry with backoff
        const backoffMs = this.computeBackoffMs(attempt);
        console.warn(`⏳ Retrying in ${backoffMs}ms... (Attempt ${attempt + 1}/${this.maxRetries})`);
        await this.sleep(backoffMs);
        attempt++;
      }
    }
    
    // This should theoretically never be reached due to the throw in the loop
    throw new Error('Unexpected error in requestWithRetry');
  }

  /**
   * Compute backoff time with exponential backoff and jitter
   * @param {number} attempt - Current attempt number (0-based)
   * @returns {number} Backoff time in milliseconds
   */
  computeBackoffMs(attempt) {
    const base = Math.min(
      this.initialBackoffMs * Math.pow(2, attempt),
      this.maxBackoffMs
    );
    // Add jitter between 0 and 500ms to prevent thundering herd
    const jitter = Math.floor(Math.random() * 500);
    return Math.min(base + jitter, this.maxBackoffMs);
  }

  async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generates Mule XML for a scheduled job.
   * @param {string} jobName - The name of the scheduled job.
   * @param {object} details - Details about the scheduled job (e.g., frequency, logic description).
   * @returns {string} The Mule XML content for the scheduled job.
   */
  _generateScheduledJobCode(jobName, details = {}) {
    const frequency = details.frequency || 1000;
    const timeUnit = details.timeUnit || "MILLISECONDS";
    const logicDescription = details.logicDescription || "// TODO: Implement actual scheduled job logic here";

    return `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns:quartz="http://www.mulesoft.org/schema/mule/quartz"
      xmlns:http="http://www.mulesoft.org/schema/mule/http"
      xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:doc="http://www.mulesoft.org/schema/mule/documentation"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="
          http://www.mulesoft.org/schema/mule/core http://www.mulesoft.org/schema/mule/core/current/mule.xsd
          http://www.mulesoft.org/schema/mule/http http://www.mulesoft.org/schema/mule/http/current/mule-http.xsd
          http://www.mulesoft.org/schema/mule/quartz http://www.mulesoft.org/schema/mule/quartz/current/mule-quartz.xsd">

  <flow name="${jobName}-flow">
    <quartz:scheduler doc:name="Scheduler" >
      <scheduling-strategy >
        <fixed-frequency frequency="${frequency}" timeUnit="${timeUnit}"/>
      </scheduling-strategy>
    </quartz:scheduler>
    <logger level="INFO" doc:name="Log Start" message="Starting scheduled job: ${jobName}"/>

    <!-- Placeholder for business logic based on Integration Design Document details -->
    <scripting:execute scriptEngine="dwl" doc:name="Implement Logic">
      <scripting:script ><![CDATA[%dw 2.0
output application/json
---
{
  "message": "${logicDescription}",
  "jobName": "${jobName}",
  "timestamp": now()
}]]></scripting:script>
    </scripting:execute>
    
    <logger level="INFO" doc:name="Log End" message="Completed scheduled job: ${jobName}"/>
  </flow>
</mule>`;
  }

  /**
   * Get agent configuration/metadata
   * @returns {object} Agent configuration
   */
  getConfig() {
    return {
      name: this.name,
      description: this.description,
      instructions: this.systemPrompt,
      conversationStarters: this.conversationStarters,
      knowledge: this.knowledge
    };
  }

  /**
   * Generate Mule code from RAML specification
   * @param {string} ramlContent - RAML specification (REQUIRED)
   * @param {string} apiName - Name of the API
   * @param {object} options - Additional options
   * @param {object} context - Additional context from previous agents
   * @returns {Promise<object>} Mule project structure with files
   */
  async generateMuleCode(ramlContent, apiName = "MuleSoftAPI", flowOptions = {}, context = {}) {
    if (!ramlContent) {
      throw new Error("RAML specification is required. Please provide RAML content.");
    }

    const sessionId = context.sessionId || null;
    context.sessionId = sessionId; // Ensure session ID is propagated

    let muleProject = { files: [] };

    try {
      // Stage 1: Generate Project Skeleton and Configuration Files
      const skeletonProject = await this._generateMuleProjectSkeleton(ramlContent, apiName, flowOptions, context);
      muleProject.files.push(...skeletonProject.files);

      // Stage 2: Generate API Flows and related DataWeave scripts
      const apiFlowsProject = await this._generateMuleApiFlows(ramlContent, apiName, flowOptions, skeletonProject, context);
      muleProject.files.push(...apiFlowsProject.files);

      // Deduplicate files before returning
      this.deduplicateFiles(muleProject);

      // Final check: Ensure pom.xml exists after all stages
      const finalPomXml = muleProject.files.find(f => f.path === 'pom.xml');
      if (!finalPomXml) {
        console.error('❌ CRITICAL: pom.xml is missing after all generation stages. Fallback disabled for LLM quality testing.');
      } else {
        console.log('✅ pom.xml confirmed present in final project files');
      }

      return muleProject;
    } catch (error) {
      console.error('❌ Error generating Mule code in stages, falling back to defaults:', error);
      // Fallback to default files if staged generation fails
      this.addDefaultFiles(muleProject, apiName);
      // Deduplicate files before returning
      this.deduplicateFiles(muleProject);
      return muleProject;
    }
  }

  /**
   * Build API spec text from context (apiDetails + ihldAnalysis) for code generation when no RAML is used.
   * @param {object} context - Must contain apiDetails and optionally ihldAnalysis.
   * @returns {string}
   */
  _buildApiSpecTextFromContext(context) {
    const ad = context.apiDetails || {};
    const endpoints = Array.isArray(ad.endpoints) ? ad.endpoints : [];
    const integrationPoints = Array.isArray(ad.integrationPoints) ? ad.integrationPoints : [];
    const endpointStr = endpoints.map(e => typeof e === 'string' ? e : (e && (e.path || e.url)) ? (e.path || e.url) : String(e)).join(', ');
    const analysisExcerpt = context.ihldAnalysis
      ? (context.ihldAnalysis.length > MAX_IHLD_ANALYSIS_CONTEXT_CHARS
        ? context.ihldAnalysis.substring(0, MAX_IHLD_ANALYSIS_CONTEXT_CHARS) + '\n...[truncated]'
        : context.ihldAnalysis)
      : '';
    return `API Name: ${ad.name || 'API'}
API Type: ${ad.type || 'N/A'}
Description: ${ad.description || 'N/A'}
Endpoints: ${endpointStr || 'None specified'}
Integration Points: ${integrationPoints.join(', ') || 'None'}

Integration Design Document Analysis (excerpt):
${analysisExcerpt}`;
  }

  /**
   * Generate Mule code from API details and IHLD analysis only (no RAML). Used when the API does not require RAML.
   * @param {string} apiName - Name of the API.
   * @param {object} flowOptions - Additional flow options.
   * @param {object} context - Must contain apiDetails and ihldAnalysis.
   * @returns {Promise<object>} Mule project structure with files.
   */
  async generateMuleCodeFromApiDetails(apiName = "MuleSoftAPI", flowOptions = {}, context = {}) {
    if (!context.apiDetails) {
      throw new Error("API details are required. Please provide context.apiDetails from IHLD analysis.");
    }
    const sessionId = context.sessionId || null;
    context.sessionId = sessionId;
    const apiSpecText = this._buildApiSpecTextFromContext(context);
    context.fromApiDetails = true;

    let muleProject = { files: [] };
    try {
      const skeletonProject = await this._generateMuleProjectSkeleton(apiSpecText, apiName, flowOptions, context);
      muleProject.files.push(...skeletonProject.files);
      const apiFlowsProject = await this._generateMuleApiFlows(apiSpecText, apiName, flowOptions, skeletonProject, {}, context);
      muleProject.files.push(...apiFlowsProject.files);
      this.deduplicateFiles(muleProject);
      const finalPomXml = muleProject.files.find(f => f.path === 'pom.xml');
      if (!finalPomXml) {
        console.error('❌ CRITICAL: pom.xml is missing after generation.');
      } else {
        console.log('✅ pom.xml confirmed present in final project files');
      }
      return muleProject;
    } catch (error) {
      console.error('❌ Error generating Mule code from API details:', error);
      this.addDefaultFiles(muleProject, apiName);
      this.deduplicateFiles(muleProject);
      return muleProject;
    }
  }

  /* LEGACY METHOD - NO LONGER USED - Commented out as per user request
  async _generateMuleCodeInternal(ramlContent, apiName, options, context) {
    // Build context information
    let contextInfo = "";
    if (context.architecture) {
      contextInfo += `\nArchitecture Solution (for reference):\n${context.architecture.substring(0, 2000)}...\n`;
    }
    if (context.diagram) {
      contextInfo += `\nArchitecture Diagram (for reference on data flow):\n${context.diagram}\n`;
    }
    if (context.ihldAnalysis) {
      contextInfo += `\nIntegration Design Document Analysis context:\n${context.ihldAnalysis}\n`;
    }
    if (context.apiDetails) {
      const endpoints = Array.isArray(context.apiDetails.endpoints) ? context.apiDetails.endpoints : [];
      const integrationPoints = Array.isArray(context.apiDetails.integrationPoints) ? context.apiDetails.integrationPoints : [];
      contextInfo += `\nAPI Details from Integration Design Document:\n`;
      contextInfo += `- API Type: ${context.apiDetails.type || 'N/A'}\n`;
      contextInfo += `- Description: ${context.apiDetails.description || 'N/A'}\n`;
      if (endpoints.length > 0) {
        contextInfo += `- Endpoints: ${endpoints.map((e) => (typeof e === 'string' ? e : (e && (e.path || e.url)) ? (e.path || e.url) : String(e))).join(', ')}\n`;
      }
      if (integrationPoints.length > 0) {
        contextInfo += `- Integration Points: ${integrationPoints.map((i) => (typeof i === 'string' ? i : String(i))).join(', ')}\n`;
      }
    }

    // Generate ALL files in ONE LLM call for better consistency and quality
    const muleProject = {
      files: []
    };

    // Single comprehensive prompt to generate all files at once
    const allFilesPrompt = `*** CRITICAL FILE FORMAT INSTRUCTION ***
EACH GENERATED FILE MUST BE EXPLICITLY DELIMITED USING THIS EXACT FORMAT:
>>> filepath <<<
[file content - no additional markers]

Example:
>>> src/main/mule/global.xml <<<
<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:doc="http://www.mulesoft.org/schema/mule/documentation"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="...">
[rest of file content]

IMPORTANT: The >>> filepath <<< marker is ONLY a delimiter. Do NOT include it inside the actual file content.

*** TASK: Generate Complete Mule 4 Application from RAML ***

⚠️ CRITICAL REMINDER BEFORE YOU START: ⚠️
Generate Mule XML files (global.xml, api-flows.xml) FIRST, then generate pom.xml based on what connectors you actually used.
- Generate global.xml and api-flows.xml with all connector configurations and operations
- THEN analyze those XML files to identify which connectors are used
- Add Maven dependencies to pom.xml for EVERY connector found in the generated XML files
- See Section 11 in system instructions for the complete dependency list
- DO NOT generate connector usage without adding the dependency to pom.xml

Based on the RAML specification below, generate a COMPLETE, PRODUCTION-READY Mule 4.9+ application project with ALL mandatory files in a single response.

API Name: ${apiName}

RAML Specification:
${ramlContent}

${contextInfo ? `\nAdditional Context:\n${contextInfo}\n` : ''}

MANDATORY FILES TO GENERATE:
- pom.xml (project root) - ***ABSOLUTELY CRITICAL: MUST include Maven dependencies for EVERY connector used. See Section 11 in system instructions for detailed instructions.***
- mule-artifact.json (project root)
- .gitignore (project root)
- .muleignore (project root)
- src/main/mule/global.xml (all global element configurations - REQUIRED file name)
- src/main/mule/global-error-handler.xml (unified error handler)
- src/main/mule/api-flows.xml (main API flows with APIKit router and implementation flows)
- src/main/mule/${apiName}-common.xml (shared subflows if logic is repeated)
- src/main/resources/local-properties.yaml (local environment properties)
- src/main/resources/dev-properties.yaml (dev environment properties)
- src/main/resources/qa-properties.yaml (qa environment properties)
- src/main/resources/prod-properties.yaml (prod environment properties)
- src/main/resources/log4j2.xml (logging configuration)
- src/test/resources/log4j2-test.xml (test logging configuration)
- src/main/java/.gitkeep (empty directory marker)
- src/test/mule/.gitkeep (empty directory marker)
- DataWeave transformation files (*.dwl) in src/main/resources/dw/ (for scripts >5 lines)

CRITICAL REQUIREMENTS - MUST FOLLOW EXACTLY:

0. POM.XML DEPENDENCY GENERATION (MUST BE DONE AFTER GENERATING XML FILES):
   *** THIS IS THE MOST CRITICAL STEP - DO NOT SKIP OR FORGET ***
   
   STEP-BY-STEP PROCESS FOR GENERATING pom.xml:
   
   Step 1: Generate global.xml FIRST with connector configurations based on RAML analysis
   Step 2: Generate api-flows.xml with connector operations based on RAML requirements
   Step 3: Analyze the generated global.xml to identify which connectors are configured (look for <salesforce:config>, <db:config>, <file:config>, etc.)
   Step 4: Analyze the generated api-flows.xml to identify which connector operations are used (look for <salesforce:query>, <db:select>, <file:read>, etc.)
   Step 5: Generate pom.xml NOW with dependencies for ALL connectors found in global.xml and api-flows.xml
   
   CONNECTOR DETECTION RULES (from generated XML files):
   - If global.xml contains <salesforce:config> → ADD mule-salesforce-connector dependency to pom.xml
   - If global.xml contains <db:config> → ADD mule-db-connector dependency to pom.xml
   - If global.xml contains <file:config> → ADD mule-file-connector dependency to pom.xml
   - If api-flows.xml contains <salesforce:query> or <salesforce:create> → ADD mule-salesforce-connector dependency to pom.xml
   - If api-flows.xml contains <db:select> or <db:insert> → ADD mule-db-connector dependency to pom.xml
   - If api-flows.xml contains <file:read> or <file:write> → ADD mule-file-connector dependency to pom.xml
   - Check for ANY connector namespace (xmlns:salesforce=, xmlns:db=, xmlns:file=, etc.) in the generated XML files
   - Always include base dependencies: HTTP connector, APIKit module (if using APIKit router), Validation module, Configuration Properties module
   - CRITICAL: Only add dependencies for connectors that are ACTUALLY used in the generated XML files
   - CRITICAL: When adding dependencies, verify compatibility with Mule Runtime version in mule-artifact.json AND Java version in mule-artifact.json
   - CRITICAL: Check official MuleSoft documentation (https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes) for connector compatibility
   - CRITICAL: Check MuleSoft Maven repository (https://repository.mulesoft.org/releases/) for actual latest available versions - do NOT assume or make up version numbers
   
   REQUIRED DEPENDENCIES (ALWAYS include these):
   - mule-http-connector (REQUIRED for HTTP listener/requester - use latest version compatible with Mule 4.9+, check https://repository.mulesoft.org/releases/ for latest version)
   - mule-apikit-module (REQUIRED if using APIKit router - use latest version compatible with Mule 4.9+, check https://repository.mulesoft.org/releases/ for latest version)
   - mule-validation-module (use latest version compatible with Mule 4.9+, check https://repository.mulesoft.org/releases/ for latest version) - RECOMMENDED for validation
   - mule-configuration-properties-module (version matching Mule Runtime) - REQUIRED for YAML properties files
   
   ⚠️ CRITICAL: pom.xml CONTENT REQUIREMENTS ⚠️
   - pom.xml MUST contain ONLY valid XML content - NO summaries, NO explanatory text, NO markdown
   - DO NOT add any text after </project> closing tag
   - DO NOT add summary sections like "## SUMMARY", "✅ Generated files", "---", etc.
   - DO NOT add explanatory text, checkmarks, or bullet points in pom.xml
   - pom.xml should start with <?xml and end with </project> - nothing else
   - If you want to provide summaries, add them OUTSIDE the >>> pom.xml <<< delimiter, NOT inside the file content
   
   CONNECTOR DEPENDENCY TEMPLATES (use these exact versions):
   Salesforce: 
   <dependency>
     <groupId>com.mulesoft.connectors</groupId>
     <artifactId>mule-salesforce-connector</artifactId>
     <version>11.15.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   Database:
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-db-connector</artifactId>
     <version>1.18.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   File:
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-file-connector</artifactId>
     <version>1.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   FTP:
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-ftp-connector</artifactId>
     <version>1.3.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   SFTP:
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-sftp-connector</artifactId>
     <version>1.3.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   Email:
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-email-connector</artifactId>
     <version>1.2.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   JMS:
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-jms-connector</artifactId>
     <version>2.0.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   VM:
   <dependency>
     <groupId>org.mule.modules</groupId>
     <artifactId>mule-vm-module</artifactId>
     <version>2.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   ObjectStore:
   <dependency>
     <groupId>org.mule.modules</groupId>
     <artifactId>mule-objectstore-module</artifactId>
     <version>2.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   Quartz:
   <dependency>
     <groupId>org.mule.modules</groupId>
     <artifactId>mule-quartz-module</artifactId>
     <version>2.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   SAP:
   <dependency>
     <groupId>com.mulesoft.connectors</groupId>
     <artifactId>mule-sap-connector</artifactId>
     <version>4.0.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   SOAP:
   <dependency>
     <groupId>com.mulesoft.connectors</groupId>
     <artifactId>mule-soap-connector</artifactId>
     <version>1.2.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   CRITICAL RULE: 
   - If you generate ANY connector configuration in global.xml, you MUST add its dependency to pom.xml
   - Mule Runtime version in pom.xml MUST match the version in mule-artifact.json
   - Connector versions MUST be compatible with both Mule Runtime version AND Java version from mule-artifact.json
   - ALWAYS verify connector compatibility at https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes
   - ALWAYS check https://repository.mulesoft.org/releases/ for actual latest available versions - do NOT assume or make up version numbers
   - If you generate ANY connector operation in api-flows.xml, you MUST add its dependency to pom.xml
   - DO NOT generate connector usage without the dependency - the project will fail to build
   - The pom.xml <dependencies> section MUST contain ALL connectors used in the generated code
   
   ⚠️ CRITICAL: pom.xml CONTENT REQUIREMENTS ⚠️
   - pom.xml MUST contain ONLY valid XML content - NO summaries, NO explanatory text, NO markdown
   - DO NOT add any text after </project> closing tag
   - DO NOT add summary sections like "## SUMMARY", "✅ Generated files", "---", etc.
   - DO NOT add explanatory text, checkmarks, or bullet points in pom.xml
   - pom.xml should start with <?xml and end with </project> - nothing else
   - If you want to provide summaries, add them OUTSIDE the >>> pom.xml <<< delimiter, NOT inside the file content

1. GENERATE COMPLETE FUNCTIONAL LOGIC (HIGHEST PRIORITY):
   - For EVERY API endpoint defined in the RAML, generate a corresponding Mule flow with FULL, EXECUTABLE implementation logic.
   - EXCEPTION: Always include a health check endpoint (/health or /healthcheck) as a standard best practice, even if not in the RAML.
   - Implementation flows MUST NOT be empty, contain placeholder comments, or have TODO markers for core logic.
   - Each implementation flow MUST contain complete, functional logic including:
     * Entry logger: <logger level="INFO" message="Entered #[flow.name] - CorrelationId: #[correlationId()]" />
     * Request validation based on RAML types, schemas, and required fields
     * Detailed transformation logic using DataWeave (externalize to .dwl files if >5 lines) to map request payloads to internal/downstream formats
     * Appropriate connector calls (HTTP Requestor for APIs, Database connectors, Salesforce connectors, etc.) based on the API's purpose and RAML details
     * Response transformation using DataWeave to map downstream responses to RAML-defined response structures
     * Exit logger: <logger level="INFO" message="Exited #[flow.name] - CorrelationId: #[correlationId()]" />
     * Robust error handling (flow-specific or delegate to global-error-handler.xml)
   - If RAML defines example responses, USE THEM AS TEMPLATES for DataWeave transformations. Do NOT generate empty or generic payloads.
   - If RAML contains request examples, use them to guide request transformation logic.
   - Generate production-ready code that can be immediately deployed and tested.

2. TRANSFORM MESSAGE STRUCTURE:\n   - <ee:transform> MUST follow this exact structure:\n     <ee:transform doc:name="Transform Name">\n       <ee:message>\n         <ee:set-payload><![CDATA[%dw 2.0 ...]]></ee:set-payload>\n       </ee:message>\n       <ee:variables>\n         <ee:set-variable variableName="varName"><![CDATA[%dw 2.0 ...]]></ee:set-variable>\n       </ee:variables>\n     </ee:transform>\n   - NEVER place <ee:set-variable> directly inside <ee:message>\n   - ALL variables MUST be inside <ee:variables> tag\n   - NEVER use <set-property> - it does not exist in Mule 4\n
3. NAMING CONVENTIONS (MANDATORY):\n   - All flows: <apiName>-<method>-<operation>-flow\n     Example: customer-api-get-customer-flow, salesforce-api-create-contact-flow\n   - Flow names MUST NOT contain special characters: /, [, ], {, }, #\n   - When URI parameters are present (e.g., "put:\\customers\\{customerId}\\kyc"), replace curly braces with parentheses:\n     Correct: put-customers-(customerId)-kyc-flow\n     Incorrect: put-customers-{customerId}-kyc-flow\n   - Forward slashes (/) are NOT acceptable and must be replaced with hyphens (-) in flow names\n   - Backslashes (\\) are acceptable in flow names and should NOT be replaced\n   - Replace any other special characters (except \\) with hyphens or remove them\n   - All subflows: <apiName>-shared-<purpose>-subflow\n     Example: customer-api-shared-validate-request-subflow\n   - All config files: <apiName>-config.xml\n     Example: customer-api-config.xml\n   - Global config file: global.xml (must be generated)\n   - Property placeholders must always be wrapped: \\\${http.port:8081} or \\\${secure::db.password}\n
 4. GLOBAL.XML RULES (MANDATORY):
    - File MUST be named: global.xml (all global element configurations go in this file)
    - Location: src/main/mule/global.xml
    - MUST contain all global element configurations (connector configurations, HTTP listener, database, external systems, HTTP requester, configuration properties, global properties)
    - MUST include environment variable as global property: <global-property name="env" value="local" doc:name="Environment"/>
    - MUST include configuration properties element: <configuration-properties file="\${env}-properties.yaml" doc:name="Configuration properties"/>
    - MUST NOT contain any <flow> or <subflow> elements
    - MUST NOT contain error handlers (those go in global-error-handler.xml)
    - Properties like host and port MUST NOT be hardcoded in XML files - MUST be referenced from YAML properties files
    - All connector connection details must use property placeholders (e.g., \${secure::db.password})
    - NEVER hardcode credentials in XML files\n
 5. ENVIRONMENT PROPERTY FILES (CRITICAL):\n   - Configuration properties MUST be stored in YAML files with naming convention {env}-properties.yaml (e.g., local-properties.yaml, dev-properties.yaml, qa-properties.yaml, prod-properties.yaml)\n   - All values in YAML properties files MUST be strings, including numeric values. For example, use port: "8081" instead of port: 8081\n   - YAML FILE STRUCTURE RULES (CRITICAL):\n     * Each key in a YAML file MUST appear only ONCE at the same level - duplicate keys are invalid YAML and will cause parsing errors\n     * DO NOT create duplicate keys at any level (top-level or nested). If a key already exists, merge properties under that single key\n     * Example of INVALID YAML (duplicate top-level key):\n       http:\n         listener:\n           host: "0.0.0.0"\n           port: "8081"\n       http:  ← DUPLICATE KEY - INVALID\n         connection:\n           timeout: "30000"\n     * Example of VALID YAML (merged under single key):\n       http:\n         listener:\n           host: "0.0.0.0"\n           port: "8081"\n         connection:\n           timeout: "30000"\n         response:\n           timeout: "60000"\n   - dev-properties.yaml: ONLY development environment properties\n     * Dev URLs, dev ports (as strings), DEBUG logging\n     * Dev connector connection details (database connection strings, Salesforce URLs, external API endpoints, etc.)\n     * Dev credentials placeholders using \\\${secure::keyName} format\n     * Properties requiring actual connection details MUST use TODO placeholders:\n       Example: salesforce.username: "your_salesforce_username"\n       Example: database.url: "your_database_url"\n       Example: api.clientId: "your_client_id"\n       Example: api.clientSecret: "your_client_secret"\n   - qa-properties.yaml: ONLY QA environment properties\n     * QA URLs, qa ports (as strings), INFO logging\n     * QA connector connection details (database connection strings, Salesforce URLs, external API endpoints, etc.)\n     * QA credentials placeholders using \\\${secure::keyName} format\n     * Properties requiring actual connection details MUST use TODO placeholders (same format as dev)\n   - prod-properties.yaml: ONLY production environment properties\n     * Prod URLs, prod ports (as strings), WARN logging\n     * Prod connector connection details (database connection strings, Salesforce URLs, external API endpoints, etc.)\n     * Prod credentials placeholders using \\\${secure::keyName} format\n     * Properties requiring actual connection details MUST use TODO placeholders (same format as dev)\n   - Each file must contain ONLY properties for that specific environment\n   - Environment-specific YAML property files MUST contain connection details for ALL connectors defined in global.xml\n   - If global.xml has Salesforce connector → each env YAML file must have:\n     salesforce.url: "your_salesforce_url", salesforce.username: "your_salesforce_username", salesforce.password: "your_salesforce_password", salesforce.securityToken: "your_salesforce_security_token"\n   - If global.xml has Database connector → each env YAML file must have:\n     database.url: "your_database_url", database.username: "your_database_username", database.password: "your_database_password"\n   - If global.xml has HTTP requester config → each env YAML file must have the base URLs for that environment\n   - Connection details are the PRIMARY reason for environment-specific files\n   - TODO placeholders make it clear which values need to be replaced with actual connection details\n   - Do NOT include file markers (>>> filename <<<) in the file content\n   - NEVER hardcode credentials in XML files\n   - NEVER commit credentials\n
6. EXPERIENCE API RULES:\n   - Must NOT call databases or external systems directly\n   - Must only perform: request validation, transformation, routing, response preparation\n   - Every Experience flow must include in order:\n     1. Entry log: "Entered #[flow.name] - CorrelationId: #[correlationId()]"\n     2. Request validation\n     3. Request transformation\n     4. Call to Process API via HTTP requester\n     5. Response transformation\n     6. Exit log: "Exited #[flow.name] - CorrelationId: #[correlationId()]"\n   - Must NOT contain complex business logic\n   - Errors must be handled by global-error-handler.xml\n   - HTTP listener must include OAuth security policy placeholders\n
7. PROCESS API RULES:\n   - Must contain business logic and orchestration\n   - Must call System APIs (never call external systems directly)\n   - Must use canonical request and response models\n   - All transformations must be in DataWeave scripts in src/main/resources/dw/\n   - If RAML indicates async operations, use VM queues for async publish/consume\n   - Must NOT access external databases or systems directly\n
8. SYSTEM API RULES:\n   - Must only communicate with backend systems\n   - Must NOT contain business logic\n   - Each operation must include:\n     1. Entry log with correlation ID\n     2. Input validation\n     3. Transformation (to system format)\n     4. Connector invocation\n     5. Response transformation (to canonical format)\n     6. Exit log with correlation ID\n   - Must generate correct connector config based on backend type\n   - Must implement standardized error handling\n   - Must generate CRUD flows with correct payload transformations\n   - Must NOT expose public HTTP listeners (internal only)\n
9. SALESFORCE SYSTEM API RULES (if Salesforce detected in RAML):\n   - If RAML mentions Salesforce, SF, CRM, Account, Contact, Lead, Opportunity → create Salesforce flows\n   - Salesforce config must include:\n     username: \\\${secure::salesforce.username}\n     password: \\\${secure::salesforce.password}\n     securityToken: \\\${secure::salesforce.securityToken}\n     authType: BASIC\n   - GET operations: input validation → SOQL transformation (dynamic) → Query → response transformation\n   - CREATE operations: input validation → transform to SF object → create → response transformation\n   - UPDATE operations: input validation → transform to SF object → update → response transformation\n   - DELETE operations: input validation → delete → response transformation\n   - SOQL queries must be dynamically generated (NOT hardcoded)\n   - Map Salesforce errors to valid Salesforce connector error types (check connector documentation for the version being used - do NOT use hardcoded error types like "SF:BAD_REQUEST")\n
10. COMMON LOGIC STRUCTURE:\n   - Every flow must begin with entry log: "Entered #[flow.name] - CorrelationId: #[correlationId()]"\n   - Every flow must propagate correlation ID to downstream systems\n   - DataWeave scripts >5 lines must be externalized to *.dwl files in src/main/resources/dw/\n   - Reusable transforms in src/main/resources/dw/\n   - Repeated logic → shared subflow in <apiName>-common.xml\n   - All responses must be transformed to canonical models\n   - Every flow must end with exit log: "Exited #[flow.name] - CorrelationId: #[correlationId()]"\n
11. SECURITY RULES:\n   - Experience API HTTP listener must include OAuth security policy placeholders\n   - No hardcoded credentials → use \\\${secure::keyName} in properties\n   - All sensitive data must use secure:: prefix\n
12. LOGGING RULES:\n   - Every flow must log entry and exit with correlation ID\n   - Must NOT expose sensitive information in logs\n   - Logger messages must always include correlation ID\n   - Use structured logging format\n
13. ERROR HANDLING RULES:\n   - Generate global-error-handler.xml (unified error handler)\n   - All API tiers must use same error structure and canonical error model\n   - Backend errors must be transformed to canonical error payloads (never return raw)\n   - Map HTTP codes to valid MuleSoft error types: Use actual error types from connectors/modules being used (check documentation). For HTTP errors, use standard Mule HTTP error types (HTTP:*) or connector-specific types. Do NOT use hardcoded examples like "VALIDATION:INVALID_INPUT" - use real, valid error types based on connector versions.\n   - HTTP ERROR TYPES RULES (CRITICAL):\n     * DO NOT use HTTP error types that don't exist in MuleSoft (e.g., HTTP:CONFLICT does NOT exist)\n     * Common valid HTTP error types: HTTP:BAD_REQUEST, HTTP:UNAUTHORIZED, HTTP:FORBIDDEN, HTTP:NOT_FOUND, HTTP:METHOD_NOT_ALLOWED, HTTP:NOT_ACCEPTABLE, HTTP:REQUEST_TIMEOUT, HTTP:INTERNAL_SERVER_ERROR, HTTP:NOT_IMPLEMENTED, HTTP:BAD_GATEWAY, HTTP:SERVICE_UNAVAILABLE, HTTP:GATEWAY_TIMEOUT\n     * ALWAYS verify HTTP error types exist in MuleSoft documentation: https://docs.mulesoft.com/mule-runtime/4.9/mule-error-concept#http-error-types\n     * If HTTP status code 409 (Conflict) needs mapping, HTTP:CONFLICT does NOT exist - use HTTP:BAD_REQUEST or create CUSTOM:CONFLICT instead\n     * DO NOT create or reference HTTP error types that don't exist in MuleSoft HTTP connector documentation\n   - Error responses must include correlation ID\n   - CRITICAL: Error types must match the actual error types thrown by the connectors/modules for the specific versions being used. Verify in MuleSoft documentation.\n   - RAISE ERROR COMPONENT RULES (CRITICAL):\n     * Do NOT use Raise Error for standard MuleSoft error types (HTTP:*, VALIDATION:*, APIKIT:*, DB:*, FILE:*, connector errors, etc.)\n     * Raise Error should ONLY be used when existing MuleSoft error types do NOT handle a particular error scenario\n     * When Raise Error is used, it MUST define a custom error type that does NOT conflict with existing MuleSoft error types\n     * Custom error types should use prefixes like CUSTOM:*, BUSINESS:*, or <API_NAME>:* (e.g., CUSTOM:INVALID_BUSINESS_RULE, SALESFORCE_API:DUPLICATE_RECORD)\n     * Before using Raise Error, verify that no standard MuleSoft error type exists for the error scenario by checking MuleSoft documentation\n     * If a standard error type exists, use error handlers (On Error Propagate/Continue) to catch and handle it, NOT Raise Error\n     * Example: If HTTP:NOT_FOUND exists, use On Error Propagate to catch it, do NOT use Raise Error with HTTP:NOT_FOUND\n
14. MANDATORY FILES (ALL must be generated):\n   - pom.xml (project root)\n   - mule-artifact.json (project root)\n   - .gitignore (project root)\n   - .muleignore (project root)\n   - src/main/mule/global.xml (all global element configurations - REQUIRED file name)\n   - src/main/mule/global-error-handler.xml (common error handlers - unified error handler)\n   - src/main/mule/api-flows.xml (main API flows with APIKit router and implementation flows from RAML)\n   - src/main/mule/<apiName>-common.xml (shared subflows if logic is repeated)\n   - src/main/resources/local-properties.yaml (local environment properties)\n   - src/main/resources/dev-properties.yaml (dev environment ONLY)\n   - src/main/resources/qa-properties.yaml (qa environment ONLY)\n   - src/main/resources/prod-properties.yaml (prod environment ONLY)\n   - src/main/resources/log4j2.xml (MUST be in src/main/resources)\n   - src/test/resources/log4j2-test.xml (MUST be in src/test/resources)\n   - src/main/java/.gitkeep (empty directory marker)\n   - src/test/mule/.gitkeep (empty directory marker)\n   - src/main/resources/dw/ (folder for DataWeave scripts >5 lines)\n
15. APIKIT AND IMPLEMENTATION FLOWS:\n   - APIKit router flows must be generated from RAML resources and methods\n   - Implementation flows must NOT be empty - must contain meaningful logic:\n     * Entry log with correlation ID\n     * Request validation\n     * Transformation logic\n     * Connector calls (System APIs) or HTTP requester calls (Experience/Process APIs)\n     * Response transformation\n     * Exit log with correlation ID\n     * Error handling\n   - Every RAML endpoint must have a corresponding implementation flow\n   - EXCEPTION: Always include a health check endpoint (/health or /healthcheck) as a standard best practice, even if not in the RAML\n
16. DATAWEAVE EXTERNALIZATION:\n   - DataWeave scripts longer than 5 lines must be in *.dwl files in src/main/resources/dw/\n   - Reference external DWL files using: <ee:transform doc:name="Transform" file="dw/transform-name.dwl" />\n   - Reusable transforms must be in src/main/resources/dw/ folder\n
17. FLOW STRUCTURE REQUIREMENTS:\n   - Every flow must start with entry logger: <logger level="INFO" message="Entered #[flow.name] - CorrelationId: #[correlationId()]" />\n   - Every flow must end with exit logger: <logger level="INFO" message="Exited #[flow.name] - CorrelationId: #[correlationId()]" />\n   - Correlation ID must be propagated to downstream systems via headers\n   - All flows must have error handling (flow-specific or global)\n
 18. MULE RUNTIME VERSION (MANDATORY):\n   - Minimum Mule runtime version: 4.9.0 (4.9.x and above)\n   - All code MUST be compatible with Mule 4.9+\n   - Use latest stable connector versions compatible with Mule 4.9+\n   - pom.xml must specify app.runtime 4.9.0 or higher\n   - mule-artifact.json must specify minMuleVersion 4.9.0\n   - CRITICAL: Mule Runtime version in pom.xml MUST match the version in mule-artifact.json\n   - Do NOT use Mule 4.8.x or lower versions\n
 19. POM.XML DEPENDENCY MANAGEMENT (ABSOLUTELY CRITICAL - HIGHEST PRIORITY - MUST FOLLOW EXACTLY):

   STEP 1: GENERATE XML FILES FIRST (global.xml, api-flows.xml):
   - Generate global.xml with connector configurations based on RAML analysis
   - Generate api-flows.xml with connector operations based on RAML requirements
   - This allows you to see exactly which connectors you actually used

   STEP 2: ANALYZE GENERATED XML FILES AND GENERATE pom.xml:
   - Analyze the generated global.xml to identify which connectors are configured (look for <salesforce:config>, <db:config>, <file:config>, etc.)
   - Analyze the generated api-flows.xml to identify which connector operations are used (look for <salesforce:query>, <db:select>, <file:read>, etc.)
   - Generate pom.xml with dependencies for ALL connectors found in the generated XML files
   - CRITICAL: Mule Runtime version in pom.xml MUST match the version in mule-artifact.json
   - CRITICAL: Connector versions MUST be compatible with both Mule Runtime version AND Java version from mule-artifact.json
   - CRITICAL: ALWAYS verify connector compatibility at https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes
   - CRITICAL: ALWAYS check https://repository.mulesoft.org/releases/ for actual latest available versions - do NOT assume or make up version numbers
   
   WHEN GENERATING pom.xml, FOLLOW THIS EXACT PROCESS:
   1. Start with base dependencies (ALWAYS include these):
      <dependency>
        <groupId>org.mule.connectors</groupId>
        <artifactId>mule-http-connector</artifactId>
        <version>CHECK_LATEST_VERSION</version>
        <classifier>mule-plugin</classifier>
      </dependency>
      CRITICAL: Replace CHECK_LATEST_VERSION with the actual latest version number compatible with Mule 4.9+ from https://repository.mulesoft.org/releases/ - do NOT use "CHECK_LATEST_VERSION" or "LATEST" as the version value
      <dependency>
        <groupId>org.mule.modules</groupId>
        <artifactId>mule-apikit-module</artifactId>
        <version>CHECK_LATEST_VERSION</version>
        <classifier>mule-plugin</classifier>
      </dependency>
      <dependency>
        <groupId>org.mule.modules</groupId>
        <artifactId>mule-validation-module</artifactId>
        <version>LATEST_COMPATIBLE_VERSION</version> <!-- Use latest version compatible with Mule 4.9+, check https://repository.mulesoft.org/releases/ for latest version -->
        <classifier>mule-plugin</classifier>
      </dependency>

    2. For EACH connector you will use in global.xml or api-flows.xml, ADD the corresponding dependency:
   
   CONNECTOR DEPENDENCY REFERENCE (use these EXACT versions for Mule 4.9+):
   
   Salesforce (if RAML mentions Salesforce, CRM, Account, Contact, Lead, Opportunity, OR if you generate <salesforce: operations):
   <dependency>
     <groupId>com.mulesoft.connectors</groupId>
     <artifactId>mule-salesforce-connector</artifactId>
     <version>11.15.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   Database (if RAML mentions database, SQL, OR if you generate <db: operations):
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-db-connector</artifactId>
     <version>1.18.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   File (if you generate <file: operations):
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-file-connector</artifactId>
     <version>1.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   FTP (if you generate <ftp: operations):
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-ftp-connector</artifactId>
     <version>1.3.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   SFTP (if you generate <sftp: operations):
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-sftp-connector</artifactId>
     <version>1.3.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   Email (if you generate <email: operations):
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-email-connector</artifactId>
     <version>1.2.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   JMS (if you generate <jms: operations):
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-jms-connector</artifactId>
     <version>2.0.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   VM (if you generate <vm: operations):
   <dependency>
     <groupId>org.mule.modules</groupId>
     <artifactId>mule-vm-module</artifactId>
     <version>2.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   ObjectStore (if you generate <os: operations):
   <dependency>
     <groupId>org.mule.modules</groupId>
     <artifactId>mule-objectstore-module</artifactId>
     <version>2.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   Quartz (if you generate <quartz: operations):
   <dependency>
     <groupId>org.mule.modules</groupId>
     <artifactId>mule-quartz-module</artifactId>
     <version>2.4.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   SAP (if RAML mentions SAP OR if you generate <sap: operations):
   <dependency>
     <groupId>com.mulesoft.connectors</groupId>
     <artifactId>mule-sap-connector</artifactId>
     <version>4.0.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   SOAP (if you generate <soap: operations):
   <dependency>
     <groupId>com.mulesoft.connectors</groupId>
     <artifactId>mule-soap-connector</artifactId>
     <version>1.2.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>
   
   Sockets (if you generate <sockets: operations):
   <dependency>
     <groupId>org.mule.connectors</groupId>
     <artifactId>mule-sockets-connector</artifactId>
     <version>1.2.0</version>
     <classifier>mule-plugin</classifier>
   </dependency>

   STEP 3: VERIFICATION CHECKLIST BEFORE FINALIZING pom.xml:
   ✓ If you generate global.xml with Salesforce connector config → pom.xml MUST have mule-salesforce-connector dependency
   ✓ If you generate global.xml with Database connector config → pom.xml MUST have mule-db-connector dependency
   ✓ If you generate api-flows.xml with <salesforce:query or <salesforce:create → pom.xml MUST have mule-salesforce-connector dependency
   ✓ If you generate api-flows.xml with <db:select or <db:insert → pom.xml MUST have mule-db-connector dependency
   ✓ If you generate ANY connector operation in ANY XML file → pom.xml MUST have the corresponding dependency
   ✓ Base dependencies (HTTP, APIKit, Validation, Configuration Properties) are ALWAYS included
   ✓ Mule Runtime version in pom.xml matches mule-artifact.json
   ✓ Connector versions are compatible with Mule Runtime version AND Java version from mule-artifact.json
   
   CRITICAL RULES:
   - DO NOT generate connector usage without adding the dependency to pom.xml
   - DO NOT skip this step - missing dependencies will cause Maven build failures
   - The pom.xml <dependencies> section MUST contain dependencies for ALL connectors used in the generated code
   - Generate XML files FIRST, then analyze them to determine pom.xml dependencies
   - Only add dependencies for connectors that are ACTUALLY used in the generated XML files
   - Mule Runtime version in pom.xml MUST match the version in mule-artifact.json
   - Connector versions MUST be compatible with both Mule Runtime version AND Java version from mule-artifact.json
   - ALWAYS verify connector compatibility at https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes
   - ALWAYS check https://repository.mulesoft.org/releases/ for actual latest available versions - do NOT assume or make up version numbers
   - Example: If you generate <salesforce:config> in global.xml, you MUST add mule-salesforce-connector dependency to pom.xml
   - Example: If you generate <db:select> in api-flows.xml, you MUST add mule-db-connector dependency to pom.xml
   
   ⚠️ CRITICAL: pom.xml CONTENT REQUIREMENTS ⚠️
   - pom.xml MUST contain ONLY valid XML content - NO summaries, NO explanatory text, NO markdown
   - DO NOT add any text after </project> closing tag
   - DO NOT add summary sections like "## SUMMARY", "✅ Generated files", "---", etc.
   - DO NOT add explanatory text, checkmarks, or bullet points in pom.xml
   - pom.xml should start with <?xml and end with </project> - nothing else
   - If you want to provide summaries, add them OUTSIDE the >>> pom.xml <<< delimiter, NOT inside the file content
   
   REMEMBER: Generate XML files first, then pom.xml based on what connectors you actually used. This ensures accuracy.\n
FINAL CHECKLIST:
✓ Generate ALL mandatory files listed above
✓ Use >>> filepath <<< delimiter format (marker is delimiter only, not in file content)
✓ Every implementation flow contains complete functional logic (not placeholders)
✓ All flows include entry/exit logging with correlation ID
✓ All DataWeave scripts >5 lines are externalized to .dwl files
✓ Environment property files contain connection details for ALL connectors
✓ Global.xml contains all global element configurations (no flows)
✓ Global-error-handler.xml contains unified error handling
✓ pom.xml specifies Mule 4.9+ runtime
✓ pom.xml includes dependencies for ALL connectors used in global.xml and api-flows.xml (VERIFY THIS!)
✓ Every connector in global.xml has a corresponding dependency in pom.xml
✓ Mule Runtime version in pom.xml matches mule-artifact.json
✓ Configuration-properties module is included in pom.xml with correct version
✓ global.xml includes environment variable and configuration properties element
✓ YAML properties files use {env}-properties.yaml naming convention
✓ All YAML values are strings (including numeric values)
✓ .gitignore includes IDE files (.vscode/) and test resources (src/test/resources/embedded*)
✓ No hardcoded credentials in XML files
✓ Every connector operation in api-flows.xml has a corresponding dependency in pom.xml
✓ mule-artifact.json specifies minMuleVersion 4.9.0
✓ All code follows Mule 4.9+ standards and best practices
✓ Project is immediately buildable with: mvn clean package (no missing dependencies)

Generate the complete project now using the >>> filepath <<< format for each file.`;

    try {
      console.log('🔄 Generating all Mule project files in one LLM call...');
      const allFilesContent = await this.askWithSystemPrompt(
        this.systemPrompt,
        allFilesPrompt,
        {
          temperature: 0.3,
          maxTokens: 25000,  // Increased to prevent truncation for complete projects
          taskType: 'code-generation-all-files',
          recommendedMinTokens: 20000
        }
      );

      // Parse all files from the response
      const files = this.parseAllFilesFromResponse(allFilesContent);

      // Add all parsed files to project
      files.forEach(file => {
        muleProject.files.push(file);
      });

      // Post-process: Ensure pom.xml has all connector dependencies
      // COMMENTED OUT: Testing LLM-only pom.xml generation quality
      // this.ensureConnectorDependencies(muleProject);

      // Validate generated XML files (temporarily disabled)
      // for (const file of muleProject.files) {
      //   if (file.path.endsWith('.xml')) {
      //     console.log(`🔍 Validating XML file: ${file.path}`);
      //     const { isValid, errors } = await validateMuleXml(file.content);
      //     if (!isValid) {
      //       console.error(`❌ XML validation failed for ${file.path}:`, errors);
      //       throw new Error(`XML validation failed for ${file.path}: ${errors.join('; ')}`); // Stop if XML is invalid
      //     } else {
      //       console.log(`✅ XML validation successful for ${file.path}`);
      //     }
      //   }
      // }

      // Maven build check is disabled per user request

      console.log(`✅ Generated ${files.length} files in one call`);

    } catch (error) {
      console.error('❌ Error generating Mule code in one call, falling back to defaults:', error);
      // Fallback to default files if generation fails
      this.addDefaultFiles(muleProject, apiName);
    }

    return muleProject;
  }
  */

  /**
   * Validates a file's content and size
   * @param {Object} file - File object with path and content
   * @throws {Error} If file is invalid
   */
  _validateFile(file) {
    if (Buffer.byteLength(file.content, 'utf8') > MAX_FILE_SIZE) {
      throw new Error(`File ${file.path} exceeds maximum size of ${MAX_FILE_SIZE} bytes`);
    }
    // Add any additional validations here
  }

  /**
   * Creates a safe file path and ensures it's within the target directory
   * @param {string} baseDir - Base directory
   * @param {string} filePath - Relative file path
   * @returns {string} Absolute safe file path
   */
  _getSafePath(baseDir, filePath) {
    const normalizedPath = path.normalize(filePath).replace(/^(\.\.\/|\/|\\)+/, '');
    const resolvedPath = path.resolve(baseDir, normalizedPath);
    
    if (!resolvedPath.startsWith(path.resolve(baseDir))) {
      throw new Error(`Invalid file path: ${filePath} - potential directory traversal attempt`);
    }
    
    return resolvedPath;
  }

  /**
   * Writes multiple files to disk with concurrency control
   * @param {Array} files - Array of {path, content} objects
   * @param {string} targetDir - Target directory
   * @returns {Promise<Array>} Results of write operations
   */
  async _writeFilesConcurrently(files, targetDir) {
    const results = [];
    const queue = [...files];
    
    const processFile = async () => {
      while (queue.length > 0) {
        const file = queue.shift();
        if (!file) continue;
        
        try {
          this._validateFile(file);
          const filePath = this._getSafePath(targetDir, file.path);
          const dirPath = path.dirname(filePath);
          
          await fs.mkdirp(dirPath);
          await fs.writeFile(filePath, file.content, 'utf8');
          
          results.push({
            success: true,
            path: file.path,
            size: Buffer.byteLength(file.content, 'utf8')
          });
        } catch (error) {
          console.error(`❌ Failed to write file ${file.path}:`, error);
          results.push({
            success: false,
            path: file.path,
            error: error.message
          });
          throw error;
        }
      }
    };
    
    // Process files with controlled concurrency
    await Promise.all(
      Array(Math.min(MAX_CONCURRENT_FILES, files.length))
        .fill()
        .map(processFile)
    );
    
    return results;
  }

  /**
   * Creates a temporary directory with a unique name
   * @param {string} prefix - Directory name prefix
   * @returns {Promise<string>} Path to the created directory
   */
  async _createTempDir(prefix = 'mule_project_') {
    const tempDir = path.join(
      os.tmpdir(),
      `${prefix}${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    );
    
    await fs.mkdir(tempDir, { recursive: true });
    return tempDir;
  }

  /**
   * Safely removes a directory and its contents
   * @param {string} dirPath - Directory to remove
   */
  async _cleanupTempDir(dirPath) {
    try {
      if (await fs.pathExists(dirPath)) {
        await fs.remove(dirPath);
        console.log(`✅ Cleaned up temporary directory: ${dirPath}`);
      }
    } catch (error) {
      console.error(`❌ Failed to clean up directory ${dirPath}:`, error);
      // Don't throw to ensure cleanup errors don't mask original errors
    }
  }

  /**
   * Runs a Maven build check on the generated Mule project
   * @param {object} muleProject - The generated Mule project structure with files
   * @param {string} apiName - The name of the API, used for temporary directory naming
   * @returns {Promise<{isSuccess: boolean, output: string}>} Build result
   */
  /**
   * Extracts JSON from LLM response, handling markdown code blocks and explanatory text.
   * @param {string} rawContent - The raw LLM response content.
   * @returns {string} Extracted JSON string.
   */
  static extractJsonFromLlmResponse(rawContent) {
    let jsonContent = rawContent.trim();
    
    // Remove markdown code blocks if present
    if (jsonContent.includes("```json")) {
      const jsonMatch = jsonContent.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonContent = jsonMatch[1].trim();
      }
    } else if (jsonContent.includes("```")) {
      // Handle generic code blocks
      const codeMatch = jsonContent.match(/```[a-z]*\s*([\s\S]*?)\s*```/);
      if (codeMatch) {
        jsonContent = codeMatch[1].trim();
      }
    }
    
    // Extract JSON object/array from text if there's explanatory text
    // Look for the first occurrence of '{' or '[' that starts a JSON structure
    const jsonStart = jsonContent.search(/[{\[]/);
    if (jsonStart > 0) {
      jsonContent = jsonContent.substring(jsonStart);
    }
    
    // Find the matching closing bracket/brace
    let braceCount = 0;
    let bracketCount = 0;
    let jsonEnd = jsonContent.length;
    let inString = false;
    let escapeNext = false;
    
    for (let i = 0; i < jsonContent.length; i++) {
      const char = jsonContent[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (char === '[') bracketCount++;
        if (char === ']') bracketCount--;
        
        if (braceCount === 0 && bracketCount === 0 && (jsonContent[0] === '{' || jsonContent[0] === '[')) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    
    jsonContent = jsonContent.substring(0, jsonEnd).trim();
    
    // Final attempt: try to find JSON using regex
    if (!jsonContent.startsWith('{') && !jsonContent.startsWith('[')) {
      const jsonMatch = jsonContent.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        jsonContent = jsonMatch[1].trim();
      }
    }
    
    return jsonContent;
  }

  /**
   * Generates dynamic questions for Mule flow code generation based on RAML content.
   * @param {string} ramlContent - The RAML specification content.
   * @param {object} options - Additional options for LLM.
   * @returns {Promise<Array<object>>} An array of question objects.
   */
  async _generateDynamicMuleFlowQuestions(ramlContent, options = {}) {
    const prompt = `Based on the following RAML specification, generate a list of clarifying questions to help me understand the business logic, integration patterns, error handling, and any specific requirements for generating a Mule 4 application.

RAML Specification:
\`\`\`raml
${ramlContent}
\`\`\`

CRITICAL: You MUST respond with ONLY valid JSON. Do NOT include any explanatory text, markdown code blocks, or comments before or after the JSON.

Provide the questions in a JSON object format with a "questions" key containing an array, where each object has 'number' (string), 'type' (string, e.g., 'text' or 'textarea'), 'question' (string), and 'placeholder' (string) fields. Ensure the questions are concise and directly relevant to Mule flow design decisions.

Example format:
{
  "questions": [
    { "number": "1", "type": "text", "question": "What is the main business purpose of this API?", "placeholder": "e.g., To manage customer profiles." }
  ]
}`;

    const systemPrompt = `You are an expert MuleSoft architect. Your task is to generate precise clarifying questions to build the best possible Mule 4 application based on a RAML specification.

CRITICAL: You MUST respond with ONLY valid JSON. Do NOT include any explanatory text, markdown formatting, or comments. Return ONLY the JSON object starting with { and ending with }.`;

    try {
      console.log('💡 Generating dynamic Mule flow questions...');
      const llmResponse = await this.askWithSystemPrompt(
        systemPrompt,
        prompt,
        {
          temperature: 0.2,
          maxTokens: 1000,
          taskType: 'question-generation',
          recommendedMinTokens: 1000,
          response_format: { type: "json_object" }
        }
      );
      
      console.log('LLM Response for questions:', llmResponse);
      
      // Use robust JSON extraction to handle explanatory text
      const jsonString = MuleCodeGenerationAgent.extractJsonFromLlmResponse(llmResponse);
      
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonString);
      } catch (parseError) {
        console.error('❌ Failed to parse JSON from LLM response');
        console.error('Extracted JSON content:', jsonString.substring(0, 500));
        console.error('Parse error:', parseError.message);
        throw new Error(`Failed to parse LLM response as JSON. The LLM may have returned explanatory text. Extracted content: ${jsonString.substring(0, 200)}...`);
      }

      if (parsedResponse.questions && Array.isArray(parsedResponse.questions)) {
        return parsedResponse.questions;
      } else if (Array.isArray(parsedResponse)) {
        // Handle case where LLM returns array directly instead of object with questions key
        return parsedResponse;
      } else {
        throw new Error("Invalid format for dynamic questions from LLM. Expected object with 'questions' array or direct array.");
      }
    } catch (error) {
      console.error('❌ Error generating dynamic Mule flow questions:', error);
      // Fallback to static questions if LLM generation fails
      return [
        { number: '1', type: 'text', question: 'Mule Flow Name', placeholder: 'e.g., customerProfileFlow' },
        { number: '2', type: 'textarea', question: 'Mule Flow Description', placeholder: 'Describe the purpose and high-level logic of this Mule flow.' },
        { number: '3', type: 'text', question: 'Integration Pattern', placeholder: 'e.g., Request-Reply, Publish-Subscribe, Batch' },
        { number: '4', type: 'textarea', question: 'Error Handling Strategy', placeholder: 'Describe how errors should be handled (e.g., DLQ, retry, custom error handling).'},
      ];
    }
  }

  /**
   * DEPRECATED: Single-call approach caused truncation issues. Use two-stage approach instead.
   * Generates ALL Mule project files in a single LLM call (skeleton + API flows).
   * @param {string} ramlContent - The RAML specification content.
   * @param {string} apiName - Name of the API.
   * @param {object} flowOptions - User-provided answers to dynamic questions.
   * @param {object} context - Additional context.
   * @returns {Promise<object>} Mule project structure with all files.
   * @deprecated Use _generateMuleProjectSkeleton + _generateMuleApiFlows instead (two-stage approach)
   */
  async _generateAllMuleFiles(ramlContent, apiName, flowOptions = {}, context = {}) {
    // Build context information (IHLD Analysis and API Details)
    let contextInfo = "";
    if (context.architecture) {
      contextInfo += `\nArchitecture Solution (for reference):\n${context.architecture.substring(0, 2000)}...\n`;
    }
    if (context.diagram) {
      contextInfo += `\nArchitecture Diagram (for reference on data flow):\n${context.diagram}\n`;
    }
    if (context.ihldAnalysis) {
      const analysisText = context.ihldAnalysis.length > MAX_IHLD_ANALYSIS_CONTEXT_CHARS
        ? context.ihldAnalysis.substring(0, MAX_IHLD_ANALYSIS_CONTEXT_CHARS) + "\n...[truncated for context length]"
        : context.ihldAnalysis;
      contextInfo += `\nIntegration Design Document Analysis context:\n${analysisText}\n`;
    }
    if (context.apiDetails) {
      const endpoints = Array.isArray(context.apiDetails.endpoints) ? context.apiDetails.endpoints : [];
      const integrationPoints = Array.isArray(context.apiDetails.integrationPoints) ? context.apiDetails.integrationPoints : [];
      contextInfo += `\nAPI Details from Integration Design Document:\n`;
      contextInfo += `- API Type: ${context.apiDetails.type || 'N/A'}\n`;
      contextInfo += `- Description: ${context.apiDetails.description || 'N/A'}\n`;
      if (endpoints.length > 0) {
        contextInfo += `- Endpoints: ${endpoints.map((e) => (typeof e === 'string' ? e : (e && (e.path || e.url)) ? (e.path || e.url) : String(e))).join(', ')}\n`;
      }
      if (integrationPoints.length > 0) {
        contextInfo += `- Integration Points: ${integrationPoints.map((i) => (typeof i === 'string' ? i : String(i))).join(', ')}\n`;
      }
    }

    let flowDetails = '';
    for (const key in flowOptions) {
      if (flowOptions.hasOwnProperty(key)) {
        flowDetails += `\n- ${key}: ${flowOptions[key]}`;
      }
    }

    const allFilesPrompt = `*** FILE FORMAT: >>> filepath <<< [content] ***

*** TASK: Generate Complete Mule 4.9+ Project (ALL FILES) ***

Generate ALL files for a complete, production-ready Mule 4.9+ application in a single response.

API: ${apiName}

${context.fromApiDetails
  ? `API Specification (from IHLD - no RAML):\n\`\`\`\n${ramlContent}\n\`\`\`\n\n`
  : `RAML Specification:\n\`\`\`raml\n${ramlContent}\n\`\`\`\n\n`}${contextInfo ? `CONTEXT:\n${contextInfo}\n` : ''}${flowDetails ? `CLARIFICATIONS:\n${flowDetails}\n` : ''}

MANDATORY FILES TO GENERATE (ALL must be included):

1. PROJECT CONFIGURATION FILES:
- pom.xml (project root) - Maven POM with Mule 4.9+ runtime and ALL connector dependencies. Analyze RAML and generated XML files to identify connectors, then add dependencies. Mule Runtime version MUST match mule-artifact.json.
- mule-artifact.json (project root) - Mule artifact metadata with minMuleVersion 4.9.0 and Java version. CRITICAL: "name" field MUST NOT contain spaces - sanitize API name (replace spaces with hyphens, lowercase). Example: "Customer Profile API" → "customer-profile-api"
- .gitignore (project root) - Include IDE files (.vscode/) and test resources (src/test/resources/embedded*)
- .muleignore (project root)

2. GLOBAL CONFIGURATION FILES:
- src/main/mule/global.xml - All global element configurations (connector configs, HTTP listener, database, HTTP requester, configuration properties, global properties). MUST include: <global-property name="env" value="local"/> and <configuration-properties file="\${env}-properties.yaml"/>
- src/main/mule/global-error-handler.xml - Unified error handler with proper error mappings

3. YAML PROPERTY FILES:
- src/main/resources/local-properties.yaml
- src/main/resources/dev-properties.yaml
- src/main/resources/qa-properties.yaml
- src/main/resources/prod-properties.yaml
CRITICAL YAML RULES:
* Each key MUST appear only ONCE at the same level - no duplicate keys
* If a key exists (e.g., "http:"), merge all properties under that single key
* All values MUST be strings (e.g., port: "8081")
* Include connection details for ALL connectors from global.xml

4. LOGGING CONFIGURATION:
- src/main/resources/log4j2.xml
- src/test/resources/log4j2-test.xml

5. API FLOWS AND IMPLEMENTATION:
- src/main/mule/api-flows.xml - APIKit router + implementation flows from RAML
- src/main/mule/${apiName}-common.xml - Shared subflows (if logic is repeated)
- src/main/resources/dw/*.dwl - DataWeave scripts (>5 lines)

6. DIRECTORY MARKERS:
- src/main/java/.gitkeep
- src/test/mule/.gitkeep

⚠️ CRITICAL: DO NOT GENERATE RAML FILES ⚠️
- RAML specification is provided as INPUT above - it is already available
- DO NOT generate or include any .raml files in your response
- RAML files will be added to the project separately
- Focus ONLY on generating Mule implementation files (XML, YAML, properties, etc.)

CRITICAL REQUIREMENTS:

1. GENERATION ORDER:
   - First: Generate global.xml to identify connectors
   - Then: Generate pom.xml with dependencies for connectors found in global.xml AND api-flows.xml
   - Finally: Generate all other files

2. POM.XML DEPENDENCIES:
   - Analyze global.xml AND api-flows.xml to identify ALL connectors used
   - Include base dependencies: mule-http-connector, mule-apikit-module, mule-validation-module (version 2.0.8 - verify at https://repository.mulesoft.org/releases/), mule-configuration-properties-module
   - Add connector dependencies for ALL connectors found (Salesforce, Database, File, etc.)
   - Check https://repository.mulesoft.org/releases/ for actual latest versions - do NOT use non-existent versions
   - Mule Runtime version in pom.xml MUST match mule-artifact.json

3. VALIDATION MODULE:
   - DO NOT use non-existent tags like <validation:is-not-empty-string>
   - Use DataWeave for validation
   - ⚠️ CRITICAL: ONLY use VALIDATION:* error types if mule-validation-module is actually included in pom.xml AND used in implementation flows
   - DO NOT use VALIDATION:* error types if the validation connector is not in the project dependencies
   - If validation module is NOT used, use appropriate error types based on the connectors/modules that are actually being used in the project

4. ERROR HANDLING:
   - Use valid MuleSoft error types (check documentation)
   - DO NOT use non-existent HTTP error types (e.g., HTTP:CONFLICT does NOT exist)
   - For HTTP 409, use HTTP:BAD_REQUEST or CUSTOM:CONFLICT

5. FLOW STRUCTURE:
   - Entry logger → Validation → Transform → Connector calls → Transform → Exit logger → Error handling
   - Flow naming: <apiName>-<method>-<operation>-flow
   - Subflow naming: <apiName>-shared-<purpose>-subflow

6. XML NAMESPACE:
   - If using doc:name, declare xmlns:doc="http://www.mulesoft.org/schema/mule/documentation" in root <mule>

Generate production-ready Mule 4.9+ code with ALL files in a single response.`;

    const muleProject = { files: [] };

    try {
      console.log('🔄 Generating complete Mule project (all files in single call)...');
      const llmResponse = await this.askWithSystemPrompt(
        this.systemPrompt,
        allFilesPrompt,
        {
          temperature: 0.3,
          maxTokens: 50000, // Increased for generating all files at once
          taskType: 'code-generation-all-files',
          recommendedMinTokens: 40000,
        }
      );

      const content = llmResponse.choices[0].message.content;
      
      // Check for truncation
      if (this._detectTruncation(content)) {
        console.error('❌ TRUNCATION DETECTED in all-files generation response:');
        const truncationInfo = this._detectTruncation(content);
        console.error(`   Reason: ${truncationInfo.reason}`);
        console.error(`   Issues found: ${truncationInfo.issues.join(', ')}`);
        console.error(`   ⚠️  Response may be incomplete. Some files may be missing or invalid.`);
      }

      // Parse files from response
      const parsedFiles = this.parseFilesFromResponse(content);
      muleProject.files = parsedFiles;

      console.log(`✅ Generated ${muleProject.files.length} files in single call.`);
      return muleProject;
    } catch (error) {
      console.error('❌ Error generating all Mule files:', error);
      this.addDefaultFiles(muleProject, apiName);
      return muleProject;
    }
  }

  /**
   * Generates the Mule project skeleton (pom.xml, mule-artifact.json, global.xml, properties files).
   * @param {string} ramlContent - The RAML specification content.
   * @param {string} apiName - Name of the API.
   * @param {object} options - Additional options.
   * @param {object} context - Additional context.
   * @returns {Promise<object>} Mule project structure with initial files.
   */
  async _generateMuleProjectSkeleton(ramlContent, apiName, options = {}, context = {}) {
    const skeletonPrompt = `*** FILE FORMAT INSTRUCTION ***
EACH GENERATED FILE MUST BE EXPLICITLY DELIMITED USING THIS EXACT FORMAT:
>>> filepath <<<
[file content - no additional markers]

IMPORTANT: The >>> filepath <<< marker is ONLY a delimiter. Do NOT include it inside the actual file content.

⚠️ CRITICAL XML NAMESPACE REMINDER: ⚠️
If you use doc:name attribute on ANY element (error-handler, logger, transform, etc.), you MUST declare xmlns:doc="http://www.mulesoft.org/schema/mule/documentation" in the root <mule> element. Missing this will cause XML validation errors.

*** TASK: Generate Mule Project Skeleton Files ***

⚠️ CRITICAL REMINDER: pom.xml is MANDATORY and MUST be included in your response. Do NOT skip generating pom.xml. ⚠️

Generate ONLY the following essential Mule 4.9+ project configuration files:

MANDATORY FILES (ALL must be generated):
- pom.xml (project root) - ***ABSOLUTELY CRITICAL - MANDATORY FILE: Maven POM with Mule 4.9+ runtime AND dependencies for ALL connectors. Generate pom.xml AFTER generating global.xml in STEP 1, then analyze global.xml to identify which connectors are used and include ALL corresponding dependencies. Mule Runtime version MUST match mule-artifact.json. See Section 11 in system instructions. THIS FILE MUST BE GENERATED - DO NOT SKIP IT.***
- mule-artifact.json (project root) - Mule artifact metadata with minMuleVersion 4.9.0 and Java version
  * CRITICAL: The "name" field in mule-artifact.json MUST NOT contain spaces or special characters. Mule artifact name may not contain spaces - this causes deployment errors.
  * Artifact name must be sanitized: replace spaces with hyphens, remove special characters, convert to lowercase
  * Example: "Customer Profile Management API" → "customer-profile-management-api"
  * If the API name contains spaces, sanitize it before using in the "name" field: replace spaces with hyphens, remove special characters, convert to lowercase
  * The "name" field should match the "assetId" field format (lowercase, hyphens only, no spaces)
- .gitignore (project root) - MUST include IDE-specific files (.vscode/) and test resources (src/test/resources/embedded*)
- .muleignore (project root)
- src/main/mule/global.xml (all global element configurations - REQUIRED file name)
- src/main/mule/global-error-handler.xml (unified error handler)
- src/main/resources/local-properties.yaml (local environment properties)
- src/main/resources/dev-properties.yaml (dev environment ONLY)
- src/main/resources/qa-properties.yaml (qa environment ONLY)
- src/main/resources/prod-properties.yaml (prod environment ONLY)
- src/main/resources/log4j2.xml (MUST be in src/main/resources)
- src/test/resources/log4j2-test.xml (MUST be in src/test/resources)
- src/main/java/.gitkeep (empty directory marker)
- src/test/mule/.gitkeep (empty directory marker)
- src/main/resources/dw/ (folder for DataWeave scripts >5 lines)

${context.fromApiDetails
  ? `API Specification (from IHLD - no RAML):\n\`\`\`\n${ramlContent}\n\`\`\``
  : `RAML Specification (for context):\n\`\`\`raml\n${ramlContent}\n\`\`\``}

CRITICAL REQUIREMENTS - FOLLOW THIS EXACT ORDER:

*** STEP 1: GENERATE XML FILES AND CONFIGURATION FILES (global.xml, global-error-handler.xml, mule-artifact.json, YAML files, etc.) ***
- Generate ONLY the files listed above. Do NOT generate flows, API files, or DataWeave scripts.
- global.xml MUST contain all global element configurations (connector configurations, HTTP listener, database, external systems, HTTP requester, configuration properties, global properties)
- global.xml MUST include environment variable as global property: <global-property name="env" value="local" doc:name="Environment"/>
- global.xml MUST include configuration properties element: <configuration-properties file="\${env}-properties.yaml" doc:name="Configuration properties"/>
- global-error-handler.xml MUST declare the doc namespace in the root <mule> element if using doc:name on error-handler elements
- global.xml MUST NOT contain any <flow> or <subflow> elements
- global.xml MUST NOT contain error handlers (those go in global-error-handler.xml)
- Properties like host and port MUST NOT be hardcoded in XML files - MUST be referenced from YAML properties files
- YAML property files MUST use naming convention {env}-properties.yaml (e.g., local-properties.yaml, dev-properties.yaml, qa-properties.yaml, prod-properties.yaml)
- All values in YAML properties files MUST be strings, including numeric values (e.g., port: "8081" not port: 8081)
- YAML FILE STRUCTURE RULES (CRITICAL):
  * Each key in a YAML file MUST appear only ONCE at the same level - duplicate keys are invalid YAML and will cause parsing errors
  * DO NOT create duplicate keys at any level (top-level or nested). If a key already exists, merge properties under that single key
  * Example of INVALID YAML (duplicate top-level key):
    http:
      listener:
        host: "0.0.0.0"
        port: "8081"
    http:  ← DUPLICATE KEY - INVALID
      connection:
        timeout: "30000"
  * Example of VALID YAML (merged under single key):
    http:
      listener:
        host: "0.0.0.0"
        port: "8081"
      connection:
        timeout: "30000"
      response:
        timeout: "60000"
- Environment YAML property files MUST contain connection details for ALL connectors defined in global.xml
- Use TODO placeholders for connection details that need to be configured (e.g., salesforce.username: "your_salesforce_username")
- mule-artifact.json MUST specify minMuleVersion 4.9.0 and Java version
- CRITICAL: The "name" field in mule-artifact.json MUST NOT contain spaces - Mule artifact name may not contain spaces (causes deployment error: "Mule artifact name may not contain spaces")
- Sanitize the artifact name: replace spaces with hyphens, remove special characters, convert to lowercase
- Example: If API name is "Customer Profile Management API", use "customer-profile-management-api" in the "name" field
- The "name" field should match the "assetId" field format (lowercase, hyphens only, no spaces)
- Follow ALL Mule 4.9+ rules and conventions from the system instructions
- NEVER hardcode credentials in XML files

*** STEP 2: GENERATE pom.xml - THIS IS MANDATORY AND MUST BE INCLUDED (MUST BE DONE AFTER STEP 1) ***
⚠️ CRITICAL: pom.xml is a MANDATORY file and MUST be generated. Do NOT skip this step. ⚠️
- AFTER generating global.xml in STEP 1, analyze it to identify which connectors are actually configured
- Generate pom.xml with Mule 4.9+ runtime (app.runtime 4.9.0 or higher)
- CRITICAL: Mule Runtime version in pom.xml MUST match the version in mule-artifact.json
- For EACH connector found in global.xml, add the corresponding Maven dependency to pom.xml
- ALWAYS include base dependencies: mule-http-connector (use latest version compatible with Mule 4.9+ - check https://repository.mulesoft.org/releases/), mule-apikit-module (use latest version compatible with Mule 4.9+ - check https://repository.mulesoft.org/releases/), mule-validation-module (CRITICAL: Latest available version is 2.0.8 as of current date - always check https://repository.mulesoft.org/releases/ for actual latest version compatible with Mule 4.9+. Do NOT use version 2.1.0 or any non-existent version), mule-configuration-properties-module (version matching Mule Runtime)
- VALIDATION MODULE USAGE RULES (CRITICAL):
  * DO NOT use non-existent validation tags like <validation:is-not-empty-string>, <validation:isNotEmptyString>, or similar
  * mule-validation-module does NOT provide tags like <validation:is-not-empty-string>
  * For input validation, use DataWeave expressions with conditional logic or Try scope with error handling
  * If validation module is needed, use only components that actually exist in the module (check MuleSoft documentation)
  * ⚠️ CRITICAL: ONLY use VALIDATION:* error types if mule-validation-module is actually included in pom.xml AND used in implementation flows
  * If validation module is NOT used in the project, DO NOT use VALIDATION:* error types
  * Validation connector provides error types like VALIDATION:INVALID_INPUT, VALIDATION:INVALID_SIZE, VALIDATION:INVALID_FORMAT, etc. (check MuleSoft documentation for complete list) - but ONLY use these if the validation module is actually in use
  * Common validation pattern (if validation module is used): Use DataWeave to validate input, then use error() function with validation error types (VALIDATION:*), and use error handlers (On Error Propagate/Continue) to catch validation errors
  * Example (if validation module is used): Use DataWeave: if (payload.field == null or payload.field == "") then error('VALIDATION:INVALID_INPUT', 'Field cannot be empty') else payload
  * If validation module is NOT used, use appropriate error types based on the connectors/modules that are actually being used in the project
  * DO NOT use Raise Error component for validation failures - use appropriate error types based on what connectors/modules are actually used
- Use the connector dependency templates from system instructions Section 11
- CRITICAL: Connector versions MUST be compatible with both Mule Runtime version AND Java version from mule-artifact.json
- CRITICAL: ALWAYS verify connector compatibility at https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes
- CRITICAL: ALWAYS check https://repository.mulesoft.org/releases/ for actual latest available versions - do NOT assume or make up version numbers
- CRITICAL: pom.xml dependencies must match EXACTLY what connectors are used in global.xml
- This ensures pom.xml contains only the dependencies that are actually needed
- REMEMBER: pom.xml MUST be generated and included in your response using the >>> pom.xml <<< format

⚠️ CRITICAL: pom.xml CONTENT REQUIREMENTS ⚠️
- pom.xml MUST contain ONLY valid XML content - NO summaries, NO explanatory text, NO markdown
- DO NOT add any text after </project> closing tag
- DO NOT add summary sections like "## SUMMARY", "✅ Generated files", "---", etc.
- DO NOT add explanatory text, checkmarks, or bullet points in pom.xml
- pom.xml should start with <?xml and end with </project> - nothing else
- If you want to provide summaries, add them OUTSIDE the >>> pom.xml <<< delimiter, NOT inside the file content

*** FINAL VALIDATION CHECK (Before completing your response) ***
⚠️ BEFORE SUBMITTING YOUR RESPONSE, VERIFY ALL FILES ARE GENERATED: ⚠️
- ✅ pom.xml MUST be generated and included (use >>> pom.xml <<< format)
- ✅ mule-artifact.json MUST be generated
- ✅ global.xml MUST be generated
- ✅ All YAML properties files MUST be generated
- ✅ After generating pom.xml and global.xml, verify that pom.xml includes dependencies for ALL connectors in global.xml
- ✅ If global.xml has Salesforce config → pom.xml MUST have mule-salesforce-connector dependency
- ✅ If global.xml has Database config → pom.xml MUST have mule-db-connector dependency
- ✅ If global.xml has File config → pom.xml MUST have mule-file-connector dependency
- ✅ Verify Mule Runtime version in pom.xml matches mule-artifact.json
- ✅ Verify configuration-properties module is included in pom.xml
- ✅ Verify global.xml includes environment variable and configuration properties element
- ✅ Verify YAML properties files use {env}-properties.yaml naming and all values are strings
- ✅ Verify .gitignore includes IDE files (.vscode/) and test resources (src/test/resources/embedded*)
- ✅ Verify no hardcoded credentials in XML files
- ⚠️ CRITICAL: If pom.xml is missing, your response is incomplete. Generate it NOW before submitting. ⚠️
- This validation is CRITICAL - missing dependencies will cause build failures
- Remember: Generate XML files FIRST in STEP 1, then pom.xml in STEP 2 based on what connectors you actually used`;

    const muleProject = { files: [] };

    try {
      console.log('🔄 Generating Mule project skeleton (config files)...');
      const llmResponse = await this.askWithSystemPrompt(
        this.systemPrompt,
        skeletonPrompt,
        {
          temperature: 0.2,
          maxTokens: 16000, // Increased to prevent truncation for complex configurations
          taskType: 'code-generation-skeleton',
          recommendedMinTokens: 12000,
          response_format: { type: "text" } // Expect text output to parse files manually
        }
      );

      // Detect truncation before parsing
      const truncationCheck = this.detectTruncation(llmResponse, 16000);
      if (truncationCheck.isTruncated) {
        console.error('❌ TRUNCATION DETECTED in skeleton generation response:');
        console.error(`   Reason: ${truncationCheck.reason}`);
        console.error(`   Issues found: ${truncationCheck.issues.join(', ')}`);
        truncationCheck.suggestions.forEach(suggestion => console.warn(`   ${suggestion}`));
        console.error('   ⚠️  Skeleton files may be incomplete. Some files may be missing or invalid.');
      }

      const files = this.parseAllFilesFromResponse(llmResponse);
      files.forEach(file => muleProject.files.push(file));

      // Log which files were parsed from LLM response
      const parsedFilePaths = files.map(f => f.path);
      console.log(`📋 Files parsed from LLM skeleton response (${parsedFilePaths.length} files):`, parsedFilePaths);
      
      // Check if pom.xml was generated by LLM
      const pomXmlGenerated = parsedFilePaths.includes('pom.xml');
      if (!pomXmlGenerated) {
        console.warn('⚠️  pom.xml was NOT generated by LLM in skeleton stage. Will use fallback default.');
      } else {
        console.log('✅ pom.xml was successfully generated by LLM');
      }

      // Post-process: Ensure pom.xml has all connector dependencies
      // COMMENTED OUT: Testing LLM-only pom.xml generation quality
      // this.ensureConnectorDependencies(muleProject);

      // Validate generated XML files (temporarily disabled)
      // for (const file of muleProject.files) {
      //   if (file.path.endsWith('.xml')) {
      //     console.log(`🔍 Validating XML file: ${file.path}`);
      //     const { isValid, errors } = await validateMuleXml(file.content);
      //     if (!isValid) {
      //       console.error(`❌ XML validation failed for ${file.path}:`, errors);
      //       throw new Error(`XML validation failed for ${file.path}: ${errors.join('; ')}`); // Stop if XML is invalid
      //     } else {
      //       console.log(`✅ XML validation successful for ${file.path}`);
      //     }
      //   }
      // }

      console.log(`✅ Generated ${muleProject.files.length} skeleton files.`);
      return muleProject;
    } catch (error) {
      console.error('❌ Error generating Mule project skeleton:', error);
      this.addDefaultFiles(muleProject, apiName); // Fallback to default files
      return muleProject;
    }
  }

  /**
   * LEGACY METHOD - Kept for backward compatibility but no longer used
   * Generates Mule API flows based on RAML and user-provided flow options.
   * @param {string} ramlContent - The RAML specification content.
   * @param {string} apiName - Name of the API.
   * @param {object} flowOptions - User-provided answers to dynamic questions.
   * @param {object} generatedSkeleton - The project skeleton generated in the previous step.
   * @param {object} options - Additional options.
   * @param {object} context - Additional context.
   * @returns {Promise<object>} Mule project structure with API flow files.
   */
  async _generateMuleApiFlows(ramlContent, apiName, flowOptions = {}, generatedSkeleton = { files: [] }, options = {}, context = {}) {
    // Extract global.xml for context
    const globalConfigXml = generatedSkeleton.files.find(f => f.path === 'src/main/mule/global.xml')?.content || '';
    const globalErrorXml = generatedSkeleton.files.find(f => f.path === 'src/main/mule/global-error-handler.xml')?.content || '';

    let flowDetails = '';
    for (const key in flowOptions) {
      if (flowOptions.hasOwnProperty(key)) {
        flowDetails += `\\n- ${key}: ${flowOptions[key]}`;
      }
    }

    // Build context information (IHLD Analysis and API Details)
    let contextInfo = "";
    if (context.architecture) {
      contextInfo += `\nArchitecture Solution (for reference):\n${context.architecture.substring(0, 2000)}...\n`;
    }
    if (context.diagram) {
      contextInfo += `\nArchitecture Diagram (for reference on data flow):\n${context.diagram}\n`;
    }
    if (context.ihldAnalysis) {
      const analysisText = context.ihldAnalysis.length > MAX_IHLD_ANALYSIS_CONTEXT_CHARS
        ? context.ihldAnalysis.substring(0, MAX_IHLD_ANALYSIS_CONTEXT_CHARS) + "\n...[truncated for context length]"
        : context.ihldAnalysis;
      contextInfo += `\nIntegration Design Document Analysis context:\n${analysisText}\n`;
    }
    if (context.apiDetails) {
      const endpoints = Array.isArray(context.apiDetails.endpoints) ? context.apiDetails.endpoints : [];
      const integrationPoints = Array.isArray(context.apiDetails.integrationPoints) ? context.apiDetails.integrationPoints : [];
      contextInfo += `\nAPI Details from Integration Design Document:\n`;
      contextInfo += `- API Type: ${context.apiDetails.type || 'N/A'}\n`;
      contextInfo += `- Description: ${context.apiDetails.description || 'N/A'}\n`;
      if (endpoints.length > 0) {
        contextInfo += `- Endpoints: ${endpoints.map((e) => (typeof e === 'string' ? e : (e && (e.path || e.url)) ? (e.path || e.url) : String(e))).join(', ')}\n`;
      }
      if (integrationPoints.length > 0) {
        contextInfo += `- Integration Points: ${integrationPoints.map((i) => (typeof i === 'string' ? i : String(i))).join(', ')}\n`;
      }
    }

    const apiFlowsPrompt = `*** FILE FORMAT: >>> filepath <<< [content] ***

*** TASK: Generate Mule 4.9+ API Flows ***

FILES TO GENERATE:
- src/main/mule/api-flows.xml (APIKit router + implementation flows)
- src/main/mule/${apiName}-common.xml (shared subflows if needed)
- src/main/resources/dw/*.dwl (DataWeave scripts >5 lines)

API: ${apiName}

${context.fromApiDetails
  ? `No RAML. API Specification (from IHLD):\n\`\`\`\n${ramlContent}\n\`\`\`\n\n`
  : `RAML:\n\`\`\`raml\n${ramlContent}\n\`\`\`\n\n`}${contextInfo ? `CONTEXT:\n${contextInfo}\n` : ''}${flowDetails ? `CLARIFICATIONS:\n${flowDetails}\n` : ''}
GLOBAL CONFIG:
\`\`\`xml
${globalConfigXml || 'N/A'}
\`\`\`

ERROR HANDLER:
\`\`\`xml
${globalErrorXml || 'N/A'}
\`\`\`

REQUIREMENTS:

0. ENDPOINT RESTRICTION (CRITICAL): 
   - ONLY implement endpoints that are explicitly defined in the RAML specification provided above
   - If Integration Design Document context is provided, ONLY implement endpoints listed in the API Details section
   - DO NOT add additional endpoints beyond what is specified in the RAML or Integration Design Document
   - DO NOT infer or assume additional endpoints based on common REST patterns
   - EXCEPTION: Health check endpoint (/health or /healthcheck) SHOULD be included as a standard best practice, even if not mentioned in RAML or Integration Design Document
   - The health check endpoint should return a simple JSON response indicating API status (e.g., {"status": "UP"})
   - All other endpoints must strictly match what is specified in the RAML or Integration Design Document

1. POM.XML: After generating api-flows.xml, update pom.xml with dependencies for ALL connectors used. Check global.xml and api-flows.xml for connector configs/operations. Include base deps: mule-http-connector, mule-apikit-module, mule-validation-module (CRITICAL: Latest available version is 2.0.8 - verify at https://repository.mulesoft.org/releases/. Do NOT use version 2.1.0 or non-existent versions), mule-configuration-properties-module (all use latest versions compatible with Mule 4.9+ - verify at https://repository.mulesoft.org/releases/). Runtime version must match mule-artifact.json.
- VALIDATION MODULE USAGE: DO NOT use non-existent validation tags like <validation:is-not-empty-string>. Use DataWeave for validation. When validation fails, use validation connector error types (VALIDATION:*) - DO NOT use Raise Error with custom error types. Use error handlers (On Error Propagate/Continue) to catch validation errors.

2. XML NAMESPACE: If using doc:name, declare xmlns:doc="http://www.mulesoft.org/schema/mule/documentation" in root <mule>.

3. FLOW STRUCTURE: Entry logger → Validation → Transform → Connector calls → Transform → Exit logger → Error handling. Use RAML examples for DataWeave.

4. NAMING: Flows: <apiName>-<method>-<operation>-flow. Subflows: <apiName>-shared-<purpose>-subflow. Replace special chars with hyphens.

5. DATAWEAVE: Scripts >5 lines → .dwl files in src/main/resources/dw/. Reference: <ee:transform file="dw/name.dwl" />

6. DO NOT GENERATE: pom.xml, mule-artifact.json, global.xml, or skeleton files. Only API flows, subflows, and DataWeave scripts.

Generate production-ready Mule 4.9+ code.`;

    const muleProjectFlows = { files: [] };

    try {
      console.log('🔄 Generating Mule API flows and related scripts...');
      const llmResponse = await this.askWithSystemPrompt(
        this.systemPrompt,
        apiFlowsPrompt,
        {
          temperature: 0.3,
          maxTokens: 40000, // Increased to prevent truncation for complex APIs
          taskType: 'code-generation-api-flows',
          recommendedMinTokens: 32000,
          response_format: { type: "text" }
        }
      );

      // Detect truncation before parsing
      const truncationCheck = this.detectTruncation(llmResponse, 40000);
      if (truncationCheck.isTruncated) {
        console.error('❌ TRUNCATION DETECTED in API flows generation response:');
        console.error(`   Reason: ${truncationCheck.reason}`);
        console.error(`   Issues found: ${truncationCheck.issues.join(', ')}`);
        truncationCheck.suggestions.forEach(suggestion => console.warn(`   ${suggestion}`));
        console.error('   ⚠️  API flows may be incomplete. Some flows or files may be missing or invalid.');
      }

      const files = this.parseAllFilesFromResponse(llmResponse);
      files.forEach(file => muleProjectFlows.files.push(file));

      // Log which files were parsed from LLM response
      const parsedFilePaths = files.map(f => f.path);
      console.log(`📋 Files parsed from LLM API flows response (${parsedFilePaths.length} files):`, parsedFilePaths);

      // Post-process: Ensure pom.xml has all connector dependencies (check both skeleton and flows)
      // Note: This will check the complete project when combined with skeleton
      // For now, we'll rely on the main generateMuleCode to call ensureConnectorDependencies

      // Validate generated XML files (temporarily disabled)
      // for (const file of muleProjectFlows.files) {
      //   if (file.path.endsWith('.xml')) {
      //     console.log(`🔍 Validating XML file: ${file.path}`);
      //     const { isValid, errors } = await validateMuleXml(file.content);
      //     if (!isValid) {
      //       console.error(`❌ XML validation failed for ${file.path}:`, errors);
      //       throw new Error(`XML validation failed for ${file.path}: ${errors.join('; ')}`); // Stop if XML is invalid
      //     } else {
      //       console.log(`✅ XML validation successful for ${file.path}`);
      //     }
      //   }
      // }

      console.log(`✅ Generated ${muleProjectFlows.files.length} API flow files.`);
      return muleProjectFlows;
    } catch (error) {
      console.error('❌ Error generating Mule API flows:', error);
      throw error; // Re-throw to be caught by the main generateMuleCode
    }
  }

  /**
   * Public method to generate dynamic questions for Mule flow code generation.
   * @param {string} ramlContent - The RAML specification content.
   * @param {object} options - Additional options for LLM.
   * @returns {Promise<Array<object>>} An array of question objects.
   */
  async getMuleFlowQuestions(ramlContent, options = {}) {
    return await this._generateDynamicMuleFlowQuestions(ramlContent, options);
  }

  async _runMavenBuildCheck(muleProject, apiName) {
    let tempDir;
    
    try {
      // 1. Create temporary directory
      tempDir = await this._createTempDir(`mule_${apiName}_`);
      console.log(`🏗️ Running Maven build check in temporary directory: ${tempDir}`);

      // 2. Write all files with validation and concurrency
      console.log(`📝 Writing ${muleProject.files.length} files...`);
      const writeResults = await this._writeFilesConcurrently(muleProject.files, tempDir);
      const failedWrites = writeResults.filter(r => !r.success);
      
      if (failedWrites.length > 0) {
        throw new Error(`Failed to write ${failedWrites.length} files`);
      }

      // 3. Run Maven build
      console.log(`🚀 Executing Maven build in ${tempDir}`);
      const command = 'mvn clean package';
      
      try {
        const { stdout, stderr } = await execAsync(command, { 
          cwd: tempDir,
          maxBuffer: 10 * 1024 * 1024 // 10MB output buffer
        });
        
        console.log('✅ Maven build completed successfully');
        if (stderr) {
          console.warn('Maven build warnings:', stderr);
        }
        
        return { 
          isSuccess: true, 
          output: stdout + (stderr ? '\nWARNINGS:\n' + stderr : '') 
        };
        
      } catch (error) {
        console.error('❌ Maven build failed:', error.message);
        return { 
          isSuccess: false, 
          output: `Maven build failed: ${error.message}\n${error.stderr || ''}` 
        };
      }
      
    } catch (error) {
      console.error('❌ Error during Maven build check:', error);
      return { 
        isSuccess: false, 
        output: error.message 
      };
      
    } finally {
      // 4. Clean up temporary directory
      if (tempDir) {
        try {
          await this._cleanupTempDir(tempDir);
        } catch (cleanupError) {
          console.error('❌ Error cleaning up temporary directory:', cleanupError);
        }
      }
    }
  }

  /**
   * Cleans pom.xml content by removing summaries, explanatory text, and non-XML content
   * @param {string} content - pom.xml file content
   * @returns {string} Cleaned XML content
   */
  cleanPomXmlContent(content) {
    if (!content) return content;

    let cleaned = content.trim();

    // Remove markdown code blocks if present
    cleaned = cleaned.replace(/```xml\n?/g, '').replace(/```\n?/g, '').trim();

    // Find the start of the XML (look for <?xml or <project)
    const xmlStart = cleaned.search(/<\?xml|<project/i);
    if (xmlStart > 0) {
      // Remove any text before the XML declaration
      cleaned = cleaned.substring(xmlStart);
    }

    // Find the end of the XML (look for </project>)
    const projectEnd = cleaned.lastIndexOf('</project>');
    if (projectEnd !== -1) {
      // Keep only content up to and including </project>
      cleaned = cleaned.substring(0, projectEnd + '</project>'.length);
    }

    // Remove common summary patterns that might appear after </project>
    // Remove markdown-style summaries (---, ##, **, etc.)
    cleaned = cleaned.replace(/---[\s\S]*$/m, ''); // Remove everything after ---
    cleaned = cleaned.replace(/##\s+SUMMARY[\s\S]*$/im, ''); // Remove ## SUMMARY sections
    cleaned = cleaned.replace(/\*\*SUMMARY[\s\S]*$/im, ''); // Remove **SUMMARY sections
    cleaned = cleaned.replace(/✅[\s\S]*$/m, ''); // Remove checkmark summaries
    cleaned = cleaned.replace(/📋[\s\S]*$/m, ''); // Remove clipboard summaries
    
    // Remove any text after </project> that doesn't look like XML
    const projectEndIndex = cleaned.lastIndexOf('</project>');
    if (projectEndIndex !== -1) {
      const afterProject = cleaned.substring(projectEndIndex + '</project>'.length);
      // If there's content after </project> that's not whitespace or XML comments, remove it
      if (afterProject.trim() && !afterProject.trim().match(/^\s*$/)) {
        // Check if it's just whitespace or XML comments
        const nonXmlContent = afterProject.replace(/^\s*/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
        if (nonXmlContent && !nonXmlContent.match(/^<\?/)) {
          // Remove non-XML content after </project>
          cleaned = cleaned.substring(0, projectEndIndex + '</project>'.length);
        }
      }
    }

    // Remove any standalone summary sections (lines starting with ##, **, ✅, etc.)
    const lines = cleaned.split('\n');
    const cleanedLines = [];
    let inXmlContent = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Detect start of XML
      if (line.match(/<\?xml|<project/i)) {
        inXmlContent = true;
      }
      
      // If we're in XML content, keep the line
      if (inXmlContent) {
        cleanedLines.push(line);
        // Detect end of XML
        if (line.includes('</project>')) {
          break; // Stop after </project>
        }
      } else {
        // Before XML starts, skip summary lines
        if (!line.match(/^(##|\*\*|✅|📋|---|SUMMARY)/i)) {
          cleanedLines.push(line);
        }
      }
    }
    
    cleaned = cleanedLines.join('\n').trim();

    // Final cleanup: ensure it starts with XML declaration or <project>
    if (!cleaned.match(/^<\?xml|<project/i)) {
      // Try to find XML content in the string
      const xmlMatch = cleaned.match(/(<\?xml[\s\S]*?<\/project>)/i);
      if (xmlMatch) {
        cleaned = xmlMatch[1];
      }
    }

    return cleaned.trim();
  }

  /**
   * Cleans environment-specific properties from property files
   * @param {string} content - File content
   * @param {string} env - Target environment (dev/qa/prod)
   * @returns {string} Cleaned content
   */
  cleanEnvironmentProperties(content, env) {
    const lines = content.split('\n');
    const cleaned = [];

    lines.forEach(line => {
      // Skip lines that reference other environments
      if (env === 'dev' && (line.includes('qa') || line.includes('prod')) && !line.startsWith('#')) {
        // Skip if it's a property value referencing qa/prod (but allow comments)
        if (line.includes('qa-server') || line.includes('prod') || line.includes('production')) {
          return;
        }
      }
      if (env === 'qa' && (line.includes('dev') || line.includes('prod')) && !line.startsWith('#')) {
        if (line.includes('localhost') || line.includes('dev') || line.includes('production')) {
          return;
        }
      }
      if (env === 'prod' && (line.includes('dev') || line.includes('qa')) && !line.startsWith('#')) {
        if (line.includes('localhost') || line.includes('dev') || line.includes('qa')) {
          return;
        }
      }
      cleaned.push(line);
    });

    return cleaned.join('\n');
  }

  /**
   * Parse all files from a single LLM response
   * @param {string} response - LLM response containing all files
   * @returns {Array} Array of {path, content} objects
   */
  parseAllFilesFromResponse(response) {
    const uniqueFilesMap = new Map(); // Use a Map for deduplication by path
    let content = response.trim();

    // Additional validation: Check for incomplete files in the parsed content
    // This is a secondary check after initial truncation detection

    // Remove markdown code blocks if present
    content = content
      .replace(/```(?:xml|json|yaml|properties|java|dwl)?\n?/g, '')
      .replace(/```/g, '');

    // Pattern to match file markers: >>> path <<< or >>> path
    const filePattern = />>>\s*([^\n<]+?)\s*(?:<<<)?\s*\n([\s\S]*?)(?=\n>>>\s*[^\n<]+?\s*(?:<<<)?\s*\n|$)/g;
    
    let match;
    const matches = [];

    // Collect all matches first
    while ((match = filePattern.exec(content)) !== null) {
      matches.push({
        path: match[1].trim(),
        content: match[2]
      });
    }

    // Process each match and deduplicate
    for (const match of matches) {
      try {
        const filePath = match.path;
        let fileContent = match.content.trim();

        // Clean up any remaining markers in the content
        fileContent = fileContent
          .replace(/>>>\s*[^\n<]+?\s*(?:<<<)?\s*\n?/g, '')
          .replace(/>>>\s*[^\n<]+?\s*(?:<<<)?\s*$/gm, '')
          .trim();

        // Skip empty files
        if (!filePath || !fileContent) {
          console.warn(`⚠️  Skipping empty or invalid file: ${filePath || 'unknown'}`);
          continue;
        }

        // Clean pom.xml: Remove any summary, explanatory text, or markdown content
        if (filePath === 'pom.xml') {
          fileContent = this.cleanPomXmlContent(fileContent);
        }

         // Handle environment-specific YAML properties
         if (filePath.includes('-properties.yaml')) {
           if (filePath.includes('dev-properties.yaml')) {
             fileContent = this.cleanEnvironmentProperties(fileContent, 'dev');
           } else if (filePath.includes('qa-properties.yaml')) {
             fileContent = this.cleanEnvironmentProperties(fileContent, 'qa');
           } else if (filePath.includes('prod-properties.yaml')) {
             fileContent = this.cleanEnvironmentProperties(fileContent, 'prod');
           }
         }

        // Add to map, overwriting if path already exists (effectively deduplicating)
        uniqueFilesMap.set(filePath, { path: filePath, content: fileContent });
      } catch (error) {
        console.error(`❌ Error processing file ${match.path}:`, error);
      }
    }

    return Array.from(uniqueFilesMap.values());
  }

  /**
   * Extract file content from LLM response (for backward compatibility)
   * @param {string} response - LLM response
   * @param {string} filename - Expected filename
   * @returns {string} Clean file content
   */
  extractFileContent(response, filename) {
    let content = response.trim();

    // Remove markdown code blocks if present
    content = content.replace(/```xml\n?/g, "");
    content = content.replace(/```json\n?/g, "");
    content = content.replace(/```properties\n?/g, "");
    content = content.replace(/```yaml\n?/g, "");
    content = content.replace(/```\n?/g, "");

    // Try to extract content after filename marker
    const marker = `>>> ${filename} <<<`;
    if (content.includes(marker)) {
      const parts = content.split(marker);
      if (parts.length > 1) {
        content = parts.slice(1).join(marker).trim();
        // Remove any subsequent file markers
        content = content.split(/>>>\s*[^\n<]+?\s*(?:<<<)?/)[0].trim();
      }
    }

    // Also try without <<<
    const marker2 = `>>> ${filename}`;
    if (content.includes(marker2) && !content.includes('<<<')) {
      const parts = content.split(marker2);
      if (parts.length > 1) {
        content = parts.slice(1).join(marker2).trim();
        // Remove any subsequent file markers
        content = content.split(/>>>\s*[^\n<]+?\s*(?:<<<)?/)[0].trim();
      }
    }

    // Remove file marker if it appears in the content itself
    content = content.replace(new RegExp(`>>>\\s*${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:<<<)?`, 'g'), '').trim();

    return content.trim();
  }

  /**
   * Add default files as fallback (only if they don't already exist)
   */
  addDefaultFiles(muleProject, apiName) {
    // Helper function to check if file already exists
    const fileExists = (filePath) => {
      return muleProject.files.some(file => file.path === filePath);
    };

    // Only add files that don't already exist
    // Ensure pom.xml always exists - use fallback if LLM didn't generate it
    if (!fileExists('pom.xml')) {
      console.warn('⚠️  pom.xml missing from generated files. Fallback disabled for LLM quality testing.');
      // COMMENTED OUT: Temporarily disabled to test LLM code quality
      // muleProject.files.push({ path: 'pom.xml', content: this.getDefaultPomXml(apiName) });
    }
    if (!fileExists('mule-artifact.json')) {
      muleProject.files.push({ path: 'mule-artifact.json', content: this.getDefaultMuleArtifact(apiName) });
    }
    if (!fileExists('.gitignore')) {
      muleProject.files.push({ path: '.gitignore', content: this.getDefaultGitIgnore() });
    }
    if (!fileExists('.muleignore')) {
      muleProject.files.push({ path: '.muleignore', content: this.getDefaultMuleIgnore() });
    }
    if (!fileExists('src/main/resources/local-properties.yaml')) {
      muleProject.files.push({ path: 'src/main/resources/local-properties.yaml', content: this.getDefaultLocalProperties() });
    }
    if (!fileExists('src/main/resources/dev-properties.yaml')) {
      muleProject.files.push({ path: 'src/main/resources/dev-properties.yaml', content: this.getDefaultDevProperties() });
    }
    if (!fileExists('src/main/resources/qa-properties.yaml')) {
      muleProject.files.push({ path: 'src/main/resources/qa-properties.yaml', content: this.getDefaultQaProperties() });
    }
    if (!fileExists('src/main/resources/prod-properties.yaml')) {
      muleProject.files.push({ path: 'src/main/resources/prod-properties.yaml', content: this.getDefaultProdProperties() });
    }
    if (!fileExists('src/main/resources/log4j2.xml')) {
      muleProject.files.push({ path: 'src/main/resources/log4j2.xml', content: this.getDefaultLog4j2() });
    }
    if (!fileExists('src/test/resources/log4j2-test.xml')) {
      muleProject.files.push({ path: 'src/test/resources/log4j2-test.xml', content: this.getDefaultLog4j2Test() });
    }
    if (!fileExists('src/main/java/.gitkeep')) {
      muleProject.files.push({ path: 'src/main/java/.gitkeep', content: '# This file ensures the directory is included in version control\n' });
    }
    if (!fileExists('src/test/mule/.gitkeep')) {
      muleProject.files.push({ path: 'src/test/mule/.gitkeep', content: '# This file ensures the directory is included in version control\n' });
    }
  }

  /**
   * Ensures pom.xml includes dependencies for all connectors used in the generated code
   * This is a post-processing step to catch any missing dependencies
   */
  ensureConnectorDependencies(muleProject) {
    const pomFile = muleProject.files.find(f => f.path === 'pom.xml');
    if (!pomFile) {
      console.warn('⚠️  pom.xml not found, cannot ensure connector dependencies');
      return;
    }

    // Detect connectors from all XML files
    const detectedConnectors = this.detectConnectorsInProject(muleProject);
    
    if (detectedConnectors.size === 0) {
      console.log('ℹ️  No connectors detected, skipping dependency check');
      return;
    }

    console.log(`🔍 Detected connectors in generated code: ${Array.from(detectedConnectors).join(', ')}`);

    // Check if dependencies are already present
    const pomContent = pomFile.content;
    const missingDeps = [];

    detectedConnectors.forEach(connector => {
      const depInfo = this.getConnectorDependencyInfo(connector);
      if (depInfo) {
        // Check if dependency already exists in pom.xml
        const artifactIdPattern = new RegExp(`<artifactId>${depInfo.artifactId}</artifactId>`, 'i');
        if (!artifactIdPattern.test(pomContent)) {
          missingDeps.push(depInfo);
          console.warn(`⚠️  Missing dependency detected: ${connector} (${depInfo.artifactId})`);
        }
      }
    });

    if (missingDeps.length === 0) {
      console.log('✅ All connector dependencies are present in pom.xml');
      return;
    }

    // Add missing dependencies to pom.xml
    console.log(`🔧 Adding ${missingDeps.length} missing connector dependency/dependencies to pom.xml`);
    
    const dependencyXml = missingDeps.map(dep => 
      `        <dependency>
            <groupId>${dep.groupId}</groupId>
            <artifactId>${dep.artifactId}</artifactId>
            <version>${dep.version}</version>
            <classifier>${dep.classifier}</classifier>
        </dependency>`
    ).join('\n');

    // Insert before </dependencies>
    if (pomContent.includes('</dependencies>')) {
      pomFile.content = pomContent.replace(
        '</dependencies>',
        dependencyXml + '\n    </dependencies>'
      );
      console.log(`✅ Updated pom.xml with ${missingDeps.length} missing connector dependency/dependencies`);
    } else {
      console.warn('⚠️  pom.xml does not have </dependencies> tag, cannot add dependencies automatically');
    }
  }

  /**
   * Detects connectors used in the Mule project files
   */
  detectConnectorsInProject(muleProject) {
    const connectors = new Set();
    
    muleProject.files.forEach(file => {
      if (file.path && file.path.endsWith('.xml') && file.content) {
        const content = file.content;
        
        // Check for connector namespaces and operations
        const connectorPatterns = {
          'salesforce': /xmlns:salesforce=|<salesforce:/i,
          'database': /xmlns:db=|<db:/i,
          'file': /xmlns:file=|<file:/i,
          'ftp': /xmlns:ftp=|<ftp:/i,
          'sftp': /xmlns:sftp=|<sftp:/i,
          'email': /xmlns:email=|<email:/i,
          'jms': /xmlns:jms=|<jms:/i,
          'vm': /xmlns:vm=|<vm:/i,
          'objectstore': /xmlns:os=|<os:/i,
          'quartz': /xmlns:quartz=|<quartz:/i,
          'sap': /xmlns:sap=|<sap:/i,
          'soap': /xmlns:soap=|<soap:/i,
          'sockets': /xmlns:sockets=|<sockets:/i
        };

        for (const [connectorName, pattern] of Object.entries(connectorPatterns)) {
          if (pattern.test(content)) {
            connectors.add(connectorName);
          }
        }
      }
    });

    return connectors;
  }

  /**
   * Get connector dependency information
   */
  getConnectorDependencyInfo(connectorName) {
    const dependencies = {
      'salesforce': {
        groupId: 'com.mulesoft.connectors',
        artifactId: 'mule-salesforce-connector',
        version: '11.15.0',
        classifier: 'mule-plugin'
      },
      'database': {
        groupId: 'org.mule.connectors',
        artifactId: 'mule-db-connector',
        version: '1.18.0',
        classifier: 'mule-plugin'
      },
      'file': {
        groupId: 'org.mule.connectors',
        artifactId: 'mule-file-connector',
        version: '1.4.0',
        classifier: 'mule-plugin'
      },
      'ftp': {
        groupId: 'org.mule.connectors',
        artifactId: 'mule-ftp-connector',
        version: '1.3.0',
        classifier: 'mule-plugin'
      },
      'sftp': {
        groupId: 'org.mule.connectors',
        artifactId: 'mule-sftp-connector',
        version: '1.3.0',
        classifier: 'mule-plugin'
      },
      'email': {
        groupId: 'org.mule.connectors',
        artifactId: 'mule-email-connector',
        version: '1.2.0',
        classifier: 'mule-plugin'
      },
      'jms': {
        groupId: 'org.mule.connectors',
        artifactId: 'mule-jms-connector',
        version: '2.0.0',
        classifier: 'mule-plugin'
      },
      'vm': {
        groupId: 'org.mule.modules',
        artifactId: 'mule-vm-module',
        version: '2.4.0',
        classifier: 'mule-plugin'
      },
      'objectstore': {
        groupId: 'org.mule.modules',
        artifactId: 'mule-objectstore-module',
        version: '2.4.0',
        classifier: 'mule-plugin'
      },
      'quartz': {
        groupId: 'org.mule.modules',
        artifactId: 'mule-quartz-module',
        version: '2.4.0',
        classifier: 'mule-plugin'
      },
      'sap': {
        groupId: 'com.mulesoft.connectors',
        artifactId: 'mule-sap-connector',
        version: '4.0.0',
        classifier: 'mule-plugin'
      },
      'soap': {
        groupId: 'com.mulesoft.connectors',
        artifactId: 'mule-soap-connector',
        version: '1.2.0',
        classifier: 'mule-plugin'
      },
      'sockets': {
        groupId: 'org.mule.connectors',
        artifactId: 'mule-sockets-connector',
        version: '1.2.0',
        classifier: 'mule-plugin'
      }
    };

    return dependencies[connectorName.toLowerCase()] || null;
  }

  /**
   * Remove duplicate files from the project (keeps the first occurrence, which is usually the LLM-generated one)
   */
  deduplicateFiles(muleProject) {
    const seen = new Map();
    const uniqueFiles = [];

    // Process files in order to keep the first occurrence of each file
    // This ensures LLM-generated files are kept over default fallback files
    for (const file of muleProject.files) {
      const filePath = file.path || '';

      if (!seen.has(filePath)) {
        seen.set(filePath, true);
        uniqueFiles.push(file);
      } else {
        console.warn(`⚠️  Duplicate file detected and removed: ${filePath} (keeping first occurrence)`);
      }
    }

    muleProject.files = uniqueFiles;
    return muleProject;
  }

  /**
   * Get default pom.xml content
   * COMMENTED OUT: Temporarily disabled to test LLM code quality without fallback
   */
  /* getDefaultPomXml(apiName) {
    const sanitizedName = apiName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.mulesoft</groupId>
    <artifactId>${sanitizedName}</artifactId>
    <version>1.0.0-SNAPSHOT</version>
    <packaging>mule-application</packaging>
    <name>${apiName}</name>

    <properties>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
        <app.runtime>4.9.0</app.runtime>
        <mule.maven.plugin.version>4.0.0</mule.maven.plugin.version>
    </properties>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-clean-plugin</artifactId>
                <version>3.1.0</version>
            </plugin>
            <plugin>
                <groupId>org.mule.tools.maven</groupId>
                <artifactId>mule-maven-plugin</artifactId>
                <version>\${mule.maven.plugin.version}</version>
                <extensions>true</extensions>
            </plugin>
        </plugins>
    </build>

    <dependencies>
        <dependency>
            <groupId>org.mule.connectors</groupId>
            <artifactId>mule-http-connector</artifactId>
            <version>1.7.4</version>
            <classifier>mule-plugin</classifier>
        </dependency>
        <!-- NOTE: HTTP connector version should be updated to latest compatible with Mule 4.9+ from https://repository.mulesoft.org/releases/ -->
        <dependency>
            <groupId>org.mule.modules</groupId>
            <artifactId>mule-validation-module</artifactId>
            <version>2.0.0</version>
            <classifier>mule-plugin</classifier>
        </dependency>
        <dependency>
            <groupId>org.mule.modules</groupId>
            <artifactId>mule-apikit-module</artifactId>
            <version>2.2.0</version>
            <classifier>mule-plugin</classifier>
        </dependency>
    </dependencies>

</project>`;
  } */

  /**
   * Get default mule-artifact.json content
   */
  getDefaultMuleArtifact(apiName) {
    // Sanitize artifact name: replace spaces and special characters with hyphens, convert to lowercase
    // Mule artifact name MUST NOT contain spaces - this causes deployment errors
    const sanitizedName = apiName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
    return JSON.stringify({
      "minMuleVersion": "4.9.0",
      "requiredProduct": "MULE",
      "classifier": "mule-application",
      "groupId": "com.mulesoft",
      "assetId": sanitizedName,
      "version": "1.0.0-SNAPSHOT",
      "name": sanitizedName, // CRITICAL: name field MUST NOT contain spaces - use sanitized name
      "dependencies": []
    }, null, 2);
  }

  /**
   * Get default local-properties.yaml content
   */
  getDefaultLocalProperties() {
    return `# Local Environment Properties
# All values MUST be strings, including numeric values

# HTTP Listener Configuration
http:
  port: "8081"
  host: "0.0.0.0"

# API Configuration
api:
  baseUri: "http://localhost:8081/api"

# Logging
logging:
  level: "INFO"

# Environment-specific properties should be in:
# - dev-properties.yaml
# - qa-properties.yaml
# - prod-properties.yaml
`;
  }

  /**
   * Get default dev properties content (YAML format)
   */
  getDefaultDevProperties() {
    return `# Development Environment Properties
# All values MUST be strings, including numeric values

# HTTP Listener Configuration
http:
  port: "8081"
  host: "0.0.0.0"

# API Configuration
api:
  baseUri: "http://localhost:8081/api"

# Logging
logging:
  level: "DEBUG"

# Connector Connection Details (Dev Environment)
# TODO: Update the following properties with actual connection details for your dev environment

# Database Connection (if Database connector is used in global.xml)
# database:
#   url: "your_database_url"
#   driver: "com.mysql.cj.jdbc.Driver"
#   username: "your_database_username"
#   password: "your_database_password"

# Salesforce Connection (if Salesforce connector is used in global.xml)
# salesforce:
#   url: "your_salesforce_url"
#   username: "your_salesforce_username"
#   password: "your_salesforce_password"
#   securityToken: "your_salesforce_security_token"

# External API Endpoints (if HTTP requester is used in global.xml)
# external:
#   api:
#     baseUrl: "your_external_api_base_url"
#     timeout: "30000"
#     clientId: "your_client_id"
#     clientSecret: "your_client_secret"

# OAuth Configuration (if OAuth is used)
# oauth:
#   tokenUrl: "your_oauth_token_url"
#   clientId: "your_oauth_client_id"
#   clientSecret: "your_oauth_client_secret"
`;
  }

  /**
   * Get default QA properties content (YAML format)
   */
  getDefaultQaProperties() {
    return `# QA Environment Properties
# All values MUST be strings, including numeric values

# HTTP Listener Configuration
http:
  port: "8081"
  host: "0.0.0.0"

# API Configuration
api:
  baseUri: "http://qa-server:8081/api"

# Logging
logging:
  level: "INFO"

# Connector Connection Details (QA Environment)
# TODO: Update the following properties with actual connection details for your QA environment

# Database Connection (if Database connector is used in global.xml)
# database:
#   url: "your_database_url"
#   driver: "com.mysql.cj.jdbc.Driver"
#   username: "your_database_username"
#   password: "your_database_password"

# Salesforce Connection (if Salesforce connector is used in global.xml)
# salesforce:
#   url: "your_salesforce_url"
#   username: "your_salesforce_username"
#   password: "your_salesforce_password"
#   securityToken: "your_salesforce_security_token"

# External API Endpoints (if HTTP requester is used in global.xml)
# external:
#   api:
#     baseUrl: "your_external_api_base_url"
#     timeout: "30000"
#     clientId: "your_client_id"
#     clientSecret: "your_client_secret"

# OAuth Configuration (if OAuth is used)
# oauth:
#   tokenUrl: "your_oauth_token_url"
#   clientId: "your_oauth_client_id"
#   clientSecret: "your_oauth_client_secret"
`;
  }

  /**
   * Get default prod properties content (YAML format)
   */
  getDefaultProdProperties() {
    return `# Production Environment Properties
# All values MUST be strings, including numeric values

# HTTP Listener Configuration
http:
  port: "8081"
  host: "0.0.0.0"

# API Configuration
api:
  baseUri: "https://api.production.com/api"

# Logging
logging:
  level: "WARN"

# Connector Connection Details (Production Environment)
# TODO: Update the following properties with actual connection details for your production environment

# Database Connection (if Database connector is used in global.xml)
# database:
#   url: "your_database_url"
#   driver: "com.mysql.cj.jdbc.Driver"
#   username: "your_database_username"
#   password: "your_database_password"

# Salesforce Connection (if Salesforce connector is used in global.xml)
# salesforce:
#   url: "your_salesforce_url"
#   username: "your_salesforce_username"
#   password: "your_salesforce_password"
#   securityToken: "your_salesforce_security_token"

# External API Endpoints (if HTTP requester is used in global.xml)
# external:
#   api:
#     baseUrl: "your_external_api_base_url"
#     timeout: "60000"
#     clientId: "your_client_id"
#     clientSecret: "your_client_secret"

# OAuth Configuration (if OAuth is used)
# oauth:
#   tokenUrl: "your_oauth_token_url"
#   clientId: "your_oauth_client_id"
#   clientSecret: "your_oauth_client_secret"
`;
  }

  /**
   * Get default log4j2.xml content
   */
  getDefaultLog4j2() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Configuration>
    <Appenders>
        <Console name="Console" target="SYSTEM_OUT">
            <PatternLayout pattern="%-5p %d [%t] %c: %m%n"/>
        </Console>
    </Appenders>
    <Loggers>
        <Logger level="INFO" name="org.mule.runtime"/>
        <Logger level="INFO" name="com.mulesoft"/>
        <Root level="INFO">
            <AppenderRef ref="Console"/>
        </Root>
    </Loggers>
</Configuration>`;
  }

  /**
   * Get default .muleignore content
   */
  getDefaultMuleIgnore() {
    return `.classpath
.project
.settings/
target/
*.iml
.idea/
*.log
.DS_Store
`;
  }

  /**
   * Get default .gitignore content
   */
  getDefaultGitIgnore() {
    return `# Maven
target/
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup
pom.xml.next
release.properties
dependency-reduced-pom.xml
buildNumber.properties
.mvn/timing.properties
.mvn/wrapper/maven-wrapper.jar

# IDE
.idea/
*.iml
*.iws
*.ipr
.classpath
.project
.settings/
.vscode/

# OS
.DS_Store
Thumbs.db

# Logs
*.log

# Mule
.mule/

# Test Resources
src/test/resources/embedded*
`;
  }

  /**
   * Get default log4j2-test.xml content
   */
  getDefaultLog4j2Test() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Configuration>
    <Appenders>
        <Console name="Console" target="SYSTEM_OUT">
            <PatternLayout pattern="%-5p %d [%t] %c: %m%n"/>
        </Console>
    </Appenders>
    <Loggers>
        <Logger level="DEBUG" name="org.mule.runtime"/>
        <Logger level="DEBUG" name="com.mulesoft"/>
        <Root level="DEBUG">
            <AppenderRef ref="Console"/>
        </Root>
    </Loggers>
</Configuration>`;
  }
}

export default MuleCodeGenerationAgent;
