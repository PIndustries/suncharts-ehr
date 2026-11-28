// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

const calls=[],notices=[];
let failDelivery=false,wrongClaim=false;
const fields={
 subscriber_given_name:'Synthetic',subscriber_family_name:'Member',patient_sex:'U',subscriber_sex:'U',
 rendering_given_name:'Synthetic',rendering_family_name:'Provider',billing_taxonomy:'207Q00000X',filing_indicator:'CI',
 claim_review_confirmed:'on',
 synthetic_test_reviewed:'on',reason:'Synthetic preparation test'
};
for(const prefix of ['billing','subscriber','patient','payer'])for(const key of ['line1','line2','city','state','postal_code'])fields[`${prefix}_${key}`]='SYNTHETIC';
const context={
 console,esc:value=>String(value??''),me:{user_id:'synthetic-clinician'},crypto:{randomUUID:()=>`request-${calls.length}`},
 document:{addEventListener:()=>{}},
 FormData:class{constructor(){return Object.entries(fields)}},
 claimsBase:'/api/v1/billing/claims',claimCurrent:{id:'synthetic-claim',version:7},
 api:async(...args)=>{
  calls.push(args);
  if(args[0].endsWith('/delivery')){
   if(failDelivery)throw new Error('Synthetic network error');
   return {id:'job',submission_id:'prepared-submission',route_key:'claimmd',status:'queued'};
  }
  return {id:'prepared-submission',version:3,claim_id:wrongClaim?'wrong-claim':'synthetic-claim',claim_version:7,partner_id:'native-partner',partner_version:4};
 },
 notice:value=>notices.push(value),showClaim:async()=>{},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('web/claimmd-native.js','utf8'),context);
vm.runInContext("claimMdConnectionState={connected:true,active:{id:'setting',partner_id:'native-partner',partner_version:4,route_key:'claimmd'}}",context);

(async()=>{
 const results=[];
 const form={dataset:{request:'prepare-only-request'},claimAfterQueue:result=>results.push(result)};
 context.form=form;context.submitter={value:'prepare'};
 delete fields.claim_review_confirmed;
 await assert.rejects(vm.runInContext('submitClaimMdForm(form,submitter)',context),/Confirm the claim review/);
 assert.equal(calls.length,0);
 fields.claim_review_confirmed='on';
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.equal(calls.length,1,'prepare-only must make exactly one local API call');
 assert.equal(calls[0][0],'/api/v1/billing/claims/synthetic-claim/837p');
 assert.doesNotMatch(calls[0][0],/delivery/);
 assert.match(notices.at(-1),/Nothing was sent to the clearinghouse/);
 const [,method,payload,version]=calls[0];
 assert.equal(method,'POST');assert.equal(version,7);
 assert.deepEqual(Object.keys(payload).sort(),['details','partner_id','partner_version','reason','request_id']);
 assert.equal(payload.partner_id,'native-partner');assert.equal(payload.partner_version,4);
 assert.equal(payload.details.billing_address.line1,'SYNTHETIC');
 assert.equal(payload.details.routine_professional_reviewed,true);

 calls.length=0;notices.length=0;context.submitter={value:'queue'};
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.equal(calls.length,2,'queue action must prepare and then explicitly queue');
 assert.equal(calls[0][0],'/api/v1/billing/claims/synthetic-claim/837p');
 assert.equal(calls[1][0],'/api/v1/billing/submissions/prepared-submission/delivery');
 assert.equal(calls[1][2].route_key,'claimmd');assert.equal(calls[1][3],3);
 assert.match(notices.at(-1),/Queued for Claim.MD/);
 assert.equal(results.at(-1).outcome,'queued');
 assert.equal(results.at(-1).job_id,'job');
 assert.equal(form.claimSubmissionClosed,true);
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.equal(calls.length,2,'a stale control cannot create a second delivery attempt');

 calls.length=0;notices.length=0;
 context.form={dataset:{request:'retry-837p'},claimAfterQueue:result=>results.push(result)};failDelivery=true;
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.match(notices.at(-1),/Check delivery/);
 assert.equal(results.at(-1).outcome,'unconfirmed');
 assert.equal(results.at(-1).submission_id,'prepared-submission');
 failDelivery=false;
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.equal(calls.length,2,'an unknown outcome only offers a status check for the existing attempt');

 context.hint={outcome:'queued',submission_id:'prepared-submission',job_id:'job',route_key:'claimmd'};
 context.detail={claim:{id:'synthetic-claim'},tracking:{submissions:[
  {id:'prepared-submission',delivery_job:{id:'job',submission_id:'prepared-submission',route_key:'claimmd',
   status:'delivered',confirmed_at:'2026-11-27T12:00:00Z',receipt_reference:'claimmd-file:1'}},
  {id:'other-submission',delivery_job:{id:'other',submission_id:'other-submission',route_key:'claimmd',
   status:'delivered',receipt_reference:'claimmd-file:2'}}
 ]}};
 const read=()=>vm.runInContext('claimMdDeliveryAttempt(detail,hint)',context);
 assert.equal(read().receipt_reference,'claimmd-file:1');
 context.detail.tracking.submissions[0].delivery_job.receipt_reference='';
 assert.equal(read().outcome,'waiting','a delivered flag by itself is insufficient');
 context.detail.tracking.submissions.shift();
 assert.equal(read().outcome,'queued','another transmission cannot prove receipt for the scoped job');

 context.form={dataset:{request:'wrong-claim'}};
 calls.length=0;wrongClaim=true;
 await assert.rejects(vm.runInContext('submitClaimMdForm(form,submitter)',context),/does not match this review/);
 assert.equal(calls.length,1,'an unexpected claim artifact is never queued');

 let timer;
 context.setTimeout=fn=>{timer=fn;return 1;};context.clearTimeout=()=>{timer=null;};
 const scoped={id:'synthetic-claim',patient_id:'synthetic-patient',account_id:'synthetic-account',status:'submitted'};
 const pollingForm={isConnected:true,claimRecord:scoped,querySelector:()=>null};
 context.api=async(path,method)=>{
  assert.equal(path,`${context.claimsBase}/${scoped.id}`);assert.equal(method,undefined,'receipt polling is read-only');
  return {claim:scoped,tracking:{submissions:[{id:'prepared-submission',delivery_job:{id:'job',
   submission_id:'prepared-submission',route_key:'claimmd',status:'delivered',receipt_reference:'claimmd-file:1'}}]}};
 };
 context.claimMdPublishSubmissionStatus(pollingForm,context.hint,()=>true);
 assert.match(pollingForm.innerHTML,/Queued for Claim.MD/);
 await timer();
 assert.match(pollingForm.innerHTML,/Claim.MD received/);
 assert.match(pollingForm.innerHTML,/Receipt claimmd-file:1/);
 assert.match(pollingForm.innerHTML,/Waiting for payer response/);
 assert.equal(timer,null,'automatic checks stop once the exact receipt arrives');
 const pending={isConnected:true,claimRecord:scoped,querySelector:()=>null};
 context.claimMdPublishSubmissionStatus(pending,context.hint,()=>true);
 pending.isConnected=false;
 await timer();
 assert.match(pending.innerHTML,/Queued for Claim.MD/,'closing the review prevents a late update');
 console.log('PASS Claim.MD prepare-only creates local 837P without external delivery; queue remains explicit');
})().catch(error=>{console.error(error);process.exitCode=1});
