import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import './App.css';
import Config from './config/config.js';
import OutputViewer from './components/OutputViewer';
import QuestionModal from './components/QuestionModal';
import IHLDAnalysisViewer from './components/IHLDAnalysisViewer';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

// Ã¢â€â‚¬Ã¢â€â‚¬ Step constants Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const STEP_UPLOAD     = 0;
const STEP_PROCESSING = 1;
const STEP_RESULTS    = 2;

function App() {
  const [currentStep, setCurrentStep]     = useState(STEP_UPLOAD);
  const [input, setInput]                 = useState('');
  const [apiName]                         = useState('MuleSoftAPI');
  const [isProcessing, setIsProcessing]   = useState(false);
  const [sessionId, setSessionId]         = useState(null);
  const [fileType, setFileType]           = useState('raml');
  const [outputs, setOutputs]             = useState({ raml: null, muleCode: null });
  const socketRef                         = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [logs, setLogs]                   = useState([]);
  const listenersAttachedRef              = useRef(false);
  const [ramlApiTasks, setRamlApiTasks]   = useState([]);
  const [ramlSelectedApiId, setRamlSelectedApiId] = useState(null);
  const [isRamlSelectionPending, setIsRamlSelectionPending] = useState(false);
  const ramlSelectedApiIdRef              = useRef(null);
  const [muleFlowQuestions, setMuleFlowQuestions] = useState([]);
  const [agents, setAgents]               = useState({ General: { status: 'idle', message: '', data: null } });
  const [ramlByApi, setRamlByApi]         = useState({});
  const [loadingApiIds, setLoadingApiIds] = useState(new Set());
  const [provider, setProvider]           = useState('auto');
  const [availableModels, setAvailableModels] = useState({
    gemini: false, groq: false, anthropic: false,
    openai: false, openrouter: false, ollama: false
  });
  const [selectedFile, setSelectedFile]   = useState(null);
  const [ihldQuestions, setIhldQuestions] = useState([]);
  const [ihldAnalysis, setIhldAnalysis]   = useState(null);
  const [ihldApis, setIhldApis]           = useState([]);
  const [ihldAnalysisFallback, setIhldAnalysisFallback] = useState(false);
  const [logFilter, setLogFilter]         = useState('all');
  const [showLogs, setShowLogs]           = useState(false);

  const logsEndRef = useRef(null);

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollTop = logsEndRef.current.scrollHeight;
    }
  }, [logs]);

  // Advance to processing step when processing starts
  useEffect(() => {
    if (isProcessing && currentStep === STEP_UPLOAD) {
      setCurrentStep(STEP_PROCESSING);
    }
  }, [isProcessing, currentStep]);

  // Advance to results step when results arrive
  useEffect(() => {
    const hasResults = ihldAnalysis || outputs.muleCode;
    if (hasResults && currentStep !== STEP_RESULTS) {
      setCurrentStep(STEP_RESULTS);
    }
  }, [ihldAnalysis, outputs.muleCode, currentStep]);

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

  const clearLogs = () => setLogs([]);

  const filteredLogs = logs.filter(log => logFilter === 'all' || log.type === logFilter);

  const setupSocketListeners = useCallback((socket) => {
    if (!socket || listenersAttachedRef.current) return;

    socket.on('session-joined', () => {
      setLogs(prev => [...prev, { type: 'info', message: 'Connected to processing session', timestamp: new Date() }]);
      toast.success('Connected to processing session!');
    });

    socket.on('progress', (event) => { handleProgress(event); });

    socket.on('error', (error) => {
      setIsProcessing(false);
      setLogs(prev => [...prev, { type: 'error', message: error.message || 'An error occurred', timestamp: new Date() }]);
      toast.error(error.message || 'An error occurred during processing.');
    });

    socket.on('connect_error', () => {
      setConnectionStatus('error');
      toast.error('Failed to connect to server. Make sure the backend is running on port 5000.');
      setIsProcessing(false);
    });

    socket.on('disconnect', () => {
      setConnectionStatus('disconnected');
      toast.warn('WebSocket disconnected.');
      setMuleFlowQuestions([]);
      setIsProcessing(false);
    });

    socket.on('mule-flow-questions-ready', (data) => {
      setMuleFlowQuestions(data.questions);
      setIsProcessing(false);
      toast.info('Additional questions needed for Mule Flow generation.');
    });

    socket.on('connect', () => {
      setConnectionStatus('connected');
      toast.success('WebSocket connected!');
    });

    socket.on('mule-code-generated', (data) => {
      setOutputs(prev => ({ ...prev, muleCode: data.muleCodeContent }));
      setIsProcessing(false);
      setLogs(prev => [...prev, { type: 'success', message: `Mule Code generated for ${data.apiName}`, timestamp: new Date() }]);
      toast.success(`Mule Code generated for ${data.apiName}!`);
    });

    socket.on('ihld-questions-ready', (data) => {
      setIhldQuestions(data.questions);
      setIsProcessing(false);
      setLogs(prev => [...prev, { type: 'info', message: 'Integration Design Document requires clarification.', timestamp: new Date() }]);
      toast.info('Additional questions needed for Integration Design Document processing.');
    });

    socket.on('ihld-analysis-ready', (data) => {
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
  }, [handleProgress]);

  const handleGenerateMuleCode = async (apiNameParam) => {
    if (!sessionId) {
      toast.error('Session ID not found. Please start a session by processing input first.');
      return;
    }
    const effectiveApiName = apiNameParam || apiName || 'API';
    try {
      const response = await axios.post(
        `${Config.API_BASE_URL}/api/mule-code/generate`,
        { sessionId, apiName: effectiveApiName, projectName: effectiveApiName },
        { responseType: 'blob' }
      );
      if (!response.data || response.data.size === 0) throw new Error('Received empty ZIP file from server');
      const blob = new Blob([response.data], { type: 'application/zip' });
      const url  = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href  = url;
      const cd   = response.headers['content-disposition'];
      let filename = 'mule-project.zip';
      if (cd) { const m = cd.match(/filename="(.+)"/); if (m?.[1]) filename = m[1]; }
      else if (effectiveApiName) { filename = `Mule-${effectiveApiName.replace(/\s+/g, '_')}.zip`; }
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success(`Mule project ZIP downloaded: ${filename}`);
    } catch (error) {
      let msg = 'Failed to download Mule code';
      if (error.response?.data instanceof Blob) {
        try { const t = await error.response.data.text(); msg = JSON.parse(t).error || msg; } catch {}
      } else if (typeof error.response?.data === 'object') {
        msg = error.response.data.error || error.response.data.message || msg;
      } else if (error.message) { msg = error.message; }
      toast.error(msg);
    }
  };

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (!file) {
      setSelectedFile(null); setInput(''); setFileType('raml');
      toast.info('No file selected.'); return;
    }

    setSelectedFile(file);
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'docx') {
      setFileType('ihld');
      toast.info(`Integration Design Document file '${file.name}' selected.`);
      const reader = new FileReader();
      reader.onload = (e) => {
        const bytes  = new Uint8Array(e.target.result);
        const binary = bytes.reduce((acc, b) => acc + String.fromCharCode(b), '');
        setInput(btoa(binary));
      };
      reader.onerror = () => { toast.error('Error reading .docx file.'); setSelectedFile(null); setInput(''); };
      reader.readAsArrayBuffer(file);
      return;
    }

    if (ext !== 'raml') {
      setSelectedFile(null);
      setInput('');
      setFileType('raml');
      toast.warn(`Unsupported file type '${file.name}'. Please upload only .raml or .docx files.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      setInput(e.target.result);
      setFileType('raml');
      toast.info(`RAML file '${file.name}' selected.`);
    };
    reader.readAsText(file);
  };

  const handleProcess = async () => {
    if (!input.trim() && !selectedFile) {
      toast.error('Please enter your RAML specification or select a file'); return;
    }
    setIsProcessing(true);
    setOutputs({ raml: null, muleCode: null });
    setIhldAnalysis(null);
    setIhldApis([]);
    const logMsg = selectedFile ? `Processing file ${selectedFile.name}` : `Processing input...`;
    setLogs(prev => [...prev, { type: 'info', message: logMsg, timestamp: new Date() }]);

    try {
      let socket = socketRef.current;
      if (!socket) {
        socket = io(Config.SOCKET_URL);
        socketRef.current = socket;
        setupSocketListeners(socket);
      } else {
        setupSocketListeners(socket);
      }

      const sendRequest = () => {
        const isDocx = selectedFile?.name.toLowerCase().endsWith('.docx');
        axios.post(`${Config.API_BASE_URL}/api/process`, {
          input: input.trim(),
          apiName: apiName || 'MuleSoftAPI',
          saveFiles: true,
          sessionId: sessionId || 'new-session',
          processType: 'mule-code-generation',
          fileType: selectedFile ? fileType : 'raml',
          isDocx,
          fileName: selectedFile?.name || null,
          provider,
          model: 'auto'
        })
          .then(response => {
            const newSessionId = response.data.sessionId;
            setSessionId(newSessionId);
            setOutputs(prev => ({ ...prev, raml: input.trim() }));
            socket.emit('join-session', newSessionId);
          })
          .catch(error => {
            toast.error('Failed to process input: ' + (error.response?.data?.error || error.message));
            setIsProcessing(false);
            setConnectionStatus('error');
            setCurrentStep(STEP_UPLOAD);
          });
      };

      if (socket.connected) { sendRequest(); }
      else { socket.once('connect', () => { setConnectionStatus('connected'); sendRequest(); }); }
    } catch (error) {
      toast.error('Failed to process input: ' + error.message);
      setIsProcessing(false);
      setCurrentStep(STEP_UPLOAD);
    }
  };

  const handleIHLDQuestionSubmission = (answers) => {
    if (!sessionId || !socketRef.current) { toast.error('Session not active.'); return; }
    setIsProcessing(true);
    setCurrentStep(STEP_PROCESSING);
    socketRef.current.emit('ihld-answers-submitted', { sessionId, questionAnswers: answers });
    setIhldQuestions([]);
    toast.info('Integration Design Document answers submitted.');
  };

  const requestMuleFlowQuestions = (ramlContent, outputs) => {
    if (!sessionId || !socketRef.current) { toast.error('Session not active.'); return; }
    setIsProcessing(true);
    setCurrentStep(STEP_PROCESSING);
    setMuleFlowQuestions([]);
    socketRef.current.emit('request-mule-flow-questions', { sessionId, ramlContent, outputs });
    toast.info('Requesting clarifying questions for Mule flow generation.');
  };

  const handleSubmitDynamicMuleFlowAnswers = (answers) => {
    if (!sessionId || !socketRef.current) { toast.error('Session not active.'); return; }
    setIsProcessing(true);
    setCurrentStep(STEP_PROCESSING);
    setOutputs(prev => ({ ...prev, muleCode: null }));
    socketRef.current.emit('mule-flow-answers-submitted', { sessionId, questionAnswers: answers });
    setMuleFlowQuestions([]);
    toast.info('Mule flow answers submitted for code generation.');
  };

  const handleRestart = () => {
    setCurrentStep(STEP_UPLOAD);
    setSelectedFile(null);
    setInput('');
    setFileType('raml');
    setOutputs({ raml: null, muleCode: null });
    setIhldAnalysis(null);
    setIhldApis([]);
    setLogs([]);
    setIsProcessing(false);
    setMuleFlowQuestions([]);
    setIhldQuestions([]);
    listenersAttachedRef.current = false;
  };

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Step labels ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const steps = [
    { label: 'Upload' },
    { label: 'Processing' },
    { label: 'Results' },
  ];

  const getStepState = (stepIndex) => {
    if (stepIndex < currentStep) return 'completed';
    if (stepIndex === currentStep) return 'active';
    return 'inactive';
  };

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Render helpers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const renderLogs = (collapsible = false) => {
    const logsBlock = (
      <div className="logs-card">
        <div className="logs-card-header">
          <h3>Activity Logs</h3>
          <div className="log-controls">
            <select className="log-filter-select" onChange={(e) => setLogFilter(e.target.value)} value={logFilter}>
              <option value="all">All</option>
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
            </select>
            <button className="clear-logs-btn" onClick={clearLogs}>Clear</button>
          </div>
        </div>
        <div className="log-entries" ref={logsEndRef}>
          {filteredLogs.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}>
              No logs yet...
            </span>
          )}
          {filteredLogs.map((log, i) => (
            <div key={i} className={`log-entry log-${log.type}`}>
              <span className="log-timestamp">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
              <span className="log-message">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    );

    if (!collapsible) return logsBlock;

    return (
      <div className="results-logs-section">
        <button
          className={`logs-toggle-btn ${showLogs ? 'open' : ''}`}
          onClick={() => setShowLogs(v => !v)}
        >
          Activity Logs ({logs.length})
          <em className="chevron">v</em>
        </button>
        {showLogs && <div style={{ marginTop: 8 }}>{logsBlock}</div>}
      </div>
    );
  };

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Main render ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  return (
    <div className="App">
      <ToastContainer
        position="bottom-right"
        autoClose={4000}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        pauseOnHover
        theme="dark"
      />

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Header ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      <header className="header">
        <div className="header-brand">
          <div className="logo-icon">AI</div>
          <div>
            <h1>Mule Code Generator</h1>
            <span>AI-Powered Mule 4 Generation</span>
          </div>
        </div>
        <div className={`connection-badge ${connectionStatus}`}>
          <span className="dot" />
          {connectionStatus === 'connected'    && 'Connected'}
          {connectionStatus === 'disconnected' && 'Disconnected'}
          {connectionStatus === 'error'        && 'Connection Error'}
        </div>
      </header>

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Step Indicator ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      <div className="step-indicator">
        {steps.map((step, idx) => (
          <React.Fragment key={idx}>
            <div className={`step-item ${getStepState(idx)}`}>
              <div className="step-circle">
                {getStepState(idx) === 'completed' ? 'Done' : idx + 1}
              </div>
              <span className="step-label">{step.label}</span>
            </div>
            {idx < steps.length - 1 && (
              <div className={`step-connector ${idx < currentStep ? 'filled' : ''}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Main Content Area ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      <div className="main-area">

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ STEP 0: UPLOAD ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {currentStep === STEP_UPLOAD && (
          <div className="upload-view">
            <div className="upload-view-header">
              <h2>Upload your file</h2>
              <p>Start with a RAML API spec or an Integration Design Document (.docx)</p>
            </div>

            <div className="upload-card">
              <label className={`drop-zone ${selectedFile ? 'has-file' : ''}`}>
                <input
                  type="file"
                  accept=".raml,.docx"
                  onChange={handleFileChange}
                  disabled={isProcessing}
                />
                {!selectedFile ? (
                  <>
                    <span className="drop-zone-icon">FILE</span>
                    <div className="drop-zone-text">Click to browse or drop your file</div>
                    <div className="drop-zone-sub">.raml, .docx</div>
                  </>
                ) : (
                  <>
                    <span className="drop-zone-icon">FILE</span>
                    <div className="drop-zone-text">File ready</div>
                    <div className="drop-zone-sub">Click to change</div>
                  </>
                )}
              </label>

              {selectedFile && (
                <div className="file-selected-info">
                  <span className="file-icon">
                    {fileType === 'ihld' ? 'IDD' : 'RAML'}
                  </span>
                  <span className="file-name">{selectedFile.name}</span>
                  <span className={`file-type-badge ${fileType}`}>
                    {fileType === 'ihld' ? 'IDD' : fileType.toUpperCase()}
                  </span>
                </div>
              )}

              {selectedFile && (
                <div className="config-section">
                  <label className="config-label">LLM Provider</label>
                  <select
                    className="config-select"
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
              )}

              {(input.trim() || selectedFile) && (
                <button className="process-btn" onClick={handleProcess} disabled={isProcessing}>
                  {fileType === 'ihld'
                    ? 'Analyze Integration Design Document'
                    : 'Generate Mule Code'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ STEP 1: PROCESSING ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {currentStep === STEP_PROCESSING && (
          <div className="processing-view">
            <div className="processing-header">
              <div className="spinner-ring" />
              <h2>Processing your file</h2>
              <p>
                {selectedFile?.name
                  ? `Analyzing ${selectedFile.name}...`
                  : 'Running AI agents, this may take a moment...'}}
              </p>
            </div>
            {renderLogs(false)}
          </div>
        )}

        {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ STEP 2: RESULTS ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {currentStep === STEP_RESULTS && (
          <div className="results-view">
            <div className="results-header">
              <h2>
                {ihldAnalysis ? 'Analysis Complete' : 'Code Generated'}
              </h2>
              <button className="btn-restart" onClick={handleRestart}>
                Start New
              </button>
            </div>

            {/* IHLD Analysis */}
            {ihldAnalysis && ihldApis.length > 0 && (
              <div className="result-panel">
                <div className="result-panel-header">
                  <span className="result-panel-title">Integration Design Document Analysis</span>
                </div>
                <div style={{ padding: '20px' }}>
                  <IHLDAnalysisViewer
                    analysis={ihldAnalysis}
                    apis={ihldApis}
                    isFallback={ihldAnalysisFallback}
                    sessionId={sessionId}
                    socket={socketRef.current}
                    onCodeGenerated={(name) => {
                      setLogs(prev => [...prev, {
                        type: 'info',
                        message: `Code generation started for ${name}`,
                        timestamp: new Date()
                      }]);
                    }}
                    onDownloadProject={handleGenerateMuleCode}
                  />
                </div>
              </div>
            )}

            {/* Mule Code Output */}
            {(outputs.raml || outputs.muleCode || muleFlowQuestions.length > 0) && (
              <div className="result-panel">
                <div className="result-panel-header">
                  <span className="result-panel-title">Mule Code</span>
                </div>
                <div style={{ padding: '20px' }}>
                  <OutputViewer
                    outputs={outputs}
                    onGenerateMuleCode={handleGenerateMuleCode}
                    onMuleFlowQuestionSubmission={handleSubmitDynamicMuleFlowAnswers}
                    onRequestMuleFlowQuestions={requestMuleFlowQuestions}
                    muleFlowQuestions={muleFlowQuestions}
                  />
                </div>
              </div>
            )}

            {/* Collapsible logs */}
            {renderLogs(true)}
          </div>
        )}
      </div>

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Modals ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {ihldQuestions.length > 0 && (
        <QuestionModal
          questions={ihldQuestions}
          onClose={() => setIhldQuestions([])}
          onSubmit={handleIHLDQuestionSubmission}
          title="Integration Design Document Clarification Needed"
          description="The AI needs more information to generate complete Mule code from your Integration Design Document. Please answer the following questions."
        />
      )}
      {muleFlowQuestions.length > 0 && (
        <QuestionModal
          questions={muleFlowQuestions}
          onClose={() => setMuleFlowQuestions([])}
          onSubmit={handleSubmitDynamicMuleFlowAnswers}
          title="Mule Flow Clarification Needed"
          description="The AI needs more information to generate complete Mule flow code. Please answer the following questions."
        />
      )}
    </div>
  );
}

export default App;


