// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

const calls=[],notices=[];
let failDelivery=false,wrongClaim=false;
const fields={
 subscriber_given_name:'Synthetic',subscriber_family_name:'Member',patient_sex:'U',subscriber_sex:'U',
 rendering_given_name:'Synthetic',rendering_family_name:'Provider',billing_taxonomy:'207Q00000X',filing_indicator:'CI',
 signature_on_file:'on',benefits_assigned:'on',release_authorized:'on',routine_professional_reviewed:'on',
 synthetic_test_reviewed:'on',reason:'Synthetic preparation test'
};
for(const prefix of ['billing','subscriber','patient','payer'])for(const key of ['line1','line2','city','state','postal_code'])fields[`${prefix}_${key}`]='SYNTHETIC';
const context={
 console,me:{user_id:'synthetic-clinician'},crypto:{randomUUID:()=>`request-${calls.length}`},
 document:{addEventListener:()=>{}},
 FormData:class{constructor(){return Object.entries(fields)}},
 claimsBase:'/api/v1/billing/claims',claimCurrent:{id:'synthetic-claim',version:7},
 api:async(...args)=>{
  calls.push(args);
  if(args[0].endsWith('/delivery')){
   if(failDelivery)throw new Error('Synthetic network error');
   return {id:'job',submission_id:'prepared-submission',route_key:'claimmd'};
  }
  return {id:'prepared-submission',version:3,claim_id:wrongClaim?'wrong-claim':'synthetic-claim',claim_version:7,partner_id:'native-partner',partner_version:4};
 },
 notice:value=>notices.push(value),showClaim:async()=>{},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('web/claimmd-native.js','utf8'),context);
vm.runInContext("claimMdConnectionState={connected:true,active:{id:'setting',partner_id:'native-partner',partner_version:4,route_key:'claimmd'}}",context);

(async()=>{
 const form={dataset:{request:'prepare-only-request'}};
 context.form=form;context.submitter={value:'prepare'};
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
 assert.match(notices.at(-1),/on its way to the clearinghouse/);

 calls.length=0;notices.length=0;
 context.form={dataset:{request:'retry-837p'}};failDelivery=true;
 await assert.rejects(vm.runInContext('submitClaimMdForm(form,submitter)',context),/Synthetic network error/);
 assert.equal(notices.length,0,'a failed response never announces that the claim was queued');
 failDelivery=false;
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.equal(calls[0][2].request_id,calls[2][2].request_id);
 assert.equal(calls[1][2].request_id,calls[3][2].request_id,'retry reuses the same delivery request');

 calls.length=0;wrongClaim=true;
 await assert.rejects(vm.runInContext('submitClaimMdForm(form,submitter)',context),/does not match this review/);
 assert.equal(calls.length,1,'an unexpected claim artifact is never queued');
 console.log('PASS Claim.MD prepare-only creates local 837P without external delivery; queue remains explicit');
})().catch(error=>{console.error(error);process.exitCode=1});
