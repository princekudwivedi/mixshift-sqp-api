const express = require('express');
const logger = require('./utils/logger');
const { loadDatabase } = require('./db/tenant');
const master = require('./models/masterModel');
const sellerModel = require('./models/sellerModel');
const ctrl = require('./controllers/sqpCronController');
const fileProcessingService = require('./services/sqpFileProcessingService');

const app = express();
app.use(express.json());

async function buildAuthOverrides(amazonSellerID) {
    const authOverrides = {};
    const tokenRow = await master.getSavedToken(amazonSellerID);
    if (tokenRow && tokenRow.access_token) {
        authOverrides.accessToken = tokenRow.access_token;
        logger.info({ 
            amazonSellerID, 
            hasAccessToken: !!tokenRow.access_token,
            tokenId: tokenRow.id,
            expiresIn: tokenRow.expires_in
        }, 'Token details for seller');
    } else {
        logger.warn({ amazonSellerID }, 'No access token found for seller');
    }
    
    // Get AWS STS credentials for SigV4 signing (like PHP)
    const sts = await master.getStsTokenDetails();
    if (sts) {
        authOverrides.awsAccessKeyId = sts.accessKeyId;
        authOverrides.awsSecretAccessKey = sts.secretAccessKey;
        authOverrides.awsSessionToken = sts.SessionToken;
    }
    
    return authOverrides;
}

app.get('/cron/request', async (req, res) => {
    try {
        const userId = Number(req.query.userId || 0);
        const sellerId = req.query.sellerId ? Number(req.query.sellerId) : null;
        await loadDatabase(0);
        const users = userId ? [{ ID: userId }] : await master.getAllAgencyUserList();
        for (const user of users) { 
            await loadDatabase(user.ID);
            const sellers = sellerId
                ? await sellerModel.getSellersProfilesForCronAdvanced({ idSellerAccount: sellerId, pullAll: 1 })
                : await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });
            for (const s of sellers) {         
                if (!s) continue;
                const authOverrides = await buildAuthOverrides(s.AmazonSellerID);
                await ctrl.requestForSeller(s, authOverrides);
            }
        }
        res.json({ success: true });
    } catch (e) {
        logger.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/cron/status', async (req, res) => {
    try {
        const userId = Number(req.query.userId || 0);
        await loadDatabase(0);
        const users = userId ? [{ ID: userId }] : await master.getAllAgencyUserList();
        
        for (const user of users) {     
            await loadDatabase(user.ID);
            
            const sts = await master.getStsTokenDetails();
            const authOverrides = sts ? {
                awsAccessKeyId: sts.accessKeyId,
                awsSecretAccessKey: sts.secretAccessKey,
                awsSessionToken: sts.SessionToken,
            } : {};
            await ctrl.checkReportStatuses(authOverrides);
        }
        res.json({ success: true });
    } catch (e) {
        logger.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/cron/download', async (req, res) => {
    try {
        const userId = Number(req.query.userId || 0);
        await loadDatabase(0);
        const users = userId ? [{ ID: userId }] : await master.getAllAgencyUserList();
        
        for (const user of users) {           
            await loadDatabase(user.ID);
            
            const sts = await master.getStsTokenDetails();
            const authOverrides = sts ? {
                awsAccessKeyId: sts.accessKeyId,
                awsSecretAccessKey: sts.secretAccessKey,
                awsSessionToken: sts.SessionToken,
            } : {};
            await ctrl.downloadCompletedReports(authOverrides);
        }
        res.json({ success: true });
    } catch (e) {
        logger.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/cron/all', async (req, res) => {
    try {
        const userId = Number(req.query.userId || 0);
        const sellerId = req.query.sellerId ? Number(req.query.sellerId) : null;
        await loadDatabase(0);
        const users = userId ? [{ ID: userId }] : await master.getAllAgencyUserList();
        for (const user of users) {
            await loadDatabase(user.ID);
            const sellers = sellerId
                ? [await sellerModel.getProfileDetailsByID(sellerId)]
                : await sellerModel.getSellersProfilesForCronAdvanced({ pullAll: 0 });
            for (const s of sellers) {
                if (!s) continue;
                const authOverrides = await buildAuthOverrides(s.AmazonSellerID);
                await ctrl.requestForSeller(s, authOverrides);
            }
        }
        // Note: AWS credentials are handled automatically by the SP-API SDK
        const authOverrides = {};
        await ctrl.checkReportStatuses(authOverrides);
        await ctrl.downloadCompletedReports(authOverrides); // downloads JSON and records file path only
        res.json({ success: true });
    } catch (e) {
        logger.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/cron/process-json', async (req, res) => {
    try {
        const userId = Number(req.query.userId || 0);
        await loadDatabase(0);
        const users = userId ? [{ ID: userId }] : await master.getAllAgencyUserList();
        
        let totalProcessed = 0;
        let totalErrors = 0;
        
        for (const user of users) {
            await loadDatabase(user.ID);
            const result = await fileProcessingService.processSavedJsonFiles();
            totalProcessed += result.processed;
            totalErrors += result.errors;
        }
        
        res.json({ 
            success: true, 
            processed: totalProcessed, 
            errors: totalErrors 
        });
    } catch (e) {
        logger.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/cron/stats', async (req, res) => {
    try {
        const userId = Number(req.query.userId || 0);
        await loadDatabase(0);
        const users = userId ? [{ ID: userId }] : await master.getAllAgencyUserList();
        
        const stats = await fileProcessingService.getProcessingStats();
        
        res.json({ 
            success: true, 
            stats 
        });
    } catch (e) {
        logger.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => logger.info({ PORT }, 'Cron server running'));


