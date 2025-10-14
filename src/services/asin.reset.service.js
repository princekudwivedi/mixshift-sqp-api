const { loadDatabase } = require('../db/tenant.db');
const { getAllAgencyUserList } = require('../models/sequelize/user.model');
const { getModel: getSellerAsinList } = require('../models/sequelize/sellerAsinList.model');
const logger = require('../utils/logger.utils');
const env = require('../config/env.config');
const isDevEnv = ["local", "development"].includes(env.NODE_ENV);
const allowedUsers = [8,3];

class AsinResetService {

    // Check if a period has started
    isNewPeriod(period) {
        const today = new Date();
        if (period === 'WEEK') return today.getDay() === 2; // Tuesday
        if (period === 'MONTH') return today.getDate() === 3;
        if (period === 'QUARTER') {
            const month = today.getMonth() + 1, day = today.getDate();
            return day === 20 && [1,4,7,10].includes(month);
        }
        return false;
    }

    // Generic reset function
    async resetStatus(period, userId = null) {
        try {
            logger.info({ period, userId }, `Starting ${period} ASIN reset`);
            await loadDatabase(0);
            const users = userId ? [{ ID: userId }] : await getAllAgencyUserList();
            let totalReset = 0, processedUsers = 0;

            for (const user of users) {
                try {
                    if(isDevEnv && !allowedUsers.includes(user.ID)) {
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
    }

    // Main reset method
    async resetAsinStatus() {
        try {
            logger.info('Starting automatic ASIN reset check');
            var periods = env.TYPE_ARRAY;
            const results = [];
            for (const period of periods) {
                if (this.isNewPeriod(period)) {
                    logger.info(`New ${period.toLowerCase()} detected - resetting`);
                    const result = await this.resetStatus(period);
                    results.push(result);
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
