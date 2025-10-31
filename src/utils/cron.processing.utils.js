/**
 * Cron Processing Utilities
 * Centralized utilities for common cron processing patterns
 * Eliminates code duplication across controllers
 */

const { loadDatabase } = require('../db/tenant.db');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const sellerModel = require('../models/sequelize/seller.model');
const authService = require('../services/auth.service');
const model = require('../models/sqp.cron.model');
const { Helpers, MemoryMonitor } = require('../helpers/sqp.helpers');
const logger = require('./logger.utils');
const env = require('../config/env.config');

const isDevEnv = ["local", "development"].includes(env.NODE_ENV);
const allowedUsers = [8, 3];

/**
 * Process users with common logic
 * @param {number|null} validatedUserId - Specific user ID or null for all users
 * @param {Function} userCallback - Async function to call for each user
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Processing results
 */
async function processUsers(validatedUserId, userCallback, options = {}) {
    const {
        checkCronLimits = true,
        isInitialPull = false,
        breakAfterFirst = false
    } = options;

    await loadDatabase(0);
    const users = validatedUserId 
        ? [{ ID: parseInt(validatedUserId) }] 
        : await getAllAgencyUserList();
    
    let totalProcessed = 0;
    let totalErrors = 0;
    let shouldBreak = false;

    for (const user of users) {
        try {
            // Skip non-allowed users in dev
            if (isDevEnv && !allowedUsers.includes(user.ID)) {
                logger.info({ userId: user.ID }, 'Skip user - not in allowed list');
                continue;
            }

            logger.info({ userId: user.ID }, 'Processing user started');
            await loadDatabase(user.ID);

            // Check cron limits if required
            if (checkCronLimits) {
                const cronLimits = await Helpers.checkCronLimits(user.ID, isInitialPull ? 1 : 0);
                if (!cronLimits.shouldProcess) {
                    logger.info({ userId: user.ID, cronLimits }, 'Skipping user - cron limit reached');
                    continue;
                }
            }

            // Execute user callback
            const result = await userCallback(user);
            if (result.processed) totalProcessed++;
            if (result.error) totalErrors++;
            if (result.shouldBreak) {
                shouldBreak = true;
                break;
            }

            if (breakAfterFirst && result.processed) {
                break;
            }

        } catch (userError) {
            totalErrors++;
            logger.error({ 
                userId: user.ID, 
                error: userError.message 
            }, 'Error processing user');
        }
    }

    return { totalProcessed, totalErrors, shouldBreak };
}

/**
 * Process sellers with common logic
 * @param {number|null} validatedSellerId - Specific seller ID or null for all sellers
 * @param {Function} sellerCallback - Async function to call for each seller
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Processing results
 */
async function processSellers(validatedSellerId, sellerCallback, options = {}) {
    const {
        checkMemory = true,
        checkEligibleAsins = true,
        isInitialPull = false,
        pullAll = 0,
        breakAfterFirst = false,
        userDetails = null
    } = options;

    const sellers = validatedSellerId
        ? [await sellerModel.getProfileDetailsByID(validatedSellerId)]
        : await sellerModel.getSellersProfilesForCronAdvanced({ pullAll });

    let totalProcessed = 0;
    let totalErrors = 0;
    let shouldBreak = false;

    for (const seller of sellers) {
        if (!seller) continue;

        try {
            // Check memory usage
            if (checkMemory) {
                const memoryStats = MemoryMonitor.getMemoryStats();
                const threshold = Number(process.env.MAX_MEMORY_USAGE_MB) || 500;
                
                if (MemoryMonitor.isMemoryUsageHigh(threshold)) {
                    logger.warn({
                        memoryUsage: memoryStats.heapUsed,
                        threshold
                    }, 'High memory usage - skipping seller');
                    continue;
                }
            }

            // Check eligible ASINs
            if (checkEligibleAsins) {
                const hasEligible = await hasAnyEligibleAsins(seller.idSellerAccount, isInitialPull);
                if (!hasEligible) {
                    logger.info({
                        sellerId: seller.idSellerAccount,
                        amazonSellerID: seller.AmazonSellerID
                    }, 'Skipping seller - no eligible ASINs');
                    continue;
                }
            }

            logger.info({
                sellerId: seller.idSellerAccount,
                amazonSellerID: seller.AmazonSellerID
            }, 'Processing seller');

            // Execute seller callback
            const result = await sellerCallback(seller, userDetails);            
            if (result.processed) totalProcessed++;
            if (result.error) totalErrors++;
            if (result.shouldBreak) {
                shouldBreak = true;
                break;
            }

            if (breakAfterFirst && result.processed) {
                shouldBreak = true;
                break;
            }            
        } catch (sellerError) {
            totalErrors++;
            logger.error({
                sellerId: seller?.idSellerAccount,
                error: sellerError.message
            }, 'Error processing seller');
        }
        break;
    }

    return { totalProcessed, totalErrors, shouldBreak };
}

