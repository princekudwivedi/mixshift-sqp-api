/**
 * Backfill Service
 * Fetches historical SQP data for periods that were missed (e.g. when a seller's token was disabled and re-enabled).
 * Uses a separate cron and only requests ranges that are not already present in SQP tables.
 */

const { initDatabaseContext, loadDatabase } = require('../db/tenant.db');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const sellerModel = require('../models/sequelize/seller.model');
const model = require('../models/sqp.cron.model');
const authService = require('../services/auth.service');
const initialPullService = require('../services/initial.pull.service');
const logger = require('../utils/logger.utils');
const dates = require('../utils/dates.utils');
const { isUserAllowed } = require('../utils/security.utils');
const env = require('../config/env.config');
const isDevEnv = ['local', 'development', 'production'].includes(env.NODE_ENV);
const { Helpers } = require('../helpers/sqp.helpers');

const BACKFILL_INITIAL_PULL = 2;

/**
 * Resolve which date range to use for a seller:
 * - If seller_ASIN_list has BackfillStartDate/BackfillEndDate for this SellerID+AmazonSellerID, use the min/max of those.
 * - Else if request start/end are provided, use that.
 * - Else fall back to env-based backfill ranges.
 */
async function getEffectiveRangeForSeller(seller, timezone, requestStartDate, requestEndDate) {
    const SellerAsinList = require('../models/sequelize/sellerAsinList.model').getModel();
    let start = requestStartDate || null;
    let end = requestEndDate || null;

    // Try to derive from seller_ASIN_list if not explicitly provided
    if (!start || !end) {
        const asinRows = await SellerAsinList.findAll({
            where: { SellerID: seller.idSellerAccount, AmazonSellerID: seller.AmazonSellerID },
            attributes: ['BackfillStartDate', 'BackfillEndDate'],
            raw: true
        }).catch(() => []);

        if (asinRows && asinRows.length > 0) {
            const starts = asinRows.map(r => r.BackfillStartDate).filter(Boolean);
            const ends = asinRows.map(r => r.BackfillEndDate).filter(Boolean);

            if (!start && starts.length > 0) {
                start = starts.reduce((min, s) => (s < min ? s : min));
            }
            if (!end) {
                if (ends.length > 0) {
                    end = ends.reduce((max, e) => (e > max ? e : max));
                } else if (start) {
                    // Open-ended window: treat "today" as the current end
                    end = dates.formatTimestamp(new Date(), null, { onlyDate: true });
                }
            }
        }
    }

    if (start && end) {
        return dates.calculateRangesInDateRange(start, end, timezone);
    }
    // Fallback: env-based backfill window
    //return dates.calculateBackfillRanges(timezone);
    // No BackfillStartDate/BackfillEndDate and no explicit request range:
    // do NOT fall back to env BACKFILL_*; simply return empty ranges so this seller is skipped.
    return {
        fullWeekRange: null,
        fullMonthRange: null,
        fullQuarterRange: null,
        weekRanges: [],
        monthRanges: [],
        quarterRanges: []
    };
}

class BackfillService {

