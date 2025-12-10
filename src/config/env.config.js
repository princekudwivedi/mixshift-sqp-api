const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Centralized Environment Configuration
 */
function env(name, defaultValue = null) {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : defaultValue;
}

// Safe integer parser
function toInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

let secretsLoadPromise = null;

/**
 * Whether AWS secrets should be auto-loaded
 */
function shouldAutoLoadSecrets(options = {}) {
  if (options.force) return true;
  const disabled = (process.env.AWS_SECRETS_AUTO_LOAD || '').toLowerCase() === 'false';
  return !disabled;
}

/**
 * Load AWS Secrets into environment
 */
async function loadAwsSecrets(options = {}) {
  const {
    constantsPath = process.env.AWS_SECRETS_CONSTANTS_PATH,
    databasePath = process.env.AWS_SECRETS_DATABASE_PATH,
    overwrite = false,
    force = false,
  } = options;

  if (!shouldAutoLoadSecrets({ force })) {
    console.info('[env.config] AWS SSM auto load disabled via AWS_SECRETS_AUTO_LOAD=false');
    return { constants: {}, database: {} };
  }

  if (!secretsLoadPromise || force) {
    secretsLoadPromise = (async () => {
      const service = require('../services/aws.secrets.manager.service');
      const results = { constants: {}, database: {} };

      if (constantsPath) {
        results.constants = await loadPath(constantsPath, { overwrite, service, label: 'constants' });
      }

      if (databasePath) {
        results.database = await loadPath(databasePath, { overwrite, service, label: 'database settings' });
      }

      return results;
    })();
  }

  return secretsLoadPromise;
}

/**
 * Base Configuration Object
 */
