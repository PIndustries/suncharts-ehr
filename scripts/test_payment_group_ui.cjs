// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {visitSummary}=require('./visit_billing_fixture.cjs');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const base=()=>({console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,esc,date:String,human:String,crypto:{randomUUID:()=>'group-1'},document:{addEventListener(){},querySelector:s=>s==='.practice-identity strong'?{textContent:'Synthetic Practice'}:null,createElement:()=>({setAttribute(){}})},testPaymentTag:()=>'',testPaymentLabel:()=>'Test payment'});
const load=(ctx,...files)=>{vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),ctx);for(const f of files)vm.runInContext(fs.readFileSync(f,'utf8'),ctx);return ctx;};

// Encounter breakdown: parts of one payment read as one line with one receipt button.
const vb=load({...base(),$:()=>null,me:{role:'owner'}},'web/billing.js','web/visit-billing.js');
const part=(id,cents,method,group,extra={})=>({id,appointment_id:'appointment',amount_cents:cents,method,occurred_on:'2026-11-12',voided:false,payment_group_id:group,...extra});
const summary=visitSummary({receipts:[part('r1',5000,'card','g1'),part('r2',2500,'cash','g1'),part('r3',2500,'check','g1'),part('r4',1000,'cash',null)]});
const html=vb.visitBillingBreakdown(summary,{canCreate:true,canWrite:true});
assert.match(html,/data-payment-group="g1" data-appointment="appointment">Receipt: Payment \$100\.00 · card \$50\.00, cash \$25\.00, check \$25\.00<\/button>/);
assert.equal((html.match(/data-payment-group=/g)||[]).length,1,'one receipt button for the whole payment');
assert.equal((html.match(/data-copay-receipt=/g)||[]).length,1,'only the ungrouped receipt keeps its own button');
assert.match(html,/data-copay-receipt="r4"/);assert.doesNotMatch(html,/data-copay-receipt="r[123]"/);

// Combined receipt: every tender, the total and the balance after payment.
const pr=load({...base(),encounterNumberForAppointment:()=>'ENC-0007',invoicePaymentMethod:m=>m},'web/billing.js','web/patient-revenue.js');
const receipts=[{id:'r1',appointment_id:'appointment',amount_cents:5000,method:'external',occurred_on:'2026-11-12',hosted_checkout:{livemode:true,card_brand:'visa',card_last4:'4242'}},{id:'r2',appointment_id:'appointment',amount_cents:2500,method:'cash',reference:'',occurred_on:'2026-11-12'},{id:'r3',appointment_id:'appointment',amount_cents:2500,method:'check',reference:'1042',occurred_on:'2026-11-12'}];
const context={practiceName:'Synthetic Practice',patient:{given_name:'Avery <b>',family_name:'Synthetic',mrn:'MRN1'},printedAt:'2026-11-12',balanceCents:4000};
const doc=pr.paymentGroupReceiptDocument(receipts,context);
for(const text of ['Synthetic Practice','Avery &lt;b&gt; Synthetic','ENC-0007','2026-11-12','Visa ending 4242','$50.00','Cash','$25.00','Check #1042','Total paid','$100.00','Patient balance after this payment','$40.00'])assert(doc.includes(text),text);
assert(!doc.includes('Avery <b>'));
const unknown=pr.paymentGroupReceiptDocument([{...receipts[0],hosted_checkout:{livemode:true}}],context);
assert.match(unknown,/<dt>Card<\/dt><dd>\$50\.00<\/dd>/);
const card=pr.paymentGroupReceiptCardMarkup(receipts,context);
assert.match(card,/data-copay-receipt-view/);assert.match(card,/Check #1042/);assert.match(card,/Balance after payment/);

// The window sends one id with every part, and only while it is open.
assert.equal(JSON.stringify(vm.runInContext('collectGroupField()',pr)),'{}');
console.log('PASS payment parts group into one encounter line and one combined receipt');
