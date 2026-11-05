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

const history=context.claimmdEligibilityHistory([{status:'completed',created_at:'2026-11-05',actor_id:'staff-1',response_snapshot:{elig:[{eligid:'synthetic-eligibility',insurance_plan:'Plan <unsafe>',benefit:[{benefit_description:'Coverage <active>',benefit_coverage_description:'Active Coverage',benefit_amount:'0'}]}]}}]);
assert.match(history,/Plan &lt;unsafe&gt;/);assert.match(history,/Coverage &lt;active&gt;/);assert.doesNotMatch(history,/<unsafe>/);assert.match(history,/synthetic-eligibility/);
console.log('PASS structured eligibility results and audit attribution render safely');
