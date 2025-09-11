const logger = require('../utils/logger');
const ctrl = require('../controllers/sqpCronController');
const { sellerDefaults } = require('../config/env');

(async () => {
    try {
        const seller = {
            AmazonSellerID: sellerDefaults.amazonSellerId,
            idSellerAccount: sellerDefaults.idSellerAccount,
            AmazonMarketplaceId: sellerDefaults.marketplaceId,
        };
        await ctrl.requestForSeller(seller);
        await ctrl.checkReportStatuses();
        await ctrl.downloadCompletedReports();
        logger.info('All cron steps completed');
        process.exit(0);
    } catch (e) {
        logger.error(e, 'All cron failed');
        process.exit(1);
    }
})();


