import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import './App.css';
import OutputViewer from './components/OutputViewer';
// import DependencyChain from './components/DependencyChain'; // Removed
// import ApproachSelector from './components/ApproachSelector'; // Removed
import QuestionModal from './components/QuestionModal';
import IHLDAnalysisViewer from './components/IHLDAnalysisViewer';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
// import RamlAgentModal from './components/RamlAgentModal'; // Commented out to disable popup

function App() {
  const [input, setInput] = useState('');
  const [apiName] = useState('MuleSoftAPI');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [fileType, setFileType] = useState('raml'); // New state to store detected file type
  const [outputs, setOutputs] = useState({
    raml: null,
    muleCode: null,
  });
  const socketRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [logs, setLogs] = useState([]);
  const listenersAttachedRef = useRef(false);
  // const [showRamlAgentModal, setShowRamlAgentModal] = useState(false); // Commented out to disable popup
  const [ramlApiTasks, setRamlApiTasks] = useState([]); // Remove if not used
  const [ramlSelectedApiId, setRamlSelectedApiId] = useState(null); // Remove if not used
  const [isRamlSelectionPending, setIsRamlSelectionPending] = useState(false); // Remove if not used
  const ramlSelectedApiIdRef = useRef(null); // Remove if not used
  const [muleFlowQuestions, setMuleFlowQuestions] = useState([]); // New state for dynamic Mule Flow questions
  const [agents, setAgents] = useState({
    // Manager: { status: 'idle', message: '', data: null }, // Remove if not used
    // Architecture: { status: 'idle', message: '', data: null }, // Remove if not used
    // Diagram: { status: 'idle', message: '', data: null }, // Remove if not used
    // Estimation: { status: 'idle', message: '', data: null }, // Remove if not used
    // RAML: { status: 'idle', message: '', data: null }, // Remove if not used
    // Documentation: { status: 'idle', message: '', data: null }, // Remove if not used
    General: { status: 'idle', message: '', data: null }
  });
  const [ramlByApi, setRamlByApi] = useState({}); // Store RAML per API ID (remove if not used)
  const [loadingApiIds, setLoadingApiIds] = useState(new Set()); // Track which APIs are currently loading (remove if not used)
  const [provider, setProvider] = useState('auto');
  const [availableModels, setAvailableModels] = useState({
    gemini: false,
    groq: false,
    anthropic: false,
    openai: false,
    openrouter: false,
    ollama: false
  });

  const [selectedFile, setSelectedFile] = useState(null);
  const [ihldQuestions, setIhldQuestions] = useState([]); // New state for Integration Design Document questions
  const [ihldAnalysis, setIhldAnalysis] = useState(null); // New state for Integration Design Document analysis
  const [ihldApis, setIhldApis] = useState([]); // New state for Integration Design Document suggested APIs
  const [ihldAnalysisFallback, setIhldAnalysisFallback] = useState(false); // true when analysis used generic fallback (loophole #5)
  const [logFilter, setLogFilter] = useState('all'); // New state for log filtering

  const logsEndRef = useRef(null); // Ref for auto-scrolling logs

  // Auto-scroll to the latest log entry
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollTop = logsEndRef.current.scrollHeight;
    }
  }, [logs]);

  const handleProgress = useCallback((event) => {
    setLogs(prev => [...prev, { type: 'info', message: event.message, timestamp: new Date() }]);

    if (event.type === 'start' && event.agent === 'MuleCodeGeneration') {
      setOutputs(prev => ({ ...prev, muleCode: null }));
      setIsProcessing(true);
    } else if (event.type === 'complete' && event.agent === 'MuleCodeGeneration' && event.data) {
      setOutputs(prev => ({ ...prev, muleCode: event.data }));
      setIsProcessing(false);
    }
  }, []);

  // Clear logs function
  const clearLogs = () => {
    setLogs([]);
  };

  // Filtered logs based on selected filter
  const filteredLogs = logs.filter(log => {
    if (logFilter === 'all') return true;
    return log.type === logFilter;
  });

  // Setup socket listeners (extracted to reusable function)
  const setupSocketListeners = useCallback((socket) => {
    if (!socket || listenersAttachedRef.current) return;

    socket.on('session-joined', (data) => {
      console.log('✅ Session joined:', data);
      setLogs(prev => [...prev, { type: 'info', message: 'Connected to processing session', timestamp: new Date() }]);
      toast.success('Connected to processing session!');
    });

    socket.on('progress', (event) => {
      console.log('📡 Progress received:', event);
      handleProgress(event);
    });

    socket.on('error', (error) => {
      console.error('❌ Socket error:', error);
      setIsProcessing(false);
      setLogs(prev => [...prev, { type: 'error', message: error.message || 'An error occurred', timestamp: new Date() }]);
      toast.error(error.message || 'An error occurred during processing.');
    });

    socket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection error:', error);
      setConnectionStatus('error');
      toast.error('Failed to connect to server. Make sure the backend is running on port 5000.');
      setIsProcessing(false);
    });

    socket.on('disconnect', () => {
      console.log('⚠️ WebSocket disconnected');
      setConnectionStatus('disconnected');
      toast.warn('WebSocket disconnected.');
      setMuleFlowQuestions([]); // Clear mule flow questions on disconnect
      setIsProcessing(false);
    });

    socket.on('mule-flow-questions-ready', (data) => {
      console.log('❓ Mule Flow Questions received:', data.questions);
      setMuleFlowQuestions(data.questions);
      setIsProcessing(false); // Allow user to interact with the modal
      toast.info('Additional questions needed for Mule Flow generation.');
    });

    socket.on('connect', () => {
      console.log('✅ WebSocket connected');
      setConnectionStatus('connected');
      toast.success('WebSocket connected!');
    });

    socket.on('mule-code-generated', (data) => {
      console.log('🔍 Mule Code generated:', {
        apiName: data.apiName,
        muleCodeContentLength: data.muleCodeContent?.length || 0
      });

      setOutputs(prev => ({ ...prev, muleCode: data.muleCodeContent }));
      setIsProcessing(false);
      setLogs(prev => [...prev, { type: 'success', message: `Mule Code generated for ${data.apiName}`, timestamp: new Date() }]);
      toast.success(`Mule Code generated for ${data.apiName}!`);
    });

    // New listener for Integration Design Document clarifying questions
    socket.on('ihld-questions-ready', (data) => {
      console.log('❓ Integration Design Document Questions received:', data.questions);
      setIhldQuestions(data.questions);
      setIsProcessing(false); // Allow user to interact with the modal
      setLogs(prev => [...prev, { type: 'info', message: 'Integration Design Document requires clarification.', timestamp: new Date() }]);
      toast.info('Additional questions needed for Integration Design Document processing.');
    });

    // New listener for Integration Design Document analysis ready
    socket.on('ihld-analysis-ready', (data) => {
      console.log('📊 Integration Design Document Analysis received:', data);
      setIhldAnalysis(data.analysis);
      setIhldApis(data.apis || []);
      setIhldAnalysisFallback(data.isFallback === true);
      setIsProcessing(false);
      setLogs(prev => [...prev, { 
        type: 'success', 
        message: `Integration Design Document analysis complete. Found ${data.apis?.length || 0} API(s).`, 
        timestamp: new Date() 
      }]);
      toast.success(`Integration Design Document analysis complete! Found ${data.apis?.length || 0} API(s).`);
    });

    socket.on('warning', (data) => {
      if (data?.message) {
        toast.warning(data.message);
        setLogs(prev => [...prev, { type: 'warning', message: data.message, timestamp: new Date() }]);
      }
    });

    listenersAttachedRef.current = true;
  }, [handleProgress]); // Removed handleProgress from useCallback dependencies as it's now defined before. No longer needed in dependency array as it's a stable callback.

  const handleGenerateMuleCode = async (apiNameParam) => {
    if (!sessionId) {
      toast.error('Session ID not found. Please start a session by processing input first.');
      return;
    }

    const effectiveApiName = apiNameParam || apiName || 'API';
    console.log('📥 Downloading Mule project:', { sessionId, apiName: effectiveApiName });

    try {
      const response = await axios.post(
        'http://localhost:5000/api/mule-code/generate',
        {
          sessionId,
          apiName: effectiveApiName,
          projectName: effectiveApiName,
        },
        {
          responseType: 'blob'
        }
      );

      console.log('✅ Download response received:', {
        status: response.status,
        contentType: response.headers['content-type'],
        contentDisposition: response.headers['content-disposition'],
        blobSize: response.data.size
      });

      if (!response.data || response.data.size === 0) {
        throw new Error('Received empty ZIP file from server');
      }

      const blob = new Blob([response.data], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      const contentDisposition = response.headers['content-disposition'];
      let filename = 'mule-project.zip';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/);
        if (match && match[1]) {
          filename = match[1];
        }
      } else if (effectiveApiName) {
        filename = `Mule-${effectiveApiName.replace(/\s+/g, '_')}.zip`;
      }

      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success(`Mule project ZIP downloaded successfully: ${filename}`);
    } catch (error) {
      console.error('❌ Mule code download failed:', error);
      console.error('Error details:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        statusText: error.response?.statusText
      });
      
      let errorMessage = 'Failed to download Mule code';
      if (error.response) {
        // Server responded with an error status
        if (error.response.data instanceof Blob) {
          // Try to parse error message from blob response
          try {
            const text = await error.response.data.text();
            const errorJson = JSON.parse(text);
            errorMessage = errorJson.error || errorMessage;
          } catch (e) {
            errorMessage = `Server error (${error.response.status}): ${error.response.statusText || 'Unknown error'}`;
          }
        } else if (typeof error.response.data === 'object' && error.response.data !== null) {
          errorMessage = error.response.data.error || error.response.data.message || errorMessage;
        } else {
          errorMessage = `Server error (${error.response.status}): ${error.response.statusText || 'Unknown error'}`;
        }
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      toast.error(errorMessage);
    }
  };

  const handleInputKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!isProcessing && input.trim()) {
        handleProcess();
      }
    }
  };

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
      setSelectedFile(file);
      const extension = file.name.split('.').pop().toLowerCase();
      
      // Handle .docx files (binary format - needs special handling)
      if (extension === 'docx') {
        setFileType('ihld');
        toast.info(`Integration Design Document file '${file.name}' selected. Text will be extracted from Word document.`);
        // For .docx files, read as ArrayBuffer and convert to base64
        // Backend will extract text from the .docx file
        const reader = new FileReader();
        reader.onload = (e) => {
          const arrayBuffer = e.target.result;
          const bytes = new Uint8Array(arrayBuffer);
          const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
          const base64 = btoa(binary);
          // Store base64 in input - backend will extract text
          setInput(base64);
        };
        reader.onerror = () => {
          toast.error('Error reading .docx file. Please try again.');
          setSelectedFile(null);
          setInput('');
        };
        reader.readAsArrayBuffer(file);
        return;
      }
      
      // Handle text-based files
      const reader = new FileReader();
      reader.onload = (e) => {
        setInput(e.target.result);
        if (['raml', 'yaml', 'yml'].includes(extension)) {
          setFileType('raml');
          toast.info(`RAML file '${file.name}' selected.`);
        } else if (['md', 'txt'].includes(extension)) {
          setFileType('ihld');
          toast.info(`Integration Design Document file '${file.name}' selected.`);
        } else {
          setFileType('unknown'); // Default or handle unsupported types
          toast.warn(`Unsupported file type for '${file.name}'.`);
        }
      };
      reader.readAsText(file);
    } else {
      setSelectedFile(null);
      setInput('');
      setFileType('raml'); // Reset file type if no file is selected
      toast.info('No file selected.');
    }
  };

  const handleProcess = async () => {
    if (!input.trim() && !selectedFile) {
      toast.error('Please enter your RAML specification or select a file');
      return;
    }

    setIsProcessing(true);
    setOutputs({ raml: null, muleCode: null }); // Clear previous outputs
    const logMessage = selectedFile
      ? `User: Processing file ${selectedFile.name}`
      : `User: ${input.trim().substring(0, 100)}...`;
    setLogs((prev) => [...prev, { type: 'info', message: logMessage, timestamp: new Date() }]);

    try {
      let socket = socketRef.current;
      if (!socket) {
        try {
          socket = io('http://localhost:5000');
          socketRef.current = socket;
          setupSocketListeners(socket);
        } catch (err) {
          console.error('❌ Failed to initialize WebSocket:', err);
          toast.error('Failed to initialize connection to the server. Please ensure the backend is running on port 5000.');
          setIsProcessing(false);
          return;
        }
      } else {
        setupSocketListeners(socket);
      }

      if (socket.connected) {
        sendRequest();
      } else {
        socket.once('connect', () => {
          console.log('✅ WebSocket connected');
          setConnectionStatus('connected');
          sendRequest();
        });
      }

      function sendRequest() {
        // Check if selected file is .docx - if so, send a flag to backend
        const isDocx = selectedFile && selectedFile.name.toLowerCase().endsWith('.docx');
        axios.post('http://localhost:5000/api/process', {
          input: input.trim(),
          apiName: apiName || 'MuleSoftAPI',
          saveFiles: true,
          sessionId: sessionId || 'new-session',
          processType: 'mule-code-generation',
          fileType: selectedFile ? fileType : 'raml', // Send detected file type to backend
          isDocx: isDocx, // Flag to indicate .docx file needs text extraction
          fileName: selectedFile ? selectedFile.name : null, // Send filename for .docx processing
          provider: provider,
          model: 'auto'
        })
          .then(response => {
            const newSessionId = response.data.sessionId;
            if (!sessionId || sessionId !== newSessionId) {
              setSessionId(newSessionId);
              console.log('📋 New Session ID received:', newSessionId);
              toast.info(`New session started: ${newSessionId}`);
            } else {
              console.log('📋 Reusing Session ID:', newSessionId);
              toast.info(`Reusing session: ${newSessionId}`);
            }
            setOutputs(prev => ({ ...prev, raml: input.trim() })); // Store input as RAML
            socket.emit('join-session', newSessionId);
          })
          .catch(error => {
            console.error('❌ Error processing input:', error);
            toast.error('Failed to process input: ' + (error.response?.data?.error || error.message));
            setIsProcessing(false);
            setConnectionStatus('error');
          });
      }
    } catch (error) {
      console.error('❌ Error:', error);
      toast.error('Failed to process input: ' + error.message);
      setIsProcessing(false);
    }
  };

  const handleIHLDQuestionSubmission = (answers) => {
    if (!sessionId || !socketRef.current) {
      toast.error('Session not active. Please start a new process.');
      return;
    }
    console.log(' submitting ihld answers to backend with sessionId', sessionId, answers);
    setIsProcessing(true); // Re-engage processing state
    socketRef.current.emit('ihld-answers-submitted', { sessionId, questionAnswers: answers });
    setIhldQuestions([]); // Clear questions after submission
    toast.info('Integration Design Document answers submitted for further processing.');
  };

  const requestMuleFlowQuestions = (ramlContent, outputs) => {
    if (!sessionId || !socketRef.current) {
      toast.error('Session not active. Please start a new process.');
      return;
    }

    console.log('Requesting Mule flow questions from backend with sessionId', sessionId, ramlContent, outputs);
    setIsProcessing(true); // Re-engage processing state
    setMuleFlowQuestions([]); // Clear any previous dynamic questions
    socketRef.current.emit('request-mule-flow-questions', { sessionId, ramlContent, outputs });
    toast.info('Requesting clarifying questions for Mule flow generation.');
  };

  const handleSubmitDynamicMuleFlowAnswers = (answers) => {
    if (!sessionId || !socketRef.current) {
      toast.error('Session not active. Please start a new process.');
      return;
    }

    console.log('Submitting dynamic Mule flow answers to backend with sessionId', sessionId, answers);
    setIsProcessing(true); // Re-engage processing state
    setOutputs(prev => ({ ...prev, muleCode: null })); // Clear previous Mule code output
    socketRef.current.emit('mule-flow-answers-submitted', { sessionId, questionAnswers: answers });
    setMuleFlowQuestions([]); // Clear questions after submission
    toast.info('Mule flow answers submitted for code generation.');
  };

  return (
    <div className="App">
      <ToastContainer position="bottom-right" autoClose={5000} hideProgressBar={false} newestOnTop={false} closeOnClick rtl={false} pauseOnFocusLoss draggable pauseOnHover />
      
      {/* Header outside container for independent positioning */}
      <header className="header">
        <h1>🤖 Mule Code Generator</h1>
        <p>AI-Powered Mule 4 Application Code Generation</p>
        <div className="connection-status" style={{
          marginTop: '10px',
          padding: '5px 15px',
          borderRadius: '20px',
          backgroundColor: connectionStatus === 'connected' ? 'rgba(102, 187, 106, 0.3)' :
            connectionStatus === 'error' ? 'rgba(239, 83, 80, 0.3)' :
              'rgba(158, 158, 158, 0.3)',
          display: 'inline-block',
          fontSize: '0.9rem'
        }}>
          {connectionStatus === 'connected' && '🟢 Connected'}
          {connectionStatus === 'error' && '🔴 Connection Error'}
          {connectionStatus === 'disconnected' && '⚪ Disconnected'}
        </div>
      </header>

      <div className="container">
        <div className="main-content">
          <div className="left-panel">
            <div className="input-section">
              <h2>📝 Mule Code Generator</h2>
              <p style={{ fontSize: '0.9rem', color: '#666', marginBottom: '10px' }}>
                Start by uploading your RAML (API spec) or Integration Design Document file.
              </p>
              <label htmlFor="file-upload" className="custom-file-upload" disabled={isProcessing}>
                <input
                  id="file-upload"
                  type="file"
                  accept=".raml,.yaml,.yml,.md,.txt,.docx" // Expanded accepted file types
                  onChange={handleFileChange}
                  disabled={isProcessing}
                />
                <span className="upload-text">
                  {selectedFile ? `File Selected: ${selectedFile.name}` : '📁 Choose RAML or IDD File'}
                </span>
              </label>
              {selectedFile && <p style={{ fontSize: '0.9rem', color: '#667eea', marginTop: '10px' }}>Selected file: {selectedFile.name} (Type: {fileType === 'ihld' ? 'Integration Design Document' : fileType.toUpperCase()})</p>}

              {isProcessing && (
                <div className="processing-indicator">
                  <div className="spinner"></div>
                  <p>Processing your file...</p>
                </div>
              )}

              {/* Conditionally render LLM selection and textarea if not processing */}
              {!isProcessing && selectedFile && ( // Only show after file selection and if not processing
                <>
                  <div className="llm-selection-section" style={{ marginTop: '20px' }}>
                    <h3>🤖 LLM Configuration (Optional)</h3>
                    <div className="llm-option-group">
                      <label htmlFor="llm-provider-select">LLM Provider:</label>
                      <select
                        id="llm-provider-select"
                        value={provider}
                        onChange={(e) => setProvider(e.target.value)}
                        disabled={isProcessing}
                      >
                        <option value="auto">Auto-Detect</option>
                        {Object.keys(availableModels).map(p => (
                          <option key={p} value={p} disabled={!availableModels[p]}>
                            {p.charAt(0).toUpperCase() + p.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <textarea
                    value={input} // Keep value but hide if file selected
                    onChange={(e) => {
                      setSelectedFile(null); // Clear selected file if user starts typing
                      setInput(e.target.value);
                      if (e.target.value.includes('#%RAML')) {
                        setFileType('raml');
                      } else if (e.target.value.length > 0) {
                        setFileType('ihld');
                      } else {
                        setFileType('raml');
                      }
                    }}
                    onKeyDown={handleInputKeyDown}
                    placeholder="Paste your RAML or Integration Design Document content here, or select a file above..."
                    rows="15"
                    disabled={isProcessing || selectedFile} // Disable if file is selected
                    style={{ display: selectedFile ? 'none' : 'block' }} // Hide textarea if file selected
                  />
                  {/* Process button will now be triggered by file selection or paste */}
                </>
              )}

              {/* The process button logic will be tied to `selectedFile` or `input` length */}
              {!isProcessing && (input.trim() || selectedFile) && (
                <button
                  onClick={handleProcess}
                  disabled={isProcessing}
                  className="generate-btn"
                >
                  {fileType === 'ihld' ? '📊 Analyze Integration Design Document' : '🚀 Generate Mule Code'}
                </button>
              )}
            </div>
          </div>

          {/* Right panel (OutputViewer and Logs) visible after processing starts or outputs are available */}
          {(outputs.raml || outputs.muleCode || muleFlowQuestions.length > 0 || ihldQuestions.length > 0 || ihldAnalysis) && (
            <div className="right-panel">
              {/* Show Integration Design Document Analysis Viewer if analysis is available */}
              {ihldAnalysis && ihldApis.length > 0 && (
                <div className="ihld-analysis-container">
                  <IHLDAnalysisViewer
                    analysis={ihldAnalysis}
                    apis={ihldApis}
                    isFallback={ihldAnalysisFallback}
                    sessionId={sessionId}
                    socket={socketRef.current}
                    onCodeGenerated={(apiName) => {
                      setLogs(prev => [...prev, { 
                        type: 'info', 
                        message: `Code generation started for ${apiName}`, 
                        timestamp: new Date() 
                      }]);
                    }}
                    onDownloadProject={handleGenerateMuleCode}
                  />
                </div>
              )}

              {/* Show OutputViewer for generated code or RAML processing */}
              {(outputs.raml || outputs.muleCode || muleFlowQuestions.length > 0) && (
                <OutputViewer
                  outputs={outputs}
                  onGenerateMuleCode={(apiNameParam) => handleGenerateMuleCode(apiNameParam)}
                  onMuleFlowQuestionSubmission={handleSubmitDynamicMuleFlowAnswers} // Submit dynamic answers
                  onRequestMuleFlowQuestions={requestMuleFlowQuestions} // New prop for requesting questions
                  muleFlowQuestions={muleFlowQuestions} // New prop for dynamic questions
                />
              )}

              <div className="logs-panel">
                <h3>Activity Logs</h3>
                <div className="log-controls">
                  <select onChange={(e) => setLogFilter(e.target.value)}>
                    <option value="all">All</option>
                    <option value="info">Info</option>
                    <option value="success">Success</option>
                    <option value="error">Error</option>
                  </select>
                  <button onClick={clearLogs} className="clear-logs-btn">Clear Logs</button>
                </div>
                <div className="log-entries" ref={logsEndRef}>
                  {filteredLogs.map((log, index) => (
                    <div key={index} className={`log-entry log-${log.type}`}>
                      <span className="log-timestamp">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                      <span className="log-message">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {ihldQuestions.length > 0 && (
        <QuestionModal
          questions={ihldQuestions}
          onClose={() => setIhldQuestions([])} // Allow closing, perhaps with an error or restart option
          onSubmit={handleIHLDQuestionSubmission}
          title="Integration Design Document Clarification Needed"
          description="The AI needs more information to generate complete Mule code from your Integration Design Document. Please answer the following questions."
        />
      )}
      {muleFlowQuestions.length > 0 && (
        <QuestionModal
          questions={muleFlowQuestions}
          onClose={() => setMuleFlowQuestions([])} // Allow closing, perhaps with an error or restart option
          onSubmit={handleSubmitDynamicMuleFlowAnswers}
          title="Mule Flow Clarification Needed"
          description="The AI needs more information to generate complete Mule flow code. Please answer the following questions."
        />
      )}
    </div>
  );
}

export default App;
