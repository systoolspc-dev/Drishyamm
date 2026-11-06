# Axis Communications — Camera & Recorder Model-Number Decoding

> Decoding scheme for Axis IP cameras. Structure:
> **[Line letter][Family digit][series digits][Resolution digit] – [Suffix]**.
> ⟵ Back to [index](README.md).

---

## 1. Company Overview

- **Origin:** Swedish (Lund), founded 1984. Axis **invented the world's first network (IP) camera,
  the AXIS Neteye 200, in 1996** — it created the IP-video category.
- **Ownership / positioning:** A subsidiary of **Canon Inc.** since 2015. Premium / enterprise tier.
- **Silicon & platform:** In-house **ARTPEC** image-processing SoC (current **ARTPEC-8**, with a
  Deep Learning Processing Unit for on-edge analytics) running the open **ACAP** (AXIS Camera
  Application Platform) for Axis + third-party analytics (e.g. AXIS Object Analytics).
- **NDAA / TAA:** **NDAA §889 compliant** and widely TAA-compliant — standard for US
  government/enterprise deals.

---

## 2. Axis Naming — Positional Decode

```
AXIS  P 3 2 6 5 - L V E
      │ │ │ │ │   └─┴─┴ suffix extensions (combine freely)
      │ │ └─┴─┴ running/series number; LAST digit ≈ resolution class
      │ └ product family / form-factor group (1st digit)
      └ product line (tier letter)
```

### Product line — first letter (tier)

| Letter | Line | Positioning |
|---|---|---|
| **M** | Mainstream | Affordable, compact — value tier |
| **P** | Professional / Performance | Versatile, advanced, multi-purpose |
| **Q** | Premium | Most advanced; mission-critical |
| **F** | Modular (FlexiCam) | Separate main unit + remote sensor heads |
| **C** | Communications / audio | Network speakers, horn speakers, audio |
| **V** | Live-stream / broadcast | Lectures, conferences, PTZ broadcast |

> Camera tiers that matter: **M < P < Q**, plus **F** (modular) and **C** (audio). Axis reuses
> letters for non-camera device classes (S recorders, A access control, I intercoms, etc.).

### Family digit — first digit after the letter (form-factor group)

The most useful field for classifying form factor in a VMS:

| Digit | Family / form factor |
|---|---|
| **1** | Fixed **box** / **bullet** (also thermal in some ranges) |
| **2** | Fixed **bullet** / compact fixed camera |
| **3** | Fixed **dome** |
| **4** | Fixed dome / onboard / modular-related (secondary dome group) |
| **5** | **PTZ** |
| **6** | **PTZ premium** (high-end) |
| **8** | **Positioning** / specialty |
| **9** | **Specialty** cameras |

> ⚠️ Two published groupings exist. Axis's official elearning groups: **1–2 = box/bullet/thermal,
> 3–4 = fixed dome, 5–6 = PTZ, 8 = positioning, 9 = specialty**. Reseller decoders split finer
> (1 = box, 2 = bullet, 3 = dome, 6 = premium PTZ). Both agree on the boundaries that matter.
> Verified: M2036 ("2") = bullet; M3215/P3265 ("3") = fixed domes; P1455/Q1656 ("1") = box/bullet;
> Q6155 ("6") = premium PTZ.

### Resolution — the LAST digit of the number block

| Last digit | Resolution / MP class (official) |
|---|---|
| 1 | VGA (640×480) |
| 2 | 4CIF / 0.4 MP |
| 3 | SVGA (800×600) |
| 4 | HDTV 720p / ~1.3 MP |
| 5 | HDTV 1080p / 2 MP |
| 6 | 3–5 MP |
| 7 | 5–8 MP |
| 8 | 4K / 8–15 MP |
| 9 | > 4K / > 15 MP |

> ⚠️ **Approximate** — reliable on older models, drifts on modern sensors. Verified: M3215-LVE,
> P3265-LVE, P1455-LE ("…5") = 2 MP/1080p ✅; Q1656, M2036-LE ("…6") = 4 MP ✅ ("6 = 3–5 MP").
> Decode the last digit for a class hint, then confirm exact MP on the datasheet. Middle digits =
> model/generation sequence (no fixed public meaning).

### Suffix extensions — dash letters (combine freely)

| Suffix | Meaning | | Combo | Expands to |
|---|---|---|---|---|
| **-E** | Exterior / outdoor-ready (IP66/67, NEMA 4X) | | **-LE** | IR + Outdoor |
| **-V** | Vandal-resistant (IK10) | | **-VE** | Vandal + Outdoor |
| **-L** | Built-in LED IR (OptimizedIR) | | **-LV** | IR + Vandal |
| **-R** | Rugged / onboard (mobile, vibration-rated) | | **-LVE** | IR + Vandal + Outdoor |
| **-P** | Panoramic (multisensor 180°/360°) | | | |
| **-C** | Cooling enclosure (extreme heat) | | | |
| **-B** | Barebone (body only, no lens/enclosure) | | | |
| **-T** | Thermal (temperature-measurement variant) | | | |

---

## 3. Technology Glossary

