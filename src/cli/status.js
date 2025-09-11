const logger = require('../utils/logger');
const ctrl = require('../controllers/sqpCronController');

(async () => {
    try {
        await ctrl.checkReportStatuses();
        logger.info('Status cron completed');
        process.exit(0);
    } catch (e) {
        logger.error(e, 'Status cron failed');
        process.exit(1);
    }
})();


