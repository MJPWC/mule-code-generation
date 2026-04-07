import LLMManager from "../llm/LLMManager.js";
import Config from "../config/config.js";
import { getEffectiveProviderAndModel } from "../llm/llmUtils.js";
import { getDocumentAnalysisSystemPrompt, getDocumentAnalysisUserPrompt } from "../config/ihldAnalysisRuleset.js";

export class IHLDProcessor {
  /**
   * Normalizes a value to an array of strings. Used so endpoints/integrationPoints are always safe for .join() in code gen.
   * @param {*} v - Value from LLM (array, string, or object with path/url/pathname).
   * @returns {string[]}
   */
  static _toStrArray(v) {
    if (v == null || v === undefined) return [];
    if (Array.isArray(v)) {
      return v
        .map((x) => {
          if (typeof x === 'string') return x.trim();
          if (x != null && typeof x === 'object' && (x.path != null || x.url != null || x.pathname != null))
            return String(x.path ?? x.url ?? x.pathname).trim();
          if (typeof x === 'number' || typeof x === 'boolean') return String(x);
          return null;
        })
        .filter((s) => s != null && s !== '' && s !== '[object Object]');
    }
    if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
    return [];
  }

  /**
   * Analyzes an Integration Design Document and identifies APIs that can be developed.
   * Returns analysis text and a list of suggested APIs.
   * @param {string} ihldContent - The content of the Integration Design Document.
   * @param {object} options - Options including LLM provider/model.
   * @returns {Promise<object>} An object containing analysis text and list of APIs.
   */
  static async analyzeIHLD(ihldContent, options = {}) {
    console.log('Starting IHLD analysis...');

    // Determine the effective provider and model, handling 'auto' selection
    // Use 'analysis' context to prioritize Groq → Gemini → Anthropic
    const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel(options.provider, options.model, 'analysis');
    console.log(`IHLDProcessor using LLM Provider: ${effectiveProvider}, Model: ${effectiveModel || 'default'}`);

    // Use the singleton LLMManager instance
    const llmManager = LLMManager.getInstance();

    const systemPrompt = getDocumentAnalysisSystemPrompt();
    const userPrompt = getDocumentAnalysisUserPrompt(ihldContent);

    const fallbackResponse = {
      analysis: "Integration Design Document Analysis: The document describes integration requirements. Analysis could not be fully completed (invalid or incomplete LLM response).",
      apis: [
        {
          name: "IntegrationAPI",
          type: "Process API",
          description: "Main integration API based on Integration Design Document requirements",
          endpoints: [],
          integrationPoints: []
        }
      ],
      isFallback: true
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          console.log('🔄 Retrying document analysis (attempt 2)...');
        }
        const response = await llmManager.chatCompletionsCreate({
          model: effectiveModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: 32000, // Extra headroom so full JSON (analysis + apis) is rarely truncated; prompts ask for concise analysis
          response_format: { type: "json_object" }
        });

        const content = response.choices[0].message.content;
        console.log('LLM Raw Response for Integration Design Document Analysis:', content.substring(0, 500) + '...');

        // Extract JSON from the response (handle markdown wrap and truncation)
        let jsonContent = content.trim();
        // Remove markdown code blocks: full block or opening only (when response truncated with no closing ```)
        if (jsonContent.includes("```json")) {
          const jsonMatch = jsonContent.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch) {
            jsonContent = jsonMatch[1].trim();
          } else {
            // Truncated response: no closing ``` — strip opening ```json and take the rest
            jsonContent = jsonContent.replace(/^```json\s*/i, "").trim();
          }
        } else if (jsonContent.includes("```")) {
          const codeMatch = jsonContent.match(/```[a-z]*\s*([\s\S]*?)\s*```/);
          if (codeMatch) {
            jsonContent = codeMatch[1].trim();
          } else {
            jsonContent = jsonContent.replace(/^```[a-z]*\s*/i, "").trim();
          }
        }
        // Start from first { in case of leading text
        const jsonStart = jsonContent.search(/\{/);
        if (jsonStart > 0) {
          jsonContent = jsonContent.substring(jsonStart);
        }
        
        // Find the matching closing brace
        let braceCount = 0;
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
            
            if (braceCount === 0 && jsonContent[0] === '{') {
              jsonEnd = i + 1;
              break;
            }
          }
        }
        
        jsonContent = jsonContent.substring(0, jsonEnd).trim();
        
        let llmOutput;
        try {
          llmOutput = JSON.parse(jsonContent);
        } catch (parseError) {
          console.error('❌ Failed to parse JSON from Integration Design Document analysis response');
          console.error('Parse error:', parseError.message);
          throw new Error(`Failed to parse LLM response as JSON. Extracted content: ${jsonContent.substring(0, 200)}...`);
        }

        // Validate response structure
        if (!llmOutput.analysis || typeof llmOutput.analysis !== 'string') {
          throw new Error("LLM response must include 'analysis' as a string.");
        }
        if (!llmOutput.apis || !Array.isArray(llmOutput.apis)) {
          throw new Error("LLM response must include 'apis' as an array.");
        }
        if (llmOutput.apis.length === 0) {
          throw new Error(
            "No APIs could be identified from the document. Please ensure the document describes at least one API with a clear name, type, and purpose, then try analyzing again."
          );
        }

        // Validate each API object and normalize shape for code generation (fixes loophole #1: endpoints/integrationPoints must be string arrays)
        const normalizedApis = llmOutput.apis.map((api) => {
          if (!api.name || typeof api.name !== 'string') {
            throw new Error("Each API must have 'name' as a string.");
          }
          if (!api.type || typeof api.type !== 'string') {
            throw new Error("Each API must have 'type' as a string.");
          }
          if (!api.description || typeof api.description !== 'string') {
            throw new Error("Each API must have 'description' as a string.");
          }
          return {
            name: api.name.trim(),
            type: api.type.trim(),
            description: api.description.trim(),
            endpoints: IHLDProcessor._toStrArray(api.endpoints),
            integrationPoints: IHLDProcessor._toStrArray(api.integrationPoints)
          };
        });

        console.log(`✅ Integration Design Document analysis complete. Found ${normalizedApis.length} APIs.`);
        return {
          analysis: llmOutput.analysis,
          apis: normalizedApis
        };
      } catch (error) {
        console.error(`❌ Document analysis attempt ${attempt} failed:`, error.message);
        if (attempt === 2) {
          console.warn('⚠️ Using fallback response after retry. Consider re-analyzing or adding more detail to the document.');
          return fallbackResponse;
        }
      }
    }

    return fallbackResponse;
  }

  /**
   * Synthesizes RAML specification for a specific API using Integration Design Document analysis and API details.
   * This method focuses on generating RAML for only the selected API, using its specific details from the analysis.
   * @param {string} ihldContent - The content of the Integration Design Document.
   * @param {object} apiDetails - The API details from the Integration Design Document analysis (name, type, description, endpoints, integrationPoints).
   * @param {string} ihldAnalysis - The comprehensive Integration Design Document analysis text.
   * @param {object} options - Options including LLM provider/model.
   * @returns {Promise<string>} The synthesized RAML specification for the selected API.
   */
  static async synthesizeRamlForApi(ihldContent, apiDetails, ihldAnalysis, options = {}) {
    console.log(`Starting RAML synthesis for API: ${apiDetails.name}...`);

    // Ensure endpoints and integrationPoints are always string arrays (defensive: avoids .join() throw from wrong LLM shape)
    const safeEndpoints = IHLDProcessor._toStrArray(apiDetails.endpoints);
    const safeIntegrationPoints = IHLDProcessor._toStrArray(apiDetails.integrationPoints);
    const safeApiDetails = {
      ...apiDetails,
      endpoints: safeEndpoints,
      integrationPoints: safeIntegrationPoints
    };

    // Determine the effective provider and model, handling 'auto' selection
    // Use 'analysis' context to prioritize Groq → Gemini → Anthropic for RAML synthesis
    const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel(options.provider, options.model, 'analysis');
    console.log(`RAML Synthesis using LLM Provider: ${effectiveProvider}, Model: ${effectiveModel || 'default'}`);

    // Use the singleton LLMManager instance
    const llmManager = LLMManager.getInstance();

    const systemPrompt = `You are an expert in MuleSoft and RAML API design. Your task is to synthesize a complete RAML 1.0 specification for a specific API based on the Integration Design Document and API details provided.

CRITICAL: You MUST respond with ONLY valid RAML 1.0 content. Do NOT include any explanatory text, comments, markdown code blocks, or JSON before or after the RAML. Your response must start directly with "#%RAML 1.0" and contain only valid RAML 1.0 syntax.

Requirements for the RAML specification:
- Must be valid RAML 1.0 syntax starting with "#%RAML 1.0"
- Include title, version, baseUri (if applicable), and mediaType
- CRITICAL: ONLY include endpoints/resources that are explicitly mentioned in the API details from the Integration Design Document
- DO NOT add additional endpoints that are not specified in the Integration Design Document
- DO NOT infer or assume additional endpoints based on common patterns
- EXCEPTION: Include a health check endpoint (/health or /healthcheck) as a standard best practice, even if not mentioned in the Integration Design Document
- The health check endpoint should be a GET endpoint that returns a simple JSON response (e.g., {"status": "UP"})
- Include HTTP methods (GET, POST, PUT, DELETE, etc.) only for the endpoints specified in the API details (plus the health check endpoint)
- Include request/response schemas or examples where possible
- Include security schemes if mentioned in Integration Design Document (OAuth 2.0, Basic Auth, etc.)
- Include query parameters, path parameters, and headers as described in the Integration Design Document
- Use proper RAML 1.0 data types and structures
- Include examples for request and response bodies when possible

The RAML should be comprehensive and production-ready, strictly adhering to the endpoints specified in the Integration Design Document, plus a standard health check endpoint.`;

    // Build context with API-specific details only; use short excerpts to avoid token overflow (loophole #6)
    const MAX_ANALYSIS_EXCERPT_RAML = 1500;
    const MAX_DOCUMENT_EXCERPT_RAML = 2000;
    const truncate = (s, maxLen) => (s && s.length > maxLen ? s.substring(0, maxLen) + "\n...[excerpt truncated]" : s || "");
    const analysisExcerpt = truncate(ihldAnalysis, MAX_ANALYSIS_EXCERPT_RAML);
    const documentExcerpt = truncate(ihldContent, MAX_DOCUMENT_EXCERPT_RAML);

    const apiContext = `
API Details (use these as the primary source for this API):
- API Name: ${safeApiDetails.name}
- API Type: ${safeApiDetails.type}
- Description: ${safeApiDetails.description}
${safeApiDetails.endpoints.length > 0 ? `- Endpoints: ${safeApiDetails.endpoints.join(', ')}` : ''}
${safeApiDetails.integrationPoints.length > 0 ? `- Integration Points: ${safeApiDetails.integrationPoints.join(', ')}` : ''}
${analysisExcerpt ? `\nDocument analysis (excerpt):\n${analysisExcerpt}` : ""}
${documentExcerpt ? `\nDocument (excerpt):\n${documentExcerpt}` : ""}
`;

    const userPrompt = `Based on the Integration Design Document, analysis, and the specific API details provided above, synthesize a complete RAML 1.0 specification for the API named "${safeApiDetails.name}".

CRITICAL INSTRUCTIONS:
- Focus ONLY on this specific API. Do not include other APIs or processes.
- ONLY include endpoints that are explicitly listed in the API details above
- DO NOT add additional endpoints beyond what is specified in the Integration Design Document
- EXCEPTION: Include a health check endpoint (/health or /healthcheck) as a standard best practice, even if not mentioned in the Integration Design Document
- The health check endpoint should be a GET endpoint that returns a simple JSON response (e.g., {"status": "UP"})
- Strictly follow the endpoints provided in the API details section above, plus add the standard health check endpoint

IMPORTANT: Respond with ONLY valid RAML 1.0 content. Start your response directly with "#%RAML 1.0". Do NOT wrap it in markdown code blocks or add any explanatory text.`;

    try {
      const response = await llmManager.chatCompletionsCreate({
        model: effectiveModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 12000, // Increased for comprehensive RAML generation with complex APIs
      });

      const content = response.choices[0].message.content;
      console.log('LLM Raw Response for RAML Synthesis:', content.substring(0, 500) + '...');

      // Extract RAML from the response
      let ramlContent = content.trim();
      
      // Remove markdown code blocks if present
      if (ramlContent.includes("```raml")) {
        const ramlMatch = ramlContent.match(/```raml\s*([\s\S]*?)\s*```/);
        if (ramlMatch) {
          ramlContent = ramlMatch[1].trim();
        }
      } else if (ramlContent.includes("```")) {
        const codeMatch = ramlContent.match(/```[a-z]*\s*([\s\S]*?)\s*```/);
        if (codeMatch) {
          ramlContent = codeMatch[1].trim();
        }
      }
      
      // Ensure it starts with RAML declaration
      if (!ramlContent.startsWith("#%RAML 1.0")) {
        // Try to find RAML content
        const ramlStart = ramlContent.search(/#%RAML 1\.0/);
        if (ramlStart >= 0) {
          ramlContent = ramlContent.substring(ramlStart);
        } else {
          // If no RAML declaration found, prepend it
          ramlContent = `#%RAML 1.0\n${ramlContent}`;
        }
      }

      console.log(`✅ RAML synthesis complete for API: ${apiDetails.name}`);
      return ramlContent;

    } catch (error) {
      console.error(`❌ Error synthesizing RAML for API ${apiDetails.name}:`, error);
      // Fallback: Generate a basic RAML structure
      const fallbackRaml = `#%RAML 1.0
title: ${safeApiDetails.name}
version: v1
baseUri: https://api.example.com/${safeApiDetails.name.toLowerCase().replace(/\s+/g, '-')}
mediaType: application/json

/${safeApiDetails.endpoints.length > 0 ? safeApiDetails.endpoints[0].replace(/^\//, '') : 'resource'}:
  get:
    description: ${safeApiDetails.description}
    responses:
      200:
        body:
          application/json:
            example: { "message": "Success" }`;
      return fallbackRaml;
    }
  }

  /**
   * Identifies Mule processes within an Integration Design Document using an LLM.
   * @param {string} ihldContent - The content of the Integration Design Document.
   * @param {object} options - Options including LLM provider/model and existing answers.
   * @returns {Promise<object>} An object containing either identified processes or clarifying questions.
   */
  static async identifyMuleProcesses(ihldContent, options = {}) {
    console.log('Starting LLM-powered Integration Design Document processing...');

    // Determine the effective provider and model, handling 'auto' selection
    // Use 'analysis' context to prioritize Groq → Gemini → Anthropic
    const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel(options.provider, options.model, 'analysis');
    console.log(`IHLDProcessor using LLM Provider: ${effectiveProvider}, Model: ${effectiveModel || 'default'}`);

    // Use the singleton LLMManager instance, ensuring all configured providers are available
    const llmManager = LLMManager.getInstance();

    const existingAnswers = options.questionAnswers || [];
    const answersContext = existingAnswers.length > 0
      ? `\nExisting Clarifications (from user):\n${existingAnswers.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n')}`
      : '';

    const systemPrompt = `You are an expert in MuleSoft and Integrations. Your task is to analyze an Integration Design Document and identify distinct MuleSoft integration processes described within it. For each identified process, extract its type (e.g., "RAML API", "Scheduled Job", "File Poller", "Database Sync") and relevant details. If a RAML API is identified, try to synthesize a basic RAML specification for it, including title, version, and at least one endpoint.

CRITICAL: You MUST respond with ONLY valid JSON. Do NOT include any explanatory text, comments, or markdown formatting before or after the JSON. Your response must start with either '[' or '{' and contain only valid JSON.

If you have sufficient information, respond with a JSON array, where each object represents a Mule process. Each object should have 'type' (string) and 'details' (object). For 'RAML API' type, 'details' should include 'name' and 'raml'. For 'Scheduled Job', 'details' should include 'name'.

If you require more information to accurately identify or detail the Mule processes, respond with a JSON object containing a 'questions' array. Each question object should have 'id' (unique string), 'question' (string), and 'type' (e.g., 'text', 'dropdown').

Example Output for identified processes:
[
  {
    "type": "raml-api",
    "details": {
      "name": "CustomerApi",
      "raml": "#%RAML 1.0\ntitle: CustomerApi\nversion: 1.0.0\n/customers:\n  get:\n    responses:\n      200:\n        body:\n          application/json:\n            example: { \"message\": \"Get all customers\" }"
    }
  },
  {
    "type": "scheduled-job",
    "details": {
      "name": "InventorySyncJob"
    }
  }
]

Example Output for clarifying questions:
{
  "questions": [
    { "id": "process_scope", "question": "What is the primary business process this integration supports?", "type": "text" },
    { "id": "integration_style", "question": "What integration style is preferred (e.g., API-led, event-driven, batch)?", "type": "dropdown", "options": ["API-led", "Event-driven", "Batch"] }
  ]
} `;

    const userPrompt = `Analyze the following Integration Design Document and identify MuleSoft processes. Consider existing clarifications:${answersContext}

Integration Design Document:
${ihldContent}

IMPORTANT: Respond with ONLY valid JSON. Do NOT include any explanatory text before or after the JSON. Start your response directly with '[' or '{'.`;

    try {
      const response = await llmManager.chatCompletionsCreate({
        model: effectiveModel, // Use the effectiveModel determined by the utility function
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 4000 // Adjust as needed
      });

      const content = response.choices[0].message.content;
      console.log('LLM Raw Response:', content);

      // Extract JSON from the response, handling various formats
      let jsonContent = content.trim();
      
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
      
      let llmOutput;
      try {
        llmOutput = JSON.parse(jsonContent);
      } catch (parseError) {
        console.error('❌ Failed to parse JSON from LLM response');
        console.error('Extracted JSON content:', jsonContent.substring(0, 500));
        console.error('Parse error:', parseError.message);
        throw new Error(`Failed to parse LLM response as JSON. The LLM may have returned explanatory text. Extracted content: ${jsonContent.substring(0, 200)}...`);
      }

      if (llmOutput.questions && Array.isArray(llmOutput.questions)) {
        // LLM returned questions
        return { type: "questions", questions: llmOutput.questions };
      } else if (Array.isArray(llmOutput)) {
        // LLM returned identified processes
        // Basic validation of the parsed output structure
        if (!Array.isArray(llmOutput)) {
          throw new Error("LLM response is not a JSON array.");
        }
        for (const p of llmOutput) {
          if (!p.type || !p.details) {
            throw new Error("Each process object must have 'type' and 'details'.");
          }
          if (p.type === "raml-api" && (!p.details.name || !p.details.raml)) {
            throw new Error("RAML API process details must include 'name' and 'raml'.");
          }
          if (p.type === "scheduled-job" && !p.details.name) {
            throw new Error("Scheduled Job process details must include 'name'.");
          }
        }
        return { type: "processes", processes: llmOutput };
      } else {
        throw new Error("LLM response is neither an array of processes nor a questions object.");
      }

    } catch (error) {
      console.error('❌ Error identifying Mule processes with LLM:', error);
      // Fallback to simple keyword matching if LLM fails or returns invalid format
      const processes = [];
      if (ihldContent.toLowerCase().includes("scheduled job")) {
        processes.push({ type: "scheduled-job", details: { name: "MyScheduledJob" } });
      }
      if (ihldContent.toLowerCase().includes("raml api")) {
        processes.push({ type: "raml-api", details: { name: "MyRamlApi", raml: "#%RAML 1.0\ntitle: MyApi\n/resource:\n  get:\n    responses:\n      200:" } });
      }
      return { type: "processes", processes: processes };
    }
  }
}
