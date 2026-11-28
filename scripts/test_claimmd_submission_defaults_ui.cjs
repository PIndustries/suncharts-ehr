// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const native=fs.readFileSync('web/claimmd-native.js','utf8');
assert.match(native,/function claimMdSubmitEditor\(detail,afterQueue,active\)/);
assert.match(native,/detail\.submission_defaults\|\|\{\}/);
assert.match(native,/claimMdSubmitEditor\(detail,afterQueue,active\);/);
for(const field of ['subscriber_given_name','subscriber_family_name','patient_sex','subscriber_sex','rendering_given_name','rendering_family_name','billing_taxonomy','filing_indicator'])assert.match(native,new RegExp(field));
for(const address of ['billing_address','subscriber_address','patient_address','payer_address'])assert.match(native,new RegExp(address));
assert.match(native,/Save claim file without sending/);
assert.match(native,/Nothing was sent to the clearinghouse/);

// Rendering the fill-in form: the screen is loaded in a sandbox with stubs that
// produce real markup, so the form can be inspected as clinic staff see it.
const vm=require('node:vm');
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function render(defaults,compact=false,route=null){
 const pane={html:''};
 // The screen builds its inputs through ediField (web/clearinghouse.js), which
 // passes the field's max length through to the app's billingField in its place.
 const ediField=(name,label,value='',max=200,required=true)=>`<label>${escape(label)}<input name="${name}" type="${max}" value="${escape(value)}" ${required?'required':''}></label>`;
 const selectField=(name,label,options,value)=>`<label>${escape(label)}<select name="${name}">${options.map(option=>`<option value="${escape(option)}" ${option===value?'selected':''}>${escape(option)}</option>`).join('')}</select></label>`;
 const context={console,crypto:{randomUUID:()=>'request'},document:{addEventListener:()=>{}},esc:escape,human:String,date:String,
  billingField:ediField,ediField,selectField,claimPane:html=>{pane.html=html;},
  claimContextSnapshot:()=>compact?{kind:"encounter",reviewSheet:{}}:null,requireClaimContext:()=>{},money:String,
  claimLocalBlueDestination:claim=>claim.snapshot.claim_routing?.payer_name+' · '+claim.snapshot.claim_routing?.payer_code,
  claimCoverageAndRouteMarkup:claim=>`<p>Insurance coverage: ${claim.snapshot.account.coverage_snapshot.payer.content.name}. Claim destination: ${claim.snapshot.claim_routing.payer_name} · ${claim.snapshot.claim_routing.payer_code}.</p>`,
  claimsBase:'/api/v1/billing/claims',$:()=>null,api:async()=>({items:[]}),notice:()=>{},run:fn=>{fn();}};
 if(!route){delete context.claimLocalBlueDestination;delete context.claimCoverageAndRouteMarkup;}
 vm.createContext(context);
 vm.runInContext(native+'\nclaimMdConnectionState={connected:true,active:{usage:"T"}};',context);
 context.claimMdSubmitEditor({claim:{id:'synthetic-claim',control_number:'SYN-CLAIM-1',version:1,status:'ready',
  content:{synthetic_test:!route},
  patient_id:'synthetic-patient',
  snapshot:{patient:{given_name:'Synthetic',family_name:'Patient'},claim_routing:route,account:{coverage_snapshot:{payer:{content:{name:'Synthetic Home Blue'}},coverage:{content:{payer_id:'synthetic-payer'}}}}}},
  submission_defaults:defaults});
 return pane.html;
}
const fullAddress={line1:'123 Synthetic St',line2:'Suite 4',city:'Syntheticton',state:'CA',postal_code:'90001'};
const filledDefaults={patient_address:fullAddress,subscriber_address:fullAddress,billing_taxonomy:'207Q00000X',filing_indicator:'MB',billing_address:fullAddress,
 subscriber_given_name:'Synthetic',subscriber_family_name:'Member',patient_sex:'F',subscriber_sex:'M',
 rendering_given_name:'Synthetic',rendering_family_name:'Provider',
 source_references:{billing_address:'123 Synthetic St Suite 4, Syntheticton CA 90001'}};
// The markup ends each input with `required>` or a bare `>`, so the ending decides.
const attributeOf=(html,name)=>{const match=new RegExp(`<input[^>]* name="${name}"[^>]*>`).exec(html);return match?match[0]:'';};
const isRequired=(html,name)=>/\srequired(?=>|\s)/.test(attributeOf(html,name));

(function compactReviewShowsOnlyMissingFields(){
 const html=render({...filledDefaults,patient_address:fullAddress,subscriber_address:{...fullAddress,postal_code:''}},true);
 assert.match(html,/Policy holder address<\/dt><dd>123 Synthetic St, Suite 4, Syntheticton, CA/);
 assert.match(html,/<input type="hidden" name="billing_postal_code" value="90001">/);
 assert.match(html,/<input type="hidden" name="subscriber_city" value="Syntheticton">/);
 assert.equal(isRequired(html,'subscriber_postal_code'),true);
 assert.equal((html.match(/<fieldset class="edi-address">/g)||[]).length,1);
 assert.doesNotMatch(html,/Save claim file without sending|Subscriber first name|Rendering provider first name/);
 assert.match(html,/name="claim_review_confirmed" type="checkbox" required/);
})();


