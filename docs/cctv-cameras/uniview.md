# Uniview (UNV) — Camera & Recorder Model-Number Decoding

> Decoding scheme for Uniview / UNV IP cameras and NVRs. High-confidence — corroborated by two
> independent reseller decoder guides plus official Uniview product pages.
> ⟵ Back to [index](README.md).

---

## 1. Company Overview

| Attribute | Detail |
|---|---|
| Legal name | Zhejiang Uniview Technologies Co., Ltd. (brand "Uniview" / "UNV") |
| Founded / HQ | 2005 · Hangzhou, Zhejiang, China |
| Market position | Widely cited **3rd-largest IP video surveillance provider** (behind Hikvision and Dahua); historically the #1 *pure-IP* specialist in China |
| Scope | IP cameras (IPC), NVRs, XVRs, PTZ, access control, video walls, VMS, AIoT |
| **NDAA status** | Marketed as **NDAA-compliant** (resellers cite ~95% of SKUs). **Not** on the FCC "Covered List" that names Hikvision/Dahua/Huawei/Hytera. Still — verify per-SKU and per-procurement; compliance is asserted by Uniview/resellers, not a blanket federal certification. |
| Series / families | **Easy** (EasyBasic, EasyStar), **Prime** (Prime-I/II/III/IV), **Pro** (incl. Pro AlphaView); thematic: **OwlView** (low-light), **Tri-Guard** (active deterrence), **ColorHunter/LightHunter** (illumination), **MultiView/OmniView** (multi-sensor) |

---

## 2. IP Camera Naming — the `IPC…` Family

### 2.1 Structure

```
IPC  3 6 1 4  SB - A D F28 K M C - I0
│    │ │ │ │  │    │ │ │   │ │ │   └── IR/AI generation (-I0 gen1, -I1 gen2; -G/-H = HW rev)
│    │ │ │ │  │    └─┴─┴───┴─┴─┴───── feature/lens block (A mic, D WDR, F28 2.8mm, K SD, M metal, C speaker)
│    │ │ │ │  └──────────────────── series marker (LB/LE Easy, SB/SS/SE/SA Prime, EA Pro)
│    │ │ │ └─────────────────────── resolution (last digit: 2/4/5/8/C MP)
│    │ │ └───────────────────────── generation digit (usually 1)
│    │ └─────────────────────────── sub-form/design (2-digit, w/ pos.1)
│    └───────────────────────────── form factor (1st digit)
└────────────────────────────────── IPC = IP Camera
```

### 2.2 Form factor (1st digit) & sub-form (first two digits)

| 1st digit | Form factor | | 2-digit | Design |
|---|---|---|---|---|
| `1` | Integrated / cube | | `21` | Mini bullet |
| `2` | **Bullet** | | `22` | Bullet (fixed lens) |
| `3` | **Dome / turret** | | `23` | Varifocal/motorized bullet |
| `5` | Box | | `31` | Mini dome / low-profile |
| `6` | **PTZ dome** | | `32` | Dome (fixed lens) |
| `7` | PTZ bullet | | `36` | Turret / fixed eyeball |
| `8` | Panoramic / fisheye | | | |
| `9` | Dual-lens PTZ | | | |

### 2.3 Resolution (last digit of numeric block)

| Digit | Resolution |
|---|---|
| `2` | 2 MP (1080p) |
| `4` | 4 MP |
| `5` | 5 MP |
| `8` | 8 MP (4K) |
| `C` | 12 MP |

> `IPC2124` = bullet(2)/mini-bullet(21)/gen1/4 MP · `IPC3614` = dome-turret(3)/turret(36)/gen1/4 MP.

### 2.4 Series marker (two letters)

| Code | Series | | Code | Series |
|---|---|---|---|---|
| `LB` | Easy — EasyBasic | | `SE` | Prime-III |
| `LE` | Easy — **EasyStar** | | `SA` | Prime-IV |
| `SB` | **Prime-I** | | `EA` | **Pro AlphaView** |
| `SS` | Prime-II | | `SR/SR3` | (legacy) Standard/Prime marker |

