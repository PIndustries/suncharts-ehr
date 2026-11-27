// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync('web/diagnosis-suggestions.js','utf8');
const endpoint='/api/v1/visits/v1/diagnosis-suggestions';
const firstTime='2026-10-25T14:00:00.000Z',secondTime='2026-10-25T14:01:00.000Z';
const savedNote=(at=firstTime)=>({assessment:'Synthetic assessment',plan:'Synthetic plan',saved_by:{at}});
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function fixture({available=true,role='clinician',canEdit=true,delegated=false,note=savedNote(),status='in_progress',posted=false,charges=true,storage={},version=3}={}){
 const dom=new JSDOM(`<form id="note-form"><textarea name="assessment"></textarea></form><dialog id="codes"><section id="visit-diagnoses"><form id="visit-diagnoses-form"><div data-diagnosis-row><input name="code"></div></form></section>${charges?'<form id="billing-account-form"><input name="code"></form>':''}</dialog><div id="notice"></div>`,{url:'https://suncharts.example.test',runScripts:'outside-only'});
 const w=dom.window,doc=w.document,host=doc.getElementById('visit-diagnoses'),dialog=doc.getElementById('codes');
 const calls=[],added=[],lines=[],notices=[],timers=new Map(),replies=new Map();let timerId=0,requestNumber=0;
 for(const [key,value] of Object.entries(storage))w.sessionStorage.setItem(key,value);
 host.getClientRects=()=>dialog.open?[{}]:[];
 const patient='p1',id='v1';
 Object.assign(w,{selected:patient,me:{role,delegated,tenant_id:'t1',user_id:'u1'},activeVisit:{id,version,status,note},esc,
  $:id=>doc.getElementById(id),encounterChargeAccount:()=>posted?{status:'posted'}:null,
  setTimeout:(fn,delay)=>{const key=++timerId;timers.set(key,{fn,delay});return key;},clearTimeout:key=>timers.delete(key),
  api:async(path,method='GET',body)=>{
   calls.push({method,path,body:body?JSON.parse(JSON.stringify(body)):undefined});
   const reply=replies.get(`${method} ${path}`);
   if(reply instanceof Error)throw reply;
   if(typeof reply==='function')return reply(body);
   if(reply!==undefined)return reply;
   if(path==='/api/v1/ai/local-status')return {available};
   if(method==='POST'){return {request_id:body.request_id,status:'queued',position:0};}
   return {status:'none',request_id:null};
  },
  visitDiagnosisAppendRow:row=>{
   added.push(JSON.parse(JSON.stringify(row)));
   const input=doc.createElement('input');input.name='code';input.value=row.code;w.$('visit-diagnoses-form').append(input);
   return true;
  },
  chargeLinesAppend:rows=>{
   lines.push(...JSON.parse(JSON.stringify(rows)));
   for(const row of rows){const input=doc.createElement('input');input.name='code';input.value=row.code;w.$('billing-account-form').append(input);}
   return rows;
  },
  notice:(message,error)=>notices.push({message,error}),encounterNumberText:data=>data.encounter_number?`ENC-${data.encounter_number}`:'',
  run:fn=>fn(),selectPatient:async()=>{},openPatientEncounter:async()=>{},encounterOpenCodesDialog:()=>{dialog.open=true;}});
 w.crypto.randomUUID=()=>`00000000-0000-4000-8000-${String(++requestNumber).padStart(12,'0')}`;
 w.$('note-form').elements.assessment.value=note?.assessment||'';
 vm.runInContext(source,dom.getInternalVMContext());
 const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
 const mount=async()=>{w.diagnosisSuggestionsMount(host,{version:w.activeVisit.version,can_edit:canEdit},id,patient);await flush();};
 const requests=()=>calls.filter(request=>request.method==='POST'&&request.path===endpoint);
 return {w,host,dialog,calls,added,lines,notices,replies,flush,mount,requests,
  panel:()=>host.querySelector('[data-diagnosis-suggest]'),
  storage:()=>Object.fromEntries(Object.keys(w.sessionStorage).map(key=>[key,w.sessionStorage.getItem(key)])),
  async open(){dialog.open=true;w.diagnosisSuggestCheck();await flush();},
  async poll(reply){replies.set(`GET ${endpoint}`,reply);const next=[...timers.entries()].find(([,entry])=>entry.delay===1500);assert.ok(next,'Expected scheduled suggestion status poll');timers.delete(next[0]);next[1].fn();await flush();},
  edit(value){const input=w.$('note-form').elements.assessment;input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));},
  async save(at=secondTime){w.activeVisit={...w.activeVisit,version:w.activeVisit.version+1,note:{...savedNote(at),assessment:w.$('note-form').elements.assessment.value}};w.diagnosisSuggestCheck();await flush();},
  click(selector){const node=host.querySelector(selector);assert.ok(node,selector);node.click();},
  tick(code,kind='diagnosis'){this.click(`[data-diagnosis-suggest-pick-${kind}="${code}"]`);}};
}
const ready=(id,extra={})=>({request_id:id,status:'ready',note_version:3,note_changed:false,mine:true,patient_id:'p1',encounter_number:5,
 suggestions:[{code:'E11.9',description:'Type 2 diabetes <b>without</b> complications',evidence:'stable on <i>metformin</i>',evidence_found:true,catalog_release_id:'rel1'},{code:'I10',description:'Essential hypertension',evidence_found:false,catalog_release_id:'rel1'}],
 procedures:[{code:'64616',description:'Synthetic procedure',system:'CPT',default_units:1,catalog_release_id:'proc-release'},{code:'J0586',description:'Synthetic supply',system:'HCPCS',quantity:300,quantity_unit:'units',default_units:300,modifiers:'JW, 59',catalog_release_id:'drug-release'}],
 procedures_unmatched:[{service:'Office visit',reason:'level'}],unmatched:[{problem:'Insomnia',evidence:'cannot sleep'}],...extra});
