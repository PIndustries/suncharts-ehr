// SPDX-License-Identifier: AGPL-3.0-only
// Program text pins: some web/*.js text is read by a program (the Sun assistant,
// or the generated bundle consumers), not by staff, so wording-cleanup jobs must
// not reword it. Fails when a pinned file's bytes differ from its recorded
// sha256, or when a pinned file is missing. Deliberate changes are refreshed
// with: node scripts/test_program_text_pins.cjs --write
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const PINS_PATH = path.join(__dirname, 'program_text_pins.json');
const GUIDANCE =
  'This file holds text or code read by a program, not by staff. ' +
  'If the change is intended, say in the pull request what the assistant or ' +
  'program will now receive, then run: node scripts/test_program_text_pins.cjs --write';

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readPins() {
  return JSON.parse(fs.readFileSync(PINS_PATH, 'utf8'));
}

// Returns one line per mismatch (changed or missing file), empty when all pins hold.
function comparePins(pins, root) {
  const mismatches = [];
  for (const [relPath, entry] of Object.entries(pins.files)) {
    const file = path.join(root, relPath);
    if (!fs.existsSync(file)) {
      mismatches.push(`${relPath}: file is missing but pinned (${entry.why})`);
      continue;
    }
    const actual = sha256Of(file);
    if (actual !== entry.sha256) {
      mismatches.push(`${relPath}: sha256 changed (pinned ${entry.sha256}, found ${actual})`);
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Self-check for the hash and the comparison
// ---------------------------------------------------------------------------

(function selfCheck() {
  const dir = fs.mkdtempSync(path.join(ROOT, '.erb-tmp-pins-selfcheck-'));
  try {
    const original = path.join(dir, 'original.txt');
    fs.writeFileSync(original, 'the assistant receives this exact text');
    fs.writeFileSync(path.join(dir, 'altered.txt'), 'the assistant receives this exact texX');
    const baseHash = sha256Of(original);
    const alteredHash = sha256Of(path.join(dir, 'altered.txt'));
    assert.notEqual(baseHash, alteredHash, 'one changed byte must give a different hash');
    const pin = (hash) => ({ files: { 'original.txt': { sha256: hash, why: 'self-check' } } });
    assert.equal(
      comparePins(pin(alteredHash), dir).length,
      1,
      'altered file must be reported as a mismatch',
    );
    assert.equal(
      comparePins(pin(baseHash), dir).length,
      0,
      'unchanged file must not be reported',
    );
    const missingPin = { files: { 'absent.txt': { sha256: baseHash, why: 'self-check' } } };
    assert.equal(
      comparePins(missingPin, dir).length,
      1,
      'missing pinned file must be reported',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const pins = readPins();
  if (argv.includes('--write')) {
    for (const [relPath, entry] of Object.entries(pins.files)) {
      const file = path.join(ROOT, relPath);
      if (!fs.existsSync(file)) {
        console.error(`FAIL: cannot write pins, ${relPath} is missing`);
        return 1;
      }
      entry.sha256 = sha256Of(file);
    }
    fs.writeFileSync(PINS_PATH, JSON.stringify(pins, null, 2) + '\n');
    console.log(`pins written: ${Object.keys(pins.files).length} files`);
    return 0;
  }

  const mismatches = comparePins(pins, ROOT);
  if (mismatches.length) {
    for (const line of mismatches) {
      const relPath = line.split(':', 1)[0];
      console.error(`FAIL ${line}`);
      console.error(`  why: ${pins.files[relPath].why}`);
      console.error(`  ${GUIDANCE}`);
    }
    return 1;
  }
  console.log(
    `PASS program text pins: ${Object.keys(pins.files).length} files unchanged`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
