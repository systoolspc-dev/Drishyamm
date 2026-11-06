# CP Plus — Camera & Recorder Model-Number Decoding

> **Documentation caveat:** CP Plus does **not** publish a formal public model-numbering key. The
> decode below is **inferred** by triangulating dozens of product listings on the official
> cpplusworld.com store and reputable resellers, then cross-checking segments that vary
> one-at-a-time. Treat letter meanings as **strongly-evidenced patterns**, not vendor-certified
> definitions. CP Plus's structure closely mirrors **Dahua's** (see [dahua.md](dahua.md)) because
> the products are largely Dahua OEM/ODM. ⟵ Back to [index](README.md).

---

## 1. Company Overview

| Attribute | Detail |
|---|---|
| Brand owner | **Aditya Infotech Limited (AIL)**, Noida, Uttar Pradesh, India |
| Market position | **Largest CCTV/surveillance brand in India** — ~**20.8%** market share; one of the world's largest CCTV plants (Andhra Pradesh); ~1,000-distributor network |
| Dahua relationship | AIL is the **exclusive India distributor for Dahua**; CP Plus products are largely **Dahua OEM/ODM** (and via the AIL–Dixon 50:50 JV from 2017, locally assembled). *This is why CP Plus model structure mirrors Dahua's letter-coded scheme.* |
| Scope | HDCVI/analog cameras, IP cameras, DVRs, NVRs, PTZ, Wi-Fi/smart-home, intrusion, access control, video door phones |
| IPO | Aditya Infotech listed publicly (IPO mid-2025) |

---

## 2. Camera Naming

General form: `CP - <LINE> - <FORM><sub><RES><LENS><IR> - <variant>`

### 2.1 Prefix & line code

- **`CP-`** = the CP Plus brand.

| Line code | Line |
|---|---|
| `UNC` | **U**nified **N**etwork **C**amera — IP/network cameras |
| `USC` | **U**nified ("Cosmic") **HD** analog/HDCVI (multi-format CVI/AHD/TVI/CVBS) |
| `VAC` | Analog/HD ("Cosmic" Value analog) — older line |
| `UNP` | Network HD (PTZ / premium IP) |
| `GPC` | **Guard+** premium camera line |
| `URC` | Standard-resolution analog camera |

### 2.2 Form-factor letter (1st letter after the line code)

| Letter | Form factor |
|---|---|
| `T` | **Bullet** (turret-style/tubular) — e.g. `CP-UNC-TA…`, `CP-USC-TC…` |
| `D` | **Dome / turret eyeball** — e.g. `CP-UNC-DA…`, `CP-USC-DA…` |
| `B` | Bullet (on some lines) |

The 2nd letter (`A` / `C`) is a sub-series/feature class marker — read it as part of the
form-factor token (UNC `TA`/`DA`; USC `TC`/`DC`).

### 2.3 Resolution code (2 digits)

| Code | Resolution | | Code | Resolution |
|---|---|---|---|---|
| `10` | 1 MP / 720p | | `41` | **4 MP** |
| `21` | **2 MP** (1080p) | | `51` | **5 MP** |
| `24` | **2.4 MP** | | | |

### 2.4 Lens-type letter + IR-distance code

| Token | Meaning |
|---|---|
| `P` | **Fixed ("Prime") lens** (e.g. `…PL2`) |
| `Z` | **Varifocal / motorized zoom** lens (e.g. `…ZL6`) |
| `L`+n | **IR distance**: `L2`≈20 m, `L3`≈30 m, `L6`≈60 m |
| `M` | Built-in **Mic** |
| `C` | "Cosmic"/color or coax-control feature flag |
| `D` | Dual-light / extra feature (on some SKUs) |

**Variant suffix:** `-V2/-V3/-V5` = hardware version/revision; `-Q`, `-D`, `-IC` =
packaging/feature variants.

> `CP-USC-TC51PL2-V3` = CP Plus · USC (Cosmic HD analog) · **T** bullet · C-class · **51**=5 MP ·
> **P**=fixed lens · **L2**=20 m IR · **V3**=rev 3. The sibling `CP-USC-TC51ZL6-V3` swaps to **Z**
> (zoom) + **L6** (60 m IR) — confirming the `P`/`Z` lens and `L2`/`L6` IR pattern.

---

## 3. DVR / NVR Naming

| Prefix | Recorder type |
|---|---|
| `CP-UVR` | **DVR** (analog/HDCVI "Cosmic HD" — multi-format CVI/AHD/TVI/CVBS/IP) |
| `CP-UNR` | **NVR** (network video recorder) |

```
CP-UNR - 2 16 F 2 - I2      CP-UVR - 08 01 L 1 - 4KH
       │ │  │ │   └─ AI tier/gen          │  │  │ │   └─ 4K H.265
       │ │  │ └───── HDD/SATA bays        │  │  │ └───── HDD bays
       │ │  └─────── platform/class       │  │  └─────── platform/class (L Cosmic)
       │ └────────── channels (16)        │  └────────── generation/variant field
       └──────────── series               └──────────── channels (08 = 8-ch)
```

