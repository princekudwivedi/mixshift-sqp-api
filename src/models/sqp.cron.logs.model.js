const BaseModel = require('./base.model');
const { env } = require('../config/env.config');
const dates = require('../utils/dates.utils');


class SqpCronLogsModel extends BaseModel {
    constructor() {
        super(env('TBL_SQP_CRON_LOGS', 'sqp_cron_logs'), 'ID');
    }

    async log(info) {
        return this.create({ ...info, CreatedAt: dates.getNowDateTimeInUserTimezone().db });
    }

    async findByCronId(cronId, options = {}) {
        return this.getAll({ where: { CronID: cronId }, orderBy: 'CreatedAt DESC', ...options });
    }
}

module.exports = new SqpCronLogsModel();


