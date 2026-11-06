# Honeywell — Camera & Recorder Model-Number Decoding

> Honeywell publishes an explicit naming-key diagram for its current **30 / 35 / 60 / 70 Series**
> (quoted verbatim below). Its older **equIP** and **Performance** generations are far less
> consistent — those sections flag clearly where the pattern is **official** vs **inferred**.
> ⟵ Back to [index](README.md).

---

## 1. Company Overview

- **Who:** **Honeywell Commercial Security** (Honeywell Building Technologies), US-based (Atlanta,
  GA). Mid-market to enterprise commercial video.
- **Current camera lines:** **30 Series** (cost-optimized value), **35 Series** (SMB, smart
  analytics, NDAA), **60 Series** (professional), **70 Series** (premium) — these replaced the older
  **equIP®** and **Performance Series**.
- **Recorders/VMS:** **MAXPRO** VMS and **MAXPRO NVR** (editions XE/SE/PE/HE), **Pro-Watch**, plus
  **30/35 Series NVRs (HN300/HN301)** and the legacy **Performance Series eNVR (HEN)**.
- **NDAA:** 30/35/60/70 Series are explicitly **NDAA §889-compliant**; Honeywell publishes an "NDAA
  Products Transition" guide mapping old equIP/Performance models to compliant replacements.

---

## 2. Camera Naming

### 2.1 OFFICIAL key — 30 / 35 / 60 / 70 Series

Honeywell prints a naming-structure diagram on its datasheets. From the NDAA Transition Guide
(`HC60 W 4 5 R2 L`) and the 35 Series datasheet (`HC35 W 4 8 R2`):

```
HC  35  W  4  8  R2  (L)
│   │   │  │  │  │    └── trailing -L = supplied WITHOUT built-in video-analytics license
│   │   │  │  │  └─────── IR + lens/sub-variant (R2 = MFZ 2.7–13.5mm, R3 = fixed 2.8mm; PTZ R25/R30 = zoom)
│   │   │  │  └────────── resolution digit (2/3/4/5/8 MP)
│   │   │  └───────────── form-factor letter/digit (2/3/4 dome sizes · B bullet · E ball · Z PTZ · F fisheye)
│   │   └──────────────── W = WDR 120 dB
│   └──────────────────── series: 30 value · 35 SMB-smart · 60 professional · 70 premium
└──────────────────────── HC = Honeywell Camera
```

| Position | Field | Decode |
|---|---|---|
| `HC` | prefix | **H**oneywell **C**amera |
| `30/35/60/70` | series | value / SMB-smart / professional / premium |
| `W` | feature | **WDR 120 dB** |
| form letter | form factor | **2**=2″/micro dome · **3**=3″ indoor dome · **4**=4″ rugged dome · **B**=bullet · **E**=eye/ball · **Z**=PTZ · **F**=fisheye |
| res digit | resolution | **2**=2 MP · **3**=3 MP · **4**=4 MP · **5**=5 MP · **8**=8 MP |
| `R` | IR | **R = IR LEDs** (PTZ: digits after R = zoom, e.g. `R25`=25×, `R30`=30×) |
| `R1/R2/R3` | lens/variant | **R2 = MFZ** (motorized 2.7–13.5 mm) · **R3 = fixed-lens** (2.8 mm). In the 30/60 key: 1=4 mm, 2=MFZ, 3=2.8 mm, 4=7–22 mm, 5=5–50 mm, 30=4.3–129 mm |
| trailing `-L` | analytics | **without** built-in analytics license |

> Note: `W` = **WDR**, not a form factor. There is **no single "dome" letter** — domes are encoded
> by the **size digit** (2/3/4). The final `R#` digit is "lens / sub-variant," not a pure generation
> counter — e.g. `HC35W45R2` = 5 MP IR **MFZ** dome vs `HC35W45R3` = 5 MP IR **fixed-2.8 mm**
> rugged mini dome.

### 2.2 equIP® series (legacy) — inferred + cross-referenced

No published key diagram exists. Inferred pattern: **`H` + [size/gen digit] + [form letter] + [res
digit] + `G/P` + [features] + `R[n]`**.

- `H` = Honeywell · size/gen digit **2/3/4** ≈ dome size class (2″/3″/4″).
- form letter: `W` = (mini/rugged) dome · `D` = dome · `B` = box/bullet · `Z` = PTZ · `F` = fisheye ·
  `E`/`EW` = ball/eyeball · `M` = multi-sensor (*inferred; varies by sub-line*).
