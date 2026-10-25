// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let scheduleDate=localTime(new Date().toISOString()).slice(0,10), scheduleMode='day', scheduleProvider='', scheduleState, scheduleProviders=[], schedulePatients=[], scheduleCursor, scheduleSelected;
const canSchedule=()=>['owner','clinician','front_desk'].includes(me.role);
function scheduleInstant(value){
 const d=new Date(value);if(!Number.isFinite(d.getTime())||localTime(d.toISOString())!==value)throw new Error('This local time does not exist. Choose another time.');
 for(const delta of [-7200000,-3600000,-1800000,1800000,3600000,7200000])if(localTime(new Date(d.getTime()+delta).toISOString())===value)throw new Error('This local time occurs twice during a clock change. Use the API with an explicit UTC offset or choose another time.');
 return d.toISOString();
}
const scheduleLabel=s=>String(s).replaceAll('_',' ');
function scheduleBounds(){const start=new Date(`${scheduleDate}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+(scheduleMode==='week'?7:1));return {start:start.toISOString(),end:end.toISOString()};}
async function showSchedule(){
 const providers=await api('/api/v1/schedule/providers');
 const bounds=scheduleBounds();const data=await api(`/api/v1/schedule?${new URLSearchParams({...bounds,...(scheduleProvider?{clinician_id:scheduleProvider}:{})})}`);
 scheduleProviders=providers.items;scheduleState=data;showTool('Schedule');renderSchedule();
}
let scheduleFocus;
function schedulePanel(content){
 const panel=$('schedule-detail');if(!panel.contains(document.activeElement))scheduleFocus=document.activeElement;
 panel.hidden=false;panel.closest('.schedule-layout').classList.add('has-detail');
 panel.innerHTML=`<div class="detail-titlebar"><span>APPOINTMENT WORKSPACE</span><button type="button" data-schedule-close aria-label="Close appointment details">✕</button></div>${content}`;
 document.querySelectorAll('[data-schedule-id]').forEach(row=>row.classList.toggle('is-selected',row.dataset.scheduleId===scheduleSelected));
 const heading=panel.querySelector('h2,h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}panel.scrollTop=0;
}
function closeSchedulePane(){
 $('schedule-detail').hidden=true;$('schedule-detail').closest('.schedule-layout').classList.remove('has-detail');
 if(scheduleFocus?.isConnected)scheduleFocus.focus({preventScroll:true});
}
function renderSchedule(){
 const active=scheduleState.appointments.filter(a=>!['cancelled','no_show'].includes(a.status));
 const checked=active.filter(a=>a.status==='checked_in').length;
 const days=Array.from({length:scheduleMode==='week'?7:1},(_,i)=>{const d=new Date(`${scheduleDate}T12:00:00`);d.setDate(d.getDate()+i);return localTime(d.toISOString()).slice(0,10);});
 const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const time=s=>new Date(s).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
 $('tools').innerHTML=`<section id="schedule-workspace"><div class="schedule-commandbar"><div><h2>Practice schedule</h2><p class="muted">${esc(tz)} · ${scheduleMode==='week'?'Seven days from selected date':'Day agenda'}</p></div>${canSchedule()?'<div class="actions"><button type="button" data-new-block>Block time</button><button type="button" class="primary" data-new-appointment>+ Appointment</button></div>':''}</div>
 <form id="schedule-filter" class="schedule-toolbar"><div class="actions"><button type="button" data-schedule-shift="-1" aria-label="Previous period">←</button><button type="button" data-schedule-today>Today</button><button type="button" data-schedule-shift="1" aria-label="Next period">→</button></div><label>Date<input name="date" type="date" value="${esc(scheduleDate)}" required></label><label>View<select name="view"><option value="day" ${scheduleMode==='day'?'selected':''}>Day</option><option value="week" ${scheduleMode==='week'?'selected':''}>7 days</option></select></label><label>Provider<select name="provider"><option value="">All providers</option>${scheduleProviders.map(p=>`<option value="${p.id}" ${scheduleProvider===p.id?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label><button type="submit">Apply</button></form>
 <div class="schedule-statusbar"><span><b>${active.length}</b> appointments</span><span class="status-dot checked_in"><b>${checked}</b> checked in</span><span class="status-dot in_progress"><b>${active.filter(a=>a.status==='in_progress').length}</b> in progress</span><span><b>${scheduleState.blocks.length}</b> time blocks</span><span class="schedule-status-hint">Select a patient to manage appointment</span></div>
 <div class="schedule-layout"><div class="schedule-agenda">${days.map(day=>{const start=new Date(`${day}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);const entries=[...scheduleState.appointments.map(a=>({...a,kind:'appointment'})),...scheduleState.blocks.map(b=>({...b,kind:'block'}))].filter(a=>new Date(a.starts_at)<end&&new Date(a.ends_at)>start).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));return `<section class="schedule-day"><h3>${esc(start.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}))}<small>${entries.length} entries</small></h3><div class="schedule-table-wrap"><table class="schedule-table"><caption class="sr-only">Appointments for ${esc(day)}</caption><thead><tr><th scope="col">Time</th><th scope="col">Patient / appointment</th><th scope="col">Provider</th><th scope="col">Location</th><th scope="col">Status</th></tr></thead><tbody>${entries.map(a=>`<tr data-schedule-id="${a.id}" class="${a.kind==='block'?'schedule-block':esc(a.status)}"><td class="schedule-table-time"><b>${esc(time(a.starts_at))}</b><small>${esc(time(a.ends_at))}</small></td><td><button type="button" class="schedule-patient-link" ${a.kind==='block'?`data-schedule-block="${a.id}"`:`data-schedule-open="${a.id}"`}>${esc(a.kind==='block'?a.label:a.patient_name)}</button><small>${esc(a.kind==='block'?'Provider unavailable':a.title)}${a.source_history_id?' · Imported':''}</small></td><td><span class="provider-label">${esc(a.kind==='block'?scheduleProviders.find(p=>p.id===a.clinician_id)?.label:a.provider_label)}</span></td><td>${esc(a.facility||'—')}<small>${a.room?'Room '+esc(a.room):''}</small></td><td><span class="status-badge ${a.kind==='block'?'blocked':esc(a.status)}">${esc(a.kind==='block'?'Blocked':scheduleLabel(a.status))}</span></td></tr>`).join('')||'<tr><td colspan="5" class="table-empty">No appointments or provider blocks in this period.</td></tr>'}</tbody></table></div></section>`;}).join('')}<p class="schedule-footnote">${scheduleState.appointments.length} appointments shown · Times displayed in ${esc(tz)}</p></div><section id="schedule-detail" class="schedule-detail" aria-label="Appointment details" hidden></section></div></section>`;
}
async function appointmentDetail(id){
 const a=await api(`/api/v1/appointments/${id}`);scheduleSelected=id;
 const p=scheduleState.appointments.find(x=>x.id===id);const h=await api(`/api/v1/appointments/${id}/history`);
 schedulePanel(`<div class="section-head"><h3>${esc(p?.patient_name||'Patient appointment')}</h3><span class="pill">${esc(scheduleLabel(a.status))}</span></div><h2>${esc(a.title)}</h2><p>${esc(date(a.starts_at))}<br>to ${esc(date(a.ends_at))}</p><p>${esc(a.category)}${a.facility?' · '+esc(a.facility):''}${a.room?' / '+esc(a.room):''}</p><p class="note-text">${esc(a.notes)}</p><p class="muted">${a.source_history_id?'Reconciled source appointment · Source history preserved':'Native appointment'} · v${a.version}</p><div class="actions"><button type="button" data-schedule-chart="${a.patient_id}" data-appointment="${a.id}">Open patient chart</button>${canSchedule()&&a.status==='booked'?`<button type="button" data-schedule-edit="${a.id}">Edit / reschedule</button>`:''}${['owner','clinician'].includes(me.role)&&a.clinician_id===me.user_id&&a.status==='checked_in'?`<button type="button" class="primary" data-schedule-start="${a.id}" data-patient="${a.patient_id}">Start visit</button>`:''}</div>
 ${canSchedule()&&['booked','checked_in'].includes(a.status)?`<form id="schedule-action" data-id="${a.id}" data-version="${a.version}"><h3>Appointment action</h3><label>Action<select name="action">${a.status==='booked'?'<option value="check_in">Check in</option>':''}<option value="cancel">Cancel appointment</option>${a.status==='booked'&&new Date(a.starts_at)<=new Date()?'<option value="no_show">Mark no-show</option>':''}</select></label><label>Reason<input name="reason" required maxlength="1000"></label><button type="submit">Record action</button></form>`:''}
 <h3>Appointment history</h3>${h.items.map(r=>`<details class="amendment"><summary>v${r.version} · ${esc(scheduleLabel(r.snapshot.status))} · ${esc(r.reason)}</summary><p>${esc(date(r.snapshot.starts_at))} – ${esc(date(r.snapshot.ends_at))}</p><p>${esc(r.snapshot.title)} · ${esc(r.snapshot.facility)} ${esc(r.snapshot.room)}</p><small>Recorded ${esc(date(r.created_at))} · Actor ${esc(r.actor_id)}</small></details>`).join('')}`);
}
async function loadSchedulePatients(){const page=await api('/api/v1/patients');schedulePatients=page.items;scheduleCursor=page.next_cursor;}
function patientOptions(id){return schedulePatients.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''}>${esc(p.family_name)}, ${esc(p.given_name)} · ${esc(p.mrn)}</option>`).join('');}
async function appointmentEditor(a,sourceMapping){
 if(!a)await loadSchedulePatients();
 const source=sourceMapping?.source;const raw=source?.source_data||{};const data=source?.data||{};
 const mappedPatient=sourceMapping?.patient_id;
 if(mappedPatient&&!schedulePatients.some(p=>p.id===mappedPatient)){const p=await api(`/api/v1/patients/${mappedPatient}`);schedulePatients.unshift(p);}
 const proposedStart=data.starts_at&&/([zZ]|[+-]\d\d:\d\d)$/.test(data.starts_at)?localTime(data.starts_at):'';
 const proposedEnd=data.ends_at&&/([zZ]|[+-]\d\d:\d\d)$/.test(data.ends_at)?localTime(data.ends_at):'';
 const start=a?localTime(a.starts_at):proposedStart||(source?'':`${scheduleDate}T09:00`),end=a?localTime(a.ends_at):proposedEnd||(source?'':`${scheduleDate}T09:30`);
 schedulePanel(`<h2>${a?'Edit appointment':source?'Reconcile source appointment':'New appointment'}</h2>${source?`<div class="signed-notice"><b>Verify this occurrence before booking</b><p>Source ${esc(source.source_instance)} · ${esc(source.source_id)}</p><p>Source date/time: ${esc(raw.pc_eventDate||data.pc_eventDate)} ${esc(raw.pc_startTime||data.pc_startTime)} · Duration seconds: ${esc(raw.pc_duration||data.pc_duration)}</p><p>Provider ID: ${esc(raw.pc_aid||data.pc_aid)} · Status: ${esc(raw.pc_apptstatus||data.pc_apptstatus)} · Recurrence: ${esc(raw.pc_recurrtype??data.pc_recurrtype??'unknown')}</p><p>The new native status is Booked. Choose the matching provider and verify timezone and occurrence. Past/completed encounters remain preserved in source history.</p></div>`:''}
 <form id="schedule-booking" data-id="${a?.id||''}" data-version="${a?.version||''}" data-request="${crypto.randomUUID()}" data-source="${source?.id||''}">
 ${a?`<input type="hidden" name="patient_id" value="${a.patient_id}">`:`<label>Find a loaded patient<input type="search" id="schedule-patient-search" placeholder="Name or medical record number"></label><label>Patient<select id="schedule-patient" name="patient_id" required ${mappedPatient?'disabled':''}><option value="">Choose a patient</option>${patientOptions(mappedPatient)}</select></label>${mappedPatient?`<input type="hidden" name="patient_id" value="${mappedPatient}">`:''}${scheduleCursor&&!mappedPatient?'<button type="button" data-schedule-more>Load more patients</button>':''}`}
 <label>Provider<select name="clinician_id" required><option value="">Choose a provider</option>${scheduleProviders.map(p=>`<option value="${p.id}" ${p.id===(a?.clinician_id||(source?'':scheduleProvider||me.user_id))?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label>
 <label>Visit title<input name="title" value="${esc(a?.title||data.title||raw.pc_title||data.pc_title||'Office visit')}" maxlength="200" required></label><label>Category<input name="category" value="${esc(a?.category||'Office visit')}" maxlength="100" required list="appointment-categories"><datalist id="appointment-categories"><option value="Office visit"><option value="New patient"><option value="Follow-up"><option value="Telehealth"><option value="Procedure"></datalist></label>
 <div class="form-grid"><label>Start (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)})<input name="starts_at" type="datetime-local" value="${esc(start)}" required></label><label>End<input name="ends_at" type="datetime-local" value="${esc(end)}" required></label><label>Facility<input name="facility" value="${esc(a?.facility||'')}" maxlength="200"></label><label>Room<input name="room" value="${esc(a?.room||'')}" maxlength="100"></label></div>
 <label>Scheduling notes<textarea name="notes" maxlength="2000">${esc(a?.notes||raw.pc_hometext||data.pc_hometext||'')}</textarea></label><label>Reason for ${a?'change':'booking'}<input name="reason" value="${a?'':source?'Staff reviewed source appointment':'Appointment requested'}" maxlength="1000" required></label>
 ${source?'<label class="scope-options"><input name="source_reviewed" type="checkbox" required> I verified the patient, provider, source status, occurrence and timezone.</label>':''}
 <p class="muted">Provider, patient and named room conflicts are checked before saving. Recurring series and automated reminders are not yet available.</p><div class="actions"><button class="primary" type="submit">${a?'Save changes':'Book appointment'}</button><button type="button" data-schedule-close>Close</button></div></form>`);

}
function blockEditor(){
 schedulePanel(`<h2>Block provider time</h2><p class="muted">Use for breaks, leave, or administrative time. Existing appointments must be moved before blocking their time.</p><form id="schedule-block-form" data-request="${crypto.randomUUID()}"><label>Provider<select name="clinician_id" required>${scheduleProviders.map(p=>`<option value="${p.id}" ${p.id===(scheduleProvider||me.user_id)?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label><label>Label<input name="label" required maxlength="200" placeholder="Lunch / administrative time"></label><label>Start<input name="starts_at" type="datetime-local" value="${scheduleDate}T12:00" required></label><label>End<input name="ends_at" type="datetime-local" value="${scheduleDate}T13:00" required></label><div class="actions"><button class="primary" type="submit">Block time</button><button type="button" data-schedule-close>Close</button></div></form>`);
}
document.addEventListener('input',e=>{if(e.target.id==='schedule-patient-search'){const q=e.target.value.toLowerCase();Array.from($('schedule-patient').options).forEach(o=>{o.hidden=!!o.value&&!o.textContent.toLowerCase().includes(q);});}});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.type==='submit'||(!b.closest('#schedule-workspace')&&!b.dataset.mapAppointment))return;
 run(async()=>{
 if(b.dataset.mapAppointment){const patient=selected,m=await api(`/api/v1/patients/${patient}/history/${b.dataset.mapAppointment}/appointment-mapping`);await showSchedule();if(m.native_appointment_id)await appointmentDetail(m.native_appointment_id);else await appointmentEditor(null,{...m,patient_id:patient});return;}
 if(b.dataset.scheduleShift){const d=new Date(`${scheduleDate}T12:00:00`);d.setDate(d.getDate()+Number(b.dataset.scheduleShift)*(scheduleMode==='week'?7:1));scheduleDate=localTime(d.toISOString()).slice(0,10);await showSchedule();return;}
 if(b.hasAttribute('data-schedule-today')){scheduleDate=localTime(new Date().toISOString()).slice(0,10);await showSchedule();return;}
 if(b.hasAttribute('data-new-appointment')){scheduleSelected=undefined;await appointmentEditor();return;}
 if(b.dataset.scheduleEdit){await appointmentEditor(await api(`/api/v1/appointments/${b.dataset.scheduleEdit}`));return;}
 if(b.dataset.scheduleOpen){await appointmentDetail(b.dataset.scheduleOpen);return;}
 if(b.hasAttribute('data-new-block')){scheduleSelected=undefined;blockEditor();return;}
 if(b.hasAttribute('data-schedule-close')){closeSchedulePane();return;}
 if(b.hasAttribute('data-schedule-more')){const page=await api(`/api/v1/patients?after=${encodeURIComponent(scheduleCursor)}`);schedulePatients.push(...page.items);scheduleCursor=page.next_cursor;$('schedule-patient').insertAdjacentHTML('beforeend',page.items.map(p=>`<option value="${p.id}">${esc(p.family_name)}, ${esc(p.given_name)} · ${esc(p.mrn)}</option>`).join(''));if(!scheduleCursor)b.remove();return;}
 if(b.dataset.scheduleChart){await showClinical();await selectPatient(b.dataset.scheduleChart);return;}
 if(b.dataset.scheduleStart){const v=await api('/api/v1/visits','POST',{appointment_id:b.dataset.scheduleStart});await showClinical();await selectPatient(b.dataset.patient,v.id);return;}
 if(b.dataset.scheduleBlock){scheduleSelected=b.dataset.scheduleBlock;const block=scheduleState.blocks.find(x=>x.id===b.dataset.scheduleBlock);schedulePanel(`<h2>${esc(block.label)}</h2><p>${esc(date(block.starts_at))} – ${esc(date(block.ends_at))}</p>${canSchedule()?`<form id="schedule-block-cancel" data-id="${block.id}" data-version="${block.version}"><label>Reason for removing block<input name="reason" required maxlength="1000"></label><button type="submit">Remove time block</button></form>`:''}`);}
 });});
