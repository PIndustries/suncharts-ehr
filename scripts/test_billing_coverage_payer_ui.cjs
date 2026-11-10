'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync('web/billing.js','utf8');

assert.match(source,/function coveragePayerSetup\(\)[\s\S]*No native payers are available[\s\S]*practice owner must add the payer/);
assert.match(source,/function coveragePayerForm\(\)[\s\S]*id="coverage-payer-form"[\s\S]*Claim\.MD payer ID \(optional\)/);
assert.match(source,/button class="primary" type="submit" \$\{billingPayers\.length\?'':'disabled'\}>Save coverage/);
assert.match(source,/\['payer-form','coverage-payer-form','coverage-form'/);
assert.match(source,/f\.id==='coverage-payer-form'[\s\S]*api\('\/api\/v1\/billing\/payers','POST'/);
assert.match(source,/payer_code:data\.payer_code/);
assert.match(source,/select\.innerHTML=coveragePayerOptions\(payer\.id\)/);
assert.match(source,/coverage\.querySelector\('button\[type="submit"\]'\)\.disabled=false/);
assert.match(source,/Finish the coverage details, then save the coverage/);
assert.match(source,/<th>Claim\.MD payer ID<\/th>/);

console.log('PASS empty coverage payer directories expose inline native payer setup and select the created Claim.MD-mapped payer');
