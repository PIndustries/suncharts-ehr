// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic fixtures drive the real vitals form code from web/app.js: every box is optional,
// submit sends only the boxes with a value (an empty box is never sent and never 0), drafts
// treat an empty box as the same thing as a missing saved value, and a partial record renders
// no placeholder anywhere. The server's refusals (nothing entered, half a blood pressure) are
// kept from the API. No browser, no network. Synthetic data only.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8');
const vitalsKeys=['systolic_mm_hg','diastolic_mm_hg','heart_rate_bpm','temperature_c','weight_kg','height_cm','oxygen_saturation_pct'];
const noteKeys=['subjective','objective','assessment','plan','procedure','started_from'];
const decode=value=>String(value??'').replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
function fixture(vitals){
 const nodes={},listeners={},requests=[],notices=[];
 function node(id){
  if(nodes[id])return nodes[id];
  let html='';
  const n={id,hidden:true,isConnected:true,disabled:false,dataset:{},values:{},textContent:'',innerHTML:'',open:false,
   classList:{add(){},remove(){},toggle(){},contains:()=>false},setAttribute(){},removeAttribute(){},addEventListener(){},focus(){},scrollIntoView(){},querySelector:()=>null,closest:()=>null};
  Object.defineProperty(n,'innerHTML',{get:()=>html,set(value){html=value;if(id==='visit-editor')parse(value);}});
  nodes[id]=n;return n;
 }
 function parse(html){
  for(const [id,old] of Object.entries(nodes))if(id!=='visit-editor'&&id.endsWith('-form'))old.isConnected=false;
  for(const match of html.matchAll(/<form id="([^"]+)"([^>]*)>([\s\S]*?)<\/form>/g)){
   const [,id,attributes,body]=match,form=node(id);form.values={};form.elements={};form.inputAttributes={};
   for(const [,key,value] of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g))form.dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=decode(value);
   for(const input of body.matchAll(/<(input|textarea)\b([^>]*\bname="([^"]+)"[^>]*)>([^<]*)/g)){
    const [,tag,attrs,name,text]=input;
    form.inputAttributes[name]=attrs;
    form.values[name]=tag==='textarea'?decode(text):decode(attrs.match(/value="([^"]*)"/)?.[1]??'');
    form.elements[name]={get value(){return form.values[name];},set value(value){form.values[name]=value;}};
   }
  }
 }
 const state=()=>({visit:vm.runInContext('activeVisit',context)});
 const sandbox={state,console,Object,Array,Number,Boolean,String,JSON,Map,Set,Math,Date,parseInt,parseFloat,isNaN,
  document:{addEventListener(type,callback){(listeners[type]??=[]).push(callback);},querySelectorAll:()=>[],documentElement:{classList:{add(){},remove(){}}}},
  window:{addEventListener(){},SunChartsDialog:{restoreFocus(){}}},
  $:id=>nodes[id]||node(id),
  esc:value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
  date:value=>String(value??''),displayStatus:value=>String(value??''),displayDate:value=>String(value??''),displayCount:(n,word)=>`${n} ${word}`,
  notice:(message,error)=>notices.push({message,error:!!error}),
  formData:form=>({...form.values}),
  FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){yield*Object.entries(this.form.values||{});}},
  api:async(path,method,body,version)=>{
   requests.push({path,method,body,version});
   if(method==='PUT'&&/\/vitals$/.test(path)){
    if(!Object.keys(body).length){const error=Error('Enter at least one measurement.');error.status=400;throw error;}
    if(body.systolic_mm_hg===undefined!==(body.diastolic_mm_hg===undefined)){const error=Error('Enter both blood pressure numbers, or neither.');error.status=400;throw error;}
    return {...state().visit,vitals:{...body},version:state().visit.version+1};
   }
   return {...state().visit,version:state().visit.version+1};
  }};
 sandbox.globalThis=sandbox;
 sandbox.api=new Proxy(sandbox.api,{apply(target,_,args){return Reflect.apply(target,sandbox,args);}});
 const context=vm.createContext(sandbox);
 const extract=(startText,endText)=>{const start=app.indexOf(startText),end=app.indexOf(endText,start);assert.ok(start>=0&&end>start,'anchor moved: '+startText);return app.slice(start,end);};
 vm.runInContext(extract('const visitDrafts=new Map();','function captureVisitAmendmentDraft'),context);
 vm.runInContext(extract('function captureVisitDrafts(includeRooming=true){','function followUnchangedNote'),context);
 vm.runInContext(extract('function followUnchangedNote(){','function updateDraftStatus()'),context);
 vm.runInContext(extract('function updateDraftStatus(){','// The saved note, read-only'),context);
 vm.runInContext(extract('function isRoomingStaff()','function renderHistory()'),context);
 vm.runInContext(`clinicalAccess=()=>'edit';canDocument=()=>true;`,context);
 vm.runInContext(extract('function rememberVisit(','document.addEventListener(\'submit\''),context);
 vm.runInContext(extract('async function run(action) {','async function enter() {'),context);
 vm.runInContext(extract("document.addEventListener('submit',e=>{","document.addEventListener('click'"),context);
 vm.runInContext('run=globalThis.run;',context);
 vm.runInContext(`captureVisitAmendmentDraft=()=>{};currentAmendmentDraft=()=>null;updateVisitAmendmentStatus=()=>{};visitNoteAuthorshipLine=()=>'';visitNoteSignedLine=()=>'Signed';visitNoteAmendmentAuthor=()=>'';visitNoteSaved=()=>{};renderVisitNoteSource=()=>{};renderRooming=()=>{};renderVisitDiagnoses=()=>{};renderVisitCheckout=()=>{};refreshEncounterProgress=()=>{};setEncounterSection=()=>{};encounterSections=()=>['vitals'];renderPatients=()=>{};renderChart=()=>{};renderEncounterOrderActions=()=>{};revenueServiceDate=()=>null;applyChartSection=()=>{};encounterSection='documentation';chartSection='visits';visitNoteOwnsDiagnoses=()=>true;chartAreaEnabled=()=>true;encounterShows=()=>true;noteSavedText=n=>n||{};noteSaverName=()=>null;showVisitNoteAuthorship=()=>{};patientBannerChanged=()=>{};`,context);
 const run=code=>vm.runInContext(code,context);
 for(const id of ['visit-editor','visit-draft-status','note-conflict','note-saved-copy','note-message','notice','shell-loading','login-error'])node(id);
 run(`me={tenant_id:'tenant-1',user_id:'nurse-1',role:'nurse'};selected='patient-1';busy=false;
  workspace={patient:{id:'patient-1'},appointments:[{id:'appt-1',title:'Office visit',starts_at:'2026-11-17T14:00:00Z',status:'checked_in'}],visits:[],amendments:[],clinical:{items:[]},labs:{orders:[],reports:[],acknowledgments:[]}};
  activeVisit={id:'visit-1',patient_id:selected,appointment_id:'appt-1',clinician_id:'clinician-1',status:'in_progress',version:3,note:null,vitals:${JSON.stringify(vitals)}};
  workspace.visits=[activeVisit];renderVisit(false);
 document.addEventListener('input',e=>{if(e.target.closest?.('#note-form,#vitals-form'))captureVisitDrafts();});`);
 const settle=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));};
 async function submit(){for(const callback of listeners.submit||[]){const started=callback({target:nodes['vitals-form'],preventDefault(){}});if(started&&typeof started.then==='function')await Promise.resolve(started).catch(()=>{});}await settle();}
 const vitalsForm=()=>nodes['vitals-form'],editor=()=>nodes['visit-editor'].innerHTML;
 function type(values){Object.assign(vitalsForm().values,values);for(const callback of listeners.input||[])callback({target:{closest:selector=>selector.includes('#vitals-form')?vitalsForm():null}});}
 return {context,run,nodes,requests,notices,vitalsForm,editor,type,submit,
  vitalsHtml:()=>{const html=editor();return html.slice(html.indexOf('id="vitals-form"'),html.indexOf('</form>',html.indexOf('id="vitals-form"')));}};
}
// Temperature, weight and height are typed in US units (°F, lb, in) and kept in metric.
const typed={systolic_mm_hg:120,diastolic_mm_hg:80,heart_rate_bpm:72,temperature_c:98.6,weight_kg:154,height_cm:69,oxygen_saturation_pct:98};
const full={systolic_mm_hg:120,diastolic_mm_hg:80,heart_rate_bpm:72,temperature_c:37,weight_kg:69.85,height_cm:175.3,oxygen_saturation_pct:98};
async function main(){
 // Every box is optional and an unmeasured box renders empty, never a placeholder.
 let f=fixture({heart_rate_bpm:72});
 for(const key of vitalsKeys){
  assert.ok(f.vitalsForm().inputAttributes[key],`${key} renders`);
  assert.doesNotMatch(f.vitalsForm().inputAttributes[key],/\brequired\b/,`${key} is not required`);
  assert.equal(f.vitalsForm().values[key],key==='heart_rate_bpm'?'72':'',`${key} shows the saved value or an empty box`);
 }
 assert.doesNotMatch(f.vitalsHtml(),/required/,'no vitals input carries required');
 assert.match(f.vitalsHtml(),/Save vitals/);
 assert.doesNotMatch(f.editor(),/value="(undefined|null|NaN)"/,'no box shows undefined, null or NaN');
 console.log('PASS every vitals box is optional and unmeasured boxes render empty');

 // Only a pulse, saved with nothing else, stores exactly one measurement.
 f=fixture({});
 f.type({heart_rate_bpm:'72'});
 await f.submit();
 const put=f.requests.find(r=>r.method==='PUT');
 assert.deepEqual(put.body,{heart_rate_bpm:72},'only the filled box is sent, as a number');
 assert.equal('weight_kg' in put.body,false,'an empty box is never sent, not even as 0');
 assert.equal(put.version,3,'the save carries the form version');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(activeVisit.vitals)')),{heart_rate_bpm:72},'the saved record carries only the measured key');
 f.run('renderVisit(false)');
 assert.deepEqual(Object.entries(f.vitalsForm().values).filter(([key,value])=>value!=='').map(([key,value])=>[key,Number(value)]),[['heart_rate_bpm',72]],'the re-rendered form shows only the pulse');
 assert.doesNotMatch(f.editor(),/NaN|undefined|null/,'a partial record renders no placeholder');
 console.log('PASS saving only a pulse sends one measurement and renders without placeholders');

 // All seven still save and read back identically.
 f=fixture({});
 f.type(Object.fromEntries(Object.entries(typed).map(([key,value])=>[key,String(value)])));
 await f.submit();
 assert.deepEqual(f.requests.find(r=>r.method==='PUT').body,full,'a full record is sent in metric');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(activeVisit.vitals)')),full,'all seven read back unchanged');
 f.run('renderVisit(false)');
 for(const [key,value] of Object.entries(typed))assert.equal(f.vitalsForm().values[key],String(value),`${key} comes back as it was typed`);
 console.log('PASS all seven measurements still save and read back identically');

 // Half a blood pressure is refused by the server and keeps the typed value on screen.
 f=fixture({});
 f.type({systolic_mm_hg:'120'});
 await f.submit();
 assert.equal(f.requests.length,1,'the save was attempted once');
 assert.deepEqual(f.requests[0].body,{systolic_mm_hg:120},'half a blood pressure is sent as typed, without invented zeros');
 assert.equal(f.notices.at(-1).message,'Enter both blood pressure numbers, or neither.','staff see the plain reason');
 assert.equal(JSON.parse(f.run('JSON.stringify(activeVisit.vitals)')||'{}').heart_rate_bpm,undefined,'nothing was stored');
 assert.equal(f.vitalsForm().values.systolic_mm_hg,'120','the typed number stays for correction');
 console.log('PASS blood pressure with one number is refused with plain wording');

 // Nothing entered is refused with plain wording.
 f=fixture({heart_rate_bpm:72});
 f.run('renderVisit(false)');
 f.type({heart_rate_bpm:''});
 await f.submit();
 assert.equal(f.requests.length,0,'an empty form sends nothing at all');
 assert.equal(f.notices.at(-1).message,'Enter at least one measurement.','an empty save says what is needed');
 assert.deepEqual(JSON.parse(f.run('JSON.stringify(activeVisit.vitals)')),{heart_rate_bpm:72},'the earlier record is untouched');
 console.log('PASS a save with no values is refused with plain wording');

 // Drafts: an empty box equals a missing saved value; any difference is an unsaved edit.
 f=fixture({heart_rate_bpm:72});
 assert.equal(f.run('visitDrafts.size'),0,'a form matching the saved record is clean');
 f.type({temperature_c:''});
 assert.equal(f.run('visitDrafts.size'),0,'an empty box against a missing saved value is still clean');
 f.type({temperature_c:'37.1'});
 assert.equal(f.run("visitDrafts.get('visit-1').vitals.values.temperature_c"),'37.1','a new measurement is an unsaved edit');
 f.type({heart_rate_bpm:''});
 assert.equal(f.run("visitDrafts.get('visit-1').vitals.values.heart_rate_bpm"),'','clearing a saved measurement is an unsaved edit');
 assert.match(f.nodes['visit-draft-status'].textContent,/Unsaved vitals edits/);
 f.run('JSON.stringify(visitDrafts.get("visit-1"))');
 f.type({heart_rate_bpm:'72',temperature_c:''});
 assert.equal(f.run('visitDrafts.size'),0,'edits back to the saved record are clean again');
 assert.equal(f.nodes['visit-draft-status'].textContent,'','the status line clears with it');
 console.log('PASS vitals drafts treat an empty box as the same thing as a missing value');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
