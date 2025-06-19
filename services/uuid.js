'use strict';

const crypto = require('crypto');

/**
 * Generates a deterministic UUID v5 based on a patient ID
 * This ensures the same patient always gets the same UUID
 * @param {string} patientId - The patient ID to generate UUID from
 * @returns {string} A deterministic UUID v5
 */
function generatePatientUUID(patientId) {
  // Using UUID v4 namespace (standard namespace for random UUIDs)
  const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  
  // Create SHA1 hash of namespace + patientId
  const hash = crypto.createHash('sha1')
    .update(namespace + patientId)
    .digest('hex');
  
  // Format as UUID v5 (note: the '5' in the version field indicates SHA1-based UUID)
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '5' + hash.substring(13, 16),  // Version 5 UUID
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
    hash.substring(20, 32)
  ].join('-');
}

/**
 * Generates a random UUID v4
 * @returns {string} A random UUID v4
 */
function generateRandomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

module.exports = {
  generatePatientUUID,
  generateRandomUUID
};