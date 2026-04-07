import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import Config from "../src/config/config.js"; // Only Config is needed
import { handleMuleCodeDownload } from "../src/mule/mule_code_download.js";
import { IHLDProcessor } from "../src/ihld/IHLDProcessor.js";
import MuleCodeGenerationAgent from "../src/agent/MuleCodeGenerationAgent.js"; // Corrected to default import
import { getEffectiveProviderAndModel } from "../src/llm/llmUtils.js"; // Corrected import path
import LLMManager from "../src/llm/LLMManager.js";
import { extractRamlFromFile } from "../src/utils/ramlExtractor.js";

// Set LOG_LEVEL for better console logging
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'debug';
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Store active WebSocket connections per session
const activeConnections = new Map();

// Store conversation history per session (still useful for general interactions if any)
const sessionConversations = new Map();

// Store pending IHLD questions (clarifying Q&A) per session
const pendingIHLDQuestions = new Map(); // sessionId -> { questions, ihldContent, options }
const pendingMuleFlowQuestions = new Map(); // sessionId -> { questions, ramlContent, options }

// Store per-API Mule code content (for IHLD multiple apps scenario)
const sessionMuleCodeByApi = new Map(); // sessionId -> { apiId: muleProject }

// Store IHLD analysis and API details per session
const sessionIHLDAnalysis = new Map(); // sessionId -> { analysis, apis, ihldContent, options }

/**
 * Normalize API name for flexible matching (trim, collapse whitespace, lowercase).
 * Used so "Customer API", "CustomerAPI", "customer api" all match the same API.
 * @param {string} name - API name from client or from analysis.
 * @returns {string}
 */
function normalizeApiNameForMatch(name) {
  if (name == null || typeof name !== "string") return "";
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Find an API in the list by name using flexible matching (handles spacing/casing differences).
 * @param {Array<{ name: string }>} apis - List of APIs from analysis.
 * @param {string} apiName - Name sent by client (e.g. from selected API).
 * @returns {object|undefined} The matching API object or undefined.
 */
function findApiByName(apis, apiName) {
  if (!Array.isArray(apis) || apis.length === 0) return undefined;
  const normalized = normalizeApiNameForMatch(apiName);
  if (!normalized) return undefined;
  return apis.find((api) => normalizeApiNameForMatch(api.name) === normalized);
}

/**
 * Returns true if the API is RAML-based (needs RAML synthesis when user doesn't upload RAML).
 * Mirrors client IHLDAnalysisViewer logic: non-RAML types (scheduled, batch, file) → false;
 * has valid endpoints or description suggests REST → true.
 * @param {object} api - API details from IHLD analysis.
 * @returns {boolean}
 */
function isRamlBasedApi(api) {
  const searchText = [
    api.type || "",
    api.name || "",
    api.description || ""
  ].join(" ").toLowerCase().trim().replace(/[^a-z0-9\s]/g, " ");

  const nonRamlKeywords = [
    "scheduled", "event-driven", "eventdriven", "file-based", "filebased",
    "filepoller", "file poller", "quartz", "cron"
  ];
  const nonRamlBatchPhrases = [
    "batch job", "batch processing", "batch run", "batch scheduler",
    "scheduled batch", "batch integration"
  ];
  for (const keyword of nonRamlKeywords) {
    const keywordPattern = new RegExp(`\\b${keyword.replace(/-/g, "[-\\s]?")}\\b|${keyword}`, "i");
    if (keywordPattern.test(searchText)) return false;
  }
  for (const phrase of nonRamlBatchPhrases) {
    if (searchText.includes(phrase.replace(/\s+/g, " "))) return false;
  }
  if (searchText.includes("job") && !searchText.includes("api")) return false;
  if (api.type) {
    const apiTypeLower = String(api.type).toLowerCase().trim();
    if (apiTypeLower.includes("process api") && searchText.includes("scheduled")) return false;
  }

  const hasValidEndpoints = (a) => {
    if (!a.endpoints) return false;
    if (Array.isArray(a.endpoints)) {
      const toEpStr = (ep) => {
        if (ep == null) return "";
        if (typeof ep === "string") return ep.trim();
        if (typeof ep === "object" && (ep.path != null || ep.url != null)) return String(ep.path || ep.url || "").trim();
        return String(ep).trim();
      };
      const valid = a.endpoints.filter(ep => {
        const epStr = toEpStr(ep).toUpperCase();
        return epStr !== "" && epStr !== "N/A" && epStr !== "NULL" && epStr !== "UNDEFINED";
      });
      return valid.length > 0;
    }
    if (typeof a.endpoints === "string") {
      const s = a.endpoints.trim().toUpperCase();
      return s !== "N/A" && !s.includes("N/A") && s.length > 0;
    }
    return false;
  };
  if (hasValidEndpoints(api)) return true;

  const desc = (api.description || "").toLowerCase();
  if (desc.trim()) {
    const hints = ["endpoint", "endpoints", "/api/", "http", "rest", "resource", "url", "path"];
    if (hints.some(h => desc.includes(h))) return true;
    if (/\/([a-z0-9-]+)(\/\{[^}]+\})?/i.test(desc)) return true;
  }
  return false;
}

