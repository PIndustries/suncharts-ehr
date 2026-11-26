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
// The appointment snapshot only offers missing codes for this patient and encounter.
{
 const source=fs.readFileSync('web/patient-revenue.js','utf8');
 const diagnoses=[{code:'Z00.00'}],lines=[{code_system:'CPT',code:'99213',modifiers:'25,95'}];
 const type={id:'t1',version:4,name:'Synthetic visit',diagnoses:[{code:'Z00.00'},{code:'M54.2',description:'Synthetic symptom'}],
  procedures:[{code_system:'CPT',code:'99213',modifiers:'95 25'},{code_system:'HCPCS',code:'A1234',description:'Synthetic service',units:2,modifiers:''}]};
 const actor={},visit={id:'v1',appointment_id:'a1',status:'in_progress'},appointment={id:'a1',patient_id:'p1',visit_type:type};
 const dxForm={dataset:{visitId:'v1'},querySelector:()=>true};
 const chargeForm={dataset:{},elements:{visit_id:{value:'v1'}}},state={};
 const checked=new Set(['dx-1']),account={status:'draft'};
 const dialog={open:true,isConnected:true,dataset:{patient:'p1',visit:'v1'},codesAccount:actor,
  querySelector:sel=>({'#visit-diagnoses-form':dxForm,'#billing-account-form':chargeForm,'[data-codes-editor-state]':state})[sel],
  querySelectorAll:()=>[...checked].map(value=>({value}))};
 const c=vm.createContext({me:actor,selected:'p1',chartSection:'visits',activeVisit:visit,workspace:{appointments:[appointment]},
  encounterChargeAccount:()=>account,chargeLiveRows:()=>lines,chargeRowValue:row=>row,visitDiagnosisFormValues:()=>({diagnoses}),
  chargeLinesAppend:items=>{lines.push(...items);return items;},visitDiagnosisAppendRow:item=>{diagnoses.push(item);return true;}});
 vm.runInContext(source.slice(source.indexOf('function encounterCodesDialogCurrent('),source.indexOf('function encounterOpenCodesDialog(')),c);
 c.encounterTemplateCodesPaint=()=>{};
 const choices=()=>Array.from(c.encounterTemplateCodeChoices(dialog)?.choices||[],choice=>choice.key);
 assert.deepEqual(choices(),['dx-1','service-1']);
 assert.equal(diagnoses.length,1);assert.equal(lines.length,1);
 c.encounterApplyTemplateCodes(dialog);
 assert.deepEqual(choices(),['service-1']);assert.equal(lines.length,1,'unchecked service stays a suggestion');
 checked.add('service-1');c.encounterApplyTemplateCodes(dialog);c.encounterApplyTemplateCodes(dialog);
 assert.deepEqual(lines.map(l=>l.code),['99213','A1234']);assert.equal(lines[1].units,2);
 lines.pop();account.status='posted';assert.deepEqual(choices(),[]);
 account.status='draft';appointment.patient_id='p2';assert.deepEqual(choices(),[]);
 appointment.patient_id='p1';visit.status='signed';assert.deepEqual(choices(),[]);
}
console.log('PASS lines added to the open charge table go through one path shared by bundles and code suggestions');
