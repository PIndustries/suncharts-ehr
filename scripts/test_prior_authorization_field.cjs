// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
// The prior authorization number sits under the procedures, is the same stored value the claim
// details hold, goes out through the same save, shows on the Charges row, and is plain text once
// the charges are final. Synthetic values only.
const nodes={},ctx={console,Date,Intl,URL,URLSearchParams,crypto:{randomUUID:()=>'synthetic-request'},selected:'patient',me:{role:'owner'},chartSection:'billing',
 workspace:{appointments:[],visits:[{id:'visit-a',appointment_id:'appt-a',created_at:'2026-11-13T14:00:00Z'}],billing:{accounts:[],coverages:[],entries:[]}},
 $:id=>id==='billing-account-form'?ctx.openedForm:(nodes[id]??={id,innerHTML:'',dataset:{},scrollIntoView(){},replaceChildren(){this.innerHTML='';},querySelector:()=>null,querySelectorAll:()=>[]}),
 document:{addEventListener(){}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),human:v=>v,date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),payerName:()=>'Synthetic payer',billingCan:()=>true,
 notice(){},run:fn=>fn(),showChartSection(){},setEncounterSection(){}};
vm.createContext(ctx);
for(const f of ['billing.js','fees.js','visit-billing.js'])vm.runInContext(fs.readFileSync('web/'+f,'utf8'),ctx);
(async()=>{
const markup=d=>vm.runInContext('encounterClaimDetailsMarkup',ctx)(d,'authorization');
const head=vm.runInContext('encounterClaimDetailsMarkup',ctx)({prior_authorization_number:'PA-SYN-9'},'head');

// The field: one input, optional, 50 characters, carrying the stored value, with its hint.
const field=markup({prior_authorization_number:'PA-SYN-9'});
assert.match(field,/name="cd_prior_authorization_number"[^>]*value="PA-SYN-9"[^>]*maxlength="50"|value="PA-SYN-9" maxlength="50"/);
assert.doesNotMatch(field,/required/);
assert.match(field,/Sent with the claim \(box 23\)\. One number per claim\./);
assert.doesNotMatch(head,/prior_authorization_number/,'the number is asked once, not twice');

// Under the procedures in the encounter's charge form.
ctx.chartSection='visits';ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'in_progress'};ctx.revenueServiceDate=()=>'2026-11-13';
ctx.accountEditor(null,null,true);
const form=nodes['encounter-billing-editor'].innerHTML;
assert.ok(form.indexOf('data-charge-prior-auth')>form.indexOf('id="billing-charge-lines"'),'under the procedure lines');
assert.ok(form.indexOf('data-charge-prior-auth')<form.indexOf('data-visit-charge-options'),'before the insurance and dates box');
assert.equal(form.split('cd_prior_authorization_number').length-1,1);

// Saved through the same claim details the account save already sends.
const els=values=>({elements:new Proxy({},{get:(_,key)=>key==='cd_paper_only'?{checked:false}:String(key).startsWith('cd_')?{value:values[String(key).slice(3)]||''}:undefined})});
assert.equal(JSON.stringify(ctx.encounterClaimDetailsValue(els({prior_authorization_number:' PA-SYN-9 ',place_of_service:'11'}))),JSON.stringify({prior_authorization_number:'PA-SYN-9',place_of_service:'11'}));

// The Charges row on the Billing summary names it, and says nothing when blank.
ctx.encounterChargeAccount=()=>({content:{claim_details:{prior_authorization_number:'PA-SYN-9'}}});
assert.match(vm.runInContext('visitBillingAuthorizationNote',ctx)(),/Prior authorization PA-SYN-9/);
ctx.encounterChargeAccount=()=>({content:{claim_details:{}}});
assert.equal(vm.runInContext('visitBillingAuthorizationNote',ctx)(),'');

// Once the charges are final (the claim is out), it is shown as text with no input.
const finished=vm.runInContext('chargeTableFinishedMarkup',ctx)({status:'posted',content:{visit_id:'visit-a',service_date:'2026-11-13',lines:[],claim_details:{prior_authorization_number:'PA-SYN-9'}}});
assert.match(finished,/Prior authorization number <b>PA-SYN-9<\/b>/);
assert.doesNotMatch(finished,/<input[^>]*prior_authorization/);

// No stylesheet rule hides it while procedures are being edited.
const css=fs.readFileSync('web/visit-billing.css','utf8');
assert.ok(!/data-billing-part="codes"\][^{]*data-charge-prior-auth[^{]*\{display:none/.test(css));
// Charges posted, claim not sent: the box stays editable and saves onto the draft claim.
const posted=claim_=>{
 ctx.encounterRevenueState={data:{summary:{claim:claim_}}};
 return vm.runInContext('chargeTableFinishedMarkup',ctx)({status:'posted',content:{visit_id:'visit-a',service_date:'2026-11-13',lines:[],claim_details:{}}});
};
const draft=posted({id:'claim-1',status:'draft',content:{encounter:{prior_authorization_number:'PA-SYN-1'}}});
assert.match(draft,/data-prior-auth-edit data-claim="claim-1"/);
assert.match(draft,/<input name="prior_authorization_number" value="PA-SYN-1" maxlength="50"/);
assert.match(draft,/data-prior-auth-save>Save</);
// A claim already released or sent is plain text, shown only when set.
for(const status of ['ready','submitted','accepted','rejected','adjudicated']){
 const html=posted({id:'claim-1',status,content:{encounter:{prior_authorization_number:'PA-SYN-1'}}});
 assert.doesNotMatch(html,/<input|data-prior-auth-edit/,`${status}: read-only`);
 assert.match(html,/Prior authorization number <b>PA-SYN-1<\/b>/);
}
assert.doesNotMatch(posted({id:'claim-1',status:'submitted',content:{}}),/Prior authorization/,'nothing shown when blank');
// Saving reads the claim back for its version and puts the content back with only the number changed.
const calls=[];
ctx.api=async(url,method='GET',body)=>{calls.push([url,method,body]);return method==='GET'?{claim:{id:'claim-1',status:'draft',version:4,content:{billing_npi:'1234567890',encounter:{claim_codes:'X'}}}}:{claim:{}};};
await vm.runInContext('chargePriorAuthorizationSave',ctx)('claim-1',' PA-SYN-2 ');
assert.equal(calls[1][1],'PUT');assert.equal(calls[1][0],'/api/v1/billing/claims/claim-1');
assert.equal(JSON.stringify(calls[1][2].content),JSON.stringify({billing_npi:'1234567890',encounter:{claim_codes:'X',prior_authorization_number:'PA-SYN-2'}}));
// The version goes as If-Match through api's fourth argument.
ctx.api=async(url,method='GET',body,version)=>{calls.push([url,method,body,version]);return method==='GET'?{claim:{id:'claim-1',status:'draft',version:4,content:{}}}:{};};
await vm.runInContext('chargePriorAuthorizationSave',ctx)('claim-1','PA-SYN-3');
assert.equal(calls.at(-1)[3],4);
// A claim released since the page was drawn is refused in plain words.
ctx.api=async()=>({claim:{id:'claim-1',status:'ready',version:5,content:{}}});
await assert.rejects(vm.runInContext('chargePriorAuthorizationSave',ctx)('claim-1','X'),/already been released/);
// The Billing summary's Charges card carries the box for a draft claim, with its own Save.
const {visitSummary}=require('./visit_billing_fixture.cjs');
const postedAccount={id:'account',status:'posted',version:3,patient_id:'patient',total_cents:28000,content:{visit_id:'visit-a',service_date:'2026-11-13',coverage_id:'cov',lines:[{code:'99213',units:1,amount_cents:28000,diagnosis_codes:['M62.81']}],claim_details:{prior_authorization_number:'PA-SYN-1'}}};
ctx.workspace.billing.accounts=[postedAccount];ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'signed'};
ctx.encounterChargeAccount=()=>postedAccount;
const column=claim_=>vm.runInContext('visitBillingColumn',ctx)(visitSummary({state:'send_claim',claim:claim_}),{canCreate:true,canWrite:true,claimsAllowed:true});
const cardDraft=column({id:'claim-1',status:'draft',content:{encounter:{prior_authorization_number:'PA-SYN-1'}}});
assert.match(cardDraft,/data-prior-auth-save/,'the Charges card has the box and its Save for a draft claim');
assert.match(cardDraft,/Prior authorization PA-SYN-1/,'and the row names the number');
assert.doesNotMatch(column({id:'claim-1',status:'submitted',content:{}}),/data-prior-auth-save/);
assert.doesNotMatch(column({id:'claim-1',status:'ready',content:{}}),/data-prior-auth-save/);

// The charge editor for posted charges (a correction) never offers it for change.
ctx.accountEditor(postedAccount,null,true,{correction:true});
const editor=nodes['encounter-billing-editor'].innerHTML;
assert.match(editor,/name="cd_prior_authorization_number"[^>]*readonly/,'read-only in the correction editor');
assert.match(editor,/Change it from the Charges card/);
assert.equal(vm.runInContext('encounterClaimDetailsValue',ctx)({elements:new Proxy({},{get:(_,k)=>k==='cd_place_of_service'?{value:'11'}:k==='cd_prior_authorization_number'?{value:'PA-SYN-1'}:String(k).startsWith('cd_')?{value:''}:undefined})}).prior_authorization_number,'PA-SYN-1','the value it carries is the stored one, unchanged');
console.log('prior authorization field checks ok');
})().catch(e=>{console.error(e);process.exit(1);});