const postId=f=>f.requests().at(-1).body.request_id;
const apply='[data-diagnosis-suggest-add]';
(async()=>{
 for(const options of [{role:'nurse'},{canEdit:false},{delegated:true},{note:null},{status:'cancelled'},{note:{assessment:'  '}}]){
  const f=fixture(options);await f.mount();await f.open();assert.equal(f.calls.length,0);assert.equal(f.panel(),null);
 }
 let f=fixture({available:false});await f.mount();assert.deepEqual(f.calls,[]);await f.open();assert.deepEqual(f.calls.map(c=>c.path),['/api/v1/ai/local-status']);assert.equal(f.panel(),null);
 f=fixture();await f.mount();assert.equal(f.calls.length,0,'closed coding must not contact AI');await f.open();
 assert.equal(f.requests().length,1);assert.deepEqual(Object.keys(f.requests()[0].body),['request_id','visit_version']);assert.equal(f.requests()[0].body.visit_version,3);
 assert.match(f.panel().textContent,/Reading the saved note/);assert.equal(f.added.length+f.lines.length,0);
 await f.mount();await f.open();assert.equal(f.requests().length,1);
 await f.poll({request_id:postId(f),status:'queued',note_version:3,stage:'choose',position:0});assert.match(f.panel().textContent,/Matching codes/);
 await f.poll(ready(postId(f)));
 assert.equal(f.host.querySelector('[data-diagnosis-row]').nextElementSibling,f.panel(),'suggestions are inline beside diagnosis fields');
 assert.equal(f.dialog.querySelectorAll('dialog').length,0);assert.doesNotMatch(f.panel().textContent,/Review and add|Suggest again/);
 assert.match(f.panel().innerHTML,/&lt;b&gt;without&lt;\/b&gt;/);assert.match(f.panel().innerHTML,/&lt;i&gt;metformin&lt;\/i&gt;/);
 assert.match(f.panel().textContent,/300 units given|Office visit · Choose the encounter level/);assert.match(f.panel().textContent,/Insomnia · No matching code/);
 assert.equal(f.panel().querySelector(apply).disabled,true);
 f.tick('E11.9');f.tick('J0586','procedure');
 assert.equal(f.panel().querySelector(apply).textContent,'Add 2 selected');assert.equal(f.added.length+f.lines.length,0);
 f.click(apply);assert.deepEqual(f.added,[{code:'E11.9',display:ready('').suggestions[0].description,catalog_release_id:'rel1'}]);
 assert.deepEqual(f.lines,[{code_system:'HCPCS',code:'J0586',description:'Synthetic supply',modifiers:'JW,59',units:300,catalog_release_id:'drug-release'}]);
 assert.equal(f.panel().querySelector('[data-diagnosis-suggest-pick-diagnosis="E11.9"]'),null);
 assert.ok(f.panel().querySelector('[data-diagnosis-suggest-pick-diagnosis="I10"]'),'unselected codes remain available');
 assert.equal(f.calls.some(call=>call.path.endsWith('/dismiss')),false);
 f.w.activeVisit.version=4;await f.mount();assert.equal(f.requests().length,1,'coding/vitals revisions must not re-request');
 const persisted=f.storage(),originalRequest=postId(f);
 f=fixture({version:4,storage:persisted});f.replies.set(`GET ${endpoint}`,ready(originalRequest,{note_changed:true}));await f.mount();await f.open();
 assert.equal(f.requests().length,0,'opening this note again reuses its known result');assert.ok(f.panel().querySelector('[data-diagnosis-suggest-pick-diagnosis="I10"]'));
 f.tick('I10');f.edit('New draft assessment');await f.flush();assert.match(f.panel().textContent,/Waiting for the note to save/);assert.equal(f.panel().querySelector(apply),null);assert.equal(f.requests().length,0);
 await f.save();assert.equal(f.requests().length,1);assert.equal(f.requests()[0].body.visit_version,5);assert.equal(f.added.length,0);
 await f.mount();assert.equal(f.requests().length,1);

 f=fixture();await f.mount();await f.open();const old=postId(f);f.edit('A new revision pending while the assistant runs');await f.save();
 assert.equal(f.requests().length,1,'wait for the old request instead of sending it again');await f.poll(ready(old,{note_changed:true}));
 assert.equal(f.requests().length,2);assert.equal(f.requests().at(-1).body.visit_version,4);assert.equal(f.panel().querySelector(apply),null);
 await f.poll(ready(postId(f),{note_version:4}));assert.ok(f.panel().querySelector(apply));

 f=fixture();await f.mount();await f.open();await f.poll(ready(postId(f)));f.click('[data-diagnosis-suggest-dismiss]');
 assert.equal(f.panel(),null);await f.open();assert.equal(f.requests().length,1);
 f=fixture({storage:f.storage()});await f.mount();await f.open();assert.equal(f.calls.length,0,'dismissed note stays dismissed across reload');assert.equal(f.panel(),null);
 f.edit('Another note revision');await f.save();assert.equal(f.requests().length,1);

 f=fixture({posted:true});f.replies.set(`GET ${endpoint}`,ready('external'));
 await f.mount();await f.open();assert.match(f.panel().textContent,/billing correction/);assert.equal(f.panel().querySelector('[data-diagnosis-suggest-pick-procedure]'),null);
 assert.ok(f.panel().querySelector('[data-diagnosis-suggest-pick-diagnosis]'));assert.equal(f.requests().length,0);
 f=fixture();f.w.$('billing-account-form').elements.code.value=' 64616 ';f.replies.set(`GET ${endpoint}`,ready('external'));
 await f.mount();await f.open();assert.equal(f.panel().querySelector('[data-diagnosis-suggest-pick-procedure="64616"]'),null);
 f=fixture({charges:false});f.replies.set(`GET ${endpoint}`,ready('external'));await f.mount();await f.open();assert.match(f.panel().textContent,/Open editable charges/);

 f=fixture();f.replies.set(`POST ${endpoint}`,new Error('Temporary connection error'));await f.mount();await f.open();
 assert.equal(f.requests().length,1);assert.match(f.panel().textContent,/Retry suggestions/);await f.open();await f.mount();assert.equal(f.requests().length,1);
 f.replies.delete(`POST ${endpoint}`);f.click('[data-diagnosis-suggest-retry]');await f.flush();assert.equal(f.requests().length,2);
 await f.poll(new Error('Read timed out'));assert.match(f.panel().textContent,/Retry suggestions/);
 f.replies.set(`GET ${endpoint}`,ready(postId(f)));f.click('[data-diagnosis-suggest-retry]');await f.flush();assert.equal(f.requests().length,2);assert.ok(f.panel().querySelector(apply));

 f=fixture();let releaseStatus;
 f.replies.set('GET /api/v1/ai/local-status',()=>new Promise(resolve=>{releaseStatus=resolve;}));await f.mount();
 f.dialog.open=true;f.w.diagnosisSuggestCheck();f.dialog.open=false;releaseStatus({available:true});await f.flush();assert.equal(f.calls.length,1,'closing before AI status prevents note access');
 await f.open();let releaseResult;
 f.replies.set(`GET ${endpoint}`,()=>new Promise(resolve=>{releaseResult=resolve;}));
 f.w.diagnosisSuggestionsEvent('visit.diagnosis_suggestions_ready','v1');
 f.w.selected='p2';f.w.activeVisit={id:'v2',note:savedNote(),version:3,status:'in_progress'};releaseResult(ready(postId(f)));await f.flush();
 assert.equal(f.added.length+f.lines.length,0);assert.doesNotMatch(f.host.textContent,/Type 2 diabetes/);assert.match(f.notices.at(-1).message,/ENC-5/);

 assert.match(fs.readFileSync('web/visit-diagnoses.js','utf8'),/diagnosisSuggestionsMount\(host,data,id,patient\)/);
 assert.match(fs.readFileSync('web/index.html','utf8'),/diagnosis-suggestions\.js/);
 console.log('diagnosis suggestions automatic secure revision and inline approval UI tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
