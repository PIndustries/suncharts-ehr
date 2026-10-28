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
function scheduleDayKey(value){return localTime(value.toISOString()).slice(0,10);}
function scheduleCalendarDays(){
 const first=new Date(`${scheduleDate}T12:00:00`);first.setDate(1);first.setDate(first.getDate()-first.getDay());
 return Array.from({length:42},(_,i)=>{const d=new Date(first);d.setDate(d.getDate()+i);return scheduleDayKey(d);});
}
function scheduleWeekDays(){
 const d=new Date(`${scheduleDate}T12:00:00`);d.setDate(d.getDate()-(d.getDay()+6)%7);
 return Array.from({length:7},(_,i)=>{const v=new Date(d);v.setDate(v.getDate()+i);return scheduleDayKey(v);});
}
function scheduleBounds(){
 const start=new Date(`${scheduleMode==='month'?scheduleCalendarDays()[0]:scheduleMode==='week_grid'?scheduleWeekDays()[0]:scheduleDate}T00:00:00`),end=new Date(start);
 end.setDate(end.getDate()+(scheduleMode==='month'?42:['week','week_grid'].includes(scheduleMode)?7:1));
 return {start:start.toISOString(),end:end.toISOString()};
}
function shiftSchedulePeriod(direction){
 const d=new Date(`${scheduleDate}T12:00:00`);
 if(scheduleMode==='month'){d.setDate(1);d.setMonth(d.getMonth()+direction);}else d.setDate(d.getDate()+direction*(['week','week_grid'].includes(scheduleMode)?7:1));
 scheduleDate=scheduleDayKey(d);
}
let scheduleLoadGeneration=0;
async function showSchedule(){
 scheduleDrag=undefined;scheduleMove=undefined;
 const generation=++scheduleLoadGeneration,bounds=scheduleBounds(),provider=scheduleProvider;
 // Keep each request below the server's 31-day limit, including DST transitions.
 const ranges=[];let cursor=new Date(bounds.start),end=new Date(bounds.end);
 while(cursor<end){const next=new Date(cursor);next.setDate(next.getDate()+21);if(next>end)next.setTime(end.getTime());ranges.push({start:cursor.toISOString(),end:next.toISOString()});cursor=next;}
 const [providers,pages]=await Promise.all([api('/api/v1/schedule/providers'),Promise.all(ranges.map(range=>api(`/api/v1/schedule?${new URLSearchParams({...range,...(provider?{clinician_id:provider}:{})})}`)))]);
 if(generation!==scheduleLoadGeneration)return;
 const unique=key=>Array.from(new Map(pages.flatMap(page=>page[key]).map(item=>[item.id,item])).values());
 scheduleProviders=providers.items;scheduleState={appointments:unique('appointments'),blocks:unique('blocks')};showTool('Schedule');renderSchedule();
}
function scheduleEntriesForDay(day){
 const start=new Date(`${day}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);
 return [...scheduleState.appointments.map(a=>({...a,kind:'appointment'})),...scheduleState.blocks.map(b=>({...b,kind:'block'}))].filter(a=>new Date(a.starts_at)<end&&new Date(a.ends_at)>start).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.id.localeCompare(b.id));
}
function scheduleMonthCalendar(){
 const days=scheduleCalendarDays(),today=scheduleDayKey(new Date()),month=scheduleDate.slice(0,7);
 const monthLabel=new Date(`${scheduleDate}T12:00:00`).toLocaleDateString(undefined,{month:'long',year:'numeric'});
 const time=value=>new Date(value).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
 return `<section class="schedule-month" aria-label="${esc(monthLabel)} calendar"><div class="calendar-title"><h3>${esc(monthLabel)}</h3><span>Choose a date for its agenda · Select an appointment for details</span></div><div class="calendar-scroll"><table class="month-calendar"><caption class="sr-only">${esc(monthLabel)} appointments and provider time blocks</caption><thead><tr>${days.slice(0,7).map(day=>`<th scope="col">${esc(new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{weekday:'short'}))}</th>`).join('')}</tr></thead><tbody>${Array.from({length:6},(_,week)=>`<tr>${days.slice(week*7,week*7+7).map(day=>{
 const entries=scheduleEntriesForDay(day),label=new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
 return `<td class="calendar-day ${day.slice(0,7)!==month?'outside-month ':''}${day===today?'calendar-today ':''}${day===scheduleDate?'calendar-selected':''}"><div class="calendar-date-row"><button type="button" data-calendar-day="${day}" aria-label="Open agenda for ${esc(label)}" ${day===today?'aria-current="date"':''}>${Number(day.slice(-2))}<span class="sr-only"> · ${entries.length} entries</span></button>${canSchedule()?`<button type="button" class="calendar-add" data-calendar-book="${day}" aria-label="Book appointment on ${esc(label)}">+</button>`:''}</div><div class="calendar-events">${entries.slice(0,3).map(a=>`<button type="button" class="calendar-event ${a.kind==='block'?'calendar-block':esc(a.status)}" data-schedule-id="${esc(a.id)}" ${a.kind==='block'?`data-schedule-block="${esc(a.id)}"`:`data-schedule-open="${esc(a.id)}"`}><span class="calendar-event-time">${esc(time(a.starts_at))}${localTime(a.starts_at).slice(0,10)!==day?' · continued':''}</span><strong>${esc(a.kind==='block'?a.label:a.patient_name)}</strong><span>${esc(a.kind==='block'?'Provider blocked':scheduleLabel(a.status))}</span><span>${esc(a.kind==='block'?scheduleProviders.find(p=>p.id===a.clinician_id)?.label:a.provider_label)}</span></button>`).join('')}${entries.length>3?`<button type="button" class="calendar-more" data-calendar-day="${day}">View all ${entries.length} entries</button>`:''}</div></td>`;
 }).join('')}</tr>`).join('')}</tbody></table></div><p class="schedule-footnote">Adjacent-month dates are included. Cancelled and no-show appointments stay visible with their recorded status.</p></section>`;
}
let scheduleDrag, scheduleMove;
function scheduleWeekCalendar(){
 const days=scheduleWeekDays(),providers=scheduleProviders.filter(p=>!scheduleProvider||p.id===scheduleProvider);
 // Preserve visibility for historical appointments whose provider is no longer active.
 for(const a of [...scheduleState.appointments,...scheduleState.blocks])if(!providers.some(p=>p.id===a.clinician_id))providers.push({id:a.clinician_id,label:a.provider_label||'Unavailable provider'});
 if(!providers.length)return '<div class="notice">No providers available. Add a provider before booking.</div>';
 const entries=days.map(day=>scheduleEntriesForDay(day));let first=14,last=38;
 entries.forEach((items,di)=>items.forEach(a=>{const start=localTime(a.starts_at),end=localTime(a.ends_at),minute=v=>Number(v.slice(11,13))*60+Number(v.slice(14,16));first=Math.min(first,start.slice(0,10)!==days[di]?0:Math.floor(minute(start)/30));last=Math.max(last,end.slice(0,10)!==days[di]?48:Math.ceil(minute(end)/30));}));
 const slotLabel=n=>`${String(Math.floor(n/2)).padStart(2,'0')}:${n%2?'30':'00'}`;
 const label=day=>new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
 return `<section class="week-calendar" aria-label="Week calendar"><div class="calendar-title"><h3>${esc(label(days[0]))} – ${esc(label(days[6]))}</h3><span>Drag booked appointments to a slot, then review and save. Edit / reschedule is also available without dragging.</span></div><div class="week-calendar-scroll"><table class="week-slot-table"><caption class="sr-only">Weekly schedule with providers side by side and 30-minute time slots</caption><thead><tr><th rowspan="2" scope="col">Time</th>${days.map(day=>`<th colspan="${providers.length}" scope="colgroup"><button type="button" data-calendar-day="${day}">${esc(label(day))}</button></th>`).join('')}</tr><tr>${days.map(()=>providers.map(p=>`<th scope="col">${esc(p.label)}</th>`).join('')).join('')}</tr></thead><tbody>${Array.from({length:last-first},(_,i)=>i+first).map(slot=>`<tr><th scope="row">${slotLabel(slot)}</th>${days.map((day,di)=>providers.map(p=>{
 const key=`${day}T${slotLabel(slot)}`,start=new Date(key),end=new Date(start.getTime()+1800000);
 const rows=entries[di].filter(a=>a.clinician_id===p.id&&new Date(a.starts_at)<end&&new Date(a.ends_at)>start);
 const ambiguous=!Number.isFinite(start.getTime())||localTime(start.toISOString())!==key;
 return `<td class="week-slot ${rows.length?'slot-occupied':''}" data-drop-time="${key}" data-drop-provider="${esc(p.id)}">${rows.map(a=>{
 const continued=new Date(a.starts_at)<start,canMove=canSchedule()&&a.kind==='appointment'&&a.status==='booked';
 return `<button type="button" class="week-appointment ${a.kind==='block'?'calendar-block':esc(a.status)} ${continued?'slot-continuation':''}" data-schedule-id="${esc(a.id)}" ${a.kind==='block'?`data-schedule-block="${esc(a.id)}"`:`data-schedule-open="${esc(a.id)}"`} ${canMove?`draggable="true" data-drag-appointment="${esc(a.id)}"`:''}><strong>${continued?'↳ ':''}${esc(a.kind==='block'?a.label:a.patient_name)}</strong><span>${esc(new Date(a.starts_at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}))}–${esc(new Date(a.ends_at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}))}</span><span>${esc(a.kind==='block'?'Provider blocked':scheduleLabel(a.status))}</span></button>`;
 }).join('')}${canSchedule()&&!ambiguous?`<button type="button" class="week-slot-book" data-slot-book="${key}" data-slot-provider="${esc(p.id)}" aria-label="Book ${esc(label(day))} at ${slotLabel(slot)} with ${esc(p.label)}">+</button>`:''}</td>`;
 }).join('')).join('')}</tr>`).join('')}</tbody></table></div><p class="schedule-footnote">Times use ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Occupied slots show continuing appointments; cancelled and no-show records retain their status. Only booked appointments can move.</p></section>`;
}
function proposeScheduleMove(appointment,targetTime,provider){
 if(!canSchedule()||appointment.status!=='booked')throw new Error('Only booked appointments can be rescheduled by scheduling staff.');
 if(!scheduleProviders.some(p=>p.id===provider))throw new Error('Choose an active provider.');
 const starts_at=scheduleInstant(targetTime),duration=new Date(appointment.ends_at)-new Date(appointment.starts_at);
 if(!(duration>0))throw new Error('Reload the appointment before rescheduling.');
 const ends_at=new Date(new Date(starts_at).getTime()+duration).toISOString();
 return {id:appointment.id,version:appointment.version,original:appointment,body:{clinician_id:provider,title:appointment.title,category:appointment.category,starts_at,ends_at,facility:appointment.facility,room:appointment.room,notes:appointment.notes}};
}
async function reviewScheduleMove(id,time,provider,version){
 const a=await api(`/api/v1/appointments/${id}`);
 if(a.version!==version)throw new Error('Appointment changed while dragging. Reload the schedule before moving it.');
 const proposal=proposeScheduleMove(a,time,provider);scheduleMove=proposal;scheduleSelected=id;
 schedulePanel(`<h2>Review appointment move</h2><p><b>${esc(scheduleState.appointments.find(x=>x.id===id)?.patient_name||'Patient appointment')}</b> · ${esc(a.title)}</p><p>From ${esc(date(a.starts_at))} – ${esc(date(a.ends_at))}<br>To ${esc(date(proposal.body.starts_at))} – ${esc(date(proposal.body.ends_at))}<br>Provider: ${esc(scheduleProviders.find(p=>p.id===provider).label)}</p><p class="muted">The duration, patient, room and other appointment details are preserved. Provider, patient, room and time-block conflicts are checked by the server when saving.</p><form id="schedule-move-form" data-id="${esc(id)}" data-version="${version}"><label>Reason for rescheduling<input name="reason" required maxlength="1000"></label><p id="schedule-move-error" role="alert" hidden></p><div class="actions"><button type="submit" class="primary">Save appointment move</button><button type="button" data-schedule-close>Cancel move</button></div></form>`);
}
document.addEventListener('dragstart',e=>{
 const b=e.target.closest('[data-drag-appointment]');if(!b)return;
 const a=scheduleState?.appointments.find(x=>x.id===b.dataset.dragAppointment);
 if(!a||!canSchedule()||a.status!=='booked'){e.preventDefault();return;}
 scheduleDrag={id:a.id,version:a.version};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',a.id);
});
document.addEventListener('dragover',e=>{const cell=e.target.closest('[data-drop-time]');if(!cell||!scheduleDrag||!canSchedule())return;e.preventDefault();e.dataTransfer.dropEffect='move';});
document.addEventListener('drop',e=>{
 const cell=e.target.closest('[data-drop-time]');if(!cell||!scheduleDrag)return;e.preventDefault();const drag=scheduleDrag;scheduleDrag=undefined;
 run(()=>reviewScheduleMove(drag.id,cell.dataset.dropTime,cell.dataset.dropProvider,drag.version));
});
document.addEventListener('dragend',()=>{scheduleDrag=undefined;});
let scheduleFocus;
function schedulePanel(content){
 const panel=$('schedule-detail');if(!panel.contains(document.activeElement))scheduleFocus=document.activeElement;
 panel.hidden=false;panel.closest('.schedule-layout').classList.add('has-detail');
 panel.innerHTML=`<div class="detail-titlebar"><span>APPOINTMENT WORKSPACE</span><button type="button" data-schedule-close aria-label="Close appointment details">✕</button></div>${content}`;
 document.querySelectorAll('[data-schedule-id]').forEach(row=>row.classList.toggle('is-selected',row.dataset.scheduleId===scheduleSelected));
 const heading=panel.querySelector('h2,h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}panel.scrollTop=0;
}
function closeSchedulePane(){
 scheduleMove=undefined;
 $('schedule-detail').hidden=true;$('schedule-detail').closest('.schedule-layout').classList.remove('has-detail');
 if(scheduleFocus?.isConnected)scheduleFocus.focus({preventScroll:true});
}
function renderSchedule(){
 const active=scheduleState.appointments.filter(a=>!['cancelled','no_show'].includes(a.status));
 const checked=active.filter(a=>a.status==='checked_in').length;
 const days=Array.from({length:['week','week_grid'].includes(scheduleMode)?7:1},(_,i)=>{const d=new Date(`${scheduleDate}T12:00:00`);d.setDate(d.getDate()+i);return localTime(d.toISOString()).slice(0,10);});
 const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const time=s=>new Date(s).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
 $('tools').innerHTML=`<section id="schedule-workspace"><div class="schedule-commandbar"><div><h2>Practice schedule</h2><p class="muted">${esc(tz)} · ${scheduleMode==='month'?'Month calendar':scheduleMode==='week_grid'?'Week calendar · 30-minute slots':scheduleMode==='week'?'Seven-day agenda':'Day agenda'}</p></div><div class="actions"><button type="button" data-series-list>Recurring series</button><button type="button" data-reminder-workspace>Reminders</button></div>${canSchedule()?'<div class="actions"><button type="button" data-new-block>Block time</button><button type="button" class="primary" data-new-appointment>+ Appointment</button></div>':''}</div>
 <form id="schedule-filter" class="schedule-toolbar"><div class="actions"><button type="button" data-schedule-shift="-1" aria-label="Previous period">←</button><button type="button" data-schedule-today>Today</button><button type="button" data-schedule-shift="1" aria-label="Next period">→</button></div><label>Date<input name="date" type="date" value="${esc(scheduleDate)}" required></label><label>View<select name="view"><option value="day" ${scheduleMode==='day'?'selected':''}>Day agenda</option><option value="week" ${scheduleMode==='week'?'selected':''}>7-day agenda</option><option value="month" ${scheduleMode==='month'?'selected':''}>Month calendar</option><option value="week_grid" ${scheduleMode==='week_grid'?'selected':''}>Week calendar</option></select></label><label>Provider<select name="provider"><option value="">All providers</option>${scheduleProviders.map(p=>`<option value="${p.id}" ${scheduleProvider===p.id?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label><button type="submit">Apply</button></form>
 <div class="schedule-statusbar"><span><b>${active.length}</b> appointments</span><span class="status-dot checked_in"><b>${checked}</b> checked in</span><span class="status-dot in_progress"><b>${active.filter(a=>a.status==='in_progress').length}</b> in progress</span><span><b>${scheduleState.blocks.length}</b> time blocks</span><span class="schedule-status-hint">Select a patient to manage appointment</span></div>
 <div class="schedule-layout"><div class="schedule-agenda">${scheduleMode==='month'?scheduleMonthCalendar():scheduleMode==='week_grid'?scheduleWeekCalendar():days.map(day=>{const start=new Date(`${day}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);const entries=[...scheduleState.appointments.map(a=>({...a,kind:'appointment'})),...scheduleState.blocks.map(b=>({...b,kind:'block'}))].filter(a=>new Date(a.starts_at)<end&&new Date(a.ends_at)>start).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));return `<section class="schedule-day"><h3>${esc(start.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}))}<small>${entries.length} entries</small></h3><div class="schedule-table-wrap"><table class="schedule-table"><caption class="sr-only">Appointments for ${esc(day)}</caption><thead><tr><th scope="col">Time</th><th scope="col">Patient / appointment</th><th scope="col">Provider</th><th scope="col">Location</th><th scope="col">Status</th></tr></thead><tbody>${entries.map(a=>`<tr data-schedule-id="${a.id}" class="${a.kind==='block'?'schedule-block':esc(a.status)}"><td class="schedule-table-time"><b>${esc(time(a.starts_at))}</b><small>${esc(time(a.ends_at))}</small></td><td><button type="button" class="schedule-patient-link" ${a.kind==='block'?`data-schedule-block="${a.id}"`:`data-schedule-open="${a.id}"`}>${esc(a.kind==='block'?a.label:a.patient_name)}</button><small>${esc(a.kind==='block'?'Provider unavailable':a.title)}${a.source_history_id?' · Imported':''}</small></td><td><span class="provider-label">${esc(a.kind==='block'?scheduleProviders.find(p=>p.id===a.clinician_id)?.label:a.provider_label)}</span></td><td>${esc(a.facility||'—')}<small>${a.room?'Room '+esc(a.room):''}</small></td><td><span class="status-badge ${a.kind==='block'?'blocked':esc(a.status)}">${esc(a.kind==='block'?'Blocked':scheduleLabel(a.status))}</span></td></tr>`).join('')||'<tr><td colspan="5" class="table-empty">No appointments or provider blocks in this period.</td></tr>'}</tbody></table></div></section>`;}).join('')}<p class="schedule-footnote">${scheduleState.appointments.length} appointments shown · Times displayed in ${esc(tz)}</p></div><section id="schedule-detail" class="schedule-detail" aria-label="Appointment details" hidden></section></div></section>`;
}
async function appointmentDetail(id){
 const a=await api(`/api/v1/appointments/${id}`);scheduleSelected=id;
 let p=scheduleState.appointments.find(x=>x.id===id);if(!p){const patient=await api(`/api/v1/patients/${a.patient_id}`);p={patient_name:`${patient.family_name}, ${patient.given_name}`};}const h=await api(`/api/v1/appointments/${id}/history`);
 schedulePanel(`<div class="section-head"><h3>${esc(p?.patient_name||'Patient appointment')}</h3><span class="pill">${esc(scheduleLabel(a.status))}</span></div><h2>${esc(a.title)}</h2><p>${esc(date(a.starts_at))}<br>to ${esc(date(a.ends_at))}</p><p>${esc(a.category)}${a.facility?' · '+esc(a.facility):''}${a.room?' / '+esc(a.room):''}</p><p class="note-text">${esc(a.notes)}</p><p class="muted">${a.source_history_id?'Reconciled source appointment · Source history preserved':'Native appointment'} · v${a.version}</p><div class="actions"><button type="button" data-schedule-chart="${a.patient_id}" data-appointment="${a.id}">Open patient chart</button>${canSchedule()&&a.status==='booked'?`<button type="button" data-schedule-edit="${a.id}">Edit / reschedule</button>${scheduleMode==='week_grid'?`<button type="button" data-schedule-pick-move="${a.id}">Choose calendar slot to move</button>`:''}`:''}${['owner','clinician'].includes(me.role)&&a.clinician_id===me.user_id&&a.status==='checked_in'?`<button type="button" class="primary" data-schedule-start="${a.id}" data-patient="${a.patient_id}">Start visit</button>`:''}</div>
 ${canSchedule()&&['booked','checked_in'].includes(a.status)?`<form id="schedule-action" data-id="${a.id}" data-version="${a.version}"><h3>Appointment action</h3><label>Action<select name="action">${a.status==='booked'?'<option value="check_in">Check in</option>':''}<option value="cancel">Cancel appointment</option>${a.status==='booked'&&new Date(a.starts_at)<=new Date()?'<option value="no_show">Mark no-show</option>':''}</select></label><label>Reason<input name="reason" required maxlength="1000"></label><button type="submit">Record action</button></form>`:''}
 <h3>Appointment history</h3>${h.items.map(r=>`<details class="amendment"><summary>v${r.version} · ${esc(scheduleLabel(r.snapshot.status))} · ${esc(r.reason)}</summary><p>${esc(date(r.snapshot.starts_at))} – ${esc(date(r.snapshot.ends_at))}</p><p>${esc(r.snapshot.title)} · ${esc(r.snapshot.facility)} ${esc(r.snapshot.room)}</p><small>Recorded ${esc(date(r.created_at))} · Actor ${esc(r.actor_id)}</small></details>`).join('')}<div id="appointment-extras"></div>`);
 if(typeof renderAppointmentExtras==='function')await renderAppointmentExtras(a);
}
async function loadSchedulePatients(){const page=await api('/api/v1/patients');schedulePatients=page.items;scheduleCursor=page.next_cursor;}
function patientOptions(id){return schedulePatients.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''}>${esc(p.family_name)}, ${esc(p.given_name)} · ${esc(p.mrn)}</option>`).join('');}
function patientAppointmentWorkspace(){
 const appointment=activeVisit?workspace.appointments.find(a=>a.id===activeVisit.appointment_id):null;
 const provider=a=>scheduleProviders.find(p=>p.id===a.clinician_id)?.label||(a.clinician_id===me.user_id?'You':'Assigned clinician');
 return `<section id="appointments-panel" class="panel patient-appointments"><div class="section-head"><div><h2>Appointments</h2><p class="muted">${appointment?esc(appointment.title)+' · '+esc(scheduleLabel(appointment.status)):'Book, check in and start an encounter'}</p></div>${canSchedule()?`<button type="button" data-chart-book="${esc(selected)}">Book appointment</button>`:''}</div>${appointment?`<dl class="patient-appointment-context"><div><dt>Provider</dt><dd>${esc(provider(appointment))}</dd></div><div><dt>Visit category</dt><dd>${esc(appointment.category)}</dd></div><div><dt>Facility / room</dt><dd>${esc([appointment.facility,appointment.room?'Room '+appointment.room:''].filter(Boolean).join(' · ')||'Not recorded')}</dd></div><div><dt>Scheduled</dt><dd>${esc(date(appointment.starts_at))}</dd></div></dl>`:''}<details ${activeVisit?'':'open'}><summary>Appointment history <span class="pill">${workspace.appointments.length} loaded</span></summary>${workspace.appointments.map(a=>`<div class="timeline-row"><div><b>${esc(a.title)}</b><small>${esc(date(a.starts_at))} · ${esc(scheduleLabel(a.status))}</small><small>${esc(provider(a))} · ${esc(a.category)}${a.facility?' · '+esc(a.facility):''}${a.room?' · Room '+esc(a.room):''}</small></div>${a.status==='booked'&&canSchedule()?`<button type="button" data-check-in="${esc(a.id)}">Check in</button>`:a.status==='checked_in'&&['owner','clinician'].includes(me.role)&&a.clinician_id===me.user_id?`<button type="button" class="primary" data-start="${esc(a.id)}">Start encounter</button>`:''}</div>`).join('')||'<p class="muted">No appointments recorded for this patient.</p>'}</details><div id="chart-booking-editor"></div></section>`;
}
async function openPatientAppointmentEditor(patientId){
 if(!canSchedule()||selected!==patientId)throw new Error('Open the patient chart before booking an appointment.');
 const providers=await api('/api/v1/schedule/providers');
 if(selected!==patientId)return;
 scheduleProviders=providers.items;
 // Pin the patient from the chart, including patients outside the directory page.
 schedulePatients=[workspace.patient];scheduleCursor=undefined;
 showChartSection('visits');
 await appointmentEditor(null,null,{patient_id:patientId,visit_id:activeVisit?.id||''});
}
async function attachScheduleLocations(){
 const form=$('schedule-booking'),facility=form?.querySelector?.('[name="facility"]'),room=form?.querySelector?.('[name="room"]');
 if(!facility||!room)return;
 const actor=me?.user_id;
 const hint=document.createElement('p');hint.className='muted';hint.setAttribute('role','status');hint.textContent='Loading practice location choices…';form.appendChild(hint);
 try{
  const directory=await api('/api/v1/schedule/locations');
  if($('schedule-booking')!==form||actor!==me?.user_id)return;
  const facilityChoices=document.createElement('datalist'),roomChoices=document.createElement('datalist');
  facilityChoices.id='schedule-facility-choices';roomChoices.id='schedule-room-choices';
  const option=value=>{const node=document.createElement('option');node.value=value;return node;};
  facilityChoices.replaceChildren(...directory.items.map(f=>option(f.name)));
  const updateRooms=()=>roomChoices.replaceChildren(...(directory.items.find(f=>f.name===facility.value)?.rooms||[]).map(r=>option(r.name)));
  facility.setAttribute('list',facilityChoices.id);room.setAttribute('list',roomChoices.id);form.appendChild(facilityChoices);form.appendChild(roomChoices);facility.addEventListener('input',updateRooms);updateRooms();
  hint.textContent=directory.has_more?'Location choices are limited. Existing location text remains supported; server conflict checks apply.':'Choose a practice facility and room, or retain an existing location. Server conflict checks apply.';
 }catch{if($('schedule-booking')===form&&actor===me?.user_id)hint.textContent='Practice location choices could not load. Existing location text remains supported; refresh before choosing a new location.';}
}
async function appointmentEditor(a,sourceMapping,chartContext,bookingDate=scheduleDate,slotTime,slotProvider){
 if(!a&&!chartContext)await loadSchedulePatients();
 const source=sourceMapping?.source;const raw=source?.source_data||{};const data=source?.data||{};
 const mappedPatient=sourceMapping?.patient_id||chartContext?.patient_id;
 if(mappedPatient&&!schedulePatients.some(p=>p.id===mappedPatient)){const p=await api(`/api/v1/patients/${mappedPatient}`);schedulePatients.unshift(p);}
 const proposedStart=data.starts_at&&/([zZ]|[+-]\d\d:\d\d)$/.test(data.starts_at)?localTime(data.starts_at):'';
 const proposedEnd=data.ends_at&&/([zZ]|[+-]\d\d:\d\d)$/.test(data.ends_at)?localTime(data.ends_at):'';
 const nextStart=new Date();nextStart.setMinutes(nextStart.getMinutes()+30-nextStart.getMinutes()%30,0,0);const nextEnd=new Date(nextStart.getTime()+30*60000);
 const start=a?localTime(a.starts_at):proposedStart||(source?'':chartContext?localTime(nextStart.toISOString()):(slotTime||`${bookingDate}T09:00`)),end=a?localTime(a.ends_at):proposedEnd||(source?'':chartContext?localTime(nextEnd.toISOString()):slotTime?localTime(new Date(new Date(scheduleInstant(slotTime)).getTime()+1800000).toISOString()):`${bookingDate}T09:30`);
 const pinnedPatient=mappedPatient?schedulePatients.find(p=>p.id===mappedPatient):null;
 const present=chartContext?html=>{const panel=$('chart-booking-editor');if(!panel||selected!==chartContext.patient_id)return;panel.innerHTML=`<section class="chart-booking-panel" aria-label="Book patient appointment">${html}</section>`;panel.scrollIntoView({block:'start'});panel.querySelector('h2')?.setAttribute('tabindex','-1');panel.querySelector('h2')?.focus({preventScroll:true});}:schedulePanel;
 present(`<h2>${a?'Edit appointment':source?'Reconcile source appointment':'New appointment'}</h2>${source?`<div class="signed-notice"><b>Verify this occurrence before booking</b><p>Source ${esc(source.source_instance)} · ${esc(source.source_id)}</p><p>Source date/time: ${esc(raw.pc_eventDate||data.pc_eventDate)} ${esc(raw.pc_startTime||data.pc_startTime)} · Duration seconds: ${esc(raw.pc_duration||data.pc_duration)}</p><p>Provider ID: ${esc(raw.pc_aid||data.pc_aid)} · Status: ${esc(raw.pc_apptstatus||data.pc_apptstatus)} · Recurrence: ${esc(raw.pc_recurrtype??data.pc_recurrtype??'unknown')}</p><p>The new native status is Booked. Choose the matching provider and verify timezone and occurrence. Past/completed encounters remain preserved in source history.</p></div>`:''}
 <form id="schedule-booking" data-id="${a?.id||''}" data-version="${a?.version||''}" data-request="${crypto.randomUUID()}" data-source="${source?.id||''}" data-chart-patient="${esc(chartContext?.patient_id||'')}" data-chart-visit="${esc(chartContext?.visit_id||'')}">
 ${a?`<input type="hidden" name="patient_id" value="${esc(a.patient_id)}">`:mappedPatient?`<div class="booking-patient-context"><span class="muted">Patient</span><p><b>${esc(pinnedPatient.family_name)}, ${esc(pinnedPatient.given_name)}</b> · MRN ${esc(pinnedPatient.mrn)}</p><input type="hidden" name="patient_id" value="${esc(mappedPatient)}"></div>`:`<label>Find a loaded patient<input type="search" id="schedule-patient-search" placeholder="Name or medical record number"></label><label>Patient<select id="schedule-patient" name="patient_id" required><option value="">Choose a patient</option>${patientOptions()}</select></label>${scheduleCursor?'<button type="button" data-schedule-more>Load more patients</button>':''}`}
 <label>Provider<select name="clinician_id" required><option value="">Choose a provider</option>${scheduleProviders.map(p=>`<option value="${p.id}" ${p.id===(a?.clinician_id||(source?'':chartContext?me.user_id:slotProvider||scheduleProvider||me.user_id))?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label>
 <label>Visit title<input name="title" value="${esc(a?.title||data.title||raw.pc_title||data.pc_title||'Office visit')}" maxlength="200" required></label><label>Category<input name="category" value="${esc(a?.category||'Office visit')}" maxlength="100" required list="appointment-categories"><datalist id="appointment-categories"><option value="Office visit"><option value="New patient"><option value="Follow-up"><option value="Telehealth"><option value="Procedure"></datalist></label>
 <div class="form-grid"><label>Start (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)})<input name="starts_at" type="datetime-local" value="${esc(start)}" required></label><label>End<input name="ends_at" type="datetime-local" value="${esc(end)}" required></label><label>Facility<input name="facility" value="${esc(a?.facility||'')}" maxlength="200"></label><label>Room<input name="room" value="${esc(a?.room||'')}" maxlength="100"></label></div>
 <label>Scheduling notes<textarea name="notes" maxlength="2000">${esc(a?.notes||raw.pc_hometext||data.pc_hometext||'')}</textarea></label><label>Reason for ${a?'change':'booking'}<input name="reason" value="${a?'':source?'Staff reviewed source appointment':'Appointment requested'}" maxlength="1000" required></label>
 ${source?'<label class="scope-options"><input name="source_reviewed" type="checkbox" required> I verified the patient, provider, source status, occurrence and timezone.</label>':''}
 ${!a&&!source?`<fieldset class="recurrence-fields"><legend>Repeat appointment</legend><div class="form-grid"><label>Repeat<select name="repeat_frequency"><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label>Every<input name="repeat_interval" type="number" min="1" max="12" value="1"></label><label>Number of visits<input name="repeat_count" type="number" min="2" max="52" value="4"></label></div><p class="muted">Recurring visits keep the local start time in this browser’s timezone. Monthly visits use the original day, or the last day in shorter months. Review every occurrence before booking. No visits are booked if any occurrence conflicts.</p><div id="series-preview"></div></fieldset>`:''}<p class="muted">Provider, patient, room and blocked-time conflicts are checked before saving. Reminders are configured separately after booking.</p><div class="actions"><button class="primary" type="submit">${a?'Save changes':'Book appointment'}</button><button type="button" ${chartContext?'data-chart-book-close':'data-schedule-close'}>Close</button></div></form>`);

 void attachScheduleLocations();
}
function blockEditor(){
 schedulePanel(`<h2>Block provider time</h2><p class="muted">Use for breaks, leave, or administrative time. Existing appointments must be moved before blocking their time.</p><form id="schedule-block-form" data-request="${crypto.randomUUID()}"><label>Provider<select name="clinician_id" required>${scheduleProviders.map(p=>`<option value="${p.id}" ${p.id===(scheduleProvider||me.user_id)?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label><label>Label<input name="label" required maxlength="200" placeholder="Lunch / administrative time"></label><label>Start<input name="starts_at" type="datetime-local" value="${scheduleDate}T12:00" required></label><label>End<input name="ends_at" type="datetime-local" value="${scheduleDate}T13:00" required></label><div class="actions"><button class="primary" type="submit">Block time</button><button type="button" data-schedule-close>Close</button></div></form>`);
}
document.addEventListener('input',e=>{if(e.target.id==='schedule-patient-search'){const q=e.target.value.toLowerCase();Array.from($('schedule-patient').options).forEach(o=>{o.hidden=!!o.value&&!o.textContent.toLowerCase().includes(q);});}});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||(!b.hasAttribute('data-chart-book')&&!b.hasAttribute('data-chart-book-close')))return;
 e.preventDefault();e.stopImmediatePropagation();
 if(b.hasAttribute('data-chart-book-close')){$('chart-booking-editor')?.replaceChildren();return;}
 run(()=>openPatientAppointmentEditor(b.dataset.chartBook));
},true);
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.type==='submit'||(!b.closest('#schedule-workspace')&&!b.dataset.mapAppointment))return;
 run(async()=>{
 if(b.dataset.mapAppointment){const patient=selected,m=await api(`/api/v1/patients/${patient}/history/${b.dataset.mapAppointment}/appointment-mapping`);await showSchedule();if(m.native_appointment_id)await appointmentDetail(m.native_appointment_id);else await appointmentEditor(null,{...m,patient_id:patient});return;}
 if(b.dataset.scheduleShift){shiftSchedulePeriod(Number(b.dataset.scheduleShift));await showSchedule();return;}
 if(b.dataset.calendarDay){scheduleDate=b.dataset.calendarDay;scheduleMode='day';await showSchedule();return;}
 if(b.dataset.slotBook){if(scheduleDrag){const drag=scheduleDrag;scheduleDrag=undefined;await reviewScheduleMove(drag.id,b.dataset.slotBook,b.dataset.slotProvider,drag.version);return;}scheduleSelected=undefined;await appointmentEditor(null,null,null,b.dataset.slotBook.slice(0,10),b.dataset.slotBook,b.dataset.slotProvider);return;}
 if(b.dataset.calendarBook){scheduleSelected=undefined;await appointmentEditor(null,null,null,b.dataset.calendarBook);return;}
 if(b.hasAttribute('data-schedule-today')){scheduleDate=localTime(new Date().toISOString()).slice(0,10);await showSchedule();return;}
 if(b.hasAttribute('data-new-appointment')){scheduleSelected=undefined;await appointmentEditor();return;}
 if(b.dataset.schedulePickMove){const a=scheduleState.appointments.find(x=>x.id===b.dataset.schedulePickMove);if(!a||!canSchedule()||a.status!=='booked')throw new Error('Reload the booked appointment.');scheduleDrag={id:a.id,version:a.version};closeSchedulePane();notice('Choose the + button in the destination time slot to review this appointment move.');return;}
 if(b.dataset.scheduleEdit){await appointmentEditor(await api(`/api/v1/appointments/${b.dataset.scheduleEdit}`));return;}
 if(b.dataset.scheduleOpen){await appointmentDetail(b.dataset.scheduleOpen);return;}
 if(b.hasAttribute('data-new-block')){scheduleSelected=undefined;blockEditor();return;}
 if(b.hasAttribute('data-schedule-close')){closeSchedulePane();return;}
 if(b.hasAttribute('data-schedule-more')){const page=await api(`/api/v1/patients?after=${encodeURIComponent(scheduleCursor)}`);schedulePatients.push(...page.items);scheduleCursor=page.next_cursor;$('schedule-patient').insertAdjacentHTML('beforeend',page.items.map(p=>`<option value="${p.id}">${esc(p.family_name)}, ${esc(p.given_name)} · ${esc(p.mrn)}</option>`).join(''));if(!scheduleCursor)b.remove();return;}
 if(b.dataset.scheduleChart){await showClinical();await selectPatient(b.dataset.scheduleChart);return;}
 if(b.dataset.scheduleStart){const v=await api('/api/v1/visits','POST',{appointment_id:b.dataset.scheduleStart});await showClinical();await selectPatient(b.dataset.patient,v.id);return;}
 if(b.dataset.scheduleBlock){scheduleSelected=b.dataset.scheduleBlock;const block=scheduleState.blocks.find(x=>x.id===b.dataset.scheduleBlock);schedulePanel(`<h2>${esc(block.label)}</h2><p>${esc(date(block.starts_at))} – ${esc(date(block.ends_at))}</p>${canSchedule()?`<form id="schedule-block-cancel" data-id="${block.id}" data-version="${block.version}"><label>Reason for removing block<input name="reason" required maxlength="1000"></label><button type="submit">Remove time block</button></form>`:''}`);}
 });});
