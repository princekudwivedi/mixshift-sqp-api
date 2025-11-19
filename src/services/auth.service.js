const AuthToken = require('../models/authToken.model');
const axios = require('axios');
const logger = require('../utils/logger.utils');
const { Helpers } = require('../helpers/sqp.helpers');
// Amazon LWA token endpoint
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

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

            logger.info(
                {
                    amazonSellerID,
                    wasRefreshed: tokenResult.wasRefreshed,
                    refreshFailed: tokenResult.refreshFailed || false,
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
            logger.warn(
                {
                    amazonSellerID,
                    error: tokenResult.error,
                },
                'No valid access token available for seller'
            );
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
        const clientSecret = await Helpers.resolveClientSecret();
        if (!process.env.SP_API_DEVELOPER_CLIENT_ID || !clientSecret)
            throw new Error('LWA credentials not configured');

        logger.info({ amazonSellerID }, 'Attempting to refresh access token');

        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: process.env.SP_API_DEVELOPER_CLIENT_ID,
            client_secret: clientSecret,
        });

        const response = await axios.post(LWA_TOKEN_URL, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000,
        });

        if (response.data && response.data.access_token) {
            const rawExpires = Number(response.data.expires_in);
            const expiresInMs = Number.isFinite(rawExpires) ? rawExpires * 1000 : 3600 * 1000;
            const safetyBufferMs = 5 * 60 * 1000;
            const ttlMs = Math.max(expiresInMs - safetyBufferMs, 60 * 1000);
            const expiresInDate = new Date(Date.now() + ttlMs);

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
            return { accessToken: null, wasRefreshed: false };
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

                return { accessToken: newTokenData.access_token, wasRefreshed: true };
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
                };
            }
        }

        logger.info({ amazonSellerID, expiresAt: tokenRow.expires_in }, 'Using existing valid token');
        return { accessToken: tokenRow.access_token, wasRefreshed: false };
    } catch (error) {
        logger.error({ amazonSellerID, error: error.message, stack: error.stack }, 'Error in getValidAccessToken');
        return { accessToken: null, wasRefreshed: false, error: error.message };
    }
}

module.exports = {
    isTokenExpired,
    refreshAccessToken,
    updateTokenInDatabase,
    getValidAccessToken,
    buildAuthOverrides,
};
