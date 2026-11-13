// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}
const {visitSummary,selfPay}=require('./visit_billing_fixture.cjs');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={},nodes={};
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},hidden:false,open:false,scrollIntoView(){},querySelector(){return null;},querySelectorAll(){return [];},replaceChildren(){this.innerHTML='';},append(child){this.appended=child;}};
const appointment={id:'appointment',starts_at:'2026-11-12T15:00:00Z',timezone:'America/Chicago',status:'checked_in',title:'Office visit'};
const account={id:'account',version:2,status:'posted',patient_id:'patient',total_cents:28000,coverage_snapshot:{payer:{content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}},coverage:{content:{member_id:'SYN-MEMBER',verification:'manually_verified'}}},content:{visit_id:'visit',service_date:'2026-11-12',coverage_id:'coverage',lines:[],notes:''}};
const sent=[];let reply=()=>visitSummary();
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,crypto:{randomUUID:()=>'request'},setTimeout:()=>0,clearTimeout(){},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createElement:()=>({setAttribute(){}})},$:node,me:{role:'front_desk'},selected:'patient',billingSelected:null,chartSection:'visits',encounterSection:'charges',activeVisit:{id:'visit',appointment_id:'appointment',status:'signed',version:3},workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{}},appointments:[appointment],visits:[{id:'visit',appointment_id:'appointment'}],billing:{accounts:[account],coverages:[],entries:[],copays:[]}},esc,human:v=>String(v).replaceAll('_',' '),date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,dollars:v=>(v/100).toFixed(2),cents:v=>Math.round(Number(v)*100),payerName:()=>'Synthetic Medicare PPO',billingCan:()=>true,showChartSection(){},setEncounterSection(){},notice:message=>ctx.noticed=message,run:fn=>ctx.pending=Promise.resolve().then(fn),openBillingEditor:html=>{ctx.editor=html;},patientInvoiceDocument:()=>'<html>statement</html>',showBillingAccount(){},showEncounterClaim:async(id,accountId)=>{ctx.openedClaim=[id,accountId];},claimEditor:(snapshot,claim)=>{ctx.editedClaim=claim.id;},api:async(url,method='GET',body)=>{sent.push([url,method,body]);return reply(url,method,body);}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/visit-billing.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
ctx.loadHostedCopays=()=>{};
const all={canCreate:true,canWrite:true,claimsAllowed:true};
const card=(summary,context=all)=>ctx.visitBillingCardMarkup(summary,context);
const primaries=html=>[...html.matchAll(/<button type="button" class="primary" ([^>]*)>([^<]*)</g)].map(match=>match[2]);
const click=dataset=>{const button={dataset,disabled:false,hasAttribute:name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) in dataset,closest:()=>null};for(const handler of handlers.click)handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});return button;};
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};

