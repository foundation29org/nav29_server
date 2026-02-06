'use strict'

const config = require('../config')
const request = require('request')
const deepl = require('deepl-node');
const insights = require('../services/insights')
const deeplApiKey = config.DEEPL_API_KEY;

// Configuración de retry
const MAX_RETRIES = 2; // Número de reintentos por región
const RETRY_DELAY = 1000; // Delay en ms entre reintentos

// Helper function para hacer retry con delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function para hacer una petición de traducción con retry y fallback
async function translateWithRetryAndFallback(url, body, options) {
  const regions = [
    { key: config.translationKey, region: config.translationRegionPrimary },
    { key: config.translationKeySecondary, region: config.translationRegionSecondary }
  ];

  let lastError = null;

  for (const regionConfig of regions) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          await delay(RETRY_DELAY * attempt); // Backoff exponencial
        }

        const result = await new Promise((resolve, reject) => {
          const headers = {
            'Ocp-Apim-Subscription-Key': regionConfig.key,
            'Ocp-Apim-Subscription-Region': regionConfig.region,
            ...options.headers
          };

          request.post({
            url: url,
            json: true,
            headers: headers,
            body: body
          }, (error, response, responseBody) => {
            if (error) {
              reject(error);
            } else if (responseBody === 'Missing authentication token.') {
              // Si es error de autenticación, rechazar inmediatamente sin retry
              reject(new Error('Missing authentication token'));
            } else if (response && response.statusCode >= 400) {
              reject(new Error(`HTTP ${response.statusCode}: ${JSON.stringify(responseBody)}`));
            } else if (responseBody && typeof responseBody === 'object' && responseBody.error) {
              // Si la respuesta tiene un error, rechazar
              reject(new Error(responseBody.error.message || JSON.stringify(responseBody.error)));
            } else {
              resolve(responseBody);
            }
          });
        });

        // Si llegamos aquí, la petición fue exitosa
        return result;
      } catch (error) {
        lastError = error;
        const regionName = regionConfig.region;
        const attemptNum = attempt + 1;
        
        // Si es un error de autenticación, no hacer retry ni cambiar de región
        if (error.message && error.message.includes('Missing authentication token')) {
          insights.error({ 
            message: `Authentication error for region ${regionName}, skipping retries and fallback`, 
            error: error.message 
          });
          throw error; // Lanzar inmediatamente sin intentar otras regiones
        }
        
        if (attempt < MAX_RETRIES) {
          insights.error({ 
            message: `Translation attempt ${attemptNum}/${MAX_RETRIES + 1} failed for region ${regionName}, retrying...`, 
            error: error.message 
          });
        } else {
          insights.error({ 
            message: `All retries exhausted for region ${regionName}, trying next region...`, 
            error: error.message 
          });
        }
      }
    }
  }

  // Si llegamos aquí, todas las regiones y reintentos fallaron
  insights.error({ 
    message: 'All translation attempts failed (all regions and retries exhausted)', 
    error: lastError 
  });
  throw lastError || new Error('Translation failed after all retries and fallbacks');
}

// Helper function para detección de idioma con retry y fallback
async function detectLanguageWithRetryAndFallback(text) {
  const url = 'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0';
  const body = [{ "Text": text.substring(0, 10000) }];
  
  return await translateWithRetryAndFallback(url, body, { headers: {} });
}



async function getDetectLanguage(text) {
  try {
    return await detectLanguageWithRetryAndFallback(text);
  } catch (error) {
    console.error('Error in getDetectLanguage after all retries:', error);
    insights.error({ message: 'Error in getDetectLanguage', error: error });
    throw error;
  }
}

async function getTranslationDictionary (text, source_lang){
  try {
    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${source_lang}&to=en`;
    return await translateWithRetryAndFallback(url, text, { headers: {} });
  } catch (error) {
    console.error('Error in getTranslationDictionary after all retries:', error);
    insights.error({ message: 'Error in getTranslationDictionary', error: error });
    throw error;
  }
}

async function getTranslationDictionaryInvert (req, res){
  try {
    const lang = req.body.lang;
    const info = req.body.info;
    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${lang}`;
    const result = await translateWithRetryAndFallback(url, info, { headers: {} });
    res.status(200).send(result);
  } catch (error) {
    console.error('Error in getTranslationDictionaryInvert after all retries:', error);
    insights.error({ message: 'Error in getTranslationDictionaryInvert', error: error });
    
    // Manejar errores de autenticación específicamente
    if (error.message && error.message.includes('Missing authentication token')) {
      res.status(401).send('Missing authentication token.');
    } else {
      res.status(500).send(error);
    }
  }
}

