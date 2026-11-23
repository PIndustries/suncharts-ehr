// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// SunCharts AI reads the encounter's note and suggests diagnosis codes. The request waits in line
// with the assistant, so asking returns at once and the clinician is told when the answer is ready.
// Nothing is added to the encounter until a person ticks a suggestion and chooses Add selected.
const diagnosisSuggestStates=new Map();
let diagnosisAiStatusCache=null;
const diagnosisSuggestUuid=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g,()=>Math.floor(Math.random()*16).toString(16));
const diagnosisSuggestPoll=new Map();
function diagnosisSuggestMayAsk(){return ['owner','clinician'].includes(me?.role)&&!me?.delegated;}
// Whether SunCharts AI is switched on is asked once per sign-in and remembered.
function diagnosisAiAvailable(){
 if(!diagnosisAiStatusCache||diagnosisAiStatusCache.account!==me)diagnosisAiStatusCache={account:me,read:api('/api/v1/ai/local-status').then(status=>status?.available===true,()=>false)};
 return diagnosisAiStatusCache.read;
}
function diagnosisSuggestState(id){let state=diagnosisSuggestStates.get(id);if(!state){state={status:'idle',position:0,suggestions:null,picked:new Set(),message:'',noteChanged:false,hydrated:false,account:me};diagnosisSuggestStates.set(id,state);}return state;}
function diagnosisSuggestApply(state,data){
 state.requestId=data.request_id||null;state.patientId=data.patient_id||state.patientId;state.number=data.encounter_number||state.number;
 state.unmatched=Array.isArray(data.unmatched)?data.unmatched:[];state.mine=data.mine!==false;state.noteChanged=data.note_changed===true;state.dropped=data.dropped||0;
 if(data.status==='queued'){state.status='queued';state.position=Number(data.position)||0;}
 else if(data.status==='ready'){if(state.status!=='ready'){state.picked=new Set();}state.status='ready';state.suggestions=Array.isArray(data.suggestions)?data.suggestions:[];}
 else if(data.status==='failed'){state.status='failed';state.message='The assistant could not read the note. Try again.';}
 else state.status='idle';
}
// Problems the note states for which no code was chosen, so the person knows they were read.
function diagnosisSuggestUnmatchedMarkup(state){
 const items=(state.unmatched||[]).filter(item=>item&&item.problem);
 if(!items.length)return '';
 return `<div class="muted" data-diagnosis-suggest-unmatched><p>No code found for:</p><ul>${items.map(item=>`<li>${esc(item.problem)}${item.evidence?` <small>“${esc(item.evidence)}”</small>`:''}</li>`).join('')}</ul><p><small>Use the code search above to add these.</small></p></div>`;
}
function diagnosisSuggestMarkup(id,state){
 const ask=`<button type="button" data-diagnosis-suggest-ask>Suggest from the note</button>`;
 let body='';
 if(state.status==='asking')body=`<button type="button" disabled>Suggest from the note</button><p class="muted" role="status">Sending the note…</p>`;
 else if(state.status==='queued')body=`<p class="muted" role="status" data-diagnosis-suggest-waiting>Reading the note. You can keep working; you’ll be told when the suggestions are ready.${state.position>0?` <span data-diagnosis-suggest-place>${esc(String(state.position))} ahead of you</span>`:''}</p>`;
 else if(state.status==='failed'||state.status==='error')body=`${ask}<p role="alert" data-diagnosis-suggest-error>${esc(state.message||'The assistant could not read the note. Try again.')}</p>`;
 else if(state.status==='ready'&&state.noteChanged)body=`<p role="status" data-diagnosis-suggest-stale>The note changed. Suggest again.</p><div class="actions">${ask}<button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div>`;
 else if(state.status==='ready'&&!(state.suggestions||[]).length)body=`<p class="muted" data-diagnosis-suggest-empty>No codes found in the note.</p>${diagnosisSuggestUnmatchedMarkup(state)}<div class="actions">${ask}<button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div>`;
 else if(state.status==='ready')body=`<ul class="diagnosis-suggest-list">${state.suggestions.map((item,index)=>`<li><label><input type="checkbox" data-diagnosis-suggest-pick="${index}" ${state.picked.has(index)?'checked':''}> <span class="codes-strip-code">${esc(item.code)}</span> ${esc(item.description)}</label><small class="muted">${item.evidence_found&&item.evidence?`“${esc(item.evidence)}”`:'No matching sentence found in the note'}</small></li>`).join('')}</ul>${diagnosisSuggestUnmatchedMarkup(state)}<div class="actions"><button type="button" data-diagnosis-suggest-add>Add selected</button><button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div><p class="muted"><small>Suggestions come from SunCharts AI. Check each one against the note.</small></p>`;
 else body=ask;
 return `<section data-diagnosis-suggest aria-label="Diagnosis suggestions"><h4>Diagnosis suggestions</h4>${state.message&&state.status==='ready'?`<p role="alert">${esc(state.message)}</p>`:''}${body}</section>`;
}
function diagnosisSuggestPaint(id){
 const host=$('visit-diagnoses'),state=diagnosisSuggestStates.get(id);
 if(!host||!state||activeVisit?.id!==id||state.account!==me)return;
 host.querySelector?.('[data-diagnosis-suggest]')?.remove();
 const slot=document.createElement('div');slot.innerHTML=diagnosisSuggestMarkup(id,state);
 const section=slot.firstElementChild||slot;
 const anchor=host.querySelector?.('details');
 if(anchor)anchor.before(section);else host.append(section);
}
function diagnosisSuggestSchedulePoll(id){
 clearTimeout(diagnosisSuggestPoll.get(id));diagnosisSuggestPoll.delete(id);
 const state=diagnosisSuggestStates.get(id);
 // The live notice normally arrives first; this is only a safety net while the editor stays open.
 if(state?.status==='queued')diagnosisSuggestPoll.set(id,setTimeout(()=>{void diagnosisSuggestRefresh(id);},30000));
}
async function diagnosisSuggestRefresh(id,{announce=false}={}){
 const account=me,state=diagnosisSuggestState(id),before=state.status;
 let data;try{data=await api(`/api/v1/visits/${id}/diagnosis-suggestions`);}catch{return null;}
 if(me!==account)return null;
 state.hydrated=true;diagnosisSuggestApply(state,data);
 diagnosisSuggestPaint(id);diagnosisSuggestSchedulePoll(id);
 if(announce&&before!=='ready'&&(data.status==='ready'||data.status==='failed')&&data.mine!==false&&!($('visit-diagnoses')&&activeVisit?.id===id))diagnosisSuggestNotice(id,state,data.status);
 return data;
}
function diagnosisSuggestNotice(id,state,status){
 const number=typeof encounterNumberText==='function'?encounterNumberText({encounter_number:state.number}):'';
 notice(status==='ready'?`Diagnosis suggestions are ready for ${number||'an encounter you asked about'}.`:`The assistant could not read the note${number?` for ${number}`:''}. Try again.`,status!=='ready');
 const holder=$('notice');
 if(status==='ready'&&holder?.append&&typeof document?.createElement==='function'){
  const button=document.createElement('button');button.type='button';button.textContent='Open diagnoses';button.setAttribute('data-diagnosis-suggest-open',id);button.dataset.visitId=id;button.dataset.patientId=state.patientId||'';
  holder.append(' ',button);
 }
}
async function diagnosisSuggestOpen(visitId,patientId){
 if(patientId&&selected!==patientId)await selectPatient(patientId,visitId);
 else if(activeVisit?.id!==visitId)await openPatientEncounter(visitId);
 if(typeof openEncounterStep==='function')openEncounterStep('diagnoses');
}
// The live feed names the encounter and whether the assistant finished. Only people who may ask read
// the answer, and the screen then decides whether to show it in place or tell the person.
function diagnosisSuggestionsEvent(action,visitId){
 if(!diagnosisSuggestMayAsk())return;
 void diagnosisAiAvailable().then(available=>{if(available)void diagnosisSuggestRefresh(visitId,{announce:true});});
}
// Called each time the diagnoses editor is drawn.
function diagnosisSuggestionsMount(host,data,id,patient){
 if(!diagnosisSuggestMayAsk()||!data.can_edit||data.version!==activeVisit?.version)return;
 void diagnosisAiAvailable().then(available=>{
  if(!available||activeVisit?.id!==id||selected!==patient||$('visit-diagnoses')!==host)return;
  const state=diagnosisSuggestState(id);state.patientId=patient;
  if(state.account!==me){diagnosisSuggestStates.delete(id);return;}
  diagnosisSuggestPaint(id);
  if(!state.hydrated)void diagnosisSuggestRefresh(id);
 });
}
async function diagnosisSuggestAsk(id){
 const account=me,state=diagnosisSuggestState(id);
 state.status='asking';state.message='';diagnosisSuggestPaint(id);
 try{
  const data=await api(`/api/v1/visits/${id}/diagnosis-suggestions`,'POST',{request_id:diagnosisSuggestUuid()});
  if(me!==account)return;
  state.status='queued';state.position=Number(data.position)||0;state.requestId=data.request_id;state.suggestions=null;state.noteChanged=false;state.picked=new Set();
  diagnosisSuggestSchedulePoll(id);
 }catch(error){
  if(me!==account)return;
  state.status='error';state.message=error.message||'The assistant could not read the note. Try again.';
 }
 diagnosisSuggestPaint(id);
}
async function diagnosisSuggestDismiss(id){
 const state=diagnosisSuggestState(id);
 try{await api(`/api/v1/visits/${id}/diagnosis-suggestions/dismiss`,'POST',{});}catch{}
 state.status='idle';state.suggestions=null;state.picked=new Set();state.noteChanged=false;state.message='';
 clearTimeout(diagnosisSuggestPoll.get(id));diagnosisSuggestPaint(id);
}
function diagnosisSuggestAdd(id){
 const state=diagnosisSuggestState(id);
 if(state.noteChanged){state.message='The note changed. Suggest again.';diagnosisSuggestPaint(id);return;}
 const chosen=(state.suggestions||[]).filter((item,index)=>state.picked.has(index));
 if(!chosen.length){state.message='Tick the codes to add.';diagnosisSuggestPaint(id);return;}
 // Each ticked code joins the list through the same path as a code picked in the type-ahead, in order.
 let added=0;
 for(const item of chosen)if(visitDiagnosisAppendRow({code:item.code,display:item.description,catalog_release_id:item.catalog_release_id}))added++;
 if(!added){state.message='Those codes could not be added. Reload the encounter and try again.';diagnosisSuggestPaint(id);return;}
 void diagnosisSuggestDismiss(id);
}
document.addEventListener('click',event=>{
 const target=event.target?.closest?.('[data-diagnosis-suggest-ask],[data-diagnosis-suggest-add],[data-diagnosis-suggest-dismiss],[data-diagnosis-suggest-open]');if(!target)return;
 const id=activeVisit?.id;
 if(target.hasAttribute('data-diagnosis-suggest-open')){event.preventDefault();const visit=target.dataset.visitId,patient=target.dataset.patientId;run(async()=>{await diagnosisSuggestOpen(visit,patient);});return;}
 if(!id)return;event.preventDefault();
 if(target.hasAttribute('data-diagnosis-suggest-ask'))void diagnosisSuggestAsk(id);
 else if(target.hasAttribute('data-diagnosis-suggest-add'))diagnosisSuggestAdd(id);
 else void diagnosisSuggestDismiss(id);
});
document.addEventListener('change',event=>{
 const box=event.target?.closest?.('[data-diagnosis-suggest-pick]');if(!box||!activeVisit?.id)return;
 const state=diagnosisSuggestState(activeVisit.id),index=Number(box.getAttribute('data-diagnosis-suggest-pick'));
 if(box.checked)state.picked.add(index);else state.picked.delete(index);
});
