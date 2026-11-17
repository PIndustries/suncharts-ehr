// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The checkout AVS review shows only the vitals that were measured; a measurement that was
// not taken leaves its line out and never prints undefined, null, NaN or a placeholder 0.
// Synthetic data only.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/checkout.js','utf8');
const context=vm.createContext({esc:v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),human:v=>String(v).replaceAll('_',' '),document:{addEventListener(){}},window:{addEventListener(){}}});
vm.runInContext(source,context);
const summary=vitals=>vm.runInContext(`avsSummary({vitals:${JSON.stringify(vitals??null)}})`,context);
const vitals=vitals=>{const html=summary(vitals);const at=html.indexOf('Visit vitals');return at<0?'':html.slice(at,html.indexOf('</section>',at));};

const full={systolic_mm_hg:120,diastolic_mm_hg:80,heart_rate_bpm:72,temperature_c:36.8,oxygen_saturation_pct:98,weight_kg:70,height_cm:175};
assert.equal(vitals(full),'Visit vitals</h4><p>Blood pressure 120/80 mmHg · Pulse 72 bpm · Temperature 36.8 °C · Oxygen saturation 98% · Weight 70 kg · Height 175 cm</p>');
assert.equal(vitals({heart_rate_bpm:72}),'Visit vitals</h4><p>Pulse 72 bpm</p>');
assert.equal(vitals({systolic_mm_hg:118,diastolic_mm_hg:76,weight_kg:70}),'Visit vitals</h4><p>Blood pressure 118/76 mmHg · Weight 70 kg</p>');
assert.equal(vitals({}),'','a record with no measurement shows no vitals section');
assert.equal(vitals(null),'','a visit without vitals shows no vitals section');
// Half a stored blood pressure (legacy data) is shown as a gap, never as a number.
assert.match(vitals({systolic_mm_hg:120}),/Blood pressure 120\/— mmHg/);
for(const record of [full,{heart_rate_bpm:72},{systolic_mm_hg:120},{}])assert.doesNotMatch(vitals(record),/undefined|NaN|null/,'no placeholder ever prints');
console.log('PASS AVS review lists only measured vitals and never prints a placeholder');