### 2.5 Feature / lens block (letter-by-letter)

| Letter | Meaning | | Letter | Meaning |
|---|---|---|---|---|
| `A` | Built-in audio (mic) | | `K` | MicroSD card slot |
| `B` | PoE support (camera-side) | | `M` | Metal housing |
| `C` | Built-in speaker (two-way / deterrence) | | `H` | Supports 60 fps |
| `D` | WDR | | `W` | Wi-Fi |
| `F`+nn | **Fixed** lens; `F28`=2.8 mm, `F40`=4.0 mm | | `WL` | White-light / **ColorHunter** |
| `X`/`Z`+n | Motorized / varifocal zoom | | `G` | SFP / fiber port (some SKUs) |

> `ADF28KM` = **A**(mic) · **D**(WDR) · **F28**(fixed 2.8 mm) · **K**(SD) · **M**(metal). Add **C**
> → speaker (Tri-Guard active deterrence). Note the leading `A` is **audio**, not part of the lens.

### 2.6 Trailing suffix

| Suffix | Meaning |
|---|---|
| `-I` / `-I0` / `-I1` | Smart-IR + AI line; `-I0` = gen 1, `-I1` = gen 2 |
| `-G` / `-H` | Hardware/chipset revision iterations (platform revs, not feature flags) |
| `-WP` | (OwlView) warm-light/white-light packaging variant |

---

## 3. NVR Naming — `NVR301/302/304/308/501`

```
NVR 3 04 - 16 E P - B
│   │ │    │  │ │   └── hardware revision (-B/-B2)
│   │ │    │  │ └────── PoE: P/EP = built-in PoE switch (number = ports)
│   │ │    │  └──────── class: B Entry · E Enhanced · S Economy · I Intelligence(AI) · X Super-Enhanced
│   │ │    └─────────── channel count (04/08/16/32/64/128/256)
│   │ └──────────────── max HDD bays (01/02/04/08…24)
│   └────────────────── series tier (3 standard/mid; 5/8 enterprise "Project")
└────────────────────── Network Video Recorder
```

| Series | HDD bays | Typical channels |
|---|---|---|
| NVR301 | 1 SATA | 4 / 8 ch (built-in PoE variants) |
| NVR302 | 2 SATA | 8 / 16 ch (+ fisheye dewarp, face, LPR) |
| NVR304 | 4 SATA | 16 / 32 ch |
| NVR308 | 8 SATA | 32 / 64 ch |
| NVR501 | enterprise "Project" high-end, AI-forward | |

---

## 4. Technology

| Name | What it is |
|---|---|
| **LightHunter** | Ultra-low-light color via F1.6 large iris + BSI sensor + noise reduction — color in near-dark **without** supplemental light |
| **ColorHunter** | LightHunter **+** built-in warm/white LEDs for 24/7 full-color (2.0/+/Smart Dual Light auto IR↔warm-light switching) |
| **Tri-Guard** | Active deterrence: smart intrusion + sound-and-light (siren+strobe) linkage; implies speaker (`C`) |
| **Easy / Prime / Pro** | Entry / mid-range-with-AI / enterprise tiers |

---

## 5. Fully-Decoded Examples

### `IPC2124LE-ADF28KM-G` — 4 MP EasyStar bullet

| Segment | Value | Meaning |
|---|---|---|
| IPC / 2 / 21 | type / form / sub-form | IP camera / bullet / mini bullet |
| 2 / 4 | gen / res | gen 2 / **4 MP** |
| LE | series | **EasyStar** |
| A / D / F28 / K / M | features | mic / WDR 120 dB / 2.8 mm fixed / microSD / metal |
| -G | HW rev | platform rev (the `-H` sibling = different rev) |

