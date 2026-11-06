# drisyam — backend service template

If you're an intern adding a new Node service to drisyam, **read this first**, then look at [smart-cam-backend](../smart-cam-backend) as the worked example. Every Node service in this repo follows the same shape so you can move between them without re-learning anything.

You should be able to scaffold a new service in ~30 minutes after reading this doc once.

---

## TL;DR — the rules

1. **One service = one folder at the repo root** (`my-service/`), built and run from its own Dockerfile, wired into the root `docker-compose.yml`.
2. **Organise `src/` by file type** (routes / controllers / services / models / middleware / validations / utils / config), not by feature.
3. **Routes are thin. Controllers are thin. Services do the work.** No `axios.post()` in a controller. No SQL in a route.
4. **Every async controller goes through `asyncHandler`.** No naked `async (req, res) => {}` in routes.
5. **Errors are thrown, not returned.** `throw new AppError('message', statusCode)`. The global `errorHandler` middleware converts them.
6. **`req.user.id` is the multi-tenancy key.** Never trust `req.body.userId` / query params for tenant scope.
7. **Internal service-to-service calls use `X-Service-Token`**, not JWT. Mount them under `/api/internal/*`.
8. **Config goes through `src/config/env.js`.** No `process.env.FOO` scattered through services — central, validated, with defaults.
9. **Comments explain WHY, not WHAT.** Names should already say what; comment when there's a hidden constraint or surprise.

---

## Folder layout — copy this verbatim

```
my-service/
├── Dockerfile
├── docker-entrypoint.sh        # optional — if you have multiple roles (api + worker)
├── .env.example                # every var you read, with sample values + comments
├── .gitignore
├── .dockerignore
├── .sequelizerc                # if you use Sequelize
├── package.json
├── package-lock.json
├── docs/
│   ├── ONBOARDING.md           # 30-min intern ramp
│   ├── ARCHITECTURE.md         # why each piece exists
│   ├── FEATURES.md             # what each feature does (per-endpoint reference)
│   └── TROUBLESHOOTING.md      # common failures and fixes
├── migrations/                 # immutable Sequelize migrations
├── seeders/                    # idempotent demo / dev data
├── sql/                        # one-shot SQL (bootstrap, fix, schema reference)
├── scripts/                    # operational scripts, run from the host
│   ├── create-admin.js
│   ├── dev-probes/             # throwaway dev probes
│   └── legacy-*/               # archived scripts from removed dependencies
└── src/
    ├── server.js               # boot file — connect deps, start http.listen
    ├── app.js                  # express() construction + middleware order
    ├── config/                 # env.js + per-dep adapters (database.js, redis.js, logger.js)
    ├── routes/                 # one .routes.js per domain, wired in routes/index.js
    ├── controllers/            # one .controller.js per domain
    ├── services/               # business logic; this is where the work happens
    ├── models/                 # Sequelize models, autoloaded by models/index.js
    ├── middleware/             # authenticate, authorize, asyncHandler, errorHandler, etc.
    ├── validations/            # joi schemas per domain
    ├── events/                 # in-process EventEmitter + EVENTS enum (if you emit events)
    ├── queues/                 # BullMQ definitions + workers (if you have async jobs)
    ├── scripts/                # IN-PROCESS scripts that need to import from src/
    └── utils/                  # AppError, asyncHandler, constants, helpers
```

`tests/` goes at the top level alongside `src/` once you have tests. Don't worry about it on day one.

---

## File naming — non-negotiable

| What | Filename | Inside |
|---|---|---|
| Router for `/api/widgets/*` | `routes/widgets.routes.js` | `const router = Router(); router.use(authenticate); router.get(...); module.exports = router;` |
| Controller for the same | `controllers/widgets.controller.js` | functions wrapped in `asyncHandler`, exported as `module.exports = { listWidgets, createWidget, ... }` |
| Service for the same | `services/widgets.service.js` | the actual logic (DB queries, axios calls). Stateless functions or a class. |
| Model | `models/Widget.js` (PascalCase, no suffix) | Sequelize `define` or `Model` subclass; `static associate(models) { ... }` |
| Validation | `validations/widgets.validation.js` | Joi schemas: `module.exports = { create: Joi.object({...}), update: Joi.object({...}) }` |
| Middleware | `middleware/<verb>.js` | `module.exports = (req, res, next) => { ... }` |

**File-name = noun, plural** (`widgets.routes.js`, not `widget.routes.js`). Plural matches the URL.

---

## The minimum a new service has to do — checklist

Boot a fresh service from this template and verify each item before you push:

