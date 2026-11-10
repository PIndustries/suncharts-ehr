// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const native=fs.readFileSync('web/claimmd-native.js','utf8');
assert.match(native,/function claimMdSubmitEditor\(detail\)/);
assert.match(native,/detail\.submission_defaults\|\|\{\}/);
assert.match(native,/claimMdSubmitEditor\(detail\)/);
for(const field of ['subscriber_given_name','subscriber_family_name','patient_sex','subscriber_sex','rendering_given_name','rendering_family_name','billing_taxonomy','filing_indicator'])assert.match(native,new RegExp(field));
for(const address of ['billing_address','subscriber_address','patient_address','payer_address'])assert.match(native,new RegExp(address));
assert.match(native,/SunCharts prepared this submission/);
assert.match(native,/values were filled from the frozen claim and current chart/);
assert.match(native,/Prepare 837P only/);
assert.match(native,/Prepare and queue to Claim\.MD/);
assert.match(native,/Nothing was sent externally/);
console.log('PASS Claim.MD submission editor reuses structured chart and claim defaults');
