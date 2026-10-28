// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const roomingDrafts=new Map(),roomingBaselines=new WeakMap(),roomingPending=new Map();let roomingGeneration=0;
function roomingValues(value){
 return {status:value.status==='ready'?'ready':'in_progress',chief_complaint:String(value.chief_complaint??''),intake_notes:String(value.intake_notes??''),medications_reviewed:!!value.medications_reviewed,allergies_reviewed:!!value.allergies_reviewed};
}
function roomingFormValues(f){
 const values=formData(f);values.medications_reviewed=!!f.elements.medications_reviewed.checked;values.allergies_reviewed=!!f.elements.allergies_reviewed.checked;
 return roomingValues(values);
}
function sameRoomingValues(a,b){return !!a&&!!b&&Object.keys(roomingValues(a)).every(key=>roomingValues(a)[key]===roomingValues(b)[key]);}
function captureRoomingDraft(){
 const f=$('rooming-form');if(!f)return;
 const values=roomingFormValues(f),baseline=roomingBaselines.get(f);
 if(!baseline)return;
 const pending=roomingPending.get(f.dataset.visitId);
 if(sameRoomingValues(values,baseline.values)&&(!pending||sameRoomingValues(values,pending))){roomingDrafts.delete(f.dataset.visitId);return;}
 roomingDrafts.set(f.dataset.visitId,{patientId:f.dataset.patientId,version:Number(f.dataset.version),values});
}
async function renderRooming(){
 const host=$('visit-rooming');if(!host||!activeVisit)return;
 const id=activeVisit.id,patient=selected,generation=++roomingGeneration;
 host.innerHTML='<h3>Rooming and clinical intake</h3><p class="muted">Loading saved intake…</p>';
 try{
  const data=await api(`/api/v1/visits/${id}/rooming`);
  if(generation!==roomingGeneration||activeVisit?.id!==id||selected!==patient||$('visit-rooming')!==host)return;
  const draft=roomingDrafts.get(id),retained=draft?.patientId===patient&&data.visit?.status!=='signed'?draft:null,values=retained?.values||data,stale=data.version!==activeVisit.version,needsReview=!!retained&&retained.version!==data.version,locked=!data.can_edit||stale;
  host.innerHTML=`<div class="section-head"><h3>Rooming and clinical intake</h3><span class="badge">${esc(human(data.status))}</span></div><p class="muted">Intake remains separate from the assigned clinician’s SOAP note and signature. Medication and allergy review records staff review; corrections to clinical lists require an authorized clinician.</p>${retained?'<p role="status" class="muted">Unsaved intake retained in this tab.</p>':''}${needsReview?`<section role="status"><p>The saved encounter changed. Compare your retained intake edits with the saved record before using the current version.</p><p>Saved chief complaint: ${esc(data.chief_complaint)}<br>Saved intake notes: ${esc(data.intake_notes)}<br>Saved status: ${esc(human(data.status))} · Medication review ${data.medications_reviewed?'complete':'incomplete'} · Allergy review ${data.allergies_reviewed?'complete':'incomplete'}</p>${!locked?`<button type="button" data-rooming-rebase="${data.version}">Keep intake edits against current version</button>`:''}</section>`:''}${stale?'<p role="status">This encounter changed. Reload the saved encounter before editing intake; unsaved note, vitals and intake edits remain in this tab.</p><button type="button" data-rooming-refresh>Reload saved encounter</button>':''}<form id="rooming-form" data-visit-id="${esc(id)}" data-patient-id="${esc(patient)}" data-version="${retained?.version??data.version}"><div class="form-grid"><label>Chief complaint<textarea name="chief_complaint" maxlength="2000" ${locked?'readonly':''}>${esc(values.chief_complaint)}</textarea></label><label>Intake notes<textarea name="intake_notes" maxlength="10000" ${locked?'readonly':''}>${esc(values.intake_notes)}</textarea></label><label><input type="checkbox" name="medications_reviewed" ${values.medications_reviewed?'checked':''} ${locked?'disabled':''}> Medication list reviewed with patient</label><label><input type="checkbox" name="allergies_reviewed" ${values.allergies_reviewed?'checked':''} ${locked?'disabled':''}> Allergy list reviewed with patient</label><label>Rooming status<select name="status" ${locked?'disabled':''}><option value="in_progress" ${values.status==='in_progress'||values.status==='not_started'?'selected':''}>Rooming in progress</option><option value="ready" ${values.status==='ready'?'selected':''}>Ready for clinician</option></select></label></div>${locked?'':`<button type="submit" ${needsReview?'disabled':''}>Save intake</button>`}</form><p class="muted">${data.updated_at?`Last intake update ${esc(date(data.updated_at))} · Staff ${esc(data.updated_by_label||data.updated_by)}`:'No intake saved.'}</p><details><summary>Attributed intake and vitals history</summary>${data.history.map(r=>`<section><p>Encounter v${esc(r.visit_version)} · ${esc(human(r.kind))} · ${esc(date(r.created_at))}<br>Staff ${esc(r.actor_label||r.actor_id)}</p>${r.kind==='vitals'?`<p>${esc(Object.entries(r.snapshot.vitals||{}).map(([k,v])=>`${human(k)}: ${v}`).join(' · '))}</p>`:`<p>${esc(r.snapshot.chief_complaint)} · ${esc(human(r.snapshot.status))}</p>`}</section>`).join('')||'<p>No intake or vitals history recorded.</p>'}</details>`;
  const form=$('rooming-form');if(form)roomingBaselines.set(form,{values:roomingValues(data),version:data.version});
 }catch(e){if(generation===roomingGeneration&&$('visit-rooming')===host)host.textContent=`Intake could not load: ${e.message}`;}
}
document.addEventListener('input',e=>{if(e.target.closest?.('#rooming-form'))captureRoomingDraft();});
document.addEventListener('change',e=>{if(e.target.closest?.('#rooming-form'))captureRoomingDraft();});
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-rooming-refresh],[data-rooming-rebase]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();run(async()=>{captureRoomingDraft();if(b.hasAttribute('data-rooming-rebase')){const draft=roomingDrafts.get(activeVisit.id);if(draft)draft.version=Number(b.dataset.roomingRebase);await renderRooming();return;}captureVisitDrafts();const id=activeVisit.id,v=await api(`/api/v1/visits/${id}`);if(activeVisit?.id!==id)return;rememberVisit(v);renderVisit(false);});},true);
document.addEventListener('submit',e=>{
 const f=e.target;if(f.id!=='rooming-form')return;e.preventDefault();e.stopImmediatePropagation();
 run(async()=>{
  captureRoomingDraft();captureVisitDrafts();
  const id=f.dataset.visitId,patient=f.dataset.patientId,submitted=roomingFormValues(f),version=Number(f.dataset.version);
  const account=typeof me==='undefined'?null:me?.user_id;
  roomingPending.set(id,submitted);
  let data;try{data=await api(`/api/v1/visits/${id}/rooming`,'PUT',submitted,version);}finally{roomingPending.delete(id);}
  if(typeof me!=='undefined'&&me?.user_id!==account)return;
  // Inputs remain usable while the request is pending. Only clear the exact
  // submitted draft; newer typing remains attached to its original version.
  const visible=$('rooming-form')===f&&activeVisit?.id===id&&selected===patient;
  const existing=roomingDrafts.get(id),latest=visible?roomingFormValues(f):existing?.values||submitted;
  const saved=roomingValues(data);
  roomingBaselines.set(f,{values:saved,version:data.version});
  if(sameRoomingValues(latest,submitted)||sameRoomingValues(latest,saved))roomingDrafts.delete(id);
  else roomingDrafts.set(id,{patientId:patient,version:existing?.version??version,values:latest});
  if(activeVisit?.id!==id||selected!==patient)return;
  rememberVisit(data.visit,'rooming');await renderRooming();notice('Rooming intake saved with staff attribution.');
 });
},true);
