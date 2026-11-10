// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic UI fixtures; a live Claim.MD account and browser acceptance are separate checks.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../web/claimmd-eligibility.js'),'utf8');
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const context=vm.createContext({console,Date,Intl,URLSearchParams,crypto:{randomUUID:()=> 'synthetic-request'},window:{},document:{addEventListener(){}},esc,human:value=>String(value).replaceAll('_',' '),date:value=>value,billingWrite:()=>true});
vm.runInContext(source,context);

assert.match(context.claimmdEligibilityButton({id:'coverage-1',content:{status:'active'}}),/data-claimmd-eligibility="coverage-1"/);
assert.equal(context.claimmdEligibilityButton({id:'coverage-2',content:{status:'inactive'}}),'');
assert.doesNotMatch(source,/AccountKey|account_key/);
console.log('PASS active coverage action and no credential fields in browser source');

const payerHtml=context.claimmdPayerRows([{payer_name:'Payer <script>',payerid:'60054',payer_type:'commercial',eligibility:'yes','1500_claims':'yes',ub_claims:'no',era:'enrollment'}]);
assert.match(payerHtml,/Payer &lt;script&gt;/);assert.doesNotMatch(payerHtml,/<script>/);assert.match(payerHtml,/60054/);assert.match(payerHtml,/enrollment/);
console.log('PASS payer capability rendering escapes directory data');

const selectable=context.claimmdPayerRows([{payer_name:'Synthetic payer',payerid:'SYN001'}],true);
assert.match(selectable,/data-claimmd-payer-select="SYN001"/);assert.match(selectable,/Use payer/);
assert.match(context.claimmdCoveragePayerSearch(),/coverage-claimmd-payer-search/);
assert.match(source,/const payerid=\(data\.payerid\|\|'\'\)\.trim\(\),name=\(data\.name\|\|'\'\)\.trim\(\)/);
console.log('PASS payer directory results are selectable in native coverage setup');

vm.runInContext("claimmdProviderDefaults={providers:[{id:'provider-1',display_name:'Synthetic Provider',npi:'1234567893'}],facilities:[{id:'facility-1',name:'Synthetic Clinic',address:'100 Test Way'}],default_provider_id:'provider-1',default_facility_id:'facility-1'}",context);
const defaults=context.claimmdClaimProviderDefaults();
assert.deepEqual(JSON.parse(JSON.stringify(defaults)),{billing_provider_name:'Synthetic Clinic',billing_npi:'1234567893',rendering_npi:'1234567893',billing_address:'100 Test Way',tax_id:''});
console.log('PASS stored provider and facility identity is reusable without inventing tax identity');

const history=context.claimmdEligibilityHistory([{status:'completed',created_at:'2026-11-05',actor_id:'staff-1',response_snapshot:{elig:[{eligid:'synthetic-eligibility',insurance_plan:'Plan <unsafe>',benefit:[{benefit_description:'Coverage <active>',benefit_coverage_description:'Active Coverage',benefit_amount:'0'}]}]}}]);
assert.match(history,/Plan &lt;unsafe&gt;/);assert.match(history,/Coverage &lt;active&gt;/);assert.doesNotMatch(history,/<unsafe>/);assert.match(history,/synthetic-eligibility/);
console.log('PASS structured eligibility results and audit attribution render safely');
