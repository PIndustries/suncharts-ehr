// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// An open chart gives the screen to the visit: the patient list is hidden by default
// (and the device remembers otherwise), and Archive sits in the Patient record menu.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),app=fs.readFileSync(path.join(root,'web/app.js'),'utf8'),lifecycle=fs.readFileSync(path.join(root,'web/patient-lifecycle.js'),'utf8'),style=fs.readFileSync(path.join(root,'web/style.css'),'utf8');
function extract(start,end){const a=app.indexOf(start),b=app.indexOf(end,a);assert(a>=0&&b>a,start);return app.slice(a,b);}
function nodes(){
 const all=new Map();
 const node=id=>{if(!all.has(id)){const classes=new Set();all.set(id,{id,hidden:false,open:false,innerHTML:'',textContent:'',attributes:{},classList:{toggle(name,force){const on=force===undefined?!classes.has(name):Boolean(force);if(on)classes.add(name);else classes.delete(name);return on;},contains:name=>classes.has(name)},setAttribute(name,value){this.attributes[name]=value;},hasAttribute(name){return name in this.attributes;},querySelector(){return null;},querySelectorAll(){return [];},scrollIntoView(){this.scrolled=true;},focus(){this.focused=true;},replaceChildren(){this.innerHTML='';}});}return all.get(id);};
 return {all,node};
}
function directory(storage){
 const {node}=nodes();
 const ctx={console,Map,Set,Promise,me:{tenant_id:'tenant',user_id:'staff',role:'clinician'},selected:undefined,activeVisit:undefined,workspace:undefined,patients:[],cursor:null,$:node,
  captureVisitDrafts(){},showTool(){node('clinical-workspace').hidden=true;},canRegisterPatient:()=>true,workspaceResourceAllowed:()=>true,isRoomingStaff:()=>false,renderPatients(){},renderChart(){},
  api:async path=>path.endsWith('/workspace')?{patient:{id:path.split('/')[4]},visits:[],appointments:[]}:{items:[],next_cursor:null}};
 if(storage)ctx.localStorage=storage;
 vm.createContext(ctx);
 vm.runInContext(extract("let chartSection='overview'",'// Unsaved clinical edits'),ctx);
 vm.runInContext(extract('async function selectPatient(','\nconst date ='),ctx);
 vm.runInContext(extract('async function showClinical()','\nconst scopeNames='),ctx);
 // The header button, exactly as the click handler runs it.
 const handler=/if\(button\.id==='toggle-directory'\)\{([^\n]*?)return;\}/.exec(app);assert(handler,'the patient list toggle handler exists');
 ctx.toggle=()=>vm.runInContext(`(()=>{${handler[1]}})()`,ctx);
 return {ctx,node};
}
const memory=()=>{const values=new Map();return {values,getItem:key=>values.has(key)?values.get(key):null,setItem(key,value){values.set(key,String(value));}};};
const collapsed=f=>f.node('clinical-workspace').classList.contains('directory-collapsed');
(async()=>{
 // Default: the list shows while choosing a patient and hides once a chart is open.
 const store=memory();let f=directory(store);
 await f.ctx.showClinical();assert.equal(collapsed(f),false,'the list is shown while choosing a patient');
 await f.ctx.selectPatient('patient-a');assert.equal(collapsed(f),true,'an open chart hides the list by default');
 assert.equal(f.node('toggle-directory').textContent,'Show patients');assert.equal(f.node('toggle-directory').attributes['aria-expanded'],'false');
 assert.equal(store.values.size,0,'opening a chart stores nothing by itself');
 // The toggle shows it, and that choice is remembered on this device.
 f.ctx.toggle();assert.equal(collapsed(f),false);assert.equal(f.node('toggle-directory').textContent,'Hide patients');
 assert.deepEqual([...store.values],[['suncharts.patientDirectory.besideChart','shown']]);
 await f.ctx.selectPatient('patient-b');assert.equal(collapsed(f),false,'the next chart keeps the list because the user asked for it');
 f=directory(store);await f.ctx.selectPatient('patient-a');assert.equal(collapsed(f),false,'a new session on the same device remembers the choice');
 f.ctx.toggle();assert.equal(collapsed(f),true);assert.equal(store.values.get('suncharts.patientDirectory.besideChart'),'hidden');
 f=directory(store);await f.ctx.selectPatient('patient-a');assert.equal(collapsed(f),true,'hiding is remembered too');
 // Toggling before any chart is open changes the view but not the remembered choice.
 f=directory(store);await f.ctx.showClinical();f.ctx.toggle();assert.equal(collapsed(f),true);assert.equal(store.values.get('suncharts.patientDirectory.besideChart'),'hidden');
 const untouched=memory();f=directory(untouched);await f.ctx.showClinical();f.ctx.toggle();f.ctx.toggle();assert.equal(untouched.values.size,0);
 // Storage that is missing or blocked never breaks the chart.
 f=directory(null);await f.ctx.selectPatient('patient-a');assert.equal(collapsed(f),true);f.ctx.toggle();assert.equal(collapsed(f),false);await f.ctx.selectPatient('patient-b');assert.equal(collapsed(f),false,'the choice still holds for this session');
 const blocked={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
 f=directory(blocked);await f.ctx.selectPatient('patient-a');assert.equal(collapsed(f),true);assert.doesNotThrow(()=>f.ctx.toggle());assert.equal(collapsed(f),false);

 // Archive: out of the main flow, one click away in the Patient record menu.
 const {node}=nodes(),chart=vm.createContext({console,Map,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),$:node,selected:'patient-a',me:{user_id:'owner',role:'owner'},workspace:{patient:{id:'patient-a',archived:false}},patients:[],cursor:null,activeVisit:undefined,chartSection:'overview',encounterSection:'documentation',patientLifecycleRevealed:false,
  chartAreaEnabled:()=>true,encounterSections:()=>[['documentation','Notes']],document:{addEventListener(){},querySelectorAll:()=>[]},URLSearchParams});
 vm.runInContext(extract('function patientSectionVisible(','function chartNavigation('),chart);
 vm.runInContext(extract('function chartNavigation(','function patientWorkflowActions('),chart);
 vm.runInContext(extract('function revealPatientLifecycle(','function renderChart()'),chart);
 vm.runInContext(lifecycle,chart);
 const tabs=[['overview','Summary'],['profile','Patient details'],['visits','Encounters']];
 const menu=vm.runInContext(`chartNavigation(${JSON.stringify(tabs)})`,chart);
 assert.match(menu,/<details class="patient-record-navigation" id="patient-record-navigation"><summary>Patient record<\/summary>/);
 assert.match(menu,/<button type="button" id="chart-archive-entry" data-patient-lifecycle-show hidden>Archive this patient<\/button><\/div><\/details>/,'the entry waits, hidden, until the server says this person may archive');
 const bare=vm.runInContext("chartNavigation([['overview','Summary'],['visits','Encounters']])",chart);
 assert.match(bare,/id="patient-record-navigation" data-archive-only hidden>/);assert.match(bare,/id="chart-archive-entry"/,'Archive stays reachable when every record tab is switched off');
 assert.match(app,/<section id="patient-lifecycle" class="panel" hidden><\/section>/,'the archive panel starts out of the main flow');
 // Hidden until asked for.
 const panel=node('patient-lifecycle'),details={open:false},focused={focus(){this.done=true;}};
 panel.querySelector=selector=>selector==='details'?details:selector==='summary,button'?focused:null;
 vm.runInContext('applyChartSection()',chart);assert.equal(panel.hidden,true);
 // The same control with the same confirmation, shown only to people who can use it.
 const state={patient_id:'patient-a',archived:false,can_manage:true,version:1,history:[]};chart.state=state;
 vm.runInContext('showPatientLifecycle(state)',chart);
 assert.equal(node('chart-archive-entry').hidden,false,'an owner sees the entry');
 assert.match(panel.innerHTML,/<summary>Archive this patient<\/summary>/);assert.match(panel.innerHTML,/data-patient-lifecycle-open>Archive patient…<\/button>/);
 chart.state={...state,can_manage:false};vm.runInContext('showPatientLifecycle(state)',chart);assert.equal(node('chart-archive-entry').hidden,true,'staff who cannot archive are not offered it');
 chart.state=state;vm.runInContext('showPatientLifecycle(state)',chart);
 node('patient-record-navigation').open=true;
 vm.runInContext('revealPatientLifecycle()',chart);
 assert.equal(panel.hidden,false,'choosing the entry shows the archive panel');assert.equal(details.open,true);assert.equal(panel.scrolled,true);assert.equal(focused.done,true);assert.equal(node('patient-record-navigation').open,false);
 vm.runInContext("patientLifecycleDrafts.set('patient-a',{reason:'',confirmed:false,archived:true,version:1});showPatientLifecycle(state)",chart);
 assert.match(panel.innerHTML,/I confirm that I want to archive this patient chart\./);assert.match(panel.innerHTML,/<button type="submit" >Archive patient<\/button>/);
 // An archived chart always shows its restore control.
 chart.patientLifecycleRevealed=false;vm.runInContext('patientLifecycleRevealed=false;workspace.patient.archived=true;applyChartSection()',chart);assert.equal(panel.hidden,false);
 vm.runInContext('workspace.patient.archived=false;applyChartSection()',chart);assert.equal(panel.hidden,true);
 assert.match(app,/if\(button\.hasAttribute\('data-patient-lifecycle-show'\)\)\{revealPatientLifecycle\(\);return;\}/);
 // The step row and the note stay on screen: the encounter band is one row and its tabs do not scroll sideways.
 assert.match(style,/#encounter-progress \.encounter-step-tabs\{overflow-x:visible\}/);
 assert.match(style,/\.encounter-workspace-heading \.eyebrow\{display:none\}/);
 console.log('PASS patient list default, remembered toggle and reachable Archive');
})().catch(error=>{console.error(error);process.exit(1);});
