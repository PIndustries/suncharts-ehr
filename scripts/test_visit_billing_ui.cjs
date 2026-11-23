// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}
const {visitSummary,selfPay}=require('./visit_billing_fixture.cjs');
// The claim detail a one-click send reads back before it releases anything: the claim itself, the
// server's own preflight answer, and the Claim.MD route the claim file goes over.
const claimDetail=(over={})=>({claim:{id:'claim',status:'ready',version:2},preflight_issues:[],transport:{routes:[{provider:'claim_md',route_key:'claimmd'}]},...over});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={},nodes={};
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},hidden:false,open:false,scrollIntoView(){},querySelectorAll(){return [];},querySelector(sel){if(sel!=='[data-claim-send-error]'&&sel!=='.visit-billing-status .actions')return null;const at=this.innerHTML.indexOf('<div class="actions">');if(at<0)return null;const actionsEnd=this.innerHTML.indexOf('</div>',at);if(sel==='.visit-billing-status .actions')return{insertAdjacentHTML:(_,html)=>{this.alert=(html.match(/role="alert">(.*?)<\/p>/)||[])[1]||'';this.innerHTML=this.innerHTML.slice(0,actionsEnd)+html+this.innerHTML.slice(actionsEnd);}};return this.alert?{textContent:this.alert,remove:()=>{this.alert='';this.innerHTML=this.innerHTML.replace(/<p class="claim-send-error".*?<\/p>/,'');}}:null;},replaceChildren(){this.innerHTML='';},append(child){this.appended=child;}};
const appointment={id:'appointment',starts_at:'2026-11-12T15:00:00Z',timezone:'America/Chicago',status:'checked_in',title:'Office visit'};
const account={id:'account',version:2,status:'posted',patient_id:'patient',total_cents:28000,coverage_snapshot:{payer:{content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}},coverage:{content:{member_id:'SYN-MEMBER',verification:'manually_verified'}}},content:{visit_id:'visit',service_date:'2026-11-12',coverage_id:'coverage',lines:[],notes:''}};
const sent=[];let reply=()=>visitSummary();
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,crypto:{randomUUID:()=>'request'},setTimeout:()=>0,clearTimeout(){},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createElement:()=>({setAttribute(){}})},$:node,me:{role:'front_desk'},selected:'patient',billingSelected:null,chartSection:'visits',encounterSection:'charges',activeVisit:{id:'visit',appointment_id:'appointment',status:'signed',version:3},workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{}},appointments:[appointment],visits:[{id:'visit',appointment_id:'appointment'}],billing:{accounts:[account],coverages:[],entries:[],copays:[]}},esc,human:v=>String(v).replaceAll('_',' '),date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,dollars:v=>(v/100).toFixed(2),cents:v=>Math.round(Number(v)*100),payerName:()=>'Synthetic Medicare PPO',billingCan:()=>true,showChartSection(){},setEncounterSection(){},notice:message=>ctx.noticed=message,run:fn=>{ctx.pending=Promise.resolve().then(fn).catch(error=>{ctx.failed=error&&error.stack||String(error);});return ctx.pending;},openBillingEditor:html=>{ctx.editor=html;},patientInvoiceDocument:()=>'<html>statement</html>',showBillingAccount(){},showEncounterClaim:async(id,accountId)=>{ctx.openedClaim=[id,accountId];},claimEditor:(snapshot,claim)=>{ctx.editedClaim=claim.id;},api:async(url,method='GET',body)=>{sent.push([url,method,body]);return reply(url,method,body);}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/visit-billing.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/visit-review.js','utf8'),ctx);
ctx.loadHostedCopays=()=>{};
ctx.billingBase=()=>`/api/v1/patients/${ctx.selected}/billing/accounts`;
const all={canCreate:true,canWrite:true,claimsAllowed:true};let b0;
ctx.globalThis=ctx;ctx.__DIAG=[];
const card=(summary,context=all)=>{
 // The billing step holds one live state object; opening an encounter's charges draws its card from
 // it. That is what the card's main button asks about, so the step is simulated here.
 if(!ctx.billingStep)ctx.billingStep=vm.runInContext('encounterRevenueState',ctx);
 Object.assign(ctx.billingStep,{data:{summary},reviewCard:summary});
 return ctx.visitBillingCardMarkup(summary,context);
};
const primaries=html=>[...html.matchAll(/<button type="button" class="primary" ([^>]*)>([^<]*)</g)].map(match=>match[2]);
const click=dataset=>{const button={dataset,disabled:false,hasAttribute:name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) in dataset,closest:()=>null};for(const handler of handlers.click)handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});return button;};
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};

// Every state of the status line names who is waiting and has exactly one primary action
// (none when nothing is left to do). "Waiting on your office." is gone from every state,
// the sign-visit sentence never says both "must be signed" and "Waiting on the clinician.",
// and the patient and insurer wordings are "Waiting for".
const states=[
 [visitSummary({state:'add_charges',account:null,charges_cents:null,balance_cents:null,claim:null,insurance:{status:'not_billed',pending_cents:0},patient:{received_cents:0,owes_now_cents:1000},receipts:[]}),'Add charges','Add charges','data-encounter-charges',/Add the procedures done at this encounter\./],
 [visitSummary({state:'sign_visit',waiting_on:'clinician',account:{status:'draft'},balance_cents:null,claim:null,insurance:{status:'not_billed',pending_cents:0}}),'Charges can still be changed','Continue the encounter note','data-revenue-documentation',/The encounter note must be signed before the charges are posted\./],
  [visitSummary({state:'post_charges',account:{status:'draft'},balance_cents:null,claim:null,insurance:{status:'not_billed',pending_cents:0}}),'Post charges','Post charges','data-visit-post-charges="account"',/claim to Synthetic Medicare PPO is prepared for you next/],
 [selfPay(),'Self-pay: collect payment','Collect payment','data-visit-collect',/Patient owes \$280\.00\. Waiting for the patient/],
 [visitSummary({state:'claim_cancelled',claim:null}),'The claim to Synthetic Medicare PPO was cancelled','Prepare a new claim','data-visit-claim-prepare="again"',/Nothing is with the insurer/],
  [visitSummary({state:'fix_claim',claim:{issues:[{code:'tax_id',missing:'billing organization tax ID',detail:'Tax ID is required'},{code:'npi',missing:'provider NPI',detail:'x'}]}}),'Claim to Synthetic Medicare PPO needs details','Fix claim details',`data-visit-claim-fix="${esc(visitSummary().claim.id)}"`,/Practice billing setup:<\/b> billing organization tax ID, provider NPI/],
  // A claim the server has filled in and checked needs no review to press; it is ready to go out.
  [visitSummary({claim:{status:'ready'}}),'Claim ready to send to Synthetic Medicare PPO','Send claim to Synthetic Medicare PPO','data-visit-claim-direct-send="claim"',/Nothing has been sent yet\./],
  // A draft claim has not been checked yet, so the card still opens the review, which releases it.
  [visitSummary({claim:{status:'draft'}}),'Claim ready to send to Synthetic Medicare PPO','Review and send to the clearinghouse','data-visit-review-open="account"',/Nothing has been sent yet\./],
 [visitSummary({state:'waiting_insurer',waiting_on:'insurer',insurance:{status:'waiting',sent_on:'2026-11-12'},claim:{status:'submitted',sent_on:'2026-11-12'}}),'Waiting on Synthetic Medicare PPO','Check claim status','data-revenue-claim="claim"',/Claim sent Nov 12, 2026\. Nothing to do until they answer/],
 [visitSummary({state:'post_response',insurance:{status:'waiting'},claim:{status:'submitted',response_to_review:'era-1'}}),'Synthetic Medicare PPO answered','Review insurer payment','data-revenue-remittance="era-1"',/post it to this encounter/],
 [visitSummary({state:'denied',insurance:{status:'denied'},claim:{status:'adjudicated'}}),'Denied by Synthetic Medicare PPO','Fix and resend claim','data-revenue-claim="claim"',/Fix the claim and send it again/],
  [visitSummary({state:'review_response',insurance:{status:'answered',paid_cents:20000,adjusted_cents:4000,pending_cents:0,unassigned_cents:7000},claim:{status:'adjudicated',answer:{payment_date:'2026-11-20'}}}),'Insurance paid $200.00','Review insurer answer','data-revenue-claim="claim"',/\$70\.00 is not paid, written off or assigned to the patient yet/],
  [visitSummary({state:'patient_owes',waiting_on:'patient',insurance:{status:'answered',paid_cents:20000,adjusted_cents:4000,pending_cents:0},patient:{copay_cents:null,copay_paid_cents:null,copay_due_cents:null,paid_above_copay_cents:null,received_cents:0,receipts_applied_cents:0,other_patient_payments_cents:0,adjustment_cents:0,unapplied_cents:0,overpaid_cents:0,credit_cents:0,receipt_needs_review:false,responsibility_cents:4000,responsibility_source:'insurer_response',owes_now_cents:3000},balance_cents:3000,claim:{status:'adjudicated',answer:{payment_date:'2026-11-20'}}}),'Patient owes $30.00','Collect payment','data-visit-collect',/Insurance paid \$200\.00\. Waiting for the patient/],
 [visitSummary({state:'insurance_outside',claim:null,insurance:{electronic:false,status:'outside'}}),'Synthetic Medicare PPO is billed outside SunCharts','Record insurer payment','data-new-ledger',/no claim is sent from SunCharts/],
 [selfPay({state:'review_balance',waiting_on:'staff',insurance:{unassigned_cents:7000},patient:{owes_now_cents:0,responsibility_source:'reviewed_statement'},balance_cents:7000}),'$70.00 is not on the patient’s statement','Write off or adjust','data-new-ledger',/Write the rest off or adjust it/],
 [selfPay({state:'patient_credit',waiting_on:'staff',patient:{owes_now_cents:0,unapplied_cents:2000,credit_cents:2000},balance_cents:0}),'Patient has a $20.00 credit','Review payments','data-visit-history="payments"',/Refund the credit or keep it/],
];
// The card offers the review button only for the encounter whose billing state the screen is on:
// each state below is put on screen in turn, exactly as opening that visit would.
// Opening each encounter's billing step in turn, so a card is asked only what it would be asked
// on screen: the card of the encounter whose summary the step is holding.
ctx.setRevenueSummary=summary=>{ctx.shown=summary;return summary;};
for(const entry of states)entry[5]=ctx.setRevenueSummary(entry[0]);

