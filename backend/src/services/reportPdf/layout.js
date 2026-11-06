'use strict';
/**
 * layout.js — the Drishyam report on paper, for every report type.
 *
 * One document grammar, drawn from a plain page model (see index.js):
 *   page 1   summary — title, the type's four numbers, what the report
 *            covers, the type's own blocks (a bar list, small tables), and
 *            one footnote on how to read the numbers. No legend, no contents.
 *   pages 2+ one or more SECTIONS, each paginated with the header repeated:
 *              records  — a table (with or without stills), N rows a page
 *              evidence — two large cards a page (only when it has entries)
 *
 * Every coordinate is in millimetres on A4 PORTRAIT (210 × 297, 14 mm side
 * margins → 182 mm of content) and mirrors the reference mockup
 * docs/mockups/ai-event-report-pdf-design.html. Nothing here touches the
 * database, so any report type can be rendered from a hand-built model.
 */

const { Sheet, COLORS } = require('./canvas');
const V = require('./vocabulary');

const FOOTER_Y = 283;
const TABLE_TOP = 35;        // y where the first row of a records section starts
const TABLE_BOTTOM = 278;    // rows must end above this
const THUMB_ROW_H = 15.2;
const PLAIN_ROW_H = 10.4;
const THUMB_W = 21;
const THUMB_H = 11.8;
const EVIDENCE_PER_PAGE = 3;
const SNAP_W = 100;          // evidence still, 16:9
const SNAP_H = 56.25;
const CARD_H = 10 + SNAP_H + 3;

/* ───────────────────────────── page arithmetic ───────────────────────────── */

function rowGeometry(section) {
  const rowH = section.rowH || (section.columns.some((c) => c.cell === 'thumb') ? THUMB_ROW_H : PLAIN_ROW_H);
  return { rowH, perPage: Math.max(1, Math.floor((TABLE_BOTTOM - TABLE_TOP) / rowH)) };
}

function sectionPages(section) {
  if (section.kind === 'records') return Math.max(1, Math.ceil((section.rows?.length || 0) / rowGeometry(section).perPage));
  if (section.kind === 'evidence') return Math.ceil((section.entries?.length || 0) / EVIDENCE_PER_PAGE);
  return 0;
}

/** Where every section lands: [{ section, start, end, pages }] plus the total. */
function pageCounts(m) {
  let page = 2;
  const plan = [];
  for (const section of m.sections || []) {
    const pages = sectionPages(section);
    plan.push({ section, start: page, end: page + pages - 1, pages });
    page += pages;
  }
  return { plan, total: page - 1 };
}

/* ───────────────────────────── pieces ───────────────────────────── */

function sectionHeading(s, x, y, w, title, aside) {
  s.rect(x, y + 0.9, 2.2, 2.2, { fill: COLORS.brand });
  const asideW = aside ? Math.min(w * 0.6, 150) : 0;
  s.text(title, x + 4.4, y, { key: 'B', size: 8.5, caps: true, tracking: 0.09, width: w - 4.4 - asideW });
  if (aside) {
    s.text(aside, x + w - asideW, y + 0.6, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: asideW, align: 'right', tnum: true });
  }
  s.rule(x, y + 5.5, x + w, { color: COLORS.lineStrong });
  return y + 8.1;
}

/**
 * Definition list. rows: [{ dt, dd, sub, tnum, wrap, subWrap, key, color, severity }]
 * A row with `severity` prints the dot + word chip instead of plain text.
 */
function dl(s, x, y, dtW, w, rows, { ddSize = 9, gap = 1.5 } = {}) {
  const ddX = x + dtW + 3;
  const ddW = w - dtW - 3;
  for (const r of rows) {
    s.text(r.dt, x, y + 0.7, { key: 'S', size: 7, caps: true, tracking: 0.07, color: COLORS.fgMuted, width: dtW });
    let h;
    if (r.severity) {
      severityChip(s, ddX, y, r.severity, { size: ddSize });
      h = s.lineHeight('S', ddSize);
    } else {
      h = s.text(r.dd ?? '—', ddX, y, {
        key: r.key || 'M', size: r.size || ddSize, color: r.color || COLORS.fg, width: ddW, wrap: !!r.wrap, tnum: !!r.tnum,
      });
    }
    if (r.sub) {
      h += 0.3;
      h += s.text(r.sub, ddX, y + h, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: ddW, wrap: !!r.subWrap, tnum: !!r.tnum });
    }
    y += h + gap;
  }
  return y;
}

