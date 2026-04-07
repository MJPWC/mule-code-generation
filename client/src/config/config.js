/**
 * Configuration settings for the MuleSoft Code Generation System
 */

const Config = {
  // API endpoints
  API_BASE_URL: process.env.REACT_APP_API_URL || 'http://localhost:3001',
  
  // Socket.io configuration
  SOCKET_URL: process.env.REACT_APP_SOCKET_URL || 'http://localhost:3001',
  
  // Application settings
  APP_NAME: 'MuleSoft Code Generation System',
  VERSION: '1.0.0',
  
  // Feature flags
  FEATURES: {
    ENABLE_LLM_GENERATION: true,
    ENABLE_FILE_UPLOAD: true,
    ENABLE_REAL_TIME_COLLABORATION: true
  },
  
  // UI Configuration
  UI: {
    THEME: 'light',
    LANGUAGE: 'en',
    PAGE_SIZE: 10
  }
};

export default Config;
