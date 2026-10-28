// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const visitDiagnosisDrafts=new Map(),visitDiagnosisStates=new Map(),visitDiagnosisBaselines=new WeakMap(),visitDiagnosisPending=new Map();let visitDiagnosisGeneration=0;
function diagnosisValues(rows){return (rows||[]).map(row=>({code:String(row.code??''),display:String(row.display??'')}));}
function sameDiagnosisValues(a,b){return JSON.stringify(diagnosisValues(a))===JSON.stringify(diagnosisValues(b));}
function visitDiagnosisFormValues(form){return {diagnoses:Array.from(form.querySelectorAll('[data-diagnosis-row]'),row=>({code:row.querySelector('[name="code"]').value,display:row.querySelector('[name="display"]').value})),reason:form.elements.reason.value};}
function captureVisitDiagnosisDraft(){
 const form=$('visit-diagnoses-form');if(!form)return;
 const baseline=visitDiagnosisBaselines.get(form);if(!baseline)return;
 const values=visitDiagnosisFormValues(form),pending=visitDiagnosisPending.get(form.dataset.visitId);
 if(sameDiagnosisValues(values.diagnoses,baseline)&&!values.reason&&(!pending||sameDiagnosisValues(values.diagnoses,pending.diagnoses))){visitDiagnosisDrafts.delete(form.dataset.visitId);return;}
 visitDiagnosisDrafts.set(form.dataset.visitId,{patientId:form.dataset.patientId,version:Number(form.dataset.version),values});
}
function visitDiagnosisProgress(){
 const data=activeVisit?visitDiagnosisStates.get(activeVisit.id):null;
 if(!activeVisit)return {label:'Select an encounter',complete:false};
 if(!data||data.patientId!==selected||data.version!==activeVisit.version)return {label:'Review diagnoses',complete:false};
 const draft=visitDiagnosisDrafts.get(activeVisit.id);
 if(draft?.patientId===selected&&activeVisit.status!=='signed')return {label:'Unsaved diagnosis edits',complete:false};
 return {label:data.diagnoses.length?`${data.diagnoses.length} recorded`:'No encounter diagnoses recorded',complete:data.diagnoses.length>0};
}
function diagnosisListMarkup(rows){return rows.length?`<ol>${rows.map((row,i)=>`<li>${esc(row.code)} · ${esc(row.display)}${i===0?' <span class="badge">Primary</span>':''}</li>`).join('')}</ol>`:'<p class="muted">No encounter diagnoses recorded.</p>';}
function showVisitDiagnoses(host,data,id,patient){
 const draft=visitDiagnosisDrafts.get(id),unsignedDraft=draft?.patientId===patient&&data.visit?.status==='signed'?draft:null,retained=draft?.patientId===patient&&data.visit?.status!=='signed'?draft:null,rows=retained?.values.diagnoses||diagnosisValues(data.diagnoses),stale=data.version!==activeVisit.version,locked=!data.can_edit||stale,needsReview=!!retained&&retained.version!==data.version;
 host.innerHTML=`<div class="section-head"><h3>Encounter diagnoses</h3><span class="badge">${data.visit?.status==='signed'?'Signed record':`${data.diagnoses.length} saved`}</span></div><p class="muted">Diagnoses apply to this encounter. The first diagnosis is primary. Enter ICD-10-CM codes and descriptions; codes are not validated against a terminology catalog. These entries do not change the longitudinal problem list.</p>${unsignedDraft?`<section role="status"><p>This encounter was signed while this tab contained unsaved diagnosis edits. Those edits are not part of the signed record. Copy them for a separate correction or discard the draft.</p><details><summary>View and copy unsaved diagnosis draft</summary><label>Unsigned draft only<textarea readonly aria-label="Unsigned diagnosis draft">${esc(unsignedDraft.values.diagnoses.map((row,i)=>`${i+1}. ${row.code} — ${row.display}`).join('\n')+'\nReason: '+unsignedDraft.values.reason)}</textarea></label></details><button type="button" data-diagnosis-discard>Discard unsigned diagnosis draft</button></section>`:''}${retained?'<p role="status">Unsaved diagnosis edits retained in this tab.</p>':''}${needsReview?`<section role="status"><p>The saved encounter changed. Compare your edits with the saved diagnosis list before saving.</p>${diagnosisListMarkup(data.diagnoses)}${!locked?`<button type="button" data-diagnosis-rebase="${data.version}">Keep diagnosis edits against current version</button>`:''}</section>`:''}${stale?'<p role="status">Reload the saved encounter before editing diagnoses. Your unsaved edits remain in this tab.</p>':''}<button type="button" class="text-button" data-diagnosis-refresh>Reload saved encounter</button>${locked?diagnosisListMarkup(data.diagnoses):`<form id="visit-diagnoses-form" data-visit-id="${esc(id)}" data-patient-id="${esc(patient)}" data-version="${retained?.version??data.version}"><div>${rows.map((row,i)=>`<div class="amendment" data-diagnosis-row><div class="section-head"><strong>${i===0?'Primary diagnosis':`Diagnosis ${i+1}`}</strong><div class="actions"><button type="button" data-diagnosis-up="${i}" ${i===0?'disabled':''}>Move up</button><button type="button" data-diagnosis-remove="${i}">Remove</button></div></div><div class="form-grid"><label>ICD-10-CM code<input name="code" value="${esc(row.code)}" required maxlength="8" autocomplete="off"></label><label>Description<input name="display" value="${esc(row.display)}" required maxlength="500" autocomplete="off"></label></div></div>`).join('')||'<p class="muted">No diagnoses entered. Add a diagnosis to document the reason for this visit.</p>'}</div><div class="actions"><button type="button" data-diagnosis-add ${rows.length>=20?'disabled':''}>Add diagnosis</button></div><label>Reason for this change<input name="reason" value="${esc(retained?.values.reason||'')}" required maxlength="2000" autocomplete="off" placeholder="Why are you adding or revising these diagnoses?"></label><div class="actions"><button type="submit" ${needsReview?'disabled':''}>Save diagnoses</button>${retained?'<button type="button" class="text-button" data-diagnosis-discard>Discard diagnosis edits</button>':''}</div></form>`}<details><summary>Diagnosis revision history</summary>${(data.history||[]).map(revision=>`<section class="amendment"><p>Encounter v${esc(revision.visit_version)} · ${esc(date(revision.created_at))}<br>Staff ${esc(revision.actor_label||revision.actor_id)} · ${esc(revision.reason)}</p>${diagnosisListMarkup(revision.diagnoses||(Array.isArray(revision.snapshot)?revision.snapshot:revision.snapshot?.diagnoses)||[])}</section>`).join('')||'<p class="muted">No diagnosis revisions recorded.</p>'}${data.history_truncated?'<p class="muted">Older revisions are omitted from this view.</p>':''}</details>`;
 const form=$('visit-diagnoses-form');if(form)visitDiagnosisBaselines.set(form,diagnosisValues(data.diagnoses));
 refreshEncounterProgress();
}
async function renderVisitDiagnoses(){
 const host=$('visit-diagnoses');if(!host||!activeVisit)return;
 captureVisitDiagnosisDraft();
 const id=activeVisit.id,patient=selected,generation=++visitDiagnosisGeneration;
 host.innerHTML='<h3>Encounter diagnoses</h3><p class="muted">Loading saved diagnoses…</p>';
 try{
  const data=await api(`/api/v1/visits/${id}/diagnoses`);
  if(generation!==visitDiagnosisGeneration||activeVisit?.id!==id||selected!==patient||$('visit-diagnoses')!==host)return;
  visitDiagnosisStates.set(id,{...data,patientId:patient});showVisitDiagnoses(host,data,id,patient);
 }catch(error){if(generation===visitDiagnosisGeneration&&$('visit-diagnoses')===host){host.textContent=`Diagnoses could not load: ${error.message}`;visitDiagnosisStates.delete(id);refreshEncounterProgress();}}
}
document.addEventListener('input',event=>{if(event.target.closest?.('#visit-diagnoses-form')){captureVisitDiagnosisDraft();refreshEncounterProgress();}});
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-diagnosis-add],[data-diagnosis-remove],[data-diagnosis-up],[data-diagnosis-rebase],[data-diagnosis-refresh],[data-diagnosis-discard]');if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  captureVisitDiagnosisDraft();
  const id=activeVisit?.id,patient=selected,host=$('visit-diagnoses'),data=visitDiagnosisStates.get(id);if(!id||!host||data?.patientId!==patient)return;
  if(button.hasAttribute('data-diagnosis-refresh')){captureVisitDrafts();const visit=await api(`/api/v1/visits/${id}`);if(activeVisit?.id!==id||selected!==patient)return;rememberVisit(visit);renderVisit(false);return;}
  if(button.hasAttribute('data-diagnosis-discard')){if(!window.confirm('Discard unsaved diagnosis edits and use the saved diagnosis list?'))return;visitDiagnosisDrafts.delete(id);showVisitDiagnoses(host,data,id,patient);return;}
  if(!data.can_edit||data.version!==activeVisit.version)return;
  const draft=visitDiagnosisDrafts.get(id)||{patientId:patient,version:data.version,values:{diagnoses:diagnosisValues(data.diagnoses),reason:''}};
  if(button.hasAttribute('data-diagnosis-rebase'))draft.version=Number(button.dataset.diagnosisRebase);
  else if(button.hasAttribute('data-diagnosis-add')){if(draft.values.diagnoses.length>=20)return;draft.values.diagnoses.push({code:'',display:''});}
  else{const index=Number(button.dataset.diagnosisRemove??button.dataset.diagnosisUp);if(!Number.isInteger(index)||index<0||index>=draft.values.diagnoses.length)return;if(button.hasAttribute('data-diagnosis-remove'))draft.values.diagnoses.splice(index,1);else if(index>0)[draft.values.diagnoses[index-1],draft.values.diagnoses[index]]=[draft.values.diagnoses[index],draft.values.diagnoses[index-1]];}
  visitDiagnosisDrafts.set(id,draft);showVisitDiagnoses(host,data,id,patient);
 });
},true);
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='visit-diagnoses-form')return;event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  captureVisitDiagnosisDraft();captureVisitDrafts();
  const id=form.dataset.visitId,patient=form.dataset.patientId,version=Number(form.dataset.version),submitted=visitDiagnosisFormValues(form),account=me;
  visitDiagnosisPending.set(id,submitted);
  let data;try{data=await api(`/api/v1/visits/${id}/diagnoses`,'PUT',submitted,version);}finally{visitDiagnosisPending.delete(id);}
  if(me!==account)return;
  const existing=visitDiagnosisDrafts.get(id),visible=$('visit-diagnoses-form')===form&&activeVisit?.id===id&&selected===patient,latest=visible?visitDiagnosisFormValues(form):existing?.values||submitted;
  visitDiagnosisBaselines.set(form,diagnosisValues(data.diagnoses));
  if(sameDiagnosisValues(latest.diagnoses,submitted.diagnoses)&&latest.reason===submitted.reason)visitDiagnosisDrafts.delete(id);
  else visitDiagnosisDrafts.set(id,{patientId:patient,version:existing?.version??version,values:latest});
  visitDiagnosisStates.set(id,{...data,patientId:patient});
  if(activeVisit?.id!==id||selected!==patient)return;
  rememberVisit(data.visit,'diagnoses');
  const host=$('visit-diagnoses');if(host)showVisitDiagnoses(host,data,id,patient);
  notice('Encounter diagnoses saved with revision history.');
 });
},true);
