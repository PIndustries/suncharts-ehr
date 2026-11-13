// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

const calls=[],notices=[];
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
 api:async(...args)=>{calls.push(args);return {id:'prepared-submission',version:3}},
 notice:value=>notices.push(value),showClaim:async()=>{},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('web/claimmd-native.js','utf8'),context);
vm.runInContext("claimMdConnectionState={active:{partner_id:'native-partner',partner_version:4,route_key:'claimmd'}}",context);

(async()=>{
 const form={dataset:{request:'prepare-only-request'}};
 context.form=form;context.submitter={value:'prepare'};
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.equal(calls.length,1,'prepare-only must make exactly one local API call');
 assert.equal(calls[0][0],'/api/v1/billing/claims/synthetic-claim/837p');
 assert.doesNotMatch(calls[0][0],/delivery/);
 assert.match(notices.at(-1),/Nothing was sent to Claim\.MD/);

 calls.length=0;notices.length=0;context.submitter={value:'queue'};
 await vm.runInContext('submitClaimMdForm(form,submitter)',context);
 assert.equal(calls.length,2,'queue action must prepare and then explicitly queue');
 assert.equal(calls[0][0],'/api/v1/billing/claims/synthetic-claim/837p');
 assert.equal(calls[1][0],'/api/v1/billing/submissions/prepared-submission/delivery');
 assert.match(notices.at(-1),/on its way to Claim\.MD/);
 console.log('PASS Claim.MD prepare-only creates local 837P without external delivery; queue remains explicit');
})().catch(error=>{console.error(error);process.exitCode=1});
