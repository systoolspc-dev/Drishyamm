# AI licence enforcement — plan for review

**Status:** proposal, not built · **Date:** 15 October 2026 · **Owner:** Anil

## The rule we sell

**1 licence = 1 AI model on 1 camera.** Head count on 10 cameras is 10 Head count licences. Licences are a pool per account (site): the customer chooses which cameras use them and can move them any time. A pack (Counting, Door, Gate, Safety, Everything) is several models on the *same* camera and uses one pack licence per camera. This is what drishyam.io, the price lists (DRS/PL/2026-03, -04) and the licence calculator now say.

## What the product does today

| Area | Today | Where |
|---|---|---|
| AI on/off | One switch per account: plan `ai_enabled` true/false | `smart-cam-backend/src/services/entitlements.service.js:17-60` |
| Which features | `subscriptions.features` JSON list, **not enforced on the backend** (only hides navigation); null or empty = all features | `migrations/028`, `src/core/nav/entitlements.js:28-44` |
| Per-camera AI | `cameras.settings.headcount.enabled`, `cameras.settings.ai.*`; anyone on an AI plan can switch any feature on for **any number of cameras** | `ai.controller.js:1211-1368` |
| Licence counts | `license_features.config_json.cameras` exists, but is a **billing record only**; admin UI says "runtime enforcement in Phase D" | `license.controller.js:295-304`, `LicenseDetail.jsx:322` |
| Camera limit | Only total cameras per plan (`plan.maxCameras`) | `cameraQuota.service.js:29-63` |
| Licence key / activation | None (`licenses.license_key` is a placeholder) | `migrations/018` |

So a customer who buys one Head count licence can switch head count on for all 100 cameras today.

## Proposal

### Phase 1 — per-feature quotas, enforced (≈ 1 week)

1. **Data:** add `subscriptions.feature_quotas` JSON, e.g. `{"head_count": 10, "face": 4, "restricted_zone": 6}`. `null` = legacy behaviour (unlimited) so nothing breaks on deploy.
2. **One key list** shared by billing, website and runtime. Map the 12 sold features to the settings each one switches on (e.g. `head_count` → `settings.headcount.enabled`, `face` → face/watchlist in `settings.ai`, `restricted_zone` → zone-guard config). Features with no runtime switch yet are listed as such, not silently allowed.
3. **Usage = count of cameras with the feature on**, computed from `cameras.settings` per account (one query, cached per request).
4. **Enforce at every "turn on" endpoint:** `PUT /api/ai/cameras/:id/headcount`, `PATCH /api/ai/cameras/:id/lifecycle`, `POST /api/ai/person-tracker-cameras`, and the zone/face equivalents. Turning a feature **on** for a camera when `used >= quota` returns `403 { code: "LICENCE_LIMIT", feature, used, quota }`. Turning **off** is always allowed (frees a licence).
5. **Frontend:** camera AI settings show "Head count: 7 of 10 licences in use"; the 403 shows a toast: *"All 10 Head count licences are in use. Turn it off on another camera, or add licences."*
6. **Admin:** platform admin sets `feature_quotas` per customer from the licence screen (today `subscriptions.features` has no UI at all and is set in the database).
7. **Existing customers:** a migration sets each account's quota to its *current* usage, so nobody loses a camera on deploy.

### Phase 2 — packs and per-camera assignment (≈ 1 week)

Counting quotas per feature can't express packs ("Counting pack on 6 cameras" = head + zone + crowd on the *same* 6 cameras). Add `camera_licences(camera_id, licence_key)`: a camera holds a feature licence or a pack licence, and a feature may only be switched on if the camera holds a licence that covers it. Moving a licence = reassigning the row. The camera settings screen gets a "Licences on this camera" picker.

### Phase 3 — licence keys for on-site installs (≈ 1–2 weeks)

A licence file signed with Drishyam's private key (JWT): account, camera limit, feature quotas, expiry, maintenance end date. The on-site server verifies it offline with the public key; activation needs internet once. Expired monthly licence → AI stops, recording keeps running. Lapsed perpetual maintenance → keeps running on the current version.

### Downgrades and expiry

Never switch a customer's AI off silently. If usage is above quota (downgrade, expiry), mark the extra cameras "over licence", alert the account admin, and give a 7-day grace period before the reconcile loop (`aiLifecycle.service.js:46-61`) stops AI on the most recently enabled cameras.

## Decisions needed from Anil

1. Grace period length on downgrade (proposal: 7 days).
2. Trial: all features on all cameras for 14 days, then quotas apply? (Matches the website's "see it on your feed" offer.)
3. Attendance: its own licence (as priced) or free with every Face licence?
4. Is Phase 1 alone enough to start selling per-camera, with packs handled manually by support until Phase 2?
