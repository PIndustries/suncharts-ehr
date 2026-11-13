// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The chart overview's "Latest vitals" card: a measurement that was not taken is left out,
// and the card never prints "undefined". Synthetic data only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),app=fs.readFileSync(path.join(root,'web/app.js'),'utf8');
const overview=app.slice(app.indexOf('function chartOverview(){'),app.indexOf('function chartAreaEnabled('));
function card(visits,activeVisit){
 const c=vm.createContext({console,Number,Object,Boolean,activeVisit,workspace:{visits,clinical:{items:[]},labs:{reports:[],acknowledgments:[],orders:[]}},esc:v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),date:String,
  displayStatus:String,displayDate:String,displayCount:(n,word)=>`${n} ${word}`,patientWorkflowActions:()=>'',chartContactSummary:()=>'',patientEncounterHistoryRows:()=>'',patientEncounterHistoryEntries:()=>[],encounterDateLabel:v=>'Nov 10, 2026 · '+v.id});
 vm.runInContext(overview,c);const html=vm.runInContext('chartOverview()',c);
 return html.slice(html.indexOf('Latest vitals'),html.indexOf('Encounter history'));
}
const full={systolic_mm_hg:120,diastolic_mm_hg:80,heart_rate_bpm:72,temperature_c:36.8,oxygen_saturation_pct:98,weight_kg:70,height_cm:170};
const rows=html=>[...html.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]*) <small>([^<]*)<\/small><\/dd>/g)].map(match=>`${match[1]}: ${match[2]} ${match[3]}`);

let html=card([{id:'v1',vitals:full}]);
assert.deepEqual(rows(html),['Blood pressure: 120/80 mmHg','Pulse: 72 bpm','Temperature: 36.8 °C','Oxygen saturation: 98 %','Weight: 70 kg','Height: 170 cm']);
assert.match(html,/Last recorded · Nov 10, 2026 · v1/);
// An empty vitals record (saved without any measurement) is not "recorded vitals".
html=card([{id:'v1',vitals:{}}]);assert.doesNotMatch(html,/undefined|NaN|null/);assert.deepEqual(rows(html),[]);assert.match(html,/No vitals recorded yet\./);
// Only what was measured is listed. Half a blood pressure is not a blood pressure.
html=card([{id:'v1',vitals:{heart_rate_bpm:72,weight_kg:null,temperature_c:'',systolic_mm_hg:120}}]);assert.doesNotMatch(html,/undefined|NaN|null/);assert.deepEqual(rows(html),['Pulse: 72 bpm']);
html=card([{id:'v1',vitals:{systolic_mm_hg:118,diastolic_mm_hg:76}}]);assert.deepEqual(rows(html),['Blood pressure: 118/76 mmHg']);
html=card([{id:'v1',vitals:{...full,oxygen_saturation_pct:undefined,height_cm:Number.NaN}}]);assert.doesNotMatch(html,/undefined|NaN/);assert.equal(rows(html).length,4);
// A measured zero is still a measurement.
html=card([{id:'v1',vitals:{heart_rate_bpm:0}}]);assert.deepEqual(rows(html),['Pulse: 0 bpm']);
// An open visit with nothing measured yet does not hide an earlier visit's vitals.
html=card([{id:'open',vitals:{}},{id:'earlier',vitals:full}],{id:'open',vitals:{}});assert.equal(rows(html).length,6);assert.match(html,/Last recorded · Nov 10, 2026 · earlier/);
html=card([{id:'open',vitals:full}],{id:'open',vitals:full});assert.match(html,/This visit · /);
html=card([{id:'none'}]);assert.match(html,/No vitals recorded yet\./);assert.doesNotMatch(html,/undefined/);
console.log('PASS recorded vitals list only what was measured and never print undefined');
