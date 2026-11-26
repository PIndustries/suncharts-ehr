// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Voice note panel on the SOAP note: visibility, recording, upload, live steps and drafted sections. Synthetic data only.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/voice-notes.js','utf8');
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const keys=['subjective','objective','assessment','plan'];
function fixture({role='clinician',status='in_progress',values={},list={available:true,items:[]},reduced=false}={}){
 const handlers={},calls=[],timers=new Map(),intervals=new Map(),notices=[],sheets=[],inputs=[],xhrs=[],gum=[],recorders=[];let timerId=0,hostVisible=true;
 const host={hidden:true,className:'',innerHTML:'',dataset:{}};
 const sections={};
 const boxes={};
 for(const key of keys){
  const section={cards:null,append(node){this.cards=node;},querySelector(sel){return sel==='[data-voice-card]'?this.cards:null;}};
  const box={value:values[key]??'',closest:()=>section,dispatchEvent(event){inputs.push({key,type:event.type,bubbles:event.bubbles});},getAttribute:n=>n==='name'?key:null};
  sections[key]=section;boxes[key]=box;
 }
 for(const key of keys)sections[key].remove=undefined;
 const mkCard=()=>({contains:()=>false,querySelectorAll:()=>[],set innerHTML(v){this.html=v;},get innerHTML(){return this.html||'';},setAttribute(){},remove(){for(const k of keys)if(sections[k].cards===this)sections[k].cards=null;},className:''});
 const form={dataset:{visitId:'v1'},querySelector:sel=>{const m=/textarea\[name="(\w+)"\]/.exec(sel);return m?boxes[m[1]]:null;}};
 const state={me:{role,user_id:'u1',tenant_id:'t1'},rec:null};
 class FakeRecorder{static isTypeSupported(t){return t==='audio/webm;codecs=opus';}
  constructor(stream,opts){this.stream=stream;this.opts=opts;this.state='inactive';this.mimeType=opts?.mimeType||'';recorders.push(this);}
  start(){this.state='recording';}pause(){this.state='paused';}resume(){this.state='recording';}
  stop(){this.state='inactive';this.ondataavailable?.({data:{size:3,type:'audio/webm'}});this.onstop?.();}}
 class FakeBlob{constructor(parts,opts){this.parts=parts;this.type=opts?.type;}}
 class FakeForm{constructor(){this.entries=[];}append(k,v,name){this.entries.push([k,v,name]);}}
 class FakeXhr{constructor(){this.headers={};this.upload={};xhrs.push(this);}open(m,u){this.method=m;this.url=u;}setRequestHeader(k,v){this.headers[k]=v;}send(body){this.body=body;}
  reply(status,data){this.status=status;this.responseText=JSON.stringify(data);this.onload();}}
 const stopped=[];
 const context=vm.createContext({console,Map,Set,Promise,Date,Math,Number,String,Array,Object,JSON,Uint8Array,Error,Blob:FakeBlob,FormData:FakeForm,XMLHttpRequest:FakeXhr,MediaRecorder:FakeRecorder,
  get me(){return state.me;},set me(v){state.me=v;},selected:'p1',activeVisit:{id:'v1',status},esc,
  $:id=>id==='note-form'?form:null,
  api:async(path,method='GET',body)=>{calls.push({path,method,body});const reply=context.replies[`${method} ${path}`];if(typeof reply==='function')return reply(body);if(reply instanceof Error)throw reply;return reply??{};},
  replies:{'GET /api/v1/visits/v1/voice-notes':list},
  setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
  setInterval:(fn,delay)=>{const id=++timerId;intervals.set(id,{fn,delay});return id;},clearInterval:id=>intervals.delete(id),
  matchMedia:()=>({matches:reduced}),
  navigator:{mediaDevices:{getUserMedia:async c=>{gum.push(c);if(context.micError)throw context.micError;return {getTracks:()=>[{stop:()=>stopped.push(1)}]};}}},
  window:{addEventListener:(n,fn)=>{(handlers['w:'+n]??=[]).push(fn);},removeEventListener:(n,fn)=>{handlers['w:'+n]=(handlers['w:'+n]||[]).filter(f=>f!==fn);}},
  document:{querySelector:sel=>sel==='[data-voice-note-panel]'&&hostVisible?host:null,querySelectorAll:()=>[],addEventListener:(n,fn)=>{(handlers[n]??=[]).push(fn);},createElement:()=>mkCard()},
  notice:(m,e)=>notices.push({m,e}),sheetOpen:(title,node)=>{const dialog={title,open:true,get html(){return node.innerHTML;},addEventListener(type,fn){if(type==='close')this.closed=fn;}};sheets.push(dialog);return dialog;},sheetClose:dialog=>{dialog.open=false;dialog.closed?.();},
  Event:class{constructor(type,o){this.type=type;this.bubbles=o?.bubbles;}},URL:{createObjectURL:()=>'blob:x',revokeObjectURL(){}},
 });
 vm.runInContext(source,context);
 const flush=()=>new Promise(r=>setImmediate(r));
 const f={context,host,boxes,sections,calls,timers,intervals,notices,sheets,inputs,xhrs,gum,recorders,stopped,handlers,flush,state,
  hide(){hostVisible=false;},
  async mount(){context.voiceNotesMount();await flush();await flush();},
  click(action,extra={}){const el={dataset:{voiceAction:action,...extra}};for(const h of handlers.click)h({target:{closest:()=>el}});return flush();},
  mode(m){const el={dataset:{voiceMode:m}};for(const h of handlers.click)h({target:{closest:()=>el}});},
  consent(checked){const el={checked};for(const h of handlers.change)h({target:{closest:sel=>sel==='[data-voice-consent]'?el:null}});},
  card(key){return sections[key].cards?.html||'';},review(){return sheets.find(sheet=>sheet.title==='Review recording draft'&&sheet.open)?.html||'';}};
 return f;
}
const at=(s)=>new Date(Date.now()-s*1000).toISOString();
const note=(stage,extra={})=>({id:'n1',mode:'dictation',consent_recorded:false,created_at:at(20),created_by_name:'Dr A',duration_seconds:60,file_id:'f1',stage,position:0,error:null,started_at:at(14),transcript:null,draft:null,dismissed:false,...extra});
const draft={subjective:'Cough for <3> days',objective:'Lungs clear',assessment:'',plan:'Rest and fluids'};
(async()=>{
 // Hidden when unavailable, when the role may not ask, or when the note is signed.
 let f=fixture({list:{available:false,items:[]}});await f.mount();assert.equal(f.host.hidden,true);assert.equal(f.host.innerHTML,'');
 f=fixture({role:'front_desk'});await f.mount();assert.equal(f.host.hidden,true);assert.equal(f.calls.length,0);
 f=fixture({status:'signed'});await f.mount();assert.equal(f.host.hidden,true);assert.equal(f.calls.length,0);
 f=fixture({list:{available:false,items:[note('ready',{draft})]}});await f.mount();assert.equal(f.host.hidden,false);
 f=fixture();await f.mount();assert.equal(f.host.hidden,false);
 assert.match(f.host.innerHTML,/Voice note/);assert.match(f.host.innerHTML,/Talk through the note and SunCharts AI drafts it for you\./);assert.match(f.host.innerHTML,/Dictation/);assert.match(f.host.innerHTML,/Record the encounter/);assert.match(f.host.innerHTML,/● Record/);
 console.log('PASS the panel is hidden when unavailable, for other roles and when signed, and shows the idle controls otherwise');

 // The consent tick gates Record in encounter mode.
 f=fixture();await f.mount();
 assert.doesNotMatch(f.host.innerHTML,/data-voice-action="record" disabled/);assert.doesNotMatch(f.host.innerHTML,/The patient agreed/);
 f.mode('encounter');assert.match(f.host.innerHTML,/The patient agreed to be recorded/);assert.match(f.host.innerHTML,/data-voice-action="record" disabled/);
 await f.click('record');assert.equal(f.gum.length,0,'no recording without consent');
 f.consent(true);assert.doesNotMatch(f.host.innerHTML,/data-voice-action="record" disabled/);
 console.log('PASS Record waits for the consent tick in encounter mode');

 // Microphone problems and browsers without recording.
 for(const [name,re] of [['NotAllowedError',/Allow the microphone for this site in your browser, then press Record again\./],['NotFoundError',/No microphone was found/]]){
  f=fixture();await f.mount();f.context.micError={name};await f.click('record');assert.match(f.host.innerHTML,re);assert.equal(f.recorders.length,0);
 }
 f=fixture();await f.mount();f.context.MediaRecorder=undefined;vm.runInContext('MediaRecorder=undefined',f.context);await f.click('record');assert.match(f.host.innerHTML,/This browser cannot record/);
 console.log('PASS microphone blocked, no microphone and unsupported browsers give plain messages');

 // Recording, pause, discard confirmation, stop and upload.
 f=fixture();await f.mount();f.mode('encounter');f.consent(true);await f.click('record');
 assert.equal(JSON.stringify(f.gum[0]),'{"audio":true}');assert.equal(f.recorders[0].opts.mimeType,'audio/webm;codecs=opus');
 assert.match(f.host.innerHTML,/voice-rec-dot/);assert.match(f.host.innerHTML,/data-voice-timer[^>]*>00:00</);assert.equal((f.host.innerHTML.match(/data-voice-bar/g)||[]).length,7);
 assert.match(f.host.innerHTML,/Stop and save/);assert.match(f.host.innerHTML,/>Pause</);assert.match(f.host.innerHTML,/>Discard</);
 assert.equal(f.handlers['w:beforeunload'].length,1,'warns before leaving');
 await f.click('pause');assert.match(f.host.innerHTML,/>Resume</);assert.match(f.host.innerHTML,/Paused/);await f.click('resume');assert.match(f.host.innerHTML,/>Pause</);
 await f.click('discard');assert.match(f.host.innerHTML,/Throw this recording away/);await f.click('discard-no');assert.match(f.host.innerHTML,/Stop and save/);
 await f.click('stop');await f.flush();
 assert.ok(f.stopped.length>0,'microphone tracks stopped');
 assert.equal(f.xhrs.length,1);let x=f.xhrs[0];assert.equal(x.method,'POST');assert.equal(x.url,'/api/v1/visits/v1/voice-notes');assert.equal(x.headers['X-SunCharts-Staff-Context'],'t1:u1');
 const got=Object.fromEntries(x.body.entries.map(e=>[e[0],e[1]]));
 assert.equal(got.mode,'encounter');assert.equal(got.consent,'true');assert.ok(Number(got.duration_seconds)>=1);assert.equal(got.audio.type,'audio/webm');
 assert.match(f.host.innerHTML,/Saving to the chart…/);
 x.upload.onprogress({lengthComputable:true,loaded:1,total:2});
 x.reply(201,note('saved',{id:'n9',position:0,started_at:null}));await f.flush();
 assert.match(f.host.innerHTML,/data-voice-steps/);assert.equal(f.handlers['w:beforeunload'].length,0);
 console.log('PASS recording, pause, discard confirm, stop, and the upload carries audio, mode, consent and duration');

 // Dictation sends no consent. A discard throws the recording away without uploading.
 f=fixture();await f.mount();await f.click('record');await f.click('stop');await f.flush();
 assert.equal(f.xhrs[0].body.entries.some(e=>e[0]==='consent'),false);assert.equal(f.xhrs[0].body.entries.find(e=>e[0]==='mode')[1],'dictation');
 f=fixture();await f.mount();await f.click('record');await f.click('discard');await f.click('discard-yes');await f.flush();assert.equal(f.xhrs.length,0);assert.ok(f.stopped.length>0);assert.match(f.host.innerHTML,/● Record/);
 console.log('PASS dictation sends no consent and a discarded recording is never uploaded');

 // A failed upload keeps the recording and offers Try again and Download.
 f=fixture();await f.mount();await f.click('record');await f.click('stop');await f.flush();
 f.xhrs[0].reply(413,{message:'x'});await f.flush();
 assert.match(f.host.innerHTML,/too large/);assert.match(f.host.innerHTML,/Try again/);assert.match(f.host.innerHTML,/Download recording/);assert.match(f.host.innerHTML,/href="blob:x"/);
 await f.click('upload-retry');assert.equal(f.xhrs.length,2);f.xhrs[1].reply(422,{message:'Recording needs the patient to agree.'});await f.flush();assert.match(f.host.innerHTML,/needs the patient to agree/);
 f.xhrs.length=0;await f.click('upload-retry');f.xhrs[0].reply(201,note('saved'));await f.flush();assert.match(f.host.innerHTML,/data-voice-steps/);
 console.log('PASS a failed upload keeps the recording with Try again and Download, and retries');

 // Stage to steps.
 const steps=(h)=>[...h.matchAll(/<li class="(is-\w+)"[^>]*data-voice-step="(\d)"/g)].map(m=>m[1]);
 f=fixture({list:{available:true,items:[note('saved')]}});await f.mount();
 assert.deepEqual(steps(f.host.innerHTML),['is-now','is-later','is-later','is-later','is-later']);assert.match(f.host.innerHTML,/Saved to the chart…/);
 f=fixture({list:{available:true,items:[note('waiting',{position:3})]}});await f.mount();
 assert.deepEqual(steps(f.host.innerHTML),['is-done','is-now','is-later','is-later','is-later']);assert.match(f.host.innerHTML,/Waiting for a turn · 3 ahead of you/);assert.match(f.host.innerHTML,/3 ahead of you<\/small>/);
 f=fixture({list:{available:true,items:[note('waiting',{position:0})]}});await f.mount();assert.match(f.host.innerHTML,/Waiting for a turn…/);assert.doesNotMatch(f.host.innerHTML,/ahead/);
 f=fixture({list:{available:true,items:[note('transcribing')]}});await f.mount();
 assert.deepEqual(steps(f.host.innerHTML),['is-done','is-done','is-now','is-later','is-later']);assert.match(f.host.innerHTML,/data-voice-skipped/);assert.match(f.host.innerHTML,/Turning speech into text… <span[^>]*data-voice-elapsed>14 s</);
 f=fixture({list:{available:true,items:[note('drafting')]}});await f.mount();assert.deepEqual(steps(f.host.innerHTML),['is-done','is-done','is-done','is-now','is-later']);assert.match(f.host.innerHTML,/Drafting the note…/);
 f=fixture({list:{available:true,items:[note('ready',{draft})]}});await f.mount();assert.deepEqual(steps(f.host.innerHTML),[]);assert.match(f.host.innerHTML,/data-voice-pending-count="3"/);
 console.log('PASS each stage maps to the right steps, with the place in line and no wait shown');

 // Elapsed text ticks on the client.
 f=fixture({list:{available:true,items:[note('transcribing',{started_at:at(75)})]}});await f.mount();assert.match(f.host.innerHTML,/1 min 15 s/);
 const live={textContent:''};f.context.document.querySelectorAll=sel=>sel==='[data-voice-elapsed]'?[live]:[];
 await new Promise(r=>setTimeout(r,5));vm.runInContext('voiceNoteTick()',f.context);assert.match(live.textContent,/^1 min \d+ s$/);
 console.log('PASS the elapsed seconds tick on the client');

 // A live event moves the strip without fetching the list; a ready event fetches the draft.
 f=fixture({list:{available:true,items:[note('waiting',{position:2})]}});await f.mount();let before=f.calls.length;
 f.context.voiceNotesEvent({visit_id:'v1',voice_note_id:'n1',stage:'transcribing',position:0});
 assert.equal(f.calls.length,before);assert.deepEqual(steps(f.host.innerHTML),['is-done','is-done','is-now','is-later','is-later']);
 f.context.replies['GET /api/v1/visits/v1/voice-notes']={available:true,items:[note('ready',{draft})]};
 f.context.voiceNotesEvent({visit_id:'v1',voice_note_id:'n1',stage:'ready'});await f.flush();await f.flush();
 assert.equal(f.calls.length,before+1);assert.match(f.host.innerHTML,/data-voice-review-draft/);assert.equal(f.card('subjective'),'');
 console.log('PASS a live event updates the strip and a ready event brings the draft');

 // Poll fallback schedules every 2 s while unfinished, and stops.
 f=fixture({list:{available:true,items:[note('transcribing')]}});await f.mount();
 let t=[...f.timers.values()].filter(x=>x.delay===2000);assert.equal(t.length,1);
 f.context.replies['GET /api/v1/visits/v1/voice-notes']={available:true,items:[note('drafting')]};
 let b=f.calls.length;f.timers.clear();t[0].fn();await f.flush();await f.flush();assert.equal(f.calls.length,b+1);assert.equal([...f.timers.values()].filter(x=>x.delay===2000).length,1,'keeps polling');
 f.timers.clear();f.context.replies['GET /api/v1/visits/v1/voice-notes']={available:true,items:[note('ready',{draft})]};
 vm.runInContext('voiceNoteStates.get("v1").pollTimer=null',f.context);await f.context.voiceNoteRefresh('v1');
 assert.equal([...f.timers.values()].filter(x=>x.delay===2000).length,0,'stops when ready');
 f=fixture({list:{available:true,items:[note('failed',{error:'timeout'})]}});await f.mount();assert.equal([...f.timers.values()].filter(x=>x.delay===2000).length,0);
 console.log('PASS polling runs every 2 s while unfinished and stops at ready or failed');

 // Open review deliberately, with the actual edited note available for comparison.
 f=fixture({values:{plan:'Existing plan'},list:{available:true,items:[note('ready',{draft})]}});await f.mount();
 assert.match(f.host.innerHTML,/data-voice-pending-count="3"/);assert.doesNotMatch(f.host.innerHTML,/Lungs clear|Rest and fluids|data-voice-steps/);
 assert.equal(f.card('plan'),'');assert.equal(f.sheets.length,0);assert.equal(f.inputs.length,0);
 await f.click('review');
 assert.match(f.review(),/Current note/);assert.match(f.review(),/Existing plan/);assert.match(f.review(),/Cough for &lt;3&gt; days/);
 assert.match(f.review(),/Use suggestion/);assert.match(f.review(),/Append to section/);assert.match(f.review(),/Replace section/);
 assert.doesNotMatch(f.review(),/data-voice-card="assessment"/);
 for(const text of ['Show transcript','Dismiss draft','Record another'])assert.ok(f.review().includes(text));
 assert.equal(f.inputs.length,0,'reading the comparison does not change the note');
 f.calls.length=0;await f.click('use',{key:'subjective'});assert.equal(f.boxes.subjective.value,'Cough for <3> days');assert.deepEqual(f.inputs[0],{key:'subjective',type:'input',bubbles:true});assert.equal(f.calls.length,0);
 await f.click('add',{key:'plan'});assert.equal(f.boxes.plan.value,'Existing plan\n\nRest and fluids');
 assert.match(f.host.innerHTML,/data-voice-pending-count="1"/);
 f=fixture({values:{plan:'Old'},list:{available:true,items:[note('ready',{draft})]}});await f.mount();await f.click('review');
 await f.click('use',{key:'plan'});assert.equal(f.boxes.plan.value,'Rest and fluids');
 console.log('PASS recording review compares the current note with suggestions and changes only the chosen section');

 // An already-applied paragraph remains resolved on reload; skipped fields stay untouched.
 f=fixture({values:{plan:'Old\n\nRest and fluids'},list:{available:true,items:[note('ready',{draft})]}});await f.mount();await f.click('review');
 assert.match(f.host.innerHTML,/data-voice-pending-count="2"/);assert.doesNotMatch(f.review(),/Already in note|Rest and fluids/);
 await f.click('toggle-reviewed');assert.match(f.review(),/Already in note/);assert.equal(f.review().split('Rest and fluids').length-1,1,'matches appear once on request');await f.click('toggle-reviewed');
 await f.click('dismiss-card',{key:'objective'});assert.doesNotMatch(f.review(),/data-voice-card="objective"/);await f.click('toggle-reviewed');assert.match(f.review(),/Dismissed/);await f.click('toggle-reviewed');assert.match(f.host.innerHTML,/data-voice-pending-count="1"/);
 await f.click('use-all');assert.equal(f.boxes.subjective.value,'Cough for <3> days');assert.equal(f.boxes.objective.value,'');assert.equal(f.boxes.plan.value,'Old\n\nRest and fluids');assert.equal(f.inputs.length,1);
 assert.match(f.host.innerHTML,/data-voice-pending-count="0"/);assert.match(f.host.innerHTML,/View recording/);
 f=fixture({values:{plan:'Old'},list:{available:true,items:[note('ready',{draft})]}});await f.mount();await f.click('review');await f.click('use-all');
 assert.equal(f.boxes.subjective.value,'Cough for <3> days');assert.equal(f.boxes.objective.value,'Lungs clear');assert.equal(f.boxes.plan.value,'Old\n\nRest and fluids');assert.equal(f.inputs.length,3);
 console.log('PASS batch apply skips identical and dismissed suggestions and appends without replacing existing sections');

 // Match complete lines and paragraphs only, regardless of newline convention.
 const full={subjective:'History A',objective:'Observation B',assessment:'Finding C\r\nFinding D',plan:'Counsel E'};
 f=fixture({values:{...full,subjective:'Other paragraph\nHistory A',assessment:'Finding C\nFinding D'},list:{available:true,items:[note('ready',{draft:full,transcript:'Recorded source'})]}});await f.mount();
 assert.match(f.host.innerHTML,/data-voice-recording/);assert.doesNotMatch(f.host.innerHTML,/data-voice-review-draft|sections to review|Recording draft/);
 await f.click('recording');let recording=f.sheets.at(-1);assert.equal(recording.title,'Recording and transcript');
 assert.match(recording.html,/All suggestions are already in the note/);assert.match(recording.html,/<audio controls/);assert.match(recording.html,/Recorded source/);
 assert.doesNotMatch(recording.html,/data-voice-card=|Current note|Replace section|Append to section|Finding C/);
 assert.match(recording.html,/View reviewed sections \(4\)/);
 await f.click('toggle-reviewed');assert.equal(recording.html.split('Observation B').length-1,1);assert.match(recording.html,/data-voice-card="assessment"/);
 await f.click('toggle-reviewed');assert.doesNotMatch(recording.html,/Observation B/);assert.equal(f.inputs.length,0);
 f=fixture({values:{...full,objective:'No Observation B',plan:'counsel E'},list:{available:true,items:[note('ready',{draft:full})]}});await f.mount();
 assert.match(f.host.innerHTML,/data-voice-pending-count="2"/);await f.click('review');assert.match(f.review(),/No Observation B/);assert.match(f.review(),/counsel E/);assert.doesNotMatch(f.review(),/History A/);assert.equal(f.inputs.length,0);
 console.log('PASS exact incorporated sections disappear from decisions, partial and case-changed matches still need review, recording stays available');

 // Transcript sheet and dismiss.
 f=fixture({list:{available:true,items:[note('ready',{draft,transcript:'Patient says <hello>'})]}});await f.mount();await f.click('transcript');
 assert.equal(f.sheets[0].title,'Transcript');assert.match(f.sheets[0].html,/<audio controls/);assert.match(f.sheets[0].html,/\/api\/v1\/patients\/p1\/documents\/f1\/download/);assert.match(f.sheets[0].html,/Patient says &lt;hello&gt;/);
 f.context.replies['POST /api/v1/visits/v1/voice-notes/n1/dismiss']={};await f.click('dismiss');
 assert.equal(f.calls.at(-1).path,'/api/v1/visits/v1/voice-notes/n1/dismiss');assert.match(f.host.innerHTML,/Talk through the note/);assert.equal(f.card('subjective'),'');
 console.log('PASS the transcript opens in a sheet with the recording and Dismiss draft calls the server');

 // Failures.
 const failed=(error,extra={})=>fixture({list:{available:true,items:[note('failed',{error,...extra})]}});
 f=failed('unavailable');await f.mount();assert.match(f.host.innerHTML,/Saved to the chart\. SunCharts AI is not reachable right now\./);assert.match(f.host.innerHTML,/>Try again</);
 f=failed('empty');await f.mount();assert.match(f.host.innerHTML,/No speech was heard in the recording\./);
 for(const e of ['timeout','upstream_error']){f=failed(e);await f.mount();assert.match(f.host.innerHTML,/That took too long\. Try again\./);}
 f=failed('draft_invalid',{transcript:'words'});await f.mount();assert.match(f.host.innerHTML,/The recording was turned into text but the draft could not be made\./);assert.match(f.host.innerHTML,/Show transcript/);assert.match(f.host.innerHTML,/>Try again</);
 f.context.replies['POST /api/v1/visits/v1/voice-notes/n1/retry']={...note('waiting',{position:1})};await f.click('retry');assert.equal(f.calls.at(-1).path.endsWith('/retry')||f.calls.some(c=>c.path.endsWith('/retry')),true);
 console.log('PASS each failure shows its plain message and the right buttons');

 // A draft that becomes ready while the panel is off screen is announced.
 f=fixture({list:{available:true,items:[note('drafting')]}});await f.mount();f.hide();
 f.context.replies['GET /api/v1/visits/v1/voice-notes']={available:true,items:[note('ready',{draft})]};await f.context.voiceNoteRefresh('v1');
 assert.equal(f.notices.length,1);assert.match(f.notices[0].m,/draft is ready/);
 console.log('PASS a toast announces a draft that is ready while the panel is not on screen');
})().catch(e=>{console.error(e);process.exit(1);});
