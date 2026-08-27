'use strict';

function valueType(value) {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    if (typeof value === 'number' && value % 1 === 0) {
        return 'integer';
    }
    return typeof value;
}

function matchesType(value, expectedType) {
    var actualType = valueType(value);
    if (expectedType === 'number') {
        return actualType === 'number' || actualType === 'integer';
    }
    if (expectedType === 'object') {
        return actualType === 'object';
    }
    return actualType === expectedType;
}

function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function decodePointerToken(value) {
    return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveReference(reference, context) {
    var parts = reference.split('#');
    var schema = parts[0] ? context.schemas[parts[0]] : context.rootSchema;
    var rootSchema = schema;
    var pointer = parts[1] || '';
    if (!schema) {
        return null;
    }
    if (pointer && pointer.charAt(0) !== '/') {
        return null;
    }
    pointer.split('/').slice(1).forEach(function (token) {
        if (schema && typeof schema === 'object') {
            schema = schema[decodePointerToken(token)];
        } else {
            schema = null;
        }
    });
    if (!schema) {
        return null;
    }
    return { rootSchema: rootSchema, schema: schema };
}

function validateNode(schema, value, location, errors, context) {
    var allowedKeys;
    var expectedTypes;
    var referencedSchema;
    if (!schema || typeof schema !== 'object') {
        return;
    }
    if (schema.$ref) {
        referencedSchema = resolveReference(schema.$ref, context);
        if (!referencedSchema) {
            errors.push(location + ' uses unresolved schema reference ' + schema.$ref);
            return;
        }
        validateNode(referencedSchema.schema, value, location, errors,
            { rootSchema: referencedSchema.rootSchema, schemas: context.schemas });
        return;
    }
    if (schema.hasOwnProperty('const') && !sameValue(value, schema.const)) {
        errors.push(location + ' must equal ' + JSON.stringify(schema.const));
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(function (candidate) {
        return sameValue(value, candidate);
    })) {
        errors.push(location + ' must be one of ' + JSON.stringify(schema.enum));
    }
    if (schema.type) {
        expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!expectedTypes.some(function (expectedType) { return matchesType(value, expectedType); })) {
            errors.push(location + ' must have type ' + expectedTypes.join('|') + ', got ' + valueType(value));
            return;
        }
    }
    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            errors.push(location + ' must have at least ' + schema.minLength + ' characters');
        }
        if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) {
            errors.push(location + ' must match ' + schema.pattern);
        }
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
            errors.push(location + ' must have at most ' + schema.maxLength + ' characters');
        }
    }
    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) {
            errors.push(location + ' must be at least ' + schema.minimum);
        }
        if (typeof schema.maximum === 'number' && value > schema.maximum) {
            errors.push(location + ' must be at most ' + schema.maximum);
        }
    }
    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            errors.push(location + ' must have at least ' + schema.minItems + ' items');
        }
        if (schema.items) {
            value.forEach(function (item, index) {
                validateNode(schema.items, item, location + '[' + index + ']', errors, context);
            });
        }
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
            errors.push(location + ' must have at most ' + schema.maxItems + ' items');
        }
        if (schema.uniqueItems === true && value.some(function (item, index) {
            return value.slice(0, index).some(function (candidate) { return sameValue(item, candidate); });
        })) {
            errors.push(location + ' must contain unique items');
        }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        (schema.required || []).forEach(function (key) {
            if (!value.hasOwnProperty(key)) {
                errors.push(location + ' is missing required property ' + key);
            }
        });
        allowedKeys = schema.properties || {};
        Object.keys(value).forEach(function (key) {
            if (allowedKeys[key]) {
                validateNode(allowedKeys[key], value[key], location + '.' + key, errors, context);
            } else if (schema.additionalProperties === false) {
                errors.push(location + ' has unsupported property ' + key);
            }
        });
    }
}

/**
 * 校验当前 Program 契约所使用的 JSON Schema 子集。
 * @param {Object} schema - JSON Schema。
 * @param {*} value - 待校验值。
 * @param {Object} referencedSchemas - 以文件名或 schema ID 索引的外部 schema。
 * @returns {string[]} 稳定排序的错误列表。
 */
function validate(schema, value, referencedSchemas) {
    var errors = [];
    var schemas = referencedSchemas || {};
    if (schema.$id) {
        schemas[schema.$id] = schema;
    }
    validateNode(schema, value, '$', errors, { rootSchema: schema, schemas: schemas });
    return errors.sort();
}

module.exports = {
    validate: validate
};
