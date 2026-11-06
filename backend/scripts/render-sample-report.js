#!/usr/bin/env node
/**
 * Render the report PDF layout from a sample model (no database) so it can be
 * opened and checked by eye.
 *
 *   node scripts/render-sample-report.js [out.pdf] [--type ai_events|camera_health] [--thumb path.jpg] [--large path.jpg]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const layout = require('../src/services/reportPdf/layout');
const { sampleModel, cameraHealthModel } = require('../test/helpers/reportPdfSample');

async function main() {
  const args = process.argv.slice(2);
  const out = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))) || path.join(os.tmpdir(), 'drishyam-sample-report.pdf');
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const thumb = opt('--thumb') ? fs.readFileSync(opt('--thumb')) : undefined;
  const large = opt('--large') ? fs.readFileSync(opt('--large')) : undefined;
  const model = opt('--type') === 'camera_health'
    ? cameraHealthModel()
    : await sampleModel({ rows: 23, evidence: 3, thumb, large });
  const pdf = await layout.render(model);
  fs.writeFileSync(out, pdf);
  console.log(`wrote ${out} (${(pdf.length / 1024).toFixed(0)} KB, ${layout.pageCounts(model).total} pages)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
