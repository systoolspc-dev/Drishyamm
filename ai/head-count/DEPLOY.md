# Head-count — deployment

Head counting is **per-camera, user-controlled**: users toggle it on the cameras
they want from the VMS (Headcount & Occupancy page → "Head counting — choose
cameras"). The head-count service polls the backend camera registry
(`/api/internal/cameras`, filtered by `settings.headcount.enabled`) and counts
those cameras, forwarding live counts to the backend (occupancy gauge + threshold
alerts). No camera list to maintain in config.

## Ports
- Own dashboard + REST: **:8020** (`http://<host>:8020/`)
- Talks to `smart-cam-backend:5000` and `stream-service:8554` on the compose network.

---

## LOCAL (done + verified)

Already deployed on the `drisyam-original` stack:

```bash
docker compose -p drisyam-original -f docker-compose.drisyam-original.yml build head-count
docker compose -p drisyam-original -f docker-compose.drisyam-original.yml up -d head-count
# migration 029 (restricted_zones.max_occupancy) run in the backend container
```

Verified: enabling head-count on a camera → the service adds a worker → counts →
forwards → backend Redis gauge `occupancy:live:<monitorId>` tracks the count.

---

## PROD (103.109.7.36) — run on the server

Prod uses compose project **`build`** with **`/data/build/docker-compose.prod.yml`**.

**1. Sync the changed files** to `/data/build/` (your usual method — git pull or scp):
- New:
  - `smart-cam-ai/app/head-count/` (Dockerfile, `src/headcount/{config,manager,source,forwarder,api}.py`, `config/config.docker.yaml`)
  - `smart-cam-backend/src/services/occupancyHysteresis.js`
  - `smart-cam-backend/src/services/alertEngine.js`
  - `smart-cam-backend/migrations/029-add-restricted-zone-max-occupancy.js`
- Changed:
  - backend: `src/routes/internal.routes.js`, `src/controllers/ai.controller.js`, `src/routes/ai.routes.js`, `src/services/zoneIntrusion.service.js`, `src/models/RestrictedZone.js`
  - AI: `smart-cam-ai/app/face_detection/vms_face/infra/alert_backend_forwarder.py`
  - frontend: `smart-cam-app/src/modules/headcount/HeadCount.jsx`, `smart-cam-app/src/core/services/ai.js`

**2. Add the head-count service** to `/data/build/docker-compose.prod.yml` (mirror the
block in `docker-compose.drisyam-original.yml`; keep `env_file: ./smart-cam-ai/.env`
so it shares `SERVICE_TOKEN`), and add the `head-count-models:` named volume.

**3. Run the migration** (prod uses migrations, not sync):
```bash
docker exec build-backend-1 npx sequelize-cli db:migrate   # or the backend container name
```

**4. Build + start head-count:**
```bash
cd /data/build
docker compose -p build -f docker-compose.prod.yml build head-count
docker compose -p build -f docker-compose.prod.yml up -d head-count
```

**5. Apply the backend changes** (baked image → hot-patch per prod_deploy_process):
```bash
# docker cp each changed backend file into the running backend container, then:
docker restart <backend-container>
```

**6. Rebuild the frontend** (HeadCount.jsx + ai.js changed):
```bash
/data/build/build-app.sh
```

**7. Verify:**
- `http://<host>:8020/` shows the head-count dashboard.
- In the VMS → Headcount & Occupancy → toggle a camera ON → within ~15s the
  service logs `added camera <id>` and the live tile shows the head count.
- Set a limit > 0 to arm the occupancy alert (fires with hysteresis, no flapping).

---

## Notes
- CPU image (torch-CPU) — keeps the GPU free for face recognition. For heavy
  multi-camera load, switch to a CUDA base + `gpus: all`.
- The head model auto-downloads once into the `head-count-models` volume.
- Occupancy alert threshold is per-camera (`settings.headcount.threshold`), or set
  a global default via `OCCUPANCY_ALERT_THRESHOLD` on the backend.
