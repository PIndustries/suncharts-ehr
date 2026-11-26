// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The claim page's "Fix it here" form: missing boxes are filled in on the claim itself, without
// opening the chart or the insurance screen. The patient's address goes to the chart (where the
// clearinghouse reads it), everything else is saved on the claim, and the claim is read again.
// Synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','web','claims.js'),'utf8');
const start=source.indexOf('// Whether a rule names this problem'),end=source.indexOf('// Staff wording for a list of problems');
assert.ok(start>0&&end>start,'the claim missing code is where this test expects it');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const calls=[];let refreshed=null,noticed='';
const ctx={esc,Date,Object,String,Set,Array,JSON,Promise,FormData:class{constructor(form){this.entries=Object.entries(form.values);}[Symbol.iterator](){return this.entries[Symbol.iterator]();}},
 billingWrite:()=>true,claimIsCrossover:()=>false,claimsBase:'/api/v1/billing/claims',
 claimContextSnapshot:()=>({kind:'worklist'}),requireClaimContext(){},notice:m=>{noticed=m;},
 refreshClaimInContext:async id=>{refreshed=id;},document:{addEventListener(){}}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),ctx);
vm.runInContext(source.slice(start,end)+';this.claimMissingGroupsFor=claimMissingGroupsFor;this.claimMissingMarkup=claimMissingMarkup;this.saveClaimQuickFix=saveClaimQuickFix;this.setCurrent=c=>{claimCurrent=c;};',ctx);
const issues=['Patient address is required','Subscriber address is required','Subscriber date of birth is required','Insurer name can only use plain letters, numbers and basic punctuation (no long dashes, accents or curly quotes), 1 to 60 characters'];
const claim={id:'claim-1',patient_id:'patient-1',status:'draft',version:3,content:{patient_address:'',subscriber_address:'',subscriber_birth_date:null,place_of_service:'11',notes:''},
 snapshot:{patient:{birth_date:'1980-02-03'},account:{coverage_snapshot:{coverage:{content:{relationship:'self'}}}}}};
const html=ctx.claimMissingMarkup(ctx.claimMissingGroupsFor(issues),claim);
// Address and date of birth are boxes right here; the policy holder is the patient, so one address.
assert.match(html,/<form id="claim-quick-fix"[^>]*data-claim="claim-1"/);
for(const name of ['address_line1','address_city','address_region','address_postal_code','subscriber_birth_date'])assert.match(html,new RegExp(`name="${name}"`),name);
assert.doesNotMatch(html,/name="subscriber_address"/,'the patient is the policy holder: the address above is used');
assert.match(html,/value="1980-02-03"/,"the policy holder's date of birth starts as the patient's");
assert.match(html,/Save and check again/);
// View first: the list of what is missing with one Fix here button; the boxes open on Fix here, Cancel closes them.
assert.match(html,/<form id="claim-quick-fix"[^>]* hidden>/);assert.match(html,/data-claim-quick-view><ul><li>Patient address<\/li><li>Policy holder&#39;s address<\/li><li>Policy holder&#39;s date of birth<\/li><\/ul><button type="button" class="primary" data-claim-quick-fix-open>Fix here<\/button>/);assert.match(html,/data-claim-quick-fix-cancel>Cancel</);
// What cannot be filled in here keeps its one button; the Patient group, now fully fixable here, has none.
assert.match(html,/data-missing-group="insurance"><b>Insurance<\/b><ul><li>Insurance company name<\/li><\/ul><button type="button" data-claim-insurance>/);
assert.doesNotMatch(html,/data-missing-group="patient"/);assert.doesNotMatch(html,/data-claim-patient/);
// A claim already sent shows the list only, no form.
const sent=ctx.claimMissingMarkup(ctx.claimMissingGroupsFor(issues),{...claim,status:'ready'});
assert.doesNotMatch(sent,/claim-quick-fix/);assert.match(sent,/data-claim-patient/);
// Someone who cannot bill sees the list only.
ctx.billingWrite=()=>false;assert.doesNotMatch(ctx.claimMissingMarkup(ctx.claimMissingGroupsFor(issues),claim),/claim-quick-fix/);ctx.billingWrite=()=>true;
// A policy holder who is not the patient gets their own address box.
const other=ctx.claimMissingMarkup(ctx.claimMissingGroupsFor(issues),{...claim,snapshot:{patient:{},account:{coverage_snapshot:{coverage:{content:{relationship:'spouse'}}}}}});
assert.match(other,/name="subscriber_address"/);assert.doesNotMatch(other,/value="1980-02-03"/);
(async()=>{
 // Saving: address to the chart (keeping the rest of the contact profile), then the claim is read
 // again and only what is still empty or changed is saved on it, at the version just read.
 ctx.api=async(url,method='GET',body,version)=>{calls.push([url,method,body,version]);
  if(url.endsWith('/demographics')&&method==='GET')return {version:7,content:{phone:'555-0100',address:{country:'US'}}};
  if(url==='/api/v1/billing/claims/claim-1'&&method==='GET')return {claim:{...claim,version:4,content:{...claim.content,patient_address:'',subscriber_address:''}}};
  return {};};
 ctx.setCurrent(claim);
 const inputs=[];const form={dataset:{claim:'claim-1'},isConnected:true,values:{address_line1:'1 Synthetic Way',address_line2:'',address_city:'Austin',address_region:'tx',address_postal_code:'78701',subscriber_birth_date:'1980-02-03'},querySelectorAll:()=>inputs};
 await ctx.saveClaimQuickFix(form);
 assert.deepEqual(calls.map(c=>c[0]+' '+c[1]),['/api/v1/patients/patient-1/demographics GET','/api/v1/patients/patient-1/demographics PUT','/api/v1/billing/claims/claim-1 GET','/api/v1/billing/claims/claim-1 PUT']);
 const chart=calls[1];assert.equal(chart[3],7);assert.equal(chart[2].content.phone,'555-0100','the rest of the contact profile is kept');
 assert.deepEqual(JSON.parse(JSON.stringify(chart[2].content.address)),{country:'US',line1:'1 Synthetic Way',line2:null,city:'Austin',region:'TX',postal_code:'78701'});
 const saved=calls[3];assert.equal(saved[3],4,'saved at the version just read');
 assert.equal(saved[2].content.patient_address,'1 Synthetic Way, Austin, TX 78701');assert.equal(saved[2].content.subscriber_address,'1 Synthetic Way, Austin, TX 78701');
 assert.equal(saved[2].content.subscriber_birth_date,'1980-02-03');assert.equal(saved[2].content.place_of_service,'11','other boxes are kept as they are');
 assert.equal(refreshed,'claim-1');assert.match(noticed,/checked again/);
 // A claim the server already completed from the chart is not written again.
 calls.length=0;ctx.api=async(url,method='GET',body,version)=>{calls.push([url,method]);if(method==='GET'&&url.endsWith('/demographics'))return {version:8,content:{}};if(method==='GET')return {claim:{...claim,version:5,content:{...claim.content,patient_address:'2 Synthetic Way, Austin, TX 78701',subscriber_address:'2 Synthetic Way, Austin, TX 78701',subscriber_birth_date:'1980-02-03'}}};return {};};
 await ctx.saveClaimQuickFix({...form,values:{...form.values,address_line1:'2 Synthetic Way'}});
 assert.deepEqual(calls.map(c=>c[1]),['GET','PUT','GET'],'nothing left to save on the claim');
 console.log('PASS claim quick fix: missing boxes filled in on the claim page, address to the chart, claim checked again in place');
})().catch(error=>{console.error(error);process.exit(1);});
