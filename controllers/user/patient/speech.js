// Controller para manejar el reconocimiento de voz usando Azure Speech Services
// Este endpoint genera tokens temporales para proteger la API key de Azure

const config = require('../../../config');
const insights = require('../../../services/insights');
const axios = require('axios');

/**
 * Genera un token temporal para Azure Speech Services
 * Este token permite al cliente usar Azure Speech sin exponer la API key
 * Los tokens expiran después de 10 minutos
 */
exports.getSpeechToken = async (req, res) => {
  try {
    const azureSpeechKey = config.AZURE_SPEECH_KEY;
    const azureSpeechRegion = config.AZURE_SPEECH_REGION;

    if (!azureSpeechKey || !azureSpeechRegion) {
      return res.status(500).json({ 
        error: 'Azure Speech Services no está configurado en el servidor' 
      });
    }

    // Generar token temporal usando la API de Azure
    // El token expira en 10 minutos, después el cliente debe pedir uno nuevo
    const tokenUrl = `https://${azureSpeechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
    
    try {
      const response = await axios.post(tokenUrl, null, {
        headers: {
          'Ocp-Apim-Subscription-Key': azureSpeechKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 5000
      });

      const token = response.data; // El token es un string
      
      res.json({
        token: token,
        region: azureSpeechRegion,
        expiresIn: 600 // 10 minutos en segundos
      });
    } catch (tokenError) {
      console.error('Error generando token de Azure:', tokenError);
      insights.error({ message: 'Error generando token de Azure Speech', error: tokenError });
      
      // Fallback: devolver solo la región si falla la generación de token
      // El cliente puede usar la key directamente (menos seguro pero funcional)
      res.json({
        region: azureSpeechRegion,
        error: 'No se pudo generar token temporal, usando modo directo'
      });
    }
  } catch (error) {
    console.error('Error getting speech token:', error);
    insights.error({ message: 'Error getting speech token', error });
    res.status(500).json({ error: 'Error al obtener token de reconocimiento de voz' });
  }
};

/**
 * Endpoint alternativo: procesa audio desde el servidor
 * El cliente envía el audio, el servidor lo procesa con Azure y devuelve el texto
 */
exports.processSpeechAudio = async (req, res) => {
  try {
    const azureSpeechKey = config.AZURE_SPEECH_KEY;
    const azureSpeechRegion = config.AZURE_SPEECH_REGION;

    if (!azureSpeechKey || !azureSpeechRegion) {
      return res.status(500).json({ 
        error: 'Azure Speech Services no está configurado en el servidor' 
      });
    }

    // Aquí procesarías el audio usando Azure Speech SDK en el servidor
    // Por ahora, este es un placeholder para la implementación futura
    
    res.status(501).json({ 
      error: 'Procesamiento de audio en servidor no implementado aún. Usa getSpeechToken.' 
    });
  } catch (error) {
    console.error('Error processing speech audio:', error);
    insights.error({ message: 'Error processing speech audio', error });
    res.status(500).json({ error: 'Error al procesar audio' });
  }
};

