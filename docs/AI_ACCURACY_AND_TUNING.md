# AI Accuracy & Tuning

> How Drishyam's detection/recognition accuracy is defined, measured, and tuned.
> Read `DETECTION_LOGGING_ALERTING_POLICY.md` first — it defines *when* we alert.
> This document defines *how well we see* and *which knobs move it*.

---

## 1. Models in use

| Stage | Model | Where | Notes |
|---|---|---|---|
| Face detection | **SCRFD-10G** (InsightFace `buffalo_l`) | `infra/insightface_runtime.py`, `infra/batched_scrfd.py` | `insightface_det_size=960`, score threshold 0.5. WIDER FACE Hard 83.05%. |
| Face recognition | **ArcFace R50** (buffalo_l) *default* | `infra/recognizers/` | 512-D, cosine threshold **0.62** (code default — ⚠️ production runs **0.45**, see §2.1). IJB-C TAR@FAR=1e-4 ≈ 97.25%. |
| Face recognition (alt) | **AdaFace R100 WebFace12M** | pluggable via `recognizer_backend` | 512-D, cosine threshold **0.35**. TinyFace Rank-1 72.29%, IJB-C 97.66%. |
| Gender/age | buffalo_l genderage head | `infra/genderage.py` | On-demand, **per-track majority vote** (not per-frame). |
| Person detection | **YOLOv8n** | `infra/person_detector.py` | Counts humans regardless of face visibility. |
| Body ReID | **OSNet x1.0** (MSMT17) | `journey/body.py` | Cross-camera journey fusion. |

**Recognizer swap is not free.** ArcFace and AdaFace produce *different embedding spaces*.
Changing `recognizer_backend` invalidates the gallery — **every person must be re-enrolled**,
and the threshold changes with it (0.62 → 0.35). Never mix vectors from two recognizers in
`vms_enrolled`; the payload stores `recognizer` per point so mismatches are detectable.

### Why AdaFace for surveillance
Its loss adaptively down-weights low-quality samples during training, so it degrades more
gracefully on CCTV faces (small, blurred, off-angle) than ArcFace. That's the reason it wins
on TinyFace while being roughly level on clean benchmarks.

### Why we do NOT super-resolve before recognition
GFPGAN / CodeFormer / Real-ESRGAN **hallucinate identity-relevant pixels** — their own
documentation admits slight identity change. No verified study shows SR-then-recognize beating
a quality-aware recognizer (AdaFace) on TinyFace/QMUL-SurvFace.

> **Rule:** super-resolution is for **human-review thumbnails only**
> (`facerecounstruct`, :8002) — never in the matching path.
> The right fix for low-quality faces is a recognizer trained on degraded faces, not SR.

---

## 2.1 ⚠️ Deployed settings differ from code defaults

`docker-compose.drisyam-original.yml` overrides two safety-critical matching parameters:

| Setting | Code default | **Deployed** | Effect of the override |
|---|---|---|---|
| `INSIGHTFACE_REC_THRESHOLD` | 0.62 | **0.45** | Much looser matching → **substantially more false identifications** |
| `MATCH_MIN_FACE_PX` | 80 | **15** | 15px faces are matched — far below reliable recognition size |
| `PIPELINE_FRAME_TIMEOUT_SEC` | 1.5 | 15.0 | Tolerates slow/stalling sources |
| `INSIGHTFACE_DET_SIZE` | 960 | 960 | unchanged |

**Read this together:** a 0.45 threshold *and* a 15px minimum face means the system will
confidently name people from faces that carry very little identity information. That is the
classic precision-destroying combination — it maximises "we detected someone" at the direct
cost of "it's actually them".

These values were most likely lowered to make demos detect more readily. **They are not safe
defaults for a watchlist deployment**, where a false identification is the expensive error.

> **Recommended:** before any deployment where identification drives action (alerts, access,
> incident reports), run the §5 tuning procedure on that site's own footage and pick the
> threshold from an FNIR/FPIR sweep. Raise `MATCH_MIN_FACE_PX` to something defensible
> (40–80 px is a common floor) so unusable crops are rejected rather than guessed at.
>
> If loose settings are deliberate for a demo environment, keep them **environment-scoped**
> — never let demo tuning become the production default.

---

## 2. How we measure accuracy

**Headline metric: FNIR @ FPIR = 1e-3** (NIST FRVT 1:N open-set identification).
For 1:1 gates use **FNMR @ FMR = 1e-4**.