// Every state of the status line names who is waiting and has exactly one primary action
// (none when nothing is left to do).
const states=[
 [visitSummary({state:'add_charges',account:null,charges_cents:null,balance_cents:null,claim:null,insurance:{status:'not_billed',pending_cents:0},patient:{received_cents:0,owes_now_cents:1000},receipts:[]}),'Add charges','Add charges','data-encounter-charges',/Waiting on your office/],
 [visitSummary({state:'sign_visit',waiting_on:'clinician',account:{status:'draft'},balance_cents:null,claim:null,insurance:{status:'not_billed',pending_cents:0}}),'Charges can still be changed','Continue the visit note','data-revenue-documentation',/Waiting on the clinician/],
 [visitSummary({state:'post_charges',account:{status:'draft'},balance_cents:null,claim:null,insurance:{status:'not_billed',pending_cents:0}}),'Post charges','Review and post charges','data-revenue-account="account"',/claim to Synthetic Medicare PPO is prepared for you next/],
 [selfPay(),'Self-pay: collect payment','Collect payment','data-visit-collect',/Patient owes \$280\.00\. Waiting on the patient/],
 [visitSummary({state:'claim_cancelled',claim:null}),'The claim to Synthetic Medicare PPO was cancelled','Prepare a new claim','data-visit-claim-prepare="again"',/Nothing is with the insurer/],
 [visitSummary({state:'fix_claim',claim:{issues:[{code:'tax_id',missing:'billing organization tax ID',detail:'Tax ID is required'},{code:'npi',missing:'provider NPI',detail:'x'}]}}),'Claim to Synthetic Medicare PPO needs details','Fix claim details','data-visit-claim-fix="claim"',/Missing: billing organization tax ID, provider NPI/],
 [visitSummary(),'Claim ready to send to Synthetic Medicare PPO','Review and send claim','data-visit-claim-send="claim"',/Nothing has been sent yet\. Waiting on your office/],
 [visitSummary({state:'waiting_insurer',waiting_on:'insurer',insurance:{status:'waiting',sent_on:'2026-11-12'},claim:{status:'submitted',sent_on:'2026-11-12'}}),'Waiting on Synthetic Medicare PPO','Check claim status','data-revenue-claim="claim"',/Claim sent Nov 12, 2026\. Nothing to do until they answer/],
 [visitSummary({state:'post_response',insurance:{status:'waiting'},claim:{status:'submitted',response_to_review:'era-1'}}),'Synthetic Medicare PPO answered','Review insurer payment','data-revenue-remittance="era-1"',/post it to this visit/],
 [visitSummary({state:'denied',insurance:{status:'denied'},claim:{status:'adjudicated'}}),'Denied by Synthetic Medicare PPO','Fix and resend claim','data-revenue-claim="claim"',/Fix the claim and send it again/],
 [visitSummary({state:'review_response',insurance:{status:'answered',paid_cents:20000,pending_cents:0,unassigned_cents:7000},claim:{status:'adjudicated'}}),'Insurance paid $200.00','Review insurer answer','data-revenue-claim="claim"',/\$70\.00 is not paid, written off or assigned to the patient yet/],
 [visitSummary({state:'patient_owes',waiting_on:'patient',insurance:{status:'answered',paid_cents:20000,adjusted_cents:4000,pending_cents:0},patient:{responsibility_cents:4000,responsibility_source:'insurer_response',owes_now_cents:3000},balance_cents:3000,claim:{status:'adjudicated',answer:{payment_date:'2026-11-20'}}}),'Patient owes $30.00','Collect payment','data-visit-collect',/Insurance paid \$200\.00\. Waiting on the patient/],
 [visitSummary({state:'insurance_outside',claim:null,insurance:{electronic:false,status:'outside'}}),'Synthetic Medicare PPO is billed outside SunCharts','Record insurer payment','data-new-ledger',/no claim is sent from SunCharts/],
 [selfPay({state:'patient_credit',waiting_on:'staff',patient:{owes_now_cents:0,unapplied_cents:2000,credit_cents:2000},balance_cents:0}),'Patient has a $20.00 credit','Review payments','data-visit-history="payments"',/Refund the credit or keep it/],
];
for(const [summary,headline,label,attribute,detail] of states){
 const html=card(summary);
 assert.ok(html.includes(`<p class="visit-billing-headline">${esc(headline)}</p>`),`${summary.state}: ${html.slice(0,400)}`);
 assert.deepEqual(primaries(html),[label],`${summary.state} has one primary action`);
 assert.ok(html.includes(`class="primary" ${attribute}>`),`${summary.state} action target`);
 assert.match(html,detail,summary.state);assert.ok(html.includes(`data-visit-billing-state="${summary.state}"`));
}
const done=card(selfPay({state:'paid_in_full',waiting_on:'nobody',patient:{owes_now_cents:0},balance_cents:0}));
assert.match(done,/<span class="eyebrow">Status<\/span><p class="visit-billing-headline">Paid in full<\/p>/);assert.deepEqual(primaries(done),[]);
// The old one-after-another buttons are gone from the normal view in every state.
for(const [summary] of states){const html=card(summary);assert.doesNotMatch(html,/Prepare insurance claim|Review patient invoice|Saved invoices|Claim &amp; payment history|Account history|data-revenue-invoice|data-new-claim/);assert.doesNotMatch(html.replace(/<[^>]*>/g,' '),/ledger|posted charges|manually_verified|Payer snapshot|\bv\d\b|Account [0-9a-f]{8}/i,summary.state);}