- [ ] `Dockerfile` builds clean (`docker build .`)
- [ ] `docker compose up -d <service>` starts and `curl :PORT/health` returns 200
- [ ] `.env.example` lists every variable the service reads, each with a comment
- [ ] Has `migrations/` + `seeders/` if it touches a DB, even if empty
- [ ] `routes/index.js` mounts every sub-router; nothing else mounts in `app.js`
- [ ] Every controller function is wrapped in `asyncHandler`
- [ ] Every external HTTP call lives in `services/`, not `controllers/`
- [ ] Auth middleware applied to the router: `router.use(authenticate)` or `router.use(serviceAuth)`
- [ ] No `process.env.X` outside `src/config/env.js`
- [ ] No `console.log` — use the configured logger
- [ ] `docs/ONBOARDING.md` updated so the next intern can ramp without you
- [ ] Added the service to the root `README.md` service table
- [ ] Added an entry to root `docker-compose.yml`
- [ ] If proxied through smart-cam-backend, added a route at `smart-cam-backend/src/routes/<service>.routes.js`

---

## Walking example — adding the `widgets` domain

You want to ship `GET /api/widgets` (list) + `POST /api/widgets` (create). Touch exactly five files:

### 1. `src/validations/widgets.validation.js`

```js
const Joi = require('joi');

module.exports = {
  create: Joi.object({
    name: Joi.string().min(1).max(200).required(),
    color: Joi.string().valid('red', 'blue', 'green').default('red'),
  }),
};
```

### 2. `src/services/widgets.service.js`

```js
const { Widget } = require('../models');
const AppError = require('../utils/AppError');

// List widgets owned by a user. Tenant filter is non-negotiable.
async function listForUser(userId) {
  return Widget.findAll({ where: { userId }, order: [['createdAt', 'DESC']] });
}

// Create a widget. Throws AppError(409) on duplicate name within a user.
async function create(userId, { name, color }) {
  const dup = await Widget.findOne({ where: { userId, name } });
  if (dup) throw new AppError(`widget "${name}" already exists`, 409);
  return Widget.create({ userId, name, color });
}

module.exports = { listForUser, create };
```

### 3. `src/controllers/widgets.controller.js`

```js
const asyncHandler = require('../middleware/asyncHandler');
const validate = require('../middleware/validate');
const widgetsService = require('../services/widgets.service');
const { create: createSchema } = require('../validations/widgets.validation');

const listWidgets = asyncHandler(async (req, res) => {
  const widgets = await widgetsService.listForUser(req.user.id);
  res.json({ success: true, data: widgets });
});

const createWidget = [
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const widget = await widgetsService.create(req.user.id, req.body);
    res.status(201).json({ success: true, data: widget });
  }),
];

module.exports = { listWidgets, createWidget };
```

### 4. `src/routes/widgets.routes.js`

```js
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const widgets = require('../controllers/widgets.controller');

const router = Router();
router.use(authenticate);

router.get ('/', widgets.listWidgets);
router.post('/', widgets.createWidget);

module.exports = router;
```

### 5. `src/routes/index.js` — add one line

```js
const widgetsRoutes = require('./widgets.routes');
// ...
router.use('/widgets', widgetsRoutes);
```

That's it. `GET /api/widgets` and `POST /api/widgets` now exist, authenticated, scoped to the JWT user, with validation, with proper errors.

Pattern check:
- Route is 12 lines
- Controller is 14 lines
- Service is 12 lines

If any of these are over 100 lines, you're doing too much in one place — split. The biggest controller in smart-cam-backend (`ai.controller.js`, 1,200 lines) is the **anti-pattern**, not a target.

---

## Models — the rules

```js
// src/models/Widget.js
const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Widget extends Model {
    static associate(models) {
      Widget.belongsTo(models.User, { foreignKey: 'userId' });
    }
  }
  Widget.init({
    id:   { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    name:  DataTypes.STRING(200),
    color: DataTypes.STRING(20),
  }, { sequelize, modelName: 'Widget', tableName: 'widgets', underscored: true });
  return Widget;
};
```

- PascalCase model name, snake_case table, plural.
- Every association in the `static associate(models)` method.
- Every multi-tenant table has `userId` (or `tenantId`) as a FK + index — multi-tenancy is enforced by the query filter, never trusted from the request body.
- Migrations are immutable once merged. Changing schema = new migration file. Never edit an old one.

`src/models/index.js` autoloads everything in the folder, calls `init`, then runs `associate` on each. Don't manually `require` a model — let the autoloader find it.

---

## Errors — the rules

```js
// src/utils/AppError.js
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}
module.exports = AppError;
```

Throw it from any service or controller:

```js
if (!widget) throw new AppError('widget not found', 404);
if (widget.userId !== req.user.id) throw new AppError('forbidden', 403);
```

