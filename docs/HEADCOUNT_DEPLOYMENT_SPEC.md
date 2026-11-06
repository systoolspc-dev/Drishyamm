# Head-count deployment spec — measured, not quoted

**Date:** 2026-08-10 · **Model:** YOLOv8n head detector (`abel/best.pt`) · **Settings:** `imgsz 640`, `conf 0.40` (production `config.docker.yaml`)

Every question an installer asks — how high, what angle, what resolution, how
much light — collapses into **one** number this detector actually responds to:

> **how many pixels tall is a head, at the model's input tensor.**

So the numbers below were measured on our own model rather than taken from
vendor guidance. Everything else is optics on top of that measurement.

---

## 0. What was measured, and what it does not prove

| | |
|---|---|
| **Clip** | `crowd.mp4`, 1280×720, 341 frames (43–120 sampled per experiment) |
| **Reference ("truth")** | our own model at `imgsz 1536`, keeping only `conf ≥ 0.60` detections |
| **Match rule** | IoU ≥ 0.40 against the reference |
| **Samples** | 10,287 (size sweep), 9,680 (light/blur), 3,558 (crowding) |

**This measures degradation, not absolute accuracy.** The reference is the model
judging itself under ideal conditions, so every curve answers *"of the heads we
can find at 1536 px in good light, what fraction survive condition X?"* — which
is exactly the right question for a mounting spec, and the wrong one for an
accuracy claim. An absolute accuracy figure still needs a human-labelled set;
that remains the open accuracy gate.

Two further limits worth stating plainly:

- **One scene.** A single crowd clip, moderately dense, elevated oblique view.
- **Daylight/colour only.** IR night mode changes the image statistics
  completely (mono, IR reflectance, flat lighting). **Night performance is
  unmeasured** and must be validated on site before it is promised.

---

## 1. Resolution density — the parameter everything else reduces to

Measured recall against head height at model input:

| head px @ model input | samples | recall | mean conf |
|---:|---:|---:|---:|
| < 8 | 5,712 | **20.5 %** | 0.54 |
| 8 – 10 | 1,514 | 81.6 % | 0.60 |
| 10 – 12 | 1,117 | 95.0 % | 0.66 |
| **12 – 14** | 803 | **97.8 %** | 0.70 |
| 14 – 16 | 416 | 98.3 % | 0.72 |
| **16 – 20** | 516 | **99.2 %** | 0.73 |
| 20 – 32 | 209 | 100 % | 0.73 |

The knee is sharp and sits at **10–12 px**. Below 8 px the detector is
effectively blind; the model does not degrade gracefully there, it falls off a
cliff.

### The design rule

A head is ~0.24 m tall, so:

| tier | head px | **pixels per metre at the head plane, at model input** |
|---|---:|---:|
| Minimum viable | 12 px | **50 px/m** |
| High-confidence | 16 px | **67 px/m** |

### The counter-intuitive part: megapixels do not extend range

Frames are letterboxed to `imgsz` on the long side before inference, so:

```
px_model = (V/W) · imgsz · h_head / (2 · d · tan(vfov/2))
```

**The camera's native pixel count is absent from that equation.** Once we resize
to 640, a 4K camera and a 1080p camera at the same FOV and distance produce the
*same* head pixels — and therefore the same accuracy. Range is set by **FOV and
`imgsz`**, not by megapixels.

Stated as a native-sensor requirement, the same spec reads:

| camera | multiplier @ imgsz 640 | native px/m needed (12 px tier) |
|---|---:|---:|
| 1080p | ×3 | 150 px/m |
| 1440p | ×4 | 200 px/m |
| 4K | ×6 | **300 px/m** |

A 4K camera meeting "150 px/m native" — a perfectly normal CCTV spec — delivers
only **25 px/m** at model input and will miss most heads. For head-count, spend
the budget on the right lens, not on sensor resolution.

---

## 2. Range, by lens and `imgsz`

