// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// SunCharts AI reads the encounter's note and suggests diagnosis codes and procedure codes. The
// request waits in line with the assistant, so asking returns at once and the clinician is told when
// the answer is ready. Nothing is added to the encounter until a person ticks a suggestion and
// chooses Add selected; a ticked procedure is added to the charge table like a code typed there.
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
function diagnosisSuggestState(id){let state=diagnosisSuggestStates.get(id);if(!state){state={status:'idle',position:0,suggestions:null,procedures:[],proceduresUnmatched:[],picked:new Set(),pickedProcedures:new Set(),message:'',noteChanged:false,hydrated:false,account:me};diagnosisSuggestStates.set(id,state);}return state;}
function diagnosisSuggestApply(state,data){
 state.requestId=data.request_id||null;state.patientId=data.patient_id||state.patientId;state.number=data.encounter_number||state.number;
 state.unmatched=Array.isArray(data.unmatched)?data.unmatched:[];state.mine=data.mine!==false;state.noteChanged=data.note_changed===true;state.dropped=data.dropped||0;
 if(data.status==='queued'){state.status='queued';state.position=Number(data.position)||0;}
 else if(data.status==='ready'){if(state.status!=='ready'){state.picked=new Set();state.pickedProcedures=new Set();}state.status='ready';state.suggestions=Array.isArray(data.suggestions)?data.suggestions:[];state.procedures=Array.isArray(data.procedures)?data.procedures:[];state.proceduresUnmatched=Array.isArray(data.procedures_unmatched)?data.procedures_unmatched:[];}
 else if(data.status==='failed'){state.status='failed';state.message='The assistant could not read the note. Try again.';}
 else state.status='idle';
}
// Problems the note states for which no code was chosen, so the person knows they were read.
function diagnosisSuggestUnmatchedMarkup(state){
 const items=(state.unmatched||[]).filter(item=>item&&item.problem);
 if(!items.length)return '';
 return `<div class="muted" data-diagnosis-suggest-unmatched><p>No code found for:</p><ul>${items.map(item=>`<li>${esc(item.problem)}${item.evidence?` <small>“${esc(item.evidence)}”</small>`:''}</li>`).join('')}</ul><p><small>Use the code search above to add these.</small></p></div>`;
}
// Whether a ticked procedure can be added: the encounter's charge table is open and takes lines.
// Charges that are posted are corrected from Billing, so there the procedures are only shown.
function diagnosisSuggestChargeGate(){
 const form=typeof $==='function'?$('billing-account-form'):null;
 if(form&&typeof chargeLinesAppend==='function'&&!form.dataset?.draftReadOnly&&!form.dataset?.draftStale)return {ok:true,why:''};
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 if(account?.status==='posted')return {ok:false,why:'Charges are posted. Add a correction from Billing.'};
 if(typeof billingCan==='function'&&!billingCan('create'))return {ok:false,why:'You do not have permission to change charges.'};
 return {ok:false,why:'Open the charges to add procedures.'};
}
function diagnosisSuggestQuantityText(item){
 const amount=Number(item.quantity);if(!(amount>0))return '';
 return `${amount} ${item.quantity_unit||''}`.trim()+' given';
}
// Services the note says were done for which no code was chosen. A visit that comes in levels is
// left to the clinician; anything else simply found nothing in the practice's lists.
function diagnosisSuggestProceduresUnmatchedMarkup(state){
 const items=(state.proceduresUnmatched||[]).filter(item=>item&&item.service);
 if(!items.length)return '';
 const level=items.filter(item=>item.reason==='level'),none=items.filter(item=>item.reason!=='level');
 return `<div class="muted" data-diagnosis-suggest-procedures-unmatched>${none.length?`<p>No code found for:</p><ul>${none.map(item=>`<li>${esc(item.service)}${item.evidence?` <small>“${esc(item.evidence)}”</small>`:''}</li>`).join('')}</ul><p><small>Use the procedure box in the charges to add these.</small></p>`:''}${level.length?`<ul data-diagnosis-suggest-level>${level.map(item=>`<li>${esc(item.service)}: choose the visit level yourself.</li>`).join('')}</ul>`:''}</div>`;
}
// Whether a code is already typed into the charge table (saved or not), so it is not offered again.
function diagnosisSuggestOnCharges(code){
 try{
  const form=typeof $==='function'?$('billing-account-form'):null,wanted=String(code??'').trim().toUpperCase();
  if(!form||typeof form.querySelectorAll!=='function'||!wanted)return false;
  return [...form.querySelectorAll('[name="code"]')].some(input=>String(input?.value??'').trim().toUpperCase()===wanted);
 }catch{return false;}
}
function diagnosisSuggestProceduresMarkup(state,gate){
 const items=state.procedures||[];
 if(!items.length)return diagnosisSuggestProceduresUnmatchedMarkup(state);
 const rows=items.map((item,index)=>{
  const quantity=diagnosisSuggestQuantityText(item),text=`<span class="codes-strip-code">${esc(item.code)}</span> ${esc(item.description)}`,onCharges=diagnosisSuggestOnCharges(item.code);
  return `<li>${gate.ok?`<label><input type="checkbox" data-diagnosis-suggest-pick-procedure="${index}" ${!onCharges&&state.pickedProcedures.has(index)?'checked':''}${onCharges?' disabled':''}> ${text}</label>`:`<span>${text}</span>`}<small class="muted">${item.evidence_found&&item.evidence?`“${esc(item.evidence)}”`:'No matching sentence found in the note'}</small>${quantity?`<small class="muted" data-diagnosis-suggest-quantity>${esc(quantity)}</small>`:''}${onCharges?`<small class="muted" data-diagnosis-suggest-on-charges>Already on the charges</small>`:''}</li>`;
 }).join('');
 return `<h5>Procedures</h5>${gate.ok?'':`<p class="muted" data-diagnosis-suggest-charges-note>${esc(gate.why)}</p>`}<ul class="diagnosis-suggest-list" data-diagnosis-suggest-procedures>${rows}</ul>${diagnosisSuggestProceduresUnmatchedMarkup(state)}`;
}
function diagnosisSuggestMarkup(id,state){
 const ask=`<button type="button" data-diagnosis-suggest-ask>Suggest codes</button>`;
 let body='';
 const found=(state.suggestions||[]).length+(state.procedures||[]).length;
 if(state.status==='asking')body=`<button type="button" disabled>Suggest codes</button><p class="muted" role="status">Sending the note…</p>`;
 else if(state.status==='queued')body=`<p class="muted" role="status" data-diagnosis-suggest-waiting>Reading the note. You can keep working; you’ll be told when the suggestions are ready.${state.position>0?` <span data-diagnosis-suggest-place>${esc(String(state.position))} ahead of you</span>`:''}</p>`;
 else if(state.status==='failed'||state.status==='error')body=`${ask}<p role="alert" data-diagnosis-suggest-error>${esc(state.message||'The assistant could not read the note. Try again.')}</p>`;
 else if(state.status==='ready'&&state.noteChanged)body=`<p role="status" data-diagnosis-suggest-stale>The note changed. Suggest again.</p><div class="actions">${ask}<button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div>`;
 else if(state.status==='ready'&&!found)body=`<p class="muted" data-diagnosis-suggest-empty>No codes found in the note.</p>${diagnosisSuggestUnmatchedMarkup(state)}${diagnosisSuggestProceduresUnmatchedMarkup(state)}<div class="actions">${ask}<button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div>`;
 else if(state.status==='ready'){
  const gate=diagnosisSuggestChargeGate(),diagnoses=state.suggestions||[],both=diagnoses.length&&((state.procedures||[]).length||(state.proceduresUnmatched||[]).length);
  const list=diagnoses.length?`${both?'<h5>Diagnoses</h5>':''}<ul class="diagnosis-suggest-list">${diagnoses.map((item,index)=>`<li><label><input type="checkbox" data-diagnosis-suggest-pick="${index}" ${state.picked.has(index)?'checked':''}> <span class="codes-strip-code">${esc(item.code)}</span> ${esc(item.description)}</label><small class="muted">${item.evidence_found&&item.evidence?`“${esc(item.evidence)}”`:'No matching sentence found in the note'}</small></li>`).join('')}</ul>`:'';
  body=`${list}${diagnosisSuggestUnmatchedMarkup(state)}${diagnosisSuggestProceduresMarkup(state,gate)}<div class="actions"><button type="button" class="primary" data-diagnosis-suggest-add>Add selected</button><button type="button" class="text-button" data-diagnosis-suggest-all>Tick all</button><button type="button" class="text-button" data-diagnosis-suggest-ask>Suggest codes again</button><button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div><p class="muted"><small>Suggestions come from SunCharts AI and are read from the saved note. Check each one against the note. If you change the note, save it and press Suggest codes again.</small></p>`;
 }
 else body=`${ask}<p class="muted"><small>Reads the saved note and proposes diagnosis and procedure codes for you to tick. Nothing is added until you choose.</small></p>`;
 return `<section data-diagnosis-suggest aria-label="Code suggestions"><h4>Code suggestions</h4>${state.message&&state.status==='ready'?`<p role="alert">${esc(state.message)}</p>`:''}${body}</section>`;
}
// The button beside Save note, and a short line saying where the suggestions stand.
function diagnosisSuggestCountText(diagnoses,procedures){
 const parts=[];
 if(diagnoses)parts.push(`${diagnoses} ${diagnoses===1?'diagnosis':'diagnoses'}`);
 if(procedures)parts.push(`${procedures} ${procedures===1?'procedure':'procedures'}`);
 return parts.length?`${parts.join(' and ')} ready`:'No codes found';
}
function diagnosisSuggestNoteSync(id){
 const button=typeof document!=='undefined'?document.querySelector?.('[data-note-suggest]'):null,line=typeof document!=='undefined'?document.querySelector?.('[data-note-suggest-status]'):null;
 if(!button||activeVisit?.id!==id)return;
 const state=diagnosisSuggestStates.get(id);
 button.hidden=false;button.disabled=state?.status==='asking'||state?.status==='queued';
 button.textContent=state?.status==='ready'?'Suggest codes again':'Suggest codes';
 if(!line)return;
 const diagnoses=(state?.suggestions||[]).length,procedures=(state?.procedures||[]).length;
 if(state?.status==='queued'||state?.status==='asking')line.textContent=`Reading the note${state.position>0?` · ${state.position} ahead of you`:''}. You can keep working.`;
 else if(state?.status==='ready'&&state.noteChanged)line.textContent='The note changed since the last suggestions.';
 else if(state?.status==='ready')line.innerHTML=`${diagnosisSuggestCountText(diagnoses,procedures)} · <button type="button" class="text-button" data-note-suggest-review>Review</button>`;
 else if(state?.status==='failed'||state?.status==='error')line.textContent=state.message||'The assistant could not read the note. Try again.';
 else line.textContent='';
}
function diagnosisSuggestEditorOpen(){
 if(typeof encounterCodesEditorOpen==='function')encounterCodesEditorOpen(0,true);
 else if(typeof openEncounterStep==='function')openEncounterStep('diagnoses');
 setTimeout(()=>{document.querySelector?.('[data-diagnosis-suggest]')?.scrollIntoView?.({block:'center'});},400);
}
// Unsaved typing in the note would not be read, so it is saved first.
function diagnosisSuggestNoteDirty(){
 const form=$('note-form'),note=activeVisit?.note||{};if(!form?.elements)return false;
 return ['subjective','objective','assessment','plan','procedure'].some(key=>form.elements[key]&&String(form.elements[key].value||'')!==String(note[key]||''));
}
function diagnosisSuggestPaint(id){
 diagnosisSuggestNoteSync(id);
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
 diagnosisSuggestPaint(id);diagnosisSuggestNoteSync(id);diagnosisSuggestSchedulePoll(id);
 if(announce&&before!=='ready'&&(data.status==='ready'||data.status==='failed')&&data.mine!==false&&!($('visit-diagnoses')&&activeVisit?.id===id))diagnosisSuggestNotice(id,state,data.status);
 return data;
}
function diagnosisSuggestNotice(id,state,status){
 const number=typeof encounterNumberText==='function'?encounterNumberText({encounter_number:state.number}):'';
 notice(status==='ready'?`Code suggestions are ready for ${number||'an encounter you asked about'}.`:`The assistant could not read the note${number?` for ${number}`:''}. Try again.`,status!=='ready');
 const holder=$('notice');
 if(status==='ready'&&holder?.append&&typeof document?.createElement==='function'){
  const button=document.createElement('button');button.type='button';button.textContent='Open codes';button.setAttribute('data-diagnosis-suggest-open',id);button.dataset.visitId=id;button.dataset.patientId=state.patientId||'';
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
// The note's own button appears when the encounter page is drawn, whether or not the codes are open.
function diagnosisSuggestNoteMount(){
 const id=activeVisit?.id;if(!id||!diagnosisSuggestMayAsk()||activeVisit.status==='signed')return;
 void diagnosisAiAvailable().then(available=>{
  if(!available||activeVisit?.id!==id)return;
  const state=diagnosisSuggestState(id);if(state.account!==me){diagnosisSuggestStates.delete(id);return;}
  diagnosisSuggestNoteSync(id);
  if(!state.hydrated)void diagnosisSuggestRefresh(id);
 });
}
if(typeof MutationObserver==='function'&&typeof document!=='undefined'&&document.documentElement)new MutationObserver(()=>{const button=document.querySelector('[data-note-suggest][hidden]');if(button&&!button.dataset.suggestSeen){button.dataset.suggestSeen='1';diagnosisSuggestNoteMount();}}).observe(document.documentElement,{childList:true,subtree:true});
async function diagnosisSuggestAsk(id){
 const account=me,state=diagnosisSuggestState(id);
 state.status='asking';state.message='';diagnosisSuggestPaint(id);
 try{
  const data=await api(`/api/v1/visits/${id}/diagnosis-suggestions`,'POST',{request_id:diagnosisSuggestUuid()});
  if(me!==account)return;
  state.status='queued';state.position=Number(data.position)||0;state.requestId=data.request_id;state.suggestions=null;state.procedures=[];state.proceduresUnmatched=[];state.noteChanged=false;state.picked=new Set();state.pickedProcedures=new Set();
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
 state.status='idle';state.suggestions=null;state.procedures=[];state.proceduresUnmatched=[];state.picked=new Set();state.pickedProcedures=new Set();state.noteChanged=false;state.message='';
 clearTimeout(diagnosisSuggestPoll.get(id));diagnosisSuggestPaint(id);
}
// A ticked procedure becomes a charge line through the same table path a bundle uses: the practice
// price fills in as it does for a typed code, and the encounter's diagnoses are linked by default.
function diagnosisSuggestChargeLine(item){
 const units=Math.trunc(Number(item.default_units));
 return {code_system:item.system||(/^[A-Z]/i.test(item.code)?'HCPCS':'CPT'),code:item.code,description:item.description,modifiers:String(item.modifiers||'').split(/[\s,]+/).filter(Boolean).join(','),units:units>=1?units:1,catalog_release_id:item.catalog_release_id||''};
}
function diagnosisSuggestAdd(id){
 const state=diagnosisSuggestState(id);
 if(state.noteChanged){state.message='The note changed. Suggest again.';diagnosisSuggestPaint(id);return;}
 const chosen=(state.suggestions||[]).filter((item,index)=>state.picked.has(index));
 const procedures=(state.procedures||[]).filter((item,index)=>state.pickedProcedures.has(index)&&!diagnosisSuggestOnCharges(item.code));
 if(!chosen.length&&!procedures.length){state.message='Tick the codes to add.';diagnosisSuggestPaint(id);return;}
 // Each ticked code joins the list through the same path as a code picked in the type-ahead, in order.
 let added=0;
 for(const item of chosen)if(visitDiagnosisAppendRow({code:item.code,display:item.description,catalog_release_id:item.catalog_release_id}))added++;
 if(chosen.length&&!added){state.message='Those codes could not be added. Reload the encounter and try again.';diagnosisSuggestPaint(id);return;}
 if(procedures.length){
  let lines=0;
  if(diagnosisSuggestChargeGate().ok)for(const item of procedures)if(chargeLinesAppend([diagnosisSuggestChargeLine(item)]).length)lines++;
  if(lines<procedures.length){
   // The diagnoses that did go in are not offered again; the procedures stay to be added once the charges are open.
   state.picked=new Set();state.pickedProcedures=new Set();
   state.message='Some procedures could not be added to the charges. Open the charges and try again.';diagnosisSuggestPaint(id);return;
  }
 }
 void diagnosisSuggestDismiss(id);
}
document.addEventListener('click',event=>{
 const target=event.target?.closest?.('[data-diagnosis-suggest-ask],[data-diagnosis-suggest-add],[data-diagnosis-suggest-dismiss],[data-diagnosis-suggest-open],[data-diagnosis-suggest-all],[data-note-suggest],[data-note-suggest-review]');if(!target)return;
 const id=activeVisit?.id;
 if(target.hasAttribute('data-note-suggest-review')){event.preventDefault();diagnosisSuggestEditorOpen();return;}
 if(target.hasAttribute('data-note-suggest')){
  event.preventDefault();if(!id)return;
  if(diagnosisSuggestNoteDirty()){notice('Save the note first. Suggestions are read from the saved note.',true);return;}
  void diagnosisSuggestAsk(id).then(()=>diagnosisSuggestEditorOpen());return;
 }
 if(target.hasAttribute('data-diagnosis-suggest-all')){event.preventDefault();if(!id)return;const state=diagnosisSuggestState(id);state.picked=new Set((state.suggestions||[]).map((item,index)=>index));state.pickedProcedures=diagnosisSuggestChargeGate().ok?new Set((state.procedures||[]).map((item,index)=>index).filter(index=>!diagnosisSuggestOnCharges(state.procedures[index].code))):new Set();diagnosisSuggestPaint(id);return;}
 if(target.hasAttribute('data-diagnosis-suggest-open')){event.preventDefault();const visit=target.dataset.visitId,patient=target.dataset.patientId;run(async()=>{await diagnosisSuggestOpen(visit,patient);});return;}
 if(!id)return;event.preventDefault();
 if(target.hasAttribute('data-diagnosis-suggest-ask'))void diagnosisSuggestAsk(id);
 else if(target.hasAttribute('data-diagnosis-suggest-add'))diagnosisSuggestAdd(id);
 else void diagnosisSuggestDismiss(id);
});
document.addEventListener('change',event=>{
 const box=event.target?.closest?.('[data-diagnosis-suggest-pick],[data-diagnosis-suggest-pick-procedure]');if(!box||!activeVisit?.id)return;
 const state=diagnosisSuggestState(activeVisit.id),procedure=box.hasAttribute?.('data-diagnosis-suggest-pick-procedure'),index=Number(box.getAttribute(procedure?'data-diagnosis-suggest-pick-procedure':'data-diagnosis-suggest-pick')),picked=procedure?state.pickedProcedures:state.picked;
 if(box.checked)picked.add(index);else picked.delete(index);
});
