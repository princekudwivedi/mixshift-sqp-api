const dbConfig = require('../config/db.config');
const logger = require('../src/utils/logger.utils');

/**
 * Models Index
 * Initializes database connection and loads all models
 */
class ModelsIndex {
    constructor() {
        this.db = dbConfig;
        this.models = {};
        this.initialized = false;
    }

    /**
     * Initialize database and load models
     */
    async initialize() {
        try {
            if (this.initialized) {
                return this.models;
            }

            // Initialize database connection
            await this.db.initialize();

            // Load all models
            this.models.User = require('./user.model');
            this.models.AuthToken = require('./authToken.model');
            this.models.StsToken = require('./stsToken.model');
            this.models.SqpDownloadUrl = require('./sqpDownloadUrl.model');
            this.models.SqpMetric = require('./sqpMetric.model');
            this.models.Seller = require('./seller.model');

            // Set up model associations
            this.setupAssociations();

            this.initialized = true;
            logger.info('All models loaded and initialized successfully');

            return this.models;
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to initialize models');
            throw error;
        }
    }

    /**
     * Set up model associations
     */
    setupAssociations() {
        // Seller associations
        if (this.models.Seller && this.models.SqpDownloadUrl) {
            // Seller has many SqpDownloadUrls
            this.models.Seller.hasMany(this.models.SqpDownloadUrl, { 
                foreignKey: 'AmazonSellerID', 
                as: 'downloadUrls' 
            });
            this.models.SqpDownloadUrl.belongsTo(this.models.Seller, { 
                foreignKey: 'AmazonSellerID', 
                as: 'seller' 
            });
        }

        // SqpDownloadUrl associations
        if (this.models.SqpDownloadUrl && this.models.SqpMetric) {
            // SqpDownloadUrl has many SqpMetrics
            this.models.SqpDownloadUrl.hasMany(this.models.SqpMetric, { 
                foreignKey: 'ReportID', 
                as: 'metrics' 
            });
            this.models.SqpMetric.belongsTo(this.models.SqpDownloadUrl, { 
                foreignKey: 'ReportID', 
                as: 'downloadUrl' 
            });
        }

        logger.info('Model associations set up successfully');
    }

    /**
     * Get a specific model
     */
    getModel(modelName) {
        if (!this.initialized) {
            throw new Error('Models not initialized. Call initialize() first.');
        }
        return this.models[modelName];
    }

    /**
     * Get all models
     */
    getAllModels() {
        if (!this.initialized) {
            throw new Error('Models not initialized. Call initialize() first.');
        }
        return this.models;
    }

    /**
     * Close database connection
     */
    async close() {
        await this.db.close();
        this.initialized = false;
        logger.info('Database connection closed');
    }

    /**
     * Health check
     */
    async healthCheck() {
        return await this.db.healthCheck();
    }
}

// Create singleton instance
const modelsIndex = new ModelsIndex();

module.exports = modelsIndex;