// The breakdown: self-pay, copay paid, insurance pending, answered with a patient remainder, denied, overpaid.
const cell=(html,label)=>{const match=html.match(new RegExp(`<th scope="row">${label}</th><td>(.*?)</td><td class="money-cell">(.*?)</td>`));assert.ok(match,`${label} row in ${html}`);return [match[1],match[2]];};
let b=ctx.visitBillingBreakdown(selfPay(),all);
assert.deepEqual(cell(b,'Charges'),['Charges are final','$280.00']);assert.doesNotMatch(b,/Insurance:/);assert.match(b,/Patient \(self-pay\)/);assert.deepEqual(cell(b,'Patient owes now'),['No insurance on this visit','$280.00']);
b=ctx.visitBillingBreakdown(visitSummary(),all);
assert.match(b,/Insurance: Synthetic Medicare PPO/);assert.deepEqual(cell(b,'Insurance paid'),['Not sent yet','$0.00']);assert.equal(cell(b,'Insurance pending')[1],'$270.00');
assert.deepEqual(cell(b,'Copay \\$10\\.00'),['Paid','$10.00']);assert.match(b,/<tr class="visit-billing-receipts"><th scope="row">Receipts<\/th><td colspan="2"><button type="button" class="text-button" data-copay-receipt="receipt" data-appointment="appointment">Receipt: \$10\.00 cash, Nov 12, 2026<\/button><\/td><\/tr>/);
assert.deepEqual(cell(b,'Patient owes now'),['The plan copay, until the insurer answers','$0.00']);assert.doesNotMatch(b,/data-visit-collect/,'a paid copay offers nothing to collect');
b=ctx.visitBillingBreakdown(visitSummary({patient:{copay_cents:2500,copay_paid_cents:0,copay_due_cents:2500,received_cents:0,owes_now_cents:2500},receipts:[]}),all);
assert.match(cell(b,'Copay \\$25\\.00')[0],/^Due <button type="button" class="text-button" data-visit-collect>Collect<\/button>$/);assert.doesNotMatch(b,/visit-billing-receipts/);assert.equal(cell(b,'Patient owes now')[1],'$25.00');
assert.doesNotMatch(ctx.visitBillingBreakdown(visitSummary({patient:{copay_cents:2500,copay_paid_cents:0,copay_due_cents:2500,received_cents:0,owes_now_cents:2500},receipts:[]}),{canCreate:false}),/data-visit-collect/);
b=ctx.visitBillingBreakdown(visitSummary({state:'waiting_insurer',insurance:{status:'waiting',sent_on:'2026-11-12'}}),all);
assert.deepEqual(cell(b,'Insurance paid'),['Waiting since Nov 12, 2026','$0.00']);assert.deepEqual(cell(b,'Insurance pending'),['Waiting on the insurer’s answer','$270.00']);
b=ctx.visitBillingBreakdown(states[11][0],all);
assert.deepEqual(cell(b,'Insurance paid'),['Answered Nov 20, 2026','$200.00']);assert.deepEqual(cell(b,'Insurance adjustments'),['Written off, not owed by anyone','$40.00']);assert.doesNotMatch(b,/Insurance pending/);
assert.deepEqual(cell(b,'Patient owes now'),['What the insurer says the patient owes, less what they paid','$30.00']);
b=ctx.visitBillingBreakdown(visitSummary({state:'denied',insurance:{status:'denied'}}),all);
assert.deepEqual(cell(b,'Insurance paid'),['Denied','$0.00']);assert.deepEqual(cell(b,'Insurance pending'),['Denied. Fix and resend the claim','$270.00']);assert.equal(cell(b,'Patient owes now')[1],'$0.00','a denial is never handed to the patient');
b=ctx.visitBillingBreakdown(visitSummary({state:'patient_credit',insurance:{status:'answered',paid_cents:27500,pending_cents:0},patient:{copay_cents:2500,copay_paid_cents:2500,received_cents:2500,overpaid_cents:2500,credit_cents:2500,responsibility_cents:0,responsibility_source:'insurer_response'},balance_cents:-2500}),all);
assert.deepEqual(cell(b,'Paid more than owed'),['Refund it or keep it as a credit','$25.00']);assert.equal(cell(b,'Patient owes now')[1],'$0.00');
b=ctx.visitBillingBreakdown(selfPay({patient:{unapplied_cents:1500,received_cents:1500},receipts:[{id:'r2',appointment_id:'appointment',amount_cents:1500,method:'card',occurred_on:'2026-11-12',voided:false}]}),all);
assert.match(cell(b,'Paid but not applied yet')[0],/data-apply-copays/);assert.match(b,/Receipt: \$15\.00 card, Nov 12, 2026/);
assert.match(ctx.visitBillingBreakdown(visitSummary({patient:{receipt_needs_review:true}}),all),/A payment for this visit needs review/);
b=ctx.visitBillingBreakdown(visitSummary({patient:{copay_cents:2500,copay_paid_cents:1000,copay_due_cents:1500,owes_now_cents:1500}}),all);assert.match(cell(b,'Copay \\$25\\.00')[0],/^\$10\.00 paid, \$15\.00 due <button[^>]*data-visit-collect>Collect<\/button>$/);assert.equal(cell(b,'Copay \\$25\\.00')[1],'$10.00');
b=ctx.visitBillingBreakdown(visitSummary({patient:{received_cents:1500,other_patient_payments_cents:500}}),all);assert.deepEqual(cell(b,'Other patient payments'),['','$5.00']);b=ctx.visitBillingBreakdown(selfPay({patient:{other_patient_payments_cents:4000}}),all);assert.deepEqual(cell(b,'Patient payments'),['','$40.00']);
// Amounts are only formatted: every money cell is exactly a value the server sent.
const answered=states[11][0],shown=[...ctx.visitBillingBreakdown(answered,all).matchAll(/\$(\d+\.\d\d)/g)].map(m=>Math.round(Number(m[1])*100)),served=new Set([answered.charges_cents,...Object.values(answered.insurance),...Object.values(answered.patient)].filter(Number.isInteger));
for(const value of shown)assert.ok(served.has(value),`${value} was not sent by the server`);

