// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let scheduleDate=localTime(new Date().toISOString()).slice(0,10), scheduleMode='day', scheduleProvider='', scheduleState, scheduleProviders=[], schedulePatients=[], scheduleCursor, scheduleSelected, schedulePreferenceLoadedFor='', scheduleFilter='all', scheduleZoom='comfortable', scheduleHours=null;
const canSchedule=()=>['owner','clinician','front_desk'].includes(me.role);
const scheduleModes=new Set(['day','week','month','week_grid']);
// The chosen view, provider and row height are remembered on this device for each staff member.
function schedulePreferenceKey(part=''){return `suncharts.schedule.default-view.${me?.tenant_id||'local'}.${me?.user_id||'anonymous'}${part}`;}
function loadSchedulePreference(){const key=schedulePreferenceKey();if(schedulePreferenceLoadedFor===key)return;schedulePreferenceLoadedFor=key;scheduleMode='day';scheduleZoom='comfortable';scheduleFilter='all';try{const saved=localStorage.getItem(key),provider=localStorage.getItem(schedulePreferenceKey('.provider'));if(scheduleModes.has(saved))scheduleMode=saved;if(!scheduleProvider&&/^[0-9a-f-]{36}$/i.test(provider||''))scheduleProvider=provider;if(localStorage.getItem(schedulePreferenceKey('.zoom'))==='compact')scheduleZoom='compact';}catch{}}
function saveSchedulePreference(part='view'){try{if(part==='provider')localStorage.setItem(schedulePreferenceKey('.provider'),scheduleProvider||'');else if(part==='zoom')localStorage.setItem(schedulePreferenceKey('.zoom'),scheduleZoom);else localStorage.setItem(schedulePreferenceKey(),scheduleMode);}catch{}}
function scheduleInstant(value){
 const d=new Date(value);if(!Number.isFinite(d.getTime())||localTime(d.toISOString())!==value)throw new Error('This local time does not exist. Choose another time.');
 for(const delta of [-7200000,-3600000,-1800000,1800000,3600000,7200000])if(localTime(new Date(d.getTime()+delta).toISOString())===value)throw new Error('This local time occurs twice during a clock change. Use the API with an explicit UTC offset or choose another time.');
 return d.toISOString();
}
const scheduleLabel=s=>typeof displayStatus==='function'?displayStatus(s):String(s).replaceAll('_',' ');
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
let scheduleLoadGeneration=0,scheduleMarkersReady=Promise.resolve();
async function showSchedule(options={}){
 loadSchedulePreference();
 scheduleDrag=undefined;scheduleMove=undefined;
 const generation=++scheduleLoadGeneration,bounds=scheduleBounds(),provider=scheduleProvider;
 // Keep each request below the server's 31-day limit, including DST transitions.
 const ranges=[];let cursor=new Date(bounds.start),end=new Date(bounds.end);
 while(cursor<end){const next=new Date(cursor);next.setDate(next.getDate()+21);if(next>end)next.setTime(end.getTime());ranges.push({start:cursor.toISOString(),end:next.toISOString()});cursor=next;}
 const [providers,pages]=await Promise.all([api('/api/v1/schedule/providers'),Promise.all(ranges.map(range=>api(`/api/v1/schedule?${new URLSearchParams({...range,...(provider?{clinician_id:provider}:{})})}`)))]);
 if(generation!==scheduleLoadGeneration)return;
 // A remembered provider who no longer works here must not hide the schedule.
 if(provider&&!providers.items.some(p=>p.id===provider)){scheduleProvider='';saveSchedulePreference('provider');return showSchedule(options);}
 const unique=key=>Array.from(new Map(pages.flatMap(page=>page[key]).map(item=>[item.id,item])).values());
 scheduleProviders=providers.items;scheduleHours=providers.hours||null;scheduleState={appointments:unique('appointments'),blocks:unique('blocks')};if(typeof scheduleLastRefresh!=='undefined')scheduleLastRefresh=Date.now();if(!options.quiet)showTool('Schedule');renderSchedule();
 // Cards are on screen; what each visit still needs is read once for the whole range.
 scheduleMarkersReady=typeof loadScheduleMarkers==='function'?loadScheduleMarkers(ranges,provider,generation):Promise.resolve();
}
let scheduleDrag, scheduleMove;
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
 scheduleDrag={id:a.id,version:a.version,provider:a.clinician_id};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',a.id);
});
const scheduleDropTarget=e=>e.target.closest('[data-drop-time],[data-grid-column]');
document.addEventListener('dragover',e=>{const cell=scheduleDropTarget(e);if(!cell||!scheduleDrag||!canSchedule())return;e.preventDefault();e.dataTransfer.dropEffect='move';});
document.addEventListener('drop',e=>{
 const cell=scheduleDropTarget(e);if(!cell||!scheduleDrag)return;e.preventDefault();const drag=scheduleDrag;scheduleDrag=undefined;
 // A calendar column gives the time from where the card was dropped; the provider stays unless the column names one.
 const time=cell.dataset.dropTime||scheduleGridTimeAt(cell,e.clientY-cell.getBoundingClientRect().top);
 run(()=>reviewScheduleMove(drag.id,time,cell.dataset.dropProvider||cell.dataset.gridProvider||drag.provider,drag.version));
});
document.addEventListener('dragend',()=>{scheduleDrag=undefined;});
let scheduleFocus;
function schedulePanel(content){
 const panel=$('schedule-detail');if(!panel.contains(document.activeElement))scheduleFocus=document.activeElement;
 panel.hidden=false;panel.closest('.schedule-layout').classList.add('has-detail');if(typeof placeSchedulePanel==='function')placeSchedulePanel(panel);
 panel.innerHTML=`<div class="detail-titlebar"><span>APPOINTMENT</span><button type="button" data-schedule-close aria-label="Close appointment details">✕</button></div>${content}`;
 document.querySelectorAll('[data-schedule-id]').forEach(row=>row.classList.toggle('is-selected',row.dataset.scheduleId===scheduleSelected));
 const heading=panel.querySelector('h2,h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}panel.scrollTop=0;
}
function closeSchedulePane(){
 scheduleMove=undefined;
 $('schedule-detail').hidden=true;$('schedule-detail').closest('.schedule-layout').classList.remove('has-detail');
 if(scheduleFocus?.isConnected)scheduleFocus.focus({preventScroll:true});
}
async function appointmentDetail(id){
 const a=await api(`/api/v1/appointments/${id}`);scheduleSelected=id;
 let p=scheduleState.appointments.find(x=>x.id===id);if(!p){const patient=await api(`/api/v1/patients/${a.patient_id}`);p={patient_name:`${patient.family_name}, ${patient.given_name}`};}const h=await api(`/api/v1/appointments/${id}/history`);
 schedulePanel(schedulePanelHtml({...p,...a},p.patient_name,h.items));
 void loadSchedulePanelAllergies(a);
 if(typeof renderAppointmentExtras==='function')await renderAppointmentExtras(a);
}
async function loadSchedulePatients(){const page=await api('/api/v1/patients');schedulePatients=page.items;scheduleCursor=page.next_cursor;}
function patientOptions(id){return schedulePatients.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''}>${esc(p.family_name)}, ${esc(p.given_name)} · ${esc(p.mrn)}</option>`).join('');}
function patientEncounterHistoryEntries(){
 const appointments=workspace?.appointments||[],visits=workspace?.visits||[],byAppointment=new Map(appointments.map(a=>[a.id,a]));
 const linked=new Set(visits.map(v=>v.appointment_id).filter(Boolean));
 const entries=[...visits.map(visit=>({visit,appointment:byAppointment.get(visit.appointment_id)})),...appointments.filter(a=>!linked.has(a.id)).map(appointment=>({appointment}))];
 const timestamp=entry=>Date.parse(entry.appointment?.starts_at||entry.visit?.created_at||entry.visit?.signed_at||'')||0;
 return entries.sort((a,b)=>timestamp(b)-timestamp(a)||String(a.visit?.id||a.appointment.id).localeCompare(String(b.visit?.id||b.appointment.id)));
}
function patientEncounterHistoryRows(limit,compact=false){
 const entries=patientEncounterHistoryEntries(),rows=Number.isInteger(limit)?entries.slice(0,limit):entries;
 return rows.map(({visit:v,appointment:a})=>{
  const providerId=a?.clinician_id||v?.clinician_id,provider=scheduleProviders.find(p=>p.id===providerId)?.label||(providerId===me.user_id?'You':'Assigned clinician');
  const signed=v?.status==='signed',completed=a?.status==='completed',status=v?(signed?(completed?'Completed · Signed':'Signed'):'In progress'):scheduleLabel(a.status);
  const when=a?.starts_at||v?.created_at||v?.signed_at;
  const action=v?`<button type="button" class="quiet" data-visit="${esc(v.id)}">${signed?'Open completed encounter':'Continue encounter'}</button>`:a.status==='booked'&&canSchedule()?`<button type="button" data-check-in="${esc(a.id)}">Check in</button>`:a.status==='checked_in'&&((typeof isRoomingStaff==='function'&&isRoomingStaff())||(['owner','clinician'].includes(me.role)&&a.clinician_id===me.user_id))?`<button type="button" class="primary" data-start="${esc(a.id)}">Start encounter</button>`:'';
  return `<div class="${compact?'chart-history-row':'timeline-row encounter-history-row'}${v?.id===activeVisit?.id?' selected-encounter':''}" ${v?`data-history-visit="${esc(v.id)}"`:`data-history-appointment="${esc(a.id)}"`}><div><strong>${esc(a?.title||'Office visit')}</strong><small>${when?esc(date(when)):'No date'} · ${esc(status)}</small>${compact?'':`<small>${esc(provider)}${a?.category?' · '+esc(a.category):''}${a?.facility?' · '+esc(a.facility):''}${a?.room?' · Room '+esc(a.room):''}</small>${!v&&['completed','in_progress'].includes(a.status)?'<small>No visit note was started for this appointment.</small>':''}${v?.id===activeVisit?.id?'<small>Selected encounter</small>':''}`}</div>${action}</div>`;
 }).join('')||'<p class="muted">No visits or appointments yet.</p>';
}
function patientAppointmentWorkspace(){
 const count=patientEncounterHistoryEntries().length;
 return `<section id="appointments-panel" class="panel patient-appointments patient-encounter-history"><div class="section-head"><div><h2>Encounter history</h2></div>${canSchedule()?`<button type="button" data-chart-book="${esc(selected)}">Book appointment</button>`:''}</div><details id="patient-encounter-history" ${activeVisit?'':'open'}><summary>${activeVisit?'Other visits and appointments':'Visits and appointments'} <span class="pill">${count}</span></summary>${patientEncounterHistoryRows()}</details><div id="chart-booking-editor"></div></section>`;
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
 if(typeof scheduleBoardClick==='function'&&b.closest('#schedule-workspace')&&await scheduleBoardClick(b))return;
 if(b.dataset.mapAppointment){const patient=selected,m=await api(`/api/v1/patients/${patient}/history/${b.dataset.mapAppointment}/appointment-mapping`);await showSchedule();if(m.native_appointment_id)await appointmentDetail(m.native_appointment_id);else await appointmentEditor(null,{...m,patient_id:patient});return;}
 if(b.dataset.scheduleShift){shiftSchedulePeriod(Number(b.dataset.scheduleShift));await showSchedule();return;}
 if(b.dataset.calendarDay){scheduleDate=b.dataset.calendarDay;scheduleMode='day';await showSchedule();return;}
 if(b.dataset.slotBook){if(scheduleDrag){const drag=scheduleDrag;scheduleDrag=undefined;await reviewScheduleMove(drag.id,b.dataset.slotBook,b.dataset.slotProvider,drag.version);return;}scheduleSelected=undefined;await appointmentEditor(null,null,null,b.dataset.slotBook.slice(0,10),b.dataset.slotBook,b.dataset.slotProvider);return;}
 if(b.dataset.calendarBook){scheduleSelected=undefined;await appointmentEditor(null,null,null,b.dataset.calendarBook,undefined,b.dataset.slotProvider||undefined);return;}
 if(b.hasAttribute('data-schedule-today')){scheduleDate=localTime(new Date().toISOString()).slice(0,10);await showSchedule();return;}
 if(b.hasAttribute('data-new-appointment')){scheduleSelected=undefined;await appointmentEditor();return;}
 if(b.dataset.schedulePickMove){const a=scheduleState.appointments.find(x=>x.id===b.dataset.schedulePickMove);if(!a||!canSchedule()||a.status!=='booked')throw new Error('Reload the booked appointment.');scheduleDrag={id:a.id,version:a.version,provider:a.clinician_id};closeSchedulePane();notice('Click the new time on the calendar. You will review the move before it is saved.');return;}
 if(b.dataset.scheduleEdit){await appointmentEditor(await api(`/api/v1/appointments/${b.dataset.scheduleEdit}`));return;}
 if(b.dataset.scheduleOpen){await appointmentDetail(b.dataset.scheduleOpen);return;}
 if(b.hasAttribute('data-new-block')){scheduleSelected=undefined;blockEditor();return;}
 if(b.hasAttribute('data-schedule-close')){closeSchedulePane();return;}
 if(b.hasAttribute('data-schedule-more')){const page=await api(`/api/v1/patients?after=${encodeURIComponent(scheduleCursor)}`);schedulePatients.push(...page.items);scheduleCursor=page.next_cursor;$('schedule-patient').insertAdjacentHTML('beforeend',page.items.map(p=>`<option value="${p.id}">${esc(p.family_name)}, ${esc(p.given_name)} · ${esc(p.mrn)}</option>`).join(''));if(!scheduleCursor)b.remove();return;}
 if(b.dataset.scheduleChart){await showClinical();await selectPatient(b.dataset.scheduleChart);return;}
 if(b.dataset.scheduleStart){const v=await api('/api/v1/visits','POST',{appointment_id:b.dataset.scheduleStart});await showClinical();await selectPatient(b.dataset.patient,v.id);return;}
 if(b.dataset.scheduleBlock){scheduleSelected=b.dataset.scheduleBlock;const block=scheduleState.blocks.find(x=>x.id===b.dataset.scheduleBlock);schedulePanel(`<h2>${esc(block.label)}</h2><p>${esc(date(block.starts_at))} – ${esc(date(block.ends_at))}</p>${canSchedule()?`<form id="schedule-block-cancel" data-id="${block.id}" data-version="${block.version}"><label>Reason for removing block<input name="reason" required maxlength="1000"></label><button type="submit">Remove time block</button></form>`:''}`);}
 });});
document.addEventListener('change',e=>{const f=e.target.closest?.('#schedule-filter');if(!f||!['date','view','provider'].includes(e.target.name))return;const d=Object.fromEntries(new FormData(f));if(!d.date||!scheduleModes.has(d.view))return;scheduleDate=d.date;scheduleMode=d.view;scheduleProvider=d.provider||'';if(e.target.name==='provider')saveSchedulePreference('provider');run(()=>showSchedule());});
document.addEventListener('submit',e=>{const f=e.target;if(!['schedule-filter','schedule-booking','schedule-action','schedule-block-form','schedule-block-cancel','schedule-move-form'].includes(f.id))return;e.preventDefault();run(async()=>{const d=Object.fromEntries(new FormData(f));delete d.repeat_frequency;delete d.repeat_interval;delete d.repeat_count;
 if(f.id==='schedule-move-form'){
  if(!scheduleMove||scheduleMove.id!==f.dataset.id||scheduleMove.version!==Number(f.dataset.version))throw new Error('Reload the appointment move before saving.');
  const button=f.querySelector('button[type=submit]');button.disabled=true;
  try{const saved=await api(`/api/v1/appointments/${scheduleMove.id}`,'PUT',{...scheduleMove.body,reason:d.reason},scheduleMove.version);scheduleMove=undefined;await showSchedule();await appointmentDetail(saved.id);notice('Appointment rescheduled after server conflict checks.');}
  catch(error){const host=$('schedule-move-error');if(host){host.hidden=false;host.textContent=`Move not saved: ${error.message} Reload the schedule to verify its current state before retrying; a connection failure may occur after a save.`;}else throw error;}finally{button.disabled=false;}return;
 }
 if(f.id==='schedule-filter'){scheduleDate=d.date;scheduleProvider=d.provider||'';await showSchedule();return;}
 if(f.id==='schedule-booking'){if(f.dataset.chartPatient&&selected!==f.dataset.chartPatient)throw new Error('Patient context changed. Open the current patient’s appointment editor before saving.');delete d.source_reviewed;d.starts_at=scheduleInstant(d.starts_at);d.ends_at=scheduleInstant(d.ends_at);let saved;
 if(f.dataset.id){delete d.patient_id;saved=await api(`/api/v1/appointments/${f.dataset.id}`,'PUT',d,Number(f.dataset.version));}else{d.request_id=f.dataset.request;d.source_history_id=f.dataset.source||null;saved=await api('/api/v1/appointments','POST',d);}
 if(f.dataset.chartPatient){if(selected===f.dataset.chartPatient){await selectPatient(f.dataset.chartPatient,f.dataset.chartVisit||undefined);showChartSection('visits');notice('Appointment booked. Review its arrival before starting the encounter.');}return;}
 scheduleDate=localTime(saved.starts_at).slice(0,10);await showSchedule();await appointmentDetail(saved.id);notice(f.dataset.id?'Appointment updated.':'Appointment booked.');return;}
 if(f.id==='schedule-action'){const a=await api(`/api/v1/appointments/${f.dataset.id}/actions`,'POST',d,Number(f.dataset.version));await showSchedule();await appointmentDetail(a.id);notice('Appointment action recorded.');return;}
 if(f.id==='schedule-block-form'){d.request_id=f.dataset.request;d.starts_at=scheduleInstant(d.starts_at);d.ends_at=scheduleInstant(d.ends_at);await api('/api/v1/schedule/blocks','POST',d);await showSchedule();notice('Provider time blocked.');return;}
 if(f.id==='schedule-block-cancel'){await api(`/api/v1/schedule/blocks/${f.dataset.id}/cancel`,'POST',d,Number(f.dataset.version));await showSchedule();notice('Time block removed.');}
 });});

document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('schedule-detail')&&!$('schedule-detail').hidden){e.preventDefault();closeSchedulePane();}});