- **UNR**: first digit = series, next 2 = channels (`216` = 16-ch). **UVR**: first 2 digits =
  channels (`0801` = 8-ch, `1601` = 16-ch, `0401` = 4-ch).
- Platform/class letter `F/E/L/K` (F = current AI-capable; E = economy; L = Cosmic line).
  Trailing digit = HDD bays. `-P8` = 8 PoE ports (NVR). `-I/-I2` = AI tier/generation.
  `-4KH / -4KI2` = 4K H.265 / 4K + AI gen-2. `-IC` = feature variant.

---

## 4. Fully-Decoded Examples

### `CP-UNC-TA21PL3` — 2 MP IP bullet

| Segment | Value | Meaning |
|---|---|---|
| CP- / UNC | brand / line | CP Plus / Unified **Network Camera** (IP) |
| T / A | form / sub | **Bullet** / sub-class A |
| 21 | res | **2 MP** (1080p) |
| P / L3 | lens / IR | Fixed lens / **~30 m IR** |

### `CP-USC-TC51PL2-V3` — 5 MP HDCVI bullet

| Segment | Value | Meaning |
|---|---|---|
| CP- / USC | brand / line | CP Plus / Unified "Cosmic" HD analog (CVI/AHD/TVI/CVBS) |
| T / C | form / sub | **Bullet** / C-class |
| 51 | res | **5 MP** |
| P / L2 / V3 | lens / IR / rev | Fixed 3.6 mm / **~20 m IR** / hardware rev 3 |

→ 5 MP multi-format bullet, 3.6 mm fixed, 20 m Smart IR, IP67, switchable CVI/AHD/TVI/CVBS, coax OSD.

### `CP-UNR-216F2-I2` — 16-ch AI NVR

| Segment | Value | Meaning |
|---|---|---|
| CP- / UNR | brand / type | CP Plus / **NVR** |
| 2 / 16 | series / channels | series 2 / **16 channels** |
| F / 2 | platform / bays | current platform / **2 SATA bays** |
| -I2 | AI | **AI tier, gen 2** (face DB, perimeter) |

→ 16-ch NVR, up to 12 MP decode, 2 SATA, H.265, face recognition + perimeter protection.

### `CP-UVR-0801L1-4KH` — 8-ch 4K DVR

| Segment | Value | Meaning |
|---|---|---|
| CP-UVR | type | CP Plus **DVR** |
| 08 / 01 | channels / variant | **8 channels** / generation field |
| L / 1 | platform / bays | Cosmic line / 1 HDD bay |
| 4KH | resolution | **4K H.265** |

---

## 5. Cheat-Sheet

| Code | Meaning |
|---|---|
| `CP-` | CP Plus brand |
| `UNC` / `USC` / `VAC` | IP camera / HDCVI analog (multi-format) / older analog |
| `UNP` / `GPC` | network PTZ-premium / Guard+ |
| `UVR` / `UNR` | DVR / NVR |
| `T…` bullet · `D…` dome/turret | form factor |
| `10/21/24/41/51` | 1 / 2 / 2.4 / 4 / 5 MP |
| `P` fixed lens · `Z` varifocal/zoom | lens type |
| `L2/L3/L6` | 20 / 30 / 60 m IR |
| `M` | built-in mic |
| UVR `0401/0801/1601` | 4 / 8 / 16-ch DVR |
| UNR `108/216` | (series+) 8 / 16-ch NVR |
| `F1/F2` | 1 / 2 HDD bays |
| `-P8` | 8 PoE ports (NVR) |
| `-I / -I2` | AI tier / gen · `-4KH` 4K H.265 · `-V2/V3/V5` hardware revision |

---

## Sources
- CP-UNR-216F2-I2 (16-ch AI NVR) — CP Plus official — https://cpplusworld.com/cp-unr-216f2-i2
- CP-UNR-108F1 (8-ch NVR) — https://cpplusworld.com/cp-unr-108f1
- CP-USC-TC51PL2 / -V3 (5 MP bullet) — https://www.cpplusworld.com/cp-usc-tc51pl2 · https://www.cpplusworld.com/cp-usc-tc51pl2-v3
- CP-USC-TC51ZL6-V3 (60 m varifocal) — https://www.cpplusworld.com/cp-usc-tc51zl6-v3
- CP-UNC examples (TA/DA) — https://www.cpplusworld.com/cp-unc-ta41l3c-d-q · IndiaMART/Multibrand listings
- CP-UVR DVR examples (0401/0801/1601, 4KH) — https://www.cpplusworld.com/cp-uvr-0801l1-4kh · https://www.cpplusworld.com/cp-uvr-1601f1-ic
- Aditya Infotech / Dahua relationship & market share — CARE Ratings — https://www.careratings.com/upload/CompanyFiles/PR/202404130426_Aditya_Infotech_Limited.pdf · ICICI Direct IPO review — https://www.icicidirect.com/mailcontent/idirect_adityainfotech_iporeview-jul_25.pdf
