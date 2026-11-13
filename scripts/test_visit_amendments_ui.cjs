// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic DOM fixtures exercise the real app handlers; no browser or network.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
const decode=value=>String(value||'').replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
function fixture(){
 const nodes=new Map(),listeners=new Map(),windowListeners=new Map(),calls=[];
 const formIds=new Set(['note-form','vitals-form','amendment-form','amendment-draft-status','amendment-review-current','amendment-discard','amendment-submit']);
 let focused=null,scrolls=0;
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  let html='';const classes=new Set();
  const n={id,hidden:false,disabled:false,isConnected:true,dataset:{},value:'',textContent:'',
   classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){if(on??!classes.has(x))classes.add(x);else classes.delete(x);}},
   setAttribute(){},removeAttribute(){},addEventListener(){},replaceChildren(){this.innerHTML='';},querySelector(){return null;},
   focus(){focused=id;},scrollIntoView(){scrolls++;}};
  Object.defineProperty(n,'innerHTML',{get:()=>html,set(value){html=value;if(id==='visit-editor')parseEditor(value);}});
  nodes.set(id,n);return n;
 }
 function parseEditor(html){
  for(const id of formIds){const old=nodes.get(id);if(old)old.isConnected=false;nodes.delete(id);}
  for(const match of html.matchAll(/<form id="([^"]+)"([^>]*)>([\s\S]*?)<\/form>/g)){
   const [,id,attributes,body]=match,form=node(id);form.values={};form.elements={};
   for(const [,key,value]of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g))form.dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=decode(value);
   for(const input of body.matchAll(/<(input|textarea)\b([^>]*\bname="([^"]+)"[^>]*)>([^<]*)/g)){
    const [,tag,attrs,name,text]=input;form.values[name]=tag==='textarea'?decode(text):decode(attrs.match(/value="([^"]*)"/)?.[1]);
    form.elements[name]={get value(){return form.values[name];},set value(value){form.values[name]=value;},focus(){focused=id+':'+name;}};
   }
   form.reset=()=>{for(const key of Object.keys(form.values))form.values[key]='';};
  }
  for(const id of formIds)if(!id.endsWith('-form')&&html.includes(`id="${id}"`))node(id);
 }
 const context=vm.createContext({console,Date,Intl,URL,URLSearchParams,TextEncoder,crypto:{randomUUID:()=> 'synthetic-request'},location:{search:'',hash:'',pathname:'/'},
  FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){yield*Object.entries(this.form.values||{});}},
  document:{getElementById:id=>formIds.has(id)?nodes.get(id)||null:node(id),querySelectorAll:()=>[],addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(callback);}},
  window:{scrollTo(){},addEventListener(type,callback){windowListeners.set(type,callback);}},
  fetch(){throw new Error('Unexpected network request');},billingWrite:()=>true,billingCan:()=>true,canDocument:()=>true,calls,
  localStorage:{setItem(){throw new Error('PHI must not be persisted');}},sessionStorage:{setItem(){throw new Error('PHI must not be persisted');}}
 });
 const run=code=>vm.runInContext(code,context);run(app);
 run(`me={tenant_id:'tenant-1',user_id:'author',role:'owner'};selected='patient-1';
 workspace={appointments:[{id:'appointment-1',title:'Synthetic visit',starts_at:'2026-11-11T12:00:00Z'}],visits:[],amendments:[],clinical:{items:[],reviews:[]},labs:{orders:[],reports:[],acknowledgments:[]},billing:{accounts:[]}};
 activeVisit={id:'visit-1',patient_id:selected,appointment_id:'appointment-1',clinician_id:'author',status:'signed',version:1,signed_at:'2026-11-11T13:00:00Z',note:{subjective:'Frozen S',objective:'Frozen O',assessment:'Frozen A',plan:'Frozen P'}};
 workspace.visits=[activeVisit];renderVisit(false);`);
 function type(reason,text){const f=nodes.get('amendment-form');f.values={reason,text};for(const callback of listeners.get('input')||[])callback({target:{closest:selector=>selector==='#amendment-form'?f:null}});return f;}
 function click(action,extra={}){const button={id:'',type:'button',dataset:{action,...extra},closest:()=>null,hasAttribute:()=>false};for(const callback of listeners.get('click')||[])callback({target:{closest:()=>button}});}
 return {run,context,nodes,calls,type,click,windowListeners,focused:()=>focused,scrolls:()=>scrolls};
}
async function main(){
 let f=fixture(),html=f.nodes.get('visit-editor').innerHTML;
 const note=html.match(/<form id="note-form"[\s\S]*?<\/form>/)[0];
 assert.equal([...note.matchAll(/readonly/g)].length,4);assert.match(html,/Signed note — read-only/);assert.match(html,/Original|original SOAP note and vitals cannot be overwritten/);
 assert.doesNotMatch(html.match(/<form id="amendment-form"[\s\S]*?<\/form>/)[0],/readonly/);
 f.click('focus-amendment');assert.equal(f.focused(),'amendment-form:reason');assert.ok(f.scrolls()>0);
 const form=f.type('Correct transcription','Retained <correction>'),sameForm=f.nodes.get('amendment-form');assert.equal(form,sameForm,'typing never replaces the editor or loses focus');
 f.run('renderVisit(false)');assert.match(f.nodes.get('visit-editor').innerHTML,/Retained &lt;correction&gt;/);assert.equal(f.nodes.get('amendment-form').values.reason,'Correct transcription');
 let prevented=false;f.windowListeners.get('beforeunload')({preventDefault(){prevented=true;}});assert.equal(prevented,true,'unsaved amendment participates in browser-close warning');
 console.log('PASS signed original remains immutable; correction jump focuses input and drafts survive rerender without replacing typing inputs');

 f.run("captureVisitDrafts();selected='patient-2';activeVisit={...activeVisit,id:'visit-2',patient_id:selected};renderVisit(false)");
 assert.equal(f.nodes.get('amendment-form').values.text,'');f.type('Second','Other patient');
 f.run("selected='patient-1';activeVisit={...activeVisit,id:'visit-1',patient_id:selected};renderVisit(false)");
 assert.equal(f.nodes.get('amendment-form').values.text,'Retained <correction>');
 f.run("activeVisit={...activeVisit,id:'visit-3'};renderVisit(false)");assert.equal(f.nodes.get('amendment-form').values.text,'');
 f.run("me={tenant_id:'tenant-2',user_id:'author',role:'owner'};activeVisit={...activeVisit,id:'visit-1'};renderVisit(false)");
 assert.equal(f.nodes.get('amendment-form').values.text,'');assert.equal(f.run('visitAmendmentsHaveDrafts()'),false);
 f.type('Tenant two','Private correction');f.run('me={...me};captureVisitDrafts()');assert.equal(f.run('visitAmendmentsHaveDrafts()'),false,'replacement staff session cannot recapture stale DOM content');
 f.run("activeVisit.clinician_id='other';renderVisit(false)");assert.ok(f.nodes.get('amendment-form'),'the owner or another clinician may correct a colleague’s signed note');assert.match(f.nodes.get('visit-editor').innerHTML,/data-action="focus-amendment"/);
 for(const role of ['nurse','medical_assistant','front_desk','read_only']){
  f.run(`me={...me,role:${JSON.stringify(role)}};renderVisit(false)`);assert.equal(f.nodes.get('amendment-form'),undefined,role);
  assert.doesNotMatch(f.nodes.get('visit-editor').innerHTML,/data-action="focus-amendment"|Only the assigned clinician/,role);assert.match(f.nodes.get('visit-editor').innerHTML,/cannot be overwritten\. A clinician can add a correction\.<\/div>/,role);
 }
 f.run("me={...me,role:'owner',delegated:true};renderVisit(false)");assert.equal(f.nodes.get('amendment-form'),undefined);
 assert.match(f.nodes.get('visit-editor').innerHTML,/cannot be overwritten\. A clinician at the practice must sign any correction\.<\/div>/);assert.doesNotMatch(f.nodes.get('visit-editor').innerHTML,/data-action="focus-amendment"/);
 console.log('PASS drafts remain isolated by tenant, patient, encounter and staff session; any clinician or the owner may correct, support staff and a support session may not');

 f=fixture();f.type('Reason','Correction');f.run('activeVisit={...activeVisit,version:2};renderVisit(false)');
 assert.equal(f.nodes.get('amendment-form').dataset.version,'1');assert.equal(f.nodes.get('amendment-submit').disabled,true);assert.equal(f.nodes.get('amendment-review-current').hidden,false);
 f.context.api=async(...args)=>{f.calls.push(args);return {...f.run('activeVisit'),version:3};};
 await assert.rejects(f.run("submitVisitAmendment($('amendment-form'))"),/Review the changed encounter/);assert.equal(f.calls.length,0);
 f.click('review-amendment-version',{version:'2'});assert.equal(f.nodes.get('amendment-form').dataset.version,'2');assert.equal(f.nodes.get('amendment-submit').disabled,false);assert.equal(f.focused(),'amendment-form:text');
 f.run("selectPatient=async(p,v)=>{calls.push(['reload',p,v]);activeVisit={...activeVisit,version:3};renderVisit(false);}");
 await f.run("submitVisitAmendment($('amendment-form'))");assert.equal(f.calls[0][0],'/api/v1/visits/visit-1/amendments');assert.equal(f.calls[0][3],2);assert.equal(f.run('visitAmendmentsHaveDrafts()'),false);assert.equal(f.nodes.get('amendment-form').values.text,'');assert.match(f.nodes.get('visit-editor').innerHTML,/Frozen S/);
 console.log('PASS stale base version blocks writes until explicit review; confirmed save clears only the submitted draft and retains signed SOAP');

 f=fixture();f.type('Reason','First correction');let resolve;
 f.context.api=()=>new Promise(done=>{resolve=done;});f.run("selectPatient=async(p,v)=>{calls.push(['reload',p,v]);activeVisit={...activeVisit,version:2};renderVisit(false);}");
 let save=f.run("submitVisitAmendment($('amendment-form'))");f.type('Reason','Correction typed during save');resolve({...f.run('activeVisit'),version:2});await save;
 assert.equal(f.nodes.get('amendment-form').values.text,'Correction typed during save');assert.equal(f.nodes.get('amendment-form').dataset.version,'2');assert.equal(f.run('visitAmendmentsHaveDrafts()'),true);
 console.log('PASS typing during an amendment save survives its response with the new confirmed version');

 for(const laterText of [null,'Later correction in replacement form']){
  f=fixture();f.type('Reason','Submitted correction');f.context.api=()=>new Promise(done=>{resolve=done;});
  f.run("selectPatient=async(p,v)=>{calls.push(['reload',p,v]);activeVisit={...activeVisit,version:2};renderVisit(false);}");
  const originalForm=f.nodes.get('amendment-form');save=f.run("submitVisitAmendment($('amendment-form'))");f.run('renderVisit(false)');assert.notEqual(f.nodes.get('amendment-form'),originalForm);
  if(laterText)f.type('Reason',laterText);resolve({...f.run('activeVisit'),version:2});await save;f.run('captureVisitDrafts()');
  assert.equal(f.nodes.get('amendment-form').values.text,laterText||'');assert.equal(f.run('visitAmendmentsHaveDrafts()'),Boolean(laterText));assert.equal(f.nodes.get('amendment-form').dataset.version,'2');
 }
 console.log('PASS replacement form is reconciled after save without resurrecting submitted text or discarding later typing');

 f=fixture();f.type('Reason','First correction');f.context.api=()=>new Promise(done=>{resolve=done;});f.run("selectPatient=async(...args)=>calls.push(['unexpected reload',...args])");
 const original={...f.run('activeVisit'),version:2};save=f.run("submitVisitAmendment($('amendment-form'))");
 f.run("captureVisitDrafts();selected='patient-2';activeVisit={...activeVisit,id:'visit-2',patient_id:selected};renderVisit(false)");f.type('Other','Other patient draft');resolve(original);await save;
 assert.equal(f.calls.length,0);assert.equal(f.nodes.get('amendment-form').values.text,'Other patient draft');assert.equal(f.run('currentAmendmentDraft().values.text'),'Other patient draft');
 console.log('PASS late save response cannot navigate to or overwrite a different patient chart');

 f=fixture();f.type('Reason','Keep this');f.context.confirmAction=()=>new Promise(done=>{resolve=done;});const discard=f.run('discardVisitAmendmentDraft()');
 f.run("captureVisitDrafts();selected='patient-2';activeVisit={...activeVisit,id:'visit-2',patient_id:selected};renderVisit(false)");f.type('Other','Keep other');resolve(true);await discard;
 assert.equal(f.nodes.get('amendment-form').values.text,'Keep other');assert.equal(f.run('visitAmendmentDrafts.size'),2);
 f.context.confirmAction=async()=>true;await f.run('discardVisitAmendmentDraft()');assert.equal(f.nodes.get('amendment-form').values.text,'');assert.equal(f.run('visitAmendmentDrafts.size'),1);
 f.run('clearVisitAmendmentDrafts()');assert.equal(f.run('visitAmendmentsHaveDrafts()'),false);
 console.log('PASS discard confirmation is context-bound and session cleanup removes in-memory drafts');

 f=fixture();f.run("activeVisit.status='in_progress';renderVisit(false)");assert.equal(f.nodes.get('amendment-form'),undefined);const unsigned=f.nodes.get('visit-editor').innerHTML.match(/<form id="note-form"[\s\S]*?<\/form>/)[0];assert.doesNotMatch(unsigned,/readonly/);assert.match(unsigned,/>Save note</);
 console.log('PASS unsigned assigned-owner SOAP remains directly editable');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
