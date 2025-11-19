const { loadDatabase, initDatabaseContext } = require('../db/tenant.db');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const logger = require('../utils/logger.utils');
const { isUserAllowed, sanitizeLogData } = require('../utils/security.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development","production"].includes(env.NODE_ENV);
const dates = require('../utils/dates.utils');
class AsinResetService {

    // Check if a period has started
    isNewPeriod(period) {
        const nowInTimezone = dates.getNowDateTimeInUserTimezone().log;
		const today = new Date(nowInTimezone.replace(' ', 'T'));
		today.setHours(0, 0, 0, 0); // zero out hours, minutes, seconds, ms		

        if (period === 'WEEK') return today.getDay() === Number(process.env.WEEK_RESET_DAY || 2); // Tuesday
        if (period === 'MONTH') return today.getDate() === Number(process.env.MONTH_REPORT_DELAY || 3);
        if (period === 'QUARTER') {
            const month = today.getMonth() + 1, day = today.getDate();
            return day === Number(process.env.QUARTER_REPORT_DELAY || 20) && [1,4,7,10].includes(month);
        }
        logger.info({'userId': null, 'operation': 'resetAsinStatus isNewPeriod', 'period': period}, 'No period start detected');
        return false;
    }

    // Generic reset function
    async resetStatus(period, userId = null) {
        return initDatabaseContext(async () => {
            try {
                logger.info({ period, userId }, `Starting ${period} ASIN reset`);
                await loadDatabase(0);
                const users = userId ? [{ ID: userId }] : await getAllAgencyUserList();
                let totalReset = 0, processedUsers = 0;

                for (const user of users) {
                    try {                        
                        if(isDevEnv && !isUserAllowed(user.ID)) {
                            continue;
                        } else {
                            await loadDatabase(user.ID);
                            const SellerAsinList = getSellerAsinList();
                            const fields = {};
                            const dt = new Date();

                            if (period === 'WEEK') {
                                Object.assign(fields, {
                                    WeeklyLastSQPDataPullStatus: null,
                                    WeeklyLastSQPDataPullStartTime: null,
                                    WeeklyLastSQPDataPullEndTime: null
                                });
                            } else if (period === 'MONTH') {
                                Object.assign(fields, {
                                    MonthlyLastSQPDataPullStatus: null,
                                    MonthlyLastSQPDataPullStartTime: null,
                                    MonthlyLastSQPDataPullEndTime: null
                                });
                            } else if (period === 'QUARTER') {
                                Object.assign(fields, {
                                    QuarterlyLastSQPDataPullStatus: null,
                                    QuarterlyLastSQPDataPullStartTime: null,
                                    QuarterlyLastSQPDataPullEndTime: null
                                });
                            }
                            fields.dtUpdatedOn = dt;
                            const [updated] = await SellerAsinList.update(fields, { where: { IsActive: 1 } });
                            totalReset += updated;
                            processedUsers++;

                            logger.info({ userId: user.ID, resetCount: updated }, `${period} reset done for user`);
                        }
                    } catch (e) {
                        logger.error({ userId: user.ID, error: e.message }, `Error resetting ${period} for user`);
                    }
                }

                return { success: true, totalReset, userCount: processedUsers, totalUsers: users.length, resetType: period };

            } catch (error) {
                logger.error({ error: error.message, stack: error.stack }, `Error in ${period} reset`);
                throw error;
            }
        });
    }

    // Main reset method
    async resetAsinStatus() {
        try {            
            logger.info({'userId': null, 'operation': 'resetAsinStatus'}, 'Starting automatic ASIN reset check');
            var periods = env.TYPE_ARRAY;
            const results = [];
            for (const period of periods) {
                if (this.isNewPeriod(period)) {
                    logger.info(`New ${period.toLowerCase()} detected - resetting`);
                    const result = await this.resetStatus(period);
                    results.push(result);
                } else {
                    logger.info({'userId': null, 'operation': 'resetAsinStatus function for loop detected no period start', 'period': period}, 'No period start detected');
                }
            }
            return results.length ? { success: true, message: 'Automatic reset completed', results }
                                  : { success: true, message: 'No period start detected', results: [] };
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Error in automatic ASIN reset');
            throw error;
        }
    }
}

module.exports = new AsinResetService();
