// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let patientDirectoryStatus='active',patientLifecycleGeneration=0;
const patientLifecycleStates=new Map(),patientLifecycleDrafts=new Map(),patientLifecycleRetiredForms=new WeakSet();
function patientDirectoryQuery(after){const q=new URLSearchParams({status:patientDirectoryStatus});if(after)q.set('after',after);return '/api/v1/patients?'+q;}
function clearPatientLifecycleSession(){patientDirectoryStatus='active';patientLifecycleGeneration++;patientLifecycleStates.clear();patientLifecycleDrafts.clear();if($('patient-status-filter'))$('patient-status-filter').value='active';}
function patientLifecycleValues(form){return {reason:form.elements.reason.value,confirmed:form.elements.confirmed.checked,archived:form.dataset.archived==='true',version:Number(form.dataset.version)};}
function capturePatientLifecycleDraft(){const form=$('patient-lifecycle-form');if(form&&!patientLifecycleRetiredForms.has(form))patientLifecycleDrafts.set(form.dataset.patient,patientLifecycleValues(form));}
function patientLifecycleHasDrafts(){return [...patientLifecycleDrafts.values()].some(d=>d.reason.trim()||d.confirmed);}
function patientLifecycleMarkup(data){
 const draft=patientLifecycleDrafts.get(data.patient_id),stale=draft&&draft.version!==data.version,action=data.archived?'Restore':'Archive';
 return `<div class="section-head"><div><b>${data.archived?'Archived patient chart':'Patient chart status'}</b>${data.archived?'<p>This chart is hidden from the active directory. Restore it before booking a new appointment or starting an encounter. Existing records remain available.</p>':''}</div>${data.can_manage?`<button type="button" data-patient-lifecycle-open>${action} patient…</button>`:''}</div>${draft&&data.can_manage?`<form id="patient-lifecycle-form" data-patient="${esc(data.patient_id)}" data-version="${draft.version}" data-archived="${draft.archived}"><h3>${draft.archived?'Archive':'Restore'} patient</h3><p>Archiving never deletes clinical records, uploaded files, signed notes, claims or payment history. Existing appointments keep their status, and an encounter already in progress can still be completed.</p>${stale?'<p role="alert">Archive status changed. Your reason is retained; cancel this draft and review the current status before continuing.</p>':''}<label>Reason<input name="reason" required maxlength="1000" value="${esc(draft.reason)}"></label><label><input name="confirmed" type="checkbox" required ${draft.confirmed?'checked':''}> I confirm that I want to ${draft.archived?'archive':'restore'} this patient chart.</label><div class="actions"><button type="submit" ${stale?'disabled':''}>${draft.archived?'Archive patient':'Restore patient'}</button><button type="button" data-patient-lifecycle-cancel>Cancel</button></div></form>`:''}${data.history?.length?`<details><summary>Archive & restore history</summary>${data.history.map(h=>`<p><b>${h.archived?'Archived':'Restored'}</b> · ${esc(date(h.created_at))} · ${esc(h.actor_label||h.actor_id)}<br>${esc(h.reason)}</p>`).join('')}${data.history_truncated?'<p>Earlier events are omitted from this view.</p>':''}</details>`:''}`;
}
function showPatientLifecycle(data){const host=$('patient-lifecycle');if(!host||data.patient_id!==selected)return;host.className=data.archived?'panel mapping-notice':'panel';host.innerHTML=patientLifecycleMarkup(data);}
async function renderPatientLifecycle(){
 const host=$('patient-lifecycle'),patient=selected,identity=me,generation=++patientLifecycleGeneration;if(!host||!patient)return;
 capturePatientLifecycleDraft();host.innerHTML=workspace.patient.archived?'<b>Archived patient chart</b><p>Existing records are retained. Loading restore controls…</p>':'<p class="muted">Loading patient chart status…</p>';
 try{const data=await api(`/api/v1/patients/${patient}/lifecycle`);if(me!==identity||selected!==patient||generation!==patientLifecycleGeneration||$('patient-lifecycle')!==host)return;if(data.patient_id!==patient)throw new Error('Patient status does not match this chart.');patientLifecycleStates.set(patient,data);workspace.patient.archived=data.archived;showPatientLifecycle(data);}
 catch(error){if(me===identity&&selected===patient&&generation===patientLifecycleGeneration&&$('patient-lifecycle')===host)host.textContent=`Patient archive status unavailable: ${error.message}`;}
}
async function changePatientDirectoryStatus(value){
 if(!['active','archived','all'].includes(value))return;const identity=me,previous=patientDirectoryStatus;patientDirectoryStatus=value;
 try{const page=await api(patientDirectoryQuery());if(me!==identity||patientDirectoryStatus!==value)return;patients=page.items;cursor=page.next_cursor;renderPatients();}
 catch(error){if(me===identity&&patientDirectoryStatus===value){patientDirectoryStatus=previous;if($('patient-status-filter'))$('patient-status-filter').value=previous;}throw error;}
}
async function savePatientLifecycle(form){
 capturePatientLifecycleDraft();const patient=form.dataset.patient,identity=me,submitted=patientLifecycleValues(form);
 if(patient!==selected||!submitted.confirmed||!submitted.reason.trim())throw new Error('Enter a reason and confirm this patient chart change.');
 const data=await api(`/api/v1/patients/${patient}/lifecycle`,'PUT',{archived:submitted.archived,reason:submitted.reason},submitted.version);
 if(me!==identity)return;
 if(data.patient_id!==patient)throw new Error('Patient status does not match the submitted chart.');
 if($('patient-lifecycle-form')===form)capturePatientLifecycleDraft();
 const draft=patientLifecycleDrafts.get(patient);if(!draft||JSON.stringify(draft)===JSON.stringify(submitted)){patientLifecycleDrafts.delete(patient);patientLifecycleRetiredForms.add(form);}
 patientLifecycleStates.set(patient,data);
 patients=patients.map(p=>p.id===patient?{...p,archived:data.archived}:p).filter(p=>patientDirectoryStatus==='all'||Boolean(p.archived)===(patientDirectoryStatus==='archived'));
 renderPatients();
 if(selected!==patient)return;
 captureVisitDrafts();workspace.patient.archived=data.archived;renderChart();notice(data.archived?'Patient archived. Existing records are preserved. Use Archived patients to find and restore this chart.':'Patient restored to the active directory. Existing records are unchanged.');
 // A restored chart might not be in the already-loaded active page. Refresh the
 // directory without changing the open patient, selected encounter or drafts.
 await changePatientDirectoryStatus(patientDirectoryStatus);
}
document.addEventListener('input',event=>{if(event.target.closest?.('#patient-lifecycle-form'))capturePatientLifecycleDraft();});
document.addEventListener('change',event=>{if(event.target.id==='patient-status-filter'){if(typeof busy!=='undefined'&&busy){event.target.value=patientDirectoryStatus;return;}run(()=>changePatientDirectoryStatus(event.target.value));return;}if(event.target.closest?.('#patient-lifecycle-form'))capturePatientLifecycleDraft();});
document.addEventListener('click',event=>{const button=event.target.closest?.('[data-patient-lifecycle-open],[data-patient-lifecycle-cancel]');if(!button)return;event.preventDefault();event.stopImmediatePropagation();const data=patientLifecycleStates.get(selected);if(!data?.can_manage)return;if(button.hasAttribute('data-patient-lifecycle-cancel'))patientLifecycleDrafts.delete(selected);else if(!patientLifecycleDrafts.has(selected))patientLifecycleDrafts.set(selected,{reason:'',confirmed:false,archived:!data.archived,version:data.version});showPatientLifecycle(data);},true);
document.addEventListener('submit',event=>{if(event.target.id!=='patient-lifecycle-form')return;event.preventDefault();event.stopImmediatePropagation();run(()=>savePatientLifecycle(event.target));},true);
