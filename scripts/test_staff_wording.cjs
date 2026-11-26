// SPDX-License-Identifier: AGPL-3.0-only
// Staff wording check: developer wording must not reach clinic staff screens.
// Fails when a banned word appears more often than the recorded baseline, and
// also when it appears less often, so the baseline can only be lowered on
// purpose (node scripts/test_staff_wording.cjs --write).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const BASELINE_PATH = path.join(__dirname, 'staff_wording_baseline.json');
// 'encounter' is the clinic's own word for the encounter record (owner, 2026-11-19), so it is allowed.
const BANNED_WORDS = [
  'catalog',
  'snapshot',
  'payload',
  'endpoint',
  'tenant',
  'schema',
  'JSON',
];

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

// String and template literals in a source file, with escapes handled and
// ${...} parts (including nested braces) dropped from templates.
function extractLiterals(src) {
  const literals = [];
  // A RegExp passed to String.replace can contain quotes in its character class.
  // Consume the pattern so those quotes cannot start a string in the scanner.
  const replacePattern = /\.replace\(\s*\/(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/[\\\r\n])+\/[a-z]*/y;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 2 || n;
      continue;
    }
    if (c === '.') {
      replacePattern.lastIndex = i;
      if (replacePattern.test(src)) {
        i = replacePattern.lastIndex;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let out = '';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i + 1] === '\n' ? '' : src[i + 1];
          i += 2;
        } else if (src[i] === quote) {
          i += 1;
          break;
        } else {
          out += src[i];
          i += 1;
        }
      }
      literals.push(out);
      continue;
    }
    if (c === '`') {
      let out = '';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i + 1] === '\n' ? '' : src[i + 1];
          i += 2;
        } else if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
            i += 1;
          }
        } else if (src[i] === '`') {
          i += 1;
          break;
        } else {
          out += src[i];
          i += 1;
        }
      }
      literals.push(out);
      continue;
    }
    i += 1;
  }
  return literals;
}

// Everything from < to the next > goes, which also removes attribute values,
// class names and data- attributes.
function stripTags(text) {
  return text.replace(/<[^>]*>/g, ' ');
}

function isIgnorable(text) {
  if (!text.includes(' ')) return true; // keys, ids, routes
  if (text.includes('/api/')) return true;
  const t = text.trim();
  if (t.startsWith('/') || t.startsWith('http')) return true;
  return false;
}

function isCaseSensitive(word) {
  return word === word.toUpperCase() && /[A-Z]/.test(word);
}

function wordPattern(word, flags) {
  // 'JSON' is matched case-sensitively; the rest are not. Plurals count too.
  if (isCaseSensitive(word)) return new RegExp(`\\b${word}s?\\b`, flags);
  const re = new RegExp(`\\b${word}s?\\b`, flags);
  return new RegExp(re.source.replace(/^\\b([a-z])/, (_, c) => `\\b[${c}${c.toUpperCase()}]`), re.flags);
}

function countWord(text, word) {
  const re = wordPattern(word, 'g');
  let count = 0;
  while (re.exec(text) !== null) count += 1;
  return count;
}

function exampleFor(text, word) {
  const match = wordPattern(word, '').exec(text) || wordPattern(word, 'g').exec(text);
  if (!match) return text.slice(0, 80).trim();
  const start = Math.max(0, match.index - 30);
  return text.replace(/\s+/g, ' ').slice(start, start + 80).trim();
}

// Scan one source file: returns banned word -> {count, examples[]}.
function scanSource(src) {
  const found = new Map();
  for (const literal of extractLiterals(src)) {
    const text = stripTags(literal).trim();
    if (!text || isIgnorable(text)) continue;
    for (const word of BANNED_WORDS) {
      const hits = countWord(text, word);
      if (!hits) continue;
      let entry = found.get(word);
      if (!entry) {
        entry = { count: 0, examples: [] };
        found.set(word, entry);
      }
      entry.count += hits;
      if (entry.examples.length < 3) entry.examples.push(exampleFor(text, word));
    }
  }
  return found;
}

function scanWebFiles() {
  const results = new Map();
  for (const name of fs.readdirSync(WEB_DIR).sort()) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(WEB_DIR, name), 'utf8');
    const found = scanSource(src);
    if (found.size) results.set(name, found);
  }
  return results;
}

function sortedCounts(counts) {
  const out = {};
  for (const word of Object.keys(counts).sort()) out[word] = counts[word];
  return out;
}

