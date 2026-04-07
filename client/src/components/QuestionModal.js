import React, { useState, useEffect } from 'react';
import './QuestionModal.css';

const QuestionModal = ({ questions, onSubmit, onClose, isProcessing = false, contextType = 'architecture' }) => {
  const [answers, setAnswers] = useState({});
  const [errors, setErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize answers state
  useEffect(() => {
    const initialAnswers = {};
    questions.forEach(q => {
      initialAnswers[q.number] = q.answer || '';
    });
    setAnswers(initialAnswers);
  }, [questions]);

  const handleAnswerChange = (questionNumber, value) => {
    setAnswers(prev => ({
      ...prev,
      [questionNumber]: value
    }));
    // Clear error for this question when user starts typing
    if (errors[questionNumber]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[questionNumber];
        return newErrors;
      });
    }
  };

  const validateAnswers = () => {
    const newErrors = {};
    let hasErrors = false;

    const isDocumentationContext = contextType === 'documentation';
    const isArchitectureContext = contextType === 'architecture';

    questions.forEach(q => {
      const answer = answers[q.number]?.trim() || '';
      const questionText = q.question || '';

      if (!answer) {
        newErrors[q.number] = "Answer is required";
        hasErrors = true;
        return;
      }

      // For documentation flows, allow short/single-word answers for document-type selection
      const isDocTypeQuestion = /what\s+(type|kind)\s+of\s+(document|documentation)|what\s+type\s+of\s+documentation/i.test(questionText);
      if (isDocumentationContext && isDocTypeQuestion) {
        // Accept any non-empty answer (e.g., "HLD", "BRD", "TDD", "Test Plan")
        return;
      }

      // For architecture context, be more lenient with length requirements
      const minLength = isArchitectureContext ? 2 : 5;
      if (answer.length < minLength) {
        newErrors[q.number] = `Answer is too short. Please provide ${isArchitectureContext ? 'at least a brief' : 'more'} details.`;
        hasErrors = true;
        return;
      }

      // Check for irrelevant responses - but be more lenient for architecture questions
      const irrelevantPatterns = [
        /^(i'?m\s+)?fine$/i,
        /^(i'?m\s+)?ok(ay)?$/i,
        /^(i'?m\s+)?good$/i,
        /^(i\s+)?don'?t\s+know$/i,
        /^(i\s+)?have\s+no\s+idea$/i,
        /^not\s+sure$/i,
        /^maybe$/i,
        /^probably$/i,
        /^i\s+guess$/i,
        /^whatever$/i,
        /^anything$/i,
        /^i'?m\s+fine$/i
      ];

      // Skip irrelevant pattern check for architecture context if answer is reasonably long
      if (isArchitectureContext && answer.length >= 3) {
        return; // Accept longer architecture answers without pattern checking
      }

      for (const pattern of irrelevantPatterns) {
        if (pattern.test(answer)) {
          newErrors[q.number] = "Please provide a specific answer related to the question. Vague answers like 'I'm fine' are not acceptable.";
          hasErrors = true;
          return;
        }
      }
    });

    setErrors(newErrors);
    return !hasErrors;
  };

  const handleSubmit = () => {
    if (!validateAnswers()) {
      return;
    }

    setIsSubmitting(true);

    // Prepare question answers
    const questionAnswers = questions.map(q => ({
      number: q.number,
      question: q.question,
      answer: answers[q.number]?.trim() || ''
    }));

    try {
      onSubmit(questionAnswers);
    } catch (error) {
      console.error('Error submitting answers:', error);
      alert('Failed to submit answers: ' + error.message);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="question-modal-overlay">
      <div className="question-modal">
        <div className="question-modal-header">
          <h2>❓ Clarifying Questions</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="question-modal-content">
          <p className="modal-description">
            {contextType === 'documentation' ? (
              <>
                To generate the best documentation, please answer the following questions.
                Please provide <strong>specific and relevant answers</strong> related to each question.
                avoid one word answers like yes, no, ok etc.
              </>
            ) : (
              <>
                To design the best architecture solution, please answer the following questions.
                Please provide <strong>specific and relevant answers</strong> related to each question.
                avoid one word answers like yes, no, ok etc.
              </>
            )}
          </p>

          {!isProcessing && (
            questions.length > 0 ? (
              <div className="questions-list">
                {questions.map((q) => (
                  <div key={q.number} className={`question-item ${errors[q.number] ? 'error' : ''}`}>
                    <label className="question-label">
                      <span className="question-number">Q{q.number}:</span>
                      <span className="question-text">{q.question}</span>
                    </label>
                    <textarea
                      value={answers[q.number] || ''}
                      onChange={(e) => handleAnswerChange(q.number, e.target.value)}
                      placeholder={`Please provide a specific answer for: ${q.question}`}
                      rows="3"
                      className={`answer-input ${errors[q.number] ? 'error' : ''}`}
                      disabled={isProcessing}
                    />
                    {errors[q.number] && (
                      <div className="error-message">
                        ⚠️ {errors[q.number]}
                      </div>
                    )}
                    {q.validation && !q.validation.valid && (
                      <div className="validation-error">
                        ❌ {q.validation.reason || "Answer is not relevant to the question"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-questions-message">
                <p>No clarifying questions generated at this time. Please try again or adjust your input.</p>
                <p>If the issue persists, ensure your LLM configuration is correct and that the backend is able to reach the LLM provider.</p>
              </div>
            )
          )}

          {isProcessing ? (
            <div className="processing-state">
              <div className="processing-spinner"></div>
              <h3>Processing Your Answers...</h3>
              <p>Validating answers and generating architecture approaches based on your responses.</p>
              <div className="processing-steps">
                <div className="step completed">
                  <span className="step-icon">✓</span>
                  <span>Answers Submitted</span>
                </div>
                <div className="step active">
                  <span className="step-icon rotating">⟳</span>
                  <span>Validating Answers</span>
                </div>
                <div className="step">
                  <span className="step-icon">○</span>
                  <span>Generating Approaches</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="question-modal-footer">
              <button 
                className="cancel-btn" 
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button 
                className="submit-btn" 
                onClick={handleSubmit}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Validating...' : 'Submit Answers'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuestionModal;

