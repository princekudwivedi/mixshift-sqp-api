const logger = require('../utils/logger');
const ctrl = require('../controllers/sqpCronController');

(async () => {
    try {
        await ctrl.downloadCompletedReports();
        logger.info('Download cron completed');
        process.exit(0);
    } catch (e) {
        logger.error(e, 'Download cron failed');
        process.exit(1);
    }
})();


