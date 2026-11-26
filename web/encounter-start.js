// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// An uncertain booking retains its original body and request ID in this tab.
// Check-in and start are recovered by reading authoritative appointment/visit state.
let encounterStartIdentity;
const encounterStartOperations=new Map();
function encounterStartSession(){if(encounterStartIdentity!==me){encounterStartOperations.clear();encounterStartIdentity=me;}}
function canStartEncounterFlow(){
 return ['owner','clinician','nurse','medical_assistant'].includes(me?.role)&&!me?.delegated&&!workspace?.patient?.archived&&
  (typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical','create'));
}
function encounterStartCanBook(){
 return ['owner','clinician'].includes(me?.role)&&
  (typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('scheduling','create'));
}
function encounterStartCurrent(op){return selected===op.patient&&me===op.identity;}
function requireEncounterStartContext(op){if(!encounterStartCurrent(op))throw new Error('Patient or sign-in changed. Return to the original chart to continue starting this encounter.');}
function encounterStartAppointments(isNew=false){
 const rooming=['nurse','medical_assistant'].includes(me?.role);
 const linked=new Set((workspace.visits||[]).filter(v=>v.patient_id===selected).map(v=>v.appointment_id));
 return (workspace.appointments||[]).filter(a=>a.patient_id===selected&&(rooming||a.clinician_id===me.user_id)&&
  (!isNew||!linked.has(a.id))&&(rooming?a.status==='checked_in':isNew?['booked','checked_in'].includes(a.status):['booked','checked_in','in_progress'].includes(a.status)));
}
async function renderEncounterStartBenefits(hostId,serviceDate){
 const host=$(hostId);if(!host)return;
 const patient=selected,identity=me,coverage=typeof revenueCoverage==='function'?revenueCoverage(serviceDate):null;
 const current=()=>selected===patient&&me===identity&&$(hostId)===host&&host.dataset.serviceDate===serviceDate;
 host.dataset.serviceDate=serviceDate;
 // On the encounter's note this is one line that opens; when starting an encounter it is shown in full.
 const appointment=(workspace.appointments||[]).find(a=>a.id===(typeof activeVisit!=='undefined'?activeVisit?.appointment_id:null));
 const reason=typeof scheduleInsuranceCheckMessage==='function'?scheduleInsuranceCheckMessage(appointment):'';
 const compact=hostId==='encounter-benefits',line=(html,words,tone='',eligibility='')=>{host.innerHTML=compact?`<details class="encounter-benefits-line"><summary${eligibility?` data-eligibility="${esc(eligibility)}"`: ''}><b>Insurance</b> ${words}${tone?` <span class="pill ${tone}">${tone==='ok'?'Checked':esc(reason||'Not checked')}</span>`:''}</summary>${html}</details>`:html;};
 const heading=`<h3>Insurance & benefits · ${esc(displayDate(serviceDate))}</h3>`;
 if(!workspace.billing){line(heading+'<p class="muted">Insurance details are unavailable with the current access. Confirm benefits with authorized billing staff.</p>','· not available with your access');return;}
 if(!coverage){line(heading+'<p>No insurance on file for this encounter date.</p><button type="button" data-chart-section="insurance">Review insurance</button>','· none on file for this date (self-pay)');return;}
 const summary=heading+`<p><b>${esc(payerName(coverage.content.payer_id))}</b> · ${esc(coverage.content.plan_name||'Plan name not recorded')}</p><p>Recorded plan copay: <b>${coverage.content.copay_cents==null?'Not recorded':money(coverage.content.copay_cents)}</b>. Review the payer benefits and visit type before collecting.</p><button type="button" data-chart-section="insurance">Review coverage & copay</button>`;
 const words=`· ${esc(payerName(coverage.content.payer_id))} · Copay ${coverage.content.copay_cents==null?'not recorded':money(coverage.content.copay_cents)}`;
 line(summary+'<p class="muted">Loading eligibility…</p>',words,'','Loading eligibility');
 try{
  const history=await api(`/api/v1/patients/${patient}/coverages/${coverage.id}/claimmd-eligibility`);if(!current())return;
  const items=[...(history.items||[])].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),check=items.find(c=>(c.request_snapshot?.request?.service_date||c.request_snapshot?.service_date)===serviceDate)||items[0];
  if(!check){line(summary+'<p class="muted">Not checked with the insurer yet. Open Review coverage to check eligibility.</p>',words,'warn','Eligibility not checked');return;}
  const checkedDate=check.request_snapshot?.request?.service_date||check.request_snapshot?.service_date,matching=checkedDate===serviceDate;
  line(summary+`${matching?'':`<p class="mapping-notice">The last eligibility check was for ${esc(checkedDate||'another date')}, not this encounter date.</p>`}${check.status==='completed'?claimmdEligibilityRows(check):'<p>The last eligibility check did not get an answer from the insurer. Open Review insurance to see why.</p>'}<p class="muted">An insurer\'s answer is not a promise to pay. The recorded plan copay only changes when staff save it.</p>`,words,matching&&check.status==='completed'?'ok':'warn',!matching?'Eligibility not checked for this visit':check.status==='completed'?'Eligibility checked':'No eligibility answer');
 }catch{if(current())line(summary+'<p class="muted">The eligibility history could not be loaded.</p>',words,'','Eligibility unavailable');}
}
async function openEncounterStartFlow(intent,appointmentId=''){
 const isNew=intent==='new';
 if(!canStartEncounterFlow()||!selected)throw new Error('Visit start is unavailable for this chart or role.');
 encounterStartSession();
 const patient=selected,identity=me,title=isNew?'New encounter':'Start encounter';
 let dialog=null,sheetBody=null;
 if(typeof sheetOpen==='function'){
  const existing=document.querySelector('dialog[data-encounter-start]');
  if(existing){existing.querySelector('button,select,input')?.focus();return;}
  sheetBody=document.createElement('div');
  sheetBody.innerHTML='<p role="status">Loading appointments…</p>';
  dialog=sheetOpen(title,sheetBody,{label:true});dialog.dataset.encounterStart='';
 }
 const current=()=>selected===patient&&me===identity&&(!dialog||dialog.isConnected!==false&&!dialog.dataset.closing);
 let fresh;
 try{fresh=await api(`/api/v1/patients/${patient}/workspace`);}catch(error){
  if(sheetBody&&current())sheetBody.innerHTML='<p role="alert">Appointments could not be loaded. Close this window and try again.</p>';
  if(current())throw error;return;
 }
 if(!current())return;
 if(fresh.patient?.id!==patient||fresh.patient.archived){
  const message=fresh.patient?.id===patient?'Restore this archived patient before starting a new encounter.':'The appointment response does not match this chart.';
  if(fresh.patient?.id===patient)workspace.patient.archived=true;
  if(sheetBody)sheetBody.innerHTML='<p role="alert">'+esc(message)+'</p>';
  throw new Error(message);
 }
 workspace.patient.archived=fresh.patient.archived;
 workspace.appointments=fresh.appointments;workspace.visits=fresh.visits;
 const present=markup=>{
  const host=$('encounter-start-editor');
  if(sheetBody){
   if(host){host.replaceChildren();host.hidden=true;}
   sheetBody.innerHTML=markup;
   if(dialog.querySelector?.('.sheet-close')===document.activeElement){
    (sheetBody.querySelector?.('select,button')||dialog.querySelector('.sheet-close'))?.focus({preventScroll:true});
   }
   return true;
  }
  if(!host)throw new Error('Open this patient’s chart before starting an encounter.');
  host.hidden=false;host.innerHTML=`<section class="panel"><h3>${title}</h3>${markup}</section>`;return true;
 };
 if(encounterStartOperations.has(patient)){
  present('<p>The previous start has not been confirmed. Continue the same request to check the saved appointment and encounter.</p><button type="button" class="primary" data-resume-encounter-start>Continue the same visit</button>');
  return;
 }
 const start=new Date();start.setSeconds(0,0);
 const local=localTime(start.toISOString());
 const today=a=>revenueServiceDate(a)===revenueServiceDate({...a,starts_at:start.toISOString()});
 const choices=encounterStartAppointments(isNew);
 const rank=a=>(today(a)?0:3)+({checked_in:0,booked:1,in_progress:2}[a.status]??2);
 choices.sort((left,right)=>rank(left)-rank(right)||String(left.starts_at).localeCompare(String(right.starts_at)));
 const scheduled=choices.find(a=>a.id===appointmentId)||(!isNew&&choices.find(a=>a.status==='in_progress'))||
  choices.find(a=>today(a)&&new Date(a.starts_at)<=start);
 const walkIn=encounterStartCanBook();
 if(!walkIn&&!choices.length){present('<p>No checked-in appointments are available to start for this patient.</p>');return;}
 const [types,locations]=walkIn?await Promise.all([
  typeof scheduleVisitTypes==='function'?scheduleVisitTypes().catch(()=>null):[],
  typeof scheduleSoleFacility==='function'?api('/api/v1/schedule/locations').catch(()=>null):null
 ]):[[],null];
 if(!current())return;
 const catalog=(types||[]).filter(t=>t.enabled!==false&&t.id&&Number.isSafeInteger(t.version));
 const defaultType=catalog.find(t=>t.name.trim().toLowerCase()==='office encounter')||catalog.find(t=>t.name.trim().toLowerCase()==='office visit')||(catalog.length===1?catalog[0]:null)||{name:'Office encounter',category:'Office encounter',duration_minutes:30};
 const facility=locations&&typeof scheduleSoleFacility==='function'?scheduleSoleFacility(locations):'';
 const typeChoice=catalog.length?`<label>Visit type<select name="visit_type_id">${catalog.map(t=>`<option value="${esc(t.id)}" data-version="${esc(t.version)}" data-category="${esc(t.category)}" data-minutes="${esc(t.duration_minutes)}" data-title="${esc(t.name)}" ${t.id===defaultType.id?'selected':''}>${esc(t.name)} · ${esc(t.duration_minutes)} min</option>`).join('')}<option value="" ${defaultType.id?'':'selected'}>Custom visit</option></select></label>`:'';
 const options=choices.map(a=>`<option value="${esc(a.id)}" ${scheduled?.id===a.id?'selected':''}>${esc(date(a.starts_at))} · ${esc(a.title)} · ${esc(human(a.status))}</option>`).join('');
 const chooser=`<label>Appointment<select name="appointment_id" ${walkIn?'':'required'}>${walkIn?`<option value="" ${scheduled?'':'selected'}>Walk-in · now</option>`:scheduled?'':'<option value="" selected disabled>Choose a checked-in appointment</option>'}${options}</select></label>`;
 const fields=walkIn?`<fieldset id="encounter-start-new-fields" ${scheduled?'hidden disabled':''}>${typeChoice}<label data-start-title ${defaultType.id?'hidden':''}>${catalog.length?'Custom visit title':'Visit type or title'}<input name="title" value="${esc(defaultType.name)}" maxlength="200" required></label>${types===null?'<p class="muted">Practice visit types could not be loaded. You can enter a custom visit.</p>':''}<details data-inline data-start-options><summary>Time, duration &amp; category</summary><div class="form-grid"><label>Service date &amp; time<input name="starts_at" type="datetime-local" value="${esc(local)}" required></label><label>Duration (minutes)<input name="duration" type="number" value="${esc(defaultType.duration_minutes)}" min="5" max="480" required></label><label>Category<input name="category" value="${esc(defaultType.category)}" maxlength="100" required></label></div><p class="muted">${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p></details></fieldset>`:'';
 const clinician=me.display_name||'You';
 const owner=walkIn?`<p class="muted">Clinician · ${esc(clinician)}</p>`:'';
 const insurance='<details data-inline data-start-insurance><summary>Insurance &amp; benefits</summary><div id="encounter-start-benefits"></div></details>';
 const action=scheduled?.status==='in_progress'?'Continue encounter':'Start encounter';
 if(!present(`<form id="encounter-start-form" data-patient="${esc(patient)}" data-intent="${isNew?'new':'start'}" data-facility="${esc(facility)}">${chooser}${fields}${owner}${insurance}<p id="encounter-start-status" role="status"></p><div class="actions"><button type="submit" class="primary">${action}</button><button type="button" data-encounter-start-cancel>Cancel</button></div></form>`))return;
 const benefits=$('encounter-start-benefits');
 if(benefits)benefits.dataset.serviceDate=scheduled?revenueServiceDate(scheduled):local.slice(0,10);
}
function encounterStartConflict(error){return /provider, patient or room is unavailable during that time/i.test(String(error?.message||''));}
function encounterStartInput(form){
 encounterStartSession();if(!canStartEncounterFlow()||form.dataset.patient!==selected)throw new Error('Open this patient’s visit form before starting.');
 const pending=encounterStartOperations.get(selected);if(pending)return pending;
 const values=Object.fromEntries(new FormData(form));
 const op={patient:selected,identity:me,appointmentId:values.appointment_id||null,booking:null};
 if(op.appointmentId){
  const appointment=encounterStartAppointments(form.dataset.intent==='new').find(a=>a.id===op.appointmentId);
  if(!appointment)throw new Error('Choose an available appointment assigned to you, or a checked-in appointment for rooming.');
  op.clinicianId=appointment.clinician_id;
 }
 else{
  if(!encounterStartCanBook())throw new Error('Choose a checked-in appointment to start.');
  const starts_at=scheduleInstant(values.starts_at),duration=Number(values.duration),title=String(values.title||'').trim(),category=String(values.category||'').trim();
  if(!Number.isInteger(duration)||duration<5||duration>480||!title||!category)throw new Error('Review the service time, duration and visit title.');
  op.booking={request_id:crypto.randomUUID(),patient_id:selected,clinician_id:me.user_id,starts_at,ends_at:new Date(new Date(starts_at).getTime()+duration*60000).toISOString(),title,category,facility:form.dataset.facility||'',room:'',notes:'',reason:'Start unscheduled visit'};
  if(values.visit_type_id){
   const option=form.elements.visit_type_id.selectedOptions[0],version=Number(option?.dataset.version);
   if(option?.value!==values.visit_type_id||!Number.isSafeInteger(version)||version<1)throw new Error('Choose a current practice visit type.');
   op.booking.visit_type={id:option.value,version};
  }
  op.clinicianId=me.user_id;
 }
 encounterStartOperations.set(selected,op);return op;
}
async function continueEncounterStart(op){
 if(op.pending)return op.pending;
 op.pending=startEncounterOperation(op);
 try{return await op.pending;}finally{delete op.pending;}
}
async function startEncounterOperation(op){
 requireEncounterStartContext(op);if(!canStartEncounterFlow())throw new Error('Only the assigned clinician can start this encounter.');
 const read=async()=>{const next=await api(`/api/v1/patients/${op.patient}/workspace`);requireEncounterStartContext(op);if(next.patient?.id!==op.patient)throw new Error('The appointment response does not match this patient.');return next;};
 if(!op.appointmentId){
  const booked=await api('/api/v1/appointments','POST',op.booking);requireEncounterStartContext(op);
  if(booked.patient_id!==op.patient||booked.clinician_id!==op.identity.user_id)throw new Error('The saved appointment does not match this encounter.');
  op.appointmentId=booked.id;
 }
 let fresh=await read();
 const findVisit=()=>fresh.visits.find(v=>v.appointment_id===op.appointmentId&&v.patient_id===op.patient&&v.clinician_id===op.clinicianId);
 const findAppointment=()=>fresh.appointments.find(a=>a.id===op.appointmentId&&a.patient_id===op.patient&&a.clinician_id===op.clinicianId);
 let visit=findVisit(),appointment=findAppointment();
 if(!appointment)throw new Error('The appointment is unavailable or assigned to another clinician.');
 if(!visit&&appointment.status==='booked'){
  if(!['owner','clinician'].includes(op.identity.role))throw new Error('This appointment must be checked in again before starting rooming.');
  let failure;try{await api(`/api/v1/appointments/${op.appointmentId}/check-in`,'POST');}catch(error){failure=error;}
  fresh=await read();visit=findVisit();appointment=findAppointment();
  if(!visit&&appointment?.status!=='checked_in')throw failure||new Error('Check-in was not confirmed. Continue the same visit to retry.');
 }
 if(!visit&&appointment?.status==='checked_in'){
  let failure;try{await api('/api/v1/visits','POST',{appointment_id:op.appointmentId});}catch(error){failure=error;}
  fresh=await read();visit=findVisit();if(!visit)throw failure||new Error('Visit start was not confirmed. Continue the same visit to retry.');
 }
 if(!visit)throw new Error('This appointment cannot start an encounter in its current state. Review its status.');
 requireEncounterStartContext(op);
 // A confirmed encounter remains the recovery target if the final chart reload fails.
 await selectPatient(op.patient,visit.id);requireEncounterStartContext(op);
 encounterStartOperations.delete(op.patient);
 {const sheet=$('encounter-start-form')?.closest?.('dialog')||document.querySelector?.('dialog[data-encounter-start]');if(sheet&&typeof sheetClose==='function')sheetClose(sheet);}
 const editor=$('encounter-start-editor');if(editor){editor.replaceChildren();editor.hidden=true;}
 if(typeof insuranceAppointmentSelection!=='undefined')insuranceAppointmentSelection.set(op.patient,op.appointmentId);
 setEncounterSection('visit');
 if($('encounter-benefits'))void renderEncounterStartBenefits('encounter-benefits',revenueServiceDate(appointment));
 notice('Visit started.');
}
document.addEventListener('click',event=>{
 const coverage=event.target.closest('button[data-chart-section="insurance"]');
 if(coverage?.closest('dialog[data-encounter-start]'))sheetClose(coverage.closest('dialog'));
 const cancel=event.target.closest('button[data-encounter-start-cancel]');
 if(cancel){event.preventDefault();const dialog=cancel.closest('dialog');if(dialog)sheetClose(dialog);else{const host=$('encounter-start-editor');if(host){host.replaceChildren();host.hidden=true;}}return;}
 const start=event.target.closest('button[data-start-encounter-flow]'),resume=event.target.closest('button[data-resume-encounter-start]');
 if(!start&&!resume)return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  if(start){await openEncounterStartFlow(start.dataset.startEncounterFlow,start.dataset.appointment||'');return;}
  encounterStartSession();const op=encounterStartOperations.get(selected);
  if(!op)throw new Error('Open New encounter to review the appointment.');
  await continueEncounterStart(op);
 });
},true);
document.addEventListener('submit',event=>{
 if(event.target.id!=='encounter-start-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 const form=event.target;
 run(async()=>{
  const op=encounterStartInput(form);
  const fields=[...form.querySelectorAll('input,select')];
  const status=$('encounter-start-status'),submit=form.querySelector('button[type="submit"]');
  fields.forEach(field=>field.disabled=true);
  if(status)status.textContent='Starting encounter…';
  try{await continueEncounterStart(op);}
  catch(error){
   if(!encounterStartCurrent(op)||$('encounter-start-form')!==form)throw error;
   if(!op.appointmentId&&[400,409,422].includes(error.status)){
    encounterStartOperations.delete(op.patient);
    fields.forEach(field=>field.disabled=false);
    if(submit)submit.textContent='Start encounter';
    if(encounterStartConflict(error)){
     if(status)status.textContent='That time overlaps another appointment for this clinician, patient or room. Choose a different time.';
     const options=form.querySelector('[data-start-options]');if(options)options.open=true;
     form.elements?.starts_at?.focus?.();return;
    }
    if(status)status.textContent='Check the service time, duration and visit title.';
   }else{
    if(submit)submit.textContent='Continue the same visit';
    if(status)status.textContent='Start not yet confirmed. Continue the same request to recover the saved appointment and encounter.';
   }
   throw error;
  }
 });
},true);
document.addEventListener('change',event=>{
 const form=event.target.closest?.('#encounter-start-form');if(!form)return;
 const appointment=(workspace.appointments||[]).find(a=>a.id===form.elements.appointment_id.value);
 const fields=$('encounter-start-new-fields');
 if(fields){fields.disabled=!!appointment;fields.hidden=!!appointment;}
 if(fields&&event.target.name==='visit_type_id'){
  const type=event.target.selectedOptions[0];
  fields.querySelector('[data-start-title]').hidden=!!type?.value;
  if(type?.value){
   form.elements.title.value=type.dataset.title;form.elements.category.value=type.dataset.category;form.elements.duration.value=type.dataset.minutes;
  }else{form.elements.title.focus();}
 }
 const serviceDate=appointment?revenueServiceDate(appointment):String(form.elements.starts_at?.value||'').slice(0,10);
 const benefits=$('encounter-start-benefits');
 if(benefits&&/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)){
  benefits.dataset.serviceDate=serviceDate;
  if(benefits.closest('details')?.open)void renderEncounterStartBenefits(benefits.id,serviceDate);
 }
});
document.addEventListener('toggle',event=>{
 const details=event.target;
 if(details.matches?.('[data-start-insurance]')&&details.open){
  const host=details.querySelector('#encounter-start-benefits');
  if(host?.dataset.serviceDate)void renderEncounterStartBenefits(host.id,host.dataset.serviceDate);
 }
},true);
