// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Reuse the existing Sun browser fixture without running its separate suite.
const fixture=fs.readFileSync('scripts/test_sun_assistant_ui.cjs','utf8');
const foundation=vm.createContext({require,console});
vm.runInContext(fixture.slice(0,fixture.indexOf('\n(async()=>{')),foundation);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const observed=new Date(Date.now()-500).toISOString();
function snapshot(total=17){return {observed_at:observed,practice_timezone:'America/Chicago',timezone_source:'practice_booking_settings',source:'native_local_database',capabilities:['patients.count'],facts:{patients:{total,scope:'all_local_patient_records',definition:'All local patient records, not active or unique people.'}},unavailable:[{tool:'appointments.today.count',reason:'scheduling.read is unavailable'}]};}
function element(tag='div'){
 const classes=new Set();return {tagName:tag.toUpperCase(),children:[],dataset:{},textContent:'',hidden:false,classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},setAttribute(){},append(...children){this.children.push(...children);},replaceChildren(...children){this.textContent='';this.children=[...children];},querySelector(){return null;}};
}
function text(node){return [node?.textContent||'',...(node?.children||[]).map(text)].join(' ');}
function buttons(node){return [...(node.children||[]).filter(child=>child.tagName==='BUTTON'),...(node.children||[]).flatMap(buttons)];}
function harness(){
 const h=vm.runInContext('harness()',foundation);
 h.context.document.createElement=element;
 Object.assign(h.nodes['sun-answer'],element());h.nodes['sun-answer'].hidden=true;
 h.nodes['sun-settings']={open:true};h.context.selected='patient-a';h.nodes['sun-text'].value='How many patients do we have?';
 return h;
}
function preview(body){return {id:'preview-context',expires_at:new Date(Date.now()+900000).toISOString(),requires_approval:true,integration_id:body.integration_id,purpose:body.purpose,provider:'erebine',model:'synthetic-model',instruction:body.instruction,source_text:body.source_text,redaction_count:0,identifier_types:[],warnings:[]};}
const tick=()=>new Promise(setImmediate);

