// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
const handlers={},ctx={console,selected:'patient',me:{role:'owner'},workspace:{billing:{coverages:[]}},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:()=>null,esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),human:v=>String(v||'').replaceAll('_',' '),notice(){},run:fn=>fn()};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);

// The three drug inputs render inside the row's "More" area, filled from the line.
const withDrug=ctx.chargeRow({code:'J0585',code_system:'HCPCS',amount_cents:12500,ndc_code:'00023114501',ndc_quantity:'100',ndc_unit:'UN'});
assert.match(withDrug,/Drug given \(for injections\)/);
assert.match(withDrug,new RegExp('<input name="ndc_code"[^>]*value="00023114501"'));
assert.match(withDrug,new RegExp('placeholder="11 digits"'));
assert.match(withDrug,new RegExp('<input name="ndc_quantity"[^>]*value="100"'));
assert.match(withDrug,new RegExp('<select name="ndc_unit">'));
assert.match(withDrug,new RegExp('<option value="UN" selected>UN — units'));
assert.match(withDrug,new RegExp('<option value="F2" >F2 — international units'));
// The "More" area opens automatically when the line already carries an NDC.
assert.match(withDrug,new RegExp('<details class="charge-drug-more" open>'));
// A plain line: the fields render empty and its "More" area stays closed.
const plain=ctx.chargeRow({code:'99213',code_system:'CPT',amount_cents:15000});
assert.match(plain,/Drug given \(for injections\)/);
assert.match(plain,new RegExp('<input name="ndc_code"[^>]*value=""'));
assert.match(plain,new RegExp('<option value="" selected>'));
assert.doesNotMatch(plain,new RegExp('<details class="charge-more" open>'));
assert.doesNotMatch(plain,new RegExp('<details class="charge-drug-more" open>'));
// Compact (visit) rows and full rows both carry the group inside their More area.
const compact=ctx.chargeRow({code:'J0585',amount_cents:12500,ndc_code:'00023114501',ndc_quantity:'2.5',ndc_unit:'ML'},true);
assert.match(compact,new RegExp('<details class="charge-more" open>'));
assert.match(compact,new RegExp('<input name="ndc_quantity"[^>]*value="2.5"'));
assert.match(compact,new RegExp('<option value="ML" selected>ML — milliliters'));

// The submitted line carries the three keys only when an NDC is entered.
const eq=(a,b,why)=>assert.equal(JSON.stringify(a),JSON.stringify(b),why);
eq(ctx.chargeDrugMarkup({ndc_code:'00023114501',ndc_quantity:'100',ndc_unit:'UN'}),{ndc_code:'00023114501',ndc_quantity:'100',ndc_unit:'UN'});
eq(ctx.chargeDrugMarkup({ndc_code:'',ndc_quantity:'',ndc_unit:''}),{},'a line with no NDC sends no drug keys');
eq(ctx.chargeDrugMarkup({}),{},'a line with no fields at all sends no drug keys');
eq(ctx.chargeDrugMarkup({ndc_code:' 00023114501 ',ndc_quantity:' 100 ',ndc_unit:' UN '}),{ndc_code:'00023114501',ndc_quantity:'100',ndc_unit:'UN'},'values are trimmed on the way out');

// The submit path wires each row's drug inputs through the same explicit key list.
const source=fs.readFileSync('web/billing.js','utf8');
assert.match(source,/chargeDrugMarkup\(\{ndc_code:value\('ndc_code'\),ndc_quantity:value\('ndc_quantity'\),ndc_unit:value\('ndc_unit'\)\}\)/);

// The clearinghouse screen no longer calls the drug (NDC) claim kind unsupported.
const edi=fs.readFileSync('web/clearinghouse.js','utf8');
assert.doesNotMatch(edi,/drug \(NDC\)/);
assert.match(edi,/not institutional, dental, secondary \(COB\), accident, referring-provider or prior-authorization claims\./);

console.log('PASS charge drug fields render filled from the line, the More area opens for a drug line, submitted keys appear only with an NDC, and the NDC claim kind is no longer listed as unsupported');
