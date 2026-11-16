// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const native=fs.readFileSync('web/claimmd-native.js','utf8');
assert.match(native,/function claimMdSubmitEditor\(detail\)/);
assert.match(native,/detail\.submission_defaults\|\|\{\}/);
assert.match(native,/claimMdSubmitEditor\(detail\)/);
for(const field of ['subscriber_given_name','subscriber_family_name','patient_sex','subscriber_sex','rendering_given_name','rendering_family_name','billing_taxonomy','filing_indicator'])assert.match(native,new RegExp(field));
for(const address of ['billing_address','subscriber_address','patient_address','payer_address'])assert.match(native,new RegExp(address));
assert.match(native,/Check these details before sending/);
assert.match(native,/fields were filled in from the claim and the chart/);
assert.match(native,/Save claim file without sending/);
assert.match(native,/Send claim to Claim\.MD/);
assert.match(native,/Nothing was sent to Claim\.MD/);

// Rendering the fill-in form: the screen is loaded in a sandbox with stubs that
// produce real markup, so the form can be inspected as clinic staff see it.
const vm=require('node:vm');
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function render(defaults){
 const pane={html:''};
 // The screen builds its inputs through ediField (web/clearinghouse.js), which
 // passes the field's max length through to the app's billingField in its place.
 const ediField=(name,label,value='',max=200,required=true)=>`<label>${escape(label)}<input name="${name}" type="${max}" value="${escape(value)}" ${required?'required':''}></label>`;
 const selectField=(name,label,options,value)=>`<label>${escape(label)}<select name="${name}">${options.map(option=>`<option value="${escape(option)}" ${option===value?'selected':''}>${escape(option)}</option>`).join('')}</select></label>`;
 const context={console,crypto:{randomUUID:()=>'request'},document:{addEventListener:()=>{}},esc:escape,human:String,date:String,
  billingField:ediField,ediField,selectField,claimPane:html=>{pane.html=html;},
  claimContextSnapshot:()=>null,claimMdConnectionState:{connected:true,active:{usage:'T'}},
  claimsBase:'/api/v1/billing/claims',$:()=>null,api:async()=>({items:[]}),notice:()=>{},run:fn=>{fn();}};
 vm.createContext(context);
 vm.runInContext(native,context);
 context.claimMdSubmitEditor({claim:{id:'synthetic-claim',control_number:'SYN-CLAIM-1',version:1,status:'ready',
  content:{synthetic_test:true},
  patient_id:'synthetic-patient',
  snapshot:{patient:{given_name:'Synthetic',family_name:'Patient'},account:{coverage_snapshot:{coverage:{content:{payer_id:'synthetic-payer'}}}}}},
  submission_defaults:defaults});
 return pane.html;
}
const fullAddress={line1:'123 Synthetic St',line2:'Suite 4',city:'Syntheticton',state:'CA',postal_code:'90001'};
const filledDefaults={billing_taxonomy:'207Q00000X',filing_indicator:'MB',billing_address:fullAddress,
 subscriber_given_name:'Synthetic',subscriber_family_name:'Member',patient_sex:'F',subscriber_sex:'M',
 rendering_given_name:'Synthetic',rendering_family_name:'Provider',
 source_references:{billing_address:'123 Synthetic St Suite 4, Syntheticton CA 90001'}};
// The markup ends each input with `required>` or a bare `>`, so the ending decides.
const attributeOf=(html,name)=>{const match=new RegExp(`<input name="${name}"[^>]*>`).exec(html);return match?match[0]:'';};
const isRequired=(html,name)=>/\srequired(?=>|\s)/.test(attributeOf(html,name));

(function filledDefaultsRender(){
 const html=render(filledDefaults);
 assert.equal(attributeOf(html,'billing_taxonomy').includes('value="207Q00000X"'),true,'taxonomy input must be filled');
 assert.match(html,new RegExp('<select name="filing_indicator">.*?<option value="MB" selected>'),'MB must be the chosen insurance type');
 assert.equal(attributeOf(html,'billing_line1').includes('value="123 Synthetic St"'),true,'billing street must be filled');
 assert.equal(attributeOf(html,'billing_city').includes('value="Syntheticton"'),true,'billing city must be filled');
 assert.equal(attributeOf(html,'billing_state').includes('value="CA"'),true,'billing state must be filled');
 assert.equal(attributeOf(html,'billing_postal_code').includes('value="90001"'),true,'billing ZIP must be filled');
 assert.doesNotMatch(html,/Practice administration/,'no Practice administration hint when the details are on file');
 const count=Number(/([0-9]+) fields were filled in/.exec(html)[1]);
 // six names, two sexes, the taxonomy and three non-empty billing address parts
 assert.equal(count,6+2+1+3,'count must cover names, sexes, the taxonomy and the billing address');
})();

(function emptyDefaultsRender(){
 const html=render({source_references:{}});
 assert.match(html,/Add the provider’s taxonomy code under Practice administration → Providers and it will be filled in here\./);
 assert.match(html,/<b>No billing address on file.<\/b> Add the street, city, state and ZIP under Practice administration → Facilities and it will be filled in here\./,'a practice with no billing address is told so plainly');
 assert.doesNotMatch(html,/Billing address on file:<\/b> Not on file/,'the screen must not say "on file: Not on file"');
})();

(function billingAddressTextOnFileButNotFilled(){
 const html=render({billing_address:{},source_references:{billing_address:'123 Synthetic St Suite 4, Syntheticton CA 90001'}});
 assert.match(html,/<b>Billing address on file:<\/b> 123 Synthetic St Suite 4, Syntheticton CA 90001\. Add the street, city, state and ZIP under Practice administration → Facilities and it will be filled in here\./);
 assert.doesNotMatch(html,/No billing address on file\./,'a billing address that is on file is not called missing');
})();

(function payerAddressIsOptional(){
 const html=render({...filledDefaults,billing_address:{},billing_taxonomy:'',filing_indicator:'',source_references:{billing_address:'123 Synthetic St Suite 4, Syntheticton CA 90001',payer_address:'PO Box 9, Syntheticton CA 90002'}});
 assert.match(html,/<b>Insurer address on file:<\/b> PO Box 9, Syntheticton CA 90002\./,'the insurer address on file is shown as it is');
 assert.doesNotMatch(html,/Insurer address on file:<\/b>[^<]*Enter it/,'staff are not told to type the insurer address in');
 assert.match(html,/Add the street, city, state and ZIP under Practice administration/,'the billing address hint is back once the billing address is blank');
 for(const key of ['line1','line2','city','state','postal_code']){
  assert.equal(isRequired(html,'payer_'+key),false,`payer_${key} must not be required`);
 }
 for(const prefix of ['billing','subscriber','patient'])for(const key of ['line1','city','state','postal_code']){
  assert.equal(isRequired(html,`${prefix}_${key}`),true,`${prefix}_${key} must stay required`);
 }
 assert.match(html,/Insurer address \(optional\)/);
 assert.match(html,/Leave this blank unless the insurer asks for it\./);
 assert.doesNotMatch(html,/Payer address/);
})();

console.log('PASS Claim.MD submission editor reuses structured chart and claim defaults');
