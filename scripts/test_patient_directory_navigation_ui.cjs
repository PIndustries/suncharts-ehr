// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8');
function extract(start,end){const a=app.indexOf(start),b=app.indexOf(end,a);assert(a>=0&&b>a);return app.slice(a,b);}
function fixture(){
 const nodes=new Map(),calls=[],drafts=new Map();
 const node=id=>{if(!nodes.has(id)){const classes=new Set();nodes.set(id,{id,hidden:false,innerHTML:'',value:'',attributes:{},classList:{toggle(name,force){const has=force===undefined?!classes.has(name):force;if(has)classes.add(name);else classes.delete(name);return has;},contains:name=>classes.has(name)},setAttribute(name,value){this.attributes[name]=value;},replaceChildren(){this.innerHTML='';},focus(){this.focused=true;}});}return nodes.get(id);};
 const ctx={console,Map,Set,Promise,me:{tenant_id:'tenant',user_id:'staff',role:'clinician'},selected:'patient-a',activeVisit:{id:'visit-a',patient_id:'patient-a',status:'in_progress'},workspace:{patient:{id:'patient-a'},visits:[{id:'visit-a',patient_id:'patient-a',status:'in_progress'},{id:'visit-complete',patient_id:'patient-a',status:'signed'}]},patients:[],cursor:null,formText:'SYNTHETIC UNSAVED NOTE',$:node,
  captureVisitDrafts(){calls.push(['capture',ctx.selected,ctx.activeVisit?.id]);if(ctx.activeVisit&&ctx.formText)drafts.set(ctx.activeVisit.id,ctx.formText);},
  showTool(title){calls.push(['tool',title]);node('clinical-workspace').hidden=true;},canRegisterPatient:()=>true,workspaceResourceAllowed:()=>true,isRoomingStaff:()=>false,
  renderPatients(){calls.push(['patients',ctx.selected]);},renderChart(){calls.push(['chart',ctx.selected,ctx.activeVisit?.id]);},
  rememberVisit(visit){ctx.activeVisit=visit;ctx.workspace.visits=ctx.workspace.visits.map(row=>row.id===visit.id?visit:row);calls.push(['remember',visit.id]);},
  api:async(path,method='GET')=>{calls.push([method,path]);if(path==='/api/v1/patients')return {items:[{id:'patient-a'}],next_cursor:null};if(path.endsWith('/workspace'))return {patient:{id:path.split('/')[4]},visits:[{id:'visit-a',patient_id:'patient-a',status:'in_progress'}],appointments:[]};if(path.startsWith('/api/v1/visits/'))return {id:path.split('/').at(-1),patient_id:'patient-a',status:'signed'};return {items:[]};}
 };
 vm.createContext(ctx);
 vm.runInContext(extract("let chartSection='overview'",'// Unsaved clinical edits'),ctx);
 vm.runInContext(extract('async function selectPatient(','\nconst date ='),ctx);
 vm.runInContext(extract('async function showClinical(','\nconst scopeNames='),ctx);
 return {ctx,node,calls,drafts,evaluate:code=>vm.runInContext(code,ctx)};
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
function tabFixture(){
 const {JSDOM}=require('jsdom');
 const dom=new JSDOM('<button id="nav-clinical">Patients</button><div id="frame-patient-tabs"></div><section id="clinical-workspace"><div id="chart"></div></section><div id="tools"></div><div id="notice"></div><form id="patient-form"></form><button id="toggle-directory"></button>',{runScripts:'outside-only'});
 const w=dom.window,calls=[],held=new Map(),drafts=new Map();
 const node=id=>w.document.getElementById(id);
 const patient=id=>({id,family_name:'Synthetic',given_name:id});
 const reply=path=>path.endsWith('/workspace')?{patient:patient(path.split('/')[4]),visits:[{id:'visit-'+path.split('/')[4],status:'in_progress'}]}:{items:[]};
 Object.assign(w,{$:node,esc:s=>String(s??''),me:{user_id:'staff'},selected:null,workspace:null,activeVisit:null,chartHeadingFocusPending:null,frameClinicalFocus:'problem',billingPayers:[],chartAreaEnabled:()=>true,workspaceResourceAllowed:()=>true,
  setPage:Object.assign(()=>{},{last:'Patients & encounters'}),chartCloseSheets(){},renderPatients(){},
  captureVisitDrafts(){const form=node('draft');if(form&&w.activeVisit)drafts.set(w.activeVisit.id,form.value);},
  renderChart(){node('chart').innerHTML='<h2>'+w.selected+'</h2><textarea id="draft"></textarea>';node('draft').value=drafts.get(w.activeVisit?.id)||'';},
  api(path){calls.push(path);return held.get(path)?.promise||Promise.resolve(reply(path));}
 });
 const context=dom.getInternalVMContext();
 vm.runInContext(extract("let chartSection='overview'",'// Unsaved clinical edits'),context);
 vm.runInContext(extract('async function selectPatient(','\nconst date ='),context);
 vm.runInContext(extract('let framePatients=[];','function frameBillingMonitorNavigation'),context);
 function hold(path){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  held.set(path,{promise});
  return {complete(){held.delete(path);resolve(reply(path));},fail(){held.delete(path);reject(new Error('Synthetic chart read failed'));}};
 }
 for(const id of ['A','B','C'])w.frameOpenPatient(patient(id));
 return {w,dom,node,hold,calls};
}
test('rapid tab changes share in-flight reads, immediately hide the old chart, and preserve the patient’s draft',async()=>{
 const {w,dom,node,hold,calls}=tabFixture();
 try{
  await w.frameSelectPatient('A');
  node('draft').value='Synthetic note for A';
  w.eval("chartSection='visits';encounterSection='files';");
  const path='/api/v1/patients/B/workspace',gate=hold(path);
  const first=w.frameSelectPatient('B');
  assert.equal(w.frameSelectPatient('B'),first,'duplicate click joins the same selection');
  assert.equal(w.selected,undefined);
  assert.equal(w.document.querySelector('[aria-current="page"]').dataset.framePatient,'B');
  assert.equal(node('chart').getAttribute('aria-busy'),'true');
  assert.equal(node('draft'),null);
  const ignored=w.frameSelectPatient('C');
  const latest=w.frameSelectPatient('B');
  await first;await ignored;
  gate.complete();await latest;
  assert.equal(calls.filter(call=>call===path).length,1);
  assert.equal(w.selected,'B');assert.equal(node('draft').value,'');
  const settled=calls.length;await w.frameSelectPatient('B');assert.equal(calls.length,settled);
  await w.frameSelectPatient('A');
  assert.equal(node('draft').value,'Synthetic note for A');
  assert.equal(w.activeVisit.id,'visit-A');
  assert.equal(w.eval('chartSection'),'visits');assert.equal(w.eval('encounterSection'),'files');
  assert(!calls.includes('/api/v1/patients'));
 }finally{dom.window.close();}
});
test('closing a pending tab retires late related errors, and a visible failure offers a read-only retry',async()=>{
 const {w,dom,node,hold}=tabFixture();
 try{
  await w.frameSelectPatient('A');
  const related=hold('/api/v1/patients/B/orders');
  const pending=w.frameSelectPatient('B');
  await new Promise(resolve=>setImmediate(resolve));
  await w.frameClosePatient('B');related.fail();await pending;
  assert.equal(w.selected,'A','closing returns to the most recently viewed remaining chart');assert.equal(node('chart').querySelector('[role="alert"]'),null);
  assert.equal(w.document.querySelector('[data-frame-patient="B"]'),null);
  const read=hold('/api/v1/patients/C/workspace'),failed=w.frameSelectPatient('C');
  read.fail();await assert.rejects(failed,/Synthetic chart read failed/);
  assert.equal(w.selected,undefined);assert.equal(node('draft'),null);assert.equal(node('chart').hasAttribute('aria-busy'),false);
  assert.equal(node('chart').querySelector('[data-frame-retry]').dataset.frameRetry,'C');
  await w.frameSelectPatient('C');assert.equal(w.selected,'C');
 }finally{dom.window.close();}
});
test('tab restoration rechecks role access and retires old-session chart reads at sign-out',async()=>{
 const {w,dom,node,hold,calls}=tabFixture();
 try{
  await w.frameSelectPatient('A');w.eval("chartSection='billing';");
  await w.frameSelectPatient('B');
  w.workspaceResourceAllowed=resource=>resource!=='billing';
  const start=calls.length;await w.frameSelectPatient('A');
  assert.equal(w.eval('chartSection'),'overview');
  assert(!calls.slice(start).some(path=>path.includes('billing')||path.endsWith('/history')));
  const read=hold('/api/v1/patients/B/workspace'),old=w.frameSelectPatient('B');
  w.clearFramePatients();w.me={user_id:'another-staff'};
  read.complete();await old;
  assert.equal(w.selected,undefined);assert.equal(w.workspace,undefined);assert.equal(node('frame-patient-tabs').textContent,'');
 }finally{dom.window.close();}
});
test('Patients clears selection after capturing drafts and displays the expanded directory',async()=>{
 const f=fixture(),c=f.ctx;f.evaluate('setPatientDirectoryVisible(false)');assert.equal(f.node('toggle-directory').textContent,'Show patients');
 await c.showClinical();assert.equal(c.selected,undefined);assert.equal(c.activeVisit,undefined);assert.equal(c.workspace,undefined);assert.equal(f.drafts.get('visit-a'),'SYNTHETIC UNSAVED NOTE');
 assert.equal(f.node('clinical-workspace').hidden,false);assert.equal(f.node('clinical-workspace').classList.contains('directory-collapsed'),false);assert.equal(f.node('toggle-directory').textContent,'Hide patients');assert.equal(f.node('toggle-directory').attributes['aria-expanded'],'true');assert.equal(f.node('search').focused,true);assert.match(f.node('chart').innerHTML,/Choose a patient/);assert.equal(f.calls[0][0],'capture');assert(!f.calls.some(([method])=>['POST','PUT','DELETE'].includes(method)));
});
test('an open chart keeps the patient list on the Patients page',async()=>{
 const f=fixture();await f.ctx.selectPatient('patient-a');assert.equal(f.node('clinical-workspace').classList.contains('directory-collapsed'),true);assert.equal(f.node('toggle-directory').textContent,'Show patients');assert.equal(f.node('toggle-directory').attributes['aria-expanded'],'false');
 f.evaluate('setPatientDirectoryVisible(false)');await f.ctx.selectPatient('patient-a');assert.equal(f.node('toggle-directory').textContent,'Show patients');assert.equal(f.node('toggle-directory').attributes['aria-expanded'],'false');f.evaluate('setPatientDirectoryVisible(true)');assert.equal(f.node('toggle-directory').textContent,'Show patients');
});
test('a late patient load cannot overwrite a newer directory navigation',async()=>{
 const f=fixture(),normal=f.ctx.api;let resolve;f.ctx.api=async(path,...args)=>path.endsWith('/workspace')?new Promise(r=>resolve=r):normal(path,...args);
 const pending=f.ctx.selectPatient('patient-a');await f.ctx.showClinical();resolve({patient:{id:'patient-a'},visits:[]});await pending;
 assert.equal(f.ctx.selected,undefined);assert.equal(f.ctx.workspace,undefined);assert(!f.calls.some(([kind])=>kind==='chart'));
});
test('a stale directory response cannot replace a newly opened patient',async()=>{
 const f=fixture(),normal=f.ctx.api;let resolve;f.ctx.api=async(path,...args)=>path==='/api/v1/patients'?new Promise(r=>resolve=r):normal(path,...args);
 const pending=f.ctx.showClinical();await f.ctx.selectPatient('patient-a');const patientList=f.ctx.patients;resolve({items:[{id:'stale'}]});await pending;assert.equal(f.ctx.selected,'patient-a');assert.equal(f.ctx.patients,patientList);
});
test('completed encounter opens by exact patient-bound ID using only a read and preserves earlier drafts',async()=>{
 const f=fixture();await f.ctx.openPatientEncounter('visit-complete');assert.deepEqual(f.calls.filter(([method])=>method==='GET'),[['GET','/api/v1/visits/visit-complete']]);assert.equal(f.ctx.activeVisit.id,'visit-complete');assert.equal(f.ctx.activeVisit.status,'signed');assert.equal(f.drafts.get('visit-a'),'SYNTHETIC UNSAVED NOTE');assert.equal(f.evaluate('chartSection'),'visits');assert.equal(f.evaluate('encounterSection'),'visit');assert(!f.calls.some(([method])=>['POST','PUT','DELETE'].includes(method)));
});
test('encounter selection rejects foreign IDs and mismatched provider responses',async()=>{
 const f=fixture();await assert.rejects(f.ctx.openPatientEncounter('foreign-visit'),/this patient’s history/);assert(!f.calls.some(([method])=>method==='GET'));
 f.ctx.api=async()=>({id:'visit-complete',patient_id:'patient-b',status:'signed'});await assert.rejects(f.ctx.openPatientEncounter('visit-complete'),/does not belong/);assert.equal(f.ctx.activeVisit.id,'visit-a');
});
test('late encounter response cannot publish after directory navigation or account change',async()=>{
 for(const next of ['directory','identity']){const f=fixture(),normal=f.ctx.api;let resolve;f.ctx.api=async(path,...args)=>path.startsWith('/api/v1/visits/')?new Promise(r=>resolve=r):normal(path,...args);const pending=f.ctx.openPatientEncounter('visit-complete');if(next==='directory')await f.ctx.showClinical();else f.ctx.me={tenant_id:'another',user_id:'another'};resolve({id:'visit-complete',patient_id:'patient-a',status:'signed'});await pending;assert(!f.calls.some(([kind])=>kind==='remember'));}
});
(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+error.stack);}}if(failed)process.exitCode=1;})();
