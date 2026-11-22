// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The practice overview: tiles open their lists, the claims, 30-day and patient charts, the
// needs-attention list, and nothing about money or claims when the server sent none. Synthetic only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx=vm.createContext({console,Date,Intl,Math,Number,String,JSON,Array,Object,URLSearchParams,esc,money:c=>`$${(c/100).toFixed(2)}`,document:{addEventListener(){}},$:()=>null,me:{role:'owner'}});
vm.runInContext(fs.readFileSync('web/practice.js','utf8'),ctx);
const trend=Array.from({length:30},(_,i)=>({day:`2026-11-${String(i+1).padStart(2,'0')}`,charges_cents:i===29?8000:0,collected_cents:i===29?2500:0}));
const overview={patients:{active:12,insured:9,self_pay:3,missing_address:2,missing_phone:0,missing_member_id:1},
 claims:{by_status:{draft:{count:1,billed_cents:8000},submitted:{count:4,billed_cents:166181},rejected:{count:0,billed_cents:0},adjudicated:{count:2,billed_cents:30000}},needs_correction:1,received_by_clearinghouse:3},
 money:{collected_today_cents:2500,collected_month_cents:41000,charges_month_cents:250000,waiting_on_insurers_cents:166181,payment_account_balance:null},trend};
const html=ctx.practiceDashboardMarkup({overview,appointments:[{status:'checked_in'},{status:'booked'}],unfinished:{total:2}});
for(const [label,value] of [['Today’s patients','2'],['Unfinished encounters','2'],['Claims to send','1'],['Waiting on insurers','$1661.81'],['Collected today','$25.00'],['Charges this month','$2500.00']])
 assert.ok(html.includes(`<span>${label}</span><b>${value}</b>`),label);
assert.match(html,/data-practice-action="claims"/);assert.match(html,/data-practice-action="billing"/);
assert.match(html,/<h3>Claims<\/h3><div class="practice-bars"/);assert.match(html,/Ready to send 1/);assert.match(html,/Needs correcting 1/);assert.match(html,/With the clearinghouse 3/);
assert.match(html,/<h3>Last 30 days<\/h3>/);assert.match(html,/Charges \$80\.00/);assert.match(html,/Collected \$25\.00/);
assert.match(html,/<h3>Patients<\/h3>/);assert.match(html,/Insurance 9/);assert.match(html,/Self-pay 3/);assert.match(html,/12 active patients/);
assert.match(html,/Needs attention/);assert.match(html,/Patients: missing address<\/span><b>2/);assert.match(html,/insured, no member id<\/span><b>1/);assert.doesNotMatch(html,/missing phone/);
// Someone without billing view: patients only, no money, no claims.
const limited=ctx.practiceDashboardMarkup({overview:{patients:overview.patients,claims:null,money:null,trend:null},appointments:[],unfinished:{total:0}});
assert.doesNotMatch(limited,/Collected today|Waiting on insurers|<h3>Claims<\/h3>|Last 30 days/);assert.match(limited,/<h3>Patients<\/h3>/);
// The overview is loaded with the viewer's time zone, and its styles use theme tokens only.
const source=fs.readFileSync('web/practice.js','utf8'),css=fs.readFileSync('web/practice-overview.css','utf8');
assert.match(source,/\/api\/v1\/practice\/overview\?\$\{new URLSearchParams\(\{tz:/);
assert.doesNotMatch(css,/#[0-9a-fA-F]{3,6}\b/,'theme tokens only');
console.log('PASS practice overview: tiles open their lists, claims/30-day/patients charts, needs attention, billing figures only with billing view');
