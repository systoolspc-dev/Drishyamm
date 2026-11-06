# Hikvision — Camera & Recorder Model-Number Decoding

> A working reference for decoding Hikvision model strings (IP cameras, Turbo HD analog cameras,
> NVRs, DVRs). Hikvision has never published a single fully-authoritative public legend, so
> conventions below are cross-referenced from multiple reseller decode guides **and confirmed
> against official Hikvision product pages/datasheets**. Caveats are flagged inline.
> ⟵ Back to [index](README.md).

---

## 1. Company Overview

**Hikvision** (Hangzhou Hikvision Digital Technology Co., Ltd.) is the world's largest manufacturer
of video surveillance equipment, headquartered in **Hangzhou, Zhejiang, China**. It is majority
state-owned (controlling shareholder is China Electronics Technology Group Corporation, CETC).
Product scope spans IP network cameras, analog/Turbo HD (HD-TVI) cameras, PTZ cameras, NVRs, DVRs,
access control, intercom, alarm/intrusion, thermal, LED displays, and the **HikCentral** VMS.

**Regulatory status (US/UK):**
- **NDAA Section 889** (US, FY2019 NDAA) prohibits federal agencies and contractors from procuring
  or using Hikvision (and Dahua, Huawei, ZTE, Hytera) equipment — origin of the "NDAA-compliant"
  label buyers screen for. Extends to subsidiaries and OEM/rebranded equipment.
- **FCC "Covered List" / Secure Equipment Act:** On **25 Nov 2022** the FCC barred new equipment
  authorizations for Hikvision/Dahua gear deemed a national-security risk; tightened further
  2024–2025.
- **UK:** Nov 2022, the government instructed departments to stop installing Hikvision/Dahua cameras
  on sensitive government sites and consider removing existing ones.

**Sub-brands / affiliates:** **HiLook** (value/entry sub-brand — shares Hikvision DNA, generally
also treated as non-NDAA-compliant), **EZVIZ** (consumer cloud cameras), **Pyronix** (UK intrusion
alarms, acquired 2016).

---

## 2. IP Camera Naming — the `DS-2CD…` Family

### 2.1 Overall structure

```
DS-2CD 2 3 4 7 G2 - LU
│      │ │ │ │ │    └── Suffix: features (IR, audio/alarm I/O, white light, mic, Wi-Fi, motorized lens…)
│      │ │ │ │ └─────── Generation marker (G0/G1/G2/G3)
│      │ │ │ └───────── Resolution digit (sensor MP)
│      │ │ └─────────── Sensor / imaging-tech digit (IR vs ColorVu)
│      │ └───────────── Form-factor digit (dome/turret/bullet/cube/fisheye…)
│      └─────────────── Product-level / series-tier digit (1/2/4/5/6/7…)
└────────────────────── Fixed prefix: DS-2CD = network (IP) camera
```

> ⚠️ Hikvision reuses/repurposes letters over time and publishes no single authoritative key.
> Treat the per-digit tables as the consensus decode confirmed against official pages — but verify
> unfamiliar codes against the actual datasheet.

### 2.2 Prefix `DS-2CD` and signal-type letter

- **DS-** = universal Hikvision prefix ("Digital Surveillance"). **2** = camera product range.
  **C** = camera (color/day-night).
- **3rd letter = signal type:** `CD` → network/IP (`DS-2CD…`) · `CE` → Turbo HD/analog (`DS-2CE…`,
  §3) · `DE`/`DF` → PTZ (`DS-2DE…`, `DS-2DF…`) · `TD` → thermal (`DS-2TD…`).

### 2.3 First core digit — product-level / series tier

| Digit | Tier / series |
|---|---|
| **1** | Value / EasyIP entry (`DS-2CD1…`) |
| **2** | Pro / mainstream (the bulk of the lineup, `DS-2CD2…`) |
| **4** | Smart / Pro Series (advanced analytics) |
| **5** | Higher-tier Pro |
| **6** | DarkFighter / Pro ultra-low-light + specialty (PanoVu/multi-sensor) |
| **7** | Top-tier / Ultra |

### 2.4 Second core digit — form factor

| Digit | Form factor |
|---|---|
| **0** | Fixed mini-bullet / box |
| **1** | Fixed dome / varifocal dome |
| **3** | Fixed turret ("eyeball"/EXIR turret) |
| **4** | Cube / compact |
| **5** | Mini dome / outdoor dome |
| **6** | Varifocal bullet |
| **7** | Varifocal dome |
| **9** | Fisheye / PanoVu (panoramic) |

