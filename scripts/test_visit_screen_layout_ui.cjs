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

 // Archive: out of the main flow, one click away in the patient banner's More menu. It lives in one place only.
 const {node}=nodes(),chart=vm.createContext({console,Map,Date,Intl,esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),$:node,selected:'patient-a',me:{user_id:'owner',role:'owner'},workspace:{patient:{id:'patient-a',mrn:'SYN-1',given_name:'Avery',family_name:'Synthetic',birth_date:'1990-01-01',archived:false},appointments:[],visits:[],clinical:{items:[],reviews:[]},billing:{coverages:[]},demographics:{content:{}}},patients:[],cursor:null,activeVisit:undefined,chartSection:'overview',encounterSection:'documentation',
  chartAreaEnabled:()=>true,encounterSections:()=>[['documentation','Notes']],document:{addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null},URLSearchParams});
 vm.runInContext(extract('function patientSectionVisible(','function chartNavigation('),chart);
 vm.runInContext(extract('function chartNavigation(','function patientWorkflowActions('),chart);
 vm.runInContext(fs.readFileSync(path.join(root,'web/display-format.js'),'utf8'),chart);
 vm.runInContext(lifecycle,chart);vm.runInContext(fs.readFileSync(path.join(root,'web/patient-banner.js'),'utf8'),chart);
 const tabs=[['overview','Summary'],['profile','Patient details'],['visits','Encounters']];
 const menu=vm.runInContext(`chartNavigation(${JSON.stringify(tabs)})`,chart);
 assert.match(menu,/<details class="patient-record-navigation" id="patient-record-navigation"><summary>Patient record<\/summary>/);
 assert.doesNotMatch(menu,/Archive/,'the Patient record menu no longer carries a second Archive entry');
 assert.doesNotMatch(app,/chart-archive-entry|data-patient-lifecycle-show|revealPatientLifecycle|patientLifecycleRevealed/);assert.doesNotMatch(style,/chart-archive-entry/);
 assert.match(app,/<section id="patient-lifecycle" class="panel" hidden><\/section>/,'the archive panel starts out of the main flow');
 const more=()=>{const html=vm.runInContext('patientBannerMarkup()',chart);return html.slice(html.indexOf('class="patient-banner-menu"'));};
 // Hidden until asked for, and offered only once the server says this person may archive.
 const panel=node('patient-lifecycle');panel.hidden=true;
 assert.doesNotMatch(more(),/Archive/,'not offered before the server has answered');
 // The same control with the same confirmation, shown only to people who can use it.
 const state={patient_id:'patient-a',archived:false,can_manage:true,version:1,history:[]};chart.state=state;
 vm.runInContext("patientLifecycleStates.set('patient-a',state);showPatientLifecycle(state)",chart);
 assert.match(more(),/<button type="button" role="menuitem" class="patient-banner-danger" data-patient-lifecycle-open>Archive this patient…<\/button>/,'someone who may archive reaches it from More, with every record tab switched on or off');
 assert.equal(panel.hidden,true,'nothing is added to the chart until Archive is chosen');assert.equal(panel.innerHTML,'');
 chart.state={...state,can_manage:false};vm.runInContext("patientLifecycleStates.set('patient-a',state);showPatientLifecycle(state)",chart);assert.doesNotMatch(more(),/Archive/,'staff who cannot archive are not offered it');
 chart.state=state;vm.runInContext("patientLifecycleStates.set('patient-a',state);showPatientLifecycle(state)",chart);
 // Choosing it (the existing data-patient-lifecycle-open handler starts the draft) shows the same form and confirmation.
 assert.match(lifecycle,/\[data-patient-lifecycle-open\],\[data-patient-lifecycle-cancel\]/);
 vm.runInContext("patientLifecycleDrafts.set('patient-a',{reason:'',confirmed:false,archived:true,version:1});showPatientLifecycle(state)",chart);
 assert.equal(panel.hidden,false,'choosing the entry shows the archive panel');
 assert.match(panel.innerHTML,/I confirm that I want to archive this patient chart\./);assert.match(panel.innerHTML,/<button type="submit" >Archive patient<\/button>/);
 vm.runInContext("patientLifecycleDrafts.clear();showPatientLifecycle(state)",chart);assert.equal(panel.hidden,true,'cancelling puts it away again');
 // An archived chart always shows its restore control, and is not offered Archive again.
 chart.state={...state,archived:true,version:2};vm.runInContext("workspace.patient.archived=true;patientLifecycleStates.set('patient-a',state);showPatientLifecycle(state)",chart);assert.equal(panel.hidden,false);assert.match(panel.innerHTML,/Restore patient…/);assert.doesNotMatch(more(),/Archive this patient/);
 // The step row and the note stay on screen: the encounter band is one row and its tabs do not scroll sideways.
 assert.match(style,/#encounter-progress \.encounter-step-tabs\{overflow-x:visible\}/);
 assert.match(style,/\.encounter-workspace-heading \.eyebrow\{display:none\}/);
 console.log('PASS patient list default, remembered toggle and reachable Archive');
})().catch(error=>{console.error(error);process.exit(1);});
