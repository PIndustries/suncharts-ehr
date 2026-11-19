// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The CPT section on the owner's Codes & prices screen: one license box and one button, a working
// state, and an installed CPT list simply reported. Synthetic only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/terminology.js','utf8');
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(response){
 const handlers={},calls=[];
 const context=vm.createContext({Map,Set,WeakMap,WeakSet,Object,Array,Number,String,Date,JSON,URLSearchParams,encodeURIComponent,Error,Promise,console,calls,
  me:{role:'owner'},esc,crypto:{randomUUID:()=>'00000000-0000-4000-8000-000000000001'},
  document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},
  api:async(path,method,body)=>{calls.push({path,method,body});return response(path,method,body);},setTimeout,clearTimeout});
 vm.runInContext(source,context);
 vm.runInContext('showTerminologyCatalogs=async()=>{calls.push({refreshed:true});}',context);
 return {context,calls,handlers};
}
function form({attested=true}={}){
 const status={textContent:''},button={disabled:false,textContent:'Install CPT codes'};
 return {id:'terminology-cpt-form',status,button,elements:{license_attested:{checked:attested}},
  querySelector:s=>s==='[data-cpt-status]'?status:s==='button[type="submit"]'?button:null};
}
(async()=>{
 let f=fixture(async()=>({release:{code_count:11063},created:true}));
 const markup=f.context.terminologyCptSection([{system:'ICD-10-CM',edition:'FY2027',code_count:1}]);
 assert.match(markup,/Our practice holds a current CPT license from the American Medical Association/);
 assert.match(markup,/name="license_attested" required/);assert.match(markup,/>Install CPT codes</);
 assert.doesNotMatch(markup,/license_reference|license_valid_until|type="date"|Agreement or account/,'the box is the only thing to fill in');
 const installed=f.context.terminologyCptSection([{system:'CPT',edition:'2026 (CMS PFS RVU26D, October 2026)',code_count:11063}]);
 assert.match(installed,/CPT codes installed: 2026 \(CMS PFS RVU26D, October 2026\), 11,063 codes\./);assert.doesNotMatch(installed,/<form/);
 let x=form({attested:false});await f.context.installTerminologyCpt(x);assert.match(x.status.textContent,/Confirm that your practice holds a CPT license/);assert.equal(f.calls.length,0);
 x=form();const pending=f.context.installTerminologyCpt(x);assert.equal(x.button.disabled,true);assert.match(x.button.textContent,/Installing… this takes up to a minute/);await pending;
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{path:'/api/v1/terminology/cpt-install',method:'POST',body:{request_id:'00000000-0000-4000-8000-000000000001',license_attested:true}});
 assert.match(x.status.textContent,/Installed 11,063 CPT codes\./);assert.ok(f.calls.some(c=>c.refreshed));
 f=fixture(async()=>{throw new Error('The CPT file could not be downloaded from CMS. Try again later.');});x=form();await f.context.installTerminologyCpt(x);
 assert.match(x.status.textContent,/could not be downloaded from CMS/);assert.equal(x.button.disabled,false);assert.equal(x.button.textContent,'Install CPT codes');
 f=fixture(async()=>({release:{code_count:3},created:true}));let prevented=false;const target=form();
 for(const h of f.handlers.submit||[])h({target,preventDefault(){prevented=true;},stopImmediatePropagation(){}});await new Promise(r=>setImmediate(r));assert.equal(prevented,true);
 console.log('PASS CPT install section: one license box, working state, installed summary, server errors shown, own submit handler');
})().catch(error=>{console.error(error);process.exitCode=1;});
