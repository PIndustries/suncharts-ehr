// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const sources={order:fs.readFileSync('web/labs.js','utf8'),account:fs.readFileSync('web/billing.js','utf8')};
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(kind){
 const handlers={},host={innerHTML:'',scrollIntoView(){},replaceChildren(){this.innerHTML='';}};
 const dx={version:7,diagnoses:[{id:'d1',code:'Z00.00',display:'<script>unsafe</script>',rank:1},{id:'d2',code:'R51.9',display:'Synthetic headache',rank:2}]};
 const order={id:'o1',visit_id:'v1',status:'draft',version:3,diagnosis_snapshot:{visit_id:'v1',visit_version:5,diagnoses:[dx.diagnoses[1]]}};
 const account={id:'a1',status:'draft',version:4,content:{visit_id:'v1',lines:[{code:'99213',description:'Synthetic <b>visit</b>',diagnosis_codes:['Z99.9']}]},diagnosis_snapshot:{visit_id:'v1',visit_version:5,lines:[{line_index:0,diagnoses:[dx.diagnoses[1]]}]}};
 const context=vm.createContext({console,Map,Set,selected:'p1',me:{user_id:'u1',role:'clinician'},workspace:{labs:{orders:[order]},billing:{accounts:[account]}},activeVisit:{id:'v1'},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:(id)=>['lab-editor','billing-editor'].includes(id)?host:context.currentForm?.id===id?context.currentForm:null,esc,human:s=>s,api:async(path)=>path.endsWith('/orders')?{orders:[order]}:path.endsWith('/billing')?{accounts:[account]}:dx,canDocument:()=>true,FormData:class{constructor(form){this.form=form;}get(key){return this.form.values[key];}},run:fn=>context.pending=fn(),notice:()=>{},window:{confirm:()=>true},selectPatient:async()=>{},showChartSection:()=>{}});
 vm.runInContext(sources[kind],context);
 if(kind==='order')vm.runInContext("labSelected='o1'",context);else vm.runInContext("billingSelected='a1'",context);
 context.openBillingEditor=html=>{host.innerHTML=html;};
 return {context,host,dx,order,account,handlers,run:code=>vm.runInContext(code,context),submit(form){form.classList={contains:()=>false};context.currentForm=form;for(const fn of handlers.submit)fn({target:form,preventDefault(){}});return context.pending;}};
}
(async()=>{
 let f=fixture('order');await f.run('editOrderDiagnosisLinks()');assert.match(f.host.innerHTML,/&lt;script&gt;unsafe/);assert.doesNotMatch(f.host.innerHTML,/<script>/);assert.match(f.host.innerHTML,/value="d2" checked/);assert.match(f.host.innerHTML,/data-version="3" data-visit-version="7"/);assert.match(f.host.innerHTML,/no selections clears/);console.log('PASS order link editor escapes diagnoses and keeps explicit frozen/current version context');
 f=fixture('account');await f.run('editAccountDiagnosisLinks()');assert.match(f.host.innerHTML,/Z99.9/);assert.match(f.host.innerHTML,/existing manual and previously added codes are retained/i);assert.match(f.host.innerHTML,/value="d2" checked/);assert.match(f.host.innerHTML,/Synthetic &lt;b&gt;visit/);assert.match(f.host.innerHTML,/clears provenance links only/);console.log('PASS charge editor preserves manual-code context and requires explicit line selection');
 for(const kind of ['order','account']){
  f=fixture(kind);let finish;f.context.api=path=>path.includes('/visits/')?new Promise(resolve=>finish=resolve):Promise.resolve(kind==='order'?{orders:[f.order]}:{accounts:[f.account]});const pending=f.run(kind==='order'?'editOrderDiagnosisLinks()':'editAccountDiagnosisLinks()');f.context.selected='p2';f.host.innerHTML='Other chart';finish(f.dx);await pending;assert.equal(f.host.innerHTML,'Other chart');
 }console.log('PASS stale diagnosis reads cannot render into another patient chart');
 for(const kind of ['order','account']){
  f=fixture(kind);if(kind==='order')f.order.status='placed';else f.account.status='posted';await f.run(kind==='order'?'editOrderDiagnosisLinks()':'editAccountDiagnosisLinks()');assert.equal(f.host.innerHTML,'');
 }console.log('PASS placed orders and posted accounts have no editable link workflow');
 f=fixture('order');let captured;f.context.api=async(...args)=>{captured=args;return {};};let form={id:'order-diagnoses-form',dataset:{patient:'p1',order:'o1',version:'3',visitVersion:'7'},values:{reason:'Explicit selection'},querySelectorAll:()=>[{value:'d2'}]};await f.submit(form);assert.equal(captured[0],'/api/v1/patients/p1/orders/o1/diagnoses');assert.equal(captured[1],'PUT');assert.equal(captured[3],3);assert.deepEqual(JSON.parse(JSON.stringify(captured[2])),{visit_version:7,diagnosis_ids:['d2'],reason:'Explicit selection'});console.log('PASS order saves submit reviewed IDs with resource and encounter versions');
 f=fixture('account');f.context.api=async(...args)=>{captured=args;return {};};form={id:'account-diagnoses-form',dataset:{patient:'p1',account:'a1',version:'4',visitVersion:'7'},values:{reason:'Explicit charge selection'},querySelectorAll:()=>[{dataset:{diagnosisLine:'0'},querySelectorAll:()=>[{value:'d1'}]}]};await f.submit(form);assert.equal(captured[3],4);assert.deepEqual(JSON.parse(JSON.stringify(captured[2])),{visit_version:7,lines:[{line_index:0,diagnosis_ids:['d1']}],reason:'Explicit charge selection'});console.log('PASS charge saves select individual line IDs without replacing manual code fields');
 for(const kind of ['order','account']){
  f=fixture(kind);f.context.api=async()=>{throw new Error('Visit changed; review current diagnoses');};form=kind==='order'?{id:'order-diagnoses-form',dataset:{patient:'p1',order:'o1',version:'3',visitVersion:'7'},values:{reason:'Keep edit'},querySelectorAll:()=>[{value:'d2'}]}:{id:'account-diagnoses-form',dataset:{patient:'p1',account:'a1',version:'4',visitVersion:'7'},values:{reason:'Keep edit'},querySelectorAll:()=>[]};f.host.innerHTML='Reviewed unsaved selection';await assert.rejects(f.submit(form),/Visit changed/);assert.equal(f.host.innerHTML,'Reviewed unsaved selection');
 }console.log('PASS failed/conflicting link saves retain selections for explicit review');
 for(const kind of ['order','account']){
  f=fixture(kind);let finish,refreshes=0;
  const form=kind==='order'?{id:'order-diagnoses-form',dataset:{patient:'p1',order:'o1',version:'3',visitVersion:'7'},values:{reason:'Submitted reason'},querySelectorAll:()=>[{value:'d2'}]}:{id:'account-diagnoses-form',dataset:{patient:'p1',account:'a1',version:'4',visitVersion:'7'},values:{reason:'Submitted reason'},querySelectorAll:()=>[{dataset:{diagnosisLine:'0'},querySelectorAll:()=>[{value:'d2'}]}]};
  f.context.currentForm=form;f.context.testForm=form;
  f.run(kind==='order'?"orderDiagnosisLinkBaselines.set(testForm,JSON.stringify({...orderDiagnosisLinkValues(testForm),reason:''}))":"accountDiagnosisLinkBaselines.set(testForm,JSON.stringify({...accountDiagnosisLinkValues(testForm),reason:''}))");
  f.context.api=()=>new Promise(resolve=>finish=resolve);f.context.selectPatient=async()=>{refreshes++;};
  const saving=f.submit(form);form.values.reason='New typing during save';f.run(kind==='order'?'captureOrderDiagnosisLinkDraft()':'captureAccountDiagnosisLinkDraft()');finish({});await saving;
  assert.equal(refreshes,0);assert.equal(f.run(kind==='order'?"orderDiagnosisLinkDrafts.get('p1:o1').values.reason":"accountDiagnosisLinkDrafts.get('p1:a1').values.reason"),'New typing during save');
 }console.log('PASS typing during a save remains unsaved without rebuilding either editor');
 for(const kind of ['order','account']){
  f=fixture(kind);f.run(kind==='order'?"orderDiagnosisLinkDrafts.set('p1:o1',{patient:'p1',order:'o1',version:2,values:{visit_version:5,diagnosis_ids:['d2'],reason:'Keep draft'}})":"accountDiagnosisLinkDrafts.set('p1:a1',{patient:'p1',account:'a1',version:2,values:{visit_version:5,lines:[{line_index:0,diagnosis_ids:['d2']}],reason:'Keep draft'}})");
  await f.run(kind==='order'?'editOrderDiagnosisLinks()':'editAccountDiagnosisLinks()');assert.match(f.host.innerHTML,/Unsaved selections retained/);assert.match(f.host.innerHTML,/Keep available selections against current versions/);assert.match(f.host.innerHTML,/<button type="submit" disabled>/);assert.match(f.host.innerHTML,/value="Keep draft"/);
  f.context.selected='p2';assert.equal(f.run(kind==='order'?"orderDiagnosisEditorMarkup(workspace.labs.orders[0],{version:7,diagnoses:[]},'p2')":"accountDiagnosisEditorMarkup(workspace.billing.accounts[0],{version:7,diagnoses:[]},'p2')").includes('Keep draft'),false);
 }console.log('PASS navigation restores patient-isolated drafts and stale versions require explicit comparison');
 for(const kind of ['order','account']){
  f=fixture(kind);const entity=kind==='order'?f.order:f.account;entity.status=kind==='order'?'placed':'posted';const snapshot=JSON.stringify(entity.diagnosis_snapshot);
  f.run(kind==='order'?"orderDiagnosisLinkDrafts.set('p1:o1',{values:{visit_version:5,diagnosis_ids:['d2'],reason:'Retained <draft>'}})":"accountDiagnosisLinkDrafts.set('p1:a1',{values:{visit_version:5,lines:[{line_index:0,diagnosis_ids:['d2']}],reason:'Retained <draft>'}})");
  const html=f.run(kind==='order'?'orderDiagnosisDraftRecovery(workspace.labs.orders[0])':'accountDiagnosisDraftRecovery(workspace.billing.accounts[0])');assert.match(html,/not part of this finalized/);assert.match(html,/<textarea readonly>/);assert.match(html,/Retained &lt;draft/);assert.match(html,/Discard unapplied/);
  f.context.showOrder=()=>{};f.context.showBillingAccount=()=>{};
  const button={dataset:kind==='order'?{discardOrderLinkDraft:'o1'}:{discardAccountLinkDraft:'a1'}};
  for(const handler of f.handlers.click)handler({target:{closest:selector=>selector===(kind==='order'?'[data-discard-order-link-draft]':'[data-discard-account-link-draft]')?button:null},preventDefault(){}});
  assert.equal(f.run(kind==='order'?'orderDiagnosisLinkDrafts.size':'accountDiagnosisLinkDrafts.size'),0);assert.equal(JSON.stringify(entity.diagnosis_snapshot),snapshot);
 }console.log('PASS remotely finalized records expose copy/discard recovery without changing saved links');
 for(const kind of ['order','account']){
  f=fixture(kind);const entity=kind==='order'?f.order:f.account,finalized={...entity,status:kind==='order'?'placed':'posted'};
  f.run(kind==='order'?"orderDiagnosisLinkDrafts.set('p1:o1',{values:{reason:'Retain unsigned order selection'}})":"accountDiagnosisLinkDrafts.set('p1:a1',{values:{reason:'Retain unsigned charge selection'}})");
  f.context.api=async path=>path.includes('/visits/')?f.dx:kind==='order'?{orders:[finalized]}:{accounts:[finalized]};
  await f.run(kind==='order'?'editOrderDiagnosisLinks()':'editAccountDiagnosisLinks()');assert.match(f.host.innerHTML,/View\/copy unapplied/);assert.doesNotMatch(f.host.innerHTML,/<form/);
 }console.log('PASS a finalization discovered during reload replaces editing with safe draft recovery');


})();
