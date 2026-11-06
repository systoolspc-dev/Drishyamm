const Joi = require('joi');
const validate = require('../src/middleware/validate');

describe('validate middleware', () => {
  test('plain schema: a valid body passes and unknown keys are stripped', () => {
    const schema = Joi.object({ name: Joi.string().required() });
    const req = { body: { name: 'x', injected: 'evil' } };
    const next = jest.fn();
    validate(schema)(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body).toEqual({ name: 'x' }); // 'injected' stripped
  });

  test('plain schema: an invalid body throws 400 with all messages', () => {
    const schema = Joi.object({ name: Joi.string().required(), age: Joi.number().required() });
    let err;
    try { validate(schema)({ body: {} }, {}, jest.fn()); } catch (e) { err = e; }
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/name/);
    expect(err.message).toMatch(/age/); // abortEarly:false → both reported
  });

  test('object schema: validates + coerces query params', () => {
    const schema = { query: Joi.object({ page: Joi.number().integer() }) };
    const req = { query: { page: '2' }, body: {}, params: {} };
    const next = jest.fn();
    validate(schema)(req, {}, next);
    expect(req.query.page).toBe(2); // string → number
    expect(next).toHaveBeenCalled();
  });

  test('object schema: a bad param throws 400', () => {
    const schema = { params: Joi.object({ id: Joi.string().uuid().required() }) };
    let err;
    try { validate(schema)({ params: { id: 'not-a-uuid' }, body: {}, query: {} }, {}, jest.fn()); }
    catch (e) { err = e; }
    expect(err.statusCode).toBe(400);
  });
});
