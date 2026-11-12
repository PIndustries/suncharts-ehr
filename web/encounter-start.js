// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// An uncertain booking retains its original body and request ID in this tab.
// Check-in and start are recovered by reading authoritative appointment/visit state.
let encounterStartIdentity;
const encounterStartOperations=new Map();
function encounterStartSession(){if(encounterStartIdentity!==me){encounterStartOperations.clear();encounterStartIdentity=me;}}
function canStartEncounterFlow(){return ['owner','clinician'].includes(me?.role)&&!workspace?.patient?.archived;}
function encounterStartCurrent(op){return selected===op.patient&&me===op.identity;}
function requireEncounterStartContext(op){if(!encounterStartCurrent(op))throw new Error('Patient or sign-in changed. Return to the original chart to continue starting this encounter.');}
function encounterStartAppointments(){return (workspace.appointments||[]).filter(a=>a.patient_id===selected&&a.clinician_id===me.user_id&&['booked','checked_in','in_progress'].includes(a.status));}
async function renderEncounterStartBenefits(hostId,serviceDate){
 const host=$(hostId);if(!host)return;
 const patient=selected,identity=me,coverage=typeof revenueCoverage==='function'?revenueCoverage(serviceDate):null;
 const current=()=>selected===patient&&me===identity&&$(hostId)===host&&host.dataset.serviceDate===serviceDate;
 host.dataset.serviceDate=serviceDate;
 const heading=`<h3>Insurance & benefits · ${esc(serviceDate)}</h3>`;
 if(!workspace.billing){host.innerHTML=heading+'<p class="muted">Insurance details are unavailable with the current access. Confirm benefits with authorized billing staff.</p>';return;}
 if(!coverage){host.innerHTML=heading+'<p>No insurance on file for this visit date.</p><button type="button" data-chart-section="insurance">Review insurance</button>';return;}
 const summary=heading+`<p><b>${esc(payerName(coverage.content.payer_id))}</b> · ${esc(coverage.content.plan_name||'Plan name not recorded')}</p><p>Recorded plan copay: <b>${coverage.content.copay_cents==null?'Not recorded':money(coverage.content.copay_cents)}</b>. Review the payer benefits and visit type before collecting.</p><button type="button" data-chart-section="insurance">Review coverage & copay</button>`;
 host.innerHTML=summary+'<p class="muted">Loading recorded eligibility benefits…</p>';
 try{
  const history=await api(`/api/v1/patients/${patient}/coverages/${coverage.id}/claimmd-eligibility`);if(!current())return;
  const items=[...(history.items||[])].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),check=items.find(c=>(c.request_snapshot?.request?.service_date||c.request_snapshot?.service_date)===serviceDate)||items[0];
  if(!check){host.innerHTML=summary+'<p class="muted">No eligibility response is recorded. Review insurance to request benefits for this service date.</p>';return;}
  const checkedDate=check.request_snapshot?.request?.service_date||check.request_snapshot?.service_date,matching=checkedDate===serviceDate;
  host.innerHTML=summary+`<p><b>${check.status==='completed'?'Payer response received':esc(human(check.status))}</b> · Requested ${esc(date(check.created_at))} · Service ${esc(checkedDate||'not recorded')}</p>${matching?'':'<p class="mapping-notice">This response is for a different service date. Verify benefits for this encounter.</p>'}${check.status==='completed'?claimmdEligibilityRows(check):'<p>No completed benefit response from this request. Coverage remains unconfirmed.</p>'}<p class="muted">Payer responses do not guarantee coverage or payment. Recorded plan copays are not automatically changed by eligibility results.</p>`;
 }catch{if(current())host.innerHTML=summary+'<p class="muted">Eligibility history could not be loaded. Coverage remains unconfirmed.</p>';}
}
async function openEncounterStartFlow(){
 if(!canStartEncounterFlow()||!selected)throw new Error('Only the assigned clinician can start an encounter here.');
 encounterStartSession();const patient=selected,identity=me;
 // Refresh before offering an unscheduled start, so an existing encounter is visible.
 const fresh=await api(`/api/v1/patients/${patient}/workspace`);if(selected!==patient||me!==identity)return;
 if(fresh.patient?.id!==patient)throw new Error('The appointment response does not match this chart.');
 workspace.patient.archived=fresh.patient.archived;if(fresh.patient.archived)throw new Error('Restore this archived patient before starting a new encounter.');
 workspace.appointments=fresh.appointments;workspace.visits=fresh.visits;
 showChartSection('visits');
 const host=$('encounter-start-editor');if(!host)throw new Error('Open the patient encounter workspace before starting.');
 host.hidden=false;const pending=encounterStartOperations.get(patient),appointments=encounterStartAppointments();
 if(pending){host.innerHTML=`<section class="panel"><h3>Continue starting encounter</h3><p>The previous start has not been confirmed. Continue the same appointment and request to check its saved state.</p><button type="button" class="primary" data-resume-encounter-start>Continue the same encounter</button></section>`;host.scrollIntoView({block:'nearest'});return;}
 const start=new Date();start.setSeconds(0,0);const local=localTime(start.toISOString()),existing=appointments.find(a=>a.status==='in_progress')||appointments.find(a=>a.status==='checked_in')||appointments.find(a=>revenueServiceDate(a)===local.slice(0,10));
 host.innerHTML=`<section class="panel"><h3>Start encounter</h3><p>Choose an existing appointment or enter the service date and time for an unscheduled visit. The encounter stays linked to this appointment for documentation, copay, charges and claims.</p><form id="encounter-start-form" data-patient="${esc(patient)}"><label>Appointment<select name="appointment_id"><option value="" ${existing?'':'selected'}>Unscheduled visit</option>${appointments.map(a=>`<option value="${esc(a.id)}" ${existing?.id===a.id?'selected':''}>${esc(date(a.starts_at))} · ${esc(a.title)} · ${esc(human(a.status))}</option>`).join('')}</select></label><div id="encounter-start-new-fields" ${existing?'hidden':''}><div class="form-grid"><label>Service date & time<input name="starts_at" type="datetime-local" value="${esc(local)}" required></label><label>Duration (minutes)<input name="duration" type="number" value="30" min="5" max="480" required></label><label>Visit title<input name="title" value="Office visit" maxlength="200" required></label><label>Visit category<input name="category" value="Office visit" maxlength="100" required></label></div><p class="muted">Clinician: you. Times use this device’s timezone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}).</p></div><div id="encounter-start-benefits"></div><p id="encounter-start-status" role="status"></p><button type="submit" class="primary">${existing?.status==='in_progress'?'Continue encounter':'Start encounter'}</button></form></section>`;
 host.scrollIntoView({block:'nearest'});void renderEncounterStartBenefits('encounter-start-benefits',existing?revenueServiceDate(existing):local.slice(0,10));
}
function encounterStartInput(form){
 encounterStartSession();if(!canStartEncounterFlow()||form.dataset.patient!==selected)throw new Error('Open this patient’s encounter form before starting.');
 const pending=encounterStartOperations.get(selected);if(pending)return pending;
 const values=Object.fromEntries(new FormData(form));
 const op={patient:selected,identity:me,appointmentId:values.appointment_id||null,booking:null};
 if(op.appointmentId){if(!encounterStartAppointments().some(a=>a.id===op.appointmentId))throw new Error('Choose a current appointment assigned to you.');}
 else{
  const starts_at=scheduleInstant(values.starts_at),duration=Number(values.duration),title=values.title.trim(),category=values.category.trim();
  if(!Number.isInteger(duration)||duration<5||duration>480||!title||!category)throw new Error('Review the service time, duration and visit title.');
  op.booking={request_id:crypto.randomUUID(),patient_id:selected,clinician_id:me.user_id,starts_at,ends_at:new Date(new Date(starts_at).getTime()+duration*60000).toISOString(),title,category,facility:'',room:'',notes:'',reason:'Start unscheduled encounter'};
 }
 encounterStartOperations.set(selected,op);return op;
}
async function continueEncounterStart(op){
 requireEncounterStartContext(op);if(!canStartEncounterFlow())throw new Error('Only the assigned clinician can start this encounter.');
 const read=async()=>{const next=await api(`/api/v1/patients/${op.patient}/workspace`);requireEncounterStartContext(op);if(next.patient?.id!==op.patient)throw new Error('The appointment response does not match this patient.');return next;};
 if(!op.appointmentId){
  const booked=await api('/api/v1/appointments','POST',op.booking);requireEncounterStartContext(op);
  if(booked.patient_id!==op.patient||booked.clinician_id!==op.identity.user_id)throw new Error('The saved appointment does not match this encounter.');
  op.appointmentId=booked.id;
 }
 let fresh=await read();
 const findVisit=()=>fresh.visits.find(v=>v.appointment_id===op.appointmentId&&v.patient_id===op.patient&&v.clinician_id===op.identity.user_id);
 const findAppointment=()=>fresh.appointments.find(a=>a.id===op.appointmentId&&a.patient_id===op.patient&&a.clinician_id===op.identity.user_id);
 let visit=findVisit(),appointment=findAppointment();
 if(!appointment)throw new Error('The appointment is unavailable or assigned to another clinician.');
 if(!visit&&appointment.status==='booked'){
  let failure;try{await api(`/api/v1/appointments/${op.appointmentId}/check-in`,'POST');}catch(error){failure=error;}
  fresh=await read();visit=findVisit();appointment=findAppointment();
  if(!visit&&appointment?.status!=='checked_in')throw failure||new Error('Check-in was not confirmed. Continue the same encounter to retry.');
 }
 if(!visit&&appointment?.status==='checked_in'){
  let failure;try{await api('/api/v1/visits','POST',{appointment_id:op.appointmentId});}catch(error){failure=error;}
  fresh=await read();visit=findVisit();if(!visit)throw failure||new Error('Encounter start was not confirmed. Continue the same encounter to retry.');
 }
 if(!visit)throw new Error('This appointment cannot start an encounter in its current state. Review its status.');
 requireEncounterStartContext(op);
 // A confirmed encounter remains the recovery target if the final chart reload fails.
 await selectPatient(op.patient,visit.id);requireEncounterStartContext(op);
 encounterStartOperations.delete(op.patient);
 const editor=$('encounter-start-editor');if(editor){editor.replaceChildren();editor.hidden=true;}
 if(typeof insuranceAppointmentSelection!=='undefined')insuranceAppointmentSelection.set(op.patient,op.appointmentId);
 setEncounterSection('intake');
 if($('encounter-benefits'))void renderEncounterStartBenefits('encounter-benefits',revenueServiceDate(appointment));
 notice('Encounter opened. Review the service-date benefits, then continue the visit.');
}
document.addEventListener('click',event=>{
 const start=event.target.closest('button[data-start-encounter-flow]'),resume=event.target.closest('button[data-resume-encounter-start]');if(!start&&!resume)return;
 event.preventDefault();event.stopImmediatePropagation();run(async()=>{if(start){await openEncounterStartFlow();return;}encounterStartSession();const op=encounterStartOperations.get(selected);if(!op)throw new Error('Open Start encounter to review the appointment.');await continueEncounterStart(op);});
},true);
document.addEventListener('submit',event=>{
 if(event.target.id!=='encounter-start-form')return;event.preventDefault();event.stopImmediatePropagation();const form=event.target;
 run(async()=>{const op=encounterStartInput(form);form.querySelectorAll('input,select').forEach(field=>field.disabled=true);const status=$('encounter-start-status');if(status)status.textContent='Starting this encounter. If confirmation is interrupted, continue the same request.';try{await continueEncounterStart(op);}catch(error){if(encounterStartCurrent(op)&&$('encounter-start-form')===form){const submit=form.querySelector('button[type="submit"]');if(!op.appointmentId&&[400,409,422].includes(error.status)){encounterStartOperations.delete(op.patient);form.querySelectorAll('input,select').forEach(field=>field.disabled=false);if(submit)submit.textContent='Start encounter';if(status)status.textContent='The appointment was not accepted. Review the entries and try again.';}else{if(submit)submit.textContent='Continue the same encounter';if(status)status.textContent='Start not yet confirmed. Continue the same request to recover the saved appointment and encounter.';}}throw error;}});
},true);
document.addEventListener('change',event=>{
 const form=event.target.closest?.('#encounter-start-form');if(!form)return;
 const values=Object.fromEntries(new FormData(form)),appointment=(workspace.appointments||[]).find(a=>a.id===values.appointment_id);
 $('encounter-start-new-fields').hidden=!!appointment;
 const serviceDate=appointment?revenueServiceDate(appointment):String(values.starts_at||'').slice(0,10);if(/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))void renderEncounterStartBenefits('encounter-start-benefits',serviceDate);
});
