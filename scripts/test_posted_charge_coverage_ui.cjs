// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');

const serviceDate='2026-11-24';
const patient='synthetic-patient',visit={id:'synthetic-visit',status:'signed'};
const account={id:'synthetic-account',patient_id:patient,status:'posted',version:6,total_cents:45000,content:{
 visit_id:visit.id,coverage_id:null,service_date:serviceDate,lines:[{code:'99204',diagnosis_codes:['M79.604'],amount_cents:45000}]
}};
const choices=[{id:'synthetic-policy',version:3,payer_name:'Synthetic Medicare',plan_name:'Synthetic plan',priority:'primary',member_id:'SYN-42'}];
const path=`/api/v1/patients/${patient}/billing/accounts/${account.id}/coverage`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({blocked='',version=account.version,readOnly=false,conflict=false,interrupted=false,queued=false,draftFailure=false,deliberate=false}={}){
 const dom=new JSDOM('<main id="visit-page-host"><div id="guide"><button data-encounter-next></button><button data-encounter-early-payment></button></div><div id="payment"></div><div id="encounter-revenue"></div></main>',{runScripts:'outside-only',url:'http://127.0.0.1'});
 const w=dom.window,d=w.document,calls=[],notices=[];
 const summary={visit,patient_id:patient,account,claim:null,state:'self_pay_collect',insurance:{insured:false,added_after_posting:!deliberate},patient:{owes_now_cents:45000},receipts:[]};
 const updated={...account,version:7,content:{...account.content,coverage_id:choices[0].id}};
 const originalCoverage={content:{status:'active',effective_date:'2025-01-01'}};
 const billing={accounts:[account],coverages:[originalCoverage],entries:[],copays:[]};
 Object.assign(w,{
  workspace:{patient:{id:patient},billing,appointments:[]},selected:patient,activeVisit:visit,me:{role:readOnly?'read_only':'owner'},chartSection:'visits',
  $:id=>d.getElementById(id),billingCan:()=>!readOnly,billingEffectiveCoverages:date=>date===serviceDate?[originalCoverage]:[],
  human:String,esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),money:cents=>`$${(cents/100).toFixed(2)}`,
  notice:message=>notices.push(message),
  sheetOpen:(title,node)=>{const dlg=d.createElement('dialog');dlg.open=true;dlg.setAttribute('aria-label',title);dlg.append(node);d.body.append(dlg);return dlg;},
  sheetClose:dlg=>{if(dlg.canCloseSheet?.()===false)throw new Error('saving dialog cannot be dismissed');dlg.open=false;dlg.dispatchEvent(new w.Event('close'));dlg.remove();},
  visitReviewOpen:()=>{reviewed++;},
  api:async(url,method,body,versionHeader)=>{
   calls.push([url,method,body,versionHeader]);
   if(url.endsWith('/claims/prepare')){
    if(draftFailure)throw new Error('Test directory unavailable');
    return {outcome:'prepared',claim_id:'synthetic-claim'};
   }
   if(!method)return {account_id:account.id,account_version:version,service_date:serviceDate,choices,blocked_reason:blocked};
   if(conflict)throw Object.assign(new Error('The selected coverage changed.'),{status:409});
   if(interrupted&&calls.length===2)throw new Error('Connection interrupted');
   return updated;
  }
 });
 const context=dom.getInternalVMContext();
 for(const file of ['web/visit-billing.js','web/patient-revenue.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const state=vm.runInContext('encounterRevenueState',context);state.data={summary};
 let refreshed=0,reviewed=0;
 w.renderEncounterRevenue=()=>{
  assert.deepEqual(billing.accounts,[updated]);refreshed++;
  if(queued)state.data.summary={...summary,account:updated,claim:draftFailure?null:{id:'synthetic-claim'}};
 };
 const launcher=()=>d.querySelector('[data-apply-posted-coverage]');
 const payment=()=>w.encounterStepPayments(w.$('payment'),w.$('encounter-revenue'),null,summary,{selfPay:true},false);
 payment();
 return {w,d,calls,notices,updated,billing,launcher,payment,summary,refreshed:()=>refreshed,reviewed:()=>reviewed};
}

async function main(){
 const ok=fixture();
 assert.equal(ok.launcher().textContent,'Apply insurance');
 const page=ok.w.$('visit-page-host'),next=ok.w.encounterNextAction(page,ok.summary,{signed:true,selfPay:true});
 ok.w.encounterNextSync(page,ok.w.$('guide'),next,0);
 assert.equal(ok.d.querySelector('[data-encounter-next]').textContent,'Apply insurance');
 ok.d.querySelector('[data-encounter-next]').click();
 await tick();
 const form=ok.d.querySelector('dialog[open] [data-posted-coverage-form]');
 assert.match(form.textContent,/\$450\.00 posted/);
 assert.equal(form.elements.coverage_id.value,choices[0].id);
 assert.equal(ok.d.activeElement,form.elements.coverage_id);
 assert.equal(form.elements.reason,undefined,'the action supplies its own audit reason');
 assert.deepEqual(ok.calls,[[path,undefined,undefined,undefined]]);
 form.dispatchEvent(new ok.w.Event('submit',{cancelable:true}));
 form.dispatchEvent(new ok.w.Event('submit',{cancelable:true}));
 await tick();
 assert.equal(ok.calls.length,2,'one scoped write and no request to send a claim');
 const [url,method,body,version]=ok.calls[1];
 assert.equal(url,path);assert.equal(method,'POST');assert.equal(version,6);
 assert.equal(body.coverage_id,choices[0].id);assert.equal(body.coverage_version,3);
 assert.equal(body.reason,'Apply insurance to posted self-pay charges');assert.match(body.request_id,/^[0-9a-f-]{36}$/);
 assert.deepEqual(ok.billing.accounts[0].content.lines,account.content.lines);
 assert.equal(ok.refreshed(),1);
 assert.equal(ok.d.querySelector('dialog[open]'),null);
 assert.match(ok.notices.at(-1),/Review the claim before sending/);

 for(const fixtureOptions of [{blocked:'Resolve the existing statement before applying insurance.'},{version:7}]){
  const f=fixture(fixtureOptions);
  await f.w.openEncounterPostedCoverage(f.launcher());
  assert.equal(f.calls.length,1);
  assert.equal(f.d.querySelector('dialog form'),null);
  const alert=f.d.querySelector('dialog [role="alert"]').textContent;
  if(fixtureOptions.blocked)assert.equal(alert,fixtureOptions.blocked);else assert.match(alert,/posted charges changed/);
  f.w.close();
 }
 const changed=fixture({conflict:true});
 await changed.w.openEncounterPostedCoverage(changed.launcher());
 const changedForm=changed.d.querySelector('dialog form');
 changedForm.dispatchEvent(new changed.w.Event('submit',{cancelable:true}));
 await tick();
 assert.match(changedForm.querySelector('[role="alert"]').textContent,/selected coverage changed/i);
 assert.equal(changedForm.querySelector('button[type=submit]').disabled,true);
 assert.equal(changed.refreshed(),0);
 const failed=fixture({interrupted:true});
 await failed.w.openEncounterPostedCoverage(failed.launcher());
 const retryForm=failed.d.querySelector('dialog form'),retry=retryForm.querySelector('button[type=submit]');
 retryForm.dispatchEvent(new failed.w.Event('submit',{cancelable:true}));
 await tick();
 assert.equal(retry.textContent,'Retry');
 assert.equal(retry.disabled,false);
 assert.equal(retryForm.elements.coverage_id.disabled,true);
 retryForm.dispatchEvent(new failed.w.Event('submit',{cancelable:true}));
 await tick();
 assert.deepEqual(failed.calls[1],failed.calls[2],'the retry replays the exact reviewed request');
 assert.equal(failed.refreshed(),1);
 assert.equal(fixture({readOnly:true}).launcher(),null);
 assert.equal(fixture({deliberate:true}).launcher(),null,'a documented self-pay decision stays in effect');
 for(const draftFailure of [false,true]){
  const queued=fixture({queued:true,draftFailure});
  queued.w.loadEncounterRevenueStatus=async()=>{};
  await assert.rejects(queued.w.openEncounterCoverageWorklistAction(account.id,'apply_coverage',5),/posted charges changed/);
  await queued.w.openEncounterCoverageWorklistAction(account.id,'apply_coverage',6);
  const queueForm=queued.d.querySelector('dialog form');
  assert.equal(queueForm.querySelector('button[type=submit]').textContent,'Apply insurance and prepare claim');
  queueForm.dispatchEvent(new queued.w.Event('submit',{cancelable:true}));
  await tick();
  assert.equal(queued.calls.length,3,'only options, application, and claim draft preparation');
  assert.equal(queued.calls[1][2].prepare_for_claim,true);
  assert.match(queued.calls[2][0],/\/claims\/prepare$/);
  assert.equal(queued.billing.accounts[0].content.coverage_id,choices[0].id);
  assert.equal(queued.reviewed(),draftFailure?0:1);
  if(draftFailure)assert.match(queued.notices.at(-1),/Insurance applied/);
  queued.w.close();
 }
 ok.w.close();changed.w.close();failed.w.close();
 console.log('PASS posted coverage: exact versions, no repeat writes, codes preserved, blocked and stale corrections, read-only staff');
}

main().catch(error=>{console.error(error);process.exitCode=1;});
