// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A visible coding editor can ask SunCharts AI about the saved note. Only a clinician's
// explicit selection adds codes through the existing diagnosis and charge editors.
const diagnosisSuggestStates=new Map();
let diagnosisAiStatusCache=null;
const diagnosisSuggestFields=['subjective','objective','assessment','plan','procedure'];
function diagnosisSuggestMayAsk(){return ['owner','clinician'].includes(me?.role)&&!me.delegated;}
function diagnosisAiAvailable(){
 if(diagnosisAiStatusCache?.account!==me)diagnosisAiStatusCache={account:me,read:api('/api/v1/ai/local-status').then(status=>status?.available===true,()=>false)};
 return diagnosisAiStatusCache.read;
}
function diagnosisSuggestRemember(state){
 if(!state.storageKey)return;
 // Only the server's opaque request identifier, encounter version and authored timestamp.
 // Never hold the fallback revision (which includes text) outside this page.
 const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
 const revision=state.requestRevision,time=timestamp(revision)?revision:null;
 const dismissed=[...state.dismissed].filter(timestamp).at(-1)||null;
 try{sessionStorage.setItem(state.storageKey,JSON.stringify({id:state.requestId,version:state.requestVersion,revision:time,dismissed}));}catch{}
}
function diagnosisSuggestState(id){
 let state=diagnosisSuggestStates.get(id);
 if(state?.account!==me){
  clearTimeout(state?.poll);
  state={account:me,status:'none',attempted:new Set(),dismissed:new Set(),picked:new Set(),pickedProcedures:new Set()};
  if(me?.tenant_id&&me?.user_id){
   state.storageKey=`suncharts-code-suggestions:${me.tenant_id}:${me.user_id}:${id}`;
   try{
    const saved=JSON.parse(sessionStorage.getItem(state.storageKey));
    if(saved?.id&&saved?.revision){state.requestId=saved.id;state.requestRevision=saved.revision;state.requestVersion=saved.version;}
    if(saved?.dismissed)state.dismissed.add(saved.dismissed);
   }catch{}
  }
  diagnosisSuggestStates.set(id,state);
 }
 return state;
}
function diagnosisSuggestScope(id,state){
 return state.account===me&&diagnosisSuggestStates.get(id)===state;
}
function diagnosisSuggestVisible(host){
 if(!host?.isConnected||document.visibilityState==='hidden')return false;
 const dialog=host.closest('dialog');
 return (!dialog||dialog.open)&&host.getClientRects().length>0;
}
function diagnosisSuggestRevision(){
 if(!['in_progress','signed'].includes(activeVisit?.status))return null;
 const note=activeVisit.note;
 const text=diagnosisSuggestFields.map(key=>String(note?.[key]||'').trim());
 if(!text.some(Boolean))return null;
 // Vitals, signing and coding also increment the encounter version. Saved note authorship
 // is the note revision. Older visits can lack it, so compare their note sections in memory.
 return note.saved_by?.at||JSON.stringify(text);
}
function diagnosisSuggestNoteDirty(){
 const form=$('note-form'),note=activeVisit?.note||{};
 return !!form?.elements&&diagnosisSuggestFields.some(key=>form.elements[key]&&String(form.elements[key].value||'')!==String(note[key]||''));
}
function diagnosisSuggestCodes(form){
 return new Set([...(form?.querySelectorAll('[name="code"]')||[])].map(field=>String(field.value||'').trim().toUpperCase()));
}
function diagnosisSuggestCandidates(state){
 const available=(items,form,applied)=>{
  const codes=diagnosisSuggestCodes(form);
  return (items||[]).filter(item=>item?.code&&!codes.has(item.code.toUpperCase())&&!applied?.has(item.code));
 };
 return {
  diagnoses:available(state.suggestions,$('visit-diagnoses-form'),state.appliedDiagnoses),
  procedures:available(state.procedures,$('billing-account-form'),state.appliedProcedures)
 };
}
function diagnosisSuggestChargeGate(){
 if(typeof encounterChargeAccount==='function'&&encounterChargeAccount()?.status==='posted')return 'Procedures can be changed through a billing correction.';
 const form=$('billing-account-form');
 if(!form||form.dataset.draftReadOnly!==undefined||form.dataset.draftStale!==undefined||typeof chargeLinesAppend!=='function')return 'Open editable charges to add procedures.';
 return '';
}
function diagnosisSuggestRow(item,attribute,picked,locked=false){
 const code=`<b class="codes-strip-code">${esc(item.code)}</b> <span>${esc(item.description)}</span>`;
 const evidence=item.evidence_found&&item.evidence?`<small class="diagnosis-suggest-quote">“${esc(item.evidence)}”</small>`:'';
 const quantity=attribute==='procedure'&&Number(item.quantity)>0?`<small>${esc(`${item.quantity} ${item.quantity_unit||''}`.trim())} given</small>`:'';
 return `<li>${locked?`<span>${code}</span>`:`<label><input type="checkbox" data-diagnosis-suggest-pick-${attribute}="${esc(item.code)}"${picked.has(item.code)?' checked':''}> ${code}</label>`}${evidence}${quantity}</li>`;
}
function diagnosisSuggestUnmatched(items,field){
 const rows=(items||[]).filter(item=>item?.[field]);
 return rows.length?`<ul class="muted" data-diagnosis-suggest-unmatched>${rows.map(item=>`<li>${esc(item[field])} · ${item.reason==='level'?'Choose the encounter level':'No matching code'}${item.evidence?` <small>“${esc(item.evidence)}”</small>`:''}</li>`).join('')}</ul>`:'';
}
function diagnosisSuggestSelected(state){
 const {diagnoses,procedures}=diagnosisSuggestCandidates(state);
 return {
  diagnoses:diagnoses.filter(item=>state.picked.has(item.code)),
  procedures:diagnosisSuggestChargeGate()?[]:procedures.filter(item=>state.pickedProcedures.has(item.code))
 };
}
function diagnosisSuggestAddLabel(state){
 const selected=diagnosisSuggestSelected(state),count=selected.diagnoses.length+selected.procedures.length;
 return count?`Add ${count} selected`:'Add selected';
}
function diagnosisSuggestMarkup(state,revision){
 if(!revision||state.dismissed.has(revision))return '';
 const wrap=body=>`<section data-diagnosis-suggest class="diagnosis-suggest-panel" aria-label="Suggested codes"><h4 class="suggest-title">Suggested codes</h4>${body}</section>`;
 if(diagnosisSuggestNoteDirty())return state.resultRevision?wrap('<p role="status">Waiting for the note to save…</p>'):'';
 if(state.readFailed||state.status==='failed'&&state.resultRevision===revision){
  return wrap('<p role="status">Code suggestions could not load.</p><div class="actions"><button type="button" data-diagnosis-suggest-retry>Retry suggestions</button></div>');
 }
 if(state.status==='asking'||state.status==='queued'){
  const progress=state.status==='asking'?'Checking the saved note…':state.stage==='choose'?'Matching codes…':state.position>0?`Waiting for the assistant · ${state.position} ahead of you`:'Reading the saved note…';
  return wrap(`<p role="status">${esc(progress)}</p>`);
 }
 if(state.status!=='ready'||state.resultRevision!==revision)return '';
 const {diagnoses,procedures}=diagnosisSuggestCandidates(state),gate=diagnosisSuggestChargeGate();
 const hasChoices=diagnoses.length||procedures.length&&!gate;
 const list=(title,items,attribute,picked,locked=false)=>items.length?`<section class="diagnosis-suggest-section"><h4>${title}</h4>${locked?`<p class="muted">${esc(gate)}</p>`:''}<ul class="diagnosis-suggest-list">${items.map(item=>diagnosisSuggestRow(item,attribute,picked,locked)).join('')}</ul></section>`:'';
 const selected=diagnosisSuggestSelected(state),count=selected.diagnoses.length+selected.procedures.length;
 const unmatched=diagnosisSuggestUnmatched(state.unmatched,'problem')+diagnosisSuggestUnmatched(state.proceduresUnmatched,'service');
 const added=state.appliedDiagnoses?.size||state.appliedProcedures?.size;
 if(!diagnoses.length&&!procedures.length&&!unmatched&&(added||state.suggestions?.length||state.procedures?.length))return '';
 return wrap(`${diagnoses.length||procedures.length?'':'<p class="muted">No codes suggested from the saved note.</p>'}${list('Diagnoses',diagnoses,'diagnosis',state.picked)}${list('Procedures',procedures,'procedure',state.pickedProcedures,!!gate)}${unmatched}${state.message?`<p role="alert">${esc(state.message)}</p>`:''}<div class="actions">${hasChoices?`<button type="button" class="primary" data-diagnosis-suggest-add${count&&!state.adding?'':' disabled'}>${esc(diagnosisSuggestAddLabel(state))}</button>`:''}<button type="button" class="text-button" data-diagnosis-suggest-dismiss>Dismiss</button></div>`);
}
function diagnosisSuggestPaint(id,state){
 if(activeVisit?.id!==id||selected!==state.patient||!diagnosisSuggestScope(id,state))return;
 const host=$('visit-diagnoses');if(!host)return;
 const panel=host.querySelector('[data-diagnosis-suggest]'),html=diagnosisSuggestMarkup(state,diagnosisSuggestRevision());
 if(panel&&state.panelHtml===html)return;
 panel?.remove();
 if(html){
  const row=host.querySelector('[data-diagnosis-row]');
  if(row)row.insertAdjacentHTML('afterend',html);
  else host.insertAdjacentHTML('beforeend',html);
 }
 state.panelHtml=html;
}
function diagnosisSuggestNotice(id,data){
 if(typeof notice!=='function')return;
 const number=typeof encounterNumberText==='function'?encounterNumberText(data):'';
 notice(data.status==='ready'?`Code suggestions are ready${number?` for ${number}`:''}.`:'Code suggestions could not load.',data.status==='failed');
 const holder=$('notice');
 if(data.status==='ready'&&holder?.append){
  const button=document.createElement('button');button.type='button';button.textContent='Open codes';
  button.setAttribute('data-diagnosis-suggest-open',id);button.dataset.patientId=data.patient_id||'';
  holder.append(' ',button);
 }
}
function diagnosisSuggestSchedulePoll(id,state){
 clearTimeout(state.poll);
 if(state.status==='queued')state.poll=setTimeout(()=>{if(diagnosisSuggestScope(id,state))void diagnosisSuggestRefresh(id,state);},1500);
}
function diagnosisSuggestRefresh(id,state,{announce=false}={}){
 if(state.read)return state.read;
 const revision=activeVisit?.id===id?diagnosisSuggestRevision():null;
 const previous=state.status;
 const read=(async()=>{
  let data;
  try{data=await api(`/api/v1/visits/${id}/diagnosis-suggestions`);}
  catch{
   if(diagnosisSuggestScope(id,state)){state.readFailed=true;diagnosisSuggestPaint(id,state);}
   return;
  }
  if(!diagnosisSuggestScope(id,state))return;
  if(data.patient_id&&data.patient_id!==state.patient){state.readFailed=true;diagnosisSuggestPaint(id,state);return;}
  state.readFailed=false;state.hydrated=true;
  const same=data.request_id===state.requestId;
  if(!same){state.picked.clear();state.pickedProcedures.clear();state.appliedDiagnoses?.clear();state.appliedProcedures?.clear();}
  const matches=revision&&data.note_version===activeVisit?.version&&activeVisit.id===id&&diagnosisSuggestRevision()===revision;
  state.resultRevision=matches?revision:same&&data.note_version===state.requestVersion?state.requestRevision:null;
  state.requestId=data.request_id;
  state.requestVersion=data.note_version;state.requestRevision=state.resultRevision;
  diagnosisSuggestRemember(state);
  state.status=data.status;
  state.position=Number(data.position)||0;state.stage=data.stage;
  state.suggestions=data.suggestions;state.procedures=data.procedures;
  state.unmatched=data.unmatched;state.proceduresUnmatched=data.procedures_unmatched;
  diagnosisSuggestPaint(id,state);diagnosisSuggestSchedulePoll(id,state);
  if(announce&&previous!==data.status&&['ready','failed'].includes(data.status)&&data.mine!==false&&
   (activeVisit?.id!==id||!diagnosisSuggestVisible($('visit-diagnoses'))))diagnosisSuggestNotice(id,data);
 })();
 state.read=read;
 void read.finally(()=>{if(state.read===read)state.read=null;if(!state.readFailed&&activeVisit?.id===id&&diagnosisSuggestScope(id,state))diagnosisSuggestCheck();});
 return read;
}
async function diagnosisSuggestAsk(id,state,revision){
 const requestId=crypto.randomUUID(),version=activeVisit.version;
 state.attempted.add(revision);state.status='asking';state.position=0;state.stage=null;state.message='';
 state.picked.clear();state.pickedProcedures.clear();state.appliedDiagnoses?.clear();state.appliedProcedures?.clear();
 state.resultRevision=null;
 diagnosisSuggestPaint(id,state);
 try{
  const data=await api(`/api/v1/visits/${id}/diagnosis-suggestions`,'POST',{request_id:requestId,visit_version:version});
  if(!diagnosisSuggestScope(id,state))return;
  state.requestId=data.request_id;state.requestRevision=data.request_id===requestId?revision:null;
  state.requestVersion=version;
  diagnosisSuggestRemember(state);
  // The endpoint can return an already queued job from another editor. Only mark this
  // saved revision attempted when this request was the one accepted.
  if(!state.requestRevision)state.attempted.delete(revision);
  state.status='queued';state.position=Number(data.position)||0;
  diagnosisSuggestSchedulePoll(id,state);
 }catch{
  if(!diagnosisSuggestScope(id,state))return;
  state.status='failed';state.resultRevision=revision;
 }
 diagnosisSuggestPaint(id,state);
}
function diagnosisSuggestCheck(){
 const id=activeVisit?.id,host=$('visit-diagnoses'),state=diagnosisSuggestStates.get(id);
 if(!id||!state||!diagnosisSuggestScope(id,state)||!diagnosisSuggestMayAsk()||!state.canEdit||selected!==state.patient||!diagnosisSuggestVisible(host))return;
 const revision=diagnosisSuggestRevision();
 if(state.available)diagnosisSuggestPaint(id,state);
 if(!revision||diagnosisSuggestNoteDirty()||state.dismissed.has(revision))return;
 if(state.available===undefined){
  if(state.checkingAvailability)return;
  state.checkingAvailability=true;
  void diagnosisAiAvailable().then(available=>{
   if(!diagnosisSuggestScope(id,state))return;
   state.available=available;
   if(activeVisit?.id===id)diagnosisSuggestCheck();
  });
  return;
 }
 if(!state.available||state.read||state.readFailed)return;
 if(!state.hydrated){void diagnosisSuggestRefresh(id,state);return;}
 if(state.status==='asking'||state.status==='queued'||state.resultRevision===revision||state.attempted.has(revision))return;
 void diagnosisSuggestAsk(id,state,revision);
}
function diagnosisSuggestionsMount(host,data,id,patient){
 if(!diagnosisSuggestMayAsk()||activeVisit?.id!==id||selected!==patient||$('visit-diagnoses')!==host)return;
 const state=diagnosisSuggestState(id);
 state.patient=patient;state.canEdit=!!data.can_edit&&data.version===activeVisit.version;
 diagnosisSuggestCheck();
}
function diagnosisSuggestionsEvent(_action,id){
 const state=diagnosisSuggestStates.get(id);
 if(diagnosisSuggestMayAsk()&&state?.available&&diagnosisSuggestScope(id,state)&&state.status!=='asking')void diagnosisSuggestRefresh(id,state,{announce:true});
}
function diagnosisSuggestChargeLine(item){
 const units=Math.trunc(Number(item.default_units));
 return {code_system:item.system||(/^[A-Z]/i.test(item.code)?'HCPCS':'CPT'),code:item.code,description:item.description,modifiers:String(item.modifiers||'').split(/[\s,]+/).filter(Boolean).join(','),units:units>=1?units:1,catalog_release_id:item.catalog_release_id||''};
}
function diagnosisSuggestAdd(id,state){
 const revision=diagnosisSuggestRevision();
 if(state.adding||state.status!=='ready'||state.resultRevision!==revision||diagnosisSuggestNoteDirty())return;
 const {diagnoses,procedures}=diagnosisSuggestSelected(state);
 if(!diagnoses.length&&!procedures.length)return;
 state.adding=true;state.message='';
 const appliedDiagnoses=state.appliedDiagnoses??=new Set(),appliedProcedures=state.appliedProcedures??=new Set();
 let added=0;
 try{
  for(const item of diagnoses)if(visitDiagnosisAppendRow({code:item.code,display:item.description,catalog_release_id:item.catalog_release_id})){
   appliedDiagnoses.add(item.code);state.picked.delete(item.code);added++;
  }
  if(procedures.length&&!diagnosisSuggestChargeGate()){
   for(const item of procedures)if(chargeLinesAppend([diagnosisSuggestChargeLine(item)]).length){
    appliedProcedures.add(item.code);state.pickedProcedures.delete(item.code);added++;
   }
  }
  if(added<diagnoses.length+procedures.length)state.message='Some selected codes could not be added. Review the code fields and try again.';
  if(added&&typeof notice==='function')notice(`Added ${added} ${added===1?'code':'codes'} to the encounter.`);
 }finally{state.adding=false;diagnosisSuggestPaint(id,state);}
}
document.addEventListener('click',event=>{
 const target=event.target.closest?.('[data-diagnosis-suggest-retry],[data-diagnosis-suggest-add],[data-diagnosis-suggest-dismiss],[data-diagnosis-suggest-open]');
 if(!target)return;
 event.preventDefault();
 if(target.hasAttribute('data-diagnosis-suggest-open')){
  const id=target.getAttribute('data-diagnosis-suggest-open'),patient=target.dataset.patientId,account=me;
  run(async()=>{
   if(patient&&selected!==patient)await selectPatient(patient,id);
   else if(activeVisit?.id!==id)await openPatientEncounter(id);
   if(me===account&&activeVisit?.id===id&&typeof encounterOpenCodesDialog==='function')encounterOpenCodesDialog();
  });
  return;
 }
 const id=activeVisit?.id,state=diagnosisSuggestStates.get(id),host=$('visit-diagnoses');
 if(!state?.canEdit||!diagnosisSuggestMayAsk()||!diagnosisSuggestScope(id,state)||selected!==state.patient||!host?.contains(target)||!diagnosisSuggestVisible(host))return;
 if(target.hasAttribute('data-diagnosis-suggest-add'))diagnosisSuggestAdd(id,state);
 else if(target.hasAttribute('data-diagnosis-suggest-dismiss')){
  state.dismissed.add(diagnosisSuggestRevision());state.picked.clear();state.pickedProcedures.clear();diagnosisSuggestRemember(state);diagnosisSuggestPaint(id,state);
 }else{
  const revision=diagnosisSuggestRevision();
  if(!revision||diagnosisSuggestNoteDirty())return;
  if(state.readFailed){state.readFailed=false;void diagnosisSuggestRefresh(id,state);}
  else if(state.status==='failed'&&state.resultRevision===revision)void diagnosisSuggestAsk(id,state,revision);
 }
});
document.addEventListener('change',event=>{
 const input=event.target.closest?.('[data-diagnosis-suggest-pick-diagnosis],[data-diagnosis-suggest-pick-procedure]');
 const id=activeVisit?.id,state=diagnosisSuggestStates.get(id),host=$('visit-diagnoses');
 if(!input||!state?.canEdit||!diagnosisSuggestScope(id,state)||!host?.contains(input)||!diagnosisSuggestVisible(host))return;
 const procedure=input.hasAttribute('data-diagnosis-suggest-pick-procedure');
 const code=input.getAttribute(procedure?'data-diagnosis-suggest-pick-procedure':'data-diagnosis-suggest-pick-diagnosis'),picked=procedure?state.pickedProcedures:state.picked;
 if(input.checked)picked.add(code);else picked.delete(code);
 const add=host.querySelector('[data-diagnosis-suggest-add]');if(!add)return;
 const label=diagnosisSuggestAddLabel(state);
 add.textContent=label;add.disabled=label==='Add selected';
});
document.addEventListener('input',event=>{if(event.target.closest?.('#note-form')&&diagnosisSuggestFields.includes(event.target.name))diagnosisSuggestCheck();});
document.addEventListener('visibilitychange',diagnosisSuggestCheck);
