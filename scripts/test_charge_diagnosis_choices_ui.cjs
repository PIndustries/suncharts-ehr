// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
const handlers={},nodes={},rows=[],ctx={console,selected:'patient',me:{role:'owner'},workspace:{billing:{coverages:[]}},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:id=>nodes[id],esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),human:v=>v,notice(){},run:fn=>fn()};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);let captured=0;ctx.captureBillingChargeDraft=()=>captured++;
const form={dataset:{patient:'patient'},elements:{visit_id:{value:'visit-a'}},querySelectorAll:()=>rows};nodes['billing-account-form']=form;
const field={value:'MANUAL'},host={innerHTML:''},row={querySelector:selector=>selector==='[name="diagnoses"]'?field:host};rows.push(row);
const diagnoses=[{id:'d1',code:'G24.3',display:'Synthetic diagnosis A'},{id:'d2',code:'G25.9',display:'Synthetic diagnosis B'}];
const change=(code,checked)=>{const target={dataset:{chargeDiagnosis:code},checked,hasAttribute:name=>name==='data-charge-diagnosis',closest:selector=>selector==='#billing-account-form'?form:selector==='.billing-charge-row'?row:null};handlers.change.forEach(fn=>fn({target}));};
(async()=>{
 ctx.api=async()=>({version:4,diagnoses});await ctx.loadChargeEncounterDiagnoses(form);
 assert.match(host.innerHTML,/G24.3/);assert.match(host.innerHTML,/Synthetic diagnosis B/);assert.doesNotMatch(host.innerHTML,/ checked/,'new procedures must not automatically assert diagnosis associations');assert.equal(field.value,'MANUAL');
 change('G24.3',true);assert.equal(field.value,'MANUAL, G24.3');change('G24.3',true);assert.equal(field.value,'MANUAL, G24.3','selection cannot duplicate existing code');change('G25.9',true);assert.equal(field.value,'MANUAL, G24.3, G25.9');change('G24.3',false);assert.equal(field.value,'MANUAL, G25.9');assert.ok(captured>=4);
 form.dataset.draftReadOnly='true';ctx.renderChargeEncounterDiagnoses(form);assert.match(host.innerHTML,/data-charge-diagnosis="G24.3" disabled/);change('G24.3',true);assert.equal(field.value,'MANUAL, G25.9');delete form.dataset.draftReadOnly;
 const newHost={innerHTML:''};rows.push({querySelector:selector=>selector==='[name="diagnoses"]'?{value:''}:newHost});ctx.renderChargeEncounterDiagnoses(form);assert.match(newHost.innerHTML,/G24.3/);assert.doesNotMatch(newHost.innerHTML,/ checked/);
 let resolve;ctx.api=()=>new Promise(r=>resolve=r);const old=ctx.loadChargeEncounterDiagnoses(form);form.elements.visit_id.value='visit-b';ctx.api=async()=>({version:1,diagnoses:[{code:'Z00.00',display:'Visit B saved diagnosis'}]});await ctx.loadChargeEncounterDiagnoses(form);resolve({version:5,diagnoses});await old;assert.match(host.innerHTML,/Visit B/);assert.doesNotMatch(host.innerHTML,/G24.3/,'late prior-visit data cannot publish into a different encounter');
 ctx.api=()=>new Promise(r=>resolve=r);const foreign=ctx.loadChargeEncounterDiagnoses(form);ctx.me={role:'owner'};host.innerHTML='NEW SESSION';resolve({diagnoses});await foreign;assert.equal(host.innerHTML,'NEW SESSION');
 ctx.api=async()=>{throw Error('synthetic error')};await ctx.loadChargeEncounterDiagnoses(form);assert.match(host.innerHTML,/could not be loaded/);assert.equal(field.value,'MANUAL, G25.9','failed history never clears entered codes');
 ctx.workspace.billing.coverages=[{id:'s',content:{priority:'secondary',payer_id:'s',member_id:'SYN-S',status:'active',effective_date:'2026-01-01'}},{id:'expired',content:{priority:'primary',payer_id:'old',status:'active',effective_date:'2025-01-01',end_date:'2025-12-31'}},{id:'p',content:{priority:'primary',payer_id:'p',member_id:'SYN-P',status:'active',effective_date:'2026-01-01'}}];vm.runInContext("billingPayers=[{id:'s',content:{name:'Synthetic secondary'}},{id:'p',content:{name:'Synthetic primary'}}]",ctx);
 const coverage=ctx.billingCoverageOrderMarkup('2026-10-25','p');assert.ok(coverage.indexOf('Synthetic primary')<coverage.indexOf('Synthetic secondary'));assert.doesNotMatch(coverage,/expired/);assert.match(coverage,/do not add another charge line or account/);assert.match(coverage,/crossover/);
 let linkedMarkup;ctx.openBillingEditor=html=>linkedMarkup=html;ctx.accountEditor({id:'linked',diagnosis_snapshot:{visit_version:3,lines:[]}});assert.match(linkedMarkup,/Review \/ clear diagnosis links/);assert.doesNotMatch(linkedMarkup,/<form/);
 {
  // A brand-new line starts with the visit's diagnoses selected, once; nothing already entered is touched.
  const mk=(value,pending=true)=>{const f={value},h={innerHTML:''};return {f,h,row:{dataset:pending?{diagnosesDefault:'pending'}:{},querySelector:selector=>selector==='[name="diagnoses"]'?f:h}};};
  const fresh=mk(''),typed=mk('M62.838'),saved=mk('',false),many=Array.from({length:14},(_,i)=>({id:'m'+i,code:'G80.'+String(i).padStart(2,'0'),display:'Synthetic '+i}));
  const form2={dataset:{patient:'patient'},elements:{visit_id:{value:'visit-a'}},querySelectorAll:()=>[fresh.row,typed.row,saved.row]};
  nodes['billing-account-form']=form2;  ctx.selected='patient';ctx.api=async()=>({version:5,diagnoses});const before=captured;await ctx.loadChargeEncounterDiagnoses(form2);
  assert.equal(fresh.f.value,'G24.3, G25.9');assert.match(fresh.h.innerHTML,/data-charge-diagnosis="G24.3"  checked/);assert.match(fresh.h.innerHTML,/The diagnoses from this visit are ticked for you\. Untick any that do not apply\./);
  assert.equal(typed.f.value,'M62.838','codes already entered are kept');assert.equal(saved.f.value,'','a saved line with no codes is not filled in');assert.ok(captured>before);
  fresh.f.value='';ctx.renderChargeEncounterDiagnoses(form2);assert.equal(fresh.f.value,'','unticking everything is respected');
  const capped=mk('');form2.querySelectorAll=()=>[capped.row];ctx.api=async()=>({version:6,diagnoses:many});await ctx.loadChargeEncounterDiagnoses(form2);assert.equal(capped.f.value.split(', ').length,12);
  const locked=mk('');form2.querySelectorAll=()=>[locked.row];form2.dataset.draftReadOnly='true';await ctx.loadChargeEncounterDiagnoses(form2);assert.equal(locked.f.value,'','a read-only draft is not changed');
  assert.match(ctx.chargeRow(),/data-diagnoses-default="pending"/);assert.doesNotMatch(ctx.chargeRow({code:'99214',amount_cents:16981,diagnosis_codes:[]}),/data-diagnoses-default/);assert.doesNotMatch(ctx.chargeRow({diagnosis_codes:['G81.14']}),/data-diagnoses-default/);
 }
 console.log('PASS reviewed inline encounter diagnosis reuse, manual-code preservation, no default association, stale visit/session isolation, and ordered multiple coverage without duplicated charges');
})().catch(error=>{console.error(error);process.exitCode=1;});