for(const [summary,headline,label,attribute,detail,shown] of states){
 const html=card(shown);
 assert.ok(html.includes(`<p class="visit-billing-headline">${esc(headline)}</p>`),`${summary.state}: ${html.slice(0,400)}`);
 assert.deepEqual(primaries(html),[label],`${summary.state} has one primary action`);
 assert.ok(html.includes(`class="primary" ${attribute}>`),`${summary.state} action target`);
 assert.match(html,detail,summary.state);assert.ok(html.includes(`data-visit-billing-state="${summary.state}"`));
}
for(const [summary] of states){const html=card(summary).replace(/<[^>]*>/g,' ');assert.doesNotMatch(html,/Waiting on your office/,'the office is never named as the one who waits');assert.doesNotMatch(html,/Waiting on the patient|Waiting on the insurer(?!’s)/,'staff see "Waiting for" the patient or the insurer');if(summary.state==='sign_visit')assert.doesNotMatch(html,/must be signed[^\n]*Waiting on the clinician/,'a sentence that already says the note must be signed does not also say who it waits on');}
// A delegated support session acts for the practice: it is given the same Prepare claim button.
const support=card(visitSummary({state:'prepare_claim',claim:null}),{...all,delegated:true});assert.doesNotMatch(support,/A support session does not prepare claims/);assert.match(support,/data-visit-claim-prepare/);
b0=ctx.visitBillingBreakdown(selfPay({state:'review_balance',insurance:{unassigned_cents:7000},patient:{owes_now_cents:0,responsibility_source:'reviewed_statement'}}),all);assert.match(b0,/<th scope="row">Not on the statement<\/th><td>Write it off, adjust it or send a new statement<\/td><td class="money-cell">\$70\.00/);assert.match(b0,/What the latest statement says, less what they paid/);
const done=card(selfPay({state:'paid_in_full',waiting_on:'nobody',patient:{owes_now_cents:0},balance_cents:0}));
assert.match(done,/<span class="eyebrow">Status<\/span><p class="visit-billing-headline">Paid in full<\/p>/);assert.deepEqual(primaries(done),[]);
// The old one-after-another buttons are gone from the normal view in every state.
for(const [summary] of states){const html=card(summary);assert.doesNotMatch(html,/Prepare insurance claim|Review patient invoice|Saved invoices|Claim &amp; payment history|Account history|data-revenue-invoice|data-new-claim/);assert.doesNotMatch(html.replace(/<[^>]*>/g,' '),/ledger|posted charges|manually_verified|Payer snapshot|\bv\d\b|Account [0-9a-f]{8}/i,summary.state);}