function severityChip(s, x, y, sev, { size = 8.5 } = {}) {
  const meta = V.severityOf(sev);
  const lh = s.lineHeight('S', size);
  s.dot(x + 1.1, y + lh / 2 + 0.15, 1.1, meta.dot);
  s.text(meta.label, x + 3.9, y, { key: 'S', size, color: meta.ink, width: 22 });
  return 3.9 + s.widthOf(meta.label, 'S', size);
}

const TONES = {
  ok: { dot: '#10B981', ink: COLORS.fgSecondary },
  bad: { dot: COLORS.high, ink: COLORS.highInk },
  warn: { dot: COLORS.medium, ink: COLORS.mediumInk },
  muted: { dot: COLORS.info, ink: COLORS.fgMuted },
};

/** Generic status chip: { label, tone: ok | bad | warn | muted }. */
function statusChip(s, x, y, st, { size = 8.5, width = 24 } = {}) {
  if (!st) return 0;
  const tone = TONES[st.tone] || TONES.muted;
  const lh = s.lineHeight('S', size);
  s.dot(x + 1.1, y + lh / 2 + 0.15, 1.1, tone.dot);
  s.text(st.label, x + 3.9, y, { key: 'S', size, color: tone.ink, width: width - 3.9 });
  return 3.9 + s.widthOf(st.label, 'S', size);
}

/** A still with an optional detection box. Falls back to a "No snapshot" tile. */
function still(s, x, y, w, h, img, box, { boxWidth = 0.35, label } = {}) {
  if (!img || !s.image(img, x, y, w, h)) {
    s.rect(x, y, w, h, { fill: COLORS.muted, stroke: COLORS.line, radius: 0.6 });
    s.text('No snapshot', x, y + h / 2 - 1.4, { key: 'M', size: 6, color: COLORS.fgSubtle, width: w, align: 'center' });
    return false;
  }
  if (box) {
    const bx = x + box[0] * w; const by = y + box[1] * h;
    const bw = box[2] * w; const bh = box[3] * h;
    s.rect(bx, by, bw, bh, { stroke: COLORS.fg, width: boxWidth + 0.35, opacity: 0.45 });
    s.rect(bx, by, bw, bh, { stroke: COLORS.brand, width: boxWidth });
    if (label) {
      const tw = s.widthOf(label, 'S', 6) + 2.6;
      const th = 3.4;
      let ty = by - th - 0.4;
      if (ty < y + 0.5) ty = Math.min(by + bh + 0.4, y + h - th - 0.5);
      let tx = bx;
      if (tx + tw > x + w - 0.5) tx = x + w - 0.5 - tw;
      s.rect(tx, ty, tw, th, { fill: COLORS.brand, radius: 0.4 });
      s.text(label, tx + 1.3, ty + 0.55, { key: 'S', size: 6, color: COLORS.white, width: tw });
    }
  }
  return true;
}

/* ───────────────────────────── page 1 ───────────────────────────── */

function drawHeader(s, m) {
  const y = s.MT;
  s.dot(s.x0 + 3.5, y + 3.5, 3.5, COLORS.brand);
  s.text('D', s.x0, y + 1.5, { key: 'B', size: 10, color: COLORS.white, width: 7, align: 'center' });
  s.text('DRISHYAM', s.x0 + 10, y + 1.2, { key: 'B', size: 12.5, tracking: 0.14, width: 60 });
  s.text(m.account.name, s.x1 - 150, y + 2.2, { key: 'R', size: 8.5, color: COLORS.fgMuted, width: 150, align: 'right' });
  const ry = y + 9.5;
  s.rule(s.x0, ry, s.x1, { color: COLORS.lineStrong });
  s.rect(s.x0, ry - 0.3, 26, 0.6, { fill: COLORS.brand });
  return ry;
}