document.addEventListener('submit',e=>{const f=e.target;if(!['schedule-filter','schedule-booking','schedule-action','schedule-block-form','schedule-block-cancel'].includes(f.id))return;e.preventDefault();run(async()=>{const d=Object.fromEntries(new FormData(f));
 if(f.id==='schedule-filter'){scheduleDate=d.date;scheduleMode=d.view;scheduleProvider=d.provider;await showSchedule();return;}
 if(f.id==='schedule-booking'){delete d.source_reviewed;d.starts_at=scheduleInstant(d.starts_at);d.ends_at=scheduleInstant(d.ends_at);let saved;
 if(f.dataset.id){delete d.patient_id;saved=await api(`/api/v1/appointments/${f.dataset.id}`,'PUT',d,Number(f.dataset.version));}else{d.request_id=f.dataset.request;d.source_history_id=f.dataset.source||null;saved=await api('/api/v1/appointments','POST',d);}
 scheduleDate=localTime(saved.starts_at).slice(0,10);await showSchedule();await appointmentDetail(saved.id);notice(f.dataset.id?'Appointment updated.':'Appointment booked.');return;}
 if(f.id==='schedule-action'){const a=await api(`/api/v1/appointments/${f.dataset.id}/actions`,'POST',d,Number(f.dataset.version));await showSchedule();await appointmentDetail(a.id);notice('Appointment action recorded.');return;}
 if(f.id==='schedule-block-form'){d.request_id=f.dataset.request;d.starts_at=scheduleInstant(d.starts_at);d.ends_at=scheduleInstant(d.ends_at);await api('/api/v1/schedule/blocks','POST',d);await showSchedule();notice('Provider time blocked.');return;}
 if(f.id==='schedule-block-cancel'){await api(`/api/v1/schedule/blocks/${f.dataset.id}/cancel`,'POST',d,Number(f.dataset.version));await showSchedule();notice('Time block removed.');}
 });});

document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('schedule-detail')&&!$('schedule-detail').hidden){e.preventDefault();closeSchedulePane();}});
