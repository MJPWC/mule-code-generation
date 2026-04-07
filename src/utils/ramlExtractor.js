/**
 * Utility to extract RAML content from files or ZIP archives
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Extract RAML content from a ZIP file
 * @param {string} zipFilePath - Path to the ZIP file
 * @returns {Promise<string>} - Extracted RAML content
 */
export async function extractRamlFromZip(zipFilePath) {
  try {
    // Try to use adm-zip if available, otherwise fallback to manual extraction
    let AdmZip;
    try {
      AdmZip = (await import('adm-zip')).default;
    } catch (e) {
      throw new Error('adm-zip package is required for ZIP extraction. Please install it: npm install adm-zip');
    }

    const zip = new AdmZip(zipFilePath);
    const zipEntries = zip.getEntries();

    // Find RAML files in the ZIP
    const ramlFiles = zipEntries.filter(entry => {
      const fileName = entry.entryName.toLowerCase();
      return fileName.endsWith('.raml') && !entry.isDirectory;
    });

    if (ramlFiles.length === 0) {
      throw new Error('No RAML files found in the ZIP archive');
    }

    // If multiple RAML files, try to find the main one (api.raml, main.raml, or the first one)
    let mainRamlFile = ramlFiles.find(f => 
      f.entryName.toLowerCase().includes('api.raml') || 
      f.entryName.toLowerCase().includes('main.raml')
    ) || ramlFiles[0];

    const ramlContent = mainRamlFile.getData().toString('utf8');
    
    console.log(`✅ Extracted RAML from ZIP: ${mainRamlFile.entryName}`);
    return ramlContent;

  } catch (error) {
    console.error('❌ Error extracting RAML from ZIP:', error);
    throw error;
  }
}

/**
 * Extract RAML content from base64 encoded ZIP
 * @param {string} base64Zip - Base64 encoded ZIP content
 * @param {string} tempFileName - Temporary file name
 * @returns {Promise<string>} - Extracted RAML content
 */
export async function extractRamlFromBase64Zip(base64Zip, tempFileName = 'temp-raml.zip') {
  try {
    const tempDir = path.join(__dirname, '..', 'uploads', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempZipPath = path.join(tempDir, tempFileName);
    
    // Write base64 to file
    const buffer = Buffer.from(base64Zip, 'base64');
    fs.writeFileSync(tempZipPath, buffer);

    // Extract RAML
    const ramlContent = await extractRamlFromZip(tempZipPath);

    // Clean up temp file
    try {
      fs.unlinkSync(tempZipPath);
    } catch (e) {
      console.warn('⚠️ Failed to clean up temp ZIP file:', e.message);
    }

    return ramlContent;

  } catch (error) {
    console.error('❌ Error extracting RAML from base64 ZIP:', error);
    throw error;
  }
}

/**
 * Extract RAML content from file buffer or text
 * @param {Buffer|string} fileData - File data (buffer or text)
 * @param {string} fileName - File name
 * @returns {Promise<string>} - RAML content
 */
export async function extractRamlFromFile(fileData, fileName) {
  try {
    const lowerFileName = fileName.toLowerCase();

    // If it's a ZIP file
    if (lowerFileName.endsWith('.zip')) {
      if (typeof fileData === 'string') {
        // Assume it's base64 encoded
        return await extractRamlFromBase64Zip(fileData, fileName);
      } else if (Buffer.isBuffer(fileData)) {
        // Write buffer to temp file and extract
        const tempDir = path.join(__dirname, '..', 'uploads', 'temp');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        const tempZipPath = path.join(tempDir, fileName);
        fs.writeFileSync(tempZipPath, fileData);
        const ramlContent = await extractRamlFromZip(tempZipPath);
        
        // Clean up
        try {
          fs.unlinkSync(tempZipPath);
        } catch (e) {
          console.warn('⚠️ Failed to clean up temp ZIP file:', e.message);
        }
        
        return ramlContent;
      }
    }

    // If it's a RAML file (text)
    if (lowerFileName.endsWith('.raml')) {
      if (typeof fileData === 'string') {
        return fileData;
      } else if (Buffer.isBuffer(fileData)) {
        return fileData.toString('utf8');
      }
    }

    throw new Error(`Unsupported file type: ${fileName}. Expected .raml or .zip file.`);

  } catch (error) {
    console.error('❌ Error extracting RAML from file:', error);
    throw error;
  }
}
