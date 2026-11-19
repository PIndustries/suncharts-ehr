// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The wide-screen visit layout: loaded by the page, served by the server, two columns from
// 1280 px with the note on the left and codes & charges then finish on the right; nothing below.
const assert=require('node:assert/strict'),fs=require('node:fs');
const css=fs.readFileSync('web/visit-layout.css','utf8'),index=fs.readFileSync('web/index.html','utf8'),lib=fs.readFileSync('src/lib.rs','utf8');
assert.match(index,/<link rel="stylesheet" href="\/visit-layout\.css">/);
assert.match(lib,/"\/visit-layout\.css"/);assert.match(lib,/include_str!\("\.\.\/web\/visit-layout\.css"\)/);
const wide=css.slice(css.indexOf('@media(min-width:1280px)'));
assert.ok(css.indexOf('@media(min-width:1280px)')>0,'two columns only from 1280 px');
assert.match(wide,/grid-template-columns:minmax\(0,58fr\) minmax\(0,42fr\)/);
assert.match(wide,/#encounter-progress\{grid-column:1\/-1;grid-row:1\}/);
assert.match(wide,/#visit-editor\{grid-column:1;grid-row:2\/5\}/);
assert.match(wide,/#encounter-revenue\{grid-column:2;grid-row:2\}/);
assert.match(wide,/#visit-checkout\{grid-column:2;grid-row:3\}/);
assert.doesNotMatch(css,/#[0-9a-fA-F]{3,6}\b|grid-template-areas/,'theme variables only, no shared areas');
console.log('PASS visit layout: loaded and routed, two columns from 1280 px, note left, codes and finish right');