/**
 * Summarize large RAML/IHLD input with an LLM before code generation.
 * DISABLED: Document analysis already runs on the full document and its output is used for code generation;
 * pre-summarizing would reduce fidelity. Pass-through only.
 */
async function summarizeLargeInputIfNeeded(rawInput, { fileType, sessionId }) {
  if (!rawInput || !rawInput.trim()) return rawInput;
  const kind = fileType === "ihld" ? "Integration Design Document" : "RAML";
  console.log(`📏 Summarization disabled - using original ${kind} input directly (${rawInput.length} chars)`);
  return rawInput;
}

// NO LONGER NEEDED:
// const pendingApproaches = new Map(); // sessionId -> { approaches, requirements, options }
// const pendingQuestions = new Map(); // sessionId -> { questions, requirements, options }
// const pendingDocQuestions = new Map(); // sessionId -> { questions, context, requirements, options }
// const sessionOutputs = new Map(); // sessionId -> { architecture, raml, diagram, estimation }
// const sessionRamlByApi = new Map(); // sessionId -> { apiId: ramlContent }
// const deliveredApproaches = new Set();
// const pendingProgressEvents = new Map(); // sessionId -> progressEvent[]
// const pendingDocumentationReady = new Map(); // sessionId -> { content, docType, message }

app.get('/api/models/available', async (req, res) => {
  try {
    const models = {
      gemini: !!process.env.GEMINI_API_KEY,
      groq: !!process.env.GROQ_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
      ollama: true // Assuming Ollama is always available locally
    };
    res.json(models);
  } catch (error) {
    console.error('Error checking model availability:', error);
    res.status(500).json({ error: 'Failed to check model availability' });
  }
});

// API endpoint to process user input (routes to appropriate agent)
app.post("/api/process", async (req, res) => {
  const { input, apiName, saveFiles, sessionId: providedSessionId, provider, model, fileType, isDocx, fileName } = req.body;

  console.log("📥 Received input:");
  console.log("  Input length:", input?.length || 0);
  console.log("  API Name:", apiName || "MuleSoftAPI");
  console.log("  Save Files:", saveFiles !== false);
  console.log("  Provided Session ID:", providedSessionId || "none");
  console.log("  Provider:", provider || "default(.env)");
  console.log("  Model:", model || "default");
  console.log("  File Type:", fileType || "none");
  console.log("  Is DOCX:", isDocx || false);
  console.log("  File Name:", fileName || "none");

  // Now, input is always required for initial processing.
  if (!input || !input.trim()) {
    return res.status(400).json({ error: "Input (RAML/Integration Design Document) is required" });
  }

  // Extract text from .docx file if needed
  let processedInput = input.trim();
  if (isDocx) {
    try {
      const mammoth = await import('mammoth');
      const buffer = Buffer.from(input, 'base64');
      const result = await mammoth.extractRawText({ buffer: buffer });
      processedInput = result.value;
      console.log("✅ Extracted text from .docx file. Length:", processedInput.length);
    } catch (error) {
      console.error("❌ Error extracting text from .docx:", error);
      return res.status(400).json({ error: `Failed to extract text from .docx file: ${error.message}` });
    }
  }

  // Use provided sessionId or create new one
  const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Initialize conversation history if new session
  if (!sessionConversations.has(sessionId)) {
    sessionConversations.set(sessionId, []);
  }

  console.log("  Session ID:", sessionId);
  console.log("  Conversation history length:", sessionConversations.get(sessionId).length);

  res.json({ sessionId, message: "Processing started" });

  // Wait a bit for WebSocket connection to be established
  setTimeout(() => {
    // Get conversation history for this session
    const conversationHistory = sessionConversations.get(sessionId) || [];

    // Process input directly using MuleCodeGenerationAgent or Integration Design Document Processor
    const socket = activeConnections.get(sessionId);
    
    // Use processedInput (already extracted from .docx if needed)
    processInputAndGenerateMuleCode(sessionId, processedInput, {
      apiName: apiName || "MuleSoftAPI",
      saveFiles: saveFiles !== false,
      conversationHistory: conversationHistory, // Pass conversation history
      provider,
      model,
      fileType // Pass fileType to determine processing logic
    }, socket);

  }, 500);
});

