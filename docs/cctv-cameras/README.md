# CCTV Camera Model-Number Decoding Reference

A working reference for **decoding CCTV camera & recorder model numbers** into their real
capabilities (form factor, resolution, lens, IR/illumination, AI/analytics, recorder channels,
PoE, HDD bays, etc.). Built as integration documentation for the **drisyam** campus VMS, where
being able to infer a device's capabilities directly from its SKU — across thousands of mixed
cameras — saves a lot of manual datasheet hunting.

> **Why not Scribd?** This set was originally requested as a scrape of a Scribd search
> ("Hikvision Camera Model Naming Guide"). Scribd is login/paywalled and JavaScript-rendered, so
> its pages can't be scraped (and bulk-scraping violates its ToS). Instead, each doc below is built
> from **authoritative public sources** — official manufacturer naming-rule PDFs, datasheets,
> product pages, and reputable reseller decoders — which is both legal and more accurate than
> random uploads. Every doc ends with a **Sources** list.

---

## Manufacturers covered

| # | Manufacturer | Doc | HQ | NDAA status | Notes |
|---|---|---|---|---|---|
| 1 | **Hikvision** | [hikvision.md](hikvision.md) | China | ❌ Banned (NDAA/FCC) | World #1; `DS-2CD…` IP, `DS-2CE…` analog |
| 2 | **Dahua** | [dahua.md](dahua.md) | China | ❌ Banned (NDAA/FCC) | World #2; `IPC-…` IP, `HAC-…` HDCVI |
| 3 | **Uniview (UNV)** | [uniview.md](uniview.md) | China | ✅ Marketed compliant | #3 pure-IP; `IPC…`, LightHunter/ColorHunter |
| 4 | **CP Plus** | [cp-plus.md](cp-plus.md) | India | ⚠️ Dahua-OEM | India's #1 brand; `CP-UNC/USC…` |
| 5 | **Hanwha Vision (Wisenet)** | [hanwha-vision.md](hanwha-vision.md) | South Korea | ✅ Compliant | Ex-Samsung Techwin; `XNV/QND/PNM…` |
| 6 | **Axis Communications** | [axis.md](axis.md) | Sweden | ✅ Compliant | Invented the IP camera; `M/P/Q…` |
| 7 | **Bosch** | [bosch.md](bosch.md) | Germany | ✅ Compliant | FLEXIDOME/DINION/AUTODOME; CTN `NDE/NBE…` |
| 8 | **Honeywell** | [honeywell.md](honeywell.md) | USA | ✅ Compliant lines | 30/35/60/70 Series; `HC35…` |

---

## How to read a model number (general approach)

Almost every surveillance SKU packs the same information into a fixed-position string:

```
[BRAND/LINE]  [FORM FACTOR]  [TIER]  [RESOLUTION]  [GENERATION]  - [FEATURE SUFFIXES]
```

The **position** of each field differs by vendor — that's exactly what each doc maps out:

| Field | Where to find it |
|---|---|
| **Form factor** (dome/turret/bullet/PTZ/fisheye) | Hikvision: 2nd core digit · Dahua: `HDW/HFW/HDBW` block · Hanwha: 3rd letter · Axis: 1st digit |
| **Resolution (MP)** | Hikvision/Dahua/Uniview: a digit in the core block · Axis: **last** digit (approx) · Hanwha: leading digit (approx) |
| **Tier / series** | Hikvision: 1st core digit · Dahua: 1st digit after form block · Hanwha/Axis: 1st letter |
| **IR / night vision** | Hikvision/Dahua/Hanwha: `-I`/`-R` · Axis: `-L` |
| **Outdoor / vandal** | Axis: `-E` / `-V` · others: form-factor letter (vandal dome) |
| **AI / analytics** | Hikvision: AcuSense (`G2`/`iDS`/`NXI`) · Dahua: WizSense/WizMind · Bosch: EVA/IVA tier |

### ⚠️ Universal cautions
- **Resolution digits are class hints, not guarantees.** Axis and Hanwha's "resolution digit"
  maps are approximate and drift on modern sensors — always confirm exact MP on the datasheet or
  via the camera's ONVIF-reported capabilities.
- **Letters are overloaded and reused** across series and generations (e.g. Hikvision `F`, `P`,
  `S`; Dahua `-PV` ≠ full-color). When in doubt, anchor a SKU to its **official datasheet title**,
  not pure algorithmic decoding.
- **OEM/rebrand caveat:** CP Plus ≈ Dahua; many budget brands (Amcrest, EmpireTech, ICRealtime,
  LaView, etc.) are Dahua/Hikvision OEMs and decode like their parent — and inherit the same NDAA
  status.

---

## NDAA / regulatory cheat-sheet (US/UK)

| Vendor | NDAA §889 | FCC "Covered List" | Practical effect |
|---|---|---|---|
| Hikvision, Dahua | **Prohibited** | **Yes** (no new authorizations) | Not usable for US federal/contractor; UK removing from sensitive sites |
| Uniview | Marketed compliant | Not listed | Resellers cite ~95% of SKUs compliant; verify per-procurement |
| CP Plus | Dahua-OEM | — | Inherits Dahua hardware lineage; not a US-market concern (India-focused) |
| Hanwha, Axis, Bosch, Honeywell | **Compliant** | Not listed | Eligible for US federal/enterprise; key selling point |

> For drisyam (campus VMS, India, DPDP-driven), NDAA isn't a procurement blocker, but the
> hardware-lineage info matters for **supply-chain risk** and **firmware/feature parity** (CP Plus
> ↔ Dahua sharing the same SoC/firmware family is useful to know during integration).

---

## Per-doc structure

Each manufacturer doc follows the same layout:

1. **Company overview** — who they are, HQ, market position, regulatory status, sub-brands.
2. **IP camera naming** — full position-by-position decode of the model string.
3. **Analog naming** (where applicable — Turbo HD / HDCVI / AHD).
4. **NVR / DVR / XVR naming** — channels, PoE, HDD bays, AI tiers.
5. **Technology glossary** — how marketing tech (ColorVu, WizSense, Lightfinder…) appears in SKUs.
6. **Fully-decoded real examples** — actual SKUs broken into per-segment tables.
7. **Cheat-sheet** — the most useful codes at a glance.
8. **Sources** + confidence notes.

---

_Last updated: 2026-05-30. Maintained as part of the drisyam VMS reference docs._
