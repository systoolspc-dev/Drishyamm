// ─────────────────────────────────────────────────────────────────────────────
// Report delivery — turns a catalog section, an employee row, or a Federated
// Site Report selection into a file and hands it to the browser.
//
// FRONTEND-ONLY. Every file is rendered in the browser from the page's
// datasets. Future backend: POST /activity/report/federated
//   { store, from, to, shift, sections[], format, delivery, recipients[] }
// → a signed download URL, or 202 when the server emails it. Until then
// "Send to email" downloads the file and opens a pre-addressed draft in the
// user's mail client (a browser cannot attach a file to mailto:).
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildScorecardPayload, download, renderScorecardCsv, renderScorecardPdf, renderScorecardXlsx,
} from './scorecard-export';
import { buildSection, employeePayloadInput, federatedPayloadInput, sectionPayloadInput } from './report-sections';
import { zipFiles } from './zip';

const RENDER = { pdf: renderScorecardPdf, csv: renderScorecardCsv, xlsx: renderScorecardXlsx };

async function deliver(payload, format) {
  const blob = await RENDER[format](payload);
  const filename = `${payload.filename}.${format}`;
  download(blob, filename);
  return { filename, reportId: payload.reportId };
}

/** One domain report from the catalog: format 'pdf' | 'csv' | 'xlsx'. */
export function exportSection(ctx, id, format) {
  return deliver(buildScorecardPayload(sectionPayloadInput(ctx, id)), format);
}

/** One employee's week, from a table row or a matrix card. */
export function exportEmployee(ctx, row, format) {
  return deliver(buildScorecardPayload(employeePayloadInput(ctx, row)), format);
}

export const FEDERATED_FORMATS = [
  { id: 'pdf', label: 'PDF', hint: 'One paginated executive deck' },
  { id: 'xlsx', label: 'Excel', hint: 'Workbook — a Summary tab plus one tab per table' },
  { id: 'zip', label: 'Zip', hint: 'The PDF deck, the Excel workbook and a CSV per section' },
];

/**
 * Build the Federated Site Report and download it.
 * @param {object} ctx  the page's report context (see report-sections.js)
 * @param {{ sections: string[], format: 'pdf'|'xlsx'|'zip' }} opts
 * @returns {Promise<{ filename: string, reportId: string, sections: string[] }>}
 */
export async function generateFederated(ctx, { sections, format }) {
  const input = federatedPayloadInput(ctx, sections);
  const payload = buildScorecardPayload(input);

  if (format !== 'zip') {
    const out = await deliver(payload, format);
    return { ...out, sections: input.sections };
  }

  const [pdf, xlsx] = await Promise.all([renderScorecardPdf(payload), renderScorecardXlsx(payload)]);
  const csvs = input.sections.map((id, i) => {
    const one = buildScorecardPayload(sectionPayloadInput(ctx, id));
    return { name: `csv/${String(i + 1).padStart(2, '0')}-${one.filename}.csv`, data: renderScorecardCsv(one) };
  });
  const bytes = await zipFiles([
    { name: `${payload.filename}.pdf`, data: pdf },
    { name: `${payload.filename}.xlsx`, data: xlsx },
    ...csvs,
  ]);
  const filename = `${payload.filename}.zip`;
  download(new Blob([bytes], { type: 'application/zip' }), filename);
  return { filename, reportId: payload.reportId, sections: input.sections };
}

/** Open a pre-addressed draft for a report that was just downloaded. */
export function openEmailDraft({ recipients, filename, reportId, ctx, sections }) {
  const titles = sections.map((id) => `  - ${buildSection(ctx, id)?.title}`).join('\n');
  const subject = `Federated Site Report - ${ctx.storeLabel} (${reportId})`;
  const body = [
    'Hi,',
    '',
    `Attached is the Federated Site Report for ${ctx.storeLabel}, covering ${ctx.from} to ${ctx.to} (${ctx.shiftLabel}).`,
    '',
    'Sections:',
    titles,
    '',
    `Report ID: ${reportId}`,
    `File: ${filename}`,
    '',
    `- ${ctx.generatedBy}`,
  ].join('\n');
  const a = document.createElement('a');
  a.href = `mailto:${recipients.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  a.click();
}
