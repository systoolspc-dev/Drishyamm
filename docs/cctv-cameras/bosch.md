# Bosch — Camera & Recorder Model-Number Decoding

> Bosch uses **two names for every camera**: a descriptive product-line name (e.g. *FLEXIDOME IP
> starlight 8000i*) and a **Commercial Type Number (CTN)** (e.g. *NDE-8503-R*) — the orderable code
> a VMS/asset DB should key on. The CTN prefix scheme decodes reliably.
> ⟵ Back to [index](README.md).

---

## 1. Company Overview

- **Who:** Bosch Security and Safety Systems, part of **Bosch Building Technologies** (Robert Bosch
  GmbH, Germany). Premium / enterprise. (Note: in 2024–2025 the Building Technologies "solutions"
  video business was carved out under the **Keenfinity Group** brand — many boschsecurity.com URLs
  now redirect to keenfinity-group.com; product/naming conventions are unchanged.)
- **Positioning:** High-end image quality (**starlight** low-light, 120 dB HDR), edge analytics as
  standard, **NDAA §889-compliant** lines.
- **Signature tech:** **Intelligent Video Analytics (IVA)** & **Essential Video Analytics (EVA)** at
  the edge; **Camera Trainer** (on-camera ML classifier you train yourself); **INTEOX** open
  platform (AI + open OS + app store).

---

## 2. Camera Naming — Two Parallel Systems

### 2.1 Product families (descriptive names — form factor / use case)

| Family | Form factor | Use case |
|---|---|---|
| **FLEXIDOME** | Fixed dome | Workhorse fixed dome (indoor + outdoor/vandal); most now have motorized **PTRZ** (Pan-Tilt-Roll-Zoom) |
| **DINION** | Fixed box **and** bullet | Box cameras (interchangeable lens) for demanding scenes; 3000i = compact bullet |
| **AUTODOME** | PTZ dome | Wide-area coverage with optical zoom (e.g. 30×) |
| **MIC** | Ruggedized PTZ | All-metal, corrosion-resistant for extreme environments; **MIC IP fusion 9000i** = thermal + optical |
| **FLEXIDOME panoramic** | Single-imager fisheye | 180°/360° single-sensor |
| **FLEXIDOME multi** | Multi-imager dome | Several sensors, one IP address (e.g. multi 7000i = 4 imagers) |
| **TINYON** | Tiny indoor mini-dome/cube | Very small, low-cost indoor |
| **EXTEGRA** | Ruggedized fixed | Industrial/explosion-area fixed (EXTEGRA IP 9000) |

### 2.2 Tier words: starlight / ultra / micro

Adjectives **inside the descriptive name** (not in the CTN): **starlight** = signature ultra-low-light
sensor tech (color in near-darkness, 120 dB HDR); **ultra** = top imaging tier; **micro** = smallest
dome form factor.

### 2.3 The "x000" performance series (drives which analytics ship)

| Series | Tier | Built-in analytics (standard) |
|---|---|---|
| **3000 / 3000i** | Entry | **Essential Video Analytics** (3000i pulled EVA into entry tier) |
| **4000 / 4000i** | Value | Essential VA |
| **5000 / 5000i** | Mid-range | Essential VA |
| **6000 / 6000i** | Upper-mid / professional | Essential VA |
| **7000 / 7000i** | High-performance | **Intelligent Video Analytics (IVA)** |
| **8000 / 8000i** | Premium (high-MP, PTRZ, starlight) | IVA |
| **9000 / 9000i** | Flagship / specialist (MIC fusion, EXTEGRA, 4K box) | IVA |

> **Rule (officially stated):** IP **4000–6000** ship with **Essential** VA; IP **7000–9000** ship
> with **Intelligent** VA. (3000i is the exception.)

### 2.4 The trailing "i"

Lowercase **"i"** (3000**i**, 7000**i**, 8000**i**) = **current generation** of intelligent edge
cameras (built-in analytics standard, H.265, PTRZ on many). On top lines, the "i" generation carries
**INTEOX** open-platform capability. Older models without "i" = previous generation.

