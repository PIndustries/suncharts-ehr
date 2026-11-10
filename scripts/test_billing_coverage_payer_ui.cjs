'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync('web/billing.js','utf8');

assert.match(source,/function coveragePayerSetup\(\)[\s\S]*No native payers are available[\s\S]*practice owner must add the payer/);
assert.match(source,/function coveragePayerForm\(\)[\s\S]*id="coverage-payer-form"[\s\S]*billingField\('payer_code','Claim\.MD payer ID','','text',100,true\)/);
assert.match(source,/Required here because insured accounts freeze this mapping when they are posted/);
assert.doesNotMatch(source,/Claim\.MD payer ID \(optional\)/);
assert.match(source,/button class="primary" type="submit" \$\{billingPayers\.length\?'':'disabled'\}>Save coverage/);
assert.match(source,/\['payer-form','coverage-payer-form','coverage-form'/);
assert.match(source,/f\.id==='coverage-payer-form'[\s\S]*api\('\/api\/v1\/billing\/payers','POST'/);
assert.match(source,/payer_code:data\.payer_code/);
assert.match(source,/select\.innerHTML=coveragePayerOptions\(payer\.id\)/);
assert.match(source,/coverage\.querySelector\('button\[type="submit"\]'\)\.disabled=false/);
assert.match(source,/Finish the coverage details, then save the coverage/);
assert.match(source,/<th>Claim\.MD payer ID<\/th>/);
assert.match(source,/name="local_only" value="true"/);
assert.match(source,/Post as local-only insurance activity/);
assert.match(source,/data\.local_only=data\.local_only==='true'/);
assert.match(source,/a\.status==='posted'&&frozenElectronicPayer/);
assert.match(source,/Local-only insurance account/);

const billingRust=fs.readFileSync('src/billing.rs','utf8');
assert.match(billingRust,/local_only: bool/);
assert.match(billingRust,/missing_electronic_payer && !v\.local_only/);
assert.match(billingRust,/add the correct Claim\.MD payer ID in the payer mapping before posting/);

const claimsRust=fs.readFileSync('src/claims.rs','utf8');
assert.match(claimsRust,/Claim\.MD payer ID is missing from the frozen payer mapping/);
assert.doesNotMatch(claimsRust,/Payer \{field\} is required/);

console.log('PASS empty coverage payer directories expose inline native payer setup and select the created Claim.MD-mapped payer');