> ⚠️ A competing reseller scheme assigns these slightly differently. The four rock-solid anchors
> are **1 = dome, 3 = turret, 6 = bullet, 9 = fisheye**. Confirm odd cases on the datasheet.

### 2.5 Third core digit — sensor / imaging technology

| Digit | Imaging line |
|---|---|
| **4** | Standard IR / AcuSense (infrared night vision) |
| **6** | DarkFighter (ultra-low-light, B/W at night, starlight sensor) |
| **7** | ColorVu (24/7 full-color, supplementary white light) |

### 2.6 Fourth core digit — resolution (sensor MP)

| Digit | Resolution | | Digit | Resolution |
|---|---|---|---|---|
| **2** | 2 MP (1080p) | | **6** | 6 MP |
| **3** | 3 MP | | **8** | 8 MP (4K) |
| **4** | 4 MP | | **C** | 12 MP |
| **5** | 5 MP | | | |

> Parse **position-by-position**, not by eye — resolution and sensor-line digits sit adjacent.
> Worked examples in §7 show the unambiguous parse.

### 2.7 Generation marker — `G0 / G1 / G2 / G3`

| Marker | Generation |
|---|---|
| (none) / **G0** | 1st generation |
| **G1** | 2nd generation |
| **G2** | 3rd gen — mainstream **AcuSense** / ColorVu Gen-2 era |
| **G3** | 4th gen — AcuSense-enhanced latest |

> "G2 ColorVu" = 2nd-gen ColorVu cameras that **also embed AcuSense** human/vehicle classification
> on the same unit (e.g. `DS-2CD2347G2-LU`).

### 2.8 Suffix legend (letters after the dash)

| Suffix | Meaning |
|---|---|
| **I** | Built-in IR illuminator (with `-I3/I5/I8` ≈ 30/50/80 m IR range) |
| **F** | Built-in micro-SD slot (onboard storage) |
| **H** | Built-in heater (low-temp outdoor) |
| **WD / WDR** | Wide Dynamic Range |
| **W** (suffix) | Wi-Fi · **WS** = Wi-Fi + alarm/audio I/O |
| **Z** | Motorized varifocal / zoom lens |
| **S** | Dry-contact alarm I/O + audio in/out interface |
| **U** | Built-in microphone (audio) |
| **L** | White-light supplement LED (ColorVu) / "smart hybrid light" |
| **LU** | White light + microphone (typical ColorVu+mic turret) |
| **LS** | White light + alarm/audio I/O |
| **LSU** | White light + alarm I/O + microphone |
| **/SL** | **S**iren + strobe **L**ight (active deterrence) — e.g. `…-LSU/SL` |
| **PWS** | Power + Wi-Fi + alarm I/O variant |
| **B** | Black housing / no-SD variant (series-dependent) |
| **POWERED-BY-DARKFIGHTER** | DarkFighter ultra-low-light branding |

> Official confirmation: Hikvision's page for `DS-2CD2387G2-LSU/SL` titles it "8 MP ColorVu Strobe
> Light and Audible Warning" turret — confirming L = white light, S = alarm/audio I/O, U = mic,
> /SL = siren+strobe. Lens focal length (e.g. 2.8 mm) is usually a separate SKU field; `Z` flags a
> motorized varifocal lens.

### 2.9 PTZ note (`DS-2DE…` / `DS-2DF…` / `DS-2SE…`)

PTZ strings encode size/series, resolution, optical-zoom factor, then suffix —
e.g. `DS-2DE4225IW-DE` ≈ 4-inch, 2 MP, 25× optical zoom PTZ with IR. **TandemVu** dual-lens PTZ
(fixed panoramic + PTZ lens in one body) appear under `DS-2SE…`.

---

## 3. Turbo HD / Analog (HD-TVI) Camera Naming — the `DS-2CE…` Family

### 3.1 Structure

```
DS-2CE 16 D 0 T - IT3
│      │  │ │ │   └── Suffix: features (IR, ColorVu, audio, PoC…)
│      │  │ │ └────── Signal letter: T = Turbo HD (HD-TVI)
│      │  │ └──────── Generation digit
│      │  └────────── Resolution letter (D=2MP, K=3K, H=5MP, U/F=8MP)
│      └───────────── Two-digit form-factor/series block (16/17 bullet, 56/76 turret…)
└──────────────────── Prefix: DS-2CE = Turbo HD / analog camera
```

### 3.2 Form-factor block & resolution letter

