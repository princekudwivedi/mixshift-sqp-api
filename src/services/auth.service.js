const AuthToken = require('../models/authToken.model');
const axios = require('axios');
const logger = require('../utils/logger.utils');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const dates = require('../utils/dates.utils');

// Amazon LWA token endpoint
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/**
 * Keep seller backfill window/flag in sync with token state.
 * - When iLostAccess = 1: set BackfillStartDate (from dtLostAccessOn if available), clear BackfillEndDate, mark BackfillPending = 1.
 * - When token has access (iLostAccess = 0) and seller has BackfillStartDate but no BackfillEndDate:
 *   set BackfillEndDate to today and keep BackfillPending = 1 so cron/backfill can fill the gap.
 */
async function syncSellerBackfillWithToken(amazonSellerID, tokenRow) {
    if (!tokenRow || typeof tokenRow.iLostAccess === 'undefined') return;

    try {
        const SellerAsinList = getSellerAsinList();
        const asinRows = await SellerAsinList.findAll({
            where: { AmazonSellerID: amazonSellerID },
            attributes: ['SellerID', 'BackfillStartDate', 'BackfillEndDate', 'BackfillPending'],
            raw: true
        });
        if (!asinRows || asinRows.length === 0) return;
        const sellerID = asinRows[0].SellerID;

        const lost = Number(tokenRow.iLostAccess) === 1;

        if (lost) {
            // Derive start date from dtLostAccessOn if available, else today
            const lostDate = tokenRow.dtLostAccessOn
                ? new Date(tokenRow.dtLostAccessOn)
                : new Date();
            const startDateStr = dates.formatTimestamp(lostDate, null, { onlyDate: true });

            // Only set BackfillStartDate the first time we detect loss
            const hasAnyStart = asinRows.some(r => r.BackfillStartDate);
            if (!hasAnyStart) {
                await SellerAsinList.update(
                    {
                        BackfillStartDate: startDateStr,
                        BackfillEndDate: null,
                        BackfillPending: 1,
                        dtUpdatedOn: dates.getNowDateTimeInUserTimezone().db
                    },
                    { where: { SellerID: sellerID, AmazonSellerID: amazonSellerID } }
                );
            } else if (!asinRows.some(r => Number(r.BackfillPending) === 1)) {
                // Ensure pending flag is on while access is lost
                await SellerAsinList.update(
                    {
                        BackfillPending: 1,
                        dtUpdatedOn: dates.getNowDateTimeInUserTimezone().db
                    },
                    { where: { SellerID: sellerID, AmazonSellerID: amazonSellerID } }
                );
            }
            return;
        }

        // Token has access (iLostAccess = 0):
        // If we have BackfillStartDate but no BackfillEndDate, close the gap at "today".
        const hasOpenWindow = asinRows.some(r => r.BackfillStartDate && !r.BackfillEndDate);
        if (hasOpenWindow) {
            const endDate = new Date();
            const endDateStr = dates.formatTimestamp(endDate, null, { onlyDate: true });
            await SellerAsinList.update(
                {
                    BackfillEndDate: endDateStr,
                    BackfillPending: 1, // still pending until backfill cron runs
                    dtUpdatedOn: dates.getNowDateTimeInUserTimezone().db
                },
                { where: { SellerID: sellerID, AmazonSellerID: amazonSellerID, BackfillEndDate: null } }
            );
        }
    } catch (err) {
        logger.warn(
            { amazonSellerID, error: err.message },
            'Failed to sync seller backfill window with token state'
        );
    }
}

/**
 * Build authentication overrides for a seller
 * Automatically refreshes token if expired or about to expire
 */
async function buildAuthOverrides(amazonSellerID, forceRefresh = false) {
    try {
        const authOverrides = {};
        // Call getValidAccessToken from the same module (avoid 'this')
        const tokenResult = await getValidAccessToken(amazonSellerID, forceRefresh);

        if (tokenResult.accessToken) {
            authOverrides.accessToken = tokenResult.accessToken;
            authOverrides.iLostAccess = tokenResult.iLostAccess ?? 0;

            logger.info(
                {
                    amazonSellerID,
                    wasRefreshed: tokenResult.wasRefreshed,
                    refreshFailed: tokenResult.refreshFailed || false
                },
                tokenResult.wasRefreshed
                    ? 'Token refreshed successfully for seller'
                    : 'Using existing valid token for seller'
            );

            if (tokenResult.refreshFailed) {
                logger.warn(
                    {
                        amazonSellerID,
                        error: tokenResult.error,
                    },
                    'Token refresh failed, using existing token - may encounter authentication errors'
                );
            }
        } else {
            if (tokenResult?.iLostAccess === 1) {
                logger.warn(
                    { amazonSellerID, iLostAccess: tokenResult?.iLostAccess },
                    'Token lost access for seller'
                );
            } else {
                logger.warn(
                    { amazonSellerID, iLostAccess: 1 },
                    'No valid access token available for seller'
                );
            }
            authOverrides.accessToken = null;
            authOverrides.iLostAccess = 1;
        }

        return authOverrides;
    } catch (error) {
        logger.error(
            { error: error.message, amazonSellerID },
            'Error building auth overrides'
        );
        throw error;
    }
}

