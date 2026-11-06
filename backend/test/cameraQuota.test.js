// Mock the model boundary so the quota logic can be tested with no DB.
jest.mock('../src/models', () => ({
  Camera: { count: jest.fn() },
  Subscription: { findOne: jest.fn() },
  Plan: {},
  // Owner resolution (entitlements.service): user-1 is an account owner with no sub-users.
  User: { findByPk: jest.fn(async (id) => ({ id, parentUserId: null })), findAll: jest.fn(async () => []) },
}));

const models = require('../src/models');
const { assertCameraQuota } = require('../src/services/cameraQuota.service');

describe('assertCameraQuota — enforcement (default: enabled, free tier unlimited)', () => {
  test('no subscription + no free-tier cap → unlimited (never throws)', async () => {
    models.Subscription.findOne.mockResolvedValue(null);
    models.Camera.count.mockResolvedValue(500);
    await expect(assertCameraQuota('user-1', 1)).resolves.toBeUndefined();
  });

  test('a plan with null maxCameras is an unlimited plan (no throw)', async () => {
    models.Subscription.findOne.mockResolvedValue({ plan: { maxCameras: null, name: 'Enterprise' } });
    models.Camera.count.mockResolvedValue(500);
    await expect(assertCameraQuota('user-1', 10)).resolves.toBeUndefined();
  });

  test('a per-account camera licence overrides the plan (admin console)', async () => {
    models.Subscription.findOne.mockResolvedValue({ cameraLimit: 3, plan: { maxCameras: 64, name: 'Enterprise' } });
    models.Camera.count.mockResolvedValue(3);
    await expect(assertCameraQuota('user-1', 1)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('a per-account licence of 0 means no cameras, not unlimited', async () => {
    models.Subscription.findOne.mockResolvedValue({ cameraLimit: 0, plan: { maxCameras: 8, name: 'AI+VMS' } });
    models.Camera.count.mockResolvedValue(0);
    await expect(assertCameraQuota('user-1', 1)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('a sub-user spends the account owner licence', async () => {
    models.User.findByPk.mockResolvedValueOnce({ id: 'sub-1', parentUserId: 'owner-1' });
    models.Subscription.findOne.mockResolvedValue({ cameraLimit: 2, plan: { maxCameras: 8, name: 'AI+VMS' } });
    models.Camera.count.mockResolvedValue(2);
    await expect(assertCameraQuota('sub-1', 1)).rejects.toMatchObject({ statusCode: 403 });
    expect(models.Subscription.findOne.mock.calls.at(-1)[0].where.userId).toBe('owner-1');
  });

  test('adding within the plan limit is allowed', async () => {
    models.Subscription.findOne.mockResolvedValue({ plan: { maxCameras: 10, name: 'Pro' } });
    models.Camera.count.mockResolvedValue(3);
    await expect(assertCameraQuota('user-1', 2)).resolves.toBeUndefined(); // 3 + 2 <= 10
  });

  test('adding exactly to the limit is allowed', async () => {
    models.Subscription.findOne.mockResolvedValue({ plan: { maxCameras: 10, name: 'Pro' } });
    models.Camera.count.mockResolvedValue(8);
    await expect(assertCameraQuota('user-1', 2)).resolves.toBeUndefined(); // 8 + 2 == 10
  });

  test('exceeding the limit throws a 403 with a helpful message', async () => {
    models.Subscription.findOne.mockResolvedValue({ plan: { maxCameras: 5, name: 'Starter' } });
    models.Camera.count.mockResolvedValue(5);
    await expect(assertCameraQuota('user-1', 1)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('a batch that would overflow the limit is rejected', async () => {
    models.Subscription.findOne.mockResolvedValue({ plan: { maxCameras: 10, name: 'Pro' } });
    models.Camera.count.mockResolvedValue(8);
    await expect(assertCameraQuota('user-1', 5)).rejects.toMatchObject({ statusCode: 403 }); // 8 + 5 > 10
  });
});

describe('assertCameraQuota — disabled via ENFORCE_CAMERA_LIMITS=false', () => {
  test('is a no-op regardless of counts', async () => {
    process.env.ENFORCE_CAMERA_LIMITS = 'false';
    jest.resetModules();
    jest.doMock('../src/models', () => ({
      Camera: { count: jest.fn() },
      Subscription: { findOne: jest.fn() },
      Plan: {},
      User: { findByPk: jest.fn(async (id) => ({ id, parentUserId: null })), findAll: jest.fn(async () => []) },
    }));
    const { assertCameraQuota: fn } = require('../src/services/cameraQuota.service');
    await expect(fn('user-1', 9999)).resolves.toBeUndefined();
    delete process.env.ENFORCE_CAMERA_LIMITS;
    jest.resetModules();
  });
});