Max **slant** distance at which a head still clears the pixel threshold
(1/2.8" sensor, 16:9):

| lens | HFOV | VFOV | imgsz 640 (12px / 16px) | imgsz 960 | imgsz 1280 |
|---|---:|---:|---:|---:|---:|
| 2.8 mm | 91° | 59° | 6.3 m / 4.7 m | 9.4 / 7.1 | 12.6 / 9.4 |
| 4.0 mm | 71° | 44° | 9.0 m / 6.7 m | 13.5 / 10.1 | 18.0 / 13.5 |
| 6.0 mm | 51° | 30° | 13.5 m / 10.1 m | 20.2 / 15.2 | 27.0 / 20.2 |
| 8.0 mm | 39° | 23° | 18.0 m / 13.5 m | 27.0 / 20.2 | 36.0 / 27.0 |
| 12.0 mm | 27° | 15° | 27.0 m / 20.2 m | 40.5 / 30.4 | 54.0 / 40.5 |

**`imgsz 640` is the binding constraint for large rooms.** A 4 mm lens reaches
only 9 m — shorter than most cafeterias and auditoriums. See §6.

---

## 3. Mounting height and tilt

Range is a **slant** distance, so height trades directly against floor reach
(head plane assumed 1.6 m):

| lens | mount | slant | floor reach | tilt down |
|---|---:|---:|---:|---:|
| 2.8 mm | 2.5 m | 6.3 m | 6.2 m | 8.2° |
| 2.8 mm | 3.0 m | 6.3 m | 6.1 m | 12.8° |
| 2.8 mm | 4.0 m | 6.3 m | 5.8 m | 22.4° |
| 2.8 mm | 5.0 m | 6.3 m | 5.3 m | 32.7° |
| 4.0 mm | 3.0 m | 9.0 m | 8.9 m | 8.9° |
| 4.0 mm | 4.0 m | 9.0 m | 8.7 m | 15.5° |
| 6.0 mm | 3.0 m | 13.5 m | 13.4 m | 6.0° |
| 6.0 mm | 4.0 m | 13.5 m | 13.3 m | 10.2° |

**Recommended: 3.0–4.0 m.** Below 2.5 m the camera is reachable and the view
goes near-horizontal; above 5 m you spend range on height and buy nothing back.

### Tilt: the measured result changes the usual advice

Conventional guidance says tilt steeply to stop people occluding each other. We
measured whether crowding actually costs us anything — recall against how close
the nearest other head is, with **head size held constant** so this isolates
occlusion from distance:

| nearest neighbour (head diameters) | samples | recall |
|---|---:|---:|
| 1.0 – 1.5 (nearly touching) | 250 | 99.2 % |
| 1.5 – 2.0 | 239 | 100 % |
| 2.0 – 3.0 | 348 | 99.1 % |
| 3.0 – 5.0 | 758 | 99.2 % |
| 5.0+ | 1,949 | 99.5 % |

| other heads within 3 diameters | samples | recall |
|---|---:|---:|
| 0 – 1 | 2,707 | 99.4 % |
| 1 – 2 | 502 | 99.6 % |
| 2 – 3 | 301 | 99.0 % |
| 3 – 5 | 48 | 100 % |

**Crowding is not the binding constraint.** It is a *head* detector — heads sit
at the top of the silhouette and rarely hide behind one another, so packing
people shoulder-to-shoulder costs essentially nothing as long as the pixels are
there.

So tilt for **range and framing**, not for occlusion:

- **10–20° below horizontal** is the working band for a room. It keeps slant
  distance close to floor distance (maximising reach) while putting the head
  plane in frame.
- Steeper than ~30° throws away reach for no measured accuracy gain.
- **Caveat:** heads closer than 1.0 diameter (genuinely overlapping) were too
  rare in this clip to measure, and a truly horizontal corridor view — where
  bodies stack — is outside what was tested. Do not read this as licence to
  mount at eye level.
- **Conflict to note:** head *counting* tolerates a steep look-down; face
  *recognition* needs a near-horizontal view. A camera doing both should sit at
  the shallow end of the band (10–15°), or use two cameras.

---

## 4. Illumination

Measured by dropping the scene in **linear light** and applying shot (Poisson)
plus read noise at that photon count, then auto-gaining back — i.e. simulating
what a sensor really does in a dim room. It is the *noise*, not the darkness,
that kills small-object recall.

| stops below reference | relative light | indicative lux¹ | recall | mean conf |
|---:|---:|---:|---:|---:|
| 0 | 1.0 | ~300 | 99.5 % | 0.73 |
| −3 | 1/8 | ~38 | 99.4 % | 0.73 |
| −4 | 1/16 | ~19 | 98.9 % | 0.72 |
| **−5** | 1/32 | **~9** | **97.4 %** | 0.71 |
| −6 | 1/64 | ~5 | 94.2 % | 0.69 |
| −7 | 1/128 | ~2.3 | 84.8 % | 0.65 |
| −8 | 1/256 | ~1.2 | **34.2 %** | 0.58 |
| −9 | 1/512 | ~0.6 | **0 %** | — |

¹ Assuming the reference scene ≈ 300 lux (normal office lighting). The stops are
measured; the lux column is that assumption applied, so treat it as indicative.

**Spec: ≥ 10 lux at the head plane** for full accuracy. 5 lux costs ~5 %. Below
2 lux the detector collapses within one stop — there is no gentle decline, so do
not design near that edge. Below 5 lux, add IR illumination **and validate on
site** (see §0 — IR is unmeasured).

### The shutter trap — the part that actually bites

Low light makes auto-exposure lengthen the shutter, and a walking head smears.
Measured recall against motion blur:

| blur (px @ model input) | recall |
|---:|---:|
| 0 | 99.5 % |
| 3 | 99.4 % |
| 5 | 97.5 % |
| 7 | 92.0 % |
| **9** | **68.5 %** |
| 13 | 14.7 % |

Converted to a shutter ceiling at walking pace (1.4 m/s), 12 px tier:

| shutter | head travel | blur | recall |
|---|---:|---:|---:|
| 1/30 s | ~5 cm | ~2 px | ~99 % |
| 1/23 s | 6 cm | 3 px | 99.4 % |
| 1/14 s | 10 cm | 5 px | 97.5 % |
| **1/8 s** | 18 cm | 9 px | **68.5 %** |

**Cap the shutter and let the image go dark rather than blurred.** For head
counting 1/30 s is enough. **A camera doing face recognition needs ~1/100 s**:
blur is measured in pixels, and a face occupies roughly six times more of them
than a head, so the same exposure smears a face past matching while leaving a
head perfectly countable. Derived from the same curve above at face
magnification (~300 px/m), and consistent with the ≤1/100 s walk-area figure in
`CAMERA_PLACEMENT_DETECTION_SPECS.md`. A
camera left on auto in a dim room will happily drop to 1/8 s and quietly lose a
third of the count — with no error, no offline flag, just a low number. This is
the single most likely cause of a site that "counts fine by day, under-counts at
night". Fix it with light, not exposure time.

---

## 5. Detection choke point

Everything above says the same thing: **short, bounded range is worth more than
any other advantage.** A choke point — doorway, corridor, turnstile, lobby
throat — gives exactly that:

- **Range is short and roughly constant**, so every head lands in the 12–20 px
  band instead of spanning 6 px at the back to 40 px at the front.
- **A wide lens becomes affordable.** At a 1.2 m doorway from 3 m on a 2.8 mm
  lens, the whole opening sits at ~3–4 m slant — inside the 6.3 m budget with
  ~2× margin, even at `imgsz 640`.
- **Coverage is provable.** A bounded opening can be argued to be fully covered;
  an open hall cannot.

Practical placement:

| | |
|---|---|
| Mount | 3.0–3.5 m, 10–20° down, aimed **along** the flow, not across it |
| Standoff | 2–4 m back from the line people cross |
| Lens | 2.8 mm for a single door, 4 mm for a wide entrance |
| Avoid | backlit doorways — a bright exterior behind the subject silhouettes heads and costs contrast exactly where it is needed |

For **room occupancy** (as opposed to flow), the same logic drives the fusion
model already in the product: several short-range cameras beat one wide one, and
cameras seeing the same people share an `overlapGroup` so the room takes MAX,
not SUM (see `docs/OCCUPANCY_LOGIC.md`).

---

## 6. Per-camera detail level (`imgsz`) — SHIPPED

`imgsz 640` caps a 4 mm lens at 9 m, which is smaller than many rooms we sell
into, so detail level is chosen **per camera** in the UI:

| UI label | `imgsz` | Range on a 4 mm lens |
|---|---:|---:|
| Standard | 640 | ~9 m |
| High | 960 | ~13 m |
| Maximum | 1280 | ~18 m |

**Status: implemented end to end** — picker in `HeadCount.jsx`, allow-listed and
persisted in `ai.controller.js`, consumed in `source.py`. Values outside the
allow-list fall back to the default rather than being passed through.

### What it costs — read this before quoting the isolated benchmark

| imgsz | GPU p50, model call alone | GPU p50, end-to-end per frame |
|---:|---:|---:|
| 640 | 5.6 ms | ~8.2 ms |
| 960 | 6.1 ms | — |
| 1280 | 5.8 ms | ~17.4 ms |

The model call on its own barely moves, which made an earlier draft of this
document claim raising detail was "essentially free". **That was wrong.** The
isolated figure hides the letterbox, the host→device copy and the NMS, all of
which scale with the input. Measured on the real pipeline, 640 → 1280 is
roughly **2×**, not 0.2 ms — still worth it for a deep room, but it is a real
budget decision and must be sized as one. On CPU it is ~2.5× and clearly not
free.

Rule of thumb: raise detail on deep rooms only, and re-check the camera-per-GPU
figure afterwards.

---

## 7. Commissioning checklist

1. Measure the **furthest point** a person can stand in frame.
2. Check it against §2 for the lens and `imgsz` in use. If over, fit a longer
   lens, move the camera, or raise `imgsz` (GPU sites).
3. Confirm mount **3–4 m**, tilt **10–20°** down.
4. Measure lux **at head height** at the furthest point — **≥10 lux**.
5. Force **shutter ≤ 1/30 s** in the camera profile (**≤ 1/100 s if this camera
   also does face recognition**). Do not leave it on auto.
6. Verify against a manual count at the busiest 10 minutes of the day, not a
   quiet one.
7. Re-verify at night, under IR, before promising 24 h accuracy.

---

## Appendix — reproducing this

Scripts used (GPU container, model volume + clip mounted):

| script | produces |
|---|---|
| `px_sweep.py` | recall vs head px at model input |
| `env_sweep.py` | recall vs illumination and motion blur |
| `crowd_sweep.py` | recall vs neighbour spacing and local density |
| `geometry.py` | range / mounting / shutter tables from the measured thresholds |

```
docker run --rm --gpus all \
  -v drisyam-original_head-count-models:/srv/head-count/models:ro \
  -v <clip>:/demo/crowd.mp4:ro -v <out>:/out \
  drisyam/head-count:latest python /out/px_sweep.py
```
