// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8'),style=fs.readFileSync('web/style.css','utf8');
assert.match(app,/function organizeWorkspaceNavigation\(\)/);
for(const group of ['Today','Patients','Clinical','Revenue','Operations','Settings'])assert.match(app,new RegExp(`\\['${group}'`));
for(const label of ['Home','Schedule','Work queue','Messages','Intake inbox','Patient directory','Orders & results','Referrals','Billing & payments','Claims & remittances','Clearinghouse','Workflow Studio','Forms','Automation Center','AI review','Practice settings','Integrations','Data import'])assert.ok(app.includes(label),`missing ${label}`);
for(const id of ['nav-practice','nav-schedule','nav-followup','nav-portal','nav-communications','nav-clinical','nav-labs','nav-specialty','nav-referrals','nav-billing','nav-claims','nav-edi','nav-workflows','nav-automation','nav-ai-review','nav-admin','nav-apps','nav-migration'])assert.match(index,new RegExp(`id="${id}"`));
assert.match(app,/forms\.id='nav-forms'/);assert.match(app,/button\.id==='nav-forms'/);assert.match(app,/studioView='forms'/);
assert.match(app,/nav-forms'.*aria-current|aria-current.*nav-forms/s);assert.match(style,/\.nav-item-child\[aria-current=page\]/);
assert.match(app,/\$\('nav-migration'\)\.hidden=me\.role!=='owner'/);assert.match(app,/\$\('nav-admin'\)\)\$\('nav-admin'\)\.hidden=me\.role!=='owner'/);
assert.match(app,/navigation\.dataset\.organized='true'/);assert.match(style,/\.nav-group-primary/);
assert.match(app,/operations=\['Workflow Studio','Automation Center','AI review'\]/);assert.match(app,/operations\.includes\(title\)\?'OPERATIONS'/);
assert.match(app,/settings=\['Practice administration','Integrations','Connect services','Support tickets','Data import'\]/);assert.match(app,/settings\.includes\(title\)\?'SETTINGS'/);
assert.match(app,/today\.includes\(title\).*\?'TODAY'/);assert.match(app,/patients\.includes\(title\)\?'PATIENTS'/);assert.match(app,/clinical\.includes\(title\)\?'CLINICAL'/);
console.log('PASS task-oriented shell hierarchy, feature preservation, forms route, active state and role gates');
