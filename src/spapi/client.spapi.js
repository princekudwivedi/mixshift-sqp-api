const logger = require('../utils/logger.utils');
const config = require('../config/env.config');
const axios = require('axios');
const zlib = require('zlib');

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
	const clientId = opts.clientId || config.LWA_CLIENT_ID;
	const clientSecret = opts.clientSecret || config.LWA_CLIENT_SECRET;
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
	try {
		logger.info({ 
			sellerProfile: {
				AmazonSellerID: sellerProfile.AmazonSellerID,
				MerchantRegion: sellerProfile.MerchantRegion,
				MerchantRegionType: typeof sellerProfile.MerchantRegion
			}
		}, 'createReport input');
		
		// Add merchant region to auth overrides
		const clientOpts = {
			...authOverrides,
			merchantRegion: sellerProfile.MerchantRegion
		};
		const reportsApi = await buildReportsClient(clientOpts);
		const body = {
			reportType: payload.reportType || config.GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT,
			marketplaceIds: payload.marketplaceIds,
			dataStartTime: payload.dataStartTime,
			dataEndTime: payload.dataEndTime,
			reportOptions: payload.reportOptions,
		};
		
		logger.info({ 
			sellerId: sellerProfile.AmazonSellerID,
			marketplaceIds: payload.marketplaceIds,
        	reportType: body.reportType,
			dataStartTime: payload.dataStartTime,
			dataEndTime: payload.dataEndTime
		}, 'Creating SP-API report request');
		
		const res = await reportsApi.createReport(body);
		// SDK may wrap in data property depending on version
		const reportId = res?.data?.reportId || res?.reportId;
		if (!reportId) throw new Error('createReport: reportId missing in response');
		return { reportId };
	} catch (error) {
		logger.error({ 
			error: error.message,
			status: error.status,
			statusText: error.statusText,
			response: error.response?.data,
			sellerId: sellerProfile.AmazonSellerID
		}, 'SP-API createReport failed');
		throw error;
	}
}

async function getReportStatus(sellerProfile, reportId, authOverrides = {}) {
	try {
		// Add merchant region to auth overrides
		const clientOpts = {
			...authOverrides,
			merchantRegion: sellerProfile.MerchantRegion
		};
		const reportsApi = await buildReportsClient(clientOpts);
		const res = await reportsApi.getReport(reportId);
		const data = res?.data || res;
		logger.info({ sellerId: sellerProfile.AmazonSellerID, reportId, raw: data }, 'getReport raw response');
		const status = data?.processingStatus;
		const reportDocumentId = data?.reportDocumentId || data?.payload?.reportDocumentId;
		return { processingStatus: status, reportDocumentId };
	} catch (error) {
        logger.error({ 
            error: error.message,
            status: error.status,
            statusText: error.statusText,
            response: error.response?.data,
            sellerId: sellerProfile.AmazonSellerID,
            reportId
        }, 'SP-API getReportStatus failed');
        // Normalize 403 Forbidden into a clear, non-retryable error with preserved status
        if ((error.status || error.response?.status) === 403) {
            const e = new Error('Forbidden: SP-API Brand Analytics permission missing or token/seller mismatch');
            e.status = 403;
            throw e;
        }
        throw error;
	}
}

async function downloadReport(sellerProfile, documentId, authOverrides = {}) {
	try {
	  // Build reports client with correct region
	  const clientOpts = {
		...authOverrides,
		merchantRegion: sellerProfile.MerchantRegion,
	  };
	  const reportsApi = await buildReportsClient(clientOpts);
  
	  logger.info({ sellerId: sellerProfile.AmazonSellerID }, "Building Reports API client");
  
	  // Step 1: Get document metadata
	  const metaResp = await reportsApi.getReportDocument(documentId);
	  const doc = metaResp?.data || metaResp;
  
	  logger.info(
		{
		  sellerId: sellerProfile.AmazonSellerID,
		  documentId,
		  hasUrl: !!doc?.url,
		  compression: doc?.compressionAlgorithm,
		},
		"getReportDocument response"
	  );
  
	  if (!doc?.url) {
		throw new Error(`Missing download URL for documentId=${documentId}`);
	  }
  
	  // Step 2: Download from pre-signed S3 URL (no auth needed)
	  const resp = await axios.get(doc.url, {
		responseType: "arraybuffer",
		timeout: 60_000, // 60 sec safety
	  });
  
	  let buffer = Buffer.from(resp.data);
  
	  // Step 3: Decompress if needed
	  const compression = (doc.compressionAlgorithm || "").toUpperCase();
	  if (compression === "GZIP") {
		buffer = zlib.gunzipSync(buffer);
	  }
  
	  // Step 4: Parse JSON (if valid JSON)
	  let parsed = null;
	  try {
		parsed = JSON.parse(buffer.toString("utf8"));
	  } catch {
		logger.warn(
		  { sellerId: sellerProfile.AmazonSellerID, documentId },
		  "Downloaded report is not valid JSON, returning raw buffer"
		);
	  }
  
	  return { meta: doc, data: parsed, raw: buffer };
	} catch (error) {
	  logger.error(
		{
		  error: error.message,
		  status: error.response?.status,
		  response: error.response?.data,
		  sellerId: sellerProfile.AmazonSellerID,
		  documentId,
		},
		"SP-API downloadReport failed"
	  );
	  throw error;
	}
}
module.exports = { createReport, getReportStatus, downloadReport };


