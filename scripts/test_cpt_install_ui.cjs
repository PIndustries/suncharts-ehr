// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The CPT section on the owner's Code lists screen: the license box and reference are required,
// the button says it is working, and an installed CPT list is simply reported. Synthetic only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/terminology.js','utf8');
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(response){
 const handlers={},calls=[];
 const context=vm.createContext({Map,Set,WeakMap,WeakSet,Object,Array,Number,String,Date,JSON,URLSearchParams,encodeURIComponent,Error,Promise,console,
  me:{role:'owner'},esc,crypto:{randomUUID:()=>'00000000-0000-4000-8000-000000000001'},
  document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},
  api:async(path,method,body)=>{calls.push({path,method,body});return response(path,method,body);},
  showTerminologyCatalogs:async()=>{calls.push({refreshed:true});},setTimeout,clearTimeout});
 vm.runInContext(source,context);
 vm.runInContext('showTerminologyCatalogs=async()=>{calls.push({refreshed:true});}',Object.assign(context,{calls}));
 return {context,calls,handlers};
}
function form({attested=true,reference='Synthetic license 1',until=''}={}){
 const status={textContent:''},button={disabled:false,textContent:'Install CPT codes'};
 return {id:'terminology-cpt-form',status,button,elements:{license_attested:{checked:attested},license_reference:{value:reference},license_valid_until:{value:until}},
  querySelector:s=>s==='[data-cpt-status]'?status:s==='button[type="submit"]'?button:null};
}
(async()=>{
 let f=fixture(async()=>({release:{code_count:11063},created:true}));
 const markup=f.context.terminologyCptSection([{system:'ICD-10-CM',edition:'FY2027',code_count:1}]);
 assert.match(markup,/Our practice holds a current CPT license from the American Medical Association/);
 assert.match(markup,/name="license_attested" required/);assert.match(markup,/name="license_reference" required/);assert.match(markup,/type="date" name="license_valid_until"/);assert.match(markup,/>Install CPT codes</);
 const installed=f.context.terminologyCptSection([{system:'CPT',edition:'2026 (CMS PFS RVU26D, October 2026)',code_count:11063}]);
 assert.match(installed,/CPT codes installed: 2026 \(CMS PFS RVU26D, October 2026\), 11,063 codes\./);assert.doesNotMatch(installed,/<form/);
 // Unchecked box or blank reference: nothing is sent.
 let x=form({attested:false});await f.context.installTerminologyCpt(x);assert.match(x.status.textContent,/Confirm that your practice holds a CPT license/);
 x=form({reference:'  '});await f.context.installTerminologyCpt(x);assert.match(x.status.textContent,/Enter the license reference/);assert.equal(f.calls.length,0);
 // Install: the button says it is working, the request names the license, the list refreshes.
 x=form({until:'2027-12-31'});const pending=f.context.installTerminologyCpt(x);assert.equal(x.button.disabled,true);assert.match(x.button.textContent,/Installing… this takes up to a minute/);await pending;
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{path:'/api/v1/terminology/cpt-install',method:'POST',body:{request_id:'00000000-0000-4000-8000-000000000001',license_attested:true,license_reference:'Synthetic license 1',license_valid_until:'2027-12-31'}});
 assert.match(x.status.textContent,/Installed 11,063 CPT codes\./);assert.ok(f.calls.some(c=>c.refreshed));
 // A failed download shows the server's words and gives the button back.
 f=fixture(async()=>{throw new Error('The CPT file could not be downloaded from CMS. Try again later.');});x=form();await f.context.installTerminologyCpt(x);
 assert.match(x.status.textContent,/could not be downloaded from CMS/);assert.equal(x.button.disabled,false);assert.equal(x.button.textContent,'Install CPT codes');
 // The form submit is caught by its own handler and never by the file import.
 f=fixture(async()=>({release:{code_count:3},created:true}));let prevented=false;const target=form();
 for(const h of f.handlers.submit||[])h({target,preventDefault(){prevented=true;},stopImmediatePropagation(){}});await new Promise(r=>setImmediate(r));assert.equal(prevented,true);
 console.log('PASS CPT install section: license box and reference required, working state, installed summary, server errors shown, own submit handler');
})().catch(error=>{console.error(error);process.exitCode=1;});
