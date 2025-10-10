const AuthToken = require('../models/authToken.model');
const axios = require('axios');
const config = require('../config/env.config');
const logger = require('../utils/logger.utils');

// Amazon LWA token endpoint
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/**
     * Build authentication overrides for a seller
     * Automatically refreshes token if expired or about to expire
*/
async function buildAuthOverrides(amazonSellerID) {
	try {
		const authOverrides = {};
		
		// Use the new getValidAccessToken which automatically refreshes if needed
		const tokenResult = await this.getValidAccessToken(amazonSellerID);
		
		if (tokenResult.accessToken) {
			authOverrides.accessToken = tokenResult.accessToken;
			
			logger.info({ 
				amazonSellerID, 
				wasRefreshed: tokenResult.wasRefreshed,
				refreshFailed: tokenResult.refreshFailed || false
			}, tokenResult.wasRefreshed 
				? 'Token refreshed successfully for seller' 
				: 'Using existing valid token for seller');
				
			if (tokenResult.refreshFailed) {
				logger.warn({ 
					amazonSellerID,
					error: tokenResult.error 
				}, 'Token refresh failed, using existing token - may encounter authentication errors');
			}
		} else {
			logger.warn({ 
				amazonSellerID,
				error: tokenResult.error 
			}, 'No valid access token available for seller');
		}
		
		return authOverrides;
	} catch (error) {
		logger.error({ error: error.message, amazonSellerID }, 'Error building auth overrides');
		throw error;
	}
}

function isTokenExpired(tokenRow) {
	if (!tokenRow || !tokenRow.expires_in) {
		return true;
	}
	// Compare current time with expires_in datetime
	const expiryTime = new Date(tokenRow.expires_in);
	const currentTime = new Date();
	
	// Token is expired if current time >= expiry time
	return currentTime >= expiryTime;
}

/**
 * Refresh access token using refresh token
 * @param {string} amazonSellerID - Amazon Seller ID
 * @param {string} refreshToken - Refresh token
 * @returns {Object} - New token data { access_token, expires_in }
 */
async function refreshAccessToken(amazonSellerID, refreshToken) {
	try {
		if (!refreshToken) {
			throw new Error('No refresh token available');
		}
		
		if (!config.LWA_CLIENT_ID || !config.LWA_CLIENT_SECRET) {
			throw new Error('LWA credentials not configured');
		}
		
		logger.info({ amazonSellerID }, 'Attempting to refresh access token');
		
		const params = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: config.LWA_CLIENT_ID,
			client_secret: config.LWA_CLIENT_SECRET
		});
		const response = await axios.post(LWA_TOKEN_URL, params.toString(), {
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			timeout: 30000 // 30 second timeout
		});
		
		if (response.data && response.data.access_token) {
			// Calculate expires_in as DATETIME (JS: +5 MINUTES from now)
			// Stores as datetime, not seconds: date('Y-m-d H:i:s', strtotime("+5 MINUTES"))
			const expiresInDate = new Date();
			expiresInDate.setMinutes(expiresInDate.getMinutes() + 5);
			
			logger.info({ 
				amazonSellerID, 
				expiresAt: expiresInDate.toISOString()
			}, 'Successfully refreshed access token');
			
			return {
				access_token: response.data.access_token,
				expires_in: expiresInDate, // Store as Date object, will convert to MySQL DATETIME
				refresh_token: response.data.refresh_token || refreshToken // Some responses include new refresh token
			};
		} else {
			throw new Error('Invalid response from LWA token endpoint');
		}
		
	} catch (error) {
		if (error.response) {
			logger.error({ 
				amazonSellerID,
				status: error.response.status,
				data: error.response.data,
				error: error.message
			}, 'Failed to refresh token - LWA API error');
			
			// Check if refresh token is invalid
			if (error.response.status === 400 && 
			    error.response.data?.error === 'invalid_grant') {
				throw new Error('Refresh token is invalid or expired - re-authorization required');
			}
		} else {
			logger.error({ 
				amazonSellerID,
				error: error.message,
				stack: error.stack
			}, 'Failed to refresh token - Network or system error');
		}
		
		throw error;
	}
}

/**
 * Update token in database using AuthToken model
 * @param {string} amazonSellerID - Amazon Seller ID
 * @param {Object} tokenData - New token data
 * @returns {boolean} - Success status
 */
async function updateTokenInDatabase(amazonSellerID, tokenData) {
	try {
		// Use the AuthToken.updateRefreshedToken method (allowed for token refresh)
		return await AuthToken.updateRefreshedToken(amazonSellerID, tokenData);
	} catch (error) {
		logger.error({ 
			amazonSellerID,
			error: error.message,
			stack: error.stack
		}, 'Failed to update token in database');
		throw error;
	}
}

/**
 * Get valid access token - refresh if expired
 * @param {string} amazonSellerID - Amazon Seller ID
 * @returns {Object} - { accessToken, wasRefreshed }
 */
async function getValidAccessToken(amazonSellerID) {
	try {
		// Get current token from database using AuthToken model
		const tokenRow = await AuthToken.getSavedToken(amazonSellerID);
		
		if (!tokenRow) {
			logger.warn({ amazonSellerID }, 'No token found for seller');
			return { accessToken: null, wasRefreshed: false };
		}
		// Check if token is expired
		if (isTokenExpired(tokenRow)) {
			logger.info({ 
				amazonSellerID,
				expiresAt: tokenRow.expires_in 
			}, 'Token is expired, refreshing...');
			
			// Attempt to refresh the token
			try {
				const newTokenData = await refreshAccessToken(amazonSellerID, tokenRow.refresh_token);
				
				// Update token in database
				await updateTokenInDatabase(amazonSellerID, newTokenData);
				
				return { 
					accessToken: newTokenData.access_token, 
					wasRefreshed: true 
				};
				
			} catch (refreshError) {
				logger.error({ 
					amazonSellerID,
					error: refreshError.message
				}, 'Failed to refresh token, using existing token');
				
				// If refresh fails, return existing token (might still work)
				return { 
					accessToken: tokenRow.access_token, 
					wasRefreshed: false,
					refreshFailed: true,
					error: refreshError.message
				};
			}
		}
		
		// Token is still valid
		logger.info({ 
			amazonSellerID,
			expiresAt: tokenRow.expires_in 
		}, 'Using existing valid token');
		
		return { 
			accessToken: tokenRow.access_token, 
			wasRefreshed: false 
		};
		
	} catch (error) {
		logger.error({ 
			amazonSellerID,
			error: error.message,
			stack: error.stack
		}, 'Error in getValidAccessToken');
		
		return { 
			accessToken: null, 
			wasRefreshed: false,
			error: error.message
		};
	}
}

module.exports = {
	isTokenExpired,
	refreshAccessToken,
	updateTokenInDatabase,
	getValidAccessToken,
	buildAuthOverrides
};


