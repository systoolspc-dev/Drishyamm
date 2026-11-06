// ─────────────────────────────────────────────────────────────────────────────
// Minimal .xlsx writer — a multi-tab workbook without a spreadsheet library.
//
// An .xlsx is a zip of a handful of XML parts; this writes the smallest set
// Excel, LibreOffice and Google Sheets all open cleanly: inline strings (no
// shared-string table), a fixed style sheet, frozen header rows and column
// widths sized to the content.
//
// Cells: numbers stay numbers, "88%" becomes 0.88 formatted as a percent (so it
// sorts and averages in Excel), everything else is text. A sheet with `heat`
// tints its percent cells good / warn / bad, the workbook's heatmap.
//
// A sheet with `image` ({ bytes: PNG Uint8Array, w, h } in pixels) carries that
// picture floating over its top-left corner — the Drishyam logo on a report's
// Summary tab. A row's `height` (points) makes room for it. A `span` row (a
// long single-cell line) does not widen its column.
// ─────────────────────────────────────────────────────────────────────────────

import { zipFiles } from './zip.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Style indices into cellXfs below.
const S = { text: 0, head: 1, title: 2, section: 3, pct: 4, good: 5, warn: 6, bad: 7, label: 8 };

const STYLES = `${XML}<styleSheet xmlns="${NS}">
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2E3749"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCF3E6"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDEFD6"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFBDDE1"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>
<xf numFmtId="9" fontId="0" fillId="4" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>
<xf numFmtId="9" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// eslint-disable-next-line no-control-regex
const esc = (s) => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colName = (i) => {
  let n = i + 1; let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// Excel sheet names: ≤31 chars, none of []:*?/\ , unique in the workbook.
function sheetNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const base = String(raw).replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base; let k = 2;
    while (used.has(name.toLowerCase())) { const sfx = ` (${k++})`; name = base.slice(0, 31 - sfx.length) + sfx; }
    used.add(name.toLowerCase());
    return name;
  });
}

function cellXml(ref, value, rowStyle, heat) {
  if (value === '' || value === null || value === undefined) {
    return rowStyle !== undefined && rowStyle !== S.text ? `<c r="${ref}" s="${rowStyle}"/>` : '';
  }
  const str = String(value).trim();
  const isStyledRow = rowStyle === S.head || rowStyle === S.title || rowStyle === S.section;
  if (!isStyledRow) {
    const pct = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(str);
    if (pct) {
      const n = Number(pct[1]);
      const s = heat ? (n >= heat.good ? S.good : n >= heat.warn ? S.warn : S.bad) : S.pct;
      return `<c r="${ref}" s="${s}"><v>${n / 100}</v></c>`;
    }
    if (typeof value === 'number' || /^-?\d+(?:\.\d+)?$/.test(str)) {
      return `<c r="${ref}"${rowStyle ? ` s="${rowStyle}"` : ''}><v>${Number(str)}</v></c>`;
    }
  }
  return `<c r="${ref}" t="inlineStr"${rowStyle ? ` s="${rowStyle}"` : ''}><is><t xml:space="preserve">${esc(str)}</t></is></c>`;
}

function sheetXml(sheet) {
  const rows = sheet.rows;
  const nCols = Math.max(1, ...rows.map((r) => r.cells.length));
  const widths = Array.from({ length: nCols }, (_, ci) => {
    const longest = Math.max(4, ...rows.filter((r) => r.style !== 'title' && !r.span).map((r) => String(r.cells[ci] ?? '').length));
    return Math.min(60, longest + 2);
  });
  const freeze = sheet.freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const body = rows.map((r, ri) => {
    const style = r.style ? S[r.style] : undefined;
    const heat = r.style ? null : sheet.heat;
    const cells = r.cells.map((v, ci) => cellXml(`${colName(ci)}${ri + 1}`, v, style, heat)).join('');
    const ht = r.height ? ` ht="${r.height}" customHeight="1"` : '';
    return `<row r="${ri + 1}"${ht}>${cells}</row>`;
  }).join('');
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL}">${freeze}`
    + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${body}</sheetData>${sheet.image ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
}

// One picture anchored at A1, sized in EMUs (9525 per pixel).
function drawingXml({ w, h }) {
  const cx = Math.round(w * 9525); const cy = Math.round(h * 9525);
  return `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">`
    + '<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>76200</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>57150</xdr:rowOff></xdr:from>'
    + `<xdr:ext cx="${cx}" cy="${cy}"/>`
    + '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Drishyam logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
    + '<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
    + '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
}

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const relsXml = (type, target) => `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL}/${type}" Target="${target}"/></Relationships>`;

/**
 * @param {{ name: string, rows: { cells: (string|number)[], style?: 'title'|'head'|'section'|'label', height?: number, span?: boolean }[],
 *   heat?: { good: number, warn: number }, freezeRow?: number,
 *   image?: { bytes: Uint8Array, w: number, h: number } }[]} sheets
 * @returns {Promise<Blob>}
 */
export async function buildXlsx(sheets) {
  const names = sheetNames(sheets.map((s) => s.name));
  const pictured = sheets.map((s, i) => (s.image ? i + 1 : 0)).filter(Boolean);
  const files = [
    {
      name: '[Content_Types].xml',
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + (pictured.length ? '<Default Extension="png" ContentType="image/png"/>' : '')
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + pictured.map((n) => `<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>`
        + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
        + '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
    ...pictured.flatMap((n) => [
      { name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: relsXml('drawing', `../drawings/drawing${n}.xml`) },
      { name: `xl/drawings/drawing${n}.xml`, data: drawingXml(sheets[n - 1].image) },
      { name: `xl/drawings/_rels/drawing${n}.xml.rels`, data: relsXml('image', `../media/image${n}.png`) },
      { name: `xl/media/image${n}.png`, data: sheets[n - 1].image.bytes },
    ]),
  ];
  const bytes = await zipFiles(files);
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
