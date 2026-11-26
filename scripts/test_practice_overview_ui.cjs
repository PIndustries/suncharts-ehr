// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Home work tiles and the merged attention list. Synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx=vm.createContext({console,Date,Intl,Math,Number,String,JSON,Array,Object,URLSearchParams,esc,money:c=>`$${(c/100).toFixed(2)}`,document:{addEventListener(){}},$:()=>null,me:{role:'owner'}});
vm.runInContext(fs.readFileSync('web/practice.js','utf8'),ctx);
const trend=Array.from({length:30},(_,i)=>({day:`2026-11-${String(i+1).padStart(2,'0')}`,charges_cents:i===29?8000:0,collected_cents:i===29?2500:0}));
const overview={patients:{active:12,insured:9,self_pay:3,missing_address:2,missing_phone:0,missing_member_id:1},
 claims:{by_status:{draft:{count:1,billed_cents:8000},submitted:{count:4,billed_cents:166181},rejected:{count:0,billed_cents:0},adjudicated:{count:2,billed_cents:30000}},needs_correction:1,received_by_clearinghouse:3},
 money:{collected_today_cents:2500,collected_month_cents:41000,charges_month_cents:250000,waiting_on_insurers_cents:166181,payment_account_balance:null},trend};
const data={overview,schedule:{},appointments:[{status:'checked_in'},{status:'booked'}],unfinished:{total:2},inbox:{items:[],limit:100},followup:{items:[]},referrals:{items:[]}};
const html=ctx.practiceDashboardMarkup(data);
for(const [label,value] of [['Appointments today','2'],['Notes to finish','2'],['Claims to send','1'],['Claims needing a fix','1']])assert.ok(html.includes(`<span>${label}</span><b>${value}</b>`),label);
assert.match(html,/data-practice-action="claims-send"/);assert.match(html,/data-practice-action="claims-fix"/);
assert.doesNotMatch(html,/Waiting on insurers|Charges this month|practice-chart|Last 30 days/);
const needs=ctx.practiceAttentionMarkup(data);
assert.match(needs,/Missing address<\/span><b>2/);assert.match(needs,/Missing phone<\/span><b>0/);
assert.equal((needs.match(/<li>/g)||[]).length,7);
const limited=ctx.practiceDashboardMarkup({...data,overview:{patients:overview.patients,claims:null}});
assert.match(limited,/<span>Claims to send<\/span><b>—/);assert.doesNotMatch(limited,/practice-chart/);
const source=fs.readFileSync('web/practice.js','utf8'),css=fs.readFileSync('web/practice-overview.css','utf8');
assert.match(source,/\/api\/v1\/practice\/overview\?\$\{new URLSearchParams\(\{tz:/);
assert.doesNotMatch(css,/#[0-9a-fA-F]{3,6}\b/,'theme tokens only');
console.log('PASS Home work tiles, merged attention, unavailable figures and theme tokens');