- res digit: 2/4/5/6/8 MP.
- **G** vs **P** = the two equIP technology generations in the guide — **"G" series** (`H2W2GR1`,
  `H4D8GR1`) and **Performance "P" series** (`H4W4PER2`, `HBW8PR2`). `E` after res ≈ outdoor/
  environmental · `P` ≈ Performance/PoE · trailing `V` ≈ varifocal · `R1/R2/R3` = revision.
- **HDZ** PTZ sub-line: `HDZ` = **H**oneywell **D**ome **Z**oom. Family `HDZ302D / DE / DIN / LIK /
  LIW` — `30`-era, `2`≈2 MP, trailing letters = bubble/mount/housing variants (*suffix meanings
  inferred*).

> Confidence: the **existence and grouping** of these equIP models is **cited** from Honeywell's
> NDAA Transition Guide; the **per-character meaning** is **inferred** (Honeywell never published an
> equIP key diagram).

### 2.3 Quick maps (current Series — official)

| Form code | Form factor | | Res digit | Resolution |
|---|---|---|---|---|
| **2** | 2″ / micro dome | | **2** | 2 MP |
| **3** | 3″ indoor dome | | **3** | 3 MP |
| **4** | 4″ rugged dome | | **4** | 4 MP |
| **B** | bullet | | **5** | 5 MP |
| **E** | eye/ball | | **8** | 8 MP |
| **Z** | PTZ / speed dome | | | |
| **F** | fisheye | | | |

---

## 3. Recorder / VMS Naming

**MAXPRO NVR editions** (suffix = scale tier):

| Model | Edition | Scale |
|---|---|---|
| **MAXPRO NVR XE** | Xpress | entry, ≤16 IP ch |
| **MAXPRO NVR SE** | Standard | ≤64 IP ch |
| **MAXPRO NVR PE** | Professional | ≤128 IP ch, RAID 5/6 enterprise |
| **MAXPRO NVR HE** | High-Efficiency | open-platform, ONVIF/PSIA |

> "MAXPRO VMS" = umbrella video-management platform; **Pro-Watch** = access-control/integration
> platform (also records ≤256 IP ch).

**30/35 Series NVRs — `HN300` / `HN301`** (inferred): `HN` = Honeywell NVR; `300/301` = 30-Series
gen; following digits = channel count + HDD bays (e.g. `HN300401xx` = 4-ch/1-bay, `HN300802xx` =
8-ch/2-bay, `HN301602xx` = 16-ch/2-bay).

**Legacy Performance Series eNVR — `HEN`:** `HEN` = Honeywell Embedded NVR. `HEN0413` = 4-ch,
`HEN0813` = 8-ch, `HEN161x4` = 16-ch, `HEN32xx4` = 32-ch, `HEN64xx4` = 64-ch; trailing digit ≈ HDD
bays (*channel field cited; bay field inferred*).

**"Trinity":** older **HRDP / Performance "Trinity"** = embedded DVR/hybrid recorders (analog + IP),
largely superseded. Treat as legacy hybrid DVR (*low-confidence, branding-level*).

---

## 4. Technology Stack

- **WDR 120 dB** ("W" in the model) · **True day/night** + removable IR-cut · **Smart IR**.
- **Smart analytics (AI):** people counting, intrusion, loitering, **smart motion detection** that
  fires on person/vehicle recognition (not raw pixel change).
- **Smart Codec** (H.265/H.264, ~50% savings) · **ONVIF Profile S/G/T** · **AES-256** stream
  encryption · **NDAA §889 compliant** · microSD edge (≤256 GB) · PoE/12 Vdc · IP66/IP67 + IK10
  (model-dependent).

---

## 5. Fully-Decoded Examples

### `HC35WB5R2` (official key)

| Segment | Value | Meaning |
|---|---|---|
| HC / 35 | prefix / series | Honeywell Camera / 35 Series (SMB-smart) |
| W / B | WDR / form | WDR 120 dB / **bullet** |
| 5 / R2 | res / IR+lens | **5 MP** / IR LEDs, **R2 = MFZ 2.7–13.5 mm** |

→ 5 MP IR MFZ bullet, WDR 120 dB, PoE, audio & alarm I/O.

