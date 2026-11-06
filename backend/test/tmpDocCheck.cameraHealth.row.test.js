jest.mock('../src/models', () => ({ Camera: { findAll: jest.fn() }, CameraGroup: {}, Site: {} }));
jest.mock('../src/services/drishyamStreaming.service', () => ({
  api: { get: jest.fn().mockResolvedValue({ data: { items: [] } }) },
  pathName: (id) => `cam_${id}`,
}));
jest.mock('../src/services/transcoder.service',       () => ({ listActive: () => [] }));
jest.mock('../src/services/streamQuality.service',    () => ({ snapshot: () => ({}) }));
jest.mock('../src/services/streamSupervisor.service', () => ({ snapshot: () => ({ cameras: [] }) }));

const { Camera } = require('../src/models');
const { computeHealth } = require('../src/controllers/cameraHealth.controller');

test('health rows carry lastSeenAt', async () => {
  const seen = new Date('2026-08-01T10:00:00Z');
  Camera.findAll.mockResolvedValue([{ id: 'c1', monitorId: 'abc', name: 'Gate 1', status: 'online', lastSeenAt: seen }]);
  const { cameras } = await computeHealth('user-1');
  expect(cameras[0].status).toEqual('standby');
  expect(cameras[0].lastSeenAt).toEqual(seen);
});
