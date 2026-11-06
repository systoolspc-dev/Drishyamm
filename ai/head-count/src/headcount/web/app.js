// Live head-count dashboard. Auto-discovers streams, embeds each MJPEG feed,
// and polls stats once a second. Served from the same origin as the API, so
// all paths are relative.

const POLL_MS = 1000;
const cards = new Map(); // stream id -> DOM refs

const $ = (id) => document.getElementById(id);

function fmtUptime(s) {
  if (s == null) return "—";
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function buildCard(stream) {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="card-video">
      <span class="placeholder">connecting…</span>
      <img alt="${stream.name}" />
      <div class="badges" data-badges></div>
    </div>
    <div class="card-footer">
      <div>
        <div class="card-title">${stream.name}</div>
        <div class="card-sub">
          <span data-fps>0 fps</span>
          <span data-frames>0 frames</span>
        </div>
      </div>
      <span class="badge starting" data-status>starting</span>
    </div>`;

  const img = card.querySelector("img");
  // Point the <img> at the MJPEG endpoint — the browser renders it as live video.
  img.src = `/video/${encodeURIComponent(stream.id)}`;
  img.addEventListener("load", () => {
    const ph = card.querySelector(".placeholder");
    if (ph) ph.style.display = "none";
  });
  img.addEventListener("error", () => {
    const ph = card.querySelector(".placeholder");
    if (ph) { ph.style.display = "block"; ph.textContent = "no signal"; }
  });

  $("grid").appendChild(card);
  cards.set(stream.id, {
    card,
    badges: card.querySelector("[data-badges]"),
    fps: card.querySelector("[data-fps]"),
    frames: card.querySelector("[data-frames]"),
    status: card.querySelector("[data-status]"),
  });
}

function updateCard(s) {
  const c = cards.get(s.id);
  if (!c) return;
  // If activity is on, badges show working/on_phone/distracted; else detector counts.
  const hasActivity = s.activity && Object.keys(s.activity).length;
  const source = hasActivity ? s.activity : s.counts;
  c.badges.innerHTML = Object.entries(source)
    .map(([label, n]) => `
      <div class="count-badge state-${label}">
        <span class="n">${n}</span>
        <span class="l">${label.replace("_", " ")}</span>
      </div>`)
    .join("");
  c.fps.textContent = `${s.fps.toFixed(0)} fps`;
  c.frames.textContent = `${s.frames_processed.toLocaleString()} frames`;
  c.status.textContent = s.status;
  c.status.className = `badge ${s.status}`;
}

async function poll() {
  try {
    const [health, streamsRes] = await Promise.all([
      fetch("/health").then((r) => r.json()),
      fetch("/streams").then((r) => r.json()),
    ]);

    // Header metrics
    $("health-dot").className = `dot ${health.status}`;
    $("device").textContent = health.device;
    $("uptime").textContent = fmtUptime(health.uptime_seconds);
    $("streams-online").textContent = `${health.streams_online}/${health.streams_total}`;

    const streams = streamsRes.streams || [];
    if (streams.length && $("empty")) $("empty").remove();

    const totals = {};
    for (const s of streams) {
      if (!cards.has(s.id)) buildCard(s);
      updateCard(s);
      const src = (s.activity && Object.keys(s.activity).length) ? s.activity : s.counts;
      for (const [label, n] of Object.entries(src)) {
        totals[label] = (totals[label] || 0) + n;
      }
    }
    // Render one header metric per detector label.
    $("totals").innerHTML = Object.entries(totals)
      .map(([label, n]) => `
        <div class="metric">
          <span class="metric-value">${n}</span>
          <span class="metric-label">${label.replace("_", " ")}</span>
        </div>`)
      .join("") || `<div class="metric"><span class="metric-value">—</span>
                    <span class="metric-label">no data</span></div>`;
  } catch (e) {
    $("health-dot").className = "dot unhealthy";
    // Leave last-known values on screen; try again next tick.
  }
}

poll();
setInterval(poll, POLL_MS);
