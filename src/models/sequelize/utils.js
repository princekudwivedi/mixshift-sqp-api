function makeReadOnly(model) {
    const block = (name) => () => { throw new Error(`${model.name || model.tableName}: ${name} not allowed (read-only)`); };
    model.create = block('create');
    model.bulkCreate = block('bulkCreate');
    model.update = block('update');
    model.destroy = block('destroy');
    model.upsert = block('upsert');
    model.truncate = block('truncate');
    if (model.prototype && model.prototype.save) {
        model.prototype.save = block('save');
        model.prototype.destroy = block('destroy');
        model.prototype.update = block('update');
    }
    return model;
}

module.exports = { makeReadOnly };


