// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const handlers={},nodes={},calls=[];
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},open:false,scrollIntoView(){},replaceChildren(){this.innerHTML='';}};
const receipt={id:'receipt',appointment_id:'appt',amount_cents:2500,allocated_cents:0,reversed_cents:0,voided:false,occurred_on:'2026-11-11',method:'external',account_ids:[],hosted_checkout:{id:'checkout',status:'paid',livemode:false,refunded_cents:0}};
const appointment={id:'appt',starts_at:'2026-11-11T14:00:00Z',status:'in_progress'};
const account={id:'account',status:'draft',version:1,total_cents:20000,content:{visit_id:'visit',service_date:'2026-11-11',lines:[],notes:''}};
const ctx={console,Date,Intl,URL,Map,Set,Array,me:{role:'owner'},selected:'patient',chartSection:'visits',billingSelected:null,activeVisit:{id:'visit',appointment_id:'appt',status:'signed'},workspace:{appointments:[appointment],visits:[{id:'visit',appointment_id:'appt'}],billing:{accounts:[account],entries:[],coverages:[],copays:[receipt]}},$:node,document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},esc:v=>String(v??''),money:n=>'$'+(n/100).toFixed(2),human:String,date:String,payerName:()=>'',billingCan:()=>true,billingPayers:[],showBillingAccount:(id)=>{ctx.billingSelected=id;node('encounter-billing-detail').innerHTML='REVIEW FORM';calls.push(['review',id]);},api:async(...args)=>calls.push(args),showChartSection:()=>{},setEncounterSection:()=>{},notice:()=>{},run:fn=>fn()};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
ctx.loadHostedCopays=()=>{};
const operation={id:'checkout',appointment_id:'appt',patient_id:'patient',amount_cents:2500,livemode:false,status:'paid',receipt_id:'receipt',created_at:'2026-11-11T14:00:00Z'};
const state=ctx.hostedCopayStateFor('appt');state.items=[operation];state.availability={available:true,livemode:false};
ctx.renderEncounterRevenue();let html=node('encounter-revenue').innerHTML;
assert.match(html,/Charges<\/span><strong>\$200.00/);assert.match(html,/Paid by patient<\/span><strong>\$25.00/);
assert.match(html,/Applied to this visit<\/span><strong>Not posted/);assert.match(html,/Balance<\/span><strong>Not posted/);
assert.match(html,/Edit CPT/);assert.match(html,/Card payment captured · not yet applied to charges/);
assert.equal((html.match(/class="primary"/g)||[]).length,1);assert.match(html,/class="primary" data-revenue-account="account">Review and post charges/);
assert.equal((html.match(/data-copay-receipt="receipt"/g)||[]).length,1);assert.doesNotMatch(html,/data-hosted-copay-receipt="receipt"/);
assert.doesNotMatch(html,/<details[^>]*id="encounter-charge-details"[^>]* open/);
const hosted=ctx.encounterHostedCopayMarkup(state);assert(hosted.indexOf('data-collect-card-copay')>hosted.indexOf('<details'),'additional collection is collapsed after capture');assert.doesNotMatch(hosted,/class="primary"/);
assert.equal(calls.some(c=>c[1]==='POST'),false,'render must never post charges or create card/claim actions');
node('encounter-billing-detail').innerHTML='REASON DRAFT';const button={dataset:{revenueAccount:'account'},hasAttribute:()=>false};for(const handler of handlers.click)handler({target:{closest:()=>button},preventDefault(){}});
assert.equal(node('encounter-charge-details').open,true);assert.equal(node('encounter-billing-detail').innerHTML,'REASON DRAFT','review disclosure preserves an already-open reason');assert.equal(calls.filter(c=>c[1]==='POST').length,0);
let receiptAccount=null;ctx.openEncounterBillingAccount=id=>{receiptAccount=id;};const ledgerButton={dataset:{copayAccount:'account'},hasAttribute:()=>false};for(const handler of handlers.click)handler({target:{closest:()=>ledgerButton},preventDefault(){}});assert.equal(receiptAccount,'account','receipt ledger link uses the encounter-preserving account navigation');
// Only server-verified receipts contribute to received totals; an open checkout contributes zero.
ctx.workspace.billing.copays=[];assert.match(ctx.encounterRevenueSummary(account),/Paid by patient<\/span><strong>\$0.00/);
const pending={...state,items:[{...operation,status:'open',receipt_id:null,checkout_url:'https://checkout.stripe.com/c/pay/example'}]};assert.match(ctx.encounterHostedCopayMarkup(pending),/Awaiting card payment/);assert.doesNotMatch(ctx.encounterHostedCopayMarkup(pending),/Card payment captured/);
// Net refunds and reversal/hold warnings remain explicit; unrelated ledger rows cannot affect this encounter.
ctx.workspace.billing.copays=[{...receipt,hosted_checkout:{...receipt.hosted_checkout,refunded_cents:1000,status:'needs_review'}}];
assert.match(ctx.encounterRevenueSummary(account),/\$15.00/);assert.match(ctx.encounterRevenueSummary(account),/requires review/);
const posted={...account,status:'posted'};ctx.workspace.billing.entries=[{id:'allocated',account_id:'account',kind:'payment',effect_cents:-2500,content:{copay_receipt_id:'receipt',party:'patient',test_mode:true}},{id:'refund',account_id:'account',kind:'adjustment_debit',effect_cents:500,content:{copay_receipt_id:'receipt',party:'patient',hosted_copay_operation_id:'checkout',test_mode:true}},{id:'other',account_id:'another-account',kind:'payment',effect_cents:-99999,content:{copay_receipt_id:'receipt'}}];
assert.equal(ctx.encounterPaymentTotals(posted).copay,2000);ctx.workspace.billing.entries.push({id:'reversal',account_id:'account',kind:'reversal',reverses_id:'allocated',effect_cents:2500,content:{}});assert.equal(ctx.encounterPaymentTotals(posted).copay,-500);
ctx.workspace.billing.entries=[];ctx.workspace.billing.copays=[receipt];
html=ctx.encounterRevenueStatusMarkup(posted,{loaded:true,claims:[{id:'claim',status:'submitted',created_at:'2026-11-11',frequency:'original'}]});assert.equal((html.match(/class="primary"/g)||[]).length,1);assert.match(html,/data-revenue-claim="claim"/);assert.match(html,/data-revenue-invoice="account"/);assert.match(html,/<details data-revenue-disclosure="claims">/);
ctx.billingCan=()=>false;html=ctx.encounterRevenueStatusMarkup(posted,{loaded:true,restricted:true});assert.doesNotMatch(html,/data-new-claim|data-revenue-invoice=/);assert.match(html,/requires access to insurance claims/);
// Exercise the actual account renderer: encounter details contain no duplicate claim/invoice totals/actions.
const billing=fs.readFileSync('web/billing.js','utf8');vm.runInContext(billing.slice(billing.indexOf('function showBillingAccount('),billing.indexOf('function coveragePayerOptions(')),ctx);
Object.assign(ctx,{billingDetailHost:()=>node('encounter-billing-detail'),chargeTable:()=>'<table>services</table>',billingChargeDraftRecovery:()=>'',accountDiagnosisSummary:()=>'',accountDiagnosisDraftRecovery:()=>'',billingField:()=>'<input name="reason" required>',entrySum:()=>0,billBalance:()=>20000,ledgerKind:String});
ctx.billingCan=()=>true;ctx.showBillingAccount('account',false);html=node('encounter-billing-detail').innerHTML;assert.doesNotMatch(html,/billing-totals/);assert.match(html,/name="reason" required/);assert.match(html,/id="billing-account-action"/);assert.match(html,/Posting locks the charges/);assert.match(html,/<details class="encounter-account-record"><summary>Payments/);
node('encounter-charge-details').open=false;ctx.showBillingAccount('account',false);assert.equal(node('encounter-charge-details').open,false,'background rendering leaves details collapsed');ctx.showBillingAccount('account',false,true);assert.equal(node('encounter-charge-details').open,true,'explicit account navigation reveals the account');
ctx.workspace.billing.accounts=[posted];ctx.showBillingAccount('account',false);html=node('encounter-billing-detail').innerHTML;assert.doesNotMatch(html,/data-build-patient-invoice|data-patient-invoices|data-new-claim/);assert.match(html,/data-new-ledger/);
ctx.chartSection='billing';ctx.showBillingAccount('account',false);assert.match(node('encounter-billing-detail').innerHTML,/billing-totals/);assert.match(node('encounter-billing-detail').innerHTML,/data-build-patient-invoice/,'standalone account controls are unchanged');
const claimsSource=fs.readFileSync('web/claims.js','utf8');assert.match(claimsSource,/showBillingAccount\(b.dataset.claimAccount,false,true\)/,'claim account navigation explicitly reveals charges');assert.match(billing,/setEncounterSection\('charges'\);billingSelected=id;showBillingAccount\(id,false,true\)/,'patient account navigation explicitly reveals charges');
console.log('PASS encounter summary, captured vs applied copay, one primary review action, retained reason, no duplicate receipt, collapsed details and role/financial guards');
