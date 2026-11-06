const Joi = require('joi');

const addCamera = Joi.object({
  groupKey: Joi.string().required(),
  mid: Joi.string().max(24).required(),
  name: Joi.string().trim().max(100).required(),
  type: Joi.string().valid('h264', 'h265', 'mjpeg').default('h264'),
  protocol: Joi.string().valid('rtsp', 'http', 'onvif').default('rtsp'),
  host: Joi.string().required(),
  port: Joi.string().default('554'),
  path: Joi.string().allow('').default(''),
  username: Joi.string().allow('').default(''),
  password: Joi.string().allow('').default(''),
  width: Joi.string().default('1920'),
  height: Joi.string().default('1080'),
  fps: Joi.string().default('30'),
});

const updateCamera = Joi.object({
  groupKey: Joi.string().required(),
  name: Joi.string().trim().max(100),
  type: Joi.string().valid('h264', 'h265', 'mjpeg'),
  protocol: Joi.string().valid('rtsp', 'http', 'onvif'),
  host: Joi.string(),
  port: Joi.string(),
  path: Joi.string().allow(''),
  username: Joi.string().allow(''),
  password: Joi.string().allow(''),
  width: Joi.string(),
  height: Joi.string(),
  fps: Joi.string(),
});

const getRecordings = Joi.object({
  groupKey: Joi.string().required(),
  start: Joi.string().required(),
  end: Joi.string().required(),
});

module.exports = { addCamera, updateCamera, getRecordings };
