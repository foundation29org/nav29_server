'use strict'

const config = require('../config')
const crypto = require('crypto');

/**
 * Deriva la key usando el mismo algoritmo que crypto.createCipher (EVP_BytesToKey con MD5)
 * Esto mantiene compatibilidad con datos encriptados existentes
 * @param {string} password - La contraseña/secreto
 * @param {number} keyLen - Longitud de la key en bytes (32 para AES-256)
 * @returns {Buffer} - La key derivada
 */
function deriveKeyFromPassword(password, keyLen = 32) {
  let key = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  
  while (key.length < keyLen) {
    const hash = crypto.createHash('md5');
    hash.update(prev);
    hash.update(password, 'utf8');
    prev = hash.digest();
    key = Buffer.concat([key, prev]);
  }
  
  return key.slice(0, keyLen);
}

/**
 * Encripta datos usando AES-256-ECB
 * Compatible con Node 22+ usando createCipheriv
 * Genera el mismo output que el antiguo createCipher para mantener
 * compatibilidad con datos existentes (customShare tokens, container names, etc.)
 */
function encrypt(data) {
  const key = deriveKeyFromPassword(config.SECRET_KEY_CRYPTO, 32);
  // ECB mode no usa IV, pero createCipheriv lo requiere - usamos buffer vacío
  const cipher = crypto.createCipheriv('aes-256-ecb', key, Buffer.alloc(0));
  return cipher.update(data, 'utf8', 'hex') + cipher.final('hex');
}

/**
 * Desencripta datos
 * Compatible con Node 22+ usando createDecipheriv
 */
function decrypt(data) {
  const key = deriveKeyFromPassword(config.SECRET_KEY_CRYPTO, 32);
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, Buffer.alloc(0));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

/**
 * Genera un nombre de contenedor válido para Azure Blob Storage
 * 
 * Azure Container naming rules:
 * - 3-63 caracteres
 * - Solo letras minúsculas, números y guiones (-)
 * - No puede empezar ni terminar con guión
 * 
 * MÉTODO ACTUAL: Usa SHA256(patientId + secret) truncado a 63 chars
 * Más limpio y predecible que el método legacy.
 * 
 * NOTA: Para contenedores existentes que usan el método legacy,
 * usar getContainerNameLegacy() o migrar con el script de migración.
 * 
 * @param {string} patientId - El ObjectId del paciente
 * @returns {string} - Nombre del contenedor válido para Azure (63 chars)
 */
function getContainerName(patientId) {
  // SHA256 genera un hash determinístico de 64 chars hex
  // Truncamos a 63 para cumplir el límite de Azure
  const hash = crypto.createHash('sha256')
    .update(patientId.toString())
    .update(config.SECRET_KEY_CRYPTO)
    .digest('hex');
  return hash.substring(0, 63);
}

/**
 * Genera el nombre de contenedor usando el método LEGACY
 * Para compatibilidad con contenedores existentes creados antes de la migración.
 * 
 * Método: encrypt(patientId).substring(1)
 * 
 * @param {string} patientId - El ObjectId del paciente
 * @returns {string} - Nombre del contenedor legacy (63 chars)
 */
function getContainerNameLegacy(patientId) {
  const encrypted = encrypt(patientId.toString());
  return encrypted.substring(1);
}

/**
 * Obtiene el patientId encriptado completo (para URLs de invitación)
 * @param {string} patientId - El ObjectId del paciente
 * @returns {string} - PatientId encriptado (64 caracteres)
 */
function getEncryptedPatientId(patientId) {
  return encrypt(patientId.toString());
}

/**
 * Obtiene el nombre del contenedor desde un patientId ya encriptado
 * Descifra el patientId y luego genera el nombre con SHA256
 * 
 * @param {string} encryptedPatientId - El patientId ya encriptado (de URL)
 * @returns {string} - Nombre del contenedor SHA256 (63 caracteres)
 */
function getContainerNameFromEncrypted(encryptedPatientId) {
  const patientId = decrypt(encryptedPatientId);
  return getContainerName(patientId);
}

module.exports = {
  encrypt,
  decrypt,
  getContainerName,         // Nuevo método (SHA256) - para futuros contenedores
  getContainerNameLegacy,   // Método legacy - para contenedores existentes
  getEncryptedPatientId,
  getContainerNameFromEncrypted
}
