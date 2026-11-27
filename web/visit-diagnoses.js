// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const visitDiagnosisDrafts=new Map(),visitDiagnosisStates=new Map(),visitDiagnosisBaselines=new WeakMap(),visitDiagnosisPending=new Map(),visitDiagnosisAutosave={timer:null,busy:false,form:null,submitted:'',inFlight:null,failure:null};let visitDiagnosisGeneration=0;
function diagnosisValues(rows){return (rows||[]).map(row=>({code:String(row.code??''),display:String(row.display??''),...(row.catalog_release_id?{catalog_release_id:String(row.catalog_release_id)}:{})}));}
function sameDiagnosisValues(a,b){return JSON.stringify(diagnosisValues(a))===JSON.stringify(diagnosisValues(b));}
function visitDiagnosisChangeReason(form){
 const reason=form.elements.reason||form.querySelector?.('[name="reason"]');
 return String(reason?.value||'').trim()||(activeVisit?.status==='signed'?'Billing correction':reason?.dataset?.optionalNote?'Updated encounter diagnoses':'');
}
function visitDiagnosisRows(form){
 return Array.from(form.querySelectorAll('[data-diagnosis-row]'),row=>({
  code:row.querySelector('[name="code"]').value,
  display:row.querySelector('[name="display"]').value,
  ...(row.dataset?.catalogReleaseId?{catalog_release_id:row.dataset.catalogReleaseId}:{})
 }));
}
function visitDiagnosisStarted(row){return Boolean(row.code.trim()||row.display.trim());}
function visitDiagnosisFormValues(form){
 return {diagnoses:visitDiagnosisRows(form).filter(visitDiagnosisStarted),reason:visitDiagnosisChangeReason(form)};
}
function visitDiagnosisFocusCode(field){
 if(!field)return;
 field.focus({preventScroll:true});
 if(!field.value.trim()&&typeof terminologyComboboxes!=='undefined'){
  const picker=terminologyComboboxes.get(field);
  if(picker)closeTerminologyCombobox(picker);
 }
}
function visitDiagnosisRowValidity(row){
 if(!row)return;
 const code=row.querySelector('[name="code"]'),display=row.querySelector('[name="display"]');
 const required=Boolean(code.value.trim()||display.value.trim());
 code.required=required;display.required=required;
}
function captureVisitDiagnosisDraft(){
 const form=$('visit-diagnoses-form');if(!form)return;
 const baseline=visitDiagnosisBaselines.get(form);if(!baseline)return;
 const values=visitDiagnosisFormValues(form),pending=visitDiagnosisPending.get(form.dataset.visitId);
 if(!values.diagnoses.length&&!baseline.length&&!pending){visitDiagnosisDrafts.delete(form.dataset.visitId);return;}
 if(sameDiagnosisValues(values.diagnoses,baseline)&&!String(form.elements.reason?.value||'').trim()&&(!pending||sameDiagnosisValues(values.diagnoses,pending.diagnoses))){visitDiagnosisDrafts.delete(form.dataset.visitId);return;}
 visitDiagnosisDrafts.set(form.dataset.visitId,{patientId:form.dataset.patientId,version:Number(form.dataset.version),values});
}
function visitDiagnosisProgress(){
 const data=activeVisit?visitDiagnosisStates.get(activeVisit.id):null;
 if(!activeVisit)return {label:'Select an encounter',complete:false};
 if(!data||data.patientId!==selected||data.version!==activeVisit.version)return {label:'Review diagnoses',complete:false};
 const draft=visitDiagnosisDrafts.get(activeVisit.id);
 if(draft?.patientId===selected&&activeVisit.status!=='signed')return {label:'Diagnosis edits not saved yet',complete:false};
 return {label:data.diagnoses.length?`${data.diagnoses.length} recorded`:'No visit diagnoses recorded',complete:data.diagnoses.length>0};
}
function diagnosisListMarkup(rows){return rows.length?`<ol>${rows.map((row,i)=>`<li>${typeof diagnosisLetterBadge==='function'?diagnosisLetterBadge(i):''}${esc(row.code)} · ${esc(row.display)}${i===0?' <span class="badge">Primary</span>':''}${typeof terminologySnapshotMarkup==='function'?terminologySnapshotMarkup(row.catalog_snapshot):''}</li>`).join('')}</ol>`:'<p class="muted">No visit diagnoses recorded.</p>';}
// Whoever is watching this encounter's diagnoses. The Charges step registers a listener here so a
// diagnosis saved on either screen reaches the charge lines at once: the lettered chips on every line
// is redrawn, and a line with nothing on it yet takes the encounter's own diagnoses, in order, up to
// the four a claim line can carry.
const visitDiagnosisListeners=new Set();
// A draft account keeps its charges and its own record of which visit diagnoses they point at.
// Following the encounter is automatic now, so a step that wants to keep that record in step leaves a
// note here for itself. It is deliberately not fired from here: adding links is one-way on the
// server, and an account whose links are recorded cannot have its charge lines changed until they
// are cleared, so running it on every diagnosis save would lock the table the person is working in.
let chargeDiagnosisDraftFollow=null;
function visitDiagnosisSaved(id){if(typeof visitNoteInlinePaint==='function')visitNoteInlinePaint();for(const notify of [...visitDiagnosisListeners]){try{notify(id);}catch{}}if(id)chargeDiagnosisDraftFollow=id;}
function visitDiagnosisEditRow(row,index,savedDiagnoses){
 const primary=index===0;
 const fields=typeof terminologyDiagnosisFields==='function'?terminologyDiagnosisFields(row):
  `<label>Code<input name="code" value="${esc(row.code)}" required maxlength="8" autocomplete="off"></label><label>Description<input name="display" value="${esc(row.display)}" required maxlength="2000" autocomplete="off"></label>`;
 const saved=savedDiagnoses.find(item=>item.code===row.code&&item.display===row.display&&item.catalog_release_id===row.catalog_release_id);
 const source=typeof terminologySnapshotMarkup==='function'?terminologySnapshotMarkup(saved?.catalog_snapshot):'';
 return `<div class="amendment" data-diagnosis-row data-catalog-release-id="${esc(row.catalog_release_id||'')}" data-catalog-code="${esc(row.code)}" data-catalog-display="${esc(row.display)}" data-catalog-system="ICD-10-CM">
  <div class="section-head"><strong>${typeof diagnosisLetterBadge==='function'?diagnosisLetterBadge(index):''}${primary?'Primary diagnosis':`Diagnosis ${index+1}`}</strong><div class="actions"><button type="button" data-diagnosis-up="${index}" ${primary?'disabled':''}>Move up</button><button type="button" data-diagnosis-remove="${index}">Remove</button></div></div>
  <div class="form-grid">${fields}</div>
  ${source?`<details class="diagnosis-code-source" data-inline><summary>Code source</summary>${source}</details>`:''}
 </div>`;
}
function showVisitDiagnoses(host,data,id,patient){
 if(typeof visitNoteInlinePaint==='function')visitNoteInlinePaint();
 const draft=visitDiagnosisDrafts.get(id),stale=data.version!==activeVisit.version,locked=!data.can_edit||stale,retained=draft?.patientId===patient&&(!locked||data.visit?.status!=='signed')?draft:null,savedOrDraft=retained?.values.diagnoses||diagnosisValues(data.diagnoses),needsReview=!!retained&&retained.version!==data.version;
 // The first row is ready to type into, even before there is a diagnosis on the record.
 const rows=savedOrDraft.length?savedOrDraft:[{code:'',display:''}];
 // A blank row that was only just added is not an unsaved edit yet: the notices wait until there is something to lose.
 const unsaved=!!retained&&(needsReview||!!retained.values.reason||JSON.stringify(rows.filter(row=>row.code||row.display).map(row=>[row.code,row.display]))!==JSON.stringify(data.diagnoses.map(row=>[row.code,row.display])));
 host.innerHTML=`<div class="section-head"><h3>Diagnoses</h3>${data.diagnoses.length?`<span class="badge">${data.diagnoses.length} saved</span>`:''}</div>${data.visit?.status==='signed'?(locked?'<p class="muted">Only a clinician or the practice owner can change the diagnoses of a signed visit.</p>':'<p class="muted">Changes after signing are saved as billing corrections.</p>'):''}${data.visit?.status==='signed'&&!locked&&unsaved?'<section role="status"><button type="button" data-diagnosis-discard>Discard unsaved diagnoses</button></section>':''}${unsaved?'<p role="status" data-diagnosis-unsaved>You have diagnosis edits that have not saved yet.</p>':''}${needsReview?`<section role="status"><p>Someone else saved this encounter. Compare your changes with the saved diagnoses before saving.</p>${diagnosisListMarkup(data.diagnoses)}${!locked?`<button type="button" data-diagnosis-rebase="${data.version}">Keep my changes</button>`:''}</section>`:''}${stale?'<p role="status">This encounter was changed elsewhere. Reload it before editing; your unsaved changes are kept.</p>':''}<button type="button" class="text-button" ${stale||needsReview?'data-diagnosis-recovery ':''}data-diagnosis-refresh>Reload</button>${locked?diagnosisListMarkup(data.diagnoses):`<form id="visit-diagnoses-form" data-visit-id="${esc(id)}" data-patient-id="${esc(patient)}" data-version="${retained?.version??data.version}"><div>${rows.map((row,i)=>visitDiagnosisEditRow(row,i,data.diagnoses)).join('')}</div><div class="actions"><button type="button" data-diagnosis-add ${rows.length>=20?'disabled':''}>Add diagnosis</button></div><label>Reason for this change<input name="reason" value="${esc(retained?.values.reason||'')}" ${data.visit?.status==='signed'?'placeholder="Billing correction"':'required placeholder="For example: added after exam"'} maxlength="2000" autocomplete="off"></label><div class="actions"><button type="submit" ${needsReview?'disabled':''}>Save diagnoses</button>${unsaved?'<button type="button" class="text-button" data-diagnosis-discard>Discard diagnosis edits</button>':''}</div></form>`}<details><summary>Diagnosis history</summary>${(data.history||[]).map(revision=>`<section class="amendment"><p>${esc(date(revision.created_at))} · ${esc(revision.actor_label||revision.actor_id)} · ${esc(revision.reason)}</p>${diagnosisListMarkup(revision.diagnoses||(Array.isArray(revision.snapshot)?revision.snapshot:revision.snapshot?.diagnoses)||[])}</section>`).join('')||'<p class="muted">No changes yet.</p>'}${data.history_truncated?'<p class="muted">Older changes are not shown.</p>':''}</details>`;
 const form=$('visit-diagnoses-form');
 if(form){
  visitDiagnosisBaselines.set(form,diagnosisValues(data.diagnoses));
  for(const row of form.querySelectorAll('[data-diagnosis-row]'))visitDiagnosisRowValidity(row);
  const failed=visitDiagnosisFailure(form,visitDiagnosisFormValues(form));
  if(failed)diagnosisSaveStatus(form,failed.error.message,true);
  if(!host.querySelector('[data-diagnosis-rebase]')){
   // The practice's optional reason is applied to the new form by the same render's DOM observer.
   Promise.resolve().then(()=>{if($('visit-diagnoses-form')===form)queueVisitDiagnosisAutosave(form);});
  }
 }
 const dialog=host.closest?.('dialog[open][data-encounter-codes-dialog]');
 if(dialog?.codesFocusDiagnosis){
  dialog.codesFocusDiagnosis=false;
  const current=document.activeElement;
  if(!current?.matches('input,select,textarea')||host.contains(current))visitDiagnosisFocusCode(form?.querySelector('[name="code"]'));
 }
 if(typeof diagnosisSuggestionsMount==='function')diagnosisSuggestionsMount(host,data,id,patient);
 refreshEncounterProgress();
}
// Opening an encounter asks for its diagnoses from several places at once; requests made within a
// quarter second of each other share one read. Anything later reads again, so a save is never
// followed by an old list.
const visitDiagnosisLoads=new Map();
function visitDiagnosisLoad(id){
 const now=Date.now(),held=visitDiagnosisLoads.get(id);
 if(held&&now-held.at<250)return held.read;
 const read=api(`/api/v1/visits/${id}/diagnoses`);visitDiagnosisLoads.set(id,{at:now,read});
 return read;
}
async function renderVisitDiagnoses(){
 const host=$('visit-diagnoses');if(!host||!activeVisit)return;
 captureVisitDiagnosisDraft();
 const id=activeVisit.id,patient=selected,generation=++visitDiagnosisGeneration;
 host.innerHTML='<h3>Diagnoses</h3><p class="muted">Loading…</p>';
 try{
  const data=await visitDiagnosisLoad(id);
  if(generation!==visitDiagnosisGeneration||activeVisit?.id!==id||selected!==patient||$('visit-diagnoses')!==host)return;
  visitDiagnosisStates.set(id,{...data,patientId:patient});showVisitDiagnoses(host,data,id,patient);
 }catch(error){if(generation===visitDiagnosisGeneration&&$('visit-diagnoses')===host){host.textContent=`Diagnoses could not load: ${error.message}`;visitDiagnosisStates.delete(id);refreshEncounterProgress();}}
}