> ⚠️ "i" does **not** mean "IP" (that's a separate word in the descriptive name). Some resellers
> gloss "i = IP" — incorrect; "i" = intelligent/current generation.

### 2.5 INTEOX (open platform)

Bosch's open camera platform: open OS (hardened AOSP-derived) + app store + developer/device-management
portals. INTEOX cameras carry **IVA + Camera Trainer** at the edge and run **third-party apps**.
Naming examples: *AUTODOME inteox 7000i*, *MIC inteox 7100i*, *FLEXIDOME inteox 7100i*.

### 2.6 CTN prefix legend (family + form factor)

| Prefix | Family | Form factor |
|---|---|---|
| **NBE** | DINION | Fixed **bullet** |
| **NBN** | DINION | Fixed **box** |
| **NDE** | FLEXIDOME | Fixed dome — **outdoor / starlight** |
| **NDV** | FLEXIDOME | Fixed dome — **indoor** |
| **NDI / NDN** | FLEXIDOME | Dome (indoor/legacy IR variants) |
| **NDP** | AUTODOME | **PTZ** (current IP starlight / inteox) |
| **NDM** | FLEXIDOME multi | Multi-imager dome |
| **NDS / NFN** | FLEXIDOME panoramic | Fisheye / panoramic |
| **NUC / NUV** | FLEXIDOME | **Micro** dome |
| **NCE** | FLEXIDOME | Corner-mount dome |
| **MIC** | MIC | Rugged PTZ (prefix literally "MIC") |
| **NEZ / VG5** | AUTODOME | **Legacy** HD PTZ |
| **VJM / VIP / VJD** | VIDEOJET | Encoders / decoders |

> ⚠️ The reseller gloss "N=Network, D=Dome, E=Exterior" is a **mnemonic, not an official
> expansion**. NDE = *outdoor/starlight* dome and NDV = *indoor* — the "E vs V" distinction is what's
> load-bearing.

### 2.7 Digit structure inside the CTN

For fixed cameras: **`PREFIX - [S][n] [rr] - [suffix]`**:
- **S** (1st digit) = performance series (3=3000 … 9=9000) — matches the descriptive name.
- **n** (2nd digit) = internal family/sub-line position (often `5` on the current "i" gen).
- **rr** (3rd–4th digits) = resolution code: **02 = 2 MP (1080p)**, **03 = 5–6 MP**, **04 = 8 MP/4K**.
- For PTZ (AUTODOME) the suffix carries zoom: `-Z30` = 30× optical zoom.

### 2.8 Suffix indicators

| Suffix | Meaning |
|---|---|
| **-R** | Built-in **IR** illuminator (also PTRZ IR domes) |
| **-AL** | **A**utomatic/motorized **L**ens (varifocal, motorized zoom & focus) |
| **-A** | Standard (no IR) variant |
| **-Z30** | PTZ 30× optical zoom (number = zoom factor) |
| **-Z30C / -Z30CT / -Z30K** | Z30 + clear bubble / tinted in-ceiling / IK10 pendant |
| **02 / 03 / 04** | resolution code: 2 MP / 5–6 MP / 8 MP (4K) |

---

## 3. Recorder / Appliance Naming — DIVAR

| Prefix | Line | Meaning |
|---|---|---|
| **DIP-** | DIVAR IP | All-in-one recording **+ VMS** appliance (NVR with BVMS built in) |
| **DRN-** | DIVAR network | Standalone network video recorder (pure IP) |
| **DRH-** | DIVAR hybrid | Hybrid recorder (IP + analog) |
| **DDN-** | DIVAR (legacy) | Earlier network/hybrid generation |

**DIVAR IP all-in-one** series numbers mirror camera tiers (2000–7000) and scale by channels / HDD
bays / RAID: *4000* (≤32 ch) · *5000* (4 HDD, RAID 1/JBOD, ≤42 ch) · *6000* (1U, RAID 5, ≤64 ch) ·
*7000* (2U/3U, RAID 5/6, ≤256 ch). DIP CTN: `DIP` + series digit + channel/HDD config; trailing
`-nHD` = number of pre-installed drives (e.g. `-8HD` = 8 disks, `-00N` = no HDD).

---

## 4. Technology Glossary

- **Essential Video Analytics (EVA):** edge analytics on IP 4000–6000 (+3000i): intrusion/line-cross,
  loitering, idle/removed object, people counting, occupancy, crowd density (~15 functions).
- **Intelligent Video Analytics (IVA):** superset on IP 7000–9000 — EVA **plus** robust false-trigger
  suppression (snow, rain, hail, wind-blown trees, water reflections) and long-range/marine.
- **starlight:** ultra-low-light + 120 dB HDR (color where rivals go mono).
- **Camera Trainer:** on-camera ML — train a custom object classifier (no cloud).
- **INTEOX / inteox:** open OS + IVA + Camera Trainer + third-party app store.
- **PTRZ:** motorized Pan-Tilt-Roll-Zoom for remote touch-free aiming (common on 8000i).
- **CPP (Common Product Platform):** internal hardware-platform generations (CPP4 … CPP16) — for
  firmware grouping, not buyer-facing decode.

---

## 5. Fully-Decoded Examples

### `NDE-8503-R` — FLEXIDOME IP starlight 8000i (6 MP outdoor PTRZ IR)

| Segment | Value | Meaning |
|---|---|---|
| NDE | prefix | FLEXIDOME fixed dome, outdoor/starlight |
| 8 / 5 | series / family pos | 8000 series / current "i"-gen |
| 03 | res code | ~6 MP |
| -R | suffix | built-in IR (PTRZ IR model) |

→ *FLEXIDOME IP starlight 8000i*, 6 MP, IVA, H.265, IP66/IK10, PTRZ.

### `NBE-3502-AL` — DINION IP 3000i IR (2 MP bullet)

| Segment | Value | Meaning |
|---|---|---|
| NBE | prefix | DINION **bullet** |
| 3 / 5 | series / family pos | 3000 entry series / "i"-gen |
| 02 | res code | 2 MP (1080p) |
| -AL | suffix | motorized/auto lens (3.2–10 mm varifocal) |

→ *DINION IP 3000i IR*, 2 MP, **Essential** VA, IP66/IK10, ~30 m IR.

### `NDP-7512-Z30` — AUTODOME IP starlight 7000i (2 MP, 30× PTZ)

| Segment | Value | Meaning |
|---|---|---|
| NDP | prefix | AUTODOME **PTZ** |
| 7 / 5 | series / family pos | 7000 series / "i"-gen |
| 12 | res code | 2 MP / 1080p PTZ sensor variant |
| -Z30 | suffix | **30× optical zoom**, clear-bubble pendant |

→ *AUTODOME IP starlight 7000i*, 2 MP, **IVA**, starlight, 120 dB HDR (variants -Z30C/-Z30CT/-Z30K).

---

## 6. Cheat-Sheet

| Code | Means |
|---|---|
| **NBE / NBN** | DINION bullet / box |
| **NDE / NDV** | FLEXIDOME dome — outdoor(starlight) / indoor |
| **NDP** | AUTODOME PTZ (current) |
| **NDM** | FLEXIDOME multi-imager |
| **NDS / NFN** | FLEXIDOME panoramic/fisheye |
| **MIC-** | MIC rugged PTZ |
| **1st digit 3/4/5/6/7/8/9** | 3000…9000 performance series |
| **02 / 03 / 04** | 2 MP / 5–6 MP / 8 MP(4K) |
| **-R / -AL / -Z30** | IR / motorized lens / 30× PTZ zoom |
| **trailing "i"** | current intelligent generation (IVA/INTEOX-capable) |
| **4000–6000 → EVA · 7000–9000 → IVA** | which analytics ship standard |
| **DIP / DRN / DRH** | DIVAR IP appliance / network NVR / hybrid recorder |

---

## Confidence Notes
- Prefix→family and the series digit are confirmed across official datasheets. **Inferred** parts:
  exact channel/bay digit encoding inside DIP/HN recorder numbers and the "N/D/E" mnemonic.
- Watch the **Bosch → Keenfinity** rebrand: many boschsecurity.com links 301-redirect to
  keenfinity-group.com / keenfinity.tech; CTNs unchanged.

---

## Sources
- Bosch/Keenfinity IP video product overview (CTN list) — https://media.boschsecurity.com/fs/media/en/pb/media/support_1/tools/ip_video_product_overview.pdf
- "Which CPP corresponds to certain cameras" (CTN prefix ↔ family) — https://knowledge.keenfinity-group.com/video-systems/article/which-cpp-corresponds-to-certain-cameras-and-encod
- DINION IP 3000i IR (NBE-3502-AL) datasheet — http://s3.abbas.cz/PRODUKT/Datasheet/Bosch/ENG/NBE-3502-AL%20Datasheet_Data_sheet_enUS_73339854475.pdf
- FLEXIDOME IP starlight 8000i (NDE-85xx-R) — https://www.bhphotovideo.com/c/product/1484924-REG/bosch_nde_8503_r_flexidome_ip_starlight_8000i.html
- AUTODOME IP starlight 7000i (NDP-7512-Z30) datasheet — https://www.a1securitycameras.com/content/product_documents/53358/Bosch-NDP-7512-Z30-Datasheet-A1.pdf
- FLEXIDOME multi 7000i (NDM-770x) — https://www.a1securitycameras.com/content/product_documents/56532/Bosch-NDM-7703-A-Datasheet-A1.pdf
- MIC IP fusion 9000i — https://www.keenfinity-group.com/us/en/news/product-news/bosch-mic-ip-fusion-9000i/
- INTEOX / Camera Trainer / IVA — https://www.bosch-presse.de/pressportal/de/en/bosch-introduces-first-cameras-based-on-inteox-open-camera-platform-225920.html
- EVA vs IVA tiers — https://benchmarkmagazine.com/bosch-security-intelligent-video-analytics-2/
- DIVAR IP all-in-one — https://www.boschsecurity.com/us/en/news/product-news/divar-ip-aio-7000/ · DIVAR network 5000 (DRN-) — https://www.a1securitycameras.com/bosch-drn-5532-400n00-divar-network-5000-32-channel-h.265-nvr-network-video-recorder.html