### `HC30W45R3` (official key)

| Segment | Value | Meaning |
|---|---|---|
| HC / 30 | prefix / series | Honeywell Camera / 30 Series (value) |
| W / 4 | WDR / form | WDR 120 dB / **4″ rugged dome** |
| 5 / R3 | res / IR+variant | **5 MP** / IR LEDs, fixed-lens rugged-mini-dome |

→ 5 MP WDR vandal-resistant IR mini-dome, IP66, PoE.

### `H4W4PER2` (equIP Performance — inferred + cited model)

| Segment | Value | Meaning |
|---|---|---|
| H / 4 | brand / size-gen | Honeywell / 4″ class |
| W / 4 | form / res | (mini/rugged) dome / 4 MP |
| P / E | generation / env | **Performance** series / outdoor-environmental |
| R2 | revision | rev 2 |

→ Performance-series 4 MP outdoor rugged dome; per NDAA guide → replaced by 30 Series `HC30W42R3`/
`HC30W45R3`.

---

## 6. Cheat-Sheet

| Code | Means | Source |
|---|---|---|
| **HC** | Honeywell Camera (prefix) | official |
| **30/35/60/70** | value / SMB-smart / professional / premium | official |
| **W** | WDR 120 dB | official |
| **2/3/4** (after W) | 2″/3″/4″ dome | official |
| **B / E / Z / F** | bullet / eye-ball / PTZ / fisheye | official |
| **2/3/4/5/8** (res digit) | 2/3/4/5/8 MP | official |
| **R** | IR LEDs | official |
| **R2 vs R3 / lens digit** | lens/sub-variant (R2=MFZ, R3=fixed; 1=4 mm, 2=MFZ, 3=2.8 mm, 4=7–22, 5=5–50, 30=4.3–129) | official |
| **trailing -L** | no built-in analytics license | official |
| **R25 / R30** (PTZ) | 25× / 30× optical zoom | official |
| **H…G… / H…P…** | equIP "G" gen / "Performance" gen | model list cited; decode inferred |
| **HDZ** | Honeywell Dome Zoom (PTZ) | inferred |
| **HN300 / HN301** | 30-Series NVR (ch+bays in digits) | model cited; digit map inferred |
| **HEN** | Performance Series embedded NVR | model cited |
| **MAXPRO NVR XE/SE/PE/HE** | Xpress/Standard/Professional/High-Efficiency | official |

---

## Confidence Notes
- The **30/35/60/70 Series key is fully official** (two datasheet diagrams quoted). The
  **equIP/Performance/HDZ/HEN** per-character meanings are **inferred** from Honeywell's own model
  lists — model existence and groupings are cited, but no equIP key diagram was ever published.

---

## Sources
- **35 Series datasheet** with `HC35 W 4 8 R2` key + ordering tables — https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/literature-and-specs/datasheets/security-de/HBT-SEC-35S-CameraFamilyDS-QRG-US-EN.pdf
- **NDAA Products Transition Quick Reference Guide** with `HC60 W 4 5 R2 L` key + equIP/Performance/HDZ/HEN lists — https://buildings.honeywell.com/content/dam/hbtbt/en/documents/downloads/NDAA%20Replacement%20Guide.pdf
- 30 Series user guide (HC30W42R3 / HC30W45R3) — https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/manuals-and-guides/user-manuals/HBT-SEC-HSV-30SeriesIPCamera-UG-EN.pdf
- 60 Series Quick Reference Guide — https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/manuals-and-guides/reference-guides/60-Series-Quick-Reference-Guide.pdf
- equIP + HDZ overview datasheet — https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/literature-and-specs/datasheets/hon-ba-equip-and-hdz-series-overview-outdoor-ptz-ir-ultra-low-light-ip-cameras.pdf
- MAXPRO NVR editions — https://buildings.honeywell.com/us/en/products/by-category/video-systems/recorders-and-storage/nvrs/maxpro-nvr-xe
- 30 Series NVR (HN300/HN301) user guide — https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/manuals-and-guides/user-manuals/hon-ba-security-hsv-30seriesnvr-hn300401xx-hn300802xxx-hn301602xxx-ug-en.pdf
- Performance Series eNVR (HEN) user guide — https://hbtmkto.honeywell.com/rs/127-UCB-316/images/800-24120-A_Performance%20Series%20NVR%20User%20Guide.pdf
