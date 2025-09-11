const logger = require('../utils/logger');
const ctrl = require('../controllers/sqpCronController');
const { sellerDefaults } = require('../config/env');
const { loadDatabase } = require('../db/tenant');
const master = require('../models/masterModel');
const sellerModel = require('../models/sellerModel');

(async () => {
    try {
        // Iterate all users (agencies) like PHP run flow (can filter to one user via env if desired)
        await loadDatabase(0);
        const users = await master.getAllAgencyUserList();
        for (const user of users) {
            await loadDatabase(user.ID);
            // For each tenant, iterate active sellers (use tenant's user ID)
            const sellers = await sellerModel.getSellersProfilesForCron(user.ID);
            for (const s of sellers) {
                const authOverrides = {};
                // Optionally pick per-seller refresh token (by AmazonSellerID)
                const tokenRow = await master.getSavedToken(s.AmazonSellerID);
                if (tokenRow && tokenRow.refresh_token) {
                    authOverrides.refreshToken = tokenRow.refresh_token;
                }
                // Note: AWS credentials are handled automatically by the SP-API SDK
                await ctrl.requestForSeller(s, authOverrides);
            }
        }
        logger.info('Request cron completed');
        process.exit(0);
    } catch (e) {
        logger.error(e, 'Request cron failed');
        process.exit(1);
    }
})();