document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-diagnosis-add],[data-diagnosis-remove],[data-diagnosis-up],[data-diagnosis-rebase],[data-diagnosis-refresh],[data-diagnosis-discard]');if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  if($('visit-diagnoses-form')?.querySelectorAll('[data-diagnosis-row]').length)captureVisitDiagnosisDraft();
 const id=activeVisit?.id,patient=selected,host=$('visit-diagnoses'),state=visitDiagnosisStates.get(id),ws=typeof workspace==='undefined'?null:workspace;const data=state||(activeVisit&&selected&&ws&&ws.patient_id===selected&&activeVisit.status!=='signed'?{version:activeVisit.version,can_edit:['owner','clinician','nurse','medical_assistant','front_desk'].includes(me?.role)&&!me?.delegated,diagnoses:[],history:[],patientId:selected}:null);if(!id||!host||data?.patientId!==patient)return;
  if(button.hasAttribute('data-diagnosis-refresh')){
   const identity=me,inCodes=!!host.closest?.('[data-encounter-codes-dialog]');
   visitDiagnosisLoads.delete(id);captureVisitDrafts();
   const visit=await api(`/api/v1/visits/${id}`);
   if(me!==identity||activeVisit?.id!==id||selected!==patient)return;
   rememberVisit(visit);
   if(inCodes)await renderVisitDiagnoses();else renderVisit(false);
   return;
  }
  if(button.hasAttribute('data-diagnosis-discard')){if(!await confirmAction('Diagnosis edits that have not saved yet will be removed and the saved diagnosis list will be restored.',{title:'Discard diagnosis edits?',confirmLabel:'Discard edits',tone:'danger'}))return;visitDiagnosisDrafts.delete(id);showVisitDiagnoses(host,data,id,patient);return;}
  if(!data.can_edit||data.version!==activeVisit.version)return;
  const draft=visitDiagnosisDrafts.get(id)||{patientId:patient,version:data.version,values:{diagnoses:diagnosisValues(data.diagnoses),reason:''}};
  // Button indices refer to the displayed rows, including untouched placeholders.
  const form=$('visit-diagnoses-form');
  if(form)draft.values.diagnoses=visitDiagnosisRows(form);
  if(button.hasAttribute('data-diagnosis-rebase')){draft.version=Number(button.dataset.diagnosisRebase);visitDiagnosisAutosave.submitted='';}
  else if(button.hasAttribute('data-diagnosis-add')){if(draft.values.diagnoses.length>=20)return;draft.values.diagnoses.push({code:'',display:''});}
  else{const index=Number(button.dataset.diagnosisRemove??button.dataset.diagnosisUp);if(!Number.isInteger(index)||index<0||index>=draft.values.diagnoses.length)return;if(button.hasAttribute('data-diagnosis-remove'))draft.values.diagnoses.splice(index,1);else if(index>0)[draft.values.diagnoses[index-1],draft.values.diagnoses[index]]=[draft.values.diagnoses[index],draft.values.diagnoses[index-1]];}
  visitDiagnosisDrafts.set(id,draft);showVisitDiagnoses(host,data,id,patient);captureVisitDiagnosisDraft();
  // A new row is for typing in: the cursor goes to its code box.
  if(button.hasAttribute('data-diagnosis-add')){const added=Array.from($('visit-diagnoses-form')?.querySelectorAll?.('[data-diagnosis-row]')||[]).pop();(added?.querySelector?.('input[name="diagnosis"]')||added?.querySelector?.('input:not([type="hidden"])'))?.focus?.();}
  // Removing or moving a diagnosis saves at once, like typing one does: there is no separate save step.
  if(button.hasAttribute('data-diagnosis-remove')||button.hasAttribute('data-diagnosis-up'))queueVisitDiagnosisAutosave($('visit-diagnoses-form'));
 });
},true);
// Adds a diagnosis chosen somewhere other than the type-ahead (the note suggestions) the same way the
// add button and the type-ahead do: the row joins the draft, the list redraws, and the usual autosave
// records it. Answers whether the row was added.
function visitDiagnosisAppendRow(row,reason='Added from the note suggestions'){
 const id=activeVisit?.id,patient=selected,host=$('visit-diagnoses'),state=visitDiagnosisStates.get(id);
 if(!id||!host||state?.patientId!==patient||!state.can_edit||state.version!==activeVisit.version)return false;
 if($('visit-diagnoses-form')?.querySelectorAll('[data-diagnosis-row]').length)captureVisitDiagnosisDraft();
 const draft=visitDiagnosisDrafts.get(id)||{patientId:patient,version:state.version,values:{diagnoses:diagnosisValues(state.diagnoses),reason:''}};
 const list=draft.values.diagnoses.filter(visitDiagnosisStarted);
 if(list.length>=20||list.some(item=>item.code===row.code))return false;
 draft.values.diagnoses=list;
 list.push({code:row.code,display:row.display,...(row.catalog_release_id?{catalog_release_id:row.catalog_release_id}:{})});
 if(!draft.values.reason&&state.visit?.status!=='signed')draft.values.reason=reason;
 visitDiagnosisDrafts.set(id,draft);showVisitDiagnoses(host,state,id,patient);
 queueVisitDiagnosisAutosave($('visit-diagnoses-form'));
 return true;
}
function visitDiagnosisReady(form){
 if(!form||form.closest?.('#visit-diagnoses')?.querySelector('[data-diagnosis-rebase]'))return false;
 const rows=visitDiagnosisRows(form).filter(visitDiagnosisStarted);
 if(rows.some(row=>!row.code.trim()||!row.display.trim()))return false;
 if(!rows.length&&!visitDiagnosisBaselines.get(form)?.length)return false;
 return Boolean(visitDiagnosisChangeReason(form));
}
function diagnosisFieldEvent(event){const target=event.target;if(!target?.closest?.('#visit-diagnoses-form'))return false;const name=typeof target.name==='string'?target.name:typeof target.getAttribute==='function'?target.getAttribute('name'):null;return name==='code'||name==='display'||name==='reason';}
function visitDiagnosisChanged(form,diagnoses){
 const baseline=visitDiagnosisBaselines.get(form);
 return !baseline||!sameDiagnosisValues(diagnoses,baseline)||!!String(form.elements.reason?.value||'').trim();
}
function visitDiagnosisFailure(form,values){
 const failure=visitDiagnosisAutosave.failure;
 if(!failure||failure.identity!==me||failure.id!==form.dataset.visitId||failure.patient!==form.dataset.patientId||failure.version!==form.dataset.version)return null;
 return failure.conflict||failure.values===JSON.stringify(values)?failure:null;
}
function diagnosisSaveStatus(form,text,error=false){
 const host=$('visit-diagnoses');if(!form||!host||$('visit-diagnoses-form')!==form)return;
 let status=host.querySelector('[data-diagnosis-saved]');
 if(!status){
  status=document.createElement('p');status.dataset.diagnosisSaved='';status.setAttribute('role','status');
  form.insertAdjacentElement?.('afterbegin',status);
 }
 status.className=error?'notice error':'muted';status.textContent=text;
 const refresh=host.querySelector('[data-diagnosis-refresh]');
 if(refresh){
  if(error)refresh.dataset.diagnosisRecovery='';
  else if(!host.querySelector('[data-diagnosis-rebase]'))delete refresh.dataset.diagnosisRecovery;
 }
}
function queueVisitDiagnosisAutosave(form){
 if(!form)return;
 if(visitDiagnosisAutosave.form!==form){visitDiagnosisAutosave.form=form;visitDiagnosisAutosave.submitted='';}
 clearTimeout(visitDiagnosisAutosave.timer);visitDiagnosisAutosave.timer=null;
 if(visitDiagnosisAutosave.busy||!visitDiagnosisReady(form))return;
 const values=visitDiagnosisFormValues(form);
 if(!visitDiagnosisChanged(form,values.diagnoses)||visitDiagnosisFailure(form,values)||JSON.stringify(values)===visitDiagnosisAutosave.submitted)return;
 visitDiagnosisAutosave.timer=setTimeout(()=>{
  visitDiagnosisAutosave.timer=null;
  const save=()=>{if($('visit-diagnoses-form')===form)return submitVisitDiagnoses(form,{autosave:true});};
  const task=typeof visitNoteEnqueue==='function'?visitNoteEnqueue(save):Promise.resolve(save());
  void task.catch(()=>{}); // The editor reports the failure and retains the draft for a deliberate retry.
 },350);
}
function reflectSavedDiagnosisValues(form,diagnoses){
 const rows=Array.from(form.querySelectorAll('[data-diagnosis-row]')).filter(row=>
  row.querySelector('[name="code"]').value.trim()||row.querySelector('[name="display"]').value.trim());
 if(rows.length!==diagnoses.length)return;
 rows.forEach((row,index)=>{
  const saved=diagnoses[index],code=row.querySelector('[name="code"]'),display=row.querySelector('[name="display"]');
  if(code.value!==saved.code)code.value=saved.code;
  if(display.value!==saved.display)display.value=saved.display;
  if(row.dataset){
   row.dataset.catalogReleaseId=saved.catalog_release_id||'';
   row.dataset.catalogCode=saved.code;row.dataset.catalogDisplay=saved.display;
  }
 });
}
function markVisitDiagnosesSaved(form,host,data){
 host.querySelector('[data-diagnosis-unsaved]')?.remove();
 const badge=host.querySelector('.section-head .badge');if(badge)badge.textContent=`${(data.diagnoses||[]).length} saved`;
 diagnosisSaveStatus(form,'Saved');
}
async function finishVisitDiagnosisSave(form,submitted,account,autosave){
 const id=form.dataset.visitId,patient=form.dataset.patientId,version=Number(form.dataset.version);
 visitDiagnosisLoads.delete(id);
 let data;try{data=await api(`/api/v1/visits/${id}/diagnoses`,'PUT',submitted,version);}finally{visitDiagnosisPending.delete(id);}
 if(me!==account)return;
 if(activeVisit?.id===id&&selected===patient&&activeVisit.version>data.version){
  throw Object.assign(new Error('The encounter changed. Reload diagnoses and review your edits.'),{status:409});
 }
 const existing=visitDiagnosisDrafts.get(id),live=activeVisit?.id===id&&selected===patient?$('visit-diagnoses-form'):null;
 const latest=live?visitDiagnosisFormValues(live):existing?.values||submitted;
 const unchanged=sameDiagnosisValues(latest.diagnoses,submitted.diagnoses)&&latest.reason===submitted.reason;
 const retainedVersion=existing?.version??version;
 if(unchanged)visitDiagnosisDrafts.delete(id);
 else visitDiagnosisDrafts.set(id,{patientId:patient,version:retainedVersion===version?data.version:retainedVersion,values:latest});
 if(live&&Number(live.dataset.version)===version){
  live.dataset.version=String(data.version);
  visitDiagnosisBaselines.set(live,diagnosisValues(data.diagnoses));
  if(unchanged){
   reflectSavedDiagnosisValues(live,data.diagnoses);
   if(live.elements.reason)live.elements.reason.value='';
  }
 }
 visitDiagnosisStates.set(id,{...data,patientId:patient});
 // Charges and diagnoses are worked on in one place now, so a save here carries straight across to
 // the charge lines on screen without a reload.
 visitDiagnosisSaved(id);
 if(activeVisit?.id!==id||selected!==patient)return;
 rememberVisit(data.visit,'diagnoses');
 const host=$('visit-diagnoses');if(!host)return;
 if(autosave&&live&&(unchanged||retainedVersion===version)){
  if(unchanged)markVisitDiagnosesSaved(live,host,data);else diagnosisSaveStatus(live,'Saving changes…');
  refreshEncounterProgress();return;
 }
 showVisitDiagnoses(host,data,id,patient);
 if(!autosave)notice('Diagnoses saved.');
}
function submitVisitDiagnoses(form,{autosave=false}={}){
 const submitted=visitDiagnosisFormValues(form),account=me;
 if(!submitted.diagnoses.length&&!visitDiagnosisBaselines.get(form)?.length){
  visitDiagnosisDrafts.delete(form.dataset.visitId);return Promise.resolve();
 }
 if(autosave){
  if(visitDiagnosisAutosave.inFlight)return visitDiagnosisAutosave.inFlight;
  if(!visitDiagnosisChanged(form,submitted.diagnoses))return Promise.resolve();
  if(visitDiagnosisAutosave.form!==form){visitDiagnosisAutosave.form=form;visitDiagnosisAutosave.submitted='';}
  const failure=visitDiagnosisFailure(form,submitted);if(failure)return Promise.reject(failure.error);
  visitDiagnosisAutosave.busy=true;visitDiagnosisAutosave.submitted=JSON.stringify(submitted);visitDiagnosisPending.set(form.dataset.visitId,submitted);
  const {patientId,visitId,version}=form.dataset;
  const pending=finishVisitDiagnosisSave(form,submitted,account,true).catch(error=>{
   if(me===account){
    const conflict=error.status===409||error.code==='conflict';
    const failure=conflict?new Error('The encounter changed. Reload diagnoses and review your edits.'):error;
    visitDiagnosisAutosave.failure={identity:account,id:visitId,patient:patientId,version,values:JSON.stringify(submitted),conflict,error:failure};
    if(selected===patientId&&activeVisit?.id===visitId)diagnosisSaveStatus($('visit-diagnoses-form'),failure.message,true);
    throw failure;
   }
   throw error;
  }).finally(()=>{
   visitDiagnosisAutosave.busy=false;visitDiagnosisAutosave.inFlight=null;
   const live=$('visit-diagnoses-form');if(live)queueVisitDiagnosisAutosave(live);
  });
  visitDiagnosisAutosave.inFlight=pending;return pending;
 }
 visitDiagnosisPending.set(form.dataset.visitId,submitted);
 return run(async()=>{
  captureVisitDiagnosisDraft();captureVisitDrafts();
  await finishVisitDiagnosisSave(form,submitted,account,false);
 });
}
async function flushVisitCodeDiagnoses(form){
 const visit=activeVisit?.id,patient=selected,identity=me;
 if(!form){
  if(visitDiagnosisDrafts.get(visit)?.patientId===patient)throw new Error('Reload diagnoses and review your unsaved changes.');
  return;
 }
 const current=()=>activeVisit?.id===visit&&selected===patient&&me===identity;
 if(form.dataset.visitId!==visit||form.dataset.patientId!==patient)throw new Error('The encounter changed. Reopen its codes.');
 clearTimeout(visitDiagnosisAutosave.timer);
 const save=async()=>{
  if(visitDiagnosisAutosave.inFlight)await visitDiagnosisAutosave.inFlight;
  while(current()){
   const live=$('visit-diagnoses-form');
   if(!live||live.dataset.visitId!==visit||live.dataset.patientId!==patient)break;
   const values=visitDiagnosisFormValues(live);
   if(!visitDiagnosisChanged(live,values.diagnoses)||(!values.diagnoses.length&&!visitDiagnosisBaselines.get(live)?.length))return;
   if(Number(live.dataset.version)!==activeVisit.version||live.closest?.('#visit-diagnoses')?.querySelector('[data-diagnosis-rebase]'))throw new Error('The encounter changed. Review the saved diagnoses before keeping your edits.');
   if(values.diagnoses.some(row=>!row.code.trim()||!row.display.trim()))throw new Error('Enter a code and description for each diagnosis, or remove the unfinished row.');
   if(!values.reason)throw new Error('Enter the reason for this diagnosis change.');
   const failure=visitDiagnosisFailure(live,values);
   if(failure){
    if(failure.conflict)throw failure.error;
    visitDiagnosisAutosave.failure=null;
   }
   await submitVisitDiagnoses(live,{autosave:true});
  }
  throw new Error('The encounter changed. Reopen its codes.');
 };
 return typeof visitNoteEnqueue==='function'?visitNoteEnqueue(save):save();
}
document.addEventListener('input',event=>{if(!diagnosisFieldEvent(event))return;visitDiagnosisRowValidity(event.target.closest('[data-diagnosis-row]'));captureVisitDiagnosisDraft();refreshEncounterProgress();if(event.isComposing)return;queueVisitDiagnosisAutosave(event.target.closest('#visit-diagnoses-form'));});
document.addEventListener('change',event=>{if(diagnosisFieldEvent(event)){visitDiagnosisRowValidity(event.target.closest('[data-diagnosis-row]'));queueVisitDiagnosisAutosave(event.target.closest('#visit-diagnoses-form'));}});
document.addEventListener('compositionend',event=>{if(diagnosisFieldEvent(event))queueVisitDiagnosisAutosave(event.target.closest('#visit-diagnoses-form'));});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='visit-diagnoses-form')return;event.preventDefault();event.stopImmediatePropagation();
 clearTimeout(visitDiagnosisAutosave.timer);visitDiagnosisAutosave.timer=null;
 if(form.closest?.('dialog[data-encounter-codes-dialog]')?.hasAttribute?.('data-encounter-codes-dialog')){
  void flushVisitCodeDiagnoses(form).catch(error=>diagnosisSaveStatus(form,error.message,true));
 }else if(typeof visitNoteEnqueue==='function')void visitNoteEnqueue(()=>submitVisitDiagnoses(form));else submitVisitDiagnoses(form);
},true);