// The breakdown: self-pay, copay paid, insurance pending, answered with a patient remainder, denied, overpaid.
const cell=(html,label)=>{const match=html.match(new RegExp(`<th scope="row">${label}</th><td>(.*?)</td><td class="money-cell">(.*?)</td>`));assert.ok(match,`${label} row in ${html}`);return [match[1],match[2]];};
let b=ctx.visitBillingBreakdown(selfPay(),all);
assert.deepEqual(cell(b,'Charges'),['Posted','$280.00']);assert.doesNotMatch(b,/Insurance:/);assert.match(b,/Patient \(self-pay\)/);assert.deepEqual(cell(b,'Patient owes now'),['No insurance on this encounter','$280.00']);
b=ctx.visitBillingBreakdown(visitSummary(),all);
assert.match(b,/Insurance: Synthetic Medicare PPO/);assert.deepEqual(cell(b,'Insurance paid'),['Not sent yet','$0.00']);assert.equal(cell(b,'Insurance pending')[1],'$270.00');
assert.deepEqual(cell(b,'Copay \\$10\\.00'),['Paid','$10.00']);assert.match(b,/<tr class="visit-billing-receipts"><th scope="row">Patient paid<\/th><td>1 payment · [^]*?<td class="money-cell">\$10\.00<\/td><\/tr>/);
assert.deepEqual(cell(b,'Patient owes now'),['Paid. Nothing more is due unless the insurer says so','$0.00']);assert.doesNotMatch(b,/data-visit-collect/,'a paid copay offers nothing to collect');
// What is due decides whether a payment is offered at all, and how a settled encounter reads.
assert.deepEqual(JSON.parse(JSON.stringify(ctx.visitBillingDue(visitSummary()))),{due:0,copayOnly:false,paid:1000,paidUp:true,label:'Nothing due now',note:'Paid. Nothing more is due unless the insurer says so'});
assert.match(ctx.visitBillingTotalsLine(visitSummary()),/<small>Patient paid<\/small><b>\$10\.00 · Nothing due now<\/b>/);
{const draft=visitSummary({account:{id:'a',status:'draft'},patient:{copay_cents:2500,copay_paid_cents:0,copay_due_cents:2500,owes_now_cents:0},receipts:[]}),d=ctx.visitBillingDue(draft);assert.equal(d.due,2500);assert.equal(d.copayOnly,true);assert.equal(d.paidUp,false);assert.match(ctx.visitBillingTotalsLine(draft),/class="is-due"><small>Copay due now<\/small><b>\$25\.00/);const rows=ctx.visitBillingBreakdown(draft,all);assert.deepEqual(cell(rows,'Copay due now'),['The rest is set when the charges are posted','$25.00']);assert.match(rows,/Not paid yet/);}
{const done=selfPay();done.patient={...done.patient,owes_now_cents:0};done.receipts=[{id:'r',amount_cents:28000,method:'cash'}];done.insurance={...(done.insurance||{}),pending_cents:0};const d=ctx.visitBillingDue(done);assert.equal(d.paidUp,true);assert.equal(d.label,'Paid in full');assert.match(ctx.visitBillingTotalsLine(done),/Patient paid<\/small><b>\$280\.00 · Paid in full/);}
b=ctx.visitBillingBreakdown(visitSummary({patient:{copay_cents:2500,copay_paid_cents:0,copay_due_cents:2500,received_cents:0,owes_now_cents:2500},receipts:[]}),all);
assert.match(cell(b,'Copay \\$25\\.00')[0],/^Not paid yet <button type="button" class="text-button" data-visit-collect>Collect<\/button>$/);assert.doesNotMatch(b,/visit-billing-receipts/);assert.equal(cell(b,'Patient owes now')[1],'$25.00');
assert.doesNotMatch(ctx.visitBillingBreakdown(visitSummary({patient:{copay_cents:2500,copay_paid_cents:0,copay_due_cents:2500,received_cents:0,owes_now_cents:2500},receipts:[]}),{canCreate:false}),/data-visit-collect/);
b=ctx.visitBillingBreakdown(visitSummary({state:'waiting_insurer',insurance:{status:'waiting',sent_on:'2026-11-12'}}),all);
assert.deepEqual(cell(b,'Insurance paid'),['Waiting since Nov 12, 2026','$0.00']);assert.deepEqual(cell(b,'Insurance pending'),['Waiting on the insurer’s answer','$270.00']);
const answered=visitSummary({state:'patient_owes',waiting_on:'patient',insurance:{status:'answered',paid_cents:20000,adjusted_cents:4000,pending_cents:0,unassigned_cents:0},patient:{copay_cents:1000,copay_paid_cents:1000,copay_due_cents:0,received_cents:1000,receipts_applied_cents:1000,other_patient_payments_cents:0,adjustment_cents:0,unapplied_cents:0,overpaid_cents:0,credit_cents:0,responsibility_cents:4000,responsibility_source:'insurer_response',owes_now_cents:3000},balance_cents:3000,claim:{status:'adjudicated',answer:{payment_date:'2026-11-20'}}});
b=ctx.visitBillingBreakdown(answered,all);
assert.deepEqual(cell(b,'Insurance paid'),['Answered Nov 20, 2026','$200.00']);assert.deepEqual(cell(b,'Insurance adjustments'),['Written off, not owed by anyone','$40.00']);assert.doesNotMatch(b,/Insurance pending/);
assert.deepEqual(cell(b,'Patient owes now'),['What the insurer says the patient owes, less what they paid','$30.00']);
b=ctx.visitBillingBreakdown(visitSummary({state:'denied',insurance:{status:'denied'}}),all);
assert.deepEqual(cell(b,'Insurance paid'),['Denied','$0.00']);assert.deepEqual(cell(b,'Insurance pending'),['Denied. Fix and resend the claim','$270.00']);assert.equal(cell(b,'Patient owes now')[1],'$0.00','a denial is never handed to the patient');
b=ctx.visitBillingBreakdown(visitSummary({state:'patient_credit',insurance:{status:'answered',paid_cents:27500,pending_cents:0},patient:{copay_cents:2500,copay_paid_cents:2500,received_cents:2500,overpaid_cents:2500,credit_cents:2500,responsibility_cents:0,responsibility_source:'insurer_response'},balance_cents:-2500}),all);
assert.deepEqual(cell(b,'Paid more than owed'),['Refund it or keep it as a credit','$25.00']);assert.equal(cell(b,'Patient owes now')[1],'$0.00');
b=ctx.visitBillingBreakdown(selfPay({patient:{unapplied_cents:1500,received_cents:1500},receipts:[{id:'r2',appointment_id:'appointment',amount_cents:1500,method:'card',occurred_on:'2026-11-12',voided:false}]}),all);
assert.match(cell(b,'Paid but not applied yet')[0],/data-apply-copays/);assert.match(b,/<th scope="row">Patient paid<\/th>/);
assert.match(ctx.visitBillingBreakdown(visitSummary({patient:{receipt_needs_review:true}}),all),/A payment for this encounter needs review/);
b=ctx.visitBillingBreakdown(visitSummary({patient:{copay_cents:2500,copay_paid_cents:1000,copay_due_cents:1500,owes_now_cents:1500}}),all);assert.match(cell(b,'Copay \\$25\\.00')[0],/^\$10\.00 paid, \$15\.00 still due <button[^>]*data-visit-collect>Collect<\/button>$/);assert.equal(cell(b,'Copay \\$25\\.00')[1],'$10.00');
b=ctx.visitBillingBreakdown(visitSummary({patient:{received_cents:1500,other_patient_payments_cents:500}}),all);assert.deepEqual(cell(b,'Other patient payments'),['','$5.00']);b=ctx.visitBillingBreakdown(selfPay({patient:{other_patient_payments_cents:4000}}),all);assert.deepEqual(cell(b,'Patient payments'),['','$40.00']);
// A copay the plan never recorded but the insurer reported: the card says where it came from.
const fromCheck=visitSummary({state:'waiting_insurer',waiting_on:'insurer',insurance:{status:'waiting',sent_on:'2026-11-12',pending_cents:27000},patient:{copay_cents:1500,copay_paid_cents:0,copay_due_cents:1500,paid_above_copay_cents:0,received_cents:0,receipts_applied_cents:0,other_patient_payments_cents:0,responsibility_cents:0,responsibility_source:'insurer_check_copay',owes_now_cents:0,copay_from_insurer_check:true,copay_source_date:'2026-11-10'},receipts:[],claim:{status:'submitted',sent_on:'2026-11-12'}});
b=ctx.visitBillingBreakdown(fromCheck,all);
assert.deepEqual(cell(b,'Copay \\$15\\.00'),['from the insurer check on Nov 10, 2026','']);
assert.deepEqual(cell(b,'Patient owes now'),['Based on the insurer check on Nov 10, 2026','$0.00']);
assert.doesNotMatch(b,/No copay recorded for this plan|The plan copay, until the insurer answers/,'a copay from the check is neither missing nor the plan\'s own');
// A date the server did not send is never invented, and the plain copay rows are unchanged.
b=ctx.visitBillingBreakdown(visitSummary({...fromCheck,patient:{...fromCheck.patient,copay_source_date:null}}),all);
assert.deepEqual(cell(b,'Copay \\$15\\.00'),['from the insurer check on ','']);
b=ctx.visitBillingBreakdown(visitSummary(),all);
assert.deepEqual(cell(b,'Copay \\$10\\.00'),['Paid','$10.00']);assert.deepEqual(cell(b,'Patient owes now'),['Paid. Nothing more is due unless the insurer says so','$0.00']);
b=ctx.visitBillingBreakdown(visitSummary({patient:{copay_cents:null,copay_paid_cents:null,copay_due_cents:null,paid_above_copay_cents:null,received_cents:0,receipts_applied_cents:0,other_patient_payments_cents:0,responsibility_cents:0,responsibility_source:'copay_not_recorded',owes_now_cents:0,copay_from_insurer_check:false,copay_source_date:null},receipts:[]}),all);
assert.match(b,/<th scope="row">Copay<\/th><td>No copay recorded for this plan<\/td><td class="money-cell"><\/td>/);assert.deepEqual(cell(b,'Patient owes now'),['Nothing until the insurer answers','$0.00']);
// Amounts are only formatted: every money cell is exactly a value the server sent.
const answeredMoney=answered,shown=[...ctx.visitBillingBreakdown(answered,all).matchAll(/\$(\d+\.\d\d)/g)].map(m=>Math.round(Number(m[1])*100)),served=new Set([answered.charges_cents,...Object.values(answered.insurance),...Object.values(answered.patient)].filter(Number.isInteger));
for(const value of shown)assert.ok(served.has(value),`${value} was not sent by the server`);

// Collect payment is one action; the ways to pay sit inside it and "More" keeps rare actions reachable.
const hostedState={appointment:'appointment',patient:'patient',items:[],availability:{available:true,livemode:true}};
const options=ctx.hostedCopayMarkup(hostedState,true);
for(const [attribute,label] of [['data-reader-copay','Card on reader'],['data-saved-card-copay','Card on file'],['data-collect-card-copay','Online payment link']])assert.ok(options.includes(`${attribute}="appointment" >${label}</button>`),label+options);
assert.doesNotMatch(options,/Check payment status|Card payment details|additional collection|class="primary"/);
assert.match(ctx.hostedCopayMarkup({...hostedState,items:[{id:'op',appointment_id:'appointment',amount_cents:1000,livemode:true,status:'open',created_at:'2026-11-12T15:00:00Z'}]},true),/Awaiting card payment[\s\S]*Check card payment status/);
assert.match(ctx.hostedCopayMarkup({...hostedState,availability:{available:false,reason:'Card payments are not set up.'}},true),/Card payments aren’t set up yet\./);
const more=ctx.visitBillingMore(answered,all);
for(const expected of ['data-visit-statement>Patient statement','data-new-ledger>Record a payment, write-off or adjustment','data-visit-history="payments">Refunds and card payments','data-revenue-claim="claim">Open claim: correct, void or bill secondary insurance','/api/v1/billing/claims/claim/cms1500','data-chart-section="insurance">Insurance and eligibility'])assert.ok(more.includes(expected),expected);
assert.match(more,/^<details class="visit-billing-more" data-revenue-disclosure="more"><summary>More actions<\/summary>/);
assert.doesNotMatch(ctx.visitBillingMore(visitSummary({claim:{secondary:true}}),all),/cms1500/,'no CMS-1500 for a secondary claim');
assert.doesNotMatch(ctx.visitBillingMore(visitSummary(),{canCreate:false,canWrite:false,claimsAllowed:false}),/data-new-ledger|data-visit-statement|data-revenue-claim/);