| Tech | What it does |
|---|---|
| **Lightfinder / 2.0** | Low-light tech delivering **color** (not just B/W) images in near-darkness, low noise |
| **Forensic WDR** | Wide Dynamic Range tuned to preserve forensic detail in high-contrast scenes |
| **OptimizedIR** | Adaptive built-in IR — adjusts the beam to the lens FoV, dims center to avoid overexposure |
| **Zipstream** | Intelligent bitrate-reduction codec layer (over H.264/H.265); typically 50%+ savings |
| **ARTPEC** | In-house image-processing SoC (current **ARTPEC-8**); newer ones include a DLPU for on-edge deep learning |

---

## 4. Fully-Decoded Examples

### `AXIS M3215-LVE` — outdoor vandal IR dome (verified: 2 MP, ARTPEC-8)

| Segment | Value | Meaning |
|---|---|---|
| M | line | Mainstream (value) |
| 3 | family digit | Fixed **dome** |
| 21 | series digits | running/model number |
| 5 | resolution | 1080p / **2 MP** ✅ |
| -L / -V / -E | suffix | IR LED / Vandal (IK10) / Outdoor (IP66) |

### `AXIS P3265-LVE` — outdoor vandal IR dome (verified: 2 MP, Lightfinder 2.0)

| Segment | Value | Meaning |
|---|---|---|
| P | line | Professional |
| 3 | family | Fixed **dome** |
| 26 | series | running/model number |
| 5 | resolution | 1080p / **2 MP** ✅ |
| -LVE | suffix | IR + Vandal + Outdoor |

### `AXIS Q1656` — box camera (verified: 4 MP, ARTPEC-8, Lightfinder 2.0)

| Segment | Value | Meaning |
|---|---|---|
| Q | line | Premium (mission-critical) |
| 1 | family | Fixed **box** |
| 65 | series | running/model number |
| 6 | resolution | 3–5 MP class → **4 MP** ✅ |
| *(none)* | suffix | Indoor, no IR/vandal/outdoor (cf. `Q1656-LE`, `Q1656-B`) |

### `AXIS M2036-LE` — outdoor IR bullet (verified: 4 MP)

| Segment | Value | Meaning |
|---|---|---|
| M | line | Mainstream |
| 2 | family | **Bullet** |
| 03 | series | running/model number |
| 6 | resolution | 3–5 MP class → **4 MP** ✅ |
| -L / -E | suffix | IR LED / Outdoor |

### `AXIS P1455-LE` — outdoor IR bullet (verified: 2 MP)

| Segment | Value | Meaning |
|---|---|---|
| P | line | Professional |
| 1 | family | Box/bullet group (this SKU is a bullet) |
| 45 | series | running/model number |
| 5 | resolution | 1080p / **2 MP** ✅ |
| -LE | suffix | IR + Outdoor |

---

## 5. Cheat-Sheet

| Field | Key codes |
|---|---|
| **Line (letter)** | M Mainstream(value) · P Professional · Q Premium · F Modular · C Audio · V Live-stream |
| **Family digit (1st #)** | 1 box · 2 bullet · 1–2 box/bullet/thermal · 3–4 fixed dome · 5–6 PTZ (6=premium PTZ) · 8 positioning · 9 specialty |
| **Resolution (last #)** | 4 ≈720p · 5 = 1080p/2MP · 6 = 3–5MP · 7 = 5–8MP · 8 = 4K/8MP+ · 9 = >4K (**approximate — verify**) |
| **Suffix** | E outdoor · V vandal(IK10) · L IR-LED · R rugged/onboard · P panoramic · C cooled · B barebone · T thermal |
| **Combos** | LE = IR+outdoor · VE = vandal+outdoor · LV = IR+vandal · LVE = IR+vandal+outdoor |
| **Tech** | Lightfinder (color low-light) · Forensic WDR · OptimizedIR · Zipstream (bitrate) · ARTPEC-8 (SoC+DLPU) |

---

## Sources
- Official Axis naming-structure guide (PDF) — https://www.axis.com/dam/public/ce/a5/11/product-naming-structure:-guide-a5-horizontal-en-US-397013.pdf
- Axis Academy — "Get to know Axis network camera naming convention" — https://www.axis.com/learning/academy/elearning/get-to-know-axis-network-camera-naming-convention
- Network Webcams — Axis naming convention explained — https://www.networkwebcams.co.uk/blog/making-sense-of-the-axis-camera-naming-convention/
- Aeon Security — Axis naming guide (decoder) — https://aeon-security.com/axis/naming-guide
- IP Phone Warehouse — Axis IP cameras, what the names mean — https://www.ipphone-warehouse.com/blog/axis-ip-cameras-what-the-names-mean/
- Verified datasheets: M3215-LVE — https://www.axis.com/products/axis-m3215-lve · P3265-LVE — https://www.axis.com/products/axis-p3265-lve · Q1656 — https://www.axis.com/products/axis-q1656 · M2036-LE — https://www.axis.com/products/axis-m2036-le · P1455-LE — https://www.axis.com/products/axis-p1455-le