| Block | Form factor | | Letter | Resolution |
|---|---|---|---|---|
| **16 / 17** | Bullet / mini-bullet | | **D** | 2 MP (1080p) |
| **56** | Turret ("eyeball") | | **K** | 3K (≈5 MP "3K") |
| **76** | Turret / dome (higher) | | **H** | 5 MP |
| **12 / 10** | Mini / cube | | **U** | 8 MP (4K) |
| **55 / 71** | Dome | | **F** | 8 MP / fixed-lens (series-dependent) |

- **T** = Turbo HD (HD-TVI) signal. Digit before `T` = generation/revision.

### 3.3 Turbo HD suffix legend

| Suffix | Meaning |
|---|---|
| **I / IT / IT3 / IT5** | IR (EXIR); trailing digit ≈ IR distance |
| **P** | PoC (Power over Coax) / audio bundle (series-dependent) |
| **F** | Fixed lens / built-in audio (series-dependent) |
| **S** | Built-in microphone / audio |
| **L** | White-light "Smart Hybrid Light" (ColorVu analog) |
| **EXIR** | Enhanced IR |

> Official examples: `DS-2CE16D0T-ITPFS` = "2 MP Audio Fixed Mini Bullet"; `DS-2CE16K0T-LPFS` =
> "3K Smart Hybrid Light Audio Fixed Mini Bullet"; `DS-2CE10KF0T-PFS` = "3K ColorVu Audio Fixed
> Mini Bullet."

---

## 4. NVR Naming — `DS-7600 / 7700 / 8600 / 9600 NI(…)` Series

### 4.1 Structure (decode of `DS-7608NI-E2/8P`)

```
DS- 76 08 N I - E 2 / 8P
│   │  │  │ │   │ │   └── /xP = built-in PoE switch with x ports (here 8)
│   │  │  │ │   │ └────── SATA count: number of HDD bays (here 2)
│   │  │  │ │   └──────── Performance/generation letter (E/K/I/Q/M…)
│   │  │  │ └──────────── I = International
│   │  │  └────────────── N = Network (NVR). NXI = NVR with embedded AcuSense
│   │  └───────────────── Channel count (08 = 8ch)
│   └──────────────────── Series / chassis tier (76/77/86/96)
└──────────────────────── DS- prefix
```

### 4.2 Series tier & letters

| Series | Tier | | Letter | Meaning |
|---|---|---|---|---|
| **76xx** | Mainstream NVR | | **NI** | Standard NVR |
| **77xx** | Pro NVR | | **NXI** | NVR with **embedded AcuSense** |
| **86xx** | Higher Pro | | **Q / K / I** | Value / Performance / Professional tier |
| **96xx** | Ultra (high ch, RAID) | | digit after letter | number of SATA HDD bays |

- **`/xP`** = built-in PoE switch, x ports (`/8P`, `/16P`). No `/P` = no built-in PoE.
- **RAID** is a property of 96xx (and some 86xx) multi-bay chassis — read the bay count, not a letter.

> Example: `DS-7616NI-I4/16P` = 16-ch, Network, International, **Professional (I)** series,
> **4 HDD bays**, **16 PoE ports**.

---

## 5. DVR / Turbo HD Recorder Naming — `DS-7200 / 7300 H_HI` Series

### 5.1 Structure (decode of `DS-7308HUHI-K4`)

```
DS- 73 08 HUHI - K 4
│   │  │  │      │ └── SATA count: HDD bays (here 4)
│   │  │  │      └──── Performance/generation letter (K, F, SH, M…)
│   │  │  └─────────── H_HI block = recorder family + max resolution class
│   │  └────────────── Channel count (08 = 8ch)
│   └───────────────── Series tier (72 = compact, 73 = Pro)
└──────────────────── DS- prefix
```

### 5.2 The `H_HI` middle-letter = max resolution class

| Code | Max resolution class |
|---|---|
| **HGHI** | up to 1080p Lite / 720p-class economy |
| **HQHI** | up to 1080p (2 MP) full |
| **HUHI** | up to 5 MP / 8 MP (4K) — "Ultra" |
| **HTHI** | up to 8 MP (4K) high-density tier |

- Leading **`iDS-…`** = **AcuSense DVR** (embedded human/vehicle detection on the recorder).
- Performance letters `K/F/SH/M` = chassis generation; the **digit after = SATA bay count**.
- These DVRs are typically **5-in-1 penta-brid** (TVI/AHD/CVI/CVBS + IP).

---

## 6. Technology Naming → How It Shows in Model Numbers