(function filledDefaultsRender(){
 const html=render(filledDefaults);
 assert.match(html,/<form id="claimmd-submit-form" data-request="request">/);
 assert.match(html,/name="claim_review_confirmed" type="checkbox" required/);
 assert.match(html,/name="synthetic_test_reviewed" type="checkbox" required/);
 assert.match(html,/name="claimmd_action" value="prepare">Save claim file without sending/);
 assert.match(html,/name="claimmd_action" value="queue">Send test claim to Claim\.MD/);
 assert.equal(attributeOf(html,'billing_taxonomy').includes('value="207Q00000X"'),true,'taxonomy input must be filled');
 assert.match(html,new RegExp('<select name="filing_indicator">.*?<option value="MB" selected>'),'MB must be the chosen insurance type');
 assert.equal(attributeOf(html,'billing_line1').includes('value="123 Synthetic St"'),true,'billing street must be filled');
 assert.equal(attributeOf(html,'billing_city').includes('value="Syntheticton"'),true,'billing city must be filled');
 assert.equal(attributeOf(html,'billing_state').includes('value="CA"'),true,'billing state must be filled');
 assert.equal(attributeOf(html,'billing_postal_code').includes('value="90001"'),true,'billing ZIP must be filled');
 assert.doesNotMatch(html,/Practice administration/,'no Practice administration hint when the details are on file');

})();

(function emptyDefaultsRender(){
  const html=render({source_references:{}});
  assert.match(html,/From Practice administration → Providers/);
  assert.doesNotMatch(html,/Found in the national NPI registry/,'a missing taxonomy is not called found');
  assert.match(html,/From Practice administration → Facilities/,'missing billing address tells staff where to review it');
  assert.doesNotMatch(html,/Billing address on file:<\/b> Not on file/,'the screen must not say "on file: Not on file"');
 })();

 (function taxonomyFromNpiRegistry(){
  const html=render({...filledDefaults,billing_taxonomy_source:'npi_registry'});
  assert.match(html,/<input type="hidden" name="billing_taxonomy" value="207Q00000X">/);
  assert.doesNotMatch(html,/Add it under Practice administration → Providers/,'a found taxonomy is not called missing');
 })();

 (function taxonomyFromProviderRecord(){
  const html=render({...filledDefaults,billing_taxonomy_source:'provider'});
  assert.doesNotMatch(html,/Found in the national NPI registry/,'a code on the provider record is not called a registry lookup');
  assert.doesNotMatch(html,/No taxonomy code was found/,'a filled taxonomy is not called missing');
  assert.doesNotMatch(html,/Add it under Practice administration → Providers/,'the provider source shows no hint');
 })();

(function billingAddressTextOnFileButNotFilled(){
 const html=render({billing_address:{},source_references:{billing_address:'123 Synthetic St Suite 4, Syntheticton CA 90001'}});
 assert.match(html,/Address on file: 123 Synthetic St Suite 4, Syntheticton CA 90001/);
 assert.doesNotMatch(html,/No billing address on file\./,'a billing address that is on file is not called missing');
})();

(function payerAddressIsOptional(){
 const html=render({...filledDefaults,billing_address:{},billing_taxonomy:'',filing_indicator:'',source_references:{billing_address:'123 Synthetic St Suite 4, Syntheticton CA 90001',payer_address:'PO Box 9, Syntheticton CA 90002'}});
 assert.match(html,/Insurer address on file: PO Box 9, Syntheticton CA 90002/,'the insurer address on file is shown as it is');
 assert.doesNotMatch(html,/Insurer address on file:<\/b>[^<]*Enter it/,'staff are not told to type the insurer address in');
 assert.match(html,/From Practice administration → Facilities/,'the billing address hint is back once the billing address is blank');
 for(const key of ['line1','line2','city','state','postal_code']){
  assert.equal(isRequired(html,'payer_'+key),false,`payer_${key} must not be required`);
 }
 for(const prefix of ['billing'])for(const key of ['line1','city','state','postal_code']){
  assert.equal(isRequired(html,`${prefix}_${key}`),true,`${prefix}_${key} must stay required`);
 }
 assert.match(html,/Insurer address \(optional\)/);
 assert.match(html,/Fill in only when the insurer asks for it\./);
 assert.doesNotMatch(html,/Payer address/);
})();

(function localBlueShowsCoverageAndDestinationOnBothConsentForms(){
 const route={kind:'bluecard_local',payer_name:'Synthetic Local Blue',payer_code:'22099'};
 const compact=render(filledDefaults,true,route);
 assert.match(compact,/Insurance coverage<\/dt><dd>Synthetic Home Blue/);
 assert.match(compact,/Claim destination<\/dt><dd>Synthetic Local Blue · 22099/);
 assert.doesNotMatch(compact,/name="synthetic_test_reviewed"/);
 const worklist=render(filledDefaults,false,route);
 assert.match(worklist,/Insurance coverage<\/dt><dd>Synthetic Home Blue/);
 assert.match(worklist,/Claim destination<\/dt><dd>Synthetic Local Blue · 22099/);
 assert.match(worklist,/name="claim_review_confirmed" type="checkbox" required/);
})();

console.log('PASS Claim.MD submission editor reuses structured chart and claim defaults');
