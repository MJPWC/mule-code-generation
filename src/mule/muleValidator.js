import validator from 'xsd-schema-validator';
import path from 'path';
import fs from 'fs';

const XSD_SCHEMA_PATHS = {
  'http://www.mulesoft.org/schema/mule/core': path.resolve(process.cwd(), 'src/main/resources/schemas/mule.xsd'),
  'http://www.mulesoft.org/schema/mule/http': path.resolve(process.cwd(), 'src/main/resources/schemas/mule-http.xsd'),
  'http://www.mulesoft.org/schema/mule/quartz': path.resolve(process.cwd(), 'src/main/resources/schemas/mule-quartz.xsd'),
  // Add other Mule 4 schemas as needed
};

/**
 * Validates a Mule XML string against its declared XSD schemas.
 * @param {string} xmlContent - The Mule XML content as a string.
 * @returns {Promise<{isValid: boolean, errors: Array<string>}>} Validation result.
 */
export async function validateMuleXml(xmlContent) {
  let isValid = true;
  const errors = [];

  // Extract schema locations from xmlContent to determine which XSDs to use
  const schemaLocationMatch = xmlContent.match(/xsi:schemaLocation=\"[^\"]+\"/);

  if (schemaLocationMatch) {
    const schemaLocations = schemaLocationMatch[0].replace('xsi:schemaLocation="', '').slice(0, -1).split(/\s+/);

    for (let i = 0; i < schemaLocations.length; i += 2) {
      const namespaceUri = schemaLocations[i];
      const schemaPath = schemaLocations[i + 1];

      const localXsdPath = XSD_SCHEMA_PATHS[namespaceUri];

      if (localXsdPath && fs.existsSync(localXsdPath)) {
        try {
          const result = await validator.validateXML(xmlContent, localXsdPath);
          if (!result.valid) {
            isValid = false;
            errors.push(...result.messages);
          }
        } catch (error) {
          isValid = false;
          errors.push(`XML validation error against ${namespaceUri} (${localXsdPath}): ${error.message}`);
        }
      } else if (schemaPath) {
        errors.push(`Warning: Could not find local XSD for namespace ${namespaceUri} at ${localXsdPath || schemaPath}. Validation skipped for this schema.`);
      }
    }
  } else {
    errors.push("Warning: No xsi:schemaLocation found in the XML content. Cannot perform schema validation.");
    isValid = false; // Consider this invalid if schemaLocation is missing
  }

  return { isValid, errors };
}