function drawBars(s, x, y, w, block) {
  const items = block.items || [];
  if (!items.length) {
    s.text(block.emptyText || 'Nothing in this period.', x, y, { key: 'R', size: 8.5, color: COLORS.fgMuted, width: w });
    return y + 5;
  }
  const labelW = block.labelW || 40; const cntW = block.countW || 12; const pctW = block.share === false ? 0 : (block.shareW || 11); const gap = 3;
  const tx = x + labelW + gap;
  const tw = w - labelW - cntW - pctW - gap * (pctW ? 3 : 2);
  const max = Math.max(1, ...items.map((i) => i.count));
  for (const it of items) {
    s.text(it.name, x, y, { key: 'M', size: 8.5, width: labelW, tnum: true });
    const bw = Math.max(0.6, tw * (it.count / max));
    s.rect(tx, y + 0.6, bw, 3, { fill: it.other ? COLORS.lineStrong : COLORS.brand, radius: 0.5 });
    s.text(it.display ?? V.nf(it.count), x + w - pctW - (pctW ? gap : 0) - cntW, y, { key: 'S', size: 8.5, width: cntW, align: 'right', tnum: true });
    if (pctW) s.text(it.share || '', x + w - pctW, y + 0.25, { key: 'R', size: 8, color: COLORS.fgMuted, width: pctW, align: 'right', tnum: true });
    y += 5.85;
  }
  return y - 1.8;
}

/**
 * Small page-1 table. block.columns: [{ key, w?, title, align }] (one column
 * may omit `w` and takes the rest); block.rows: [{ key: string | { text, sub, tone } }];
 * block.rest: an optional muted closing row.
 */
function drawMiniTable(s, x, y, w, block, { maxRows = 8 } = {}) {
  const cols = block.columns;
  const fixed = cols.reduce((n, c) => n + (c.w || 0), 0);
  const flexW = Math.max(20, w - fixed);
  // Text insets: a left-aligned column that follows another column starts
  // 2.5 mm in, and a right-aligned column that is not the last ends 2.5 mm
  // early, so "Peak" and "Peak time" can never touch.
  let cx = x;
  const pos = cols.map((c, i) => {
    const cw = c.w || flexW;
    const align = c.align || 'left';
    const inL = i > 0 && align === 'left' ? 2.5 : 0;
    const inR = align === 'right' ? (i < cols.length - 1 ? 2.5 : 0) : 2;
    const p = { x: cx + inL, w: Math.max(4, cw - inL - inR), align };
    cx += cw;
    return p;
  });
  cols.forEach((c, i) => s.text(c.title, pos[i].x, y, {
    key: 'S', size: 7, caps: true, tracking: 0.07, color: COLORS.fgMuted, width: pos[i].w, align: pos[i].align,
  }));
  y += 5.2;
  s.rule(x, y, x + w, { color: COLORS.lineStrong });
  y += 0.3;
  const all = block.rows || [];
  const rows = all.slice(0, maxRows);
  if (!rows.length) {
    s.text(block.emptyText || 'Nothing to show for this period.', x, y + 1.5, { key: 'R', size: 8, color: COLORS.fgMuted, width: w });
    return y + 7;
  }
  // Rows the page had no room for are counted, never silently dropped.
  if (!block.rest && all.length > rows.length) {
    block = { ...block, rest: { [cols[0].key]: `${all.length - rows.length} more` } };
  }
  const pitch = 6.3;
  const cell = (c, p, ty, first, muted) => {
    const v = typeof c === 'object' && c !== null ? c : { text: c };
    const tone = v.tone ? TONES[v.tone] : null;
    if (tone) {
      s.dot(p.x + 1.1, ty + 2.1, 1.1, tone.dot);
      s.text(v.text ?? '—', p.x + 3.9, ty, { key: 'S', size: 8, color: tone.ink, width: p.w - 6 });
      return;
    }
    const key = first ? 'S' : 'R';
    const color = muted ? COLORS.fgMuted : (first ? COLORS.fg : COLORS.fgSecondary);
    const text = v.text == null || v.text === '' ? '—' : String(v.text);
    s.text(text, p.x, ty, { key, size: 8, color, width: p.w, align: p.align, tnum: true });
    if (v.sub && p.align !== 'right') {
      const lx = p.x + Math.min(p.w, s.widthOf(text, key, 8)) + 1.2;
      if (lx < p.x + p.w - 12) s.text(`· ${v.sub}`, lx, ty + 0.25, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: p.x + p.w - lx });
    }
  };
  rows.forEach((r, i) => {
    const ty = y + 1.1;
    cols.forEach((c, ci) => cell(r[c.key], pos[ci], ty, ci === 0, false));
    y += pitch;
    if (i < rows.length - 1 || block.rest) s.rule(x, y, x + w);
  });
  if (block.rest) {
    const ty = y + 1.1;
    cols.forEach((c, ci) => { if (block.rest[c.key] != null) cell(block.rest[c.key], pos[ci], ty, false, true); });
    y += pitch;
  }
  return y;
}

