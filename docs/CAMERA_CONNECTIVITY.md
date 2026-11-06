# Drishyam — Camera Connectivity Guide & "Connectivity Chooser" Feature Design

**Purpose:** the definitive answer to *"how do we connect any camera/NVR to Drishyam — public, dynamic, private, or vendor-cloud — with the least manual work?"* Part 1 is the operational guide (use today). Part 2 is the product spec to make it **automatic** (add-and-go for every case).

---

# Part 1 — The four connectivity scenarios

Every camera/NVR falls into exactly one of these. The whole game is: **can the Drishyam server reach the device, and how.**

| # | Site connectivity | Method | Edge agent? | Manual config |
|---|---|---|---|---|
| 1 | **Static public IP** | Direct (host = IP) | No | None — just IP + creds + brand |
| 2 | **Dynamic public IP** | **DDNS** (host = hostname) + port-forward | No | Only the DDNS hostname |
| 3 | **CGNAT / private LAN** | **Edge relay** (outbound TLS push) | Yes | Agent only (no path/port config) |
| 4 | **Vendor P2P only** | Vendor cloud (Hik-Connect) *or* edge relay | Usually | — |

> Drishyam already **auto-derives the RTSP path** from the brand (`vendors/index.js`: Hikvision/Dahua/CP Plus/UNV/Axis/Bosch/Hanwha). So in scenarios 1 & 2 you never type a path — only host + creds + brand. The manual pain only appears in scenario 3 (edge relay), which Part 2 removes.

---

## Scenario 1 — Static public IP (simplest)
The site has a fixed public IP from the ISP (often a paid business add-on).

**Setup:** point Drishyam's camera `host` at the public IP; port-forward RTSP (554) on the router to the NVR. Add camera → live.

**Pros:** dead simple, stable. **Cons:** static IPs cost money and are exposed to the internet (harden — see Security below).

---

## Scenario 2 — Dynamic public IP + **DDNS** (the Dyn case)

The site has a **real public IP that changes** periodically. **DDNS (Dynamic DNS)** maps a **fixed hostname** to that changing IP.

### What DDNS is
A small client (on the router or the NVR) reports the current public IP to a DDNS provider, which updates the DNS record. You always use the hostname (`site.ddns.net`), which resolves to whatever the IP is right now.

```
Drishyam  ──rtsp://user:pass@burjeel-hq.ddns.net:554/…──▶  Router (port-fwd 554) ──▶ NVR
                         ▲ hostname always resolves to the site's current public IP
```

### Providers (⚠️ Dyn's free tier is gone)
`account.dyn.com` = **Dyn**, the original DDNS provider — but Oracle **retired the free `dyndns.org` service in 2020**; Dyn is now **paid Managed DNS**. For CCTV, use these instead:

| Provider | Cost | Notes |
|---|---|---|
| **NVR vendor DDNS** (Hikvision `hik-online`/Hik-Connect, Dahua **QuickDDNS**, UNV) | Free | **Built into the NVR** — easiest, no extra account |
| **No-IP** | Free (confirm monthly) / paid | Popular, widely supported by NVRs |
| **DuckDNS** | Free | Simple, token-based; great for a router script |
| **Cloudflare (API DDNS)** | Free | Most robust if you own a domain; update via API/cron |
| **Dyn Managed DNS** | Paid | Enterprise; only if already invested |

### Setup on the NVR (built-in DDNS — recommended)
**Hikvision:** Configuration → Network → Basic → DDNS → enable → type (Hik-Connect / DynDNS / NO-IP) → domain + account → Save.
**Dahua / CP Plus:** Setup → Network → DDNS → enable → type (QuickDDNS / NO-IP / Dyndns) → domain + user/pass.
**UNV:** Setup → Network → DDNS → enable → provider + domain + credentials.
Then **port-forward 554** (RTSP) on the router to the NVR, and in Drishyam set `host = the DDNS hostname`.

### When DDNS is the right choice
- The site has a **genuine public IP** (even dynamic).
- You can port-forward on the router.
- **Result in Drishyam:** fully dynamic — enter the hostname once; it survives every IP change. No edge relay.

---

## Scenario 3 — CGNAT / private LAN → **Edge relay**

Most broadband and all mobile/4G connections use **CGNAT** (the ISP shares one public IP across many customers) — so there is **no public IP to point at, and DDNS/port-forward cannot work**. Private-LAN-only cameras (no internet exposure) are the same from the cloud's view. This is the NFC/Sharda case.

**Solution:** an **on-site edge agent** pulls each camera locally and **pushes** it *outbound* to Drishyam over TLS (RTSPS 8555). Outbound connections always traverse NAT/CGNAT/firewalls — no public IP, no port-forwarding. (Tooling: `edge-relay/`.)

**How to tell you're on CGNAT:** compare the router's WAN IP (router admin page) with the "what's my IP" result in a browser. **If they differ → CGNAT → DDNS won't work → use the edge relay.** Also: a WAN IP in `100.64.0.0/10` is a definitive CGNAT sign.

---

## Scenario 4 — Vendor P2P only (Hik-Connect etc.)
Some sites only expose the NVR via the vendor's **P2P mobile app** (serial-number based). A VMS cannot use that proprietary channel directly. Options: enable RTSP + one of the above (DDNS/edge relay), or integrate the vendor SDK (heavy). In practice → **edge relay**.

