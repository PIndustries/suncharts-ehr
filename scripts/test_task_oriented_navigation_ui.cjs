// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8'),style=fs.readFileSync('web/style.css','utf8'),frameStyle=fs.readFileSync('web/frame.css','utf8');
assert.match(app,/function organizeWorkspaceNavigation\(\)/);
assert.match(app,/top.append\(items.home,items.schedule,items.patients,billing\)/);
for(const label of ['Home','Schedule','Work queue','Inbox','Patients','Orders & results','Referrals','Patient balances','Claims','Insurance payments','Claim connections','Workflow Studio','Automation Center','Sun review','Practice administration','Integrations','Data import'])assert.ok(app.includes(label),`missing ${label}`);
for(const id of ['nav-practice','nav-schedule','nav-followup','nav-portal','nav-communications','nav-clinical','nav-labs','nav-specialty','nav-referrals','nav-billing','nav-claims','nav-edi','nav-workflows','nav-automation','nav-ai-review','nav-admin','nav-apps','nav-migration'])assert.match(index,new RegExp(`id="${id}"`));

// The global header, the user menu and Billing each expose their own actions.
assert.match(app,/panel.prepend\(document.querySelector\('\.sidebar-account'\),items.queue,items.messages\)/);
assert.match(app,/settingsLabel.textContent='Settings'/);
assert.match(app,/settings.append\(items.admin\)/);
assert.match(app,/panel.append\(settings\)/);
assert.match(app,/if\(environment\)panel.append\(environment\)/);
assert.match(app,/billingTabs.append\(items.claims,payments,items.billing\)/);
assert.match(app,/tabs.hidden=!billing/);
assert.match(app,/primary.hidden=\['nav-billing','nav-claims'\].every/);
assert.doesNotMatch(app,/function navigationMoreTools/);
assert.match(app,/kept\.hidden=true/);
assert.match(frameStyle,/\.frame-primary\{/);
assert.match(frameStyle,/\.frame-billing-tabs button\[aria-current=page\]/);

assert.match(app,/\$\('nav-migration'\)\.hidden=me\.role!=='owner'/);
assert.match(app,/\$\('nav-admin'\)\)\$\('nav-admin'\)\.hidden=me\.role!=='owner'/);
assert.match(app,/navigation\.dataset\.organized='true'/);
const manage=app.match(/const manage=(\[[^\n]+\]);/)?.[1]||'';
for(const title of ['Workflow Studio','Automation Center','Sun review'])assert.ok(manage.includes(`'${title}'`),`missing management workspace ${title}`);
assert.match(app,/nav-customize/);
assert.match(app,/\['apps','workflows','clearinghouse','migration'\].*dataset\.offMenu/);
assert.match(app,/dataset\?\.offMenu!==undefined\?'nav-admin':active/);
assert.match(app,/manage\.includes\(title\)\?'MANAGE'/);
assert.match(app,/today\.includes\(title\).*\?'TODAY'/);
assert.match(app,/care\.includes\(title\)\?'CARE'/);
assert.match(app,/revenue\.includes\(title\)\?'REVENUE'/);

assert.match(app,/function chartNavigation\(tabs\)/);
assert.match(app,/patient-workspace-tabs/);
assert.match(app,/frame-chart-navigation/);
assert.match(app,/encounter-visit-actions/);
assert.doesNotMatch(app,/encounter-step-tabs/,'the encounter is one page with direct actions');
assert.match(app,/function patientWorkflowActions\(\)/);
for(const action of ['Start encounter','Insurance & copay','Continue encounter'])assert.ok(app.includes(action),`missing visible patient action ${action}`);
assert.doesNotMatch(app,/class="patient-workflow-actions"/);
assert.match(style,/\.patient-next-action/);
console.log('PASS clinic-flow shell hierarchy, user menu, Billing navigation, active state and role gates');
