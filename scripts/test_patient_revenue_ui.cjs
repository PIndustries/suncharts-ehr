// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={},nodes={};
const node=id=>nodes[id]??=( {id,innerHTML:'',dataset:{},hidden:false,scrollIntoView(){},querySelector(){return null;},replaceChildren(){this.innerHTML='';}} );
const coverage={id:'coverage-current',version:3,content:{payer_id:'payer',priority:'primary',status:'active',effective_date:'2026-01-01',end_date:null,member_id:'SYNTHETIC',copay_cents:2500,plan_name:'Synthetic plan'}};
const appointment={id:'appointment',starts_at:'2026-10-25T14:00:00Z',timezone:'America/Chicago',status:'checked_in',title:'Office visit'};
const account={id:'account-current',version:4,status:'draft',content:{visit_id:'visit',service_date:'2026-10-25',coverage_id:'coverage-current',lines:[],notes:''},total_cents:15000};
const receipt={id:'receipt',appointment_id:'appointment',amount_cents:2500,allocated_cents:0,reversed_cents:0,voided:false,method:'cash',occurred_on:'2026-10-25',reference:'SYNTHETIC'};
const ctx={console,Date,Intl,crypto:{randomUUID:()=> 'stable-request'},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createElement:()=>node('created')},$:node,me:{role:'owner'},selected:'patient',billingSelected:null,chartSection:'insurance',activeVisit:{id:'visit',appointment_id:'appointment',status:'in_progress',version:2},workspace:{appointments:[appointment],visits:[{id:'visit',appointment_id:'appointment'}],billing:{accounts:[{...account,id:'wrong-account',content:{...account.content,visit_id:'other'}},account],coverages:[{...coverage,id:'old',content:{...coverage.content,end_date:'2025-12-31'}},coverage],entries:[],copays:[receipt]}},esc,human:v=>v,date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,dollars:v=>(v/100).toFixed(2),cents:v=>Math.round(Number(v)*100),payerName:()=> 'Synthetic payer',billingCan:()=>true,claimmdEligibilityButton:c=>`<button data-claimmd-eligibility="${c.id}">Check eligibility</button>`,FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}},showChartSection:key=>ctx.chartSection=key,setEncounterSection:key=>{ctx.chartSection='visits';ctx.step=key;},run:fn=>ctx.pending=fn(),notice:()=>{},openBillingEditor:html=>ctx.editor=html,showBillingAccount:(id,activate)=>ctx.opened={id,activate},accountEditor:(a,m,encounter)=>ctx.edited={a,encounter},api:async(...args)=>{ctx.sent=args;return {};},selectPatient:async()=>{}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
assert.equal(ctx.revenueCoverage('2026-10-25').id,'coverage-current');assert.equal(ctx.encounterChargeAccount().id,'account-current');assert.equal(ctx.revenueServiceDate(appointment),'2026-10-25');
ctx.renderPatientInsurance();assert.match(node('insurance-workspace').innerHTML,/Insurance & copay/);assert.match(node('insurance-workspace').innerHTML,/Recorded plan copay/);assert.match(node('insurance-workspace').innerHTML,/\$25\.00/);assert.match(node('insurance-workspace').innerHTML,/data-claimmd-eligibility/);assert.match(node('insurance-workspace').innerHTML,/Record received copay/);assert(!node('insurance-workspace').innerHTML.includes('Post a charge account before'));
node('insurance-workspace').innerHTML+='PRESERVED-DRAFT';ctx.renderPatientInsurance();assert.match(node('insurance-workspace').innerHTML,/PRESERVED-DRAFT/);
ctx.openEncounterCharges();assert.equal(ctx.step,'charges');assert.equal(ctx.opened.id,'account-current');assert.equal(ctx.opened.activate,false);assert.equal(ctx.edited.a.id,'account-current');assert.equal(ctx.edited.encounter,true);
ctx.openCopayReceiptEditor();assert.equal(ctx.chartSection,'insurance');assert.match(ctx.editor,/data-appointment="appointment"/);assert.match(ctx.editor,/value="25.00"/);assert.match(ctx.editor,/payment has already been received/);assert(!ctx.editor.includes('150.00'));
const corrected=ctx.copayReceiptMarkup([{...receipt,allocated_cents:2500,reversed_cents:2500}]);assert.match(corrected,/Corrected on ledger/);assert(!corrected.includes('awaiting charge allocation'));
ctx.workspace.billing.copays=[{...receipt,amount_cents:5000,allocated_cents:2500,reversed_cents:2500}];assert.equal(ctx.availableCopayCreditForAccount(account),0);
(async()=>{
 const form={id:'copay-receipt-form',dataset:{appointment:'appointment',coverage:'coverage-current',request:'stable-request'},values:{amount:'25.00',method:'cash',reference:'SYNTHETIC',occurred_on:'2026-10-25',reason:'Confirmed received cash',received_confirmed:'on'}};
 handlers.submit[0]({target:form,preventDefault(){}});await ctx.pending;
 assert.equal(ctx.sent[0],'/api/v1/patients/patient/billing/copays');assert.equal(ctx.sent[2].request_id,'stable-request');assert.equal(ctx.sent[2].amount_cents,2500);assert.equal(ctx.sent[2].received_confirmed,true);assert.equal(ctx.sent[2].appointment_id,'appointment');
 const oldCheck={id:'old-check',status:'completed',created_at:'2026-10-20T12:00:00Z',request_snapshot:{service_date:'2026-10-20'}};
 const latestCheck={...oldCheck,id:'latest-check',created_at:'2026-10-25T12:00:00Z',request_snapshot:{service_date:'2026-10-25'}};
 const oldReport=ctx.insuranceEligibilityMarkup({history:{items:[oldCheck]}},coverage.id,'2026-10-25');
 assert.match(oldReport,/Payer response received/);assert.match(oldReport,/selected visit is 2026-10-25/);assert.match(oldReport,/does not guarantee coverage or payment/);assert.match(oldReport,/data-eligibility-report/);
 assert.match(ctx.insuranceEligibilityMarkup({history:{items:[]}},coverage.id,'2026-10-25'),/No eligibility check recorded/);
 ctx.api=async()=>({items:[oldCheck,latestCheck]});await ctx.loadInsuranceEligibility(coverage.id,true);
 assert.match(node('insurance-eligibility-'+coverage.id).innerHTML,/Requested 2026-10-25T12:00:00Z/);
 assert.doesNotMatch(node('insurance-eligibility-'+coverage.id).innerHTML,/selected visit/);
 let resolveOld;ctx.api=()=>new Promise(resolve=>resolveOld=resolve);const oldRequest=ctx.loadInsuranceEligibility(coverage.id,true);
 ctx.updateInsuranceEligibility(coverage.id,{items:[latestCheck]});resolveOld({items:[oldCheck]});await oldRequest;
 assert.match(node('insurance-eligibility-'+coverage.id).innerHTML,/Requested 2026-10-25T12:00:00Z/,'old in-flight history must not replace newly received response');
 let resolveForeign;ctx.api=()=>new Promise(resolve=>resolveForeign=resolve);const stale=ctx.loadInsuranceEligibility(coverage.id,true);ctx.selected='different-patient';node('insurance-eligibility-'+coverage.id).innerHTML='NEW PATIENT';resolveForeign({items:[latestCheck]});await stale;
 assert.equal(node('insurance-eligibility-'+coverage.id).innerHTML,'NEW PATIENT','late history must not render into a different chart');ctx.selected='patient';
 const posted={...account,status:'posted',coverage_snapshot:{payer:{content:{payer_code:'SYNTHETIC'}}}};ctx.workspace.billing.accounts=[posted];ctx.activeVisit.status='signed';ctx.chartSection='visits';
 ctx.workspace.billing.entries=[
  {id:'patient-payment',account_id:posted.id,kind:'payment',effect_cents:-2500,content:{party:'patient'}},
  {id:'reverse-patient',account_id:posted.id,kind:'reversal',reverses_id:'patient-payment',effect_cents:2500,content:{party:'other'}},
  {id:'insurance-payment',account_id:posted.id,kind:'payment',effect_cents:-8000,content:{party:'insurer'}},
  {id:'writeoff',account_id:posted.id,kind:'adjustment_credit',effect_cents:-4500,content:{party:'insurer'}},
  {id:'other-patient',account_id:'unrelated',kind:'payment',effect_cents:-99000,content:{party:'patient'}}
 ];
 const totals=ctx.encounterPaymentTotals(posted);assert.equal(totals.patient,0);assert.equal(totals.insurer,8000);assert.equal(totals.balance,2500);
 const claim={id:'claim-current',status:'submitted',control_number:'SYNTHETIC-CLAIM',account_id:posted.id,patient_id:'patient',frequency:'original',created_at:'2026-10-25T15:00:00Z'};
 const pending=ctx.encounterRevenueStatusMarkup(posted,{loaded:true,claims:[claim],history:{items:[],active_head:null}});
 assert.match(pending,/Submitted — awaiting payer response/);assert.match(pending,/Submission and acceptance do not mean payment was received/);assert.match(pending,/data-revenue-claim="claim-current"/);assert.doesNotMatch(pending,/data-new-claim/);assert.match(pending,/data-revenue-invoice="account-current"/);
 assert.doesNotMatch(ctx.encounterRevenueStatusMarkup(posted,{error:true}),/data-new-claim/);
 const calls=[];ctx.api=async url=>{calls.push(url);if(url.includes('era-history'))return {active_head:{remittance_id:'era-current',row_index:1},items:[{remittance_id:'era-current',row_index:1,trace:'SYNTHETIC-ERA',status:'posted',claim:{status:'1',paid_cents:8000,patient_responsibility_cents:2500}}]};if(url.includes('after='))return {items:[{...claim,status:'adjudicated'}],next_cursor:null};return {items:[{...claim,id:'old-claim',status:'void',created_at:'2026-10-10T12:00:00Z'}],next_cursor:'older-page'};};
 await ctx.loadEncounterRevenueStatus(posted,true);
 assert.equal(calls[0],'/api/v1/billing/claims?patient_id=patient&account_id=account-current');assert.match(calls[1],/patient_id=patient&account_id=account-current&after=older-page/);assert.equal(calls[2],'/api/v1/billing/claims/claim-current/era-history');
 assert.match(node('encounter-revenue-status').innerHTML,/data-revenue-remittance="era-current"/);assert.match(node('encounter-revenue-status').innerHTML,/Payer-reported patient responsibility \$25\.00/);
 assert.match(node('encounter-revenue-status').innerHTML,/Adjudicated — review remittance/);
 ctx.api=async()=>{throw new Error('Synthetic offline')};await ctx.loadEncounterRevenueStatus(posted,true);assert.match(node('encounter-revenue-status').innerHTML,/Claim status could not be loaded/);assert.doesNotMatch(node('encounter-revenue-status').innerHTML,/data-new-claim/);
 let resolveClaim;ctx.api=()=>new Promise(resolve=>resolveClaim=resolve);const staleClaim=ctx.loadEncounterRevenueStatus(posted,true);ctx.selected='different-patient';node('encounter-revenue-status').innerHTML='NEW PATIENT';resolveClaim({items:[claim]});await staleClaim;assert.equal(node('encounter-revenue-status').innerHTML,'NEW PATIENT');ctx.selected='patient';
 ctx.workspaceResourceAllowed=()=>false;ctx.api=async()=>{throw new Error('Must not fetch restricted claims')};await ctx.loadEncounterRevenueStatus(posted,true);assert.match(node('encounter-revenue-status').innerHTML,/requires access to insurance claims/);
 console.log('PASS insurance reports, service dates, stale response isolation, encounter-only paginated claims, exact remittance links, balances, copays and draft preservation');
})().catch(e=>{console.error(e);process.exitCode=1;});