let config = {
  // Application
  NODE_ENV: env('NODE_ENV', 'development'),
  PORT: toInt(env('PORT', 3001)),

  // CORS
  ALLOWED_ORIGINS: env('ALLOWED_ORIGINS', ''),

  // Amazon SP API
  AMAZON_SP_API_BASE_URL: env('AMAZON_SP_API_BASE_URL', ''),
  AMAZON_SP_API_ASIA_BASE_URL: env('AMAZON_SP_API_ASIA_BASE_URL', ''),
  AMAZON_SP_API_EUROPE_BASE_URL: env('AMAZON_SP_API_EUROPE_BASE_URL', ''),

  // Table Names
  TBL_USERS: env('TBL_USERS', 'users'),
  TBL_SQP_DOWNLOAD_URLS: env('TBL_SQP_DOWNLOAD_URLS', 'sqp_download_urls'),
  TBL_SQP_CRON_DETAILS: env('TBL_SQP_CRON_DETAILS', 'sqp_cron_details'),
  TBL_SQP_CRON_LOGS: env('TBL_SQP_CRON_LOGS', 'sqp_cron_logs'),
  TBL_SELLER: env('TBL_SELLER', 'seller'),
  TBL_MARKET_PLACE: env('TBL_MARKET_PLACE', 'marketplace'),
  TBL_SELLER_MARKET_PLACES_MAPPING: env('TBL_SELLER_MARKET_PLACES_MAPPING', 'seller_marketplaces_mapping'),
  TBL_SELLER_ASIN_LIST: env('TBL_SELLER_ASIN_LIST', 'seller_ASIN_list'),
  TBL_USER_DB_MAP: env('TBL_USER_DB_MAP', 'user_database_mapping'),
  TBL_USER_DATABASES: env('TBL_USER_DATABASES', 'user_databases'),
  TBL_USER_DATABASE_CREDENTIALS: env('TBL_USER_DATABASE_CREDENTIALS', 'user_database_credentials'),
  TBL_TIMEZONES: env('TBL_TIMEZONES', 'timezones'),
  TBL_OAUTH_TOKENS: env('TBL_MWS_OAUTH_TOKEN', 'tbl_mws_oauth_token'),
  TBL_MWS_ACCESS_KEYS: env('TBL_MWS_ACCESS_KEYS', 'mws_access_keys'),
  TBL_STS_TOKENS: env('TBL_SPAPI_STS_TOKEN', 'sp_api_sts'),
  TBL_MWS_ITEMS: env('TBL_MWS_ITEMS', 'mws_items'),

  // Logging
  LOG_LEVEL: env('LOG_LEVEL', 'info'),

  // File Upload
  MAX_FILE_SIZE: toInt(env('MAX_FILE_SIZE', 10485760)), // 10MB
  UPLOAD_PATH: env('UPLOAD_PATH', './uploads'),

  // Email
  SMTP_HOST: env('SMTP_HOST'),
  SMTP_PORT: toInt(env('SMTP_PORT', 587)),
  SMTP_USER: env('SMTP_USER'),
  SMTP_PASS: env('SMTP_PASS'),
  FROM_EMAIL: env('FROM_EMAIL'),
  NOTIFY_TO: env('NOTIFY_TO'),
  NOTIFY_CC: env('NOTIFY_CC'),
  NOTIFY_BCC: env('NOTIFY_BCC'),

  // Redis
  REDIS_HOST: env('REDIS_HOST', 'localhost'),
  REDIS_PORT: toInt(env('REDIS_PORT', 6379)),
  REDIS_PASSWORD: env('REDIS_PASSWORD'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: toInt(env('RATE_LIMIT_WINDOW_MS', 900000)),
  RATE_LIMIT_MAX_REQUESTS: toInt(env('RATE_LIMIT_MAX_REQUESTS', 100)),

  // Security
  BCRYPT_ROUNDS: toInt(env('BCRYPT_ROUNDS', 12)),

  // Report Types
  GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT: env('GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'),
  MAX_ASINS_PER_REQUEST: toInt(env('MAX_ASINS_PER_REQUEST', 15)),
  MAX_DAYS_AGO: toInt(env('MAX_DAYS_AGO', 2)),

  // Timeout
  HTTP_TIMEOUT_MS: toInt(env('HTTP_TIMEOUT_MS', 120000)),
  DOWNLOAD_TIMEOUT_MS: toInt(env('DOWNLOAD_TIMEOUT_MS', 300000)),
  API_TIMEOUT_MS: toInt(env('API_TIMEOUT_MS', 60000)),

  // Memory
  MAX_FILE_SIZE_MB: toInt(env('MAX_FILE_SIZE_MB', 100)),
  MAX_MEMORY_USAGE_MB: toInt(env('MAX_MEMORY_USAGE_MB', 500)),
  MAX_JSON_SIZE_MB: toInt(env('MAX_JSON_SIZE_MB', 50)),

  // Retry
  INITIAL_DELAY_SECONDS: toInt(env('INITIAL_DELAY_SECONDS', 30)),

  // Circuit Breaker
  CIRCUIT_BREAKER_THRESHOLD: toInt(env('CIRCUIT_BREAKER_THRESHOLD', 5)),
  CIRCUIT_BREAKER_TIMEOUT_MS: toInt(env('CIRCUIT_BREAKER_TIMEOUT_MS', 60000)),

  // DB Connection Pool
  DB_CONNECTION_POOL_MAX: toInt(env('DB_CONNECTION_POOL_MAX', 5)),
  DB_CONNECTION_POOL_MIN: toInt(env('DB_CONNECTION_POOL_MIN', 0)),
  DB_CONNECTION_TIMEOUT_MS: toInt(env('DB_CONNECTION_TIMEOUT_MS', 60000)),

  // Report Pull Settings
  TYPE_ARRAY: (env('TYPE_ARRAY', 'WEEK,MONTH,QUARTER')).split(',').map(s => s.trim()), 
  WEEKS_TO_PULL: toInt(env('WEEKS_TO_PULL', 0)),
  MONTHS_TO_PULL: toInt(env('MONTHS_TO_PULL', 0)),
  QUARTERS_TO_PULL: toInt(env('QUARTERS_TO_PULL', 0)),
};

/**
 * Load and apply secrets from file or AWS
 */
async function loadPath(rawPath, { overwrite, service, label }) {
  if (!rawPath) return {};

  const trimmed = rawPath.trim();
  if (!trimmed) return {};

  const looksLikeSsm = trimmed.startsWith('/');

  if (looksLikeSsm) {
    const normalizedPath = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    try {
      const data = await service.loadParametersIntoEnv(normalizedPath, { overwrite });
      return data;
    } catch (error) {
      console.error(`[env.config] Failed to load ${label} from ${normalizedPath}: ${error.message}`);
      return {};
    }
  }
  return {};
}

function applyLocalVariables(data, { overwrite, label }) {
  Object.entries(data).forEach(([key, value]) => {
    setEnvIfAllowed(key, value, overwrite);
  });
}

function setEnvIfAllowed(key, value, overwrite) {
  if (!overwrite && process.env[key]) return;
  process.env[key] = typeof value === 'string' ? value : JSON.stringify(value);
}

module.exports = {
    env,
    ...config,
    loadAwsSecrets,
    __loadAwsSecrets: loadAwsSecrets
};
