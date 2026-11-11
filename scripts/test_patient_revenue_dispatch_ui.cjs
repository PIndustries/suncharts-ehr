// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers={},node={hidden:false,classList:{add(){},remove(){}}},calls=[];
const ctx={console,Date,Intl,URLSearchParams,busy:false,me:{role:'owner'},selected:'patient',chartSection:'visits',activeVisit:{id:'visit'},workspace:{appointments:[],billing:{accounts:[{id:'account',version:2}],coverages:[{id:'coverage',content:{}}]}},window:{},$:()=>node,document:{addEventListener:(name,handler)=>(handlers[name]??=[]).push(handler),querySelectorAll:()=>[],documentElement:node},notice:message=>calls.push(['notice',message])};
vm.createContext(ctx);
const app=fs.readFileSync('web/app.js','utf8');
vm.runInContext(app.slice(app.indexOf('async function run(action)'),app.indexOf('async function enter()')),ctx);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('web/labs.js','utf8'),ctx);
ctx.showCopayReceipt=id=>calls.push(['receipt',id]);
ctx.patientInvoiceEditor=()=>calls.push(['invoice']);
ctx.showPatientInvoices=async()=>calls.push(['invoices']);
ctx.loadInsuranceEligibility=async id=>calls.push(['eligibility-load',id]);
ctx.eligibilityState=()=>({items:new Map()});
ctx.openClaimmdEligibility=async c=>calls.push(['eligibility-open',c.id]);
ctx.showClaimsWorkspace=async()=>calls.push(['claims']);
ctx.showClaim=async id=>calls.push(['claim',id]);
ctx.showEra=async id=>calls.push(['era',id]);
ctx.editAccountDiagnosisLinks=async()=>calls.push(['diagnosis-links']);
ctx.editOrderDiagnosisLinks=async()=>calls.push(['order-diagnosis-links']);
ctx.editLabOrder=()=>calls.push(['new-order']);
ctx.api=async(...args)=>{calls.push(['api',...args]);return {applied_cents:2500};};
ctx.selectPatient=async()=>{};ctx.showChartSection=()=>{};ctx.setEncounterSection=()=>{};
async function click(attribute,value='',parent='#encounter-revenue'){
 const key=attribute.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
 const button={type:'button',dataset:{[key]:value},hasAttribute:name=>name===attribute,closest:selector=>selector===parent?{}:null};
 const event={target:{closest:selector=>selector==='button'||selector===`[${attribute}]`?button:null},preventDefault(){}};
 const start=calls.length;
 // Browser listeners run synchronously in registration order. Awaiting each
 // listener would hide a no-op handler incorrectly holding the shared busy gate.
 for(const handler of handlers.click)handler(event);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ctx.busy,false,'shared action gate should be released');
 return calls.slice(start);
}
(async()=>{
 assert.deepEqual(await click('data-copay-receipt','receipt','#insurance-workspace'),[['receipt','receipt']]);
 assert.deepEqual(await click('data-eligibility-report','coverage','#insurance-workspace'),[['eligibility-load','coverage'],['eligibility-open','coverage']]);
 assert.deepEqual(await click('data-revenue-claim','claim'),[['claims'],['claim','claim']]);
 assert.deepEqual(await click('data-revenue-remittance','remittance'),[['claims'],['era','remittance']]);
 assert.deepEqual(await click('data-revenue-invoice','account'),[['invoice']]);
 assert.deepEqual(await click('data-revenue-invoices','account'),[['invoices']]);
 assert.deepEqual(await click('data-link-account-diagnoses'),[['diagnosis-links']]);
 assert.deepEqual(await click('data-link-order-diagnoses','','#lab-workspace'),[['order-diagnosis-links']]);
 assert.deepEqual(await click('data-new-order','','#lab-workspace'),[['new-order']]);
 const applied=await click('data-apply-copays');assert.equal(applied.filter(call=>call[0]==='api').length,1);assert.equal(applied[0][1],'/api/v1/patients/patient/billing/accounts/account/copays/apply');
 assert.deepEqual(await click('data-build-patient-invoice'),[['invoice']],'billing-owned action must still execute exactly once');
 assert.deepEqual(await click('data-chart-section','insurance'),[],'navigation must not acquire the billing gate');
 console.log('PASS combined billing/revenue listener dispatch: receipt, eligibility, claim, ERA, invoices, copay allocation and diagnosis links each reach their owner');
})().catch(error=>{console.error(error);process.exitCode=1;});
