const fs = require('fs');
const path = require('path');

// Lightweight secrets manager with file and environment overrides
// Priority order: process.env[SECRET_<KEY>] -> secrets file JSON -> fallback (env/default provided by caller)

const DEFAULT_SECRET_FILE = path.resolve(process.cwd(), 'secrets.json');

let cachedSecrets = null;

function loadSecretsFromFile() {
    if (cachedSecrets !== null) {
        return cachedSecrets;
    }

    const secretFilePath = process.env.SECRETS_FILE || process.env.AWS_SECRETS_FILE || DEFAULT_SECRET_FILE;

    try {
        if (secretFilePath && fs.existsSync(secretFilePath)) {
            const contents = fs.readFileSync(secretFilePath, 'utf-8');
            const parsed = JSON.parse(contents);
            cachedSecrets = parsed && typeof parsed === 'object' ? parsed : {};
        } else {
            cachedSecrets = {};
        }
    } catch (error) {
        // If the file cannot be read or parsed, fall back to empty secrets
        console.warn('[secrets.manager] Failed to read secrets file:', error.message);
        cachedSecrets = {};
    }

    return cachedSecrets;
}

function getSecret(key, fallback = null) {
    if (!key) {
        return fallback;
    }

    const envKey = `SECRET_${key}`;
    if (process.env[envKey]) {
        return process.env[envKey];
    }

    const secrets = loadSecretsFromFile();
    if (secrets && Object.prototype.hasOwnProperty.call(secrets, key)) {
        return secrets[key];
    }

    return fallback;
}

function clearSecretCache() {
    cachedSecrets = null;
}

module.exports = {
    getSecret,
    clearSecretCache,
};


