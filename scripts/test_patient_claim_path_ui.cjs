// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

const billing=fs.readFileSync('web/billing.js','utf8');
const claims=fs.readFileSync('web/claims.js','utf8');

assert.match(billing,/data-patient-claims>Review this patient’s claims/);
assert.match(billing,/data-patient-create-claim aria-describedby="patient-claim-readiness"/);
assert.match(billing,/data-new-billing aria-describedby="patient-claim-readiness">Prepare charge account/);
assert.doesNotMatch(billing,/data-patient-create-claim[^>]*disabled/);
assert.match(billing,/Add active coverage with a Claim\.MD payer ID, record charges, sign the visit and post the insured charge account to enable claim creation/);
assert.match(billing,/const patientClaimAccounts=.*status==='posted'.*payer_code/);
assert.match(billing,/if\(accounts\.length===1\)\{await beginClaim\(accounts\[0\]\.id\);return;\}/);
assert.match(billing,/Choose charges for this claim/);
assert.match(billing,/Nothing is sent until the claim is reviewed, marked ready and explicitly submitted through Claim\.MD/);
assert.match(billing,/data-patient-create-claim'\)\)\{await beginPatientClaim\(\);return;\}/);
assert.match(billing,/Insurance claim path/);
assert.match(billing,/const patientPaymentAccounts=.*status==='posted'.*billBalance/);
assert.match(billing,/function beginPatientPayment\(\)/);
assert.match(billing,/data-patient-collect-copay/);
assert.match(billing,/claim screen offers explicit native Claim\.MD submission when the clinic’s Claim\.MD connection is active/);
assert.match(billing,/class="primary" data-new-claim="\$\{a\.id\}">Create insurance claim/);
assert.match(billing,/data-patient-claims'\)\)\{await showClaimsWorkspace\(\);return;\}/);
assert.match(claims,/if\(b\.dataset\.newClaim\)\{await beginClaim\(b\.dataset\.newClaim\);return;\}/);
assert.match(claims,/data-claimmd-submit/);

const selector=billing.match(/const patientClaimAccounts=.*;\n/)[0].replace('const patientClaimAccounts=','globalThis.patientClaimAccounts=');
const context={workspace:{billing:{accounts:[]}}};
vm.runInNewContext(selector,context);
const account=(id,status,date,payerCode)=>({id,status,content:{service_date:date},coverage_snapshot:{payer:{content:{payer_code:payerCode}}}});
assert.deepEqual(Array.from(context.patientClaimAccounts({accounts:[
 account('draft','draft','2026-11-09','12345'),
 account('local','posted','2026-11-08',''),
 account('older','posted','2026-11-07','54321'),
 account('newer','posted','2026-11-10','12345'),
]}),row=>row.id),['newer','older']);

console.log('PASS patient Financials exposes the existing reviewed claim lifecycle and native Claim.MD submission path');