// The note's chips use the same versioned diagnosis contract as the full editor.
async function visitDiagnosisInlineChange(item,removeCode){
 const id=activeVisit?.id,patient=selected,identity=me;
 if(!id||activeVisit.status==='signed')throw new Error('This note is signed. Open Edit codes for a billing correction.');
 clearTimeout(visitDiagnosisAutosave.timer);
 while(visitDiagnosisAutosave.busy)await new Promise(resolve=>setTimeout(resolve,30));
 if(activeVisit?.id!==id||selected!==patient||me!==identity)throw new Error('This page changed. Open the encounter again.');
 const form=$('visit-diagnoses-form');
 if(form)captureVisitDiagnosisDraft();
 if(visitDiagnosisDrafts.has(id))throw new Error('Review the changes in Edit codes before adding a code.');
 const data=await api(`/api/v1/visits/${id}/diagnoses`);
 if(activeVisit?.id!==id||selected!==patient||me!==identity)return;
 if(!data.can_edit||data.version!==activeVisit.version)throw new Error('This encounter changed. Reload it before changing diagnoses.');
 const rows=diagnosisValues(data.diagnoses).filter(row=>row.code!==removeCode);
 if(item&&!rows.some(row=>row.code===item.code))rows.push({code:item.code,display:item.display,...(item.catalog_release_id||item.release_id?{catalog_release_id:item.catalog_release_id||item.release_id}:{})});
 if(rows.length>20)throw new Error('An encounter can have up to 20 diagnoses.');
 const saved=await api(`/api/v1/visits/${id}/diagnoses`,'PUT',{diagnoses:rows,reason:removeCode?'Diagnosis removed from the note':'Diagnosis added from the note'},data.version);
 if(activeVisit?.id!==id||selected!==patient||me!==identity)return;
 visitDiagnosisStates.set(id,{...saved,patientId:patient});visitDiagnosisLoads.delete(id);
 rememberVisit(saved.visit,'diagnoses');visitDiagnosisSaved(id);
 const host=$('visit-diagnoses');if(host)showVisitDiagnoses(host,saved,id,patient);
 visitNoteInlinePaint();
}