Harness: `smart-cam-ai/app/face_detection/vms_face/eval/` (`frvt.py`, `harness.py`,
`metrics.py`, `video_pilot.py`). It must report an **FNIR-vs-FPIR sweep**, not a single
threshold's TPR/FPR — a single operating point hides the shape of the curve.

| Term | Meaning |
|---|---|
| **FPIR** | False Positive Identification Rate — how often a *non-enrolled* person is matched to someone in the gallery. |
| **FNIR** | False Negative Identification Rate — how often an *enrolled* person is missed. |
| **Rank-1** | Of correctly-returned candidates, how often the top hit is right. |

### ⚠️ Benchmarks do not transfer to CCTV
NIST/IJB-C numbers are laboratory conditions. **Expect 5–20× higher FNIR on real
surveillance footage.** Do not quote FRVT figures to customers as expected field accuracy.

**Build pilot benchmarks from the deployment's own captured footage.** Re-run **quarterly** —
recognition drifts with seasons, lighting changes, and population turnover.

---

## 3. The accuracy chain

Accuracy is not one number — it is the product of every stage. A face lost at ingest can
never be recovered by a better recognizer.

```
Camera placement ─► Ingest quality ─► Detection ─► Tracking ─► Quality gate
      ─► Embedding ─► Gallery match ─► Decision/debounce ─► Alert
```

| Stage | Dominant failure | Where it's controlled |
|---|---|---|
| Placement | Faces too small / too oblique | `CAMERA_PLACEMENT_DETECTION_SPECS.md` |
| Ingest | Motion blur, low light, over-compression, wrong sub-stream | camera encoder config, `stream_quality` |
| Detection | Face below detector's min size | `insightface_det_size`, zone filters |
| Tracking | ID switches in crowds | tracker + `track_min_hits_to_match` |
| Quality gate | Bad crops reaching the matcher | `face_quality.py` thresholds |
| Embedding | Single bad frame decides identity | **track embedding pool** (top-K quality-weighted mean) |
| Match | Threshold too loose/tight; look-alikes | cosine threshold + **top-1 margin guard** |
| Decision | Flapping / duplicate alerts | K-of-N, cooldowns (see alerting policy) |

**The single biggest lever is camera placement and ingest quality — not the model.**
Motion blur + yaw + low light kills accuracy faster than raw pixel count.

---

## 4. Tuning knobs

All live in `smart-cam-ai/app/face_detection/vms_face/config/settings.py`.

### 4.1 Detection
| Knob | Effect | Guidance |
|---|---|---|
| `insightface_det_size` (960) | Input resolution for SCRFD | ↑ finds smaller/farther faces, costs GPU. Lower only on close-range cameras. |
| detection score threshold (0.5) | Face-vs-noise cutoff | Rarely change. Lowering floods the tracker with junk crops. |
| motion gate (`motion_gate.py`) | Skips SCRFD on static frames | Big GPU saving on idle scenes. Too aggressive → misses slow entries. |
| detection zones | Restrict where faces count | Best precision win available: exclude posters, screens, reflections, corridors you don't own. |

### 4.2 Tracking & embedding
| Knob | Effect | Guidance |
|---|---|---|
| `track_min_hits_to_match` | Frames before a track is matchable | ↑ suppresses one-frame false identities; ↓ reacts faster. Core K-of-N accuracy control. |
| embed gating (warm-up, every-Nth frame) | How often a track is embedded | Fewer embeds = cheaper, but a slower-converging identity. |
| track embedding pool (top-K quality-weighted mean) | Fuses best crops per track | **Why one blurry frame doesn't decide identity.** Leave enabled. |

### 4.3 Matching — the two that matter most
| Knob | Effect | Guidance |
|---|---|---|
| cosine threshold (ArcFace 0.62 / AdaFace 0.35) | Match vs unknown | ↑ = fewer false matches, more misses. **Tune from a pilot FNIR/FPIR sweep, never by feel.** |
| `match_top1_margin` | Rejects when rival identity is too close | The **crowd/look-alike guard**. Returns "unknown" instead of guessing between two similar people. Raise it if you see identity confusion between similar-looking staff. |
| face quality gate (blur, min px, pose) | Blocks unmatchable crops | The cheapest precision win — a bad crop can only produce a bad answer. |

### 4.4 Gallery quality (the most under-rated lever)
A recognizer can only be as good as what it's compared against.

