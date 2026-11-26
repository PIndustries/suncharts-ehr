// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// SunCharts AI reads the encounter's note and suggests diagnosis codes and procedure codes. The
// request waits in line with the assistant, so asking returns at once and the panel shows each step as it
// happens. Nothing is added to the encounter until a person ticks a suggestion and
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
 const fresh=data.request_id!==state.requestId;
 state.requestId=data.request_id||null;state.patientId=data.patient_id||state.patientId;state.number=data.encounter_number||state.number;
 state.unmatched=Array.isArray(data.unmatched)?data.unmatched:[];state.mine=data.mine!==false;state.noteChanged=data.note_changed===true;state.dropped=data.dropped||0;
 if(data.status==='queued'){
  state.status='queued';state.position=Number(data.position)||0;state.stage=data.stage==='choose'?'choose':'extract';
  state.problemsFound=Number(data.problems_found)||0;state.servicesFound=Number(data.services_found)||0;
  if(fresh||!state.startedAt){const at=Date.parse(data.started_at);state.startedAt=Number.isFinite(at)?at:(state.startedAt||Date.now());}
 }
 else if(data.status==='ready'){if(state.status!=='ready'){state.picked=new Set();state.pickedProcedures=new Set();}state.status='ready';state.suggestions=Array.isArray(data.suggestions)?data.suggestions:[];state.procedures=Array.isArray(data.procedures)?data.procedures:[];state.proceduresUnmatched=Array.isArray(data.procedures_unmatched)?data.procedures_unmatched:[];}
 else if(data.status==='failed'){state.status='failed';state.message='The assistant could not read the note. Try again.';}
 else state.status='idle';
}
// Problems the note states for which no code was chosen, so the person knows they were read.
function diagnosisSuggestUnmatchedMarkup(state){
 const items=(state.unmatched||[]).filter(item=>item&&item.problem);
 if(!items.length)return '';
 return `<div class="muted" data-diagnosis-suggest-unmatched><p>No code found for:</p><ul>${items.map(item=>`<li>${esc(item.problem)}${item.evidence?` <small>“${esc(item.evidence)}”</small>`:''}</li>`).join('')}</ul><p><small>Use the diagnosis search in the codes to add these.</small></p></div>`;
}
// Whether a ticked procedure can be added: the encounter's charge table is open and takes lines.
// Charges that are posted are corrected from Billing, so there the procedures are only shown.
function diagnosisSuggestChargeGate(){
 const form=typeof $==='function'?$('billing-account-form'):null;
 if(form&&typeof chargeLinesAppend==='function'&&!form.dataset?.draftReadOnly&&!form.dataset?.draftStale)return {ok:true,why:''};
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 if(account?.status==='posted')return {ok:false,why:'Charges are posted. Add a correction from Billing.'};
 if(typeof billingCan==='function'&&!billingCan('create'))return {ok:false,why:'You do not have permission to change charges.'};
 // The charge table is not drawn yet; adding opens it first.
 if(!form&&typeof encounterCodesEditorOpen==='function')return {ok:true,needsOpen:true,why:''};
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
 return `<div class="muted" data-diagnosis-suggest-procedures-unmatched>${none.length?`<p>No code found for:</p><ul>${none.map(item=>`<li>${esc(item.service)}${item.evidence?` <small>“${esc(item.evidence)}”</small>`:''}</li>`).join('')}</ul><p><small>Use the procedure box in the charges to add these.</small></p>`:''}${level.length?`<ul data-diagnosis-suggest-level>${level.map(item=>`<li>${esc(item.service)}: choose the encounter level yourself.</li>`).join('')}</ul>`:''}</div>`;
}
// Whether a code is already typed into the charge table (saved or not), so it is not offered again.
function diagnosisSuggestOnCharges(code){
 try{
  const form=typeof $==='function'?$('billing-account-form'):null,wanted=String(code??'').trim().toUpperCase();
  if(!form||typeof form.querySelectorAll!=='function'||!wanted)return false;
  return [...form.querySelectorAll('[name="code"]')].some(input=>String(input?.value??'').trim().toUpperCase()===wanted);
 }catch{return false;}
}
function diagnosisSuggestItemRow(kind,item,index,checkbox,state){
 const quantity=kind==='procedure'?diagnosisSuggestQuantityText(item):'',onCharges=kind==='procedure'&&diagnosisSuggestOnCharges(item.code),text=`<span class="codes-strip-code">${esc(item.code)}</span> ${esc(item.description)}`;
 const attr=kind==='procedure'?'data-diagnosis-suggest-pick-procedure':'data-diagnosis-suggest-pick',picked=kind==='procedure'?state.pickedProcedures:state.picked;
 const quote=`<small class="muted diagnosis-suggest-quote">${item.evidence_found&&item.evidence?`“${esc(item.evidence)}”`:'No matching sentence found in the note'}</small>`;
 return `<li>${checkbox?`<label><input type="checkbox" ${attr}="${index}" ${!onCharges&&picked.has(index)?'checked':''}${onCharges?' disabled':''}> ${text}</label>`:`<span>${text}</span>`}${quote}${quantity?`<small class="muted" data-diagnosis-suggest-quantity>${esc(quantity)}</small>`:''}${onCharges?`<small class="muted" data-diagnosis-suggest-on-charges>Already on the charges</small>`:''}</li>`;
}
// How many ticked items Add selected would add, so the button can say so.
function diagnosisSuggestPickedCount(state){
 const diagnoses=[...state.picked].filter(index=>(state.suggestions||[])[index]).length;
 const procedures=[...state.pickedProcedures].filter(index=>(state.procedures||[])[index]&&!diagnosisSuggestOnCharges(state.procedures[index].code)).length;
 return diagnoses+procedures;
}
function diagnosisSuggestAddLabel(state){const count=diagnosisSuggestPickedCount(state);return count?`Add ${count} selected`:'Add selected';}
// Live progress: three steps and one line that says what is happening now. The elapsed seconds are
// filled in by a timer so the markup stays the same between polls and the current step keeps glowing.
function diagnosisSuggestWorking(state){return state?.status==='asking'||state?.status==='queued';}
function diagnosisSuggestElapsed(state){
 if(!state?.startedAt)return '';
 const seconds=Math.max(0,Math.floor((Date.now()-state.startedAt)/1000));
 return seconds<60?`${seconds} s`:`${Math.floor(seconds/60)} min ${seconds%60} s`;
}
function diagnosisSuggestFoundText(state){
 const problems=Number(state.problemsFound)||0,services=Number(state.servicesFound)||0,parts=[];
 if(problems)parts.push(`${problems} ${problems===1?'problem':'problems'}`);
 if(services)parts.push(`${services} ${services===1?'service':'services'}`);
 return parts.join(' and ');
}
// The line under the steps, or its short form for the button beside Save note.
function diagnosisSuggestLiveText(state,short=false){
 if(state.status==='asking')return 'Sending the note…';
 if(state.status==='queued'&&state.stage!=='choose'&&state.position>0)return `Waiting for a turn · ${state.position} ahead of you`;
 if(state.stage==='choose'){
  const found=diagnosisSuggestFoundText(state);
  return short||!found?'Choosing codes…':`Found ${found} in the note. Choosing codes…`;
 }
 return 'Reading the note…';
}
function diagnosisSuggestStepsMarkup(state,allDone=false){
 const current=allDone?0:state.stage==='choose'?3:1;
 const steps=[['Reading the note',''],['Finding matching codes',allDone||current===3?'Checked your code lists':''],['Choosing the best fit','']];
 return `<ol class="suggest-steps" data-suggest-steps>${steps.map((step,index)=>{
  const number=index+1,cls=allDone||number<current?'is-done':number===current?'is-now':'is-later';
  return `<li class="${cls}"${number===current?' aria-current="step"':''}><span class="suggest-step-mark" aria-hidden="true">${cls==='is-done'?'✓':number}</span><span class="suggest-step-text"><b>${step[0]}</b><small>${step[1]}</small></span></li>`;
 }).join('')}</ol>`;
}
function diagnosisSuggestWorkingMarkup(state){
 const place=state.status==='queued'&&state.stage!=='choose'&&state.position>0?`Waiting for a turn · <span data-diagnosis-suggest-place>${esc(String(state.position))} ahead of you</span>`:esc(diagnosisSuggestLiveText(state));
 return `${diagnosisSuggestStepsMarkup(state)}<p class="suggest-live" role="status" data-diagnosis-suggest-waiting>${place} <span class="suggest-elapsed" data-suggest-elapsed></span></p>`;
}
function diagnosisSuggestSheetMarkup(id,state){
 const ask='<button type="button" data-diagnosis-suggest-ask>Suggest again</button>',dismiss='<button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button>';
 const wrap=body=>`<div data-diagnosis-suggest data-visit-id="${esc(id)}" class="diagnosis-suggest-sheet">${body}</div>`;
 const alert=state.message?`<p role="alert" data-diagnosis-suggest-error>${esc(state.message)}</p>`:'';
 if(diagnosisSuggestWorking(state))return wrap(diagnosisSuggestWorkingMarkup(state));
 if(state.status==='failed'||state.status==='error')return wrap(`<p role="alert" data-diagnosis-suggest-error>${esc(state.message||'The assistant could not read the note. Try again.')}</p><div class="actions diagnosis-suggest-actions">${ask}</div>`);
 const diagnoses=state.suggestions||[],procedures=state.procedures||[],found=diagnoses.length+procedures.length;
 if(state.noteChanged)return wrap(`<p role="status" data-diagnosis-suggest-stale>The note changed. Suggest again.</p><div class="actions diagnosis-suggest-actions">${ask}${dismiss}</div>`);
 if(!found)return wrap(`<p class="muted" data-diagnosis-suggest-empty>No codes found in the note.</p>${diagnosisSuggestUnmatchedMarkup(state)}${diagnosisSuggestProceduresUnmatchedMarkup(state)}<div class="actions diagnosis-suggest-actions">${ask}${dismiss}</div>`);
 const gate=diagnosisSuggestChargeGate(),hasUnmatched=(state.unmatched||[]).some(item=>item&&item.problem),hasProcedureUnmatched=(state.proceduresUnmatched||[]).some(item=>item&&item.service);
 const diagnosisSection=diagnoses.length||hasUnmatched?`<section class="diagnosis-suggest-section"><h4>Diagnoses</h4>${diagnoses.length?`<p class="muted">Select diagnoses for the encounter</p><ul class="diagnosis-suggest-list">${diagnoses.map((item,index)=>diagnosisSuggestItemRow('diagnosis',item,index,true,state)).join('')}</ul>`:''}${diagnosisSuggestUnmatchedMarkup(state)}</section>`:'';
 const procedureSection=procedures.length||hasProcedureUnmatched?`<section class="diagnosis-suggest-section"><h4>Procedures</h4>${procedures.length?`<p class="muted">Select procedures for the charge draft</p>${gate.ok?'':`<p class="muted" data-diagnosis-suggest-charges-note>${esc(gate.why)}</p>`}<ul class="diagnosis-suggest-list" data-diagnosis-suggest-procedures>${procedures.map((item,index)=>diagnosisSuggestItemRow('procedure',item,index,gate.ok,state)).join('')}</ul>`:''}${diagnosisSuggestProceduresUnmatchedMarkup(state)}</section>`:'';
 return wrap(`<p class="diagnosis-suggest-intro">Read from the saved note. Tick what applies; nothing is added until you choose.</p>${alert}${diagnosisSection}${procedureSection}<div class="actions diagnosis-suggest-actions"><button type="button" class="primary" data-diagnosis-suggest-add>${esc(diagnosisSuggestAddLabel(state))}</button><button type="button" class="text-button" data-diagnosis-suggest-all>Tick all</button><button type="button" class="text-button" data-diagnosis-suggest-ask>Suggest again</button><button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div><p class="muted"><small>Suggestions come from SunCharts AI and are read from the saved note. Check each one against the note. If you change the note, save it and press Suggest again.</small></p>`);
}
// The panel at the top of the codes editor. The list itself opens in a sheet.
function diagnosisSuggestMarkup(id,state){
 const ask='<button type="button" class="primary" data-diagnosis-suggest-ask>Suggest codes</button>',again='<button type="button" data-diagnosis-suggest-ask>Suggest again</button>',dismiss='<button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button>';
 const diagnoses=(state.suggestions||[]).length,procedures=(state.procedures||[]).length,found=diagnoses+procedures;
 let body='',mode='';
 if(diagnosisSuggestWorking(state)){mode='working';body=diagnosisSuggestWorkingMarkup(state);}
 else if(state.status==='failed'||state.status==='error')body=`<p role="alert" data-diagnosis-suggest-error>${esc(state.message||'The assistant could not read the note. Try again.')}</p><div class="actions">${ask}</div>`;
 else if(state.status==='ready'&&state.noteChanged)body=`<p role="status" data-diagnosis-suggest-stale>The note changed. Suggest again.</p><div class="actions">${ask}${dismiss}</div>`;
 else if(state.status==='ready'&&!found)body=`<p class="muted" data-diagnosis-suggest-empty>No codes found in the note.</p><div class="actions">${ask}${dismiss}</div>`;
 else if(state.status==='ready'){mode='ready';body=`${diagnosisSuggestStepsMarkup(state,true)}<p class="suggest-headline" data-diagnosis-suggest-count>${esc(diagnosisSuggestCountText(diagnoses,procedures,'suggested'))}</p><div class="actions"><button type="button" class="primary" data-diagnosis-suggest-review>Review and add</button>${again}${dismiss}</div>`;}
 else body=`<p class="muted">SunCharts AI reads the saved note and suggests diagnosis and procedure codes.</p><div class="actions">${ask}</div>`;
 return `<section data-diagnosis-suggest class="diagnosis-suggest-panel${mode?` is-${mode}`:''}" aria-label="Suggested codes"><h4 class="suggest-title">Suggested codes</h4>${body}</section>`;
}
// The button beside Save note, and a short line saying where the suggestions stand.
function diagnosisSuggestCountText(diagnoses,procedures,word='ready'){
 const parts=[];
 if(diagnoses)parts.push(`${diagnoses} ${diagnoses===1?'diagnosis':'diagnoses'}`);
 if(procedures)parts.push(`${procedures} ${procedures===1?'procedure':'procedures'}`);
 return parts.length?`${parts.join(' and ')} ${word}`:'No codes found';
}
function diagnosisSuggestNoteSync(id){
 const button=typeof document!=='undefined'?document.querySelector?.('[data-note-suggest]'):null,line=typeof document!=='undefined'?document.querySelector?.('[data-note-suggest-status]'):null;
 if(!button||activeVisit?.id!==id)return;
 const state=diagnosisSuggestStates.get(id);
 button.hidden=false;button.disabled=state?.status==='asking'||state?.status==='queued';
 button.textContent=state?.status==='ready'?'Suggest codes again':'Suggest codes';
 if(!line)return;
 const diagnoses=(state?.suggestions||[]).length,procedures=(state?.procedures||[]).length;
 if(diagnosisSuggestWorking(state))line.textContent=`${diagnosisSuggestLiveText(state,true)} ${diagnosisSuggestElapsed(state)}`.trim();
 else if(state?.status==='ready'&&state.noteChanged)line.textContent='The note changed since the last suggestions.';
 else if(state?.status==='ready')line.innerHTML=`${diagnosisSuggestCountText(diagnoses,procedures)} · <button type="button" class="text-button" data-note-suggest-review>Review</button>`;
 else if(state?.status==='failed'||state?.status==='error')line.textContent=state.message||'The assistant could not read the note. Try again.';
 else line.textContent='';
}
function diagnosisSuggestEditorOpen(){
 if(typeof encounterCodesEditorOpen==='function')encounterCodesEditorOpen(0,true);
 else if(typeof openEncounterStep==='function')openEncounterStep('diagnoses');
}
// The list of suggestions opens in a sheet over the page. It is repainted in place when the
// suggestions change, and closing it keeps them.
function diagnosisSuggestSheetIsOpen(state){const sheet=state?.sheet;return !!sheet&&sheet.isConnected!==false&&!sheet.dataset?.closing;}
function diagnosisSuggestSheetClose(state){if(diagnosisSuggestSheetIsOpen(state)&&typeof sheetClose==='function')sheetClose(state.sheet);state.sheet=null;}
function diagnosisSuggestSheetPaint(id){
 const state=diagnosisSuggestStates.get(id);
 if(!state||!diagnosisSuggestSheetIsOpen(state))return;
 if(state.status==='idle'){diagnosisSuggestSheetClose(state);return;}
 const html=diagnosisSuggestSheetMarkup(id,state);
 // A waiting sheet is left alone while nothing in it changed, so the current step keeps glowing.
 if(diagnosisSuggestWorking(state)&&state.sheetHtml===html)return;
 state.sheetHtml=html;
 const slot=document.createElement('div');slot.innerHTML=html;
 const node=slot.firstElementChild||slot,body=state.sheet.querySelector?.('.sheet-body');
 if(body?.replaceChildren)body.replaceChildren(node);
}
function diagnosisSuggestSheetOpen(id){
 const state=diagnosisSuggestStates.get(id);
 if(!state||typeof sheetOpen!=='function')return;
 if(diagnosisSuggestSheetIsOpen(state)){diagnosisSuggestSheetPaint(id);return;}
 const html=diagnosisSuggestSheetMarkup(id,state);state.sheetHtml=html;
 const slot=document.createElement('div');slot.innerHTML=html;
 state.sheet=sheetOpen('Suggested codes',slot.firstElementChild||slot);
 state.sheet?.classList?.add('sheet-wide');
}
// A person who chose Add selected may have the codes editor shut; it is opened and waited for.
async function diagnosisSuggestEnsureOpen(needDiagnoses,needCharges){
 const missing=()=>(needDiagnoses&&!$('visit-diagnoses-form'))||(needCharges&&!$('billing-account-form'));
 if(typeof encounterCodesEditorOpen!=='function'||!missing())return;
 diagnosisSuggestEditorOpen();
 for(let tries=0;tries<40&&missing();tries++)await new Promise(resolve=>setTimeout(resolve,100));
}
// After adding, the first added item is brought into view.
function diagnosisSuggestReveal(diagnosisCode,procedureCode){
 setTimeout(()=>{
  try{
   let node=null;
   if(diagnosisCode)node=[...(document.querySelectorAll?.('[data-diagnosis-row]')||[])].find(row=>row.getAttribute?.('data-catalog-code')===diagnosisCode);
   if(!node&&procedureCode)node=[...($('billing-account-form')?.querySelectorAll?.('[name="code"]')||[])].find(input=>String(input.value||'').trim().toUpperCase()===procedureCode.toUpperCase());
   node?.scrollIntoView?.({block:'center',behavior:'smooth'});
  }catch{}
 },300);
}
// Unsaved typing in the note would not be read, so it is saved first.
function diagnosisSuggestNoteDirty(){
 const form=$('note-form'),note=activeVisit?.note||{};if(!form?.elements)return false;
 return ['subjective','objective','assessment','plan','procedure'].some(key=>form.elements[key]&&String(form.elements[key].value||'')!==String(note[key]||''));
}
function diagnosisSuggestPaint(id){
 if(typeof visitNoteSuggestPaint==='function')visitNoteSuggestPaint();
 diagnosisSuggestNoteSync(id);diagnosisSuggestSheetPaint(id);
 const host=$('visit-diagnoses'),state=diagnosisSuggestStates.get(id);
 if(!host||!state||activeVisit?.id!==id||state.account!==me)return;
 const html=diagnosisSuggestMarkup(id,state),present=host.querySelector?.('[data-diagnosis-suggest]');
 // While working the markup does not change between polls; leaving it alone keeps the glow smooth.
 if(present&&diagnosisSuggestWorking(state)&&state.panelHtml===html&&state.panelHost===host){diagnosisSuggestTick(id);return;}
 present?.remove();
 const slot=document.createElement('div');slot.innerHTML=html;
 const section=slot.firstElementChild||slot;
 // The panel is the first thing in the editor.
 if(typeof host.prepend==='function')host.prepend(section);else host.append(section);
 const wasWorking=state.painted==='working';
 state.panelHtml=html;state.panelHost=host;state.painted=diagnosisSuggestWorking(state)?'working':state.status;
 if(wasWorking&&state.status==='ready'&&!state.noteChanged&&typeof motionFlash==='function')motionFlash(section);
 diagnosisSuggestTick(id);
}
const diagnosisSuggestTicks=new Map();
// Fills in the elapsed seconds once a second while the request is working.
function diagnosisSuggestTick(id){
 clearTimeout(diagnosisSuggestTicks.get(id));diagnosisSuggestTicks.delete(id);
 const state=diagnosisSuggestStates.get(id);
 if(!diagnosisSuggestWorking(state))return;
 const text=diagnosisSuggestElapsed(state);
 for(const node of document.querySelectorAll?.('[data-suggest-elapsed]')||[])node.textContent=text;
 diagnosisSuggestNoteSync(id);
 diagnosisSuggestTicks.set(id,setTimeout(()=>diagnosisSuggestTick(id),1000));
}
function diagnosisSuggestSchedulePoll(id){
 clearTimeout(diagnosisSuggestPoll.get(id));diagnosisSuggestPoll.delete(id);
 const state=diagnosisSuggestStates.get(id);
 // The live notice normally arrives first; the quick poll keeps the steps moving in between.
 if(state?.status==='queued')diagnosisSuggestPoll.set(id,setTimeout(()=>{void diagnosisSuggestRefresh(id);},1500));
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
 state.status='asking';state.message='';state.stage='extract';state.startedAt=Date.now();diagnosisSuggestPaint(id);
 try{
  const data=await api(`/api/v1/visits/${id}/diagnosis-suggestions`,'POST',{request_id:diagnosisSuggestUuid()});
  if(me!==account)return;
  state.status='queued';state.position=Number(data.position)||0;state.stage='extract';state.problemsFound=0;state.servicesFound=0;state.requestId=data.request_id;state.suggestions=null;state.procedures=[];state.proceduresUnmatched=[];state.noteChanged=false;state.picked=new Set();state.pickedProcedures=new Set();
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
 clearTimeout(diagnosisSuggestPoll.get(id));diagnosisSuggestSheetClose(state);diagnosisSuggestPaint(id);
}
// A ticked procedure becomes a charge line through the same table path a bundle uses: the practice
// price fills in as it does for a typed code, and the encounter's diagnoses are linked by default.
function diagnosisSuggestChargeLine(item){
 const units=Math.trunc(Number(item.default_units));
 return {code_system:item.system||(/^[A-Z]/i.test(item.code)?'HCPCS':'CPT'),code:item.code,description:item.description,modifiers:String(item.modifiers||'').split(/[\s,]+/).filter(Boolean).join(','),units:units>=1?units:1,catalog_release_id:item.catalog_release_id||''};
}
async function diagnosisSuggestAdd(id){
 const state=diagnosisSuggestState(id);
 if(state.adding)return;
 if(state.noteChanged){state.message='The note changed. Suggest again.';diagnosisSuggestPaint(id);return;}
 const chosen=(state.suggestions||[]).filter((item,index)=>state.picked.has(index));
 let procedures=(state.procedures||[]).filter((item,index)=>state.pickedProcedures.has(index)&&!diagnosisSuggestOnCharges(item.code));
 if(!chosen.length&&!procedures.length){state.message='Tick the codes to add.';diagnosisSuggestPaint(id);return;}
 state.adding=true;
 try{
  await diagnosisSuggestEnsureOpen(chosen.length>0,procedures.length>0&&diagnosisSuggestChargeGate().ok);
  if(activeVisit?.id!==id)return;
  procedures=procedures.filter(item=>!diagnosisSuggestOnCharges(item.code));
  // Each ticked code joins the list through the same path as a code picked in the type-ahead, in order.
  let added=0,firstDiagnosis='';
  for(const item of chosen)if(visitDiagnosisAppendRow({code:item.code,display:item.description,catalog_release_id:item.catalog_release_id})){added++;firstDiagnosis=firstDiagnosis||item.code;}
  if(chosen.length&&!added){state.message='Those codes could not be added. Reload the encounter and try again.';diagnosisSuggestPaint(id);return;}
  let lines=0;
  if(procedures.length){
   if(diagnosisSuggestChargeGate().ok&&!diagnosisSuggestChargeGate().needsOpen)for(const item of procedures)if(chargeLinesAppend([diagnosisSuggestChargeLine(item)]).length)lines++;
   if(lines<procedures.length){
    // The diagnoses that did go in are not offered again; the procedures stay to be added once the charges are open.
    state.suggestions=(state.suggestions||[]).filter((item,index)=>!state.picked.has(index));state.picked=new Set();state.pickedProcedures=new Set();
    state.message='Some procedures could not be added to the charges. Open the charges and try again.';diagnosisSuggestPaint(id);return;
   }
  }
  state.message='';
  diagnosisSuggestSheetClose(state);
  notice(`Added ${diagnosisSuggestCountText(added,lines,'').trim()}.`);
  diagnosisSuggestReveal(firstDiagnosis,procedures[0]?.code||'');
  void diagnosisSuggestDismiss(id);
 }finally{state.adding=false;}
}
document.addEventListener('click',event=>{
 const target=event.target?.closest?.('[data-diagnosis-suggest-ask],[data-diagnosis-suggest-add],[data-diagnosis-suggest-dismiss],[data-diagnosis-suggest-open],[data-diagnosis-suggest-all],[data-diagnosis-suggest-review],[data-note-suggest],[data-note-suggest-review]');if(!target)return;
 const id=activeVisit?.id;
 if(target.hasAttribute('data-note-suggest-review')||target.hasAttribute('data-diagnosis-suggest-review')){event.preventDefault();if(id)diagnosisSuggestSheetOpen(id);return;}
 if(target.hasAttribute('data-note-suggest')){
  event.preventDefault();if(!id)return;
  void (async()=>{await visitNoteFlush();if(activeVisit?.id===id)await diagnosisSuggestAsk(id);})().catch(error=>showVisitNoteMessage(error.message));return;
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
 const add=state.sheet?.querySelector?.('[data-diagnosis-suggest-add]');if(add)add.textContent=diagnosisSuggestAddLabel(state);
});

function visitNoteSuggestPaint(){
 const host=$('note-diagnosis-suggestions'),state=diagnosisSuggestStates.get(activeVisit?.id);if(!host)return;
 const added=typeof visitDiagnosisStates==='undefined'?[]:visitDiagnosisStates.get(activeVisit?.id)?.diagnoses||[];
 host.innerHTML=state?.status==='ready'&&!state.noteChanged?(state.suggestions||[]).filter(item=>!added.some(row=>row.code===item.code)).map(item=>`<button type="button" data-note-accept-diagnosis="${esc(item.code)}">+ ${esc(item.code)} · ${esc(item.display)}</button>`).join(''):'';
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-note-accept-diagnosis]');if(!button)return;
 const item=diagnosisSuggestStates.get(activeVisit?.id)?.suggestions?.find(item=>item.code===button.dataset.noteAcceptDiagnosis);if(!item)return;
 event.preventDefault();void visitNoteEnqueue(()=>visitDiagnosisInlineChange(item)).catch(error=>showVisitNoteMessage(error.message));
});
