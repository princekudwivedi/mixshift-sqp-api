const BaseModel = require('./base.model');
const { env } = require('../config/env.config');

class SqpMetrics3moModel extends BaseModel {
    constructor() {
        super(env('TBL_SQP_METRICS_3MO', 'sqp_metrics_3mo'), 'ID');
    }

    async bulkInsert(records, chunkSize = 500) {
        if (!Array.isArray(records) || records.length === 0) return 0;
        let inserted = 0;
        for (let i = 0; i < records.length; i += chunkSize) {
            const chunk = records.slice(i, i + chunkSize);
            for (const row of chunk) {
                await this.create(row);
                inserted += 1;
            }
        }
        return inserted;
    }
}

module.exports = new SqpMetrics3moModel();