async function getdeeplTranslationDictionaryInvert (req, res){
  
  var lang = req.body.lang;
  var info = req.body.info;
  try{
    var deepl_code = await getDeeplCode(lang);
    if (deepl_code == null) {
      const inverseTranslatedText = await getTranslationDictionaryInvertMicrosoft2(info, lang);
      let source_text = inverseTranslatedText[0].translations[0].text
      res.status(200).send({text: source_text})
    } else {
      if(info[0].Text == null || info[0].Text == undefined || info[0].Text == ''){
        res.status(200).send({text: ''})
      }else{
        let source_text = await deepLtranslate(info[0].Text, deepl_code);
        res.status(200).send({text: source_text})
      }
      
    }
  }catch(e){
    console.log(e)
    res.status(200).send({text: info[0].Text})
  }

 
}

async function getTranslationTimeline (req, res){
  var lang = req.body.lang;
  var info = req.body.info;
  var deepl_code = await getDeeplCode(lang);
  if (deepl_code == null) {
    const inverseTranslatedText = await getTranslationDictionaryInvertMicrosoft2(info, lang);
    let source_text = inverseTranslatedText[0].translations[0].text
    res.status(200).send({text: source_text})
  } else {
     // Realiza una traducción para cada fragmento de texto
    for(let item of info){
      if(item.keyMedicalEvent == null || item.keyMedicalEvent == undefined || item.keyMedicalEvent == ''){
        translatedLines.push('');
      }else{
        item.keyMedicalEvent = await deepLtranslate2(item.keyMedicalEvent, deepl_code);
      }
    }
    res.status(200).send(info);
  }
}