function buildBaseline() {
  const baseline = {};
  for (const [file, found] of scanWebFiles()) {
    const counts = {};
    for (const [word, entry] of found) counts[word] = entry.count;
    baseline[file] = sortedCounts(counts);
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Self-check for the extractor and the word counter
// ---------------------------------------------------------------------------

(function selfCheck() {
  const scan = (src) => {
    const out = {};
    for (const [word, entry] of scanSource(src)) out[word] = entry.count;
    return out;
  };
  // A tag attribute is ignored, the visible text between tags is checked.
  assert.deepEqual(
    scan("const a = '<div class=\"catalog snapshot\">Catalog summary';"),
    { catalog: 1 },
    'tag attributes must not be counted',
  );
  // A template ${...} part is dropped, its contents never counted.
  assert.deepEqual(
    scan('const a = `Visit ${catalog.snapshotId} saved`;'),
    {},
    'template expressions must be dropped',
  );
  // A one-word literal is a key, id or route and is ignored.
  assert.deepEqual(scan("const a = 'catalogs';"), {}, 'bare keys must be ignored');
  assert.deepEqual(
    scan("const a = '/api/catalogs'; const b = 'https://x/catalogs';"),
    {},
    'paths and URLs must be ignored',
  );
  // The plural is counted; an unrelated longer word is not.
  assert.deepEqual(
    scan("const a = 'Catalogs listed'; const b = 'no catalogued here';"),
    { catalog: 1 },
    'Catalogs counts, catalogued does not',
  );
  // JSON is matched case-sensitively; json in lowercase is left alone.
  assert.deepEqual(
    scan("const a = 'bad JSON payload here'; const b = 'a json file body';"),
    { JSON: 1, payload: 1 },
    'JSON counts case-sensitively',
  );
  assert.deepEqual(
    scan(`const escape = value => value.replace(/[&<>"']/g, '');
      const body = JSON.stringify({value: 'synthetic'});
      const label = 'Catalog summary';`),
    { catalog: 1 },
    'quotes inside a replacement pattern cannot misclassify the code that follows',
  );
})();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  if (argv.includes('--write')) {
    const baseline = buildBaseline();
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    const files = Object.keys(baseline).length;
    const words = Object.values(baseline).reduce((s, f) => s + Object.keys(f).length, 0);
    console.log(`baseline written: ${words} file/word entries across ${files} files`);
    return 0;
  }

  if (argv.includes('--list')) {
    for (const [file, found] of scanWebFiles()) {
      for (const word of [...found.keys()].sort()) {
        const entry = found.get(word);
        console.log(`${file}  ${word}  x${entry.count}`);
        for (const ex of entry.examples) console.log(`    ${ex}`);
      }
    }
    return 0;
  }

  let baseline = {};
  if (fs.existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  }

  const results = scanWebFiles();
  const regressions = [];
  const improvements = [];
  for (const [file, found] of results) {
    const fileBaseline = baseline[file] || {};
    for (const word of [...found.keys()].sort()) {
      const foundCount = found.get(word).count;
      const examples = found.get(word).examples;
      const baseCount = fileBaseline[word] || 0;
      if (foundCount > baseCount) {
        regressions.push({ file, word, baseCount, foundCount, examples });
      }
    }
  }
  // Baseline entries the current scan no longer matches (file deleted, word
  // fixed, or removed by --list of a smaller count) must be lowered too.
  for (const [file, fileBaseline] of Object.entries(baseline)) {
    const found = results.get(file);
    for (const [word, baseCount] of Object.entries(fileBaseline)) {
      const foundCount = found && found.has(word) ? found.get(word).count : 0;
      if (baseCount > foundCount) {
        improvements.push({ file, word, baseCount, foundCount });
      }
    }
  }

  let failed = false;
  if (regressions.length) {
    failed = true;
    console.error(
      `FAIL: ${regressions.length} file/word count(s) above the staff wording baseline.`,
    );
    console.error('Staff screens use plain words. Use the clinic wording instead.');
    for (const r of regressions) {
      console.error(`  ${r.file}  ${r.word}: baseline ${r.baseCount}, found ${r.foundCount}`);
      for (const ex of r.examples) console.error(`      e.g. ${ex}`);
    }
  }
  if (improvements.length) {
    failed = true;
    console.error(
      `FAIL: ${improvements.length} file/word count(s) are now BELOW the staff wording baseline.`,
    );
    console.error('The baseline can only go down. Lower it to the new number:');
    for (const i of improvements) {
      console.error(
        `  ${i.file}  ${i.word}: baseline ${i.baseCount}, found ${i.foundCount} (set to ${i.foundCount})`,
      );
    }
    console.error('Then re-run: node scripts/test_staff_wording.cjs --write');
  }
  if (!failed) {
    console.log('PASS staff wording: no banned developer words above the baseline');
  }
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
