// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const visitDiagnosisDrafts=new Map(),visitDiagnosisStates=new Map(),visitDiagnosisBaselines=new WeakMap(),visitDiagnosisPending=new Map(),visitDiagnosisAutosave={timer:null,busy:false,form:null,submitted:''};let visitDiagnosisGeneration=0;
function diagnosisValues(rows){return (rows||[]).map(row=>({code:String(row.code??''),display:String(row.display??''),...(row.catalog_release_id?{catalog_release_id:String(row.catalog_release_id)}:{})}));}
function sameDiagnosisValues(a,b){return JSON.stringify(diagnosisValues(a))===JSON.stringify(diagnosisValues(b));}
function visitDiagnosisFormValues(form){return {diagnoses:Array.from(form.querySelectorAll('[data-diagnosis-row]'),row=>({code:row.querySelector('[name="code"]').value,display:row.querySelector('[name="display"]').value,...(row.dataset?.catalogReleaseId?{catalog_release_id:row.dataset.catalogReleaseId}:{})})),reason:String(form.elements.reason?.value||'').trim()||(activeVisit?.status==='signed'?'Billing correction':'')};}
function captureVisitDiagnosisDraft(){
 const form=$('visit-diagnoses-form');if(!form)return;
 const baseline=visitDiagnosisBaselines.get(form);if(!baseline)return;
 const values=visitDiagnosisFormValues(form),pending=visitDiagnosisPending.get(form.dataset.visitId);
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
function visitDiagnosisSaved(id){for(const notify of [...visitDiagnosisListeners]){try{notify(id);}catch{}}if(id)chargeDiagnosisDraftFollow=id;}
function showVisitDiagnoses(host,data,id,patient){
 const draft=visitDiagnosisDrafts.get(id),stale=data.version!==activeVisit.version,locked=!data.can_edit||stale,retained=draft?.patientId===patient&&(!locked||data.visit?.status!=='signed')?draft:null,rows=retained?.values.diagnoses||diagnosisValues(data.diagnoses),needsReview=!!retained&&retained.version!==data.version;
 // A blank row that was only just added is not an unsaved edit yet: the notices wait until there is something to lose.
 const unsaved=!!retained&&(needsReview||!!retained.values.reason||JSON.stringify(rows.filter(row=>row.code||row.display).map(row=>[row.code,row.display]))!==JSON.stringify(data.diagnoses.map(row=>[row.code,row.display])));
 host.innerHTML=`<div class="section-head"><h3>Diagnoses</h3>${data.diagnoses.length?`<span class="badge">${data.diagnoses.length} saved</span>`:''}</div><p class="muted">List the primary diagnosis first.</p>${data.visit?.status==='signed'?(locked?'<p class="muted">Only a clinician or the practice owner can change the diagnoses of a signed visit.</p>':'<p class="muted">Changes after signing are saved as billing corrections.</p>'):''}${data.visit?.status==='signed'&&!locked&&unsaved?'<section role="status"><button type="button" data-diagnosis-discard>Discard unsaved diagnoses</button></section>':''}${unsaved?'<p role="status" data-diagnosis-unsaved>You have diagnosis edits that have not saved yet.</p>':''}${needsReview?`<section role="status"><p>Someone else saved this encounter. Compare your changes with the saved diagnoses before saving.</p>${diagnosisListMarkup(data.diagnoses)}${!locked?`<button type="button" data-diagnosis-rebase="${data.version}">Keep my changes</button>`:''}</section>`:''}${stale?'<p role="status">This encounter was changed elsewhere. Reload it before editing; your unsaved changes are kept.</p>':''}<button type="button" class="text-button" data-diagnosis-refresh>Reload</button>${locked?diagnosisListMarkup(data.diagnoses):`<form id="visit-diagnoses-form" data-visit-id="${esc(id)}" data-patient-id="${esc(patient)}" data-version="${retained?.version??data.version}"><div>${rows.map((row,i)=>`<div class="amendment" data-diagnosis-row data-catalog-release-id="${esc(row.catalog_release_id||'')}" data-catalog-code="${esc(row.code)}" data-catalog-display="${esc(row.display)}" data-catalog-system="ICD-10-CM"><div class="section-head"><strong>${typeof diagnosisLetterBadge==='function'?diagnosisLetterBadge(i):''}${i===0?'Primary diagnosis':`Diagnosis ${i+1}`}</strong><div class="actions"><button type="button" data-diagnosis-up="${i}" ${i===0?'disabled':''}>Move up</button><button type="button" data-diagnosis-remove="${i}">Remove</button></div></div><div class="form-grid">${typeof terminologyDiagnosisFields==='function'?terminologyDiagnosisFields(row):`<label>Code<input name="code" value="${esc(row.code)}" required maxlength="8" autocomplete="off"></label><label>Description<input name="display" value="${esc(row.display)}" required maxlength="2000" autocomplete="off"></label>`}</div>${typeof terminologySnapshotMarkup==='function'?terminologySnapshotMarkup(data.diagnoses.find(saved=>saved.code===row.code&&saved.display===row.display&&saved.catalog_release_id===row.catalog_release_id)?.catalog_snapshot):''}</div>`).join('')||'<p class="muted">No diagnoses yet.</p>'}</div><div class="actions"><button type="button" data-diagnosis-add ${rows.length>=20?'disabled':''}>Add diagnosis</button></div><label>Reason for this change<input name="reason" value="${esc(retained?.values.reason||'')}" ${data.visit?.status==='signed'?'placeholder="Billing correction"':'required placeholder="For example: added after exam"'} maxlength="2000" autocomplete="off"></label><div class="actions"><button type="submit" ${needsReview?'disabled':''}>Save diagnoses</button>${unsaved?'<button type="button" class="text-button" data-diagnosis-discard>Discard diagnosis edits</button>':''}</div></form>`}<details><summary>Diagnosis history</summary>${(data.history||[]).map(revision=>`<section class="amendment"><p>${esc(date(revision.created_at))} · ${esc(revision.actor_label||revision.actor_id)} · ${esc(revision.reason)}</p>${diagnosisListMarkup(revision.diagnoses||(Array.isArray(revision.snapshot)?revision.snapshot:revision.snapshot?.diagnoses)||[])}</section>`).join('')||'<p class="muted">No changes yet.</p>'}${data.history_truncated?'<p class="muted">Older changes are not shown.</p>':''}</details>`;
 const form=$('visit-diagnoses-form');if(form){visitDiagnosisBaselines.set(form,diagnosisValues(data.diagnoses));if(!host.querySelector('[data-diagnosis-rebase]'))queueVisitDiagnosisAutosave(form);}
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
  if(button.hasAttribute('data-diagnosis-refresh')){captureVisitDrafts();const visit=await api(`/api/v1/visits/${id}`);if(activeVisit?.id!==id||selected!==patient)return;rememberVisit(visit);renderVisit(false);return;}
  if(button.hasAttribute('data-diagnosis-discard')){if(!await confirmAction('Diagnosis edits that have not saved yet will be removed and the saved diagnosis list will be restored.',{title:'Discard diagnosis edits?',confirmLabel:'Discard edits',tone:'danger'}))return;visitDiagnosisDrafts.delete(id);showVisitDiagnoses(host,data,id,patient);return;}
  if(!data.can_edit||data.version!==activeVisit.version)return;
  const draft=visitDiagnosisDrafts.get(id)||{patientId:patient,version:data.version,values:{diagnoses:diagnosisValues(data.diagnoses),reason:''}};
  if(button.hasAttribute('data-diagnosis-rebase')){draft.version=Number(button.dataset.diagnosisRebase);visitDiagnosisAutosave.submitted='';}
  else if(button.hasAttribute('data-diagnosis-add')){if(draft.values.diagnoses.length>=20)return;draft.values.diagnoses.push({code:'',display:''});}
  else{const index=Number(button.dataset.diagnosisRemove??button.dataset.diagnosisUp);if(!Number.isInteger(index)||index<0||index>=draft.values.diagnoses.length)return;if(button.hasAttribute('data-diagnosis-remove'))draft.values.diagnoses.splice(index,1);else if(index>0)[draft.values.diagnoses[index-1],draft.values.diagnoses[index]]=[draft.values.diagnoses[index],draft.values.diagnoses[index-1]];}
  visitDiagnosisDrafts.set(id,draft);showVisitDiagnoses(host,data,id,patient);
  // A new row is for typing in: the cursor goes to its code box.
  if(button.hasAttribute('data-diagnosis-add')){const added=Array.from($('visit-diagnoses-form')?.querySelectorAll?.('[data-diagnosis-row]')||[]).pop();(added?.querySelector?.('input[name="diagnosis"]')||added?.querySelector?.('input:not([type="hidden"])'))?.focus?.();}
  // Removing or moving a diagnosis saves at once, like typing one does: there is no separate save step.
  if(button.hasAttribute('data-diagnosis-remove')||button.hasAttribute('data-diagnosis-up'))queueVisitDiagnosisAutosave($('visit-diagnoses-form'));
 });
},true);
function visitDiagnosisReady(form){
 if(!form||form.closest?.('#visit-diagnoses')?.querySelector('[data-diagnosis-rebase]'))return false;
 const rows=Array.from(form.querySelectorAll('[data-diagnosis-row]'));
 if(!rows.length||rows.some(row=>!row.querySelector('[name="code"]')?.value.trim()||!row.querySelector('[name="display"]')?.value.trim()))return false;
 const reason=form.elements.reason||form.querySelector('[name="reason"]');
 return !!String(reason?.value||'').trim()||activeVisit?.status==='signed';
}
function diagnosisFieldEvent(event){const target=event.target;if(!target?.closest?.('#visit-diagnoses-form'))return false;const name=typeof target.name==='string'?target.name:typeof target.getAttribute==='function'?target.getAttribute('name'):null;return name==='code'||name==='display'||name==='reason';}
function queueVisitDiagnosisAutosave(form){
 if(!form)return;
 if(visitDiagnosisAutosave.form!==form){visitDiagnosisAutosave.form=form;visitDiagnosisAutosave.submitted='';}
 clearTimeout(visitDiagnosisAutosave.timer);visitDiagnosisAutosave.timer=null;
 if(visitDiagnosisAutosave.busy||!visitDiagnosisReady(form))return;
 const snapshot=JSON.stringify(visitDiagnosisFormValues(form));
 if(snapshot===visitDiagnosisAutosave.submitted)return;
 visitDiagnosisAutosave.timer=setTimeout(()=>{visitDiagnosisAutosave.timer=null;submitVisitDiagnoses(form,{autosave:true});},350);
}
function markVisitDiagnosesSaved(form,host,data){
 // The save answer carries the encounter's new version, and the form is about to save against it
 // again the moment the next key is pressed. A form left on the old version is a form the next
 // click is told to reload, and every edit after that is refused as someone-else-changed-it.
 form.dataset.version=String(data.version);
 host.querySelector('[data-diagnosis-unsaved]')?.remove();
 const badge=host.querySelector('.section-head .badge');if(badge)badge.textContent=`${(data.diagnoses||[]).length} saved`;
 let status=host.querySelector('[data-diagnosis-saved]');
 if(!status){status=document.createElement('p');status.className='muted';status.dataset.diagnosisSaved='';status.setAttribute('role','status');form.insertAdjacentElement('afterbegin',status);}
 status.textContent='Saved';
}
async function finishVisitDiagnosisSave(form,submitted,account,autosave){
 const id=form.dataset.visitId,patient=form.dataset.patientId,version=Number(form.dataset.version);
 let data;try{data=await api(`/api/v1/visits/${id}/diagnoses`,'PUT',submitted,version);}finally{visitDiagnosisPending.delete(id);if(autosave)visitDiagnosisAutosave.busy=false;}
 if(me!==account)return;
 const existing=visitDiagnosisDrafts.get(id),visible=$('visit-diagnoses-form')===form&&activeVisit?.id===id&&selected===patient,latest=visible?visitDiagnosisFormValues(form):existing?.values||submitted;
 visitDiagnosisBaselines.set(form,diagnosisValues(data.diagnoses));
 if(sameDiagnosisValues(latest.diagnoses,submitted.diagnoses)&&latest.reason===submitted.reason){visitDiagnosisDrafts.delete(id);if(autosave)visitDiagnosisAutosave.submitted=JSON.stringify(submitted);}
 else visitDiagnosisDrafts.set(id,{patientId:patient,version:existing?.version??version,values:latest});
 visitDiagnosisStates.set(id,{...data,patientId:patient});
 // Charges and diagnoses are worked on in one place now, so a save here carries straight across to
 // the charge lines on screen without a reload.
 visitDiagnosisSaved(id);
 if(activeVisit?.id!==id||selected!==patient)return;
 if(activeVisit)Object.assign(activeVisit,data.visit||{});
 rememberVisit(data.visit,'diagnoses');
 const host=$('visit-diagnoses');if(!host)return;
 if(autosave&&visible&&sameDiagnosisValues(latest.diagnoses,submitted.diagnoses)&&latest.reason===submitted.reason){markVisitDiagnosesSaved(form,host,data);refreshEncounterProgress();return;}
 showVisitDiagnoses(host,data,id,patient);
 notice('Diagnoses saved.');
}
function submitVisitDiagnoses(form,{autosave=false}={}){
 const submitted=visitDiagnosisFormValues(form),account=me;
 if(autosave){
  if(visitDiagnosisAutosave.busy)return Promise.resolve();
  if(visitDiagnosisAutosave.submitted===JSON.stringify(submitted))return Promise.resolve();
  visitDiagnosisAutosave.busy=true;visitDiagnosisAutosave.submitted=JSON.stringify(submitted);visitDiagnosisPending.set(form.dataset.visitId,submitted);
  return finishVisitDiagnosisSave(form,submitted,account,true).catch(error=>{
   visitDiagnosisAutosave.busy=false;visitDiagnosisAutosave.submitted='';visitDiagnosisPending.delete(form.dataset.visitId);
   if($('visit-diagnoses-form')===form)queueVisitDiagnosisAutosave(form);
   if(me&&$('visit-diagnoses-form')===form)notice(error.message,true);
  });
 }
 visitDiagnosisPending.set(form.dataset.visitId,submitted);
 return run(async()=>{
  captureVisitDiagnosisDraft();captureVisitDrafts();
  await finishVisitDiagnosisSave(form,submitted,account,false);
 });
}
document.addEventListener('input',event=>{if(!diagnosisFieldEvent(event))return;captureVisitDiagnosisDraft();refreshEncounterProgress();if(event.isComposing)return;queueVisitDiagnosisAutosave(event.target.closest('#visit-diagnoses-form'));});
document.addEventListener('change',event=>{if(diagnosisFieldEvent(event))queueVisitDiagnosisAutosave(event.target.closest('#visit-diagnoses-form'));});
document.addEventListener('compositionend',event=>{if(diagnosisFieldEvent(event))queueVisitDiagnosisAutosave(event.target.closest('#visit-diagnoses-form'));});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='visit-diagnoses-form')return;event.preventDefault();event.stopImmediatePropagation();
 clearTimeout(visitDiagnosisAutosave.timer);visitDiagnosisAutosave.timer=null;
 submitVisitDiagnoses(form);
},true);
