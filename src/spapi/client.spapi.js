const logger = require('../utils/logger.utils');
const config = require('../config/env.config');
const axios = require('axios');
const zlib = require('zlib');
const authService = require('../services/auth.service');
const { Helpers } = require('../helpers/sqp.helpers');

async function getReportsApiModule() {
	// ESM dynamic import to satisfy SDK module type
	const module = await import('@amazon-sp-api-release/amazon-sp-api-sdk-js');
	logger.info({ moduleKeys: Object.keys(module) }, 'SDK module loaded');
	return module;
}

function normalizeMerchantRegion(raw) {
	if (!raw) return 'NA';
	const s = String(raw).trim().toUpperCase();
	if (['NA', 'NORTH AMERICA', 'AMERICA', 'US', 'USA'].includes(s)) return 'NA';
	if (['EU', 'EUROPE', 'UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'TR', 'AE', 'SA'].includes(s)) return 'EU';
	if (['FE', 'FAR EAST', 'ASIA', 'JP', 'SG', 'IN', 'AU'].includes(s)) return 'FE';
	return 'NA';
}

function getSPAPIBaseUrl(merchantRegion) {
	const norm = normalizeMerchantRegion(merchantRegion);
	switch (norm) {
		case 'NA':
			return 'https://sellingpartnerapi-na.amazon.com';
		case 'FE':
			return 'https://sellingpartnerapi-fe.amazon.com';
		case 'EU':
			return 'https://sellingpartnerapi-eu.amazon.com';
		default:
			return 'https://sellingpartnerapi-na.amazon.com';
	}
}

async function buildReportsClient(opts = {}) {
	const { ReportsSpApi } = await getReportsApiModule();
	
	// Use config defaults with per-user overrides (LWA credentials)
	const clientId = opts.clientId || process.env.SP_API_DEVELOPER_CLIENT_ID;
	const clientSecret = opts.clientSecret || await Helpers.resolveClientSecret();
	const accessToken = opts.accessToken; // Use access_token
	const merchantRegion = opts.merchantRegion || 'NA';
	
	
	if (!clientId || !clientSecret) {
		throw new Error('SP-API clientId and clientSecret are required');
	}
	
	if (!accessToken) {
		throw new Error('SP-API accessToken is required');
	}
	
	const baseUrl = getSPAPIBaseUrl(merchantRegion);
	
	// Validate baseUrl is a string
	if (typeof baseUrl !== 'string') {
		throw new Error(`baseUrl must be a string, got: ${typeof baseUrl} - ${baseUrl}`);
	}
	
	logger.info({ 
		hasClientId: !!clientId, 
		hasClientSecret: !!clientSecret, 
		hasAccessToken: !!accessToken,
		merchantRegion: normalizeMerchantRegion(merchantRegion),
		baseUrl,
		baseUrlType: typeof baseUrl,
		clientIdPrefix: clientId ? clientId.substring(0, 20) + '...' : 'none'
	}, 'SP-API client configuration');
	
	logger.info({ baseUrl, merchantRegion: normalizeMerchantRegion(merchantRegion) }, 'Creating SP-API client with baseUrl');
	
	try {
		// Create ApiClient with baseUrl (like the working example)
		logger.info('Creating ApiClient with baseUrl');
		const apiClient = new ReportsSpApi.ApiClient(baseUrl);
		logger.info('ApiClient created successfully');
		
		// Apply access token to the client (like the working example)
		logger.info('Applying access token to ApiClient');
		apiClient.applyXAmzAccessTokenToRequest(accessToken);
		logger.info('Access token applied successfully');
		
		// Now create ReportsApi with the ApiClient
		const reportsApi = new ReportsSpApi.ReportsApi(apiClient);
		logger.info('ReportsApi created successfully with ApiClient');
		
		return reportsApi;
	} catch (error) {
		logger.error({ 
			error: error.message, 
			stack: error.stack,
			baseUrl,
			merchantRegion: normalizeMerchantRegion(merchantRegion)
		}, 'Failed to create SP-API client');
		throw error;
	}
}

async function createReport(sellerProfile, payload, authOverrides = {}) {
    const makeRequest = async (auth) => {
        const reportsApi = await buildReportsClient({ ...auth, merchantRegion: sellerProfile.MerchantRegion });
        const body = {
            reportType: payload.reportType || config.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT,
            marketplaceIds: payload.marketplaceIds,
            dataStartTime: payload.dataStartTime,
            dataEndTime: payload.dataEndTime,
            reportOptions: payload.reportOptions,
        };
        const res = await reportsApi.createReport(body);
        const reportId = res?.data?.reportId || res?.reportId;
        if (!reportId) throw new Error('reportId missing in response');
        return { reportId };
    };

    try {
        return await makeRequest(authOverrides);
    } catch (err) {
        const status = err.status || err.statusCode || err.response?.status;
        if (status === 401 || status === 403) {
            const refreshed = await authService.buildAuthOverrides(sellerProfile.AmazonSellerID, true);
            if (!refreshed?.accessToken) throw new Error('No access token after refresh');
            return await makeRequest(refreshed);
        }
        throw err;
    }
}

async function getReportStatus(sellerProfile, reportId, authOverrides = {}) {
    const makeRequest = async (auth) => {
        const reportsApi = await buildReportsClient({ ...auth, merchantRegion: sellerProfile.MerchantRegion });
        const res = await reportsApi.getReport(reportId);
        const data = res?.data || res;
        return {
            processingStatus: data?.processingStatus,
            reportDocumentId: data?.reportDocumentId || data?.payload?.reportDocumentId
        };
    };

    try {
        return await makeRequest(authOverrides);
    } catch (err) {
        const status = err.status || err.statusCode || err.response?.status;
        if (status === 401 || status === 403) {
            const refreshed = await authService.buildAuthOverrides(sellerProfile.AmazonSellerID, true);
            if (!refreshed?.accessToken) throw new Error('No access token after refresh');
            return await makeRequest(refreshed);
        }
        throw err;
    }
}

async function downloadReport(sellerProfile, documentId, authOverrides = {}) {
    const fetchReport = async (auth) => {
        const reportsApi = await buildReportsClient({ ...auth, merchantRegion: sellerProfile.MerchantRegion });
        const metaResp = await reportsApi.getReportDocument(documentId);
        const doc = metaResp?.data || metaResp;
        if (!doc?.url) throw new Error(`Missing download URL for documentId=${documentId}`);

        let buffer = Buffer.from((await axios.get(doc.url, { responseType: 'arraybuffer', timeout: 60_000 })).data);
        if ((doc.compressionAlgorithm || '').toUpperCase() === 'GZIP') buffer = zlib.gunzipSync(buffer);

        let parsed = null;
        try { parsed = JSON.parse(buffer.toString('utf8')); } catch {}
        return { meta: doc, data: parsed, raw: buffer };
    };

    try {
        return await fetchReport(authOverrides);
    } catch (err) {
        const status = err.status || err.statusCode || err.response?.status;
        if (status === 401 || status === 403) {
            const refreshed = await authService.buildAuthOverrides(sellerProfile.AmazonSellerID, true);
            if (!refreshed?.accessToken) throw new Error('No access token after refresh');
            return await fetchReport(refreshed);
        }
        throw err;
    }
}


module.exports = { createReport, getReportStatus, downloadReport };


