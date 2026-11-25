// Run one Express middleware (sync or asyncHandler-wrapped) and report how it
// ended: `passed` is true only when next() was called with NO error, i.e. the
// request would reach the route handler. A thrown error and next(err) both
// count as a deny and come back as `err`.
function runMw(mw, req, res = {}) {
  return new Promise((resolve) => {
    const calls = [];
    const next = (err) => {
      calls.push(err);
      // give a sync middleware the chance to call next twice before resolving
      setImmediate(() => resolve({ passed: calls.length === 1 && !calls[0], err: calls[0], calls, req }));
    };
    try {
      mw(req, res, next);
    } catch (e) {
      resolve({ passed: false, err: e, calls, req, thrown: true });
    }
  });
}

module.exports = { runMw };