(async()=>{
 let h=harness();
 for(const question of ['How many patients do we have?','How many patients?','How many patient records?','Could you tell me how many patients do we have in our EHR?','What is the total number of patients in this practice?','patient count','Sun, please count all patients','what is our total patient count?','How many patient records are there in this practice right now?']){
  assert.equal(h.run(`sunLocalIntent(${JSON.stringify(question)})`),'patients.count',question);
 }
 for(const question of ['how many patients with diabetes','how many patients do we have with diabetes','patient count last month','how many patients did we register last month','how many patients does Dr Smith have','how many patients do we have in another clinic','how many patients in another clinic','how many active patients do we have','how many patients are assigned to me','how many patients under 18','patient count and today\'s appointments','how many patients do we have? send me their names']){
  assert.equal(h.run(`sunLocalIntent(${JSON.stringify(question)})`),null,question);
 }
 const raw=snapshot();raw.tenant_id='must-stay-local';raw.patient_ids=['must-stay-local'];raw.capabilities.push('arbitrary.query');raw.facts.patients.identifiers=['must-stay-local'];raw.facts.billing={balance:'must-stay-local'};h.context.raw=raw;
 const safe=h.run('sunContextFacts(raw)');assert.equal(safe.facts.patients.total,17);assert.equal(safe.observed_at,observed);assert.equal(safe.facts.appointments,undefined);assert.equal(safe.facts.workflows,undefined);assert.ok(safe.unavailable.some(item=>item.tool==='appointments.today.count'));assert.ok(safe.unavailable.some(item=>item.tool==='workflows.count'));assert.doesNotMatch(JSON.stringify(safe),/must-stay-local|arbitrary.query|balance/);
 for(const invalid of [-1,1.5,'17',null,Number.MAX_SAFE_INTEGER+1]){h.context.raw=snapshot(invalid);assert.throws(()=>h.run('sunContextFacts(raw)'),/invalid aggregate count/);}
 h.context.raw={...snapshot(),facts:{}};const unavailable=h.run('sunContextFacts(raw)');assert.equal(unavailable.facts.patients,undefined);assert.ok(unavailable.unavailable.some(item=>item.tool==='patients.count'));

 // An authoritative local answer works without any AI provider connection.
 h=harness();h.run('sunConnections=[]');h.nodes['sun-provider'].value='';h.setReply(async path=>{assert.equal(path,'/api/v1/sun/context');return snapshot();});await h.run('sunSend()');
 assert.equal(h.calls.length,1);assert.equal(h.nodes['sun-settings'].open,false,'local responses collapse settings');assert.equal(h.nodes['sun-answer'].dataset.origin,'local');assert.match(text(h.nodes['sun-answer']),/17 patient records in this practice/);assert.match(text(h.nodes['sun-answer']),/As of/);assert.match(text(h.nodes['sun-answer']),/not an active-patient, date-filtered, or assigned-clinician count/);
 const refresh=buttons(h.nodes['sun-answer']).find(button=>button.textContent==='Refresh');assert.ok(refresh);h.nodes['sun-text'].value='A different question';refresh.onclick();await tick();assert.equal(h.calls.length,1,'stale local-answer Refresh cannot replay an old question');

 h=harness();h.run('sunConnections=[]');h.nodes['sun-provider'].value='';h.setReply(async()=>({...snapshot(),facts:{},capabilities:[]}));await h.run('sunSend()');assert.match(text(h.nodes['sun-answer']),/Patient count is unavailable/);assert.doesNotMatch(text(h.nodes['sun-answer']),/0 patient/);assert.equal(h.calls.length,1);

 // Unsupported filters go through the reviewed model path with captured,
 // scope-labelled facts, never the direct unfiltered-count answer.
 h=harness();h.nodes['sun-text'].value='How many patients with diabetes?';h.setReply(async(path,method,body)=>path==='/api/v1/sun/context'?snapshot():preview(body));await h.run('sunSend()');
 assert.deepEqual(Array.from(h.calls,call=>call.path),['/api/v1/sun/context','/api/v1/ai/privacy/preview','/api/v1/ai/drafts']);const body=h.calls[1].body,source=JSON.parse(body.source_text);assert.equal(source.local_facts.facts.patients.total,17);assert.equal(source.local_facts.observed_at,observed);assert.equal(source.local_facts.facts.appointments,undefined);assert.ok(source.local_facts.unavailable.some(item=>item.tool==='appointments.today.count'));assert.match(body.instruction,/filter|scope|unsupported/i);assert.notEqual(h.nodes['sun-answer'].dataset.origin,'local');assert.equal(h.calls[2].body.privacy_preview_id,'preview-context','facts use the privacy preview before provider execution');

 // Each pending context response remains bound to the exact current request.
 for(const change of ['text','page','patient','account','closed','panel']){
  h=harness();const wait=deferred();h.setReply(()=>wait.promise);const pending=h.run('sunSend()');
  if(change==='text')h.nodes['sun-text'].value='Changed source';
  if(change==='page')h.nodes['page-title'].textContent='Different workspace';
  if(change==='patient')h.context.selected='patient-b';
  if(change==='account')h.context.me={role:'owner',tenant_id:'other-practice'};
  if(change==='closed')h.nodes['sun-panel'].hidden=true;
  if(change==='panel')h.nodes['sun-panel']={hidden:false};
  wait.resolve(snapshot());await pending;
  assert.equal(h.calls.length,1,`${change}: stale context must not prepare provider input`);assert.equal(h.nodes['sun-answer'].hidden,true,`${change}: stale count must not render`);assert.equal(h.spoken.length,0);
 }

 // Editing after facts were captured still invalidates the later privacy result.
 h=harness();h.nodes['sun-text'].value='Explain current workflow counts';const wait=deferred();let pendingBody;h.setReply(async(path,method,body)=>{if(path==='/api/v1/sun/context')return snapshot();pendingBody=body;return wait.promise;});const pending=h.run('sunSend()');await tick();assert.ok(pendingBody);h.nodes['sun-text'].value='Changed request after facts';wait.resolve(preview(pendingBody));await pending;assert.equal(h.run('sunPrivacyReview'),null);assert.equal(h.nodes['sun-answer'].hidden,true);

 // Presentation changes may carry a completed answer, never a reviewed request.
 h=harness();h.context.sunPanelView='chat';h.setReply(async()=>snapshot());await h.run('sunSend()');h.context.presentation=h.run("sunCapturePresentationAnswer('page')");assert.ok(h.context.presentation);h.nodes['page-title'].textContent='Sun';h.context.sunPanelView='page';h.run('sunClearStaleAnswer()');assert.equal(h.nodes['sun-answer'].hidden,true);h.run('sunRestorePresentationAnswer(presentation)');assert.equal(h.nodes['sun-answer'].hidden,false);assert.match(text(h.nodes['sun-answer']),/Answered from Synthetic workspace/);assert.match(text(h.nodes['sun-answer']),/has not been refreshed/);assert.equal(h.calls.length,1,'presentation switching does not refetch or contact a provider');
 h.nodes['page-title'].textContent='Ordinary navigation';h.run('sunClearStaleAnswer()');assert.equal(h.nodes['sun-answer'].hidden,true,'normal navigation still invalidates the answer');
 h=harness();h.context.sunPanelView='chat';h.setReply(async()=>snapshot());await h.run('sunSend()');h.context.presentation=h.run("sunCapturePresentationAnswer('page')");h.run('sunInvalidatePrivacyReview()');h.context.sunPanelView='page';h.nodes['page-title'].textContent='Sun';h.run('sunRestorePresentationAnswer(presentation)');assert.equal(h.nodes['sun-answer'].hidden,true,'an intervening edit or new request invalidates a captured answer');
 h=harness();h.context.sunPanelView='chat';h.nodes['sun-text'].value='Broader question';h.setReply(async(path,method,body)=>path==='/api/v1/sun/context'?snapshot():preview(body));await h.run('sunSend()');assert.ok(h.run("sunCapturePresentationAnswer('page')"),'the protected provider answer can be carried after automatic privacy-preview execution');

 // A failed tool read cannot masquerade as a zero total or invoke a provider.
 h=harness();h.setReply(async()=>{throw Error('Synthetic context unavailable');});await h.run('sunSend()');assert.equal(h.calls.length,1);assert.equal(h.nodes['sun-answer'].hidden,true);assert.match(h.nodes['sun-status'].textContent,/unavailable/i);assert.equal(h.nodes['sun-settings'].open,true,'a failed request preserves expanded settings');
 console.log('PASS Sun total-count intent limits, omitted unavailable facts, provider-free answers and context/preview race guards');
})().catch(error=>{console.error(error);process.exitCode=1;});
