const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');
const logger = require('../utils/logger.utils');

const DEFAULT_REGION = 'us-east-2';

class AwsSecretsManagerService {
    /**
     * @param {Object} options
     * @param {string} [options.region]
     * @param {string} [options.accessKeyId]
     * @param {string} [options.secretAccessKey]
     */
    constructor(options = {}) {
        const {
            region = DEFAULT_REGION
        } = options;

        if (!region) {
            logger.log('AWS SSM region not specified; defaulting to us-east-2', 'warn');
        }

        this.client = new SSMClient({
            region: region || 'us-east-2'
        });
    }

    /**
     * Retrieve all parameters beneath a given path prefix.
     *
     * @param {string} pathPrefix - The SSM path, e.g. `/dev/mixshift/constants/`
     * @param {Object} [options]
     * @param {boolean} [options.withDecryption=true]
     * @param {boolean} [options.recursive=true]
     * @param {number} [options.maxResults=10]
     * @returns {Promise<Object>} - Object keyed by the parameter name suffix.
     */
    async getAllParameters(pathPrefix, options = {}) {
        if (!pathPrefix || typeof pathPrefix !== 'string') {
            throw new Error('pathPrefix is required to load SSM parameters');
        }

        const {
            withDecryption = true,
            recursive = true,
            maxResults = 10
        } = options;

        const cleanedPath = pathPrefix.endsWith('/')
            ? pathPrefix
            : `${pathPrefix}/`;

        const parameters = {};
        let nextToken = undefined;

        try {
            do {
                const command = new GetParametersByPathCommand({
                    Path: cleanedPath,
                    WithDecryption: withDecryption,
                    Recursive: recursive,
                    MaxResults: Math.min(Math.max(maxResults, 1), 10),
                    NextToken: nextToken
                });

                const response = await this.client.send(command);

                if (Array.isArray(response?.Parameters)) {
                    response.Parameters.forEach(param => {
                        const name = param?.Name;
                        if (!name || typeof param.Value === 'undefined') return;

                        const key = name.split('/').filter(Boolean).pop();
                        if (!key) return;

                        parameters[key] = param.Value;
                    });
                }

                nextToken = response?.NextToken;
            } while (nextToken);
        } catch (error) {
            logger.error({
                pathPrefix: cleanedPath,
                error: error.message
            }, 'Failed to load parameters from AWS SSM');
            throw error;
        }

        return parameters;
    }

    /**
     * Convenience helper to fetch parameters and merge into process.env.
     *
     * @param {string} pathPrefix
     * @param {Object} [options]
     * @param {boolean} [options.overwrite=true] - When false, do not overwrite existing env vars.
     * @returns {Promise<Object>} - The parameters that were loaded.
     */
    async loadParametersIntoEnv(pathPrefix, options = {}) {
        const { overwrite = true } = options;
        const parameters = await this.getAllParameters(pathPrefix, options);

        Object.entries(parameters).forEach(([key, value]) => {
            if (!overwrite && Object.prototype.hasOwnProperty.call(process.env, key)) {
                return;
            }
            process.env[key] = value;
        });

        return parameters;
    }
}

module.exports = new AwsSecretsManagerService();
module.exports.AwsSecretsManagerService = AwsSecretsManagerService;

