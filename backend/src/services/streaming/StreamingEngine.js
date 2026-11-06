/**
 * StreamingEngine — the abstract contract every streaming engine must satisfy.
 *
 * The backend depends ONLY on this surface (via the drishyamStreaming.service
 * singleton), never on a concrete engine's REST/wire shape. To add a new engine
 * (a native/C++ core, GStreamer, a different SFU/muxer), extend this class,
 * implement every method, and register it in ./index.js so STREAMING_ENGINE can
 * select it.
 *
 * Grouping of the surface:
 *   Identity     : engineName, engineInfo()
 *   Naming       : pathName, subPathName, monitorIdFromPath
 *   Deriving     : buildRtspUrl, deriveSubPath
 *   Path CRUD    : addCamera, removeCamera, addCameraSubStream,
 *                  removeCameraSubStream, deletePathByName
 *   Runtime read : getPath, isReady, listPaths, listConfiguredPaths
 *   Egress URLs  : getWebrtcUrl, getHlsUrl, getHlsSubUrl, getRtspEgressUrl
 *
 * Behavioural contract (engines MUST honour so callers can stay engine-agnostic):
 *   - addCamera:            idempotent; throws AppError(502) on hard failure.
 *   - addCameraSubStream:   best-effort; never throws (a missing sub only
 *                           degrades grid quality).
 *   - removeCamera / removeCameraSubStream / deletePathByName:
 *                           return true when the path is GONE (removed now or
 *                           already absent), false only when every attempt
 *                           failed. Never throw.
 *   - getPath / listPaths / listConfiguredPaths:
 *                           return null / [] when the engine is unreachable
 *                           (callers degrade gracefully — no throw).
 */
class StreamingEngine {
  get engineName() { return 'abstract'; }

  // eslint-disable-next-line class-methods-use-this
  _nyi(method) {
    throw new Error(`StreamingEngine.${method}() not implemented by ${this.constructor.name}`);
  }

  engineInfo()                      { return this._nyi('engineInfo'); }

  pathName()                        { return this._nyi('pathName'); }
  subPathName()                     { return this._nyi('subPathName'); }
  monitorIdFromPath()               { return this._nyi('monitorIdFromPath'); }

  buildRtspUrl()                    { return this._nyi('buildRtspUrl'); }
  deriveSubPath()                   { return this._nyi('deriveSubPath'); }

  async addCamera()                 { return this._nyi('addCamera'); }
  async removeCamera()              { return this._nyi('removeCamera'); }
  async addCameraSubStream()        { return this._nyi('addCameraSubStream'); }
  async removeCameraSubStream()     { return this._nyi('removeCameraSubStream'); }
  async deletePathByName()          { return this._nyi('deletePathByName'); }

  async getPath()                   { return this._nyi('getPath'); }
  async isReady()                   { return this._nyi('isReady'); }
  async listPaths()                 { return this._nyi('listPaths'); }
  async listConfiguredPaths()       { return this._nyi('listConfiguredPaths'); }

  getWebrtcUrl()                    { return this._nyi('getWebrtcUrl'); }
  getHlsUrl()                       { return this._nyi('getHlsUrl'); }
  getHlsSubUrl()                    { return this._nyi('getHlsSubUrl'); }
  getRtspEgressUrl()                { return this._nyi('getRtspEgressUrl'); }
}

module.exports = StreamingEngine;