The global `errorHandler` middleware (last in `app.js`) converts to JSON:

```json
{ "success": false, "message": "widget not found" }
```

Never `res.status(400).send('bad')` directly from a controller — that bypasses logging + format consistency.

---

## Auth — the two patterns

### Operator routes (everything the SPA hits)

```js
const authenticate = require('../middleware/authenticate');
router.use(authenticate);   // attaches req.user = { id, email, role }
```

Then `req.user.id` everywhere. **Never** look at `req.body.userId` for tenant scope. The JWT is the truth.

If a route is admin-only:

```js
const authorize = require('../middleware/authorize');
router.delete('/:id', authorize('admin'), widgets.deleteWidget);
```

### Internal service-to-service routes

When another drisyam service needs to call you:

```js
const serviceAuth = require('../middleware/serviceAuth');
router.use(serviceAuth);    // verifies X-Service-Token header
```

These live under `/api/internal/*` and are NEVER exposed through the public reverse proxy. Constant-time comparison against `SERVICE_TOKEN` env. Example: smart-cam-ai posts AIEvent rows to `/api/internal/ai/events` with `X-Service-Token: ${SERVICE_TOKEN}`.

---

## Proxy pattern — when your service forwards to another

`smart-cam-backend` proxies to `smart-cam-ai`, `face-reconstruct`, `person-tracker`. The pattern is consistent — use it.

```js
// services/<upstream>.service.js
const axios = require('axios');
const config = require('../config/env');

const client = axios.create({
  baseURL: config.upstreamUrl,
  timeout: 10_000,
  headers: { 'X-Service-Token': config.upstreamToken },
});

async function search(payload) {
  try {
    const { data } = await client.post('/api/search', payload);
    return data;
  } catch (err) {
    const status = err.response?.status || 502;
    const detail = err.response?.data?.detail || err.message;
    throw new AppError(`upstream search failed: ${detail}`, status);
  }
}

module.exports = { search };
```

Then in the controller, just call `await search(req.body)` and return whatever it returned. Don't double-wrap responses unless you're changing shape.

For binary downloads (mp4, pdf), return a `302` to a presigned URL instead of streaming bytes through your service. Example: [smart-cam-backend/src/controllers/personTracker.controller.js](../backend/src/controllers/personTracker.controller.js) `downloadVideo` — it asks upstream with `maxRedirects: 0`, captures the `Location` header, and relays the redirect. The browser then streams from the binary store directly.

---

## Hard rules — don't break these

These come from real bugs that bit us. Each one is one line; the WHY is in comments.

1. **No `console.log` in service code.** Use the configured logger. (`console.log` doesn't get structured logging or remote shipping.)
2. **`req.user.id`, never `req.body.userId`.** Auth scope is the JWT.
3. **S3/MinIO keys are namespaced by `userId`.** Multi-tenancy via key prefix.
4. **No `axios` in controllers.** All HTTP clients in services.
5. **No `Sequelize.literal` unless you've justified it in a comment.** Most cases it's a `where:` clause done wrong.
6. **No SQL in routes.** No exceptions.
7. **No `process.env.X` outside `src/config/env.js`.** Central + validated + documented.
8. **No `--no-verify`, `--no-gpg-sign`, `--force` push.** Ever, unless an incident response says otherwise.
9. **No dev probes at the repo root.** Move to `scripts/dev-probes/`. `.gitignore` should block the root patterns.
10. **Service-token routes are NOT publicly mounted.** Always `/api/internal/*` behind `serviceAuth`.

---

## When to break the rules

Almost never. The rules above are the result of fixing the same bug enough times to write it down. If you think your case needs an exception:

- Write a one-line comment in the code explaining the specific reason
- Prefer to write a service-level helper that follows the rules over scattering exceptions
- If you're about to add the third exception of the same kind, the rule is probably wrong — propose a doc change instead of more exceptions

---

## Reference reading

After this doc, read these in order:

- [smart-cam-backend/docs/ONBOARDING.md](../backend/docs/ONBOARDING.md) — the worked example, intern view
- [smart-cam-backend/docs/ARCHITECTURE.md](../backend/docs/ARCHITECTURE.md) — request lifecycle, auth, S3, MediaMTX integration, WebSocket, queues, error handling, hard rules
- [smart-cam-backend/docs/FEATURES.md](../backend/docs/FEATURES.md) — per-feature documentation pattern you should match
- [smart-cam-backend/docs/TROUBLESHOOTING.md](../backend/docs/TROUBLESHOOTING.md) — symptom → cause → fix format you should match

If you find yourself diverging from any of those patterns, ask before you ship.
