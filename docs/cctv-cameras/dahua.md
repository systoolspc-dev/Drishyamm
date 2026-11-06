# Dahua — Camera & Recorder Model-Number Decoding

> A field reference for parsing Dahua Technology model strings (IP cameras, HDCVI analog cameras,
> NVRs, XVR/DVRs). Dahua has revised its public "Name Rule" documents several times
> (2017 → 2022 → 2023), and the meaning of the **series/tier digit drifted** as the AI brands
> (WizSense, WizMind) were introduced — where ambiguous, both readings are given.
> ⟵ Back to [index](README.md).

---

## 1. Company Overview

| Attribute | Detail |
|---|---|
| **Full name** | Zhejiang Dahua Technology Co., Ltd. |
| **Founded / HQ** | 2001 (Fu Liquan, chairman) · Binjiang, Hangzhou, Zhejiang, China |
| **Market position** | World's **#2** video-surveillance vendor (behind Hikvision); Dahua + Hikvision ≈ 40% of the global market |
| **Scope** | IP cameras, HDCVI analog-over-coax, NVR/DVR/XVR, PTZ, fisheye, thermal, ANPR/LPR, access control, DSS VMS |

**US / UK regulatory status:**
- **NDAA §889** (Aug 2018) — bans US federal use of Dahua/Hikvision and their OEMs.
- **BIS Entity List** (Oct 2019) — restricts US-tech exports to Dahua (Xinjiang allegations).
- **FCC "Covered List"** (2021/Nov 2022) — barred new equipment authorizations.
- **UK** (Nov 2022) — removal/prohibition from sensitive central-government buildings.

**Sub-brands & OEM:** **Imou** (consumer smart-home), **Lorex** (acquired 2018, divested Feb 2023
to Skywatch — legacy models still Dahua silicon). Dahua OEMs for many rebadgers: **Amcrest,
EmpireTech, ICRealtime, Montavue, LaView, Swann (some), W Box**, etc. — all share the naming logic
and inherit covered-hardware status.

---

## 2. IP Camera Naming — the `IPC-…` Family

### 2.1 Structure

```
DH - IPC - HFW 2 4 3 1 T P - AS - S2
 │     │    │   │ │ │ │ │ │   │     └── hardware (chipset) generation
 │     │    │   │ │ │ │ │ │   └──────── feature suffix (Audio+Alarm+SD…)
 │     │    │   │ │ │ │ │ └──────────── P = built-in PoE (body code)
 │     │    │   │ │ │ │ └────────────── T = metal turret/bullet build (body code)
 │     │    │   │ │ │ └──────────────── generation/sequence index
 │     │    │   │ │ └────────────────── function/imaging-class digit (Starlight, Full-Color…)
 │     │    │   │ └──────────────────── resolution digit (MP)
 │     │    │   └────────────────────── series/tier digit (1/2/3/4/5…)
 │     │    └────────────────────────── form-factor block (HFW=bullet, HDW=eyeball…)
 │     └─────────────────────────────── IPC = IP/network camera
 └───────────────────────────────────── DH = Dahua house brand (DHI on some SKUs; OEMs drop it)
```

### 2.2 Form-factor block

| Code | Body style | | Code | Body style |
|---|---|---|---|---|
| **HFW** | **Bullet**, IR | | **HDBW** | **Vandal dome**, IR (IK10) |
| **HF / HFS** | Box (no IR) | | **HDB / HDP** | Dome (no IR) |
| **HDW** | **Eyeball / turret**, IR | | **EW / EBW** | (Vandal) IR fisheye |
| **HDPW** | Plastic mini-dome, IR | | **SD** | PTZ / speed dome (own prefix) |

Mnemonic: **W = weatherproof+IR**, **B = vandal-proof ball/dome**, **D = dome/eyeball**, **F =
bullet/box**.

### 2.3 Series / tier digit (1st digit after form factor)

| Digit | Reading | AI brand |
|---|---|---|
| **1** | Entry / Lite / Cooper | basic (SMD only) |
| **2** | Lite / Value | WizSense on newer |
| **3** | **WizSense** mainstream | **WizSense** (edge AI) |
| **4** | Pro | WizSense/WizMind (gen-dependent) |
| **5** | Ultra / **WizMind 5** | **WizMind** (deep-learning AI) |
| **6** | Ultra | WizMind |
| **7 / 8** | Ultra / WizMind 7 / multi-sensor / fisheye | WizMind (top) |

