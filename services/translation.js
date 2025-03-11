'use strict'

const config = require('../config')
const request = require('request')
const deepl = require('deepl-node');
const insights = require('../services/insights')
const deeplApiKey = config.DEEPL_API_KEY;

function getDetectLanguage(req, res) {
    var jsonText = req.body;
    var translationKey = config.translationKey;
    request.post({ url: 'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0', json: true, headers: { 'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' }, body: jsonText }, (error, response, body) => {
      if (error) {
        console.error(error)
        insights.error(error);
        res.status(500).send(error)
      }
      if (body == 'Missing authentication token.') {
        res.status(401).send(body)
      } else {
        res.status(200).send(body)
      }
  
    });
  }

async function getDetectLanguage2(text) {
  return new Promise((resolve, reject) => {
    var jsonText = [{ "Text": text.substring(0, 10000)}];
    var translationKey = config.translationKey;
    request.post({ url: 'https://api.cognitive.microsofttranslator.com/detect?api-version=3.0', json: true, headers: { 'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' }, body: jsonText }, (error, response, body) => {
      if (error) {
        console.error(error)
        insights.error(error);
        reject(error);
      }
      if (body == 'Missing authentication token.') {
        resolve(body);
      } else {
        resolve(body);
      }
    });
  });
}


function getTranslationDictionary (req, res){
  var lang = req.body.lang;
  var info = req.body.info;
  var translationKey = config.translationKey;
  request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from='+lang+'&to=en',json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:info}, (error, response, body) => {
    if (error) {
      console.error(error)
      insights.error(error);
      res.status(500).send(error)
    }
    if(body=='Missing authentication token.'){
      res.status(401).send(body)
    }else{
      res.status(200).send(body)
    }

  });
}

function getTranslationDictionary2 (text, source_lang){
  return new Promise(async function (resolve, reject) { 
   var lang = source_lang;
  var info = text;
  var translationKey = config.translationKey;
  request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from='+lang+'&to=en',json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:info}, (error, response, body) => {
    if (error) {
      console.error(error)
      insights.error(error);
      reject(error)
    }
    if(body=='Missing authentication token.'){
      resolve(body)
    }else{
      resolve(body)
    }
  });
});
}

function getTranslationDictionaryInvert (req, res){
  var lang = req.body.lang;
  var info = req.body.info;
  var translationKey = config.translationKey;
  request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=en&to='+lang,json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:info}, (error, response, body) => {
    if (error) {
      console.error(error)
      insights.error(error);
      res.status(500).send(error)
    }
    if(body=='Missing authentication token.'){
      res.status(401).send(body)
    }else{
      res.status(200).send(body)
    }

  });
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

function getTranslationDictionaryInvertMicrosoft2 (text, source_lang){
  return new Promise(async function (resolve, reject) {
  var lang = source_lang;
  var info = text;
  var translationKey = config.translationKey;
  request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=en&to='+lang,json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:info}, (error, response, body) => {
    if (error) {
      console.error(error)
      insights.error(error);
      reject(error)
    }
    if(body=='Missing authentication token.'){
      resolve(body)
    }else{
      resolve(body)
    }

  });
});
}

function getTranslationSegments(req, res){
    var lang = req.body.lang;
    var segments = req.body.segments;
    var translationKey = config.translationKey;
    request.post({url:'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&&from=en&to='+lang+'&textType=html',json: true,headers: {'Ocp-Apim-Subscription-Key': translationKey, 'Ocp-Apim-Subscription-Region': 'northeurope' },body:segments}, (error, response, body) => {
      if (error) {
        console.error(error)
        insights.error(error);
        res.status(500).send(error)
      }
      if(body=='Missing authentication token.'){
        insights.error(body);
        res.status(401).send(body)
      }else{
        res.status(200).send(body)
      }
  
    });
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
      console.log({
        sourceText: text,
        detectedLanguage: result.detectedSourceLang,
        targetLanguage: target,
        translatedText: result.text
      });
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

module.exports = {
  getDetectLanguage,
  getDetectLanguage2,
  getTranslationDictionary,
  getTranslationDictionary2,
  getTranslationDictionaryInvert,
  getTranslationDictionaryInvertMicrosoft2,
  getTranslationSegments,
  getDeeplCode,
  deepLtranslate,
  getdeeplTranslationDictionaryInvert,
  getTranslationTimeline
}
