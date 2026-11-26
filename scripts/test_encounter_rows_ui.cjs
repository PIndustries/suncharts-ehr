// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Lists that name an encounter show its practice number ("ENC-0005") in a chip that carries the
// encounter and the patient, even when that patient's chart is not open. Rows without an encounter
// show nothing extra. Synthetic rows only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ctx={console,Number,Date,Set,esc,money:c=>'$'+(Number(c)/100).toFixed(2),date:v=>'d('+v+')',displayDate:v=>v?'on '+v:'',displayStatus:v=>v,invoicePaymentMethod:v=>v,
 encounterNumberText:v=>{const n=Number(v?.encounter_number);return Number.isSafeInteger(n)&&n>0?`ENC-${String(n).padStart(4,'0')}`:'';},
 billingOverviewAllowed:()=>true,document:{addEventListener(){}},visitBillingStateName:s=>s,claimStatusLabel:c=>c.status,human:v=>v};
vm.createContext(ctx);
for(const f of ['encounter-timeline','billing-overview','claims','checkout','patient-billing-workspace'])vm.runInContext(fs.readFileSync(`web/${f}.js`,'utf8'),ctx);
assert.equal(ctx.encounterNumberLabel(5),'ENC-0005');assert.equal(ctx.encounterNumberLabel(null),'');
const chip=(html,visit,patient)=>assert.ok(html.includes(`data-encounter-chip="${visit}"`)&&html.includes(`data-patient="${patient}"`),`chip for ${visit}: ${html}`);
// Billing overview accounts.
{const html=ctx.billingOverviewAccountRows([{id:'a1',patient_id:'p1',patient_name:'Synthetic, A',mrn:'M1',visit_id:'v5',encounter_number:5,service_date:'2026-03-01',total_cents:100,status:'posted'},{id:'a2',patient_id:'p2',patient_name:'Synthetic, B',mrn:'M2',visit_id:null,encounter_number:null,service_date:'2026-03-02',total_cents:100,status:'posted'}]);
 const [one,two]=html.split('</tr><tr>');assert.ok(one.includes('ENC-0005'));chip(one,'v5','p1');assert.ok(!two.includes('encounter-chip'));assert.ok(!two.includes('ENC-'));}
// Copay receipts: the chip replaces the "Go to encounter" button; with no encounter the button stays.
{const html=ctx.billingOverviewCopayRows([{id:'r1',patient_id:'p1',patient_name:'S',mrn:'M',appointment_id:'ap1',visit_id:'v7',encounter_number:7,amount_cents:100,net_received_cents:100,usable_unapplied_cents:0,refunded_cents:0},{id:'r2',patient_id:'p1',patient_name:'S',mrn:'M',appointment_id:'ap2',visit_id:null,encounter_number:null,amount_cents:100,net_received_cents:100,usable_unapplied_cents:0,refunded_cents:0}]);
 const [one,two]=html.split('</tr><tr>');assert.ok(one.includes('ENC-0007'));chip(one,'v7','p1');assert.ok(!one.includes('data-receipt-encounter'),'one control per row');
 assert.ok(!two.includes('encounter-chip'));assert.ok(two.includes('data-receipt-encounter="ap2"'));}
// Claims list.
{const one=ctx.claimRowMarkup({id:'c1',patient_id:'p1',patient_name:'S',control_number:'CN1',payer_name:'P',frequency:'original',status:'draft',total_cents:100,visit_id:'v3',encounter_number:3,service_date:'2026-03-03'});
 assert.ok(one.includes('ENC-0003'));chip(one,'v3','p1');assert.match(one,/<td[^>]*class="monitor-date">on 2026-03-03<\/td>/);assert.match(one,/data-claim-open="c1"[^>]*>Open claim/);
 const two=ctx.claimRowMarkup({id:'c2',patient_id:'p1',patient_name:'S',control_number:'CN2',payer_name:'P',frequency:'original',status:'draft',total_cents:100,visit_id:null,encounter_number:null,service_date:null});
 assert.ok(!two.includes('encounter-chip'));assert.match(two,/<td[^>]*class="monitor-date">—<\/td>/);}
// Work queue.
{const rows=JSON.parse(JSON.stringify(ctx.workQueueItems({accounts:{items:[{id:'a1',patient_id:'p1',patient_name:'S',billing_state:'post_charges',visit_id:'v5',encounter_number:5}]},claims:{items:[{account_id:'a9',patient_id:'p3',patient_name:'C',status:'ready',visit_id:'v9',encounter_number:9},{account_id:'a8',patient_id:'p3',patient_name:'C',status:'ready',visit_id:null,encounter_number:null}]}})));
 const html=ctx.workQueueMarkup(rows,0,'all',false),items=html.split('<li');
 assert.ok(items[1].includes('ENC-0005'));chip(items[1],'v5','p1');assert.ok(items[2].includes('ENC-0009'));chip(items[2],'v9','p3');assert.ok(!items[3].includes('encounter-chip'));}
// Payment history: the number comes from the row though the chart is not open.
{const s={patientId:'p1'};
 const html=ctx.patientBillingPaymentEncounter({kind:'copay',visit_id:'v4',encounter_number:4,received_cents:100,created_at:'2026-03-01'},s);
 assert.ok(html.includes('ENC-0004'));chip(html,'v4','p1');assert.ok(html.includes('data-payment-amount="100"'));
 assert.ok(!ctx.patientBillingPaymentEncounter({kind:'copay',visit_id:null,encounter_number:null,appointment_id:'ap'},s).includes('encounter-chip'));}
console.log('encounter rows ui ok');
