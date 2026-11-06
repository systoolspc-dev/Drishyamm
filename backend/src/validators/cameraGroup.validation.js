const Joi = require('joi');

// createGroup body — the full field set the controller reads (the validate
// middleware strips unknown keys, so this must be complete or a needed field
// would be dropped). `channels` is a free-form per-channel name-override map
// forwarded to device discovery, so it passes through untouched.
const createGroup = Joi.object({
  name:          Joi.string().trim().min(1).max(100).required(),
  host:          Joi.string().trim().min(1).max(255).required(),
  port:          Joi.number().integer().min(1).max(65535).default(554),
  httpPort:      Joi.number().integer().min(1).max(65535).default(80),
  username:      Joi.string().allow('').max(128).default(''),
  password:      Joi.string().allow('').max(256).default(''),
  totalChannels: Joi.number().integer().min(1).max(256).default(1),
  deviceType:    Joi.string().trim().max(40).default('hikvision'),
  location:      Joi.string().allow('', null).max(255).optional(),
  channels:      Joi.any().optional(),
});

// Bulk mutations: validate the injection-prone monitorIds array strictly; leave
// the value field to the controller's own lenient parser (Joi.any passthrough,
// so it isn't stripped and isn't over-rejected).
const bulkRetention = Joi.object({
  monitorIds:    Joi.array().items(Joi.string().max(64)).min(1).required(),
  retentionDays: Joi.any().optional(),
});

const bulkQuality = Joi.object({
  monitorIds:    Joi.array().items(Joi.string().max(64)).min(1).required(),
  streamQuality: Joi.any().optional(),
});

module.exports = { createGroup, bulkRetention, bulkQuality };
