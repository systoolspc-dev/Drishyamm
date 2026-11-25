// Guard for AppError.public(): the ONE way a 5xx message reaches the browser.
//
// errorHandler hides every other 5xx message because they can carry SQL,
// hostnames or upstream detail. AppError.public() is safe only while its text
// is fixed and written for the user. This scans the backend source so a future
// `AppError.public(`Failed: ${err.message}`)` (or `+ detail`) fails CI instead
// of leaking.
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
// Constants allowed as the message: each must itself be fixed text (checked below).
const CONSTANTS = { INDEX_OFF: path.join(SRC, 'utils', 'aiIndexOff.js') };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
    return d.name.endsWith('.js') ? [p] : [];
  });
}

/** Every `AppError.public(<first argument>` in the source, with where it is. */
function calls() {
  const out = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /AppError\.public\(\s*/g;
    let m;
    while ((m = re.exec(text))) {
      // The definition itself (`static public(message, …)`) is not a call.
      if (/static\s+$/.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      // Mentions in comments (`// … AppError.public() …`, ` * …`) are not calls.
      if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ file: path.relative(SRC, file), line, arg: text.slice(re.lastIndex, re.lastIndex + 400) });
    }
  }
  return out;
}

/** Is `src` (from the opening quote) one fixed string literal, followed by `,` or `)`? */
function fixedLiteral(src) {
  const single = /^'(?:[^'\\\n]|\\.)*'\s*[,)]/;
  const double = /^"(?:[^"\\\n]|\\.)*"\s*[,)]/;
  const template = /^`[^`$]*`\s*[,)]/;          // a template with no ${…}
  return single.test(src) || double.test(src) || template.test(src);
}

function allowedArg(arg) {
  if (fixedLiteral(arg)) return true;
  const ident = /^([A-Z][A-Z0-9_]*)\s*[,)]/.exec(arg);
  return !!(ident && CONSTANTS[ident[1]]);
}

test('there are AppError.public() calls to check (the scan works)', () => {
  expect(calls().length).toBeGreaterThan(0);
});

test('every AppError.public() message is fixed text: no ${…}, no +, no variables', () => {
  const bad = calls().filter((c) => !allowedArg(c.arg))
    .map((c) => `${c.file}:${c.line}  AppError.public(${c.arg.split('\n')[0].slice(0, 80)}…`);
  expect(bad).toEqual([]);
});

test.each(Object.entries(CONSTANTS))('%s is itself fixed text', (name, file) => {
  const text = fs.readFileSync(file, 'utf8');
  const m = new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?);\\n`).exec(text);
  expect(m).not.toBeNull();
  const value = m[1];
  // Only string literals joined with +: strip them and nothing but + and whitespace may remain.
  const rest = value.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`$]*`/g, '').replace(/[+\s]/g, '');
  expect(rest).toBe('');
});

describe('the scanner itself', () => {
  test.each([
    ["'Smart Search is still starting up.', 503)", true],
    ['"Fixed text")', true],
    ['`Fixed, no placeholders`, 502)', true],
    ['INDEX_OFF, 503)', true],
    ['`Failed: ${err.message}`, 502)', false],
    ["'Failed: ' + detail, 502)", false],
    ['err.message, 503)', false],
    ['msg)', false],
    ['SOME_OTHER_CONSTANT, 503)', false],
    ["String(detail), 503)", false],
  ])('%s → allowed: %s', (arg, ok) => {
    expect(allowedArg(arg)).toBe(ok);
  });
});
