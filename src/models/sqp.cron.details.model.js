const BaseModel = require('./base.model');
const { env } = require('../config/env.config');
const dates = require('../utils/dates.utils');

class SqpCronDetailsModel extends BaseModel {
    constructor() {
        super(env('TBL_SQP_CRON_DETAILS', 'sqp_cron_details'), 'ID');
    }

    async getByStatus(status, options = {}) {
        return this.getAll({ where: { Status: status }, ...options });
    }

    async getPending(limit = 50) {
        return this.getAll({ where: { Status: 'PENDING' }, limit });
    }

    async markStarted(id) {
        return this.update(id, { Status: 'STARTED', StartedAt: dates.getNowDateTimeInUserTimezone() });
    }

    async markCompleted(id, extra = {}) {
        return this.update(id, { Status: 'COMPLETED', CompletedAt: dates.getNowDateTimeInUserTimezone(), ...extra });
    }

    async markFailed(id, message) {
        return this.update(id, { Status: 'FAILED', ErrorMessage: message, CompletedAt: dates.getNowDateTimeInUserTimezone() });
    }
}

module.exports = new SqpCronDetailsModel();


