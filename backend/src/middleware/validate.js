const AppError = require('../utils/AppError');

/**
 * Joi validation middleware factory.
 * @param {Object} schema - Joi schema object with optional body, query, params keys
 *                          OR a single Joi schema (applied to req.body)
 */
const validate = (schema) => {
  return (req, res, next) => {
    // If schema is a plain Joi schema (not an object with body/query/params)
    if (schema.validate) {
      const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (error) {
        const message = error.details.map((d) => d.message).join(', ');
        throw new AppError(message, 400);
      }

      req.body = value;
      return next();
    }

    // Schema is an object with body, query, params keys
    const sources = ['body', 'query', 'params'];
    for (const source of sources) {
      if (schema[source]) {
        const { error, value } = schema[source].validate(req[source], {
          abortEarly: false,
          stripUnknown: true,
        });

        if (error) {
          const message = error.details.map((d) => d.message).join(', ');
          throw new AppError(message, 400);
        }

        req[source] = value;
      }
    }

    next();
  };
};

module.exports = validate;
