# Hanwha Vision (Wisenet) — Camera & Recorder Model-Number Decoding

> Decoding scheme for Hanwha Vision (Wisenet, formerly Samsung Techwin) IP cameras and recorders.
> Model numbers parse left-to-right into positional fields (series / type / shape / grade).
> ⟵ Back to [index](README.md).

---

## 1. Company Overview

- **Lineage:** South Korean. **Samsung Techwin** → **Hanwha Techwin** (2015, after Hanwha Group
  acquired it from Samsung) → **Hanwha Vision** (2023). The **Wisenet** brand carries across all
  generations (cameras, lenses, chipsets, recorders).
- **NDAA / TAA compliance:** A core selling point — cameras are **NDAA §889 compliant** (no
  prohibited Chinese components such as HiSilicon SoCs) and many SKUs are **TAA compliant**,
  eligible for US federal/state/enterprise procurement.
- **In-house silicon:** Hanwha designs its own **Wisenet SoC** family (Wisenet 5 → 7 → **9**, the
  latest AI chipset). On-camera AI (object detection/classification, attribute search, BestShot)
  runs on these chips.
- **Camera tiers (series):** **P** (Premium — flagship 4K/multi-sensor/panoramic/AI), **X**
  (Versatile / "Excellent" — high-performance + latest AI chipset; the modular "X PLUS" line swaps
  lens modules), **Q** (Quality — general-purpose mid-range), **A** (entry — cost-effective
  camera+NVR bundles), plus **L** (Lite/Entry), **T** (Vertical/special incl. thermal), **H**
  (HD+/AHD analog-over-coax), **S** (legacy).

> ⚠️ Resellers gloss "A=entry, Q=quality, X=excellent, P=premium," but Hanwha's **official**
> naming-rule page lists **P=Premium, X=Versatile, Q=Quality, H=HD+, L=Entry, T=Vertical(Special)**.
> The official wording is authoritative; both are in circulation.

---

## 2. Wisenet Camera Naming — Positional Decode

Canonical shape: **[Series][Type][Shape] – [Grade?][Resolution+Lens digits][Suffix?]**

```
Q  N  V  -  (grade)  8080  R
│  │  │              │     └── suffix: R IR · VD multi-dir · T thermal · /LPR …
│  │  │              └──────── resolution + lens/series digits
│  │  └─────────────────────── shape / form factor
│  └────────────────────────── product type (signal/connectivity)
└───────────────────────────── series (product tier)
```

### Position 1 — Series (tier)

| Code | Official | Common gloss |
|---|---|---|
| **P** | Premium | Top tier — 4K, multi-sensor, panoramic |
| **X** | Versatile | "Excellent" high-performance + AI |
| **Q** | Quality | General/starter professional |
| **A** | (entry) | Cost-effective camera+NVR |
| **H** | HD+ | AHD analog-over-coax |
| **L** | Entry | Lite |
| **T** | Vertical (Special) | Specialty incl. thermal |

### Position 2 — Product type

| Code | Meaning |
|---|---|
| **N** | Network (IP) camera |
| **C** | Analog camera |
| **U** | UTP camera (HD-over-coax/twisted-pair) |

### Position 3 — Shape / form factor

| Code | Form factor | | Code | Form factor |
|---|---|---|---|---|
| **B** | Box | | **F** | Fisheye (360° single-sensor) |
| **D** | Dome (indoor/standard) | | **M** | Multi-sensor / multi-directional |
| **V** | Vandal dome (IK10) | | **P** | PTZ |
| **O** | Bullet (outdoor cylindrical) | | **U** | Positioning (PTZ unit) |
| **E** | Flateye (low-profile/turret) | | **Z** | Zoom box |

> `XNV` = Wisenet X, Network, Vandal dome · `XNO` = X, Network, Bullet · `QND` = Q, Network, Dome ·
> `PNM` = Premium, Network, Multi-sensor · `LNO` = Lite, Network, Bullet. A vandal dome and a
> bullet with the same digits are typically the **same internals in a different housing**.

### Position 4 — Grade (optional letter immediately before the digits)

This explains models like **ANE-L7012R**: the **L is a grade code, not part of the resolution
number**.

| Code | Grade | | Code | Grade |
|---|---|---|---|---|
| *(none)* | Basic | | **L** | Lite |
| **A** | AI | | **V** | Value |
| **C** | Core AI | | **K** | Korea online channel |
| **E** | Entry | | **I** | India market |

### Positions 5–7 — Resolution + lens (numeric block)

Leading digit = resolution-class hint; later digits encode lens type / model series.

| Lead digit | Approx. resolution class |
|---|---|
| 4 | VGA / sub-megapixel |
| 6 | 2 MP (1080p) |
| 7 | 4 MP |
| 8 | 5–7 MP |
| 9 | 4K / 8 MP+ |

> `8080` → 5 MP-class + motorized-varifocal series · `6120` → 2 MP-class with **12× optical zoom**
> ("12"). Treat the resolution digit as a **class hint**, then confirm exact MP on the datasheet.

### Tail — Feature suffixes

| Suffix | Meaning |
|---|---|
| **R** | IR illumination (on thermal models: "Radiometric") |
| **VD** | Multi-directional / multi-sensor variant (PNM domes) |
| **W** | Wiper, or White housing (model-dependent) |
| **T** | Thermal · **V** | Vandal (as suffix) |
| **/LPR** | License-Plate-Recognition-tuned variant |

---

## 3. Recorder & VMS Naming

Recorders mirror the camera tier letters, with **R = Recorder** in position 2:

