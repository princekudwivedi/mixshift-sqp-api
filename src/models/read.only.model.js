const BaseModel = require('./base.model');

class ReadOnlyModel extends BaseModel {
    constructor(tableName, primaryKey = 'ID') {
        super(tableName, primaryKey);
    }

    async create() {
        throw new Error(`Write operation not allowed on read-only model: ${this.tableName}`);
    }

    async update() {
        throw new Error(`Write operation not allowed on read-only model: ${this.tableName}`);
    }

    async delete() {
        throw new Error(`Write operation not allowed on read-only model: ${this.tableName}`);
    }

    async deleteBy() {
        throw new Error(`Write operation not allowed on read-only model: ${this.tableName}`);
    }
}

module.exports = ReadOnlyModel;