> Practical rule: **3-Series ⇒ WizSense**, **5-Series ⇒ WizMind**, **1/2-Series ⇒ Lite/value**.

### 2.4 Resolution digit (after the series digit)

| Code | MP | | Code | MP |
|---|---|---|---|---|
| 0 | 1 MP (720p) | | 5 | 5 MP |
| 2 | 2 MP (1080p) | | 6 | 6 MP |
| 3 | 3 MP | | 8 | 8 MP (4K) |
| 4 | 4 MP | | 12/16/32 | 12/16/32 MP |

### 2.5 Function / imaging-class digit (after resolution)

| Code | Imaging class |
|---|---|
| 0 | Standard |
| 1 / 2 | WDR / **Starlight** / Starlight+ (low-light color) |
| 3 | Polarlight |
| **9** | **Full-Color** (warm-light, color at night) — e.g. `HDW38`**`49`** = 8 MP Full-Color |

> ⚠️ **Full-Color is the "9" digit, NOT the `-PV` suffix.** `-PV` = active deterrence (TiOC).

### 2.6 Suffix legend (after the hyphen)

| Suffix | Meaning |
|---|---|
| **-A** | Audio (built-in mic) |
| **-S** | SD card slot |
| **-AS** | Audio + Alarm + SD card (most common combo) |
| **-SA / -M** | Mic (+SD) |
| **-Z / -ZS** | Motorized varifocal zoom (+SD) |
| **-VF** | Manual varifocal |
| **-PV** | **Active deterrence / TiOC** — red+blue strobe, siren, two-way audio (*not* full-color) |
| **-T** | Auto-tracking (PTZ) / Turret (context-dependent) |
| **-IL** | Smart Dual Light (IR + warm light) |
| **-W** | Wi-Fi |
| **-LED** | Full-color warm-LED build |
| **-S2 / -S3 / -S4 …** | **Hardware (chipset) generation** — firmware is S#-specific, not cross-flashable |
| **-0280B** | Fixed focal length (0280B = 2.8 mm) |

**WizSense vs WizMind vs Lite:** Lite/Cooper (1/2-Series) = value, little/no edge AI · **WizSense**
(3-Series) = human/vehicle classification, SMD Plus, perimeter (≈ Hikvision AcuSense) · **WizMind**
(5/7-Series) = face recognition, people counting, heat map, ANPR, metadata (≈ Hikvision DeepinView).

---

## 3. HDCVI / Analog Camera Naming — the `HAC-…` Family