document.addEventListener('submit',e=>{const f=e.target;if(!['schedule-filter','schedule-booking','schedule-action','schedule-block-form','schedule-block-cancel','schedule-move-form'].includes(f.id))return;e.preventDefault();run(async()=>{const d=Object.fromEntries(new FormData(f));delete d.repeat_frequency;delete d.repeat_interval;delete d.repeat_count;
 if(f.id==='schedule-move-form'){
  if(!scheduleMove||scheduleMove.id!==f.dataset.id||scheduleMove.version!==Number(f.dataset.version))throw new Error('Reload the appointment move before saving.');
  const button=f.querySelector('button[type=submit]');button.disabled=true;
  try{const saved=await api(`/api/v1/appointments/${scheduleMove.id}`,'PUT',{...scheduleMove.body,reason:d.reason},scheduleMove.version);scheduleMove=undefined;await showSchedule();await appointmentDetail(saved.id);notice('Appointment rescheduled after server conflict checks.');}
  catch(error){const host=$('schedule-move-error');if(host){host.hidden=false;host.textContent=`Move not saved: ${error.message} Reload the schedule to verify its current state before retrying; a connection failure may occur after a save.`;}else throw error;}finally{button.disabled=false;}return;
 }
 if(f.id==='schedule-filter'){scheduleDate=d.date;scheduleMode=d.view;scheduleProvider=d.provider;await showSchedule();return;}
 if(f.id==='schedule-booking'){if(f.dataset.chartPatient&&selected!==f.dataset.chartPatient)throw new Error('Patient context changed. Open the current patient’s appointment editor before saving.');delete d.source_reviewed;d.starts_at=scheduleInstant(d.starts_at);d.ends_at=scheduleInstant(d.ends_at);let saved;
 if(f.dataset.id){delete d.patient_id;saved=await api(`/api/v1/appointments/${f.dataset.id}`,'PUT',d,Number(f.dataset.version));}else{d.request_id=f.dataset.request;d.source_history_id=f.dataset.source||null;saved=await api('/api/v1/appointments','POST',d);}
 if(f.dataset.chartPatient){if(selected===f.dataset.chartPatient){await selectPatient(f.dataset.chartPatient,f.dataset.chartVisit||undefined);showChartSection('visits');notice('Appointment booked. Review its arrival before starting the encounter.');}return;}
 scheduleDate=localTime(saved.starts_at).slice(0,10);await showSchedule();await appointmentDetail(saved.id);notice(f.dataset.id?'Appointment updated.':'Appointment booked.');return;}
 if(f.id==='schedule-action'){const a=await api(`/api/v1/appointments/${f.dataset.id}/actions`,'POST',d,Number(f.dataset.version));await showSchedule();await appointmentDetail(a.id);notice('Appointment action recorded.');return;}
 if(f.id==='schedule-block-form'){d.request_id=f.dataset.request;d.starts_at=scheduleInstant(d.starts_at);d.ends_at=scheduleInstant(d.ends_at);await api('/api/v1/schedule/blocks','POST',d);await showSchedule();notice('Provider time blocked.');return;}
 if(f.id==='schedule-block-cancel'){await api(`/api/v1/schedule/blocks/${f.dataset.id}/cancel`,'POST',d,Number(f.dataset.version));await showSchedule();notice('Time block removed.');}
 });});

document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('schedule-detail')&&!$('schedule-detail').hidden){e.preventDefault();closeSchedulePane();}});
