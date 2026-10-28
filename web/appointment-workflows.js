// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let seriesDraft,appointmentExtrasGeneration=0,reminderAppointment,reminderPreferences,reminderRows=[],reminderCursor,reminderFilter='due',reminderSettings;
function recurringProposal(form){
 const d=Object.fromEntries(new FormData(form)),frequency=d.repeat_frequency,count=Number(d.repeat_count),interval=Number(d.repeat_interval);
 if(!['daily','weekly','monthly'].includes(frequency)||!Number.isInteger(count)||count<2||count>52||!Number.isInteger(interval)||interval<1||interval>12)throw new Error('Choose 2–52 visits and a repeat interval from 1–12.');
 const first=scheduleInstant(d.starts_at),last=scheduleInstant(d.ends_at),duration=new Date(last)-new Date(first);
 if(duration<=0||duration>86400000)throw new Error('Choose a positive duration of at most 24 hours.');
 const base=new Date(d.starts_at),occurrences=[];
 for(let i=0;i<count;i++){
  const local=new Date(base);
  if(frequency==='monthly'){local.setDate(1);local.setMonth(base.getMonth()+i*interval);const lastDay=new Date(local.getFullYear(),local.getMonth()+1,0).getDate();local.setDate(Math.min(base.getDate(),lastDay));}
  else local.setDate(base.getDate()+i*interval*(frequency==='weekly'?7:1));
  const starts_at=scheduleInstant(localTime(local.toISOString())),end=new Date(new Date(starts_at).getTime()+duration);
  if(new Date(starts_at)-new Date(first)>366*86400000)throw new Error('Keep the series within one year of its first visit.');
  occurrences.push({starts_at,ends_at:end.toISOString(),local_start:localTime(starts_at)+':00',local_end:localTime(end.toISOString())+':00',utc_offset_minutes:-new Date(starts_at).getTimezoneOffset()});
 }
 return {request_id:form.dataset.request,patient_id:d.patient_id,clinician_id:d.clinician_id,title:d.title,category:d.category,facility:d.facility,room:d.room,notes:d.notes,reason:d.reason,frequency,interval,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,occurrences};
}
async function previewRecurring(form){
 if(!canSchedule())throw new Error('Scheduling access is required.');
 if(form.dataset.chartPatient&&selected!==form.dataset.chartPatient)throw new Error('The patient chart changed. Reopen appointment booking.');
 const proposal=recurringProposal(form),fingerprint=JSON.stringify(proposal),data=await api('/api/v1/schedule/series/preview','POST',proposal);
 if(!form.isConnected||JSON.stringify(recurringProposal(form))!==fingerprint)return;
 seriesDraft={form,proposal,fingerprint,chartPatient:form.dataset.chartPatient,chartVisit:form.dataset.chartVisit};
 const host=form.querySelector('#series-preview');
 if(data.existing_series_id){host.innerHTML=`<p>This request already created a series. Its current appointments and history are preserved.</p><button type="button" data-series-open="${esc(data.existing_series_id)}">Open existing series</button>`;seriesDraft=undefined;return;}
 host.innerHTML=`<section class="series-review"><h3>Review recurring visits</h3><p>${esc(proposal.timezone)} · ${esc(proposal.frequency)} · ${proposal.occurrences.length} visits. Each occurrence will have its own appointment history.</p><ol>${data.occurrences.map((o,i)=>`<li><b>${esc(date(proposal.occurrences[i].starts_at))}</b> — ${esc(date(proposal.occurrences[i].ends_at))}<span class="pill ${o.available?'':'critical-label'}">${o.available?'Available':'Conflict'}</span>${o.conflict?`<small>${esc(typeof o.conflict==='string'?o.conflict:'Provider, patient, room or time block conflict')}</small>`:''}</li>`).join('')}</ol>${data.ready_to_create?'<label class="review-ack"><input type="checkbox" data-series-reviewed required>I reviewed every occurrence and the patient, provider, location and timezone.</label><button type="button" class="primary" data-series-create>Book reviewed series</button>':'<p role="alert">Resolve the conflicts by changing the appointment pattern, then preview again. No visits have been booked.</p>'}</section>`;
}
async function createReviewedSeries(){
 const draft=seriesDraft;
 if(!draft||!draft.form.isConnected||JSON.stringify(recurringProposal(draft.form))!==draft.fingerprint)throw new Error('Appointment details changed. Preview the series again.');
 if(!draft.form.querySelector('[data-series-reviewed]')?.checked)throw new Error('Review and confirm every occurrence before booking.');
 if(draft.chartPatient&&selected!==draft.chartPatient)throw new Error('Patient context changed. Reopen booking.');
 const saved=await api('/api/v1/schedule/series','POST',draft.proposal);seriesDraft=undefined;
 if(draft.chartPatient){await selectPatient(draft.chartPatient,draft.chartVisit||undefined);showChartSection('visits');notice('Recurring appointments booked with individual histories.');return;}
 await showSchedule();await showAppointmentSeries(saved.id||saved.series?.id);notice('All reviewed recurring appointments booked.');
}
async function showAppointmentSeries(id){
 const data=await api(`/api/v1/schedule/series/${id}`),series=data.series||data,appointments=(data.appointments||series.appointments||series.occurrences||[]).map(a=>({...a,id:a.id||a.appointment_id}));
 schedulePanel(`<h2>Recurring appointment series</h2><p>${esc(series.frequency)} · every ${esc(series.interval)} · ${esc(series.timezone)} · ${esc(series.status||'active')} · v${series.version}</p><p>Each occurrence can be edited, moved or cancelled separately. Changing one occurrence does not move the rest of the series.</p><div class="series-occurrences">${appointments.map(a=>`<div class="timeline-row"><div><b>${esc(date(a.starts_at))}</b><small>${esc(a.title)} · ${esc(scheduleLabel(a.status))} · v${a.version}${a.changed_from_plan?' · Modified occurrence':''}</small></div><button type="button" data-schedule-open="${esc(a.id)}">Open occurrence</button></div>`).join('')||'<p>No occurrences returned.</p>'}</div><details><summary>Series history</summary>${(series.events||[]).map(event=>`<p>v${event.version} · ${esc(event.action)} · ${esc(date(event.created_at))}<br>${esc(event.reason)}</p>`).join('')}</details>${canSchedule()&&series.status==='active'&&appointments.some(a=>a.status==='booked'&&new Date(a.starts_at)>new Date())?`<form id="series-cancel-form" data-series="${esc(id)}" data-version="${series.version}"><h3>Cancel remaining booked visits</h3><p>Only future booked occurrences are cancelled. Started, completed, checked-in and past visits retain their state.</p><label>Reason<input name="reason" required maxlength="1000"></label><label class="review-ack"><input type="checkbox" required>I reviewed the remaining visits and intend to cancel them.</label><button type="submit">Cancel future booked visits</button></form>`:''}`);
 $('series-cancel-form')?.setAttribute('data-occurrences',JSON.stringify(appointments.map(a=>({appointment_id:a.id,version:a.version}))));
}
async function showRecurringSeriesList(){
 const data=await api('/api/v1/schedule/series');
 await showSchedule();
 schedulePanel(`<h2>Recurring series</h2><p class="muted">${data.items.length} recent series${data.has_more?' · additional series are not shown':''}</p>${data.items.map(s=>`<div class="timeline-row"><div><b>${esc(s.patient_name)}</b><small>MRN ${esc(s.mrn)} · ${esc(s.title)}<br>${esc(s.frequency)} · ${s.occurrence_count} visits · ${esc(s.status)}</small></div><button type="button" data-series-open="${esc(s.id)}">Open series</button></div>`).join('')||'<p>No recurring series have been booked yet.</p>'}`);
}
let reminderWorkspaceGeneration=0,reminderLiveEpoch=0;
const reminderLiveRequests=new Map(),reminderLatestCards=new WeakMap(),reminderObservedUpdates=new Map();
function observeReminderUpdate(row){const old=reminderObservedUpdates.get(row.id);if(!old||Number(row.version)>=Number(old.version))reminderObservedUpdates.set(row.id,{...(old||{}),...row});if(reminderObservedUpdates.size>1000)reminderObservedUpdates.delete(reminderObservedUpdates.keys().next().value);return reminderObservedUpdates.get(row.id);}
function mergeReminderUpdate(row){const latest=reminderObservedUpdates.get(row.id);return latest&&Number(latest.version)>Number(row.version)?{...row,...latest}:row;}
function reminderOutcomeText(r){return ({default_window_already_elapsed:'The reminder window had already passed when this appointment was booked.',default_queued:'Scheduled automatically for this occurrence.',attributed_staff_outcome:'Staff contact outcome recorded.'})[r.last_result]||scheduleLabel(r.last_result||'');}
function reminderActionsHtml(r){
 const terminal=['cancelled','manual_contacted','manual_no_answer','manual_failed','delivered','superseded','missed','sending','accepted','needs_review'].includes(r.status),actions=r.actions||(!terminal?['manual_contacted','manual_no_answer','manual_failed','cancel',...(r.status==='failed'?['retry']:[])]:[]),labels={cancel:'Cancel reminder',manual_contacted:'Record staff contact made',manual_no_answer:'Record no answer',manual_failed:'Record failed contact',retry:'Retry using the original send request',refresh_delivery:'Refresh provider delivery evidence'};
 return canSchedule()&&actions.length?`<form class="reminder-action-form" data-id="${esc(r.id)}" data-version="${r.version}"><label>Reminder action<select name="action">${actions.map(action=>`<option value="${esc(action)}">${esc(labels[action]||scheduleLabel(action))}</option>`).join('')}</select></label><label>Outcome / reason<input name="reason" required maxlength="1000"></label><button type="submit">Record reminder action</button></form>`:'';
}
function reminderCard(r,worklist=false){
 return `<article class="reminder-card" data-reminder-row="${esc(r.id)}" data-reminder-version="${esc(r.version)}"><div class="section-head"><div><h4>${worklist?esc(r.patient_name||'Patient appointment'):esc(r.before_minutes)+' minutes before visit'}</h4><span class="pill" data-reminder-status>${esc(scheduleLabel(r.status))}</span></div><button type="button" data-reminder-history="${esc(r.id)}">History</button></div>${worklist?`<p data-reminder-context>${esc(r.appointment_title||'Appointment')} · ${esc(date(r.starts_at))}<br>MRN ${esc(r.mrn)}</p>`:''}<p data-reminder-contact>Due ${esc(date(r.due_at))}<br>${r.destination?esc(r.channel)+' · '+esc(r.destination):'Contact destination not verified'}</p><p class="muted" data-reminder-result ${r.last_result?'':'hidden'}>${esc(reminderOutcomeText(r))}</p><div class="reminder-action-area">${reminderActionsHtml(r)}</div><p class="notice" data-reminder-filter-note hidden></p>${worklist?`<button type="button" data-reminder-appointment="${esc(r.appointment_id)}">Open appointment</button>`:''}<div class="reminder-history"></div></article>`;
}
function reminderEventRows(events){return (events||[]).map(event=>`<p>${esc(event.action||event.status)} · ${esc(date(event.created_at))}<br>${esc(event.reason||'')}</p>`).join('')||'<p>No reminder events returned.</p>';}
function reminderFormHasDraft(form){return !!form&&(String(form.elements.reason?.value||'').trim()!==''||(form.elements.action?.value||'')!==(form.elements.action?.options?.[0]?.value||form.elements.action?.value||''));}
function patchReminderCard(card,r,events){
 if(!card?.isConnected||Number(card.dataset.reminderVersion||0)>Number(r.version))return;
 const form=card.querySelector('.reminder-action-form'),dirty=reminderFormHasDraft(form),oldVersion=form?.dataset.version;
 reminderLatestCards.set(card,r);card.dataset.reminderVersion=String(r.version);
 card.querySelector('[data-reminder-status]').textContent=scheduleLabel(r.status);
 card.querySelector('[data-reminder-contact]').innerHTML=`Due ${esc(date(r.due_at))}<br>${r.destination?esc(r.channel)+' · '+esc(r.destination):'Contact destination not verified'}`;
 const context=card.querySelector('[data-reminder-context]');if(context)context.innerHTML=`${esc(r.appointment_title||'Appointment')} · ${esc(date(r.starts_at))}<br>MRN ${esc(r.mrn)}`;
 const result=card.querySelector('[data-reminder-result]');result.textContent=reminderOutcomeText(r);result.hidden=!r.last_result;
 if(dirty){
  if(String(r.version)!==String(oldVersion)){
   form.dataset.liveStale='true';form.querySelector('button[type=submit]').disabled=true;
   if(!form.querySelector('[data-reminder-retained]'))form.insertAdjacentHTML('afterbegin',`<p class="notice" data-reminder-retained>This reminder changed while you were writing. Your unsent action is retained. Review the updated delivery status before continuing.</p><button type="button" data-reminder-discard-live="${esc(r.id)}">Discard unsent action and use latest status</button>`);
  }
 }else card.querySelector('.reminder-action-area').innerHTML=reminderActionsHtml(r);
 const history=card.querySelector('.reminder-history');if(history?.innerHTML.trim()&&events)history.innerHTML=reminderEventRows(events);
}
function clearReminderUpdatesSession(){reminderLiveEpoch++;reminderWorkspaceGeneration++;reminderLiveRequests.clear();reminderObservedUpdates.clear();}
async function refreshReminderViews(change={}){
 const identity=me,list=$('reminders-workspace'),extras=$('appointment-extras'),epoch=reminderLiveEpoch,extraGeneration=appointmentExtrasGeneration,appointment=typeof scheduleSelected!=='undefined'?scheduleSelected:undefined;
 if(!list&&!extras)return;
 const id=change.resource_id;
 if(!id){
  if(list){
   const filter=reminderFilter,data=await api(`/api/v1/schedule/reminders?${new URLSearchParams({state:filter})}`);
   if(me!==identity||epoch!==reminderLiveEpoch||$('reminders-workspace')!==list||!list.isConnected||filter!==reminderFilter)return;
   for(const incoming of data.items||[]){
    const row=mergeReminderUpdate(incoming);
    const old=reminderRows.find(r=>r.id===row.id);if(old&&Number(old.version)<=Number(row.version))Object.assign(old,row);else if(!old)reminderRows.push(row);
    const card=Array.from(list.querySelectorAll('[data-reminder-row]')).find(c=>c.dataset.reminderRow===row.id);
    if(card)patchReminderCard(card,row);else{list.querySelector('[data-reminder-empty]')?.remove();list.querySelector('.reminder-worklist').insertAdjacentHTML('beforeend',reminderCard(row,true));}
   }
   // Loaded records that left the current filter still receive their terminal evidence.
   const remaining=reminderRows.filter(r=>!(data.items||[]).some(n=>n.id===r.id));
   await Promise.allSettled(remaining.map(row=>refreshReminderViews({resource_id:row.id})));
   const count=list.querySelector('[data-reminder-count]');if(count)count.textContent=`${reminderRows.length} reminders loaded.`;
  }else if(extras&&appointment){
   const data=await api(`/api/v1/appointments/${appointment}/reminders`);
   if(me!==identity||epoch!==reminderLiveEpoch||appointmentExtrasGeneration!==extraGeneration||$('appointment-extras')!==extras||scheduleSelected!==appointment||!extras.isConnected)return;
   for(const row of data.items||[])patchOrAppendAppointmentReminder(extras,mergeReminderUpdate(row));
  }
  return;
 }
 const generation=(reminderLiveRequests.get(id)||0)+1;reminderLiveRequests.set(id,generation);
 const data=await api(`/api/v1/schedule/reminders/${id}`);let r=data.reminder||data;
 if(me!==identity||epoch!==reminderLiveEpoch||reminderLiveRequests.get(id)!==generation)return;
 r=observeReminderUpdate(r);
 if(list&&$('reminders-workspace')===list&&list.isConnected){
  const old=reminderRows.find(row=>row.id===id),row={...(old||{}),...r};
  let card=Array.from(list.querySelectorAll('[data-reminder-row]')).find(c=>c.dataset.reminderRow===id);
  if(!old){
   const filter=reminderFilter,page=await api(`/api/v1/schedule/reminders?${new URLSearchParams({state:filter})}`);
   if(me!==identity||epoch!==reminderLiveEpoch||reminderLiveRequests.get(id)!==generation||$('reminders-workspace')!==list||!list.isConnected||filter!==reminderFilter)return;
   const matching=(page.items||[]).find(item=>item.id===id);if(!matching)return;Object.assign(row,matching,observeReminderUpdate(r));reminderRows.push(row);
   list.querySelector('[data-reminder-empty]')?.remove();list.querySelector('.reminder-worklist').insertAdjacentHTML('beforeend',reminderCard(row,true));
   card=Array.from(list.querySelectorAll('[data-reminder-row]')).find(c=>c.dataset.reminderRow===id);
   const count=list.querySelector('[data-reminder-count]');if(count)count.textContent=`${reminderRows.length} reminders loaded.`;
  }else if(Number(old.version)<=Number(row.version))Object.assign(old,row);
  patchReminderCard(card,row,data.events);
  if(reminderFilter!=='all'&&row.status!==reminderFilter){const note=card?.querySelector('[data-reminder-filter-note]');if(note){note.hidden=false;note.textContent='Updated live. This reminder may no longer match the selected filter; apply the filter to remove it.';}}
 }else if(extras&&$('appointment-extras')===extras&&extras.isConnected&&appointmentExtrasGeneration===extraGeneration&&scheduleSelected===appointment&&r.appointment_id===appointment){patchOrAppendAppointmentReminder(extras,r,data.events);}
}
function patchOrAppendAppointmentReminder(extras,row,events){
 const card=Array.from(extras.querySelectorAll('[data-reminder-row]')).find(c=>c.dataset.reminderRow===row.id);
 if(card){patchReminderCard(card,row,events);return;}
 const host=extras.querySelector('.reminder-cards');if(!host)return;
 if(!host.querySelector('[data-reminder-row]'))host.replaceChildren();
 host.insertAdjacentHTML('beforeend',reminderCard(row));
}
function appointmentReminderCards(items){
 const activeStates=['scheduled','needs_contact','sending','accepted','failed','needs_review'];
 const active=items.filter(r=>activeStates.includes(r.status)),history=items.filter(r=>!activeStates.includes(r.status));
 return `<div class="reminder-cards">${active.map(r=>reminderCard(r)).join('')||'<p>No active reminder work for this occurrence.</p>'}</div>${history.length?`<details class="reminder-previous"><summary>Completed and previous reminder records · ${history.length}</summary><div class="reminder-cards">${history.map(r=>reminderCard(r)).join('')}</div></details>`:''}`;
}
async function renderAppointmentExtras(appointment){
 const generation=++appointmentExtrasGeneration,id=appointment.id,identity=me,root=$('appointment-extras');
 const [link,reminders,pref,profile]=await Promise.all([api(`/api/v1/appointments/${id}/series`),api(`/api/v1/appointments/${id}/reminders`),api(`/api/v1/patients/${appointment.patient_id}/reminder-preferences`),api(`/api/v1/patients/${appointment.patient_id}/demographics`)]);
 if(me!==identity||generation!==appointmentExtrasGeneration||scheduleSelected!==id||$('appointment-extras')!==root||!root)return;
 reminderAppointment=appointment;reminderPreferences=pref;const content=pref.content||{},seriesId=link.series_id||link.series?.id||link.id;
 $('appointment-extras').innerHTML=`<section class="appointment-extra-section"><h3>Repeat & reminders</h3>${seriesId?`<button type="button" data-series-open="${esc(seriesId)}">Open recurring series</button>`:'<p class="muted">This appointment is not part of a recurring series.</p>'}<p>Reminders follow this occurrence when it moves. Cancelled or completed appointments do not send queued reminders. Provider acceptance does not mean delivery.</p>${canSchedule()?`<details><summary>Patient reminder preferences</summary><form id="reminder-preferences-form" data-patient="${esc(appointment.patient_id)}" data-version="${pref.version}"><label>Contact method<select name="channel"><option value="email" ${content.channel!=='phone'?'selected':''}>Email</option><option value="phone" ${content.channel==='phone'?'selected':''}>Phone · staff contact only</option></select></label><label>Reminder destination<input name="destination" value="${esc(content.destination||profile.content?.email||'')}" maxlength="254" required></label><p class="muted">Must match the patient’s current contact profile. Update Patient details first if it has changed.</p><label class="review-ack"><input name="consented" type="checkbox" ${content.consented?'checked':''}>Patient agreed to appointment reminders at this destination</label><label class="review-ack"><input name="verified" type="checkbox" ${content.verified?'checked':''}>Staff verified this destination with the patient</label><label class="review-ack"><input name="automatic_email" type="checkbox" ${content.automatic_email?'checked':''}>Allow automatic email reminders through the configured sender</label><label>Consent / verification reason<input name="reason" required maxlength="1000"></label><button type="submit">Save reminder preferences</button></form><details><summary>Preference history</summary>${(pref.history||[]).map(event=>`<p>v${event.version} · ${esc(date(event.created_at))}<br>${esc(event.reason)}</p>`).join('')||'<p>No preference revisions recorded.</p>'}</details></details><form id="appointment-reminder-create" data-appointment="${esc(id)}" data-version="${reminders.appointment_version}" data-request="${crypto.randomUUID()}"><h4>Add reminder</h4><label>Minutes before appointment<input name="before_minutes" type="number" min="1" max="525600" value="1440" required></label><label>Reason<input name="reason" required maxlength="1000"></label><button type="submit">Schedule reminder</button></form>`:''}${appointmentReminderCards(reminders.items.map(mergeReminderUpdate))}<button type="button" data-reminder-workspace>Open reminder worklist</button></section>`;
}
async function showReminderWorkspace(append=false){
 const identity=me,generation=++reminderWorkspaceGeneration,filter=reminderFilter,navigation=typeof supportNavigationGeneration==='number'?supportNavigationGeneration:0;
 const page=await api(`/api/v1/schedule/reminders?${new URLSearchParams({state:filter,...(append&&reminderCursor?{after:reminderCursor}:{})})}`);
 if(me!==identity||generation!==reminderWorkspaceGeneration||filter!==reminderFilter||(typeof supportNavigationGeneration==='number'&&navigation!==supportNavigationGeneration))return;
 reminderRows=(append?[...reminderRows,...page.items]:page.items).map(mergeReminderUpdate).sort((a,b)=>new Date(a.due_at)-new Date(b.due_at)||a.id.localeCompare(b.id));reminderCursor=page.next_cursor;
 showTool('Appointment reminders');
 $('tools').innerHTML=`<section id="reminders-workspace"><div class="section-head"><div><h2>Appointment reminders</h2><p class="muted">Due reminders, contact readiness and delivery history</p></div><div class="actions">${me.role==='owner'?'<button type="button" data-reminder-settings>Sender settings</button>':''}<button type="button" data-reminder-back>Schedule</button></div></div><div class="mapping-notice">Automatic email requires a configured sender plus verified patient permission. Phone reminders are staff contact tasks. An accepted email is not proof it reached the patient.</div><form id="reminder-filter-form"><label>Reminder status<select name="state">${['due','all','scheduled','needs_contact','sending','accepted','delivered','failed','needs_review','cancelled','superseded','missed','manual_contacted','manual_no_answer','manual_failed'].map(state=>`<option value="${state}" ${state===reminderFilter?'selected':''}>${esc(scheduleLabel(state))}</option>`).join('')}</select></label><button type="submit">Apply filter</button></form><p data-reminder-count>${reminderRows.length} reminders loaded.</p><div class="reminder-worklist">${reminderRows.map(r=>reminderCard(r,true)).join('')||'<p class="muted" data-reminder-empty>No reminders match this filter.</p>'}</div>${reminderCursor?'<button type="button" data-reminder-more>Load more reminders</button>':''}</section>`;
 void refreshReminderViews().catch(()=>{});
}
async function showReminderSettings(){
 const [data,connect]=await Promise.all([api('/api/v1/schedule/reminder-settings'),api('/api/v1/connect/services/settings')]);reminderSettings=data.setting;
 const s=data.setting,mode=s?.delivery_mode||'suncharts_connect',managed=mode==='suncharts_connect',service=connect.setting;
 showTool('Reminder settings');
 $('tools').innerHTML=`<section id="reminder-settings-workspace"><div class="section-head"><div><h2>Appointment email</h2><p class="muted">Managed service or your practice’s branded sender</p></div><button type="button" data-reminder-workspace>Reminder worklist</button></div><p>Patient permission and verification of the current contact address are required for either option.</p>${!data.credential_storage_ready?'<p class="notice error">Restore the server credential encryption key before changing settings.</p>':''}<form id="reminder-settings-form" data-version="${s?.version||0}"><label>Email delivery<select name="delivery_mode" id="reminder-delivery-mode"><option value="suncharts_connect" ${managed?'selected':''}>SunCharts Connect — managed email</option><option value="own_resend" ${!managed?'selected':''}>My Resend account — white-label sender</option></select></label><section id="reminder-managed-fields" class="billing-section" ${managed?'':'hidden'}><h3>Included with SunCharts Connect</h3><p>SunCharts handles the email service and sender. There is no Resend API key to manage.</p><p>${service?.enabled&&service?.verified&&service.services?.reminders?.available?'Managed email is available for this installation.':'Managed email is not active. Choose Connect to SunCharts in Connected apps to finish setup.'}</p><button type="button" data-connect-services>Manage Connect services</button></section><section id="reminder-own-fields" class="billing-section" ${!managed?'':'hidden'}><h3>Your own sender</h3><p>Use your practice’s verified domain and Resend account for white-label email. Your account handles provider usage.</p><label>From email<input name="from_email" type="email" value="${esc(!managed?s?.from_email||'':'')}" maxlength="254" ${!managed?'required':''}></label><label>Resend API key ${s&&!managed?'(blank keeps saved key)':''}<input name="api_key" type="password" autocomplete="new-password" spellcheck="false" maxlength="512"></label><p class="muted">The key needs domain-read, sending and email-read access. Keys are encrypted on the server and never displayed again.</p></section><p>Saving pauses new automatic sends until you test and explicitly enable this delivery option.</p><button type="submit">Save email delivery option</button></form>${s?`<section class="billing-section"><h3>Sender status</h3><p>${s.enabled?'Automatic email enabled':'Automatic email disabled'} · ${s.verified?'Connection verified':'Not verified'}${s.from_email?` · ${esc(s.from_email)}`:''}</p><div class="actions"><button type="button" data-reminder-test>Test sender connection</button><button type="button" data-reminder-activate="${s.enabled?'false':'true'}" ${!s.verified&&!s.enabled?'disabled':''}>${s.enabled?'Disable automatic email':'Enable automatic email'}</button></div></section>`:''}<p class="muted">A connection test sends no email. Provider acceptance and confirmed delivery remain separate statuses.</p></section>`;
}
document.addEventListener('change',e=>{if(e.target.id==='reminder-delivery-mode'){const own=e.target.value==='own_resend';$('reminder-own-fields').hidden=!own;$('reminder-managed-fields').hidden=own;$('reminder-settings-form').elements.from_email.required=own;}});
document.addEventListener('input',e=>{
 const form=e.target.closest('#schedule-booking');if(!form||e.target.closest('#series-preview'))return;
 if(seriesDraft?.form===form){seriesDraft=undefined;form.querySelector('#series-preview')?.replaceChildren();form.dataset.request=crypto.randomUUID();}
 const button=form.querySelector('button[type=submit]');if(button&&form.elements.repeat_frequency)button.textContent=form.elements.repeat_frequency.value==='none'?'Book appointment':'Preview recurring visits';
});
document.addEventListener('submit',e=>{
 const form=e.target;
 if(form.id==='schedule-booking'&&form.elements.repeat_frequency?.value!=='none'&&form.elements.repeat_frequency){e.preventDefault();e.stopImmediatePropagation();run(()=>previewRecurring(form));return;}
 if(!['series-cancel-form','reminder-preferences-form','appointment-reminder-create','reminder-filter-form','reminder-settings-form'].includes(form.id)&&!form.classList.contains('reminder-action-form'))return;
 e.preventDefault();e.stopImmediatePropagation();run(async()=>{
  const d=Object.fromEntries(new FormData(form));
  if(form.id==='series-cancel-form'){await api(`/api/v1/schedule/series/${form.dataset.series}/actions`,'POST',{action:'cancel_upcoming',reason:d.reason,occurrence_versions:JSON.parse(form.dataset.occurrences)},Number(form.dataset.version));await showSchedule();await showAppointmentSeries(form.dataset.series);notice('Future booked series visits cancelled with history.');return;}
  if(form.id==='reminder-preferences-form'){await api(`/api/v1/patients/${form.dataset.patient}/reminder-preferences`,'PUT',{channel:d.channel,destination:d.destination,consented:d.consented==='on',verified:d.verified==='on',automatic_email:d.automatic_email==='on',reason:d.reason},Number(form.dataset.version));await appointmentDetail(reminderAppointment.id);notice('Patient reminder preferences saved.');return;}
  if(form.id==='appointment-reminder-create'){await api(`/api/v1/appointments/${form.dataset.appointment}/reminders`,'POST',{request_id:form.dataset.request,before_minutes:Number(d.before_minutes),reason:d.reason},Number(form.dataset.version));await appointmentDetail(form.dataset.appointment);notice('Appointment reminder scheduled.');return;}
  if(form.id==='reminder-filter-form'){reminderFilter=d.state;await showReminderWorkspace();return;}
  if(form.id==='reminder-settings-form'){if(d.delivery_mode==='suncharts_connect'){delete d.api_key;delete d.from_email;}else if(!d.api_key)delete d.api_key;await api('/api/v1/schedule/reminder-settings','PUT',d,Number(form.dataset.version));form.querySelector('input[type=password]').value='';await showReminderSettings();notice('Sender credentials saved; automatic email remains disabled.');return;}
  if(form.dataset.liveStale==='true')throw new Error('This reminder changed. Retain or discard your unsent action before continuing.');
  await api(`/api/v1/schedule/reminders/${form.dataset.id}/actions`,'POST',d,Number(form.dataset.version));
  if($('reminders-workspace'))await showReminderWorkspace();else if(reminderAppointment)await appointmentDetail(reminderAppointment.id);
  notice('Reminder outcome recorded with history.');
 });
},true);
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.reminderDiscardLive){e.preventDefault();e.stopImmediatePropagation();const card=b.closest('[data-reminder-row]'),latest=reminderLatestCards.get(card);if(latest){card.querySelector('.reminder-action-area').innerHTML=reminderActionsHtml(latest);}return;}
 const handled=b.dataset.reminderAppointment||b.hasAttribute('data-series-list')||b.hasAttribute('data-series-create')||b.dataset.seriesOpen||b.hasAttribute('data-reminder-workspace')||b.hasAttribute('data-reminder-settings')||b.hasAttribute('data-reminder-back')||b.hasAttribute('data-reminder-more')||b.dataset.reminderHistory||b.hasAttribute('data-reminder-test')||b.hasAttribute('data-reminder-activate');
 if(!handled)return;e.preventDefault();e.stopImmediatePropagation();run(async()=>{
  if(b.dataset.reminderAppointment){await showSchedule();await appointmentDetail(b.dataset.reminderAppointment);return;}
  if(b.hasAttribute('data-series-list')){await showRecurringSeriesList();return;}
  if(b.hasAttribute('data-series-create')){await createReviewedSeries();return;}
  if(b.dataset.seriesOpen){await showAppointmentSeries(b.dataset.seriesOpen);return;}
  if(b.hasAttribute('data-reminder-workspace')){await showReminderWorkspace();return;}
  if(b.hasAttribute('data-reminder-settings')){await showReminderSettings();return;}
  if(b.hasAttribute('data-reminder-back')){await showSchedule();return;}
  if(b.hasAttribute('data-reminder-more')){await showReminderWorkspace(true);return;}
  if(b.dataset.reminderHistory){const identity=me,epoch=reminderLiveEpoch,card=b.closest('[data-reminder-row]'),data=await api(`/api/v1/schedule/reminders/${b.dataset.reminderHistory}`);if(me===identity&&epoch===reminderLiveEpoch&&card?.isConnected)card.querySelector('.reminder-history').innerHTML=reminderEventRows(data.events);return;}
  const settingsForm=$('reminder-settings-form');if(settingsForm&&(settingsForm.elements.api_key.value||settingsForm.elements.delivery_mode.value!==(reminderSettings.delivery_mode||'own_resend')||((reminderSettings.delivery_mode||'own_resend')==='own_resend'&&settingsForm.elements.from_email.value!==reminderSettings.from_email)))throw new Error('Save changed email delivery settings before testing or enabling.');
  if(b.hasAttribute('data-reminder-test'))await api('/api/v1/schedule/reminder-settings/test','POST',{},reminderSettings.version);
  else await api('/api/v1/schedule/reminder-settings/activation','POST',{enabled:b.dataset.reminderActivate==='true'},reminderSettings.version);
  await showReminderSettings();
 });
},true);
