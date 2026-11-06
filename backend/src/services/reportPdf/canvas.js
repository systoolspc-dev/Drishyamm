'use strict';
/**
 * canvas.js — the sheet every Drishyam PDF report is drawn on.
 *
 * pdfkit works in PostScript points with y growing downwards. The report
 * layouts are designed in millimetres on an A4 portrait page (the mockup in
 * docs/mockups/ai-event-report-pdf-design.html is the reference), so this
 * wrapper takes millimetres and converts once. It also owns what has to be
 * identical across report types: fonts, colour tokens, margins, and the
 * "Page X of Y" footer that can only be stamped once the page count is known.
 *
 * Fonts: Inter (the console's typeface) is embedded from src/assets/fonts when
 * the files are present; otherwise the built-in Helvetica keeps the document
 * rendering rather than failing an export over a missing asset.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const MM = 72 / 25.4;
const mm = (v) => v * MM;

// Same tokens as smart-cam-app so the PDF reads as the same product.
const COLORS = {
  brand: '#F7983A', brandInk: '#B96A15', brandSoft: '#FEF3E7',
  fg: '#0F172A', fgSecondary: '#475569', fgMuted: '#64748B', fgSubtle: '#94A3B8',
  line: '#E2E8F0', lineStrong: '#CBD5E1', sunken: '#F8FAFC', muted: '#F1F5F9',
  high: '#DC2626', highInk: '#B91C1C',
  medium: '#F59E0B', mediumInk: '#B45309',
  info: '#94A3B8', infoInk: '#475569',
  white: '#FFFFFF',
};

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_FILES = { R: 'Inter-Regular.ttf', M: 'Inter-Medium.ttf', S: 'Inter-SemiBold.ttf', B: 'Inter-Bold.ttf' };
const FALLBACK = { R: 'Helvetica', M: 'Helvetica', S: 'Helvetica-Bold', B: 'Helvetica-Bold' };

function registerFonts(doc) {
  const out = { embedded: true };
  for (const [key, file] of Object.entries(FONT_FILES)) {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) {
      doc.registerFont(`Inter-${key}`, p);
      out[key] = `Inter-${key}`;
    } else {
      out[key] = FALLBACK[key];
      out.embedded = false;
    }
  }
  return out;
}

class Sheet {
  constructor({ title, author, subject } = {}) {
    this.doc = new PDFDocument({
      size: 'A4',
      layout: 'portrait',
      margin: 0,
      bufferPages: true,
      autoFirstPage: false,
      compress: true,
      info: {
        Title: title || 'Report',
        Author: author || 'Drishyam',
        Subject: subject || '',
        Creator: 'Drishyam Video Intelligence Platform',
        Producer: 'Drishyam VMS',
      },
    });
    this.fonts = registerFonts(this.doc);
    this.W = 210;
    this.H = 297;
    this.ML = 14;
    this.MR = 14;
    this.MT = 10;
    this.MB = 8;
    this.CW = this.W - this.ML - this.MR; // 182
    this.pages = 0;
    this.chunks = [];
    this.doc.on('data', (c) => this.chunks.push(c));
  }

  get x0() { return this.ML; }
  get x1() { return this.W - this.MR; }

  addPage() {
    this.doc.addPage();
    this.pages += 1;
    return this.pages;
  }

  _font(key, size, color) {
    this.doc.font(this.fonts[key] || this.fonts.R).fontSize(size);
    if (color) this.doc.fillColor(color);
  }

  /** Line height of a font/size, in mm. */
  lineHeight(key, size) {
    this._font(key, size);
    return this.doc.currentLineHeight() / MM;
  }

  widthOf(str, key = 'R', size = 9, tracking = 0) {
    this._font(key, size);
    // Measured with the same OpenType features the text is drawn with:
    // tabular figures are wider than proportional ones, and a string that
    // measures short but draws long wraps its last character onto a new line.
    const opts = { characterSpacing: tracking * size };
    if (this.fonts.embedded) opts.features = ['tnum'];
    return this.doc.widthOfString(String(str ?? ''), opts) / MM;
  }

  heightOf(str, key = 'R', size = 9, width, lineGap = 0) {
    this._font(key, size);
    return this.doc.heightOfString(String(str ?? ''), { width: mm(width), lineGap }) / MM;
  }

  /** Trim a string with an ellipsis so it fits `width` mm at this font/size. */
  fit(str, key, size, width, tracking = 0) {
    let s = String(str ?? '');
    width -= 0.2; // hairline of slack so rounding can never push a glyph over
    if (this.widthOf(s, key, size, tracking) <= width) return s;
    const ell = '…';
    let lo = 0; let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.widthOf(s.slice(0, mid).trimEnd() + ell, key, size, tracking) <= width) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo).trimEnd() + ell;
  }

  /**
   * One run of text at (x, y) mm, y being the top of the line box.
   * Single-line by default (ellipsised to `width`); `wrap: true` flows inside
   * `width`. Returns the height used, in mm.
   */
  text(str, x, y, o = {}) {
    const {
      key = 'R', size = 9, color = COLORS.fg, width, align = 'left', wrap = false,
      tracking = 0, tnum = false, lineGap = 0, caps = false, continued = false,
    } = o;
    let s = String(str ?? '');
    if (caps) s = s.toUpperCase();
    if (!wrap && width && !continued) s = this.fit(s, key, size, width, tracking);
    this._font(key, size, color);
    const opts = { align, characterSpacing: tracking * size, lineGap, lineBreak: wrap, continued };
    // A single left-aligned line is drawn without a width so pdfkit can never
    // wrap it; it has already been ellipsised to fit. Right/centre alignment
    // needs the width to align against.
    if (width && (wrap || align !== 'left' || continued)) opts.width = mm(width);
    if (this.fonts.embedded) opts.features = tnum ? ['tnum'] : [];
    this.doc.text(s, mm(x), mm(y), opts);
    return wrap && width ? this.heightOf(s, key, size, width, lineGap) : this.lineHeight(key, size);
  }

  /**
   * A wrapped paragraph made of runs with different weights/colours, e.g.
   * [{ t: 'Severity ', key: 'S' }, { t: 'is assigned…' }]. Returns height in mm.
   */
  paragraph(runs, x, y, { width, size = 7.5, color = COLORS.fgSecondary, lineGap = 0.6 } = {}) {
    const startY = this.doc.y;
    runs.forEach((run, i) => {
      this._font(run.key || 'R', run.size || size, run.color || color);
      const opts = { width: mm(width), lineBreak: true, lineGap, continued: i < runs.length - 1 };
      if (i === 0) this.doc.text(run.t, mm(x), mm(y), opts);
      else this.doc.text(run.t, opts);
    });
    const used = (this.doc.y - mm(y)) / MM;
    this.doc.y = startY;
    return used;
  }

  rule(x1, y, x2, { color = COLORS.line, width = 0.25 } = {}) {
    this.doc.save().lineWidth(mm(width)).strokeColor(color)
      .moveTo(mm(x1), mm(y)).lineTo(mm(x2), mm(y)).stroke().restore();
  }

  vrule(x, y1, y2, { color = COLORS.line, width = 0.25 } = {}) {
    this.doc.save().lineWidth(mm(width)).strokeColor(color)
      .moveTo(mm(x), mm(y1)).lineTo(mm(x), mm(y2)).stroke().restore();
  }

  rect(x, y, w, h, { fill, stroke, width = 0.25, radius = 0, opacity = 1, dash } = {}) {
    const d = this.doc.save();
    if (opacity !== 1) d.opacity(opacity);
    if (dash) d.dash(mm(dash[0]), { space: mm(dash[1]) });
    if (radius) d.roundedRect(mm(x), mm(y), mm(w), mm(h), mm(radius)); else d.rect(mm(x), mm(y), mm(w), mm(h));
    if (fill && stroke) d.fillColor(fill).strokeColor(stroke).lineWidth(mm(width)).fillAndStroke();
    else if (fill) d.fillColor(fill).fill();
    else if (stroke) d.strokeColor(stroke).lineWidth(mm(width)).stroke();
    d.restore();
  }

  polygon(points, { fill, stroke, width = 0.3, opacity = 1, dash } = {}) {
    const d = this.doc.save();
    if (opacity !== 1) d.opacity(opacity);
    if (dash) d.dash(mm(dash[0]), { space: mm(dash[1]) });
    d.polygon(...points.map(([px, py]) => [mm(px), mm(py)]));
    if (fill && stroke) d.fillColor(fill).strokeColor(stroke).lineWidth(mm(width)).fillAndStroke();
    else if (fill) d.fillColor(fill).fill();
    else if (stroke) d.strokeColor(stroke).lineWidth(mm(width)).stroke();
    d.restore();
  }

  dot(cx, cy, r, color) {
    this.doc.save().circle(mm(cx), mm(cy), mm(r)).fillColor(color).fill().restore();
  }

  /** Place a JPEG/PNG buffer to fill exactly (w × h) mm. Returns false if pdfkit rejects it. */
  image(buf, x, y, w, h) {
    if (!buf) return false;
    try {
      this.doc.image(buf, mm(x), mm(y), { width: mm(w), height: mm(h) });
      return true;
    } catch {
      return false;
    }
  }

  clip(x, y, w, h, fn) {
    this.doc.save();
    this.doc.rect(mm(x), mm(y), mm(w), mm(h)).clip();
    try { fn(); } finally { this.doc.restore(); }
  }

  /**
   * Stamp the footer on every buffered page (needs the final page count),
   * then close the document and resolve with its bytes.
   */
  finish(footerFn) {
    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      this.doc.switchToPage(range.start + i);
      footerFn(i + 1, range.count);
    }
    this.doc.flushPages();
    return new Promise((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
      this.doc.end();
    });
  }
}

module.exports = { Sheet, COLORS, mm, MM };
