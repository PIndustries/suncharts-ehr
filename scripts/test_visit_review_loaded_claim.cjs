// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {visitSummary}=require('./visit_billing_fixture.cjs');

// The review checks judge the claim the practice will send. A claim whose form was loaded and is
// filled in raises none of the "missing" items; a claim the summary named but did not carry the
// form of raises none either (not loaded is not missing); a loaded claim with a blank place of
// service still does. Synthetic values only.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const account={id:'account',patient_id:'patient',status:'posted',version:3,total_cents:28000,content:{visit_id:'visit',service_date:'2026-11-12',lines:[{code:'99213',units:1,amount_cents:28000,diagnosis_codes:['M62.81']}]},coverage_snapshot:{coverage:{content:{relationship:'self',member_id:'SYN-MEMBER'}},payer:{content:{name:'Synthetic PPO',payer_code:'SYN'}}}};
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,setTimeout:()=>0,clearTimeout(){},
 me:{role:'owner'},selected:'patient',activeVisit:{id:'visit',status:'signed',version:1},
 workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{address:{line1:'1 Synthetic Way',city:'Synthetic City',region:'SY',postal_code:'00000',country:'US'}}},billing:{accounts:[account]}},
 $:()=>({innerHTML:'',dataset:{}}),document:{addEventListener(){},createElement:()=>({setAttribute(){}})},
 esc,human:v=>String(v).replaceAll('_',' '),date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,
 payerName:()=>'Synthetic PPO',billingCan:()=>true,workspaceResourceAllowed:()=>true,
 encounterRevenueVisitUnsigned:()=>false,encounterChargeAccount:()=>account,
 claimPatientAddressDefault:a=>a.patient_id==='patient'?'1 Synthetic Way, Synthetic City, SY, 00000, US':''};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('web/visit-billing.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('web/visit-review.js','utf8'),ctx);
const content=(over={})=>({billing_provider_name:'Synthetic Care Group',billing_address:'1 Synthetic Way',tax_id:'123456789',billing_npi:'1234567890',rendering_npi:'0987654321',patient_address:'1 Synthetic Way',subscriber_address:'1 Synthetic Way',subscriber_birth_date:'1980-01-01',place_of_service:'11',diagnosis_codes:['M62.81'],line_diagnosis_pointers:[[1]],...over});
const base={id:'claim',status:'draft',issues:[]};
const loaded={snapshot:{patient:{given_name:'Synthetic',family_name:'Patient'},account}};
const texts=claim=>{
 const s=visitSummary({state:'send_claim',waiting_on:'staff',account:{id:'account',status:'posted',version:3,total_cents:28000},charges_cents:28000,claim,insurance:{insured:true,insurer:'Synthetic PPO',electronic:true}});
 return vm.runInContext('visitReviewChecks',ctx)(s,{claimsAllowed:true}).map(c=>c.text);
};
const falseItems=/billing provider name|billing address|billing NPI|rendering NPI|no address for the claim|policy holder|place of service|diagnosis codes/i;
const noFalse=list=>assert.equal(list.filter(t=>falseItems.test(t)).join(' | '),'');

// (a) a claim with everything filled in
noFalse(texts({...base,...loaded,content:content()}));
// (b) a claim with an id but nothing loaded
noFalse(texts({...base}));
noFalse(texts({...base,content:null}));
// (c) a loaded claim with a blank place of service still reports it, and only that
const blank=texts({...base,...loaded,content:content({place_of_service:''})});
assert.ok(blank.some(t=>/two-digit place of service/.test(t)),'blank place of service is still reported');
assert.ok(!blank.some(t=>/diagnosis codes|billing provider name|policy holder/.test(t)));
console.log('visit review loaded-claim checks ok');