function drawSummaryPage(s, m) {
  s.addPage();
  let y = drawHeader(s, m) + 4;

  s.text(m.title, s.x0, y, { key: 'B', size: 20, tracking: -0.015, width: s.CW });
  y += s.lineHeight('B', 20) + 1;
  // Period · scope, wrapped: a face report's scope line is longer than the page.
  y += s.paragraph([
    { t: m.periodText, key: 'S', color: COLORS.fg },
    { t: `  ·  ${m.subtitleTail}` },
  ], s.x0, y, { width: s.CW, size: 10.5, color: COLORS.fgSecondary, lineGap: 0.4 }) + 3.5;

  // the numbers
  s.rule(s.x0, y, s.x1, { color: COLORS.lineStrong });
  const top = y;
  const colW = s.CW / m.stats.length;
  m.stats.forEach((st, i) => {
    const cx = s.x0 + i * colW;
    const px = i === 0 ? cx : cx + 4;
    if (i > 0) s.vrule(cx, top + 0.6, top + 14.4);
    s.text(st.value, px, top + 2.2, { key: 'B', size: 16, tracking: -0.015, tnum: true, width: colW - 5 });
    let lx = px;
    if (st.dot) { s.dot(px + 1.05, top + 11.2, 1.05, st.dot); lx += 3.6; }
    s.text(st.label, lx, top + 9.7, { key: 'S', size: 7, caps: true, tracking: 0.08, color: COLORS.fgMuted, width: colW - 5 - (lx - px) });
  });
  y = top + 15;
  s.rule(s.x0, y, s.x1);
  y += 4.5;

  // what this report covers — six lines, in two columns
  const about = m.about || [...(m.details || []), ...(m.filterRows || [])];
  y = sectionHeading(s, s.x0, y, s.CW, 'About this report');
  const half = Math.ceil(about.length / 2);
  const aboutW = (s.CW - 8) / 2;
  const y1 = dl(s, s.x0, y, 22, aboutW, about.slice(0, half));
  const y2 = dl(s, s.x0 + aboutW + 8, y, 22, aboutW, about.slice(half));
  y = Math.max(y1, y2) + 5;

  // the type's own blocks, stacked, dropped when out of room
  const LIMIT = FOOTER_Y - 24;
  for (const block of m.blocks || []) {
    if (y + 22 > LIMIT) break;
    y = sectionHeading(s, s.x0, y, s.CW, block.heading, block.aside);
    if (block.kind === 'bars') {
      y = drawBars(s, s.x0, y, s.CW, block);
    } else if (block.kind === 'table') {
      // Leave a line for the "N more" row whenever the block will not fit whole.
      const room = Math.max(1, Math.floor((LIMIT - y - 6) / 6.3) - 1);
      y = drawMiniTable(s, s.x0, y, s.CW, block, { maxRows: Math.min(block.maxRows || 8, room) });
    } else if (block.kind === 'text') {
      for (const line of block.lines || []) {
        y += s.text(line, s.x0, y, { key: 'R', size: 8, color: COLORS.fgSecondary, width: s.CW, wrap: true }) + 1;
      }
    }
    if (block.note) {
      y += 2;
      y += s.text(block.note, s.x0, y, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: s.CW, wrap: true });
    }
    y += 6;
  }

  // one line on how to read the numbers, just above the footer — and only
  // when the page has room for it; it is never printed over the blocks.
  if (m.footnote) {
    const fh = s.heightOf(m.footnote, 'R', 7.5, s.CW);
    const fy = FOOTER_Y - 3 - fh;
    if (y - 3 < fy - 2.4) {
      s.rule(s.x0, fy - 2.4, s.x1);
      s.text(m.footnote, s.x0, fy, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: s.CW, wrap: true });
    }
  }
}

/* ───────────────────────────── pages 2+ ───────────────────────────── */

