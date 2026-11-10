// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');

const billing=fs.readFileSync('web/billing.js','utf8');
const claims=fs.readFileSync('web/claims.js','utf8');

assert.match(billing,/data-patient-claims>Review this patient’s claims/);
assert.match(billing,/Insurance claim path/);
assert.match(billing,/Open a posted insured charge account and choose <b>Create insurance claim<\/b>/);
assert.match(billing,/native Claim\.MD submission when the clinic’s Claim\.MD connection is active/);
assert.match(billing,/class="primary" data-new-claim="\$\{a\.id\}">Create insurance claim/);
assert.match(billing,/data-patient-claims'\)\)\{await showClaimsWorkspace\(\);return;\}/);
assert.match(claims,/if\(b\.dataset\.newClaim\)\{await beginClaim\(b\.dataset\.newClaim\);return;\}/);
assert.match(claims,/data-claimmd-submit/);

console.log('PASS patient Financials exposes the existing reviewed claim lifecycle and native Claim.MD submission path');