| Technology | What it does | Where in the SKU |
|---|---|---|
| **AcuSense** | On-device human/vehicle classification → fewer false alarms | IP cams: **G2/G3** · DVR: **`iDS-`** prefix · NVR: **`NXI`** |
| **ColorVu** | 24/7 full-color in darkness via white light | IP: sensor digit **`7`** + **`L`** suffix · analog: res-line + **`L`** |
| **DarkFighter** | Ultra-low-light B/W/starlight (no white light) | IP: sensor digit **`6`** / `-POWERED-BY-DARKFIGHTER` |
| **TandemVu** | One body: fixed panoramic lens + moving PTZ lens | PTZ under **`DS-2SE…`** |

> Memory aid: **`7`+`L` = ColorVu**, **`6` = DarkFighter**, **`G2/G3`/`iDS`/`NXI` = AcuSense**,
> **`2SE` = TandemVu PTZ**.

---

## 7. Fully-Decoded Real Examples

### `DS-2CD2347G2-LU` — IP ColorVu turret

| Segment | Value | Meaning |
|---|---|---|
| `DS-2CD` | prefix | Network (IP) camera |
| `2` | tier | Pro / mainstream |
| `3` | form factor | Fixed turret |
| `4` | sensor line | imaging line |
| `7` | resolution/sensor | with `G2` → 4 MP **ColorVu** |
| `G2` | generation | AcuSense + ColorVu Gen-2 |
| `-L` / `U` | suffix | White light / built-in mic |

→ **4 MP Gen-2 ColorVu turret, AcuSense, white-light, mic.**

### `DS-2CD2387G2-LSU/SL` — IP ColorVu deterrence turret

| Segment | Value | Meaning |
|---|---|---|
| `DS-2CD` | prefix | IP camera |
| `2` / `3` | tier / form | Pro / fixed turret |
| `8` / `7` | resolution / sensor | **8 MP (4K)** / **ColorVu** |
| `G2` | generation | AcuSense + ColorVu Gen-2 |
| `-L` / `S` / `U` | suffix | White light / alarm+audio I/O / mic |
| `/SL` | suffix | **Siren + strobe Light** (active deterrence) |

→ **8 MP ColorVu turret, AcuSense, alarm I/O, mic, siren+strobe warning.**

### `DS-2CD2635FWD-IZS` — IP varifocal bullet

| Segment | Value | Meaning |
|---|---|---|
| `DS-2CD` / `2` / `6` | prefix / tier / form | IP / Pro / **varifocal bullet** |
| `3` / `5` | resolution / sensor | 3 MP |
| `FWD` | features | SD slot (F) + WDR |
| `-I` / `Z` / `S` | suffix | IR / motorized zoom / alarm+audio I/O |

→ **3 MP varifocal bullet, SD, WDR, IR, motorized zoom, alarm/audio I/O.**

### `DS-2CE16D0T-ITPFS` — Turbo HD analog bullet

| Segment | Value | Meaning |
|---|---|---|
| `DS-2CE` / `16` | prefix / form | Turbo HD analog / mini-bullet |
| `D` / `0` / `T` | resolution / gen / signal | 2 MP (1080p) / gen / Turbo HD |
| `-IT` / `P` / `F` / `S` | suffix | IR EXIR / PoC / fixed lens / audio |

→ **2 MP Turbo HD fixed mini-bullet, IR, PoC, audio.**

### `DS-7616NI-I4/16P` — NVR with PoE

| Segment | Value | Meaning |
|---|---|---|
| `76` / `16` | series / channels | 7600 NVR / 16 IP channels |
| `N` / `I` | type / region | Network / International |
| `-I` / `4` / `/16P` | tier / bays / PoE | Professional / 4 HDD bays / 16 PoE ports |

### `DS-7308HUHI-K4` — Turbo HD DVR

| Segment | Value | Meaning |
|---|---|---|
| `73` / `08` | series / channels | 7300 Pro DVR / 8 ch |
| `HUHI` | family/res | penta-brid, **Ultra** (5 MP/4K class) |
| `-K` / `4` | performance / bays | K-gen chassis / 4 HDD bays |

→ Prefix `iDS-` for the AcuSense variant.

---

## 8. Cheat-Sheet — Most Useful Codes

| Code | Meaning |
|---|---|
| **I** / **Z** / **F** | IR / motorized zoom / SD slot (analog: F=fixed lens) |
| **H** / **WDR** | Heater / Wide Dynamic Range |
| **S** / **U** | Alarm+audio I/O / microphone |
| **L** / **LU** / **LS** / **/SL** | White light / +mic / +alarm I/O / siren+strobe |
| **W / WS / PWS** | Wi-Fi variants |
| **G0/G1/G2/G3** | Generation 1/2/3/4 (G2/G3 = AcuSense era) |
| **7+L / 6** | ColorVu / DarkFighter (sensor digit) |
| **iDS- / NXI** | Embedded AcuSense (DVR / NVR) |
| **/xP** | Built-in PoE switch, x ports (NVR) |
| **Q / K / I** + digit | NVR/DVR tier (value/performance/professional) + SATA bay count |
| **HGHI/HQHI/HUHI/HTHI** | DVR max-res class (720p/1080p/5MP-4K/4K-density) |