function runningHead(s, m, section) {
  s.addPage();
  const y = s.MT;
  s.dot(s.x0 + 2.3, y + 2.3, 2.3, COLORS.brand);
  s.text('D', s.x0, y + 0.9, { key: 'B', size: 6.5, color: COLORS.white, width: 4.6, align: 'center' });
  let x = s.x0 + 7.1;
  s.text('DRISHYAM', x, y + 0.75, { key: 'B', size: 7.5, tracking: 0.12, width: 30 });
  x += s.widthOf('DRISHYAM', 'B', 7.5, 0.12) + 2.5;
  s.text(`${m.typeLabel} · ${m.periodText} · ${m.account.name}`, x, y + 0.75, { key: 'R', size: 7.5, color: COLORS.fgSecondary, width: s.x1 - 54 - x });
  s.text(section, s.x1 - 50, y + 1.05, { key: 'S', size: 7, caps: true, tracking: 0.08, color: COLORS.fgMuted, width: 50, align: 'right' });
  s.rule(s.x0, y + 6.6, s.x1);
  return y + 11;
}

function columnLayout(s, columns) {
  let x = s.x0;
  return columns.map((c, i) => {
    const padL = i === 0 ? 0 : 2;
    const padR = i === columns.length - 1 ? 0 : 2;
    const p = { col: c, x: x + padL, w: c.w - padL - padR };
    x += c.w;
    return p;
  });
}

function drawRecordRow(s, section, row, y, rowH, pos, refPage) {
  const one = y + (rowH - 3.9) / 2;
  const two = y + (rowH - 7.9) / 2;
  for (const p of pos) {
    const cell = row[p.col.key];
    switch (p.col.cell) {
      case 'thumb':
        still(s, p.x, y + (rowH - THUMB_H) / 2, THUMB_W, THUMB_H, cell?.img, cell?.box, { boxWidth: 0.35 });
        break;
      case 'severity':
        severityChip(s, p.x, one, cell);
        break;
      case 'status':
        statusChip(s, p.x, one, cell, { width: p.w });
        break;
      case 'num':
        s.text(cell == null || cell === '' ? '—' : cell, p.x, one, {
          key: 'S', size: 8.5, width: p.w, align: 'right', tnum: true, color: cell == null || cell === '' ? COLORS.fgMuted : COLORS.fg,
        });
        break;
      default: {
        const c = cell && typeof cell === 'object' ? cell : { one: cell };
        const three = c.evidenceIndex != null ? `Evidence on page ${refPage(c.evidenceIndex)}` : c.three;
        const lines = 1 + (c.two ? 1 : 0) + (three ? 1 : 0);
        let ty = lines === 3 ? y + Math.max(0.6, (rowH - 11.6) / 2) : (lines === 2 ? two : one);
        const oneColor = c.muted ? COLORS.fgMuted : (c.one == null || c.one === '' ? COLORS.fgMuted : COLORS.fg);
        s.text(c.one == null || c.one === '' ? '—' : c.one, p.x, ty, { key: 'M', size: 8.5, color: oneColor, width: p.w, tnum: !!c.tnum });
        ty += 4.3;
        if (c.two) { s.text(c.two, p.x, ty, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: p.w, tnum: !!c.tnum }); ty += 3.6; }
        if (three) s.text(three, p.x, ty, { key: 'M', size: 7, color: COLORS.brandInk, width: p.w, tnum: true });
      }
    }
  }
}

function drawRecordsSection(s, m, entry, pc) {
  const section = entry.section;
  const { rowH, perPage } = rowGeometry(section);
  const pos = columnLayout(s, section.columns);
  const evidencePlan = pc.plan.find((p) => p.section.kind === 'evidence' && p.pages);
  const refPage = (i) => (evidencePlan ? evidencePlan.start + Math.floor(i / EVIDENCE_PER_PAGE) : '—');

  for (let p = 0; p < entry.pages; p += 1) {
    let y = runningHead(s, m, section.heading);
    const start = p * perPage;
    const slice = section.rows.slice(start, start + perPage);
    const aside = slice.length
      ? (section.asideOf ? section.asideOf(start + 1, start + slice.length) : `${V.nf(start + 1)} – ${V.nf(start + slice.length)} of ${V.nf(section.rows.length)}`)
      : (section.emptyAside || `Nothing to list · all times ${m.tzShort}`);
    y = sectionHeading(s, s.x0, y, s.CW, section.heading, aside);

    pos.forEach((q) => s.text(q.col.title, q.x, y, {
      key: 'S', size: 7, caps: true, tracking: 0.07, color: COLORS.fgMuted, width: q.w, align: q.col.align || 'left',
    }));
    y += 5.4;
    s.rule(s.x0, y, s.x1, { color: COLORS.lineStrong, width: 0.4 });
    y += 0.2;

    if (!slice.length) {
      s.text(section.emptyText || 'Nothing was recorded in this period for the selected scope.', s.x0, y + 6, { key: 'R', size: 9, color: COLORS.fgMuted, width: s.CW });
      continue;
    }
    for (const row of slice) {
      drawRecordRow(s, section, row, y, rowH, pos, refPage);
      y += rowH;
      s.rule(s.x0, y, s.x1);
    }
    if (p === entry.pages - 1 && section.footnote) {
      s.text(section.footnote, s.x0, y + 2.6, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: s.CW, wrap: true });
    }
  }
}

