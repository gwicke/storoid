"use strict";

var crypto = require('crypto');
var cass = require('cassandra-driver');
var uuid = require('node-uuid');

var defaultConsistency = cass.types.consistencies.one;

function cassID (name) {
    if (/^[a-zA-Z0-9_]+$/.test(name)) {
        return '"' + name + '"';
    } else {
        return '"' + name.replace(/"/g, '""') + '"';
    }
}

function tidFromDate(date) {
    // Create a new, deterministic timestamp
    return uuid.v1({
        node: [0x01, 0x23, 0x45, 0x67, 0x89, 0xab],
        clockseq: 0x1234,
        msecs: date.getTime(),
        nsecs: 0
    });
}

function buildCondition (pred) {
    var params = [];
    var conjunctions = [];
    for (var predKey in pred) {
        var cql = '';
        var predObj = pred[predKey];
        cql += cassID(predKey);
        if (predObj.constructor === String) {
            // Default to equality
            cql += ' = ?';
            params.push(predObj);
        } else if (predObj.constructor === Object) {
            var predKeys = Object.keys(predObj);
            if (predKeys.length === 1) {
                var predOp = predKeys[0];
                var predArg = predObj[predOp];
                switch (predOp.toLowerCase()) {
                case 'eq': cql += ' = ?'; params.push(predArg); break;
                case 'lt': cql += ' < ?'; params.push(predArg); break;
                case 'gt': cql += ' > ?'; params.push(predArg); break;
                case 'le': cql += ' <= ?'; params.push(predArg); break;
                case 'ge': cql += ' >= ?'; params.push(predArg); break;
                // Also support 'neq' for symmetry with 'eq' ?
                case 'ne': cql += ' != ?'; params.push(predArg); break;
                case 'between':
                        cql += ' >= ?' + ' AND '; params.push(predArg[0]);
                        cql += cassID(predKey) + ' <= ?'; params.push(predArg[1]);
                        break;
                default: throw new Error ('Operator ' + predOp + ' not supported!');
                }

            } else {
                throw new Error ('Invalid predicate ' + JSON.stringify(pred));
            }
        }
        conjunctions.push(cql);
    }
    return {
        query: conjunctions.join(' AND '),
        params: params
    };
}

// Hash a key into a valid Cassandra key name
function hashKey (key) {
    return crypto.Hash('sha1')
        .update(key)
        .digest()
        .toString('base64')
        // Replace [+/] from base64 with _ (illegal in Cassandra)
        .replace(/[+\/]/g, '_')
        // Remove base64 padding, has no entropy
        .replace(/=+$/, '');
}

function getValidPrefix (key) {
    var prefixMatch = /^[a-zA-Z0-9_]+/.exec(key);
    if (prefixMatch) {
        return prefixMatch[0];
    } else {
        return '';
    }
}

function makeValidKey (key, length) {
    var origKey = key;
    key = key.replace(/_/g, '__')
                .replace(/\./g, '_');
    if (!/^[a-zA-Z0-9_]+$/.test(key)) {
        // Create a new 28 char prefix
        var validPrefix = getValidPrefix(key).substr(0, length * 2 / 3);
        return validPrefix + hashKey(origKey).substr(0, length - validPrefix.length);
    } else if (key.length > length) {
        return key.substr(0, length * 2 / 3) + hashKey(origKey).substr(0, length / 3);
    } else {
        return key;
    }
}


/**
 * Derive a valid keyspace name from a random bucket name. Try to use valid
 * chars from the requested name as far as possible, but fall back to a sha1
 * if not possible. Also respect Cassandra's limit of 48 or fewer alphanum
 * chars & first char being an alpha char.
 *
 * @param {string} reverseDomain, a domain in reverse dot notation
 * @param {string} key, the bucket name to derive the key of
 * @return {string} Valid Cassandra keyspace key
 */
function keyspaceName (reverseDomain, key) {
    var prefix = makeValidKey(reverseDomain, Math.max(26, 48 - key.length - 3));
    return prefix
        // 6 chars _hash_ to prevent conflicts between domains & table names
        + '_T_' + makeValidKey(key, 48 - prefix.length - 3);
}

function validateSchema(req) {

    if (!req.index || !req.index.hash) {
        //console.log(req);
        throw new Error("Missing index or hash key in table schema");
    }

    // Normalize the range index to an array
    var rangeIndex = req.index.range || [];
    if (!Array.isArray(rangeIndex)) {
        rangeIndex = [req.index.range];
    }

    return rangeIndex;
}

function generateIndexSchema (req, indexName) {

    var index = req.secondaryIndexes[indexName],
        hasTid = false;

    if (!index.hash) {
        throw new Error ('Index not defined properly');
    }

    var rangeIndex = validateSchema(req);

    // Make sure we have an array for the range part of the index
    var range = [];
    if (index.range) {
        if (!Array.isArray(index.range)) {
            range = [index.range];
        } else {
            range = index.range;
        }
    }

    // Build up attributes
    var attributes = {
        __consistentUpTo: 'timeuuid',
        __tombstone: 'boolean'
    };
    index.static = '__consistentUpTo';

    // copy over type info
    attributes[index.hash] = req.attributes[index.hash];

    // build index attribures for the schema
    var _indexAttributes = {};
    _indexAttributes[index.hash] = true;

    range.forEach(function(items){
        _indexAttributes[items] = true;
    });

    // TODO: Support indexes without a hash, by substituting an int column that defaults to 0 or the like. 
    // This is useful for smallish indexes that need to be sorted / support range queries.
    
    // Make sure the main index keys are included in the new index
    // First, the hash key.
    if (!attributes[req.index.hash] && range.indexOf(req.index.hash) === -1) {
        // Add in the original hash key as an additional range key
        range.push(req.index.hash);
    }

    // Now the range key(s).
    rangeIndex.forEach(function(att) {
        if (!attributes[att] && range.indexOf(att) === -1) {
            // Add in the original hash key(s) as additional range
            // key(s)
            range.push(att);
            _indexAttributes[att] = true;
        }
    });

    // Now make sure that all range keys are also included in the
    // attributes.
    range.forEach(function(att) {
        if (!attributes[att]) {
            attributes[att] = req.attributes[att];
        }
        if (attributes[att] === 'timeuuid') {
            hasTid = true;
        }
    });

    if (!hasTid) {
        attributes._tid = 'timeuuid';
        range.push('_tid');
        _indexAttributes._tid = 'timeuuid';
    }

    // Finally, deal with projections
    if (index.proj && Array.isArray(index.proj)) {
        index.proj.forEach(function(attr) {
            if (!attributes[attr]) {
                attributes[attr] = req.attributes[attr];
            }
        });
    }

    index.range = range;
    var indexSchema = {
        name: indexName,
        attributes: attributes,
        index: index,
        consistency: defaultConsistency,
        _indexAttributes: _indexAttributes
    };

    return indexSchema;
}

function DB (client) {
    // cassandra client
    this.client = client;

    // cache keyspace -> schema
    this.schemaCache = {};
}

// Info table schema
DB.prototype.infoSchema = {
    name: 'meta',
    attributes: {
        key: 'string',
        value: 'json'
    },
    index: {
        hash: 'key'
    },
    _restbase: { _indexAttributes: {'key': true} }
};


DB.prototype.buildPutQuery = function(req, keyspace, table, schema) {

    // TODO: Think about how to insert tid for secondary index ranges

    var keys = [];
    var params = [];
    var indexKVMap = {};
    var placeholders = [];
    var _indexAttributes;

    if (table === 'meta') {
        _indexAttributes = schema._restbase._indexAttributes;
    } else if ( table === "data" ) {
        _indexAttributes = schema._restbase._indexAttributes;
    } else {
        _indexAttributes = schema._indexAttributes;
        table = "i_" + table;
    }

    if (!schema) {
        throw new Error('Table not found!');
    }

    for (var key in _indexAttributes) {
        if (key === '_tid') {
            indexKVMap[key] = tidFromDate(new Date());
        } else if (!req.attributes[key]) {
            throw new Error("Index attribute " + key + " missing");
        } else {
            indexKVMap[key] = req.attributes[key];
        }
    }

    for (key in req.attributes) {
        var val = req.attributes[key];
        if (val !== undefined && schema.attributes[key]) {
            if (val.constructor === Object) {
                val = JSON.stringify(val);
            }
            if (!_indexAttributes[key]) {
                keys.push(key);
                params.push(val);
            }
            placeholders.push('?');
        }
    }

    // switch between insert & update / upsert
    // - insert for 'if not exists', or when no non-primary-key attributes are
    //   specified
    // - update when any non-primary key attributes are supplied
    //   - Need to verify that all primary key members are supplied as well,
    //     else error.

    var cql = '', condResult;

    if (req.if && req.if.constructor === String) {
        req.if = req.if.trim().split(/\s+/).join(' ').toLowerCase();
    }

    var condRes = buildCondition(indexKVMap);

    if (!keys.length || req.if === 'not exists') {
        var proj = Object.keys(_indexAttributes).concat(keys).map(cassID).join(',');
        cql = 'insert into ' + cassID(keyspace) + '.' + cassID(table)
                + ' (' + proj + ') values (';
        cql += placeholders.join(',') + ')';
        params = condRes.params.concat(params);
    } else if ( keys.length ) {
        var updateProj = keys.map(cassID).join(' = ?,') + ' = ? ';
        cql += 'update ' + cassID(keyspace) + '.' + cassID(table) +
               ' set ' + updateProj + ' where ';
        cql += condRes.query;
        params = params.concat(condRes.params);
    } else {
        throw new Error("Can't Update or Insert");
    }

    // Build up the condition
    if (req.if) {
        if (req.if === 'not exists') {
            cql += ' if not exists ';
        } else {
            cql += ' if ';
            condResult = buildCondition(req.if);
            cql += condResult.query;
            params = params.concat(condResult.params);
        }
    }

    return {query: cql, params: params};
};

DB.prototype.executeCql = function(batch, consistency, thenCB) {
    if (batch.length === 1) {
        return this.client.execute_p(batch[0].query, batch[0].params, {consistency: consistency, prepared: true})
        .then(thenCB);
    } else {
        return this.client.batch_p(batch, {consistency: consistency, prepared: true})
        .then(thenCB);
    }
};

DB.prototype.getSchema = function (reverseDomain, tableName) {
    var keyspace = keyspaceName(reverseDomain, tableName);

    // consistency
    var consistency = defaultConsistency;
    var query = {
        attributes: {
            key: 'schema'
        }
    };
    return this._getSchema(keyspace, consistency);
};

DB.prototype._getSchema = function (keyspace, consistency) {
    var query = {
        attributes: {
            key: 'schema'
        }
    };
    return this._get(keyspace, {}, consistency, 'meta')
    .then(function(res) {
        if (res.items.length) {
            var schema = res.items[0].value,
                _indexAttributes = {},
                rangeColumn;

            schema = JSON.parse(schema);
            schema._restbase = {};
            schema._restbase.indexSchema = {};

            if (schema.secondaryIndexes) {
                for (var indexName in schema.secondaryIndexes) {
                    var indexSchema = generateIndexSchema(schema, indexName);
                    schema._restbase.indexSchema[indexName] = indexSchema;
                }
            }

            _indexAttributes[schema.index.hash] = true;
            rangeColumn = schema.index.range;
            if (Array.isArray(rangeColumn)) {
                rangeColumn.forEach(function(items){
                    _indexAttributes[items] = true;
                });
            } else if (rangeColumn) {
                _indexAttributes[rangeColumn] = true;
            }
            schema._restbase._indexAttributes = _indexAttributes;
            return schema;
        } else {
            return null;
        }
    });
};

DB.prototype.get = function (reverseDomain, req) {
    var self = this;
    var keyspace = keyspaceName(reverseDomain, req.table);

    // consistency
    var consistency = defaultConsistency;
    if (req.consistency && req.consistency in {all:1, localQuorum:1}) {
        consistency = cass.types.consistencies[req.consistency];
    }

    if (!this.schemaCache[keyspace]) {
        return this._getSchema(keyspace, defaultConsistency)
        .then(function(schema) {
            //console.log('schema', schema);
            self.schemaCache[keyspace] = schema;
            return self._get(keyspace, req, consistency);
        });
    } else {
        return this._get(keyspace, req, consistency);
    }
};

var getCache = {};

DB.prototype._get = function (keyspace, req, consistency, table) {
    if (!table) {
        table = 'data';
    }
    var proj = '*';
    if (req.proj) {
        if (Array.isArray(req.proj)) {
            proj = req.proj.map(cassID).join(',');
        } else if (req.proj.constructor === String) {
            proj = cassID(req.proj);
        }
    } else if (req.order) {
        // Work around 'order by' bug in cassandra when using *
        // Trying to change the natural sort order only works with a
        // projection in 2.0.9
        var cachedSchema = this.schemaCache[keyspace];
        if (cachedSchema) {
            proj = Object.keys(cachedSchema.attributes).map(cassID).join(',');
        }
    }
    if (req.index) {
        table = 'i_' + req.index;
    }

    if (req.distinct) {
        proj = 'distinct ' + proj;
    }
    var cql = 'select ' + proj + ' from '
        + cassID(keyspace) + '.' + cassID(table);

    var params = [];
    // Build up the condition
    if (req.attributes) {
        cql += ' where ';
        var condResult = buildCondition(req.attributes);
        cql += condResult.query;
        params = condResult.params;
    }

    if (req.order) {
        // need to know range column
        var schema = this.schemaCache[keyspace];
        var rangeColumn;
        if (schema) {
            rangeColumn = schema.index.range;
            if (Array.isArray(rangeColumn)) {
                rangeColumn = rangeColumn[0];
            }
        } else {
            // fake it for now
            rangeColumn = '_tid';
        }
        var dir = req.order.toLowerCase();
        if (rangeColumn && dir in {'asc':1, 'desc':1}) {
            cql += ' order by ' + cassID(rangeColumn) + ' ' + dir;
        }
    }

    if (req.limit && req.limit.constructor === Number) {
        cql += ' limit ' + req.limit;
    }

    //console.log(cql, params);
    return this.client.execute_p(cql, params, {consistency: consistency, prepared:true})
    .then(function(result) {
        var rows = result.rows;
        // hide the columns property added by node-cassandra-cql
        // XXX: submit a patch to avoid adding it in the first place
        for (var row in rows) {
            row.columns = undefined;
        }
        return {
            count: rows.length,
            items: rows
        };
    });
};

DB.prototype.put = function (reverseDomain, req) {
    var keyspace = keyspaceName(reverseDomain, req.table);


    // consistency
    var consistency = defaultConsistency;
    if (req.consistency && req.consistency in {all:1, localQuorum:1}) {
        consistency = cass.types.consistencies[req.consistency];
    }

    // Get the type info for the table & verify types & ops per index
    var self = this;
    if (!this.schemaCache[keyspace]) {
        return this._getSchema(keyspace, defaultConsistency)
        .then(function(schema) {
            self.schemaCache[keyspace] = schema;
            return self._put(keyspace, req, consistency);
        });
    } else {
        return this._put(keyspace, req, consistency);
    }
};


DB.prototype._put = function(keyspace, req, consistency, table ) {

    if (!table) {
        table = 'data';
    }

    var schema;
    if (table === 'meta') {
        schema = this.infoSchema;
    } else if ( table === "data" ) {
        schema = this.schemaCache[keyspace];
    }

    if (!schema) {
        throw new Error('Table not found!');
    }

    var batch = [];
    var queryResult = this.buildPutQuery(req, keyspace, table, schema);
    batch.push(queryResult);

    if (schema.secondaryIndexes) {
        for ( var item in schema.secondaryIndexes) {
            schema = this.schemaCache[keyspace]._restbase.indexSchema[item];
            if (!schema) {
                throw new Error('Table not found!');
            }
            queryResult = this.buildPutQuery( req, keyspace, item, schema);
            batch.push(queryResult);
        }
    }

    //console.log('cql', cql, 'params', JSON.stringify(params));
    return this.executeCql(batch, consistency, function(result) {
        var rows = result.rows;
        return {
            // XXX: check if condition failed!
            status: 201
        };
    });
};


DB.prototype.delete = function (reverseDomain, req) {
    var keyspace = keyspaceName(reverseDomain, req.table);

    // consistency
    var consistency = defaultConsistency;
    if (req.consistency && req.consistency in {all:1, localQuorum:1}) {
        consistency = cass.types.consistencies[req.consistency];
    }
    return this._delete(keyspace, req, consistency);
};

DB.prototype._delete = function (keyspace, req, consistency, table) {
    if (!table) {
        table = 'data';
    }
    var cql = 'delete from '
        + cassID(keyspace) + '.' + cassID(table);

    var params = [];
    // Build up the condition
    if (req.attributes) {
        cql += ' where ';
        var condResult = buildCondition(req.attributes);
        cql += condResult.query;
        params = condResult.params;
    }

    // TODO: delete from indexes too!

    return this.client.execute_p(cql, params, {consistency: consistency, prepared:true});
};

DB.prototype._createKeyspace = function (keyspace, consistency, options) {
    var cql = 'create keyspace ' + cassID(keyspace)
        + ' WITH REPLICATION = ' + options;
    return this.client.execute_p(cql, [],  {consistency: consistency || defaultConsistency});
};

DB.prototype.createTable = function (reverseDomain, req) {
    var self = this;
    if (!req.table) {
        throw new Error('Table name required.');
    }
    var keyspace = keyspaceName(reverseDomain, req.table);

    // consistency
    var consistency = defaultConsistency;
    if (req.consistency && req.consistency in {all:1, localQuorum:1}) {
        consistency = cass.types.consistencies[req.consistency];
    }

    var infoSchema = this.infoSchema;

    if (!req.options) {
        req.options = "{ 'class': 'SimpleStrategy', 'replication_factor': 3 }";
    } else {
        req.options = "{ 'class': '"+ req.options.storageClass + "', 'replication_factor': " + req.options.durabilityLevel + "}";
    }

    return this._createKeyspace(keyspace, consistency, req.options)
    .then(function() {
        return Promise.all([
            self._createTable(keyspace, req, 'data', consistency),
            self._createTable(keyspace, infoSchema, 'meta', consistency)
        ]);
    })
    .then(function() {
        return self._put(keyspace, {
            attributes: {
                key: 'schema',
                value: JSON.stringify(req)
            }
        }, consistency, 'meta');
    });
};

DB.prototype._createTable = function (keyspace, req, tableName, consistency) {
    var self = this;

    if (!req.attributes) {
        throw new Error('No AttributeDefinitions for table!');
    }

    // Figure out which columns are supposed to be static
    var statics = {};
    if (req.index && req.index.static) {
        var s = req.index.static;
        if (Array.isArray(s)) {
            s.forEach(function(k) {
                statics[k] = true;
            });
        } else {
            statics[s] = true;
        }
    }

    var cql = 'create table '
        + cassID(keyspace) + '.' + cassID(tableName) + ' (';
    for (var attr in req.attributes) {
        var type = req.attributes[attr];
        cql += cassID(attr) + ' ';
        switch (type) {
        case 'blob': cql += 'blob'; break;
        case 'set<blob>': cql += 'set<blob>'; break;
        case 'decimal': cql += 'decimal'; break;
        case 'set<decimal>': cql += 'set<decimal>'; break;
        case 'double': cql += 'double'; break;
        case 'set<double>': cql += 'set<double>'; break;
        case 'boolean': cql += 'boolean'; break;
        case 'set<boolean>': cql += 'set<boolean>'; break;
        case 'varint': cql += 'varint'; break;
        case 'set<varint>': cql += 'set<varint>'; break;
        case 'string': cql += 'text'; break;
        case 'set<string>': cql += 'set<text>'; break;
        case 'timeuuid': cql += 'timeuuid'; break;
        case 'set<timeuuid>': cql += 'set<timeuuid>'; break;
        case 'uuid': cql += 'uuid'; break;
        case 'set<uuid>': cql += 'set<uuid>'; break;
        case 'timestamp': cql += 'timestamp'; break;
        case 'set<timestamp>': cql += 'set<timestamp>'; break;
        case 'json': cql += 'text'; break;
        case 'set<json>': cql += 'set<text>'; break;
        default: throw new Error('Invalid type ' + type
                     + ' for attribute ' + attr);
        }
        if (statics[attr]) {
            cql += ' static';
        }
        cql += ', ';
    }


    // Validate and Normalize the range index to an array
    var rangeIndex = validateSchema(req);

    cql += 'primary key (';
    var indexBits = [cassID(req.index.hash)];
    rangeIndex.forEach(function(att) {
        indexBits.push(cassID(att));
    });
    cql += indexBits.join(',') + '))';

    // Default to leveled compaction strategy
    cql += " WITH compaction = { 'class' : 'LeveledCompactionStrategy' }";

    if (req.index.order && rangeIndex.length) {
        var orders = req.index.order;
        if (!Array.isArray(orders)) {
            orders = [orders];
        }
        var orderBits = [];
        for (var i = 0; i < rangeIndex.length; i++) {
            var attName = rangeIndex[i];
            var dir = orders[i];
            if (dir) {
                if (dir.constructor !== String
                        || ! dir.toLowerCase() in {'asc':1, 'desc':1})
                {
                    throw new Error('Invalid order direction in schema:\n' + req);
                } else {
                    orderBits.push(cassID(attName) + ' ' + dir.toLowerCase());
                }
            }
        }
        if (orderBits) {
            cql += ' and clustering order by ( ' + orderBits.join(',') + ' )';
        }
    }

    // XXX: Handle secondary indexes
    var tasks = [];
    if (req.secondaryIndexes) {
        for (var indexName in req.secondaryIndexes) {
            var indexSchema = generateIndexSchema(req, indexName);
            tasks.push(this._createTable(keyspace, indexSchema, 'i_' + indexName));
        }
        tasks.push(this.client.execute_p(cql, [], {consistency: consistency}));
        return Promise.all(tasks);
    } else {
        return this.client.execute_p(cql, [], {consistency: consistency});
    }
};

DB.prototype.dropTable = function (reverseDomain, table) {
    var keyspace = keyspaceName(reverseDomain, table);
    return this.client.execute_p('drop keyspace ' + cassID(keyspace), [], {consistency: defaultConsistency});
};


module.exports = DB;