async function getTranslationDictionaryInvertMicrosoft2 (text, source_lang){
  try {
    const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${source_lang}`;
    return await translateWithRetryAndFallback(url, text, { headers: {} });
  } catch (error) {
    console.error('Error in getTranslationDictionaryInvertMicrosoft2 after all retries:', error);
    insights.error({ message: 'Error in getTranslationDictionaryInvertMicrosoft2', error: error });
    throw error;
  }
}

  const langDict = {
    "af": null,
    "sq": null,
    "am": null,
    "ar": null,
    "hy": null,
    "as": null,
    "az": null,
    "bn": null,
    "ba": null,
    "eu": null,
    "bs": null,
    "bg": "BG",
    "yue": null,
    "ca": null,
    "lzh": null,
    "zh-Hans": "ZH",
    "zh-Hant": "ZH",
    "hr": null,
    "cs": "CS",
    "da": "DA",
    "prs": null,
    "dv": null,
    "nl": "NL",
    "en": "EN-US",
    "et": "ET",
    "fo": null,
    "fj": null,
    "fil": null,
    "fi": "FI",
    "fr": "FR",
    "fr-ca": null,
    "gl": null,
    "ka": null,
    "de": "DE",
    "el": "EL",
    "gu": null,
    "ht": null,
    "he": null,
    "hi": null,
    "mww": null,
    "hu": "HU",
    "is": null,
    "id": "ID",
    "ikt": null,
    "iu": null,
    "iu-Latn": null,
    "ga": null,
    "it": "IT",
    "ja": "JA",
    "kn": null,
    "kk": null,
    "km": null,
    "tlh-Latn": null,
    "tlh-Piqd": null,
    "ko": "KO",
    "ku": null,
    "kmr": null,
    "ky": null,
    "lo": null,
    "lv": "LV",
    "lt": "LT",
    "mk": null,
    "mg": null,
    "ms": null,
    "ml": null,
    "mt": null,
    "mi": null,
    "mr": null,
    "mn-Cyrl": null,
    "mn-Mong": null,
    "my": null,
    "ne": null,
    "nb": "NB",
    "or": null,
    "ps": null,
    "fa": null,
    "pl": "PL",
    "pt": "pt-PT",
    "pt-pt": null,
    "pa": null,
    "otq": null,
    "ro": "RO",
    "ru": "RU",
    "sm": null,
    "sr-Cyrl": null,
    "sr-Latn": null,
    "sk": "SK",
    "sl": "SL",
    "so": null,
    "es": "ES",
    "sw": null,
    "sv": "SV",
    "ty": null,
    "ta": null,
    "tt": null,
    "te": null,
    "th": null,
    "bo": null,
    "ti": null,
    "to": null,
    "tr": "TR",
    "tk": null,
    "uk": "UK",
    "hsb": null,
    "ur": null,
    "ug": null,
    "uz": null,
    "vi": null,
    "cy": null,
    "yua": null,
    "zu": null,
    "null": null
};

async function getDeeplCode(msCode) {
    return langDict[msCode] || null;
}


function isHTML(text) {
  const htmlRegex = /<\/?[a-z][\s\S]*>/i; // Verifica si hay etiquetas HTML
  return htmlRegex.test(text);
}
async function deepLtranslate(text, target) {
  try{
    if(text == null || text == undefined || text == ''){
      return '';
    }else{
      const translator = new deepl.Translator(deeplApiKey);
      
      /*const options = isHTML(text) ? { 
        tagHandling: 'html', 
        preserveFormatting: true, 
        splitSentences: 'on' // O 'off' según lo que necesites
    } : { 
        preserveFormatting: false,
        splitSentences: 'off' // O 'on' según lo que necesites
    };*/

    const options = isHTML(text) ? { 
      tagHandling: 'html', 
      preserveFormatting: true, 
      splitSentences: 'on' // O 'off' según lo que necesites
  } : { 
      preserveFormatting: true,
      splitSentences: 'off' // O 'on' según lo que necesites
  };
 
      const result = await translator.translateText(text, null, target, options);
      /*console.log({
        sourceText: text,
        detectedLanguage: result.detectedSourceLang,
        targetLanguage: target,
        translatedText: result.text
      });*/
      return result.text;
    }
  }catch(e){
    console.log(e)
    console.log(text)
    console.log(target)
    return text;
  }
    
}

async function deepLtranslate2(text, target) {
  if(text == null || text == undefined || text == ''){
    return '';
  }else{
    const translator = new deepl.Translator(deeplApiKey);

     const options = isHTML(text) ? { 
        tagHandling: 'html', 
        preserveFormatting: true, 
        splitSentences: 'on' // O 'off' según lo que necesites
    } : { 
        preserveFormatting: false,
        splitSentences: 'off' // O 'on' según lo que necesites
    };
      const result = await translator.translateText(text, null, target, options);
    return result.text;
  }
 
}

/**
 * Traduce texto de inglés al idioma del usuario
 * Usa DeepL si está soportado, sino Microsoft Translator
 * @param {string} text - Texto en inglés a traducir
 * @param {string} targetLang - Código de idioma destino (ej: 'es', 'fr', 'de')
 * @returns {Promise<string>} - Texto traducido
 */
async function translateToUserLang(text, targetLang) {
  try {
    if (!text || text.trim() === '' || !targetLang || targetLang === 'en') {
      return text; // No traducir si es vacío o ya es inglés
    }
    
    const deeplCode = await getDeeplCode(targetLang);
    
    if (deeplCode) {
      // Usar DeepL
      return await deepLtranslate(text, deeplCode);
    } else {
      // Usar Microsoft Translator
      const info = [{ "Text": text }];
      const result = await getTranslationDictionaryInvertMicrosoft2(info, targetLang);
      if (result && result[0] && result[0].translations && result[0].translations[0]) {
        return result[0].translations[0].text;
      }
      return text;
    }
  } catch (error) {
    console.error('Error in translateToUserLang:', error);
    return text; // En caso de error, devolver el texto original
  }
}

module.exports = {
  getDetectLanguage,
  getTranslationDictionary,
  getTranslationDictionaryInvert,
  getTranslationDictionaryInvertMicrosoft2,
  getDeeplCode,
  deepLtranslate,
  getdeeplTranslationDictionaryInvert,
  getTranslationTimeline,
  translateToUserLang
}