- **Multiple enrollments per person** (varied pose/lighting/time) beat one perfect studio shot.
- Enroll from **the same cameras and conditions** as deployment where possible.
- Prune bad enrollments — one wrong face in a person's set poisons every future match.
- **Face learning** (`services/face_learning.py`, reviewed via `/face-learning`) promotes
  operator-approved real CCTV crops into the gallery. This is the highest-value ongoing
  accuracy work: it adapts the gallery to actual site conditions.

---

## 5. Tuning procedure (do it in this order)

1. **Fix the camera first.** Placement, focus, exposure, WDR, IR, frame rate. No model
   setting recovers a blurred or backlit face.
2. **Restrict with zones.** Remove regions that can only produce false positives.
3. **Improve the gallery.** Multiple varied enrollments; remove bad ones.
4. **Build a pilot set** from that site's own footage — labelled, with true non-enrolled
   people included (needed for FPIR).
5. **Sweep the threshold** on that set. Pick the operating point from the FNIR@FPIR curve.
6. **Tune the margin guard** if look-alike confusion appears.
7. **Only then** consider a model change (e.g. ArcFace → AdaFace) — and re-enroll everyone.
8. **Debounce at the decision layer**, not by loosening the model
   (see `DETECTION_LOGGING_ALERTING_POLICY.md`).

> **Anti-pattern:** raising sensitivity to "catch more", then suppressing the resulting
> alert flood with cooldowns. That trades precision for noise and hides the real problem.
> Fix accuracy at the source; debounce only genuine state changes.

---

## 6. Throughput vs accuracy

Accuracy settings cost GPU, and GPU limits camera density.

| Lever | Accuracy | Cost |
|---|---|---|
| ↑ `insightface_det_size` | ↑ small/far faces | ↑↑ GPU |
| Batched SCRFD (`batcher.py`) | neutral | ↓ GPU (coalesces requests) |
| Motion gate | slight ↓ risk | ↓↓ GPU on static scenes |
| Sub-stream ingest | ↓ (smaller faces) | ↓↓ GPU + ↓ NVR load |
| More frequent embedding | ↑ faster convergence | ↑ GPU |
| DeepStream ingest backend | neutral | ↓ CPU at high density (`DEEPSTREAM_AI_SERVICE.md`) |

**Sub-stream vs main-stream is the sharpest trade.** Sub-streams are much lighter on both GPU
and the NVR, but faces are physically smaller — on long corridors or entrances this can drop
recognition below usable. Use main-stream on identity-critical cameras (entries, checkpoints)
and sub-stream on general-coverage cameras.

---

## 7. Non-face analytics

| Analytic | Accuracy driver | Notes |
|---|---|---|
| Restricted zone | Zone geometry + dwell time | Person detection (YOLO) means it fires without a visible face. Dwell + K-of-N prevent pass-by noise. |
| Headcount / occupancy | `persons_present = max(yolo, face_tracks)` | Occlusion in crowds is the main undercount cause; camera angle matters more than model. |
| Footfall | Line placement + tracker stability | ID switches at the line cause double counts. |
| Person journey | Space-time fusion | `camera_edges` transit gating vetoes physically impossible hops — a large precision win over pure appearance matching. |
| Activity monitor | Pose visibility | Upper-body must be visible; hysteresis (~1s) prevents state flicker. |

---

## 8. Privacy & compliance constraint

Accuracy work must stay inside DPDP limits: retention is enforced by the retention worker
(events 90d / snapshots 7d / audit 365d, configurable), all enrollment and erasure is
audit-logged (`audit_log`), and every query is tenant-scoped (`tid` claim → Qdrant filter).

**Collecting more faces "to improve accuracy" is not automatically permissible.** Prefer
better placement, better gallery hygiene, and operator-reviewed face learning over
indiscriminate retention.

---

## 9. Related documents

- `DETECTION_LOGGING_ALERTING_POLICY.md` — when to detect, log, and alert (anti-flood doctrine).
- `CAMERA_PLACEMENT_DETECTION_SPECS.md` — placement geometry, pixels-on-face requirements.
- `SYSTEM_DESIGN.md` §7 — the AI pipeline architecture.
- `RESTRICTED_ZONE_DETECTION.md`, `JOURNEY_CENTRALIZATION.md` — per-analytic designs.
- `DEEPSTREAM_AI_SERVICE.md` — high-density GPU ingest path.