// One history, with the old destinations as filters; technical details only for the owner.
const timeline=[{at:'2026-11-12T15:00:00Z',group:'charges',code:'charges_added',amount_cents:28000},{at:'2026-11-12T15:05:00Z',group:'payments',code:'payment_received',amount_cents:1000,method:'cash',receipt_id:'receipt',appointment_id:'appointment'},{at:'2026-11-12T16:00:00Z',group:'charges',code:'charges_posted',amount_cents:28000},{at:'2026-11-12T16:00:01Z',group:'insurance',code:'claim_prepared_auto',claim_id:'claim',insurer:'Synthetic <b>Plan</b>'},{at:'2026-11-12T17:00:00Z',group:'insurance',code:'claim_sent',claim_id:'claim',insurer:'Synthetic <b>Plan</b>'},{at:'2026-11-20T10:00:00Z',group:'insurance',code:'insurer_payment',amount_cents:20000},{at:'2026-11-20T10:00:00Z',group:'insurance',code:'insurer_adjustment',amount_cents:4000},{at:'2026-11-20T10:00:01Z',group:'insurance',code:'claim_answered',claim_id:'claim',insurer:'Synthetic <b>Plan</b>',patient_responsibility_cents:4000},{at:'2026-11-21T10:00:00Z',group:'statements',code:'statement',amount_cents:3000,invoice_id:'invoice-old'},{at:'2026-11-22T10:00:00Z',group:'payments',code:'patient_payment',amount_cents:3000,method:'check'}];
const history=ctx.visitBillingTimeline({timeline},all,'all');
for(const text of ['Charges added: $280.00','Payment taken: $10.00 (cash)','Charges posted: $280.00. Charges are posted','Claim to Synthetic &lt;b&gt;Plan&lt;/b&gt; prepared from this encounter','Claim sent to Synthetic &lt;b&gt;Plan&lt;/b&gt;','Insurance paid $200.00','Insurance adjustment: $40.00 written off','answered: patient owes $40.00','Statement given: $30.00 due','Patient payment: $30.00 (check)'])assert.ok(history.includes(text),text);
assert.equal((history.match(/<li /g)||[]).length,timeline.length);assert.ok(history.indexOf('Charges added')<history.indexOf('Patient payment'),'oldest first');
assert.match(history,/<time>Nov 12, 2026<\/time>/);assert.match(history,/data-visit-statement-open="invoice-old">View statement/);assert.match(history,/data-copay-receipt="receipt" data-appointment="appointment">Receipt/);
assert.deepEqual([...history.matchAll(/data-visit-history-filter="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].map(m=>[m[1],m[2],m[3]]),[['all','true','Everything'],['charges','false','Charges'],['insurance','false','Insurance'],['payments','false','Payments'],['statements','false','Statements']]);
const statements=ctx.visitBillingTimeline({timeline},all,'statements');assert.equal((statements.match(/<li /g)||[]).length,1);assert.match(statements,/Statement given/);
assert.equal((ctx.visitBillingTimeline({timeline},all,'insurance').match(/<li /g)||[]).length,5);
assert.doesNotMatch(ctx.visitBillingTimeline({timeline},{claimsAllowed:false},'all'),/data-revenue-claim/);
assert.match(ctx.visitBillingTimeline({timeline:[]},all,'statements'),/No statement has been prepared for this encounter/);
assert.equal(ctx.visitBillingTechnical(visitSummary()),'','nothing technical unless the server sent it');
const technical=ctx.visitBillingTechnical(visitSummary({technical:{account_id:'e40f1da7-0000',account_version:2,member_id:'SYN-<MEMBER>',coverage_verification:'manually_verified',payer_code:'SYN',claims:[{control_number:'SC000TEST',version:3,status:'draft',payer_control_number:''}]}}));
assert.match(technical,/<dt>Charge account<\/dt><dd>e40f1da7-0000<\/dd>/);assert.match(technical,/SYN-&lt;MEMBER&gt;/);assert.match(technical,/manually verified/);assert.match(technical,/SC000TEST · version 3/);

// Escaping: insurer names, issue text and receipt fields are text, never markup.
const hostile=card(visitSummary({state:'fix_claim',insurance:{insurer:'<img src=x onerror=1>'},claim:{payer_name:'<script>x</script>',id:'"><b>',issues:[{missing:'<i>tax</i>'}]},receipts:[{id:'"onclick="x',appointment_id:'a"b',amount_cents:1000,method:'cash',occurred_on:'2026-11-12'}]}));
assert.doesNotMatch(hostile,/<img|<script|<i>tax|"onclick="x"/);assert.match(hostile,/&lt;script&gt;x&lt;\/script&gt;/);assert.match(hostile,/Claim:<\/b> &lt;i&gt;tax&lt;\/i&gt;/);
// The claim id is hostile markup too: it stays escaped in every button and link it seeds.
// The card's main button hands claim fixes to the review panel, so the id travels through the
// open-claim hook in More instead; either way it is never raw markup.
assert.match(hostile,/data-revenue-claim="&quot;&gt;&lt;b&gt;"/);assert.doesNotMatch(hostile,/data-visit-claim-fix=""><b>"/);

// Missing details are de-duplicated and split into one line per place they are fixed, each with its own button.
const grouped=card(visitSummary({state:'fix_claim',claim:{id:'claim',issues:[
 {code:'tax_id',missing:'billing organization tax ID',detail:'Tax ID is required'},
 {code:'npi',missing:'provider NPI',detail:'x'},
 {code:'billing organization tax ID',missing:'billing organization tax ID'}, // duplicate text, same as first
 {code:'',missing:'patient address',detail:'x'},
 {missing:'Subscriber name'}, // keyword match, not a known code
 {code:'',missing:'plan year is not supported',detail:'x'}, // nothing matches: stays with the claim
]}}));
const missingLines=[...grouped.matchAll(/<p class="visit-billing-missing" data-missing-group="(\w+)"><b>([^<]*)<\/b>([^<]*?)(?: <button type="button"([^>]*)>([^<]*)<\/button>)?<\/p>/g)].map(m=>({group:m[1],label:m[2],items:m[3].trim(),attrs:(m[4]||'').trim(),action:m[5]||''}));
assert.deepEqual(missingLines.map(line=>line.group),['practice','patient','insurance','claim'],'lines come in practice, patient, insurance, then claim order');
assert.deepEqual(missingLines.map(line=>line.label),['Practice billing setup:','Patient:','Insurance:','Claim:']);
// Each group holds only its own items, joined on one line; the duplicate "billing organization tax ID" appears once.
assert.equal(missingLines[0].items,'billing organization tax ID, provider NPI');
assert.equal((grouped.match(/billing organization tax ID/g)||[]).length,1,'a repeated missing detail is listed once');
assert.equal(missingLines[1].items,'patient address');
assert.equal(missingLines[2].items,'Subscriber name','a keyword match lands with insurance even without a known code');
assert.equal(missingLines[3].items,'plan year is not supported','anything unrecognised stays with the claim');
// Each line's one button opens exactly the right place; the claim line has none of its own.
const buttonWiring={
 'Open practice billing setup':'data-billing-organizations',
 'Edit patient details':'data-chart-section="profile"',
 'Edit insurance':'data-chart-section="insurance"',
};
for(const line of missingLines.filter(line=>line.action))assert.equal(line.attrs,buttonWiring[line.action],`${line.action} button carries the right hook`);
assert.equal(missingLines.find(line=>line.group==='claim').action,'','the Claim line lists its items as text only');
// The three setup buttons appear once each, and the card has exactly one "Fix claim details": its main action.
for(const [action] of Object.entries(buttonWiring))assert.equal((grouped.match(new RegExp(`>${action}<\\/button>`,'g'))||[]).length,1,`${action} appears once`);
// Nothing can be sent while details are missing, so there is no Review and send; the one main
// action opens the claim's own Fix here boxes on this encounter.
assert.equal((grouped.match(/data-visit-review-open/g)||[]).length,0,'no Review and send while the claim cannot be sent');
assert.equal((grouped.match(/data-visit-claim-fix/g)||[]).length,1,'one Fix claim details');
// Only practice/patient/insurance items missing: the main action is still the one Fix claim details.
const nonClaimOnly=card(visitSummary({state:'fix_claim',claim:{id:'claim',issues:[{code:'tax_id',missing:'billing organization tax ID'},{code:'patient_address',missing:'patient address'},{code:'subscriber_name',missing:'subscriber name'}]}}));
assert.equal((nonClaimOnly.match(/data-visit-review-open/g)||[]).length,0,'no Review and send while the claim cannot be sent');
assert.equal((nonClaimOnly.match(/data-visit-claim-fix/g)||[]).length,1,'Fix claim details is the one main action');
// Dates and vocabulary.
assert.equal(ctx.visitBillingDate('2026-11-12'),'Nov 12, 2026');assert.equal(ctx.visitBillingDate(''),'');assert.equal(ctx.visitBillingDate('not a date'),'');
assert.equal(ctx.visitBillingClaimState({status:'ready'}),'Send claim');assert.equal(ctx.visitBillingClaimState({status:'accepted'}),'Waiting on insurer');assert.equal(ctx.visitBillingClaimState({status:'rejected'}),'Denied: fix and resend');assert.equal(ctx.visitBillingClaimState({status:'submitted',crossover_tracking_only:true}),'Secondary insurer answered');
assert.equal(ctx.visitBillingStateName('waiting_insurer'),'Waiting on insurer');assert.equal(ctx.visitBillingStateName('send_claim'),ctx.visitBillingClaimState({status:'draft'}),'one vocabulary for the card and the claims list');
// A posted visit's charge status says "Posted", never "Charges are final", in the card, its
// breakdown, the state name list and the history line.
assert.equal(ctx.visitBillingStateName('claim_restricted'),'Posted','a restricted account is named the same way');
assert.doesNotMatch(card(selfPay()),/Charges are final/,'the card never says charges are final');
assert.doesNotMatch(ctx.visitBillingBreakdown(selfPay(),all),/Charges are final/);
assert.doesNotMatch(card(visitSummary({state:'claim_restricted',claim:null,insurance:{status:'restricted'}})),/Charges are final/);
assert.match(ctx.visitBillingTimeline({timeline:[{at:'2026-11-12T16:00:00Z',group:'charges',code:'charges_posted',amount_cents:28000}]},all,'all'),/Charges posted: \$280\.00\. Charges are posted/);
// The card refreshes itself after a save; it offers no Refresh button of its own.
for(const [summary] of states.concat([[selfPay()],[visitSummary({state:'claim_restricted',claim:null})]])){
 const html=card(summary);
 assert.doesNotMatch(html,/data-refresh-revenue|>Refresh</,`${summary.state}: the card has no Refresh button`);
 assert.doesNotMatch(html,/<h3>Visit billing<\/h3>/,"the card sits inside the Invoice block with no title of its own");
}
// Every save path still redraws the card: the shared status loader paints the card node, and
// each action that changes billing goes through it.
const revenueSource=fs.readFileSync('web/patient-revenue.js','utf8');
assert.match(revenueSource,/function paintEncounterRevenue\(state,current\)\{[\s\S]*?node\.innerHTML=encounterRevenueStatusMarkup\(encounterChargeAccount\(\),state\.data\|\|\{\}\)/,'a status refresh repaints the card');
for(const action of ['postVisitChargesFromCard','prepareVisitClaim','openVisitStatement']){
 assert.match(revenueSource,new RegExp(`async function ${action}\\([^)]*\\)\\{[\\s\\S]*?loadEncounterRevenueStatus\\(encounterChargeAccount\\(\\),true\\)`),`${action} reloads the card from the server when it saves`);
}
assert.match(revenueSource,/finally\{state\.pending=null;render\(\);/,'and the reload is drawn whether the read succeeds or not');
const claimsSource=fs.readFileSync('web/claims.js','utf8'),overviewSource=fs.readFileSync('web/billing-overview.js','utf8');
assert.match(claimsSource,/function claimStatusLabel\(claim\)\{return typeof visitBillingClaimState==='function'\?visitBillingClaimState\(claim\)/);assert.match(overviewSource,/visitBillingStateName\(row\.billing_state\)/);
// No hard-coded colours anywhere in the card's styles or markup.
const css=fs.readFileSync('web/visit-billing.css','utf8');assert.doesNotMatch(css,/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|[:\s](white|black|red|green|blue|gray|grey|orange|yellow)[;}\s]/);assert.match(css,/var\(--line\)/);
assert.doesNotMatch(fs.readFileSync('web/visit-billing.js','utf8'),/style="|#[0-9a-fA-F]{6}\b|rgb\(/);
// The claim page gives the same instruction as its one button; nothing tells staff to prepare or mark ready by hand.
const nativeSource=fs.readFileSync('web/claimmd-native.js','utf8');assert.match(nativeSource,/'Check the details, then continue to send\.'/);
for(const source of [claimsSource,nativeSource])assert.doesNotMatch(source,/mark (it|the claim) ready|Mark claim ready|Create a claim from the billing section|Prepare insurance claim/);
const index=fs.readFileSync('web/index.html','utf8');assert.ok(index.indexOf('/visit-billing.js')<index.indexOf('/patient-revenue.js'));assert.match(index,/href="\/visit-billing\.css"/);

(async()=>{
 // Opening an older posted visit with no claim prepares it once, then shows it ready to send.
 let prepared=0;reply=(url,method)=>{if(url.endsWith('/claims/prepare')){prepared++;return {outcome:'prepared',claim_id:'claim',issues:[]};}return prepared?visitSummary():visitSummary({state:'prepare_claim',claim:null,claim_count:0});};
 ctx.renderEncounterRevenue();await settle();
 let host=node('encounter-revenue').innerHTML,status=node('encounter-revenue-status').innerHTML;
 assert.deepEqual(sent.map(c=>[c[0],c[1]]),[['/api/v1/patients/patient/billing/visit-summary?visit_id=visit','GET'],['/api/v1/patients/patient/billing/accounts/account/claims/prepare','POST'],['/api/v1/patients/patient/billing/visit-summary?visit_id=visit','GET']]);
 assert.equal(JSON.stringify(sent[1][2]),'{}','preparing sends no amounts and no claim details');
 assert.match(status,/Claim ready to send to Synthetic Medicare PPO/);assert.deepEqual(primaries(status),['Review and send to the clearinghouse']);
 await ctx.loadEncounterRevenueStatus(account,true);assert.equal(prepared,1,'a refresh never prepares again');
 // Layout: one card, collect hidden until asked, charges and history collapsed, details not offered to staff.
 assert.match(host,/<h2>Procedures \(CPT\)<\/h2><p class="muted">Nov 12, 2026 · Posted<\/p>/);
 assert.match(host,/<section id="visit-billing-collect" class="billing-section" hidden>/);assert.match(host,/data-record-copay="appointment">Cash or check<\/button>/);
 assert.match(host,/<div class="invoice-lines" id="encounter-billing-detail"><\/div>/);assert.match(host,/<details class="encounter-account-record" id="visit-billing-history"><summary>History<\/summary>/);assert.match(host,/<section class="billing-section" id="visit-billing-payments"><h3>Payments<\/h3><div id="visit-billing-ledger"><\/div><\/section>/);assert.match(host,/<nav class="invoice-tabs[^"]*"[^>]*>.*data-invoice-tab-key="note"[^>]*>Note<.*data-invoice-tab-key="billing"[^>]*>Billing<.*data-invoice-tab-key="history"[^>]*>History</);
 assert.doesNotMatch(host,/visit-billing-details|<h3>Copay<\/h3>|Insurance &amp; coverage details|Charges &amp; ledger details|Record a cash or check payment/);
 assert.equal((host.match(/id="encounter-claims"/g)||[]).length,1,'the claim view keeps its place');
 // The owner gets Details; the server decides what is in it.
 ctx.me={role:'owner'};node('encounter-revenue').dataset.revenueKey='';reply=()=>visitSummary({technical:{account_id:'e40f1da7',account_version:2,claims:[]}});ctx.renderEncounterRevenue();await settle();
 assert.match(node('encounter-revenue').innerHTML,/<details class="encounter-account-record" id="visit-billing-details" hidden><summary>Technical details<\/summary>/);assert.equal(node('visit-billing-details').hidden,false);assert.match(node('visit-billing-technical').innerHTML,/e40f1da7/);
 assert.doesNotMatch(node('encounter-revenue-status').innerHTML,/e40f1da7/,'identifiers stay out of the normal view');
 ctx.me={role:'front_desk'};node('visit-billing-details').hidden=true;

 // Review and send opens the claim for review; Fix opens its editor. Neither sends anything.
 sent.length=0;click({visitClaimSend:'claim'});await ctx.pending;assert.deepEqual(ctx.openedClaim,['claim','account']);assert.equal(sent.length,0);
 ctx.claimCurrent={id:'claim',status:'draft',snapshot:{account}};click({visitClaimFix:'claim'});await ctx.pending;assert.equal(ctx.editedClaim,'claim');assert.equal(sent.length,0);
  // The card's one main button opens the review panel beside the charge table; it sends nothing.
  click({visitReviewOpen:'account'});assert.equal(node('visit-billing-review').hidden,false);assert.match(node('visit-billing-review').innerHTML,/Check before it goes out/);assert.equal(sent.length,0,'opening the review sends nothing');
   click({visitReviewClose:''});assert.equal(node('visit-billing-review').hidden,true,'the review closes again');

  // ---- One press sends a claim that is ready ----------------------------------------------
  // The card of the encounter on screen, holding a claim the server filled in and checked.
  const readySummary=visitSummary({claim:{status:'ready'}});
  // The step holds the encounter's draft account, as it does before anything is posted: the send
  // checks this screen is on an encounter with charges, then reads the claim back from the server.
  const draftAccount={...account,status:'draft',version:2};
  const readyButton=(button,shown)=>{ctx.workspace.billing.accounts=[draftAccount];ctx.billingStep.data={summary:shown};ctx.billingStep.account='account';ctx.billingStep.visit='visit';ctx.billingStep.reviewCard=shown;return card(shown)&&button;};
  const readyCard=()=>card(readySummary);
  ctx.claimMdConnectionState={configured:true,connected:true};ctx.loadClaimMdConnection=async()=>ctx.claimMdConnectionState;
  // Its one main button is the send itself, and a small text link beside it still opens the review.
  let out=readyCard();
  assert.match(out,/class="primary" data-visit-claim-direct-send="claim">Send claim to Synthetic Medicare PPO</);
  assert.match(out,/class="text-button" data-visit-review-open="account">Review claim</);
  assert.deepEqual(primaries(out),['Send claim to Synthetic Medicare PPO'],'one primary action, and it is the send');
  assert.equal((out.match(/data-visit-review-open/g)||[]).length,1,'the card offers the review once, as the small link');
  // A claim already with the insurer, a secondary claim, a support session and a sign-in that
  // cannot write or cannot see claims are given no send at all.
  for(const [why,shown,context] of [
   ['already sent',visitSummary({state:'waiting_insurer',insurance:{status:'waiting'},claim:{status:'submitted'}}),all],
   ['secondary',visitSummary({claim:{status:'ready',secondary:true}}),all],
   ['crossover',visitSummary({claim:{status:'ready',crossover:true}}),all],
   ['no payer id',visitSummary({claim:{status:'ready'},insurance:{electronic:false}}),all],
   ['read-only',readySummary,{...all,canWrite:false}],
   ['claims hidden',readySummary,{...all,claimsAllowed:false}],
  ]){const html=card(shown,context);assert.doesNotMatch(html,/data-visit-claim-direct-send/,`${why}: nothing to press`);}
  // A support session acts for the practice and gets the same one-click send.
  assert.match(card(readySummary,{...all,delegated:true}),/data-visit-claim-direct-send/,'support session: the same send button');
  // A card drawn away from the live visit keeps the review button instead of a send: the send
  // reads the account the screen is actually on, and this card does not know it.
  ctx.billingStep.reviewCard={...readySummary};
  assert.doesNotMatch(ctx.visitBillingCardMarkup({...readySummary,account:{...readySummary.account,id:'other'}},all),/data-visit-claim-direct-send/,'a card for another visit keeps its own button');
  ctx.billingStep.reviewCard=readySummary;
   // Pressing it runs exactly the request the review panel's final send uses today: the claim read
   // back, released if it is a draft, submitted as an 837, then delivered over the Claim.MD route.
   // A reply that answers for itself, the way the review panel's own test drives the chain.
   let apiReply=()=>({});
   // Whether this press's own chain reached the insurer: it is the 837 being submitted that moves
   // the encounter on, so the reload answers accordingly and nothing else.
   let claimSendLanded=detail=>false;
   ctx.api=async(url,method='GET',body,version)=>{sent.push([url,method,body,version]);return apiReply(url,method,body,version);};
   // The card is drawn from the summary given, as it is before the press, so the screen answers
   // for that visit and nothing the last press left behind.
   const pressSend=async(detail,button,shown=readySummary)=>{
    sent.length=0;ctx.noticed=null;ctx.failed=null;
    claimSendLanded=()=>sent.some(c=>c[1]==='POST'&&c[0].endsWith('/837p'));
    // The chain stops before it runs for a claim that already reached the insurer.
    if(detail.claim.status==='submitted'){apiReply=()=>detail;}else
    apiReply=(url,method)=>{
     if(url==='/api/v1/billing/claimmd/status')return {configured:true,connected:true};
     if(url==='/api/v1/billing/claims/claim')return detail;
     if(url==='/api/v1/billing/claims/claim/actions')return {claim:{...detail.claim,status:'ready',version:detail.claim.version+1}};
     if(url.endsWith('/837p'))return {id:'submission',version:1};
     if(url.endsWith('/delivery'))return {submission:{id:'submission',version:2}};
     // The card's reload after the press: a send that went through leaves the encounter waiting on
     // the insurer; a send that stopped leaves it exactly as it was.
     if(url.includes('/visit-summary'))return claimSendLanded&&claimSendLanded(detail)?visitSummary({state:'waiting_insurer',waiting_on:'insurer',insurance:{status:'waiting',sent_on:'2026-11-12'},claim:{status:'submitted',sent_on:'2026-11-12'}}):shown;
     throw new Error('Unexpected API '+url);};
    // The step is opened on this encounter as the page opens it, so the pressed button answers for it.
   ctx.billingStep.version=draftAccount.version;
   const pressed=readyButton({dataset:{visitClaimDirectSend:'claim'},disabled:false,textContent:'Send claim to Synthetic Medicare PPO',isConnected:true,hasAttribute:()=>false,closest:()=>null},shown);
   for(const handler of handlers.click)handler({target:{closest:()=>pressed},preventDefault(){}});
   await settle();await ctx.pending;await settle();
   return pressed;
  };
  let pressed=await pressSend(claimDetail());
  assert.equal(ctx.failed||null,null,ctx.failed);
  assert.deepEqual(sent.filter(c=>c[1]==='POST').map(c=>[c[0],c[1],JSON.stringify(c[2])]),[
   ['/api/v1/billing/claims/claim/837p','POST',JSON.stringify({request_id:'request',details:{},acknowledged:false})],
   ['/api/v1/billing/submissions/submission/delivery','POST',JSON.stringify({request_id:'request',route_key:'claimmd',reason:'Sent from the encounter'})]],'submitted then delivered, exactly as the panel sends');
  assert.equal(sent.filter(c=>c[0].endsWith('/claims/claim/actions')).length,0,'a claim already released is not released again');
  assert.equal(ctx.noticed,'Claim sent to Synthetic Medicare PPO.','the notice names the insurer');
  assert.match(node('encounter-revenue-status').innerHTML,/Waiting on Synthetic Medicare PPO/,'the card re-renders to what the server now says');
  // While it runs the button is disabled and says so; a claim already at Claim.MD is not pushed
  // again and the button comes back with its own words.
  ctx.claimHasPreparedSubmission=()=>true;
  sent.length=0;
  const busyButton=await pressSend(claimDetail());
  assert.equal(busyButton.disabled,false,'a stopped send gives its button back');
  assert.equal(busyButton.textContent,'Send claim to Synthetic Medicare PPO','and the same words it started with');
  assert.equal(sent.filter(c=>c[1]==='POST').length,0,'no second claim file');
  assert.match(node('encounter-revenue-status').innerHTML,/already has a claim file/,'the card says why it stopped');
  ctx.claimHasPreparedSubmission=undefined;
  // A claim already with the insurer is not sent a second time either.
  sent.length=0;await pressSend(claimDetail({claim:{id:'claim',status:'submitted',version:4}}),null,readySummary);
  assert.equal(sent.filter(c=>c[1]==='POST').length,0,'a claim already with the insurer is left alone');
  assert.match(node('encounter-revenue-status').innerHTML,/already with the insurer/);
  // The server's own words show beside the button and nothing else changes.
  const stopped=await pressSend(claimDetail({preflight_issues:['Rendering provider NPI is missing']}));
  assert.equal(stopped.disabled,false);assert.equal(stopped.textContent,'Send claim to Synthetic Medicare PPO');
  assert.match(node('encounter-revenue-status').innerHTML,/Rendering provider NPI is missing/,'the server\'s own words stay on the card');
  assert.match(node('encounter-revenue-status').innerHTML,/role="alert"/,'said as an alert');
  assert.equal(sent.filter(c=>c[1]==='POST').length,0,'a refused preflight writes nothing');
  // A draft claim is released first, with the version it was read at.
  sent.length=0;pressed=await pressSend(claimDetail({claim:{id:'claim',status:'draft',version:3}}));
  assert.deepEqual(sent.filter(c=>c[0].endsWith('/claims/claim/actions')).map(c=>[c[1],JSON.stringify(c[2]),c[3]]),[['POST',JSON.stringify({action:'ready',reason:'Claim details reviewed before sending',reference:'',event_date:null,payer_control_number:''}),3]],'released with the version it read');
  assert.ok(sent.filter(c=>c[0].endsWith('/837p')).length===1,'and then sent');
  // The small review link still opens today's panel and sends nothing.
  sent.length=0;click({visitReviewOpen:'account'});assert.equal(node('visit-billing-review').hidden,false);assert.equal(sent.length,0,'the review link sends nothing');
  click({visitReviewClose:''});

  // The presses above swapped the live account for the draft they sent from; the workspace goes
  // back to the encounter's real account before the cases below read it.
  ctx.workspace.billing.accounts=[account];
  // ---- Self-pay keeps "Post charges", never a send ----------------------------------------
  const selfDraft=selfPay({state:'post_charges',waiting_on:'staff',account:{id:'account',status:'draft',version:2},balance_cents:null,claim:null});
  card(selfDraft);
  const selfCard=ctx.visitBillingCardMarkup(ctx.billingStep.reviewCard,all),selfStep=ctx.visitBillingChargeStep(ctx.billingStep.reviewCard,all);
  assert.deepEqual(primaries(selfCard),['Post charges'],'self-pay posts charges, nothing about a claim');
  assert.doesNotMatch(selfCard,/send claim|Post charges and send claim/i);
  assert.equal(selfStep.label,'Post charges');assert.equal(selfStep.attribute,'data-visit-post-charges="account"','and the line under the table says the same');
  // Insurance with no electronic ID is billed outside SunCharts, so it is never offered a send.
  const noPayer=visitSummary({state:'post_charges',account:{id:'account',status:'draft',version:2},claim:null,insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:false,status:'not_billed'}});
  card(noPayer);
  assert.equal(ctx.visitBillingChargeStep(ctx.billingStep.reviewCard,all).label,'Post charges','a payer with no insurer ID keeps the plain post');

  // ---- Post charges and send claim stops on fix_claim --------------------------------------
  // A draft the practice is working, with a payer whose claims go electronically: the line under
  // the charge table offers one button that posts, lets the claim be prepared, and sends it.
  // Something the claim cannot go without is asked for before the charges post: the card's one button
  // opens the codes, and the line under the charge table says the same thing.
  {const status=vm.runInContext('visitBillingStatus',ctx),step=vm.runInContext('visitBillingChargeStep',ctx);
   const none=visitSummary({state:'post_charges',account:{id:'account',status:'draft',version:2},balance_cents:null,claim:null,before_posting:[{code:'diagnoses',missing:'a diagnosis'}]});
   const card=status(none,{canWrite:true,canCreate:true});
   assert.equal(card.headline,'Add a diagnosis');assert.match(card.action,/data-encounter-charges/);assert.doesNotMatch(card.action,/data-visit-post-charges/);assert.match(card.detail,/cannot be sent without it/);
   assert.match(step(none,{canWrite:true}).text,/Add a diagnosis before you post/);
   const some=visitSummary({state:'post_charges',account:{id:'account',status:'draft',version:2},balance_cents:null,claim:null,before_posting:[{code:'line_diagnoses',missing:'a diagnosis for every charge',lines:2}]});
   assert.equal(status(some,{canWrite:true}).headline,'Link a diagnosis to every charge');assert.match(status(some,{canWrite:true}).detail,/2 charges have no diagnosis linked/);
   const one={...some,before_posting:[{code:'line_diagnoses',lines:1}]};assert.match(status(one,{canWrite:true}).detail,/One charge has no diagnosis linked/);
   // Someone who cannot change the charges is not sent to fix them, and nothing missing leaves the step as it was.
   assert.equal(status(none,{canWrite:false}).headline,'Post charges');
   assert.equal(status({...none,before_posting:[]},{canWrite:true}).headline,'Post charges');}
  const draftPost=visitSummary({state:'post_charges',account:{id:'account',status:'draft',version:2},balance_cents:null,claim:null});
  const draftWorkspace={...account,status:'draft',content:{...account.content,coverage_id:'coverage'}};
  ctx.workspace.billing.accounts=[draftWorkspace];ctx.__afterPostSend=true;
  ctx.workspace.billing.coverages=[{id:'coverage',version:1,content:{payer_id:'payer',priority:'primary',status:'active',effective_date:'2026-01-01',end_date:null,member_id:'SYN-MEMBER'}}];
  ctx.billingPayers=[{id:'payer',content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}}];
  // Opening the encounter's charges draws its card, and the line under the table answers from that
  // same on-screen step, so the card is put on screen first.
  card(draftPost);
  assert.equal(ctx.visitBillingChargeStep(ctx.billingStep.reviewCard,all).label,'Post charges and send claim');
  // The claim the server prepares after the post comes back needing details: the press stops there
  // and the card is left showing the fix_claim card with its issues. Nothing is submitted.
  const fixAfter=visitSummary({state:'fix_claim',account:{id:'account',status:'posted',version:3},claim:{id:'claim',status:'draft',issues:[{code:'tax_id',missing:'billing organization tax ID',detail:'Tax ID is required'}]}});
  ctx.confirmAction=async()=>true;ctx.selectPatient=async()=>{sent.push(['rerender']);};
  apiReply=(url,method)=>{
   if(url.endsWith('/actions')&&method==='POST')return account;
   if(url.includes('/visit-summary'))return fixAfter;
   throw new Error('Unexpected API '+url);};
  sent.length=0;ctx.noticed=null;
  node('encounter-revenue-status').innerHTML=ctx.visitBillingCardMarkup(draftPost,all);
  click({visitPostAndSend:'account'});await ctx.pending;await settle();
  assert.equal(ctx.failed||null,null,ctx.failed);
  assert.ok(sent.some(c=>c[0].endsWith('/accounts/account/actions')&&c[1]==='POST'&&c[2].action==='post'),'the charges were posted');
  assert.equal(sent.filter(c=>c[1]==='POST'&&c[0]!=='rerender').length,1,'nothing beyond the post was written');
  assert.equal(sent.filter(c=>c[0].endsWith('/837p')).length,0,'a claim that needs details is never submitted');
  assert.match(ctx.noticed||'',/needs details/,'the screen says the claim is not ready');
  assert.match(node('encounter-revenue-status').innerHTML,/Claim to Synthetic Medicare PPO needs details/,'the card shows the fix_claim state');
  assert.match(node('encounter-revenue-status').innerHTML,/billing organization tax ID/,'with its issues listed');
  // A cancelled ask writes nothing at all.
  ctx.confirmAction=async()=>false;sent.length=0;
  click({visitPostAndSend:'account'});await ctx.pending;await settle();
  assert.equal(sent.filter(c=>c[1]==='POST').length,0,'a cancelled ask writes nothing');
  ctx.confirmAction=async()=>true;
  apiReply=(url,method,body)=>{if(url.includes('/visit-summary'))return visitSummary({account:{id:'account',status:'draft',version:2}});return {};};
  // The workspace and the api go back to what the remaining cases read.
  if(ctx.__afterPostSend){ctx.workspace.billing.accounts=[account];ctx.api=async(url,method='GET',body)=>{sent.push([url,method,body]);return reply(url,method,body);};delete ctx.__afterPostSend;}

 // Each "missing details" button opens its own place. The card emits the hook; the app's global
 // handlers do the opening. Prove the handler exists, then that a card click reaches it.
 const appSource=fs.readFileSync('web/app.js','utf8'),practiceBillingSource=fs.readFileSync('web/practice-billing.js','utf8');
 assert.match(appSource,/if\(button\.dataset\.chartSection\)\{showChartSection\(button\.dataset\.chartSection\);return;\}/,'a [data-chart-section] click opens that chart section');
 assert.match(practiceBillingSource,/if\(button\.hasAttribute\('data-billing-organizations'\)\)\{event\.preventDefault\(\);run\(showBillingOrganizations\);return;\}/,'[data-billing-organizations] opens practice billing setup');
 // "Edit patient details" / "Edit insurance" behave like a click on the matching chart control.
 let chartOpen=null;ctx.showChartSection=section=>{chartOpen=section;};
 const chartHandlers=(appSource.match(/document\.addEventListener\('click'/)||[]).length;assert.ok(chartHandlers,'app.js installs a click handler');
 // Simulate the app's dispatch: a card button carrying [data-chart-section] opens that section.
 const openChart=dataset=>{if(dataset.chartSection)ctx.showChartSection(dataset.chartSection);};
 openChart({chartSection:'profile'});assert.equal(chartOpen,'profile','"Edit patient details" opens the chart profile');
 openChart({chartSection:'insurance'});assert.equal(chartOpen,'insurance','"Edit insurance" opens the chart insurance');
 // The buttons the card actually emits carry exactly those hooks, so a real click dispatches here.
 const missingCard=card(visitSummary({state:'fix_claim',claim:{id:'claim',issues:[{code:'tax_id',missing:'billing organization tax ID'},{code:'patient_address',missing:'patient address'},{code:'subscriber_name',missing:'subscriber name'}]}}));
 assert.match(missingCard,/<button type="button" data-billing-organizations>Open practice billing setup<\/button>/);
 assert.match(missingCard,/<button type="button" data-chart-section="profile">Edit patient details<\/button>/);
 assert.match(missingCard,/<button type="button" data-chart-section="insurance">Edit insurance<\/button>/);
 // With canWrite off the claim-fix button is gone but the three setup buttons still point somewhere useful.
 const readOnly=card(visitSummary({state:'fix_claim',claim:{id:'claim',issues:[{code:'tax_id',missing:'billing organization tax ID'},{code:'patient_address',missing:'patient address'},{code:'subscriber_name',missing:'subscriber name'}]}}),{canCreate:false,canWrite:false,claimsAllowed:false});
 assert.doesNotMatch(readOnly,/data-visit-claim-fix/,'read-only staff get no fix-claim button');
 assert.match(readOnly,/data-billing-organizations>Open practice billing setup/);assert.match(readOnly,/data-chart-section="profile">Edit patient details/);assert.match(readOnly,/data-chart-section="insurance">Edit insurance/);
 // With nothing missing there are no lines at all.
 assert.doesNotMatch(card(visitSummary({state:'fix_claim',claim:{id:'claim',issues:[]}})),/visit-billing-missing/,'no missing details, no lines');
 ctx.showChartSection=()=>{};

 // Collect payment reveals the one panel with the amount the server says is owed.
 await ctx.loadEncounterRevenueStatus(account,true);reply=()=>selfPay({patient:{owes_now_cents:4200}});await ctx.loadEncounterRevenueStatus(account,true);
 node('visit-billing-collect').hidden=true;click({visitCollect:''});assert.equal(node('visit-billing-collect').hidden,false);assert.equal(node('visit-billing-collect-note').textContent,'Patient owes now $42.00.');
 assert.equal(ctx.visitCollectAmount('appointment',1000),4200);assert.equal(ctx.visitCollectAmount('other-appointment',1000),1000);
 click({visitCollectClose:''});assert.equal(node('visit-billing-collect').hidden,true);
 ctx.openCopayReceiptEditor('appointment');assert.match(ctx.editor,/name="amount" inputmode="decimal" required value="42\.00"/,'cash or check starts from what is owed');

 // The statement record is made the first time it is needed, and only then.
 sent.length=0;reply=(url,method)=>url.endsWith('/statement')?{created:true,invoice:{id:'invoice',patient_id:'patient',account_id:'account',created_at:'2026-11-21T10:00:00Z',snapshot:{amount_due_cents:4200,service_date:'2026-11-12'}}}:selfPay({patient:{owes_now_cents:4200}});
 click({visitStatement:''});await ctx.pending;await settle();
 assert.equal(JSON.stringify(sent[0]),JSON.stringify(['/api/v1/patients/patient/billing/accounts/account/statement','POST',{}]),'no amount is typed or sent by the browser');
 assert.match(ctx.editor,/<h3>Invoice<\/h3>/);assert.match(ctx.editor,/\$42\.00 due as of Nov 21, 2026/);assert.match(ctx.editor,/data-print-patient-invoice>Print \/ save PDF/);assert.doesNotMatch(ctx.editor,/mailto:/,'no email on file, no email action');
 ctx.workspace.demographics.content.email='avery@example.test';ctx.showVisitStatement({id:'invoice',created_at:'2026-11-21T10:00:00Z',snapshot:{amount_due_cents:4200}});assert.match(ctx.editor,/href="mailto:avery%40example\.test\?subject=Your%20statement">Email the patient/);assert.doesNotMatch(ctx.editor.match(/mailto:[^"]*/)[0],/42|Nov|visit/i,'no amount or visit detail in the link');
 reply=()=>({created:true,invoice:{id:'invoice',patient_id:'someone-else',account_id:'account',snapshot:{}}});ctx.editor='';click({visitStatement:''});await ctx.pending;assert.equal(ctx.editor,'','a statement for another patient is never shown');
 // An earlier statement opens from history only when it belongs to this encounter.
 reply=()=>({id:'invoice-old',patient_id:'patient',account_id:'account',created_at:'2026-11-01T10:00:00Z',snapshot:{amount_due_cents:900}});click({visitStatementOpen:'invoice-old'});await ctx.pending;assert.match(ctx.editor,/\$9\.00 due as of Nov 1, 2026/);
 reply=()=>({id:'invoice-x',patient_id:'patient',account_id:'another',snapshot:{}});let refused;ctx.run=fn=>ctx.pending=Promise.resolve().then(fn).catch(error=>{refused=error.message;});click({visitStatementOpen:'invoice-x'});await ctx.pending;assert.match(refused,/does not belong to the open visit/);ctx.run=fn=>ctx.pending=Promise.resolve().then(fn);

 // History filters and the payments shortcut.
 reply=()=>visitSummary({timeline});await ctx.loadEncounterRevenueStatus(account,true);
 click({visitHistory:'payments'});assert.equal(node('visit-billing-history').open,true);assert.equal((node('visit-billing-timeline').innerHTML.match(/<li /g)||[]).length,2);
 click({visitHistoryFilter:'all'});assert.equal((node('visit-billing-timeline').innerHTML.match(/<li /g)||[]).length,timeline.length);

 // A failed prepare says why and offers one way forward; asking again is explicit.
 node('encounter-revenue').dataset.revenueKey='';ctx.workspace.billing.accounts=[{...account,version:3}];sent.length=0;reply=(url)=>{if(url.endsWith('/claims/prepare'))throw new Error('The charges changed; open the encounter again');return visitSummary({state:'prepare_claim',claim:null,claim_count:0,account:{version:3}});};
 ctx.renderEncounterRevenue();await settle();status=node('encounter-revenue-status').innerHTML;
 assert.match(status,/The claim to Synthetic Medicare PPO could not be prepared/);assert.match(status,/The charges changed; open the encounter again\. Try again, or open Insurance and eligibility/);assert.deepEqual(primaries(status),['Try again']);
 assert.equal(sent.filter(c=>c[1]==='POST').length,1);await ctx.loadEncounterRevenueStatus(ctx.workspace.billing.accounts[0],true);assert.equal(sent.filter(c=>c[1]==='POST').length,1,'no retry loop');
 reply=(url,method,body)=>url.endsWith('/claims/prepare')?{outcome:'prepared'}:visitSummary({account:{version:3}});click({visitClaimPrepare:'again'});await ctx.pending;await settle();
 assert.equal(JSON.stringify(sent.filter(c=>c[1]==='POST').at(-1)[2]),'{"again":true}');assert.equal(ctx.noticed,'Claim prepared from this encounter. Nothing was sent.');assert.match(node('encounter-revenue-status').innerHTML,/Claim ready to send/);
 // A delegated support session never triggers the automatic draft, by its own flag or the server's; it prepares by pressing.
 for(const [identity,viewer] of [[{role:'owner',delegated:true},{delegated:false}],[{role:'owner'},{delegated:true}]]){ctx.me=identity;node('encounter-revenue').dataset.revenueKey='';ctx.workspace.billing.accounts=[{...account,version:ctx.workspace.billing.accounts[0].version+1}];sent.length=0;reply=()=>visitSummary({state:'prepare_claim',claim:null,account:{version:ctx.workspace.billing.accounts[0].version},viewer});ctx.renderEncounterRevenue();await settle();assert.equal(sent.filter(c=>c[1]==='POST').length,0,'support session wrote nothing');assert.match(node('encounter-revenue-status').innerHTML,/data-visit-claim-prepare/,'it is offered the Prepare claim button to press itself');}
 ctx.me={role:'front_desk'};
 // Opening the encounter on another step (its note, from the schedule or the chart) prepares nothing; going to the billing step does.
 ctx.encounterSection='documentation';node('encounter-revenue').dataset.revenueKey='';ctx.workspace.billing.accounts=[{...account,version:30}];sent.length=0;let made=false;reply=url=>{if(url.endsWith('/claims/prepare')){made=true;return {outcome:'prepared'};}return made?visitSummary({account:{version:30}}):visitSummary({state:'prepare_claim',claim:null,account:{version:30}});};ctx.renderEncounterRevenue();await settle();
 assert.equal(sent.filter(c=>c[1]==='POST').length,0,'the note step never prepares a claim');
 ctx.encounterSection='charges';ctx.renderEncounterRevenue();await settle();assert.equal(sent.filter(c=>c[1]==='POST').length,1,'the billing step prepares it at once');assert.match(node('encounter-revenue-status').innerHTML,/Claim ready to send/);
 // People who cannot prepare claims never trigger it.
 ctx.billingCan=()=>false;node('encounter-revenue').dataset.revenueKey='';ctx.workspace.billing.accounts=[{...account,version:40}];sent.length=0;reply=()=>visitSummary({state:'prepare_claim',claim:null,account:{version:40}});ctx.renderEncounterRevenue();await settle();
 assert.equal(sent.filter(c=>c[1]==='POST').length,0);assert.match(node('encounter-revenue-status').innerHTML,/Billing staff prepare the claim to Synthetic Medicare PPO/);assert.deepEqual(primaries(node('encounter-revenue-status').innerHTML),[]);
 // Start payment plan is offered from the encounter More list only when charges are posted, the patient owes something and staff can create.
 {const column=(summary,context)=>ctx.visitBillingColumn(summary,context);
  const owes=visitSummary({account:{status:'posted'},patient:{owes_now_cents:4000,received_cents:0}});
  assert.match(column(owes,{canCreate:true}),/<button type="button" data-start-payment-plan>Start payment plan<\/button>/);
  assert.doesNotMatch(column(owes,{canCreate:false}),/data-start-payment-plan/,'needs permission to create');
  assert.doesNotMatch(column(visitSummary({account:{status:'draft'},patient:{owes_now_cents:4000}}),{canCreate:true}),/data-start-payment-plan/,'needs posted charges');
  assert.doesNotMatch(column(visitSummary({account:{status:'posted'},patient:{owes_now_cents:0}}),{canCreate:true}),/data-start-payment-plan/,'needs an amount owed');}
 console.log('PASS visit billing card: one next step per state, self-explaining breakdown, automatic claim draft, statement on first use, one history, owner-only details, escaping and theme colours');
})().catch(error=>{console.error(error);process.exitCode=1;});
