/**
 * Cleanup Service
 
 */
const { ValidationHelpers, CircuitBreaker, RateLimiter } = require('../helpers/sqp.helpers');
const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const { getModel: getSqpCronDetails } = require('../models/sequelize/sqpCronDetails.model');
const { getModel: getSqpCronLogs } = require('../models/sequelize/sqpCronLogs.model');
const { getModel: getSqpDownloadUrls } = require('../models/sequelize/sqpDownloadUrls.model');
const { Op } = require('sequelize');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development","production"].includes(env.NODE_ENV);
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const { isUserAllowed } = require('../utils/security.utils');
const apiLogger = require('../utils/api.logger.utils');
const dates = require('../utils/dates.utils');

class CleanupService {

    constructor() {
        // Initialize efficiency helpers
        this.circuitBreaker = new CircuitBreaker(
            Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5,
            Number(process.env.CIRCUIT_BREAKER_TIMEOUT_MS) || 60000
        );
        this.rateLimiter = new RateLimiter(
            Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
            Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000
        );
        // MemoryMonitor uses static methods, no instance needed
    }

    async cleanupAllOldRecords(daysToKeep = process.env.DAYS_TO_KEEP, logCleanupDays = process.env.LOG_CLEANUP_DAYS) {
        // clean up logs from all users
        await apiLogger.cleanOldLogs(Number(logCleanupDays));
        return this._cleanupAllOldRecords(Number(daysToKeep));
    }

    /**
     * Clean up all old records from sqp tables
     * @param {number} daysToKeep - Number of days to keep (default: 30)
     * @returns {Promise<Object>} Object with counts of deleted records from each table
     */
    async _cleanupAllOldRecords(daysToKeep = Number(process.env.DAYS_TO_KEEP)) {
        return initDatabaseContext(async () => {
            await loadDatabase(0);
            const users = await getAllAgencyUserList();
            // Track total across all users
            let totalCronDetails = 0;
            let totalCronLogs = 0;
            let totalDownloadUrls = 0;
            
            // Process each user
            for (const user of users) {
                try {                        
                    if (isDevEnv && !isUserAllowed(user.ID)) {
                        continue;
                    }
                    
                    await loadDatabase(user.ID);

                    logger.info({ user: user.ID, daysToKeep }, 'Starting cleanup of old records from all sqp tables');
    
                    const results = {
                        cronDetails: await this._cleanupOldCronDetails(user.ID, daysToKeep),
                        cronLogs: await this._cleanupOldCronLogs(user.ID, daysToKeep),
                        downloadUrls: await this._cleanupOldDownloadUrls(user.ID, daysToKeep),
                        total: 0
                    };
                    
                    results.total = results.cronDetails + results.cronLogs + results.downloadUrls;
                    
                    // Add to overall totals
                    totalCronDetails += results.cronDetails;
                    totalCronLogs += results.cronLogs;
                    totalDownloadUrls += results.downloadUrls;
                    
                    logger.info({ 
                        user: user.ID,
                        daysToKeep,
                        results
                    }, `Cleanup completed: ${results.total} total records deleted for user`);
                    
                } catch (error) {
                    logger.error({ 
                        error: error.message,
                        stack: error.stack,
                        user: user.ID,
                        daysToKeep 
                    }, 'Error during cleanup of old records');
                }
            }
            
            const grandTotal = totalCronDetails + totalCronLogs + totalDownloadUrls;
            
            logger.info({ 
                daysToKeep,
                totalCronDetails,
                totalCronLogs,
                totalDownloadUrls,
                grandTotal
            }, `All cleanup completed: ${grandTotal} total records deleted across all users`);
            
            return {
                cronDetails: totalCronDetails,
                cronLogs: totalCronLogs,
                downloadUrls: totalDownloadUrls,
                total: grandTotal
            };
        });
    }
    /**
     * Clean up old records from sqp_cron_details table
     * @param {number} daysToKeep - Number of days to keep (default: 30)
     * @returns {Promise<number>} Number of records deleted
     */
    async _cleanupOldCronDetails(userID, daysToKeep = process.env.DAYS_TO_KEEP) {
        try {
            const SqpCronDetails = getSqpCronDetails();
            const cutoffDate = dates.getNowDateTimeInUserTimezoneAgo(new Date(), { days: daysToKeep });
            const deletedCount = await SqpCronDetails.destroy({
                where: {
                    dtCreatedOn: { [Op.lt]: literal(`'${cutoffDate}'`) }
                }
            });

            logger.info({ 
                userID,
                daysToKeep, 
                cutoffDate, 
                deletedCount 
            }, `Found ${deletedCount} old records to clean from sqp_cron_details`);
            
            return deletedCount;
        } catch (error) {
            logger.error({ 
                error: error.message, 
                stack: error.stack,
                userID,
                daysToKeep 
            }, 'Error cleaning up old sqp_cron_details records');
            throw error;
        }
    }

    /**
     * Clean up old records from sqp_cron_logs table
     * @param {number} daysToKeep - Number of days to keep (default: 30)
     * @returns {Promise<number>} Number of records deleted
     */
    async _cleanupOldCronLogs(userID, daysToKeep = process.env.DAYS_TO_KEEP) {
        try {
            const SqpCronLogs = getSqpCronLogs();

            const cutoffDate = dates.getNowDateTimeInUserTimezoneAgo(new Date(), { days: daysToKeep });
            
            // Uncomment to actually delete:
            const deletedCount = await SqpCronLogs.destroy({
                where: {
                    dtCreatedOn: { [Op.lt]: literal(`'${cutoffDate}'`) }
                }
            });


            logger.info({ 
                userID,
                daysToKeep, 
                cutoffDate, 
                deletedCount 
            }, `Found ${deletedCount} old records to clean from sqp_cron_logs`);
            
            return deletedCount;
        } catch (error) {
            logger.error({ 
                error: error.message, 
                stack: error.stack,
                userID,
                daysToKeep 
            }, 'Error cleaning up old sqp_cron_logs records');
            throw error;
        }
    }

    /**
     * Clean up old records from sqp_download_urls table
     * @param {number} daysToKeep - Number of days to keep (default: 30)
     * @returns {Promise<number>} Number of records deleted
     */
    async _cleanupOldDownloadUrls(userID, daysToKeep = process.env.DAYS_TO_KEEP) {
        try {
            const SqpDownloadUrls = getSqpDownloadUrls();
            const cutoffDate = dates.getNowDateTimeInUserTimezoneAgo(new Date(), { days: daysToKeep });
            
            // Uncomment to actually delete:
            const deletedCount = await SqpDownloadUrls.destroy({
                where: {
                    dtCreatedOn: { [Op.lt]: literal(`'${cutoffDate}'`) }
                }
            });

            logger.info({ 
                userID,
                daysToKeep, 
                cutoffDate, 
                deletedCount 
            }, `Found ${deletedCount} old records to clean from sqp_download_urls`);
            
            return deletedCount;
        } catch (error) {
            logger.error({ 
                error: error.message, 
                stack: error.stack,
                userID,
                daysToKeep 
            }, 'Error cleaning up old sqp_download_urls records');
            throw error;
        }
    }
}

module.exports = new CleanupService();