**HDCVI** = High-Definition Composite Video Interface (Dahua's HD-over-coax). Prefix **`HAC`**;
the body-style block mirrors IP cameras.

```
DH - HAC - HFW 1 2 00 T L - A
            │   │ │ │  │ │   └── suffix (-A audio, -IL dual light, -LED full-color…)
            │   │ │ │  └─┴───── body/lens code (T metal, L lite housing, M metal mini, VF/Z lens)
            │   │ │ └────────── generation/sequence
            │   │ └──────────── resolution (2 = 1080p/2MP)
            │   └────────────── series tier (1 Lite · 3 Pro · 5 Ultra)
            └────────────────── form factor (HFW bullet, HDW eyeball, HDBW vandal dome…)
```

- Resolution digits: 0/1 = 720p · **2 = 1080p (2 MP)** · 4/5/6 = 4/5/6 MP · 8 = 8 MP (4K).
- HDCVI cameras are tribrid/quadbrid-switchable (HDCVI/CVBS/AHD/TVI) and pair with **XVR** recorders.

---

## 4. NVR Naming — `NVR<Tier><HDD><CH>-<options>`

```
NVR  4   2   08   -8P   -4K   S2
 │   │   │   │     │      │    └── hardware generation (S2/S3)
 │   │   │   │     │      └─────── 4K-capable
 │   │   │   │     └────────────── built-in PoE ports (4/8/16)
 │   │   │   └──────────────────── channel count (04/08/16/32/64…)
 │   │   └──────────────────────── HDD bays (1/2/4/8)
 │   └──────────────────────────── tier: 2 Compact · 4 Lite · 5 Pro/WizMind · 6 Ultra
 └──────────────────────────────── Network Video Recorder
```

- **-nP** = n built-in PoE ports · **-4K / -4KS2** = 4K + hardware gen · **-AI / -ANPR / -I2** =
  AI build/gen · **/L** = cost-reduced L-series · **RAID** typically on 8-bay Pro/Ultra units.

---

## 5. XVR / DVR Naming — `XVR<Tier><HDD><CH><Case>-<options>`

**XVR** = penta-brid recorder (HDCVI + AHD + TVI + CVBS + IP on the same channels).

```
XVR  5   2   08   A   - I3
 │   │   │   │    │     └── AI generation (I/I2/I3)
 │   │   │   │    └──────── chassis case (C/E/H/A/L/S)
 │   │   │   └───────────── channel count (04/08/16/32)
 │   │   └───────────────── HDD bays (1/2/4/8)
 │   └───────────────────── tier: 1 Cooper · 4/5/7 WizSense · 8 WizMind
 └───────────────────────── penta-brid recorder (DVR = older HDCVI-only; HCVR = legacy)
```

- **-nP** = n PoC (Power-over-Coax) ports · **4M / 4KL / 4K** = 4 MP@15 / 4K@7 / 4K@15 fps ·
  **S2 / X / I-I3** = platform gen / H.265 / AI gen.

---

## 6. Technology Naming inside Model Numbers

| Technology | What it is | Where in the SKU |
|---|---|---|
| **WizSense** | Edge AI: human/vehicle, SMD Plus, perimeter w/ target filtering | **3-Series** IP cams; **4/5/7** XVR; NVR4 AI |
| **WizMind** | Deep-learning AI: face, people-count, heatmap, ANPR, metadata | **5/7-Series** IP; NVR5/6; XVR8 |
| **Starlight / Full-Color** | Low-light color / color-at-night warm LED | function digit **1/2** / **9** |
| **TiOC (Three-in-One)** | AI + Full-Color + **Active Deterrence** (strobe+siren+audio) | **`-PV`** suffix |
| **Smart Dual Light** | IR + warm-light auto-switch | **`-IL`** suffix |

---

## 7. Fully-Decoded Real Examples

### `DH-IPC-HFW2431T-AS-S2` — IP bullet

| Segment | Value | Meaning |
|---|---|---|
| IPC / HFW | type / form | IP camera / IR **bullet** |
| 2 / 4 | tier / res | **Lite** / **4 MP** |
| 3 / 1 / T | func / gen / body | imaging class / sequence / metal build |
| -AS / -S2 | suffix / gen | **Audio + Alarm + SD** / hardware gen 2 |

### `DH-IPC-HDW3849H-AS-PV` — IP TiOC Full-Color eyeball

| Segment | Value | Meaning |
|---|---|---|
| IPC / HDW | type / form | IP camera / **eyeball** IR |
| 3 / 8 | tier / res | **WizSense** / **8 MP (4K)** |
| **49 → "9"** | func | **Full-Color** |
| H / -AS | build / suffix | high-spec / Audio+Alarm+SD |
| **-PV** | suffix | **Active deterrence (TiOC)** — strobe+siren |

### `DH-IPC-HDBW5442E-ZE` — IP motorized vandal dome

| Segment | Value | Meaning |
|---|---|---|
| IPC / HDBW | type / form | IP camera / **vandal IR dome** (IK10) |
| 5 / 4 | tier / res | **WizMind** / **4 MP** |
| 42 / E | func/gen / body | Starlight+ / body code |
| **-Z** / E | suffix | **motorized varifocal zoom** / enhanced build |

### `DH-HAC-HDW1200M` — HDCVI eyeball

| Segment | Value | Meaning |
|---|---|---|
| HAC / HDW | type / form | **HDCVI analog** / IR **eyeball** |
| 1 / 2 | tier / res | **Lite** / **2 MP (1080p)** |
| 00 / M | gen / body | generation / metal mini eyeball |

### `DHI-NVR4208-8P-4KS2` — NVR

| Segment | Value | Meaning |
|---|---|---|
| NVR / 4 | type / tier | Network recorder / **Lite** |
| 2 / 08 | bays / channels | **2 HDD bays** / **8 channels** |
| -8P / -4K / S2 | PoE / 4K / gen | **8 PoE ports** / 4K-capable / hardware gen 2 |

### `DH-XVR5208A-I3` — penta-brid XVR

| Segment | Value | Meaning |
|---|---|---|
| XVR / 5 | type / tier | **Penta-brid** / **WizSense** Pro |
| 2 / 08 / A | bays / ch / case | 2 HDD bays / 8 analog ch (+IP) / 1U chassis |
| **-I3** | gen | **AI generation 3** (SMD Plus, perimeter, face) |

---

## 8. Cheat Sheet

**Form factor (after IPC-/HAC-):** `HFW` IR bullet · `HDW` IR eyeball/turret · `HDBW` vandal IR
dome (IK10) · `HDPW` plastic mini-dome IR · `HF/HFS` box · `HDB/HDP` dome · `EW/EBW` (vandal) IR
fisheye · `SD` PTZ.

**Tier digit (IP cam):** `1/2` Lite · `3` **WizSense** · `4` Pro · `5/7` **WizMind** · `8`
WizMind multi-sensor.

**Resolution digit:** `2`=2MP · `4`=4MP · `5`=5MP · `6`=6MP · `8`=8MP/4K.

**Function digit:** `1`=Starlight · `2`=Starlight+ · `9`=**Full-Color**.

| Suffix | Meaning | | Recorder token | Meaning |
|---|---|---|---|---|
| -A / -S / -AS | Audio / SD / Audio+Alarm+SD | | NVR / XVR / DVR | IP / penta-brid / analog |
| -Z / -ZS | Motorized zoom (+SD) | | 1st digit | tier |
| **-PV** | **Active deterrence (TiOC)** | | 2nd digit | HDD bays |
| -IL / -LED | Dual light / full-color LED | | next 2 | channels |
| -S2/-S3 | Hardware generation | | -nP | PoE (NVR) / PoC (XVR) |
| -0280B | 2.8 mm fixed lens | | S2/S3, I/I2/I3 | platform / AI gen |

---

## Confidence Notes
- **`-PV` ≠ full-color** (several reseller pages conflate them). Official Dahua pages confirm `-PV`
  = active deterrence (TiOC); full-color is the **`9` function digit**.
- **Tier digit is version-dependent** — Dahua relabeled the platform digit across the 2017/2022/2023
  Name Rule revisions. Decode tier from **digit + AI brand on the datasheet**, not the digit alone.
- Official Name Rule PDFs are image-based; legends were assembled from the SlideShare transcription
  + official datasheets, cross-checked against real SKUs. Rare suffixes (`-DG`, region codes) vary
  by line — confirm against the specific datasheet.

---

## Sources

**Official Dahua:**
- IPC-HDW3449H-AS-PV-PRO (TiOC/WizSense) — https://www.dahuasecurity.com/products/network-products/network-cameras/WizSense-Series/TiOC/IPC-HDW3449H-AS-PV-PRO
- "Product Naming Rule" V.20231012 (PDF) — https://www.sveistrup.dk/filer/Teknik/Dahua/Manualer/Product%20Naming%20Rule-20231012.pdf
- "Name Rule" V.20220615 (PDF) — https://france.dahuatech.com/upload/202206/15/202206151647279989.pdf
- "Name rules ALL" V.201709 (PDF) — https://s3.amazonaws.com/marketplaces.apcmayorista.com/cloud/academy/dahua-22_noviembre_cap/Name+rules+ALL.pdf
- XVR5208A-I3 datasheet — https://material.dahuasecurity.com/uploads/cpq/prm-os-srv-res/smart/datasheetzipfiles/XVR5208A-I3_V3_datasheet_20230720.pdf
- DHI-NVR4208-8P-4KS2 datasheet — https://www.dahuasecurity.com/asset/upload/uploads/soft/20190115/DHI-NVR4208-8P-4KS2_datasheet_201901141.pdf
- HAC-HDW1200M datasheet — https://www.dahuasecurity.com/asset/upload/uploads/soft/20201109/DH-HAC-HDW1200MP_datasheet_20201106.pdf

**DahuaWiki / transcriptions:**
- DahuaWiki Name Rule — https://dahuawiki.com/Name_Rule
- Identify Model/Serial — https://www.dahuawiki.com/Basic_Setup/Identify_Model_and_Serial_Number
- SlideShare transcription of official Name Rules — https://www.slideshare.net/slideshow/dahua-products-identification-name-rules/269970665

**Reseller / community:**
- Broadband Buyer — Dahua IP / NVR part codes — https://www.broadbandbuyer.com/advice/4212-understanding-dahua-ip-camera-part-codes/
- IPCamTalk — Dahua naming convention — https://ipcamtalk.com/threads/dahua-naming-convention.53567/ · S2 vs S3 — https://ipcamtalk.com/threads/difference-between-_s2-and-_s3.74588/

**Company / regulatory:**
- Wikipedia — Dahua Technology — https://en.wikipedia.org/wiki/Dahua_Technology
- IPVM — Dahua OEM Directory — https://ipvm.com/reports/dahua-oem
- SCW — the ban — https://www.getscw.com/knowledge-base/the-ban