// API endpoint to generate and download Mule code for a specific API
app.post('/api/mule-code/generate', async (req, res) => {
  try {
    const { sessionId, apiName, projectName } = req.body || {}; // apiId is not directly used for download anymore, project name is used.

    if (!sessionId || !apiName) {
      return res.status(400).json({ error: 'sessionId and apiName are required' });
    }

    // Retrieve the generated Mule project for the given session and apiName (from IHLD multiple projects scenario)
    const apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
    const muleProject = apiMuleCodeMap[apiName]; // Key by apiName for IHLD multiple projects

    if (!muleProject || !muleProject.files || muleProject.files.length === 0) {
      return res.status(404).json({ error: 'No Mule project found for the specified API and session. Please generate Mule code first.' });
    }

    const effectiveProjectName =
      projectName ||
      (apiName && String(apiName).replace(/\s+/g, '-')) ||
      'mule-project';

    // Generate ZIP file
    const result = await handleMuleCodeDownload(muleProject, effectiveProjectName);

    if (!result || !result.success) {
      return res.status(500).json({ error: result?.error || 'Failed to generate Mule code ZIP file' });
    }

    const { zipFilePath, zipFileName, size } = result;
    const stat = fs.statSync(zipFilePath);
    const filename = zipFileName || `${effectiveProjectName}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', size || stat.size);

    const readStream = fs.createReadStream(zipFilePath);
    readStream.on('error', (err) => {
      console.error('❌ Error streaming Mule code ZIP file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream Mule code ZIP file' });
      }
    });

    return readStream.pipe(res);
  } catch (error) {
    console.error('❌ Error in Mule code generation endpoint:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * Orchestrates input processing and Mule code generation based on file type.
 * This replaces the previous `processInput` function which relied on AgentManager.
 * @param {string} sessionId - The current session ID.
 * @param {string} input - The user input (RAML or IHLD content).
 * @param {object} options - Options including API name, save files, conversation history, LLM provider, model, and file type.
 * @param {object} socket - The socket.io instance for communication.
 */
async function processInputAndGenerateMuleCode(sessionId, input, options, socket = null) {
  console.log(`\n🚀 Processing input for session: ${sessionId}`);
  console.log(`📝 Input: ${input.substring(0, 100)}...`);
  console.log(`⚙️ Options:`, options);

  options = { ...options, sessionId };

  try {
    if (options.fileType === 'ihld') {
      // IHLD: only run document analysis and show results. Do NOT create MuleCodeGenerationAgent.
      // Code generation runs later when user clicks Generate for an API (separate socket/API handlers).
      console.log('Detected Integration Design Document. Initiating analysis...');
      await analyzeIHLDAndDisplayResults(sessionId, input, options, socket);
      return;
    }

    if (options.fileType === 'raml') {
      const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel(options.provider, options.model, 'code-generation');
      console.log(`Using LLM Provider: ${effectiveProvider}, Model: ${effectiveModel || 'default'}`);
      const muleCodeAgent = new MuleCodeGenerationAgent(new Config({ provider: effectiveProvider, model: effectiveModel }));

      if (socket) {
        socket.emit("progress", { type: "info", message: "Detected RAML. Initiating Mule flow clarification process..." });
        console.log(`💡 Processing RAML for session ${sessionId}. Generating dynamic questions...`);
        try {
          const summarizedRaml = await summarizeLargeInputIfNeeded(input, { fileType: 'raml', sessionId });
          const questions = await muleCodeAgent._generateDynamicMuleFlowQuestions(summarizedRaml);
          pendingMuleFlowQuestions.set(sessionId, { questions, ramlContent: summarizedRaml, apiName: options.apiName || 'MuleSoftAPI' });
          socket.emit("mule-flow-questions-ready", { questions, sessionId });
          socket.emit("progress", { type: "waiting", message: "Waiting for Mule flow clarifications...", waitingFor: "mule-flow-questions" });
          console.log(`❓ Dynamic Mule flow questions generated for session ${sessionId}, waiting for user answers`);
        } catch (error) {
          console.error(`❌ Error generating dynamic Mule flow questions for session ${sessionId}:`, error);
          socket.emit("error", { message: `Failed to generate Mule flow questions: ${error.message}` });
        }
      }
      return;
    }

    if (socket) {
      socket.emit("error", { message: "Unsupported file type detected. Please upload RAML or Integration Design Document." });
    }
    console.error(`❌ Unsupported file type: ${options.fileType} for session ${sessionId}`);
  } catch (error) {
    console.error(`❌ Error processing input for session ${sessionId}:`, error);
    if (socket) {
      socket.emit("error", { message: `Processing failed: ${error.message}` });
    }
  }
}

/**
 * Analyzes IHLD content and displays analysis with suggested APIs to the user.
 * @param {string} sessionId - The current session ID.
 * @param {string} ihldContent - The content of the IHLD file.
 * @param {object} options - Additional options.
 * @param {object} socket - The socket.io instance for communication.
 */
async function analyzeIHLDAndDisplayResults(sessionId, ihldContent, options, socket) {
  // Note: Provider/model selection is handled inside IHLDProcessor.analyzeIHLD with 'analysis' context
  // This ensures Groq → Gemini → Anthropic priority for analysis

  try {
    if (socket) {
      socket.emit("progress", { type: "info", message: "Analyzing Integration Design Document..." });
    }
    console.log(`🔍 Analyzing Integration Design Document for session ${sessionId}...`);

    // Summarize large Integration Design Document before analysis
    const summarizedIHLD = await summarizeLargeInputIfNeeded(ihldContent, { fileType: 'ihld', sessionId });

    // Call the new analysis method
    const analysisResult = await IHLDProcessor.analyzeIHLD(
      summarizedIHLD,
      { provider: options.provider, model: options.model }
    );

    // Store analysis in session for later use during code generation
    sessionIHLDAnalysis.set(sessionId, {
      analysis: analysisResult.analysis,
      apis: analysisResult.apis,
      ihldContent: summarizedIHLD,
      options: options,
      isFallback: analysisResult.isFallback === true
    });

    // Emit analysis and API list to UI
    if (socket) {
      socket.emit("ihld-analysis-ready", {
        analysis: analysisResult.analysis,
        apis: analysisResult.apis,
        sessionId: sessionId,
        isFallback: analysisResult.isFallback === true
      });
      if (analysisResult.isFallback) {
        socket.emit("warning", {
          message: "Analysis could not be fully completed; a generic API list was used. Consider re-analyzing or adding more detail to your document."
        });
      }
      socket.emit("progress", { type: "complete", message: `Integration Design Document analysis complete. Found ${analysisResult.apis.length} API(s).` });
    }
    console.log(`✅ Integration Design Document analysis complete for session ${sessionId}. Found ${analysisResult.apis.length} API(s).`);

  } catch (error) {
    console.error(`❌ Error analyzing Integration Design Document for session ${sessionId}:`, error);
    if (socket) {
      socket.emit("error", { message: `Integration Design Document analysis failed: ${error.message}` });
    }
  }
}

/**
 * Processes Integration Design Document content and orchestrates Mule code generation for identified processes.
 * @param {string} sessionId - The current session ID.
 * @param {string} ihldContent - The content of the Integration Design Document file.
 * @param {string} baseApiName - The base API name.
 * @param {object} options - Additional options.
 * @param {object} socket - The socket.io instance for communication.
 */
async function processIHLDAndGenerateMuleCode(sessionId, ihldContent, baseApiName, options, socket) {
  // Determine the effective provider and model for code generation
  // Use 'code-generation' context to prioritize Anthropic first
  const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel(options.provider, options.model, 'code-generation');
  console.log(`IHLD Code Generation using LLM Provider: ${effectiveProvider}, Model: ${effectiveModel || 'default'}`);

  try {
    if (socket) {
      socket.emit("progress", { type: "info", message: "Processing Integration Design Document..." });
    }
    console.log(`🔄 Processing Integration Design Document for session ${sessionId}...`);

    // Summarize large Integration Design Document before identifying Mule processes
    const summarizedIHLD = await summarizeLargeInputIfNeeded(ihldContent, { fileType: 'ihld', sessionId });

    const ihldProcessingResult = await IHLDProcessor.identifyMuleProcesses(
      summarizedIHLD,
      { provider: options.provider, model: options.model, questionAnswers: options.questionAnswers }
    );

    if (ihldProcessingResult.type === "questions") {
      pendingIHLDQuestions.set(sessionId, { questions: ihldProcessingResult.questions, ihldContent: summarizedIHLD, options });
      if (socket) {
        socket.emit("ihld-questions-ready", { questions: ihldProcessingResult.questions });
        socket.emit("progress", { type: "info", message: "Additional questions needed for Integration Design Document processing." });
        socket.emit("progress", { type: "waiting", message: "Waiting for Integration Design Document clarifications...", waitingFor: "ihld-questions" });
      }
      console.log(`❓ Integration Design Document questions generated for session ${sessionId}, waiting for user answers`);
      return; // Stop processing and wait for answers
    }

    const identifiedProcesses = ihldProcessingResult.processes;
    const generatedProjects = [];

    for (const process of identifiedProcesses) {
      if (process.type === "scheduled-job") {
        if (socket) {
          socket.emit("progress", { type: "info", message: `Identified Scheduled Job: ${process.details.name}. Generating code...` });
        }
        console.log(`Generating code for scheduled job: ${process.details.name}`);

        // Direct instantiation of MuleCodeGenerationAgent
        const muleCodeAgent = new MuleCodeGenerationAgent(new Config({ provider: effectiveProvider, model: effectiveModel }));
        const scheduledJobXml = muleCodeAgent._generateScheduledJobCode(process.details.name, process.details);
        
        generatedProjects.push({
          apiName: process.details.name,
          files: [{ path: `src/main/mule/${process.details.name}.xml`, content: scheduledJobXml }]
        });

        // Store the generated project for download (keyed by apiName)
        let apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
        apiMuleCodeMap[process.details.name] = generatedProjects[generatedProjects.length - 1];
        sessionMuleCodeByApi.set(sessionId, apiMuleCodeMap);

      } else if (process.type === "raml-api") {
        if (socket) {
          socket.emit("progress", { type: "info", message: `Identified RAML API: ${process.details.name}. Generating code...` });
        }
        console.log(`Generating code for RAML API: ${process.details.name}`);

        const muleCodeAgent = new MuleCodeGenerationAgent(new Config({ provider: effectiveProvider, model: effectiveModel }));
        const muleProject = await muleCodeAgent.generateMuleCode(
          process.details.raml,
          process.details.name,
          {},
          { sessionId }
        );

        // Explicitly add the synthesized RAML as a file to the project
        if (process.details.raml) {
          muleProject.files.push({
            path: `src/main/resources/api/${process.details.name}.raml`, // Use API name for RAML file
            content: process.details.raml
          });
        }
        generatedProjects.push({ apiName: process.details.name, files: muleProject.files });

        // Store the generated project for download (keyed by apiName)
        let apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
        apiMuleCodeMap[process.details.name] = muleProject;
        sessionMuleCodeByApi.set(sessionId, apiMuleCodeMap);
      }
    }

    if (generatedProjects.length > 0) {
      if (socket) {
        socket.emit("mule-code-generated", {
          apiName: baseApiName,
          muleCodeContent: generatedProjects,
          sessionId: sessionId
        });
        socket.emit("progress", { type: "complete", message: `Generated code for ${generatedProjects.length} processes from Integration Design Document!` });
      }
      console.log(`✅ Generated code for ${generatedProjects.length} processes from Integration Design Document for session ${sessionId}`);
    } else {
      if (socket) {
        socket.emit("error", { message: "No identifiable Mule processes found in Integration Design Document." });
      }
      console.log(`❌ No identifiable Mule processes found in Integration Design Document for session ${sessionId}`);
    }

  } catch (error) {
    console.error(`❌ Error processing Integration Design Document for session ${sessionId}:`, error);
    if (socket) {
      socket.emit("error", { message: `Integration Design Document processing failed: ${error.message}` });
    }
  }
}

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join-session", (sessionId) => {
    activeConnections.set(sessionId, socket);
    socket.join(sessionId);
    console.log(`✅ Client ${socket.id} joined session ${sessionId}`);
    console.log(`📊 Active sessions: ${activeConnections.size}`);

    // Send confirmation
    socket.emit("session-joined", { sessionId, message: "Connected to generation session" });

    // If there are any pending events for this session (emitted before the client joined),
    // immediately deliver them now to avoid race conditions.
    try {
      const pendingIHLD = pendingIHLDQuestions.get(sessionId);
      if (pendingIHLD && Array.isArray(pendingIHLD.questions) && pendingIHLD.questions.length > 0) {
        console.log(`❓ Delivering pending Integration Design Document questions to session ${sessionId}`);
        socket.emit('ihld-questions-ready', { questions: pendingIHLD.questions });
      }

      // Deliver pending IHLD analysis if available
      const pendingAnalysis = sessionIHLDAnalysis.get(sessionId);
      if (pendingAnalysis && pendingAnalysis.analysis && pendingAnalysis.apis) {
        console.log(`📊 Delivering pending Integration Design Document analysis to session ${sessionId}`);
        socket.emit('ihld-analysis-ready', {
          analysis: pendingAnalysis.analysis,
          apis: pendingAnalysis.apis,
          sessionId: sessionId
        });
      }
    } catch (e) {
      console.warn(`⚠️ Failed delivering pending items for session ${sessionId}:`, e?.message || e);
    }
  });

  // Handle Integration Design Document clarifying answers submission
  socket.on("ihld-answers-submitted", async (data) => {
    const { sessionId, questionAnswers } = data;
    console.log(`📝 Received Integration Design Document answers for session ${sessionId}:`, questionAnswers);

    const pending = pendingIHLDQuestions.get(sessionId);
    if (!pending) {
      socket.emit("error", { message: "No pending Integration Design Document questions found for this session." });
      return;
    }

    // Re-process Integration Design Document with the new answers
    await processIHLDAndGenerateMuleCode(
      sessionId,
      pending.ihldContent,
      pending.options.apiName,
      { ...pending.options, questionAnswers },
      socket
    );

    pendingIHLDQuestions.delete(sessionId); // Clear questions after processing
  });

  // Handle request to generate Mule flow code with additional questions
  socket.on("generate-mule-flow", async (data) => {
    const { sessionId, ramlContent, apiName } = data; // Receive apiName for context
    console.log(`📝 Received generate-mule-flow request for session ${sessionId}. Generating dynamic questions...`);

    const socket = activeConnections.get(sessionId);
    if (!socket) {
      console.error(`❌ No active socket found for session ${sessionId}`);
      return;
    }

    try {
      socket.emit("progress", { type: "info", message: "Analyzing RAML and generating clarifying questions..." });

      // Use 'analysis' context for question generation (prioritizes Groq → Gemini → Anthropic)
      const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel("auto", "auto", 'analysis');
      const muleCodeAgent = new MuleCodeGenerationAgent(new Config({ provider: effectiveProvider, model: effectiveModel }));

      const questions = await muleCodeAgent._generateDynamicMuleFlowQuestions(ramlContent);
      
      // Store questions and RAML content for later use when answers are submitted
      pendingMuleFlowQuestions.set(sessionId, { questions, ramlContent, apiName });

      socket.emit("mule-flow-questions-ready", { questions, sessionId });
      socket.emit("progress", { type: "waiting", message: "Waiting for Mule flow clarifications...", waitingFor: "mule-flow-questions" });
      console.log(`❓ Dynamic Mule flow questions generated for session ${sessionId}, waiting for user answers`);
    } catch (error) {
      console.error(`❌ Error generating dynamic Mule flow questions for session ${sessionId}:`, error);
      socket.emit("error", { message: `Failed to generate Mule flow questions: ${error.message}` });
    }
  });

  // Handle Mule flow clarifying answers submission
  socket.on("mule-flow-answers-submitted", async (data) => {
    const { sessionId, questionAnswers } = data;
    console.log(`📝 Received Mule flow answers for session ${sessionId}:`, questionAnswers);

    const socket = activeConnections.get(sessionId);
    if (!socket) {
      console.error(`❌ No active socket found for session ${sessionId}`);
      return;
    }

    const pending = pendingMuleFlowQuestions.get(sessionId);
    if (!pending) {
      socket.emit("error", { message: "No pending Mule flow questions found for this session." });
      return;
    }

    try {
      socket.emit("progress", { type: "info", message: "Generating Mule flow code with provided answers..." });

      // Use 'code-generation' context to prioritize Anthropic first
      const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel("auto", "auto", 'code-generation');
      const muleCodeAgent = new MuleCodeGenerationAgent(new Config({ provider: effectiveProvider, model: effectiveModel }));

      // Map question answers to a more usable object for generateMuleCode
      const flowOptions = {};
      questionAnswers.forEach(qa => {
        flowOptions[qa.question] = qa.answer; // Using question as key, might need more robust mapping
      });

      const muleProject = await muleCodeAgent.generateMuleCode(
        pending.ramlContent,
        pending.apiName || 'MuleFlow',
        flowOptions, // Pass flow options from user answers
        { sessionId: sessionId } // Pass sessionId in context
      );

      // Store the generated project for download (keyed by apiName)
      let apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
      apiMuleCodeMap[pending.apiName || 'MuleFlow'] = muleProject;
      sessionMuleCodeByApi.set(sessionId, apiMuleCodeMap);

      // Add apiName to the muleProject for frontend compatibility
      const muleProjectWithApiName = {
        ...muleProject,
        apiName: pending.apiName || 'MuleFlow'
      };

      socket.emit("mule-code-generated", {
        apiName: pending.apiName || 'MuleFlow',
        muleCodeContent: [muleProjectWithApiName],
        sessionId: sessionId,
      });
      socket.emit("progress", { type: "complete", message: "Mule flow code generated successfully!" });
      console.log(`✅ Mule Flow Code generated for session ${sessionId} with dynamic answers`);
    } catch (error) {
      console.error(`❌ Error generating Mule flow code with answers for session ${sessionId}:`, error);
      socket.emit("error", { message: `Mule flow code generation failed: ${error.message}` });
    } finally {
      pendingMuleFlowQuestions.delete(sessionId); // Clear pending questions after processing
    }
  });

  // Handle Integration Design Document API generation with RAML file
  socket.on("generate-api-with-raml", async (data) => {
    const { sessionId, apiName, ramlContent, ramlFileName, ramlFileData, isZip } = data;
    console.log(`📝 Received generate-api-with-raml request for session ${sessionId}, API: ${apiName}`);

    const socket = activeConnections.get(sessionId);
    if (!socket) {
      console.error(`❌ No active socket found for session ${sessionId}`);
      return;
    }

    try {
      // Get IHLD analysis from session
      const ihldData = sessionIHLDAnalysis.get(sessionId);
      if (!ihldData) {
        socket.emit("error", { message: "No IHLD analysis found for this session. Please analyze IHLD first." });
        return;
      }

      socket.emit("progress", { type: "info", message: `Processing RAML file for ${apiName}...` });

      // Extract RAML content from file (handles both .raml and .zip files)
      let extractedRamlContent = ramlContent;
      
      if (ramlFileData || isZip) {
        // Handle file upload (ZIP or RAML file)
        try {
          const fileData = ramlFileData || ramlContent;
          const fileName = ramlFileName || `${apiName}.raml`;
          
          // If it's a ZIP or we need to extract
          if (isZip || fileName.toLowerCase().endsWith('.zip')) {
            extractedRamlContent = await extractRamlFromFile(
              typeof fileData === 'string' ? Buffer.from(fileData, 'base64') : fileData,
              fileName
            );
          } else if (typeof fileData === 'string' && !fileData.trim().startsWith('#%RAML')) {
            // Might be base64 encoded RAML file
            try {
              extractedRamlContent = Buffer.from(fileData, 'base64').toString('utf8');
            } catch (e) {
              // If base64 decode fails, use as-is
              extractedRamlContent = fileData;
            }
          } else {
            extractedRamlContent = fileData;
          }
        } catch (extractError) {
          console.error('❌ Error extracting RAML from file:', extractError);
          socket.emit("error", { message: `Failed to extract RAML from file: ${extractError.message}` });
          return;
        }
      }

      if (!extractedRamlContent || !extractedRamlContent.trim()) {
        socket.emit("error", { message: "No RAML content found in the uploaded file." });
        return;
      }

      socket.emit("progress", { type: "info", message: `Generating Mule code for ${apiName} with uploaded RAML...` });

      // Use 'code-generation' context to prioritize Anthropic first
      const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel("auto", "auto", 'code-generation');
      const muleCodeAgent = new MuleCodeGenerationAgent(new Config({ provider: effectiveProvider, model: effectiveModel }));

      // Create context with Integration Design Document analysis for better code generation
      const context = {
        sessionId: sessionId,
        ihldAnalysis: ihldData.analysis, // Pass Integration Design Document analysis as context
        apiDetails: findApiByName(ihldData.apis, apiName) // Pass specific API details (flexible name match)
      };

      const muleProject = await muleCodeAgent.generateMuleCode(
        extractedRamlContent,
        apiName,
        {}, // flowOptions
        context
      );

      // Add the uploaded RAML file to the project
      if (extractedRamlContent) {
        const ramlPath = ramlFileName && ramlFileName.endsWith('.raml') 
          ? `src/main/resources/api/${ramlFileName}`
          : `src/main/resources/api/${apiName}.raml`;
        muleProject.files.push({
          path: ramlPath,
          content: extractedRamlContent
        });
      }

      // Store the generated project for download (keyed by apiName)
      let apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
      apiMuleCodeMap[apiName] = muleProject;
      sessionMuleCodeByApi.set(sessionId, apiMuleCodeMap);

      // Add apiName to the muleProject for frontend compatibility
      const muleProjectWithApiName = {
        ...muleProject,
        apiName: apiName
      };

      socket.emit("mule-code-generated", {
        apiName: apiName,
        muleCodeContent: [muleProjectWithApiName],
        sessionId: sessionId,
      });
      socket.emit("progress", { type: "complete", message: `Mule code generated successfully for ${apiName}!` });
      console.log(`✅ Mule Code generated for ${apiName} with uploaded RAML for session ${sessionId}`);
    } catch (error) {
      console.error(`❌ Error generating Mule code with RAML for session ${sessionId}:`, error);
      socket.emit("error", { message: `Mule code generation failed: ${error.message}` });
    }
  });

  // Handle Integration Design Document API generation without RAML
  // - If API is RAML-based (needs RAML): synthesize RAML, generate code, add RAML file.
  // - If API is not RAML-based (single "Generate the code" button): generate code from API details only; no RAML synthesis, no RAML file.
  socket.on("generate-api-without-raml", async (data) => {
    const { sessionId, apiName } = data;
    console.log(`📝 Received generate-api-without-raml request for session ${sessionId}, API: ${apiName}`);

    const socket = activeConnections.get(sessionId);
    if (!socket) {
      console.error(`❌ No active socket found for session ${sessionId}`);
      return;
    }

    try {
      // Get IHLD analysis from session
      const ihldData = sessionIHLDAnalysis.get(sessionId);
      if (!ihldData) {
        socket.emit("error", { message: "No IHLD analysis found for this session. Please analyze IHLD first." });
        return;
      }

      // Find the specific API details (flexible name match: trim, collapse spaces, case-insensitive)
      const apiDetails = findApiByName(ihldData.apis, apiName);
      if (!apiDetails) {
        socket.emit("error", { message: `API "${apiName}" not found in Integration Design Document analysis.` });
        return;
      }

      const ramlBased = isRamlBasedApi(apiDetails);
      const { effectiveProvider, effectiveModel } = getEffectiveProviderAndModel(ihldData.options.provider, ihldData.options.model, 'code-generation');
      const muleCodeAgent = new MuleCodeGenerationAgent(new Config({ provider: effectiveProvider, model: effectiveModel }));
      const context = {
        sessionId: sessionId,
        ihldAnalysis: ihldData.analysis,
        apiDetails: apiDetails
      };

      let muleProject;

      if (ramlBased) {
        // API requires RAML: synthesize RAML, then generate code and add RAML file
        socket.emit("progress", { type: "info", message: `Synthesizing RAML for ${apiName} using API analysis details...` });
        const synthesizedRaml = await IHLDProcessor.synthesizeRamlForApi(
          ihldData.ihldContent,
          apiDetails,
          ihldData.analysis,
          { provider: ihldData.options.provider, model: ihldData.options.model }
        );
        if (!synthesizedRaml || !synthesizedRaml.trim()) {
          socket.emit("error", { message: `Could not synthesize RAML for ${apiName}. Please provide RAML file or more Integration Design Document details.` });
          return;
        }
        socket.emit("progress", { type: "info", message: `RAML synthesized for ${apiName}. Generating Mule code...` });
        muleProject = await muleCodeAgent.generateMuleCode(synthesizedRaml, apiName, {}, context);
        muleProject.files.push({
          path: `src/main/resources/api/${apiName}.raml`,
          content: synthesizedRaml
        });
        console.log(`✅ Mule Code generated for ${apiName} (with synthesized RAML) for session ${sessionId}`);
      } else {
        // API does not require RAML: generate code from API details only; no RAML synthesis, no RAML file
        socket.emit("progress", { type: "info", message: `Generating Mule code for ${apiName} from API details (no RAML)...` });
        muleProject = await muleCodeAgent.generateMuleCodeFromApiDetails(apiName, {}, context);
        console.log(`✅ Mule Code generated for ${apiName} without RAML (no RAML file) for session ${sessionId}`);
      }

      // Store the generated project for download (keyed by apiName)
      let apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
      apiMuleCodeMap[apiName] = muleProject;
      sessionMuleCodeByApi.set(sessionId, apiMuleCodeMap);

      const muleProjectWithApiName = { ...muleProject, apiName: apiName };
      socket.emit("mule-code-generated", {
        apiName: apiName,
        muleCodeContent: [muleProjectWithApiName],
        sessionId: sessionId,
      });
      socket.emit("progress", { type: "complete", message: `Mule code generated successfully for ${apiName}!` });
    } catch (error) {
      console.error(`❌ Error generating Mule code without RAML for session ${sessionId}:`, error);
      socket.emit("error", { message: `Mule code generation failed: ${error.message}` });
    }
  });

  socket.on("disconnect", () => {
    // Remove from active connections
    for (const [sessionId, s] of activeConnections.entries()) {
      if (s === socket) {
        activeConnections.delete(sessionId);
        console.log(`Client ${socket.id} left session ${sessionId}`);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
});
