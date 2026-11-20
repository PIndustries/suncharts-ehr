// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Provider and place on an encounter show what the claim will carry, taken from the schedule and the
// practice, instead of empty boxes staff would re-enter. A chosen override shows as chosen.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const src=fs.readFileSync('web/billing.js','utf8');
const ctx={esc,activeVisit:{id:'v1',appointment_id:'a1',clinician_id:'u-park'},
 workspace:{appointments:[{id:'a1',facility:'Main Clinic',room:'Room 2'}]},
 encounterOptions:{providers:[{id:'u-park',name:'Synthetic Park MD',npi:'1234567893'},{id:'u-lee',name:'Synthetic Lee DO',npi:'1245319599'}],facilities:[{name:'Main Clinic'}]}};
vm.createContext(ctx);
vm.runInContext(src.slice(src.indexOf('const encounterPlaceOptions='),src.indexOf('\n',src.indexOf('const encounterPlaceOptions='))),ctx);
vm.runInContext(src.slice(src.indexOf('function encounterProviderSummaryMarkup('),src.indexOf('function encounterProviderSummaryRefresh(')),ctx);
let html=ctx.encounterProviderSummaryMarkup({});
assert.match(html,/Synthetic Park MD · NPI 1234567893 <span class="muted">from the schedule<\/span>/,'the clinician on the appointment, not a blank box');
assert.match(html,/Main Clinic, Room 2/,'where the patient was seen, from the schedule');
assert.match(html,/Practice default · In office/);assert.match(html,/<dt>Referring provider<\/dt><dd>None<\/dd>/);
assert.doesNotMatch(html,/Supervising/,'empty optional roles are left out');
html=ctx.encounterProviderSummaryMarkup({rendering_npi:'1245319599',place_of_service:'10',encounter_mode:'telehealth',referring_provider_name:'Synthetic Referrer',referring_npi:'1234567893'});
assert.match(html,/Synthetic Lee DO · NPI 1245319599/);assert.doesNotMatch(html,/Park/,'a chosen provider replaces the schedule one');
assert.match(html,/10 · Telehealth, patient at home · Telehealth/);assert.match(html,/Synthetic Referrer · NPI 1234567893/);
ctx.encounterOptions=null;assert.match(ctx.encounterProviderSummaryMarkup({}),/Loading…/,'until the practice lists arrive');
// The editing fields start folded behind Change.
const part=src.slice(src.indexOf("if(part==='provider')"),src.indexOf("if(part==='actions')"));
assert.match(part,/data-encounter-provider-change aria-expanded="false">Change</);assert.match(part,/data-encounter-provider-fields hidden/);
console.log('PASS provider and place show the schedule clinician and practice location; fields only on Change');