/**
 * Build authentication overrides with rate limiting
 * @param {Object} seller - Seller object
 * @param {Object} rateLimiter - Rate limiter instance
 * @returns {Promise<Object>} Auth overrides
 */
async function buildAuthWithRateLimit(seller, rateLimiter) {
    // Check rate limit
    if (rateLimiter) {
        await rateLimiter.checkLimit(seller.AmazonSellerID);
    }

    // Get access token
    const authOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
    
    if (!authOverrides.accessToken) {
        logger.error({ 
            amazonSellerID: seller.AmazonSellerID 
        }, 'No access token available');
        throw new Error('No access token available for report request');
    }

    return authOverrides;
}

/**
 * Check if there are any eligible ASINs across all sellers
 * @param {boolean} isInitialPull - Whether this is for initial pull
 * @returns {Promise<boolean>} True if eligible ASINs exist
 */
async function hasAnyEligibleAsins(sellerID = null, isInitialPull = false) {
    return isInitialPull
        ? await model.hasEligibleASINsInitialPull(sellerID, false)
        : await model.hasEligibleASINs(sellerID, false);
}

/**
 * Process user-seller combination with standard checks
 * This is the most common pattern across cron controllers
 */
async function processUserSellerCombination(options) {
    const {
        validatedUserId,
        validatedSellerId,
        userCallback,
        sellerCallback,
        isInitialPull = false,
        checkCronLimits = true,
        checkMemory = true,
        checkEligibleAsins = true,
        breakAfterFirst = true,
        pullAll = 0
    } = options;

    return await processUsers(
        validatedUserId,
        async (user) => {
            // Check if any eligible ASINs exist before processing sellers
            if (checkEligibleAsins) {
                const hasEligible = await hasAnyEligibleAsins(null, isInitialPull);
                if (!hasEligible) {
                    logger.info({
                        userId: user.ID
                    }, 'Skipping user - no eligible ASINs for any seller');
                    return { processed: false, error: false, shouldBreak: false };
                }
            }

            // User-level callback (optional)
            if (userCallback) {
                await userCallback(user);
            }

            // Process sellers
            const sellerResult = await processSellers(
                validatedSellerId,
                sellerCallback,
                {
                    checkMemory,
                    checkEligibleAsins,
                    isInitialPull,
                    pullAll,
                    breakAfterFirst,
                    userDetails: user
                }
            );

            return {
                processed: sellerResult.totalProcessed > 0,
                error: sellerResult.totalErrors > 0,
                shouldBreak: sellerResult.shouldBreak
            };
        },
        {
            checkCronLimits,
            isInitialPull,
            breakAfterFirst
        }
    );
}

module.exports = {
    processUsers,
    processSellers,
    buildAuthWithRateLimit,
    hasAnyEligibleAsins,
    processUserSellerCombination
};

