'use strict'

const isDevelopment = process.env.NODE_ENV === 'development';
const isStaging = process.env.NODE_ENV === 'staging';
const isProduction = !isDevelopment && !isStaging;

const cogsearchIndex = isDevelopment ? 'convmemorydev-large' : 'convmemory3-large';
const cogsearchIndexChunks = isDevelopment ? 'patient-chunks-dev' : 'patient-chunks-prod';

const WELL_KNOWN_PATH_DEV = 'public/.well-known-dev/microsoft-identity-association.json';
const WELL_KNOWN_PATH_PROD = 'public/.well-known-prod/microsoft-identity-association.json';

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function buildFirebaseCredential() {
  return {
    type: 'service_account',
    project_id: requireEnv('FIREBASE_PROJECT_ID'),
    private_key_id: requireEnv('FIREBASE_PRIVATE_KEY_ID'),
    private_key: requireEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    client_email: requireEnv('FIREBASE_CLIENT_EMAIL'),
    client_id: requireEnv('FIREBASE_CLIENT_ID'),
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: requireEnv('FIREBASE_CERT_URL'),
    universe_domain: 'googleapis.com'
  };
}

module.exports = {
  client_server: requireEnv('CLIENT_SERVER'),
  port: process.env.PORT || 8443,
  dbaccounts: requireEnv('MONGODBACCOUNTS'),
  dbdata: requireEnv('MONGODBDATA'),
  SECRET_TOKEN: requireEnv('SECRET_TOKEN'),
  TRANSPORTER_OPTIONS: {
    host: 'smtp.office365.com',
    port: '587',
    secureConnection: false,
    tls: { ciphers: 'SSLv3' },
    auth: {
      user: process.env.EMAIL_USER || 'support@foundation29.org',
      pass: requireEnv('EMAIL_PASSWORD')
    }
  },
  SECRET_KEY_CRYPTO: requireEnv('SECRET_KEY_CRYPTO'),
  translationKey: requireEnv('TRANSLATION_KEY'),
  translationKeySecondary: requireEnv('TRANSLATION_KEY_SECONDARY'),
  translationRegionPrimary: process.env.TRANSLATION_REGION_PRIMARY || 'northeurope',
  translationRegionSecondary: process.env.TRANSLATION_REGION_SECONDARY || 'westeurope',
  BLOB: {
    KEY: requireEnv('BLOBKEY'),
    NAMEBLOB: requireEnv('BLOBNAME'),
    SAS: requireEnv('BLOBSAS'),
  },
  SEARCH_API_KEY: requireEnv('SEARCH_API_KEY'),
  SEARCH_API_ENDPOINT: requireEnv('SEARCH_API_ENDPOINT'),
  OPENAI_API_VERSION: process.env.OPENAI_API_VERSION || '2023-06-01-preview',
  OPENAI_API_BASE_GPT4O: requireEnv('OPENAI_API_BASE_GPT4O'),
  O_A_K_GPT4O: requireEnv('O_A_K_GPT4O'),
  OPENAI_API_BASE_FALLBACK: requireEnv('OPENAI_API_BASE_FALLBACK'),
  O_A_K_FALLBACK: requireEnv('O_A_K_FALLBACK'),
  OPENAI_API_BASE_ADVANCED: requireEnv('OPENAI_API_BASE_ADVANCED'),
  O_A_K_ADVANCED: requireEnv('O_A_K_ADVANCED'),
  FIREBASE: buildFirebaseCredential(),
  WEBPUBSUB: {
    NAME: requireEnv('WEBPUBSUB_NAME'),
    KEY: requireEnv('WEBPUBSUB_KEY'),
    HUB: process.env.WEBPUBSUB_HUB || 'Hub'
  },
  DEEPL_API_KEY: requireEnv('DEEPL_API_KEY'),
  GOOGLE_API_KEY: requireEnv('GOOGLE_API_KEY'),
  INSIGHTS: requireEnv('INSIGHTS'),
  LANGSMITH_API_KEY: requireEnv('LANGSMITH_API_KEY'),
  LANGSMITH_PROJECT: isDevelopment ? 'DEV Server Run' : isStaging ? 'STAGING Server Run' : 'PROD Server Run',
  FORM_RECOGNIZER_KEY: requireEnv('FORM_RECOGNIZER_KEY'),
  FORM_RECOGNIZER_ENDPOINT: requireEnv('FORM_RECOGNIZER_ENDPOINT'),
  Server_Key: requireEnv('SERVER_KEY'),
  allowedOrigins: process.env.ALLOWEDORIGINS ? process.env.ALLOWEDORIGINS.split(',') : ['https://nav29.org', 'https://www.nav29.org'],
  wellKnownPath: isDevelopment ? WELL_KNOWN_PATH_DEV : WELL_KNOWN_PATH_PROD,
  version: 'gemini',
  subversion: '1.0.2',
  GOCERTIUS: {
    TOKEN_URL: process.env.GOCERTIUS_TOKEN_URL || 'https://sso.garrigues.io.builders/oauth2/aus653dgdgTFL2mhw417/v1/token',
    CLIENT_ID: requireEnv('GOCERTIUS_CLIENT_ID'),
    CLIENT_SECRET: requireEnv('GOCERTIUS_CLIENT_SECRET'),
    API_URL: process.env.GOCERTIUS_API_URL || 'https://api.pre.gcloudfactory.com/digital-trust'
  },
  PERPLEXITY_API_KEY: requireEnv('PERPLEXITY_API_KEY'),
  MEDISEARCH_API_KEY: requireEnv('MEDISEARCH_API_KEY'),
  cogsearchIndex: cogsearchIndex,
  cogsearchIndexChunks: cogsearchIndexChunks,
  DXGPT_SUBSCRIPTION_KEY: requireEnv('DXGPT_SUBSCRIPTION_KEY'),
  AZURE_SPEECH_KEY: requireEnv('AZURE_SPEECH_KEY'),
  AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION || 'westeurope',
  WHATSAPP_BOT_SECRET: requireEnv('WHATSAPP_BOT_SECRET')
}