// Collect payment is one action; the ways to pay sit inside it and "More" keeps rare actions reachable.
const hostedState={appointment:'appointment',patient:'patient',items:[],availability:{available:true,livemode:true}};
const options=ctx.hostedCopayMarkup(hostedState,true);
for(const [attribute,label] of [['data-reader-copay','Card on reader'],['data-saved-card-copay','Card on file'],['data-collect-card-copay','Online payment link']])assert.ok(options.includes(`${attribute}="appointment" >${label}</button>`),label+options);
assert.doesNotMatch(options,/Check payment status|Card payment details|additional collection|class="primary"/);
assert.match(ctx.hostedCopayMarkup({...hostedState,items:[{id:'op',appointment_id:'appointment',amount_cents:1000,livemode:true,status:'open',created_at:'2026-11-12T15:00:00Z'}]},true),/Awaiting card payment[\s\S]*Check card payment status/);
assert.match(ctx.hostedCopayMarkup({...hostedState,availability:{available:false,reason:'Card payments are not set up.'}},true),/Card payments are not set up\./);
const more=ctx.visitBillingMore(states[11][0],all);
for(const expected of ['data-visit-statement>Patient statement','data-new-ledger>Record a payment, write-off or adjustment','data-visit-history="payments">Refunds and card payments','data-revenue-claim="claim">Open claim: correct, void or bill secondary insurance','/api/v1/billing/claims/claim/cms1500','data-chart-section="insurance">Insurance and eligibility'])assert.ok(more.includes(expected),expected);
assert.match(more,/^<details class="visit-billing-more" data-revenue-disclosure="more"><summary>More<\/summary>/);
assert.doesNotMatch(ctx.visitBillingMore(visitSummary({claim:{secondary:true}}),all),/cms1500/,'no CMS-1500 for a secondary claim');
assert.doesNotMatch(ctx.visitBillingMore(visitSummary(),{canCreate:false,canWrite:false,claimsAllowed:false}),/data-new-ledger|data-visit-statement|data-revenue-claim/);