| Prefix | Decode | Tier |
|---|---|---|
| **PRN-** | Premium Recorder Network | Top NVR — RAID 5/6, enterprise |
| **XRN-** | X Recorder Network | Mid-range NVR (most common pro line) |
| **QRN-** | Q Recorder Network | Entry NVR — ≤16 ch, no RAID |
| **ARN-** | A Recorder Network | SMB / value NVR |
| **HRX-** | Hybrid recorder (analog + IP) | Pentabrid/hybrid |

- **Channel count is in the digits.** `XRN-1610S` = 16-ch NVR with built-in **S**witch (PoE);
  `XRN-410S` = 4-ch; `XRN-6410DB4` = 64-ch. Trailing letters = features (S = PoE switch, B = bay
  variant) + generation number.
- **Wisenet WAVE** = Hanwha's open, license-based **VMS software** (per-camera recording licenses),
  standalone or on **WAVE appliances**. Contrast with the xRN NVR line, which records IP cameras
  **license-free**. In a VMS integration: treat "WAVE" as software/appliance, xRN as hardware NVR.

---

## 4. Technology Glossary

| Tech | What it does |
|---|---|
| **WiseStream I/II/III** | AI-assisted compression — varies encode bitrate by region (objects vs background). With H.265, **WiseStream III cuts bandwidth up to ~80%**. |
| **WiseNR / WiseNR II** | AI noise reduction — reduces low-light blur/noise on moving objects; II adds AI Preferred Shutter. |
| **WiseAI** | On-camera AI engine (object detection/classification, attribute/BestShot metadata) on the Wisenet SoC. |

---

## 5. Fully-Decoded Examples

### `QNV-8080R` — vandal dome

| Segment | Value | Meaning |
|---|---|---|
| Q / N / V | series / type / shape | Wisenet Q / Network / Vandal dome (IK10) |
| 8080 | digits | 5 MP-class sensor, motorized-varifocal series "80" |
| R | suffix | Built-in IR |

### `XNO-6120R` — bullet (verified: 2 MP, 12× zoom)

| Segment | Value | Meaning |
|---|---|---|
| X / N / O | series / type / shape | Wisenet X / Network / Bullet |
| 6120 | digits | 2 MP class ("6"), **12× optical zoom** ("12") |
| R | suffix | IR |

### `PNM-9000VD` — multi-sensor (verified: 2 × 5 MP)

| Segment | Value | Meaning |
|---|---|---|
| P / N / M | series / type / shape | Premium / Network / Multi-sensor |
| 9000 | digits | 4K/8MP-class platform (2× 5 MP modular sensors) |
| VD | suffix | Multi-directional dome variant |

### `ANE-L7012R` — entry flateye (shows the *grade* field)

| Segment | Value | Meaning |
|---|---|---|
| A / N / E | series / type / shape | Wisenet A (entry) / Network / Flateye |
| **L** | **grade** | **Lite** (grade letter — NOT part of the number) |
| 7012 | digits | 4 MP class ("7"), fixed-lens series "012" |
| R | suffix | IR |

> Siblings: `ANV-L7012R` = same camera as Vandal dome · `ANO-L7012R` = same as Bullet. Only the
> shape letter (E/V/O) changes.

---

## 6. Cheat-Sheet

| Field | Key codes |
|---|---|
| **Series (1st)** | P Premium · X Versatile/Excellent · Q Quality · A entry · L Lite · T Vertical(thermal) · H HD+/AHD |
| **Type (2nd)** | N Network · C Analog · U UTP |
| **Shape (3rd)** | B Box · D Dome · V Vandal dome · O Bullet · E Flateye · F Fisheye · M Multi-sensor · P PTZ · U Positioning · Z Zoom box |
| **Grade (pre-digit)** | A AI · C Core AI · L Lite · E Entry · V Value |
| **Suffix** | R IR · VD multi-directional · T thermal · W wiper/white · /LPR license-plate |
| **Recorders** | PRN premium NVR · XRN mid NVR · QRN entry NVR · ARN SMB NVR · (digits = channels; S = PoE switch) |
| **VMS** | WAVE = software/appliance (licensed) · xRN = hardware NVR (license-free) |

---

## Sources
- Official global product naming rule — https://www.hanwhavision.com/en/product-naming-rule/
- Hanwha Vision America — Naming Convention — https://hanwhavisionamerica.com/resources/naming-convention/
- Hanwha support — product model naming rules & standards — https://support.hanwhavision.com/hc/en-us/articles/26337417606041-Guide-to-product-model-naming-rules-and-standards
- Network Webcams — Wisenet naming convention guide — https://www.networkwebcams.co.uk/blog/wisenet-product-naming-convention-guide/
- WiseStream III — https://hanwhavisionamerica.com/technologies/intelligent-video-audio-technologies/wisestream-iii-technology/ · Wisenet 9 — https://www.hanwhavision.com/en/technology/wisenet9/
- Example models: XNO-6120R — https://hanwhavisionamerica.com/product/xno-6120r/ · PNM-9000VD — https://www.hanwhavision.com/en/products/camera/network/multi-sensor/pnm-9000vd/ · ANE-L7012R — https://nellyssecurity.com/products/hanwha-wisenet-4mp-weatherproof-ip-turret-security-camera-with-a-3mm-fixed-lens-ane-l7012r
- NVR examples: XRN-6410DB4 — https://www.hanwhavision.com/en/products/video-recorder/nvr/ch64/xrn-6410db4/ · Wisenet WAVE appliances — https://hanwhavisionamerica.com/recording-solutions/wisenet-wave-vms-appliances/