---

## Security (applies to any internet-exposed camera — scenarios 1, 2)
- **Never** leave default credentials; use strong per-device passwords.
- **Change the RTSP port** off 554 (e.g. 8554) to cut drive-by scans.
- Restrict the port-forward to Drishyam's server IP where possible (firewall allow-list).
- Prefer the **edge relay** for sensitive sites — nothing is exposed inbound at all (outbound-only).
- Keep NVR firmware updated.

---

# Part 2 — Feature design: the **Connectivity Chooser** (make it automatic)

**Goal:** turn the manual scenario-3 pain into add-and-go for *every* camera. When an operator adds a camera/NVR, Drishyam **detects reachability and routes automatically** — Direct, DDNS, or Edge — with no manual host/path/port juggling and no `mediamtx` leaking into the UI.

## 2.1 Add-camera flow (proposed)

```
Operator enters: host (IP or hostname) + brand + credentials  ── that's it ──▶

  Backend "reachability probe":
   ├─ host is a hostname?  → treat as DDNS/Direct (Scenario 1/2)
   ├─ TCP 554 (or brand RTSP port) reachable from server?  → DIRECT ✅
   ├─ not reachable + host is private (RFC1918) or CGNAT?  → EDGE mode
   └─ reachable only via vendor P2P?                       → prompt: enable RTSP / use edge

  Route accordingly. Camera goes live. Operator never picks a "streaming path".
```

## 2.2 Detection logic (server-side, deterministic)
1. **Classify host:** public IP / private RFC1918 (`10/8`, `172.16/12`, `192.168/16`) / hostname.
2. **Probe** the RTSP port from the Drishyam server (TCP connect + RTSP `OPTIONS`, short timeout).
3. Decide:
   - Reachable → **Direct** (host as-is; vendor registry derives path). Covers Scenario 1 & 2 (DDNS hostname just resolves).
   - Not reachable **and** private/CGNAT → **Edge**: mark the camera `connectivity=edge`, issue an **enrolment token**, and show the operator a one-command edge-agent install for that site.
   - Ambiguous → ask the operator (chooser UI, below).

## 2.3 Data model change (fixes the `mediamtx` leak permanently)
Add first-class fields instead of hijacking `host`:

```
cameras / camera_groups:
  connectivity   ENUM('direct','ddns','edge')   default 'direct'
  edge_stream    VARCHAR   -- e.g. 'edge_nfc_ch5'  (only when connectivity='edge')
  display_host   VARCHAR   -- the real NVR IP/hostname, for the UI ONLY
```

- **Source resolution** (`buildCamConfig`): `connectivity='edge'` → source = `rtsp://mediamtx:8554/{edge_stream}`; else → `rtsp://{host}:{port}{derivedPath}`.
- **UI always shows `display_host`** (the real NVR/branch name) — **never** the internal `mediamtx`. Kills the leak.
- No manual `host=mediamtx` override, no service restarts to re-wire.

## 2.4 Edge agent = self-registering (no manual DB wiring)
1. Operator downloads the agent for a site; it authenticates with the **enrolment token**.
2. Agent **discovers cameras** on the LAN (ONVIF) or takes the NVR + channels.
3. Agent **pushes** each stream as `edge_<token>_ch<N>` and **reports the mapping back to Drishyam via API**.
4. Backend auto-sets `connectivity='edge'`, `edge_stream=…` per camera. **Live, dynamically** — no repoint, no restarts.
5. Agent runs as a **service** (see `edge-relay/install-relay-task.ps1`) — survives reboot/logoff/sleep, self-heals.

## 2.5 UI — the chooser (only when detection is ambiguous)
A single step on "Add camera": **"How is this device reachable?"**
- **Auto (recommended)** — probe & decide.
- **Public IP / DDNS** — host as-is (show the DDNS how-to + CGNAT test).
- **Private / behind NAT (Edge)** — generate the edge-agent install command + token.

## 2.6 Why this is the right design
- **Public & dynamic cameras are already add-and-go** (vendor registry + DDNS-as-host). The feature makes that explicit and adds a **DDNS helper**.
- **Private cameras become add-and-go too** via a self-registering edge agent + first-class `connectivity` field — removing every manual step and the `mediamtx` UI leak.
- One mental model for operators: enter the device, Drishyam figures out the plumbing.

---

## Roadmap (incremental)
1. **Now:** DDNS works today — set `host` = DDNS hostname (documented above). Edge relay works via `edge-relay/` scripts (+ service installer).
2. **Next (small):** add `connectivity` / `edge_stream` / `display_host` fields + source resolution → kills the `mediamtx` leak and the manual repoint.
3. **Then:** reachability auto-probe on add-camera + the chooser UI.
4. **Then:** self-registering edge agent (token enrolment + ONVIF discovery + auto-map).

Related: [`edge-relay/`](../edge-relay) (relay + service installer) · [`sales/case-studies/netforchoice.md`](../sales/case-studies/netforchoice.md) (the manual pain this removes) · `src/services/vendors/index.js` (path auto-derivation).