→ 4 MP bullet, 2.8 mm, Smart IR ~50 m, mic, 120 dB WDR, microSD, NDAA-compliant.

### `IPC3614SB-ADF28KMC-I0` — 4 MP Prime-I Tri-Guard turret

| Segment | Value | Meaning |
|---|---|---|
| IPC / 3 / 36 | type / form / sub-form | IP camera / dome-turret / turret |
| 1 / 4 | gen / res | gen 1 / **4 MP** |
| SB | series | **Prime-I** |
| A / D / F28 / K / M / **C** | features | mic / WDR / 2.8 mm / microSD / metal / **speaker** |
| -I0 | suffix | Smart-IR + AI, gen 1 |

→ 4 MP turret, 30 m IR, mic+speaker, Tri-Guard active deterrence, deep-learning AI.

### `NVR304-16EP-B` — 16-ch PoE NVR

| Segment | Value | Meaning |
|---|---|---|
| NVR / 3 | type / series | recorder / 300-series standard tier |
| 04 / 16 | bays / channels | 4 HDD bays / 16 channels |
| E / P | class / PoE | Enhanced / built-in PoE switch |
| -B | HW rev | hardware revision |

---

## 6. Cheat-Sheet

| Code | Meaning |
|---|---|
| `IPC` / `NVR` / `XVR` | IP camera / NVR / analog-hybrid recorder |
| 1st digit `2/3/6/8` | bullet / dome-turret / PTZ / panoramic |
| last digit `2/4/5/8/C` | 2/4/5/8/12 MP |
| `LB/LE` · `SB/SS/SE/SA` · `EA` | Easy/EasyStar · Prime-I/II/III/IV · Pro AlphaView |
| `A` mic · `C` speaker · `D` WDR · `K` SD · `M` metal · `H` 60fps · `W` WiFi · `WL` ColorHunter | feature letters |
| `F28`/`F40` fixed 2.8/4.0 mm · `Z…` motorized zoom | lens |
| `-I0` / `-I1` | Smart-IR+AI gen 1 / 2 |
| `-G` / `-H` | hardware/platform revision |
| NVR `301/302/304/308` | 1/2/4/8 HDD bays |
| NVR class `B/E/S/I/X` | Entry/Enhanced/Economy/Intelligence/Super-Enhanced |

---

## Sources
- Uniview model-naming guide — XLR Security — https://www.xlrsecurity.com/guide-to-uniview-security-cameras/uniview-model-naming-conventions/
- Uniview part-codes legend — Digital Direct Security — https://www.digitaldirectsecurity.co.uk/uniview-part-codes.html
- Understanding Uniview part codes — Broadband Buyer — https://www.broadbandbuyer.com/advice/4539-understanding-uniview-ip-camera-part-codes/
- IPC2124LE-ADF28(40)KM-H (EasyStar) — Uniview official — https://www.uniview.com/Products/Network_Cameras/Easy_Series/EasyStar_Series/IPC2124LE-ADF28KM-H/
- IPC3614SB-ADF28KMC-I0 (Prime-I Tri-Guard) — Uniview official — https://www.uniview.com/Products/Network_Cameras/Prime_Series/PRIMEI_Series/IPC3614SB-ADF28KMC-I0/
- LightHunter / ColorHunter — Uniview official — https://www.uniview.com/Technology/ColorHunter/ · Smart Dual Light — https://www.uniview.com/Technology/Smart_Dual_Light_Technology/
- LightHunter vs ColorHunter — XLR Security — https://www.xlrsecurity.com/blog/uniview-lighthunter-vs-colorhunter-whats-the-difference/
- NVR series datasheets — https://www.uniview.com/Support/Download_Center/Datasheet/NVR/
- Company / NDAA — Wikipedia — https://en.wikipedia.org/wiki/Uniview · Uniview NDAA statement — https://www.uniview.com/News/News/202401/985663_169683_0.htm
