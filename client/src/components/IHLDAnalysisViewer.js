import React, { useState, useEffect } from 'react';
import './IHLDAnalysisViewer.css';

const IHLDAnalysisViewer = ({ analysis, apis, isFallback, sessionId, socket, onCodeGenerated, onDownloadProject }) => {
  const [uploadingRaml, setUploadingRaml] = useState({}); // Track which API is uploading RAML
  const [generatingWithoutRaml, setGeneratingWithoutRaml] = useState(new Set()); // Track which APIs are generating without RAML
  const [codeReady, setCodeReady] = useState(new Set()); // Track which APIs have completed code generation
  const [downloading, setDownloading] = useState(new Set()); // Track which APIs are being downloaded

  // Helper: returns true if this API should be treated as non-RAML (scheduled/batch/file job etc.)
  const isNonRamlType = (api, searchText) => {
    const nonRamlKeywords = [
      'scheduled', 'event-driven', 'eventdriven', 'file-based', 'filebased',
      'filepoller', 'file poller', 'quartz', 'cron'
    ];
    const nonRamlBatchPhrases = [
      'batch job', 'batch processing', 'batch run', 'batch scheduler',
      'scheduled batch', 'batch integration'
    ];
    for (const keyword of nonRamlKeywords) {
      const keywordPattern = new RegExp(`\\b${keyword.replace(/-/g, '[-\\s]?')}\\b|${keyword}`, 'i');
      if (keywordPattern.test(searchText)) return true;
    }
    for (const phrase of nonRamlBatchPhrases) {
      if (searchText.includes(phrase.replace(/\s+/g, ' '))) return true;
    }
    if (searchText.includes('job') && !searchText.includes('api')) return true;
    if (api.type) {
      const apiTypeLower = api.type.toLowerCase().trim();
      if (apiTypeLower.includes('process api') && searchText.includes('scheduled')) return true;
    }
    return false;
  };

  // Helper: returns true if API has valid endpoints (array or string)
  const hasValidEndpoints = (api) => {
    if (!api.endpoints) return false;
    if (Array.isArray(api.endpoints)) {
      const toEpStr = (ep) => {
        if (ep == null) return '';
        if (typeof ep === 'string') return ep.trim();
        if (typeof ep === 'object' && (ep.path != null || ep.url != null)) return String(ep.path || ep.url || '').trim();
        return String(ep).trim();
      };
      const valid = api.endpoints.filter(ep => {
        const epStr = toEpStr(ep).toUpperCase();
        return epStr !== '' && epStr !== 'N/A' && epStr !== 'NULL' && epStr !== 'UNDEFINED';
      });
      return valid.length > 0;
    }
    if (typeof api.endpoints === 'string') {
      const s = api.endpoints.trim().toUpperCase();
      return s !== 'N/A' && !s.includes('N/A') && s.length > 0;
    }
    return false;
  };

  // Helper: when endpoints are empty, check if description suggests REST/endpoints
  const descriptionSuggestsRaml = (api) => {
    const desc = (api.description || '').toLowerCase();
    if (!desc.trim()) return false;
    const hints = ['endpoint', 'endpoints', '/api/', 'http', 'rest', 'resource', 'url', 'path'];
    if (hints.some(h => desc.includes(h))) return true;
    if (/\/([a-z0-9-]+)(\/\{[^}]+\})?/i.test(desc)) return true; // path-like e.g. /customers or /orders/{id}
    return false;
  };

  // Decide if API is RAML-based: first by endpoints, then by description when endpoints are empty
  const isRamlBasedApi = (api) => {
    const searchText = [
      api.type || '',
      api.name || '',
      api.description || ''
    ].join(' ').toLowerCase().trim().replace(/[^a-z0-9\s]/g, ' ');

    if (isNonRamlType(api, searchText)) {
      console.log(`[isRamlBasedApi] API "${api.name}" is NOT RAML-based (non-RAML type)`);
      return false;
    }

    const hasEndpoints = hasValidEndpoints(api);

    if (hasEndpoints) {
      console.log(`[isRamlBasedApi] API "${api.name}" is RAML-based (has valid endpoints)`);
      return true;
    }

    if (descriptionSuggestsRaml(api)) {
      console.log(`[isRamlBasedApi] API "${api.name}" is RAML-based (no endpoints; description suggests REST/endpoints)`);
      return true;
    }

    console.log(`[isRamlBasedApi] API "${api.name}" is NOT RAML-based (no endpoints and description does not suggest REST)`);
    return false;
  };

  const handleFileSelect = (apiName, event) => {
    const file = event.target.files[0];
    if (!file) return;

    setUploadingRaml(prev => ({ ...prev, [apiName]: true }));

    const fileName = file.name;
    const isZip = fileName.toLowerCase().endsWith('.zip');
    const isRaml = fileName.toLowerCase().endsWith('.raml') || 
                   fileName.toLowerCase().endsWith('.yaml') || 
                   fileName.toLowerCase().endsWith('.yml');

    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        let ramlContent = null;
        let ramlFileData = null;

        if (isZip) {
          // For ZIP files, read as ArrayBuffer and convert to base64
          const arrayBuffer = e.target.result;
          const bytes = new Uint8Array(arrayBuffer);
          const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
          ramlFileData = btoa(binary);
        } else if (isRaml) {
          // For RAML files, read as text
          ramlContent = e.target.result;
        } else {
          // For other files, try to read as text
          ramlContent = e.target.result;
        }

        // Send to backend
        socket.emit('generate-api-with-raml', {
          sessionId,
          apiName,
          ramlContent: ramlContent,
          ramlFileName: fileName,
          ramlFileData: ramlFileData,
          isZip: isZip
        });

        // Reset file input
        event.target.value = '';
      } catch (error) {
        console.error('Error processing file:', error);
        alert('Error processing file: ' + error.message);
        setUploadingRaml(prev => ({ ...prev, [apiName]: false }));
      }
    };

    reader.onerror = () => {
      console.error('Error reading file');
      alert('Error reading file. Please try again.');
      setUploadingRaml(prev => ({ ...prev, [apiName]: false }));
    };

    // Read file based on type
    if (isZip) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  };

  const handleGenerateWithoutRaml = (apiName) => {
    setGeneratingWithoutRaml(prev => new Set([...prev, apiName]));
    socket.emit('generate-api-without-raml', {
      sessionId,
      apiName
    });
  };

  // Listen for code generation completion
  useEffect(() => {
    if (!socket) return;

    const handleCodeGenerated = (data) => {
      console.log('📦 Code generated for API:', data.apiName);
      // Mark code as ready for this API
      setCodeReady(prev => new Set([...prev, data.apiName]));
      // Clear uploading/generating states
      setUploadingRaml(prev => {
        const newState = { ...prev };
        delete newState[data.apiName];
        return newState;
      });
      setGeneratingWithoutRaml(prev => {
        const newSet = new Set(prev);
        newSet.delete(data.apiName);
        return newSet;
      });
    };

    socket.on('mule-code-generated', handleCodeGenerated);

    return () => {
      socket.off('mule-code-generated', handleCodeGenerated);
    };
  }, [socket]);

  const handleDownload = async (apiName) => {
    if (!onDownloadProject) {
      console.error('Download function not provided');
      return;
    }

    setDownloading(prev => new Set([...prev, apiName]));
    try {
      await onDownloadProject(apiName);
    } catch (error) {
      console.error('Download failed:', error);
    } finally {
      setDownloading(prev => {
        const newSet = new Set(prev);
        newSet.delete(apiName);
        return newSet;
      });
    }
  };

  return (
    <div className="ihld-analysis-viewer">
      {isFallback && (
        <div className="ihld-fallback-banner" role="alert">
          <strong>⚠️ Partial analysis:</strong> Analysis could not be fully completed; a generic API list was used. Consider re-analyzing or adding more detail to your document for better results.
        </div>
      )}
      <div className="analysis-section">
        <h3>📊 Integration Design Document Analysis</h3>
        <div className="analysis-content">
          <pre>{analysis}</pre>
        </div>
      </div>

      <div className="apis-section">
        <h3>🔌 Suggested APIs ({apis.length})</h3>
        <div className="apis-list">
          {apis.map((api, index) => (
            <div key={index} className="api-card">
              <div className="api-header">
                <h4>{api.name}</h4>
                <span className="api-type-badge">{api.type}</span>
              </div>
              <p className="api-description">{api.description}</p>
              {api.endpoints && api.endpoints.length > 0 && (
                <div className="api-endpoints">
                  <strong>Endpoints:</strong>
                  <ul>
                    {api.endpoints.map((endpoint, idx) => (
                      <li key={idx}>
                        {typeof endpoint === 'string' ? endpoint : (endpoint.path ?? endpoint.url ?? String(endpoint))}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {api.integrationPoints && api.integrationPoints.length > 0 && (
                <div className="api-integration-points">
                  <strong>Integration Points:</strong>
                  <span>{api.integrationPoints.join(', ')}</span>
                </div>
              )}
              <div className="api-actions">
                {(() => {
                  const isRaml = isRamlBasedApi(api);
                  console.log(`[RENDER] API "${api.name}" (type: "${api.type}") - isRamlBased: ${isRaml}`);
                  return isRaml;
                })() ? (
                  <>
                    {codeReady.has(api.name) ? (
                      <button
                        className="download-project-btn"
                        onClick={() => handleDownload(api.name)}
                        disabled={downloading.has(api.name)}
                      >
                        {downloading.has(api.name) ? (
                          <span>⏳ Downloading...</span>
                        ) : (
                          <span>📥 Download Project ZIP</span>
                        )}
                      </button>
                    ) : (
                      <>
                        <label
                          className={`upload-raml-btn${uploadingRaml[api.name] || generatingWithoutRaml.has(api.name) || codeReady.has(api.name) ? ' upload-raml-btn--disabled' : ''}`}
                          style={uploadingRaml[api.name] || generatingWithoutRaml.has(api.name) || codeReady.has(api.name) ? { pointerEvents: 'none' } : undefined}
                        >
                          <input
                            type="file"
                            accept=".raml,.yaml,.yml,.zip"
                            onChange={(e) => handleFileSelect(api.name, e)}
                            disabled={uploadingRaml[api.name] || generatingWithoutRaml.has(api.name) || codeReady.has(api.name)}
                            style={{ display: 'none' }}
                          />
                          {uploadingRaml[api.name] ? (
                            <span>⏳ Generating...</span>
                          ) : (
                            <span>📁 Generate with RAML</span>
                          )}
                        </label>
                        <button
                          className="generate-without-raml-btn"
                          onClick={() => handleGenerateWithoutRaml(api.name)}
                          disabled={uploadingRaml[api.name] || generatingWithoutRaml.has(api.name) || codeReady.has(api.name)}
                        >
                          {generatingWithoutRaml.has(api.name) ? (
                            <span>⏳ Generating...</span>
                          ) : (
                            <span>🚀 Generate without RAML</span>
                          )}
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {codeReady.has(api.name) ? (
                      <button
                        className="download-project-btn"
                        onClick={() => handleDownload(api.name)}
                        disabled={downloading.has(api.name)}
                      >
                        {downloading.has(api.name) ? (
                          <span>⏳ Downloading...</span>
                        ) : (
                          <span>📥 Download Project ZIP</span>
                        )}
                      </button>
                    ) : (
                      <button
                        className="generate-without-raml-btn"
                        onClick={() => handleGenerateWithoutRaml(api.name)}
                        disabled={uploadingRaml[api.name] || generatingWithoutRaml.has(api.name) || codeReady.has(api.name)}
                      >
                        {generatingWithoutRaml.has(api.name) ? (
                          <span>⏳ Generating...</span>
                        ) : (
                          <span>🚀 Generate the code</span>
                        )}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default IHLDAnalysisViewer;
