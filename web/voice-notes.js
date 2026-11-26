// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Voice note on the SOAP note: record, save to the chart, watch SunCharts AI turn it into text and draft
// the four note sections, then choose what to use. Nothing is written into the note, saved or signed
// until a person presses a button; using a suggestion only fills the box like typing would.
const voiceNoteStates=new Map();
const voiceNoteKeys=['subjective','objective','assessment','plan'];
const voiceNoteStageOrder={saved:0,waiting:1,transcribing:2,drafting:3,ready:4};
const voiceNoteStepNames=['Saved to the chart','Waiting for a turn','Turning speech into text','Drafting the note','Ready'];
const voiceNoteMaxSeconds=30*60;
let voiceNoteRec=null,voiceNoteTicker=null,voiceNoteLeave=null,voiceNoteReview=null;
function voiceNoteMayAsk(){return ['owner','clinician'].includes(me?.role)&&!me?.delegated;}
function voiceNoteState(id){let state=voiceNoteStates.get(id);if(!state){state={items:[],available:null,hydrated:false,account:me,mode:'dictation',consent:false,showRecorder:false,upload:null,error:'',pollTimer:null,seen:new Map(),used:new Set(),dismissedCards:new Set(),notifiedReady:new Set(),confirmDiscard:false};voiceNoteStates.set(id,state);}return state;}
const voiceNoteWorking=item=>Boolean(item)&&['saved','waiting','transcribing','drafting'].includes(item.stage);
function voiceNoteTime(item){const at=Date.parse(item?.created_at);return Number.isFinite(at)?at:0;}
// The recording the panel talks about: the newest one still in progress, else the newest not dismissed.
function voiceNoteCurrent(state){
 const items=[...(state.items||[])].filter(item=>item&&!item.dismissed).sort((a,b)=>voiceNoteTime(b)-voiceNoteTime(a));
 return items.find(voiceNoteWorking)||items[0]||null;
}
function voiceNoteMmss(seconds){const total=Math.max(0,Math.floor(seconds));return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;}
function voiceNoteElapsedText(item,state,now=Date.now()){
 let since=Date.parse(item?.started_at);
 if(!Number.isFinite(since)){const key=`${item?.id}:${item?.stage}`;if(!state.seen.has(key))state.seen.set(key,now);since=state.seen.get(key);}
 const seconds=Math.max(0,Math.floor((now-since)/1000));
 return seconds<60?`${seconds} s`:`${Math.floor(seconds/60)} min ${seconds%60} s`;
}
function voiceNoteLiveText(item){
 if(item.stage==='saved')return 'Saved to the chart…';
 if(item.stage==='waiting')return Number(item.position)>0?`Waiting for a turn · ${Number(item.position)} ahead of you`:'Waiting for a turn…';
 if(item.stage==='transcribing')return 'Turning speech into text…';
 if(item.stage==='drafting')return 'Drafting the note…';
 return '';
}
function voiceNoteIndicator(index){
 if(index===1)return '<span class="voice-ind" aria-hidden="true"><i></i><i></i></span>';
 if(index===2)return '<span class="voice-ind" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
 if(index===3)return '<span class="voice-ind is-text" aria-hidden="true"><i></i><i></i><i></i></span>';
 return '';
}
function voiceNoteStepsMarkup(item,state){
 const current=voiceNoteStageOrder[item.stage]??0,allDone=item.stage==='ready';
 if(item.stage==='waiting')state.sawWaiting=state.sawWaiting||new Set(),state.sawWaiting.add(item.id);
 const skipped=current>1&&!(state.sawWaiting&&state.sawWaiting.has(item.id));
 return `<ol class="suggest-steps" data-voice-steps>${voiceNoteStepNames.map((name,index)=>{
  const cls=allDone||index<current?'is-done':index===current?'is-now':'is-later';
  const sub=index===1&&cls==='is-done'&&skipped?'<small class="voice-skipped" data-voice-skipped>No wait</small>':index===1&&cls==='is-now'&&Number(item.position)>0?`<small data-voice-place>${esc(String(Number(item.position)))} ahead of you</small>`:'';
  return `<li class="${cls}"${index===current&&!allDone?' aria-current="step"':''} data-voice-step="${index}"><span class="suggest-step-mark" aria-hidden="true">${cls==='is-done'?'✓':index+1}</span><span class="suggest-step-text"><b>${esc(name)}</b>${sub}${cls==='is-now'?voiceNoteIndicator(index):''}</span></li>`;
 }).join('')}</ol>`;
}
function voiceNoteControlsMarkup(state,available){
 const encounter=state.mode==='encounter';
 return `<div class="voice-switch" role="group" aria-label="Kind of voice note"><button type="button" data-voice-mode="dictation" aria-pressed="${!encounter}">Dictation</button><button type="button" data-voice-mode="encounter" aria-pressed="${encounter}">Record the encounter</button></div>`
  +(encounter?`<label class="voice-consent"><input type="checkbox" data-voice-consent ${state.consent?'checked':''}> The patient agreed to be recorded</label>`:'')
  +`${state.error?`<p role="alert" data-voice-error>${esc(state.error)}</p>`:''}<div class="actions"><button type="button" class="primary" data-voice-action="record"${encounter&&!state.consent?' disabled':''}>● Record</button></div>`;
}
function voiceNoteErrorText(item){
 if(item.error==='unavailable')return 'Saved to the chart. SunCharts AI is not reachable right now.';
 if(item.error==='empty')return 'No speech was heard in the recording.';
 if(item.error==='draft_invalid')return 'The recording was turned into text but the draft could not be made.';
 if(item.error==='timeout'||item.error==='upstream_error')return 'That took too long. Try again.';
 return 'The recording could not be turned into a draft. Try again.';
}
function voiceNoteRecordingMarkup(state,rec){
 const bars=Array.from({length:7},()=>'<span data-voice-bar></span>').join('');
 const paused=rec.paused;
 if(state.confirmDiscard)return `<div class="voice-rec-head"><span class="voice-rec-dot" aria-hidden="true"></span><span>Recording</span></div><p role="alert" data-voice-confirm>Throw this recording away? It has not been saved.</p><div class="actions"><button type="button" data-voice-action="discard-yes">Yes, discard it</button><button type="button" class="primary" data-voice-action="discard-no">Keep recording</button></div>`;
 return `<div class="voice-rec-head"><span class="voice-rec-dot" aria-hidden="true"></span><span>${paused?'Paused':'Recording'}</span><span class="voice-timer" data-voice-timer role="timer">${voiceNoteMmss(voiceNoteRecSeconds(rec))}</span></div><div class="voice-meter" data-voice-meter aria-hidden="true">${bars}</div><div class="actions"><button type="button" class="primary" data-voice-action="stop">Stop and save</button>${rec.canPause?`<button type="button" data-voice-action="${paused?'resume':'pause'}">${paused?'Resume':'Pause'}</button>`:''}<button type="button" class="text-button" data-voice-action="discard">Discard</button></div>`;
}
function voiceNoteUploadMarkup(state){
 const up=state.upload;
 if(up.status==='sending'){const pct=Math.max(0,Math.min(100,Math.round((up.progress||0)*100)));return `<p role="status" data-voice-saving>Saving to the chart…${pct?` ${pct}%`:''}</p><div class="voice-progress" aria-hidden="true"><span data-voice-progress data-percent="${pct}"></span></div>`;}
 return `<p role="alert" data-voice-error>${esc(up.message||'The recording could not be saved.')}</p><p class="voice-note-small">Your recording is kept here until it is saved.</p><div class="actions"><button type="button" class="primary" data-voice-action="upload-retry">Try again</button><a class="button" data-voice-download href="${esc(up.url||'#')}" download="${esc(up.filename||'recording')}">Download recording</a><button type="button" class="text-button" data-voice-action="upload-drop">Discard</button></div>`;
}
function voiceNoteItemMarkup(state,item){
 if(voiceNoteWorking(item))return {cls:'',body:`<h3 class="suggest-title">Voice note</h3>${voiceNoteStepsMarkup(item,state)}<p class="suggest-live" role="status" data-voice-live>${esc(voiceNoteLiveText(item))} <span class="suggest-elapsed" data-voice-elapsed>${esc(voiceNoteElapsedText(item,state))}</span></p>`};
 if(item.stage==='failed'){
  const showText=item.error==='draft_invalid'&&item.transcript,retry=item.error!=='empty';
  return {cls:' is-failed',body:`<h3 class="suggest-title">Voice note</h3><p role="alert" data-voice-failed>${esc(voiceNoteErrorText(item))}</p><div class="actions">${retry?'<button type="button" class="primary" data-voice-action="retry">Try again</button>':''}${showText?'<button type="button" data-voice-action="transcript">Show transcript</button>':''}<button type="button" class="text-button" data-voice-action="dismiss">Dismiss</button></div>`};
 }
 const rows=voiceNoteReviewRows(state,item),count=rows.filter(row=>!row.status).length;
 if(!count)return {cls:' is-ready is-reviewed',body:'<button type="button" class="text-button" data-voice-action="recording" data-voice-recording data-voice-pending-count="0" aria-haspopup="dialog">View recording</button>'};
 return {cls:' is-ready',body:`<div class="voice-ready-summary"><span><strong>Recording draft</strong> · ${count} ${count===1?'section':'sections'} to review</span><button type="button" data-voice-action="review" data-voice-review-draft data-voice-pending-count="${count}" aria-haspopup="dialog">Review draft</button></div>`};
}
// The whole panel for one encounter, or null when it should not be shown.
function voiceNotePanelMarkup(id){
 const state=voiceNoteState(id);
 if(!voiceNoteMayAsk()||activeVisit?.status==='signed')return null;
 const rec=voiceNoteRec&&voiceNoteRec.visitId===id?voiceNoteRec:null;
 if(state.available===false&&!state.items.length&&!rec&&!state.upload)return null;
 if(state.available===null&&!state.items.length&&!rec&&!state.upload)return null;
 if(rec)return {cls:rec.paused?' is-paused':'',body:`<h3 class="suggest-title">Voice note</h3>${voiceNoteRecordingMarkup(state,rec)}`};
 if(state.upload)return {cls:state.upload.status==='failed'?' is-failed':'',body:`<h3 class="suggest-title">Voice note</h3>${voiceNoteUploadMarkup(state)}`};
 const item=voiceNoteCurrent(state);
 if(item&&!state.showRecorder)return voiceNoteItemMarkup(state,item);
 return {cls:'',body:`<h3 class="suggest-title">Voice note</h3><p>Talk through the note and SunCharts AI drafts it for you.</p>${voiceNoteControlsMarkup(state,state.available)}`};
}
function voiceNoteHost(){return typeof document!=='undefined'?document.querySelector?.('[data-voice-note-panel]'):null;}
function voiceNotePaint(id){
 const host=voiceNoteHost();if(!host||activeVisit?.id!==id)return;
 const state=voiceNoteState(id),view=voiceNotePanelMarkup(id);
 if(!view){host.hidden=true;host.innerHTML='';voiceNoteRefreshReview();return;}
 host.hidden=false;host.className=`voice-note-panel${view.cls}`;host.innerHTML=view.body;
 voiceNoteRefreshReview();voiceNoteSchedule(id);voiceNoteEnsureTicker();
}
function voiceNoteTextareas(){
 const form=typeof $==='function'?$('note-form'):null;if(!form?.querySelector)return {};
 const out={};for(const key of voiceNoteKeys){const box=form.querySelector(`textarea[name="${key}"]`);if(box)out[key]=box;}return out;
}
// Compare with the live SOAP inputs so an unsaved edit is never mistaken for a blank field.
function voiceNoteReviewRows(state,item){
 const boxes=voiceNoteTextareas();
 return voiceNoteKeys.flatMap(key=>{
  const text=String(item.draft?.[key]??'').trim(),box=boxes[key];
  if(!text||!box)return [];
  const current=String(box.value??''),handle=`${item.id}:${key}`;
  // Exact lines cover pasted and appended paragraphs without equating different clinical wording.
  const lines='\n'+current.trim().replace(/\r\n/g,'\n')+'\n';
  const matches=lines.includes('\n'+text.replace(/\r\n/g,'\n')+'\n');
  const status=matches?'Already in note':state.used.has(handle)?'Used':state.dismissedCards.has(handle)?'Dismissed':'';
  return [{key,label:key[0].toUpperCase()+key.slice(1),current,text,status}];
 });
}
function voiceNoteReviewMarkup(state,item,review){
 const rows=voiceNoteReviewRows(state,item),pending=rows.filter(row=>!row.status),resolved=rows.filter(row=>row.status);
 const fields=pending.map(({key,label,current,text})=>{
  const filled=Boolean(current.trim());
  const compare=`<div class="voice-review-comparison"><div><b>Current note</b><p>${esc(current.trim()||'Empty')}</p></div><div><b>Recording suggestion</b><p data-voice-card-text>${esc(text)}</p></div></div>`;
  return `<section class="voice-review-field" data-voice-card="${key}"><h4>${label}</h4>${compare}<div class="actions"><button type="button" data-voice-action="use" data-key="${key}">${filled?'Replace section':'Use suggestion'}</button>${filled?`<button type="button" data-voice-action="add" data-key="${key}">Append to section</button>`:''}<button type="button" class="text-button" data-voice-action="dismiss-card" data-key="${key}">Dismiss suggestion</button></div></section>`;
 }).join('');
 const append=pending.length>1?`<button type="button" data-voice-action="use-all">Add all ${pending.length} suggestions to note</button>`:'';
 const reviewed=resolved.length?`<button type="button" class="text-button" data-voice-action="toggle-reviewed" aria-expanded="${Boolean(review?.expanded)}">${review?.expanded?'Hide':'View'} reviewed sections (${resolved.length})</button>`:'';
 const history=review?.expanded?resolved.map(({key,label,status,text})=>`<section class="voice-review-resolved" data-voice-card="${key}"><strong>${label}</strong> · ${status}<p>${esc(text)}</p></section>`).join(''):'';
 const summary=pending.length?'':`<p role="status">${resolved.length&&resolved.every(row=>row.status==='Already in note')?'All suggestions are already in the note.':rows.length?'No suggestions left to review.':'No suggestions were generated.'}</p>`;
 const transcript=review?.showRecording?voiceNoteTranscriptMarkup(item):'<button type="button" data-voice-action="transcript">Show transcript</button>';
 return `${summary}${fields}${review?.showRecording?transcript:''}${reviewed}${history}<div class="voice-review-actions actions">${append}${review?.showRecording?'':transcript}<button type="button" data-voice-action="record-another">Record another</button><button type="button" class="text-button" data-voice-action="dismiss">Dismiss draft</button></div>`;
}
function voiceNoteReviewCurrent(review){
 const state=voiceNoteStates.get(review.id),item=state&&voiceNoteCurrent(state),form=$('note-form');
 return me===review.account&&selected===review.patient&&activeVisit?.id===review.id&&activeVisit.status!=='signed'&&voiceNoteMayAsk()&&(typeof canDraftNote!=='function'||canDraftNote(activeVisit))&&form?.dataset?.visitId===review.id&&!state?.showRecorder&&item?.id===review.recording&&item.stage==='ready';
}
function voiceNoteRefreshReview(){
 const review=voiceNoteReview;if(!review)return;
 if(!voiceNoteReviewCurrent(review)){voiceNoteReview=null;sheetClose(review.dialog);return;}
 const state=voiceNoteState(review.id),html=voiceNoteReviewMarkup(state,voiceNoteCurrent(state),review);
 if(review.html===html)return;
 const focus=review.node.contains(document.activeElement)?document.activeElement.dataset:null;
 review.node.innerHTML=html;review.html=html;
 if(focus){
  const buttons=[...review.node.querySelectorAll('[data-voice-action]')];
  const next=buttons.find(b=>b.dataset.voiceAction===focus.voiceAction&&b.dataset.key===focus.key)||buttons[0];
  next?.focus({preventScroll:true});
 }
}
function voiceNoteOpenReview(id,recording=false){
 const state=voiceNoteState(id),item=voiceNoteCurrent(state);
 if(!item||typeof sheetOpen!=='function'||voiceNoteReview?.dialog.open)return;
 const node=document.createElement('div'),review={id,recording:item.id,patient:selected,account:me,node,showRecording:recording,expanded:false};
 if(!voiceNoteReviewCurrent(review))return;
 node.className='voice-review';
 review.html=voiceNoteReviewMarkup(state,item,review);node.innerHTML=review.html;
 review.dialog=sheetOpen(recording?'Recording and transcript':'Review recording draft',node,{className:'chart-record-sheet voice-review-sheet sheet-wide',label:true});
 voiceNoteReview=review;
 review.dialog.addEventListener('close',()=>{
  if(voiceNoteReview===review)voiceNoteReview=null;
  if(activeVisit?.id===id&&me===review.account&&selected===review.patient){
   voiceNoteHost()?.querySelector?.('[data-voice-pending-count],[data-voice-action="record"]')?.focus?.({preventScroll:true});
  }
 },{once:true});
}
function voiceNoteFill(key,text,how){
 const box=voiceNoteTextareas()[key];if(!box)return false;
 const had=String(box.value??'').trim();
 box.value=how==='replace'||!had?text:`${box.value.replace(/\s+$/,'')}\n\n${text}`;
 box.dispatchEvent(typeof Event==='function'?new Event('input',{bubbles:true}):{type:'input',bubbles:true});
 const section=box.closest?.('.note-section');if(section&&typeof motionFlash==='function')motionFlash(section);
 return true;
}
function voiceNoteUse(id,key,how){
 const state=voiceNoteState(id),item=voiceNoteCurrent(state);if(!item?.draft)return;
 const row=voiceNoteReviewRows(state,item).find(row=>row.key===key);if(!row||row.status)return;
 if(voiceNoteFill(key,row.text,how))state.used.add(`${item.id}:${key}`);
 voiceNotePaint(id);
}
function voiceNoteUseAll(id){
 const state=voiceNoteState(id),item=voiceNoteCurrent(state);if(!item?.draft)return;
 for(const {key,text,status} of voiceNoteReviewRows(state,item)){
  if(status)continue;
  if(voiceNoteFill(key,text,'add'))state.used.add(`${item.id}:${key}`);
 }
 voiceNotePaint(id);
}
// ---- Data ----
function voiceNoteApply(id,data){
 const state=voiceNoteState(id);
 state.available=data?.available===true;state.hydrated=true;
 const before=new Map(state.items.map(item=>[item.id,item.stage]));
 state.items=Array.isArray(data?.items)?data.items:[];
 for(const item of state.items){
  if(item.stage==='ready'&&before.has(item.id)&&before.get(item.id)!=='ready'&&!state.notifiedReady.has(item.id)){
   state.notifiedReady.add(item.id);
   const onScreen=Boolean(voiceNoteHost())&&activeVisit?.id===id&&!voiceNoteHost().hidden;
   if(!onScreen&&typeof notice==='function')notice('Your voice note draft is ready.');
  }
  if(item.stage==='ready')state.notifiedReady.add(item.id);
 }
}
async function voiceNoteRefresh(id){
 const account=me,state=voiceNoteState(id);
 try{
  const data=await api(`/api/v1/visits/${id}/voice-notes`);
  if(me!==account)return;
  voiceNoteApply(id,data);voiceNotePaint(id);
 }catch{if(me===account){state.hydrated=true;voiceNoteSchedule(id);}}
}
// Fallback when no live event arrives: look again every 2 seconds while anything is unfinished.
function voiceNoteSchedule(id){
 const state=voiceNoteState(id);
 const need=state.items.some(voiceNoteWorking);
 if(!need){if(state.pollTimer){clearTimeout(state.pollTimer);state.pollTimer=null;}return;}
 if(state.pollTimer)return;
 state.pollTimer=setTimeout(()=>{state.pollTimer=null;if(state.account!==me)return;void voiceNoteRefresh(id);},2000);
}
// The live feed names the recording and its stage. Accepts the whole object, or an action and encounter id.
function voiceNotesEvent(payload,visitId){
 if(!voiceNoteMayAsk())return;
 const data=payload&&typeof payload==='object'?payload:{action:payload,visit_id:visitId};
 const id=data.visit_id||data.resource_id||visitId;if(!id)return;
 const state=voiceNoteStates.get(id);
 const stage=typeof data.stage==='string'?data.stage:null,noteId=data.voice_note_id||data.id;
 const item=state?.items.find(entry=>entry.id===noteId);
 if(item&&stage&&stage in voiceNoteStageOrder&&stage!=='ready'){
  item.stage=stage;if(data.position!=null)item.position=Number(data.position)||0;
  if(data.started_at)item.started_at=data.started_at;
  if(activeVisit?.id===id)voiceNotePaint(id);
  return;
 }
 if(state||activeVisit?.id===id)void voiceNoteRefresh(id);
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('suncharts:change',event=>{const detail=event?.detail;if(detail&&/voice_note/.test(String(detail.action||'')))voiceNotesEvent(detail.action,detail.resource_id);});
// Called when the note is drawn.
function voiceNotesMount(){
 const id=activeVisit?.id;if(!id||!voiceNoteMayAsk()||activeVisit.status==='signed')return;
 const state=voiceNoteState(id);if(state.account!==me){voiceNoteStates.delete(id);return voiceNotesMount();}
 voiceNotePaint(id);
 void voiceNoteRefresh(id);
}
if(typeof MutationObserver==='function'&&typeof document!=='undefined'&&document.documentElement)new MutationObserver(()=>{const host=document.querySelector('[data-voice-note-panel]:not([data-voice-seen])');if(host){host.dataset.voiceSeen='1';voiceNotesMount();}}).observe(document.documentElement,{childList:true,subtree:true});
// ---- Recording ----
function voiceNoteRecSeconds(rec,now=Date.now()){return Math.max(0,((rec.paused?rec.pausedAt:now)-rec.startedAt-rec.pausedTotal)/1000);}
function voiceNotePickType(){
 if(typeof MediaRecorder==='undefined'||typeof MediaRecorder.isTypeSupported!=='function')return '';
 return ['audio/webm;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type))||'';
}
function voiceNoteReduced(){try{return typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;}catch{return false;}}
function voiceNoteStopTracks(rec){
 try{rec.stream?.getTracks?.().forEach(track=>track.stop());}catch{/* Already stopped. */}
 try{rec.audio?.close?.();}catch{/* Already closed. */}
 if(rec.meterTimer)clearInterval(rec.meterTimer);rec.meterTimer=null;
}
function voiceNoteLeaveGuard(on){
 if(typeof window==='undefined'||!window.addEventListener)return;
 if(on&&!voiceNoteLeave){voiceNoteLeave=event=>{if(!voiceNoteRec&&!voiceNoteStillHeld())return;event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',voiceNoteLeave);}
 if(!on&&voiceNoteLeave){window.removeEventListener('beforeunload',voiceNoteLeave);voiceNoteLeave=null;}
}
function voiceNoteStillHeld(){for(const state of voiceNoteStates.values())if(state.upload)return true;return false;}
function voiceNoteMicMessage(error){
 const name=error?.name||'';
 if(name==='NotAllowedError'||name==='SecurityError'||name==='PermissionDeniedError')return 'Allow the microphone for this site in your browser, then press Record again.';
 if(name==='NotFoundError'||name==='DevicesNotFoundError'||name==='OverconstrainedError')return 'No microphone was found. Plug one in and press Record again.';
 return 'The microphone could not be started. Check it and press Record again.';
}
async function voiceNoteRecord(id){
 const state=voiceNoteState(id),account=me;state.error='';
 if(state.mode==='encounter'&&!state.consent)return;
 if(typeof navigator==='undefined'||!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){state.error='This browser cannot record. Use a current version of Chrome, Edge, Safari or Firefox.';voiceNotePaint(id);return;}
 let stream;
 try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
 catch(error){state.error=voiceNoteMicMessage(error);voiceNotePaint(id);return;}
 if(me!==account||voiceNoteRec){stream.getTracks().forEach(track=>track.stop());return;}
 const type=voiceNotePickType();
 let recorder;
 try{recorder=type?new MediaRecorder(stream,{mimeType:type}):new MediaRecorder(stream);}
 catch{stream.getTracks().forEach(track=>track.stop());state.error='This browser cannot record. Use a current version of Chrome, Edge, Safari or Firefox.';voiceNotePaint(id);return;}
 const rec={visitId:id,account,stream,recorder,chunks:[],mode:state.mode,consent:state.consent,startedAt:Date.now(),pausedTotal:0,pausedAt:0,paused:false,canPause:typeof recorder.pause==='function',type:recorder.mimeType||type||'',discard:false,autoStopped:false};
 recorder.ondataavailable=event=>{if(event.data&&event.data.size>0)rec.chunks.push(event.data);};
 recorder.onstop=()=>voiceNoteFinished(rec);
 const Ctx=typeof AudioContext!=='undefined'?AudioContext:typeof webkitAudioContext!=='undefined'?webkitAudioContext:null;
 if(Ctx){try{rec.audio=new Ctx();rec.analyser=rec.audio.createAnalyser();rec.analyser.fftSize=64;rec.audio.createMediaStreamSource(stream).connect(rec.analyser);rec.levels=new Uint8Array(rec.analyser.frequencyBinCount);rec.meterTimer=setInterval(()=>voiceNoteMeter(rec),90);}catch{rec.analyser=null;}}
 voiceNoteRec=rec;state.confirmDiscard=false;
 recorder.start(1000);
 voiceNoteLeaveGuard(true);voiceNotePaint(id);
}
function voiceNoteMeter(rec){
 if(!rec.analyser||rec.paused)return;
 const bars=typeof document!=='undefined'?document.querySelectorAll?.('[data-voice-bar]'):null;if(!bars||!bars.length)return;
 rec.analyser.getByteFrequencyData(rec.levels);
 const step=Math.max(1,Math.floor(rec.levels.length/bars.length));
 bars.forEach((bar,index)=>{let peak=0;for(let i=index*step;i<(index+1)*step&&i<rec.levels.length;i++)peak=Math.max(peak,rec.levels[i]);bar.style.height=`${Math.max(4,Math.round(peak/255*34))}px`;});
}
function voiceNoteEnsureTicker(){
 if(voiceNoteTicker)return;
 voiceNoteTicker=setInterval(voiceNoteTick,1000);
}
function voiceNoteTick(){
 const rec=voiceNoteRec;
 if(rec){
  if(rec.account!==me){rec.discard=true;voiceNoteEnd(rec);}
  else{
   const seconds=voiceNoteRecSeconds(rec);
   if(seconds>=voiceNoteMaxSeconds&&!rec.autoStopped){rec.autoStopped=true;voiceNoteStop(true);}
   else if(typeof document!=='undefined'&&activeVisit?.id===rec.visitId)for(const node of document.querySelectorAll?.('[data-voice-timer]')||[])node.textContent=voiceNoteMmss(seconds);
  }
 }
 const id=activeVisit?.id,state=id?voiceNoteStates.get(id):null;
 if(state&&typeof document!=='undefined'){
  const item=voiceNoteCurrent(state);
  if(item&&voiceNoteWorking(item))for(const node of document.querySelectorAll?.('[data-voice-elapsed]')||[])node.textContent=voiceNoteElapsedText(item,state);
 }
 if(!rec&&!(state&&state.items.some(voiceNoteWorking))){clearInterval(voiceNoteTicker);voiceNoteTicker=null;}
}
function voiceNoteEnd(rec){
 voiceNoteStopTracks(rec);
 try{if(rec.recorder.state!=='inactive')rec.recorder.stop();}catch{/* Already stopped. */}
 if(voiceNoteRec===rec)voiceNoteRec=null;
 voiceNoteLeaveGuard(voiceNoteStillHeld());
}
function voiceNoteStop(auto=false){
 const rec=voiceNoteRec;if(!rec)return;
 rec.finishing=true;
 if(rec.paused){rec.pausedTotal+=Date.now()-rec.pausedAt;rec.paused=false;}
 rec.seconds=Math.min(voiceNoteMaxSeconds,Math.round((Date.now()-rec.startedAt-rec.pausedTotal)/1000));
 const state=voiceNoteState(rec.visitId);
 if(auto){state.error='';if(typeof notice==='function')notice('The recording reached 30 minutes and was stopped and saved.');}
 try{if(rec.recorder.state!=='inactive')rec.recorder.stop();else voiceNoteFinished(rec);}catch{voiceNoteFinished(rec);}
 voiceNoteStopTracks(rec);
}
function voiceNoteFinished(rec){
 if(rec.done)return;rec.done=true;
 voiceNoteStopTracks(rec);
 if(voiceNoteRec===rec)voiceNoteRec=null;
 const id=rec.visitId,state=voiceNoteState(id);
 if(rec.discard||rec.account!==me){voiceNoteLeaveGuard(voiceNoteStillHeld());voiceNotePaint(id);return;}
 const type=(rec.chunks[0]&&rec.chunks[0].type)||rec.type||'audio/webm';
 const blob=new Blob(rec.chunks,{type});
 const seconds=rec.seconds??Math.round((Date.now()-rec.startedAt-rec.pausedTotal)/1000);
 const ext=/mp4/.test(type)?'m4a':/ogg/.test(type)?'ogg':'webm';
 state.upload={status:'sending',progress:0,blob,mode:rec.mode,consent:rec.consent,duration:Math.max(1,seconds),filename:`voice-note.${ext}`,message:''};
 state.confirmDiscard=false;
 voiceNoteLeaveGuard(true);voiceNotePaint(id);void voiceNoteUpload(id);
}
function voiceNotePause(resume){
 const rec=voiceNoteRec;if(!rec||!rec.canPause)return;
 try{
  if(resume){rec.recorder.resume();rec.pausedTotal+=Date.now()-rec.pausedAt;rec.paused=false;}
  else{rec.recorder.pause();rec.pausedAt=Date.now();rec.paused=true;}
 }catch{return;}
 voiceNotePaint(rec.visitId);
}
function voiceNoteDiscard(){const rec=voiceNoteRec;if(!rec)return;rec.discard=true;voiceNoteState(rec.visitId).confirmDiscard=false;voiceNoteEnd(rec);voiceNotePaint(rec.visitId);}
// ---- Upload ----
function voiceNoteFormData(up){
 const form=new FormData();
 form.append('audio',up.blob,up.filename);form.append('mode',up.mode);
 if(up.mode==='encounter')form.append('consent','true');
 form.append('duration_seconds',String(up.duration));
 return form;
}
function voiceNoteSend(id,up,onProgress){
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();
  xhr.open('POST',`/api/v1/visits/${id}/voice-notes`);
  if(me?.tenant_id&&me?.user_id)xhr.setRequestHeader('X-SunCharts-Staff-Context',`${me.tenant_id}:${me.user_id}`);
  xhr.withCredentials=true;
  if(xhr.upload)xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(event.loaded/event.total);};
  xhr.onerror=()=>reject(new Error('Connection interrupted. Your recording is kept here. Try again.'));
  xhr.onload=()=>{
   let data={};try{data=JSON.parse(xhr.responseText||'{}');}catch{/* Not JSON. */}
   if(xhr.status>=200&&xhr.status<300)resolve(data);
   else{
    const error=new Error(xhr.status===413?'The recording is too large to save.':data.message||'The recording could not be saved.');
    error.status=xhr.status;reject(error);
   }
  };
  xhr.send(voiceNoteFormData(up));
 });
}
async function voiceNoteUpload(id){
 const state=voiceNoteState(id),up=state.upload,account=me;if(!up)return;
 up.status='sending';up.progress=0;up.message='';voiceNotePaint(id);
 try{
  const item=await voiceNoteSend(id,up,fraction=>{up.progress=fraction;const bar=typeof document!=='undefined'?document.querySelector?.('[data-voice-progress]'):null;if(bar)bar.style.width=`${Math.round(fraction*100)}%`;});
  if(me!==account)return;
  if(up.url&&typeof URL!=='undefined')try{URL.revokeObjectURL(up.url);}catch{/* Ignore. */}
  state.upload=null;state.showRecorder=false;state.error='';
  state.items=[item,...state.items.filter(entry=>entry.id!==item.id)];state.available=true;
  voiceNoteLeaveGuard(voiceNoteStillHeld());voiceNotePaint(id);
  if(typeof motionFlash==='function'&&voiceNoteHost())motionFlash(voiceNoteHost());
 }catch(error){
  if(me!==account)return;
  if(error?.status===401&&typeof signInScreen==='function'){signInScreen();return;}
  up.status='failed';up.message=error.message||'The recording could not be saved.';
  if(!up.url&&typeof URL!=='undefined'&&URL.createObjectURL)try{up.url=URL.createObjectURL(up.blob);}catch{/* No download link. */}
  voiceNotePaint(id);
 }
}
// ---- Transcript and other actions ----
function voiceNoteTranscriptMarkup(item){
 const audio=item.file_id&&selected?`<audio controls preload="none" src="/api/v1/patients/${encodeURIComponent(selected)}/documents/${encodeURIComponent(item.file_id)}/download"></audio>`:'';
 return `<div class="voice-transcript">${audio}<p data-voice-transcript>${esc(item.transcript||'There is no transcript for this recording.')}</p></div>`;
}
function voiceNoteTranscript(id){
 const item=voiceNoteCurrent(voiceNoteState(id));if(!item||typeof sheetOpen!=='function')return;
 const node=document.createElement('div');node.innerHTML=voiceNoteTranscriptMarkup(item);
 sheetOpen('Transcript',node,{className:'chart-record-sheet',label:true});
}
async function voiceNotePost(id,item,action){
 const account=me;
 try{
  const data=await api(`/api/v1/visits/${id}/voice-notes/${item.id}/${action}`,'POST',{});
  if(me!==account)return;
  if(data&&data.id){const state=voiceNoteState(id);state.items=state.items.map(entry=>entry.id===data.id?data:entry);}
  else if(action==='dismiss')item.dismissed=true;
  voiceNotePaint(id);
  if(action==='retry')void voiceNoteRefresh(id);
 }catch(error){if(me===account&&typeof notice==='function')notice(error.message,true);}
}
function voiceNoteClick(event){
 const button=event.target?.closest?.('[data-voice-action],[data-voice-mode]');if(!button)return;
 const id=activeVisit?.id;if(!id||!voiceNoteMayAsk()||activeVisit.status==='signed')return;
 const dialog=button.closest?.('dialog.voice-review-sheet');
 if(dialog&&(!voiceNoteReview||voiceNoteReview.dialog!==dialog||!voiceNoteReviewCurrent(voiceNoteReview)))return;
 const state=voiceNoteState(id),action=button.dataset?.voiceAction,mode=button.dataset?.voiceMode;
 if(mode){state.mode=mode;if(mode!=='encounter')state.consent=false;state.error='';voiceNotePaint(id);return;}
 const item=voiceNoteCurrent(state),key=button.dataset?.key;
 switch(action){
  case 'record':void voiceNoteRecord(id);break;
  case 'stop':voiceNoteStop();break;
  case 'pause':voiceNotePause(false);break;
  case 'resume':voiceNotePause(true);break;
  case 'discard':state.confirmDiscard=true;voiceNotePaint(id);break;
  case 'discard-no':state.confirmDiscard=false;voiceNotePaint(id);break;
  case 'discard-yes':voiceNoteDiscard();break;
  case 'upload-retry':void voiceNoteUpload(id);break;
  case 'upload-drop':if(state.upload?.url&&typeof URL!=='undefined')try{URL.revokeObjectURL(state.upload.url);}catch{/* Ignore. */}state.upload=null;voiceNoteLeaveGuard(voiceNoteStillHeld());voiceNotePaint(id);break;
  case 'review':voiceNoteOpenReview(id);break;
  case 'recording':voiceNoteOpenReview(id,true);break;
  case 'toggle-reviewed':if(voiceNoteReview){voiceNoteReview.expanded=!voiceNoteReview.expanded;voiceNoteRefreshReview();}break;
  case 'use':voiceNoteUse(id,key,'replace');break;
  case 'add':voiceNoteUse(id,key,'add');break;
  case 'use-all':voiceNoteUseAll(id);break;
  case 'dismiss-card':if(item)state.dismissedCards.add(`${item.id}:${key}`);voiceNotePaint(id);break;
  case 'transcript':voiceNoteTranscript(id);break;
  case 'record-another':state.showRecorder=true;voiceNotePaint(id);break;
  case 'retry':if(item)void voiceNotePost(id,item,'retry');break;
  case 'dismiss':if(item)void voiceNotePost(id,item,'dismiss');break;
 }
}
function voiceNoteChange(event){
 const box=event.target?.closest?.('[data-voice-consent]');if(!box)return;
 const id=activeVisit?.id;if(!id)return;
 voiceNoteState(id).consent=Boolean(box.checked);voiceNotePaint(id);
}
// Typing can resolve a matching suggestion. Refresh the compact count only when it changes.
function voiceNoteInput(event){
 const name=event.target?.getAttribute?.('name')||event.target?.name;
 if(!voiceNoteKeys.includes(name))return;
 const id=activeVisit?.id,state=voiceNoteStates.get(id),item=state&&voiceNoteCurrent(state);
 if(item?.stage!=='ready')return;
 const button=voiceNoteHost()?.querySelector?.('[data-voice-pending-count]');
 const pending=voiceNoteReviewRows(state,item).filter(row=>!row.status).length;
 if(button&&Number(button.dataset.voicePendingCount)!==pending)voiceNotePaint(id);else voiceNoteRefreshReview();
}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('click',voiceNoteClick);
 document.addEventListener('change',voiceNoteChange);
 document.addEventListener('input',voiceNoteInput);
}
if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('pagehide',()=>{if(voiceNoteRec){voiceNoteRec.discard=true;voiceNoteEnd(voiceNoteRec);}});
