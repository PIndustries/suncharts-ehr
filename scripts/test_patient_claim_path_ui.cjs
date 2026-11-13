// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}


const billing=fs.readFileSync('web/billing.js','utf8');
const claims=fs.readFileSync('web/claims.js','utf8');

const summary=billing.slice(billing.indexOf('function renderBilling(){'),billing.indexOf('async function openEncounterBillingAccount('));
assert.match(summary,/<h2>Account summary<\/h2>/);
assert.doesNotMatch(summary,/data-patient-create-claim|data-new-billing|data-patient-claims/,'account summary must not launch a parallel billing workflow');
assert.match(summary,/Open encounter billing/);
assert.match(claims,/data-claimmd-submit/);

const selector=billing.match(/const patientClaimAccounts=.*;\n/)[0].replace('const patientClaimAccounts=','globalThis.patientClaimAccounts=');
const context={workspace:{billing:{accounts:[]}}};
vm.runInNewContext(selector,context);
const account=(id,status,date,payerCode)=>({id,status,content:{service_date:date},coverage_snapshot:{payer:{content:{payer_code:payerCode}}}});
assert.deepEqual(Array.from(context.patientClaimAccounts({accounts:[
 account('draft','draft','2026-11-09','12345'),
 account('local','posted','2026-11-08',''),
 account('older','posted','2026-11-07','54321'),
 account('newer','posted','2026-11-10','12345'),
]}),row=>row.id),['newer','older']);

async function verifyEncounterRouting(){
 const calls=[],ctx={me:{user_id:'staff'},selected:'patient',workspace:{visits:[{id:'visit-one'},{id:'visit-two'}],billing:{accounts:[{id:'account-two',content:{visit_id:'visit-two'}},{id:'source-account',content:{visit_id:null}}]}},activeVisit:{id:'visit-one'},
  selectPatient:async(patient,visit)=>{calls.push(['patient',patient,visit]);ctx.activeVisit={id:visit};},setEncounterSection:step=>calls.push(['step',step]),showBillingAccount:(id,activate)=>calls.push(['account',id,activate])};
 const start=billing.indexOf('async function openEncounterBillingAccount('),end=billing.indexOf('async function beginPatientClaim(',start);vm.createContext(ctx);vm.runInContext(billing.slice(start,end),ctx);
 await ctx.openEncounterBillingAccount('account-two');assert.deepEqual(calls,[['patient','patient','visit-two'],['step','charges'],['account','account-two',false]]);
 calls.length=0;await ctx.openEncounterBillingAccount('source-account');assert.deepEqual(calls,[['account','source-account',undefined]],'source-only account must not invent an encounter');
 calls.length=0;ctx.activeVisit={id:'visit-one'};ctx.selectPatient=async()=>{ctx.me={user_id:'different-staff'};ctx.activeVisit={id:'visit-two'};};await ctx.openEncounterBillingAccount('account-two');assert.deepEqual(calls,[],'late selection cannot open old billing under another sign-in');
 await assert.rejects(()=>ctx.openEncounterBillingAccount('missing-account'),/unavailable/);
 console.log('PASS aggregate account summary routes to owning encounter; historical sources and changed sessions remain isolated');
}
verifyEncounterRouting().catch(error=>{console.error(error);process.exitCode=1;});