---

## Confidence & Caveats
- **High confidence:** prefix scheme (`DS-2CD/2CE/2DE/2SE`), `G0–G3`, ColorVu=`7`+`L`,
  DarkFighter=`6`, AcuSense=`iDS`/`NXI`/G2+, NVR `/xP` & SATA-digit, DVR `H_HI` tiers, L/S/U/SL
  suffixes (officially confirmed).
- **Verify per model:** the exact form-factor digit↔shape map (only 1/3/6/9 rock-solid) and a few
  overloaded letters (`F`, `P`, `D`, `S`) whose meaning is series-dependent. For a production VMS
  catalog, anchor each SKU to its **official datasheet title** rather than purely algorithmic
  decoding — Hikvision reuses letters.

---

## Sources

**Official Hikvision product pages / datasheets:**
- `DS-2CD2387G2-LSU/SL` — https://www.hikvision.com/en/products/IP-Products/Network-Cameras/Pro-Series-EasyIP-/ds-2cd2387g2-lsu-sl/
- `DS-2CD2347G2-LSU/SL` — https://www.hikvision.com/en/products/IP-Products/Network-Cameras/Pro-Series-EasyIP-/ds-2cd2347g2-lsu-sl/
- `DS-2CE16D0T-ITPFS` — https://www.hikvision.com/en/products/Turbo-HD-Products/Turbo-HD-Cameras/Value-Series/ds-2ce16d0t-itpfs/
- `DS-2CE16K0T-LPFS` — https://www.hikvision.com/en/products/Turbo-HD-Products/Turbo-HD-Cameras/Value-Series/ds-2ce16k0t-lpfs/
- `DS-2CE10KF0T-PFS` — https://www.hikvision.com/en/products/Turbo-HD-Products/Turbo-HD-Cameras/ColorVu-Series/ds-2ce10kf0t-pfs/
- TandemVu PTZ — https://www.hikvision.com/en/products/IP-Products/PTZ-Cameras/tandemvu-ptz-cameras/
- DS-7300HUHI-K4 datasheet — https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000132/S000000133/S000000134/OFR000180/M000005751/Data_Sheet/Datasheet-of-DS-7300HUHI-K4_V4.2.0_20220301.pdf
- NVR Comparison Chart (Q/K/I) — https://www.hikvision.com/content/dam/hikvision/usa/marketing/materials/product-tools/NVR-Comparison-Chart.pdf

**Reseller / reference decode guides:**
- CCTV Empire — Hikvision Product Naming Guide — https://www.cctvempire.co.uk/hikvision-product-naming-guide
- Network Webcams — Hikvision IP camera model numbers — https://www.networkwebcams.co.uk/blog/2019/04/03/hikvision-model-numbers-meaning/
- SecurityCamCenter — Hikvision Naming Rules — https://securitycamcenter.com/hikvision-naming-rules/
- VueVille — Hikvision Network Camera Guide — https://www.vueville.com/home-security/cctv/ip-cameras/hikvision-network-camera-guide/
- Broadband Buyer — IP / analogue / DVR part codes — https://www.broadbandbuyer.com/advice/3280-understanding-hikvision-ip-camera-part-codes/
- NetView CCTV — Hikvision Model Name Coding Rules — https://netviewcctv.co.uk/blog/post/hikcoderules

**Official naming-rule decks (PDF, image-heavy — used for structure cross-check):**
- Hikvision Academy "Product Naming Rule" — https://bus-sitech.de/mt-content/uploads/2024/09/hikvision-naming-rule-v1.pdf
- Anixter "Hikvision Naming" — https://www.anixter.com/content/dam/Suppliers/Hikvision/Hikvision-Naming.pdf
- NVR/DVR "Model Name Coding Rule" (`DS-7608NI-E2/8P`) — https://hooshmandafzar.com/wp-content/4vip/hikvision-name-rule-2022-1.pdf

**Regulatory:**
- CRS — FCC equipment-authorization ban — https://www.congress.gov/crs-product/LSB10895
- IPVM — Where Dahua and Hikvision Are Banned — https://ipvm.com/reports/hikua-bans
- SCW — NDAA compliance / the ban — https://www.getscw.com/knowledge-base/the-ban