function drawEvidenceCard(s, e, y) {
  const x = s.x0; const w = s.CW;
  s.clip(x, y, w, 7, () => s.rect(x, y, w, 9, { fill: COLORS.sunken, radius: 1.2 }));
  s.rect(x, y, w, CARD_H, { stroke: COLORS.lineStrong, radius: 1.2 });
  s.rule(x, y + 7, x + w);

  let hx = x + 4; const hy = y + 1.7;
  hx += severityChip(s, hx, hy + 0.6, e.severity, { size: 8.5 }) + 4;
  const refW = 28;
  s.text(e.label, hx, hy, { key: 'B', size: 10.5, width: x + w - 4 - refW - 3 - hx });
  s.text(e.ref, x + w - 4 - refW, hy + 0.9, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: refW, align: 'right', tnum: true });

  const by = y + 10; const sx = x + 4;
  still(s, sx, by, SNAP_W, SNAP_H, e.large, e.largeBox, { boxWidth: 0.5, label: e.boxLabel });

  const dx = sx + SNAP_W + 5; const dw = x + w - 4 - dx;
  const rows = [...(e.left || []), ...(e.right || []), ...(e.full || [])];
  s.clip(dx, by - 0.5, dw, CARD_H - 10 - 1, () => dl(s, dx, by, 21, dw, rows, { ddSize: 8, gap: 1.8 }));
}

function drawEvidenceSection(s, m, entry) {
  const section = entry.section;
  for (let p = 0; p < entry.pages; p += 1) {
    let y = runningHead(s, m, section.heading);
    y = sectionHeading(s, s.x0, y, s.CW, section.heading, section.aside);
    const slice = section.entries.slice(p * EVIDENCE_PER_PAGE, (p + 1) * EVIDENCE_PER_PAGE);
    for (const e of slice) {
      drawEvidenceCard(s, e, y);
      y += CARD_H + 4.5;
    }
    if (p === entry.pages - 1 && section.footnote) {
      s.text(section.footnote, s.x0, y - 1.5, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: s.CW, wrap: true });
    }
  }
}

function footer(s, m) {
  return (n, total) => {
    const y = FOOTER_Y;
    s.rule(s.x0, y, s.x1);
    const ty = y + 1.8;
    s.text('Drishyam', s.x0, ty, { key: 'S', size: 7.5, color: COLORS.fgSecondary, width: 30 });
    const bw = s.widthOf('Drishyam', 'S', 7.5);
    s.text(` · ${m.typeLabel}`, s.x0 + bw, ty, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: 110 });
    s.text(`Report ID: ${m.code}`, s.x0, ty, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: s.CW, align: 'center', tnum: true });
    s.text(`Page ${n} of ${total}`, s.x1 - 40, ty, { key: 'R', size: 7.5, color: COLORS.fgMuted, width: 40, align: 'right', tnum: true });
  };
}

/** Render a page model to PDF bytes. */
async function render(model) {
  const s = new Sheet({
    title: `${model.typeLabel} — ${model.periodText}`,
    author: 'Drishyam VMS',
    subject: model.name || model.typeLabel,
  });
  const pc = pageCounts(model);
  drawSummaryPage(s, model);
  for (const entry of pc.plan) {
    if (!entry.pages) continue;
    if (entry.section.kind === 'records') drawRecordsSection(s, model, entry, pc);
    else if (entry.section.kind === 'evidence') drawEvidenceSection(s, model, entry);
  }
  return s.finish(footer(s, model));
}

module.exports = { render, pageCounts, rowGeometry, EVIDENCE_PER_PAGE, THUMB_ROW_H, PLAIN_ROW_H };