// One history, with the old destinations as filters; technical details only for the owner.
const timeline=[{at:'2026-11-12T15:00:00Z',group:'charges',code:'charges_added',amount_cents:28000},{at:'2026-11-12T15:05:00Z',group:'payments',code:'payment_received',amount_cents:1000,method:'cash',receipt_id:'receipt',appointment_id:'appointment'},{at:'2026-11-12T16:00:00Z',group:'charges',code:'charges_posted',amount_cents:28000},{at:'2026-11-12T16:00:01Z',group:'insurance',code:'claim_prepared_auto',claim_id:'claim',insurer:'Synthetic <b>Plan</b>'},{at:'2026-11-12T17:00:00Z',group:'insurance',code:'claim_sent',claim_id:'claim',insurer:'Synthetic <b>Plan</b>'},{at:'2026-11-20T10:00:00Z',group:'insurance',code:'insurer_payment',amount_cents:20000},{at:'2026-11-20T10:00:00Z',group:'insurance',code:'insurer_adjustment',amount_cents:4000},{at:'2026-11-20T10:00:01Z',group:'insurance',code:'claim_answered',claim_id:'claim',insurer:'Synthetic <b>Plan</b>',patient_responsibility_cents:4000},{at:'2026-11-21T10:00:00Z',group:'statements',code:'statement',amount_cents:3000,invoice_id:'invoice-old'},{at:'2026-11-22T10:00:00Z',group:'payments',code:'patient_payment',amount_cents:3000,method:'check'}];
const history=ctx.visitBillingTimeline({timeline},all,'all');
for(const text of ['Charges added: $280.00','Payment taken: $10.00 (cash)','Charges posted: $280.00. Charges are final','Claim to Synthetic &lt;b&gt;Plan&lt;/b&gt; prepared from this visit','Claim sent to Synthetic &lt;b&gt;Plan&lt;/b&gt;','Insurance paid $200.00','Insurance adjustment: $40.00 written off','answered: patient owes $40.00','Statement prepared: $30.00 due','Patient payment: $30.00 (check)'])assert.ok(history.includes(text),text);
assert.equal((history.match(/<li /g)||[]).length,timeline.length);assert.ok(history.indexOf('Charges added')<history.indexOf('Patient payment'),'oldest first');
assert.match(history,/<time>Nov 12, 2026<\/time>/);assert.match(history,/data-visit-statement-open="invoice-old">View statement/);assert.match(history,/data-copay-receipt="receipt" data-appointment="appointment">Receipt/);
assert.deepEqual([...history.matchAll(/data-visit-history-filter="(\w+)" aria-pressed="(\w+)">([^<]+)</g)].map(m=>[m[1],m[2],m[3]]),[['all','true','Everything'],['charges','false','Charges'],['insurance','false','Insurance'],['payments','false','Payments'],['statements','false','Statements sent']]);
const statements=ctx.visitBillingTimeline({timeline},all,'statements');assert.equal((statements.match(/<li /g)||[]).length,1);assert.match(statements,/Statement prepared/);
assert.equal((ctx.visitBillingTimeline({timeline},all,'insurance').match(/<li /g)||[]).length,5);
assert.doesNotMatch(ctx.visitBillingTimeline({timeline},{claimsAllowed:false},'all'),/data-revenue-claim/);
assert.match(ctx.visitBillingTimeline({timeline:[]},all,'statements'),/No statement has been prepared for this visit/);
assert.equal(ctx.visitBillingTechnical(visitSummary()),'','nothing technical unless the server sent it');
const technical=ctx.visitBillingTechnical(visitSummary({technical:{account_id:'e40f1da7-0000',account_version:2,member_id:'SYN-<MEMBER>',coverage_verification:'manually_verified',payer_code:'SYN',claims:[{control_number:'SC000TEST',version:3,status:'draft',payer_control_number:''}]}}));
assert.match(technical,/<dt>Charge account<\/dt><dd>e40f1da7-0000<\/dd>/);assert.match(technical,/SYN-&lt;MEMBER&gt;/);assert.match(technical,/manually verified/);assert.match(technical,/SC000TEST · version 3/);