    /**
     * Get dynamic backfill pending per seller: missing week/month/quarter counts and optional list of missing ranges.
     * Optionally update BackfillPending flag on seller. Supports custom date range (query or seller's BackfillStartDate/EndDate).
     * @param {number|null} validatedUserId
     * @param {number|null} validatedSellerId
     * @param {string|null} startDate - YYYY-MM-DD (optional)
     * @param {string|null} endDate - YYYY-MM-DD (optional)
     * @param {{ updateFlag?: boolean, onlyWithPending?: boolean, includeRanges?: boolean }} options
     */
    async getBackfillPending(validatedUserId = null, validatedSellerId = null, startDate = null, endDate = null, options = {}) {
        const { updateFlag = false, onlyWithPending = false, includeRanges = true } = options;
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(0);
                const users = validatedUserId ? [{ ID: parseInt(validatedUserId) }] : await getAllAgencyUserList();
                const sellersWithPending = [];
                let totalPendingReports = 0;

                for (const user of users) {
                    try {
                        if (isDevEnv && !isUserAllowed(user.ID)) continue;
                        await loadDatabase(user.ID);
                        const sellers = await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });
                        if (!sellers || sellers.length === 0) continue;

                        const timezone = await model.getUserTimezone(user);
                        for (const s of sellers) {
                            const pending = await this._computePendingForSeller(s, user, startDate, endDate, timezone);
                            if (pending == null) continue;
                            const total = pending.missingWeeks + pending.missingMonths + pending.missingQuarters;
                            if (onlyWithPending && total === 0) continue;
                            if (updateFlag && s.idSellerAccount != null) {
                                try {
                                    if (typeof sellerModel.update === 'function') {
                                        await sellerModel.update(
                                            { BackfillPending: total > 0 ? 1 : 0, dtUpdatedOn: new Date() },
                                            { where: { ID: s.idSellerAccount } }
                                        );
                                    }
                                } catch (e) {
                                    logger.warn({ sellerId: s.idSellerAccount, error: e.message }, 'Could not update BackfillPending flag');
                                }
                            }
                            totalPendingReports += total;
                            sellersWithPending.push({
                                sellerId: s.ID,
                                amazonSellerID: s.AmazonSellerID,
                                sellerName: s.SellerName || s.MerchantAlias || s.Name,
                                pending: {
                                    missingWeeks: pending.missingWeeks,
                                    missingMonths: pending.missingMonths,
                                    missingQuarters: pending.missingQuarters,
                                    totalPending: total,
                                    ...(includeRanges ? {
                                        missingWeekRanges: pending.missingWeekRanges,
                                        missingMonthRanges: pending.missingMonthRanges,
                                        missingQuarterRanges: pending.missingQuarterRanges
                                    } : {})
                                }
                            });
                        }
                    } catch (err) {
                        logger.error({ userId: user.ID, error: err.message }, 'getBackfillPending failed for user');
                    }
                }

                return {
                    sellers: sellersWithPending,
                    totalPendingReports,
                    dateRange: startDate && endDate ? { startDate, endDate } : null
                };
            } catch (error) {
                logger.error({ error: error.message }, 'Error in getBackfillPending');
                throw error;
            }
        });
    }

    /**
     * Compute pending (missing ranges) for one seller. Returns null if no ASINs.
     */
    async _computePendingForSeller(seller, user, requestStartDate, requestEndDate, timezone) {
        const { asins } = await model.getActiveASINsBySellerInitialPull(seller.idSellerAccount, true);
        if (!asins || asins.length === 0) return null;
        const ranges = await getEffectiveRangeForSeller(seller, timezone, requestStartDate, requestEndDate);
        const existing = await model.getExistingDataRangesForSeller(seller.idSellerAccount, seller.AmazonSellerID);
        const missingWeekRanges = (ranges.weekRanges || []).filter((r) => !existing.WEEK.has(r.range));
        const missingMonthRanges = (ranges.monthRanges || []).filter((r) => !existing.MONTH.has(r.range));
        const missingQuarterRanges = (ranges.quarterRanges || []).filter((r) => !existing.QUARTER.has(r.range));
        return {
            missingWeeks: missingWeekRanges.length,
            missingMonths: missingMonthRanges.length,
            missingQuarters: missingQuarterRanges.length,
            missingWeekRanges,
            missingMonthRanges,
            missingQuarterRanges
        };
    }

    /**
     * Process backfill for all users or specific user/seller.
     * For each seller: compute backfill ranges, subtract existing data ranges, request only missing periods.
     * Optional query: startDate, endDate (YYYY-MM-DD), onlyWithPending (1 = only sellers with BackfillPending=1).
     */
    async processBackfill(validatedUserId = null, validatedSellerId = null, options = {}) {
        const { startDate = null, endDate = null, onlyWithPending = false } = options;
        return initDatabaseContext(async () => {
            try {
                await loadDatabase(0);
                const users = validatedUserId ? [{ ID: parseInt(validatedUserId) }] : await getAllAgencyUserList();
                let sellersProcessed = 0;
                let sellersSkippedNoGaps = 0;
                let sellersSkippedNoAsins = 0;
                let sellersFailed = 0;

                for (const user of users) {
                    try {
                        if (isDevEnv && !isUserAllowed(user.ID)) continue;
                        await loadDatabase(user.ID);
                        const sellers = await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });
                        if (!sellers || sellers.length === 0) continue;
                        if (onlyWithPending) {
                            try {
                                const withFlag = await sellerModel.findAll({ where: { BackfillPending: 1 }, attributes: ['ID'], raw: true }).catch(() => []);
                                const pendingIds = new Set((withFlag || []).map((r) => r.ID));
                                sellers = sellers.filter((s) => pendingIds.has(s.idSellerAccount));
                            } catch (e) {
                                logger.warn({ error: e.message }, 'BackfillPending filter skipped (column may not exist)');
                            }
                        }

                        for (const s of sellers) {
                            try {
                                const cronLimits = await Helpers.checkCronLimits(user.ID, BACKFILL_INITIAL_PULL);
                                if (!cronLimits.shouldProcess) {
                                    logger.info({ userId: user.ID, sellerId: s.idSellerAccount }, 'Backfill: cron limits reached, skipping seller');
                                    continue;
                                }
                                const result = await this._runBackfillForSeller(s, user, startDate, endDate);
                                if (result === 'processed') sellersProcessed++;
                                else if (result === 'no_gaps') sellersSkippedNoGaps++;
                                else if (result === 'no_asins') sellersSkippedNoAsins++;
                                else sellersFailed++;
                            } catch (err) {
                                logger.error({ sellerId: s.idSellerAccount, error: err.message }, 'Backfill failed for seller');
                                sellersFailed++;
                            }
                        }
                    } catch (err) {
                        logger.error({ userId: user.ID, error: err.message }, 'Backfill failed for user');
                    }
                }

                logger.info({
                    sellersProcessed,
                    sellersSkippedNoGaps,
                    sellersSkippedNoAsins,
                    sellersFailed
                }, 'Backfill process completed');

                return {
                    sellersProcessed,
                    sellersSkippedNoGaps,
                    sellersSkippedNoAsins,
                    sellersFailed
                };
            } catch (error) {
                logger.error({ error: error.message }, 'Error in processBackfill');
                throw error;
            }
        });
    }

    /**
     * Run backfill for a single seller: get backfill ranges (seller range, request range, or env), subtract existing, request missing only.
     * @returns {'processed' | 'no_gaps' | 'no_asins' | 'error'}
     */
    async _runBackfillForSeller(seller, user, requestStartDate = null, requestEndDate = null) {
        const { asins } = await model.getActiveASINsBySellerInitialPull(seller.idSellerAccount, true);
        if (!asins || asins.length === 0) {
            logger.info({ amazonSellerID: seller.AmazonSellerID }, 'Backfill: no eligible ASINs, skipping');
            return 'no_asins';
        }

        const timezone = await model.getUserTimezone(user);
        const ranges = await getEffectiveRangeForSeller(seller, timezone, requestStartDate, requestEndDate);
        const existing = await model.getExistingDataRangesForSeller(seller.idSellerAccount, seller.AmazonSellerID);

        const missingWeekRanges = (ranges.weekRanges || []).filter((r) => !existing.WEEK.has(r.range));
        const missingMonthRanges = (ranges.monthRanges || []).filter((r) => !existing.MONTH.has(r.range));
        const missingQuarterRanges = (ranges.quarterRanges || []).filter((r) => !existing.QUARTER.has(r.range));

        const totalMissing = missingWeekRanges.length + missingMonthRanges.length + missingQuarterRanges.length;
        if (totalMissing === 0) {
            logger.info({ amazonSellerID: seller.AmazonSellerID }, 'Backfill: no missing ranges, skipping');
            return 'no_gaps';
        }

        logger.info({
            amazonSellerID: seller.AmazonSellerID,
            missingWeeks: missingWeekRanges.length,
            missingMonths: missingMonthRanges.length,
            missingQuarters: missingQuarterRanges.length
        }, 'Backfill: running historical pull for missing ranges');

        const filteredRanges = {
            fullWeekRange: missingWeekRanges.length ? `${missingWeekRanges[missingWeekRanges.length - 1].startDate} to ${missingWeekRanges[0].endDate}` : null,
            fullMonthRange: missingMonthRanges.length ? `${missingMonthRanges[missingMonthRanges.length - 1].startDate} to ${missingMonthRanges[0].endDate}` : null,
            fullQuarterRange: missingQuarterRanges.length ? `${missingQuarterRanges[missingQuarterRanges.length - 1].startDate} to ${missingQuarterRanges[0].endDate}` : null,
            weekRanges: missingWeekRanges,
            monthRanges: missingMonthRanges,
            quarterRanges: missingQuarterRanges
        };

        const authOverrides = await authService.buildAuthOverrides(seller.AmazonSellerID);
        await initialPullService._runHistoricalPullForSeller(seller, filteredRanges, BACKFILL_INITIAL_PULL, authOverrides, user);
        return 'processed';
    }
}

module.exports = new BackfillService();