/**
 * Check if token is expired
 */
function isTokenExpired(tokenRow) {
    if (!tokenRow || !tokenRow.expires_in) return true;

    // Convert token expiration to Date
    const expiryTime = new Date(tokenRow.expires_in).getTime();
    const currentTime = new Date().getTime();

    return currentTime >= expiryTime;
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(amazonSellerID, refreshToken) {
    try {
        if (!refreshToken) throw new Error('No refresh token available');
        if (!process.env.SP_API_DEVELOPER_CLIENT_ID || !process.env.SP_API_DEVELOPER_CLIENT_SECERET)
            throw new Error('LWA credentials not configured');

        logger.info({ amazonSellerID }, 'Attempting to refresh access token');

        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: process.env.SP_API_DEVELOPER_CLIENT_ID,
            client_secret: process.env.SP_API_DEVELOPER_CLIENT_SECERET,
        });

        const response = await axios.post(LWA_TOKEN_URL, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000,
        });

        if (response.data && response.data.access_token) {
            // Add 5 minutes buffer to expiration
            const expiresInDate = new Date(Date.now() + 5 * 60 * 1000);

            logger.info(
                { amazonSellerID, expiresAt: expiresInDate },
                'Successfully refreshed access token'
            );

            return {
                access_token: response.data.access_token,
                expires_in: expiresInDate, // Store as Date (or DATETIME for MySQL)
                refresh_token: response.data.refresh_token || refreshToken,
            };
        } else {
            throw new Error('Invalid response from LWA token endpoint');
        }
    } catch (error) {
        if (error.response) {
            logger.error(
                {
                    amazonSellerID,
                    status: error.response.status,
                    data: error.response.data,
                    error: error.message,
                },
                'Failed to refresh token - LWA API error'
            );

            if (
                error.response.status === 400 &&
                error.response.data?.error === 'invalid_grant'
            ) {
                throw new Error(
                    'Refresh token is invalid or expired - re-authorization required'
                );
            }
        } else {
            logger.error(
                { amazonSellerID, error: error.message, stack: error.stack },
                'Failed to refresh token - Network or system error'
            );
        }
        throw error;
    }
}

/**
 * Update token in database
 */
async function updateTokenInDatabase(amazonSellerID, tokenData) {
    try {
        return await AuthToken.updateRefreshedToken(amazonSellerID, tokenData);
    } catch (error) {
        logger.error(
            { amazonSellerID, error: error.message, stack: error.stack },
            'Failed to update token in database'
        );
        throw error;
    }
}

/**
 * Get valid access token
 */
async function getValidAccessToken(amazonSellerID, forceRefresh = false) {
    try {
        const tokenRow = await AuthToken.getSavedToken(amazonSellerID);

        if (!tokenRow) {
            logger.warn({ amazonSellerID }, 'No token found for seller');
            return { accessToken: null, wasRefreshed: false, iLostAccess: undefined, error: 'No token found for seller' };
        }

        // Keep seller backfill window/flag in sync with current token state
        await syncSellerBackfillWithToken(amazonSellerID, tokenRow);

        // If token is explicitly marked as lost access, stop pulling data
        if (Number(tokenRow.iLostAccess) === 1) {
            logger.warn(
                { amazonSellerID, iLostAccess: tokenRow.iLostAccess, dtLostAccessOn: tokenRow.dtLostAccessOn },
                'Token has lost access for seller; skipping SP-API calls'
            );
            return { accessToken: null, wasRefreshed: false, iLostAccess: 1, error: 'Token lost access' };
        }

        if (isTokenExpired(tokenRow) || forceRefresh) {
            logger.info(
                { amazonSellerID, expiresAt: tokenRow.expires_in },
                'Token is expired, refreshing...'
            );

            try {
                const newTokenData = await refreshAccessToken(
                    amazonSellerID,
                    tokenRow.refresh_token
                );
                await updateTokenInDatabase(amazonSellerID, newTokenData);

                return { accessToken: newTokenData.access_token, wasRefreshed: true, iLostAccess: 0 };
            } catch (refreshError) {
                logger.error(
                    { amazonSellerID, error: refreshError.message },
                    'Failed to refresh token, using existing token'
                );
                return {
                    accessToken: tokenRow.access_token,
                    wasRefreshed: false,
                    refreshFailed: true,
                    error: refreshError.message,
                    iLostAccess: 0
                };
            }
        }

        logger.info({ amazonSellerID, expiresAt: tokenRow.expires_in }, 'Using existing valid token');
        return { accessToken: tokenRow.access_token, wasRefreshed: false, iLostAccess: 0 };
    } catch (error) {
        logger.error({ amazonSellerID, error: error.message, stack: error.stack }, 'Error in getValidAccessToken');
        return { accessToken: null, wasRefreshed: false, iLostAccess: undefined, error: error.message };
    }
}

module.exports = {
    isTokenExpired,
    refreshAccessToken,
    updateTokenInDatabase,
    getValidAccessToken,
    buildAuthOverrides,
};
