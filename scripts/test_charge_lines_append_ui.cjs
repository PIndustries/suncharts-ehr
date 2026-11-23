// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Lines added to the open charge table from outside it (a bundle, or accepted code suggestions)
// go through one path: blank rows make way, each line is a normal row linked to the encounter's
// diagnoses by default, the practice price is looked up, and the table saves itself. Synthetic data.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
function fixture({readOnly=false}={}){
 const inserted=[],rows=[],priced=[],saved=[],notices=[];
 const body={insertAdjacentHTML(_where,html){inserted.push(html);const row={dataset:{},html,querySelector:()=>({value:'x'}),remove(){rows.splice(rows.indexOf(row),1);},scrollIntoView(){}};rows.push(row);body.lastElementChild=row;}};
 const form={dataset:readOnly?{draftReadOnly:'true'}:{compact:'true'},querySelector:sel=>sel==='#billing-charge-lines tbody'?body:null};
 const blank={dataset:{},querySelector:()=>null,remove(){rows.splice(rows.indexOf(blank),1);},isBlank:true};rows.push(blank);
 const context=vm.createContext({console,Map,Set,Promise,$:id=>id==='billing-account-form'?form:null,
  chargeLiveRows:()=>rows.slice(),chargeLineDescription:row=>row.isBlank?'':'x',chargeRowAmount:row=>row.isBlank?null:1,chargeRowMemoryCache:new Map(),
  chargeRow:(line,compact,key)=>JSON.stringify({line,compact,key}),chargeLineKey:(_l,n)=>`line-${n+1}`,chargeRowCapture(){},
  chargeTableTotals:()=>saved.push('totals'),renderChargeRowProblems:()=>saved.push('problems'),captureBillingChargeDraft:()=>saved.push('draft'),scheduleChargeAutosave:()=>saved.push('autosave'),
  notice:message=>notices.push(message),esc:String,document:{addEventListener(){}},me:{role:'owner'},selected:'p1'});
 vm.runInContext(fs.readFileSync('web/fees.js','utf8'),context);
 context.priceMemoryCheck=async row=>{priced.push(row);};
 return {context,inserted,rows,priced,saved,notices,blank};
}
const f=fixture();
const added=f.context.chargeLinesAppend([{code_system:'CPT',code:'64616',description:'Synthetic neck injection',modifiers:'RT',units:1,catalog_release_id:''},{code_system:'HCPCS',code:'J0585',description:'Injection, onabotulinumtoxinA, 1 unit',modifiers:'',units:1}]);
assert.equal(added.length,2);assert.ok(!f.rows.includes(f.blank),'a row nobody typed in makes way');
assert.deepEqual(f.inserted.map(h=>JSON.parse(h).line.code),['64616','J0585']);assert.deepEqual(JSON.parse(f.inserted[0]).line.diagnosis_codes,[]);
assert.ok(added.every(row=>row.dataset.diagnosesDefault==='pending'&&row.dataset.priceMemorySeen==='1'),'linked to the encounter diagnoses by default, practice price looked up');
assert.equal(f.priced.length,2);assert.ok(f.saved.includes('autosave')&&f.saved.includes('draft'));
// A table that cannot take lines adds nothing.
const g=fixture({readOnly:true});assert.equal(g.context.chargeLinesAppend([{code:"64616"}]).length,0);assert.equal(g.inserted.length,0);
// A bundle uses the same path and says how many lines it added.
const h=fixture();h.context.chargeBundleApply({name:'Neck visit',lines:[{code_system:'CPT',code:'64616',description:'Synthetic neck injection',modifiers:'RT  LT',units:2}]});
assert.deepEqual({...JSON.parse(h.inserted[0]).line},{diagnosis_codes:[],code_system:'CPT',code:'64616',description:'Synthetic neck injection',modifiers:'RT,LT',units:2});
assert.deepEqual(h.notices,['Added Neck visit: 1 line.']);
console.log('PASS lines added to the open charge table go through one path shared by bundles and code suggestions');
