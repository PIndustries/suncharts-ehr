// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/previsit.js','utf8');
let sequence=0;
const context=vm.createContext({
 console,structuredClone,URLSearchParams,
 crypto:{randomUUID:()=>`request-${++sequence}`},
 document:{readyState:'loading',addEventListener() {},getElementById() {return null;}},
 navigator:{clipboard:{writeText:async()=>{}}},location:{origin:'https://ehr.example.test'},
 me:{role:'owner'},
 esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 human:value=>String(value??'').replaceAll('_',' '),date:value=>String(value??''),
 api:async()=>({}),showTool() {},notice() {},run:fn=>fn(),$:()=>null,FormData:class{}
});
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);

let field=run(`reconciliationField('preferred_name','Preferred name','Existing','Patient <answer>')`);
assert.match(field,/has-conflict/);
assert.match(field,/Patient &lt;answer&gt;/);
assert.match(field,/never overwrite silently/);
assert.doesNotMatch(field,/type="checkbox"[^>]*checked/);

const item={packet_id:'packet-1',patient_id:'patient-1',patient_name:'Doe, <Jane>',mrn:'SC-1',status:'reviewed',response:{preferred_name:'Jane',pronouns:'she/her',administrative_gender:'female',address:'1 Patient Way',insurance_plan:'Example Plan',member_id:'MEM-1',group_number:'GRP-1',subscriber_relationship:'Self',mobility:'Uses wheelchair',daily_activities:'Needs transfer help',caregiver_support:'Family'}};
const demographics={version:4,content:{preferred_name:'Janey',address:{line1:'Existing road',city:'Existing city',country:'US'}}};
const billing={coverages:[{id:'coverage-1'}]},payers={items:[{id:'payer-1',content:{name:'Example <Payer>',active:true}}]},functional={items:[{id:'functional-1',recorded_at:'2026-11-05'}]};
context.item=item;context.demographics=demographics;context.billing=billing;context.payers=payers;context.functional=functional;
let html=run('previsitReconciliationView(item,demographics,billing,payers,functional)');
assert.match(html,/Staff-controlled promotion/);
assert.match(html,/All submitted answers/);
assert.match(html,/data-version="4"/);
assert.match(html,/Doe, &lt;Jane&gt;/);
assert.match(html,/Example &lt;Payer&gt;/);
assert.match(html,/value="Existing road"/);
assert.match(html,/always creates a separate coverage record/);
assert.match(html,/id="intake-functional-reconcile"/);
assert.match(html,/New assessment/);
assert.doesNotMatch(html,/type="checkbox"[^>]*checked/);

context.me={role:'front_desk'};
html=run('previsitReconciliationView(item,demographics,billing,payers,functional)');
assert.doesNotMatch(html,/id="intake-functional-reconcile"/);
assert.match(html,/must promote functional-status answers/);

assert.match(source,/item\.status!=='reviewed'/);
assert.match(source,/Select at least one demographic field to apply/);
assert.match(source,/Intake packet \$\{form\.dataset\.packet\}/);
assert.match(source,/api\(`\/api\/v1\/patients\/\$\{form\.dataset\.patient\}\/demographics`,'PUT'/);
assert.match(source,/api\(`\/api\/v1\/patients\/\$\{form\.dataset\.patient\}\/coverages`,'POST'/);
assert.match(source,/api\(`\/api\/v1\/patients\/\$\{form\.dataset\.patient\}\/functional-status`,'POST'/);
console.log('PASS reviewed intake reconciliation is explicit, conflict-aware, attributed and role-gated');