// Escaping: insurer names, issue text and receipt fields are text, never markup.
const hostile=card(visitSummary({state:'fix_claim',insurance:{insurer:'<img src=x onerror=1>'},claim:{payer_name:'<script>x</script>',id:'"><b>',issues:[{missing:'<i>tax</i>'}]},receipts:[{id:'"onclick="x',appointment_id:'a"b',amount_cents:1000,method:'cash',occurred_on:'2026-11-12'}]}));
assert.doesNotMatch(hostile,/<img|<script|<i>tax|"><b>|"onclick="x"/);assert.match(hostile,/&lt;script&gt;x&lt;\/script&gt;/);assert.match(hostile,/Missing: &lt;i&gt;tax&lt;\/i&gt;/);
// Dates and vocabulary.
assert.equal(ctx.visitBillingDate('2026-11-12'),'Nov 12, 2026');assert.equal(ctx.visitBillingDate(''),'');assert.equal(ctx.visitBillingDate('not a date'),'');
assert.equal(ctx.visitBillingClaimState({status:'ready'}),'Send claim');assert.equal(ctx.visitBillingClaimState({status:'accepted'}),'Waiting on insurer');assert.equal(ctx.visitBillingClaimState({status:'rejected'}),'Denied: fix and resend');assert.equal(ctx.visitBillingClaimState({status:'submitted',crossover_tracking_only:true}),'Secondary insurer answered');
assert.equal(ctx.visitBillingStateName('waiting_insurer'),'Waiting on insurer');assert.equal(ctx.visitBillingStateName('send_claim'),ctx.visitBillingClaimState({status:'draft'}),'one vocabulary for the card and the claims list');
const claimsSource=fs.readFileSync('web/claims.js','utf8'),overviewSource=fs.readFileSync('web/billing-overview.js','utf8');
assert.match(claimsSource,/function claimStatusLabel\(claim\)\{return typeof visitBillingClaimState==='function'\?visitBillingClaimState\(claim\)/);assert.match(overviewSource,/visitBillingStateName\(row\.billing_state\)/);
// No hard-coded colours anywhere in the card's styles or markup.
const css=fs.readFileSync('web/visit-billing.css','utf8');assert.doesNotMatch(css,/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|[:\s](white|black|red|green|blue|gray|grey|orange|yellow)[;}\s]/);assert.match(css,/var\(--line\)/);
assert.doesNotMatch(fs.readFileSync('web/visit-billing.js','utf8'),/style="|#[0-9a-fA-F]{6}\b|rgb\(/);
const index=fs.readFileSync('web/index.html','utf8');assert.ok(index.indexOf('/visit-billing.js')<index.indexOf('/patient-revenue.js'));assert.match(index,/href="\/visit-billing\.css"/);

(async()=>{
 // Opening an older posted visit with no claim prepares it once, then shows it ready to send.
 let prepared=0;reply=(url,method)=>{if(url.endsWith('/claims/prepare')){prepared++;return {outcome:'prepared',claim_id:'claim',issues:[]};}return prepared?visitSummary():visitSummary({state:'prepare_claim',claim:null,claim_count:0});};
 ctx.renderEncounterRevenue();await settle();
 let host=node('encounter-revenue').innerHTML,status=node('encounter-revenue-status').innerHTML;
 assert.deepEqual(sent.map(c=>[c[0],c[1]]),[['/api/v1/patients/patient/billing/visit-summary?visit_id=visit','GET'],['/api/v1/patients/patient/billing/accounts/account/claims/prepare','POST'],['/api/v1/patients/patient/billing/visit-summary?visit_id=visit','GET']]);
 assert.equal(JSON.stringify(sent[1][2]),'{}','preparing sends no amounts and no claim details');
 assert.match(status,/Claim ready to send to Synthetic Medicare PPO/);assert.deepEqual(primaries(status),['Review and send claim']);
 await ctx.loadEncounterRevenueStatus(account,true);assert.equal(prepared,1,'a refresh never prepares again');
 // Layout: one card, collect hidden until asked, charges and history collapsed, details not offered to staff.
 assert.match(host,/<h2>Procedures &amp; billing<\/h2><p class="muted">Nov 12, 2026 · Charges are final<\/p>/);
 assert.match(host,/<section id="visit-billing-collect" class="billing-section" hidden>/);assert.match(host,/data-record-copay="appointment">Cash or check<\/button>/);
 assert.match(host,/<details class="encounter-account-record" id="encounter-charge-details"><summary>Charges<\/summary>/);assert.match(host,/<details class="encounter-account-record" id="visit-billing-history"><summary>History<\/summary>/);assert.match(host,/id="visit-billing-ledger-details"><summary>Payments and adjustments<\/summary>/);
 assert.doesNotMatch(host,/visit-billing-details|<h3>Copay<\/h3>|Insurance &amp; coverage details|Charges &amp; ledger details|Record a cash or check payment/);
 assert.equal((host.match(/id="encounter-claims"/g)||[]).length,1,'the claim view keeps its place');
 // The owner gets Details; the server decides what is in it.
 ctx.me={role:'owner'};node('encounter-revenue').dataset.revenueKey='';reply=()=>visitSummary({technical:{account_id:'e40f1da7',account_version:2,claims:[]}});ctx.renderEncounterRevenue();await settle();
 assert.match(node('encounter-revenue').innerHTML,/<details class="encounter-account-record" id="visit-billing-details" hidden><summary>Details<\/summary>/);assert.equal(node('visit-billing-details').hidden,false);assert.match(node('visit-billing-technical').innerHTML,/e40f1da7/);
 assert.doesNotMatch(node('encounter-revenue-status').innerHTML,/e40f1da7/,'identifiers stay out of the normal view');
 ctx.me={role:'front_desk'};node('visit-billing-details').hidden=true;

 // Review and send opens the claim for review; Fix opens its editor. Neither sends anything.
 sent.length=0;click({visitClaimSend:'claim'});await ctx.pending;assert.deepEqual(ctx.openedClaim,['claim','account']);assert.equal(sent.length,0);
 ctx.claimCurrent={id:'claim',status:'draft',snapshot:{account}};click({visitClaimFix:'claim'});await ctx.pending;assert.equal(ctx.editedClaim,'claim');assert.equal(sent.length,0);
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
 assert.match(ctx.editor,/<h3>Patient statement<\/h3>/);assert.match(ctx.editor,/\$42\.00 due as of Nov 21, 2026/);assert.match(ctx.editor,/data-print-patient-invoice>Print \/ save PDF/);assert.doesNotMatch(ctx.editor,/mailto:/,'no email on file, no email action');
 ctx.workspace.demographics.content.email='avery@example.test';ctx.showVisitStatement({id:'invoice',created_at:'2026-11-21T10:00:00Z',snapshot:{amount_due_cents:4200}});assert.match(ctx.editor,/href="mailto:avery%40example\.test\?subject=Your%20statement">Email the patient/);assert.doesNotMatch(ctx.editor.match(/mailto:[^"]*/)[0],/42|Nov|visit/i,'no amount or visit detail in the link');
 reply=()=>({created:true,invoice:{id:'invoice',patient_id:'someone-else',account_id:'account',snapshot:{}}});ctx.editor='';click({visitStatement:''});await ctx.pending;assert.equal(ctx.editor,'','a statement for another patient is never shown');
 // An earlier statement opens from history only when it belongs to this visit.
 reply=()=>({id:'invoice-old',patient_id:'patient',account_id:'account',created_at:'2026-11-01T10:00:00Z',snapshot:{amount_due_cents:900}});click({visitStatementOpen:'invoice-old'});await ctx.pending;assert.match(ctx.editor,/\$9\.00 due as of Nov 1, 2026/);
 reply=()=>({id:'invoice-x',patient_id:'patient',account_id:'another',snapshot:{}});let refused;ctx.run=fn=>ctx.pending=Promise.resolve().then(fn).catch(error=>{refused=error.message;});click({visitStatementOpen:'invoice-x'});await ctx.pending;assert.match(refused,/does not belong to the open visit/);ctx.run=fn=>ctx.pending=Promise.resolve().then(fn);

 // History filters and the payments shortcut.
 reply=()=>visitSummary({timeline});await ctx.loadEncounterRevenueStatus(account,true);
 click({visitHistory:'payments'});assert.equal(node('visit-billing-history').open,true);assert.equal(node('visit-billing-ledger-details').open,true);assert.equal((node('visit-billing-timeline').innerHTML.match(/<li /g)||[]).length,2);
 click({visitHistoryFilter:'all'});assert.equal((node('visit-billing-timeline').innerHTML.match(/<li /g)||[]).length,timeline.length);

 // A failed prepare says why and offers one way forward; asking again is explicit.
 node('encounter-revenue').dataset.revenueKey='';ctx.workspace.billing.accounts=[{...account,version:3}];sent.length=0;reply=(url)=>{if(url.endsWith('/claims/prepare'))throw new Error('The charges changed; open the visit again');return visitSummary({state:'prepare_claim',claim:null,claim_count:0,account:{version:3}});};
 ctx.renderEncounterRevenue();await settle();status=node('encounter-revenue-status').innerHTML;
 assert.match(status,/The claim to Synthetic Medicare PPO could not be prepared/);assert.match(status,/The charges changed; open the visit again\. Try again, or open Insurance and eligibility/);assert.deepEqual(primaries(status),['Try again']);
 assert.equal(sent.filter(c=>c[1]==='POST').length,1);await ctx.loadEncounterRevenueStatus(ctx.workspace.billing.accounts[0],true);assert.equal(sent.filter(c=>c[1]==='POST').length,1,'no retry loop');
 reply=(url,method,body)=>url.endsWith('/claims/prepare')?{outcome:'prepared'}:visitSummary({account:{version:3}});click({visitClaimPrepare:'again'});await ctx.pending;await settle();
 assert.equal(JSON.stringify(sent.filter(c=>c[1]==='POST').at(-1)[2]),'{"again":true}');assert.equal(ctx.noticed,'Claim prepared from this visit. Nothing was sent.');assert.match(node('encounter-revenue-status').innerHTML,/Claim ready to send/);
 // People who cannot prepare claims never trigger it.
 ctx.billingCan=()=>false;node('encounter-revenue').dataset.revenueKey='';ctx.workspace.billing.accounts=[{...account,version:4}];sent.length=0;reply=()=>visitSummary({state:'prepare_claim',claim:null,account:{version:4}});ctx.renderEncounterRevenue();await settle();
 assert.equal(sent.filter(c=>c[1]==='POST').length,0);assert.match(node('encounter-revenue-status').innerHTML,/Billing staff prepare the claim to Synthetic Medicare PPO/);assert.deepEqual(primaries(node('encounter-revenue-status').innerHTML),[]);
 console.log('PASS visit billing card: one next step per state, self-explaining breakdown, automatic claim draft, statement on first use, one history, owner-only details, escaping and theme colours');
})().catch(error=>{console.error(error);process.exitCode=1;});
