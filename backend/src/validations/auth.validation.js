const Joi = require('joi');

const register = Joi.object({
  name: Joi.string().trim().min(2).max(100).required()
    .messages({ 'string.min': 'Name must be at least 2 characters' }),
  email: Joi.string().email().lowercase().trim().required(),
  password: Joi.string().min(8).max(128).required()
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .messages({
      'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      'string.min': 'Password must be at least 8 characters',
    }),
  // Trial tier: 'basic_vms' (video only) or 'ai_vms' (adds AI). Optional —
  // the controller defaults to basic_vms. Any other value is rejected here.
  tier: Joi.string().valid('basic_vms', 'ai_vms').optional(),
});

const login = Joi.object({
  // Accepts an email OR a username (RBAC sub-users log in by username).
  email: Joi.string().trim().required(),
  password: Joi.string().required(),
});

const refreshToken = Joi.object({
  refreshToken: Joi.string().required(),
});

const forgotPassword = Joi.object({
  email: Joi.string().email().lowercase().trim().required(),
});

const resetPassword = Joi.object({
  token: Joi.string().required(),
  password: Joi.string().min(8).max(128).required()
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .messages({
      'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      'string.min': 'Password must be at least 8 characters',
    }),
});

const updateProfile = Joi.object({
  name: Joi.string().trim().min(2).max(100).optional()
    .messages({ 'string.min': 'Name must be at least 2 characters' }),
  email: Joi.string().email().lowercase().trim().optional(),
}).min(1).messages({ 'object.min': 'At least one field must be provided' });

const changePassword = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).max(128).required()
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .messages({
      'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      'string.min': 'Password must be at least 8 characters',
    }),
});

module.exports = { register, login, refreshToken, forgotPassword, resetPassword, updateProfile, changePassword };
