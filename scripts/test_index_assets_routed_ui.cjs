// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Every script and stylesheet the app page loads must be served by the server. A file listed in
// web/index.html without a route answers 404 and silently never runs (the patient picker did).
const assert=require('node:assert/strict'),fs=require('node:fs');
const index=fs.readFileSync('web/index.html','utf8'),lib=fs.readdirSync('src').filter(f=>f.endsWith('.rs')).map(f=>fs.readFileSync('src/'+f,'utf8')).join('\n');
const local=[...index.matchAll(/(?:src|href)="\/([a-z0-9][a-z0-9._-]*\.(?:js|css))(?:\?[^"]*)?"/gi)].map(m=>m[1]);
assert.ok(local.length>20,'the page loads its scripts and styles');
const missing=[...new Set(local)].filter(name=>!lib.includes(`"/${name}"`)||!fs.existsSync(`web/${name}`));
assert.deepEqual(missing,[],'files loaded by index.html without a server route or file: '+missing.join(', '));
console.log(`PASS every one of the ${new Set(local).size} scripts and stylesheets index.html loads has a server route`);
