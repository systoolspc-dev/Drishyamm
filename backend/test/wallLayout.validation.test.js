const { layout } = require('../src/validators/wallLayout.validation');

// A page of `n` slots with the given cameras at the front, the rest empty.
const page = (n, cams = []) => Array.from({ length: n }, (_, i) => cams[i] ?? null);

describe('wall layout schema', () => {
  test('accepts a two-page 4 × 4 layout and applies the wall defaults', () => {
    const { error, value } = layout.validate({
      name: 'Office — Default', cols: 4, rows: 4,
      pages: [page(16, ['cam-a', 'cam-b']), page(16, ['cam-c'])],
    });
    expect(error).toBeUndefined();
    expect(value.rotate).toBe(true);
    expect(value.rotateSeconds).toBe(30);
    expect(value.skipOffline).toBe(false);
    expect(value.focusAudio).toBe(true);
  });

  test('rejects a page whose slot count does not match the grid', () => {
    const { error } = layout.validate({ name: 'x', cols: 3, rows: 3, pages: [page(16)] });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/exactly 9 slots/);
  });

  test('rejects the same camera in two slots', () => {
    const { error } = layout.validate({ name: 'x', cols: 2, rows: 2, pages: [page(4, ['a']), page(4, ['a'])] });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/only appear once/);
  });

  test('rejects grids past 6 × 6 and rotation intervals the page does not offer', () => {
    expect(layout.validate({ name: 'x', cols: 7, rows: 7, pages: [page(49)] }).error).toBeDefined();
    expect(layout.validate({ name: 'x', cols: 2, rows: 2, pages: [page(4)], rotateSeconds: 5 }).error).toBeDefined();
  });

  test('rejects a missing name and an empty page list', () => {
    expect(layout.validate({ cols: 2, rows: 2, pages: [page(4)] }).error).toBeDefined();
    expect(layout.validate({ name: '  ', cols: 2, rows: 2, pages: [page(4)] }).error).toBeDefined();
    expect(layout.validate({ name: 'x', cols: 2, rows: 2, pages: [] }).error).toBeDefined();
  });

  test('allows an entirely empty page, so a new page can be saved before it is filled', () => {
    expect(layout.validate({ name: 'x', cols: 2, rows: 2, pages: [page(4, ['a']), page(4)] }).error).toBeUndefined();
  });
});
