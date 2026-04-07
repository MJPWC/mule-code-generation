import React, { useState, useEffect } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { darcula } from 'react-syntax-highlighter/dist/esm/styles/prism';
import * as XLSX from 'xlsx';
import './OutputViewer.css';
import QuestionModal from './QuestionModal';

const OutputViewer = ({
  outputs,
  onGenerateMuleCode,
  onMuleFlowQuestionSubmission, // For submitting dynamic answers
  onRequestMuleFlowQuestions, // For requesting dynamic questions
  muleFlowQuestions, // Dynamic questions from App.js
}) => {
  const [showMuleFlowQuestionModal, setShowMuleFlowQuestionModal] = useState(false);
  const [activeTab, setActiveTab] = useState('muleCode');
  const [copied, setCopied] = useState(null);
  const [muleCodeGeneratingApiId, setMuleCodeGeneratingApiId] = useState(null);
  const [selectedMuleProject, setSelectedMuleProject] = useState(null); // New state for selected project
  const [selectedMuleFile, setSelectedMuleFile] = useState(null);
  const [deduplicatedFiles, setDeduplicatedFiles] = useState([]); // Store deduplicated files

  const tabs = [
    { id: 'muleCode', label: '📦 Mule Code', icon: '📦' },
  ];

  useEffect(() => {
    if (outputs.muleCode && Array.isArray(outputs.muleCode) && outputs.muleCode.length > 0) {
      setSelectedMuleProject(outputs.muleCode[0]); // Select the first project by default
    } else {
      setSelectedMuleProject(null);
    }
  }, [outputs.muleCode]);

  useEffect(() => {
    if (selectedMuleProject && selectedMuleProject.files && selectedMuleProject.files.length > 0) {
      // Deduplicate files by path
      const uniqueFilesMap = new Map();
      selectedMuleProject.files.forEach(file => {
        uniqueFilesMap.set(file.path, file);
      });
      const uniqueFiles = Array.from(uniqueFilesMap.values());
      setDeduplicatedFiles(uniqueFiles); // Store deduplicated files
      setSelectedMuleFile(uniqueFiles[0]); // Select the first unique file of the chosen project
    } else {
      setSelectedMuleFile(null);
      setDeduplicatedFiles([]); // Clear deduplicated files
    }
  }, [selectedMuleProject]);

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const renderMuleCodeContent = () => {
    if (!selectedMuleProject || !selectedMuleProject.files || selectedMuleProject.files.length === 0) {
      return (
        <div className="empty-output">
          <p>Mule Code has not been generated yet. Upload your RAML/Integration Design Document.</p>
        </div>
      );
    }

    if (!selectedMuleFile) {
      return <p>Select a file to view its content.</p>;
    }

    const fileExtension = selectedMuleFile.path.split('.').pop();
    let language = 'xml'; // Default to xml for Mule files
    if (fileExtension === 'json') language = 'json';
    if (fileExtension === 'properties') language = 'properties';
    if (fileExtension === 'gitignore') language = 'text';
    if (fileExtension === 'muleignore') language = 'text';
    if (fileExtension === 'dwl') language = 'java'; // DataWeave is often similar to Java for highlighting purposes
    if (fileExtension === 'java') language = 'java';
    if (fileExtension === 'xml' && selectedMuleFile.path.includes('log4j2')) language = 'xml';

    return (
      <div className="mule-file-viewer">
        <div className="mule-file-header">
          <h4>{selectedMuleFile.path}</h4>
          <button
            onClick={() => handleCopy(selectedMuleFile.content, selectedMuleFile.path)}
            className="copy-btn"
          >
            {copied === selectedMuleFile.path ? '✓ Copied' : '📋 Copy'}
          </button>
        </div>
        <SyntaxHighlighter language={language} style={darcula} customStyle={{ padding: '24px', borderRadius: '16px', fontSize: '0.9rem', lineHeight: '1.8', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {selectedMuleFile.content}
        </SyntaxHighlighter>
      </div>
    );
  };

  const renderContent = () => {
    if (activeTab === 'muleCode') {
      const muleProjects = outputs.muleCode;

      return (
        <div className="output-content">
          <div className="output-header">
            <h3>Mule Code Generation</h3>
            <div className="header-buttons">
              {muleProjects && Array.isArray(muleProjects) && muleProjects.length > 1 && (
                <select
                  className="project-selector"
                  onChange={(e) => {
                    const selectedProjectName = e.target.value;
                    const project = muleProjects.find(p => p.apiName === selectedProjectName);
                    setSelectedMuleProject(project);
                  }}
                  value={selectedMuleProject ? selectedMuleProject.apiName : ''}
                >
                  {muleProjects.map(project => (
                    <option key={project.apiName} value={project.apiName}>
                      Project: {project.apiName}
                    </option>
                  ))}
                </select>
              )}

              {selectedMuleProject && deduplicatedFiles && deduplicatedFiles.length > 0 && (
                <select
                  className="file-selector"
                  onChange={(e) => {
                    const selectedPath = e.target.value;
                    const file = deduplicatedFiles.find(f => f.path === selectedPath);
                    setSelectedMuleFile(file);
                  }}
                  value={selectedMuleFile ? selectedMuleFile.path : ''}
                >
                  {deduplicatedFiles.map(file => (
                    <option key={file.path} value={file.path}>
                      {file.path}
                    </option>
                  ))}
                </select>
              )}

              {selectedMuleProject && onGenerateMuleCode && (
                <button
                  type="button"
                  className="raml-action-btn generate-mule"
                  disabled={muleCodeGeneratingApiId === selectedMuleProject.apiName}
                  onClick={() => {
                    setMuleCodeGeneratingApiId(selectedMuleProject.apiName);
                    onGenerateMuleCode(selectedMuleProject.apiName) // Pass project name to download
                      .catch(err => {
                        console.error('Mule code generation failed:', err);
                        alert('Failed to generate Mule code: ' + (err.message || err));
                      })
                      .finally(() => {
                        setMuleCodeGeneratingApiId(null);
                      });
                  }}
                >
                  {muleCodeGeneratingApiId === selectedMuleProject.apiName && (
                    <span className="doc-loading-spinner" />
                  )}
                  <span>
                    {muleCodeGeneratingApiId === selectedMuleProject.apiName
                      ? 'Downloading...'
                      : 'Download Project ZIP'}
                  </span>
                </button>
              )}
            </div>
          </div>
          {renderMuleCodeContent()}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="output-viewer">
      <div className="output-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label.split(' ')[1]}</span>
          </button>
        ))}
      </div>
      <div className="output-panel">
        {renderContent()}
      </div>
      {showMuleFlowQuestionModal && (
        <QuestionModal
          questions={muleFlowQuestions} // Use dynamic questions
          onClose={() => setShowMuleFlowQuestionModal(false)}
          onSubmit={(answers) => {
            onMuleFlowQuestionSubmission(outputs.raml, answers); // Keep existing for now, will modify App.js handler later
            setShowMuleFlowQuestionModal(false);
          }}
          title="Generate Mule Flow Code"
          description="Please provide details for generating the Mule flow code."
          contextType="mule-flow" // New prop for Mule Flow context
        />
      )}
    </div>
  );
};

export default OutputViewer;