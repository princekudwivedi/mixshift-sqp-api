function makeReadOnly(model, { allowCreate = false, allowBulkCreate = false, allowUpdate = false, allowDelete = false, allowUpsert = false, allowTruncate = false, allowSave = false, allowDestroy = false } = {}) {
    const block = (name) => () => { throw new Error(`${model.name || model.tableName}: ${name} not allowed (read-only)`); };
    if (!allowCreate) model.create = block('create');
    if (!allowBulkCreate) model.bulkCreate = block('bulkCreate');
    if (!allowUpdate) model.update = block('update');
    if (!allowDelete) model.destroy = block('destroy');
    if (!allowUpsert) model.upsert = block('upsert');
    if (!allowTruncate) model.truncate = block('truncate');
    if (model.prototype && model.prototype.save) {
        if (!allowDestroy) model.prototype.destroy = block('destroy');
        if (!allowUpdate) model.prototype.update = block('update');
        if (!allowBulkCreate) model.prototype.bulkCreate = block('bulkCreate');
        if (!allowSave) model.prototype.save = block('save');
    }
    return model;
}

module.exports = { makeReadOnly };


