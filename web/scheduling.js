// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let scheduleDate=localTime(new Date().toISOString()).slice(0,10), scheduleMode='month', scheduleProvider='', scheduleState, scheduleProviders=[], schedulePatients=[], scheduleCursor, scheduleSelected, schedulePreferenceLoadedFor=null, schedulePreferenceIdentity=null, scheduleFilter='all', scheduleZoom='comfortable', scheduleHours=null;
const canSchedule=()=>['owner','clinician','front_desk'].includes(me.role);
// Today as a local calendar day. The board and the booking editor both need it.
function scheduleToday(){return localTime(new Date().toISOString()).slice(0,10);}
const scheduleModes=new Set(['day','week','month','week_grid']);
const scheduleStatusFilters=new Set(['all','scheduled','in_office','finished','checked_in','in_progress','forms_review','insurance_unchecked','claim_not_sent','claim_rejected','active']);
// Remember unchecked choices across ranges and show providers and locations that appear later.
let scheduleSavedView='month',scheduleSavedFilter='all',scheduleHiddenProviders=new Set(),scheduleHiddenLocations=new Set(),scheduleUnfiltered=false;
// Keep the existing per-practice, per-user keys so earlier explicit choices still work.
function schedulePreferenceKey(part=''){
 return me?.tenant_id&&me?.user_id?`suncharts.schedule.default-view.${me.tenant_id}.${me.user_id}${part}`:null;
}
function readSchedulePreference(part){
 const key=schedulePreferenceKey(part);
 try{return key?localStorage.getItem(key):null;}catch{return null;}
}
function readScheduleExclusions(part){
 try{
  const values=JSON.parse(readSchedulePreference(part));
  return new Set(Array.isArray(values)?values.filter(value=>typeof value==='string'&&value.length>0):[]);
 }catch{return new Set();}
}
function loadSchedulePreference(){
 const key=schedulePreferenceKey();
 if(schedulePreferenceLoadedFor===key&&schedulePreferenceIdentity===me)return;
 schedulePreferenceLoadedFor=key;schedulePreferenceIdentity=me;
 const chosen=readSchedulePreference('.chosen-view');
 const saved=scheduleModes.has(chosen)?chosen:readSchedulePreference('');
 scheduleSavedView=scheduleModes.has(saved)?saved:'month';
 scheduleMode=scheduleSavedView;
 const provider=readSchedulePreference('.provider');
 scheduleProvider=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(provider||'')?provider:'';
 scheduleHiddenProviders=readScheduleExclusions('.hidden-providers');
 scheduleHiddenLocations=readScheduleExclusions('.hidden-locations');
 scheduleUnfiltered=false;
 scheduleZoom=readSchedulePreference('.zoom')==='compact'?'compact':'comfortable';
 const filter=readSchedulePreference('.status-filter');
 scheduleSavedFilter=scheduleStatusFilters.has(filter)?filter:'all';
 scheduleFilter=scheduleSavedFilter;
}
function saveSchedulePreference(part='view'){
 const key=schedulePreferenceKey();
 if(schedulePreferenceIdentity!==me||schedulePreferenceLoadedFor!==key)return;
 if(part==='view')scheduleSavedView=scheduleMode;
 if(part==='status')scheduleSavedFilter=scheduleFilter;
 const settings={
  view:['.chosen-view',scheduleSavedView],
  provider:['.provider',scheduleProvider],
  zoom:['.zoom',scheduleZoom],
  status:['.status-filter',scheduleSavedFilter],
  providers:['.hidden-providers',JSON.stringify([...scheduleHiddenProviders])],
  locations:['.hidden-locations',JSON.stringify([...scheduleHiddenLocations])]
 };
 const setting=settings[part];
 if(!key||!setting)return;
 try{localStorage.setItem(key+setting[0],setting[1]);}catch{}
}
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
let scheduleLoadGeneration=0,scheduleMarkersReady=Promise.resolve(),scheduleBookingPatientPicker=null;
function clearScheduleSession(){
 scheduleLoadGeneration++;
 scheduleMarkersReady=Promise.resolve();
 schedulePreferenceLoadedFor=null;
 schedulePreferenceIdentity=null;
 scheduleDate=scheduleToday();
 scheduleMode=scheduleSavedView='month';
 scheduleFilter=scheduleSavedFilter='all';
 scheduleProvider='';scheduleZoom='comfortable';scheduleUnfiltered=false;
 scheduleHiddenProviders.clear();scheduleHiddenLocations.clear();
 scheduleState=undefined;scheduleProviders=[];schedulePatients=[];scheduleHours=null;
 scheduleCursor=undefined;scheduleSelected=undefined;scheduleDrag=undefined;scheduleMove=undefined;scheduleFocus=undefined;
 scheduleBookingPatientPicker=null;
 if(typeof clearScheduleBoardSession==='function')clearScheduleBoardSession();
}
async function showSchedule(options={}){
 const identity=me,identityKey=schedulePreferenceKey();
 const entering=!$('schedule-workspace')||$('tools')?.hidden||$('page-title')?.textContent!=='Schedule'||schedulePreferenceLoadedFor!==identityKey||schedulePreferenceIdentity!==identity;
 loadSchedulePreference();
 if(entering||options.entry){
  scheduleDate=scheduleToday();scheduleMode=scheduleSavedView;scheduleUnfiltered=false;scheduleFilter=scheduleSavedFilter;scheduleSelected=undefined;scheduleScrollMemory.clear();scheduleScrollSession++;
 }
 if(options.date)scheduleDate=options.date;
 if(scheduleModes.has(options.view))scheduleMode=options.view;
 if(options.unfiltered){scheduleUnfiltered=true;scheduleFilter='all';}
 scheduleDrag=undefined;scheduleMove=undefined;
 const generation=++scheduleLoadGeneration,bounds=scheduleBounds(),provider=scheduleUnfiltered?'':scheduleProvider;
 // Keep each request below the server's 31-day limit, including DST transitions.
 const ranges=[];let cursor=new Date(bounds.start),end=new Date(bounds.end);
 while(cursor<end){const next=new Date(cursor);next.setDate(next.getDate()+21);if(next>end)next.setTime(end.getTime());ranges.push({start:cursor.toISOString(),end:next.toISOString()});cursor=next;}
 const [providers,pages]=await Promise.all([api('/api/v1/schedule/providers'),Promise.all(ranges.map(range=>api(`/api/v1/schedule?${new URLSearchParams({...range,...(provider?{clinician_id:provider}:{})})}`)))]);
 if(generation!==scheduleLoadGeneration||me!==identity||schedulePreferenceKey()!==identityKey)return;
 // A remembered provider who no longer works here must not hide the schedule.
 if(provider&&!providers.items.some(p=>p.id===provider)){scheduleProvider='';saveSchedulePreference('provider');return showSchedule(options);}
 const unique=key=>Array.from(new Map(pages.flatMap(page=>page[key]).map(item=>[item.id,item])).values());
 scheduleProviders=providers.items;scheduleHours=providers.hours||null;scheduleState={appointments:unique('appointments'),blocks:unique('blocks')};if(typeof scheduleLastRefresh!=='undefined')scheduleLastRefresh=Date.now();if(!options.quiet)showTool('Schedule');renderSchedule();
 // Cards are on screen; what each encounter still needs is read once for the whole range.
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
 if(!time)return;
 run(()=>reviewScheduleMove(drag.id,time,cell.dataset.dropProvider||cell.dataset.gridProvider||drag.provider,drag.version));
});
document.addEventListener('dragend',()=>{scheduleDrag=undefined;});
let scheduleFocus;
function schedulePanel(content,chartPatient=null){
 let panel=$('schedule-detail');
 if(chartPatient&&!panel){
  panel=document.createElement('section');panel.id='schedule-detail';panel.className='schedule-detail';
  panel.dataset.chartTemporary='';$('chart').append(panel);
 }
 if(!panel)return;
 if(!panel.contains(document.activeElement))scheduleFocus=document.activeElement;
 panel.classList.toggle('is-editor',/id="schedule-(booking|block-form|move-form)"/.test(content));
 panel.hidden=false;
 panel.innerHTML=`<div class="detail-titlebar"><span>APPOINTMENT</span><button type="button" data-schedule-close aria-label="Close appointment details">✕</button></div>${content}`;
 if(chartPatient){
  panel.dataset.chartPatient=chartPatient;chartOpenEditor('schedule-detail','Appointment');
  panel.closest('dialog')?.addEventListener('close',()=>{delete panel.dataset.chartPatient;if(panel.hasAttribute('data-chart-temporary'))panel.remove();else panel.hidden=true;},{once:true});
 }else{panel.closest('.schedule-layout')?.classList.add('has-detail');if(typeof placeSchedulePanel==='function')placeSchedulePanel(panel);}
 document.querySelectorAll('[data-schedule-id]').forEach(row=>row.classList.toggle('is-selected',row.dataset.scheduleId===scheduleSelected));
 const heading=panel.querySelector('h2,h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}panel.scrollTop=0;
}
function closeSchedulePane(){
 scheduleMove=undefined;
 const dialog=$('schedule-detail').closest?.('dialog');if(dialog){scheduleSelected=undefined;sheetClose(dialog);return;}
 $('schedule-detail').hidden=true;$('schedule-detail').closest('.schedule-layout').classList.remove('has-detail');
 if(scheduleFocus?.isConnected)scheduleFocus.focus({preventScroll:true});
}
async function appointmentDetail(id,chartPatient=null,stillCurrent=()=>true){
 const identity=me,section=chartPatient?chartSection:null;
 scheduleSelected=id;
 const current=()=>scheduleSelected===id&&me===identity&&stillCurrent()&&(!chartPatient||(selected===chartPatient&&chartSection===section&&!$('clinical-workspace')?.hidden));
 const a=await api(`/api/v1/appointments/${id}`);if(!current())return;if(chartPatient&&a.patient_id!==chartPatient)throw new Error('This appointment does not belong to this chart.');
 let p=scheduleState?.appointments?.find(x=>x.id===id);if(!p){const patient=chartPatient?workspace.patient:await api(`/api/v1/patients/${a.patient_id}`);p={patient_name:`${patient.family_name}, ${patient.given_name}`};}const h=await api(`/api/v1/appointments/${id}/history`);
 if(!current())return;
 if(!a.phone){const demographics=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/demographics`);if(!current()||me!==identity)return;a.phone=demographics.content?.phone||'';const cached=schedulePatients.find(p=>p.id===a.patient_id);if(cached)cached.demographics=demographics;}
 if(chartPatient){
  const range=new URLSearchParams({from:a.starts_at,to:a.ends_at,provider:a.clinician_id});
  let item;
  try{
   const page=await api('/api/v1/schedule/markers?'+range);
   item=page.items.find(row=>row.appointment_id===id&&row.patient_id===chartPatient);
  }catch{/* Appointment status stays available if its insurance and payment facts cannot be read. */}
  if(!current())return;
  scheduleChartMarker={appointment:id,patient:chartPatient,identity,item};
 }
 schedulePanel(schedulePanelHtml({...p,...a},p.patient_name,h.items,{inChart:!!chartPatient}),chartPatient);
 void loadSchedulePanelAllergies(a);
 if(typeof loadScheduleCopayCards==='function'&&typeof scheduleMarkersReady!=='undefined')void scheduleMarkersReady.then(()=>loadScheduleCopayCards(a));
 if(typeof renderAppointmentExtras==='function')await renderAppointmentExtras(a);
}
async function loadSchedulePatients(){const page=await api('/api/v1/patients');schedulePatients=page.items;scheduleCursor=page.next_cursor;}
function patientEncounterHistoryEntries(){
 const appointments=workspace?.appointments||[],visits=workspace?.visits||[],byAppointment=new Map(appointments.map(a=>[a.id,a]));
 const linked=new Set(visits.map(v=>v.appointment_id).filter(Boolean));
 const entries=[...visits.map(visit=>({visit,appointment:byAppointment.get(visit.appointment_id)})),...appointments.filter(a=>!linked.has(a.id)).map(appointment=>({appointment}))];
 const timestamp=entry=>Date.parse(entry.appointment?.starts_at||entry.visit?.created_at||entry.visit?.signed_at||'')||0;
 return entries.sort((a,b)=>timestamp(b)-timestamp(a)||String(a.visit?.id||a.appointment.id).localeCompare(String(b.visit?.id||b.appointment.id)));
}
// What each encounter in the list is about at a glance: diagnoses and procedures from its charges,
// then its money and claim state from the server (one request per patient, filled in when it lands).
let encounterBalanceCache={patient:null,items:null,loading:null};
function encounterHistoryAccount(visit){return (workspace?.billing?.accounts||[]).find(a=>a.status!=='void'&&a.content?.visit_id===visit.id)||null;}
function encounterHistoryDetails(visit){
 const account=encounterHistoryAccount(visit);
 if(!account)return '<small class="encounter-history-codes muted">No charges yet</small>';
 const lines=account.content?.lines||[];
 const procedures=lines.map(l=>esc(l.code)+(String(l.modifiers||'').trim()?'-'+esc(String(l.modifiers).trim().replace(/\s+/g,'-')):'')).join(', ');
 const diagnoses=[...new Set(lines.flatMap(l=>l.diagnosis_codes||[]))].map(esc).join(', ');
 return `<small class="encounter-history-codes">${procedures?'Procedures '+procedures:'No procedures'}${diagnoses?' · Diagnoses '+diagnoses:''}</small><small class="encounter-history-money" data-encounter-money="${esc(account.id)}">${account.status==='posted'?'Charges '+money(Number(account.total_cents||0)):'Charges not posted yet · '+money(Number(account.total_cents||0))}</small>`;
}
function encounterClaimWords(row){
 if(row.denied===true)return 'Claim denied';
 return ({draft:'Claim not sent',ready:'Claim ready to send',submitted:'Claim sent',accepted:'Claim accepted by the payer',adjudicated:'Insurance answered',rejected:'Claim rejected',paid:'Insurance paid'})[row.claim_status]||'';
}
function encounterMoneyWords(row){
 const parts=['Charges '+money(Number(row.total_cents||0))];
 if(!row.posted)return 'Charges not posted yet · '+money(Number(row.total_cents||0));
 if(Number(row.insurer_paid_cents)>0)parts.push('Insurance paid '+money(Number(row.insurer_paid_cents)));
 if(Number(row.pending_cents)>0)parts.push('Insurance pending '+money(Number(row.pending_cents)));
 if(Number(row.patient_payments_cents)>0)parts.push('Patient paid '+money(Number(row.patient_payments_cents)));
 parts.push(Number(row.owes_now_cents)>0?'Patient owes '+money(Number(row.owes_now_cents)):Number(row.overpaid_cents)>0?'Credit '+money(Number(row.overpaid_cents)):'Patient owes nothing');
 const claim=encounterClaimWords(row);if(claim)parts.push(claim);
 return parts.join(' · ');
}
async function fillEncounterHistoryMoney(){
 const patient=selected,identity=me;if(!patient||!document.querySelector?.('[data-encounter-money]'))return;
 if(encounterBalanceCache.patient!==patient||!encounterBalanceCache.items){
  if(encounterBalanceCache.patient!==patient||!encounterBalanceCache.loading){encounterBalanceCache={patient,items:null,loading:api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/encounters`).then(r=>r.items||[]).catch(()=>null)};}
  const items=await encounterBalanceCache.loading;if(encounterBalanceCache.patient!==patient||selected!==patient||me!==identity)return;encounterBalanceCache.items=items;
 }
 const items=encounterBalanceCache.items;if(!items||selected!==patient||me!==identity)return;
 for(const node of document.querySelectorAll('[data-encounter-money]')){const row=items.find(r=>r.account_id===node.dataset.encounterMoney);if(row)node.textContent=encounterMoneyWords(row);}
}
function patientEncounterHistoryRows(limit,compact=false){
 const entries=patientEncounterHistoryEntries(),rows=Number.isInteger(limit)?entries.slice(0,limit):entries;
 return rows.map(({visit:v,appointment:a})=>{
  const providerId=a?.clinician_id||v?.clinician_id,provider=encounterListProviderName(providerId,v?encounterHistoryAccount(v):null);
  const signed=v?.status==='signed',completed=a?.status==='completed',status=v?(signed?(completed?'Completed · Signed':'Signed'):'In progress'):scheduleLabel(a.status);
  const when=a?.starts_at||v?.created_at||v?.signed_at;
  const action=v?`<button type="button" class="quiet" data-visit="${esc(v.id)}">${compact?(signed?'Open':'Continue'):signed?'Open completed encounter':'Continue encounter'}</button>`:a.status==='booked'&&canSchedule()?`<button type="button" data-check-in="${esc(a.id)}">Check in</button>`:a.status==='checked_in'&&((typeof isRoomingStaff==='function'&&isRoomingStaff())||(['owner','clinician'].includes(me.role)&&a.clinician_id===me.user_id))?`<button type="button" class="primary" data-start="${esc(a.id)}">Start encounter</button>`:'';
  return `<div class="${compact?'chart-history-row':'timeline-row encounter-history-row'}${v?.id===activeVisit?.id?' selected-encounter':''}" ${v?`data-history-visit="${esc(v.id)}"`:`data-history-appointment="${esc(a.id)}"`}><div><strong>${v&&typeof encounterNumberText==='function'&&encounterNumberText(v)?esc(encounterNumberText(v))+' · ':''}${esc(a?.title||'Office encounter')}</strong><small>${when?esc(date(when)):'No date'} · ${esc(status)}</small>${compact?'':`<small>${esc(provider)}${a?.category?' · '+esc(a.category):''}${a?.facility?' · '+esc(a.facility):''}${a?.room?' · Room '+esc(a.room):''}</small>${!v&&['completed','in_progress'].includes(a.status)?'<small>No visit note was started for this appointment.</small>':''}${v?encounterHistoryDetails(v):''}${v?.id===activeVisit?.id?'<small>Selected encounter</small>':''}`}</div>${action}</div>`;
 }).join('')||'<p class="muted">No visits or appointments yet.</p>';
}
// Keep filtering on the mounted rows so changing a filter preserves the page and focus.
function filterPatientEncounters(){
 const panel=$('appointments-panel');if(!panel)return;
 const filter=panel.querySelector('[data-encounter-filter][aria-pressed="true"]')?.dataset.encounterFilter||'all';
 for(const group of panel.querySelectorAll('[data-encounter-group]')){
  let count=0;
  for(const row of group.querySelectorAll('[data-encounter-row]')){
   const show=filter==='all'||filter==='open'&&row.dataset.open==='true'||filter==='unsigned'&&row.dataset.unsigned==='true'||filter==='claims'&&row.dataset.claimNotSent==='true';
   row.hidden=!show;if(show)count++;
  }
  const empty=group.querySelector('[data-encounter-empty]');empty.hidden=count>0;
  if(!count)empty.textContent=filter==='all'?(panel.querySelector('[data-encounter-row]')?'No past encounters recorded.':'No encounters recorded.'):'No encounters match this filter.';
 }
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-encounter-filter]');if(!button)return;
 for(const chip of button.closest('.encounter-filter-chips').querySelectorAll('button'))chip.setAttribute('aria-pressed',String(chip===button));
 filterPatientEncounters();
});
function encounterListProviderName(id,account){
 const provider=scheduleProviders.find(p=>p.id===id||p.user_id===id);
 const staff=typeof practiceAdminState!=='undefined'?practiceAdminState?.staff?.items?.find(p=>p.id===id||p.user_id===id):null;
 const name=person=>person?.label||person?.display_name||person?.name||[person?.given_name,person?.family_name].filter(Boolean).join(' ');
 return name(provider)||name(staff)||(id&&id===me.user_id?name(me):'')||account?.content?.claim_details?.rendering_provider_name||'—';
}
function encounterListCharges(account,balance){
 if(!account)return 'No charges yet';
 return `${money(Number(balance?.total_cents??account.total_cents??0))}${balance?`<small>${Number(balance.overpaid_cents)>0?'Credit '+money(Number(balance.overpaid_cents)):'Patient owes '+money(Number(balance.owes_now_cents||0))}</small>`:''}`;
}
function encounterListPill(words,tone='pending'){
 const colors={done:'#e9f4ee;color:#2e6b4c',pending:'#fff4d6;color:#775513',error:'#fce9e7;color:#923c32',neutral:'#edf2f6;color:#546979'};
 return `<span class="pill" style="background:${colors[tone]||colors.neutral}">${esc(words)}</span>`;
}
function encounterListClaim(row,account){
 const status=row?.claim_status;
 if(!account&&!status)return encounterListPill('Not sent','neutral');
 return encounterListPill(status||row?.denied?encounterClaimWords(row)||displayStatus(status):'Not sent',row?.denied||['rejected'].includes(status)?'error':['accepted','adjudicated','paid','submitted'].includes(status)?'done':account?'pending':'neutral');
}
function encounterListNotSent(row){return !!row&&!row.denied&&(!row.claim_status||['draft','ready'].includes(row.claim_status));}
async function fillChartEncounterClaims(){
 const patient=selected,identity=me,panel=$('appointments-panel');if(!patient||!panel)return;
 // This also hydrates the restored detailed money lines, sharing the patient request.
 await fillEncounterHistoryMoney();
 if(selected!==patient||me!==identity||$('appointments-panel')!==panel)return;
 for(const node of panel.querySelectorAll('[data-encounter-charge-summary]')){
  const account=workspace.billing?.accounts?.find(a=>a.id===node.dataset.encounterChargeSummary);
  const row=encounterBalanceCache.patient===patient?encounterBalanceCache.items?.find(r=>r.account_id===account?.id):null;
  if(account)node.innerHTML=encounterListCharges(account,row);
 }
 for(const node of panel.querySelectorAll('[data-chart-encounter-claim]')){
  const row=encounterBalanceCache.patient===patient?encounterBalanceCache.items?.find(r=>r.account_id===node.dataset.chartEncounterClaim):null;
  if(row){node.innerHTML=encounterListClaim(row,true);node.closest('[data-encounter-row]').dataset.claimNotSent=String(encounterListNotSent(row));}
 }
 const providers=Array.from(panel.querySelectorAll('[data-encounter-provider]'));
 if(providers.length&&typeof workspaceResourceAllowed==='function'&&workspaceResourceAllowed('scheduling')){
  try{
   const directory=await api('/api/v1/schedule/providers');
   if(selected!==patient||me!==identity||$('appointments-panel')!==panel)return;
   for(const node of providers){
    const id=node.dataset.encounterProvider,provider=directory.items?.find(row=>row.id===id||row.user_id===id);
    if(provider?.label)node.textContent=provider.label;
   }
  }catch{}
 }
 if(typeof loadVisitNotePeople==='function')await Promise.all(Array.from(panel.querySelectorAll('[data-encounter-visit]'),async row=>{
  const visit=workspace.visits.find(v=>v.id===row.dataset.encounterVisit);
  const provider=row.querySelector('[data-encounter-provider]'),signer=row.querySelector('[data-encounter-signer]');
  if(!visit||(!signer&&provider?.textContent!=='—'))return;
  await loadVisitNotePeople(visit);
  if(selected!==patient||me!==identity||$('appointments-panel')!==panel)return;
  if(provider?.textContent==='—'){const name=visitNotePerson(visit,provider.dataset.encounterProvider);if(name)provider.textContent=name;}
  if(signer){const name=visitNotePerson(visit,visit.signed_by);if(name)signer.textContent='Signed by '+name;}
 }));
 if(selected!==patient||me!==identity||$('appointments-panel')!==panel)return;
 filterPatientEncounters();
}
function patientAppointmentWorkspace(){
 const entries=patientEncounterHistoryEntries(),now=Date.now();
 const upcoming=entry=>!entry.visit&&['booked','checked_in'].includes(entry.appointment?.status)&&Date.parse(entry.appointment.starts_at)>now;
 if(typeof setTimeout==='function')setTimeout(()=>{void fillChartEncounterClaims();},0);
 const renderRow=({visit:v,appointment:a})=>{
  const providerId=a?.clinician_id||v?.clinician_id,account=v?encounterHistoryAccount(v):null;
  const provider=encounterListProviderName(providerId,account);
  const balance=account&&encounterBalanceCache.patient===selected?encounterBalanceCache.items?.find(r=>r.account_id===account.id):null;
  const signed=v?.status==='signed',signer=signed&&(typeof visitNotePerson==='function'?visitNotePerson(v,v.signed_by):'')||scheduleProviders.find(p=>p.id===v?.signed_by)?.label;
  const when=a?.starts_at||v?.created_at||v?.signed_at,instant=when?new Date(when):null;
  const day=instant&&Number.isFinite(instant.getTime())?instant.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'No date recorded';
  const type=a?.title||a?.category||'Office visit';
  const details=[a?.category?.trim().toLowerCase()!==type.trim().toLowerCase()?a?.category:'',a?.facility,a?.room?'Room '+a.room:''].filter(Boolean).map(esc).join(' · ');
  const diagnoses=[...new Set((account?.content?.lines||[]).flatMap(l=>l.diagnosis_codes||[]))].map(esc).join(', ');
  const open=v?!signed:['booked','checked_in','in_progress'].includes(a?.status);
  const actions=v?`<button type="button" data-visit="${esc(v.id)}">${signed?'Open':'Continue'}</button>`:`<button type="button" data-chart-appointment="${esc(a.id)}">Open</button>${a.status==='booked'&&canSchedule()?` <button type="button" data-check-in="${esc(a.id)}">Check in</button>`:a.status==='checked_in'&&((typeof isRoomingStaff==='function'&&isRoomingStaff())||(['owner','clinician'].includes(me.role)&&a.clinician_id===me.user_id))?` <button type="button" data-start="${esc(a.id)}">Start encounter</button>`:''}`;
  const cells=[`${esc(v&&typeof encounterNumberText==='function'?encounterNumberText(v)||'—':'—')}${v&&v.id===activeVisit?.id?'<br><small class="selected-encounter">Selected encounter</small>':''}`,esc(day)+(instant&&Number.isFinite(instant.getTime())?' · '+esc(instant.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})):''),`${esc(type)}${details?'<br><small>'+details+'</small>':''}<br>${encounterListPill(signed?'Completed':v?'In progress':scheduleLabel(a?.status||'booked'),'neutral')}<br><small class="muted"${signed?` data-encounter-signer="${esc(v.id)}"`:''}>${esc(signed?signer?'Signed by '+signer:'Signed':v?'Note in progress':'Note not started')}</small>`,esc(provider),diagnoses||'—',`<div class="encounter-charge-summary"${account?` data-encounter-charge-summary="${esc(account.id)}"`:''}>${encounterListCharges(account,balance)}</div>`,`<span data-chart-encounter-claim="${esc(account?.id||'')}">${encounterListClaim(balance,account)}</span>`,actions+(v?`<details class="encounter-row-details"><summary>Details</summary>${encounterHistoryDetails(v)}</details>`:'')];
  return `<tr data-encounter-row${v?` data-encounter-visit="${esc(v.id)}"`:''} data-open="${open}" data-unsigned="${!!v&&!signed}" data-claim-not-sent="${encounterListNotSent(balance)}">${cells.map((c,i)=>`<td${i===0?' class="encounter-number" style="white-space:nowrap"':i===1?' class="encounter-date"':i===3&&providerId&&provider==='—'?` data-encounter-provider="${esc(providerId)}"`:''}>${c}</td>`).join('')}</tr>`;
 };
 const table=(title,rows)=>`<section data-encounter-group><h3>${esc(title)}</h3><div class="chart-list-table"><table><thead><tr>${['ENC number','Date','Type / status','Provider','Diagnoses','Charges','Claim','Action'].map(c=>`<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>${rows.map(renderRow).join('')}</tbody></table></div><p class="muted" data-encounter-empty${rows.length?' hidden':''}>${entries.length?'No encounters match this filter.':'No encounters recorded.'}</p></section>`;
 const future=entries.filter(upcoming),history=entries.filter(entry=>!upcoming(entry));
 return `<section id="appointments-panel" class="panel patient-appointments">${chartListHeader('Encounters',typeof canStartEncounterFlow==='function'&&canStartEncounterFlow()?'<button type="button" class="primary" data-start-encounter-flow="new">+ New encounter</button>':'',canSchedule()?`<button type="button" data-chart-book="${esc(selected)}">Book appointment</button>`:'').replace('</h2>',`</h2><span class="pill" aria-label="Encounter count">${entries.length}</span><div class="encounter-filter-chips" role="group" aria-label="Encounter status">${[['all','All'],['open','Open'],['unsigned','Unsigned'],['claims','Claims not sent']].map(([key,label])=>`<button type="button" data-encounter-filter="${key}" aria-pressed="${key==='all'}">${label}</button>`).join('')}</div>`).replace('<h2 tabindex="-1">','<div class="encounter-list-heading"><h2 tabindex="-1">').replace('<div class="actions">','</div><div class="actions">')}${future.length?table('Upcoming',future):''}${table('Encounter history',history)}<div id="chart-booking-editor"></div></section>`;
}

async function openPatientAppointmentEditor(patientId){
 if(!canSchedule()||selected!==patientId)throw new Error('Open the patient chart before booking an appointment.');
 const visitId=activeVisit?.id||'',identity=me;
 const providers=await api('/api/v1/schedule/providers');
 if(selected!==patientId||me!==identity||(activeVisit?.id||'')!==visitId)return;
 scheduleProviders=providers.items;
 // Pin the patient from the chart, including patients outside the directory page.
 schedulePatients=[workspace.patient];scheduleCursor=undefined;
 await appointmentEditor(null,null,{patient_id:patientId,visit_id:visitId,origin_section:chartSection});
}
function scheduleSoleFacility(directory){
 return !directory.has_more&&directory.items?.length===1?directory.items[0].name:'';
}
async function attachScheduleLocations(){
 const form=$('schedule-booking'),facility=form?.querySelector?.('[name="facility"]'),room=form?.querySelector?.('[name="room"]');
 if(!facility||!room)return;
 const actor=me?.user_id;
 const hint=document.createElement('p');hint.className='muted';hint.setAttribute('role','status');hint.textContent='Loading practice location choices…';form.appendChild(hint);
 try{
  const directory=await api('/api/v1/schedule/locations');
  if($('schedule-booking')!==form||actor!==me?.user_id)return;
  // Facility and room are picked from the practice's own list, never typed: free text breaks room
  // conflict checks, reports and automation. A location already on the appointment stays selectable.
  const toSelect=(input,label)=>{const select=document.createElement('select');select.name=input.name;select.id=input.id||'';select.required=input.required;select.dataset.current=input.value||'';select.setAttribute('aria-label',label);input.replaceWith(select);return select;};
  const fill=(select,names,emptyLabel)=>{const current=select.dataset.current;const list=[...new Set(names)];
   const options=[`<option value="">${esc(emptyLabel)}</option>`,...(current&&!list.includes(current)?[`<option value="${esc(current)}">${esc(current)} (current)</option>`]:[]),...list.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`)];
   select.innerHTML=options.join('');select.value=current&&[...select.options].some(o=>o.value===current)?current:'';};
  const facilitySelect=toSelect(facility,'Facility'),roomSelect=toSelect(room,'Room');
  if(!form.dataset.id&&!facilitySelect.dataset.current)facilitySelect.dataset.current=scheduleSoleFacility(directory);
  fill(facilitySelect,directory.items.map(f=>f.name),directory.items.length?'Choose a facility':'No facilities set up yet');
  const updateRooms=()=>{const rooms=directory.items.find(f=>f.name===facilitySelect.value)?.rooms||[];roomSelect.dataset.current=roomSelect.value||roomSelect.dataset.current;fill(roomSelect,rooms.map(r=>r.name),!facilitySelect.value?'Choose a facility first':rooms.length?'No room':'No rooms set up for this facility');roomSelect.disabled=!facilitySelect.value&&!roomSelect.dataset.current;};
  facilitySelect.addEventListener('change',()=>{roomSelect.dataset.current='';roomSelect.value='';updateRooms();});updateRooms();
  hint.textContent=directory.items.length?'':'Add facilities and rooms in Practice administration.';hint.hidden=!!directory.items.length;
 }catch{if($('schedule-booking')===form&&actor===me?.user_id)hint.textContent='Facilities and rooms could not load. Refresh to choose a room.';}
}
async function appointmentEditor(a,sourceMapping,chartContext,bookingDate=scheduleDate,slotTime,slotProvider){
 if(!a&&!chartContext)await loadSchedulePatients();
 if(typeof payerPickerMarkup==='function'){const payers=await api('/api/v1/billing/payers');billingPayers=payers.items;}
 const identity=me;
 let types=[],catalogUnavailable=false;
 try{types=await scheduleVisitTypes();}catch{catalogUnavailable=true;}
 if(me!==identity)return;
 const source=sourceMapping?.source;const raw=source?.source_data||{};const data=source?.data||{};
 const mappedPatient=sourceMapping?.patient_id||chartContext?.patient_id;
 if(mappedPatient&&!schedulePatients.some(p=>p.id===mappedPatient)){const p=await api(`/api/v1/patients/${mappedPatient}`);schedulePatients.unshift(p);}
 const proposedStart=data.starts_at&&/([zZ]|[+-]\d\d:\d\d)$/.test(data.starts_at)?localTime(data.starts_at):'';
 const proposedEnd=data.ends_at&&/([zZ]|[+-]\d\d:\d\d)$/.test(data.ends_at)?localTime(data.ends_at):'';
 const nextStart=new Date();nextStart.setMinutes(nextStart.getMinutes()+30-nextStart.getMinutes()%30,0,0);const nextEnd=new Date(nextStart.getTime()+30*60000);
 const nowDay=scheduleToday(),quickBook=!a&&!source&&!slotTime&&bookingDate===nowDay;
 const start=a?localTime(a.starts_at):proposedStart||(source?'':chartContext||quickBook?localTime(nextStart.toISOString()):(slotTime||`${bookingDate}T09:00`)),end=a?localTime(a.ends_at):proposedEnd||(source?'':chartContext||quickBook?localTime(nextEnd.toISOString()):slotTime?localTime(new Date(new Date(scheduleInstant(slotTime)).getTime()+1800000).toISOString()):`${bookingDate}T09:30`);
 const pinnedPatient=mappedPatient?schedulePatients.find(p=>p.id===mappedPatient):null;
 const present=chartContext?html=>{const panel=$('chart-booking-editor');if(!panel||selected!==chartContext.patient_id||(activeVisit?.id||'')!==(chartContext.visit_id||''))return;panel.innerHTML=`<section class="chart-booking-panel" aria-label="Book patient appointment">${html}</section>`;chartOpenEditor('chart-booking-editor','Book appointment');panel.querySelector('h2')?.setAttribute('tabindex','-1');panel.querySelector('h2')?.focus({preventScroll:true});}:schedulePanel;
 const patientPickerId=mappedPatient||a?.patient_id||'';
 present(`<h2>${a?'Edit appointment':source?'Reconcile source appointment':'New appointment'}</h2>${source?`<div class="signed-notice"><b>Verify this occurrence before booking</b><p>Source ${esc(source.source_instance)} · ${esc(source.source_id)}</p><p>Source date/time: ${esc(raw.pc_eventDate||data.pc_eventDate)} ${esc(raw.pc_startTime||data.pc_startTime)} · Duration seconds: ${esc(raw.pc_duration||data.pc_duration)}</p><p>Provider ID: ${esc(raw.pc_aid||data.pc_aid)} · Status: ${esc(raw.pc_apptstatus||data.pc_apptstatus)} · Recurrence: ${esc(raw.pc_recurrtype??data.pc_recurrtype??'unknown')}</p><p>The new native status is Booked. Choose the matching provider and verify timezone and occurrence. Past/completed visits remain preserved in source history.</p></div>`:''}
 <form id="schedule-booking" data-existing-type="${esc(a?.visit_type?.id||'')}" data-original-minutes="${a?(Date.parse(a.ends_at)-Date.parse(a.starts_at))/60000:''}" data-original-title="${esc(a?.title||'')}" data-original-category="${esc(a?.category||'')}" data-patient-picker="${esc(patientPickerId)}" data-id="${a?.id||''}" data-version="${a?.version||''}" data-request="${crypto.randomUUID()}" data-source="${source?.id||''}" data-chart-patient="${esc(chartContext?.patient_id||'')}" data-chart-visit="${esc(chartContext?.visit_id||'')}" data-chart-origin="${esc(chartContext?.origin_section||'')}">
  ${a?`<input type="hidden" name="patient_id" value="${esc(a.patient_id)}">`:mappedPatient?patientPickerPinnedMarkup({patient:pinnedPatient}):`${patientPickerMarkup({label:'Patient',name:'patient_id',required:true,oncreate:scheduleNewPatient,onchoose:()=>scheduleCancelNewPatient()})}${scheduleCursor?'<button type="button" class="quiet" data-schedule-more>Load more patients</button>':''}`}
 <fieldset data-booking-new-patient hidden disabled><legend>New patient</legend><div class="form-grid"><label>First name<input name="new_given_name" required maxlength="100" autocomplete="given-name"></label><label>Last name<input name="new_family_name" required maxlength="100" autocomplete="family-name"></label><label>Date of birth<input name="new_birth_date" type="date" required autocomplete="bday"></label><label>Mobile phone<input name="new_phone" type="tel" required maxlength="40" autocomplete="tel"></label><label>Sex (optional)<select name="new_sex"><option value="">Not recorded</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="unknown">Unknown</option></select></label></div><fieldset><legend>Insurance (optional)</legend><div class="form-grid">${typeof payerPickerMarkup==='function'?payerPickerMarkup('new_insurance','Insurer',{required:false}):''}<label>Member ID<input name="new_member_id" maxlength="150"></label></div><p class="muted">Leave empty for self-pay.</p></fieldset><button type="button" data-booking-existing>Choose an existing patient</button></fieldset>
 <label>Provider<select name="clinician_id" required><option value="">Choose a provider</option>${scheduleProviders.map(p=>`<option value="${p.id}" ${p.id===(a?.clinician_id||(source?'':chartContext?(activeVisit?.clinician_id||me.user_id):slotProvider||scheduleProvider||me.user_id))?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label>
 <label>Visit type<select data-booking-type>${scheduleTypeOptions(types,a?.visit_type)}</select></label>${catalogUnavailable?'<p class="muted" role="status">Visit types could not load. You can enter a title and times below.</p>':''}
 <label>Encounter title<input name="title" value="${esc(a?.title||data.title||raw.pc_title||data.pc_title||'Office encounter')}" maxlength="200" required></label><label>Category<input name="category" value="${esc(a?.category||'Office encounter')}" maxlength="100" required list="appointment-categories"><datalist id="appointment-categories"><option value="Office visit"><option value="New patient"><option value="Follow-up"><option value="Telehealth"><option value="Procedure"></datalist></label>
 <div class="form-grid"><label>Start (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)})<input name="starts_at" type="datetime-local" value="${esc(start)}" required></label><label>End<input name="ends_at" type="datetime-local" value="${esc(end)}" required></label><label>Facility<input name="facility" value="${esc(a?.facility||'')}" maxlength="200"></label><label>Room<input name="room" value="${esc(a?.room||'')}" maxlength="100"></label></div>
 <label>Scheduling notes<textarea name="notes" maxlength="2000">${esc(a?.notes||raw.pc_hometext||data.pc_hometext||'')}</textarea></label><label>Reason for ${a?'change':'booking'}<input name="reason" value="${a?'':source?'Staff reviewed source appointment':'Appointment requested'}" maxlength="1000" required></label>
 ${source?'<label class="scope-options"><input name="source_reviewed" type="checkbox" required> I verified the patient, provider, source status, occurrence and timezone.</label>':''}
 ${!a&&!source?`<fieldset class="recurrence-fields"><legend>Repeat appointment</legend><div class="form-grid"><label>Repeat<select name="repeat_frequency"><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label>Every<input name="repeat_interval" type="number" min="1" max="12" value="1"></label><label>Number of visits<input name="repeat_count" type="number" min="2" max="52" value="4"></label></div><p class="muted">Recurring visits keep the local start time in this browser’s timezone. Monthly visits use the original day, or the last day in shorter months. Review every occurrence before booking. No visits are booked if any occurrence conflicts.</p><div id="series-preview"></div></fieldset>`:''}<p class="muted">Provider, patient, room and blocked-time conflicts are checked before saving. Reminders are configured separately after booking.</p><div class="actions"><button class="primary" type="submit">${a?'Save changes':'Book appointment'}</button><button type="button" ${chartContext?'data-chart-book-close':'data-schedule-close'}>Close</button></div></form>`);

 mountScheduleBookingPatientPicker();
 if(typeof typeaheadInit==='function')typeaheadInit($('schedule-booking'));
 const bookingForm=$('schedule-booking');
 if(bookingForm)bookingForm.locationReady=attachScheduleLocations();
}
// The booking form's patient box is live: it searches as staff type and holds the chosen
// patient. Opening it again with a patient already in mind fills that person straight in.
function mountScheduleBookingPatientPicker(){
  const form=$('schedule-booking');scheduleBookingPatientPicker=null;if(!form)return;
  const picker=mountPatientPicker(form);if(!picker)return;
  scheduleBookingPatientPicker=picker;
  const patient=schedulePatients.find(p=>p.id===form.dataset.patientPicker);
  if(patient)patientPickerChoose(picker,patient);
}
function blockEditor(){
 schedulePanel(`<h2>Block provider time</h2><p class="muted">Use for breaks, leave, or administrative time. Existing appointments must be moved before blocking their time.</p><form id="schedule-block-form" data-request="${crypto.randomUUID()}"><label>Provider<select name="clinician_id" required>${scheduleProviders.map(p=>`<option value="${p.id}" ${p.id===(scheduleProvider||me.user_id)?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label><label>Label<input name="label" required maxlength="200" placeholder="Lunch / administrative time"></label><label>Start<input name="starts_at" type="datetime-local" value="${scheduleDate}T12:00" required></label><label>End<input name="ends_at" type="datetime-local" value="${scheduleDate}T13:00" required></label><label>Repeat<select name="repeat"><option value="none">Does not repeat</option><option value="daily">Every day</option><option value="weekdays">Every weekday (Mon to Fri)</option><option value="weekly">Every week</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Every month on this date</option></select></label><div class="block-repeat" data-block-repeat hidden><fieldset class="block-weekdays" data-block-weekdays hidden><legend>On</legend>${blockWeekdayNames.map((name,day)=>`<label><input type="checkbox" name="weekday" value="${day}"> ${name}</label>`).join('')}</fieldset><label>Until<input name="until" type="date"></label><p class="muted" data-block-repeat-summary role="status"></p></div><div class="block-conflicts" data-block-conflicts hidden></div><div class="actions"><button class="primary" type="submit">Block time</button><button type="button" data-schedule-close>Close</button></div></form>`);
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||(!b.hasAttribute('data-chart-book')&&!b.hasAttribute('data-chart-book-close')))return;
 e.preventDefault();e.stopImmediatePropagation();
 if(b.hasAttribute('data-chart-book-close')){const host=$('chart-booking-editor'),dialog=host?.closest?.('dialog');host?.replaceChildren();if(dialog)sheetClose(dialog);return;}
 run(()=>openPatientAppointmentEditor(b.dataset.chartBook));
},true);
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.type==='submit'||(!b.closest('#schedule-workspace,#schedule-detail[data-chart-patient]')&&!b.dataset.mapAppointment))return;
 run(async()=>{
 const chartPatient=b.closest('#schedule-detail')?.dataset.chartPatient,chartVisit=chartPatient?activeVisit?.id:null;
 if(typeof scheduleBoardClick==='function'&&(chartPatient||b.closest('#schedule-workspace'))&&await scheduleBoardClick(b))return;
 if(b.dataset.mapAppointment){const patient=selected,m=await api(`/api/v1/patients/${patient}/history/${b.dataset.mapAppointment}/appointment-mapping`);await showSchedule();if(m.native_appointment_id)await appointmentDetail(m.native_appointment_id);else await appointmentEditor(null,{...m,patient_id:patient});return;}
 if(b.dataset.scheduleShift){shiftSchedulePeriod(Number(b.dataset.scheduleShift));await showSchedule();return;}
 if(b.dataset.calendarDay){scheduleDate=b.dataset.calendarDay;scheduleMode='day';await showSchedule();return;}
 if(b.dataset.slotBook){if(scheduleDrag){const drag=scheduleDrag;scheduleDrag=undefined;await reviewScheduleMove(drag.id,b.dataset.slotBook,b.dataset.slotProvider,drag.version);return;}scheduleSelected=undefined;await appointmentEditor(null,null,null,b.dataset.slotBook.slice(0,10),b.dataset.slotBook,b.dataset.slotProvider);return;}
 if(b.dataset.calendarBook){scheduleSelected=undefined;await appointmentEditor(null,null,null,b.dataset.calendarBook,undefined,b.dataset.slotProvider||undefined);return;}
 if(b.hasAttribute('data-schedule-today')){scheduleDate=localTime(new Date().toISOString()).slice(0,10);await showSchedule();return;}
 if(b.hasAttribute('data-new-appointment')){scheduleSelected=undefined;await appointmentEditor();return;}
 if(b.dataset.schedulePickMove){const a=scheduleState.appointments.find(x=>x.id===b.dataset.schedulePickMove);if(!a||!canSchedule()||a.status!=='booked')throw new Error('Reload the booked appointment.');scheduleDrag={id:a.id,version:a.version,provider:a.clinician_id};closeSchedulePane();notice('Click the new time on the calendar. You will review the move before it is saved.');return;}
 if(b.dataset.scheduleEdit){
  const appointment=await api(`/api/v1/appointments/${b.dataset.scheduleEdit}`);
  if(!chartPatient){await appointmentEditor(appointment);return;}
  if(selected!==chartPatient||appointment.patient_id!==chartPatient)return;
  const providers=await api('/api/v1/schedule/providers');
  if(selected!==chartPatient||!b.isConnected)return;
  scheduleProviders=providers.items;closeSchedulePane();
  await appointmentEditor(appointment,null,{patient_id:chartPatient,visit_id:chartVisit||''});return;
 }
 if(b.dataset.scheduleOpen){await appointmentDetail(b.dataset.scheduleOpen);return;}
 if(b.hasAttribute('data-new-block')){scheduleSelected=undefined;blockEditor();return;}
 if(b.hasAttribute('data-schedule-close')){closeSchedulePane();return;}
  if(b.hasAttribute('data-schedule-more')){const page=await api(`/api/v1/patients?after=${encodeURIComponent(scheduleCursor)}`);schedulePatients.push(...page.items);scheduleCursor=page.next_cursor;if(!scheduleCursor)b.remove();return;}
 if(b.dataset.scheduleChart){await selectPatient(b.dataset.scheduleChart);return;}
 if(b.dataset.scheduleStart){
  const a=scheduleState?.appointments.find(row=>row.id===b.dataset.scheduleStart&&row.patient_id===b.dataset.patient);
  if(!a)throw new Error('Reopen this appointment on the schedule.');
  await scheduleStartAppointment(a);return;
 }
 if(b.dataset.scheduleBlock){scheduleSelected=b.dataset.scheduleBlock;const block=scheduleState.blocks.find(x=>x.id===b.dataset.scheduleBlock);schedulePanel(`<h2>${esc(block.label)}</h2><p>${esc(date(block.starts_at))} – ${esc(date(block.ends_at))}</p>${canSchedule()?`${block.series_id?'<p class="muted">Part of a repeating block.</p>':''}<form id="schedule-block-cancel" data-id="${block.id}" data-version="${block.version}" data-series="${esc(block.series_id||'')}" data-starts="${esc(block.starts_at)}"><label>Reason for removing block<input name="reason" required maxlength="1000"></label><div class="actions"><button type="submit">${block.series_id?'Remove only this one':'Remove time block'}</button>${block.series_id?'<button type="submit" data-block-series="following">Remove this and all later ones</button><button type="submit" data-block-series="all">Remove every one</button>':''}</div></form>`:''}`);}
 });});
document.addEventListener('change',e=>{
 const target=e.target;
 if(target.dataset?.scheduleProvider){
  if(scheduleProvider){
   scheduleHiddenProviders=new Set(scheduleRailProviders().filter(p=>p.id!==scheduleProvider).map(p=>p.id));
  }
  if(target.checked)scheduleHiddenProviders.delete(target.dataset.scheduleProvider);else scheduleHiddenProviders.add(target.dataset.scheduleProvider);
  const restricted=!!scheduleProvider&&!scheduleUnfiltered;
  if(scheduleUnfiltered)scheduleFilter=scheduleSavedFilter;
  scheduleUnfiltered=false;
  saveSchedulePreference('providers');
  if(scheduleProvider){scheduleProvider='';saveSchedulePreference('provider');}
  if(restricted)run(()=>showSchedule());else repaintSchedule();return;
 }
 if(target.dataset?.scheduleLocation){
  if(target.checked)scheduleHiddenLocations.delete(target.dataset.scheduleLocation);else scheduleHiddenLocations.add(target.dataset.scheduleLocation);
  const restricted=!!scheduleProvider&&scheduleUnfiltered;
  if(scheduleUnfiltered)scheduleFilter=scheduleSavedFilter;
  scheduleUnfiltered=false;
  saveSchedulePreference('locations');
  if(restricted)run(()=>showSchedule());else repaintSchedule();return;
 }
 if(target.dataset?.scheduleStatus){const action=target.value;target.value='';if(action==='check-in')run(()=>scheduleBoardClick({dataset:{boardAction:'check-in',appointment:target.dataset.scheduleStatus}}));else if(action){const details=document.querySelector('.appt-panel-cancel');if(details){details.open=true;details.querySelector('select').value=action;details.querySelector('input')?.focus();}}return;}
 const f=e.target.closest?.('#schedule-filter');if(!f||!['date','view','provider'].includes(e.target.name))return;const d=Object.fromEntries(new FormData(f));if(!d.date||!scheduleModes.has(d.view))return;scheduleDate=d.date;scheduleMode=d.view;scheduleProvider=d.provider||'';if(e.target.name==='provider')saveSchedulePreference('provider');if(e.target.name==='view')saveSchedulePreference('view');run(()=>showSchedule());});
document.addEventListener('submit',e=>{const f=e.target;if(!['schedule-filter','schedule-booking','schedule-action','schedule-block-form','schedule-block-cancel','schedule-move-form'].includes(f.id))return;e.preventDefault();run(async()=>{
 if(f.id==='schedule-booking'&&f.locationReady){
  await f.locationReady;
  if($('schedule-booking')!==f)return;
 }
 const d=Object.fromEntries(new FormData(f));delete d.repeat_frequency;delete d.repeat_interval;delete d.repeat_count;
 if(f.id==='schedule-move-form'){
  if(!scheduleMove||scheduleMove.id!==f.dataset.id||scheduleMove.version!==Number(f.dataset.version))throw new Error('Reload the appointment move before saving.');
  const button=f.querySelector('button[type=submit]');button.disabled=true;
  try{const saved=await api(`/api/v1/appointments/${scheduleMove.id}`,'PUT',{...scheduleMove.body,reason:d.reason},scheduleMove.version);scheduleMove=undefined;await showSchedule();await appointmentDetail(saved.id);notice('Appointment rescheduled after server conflict checks.');}
  catch(error){const host=$('schedule-move-error');if(host){host.hidden=false;host.textContent=`Move not saved: ${error.message} Reload the schedule to verify its current state before retrying; a connection failure may occur after a save.`;}else throw error;}finally{button.disabled=false;}return;
 }
 if(f.id==='schedule-filter'){scheduleDate=d.date;scheduleProvider=d.provider||'';await showSchedule();return;}
 if(f.id==='schedule-booking'){if(f.dataset.chartPatient&&selected!==f.dataset.chartPatient)throw new Error('Patient context changed. Open the current patient’s appointment editor before saving.');delete d.source_reviewed;d.starts_at=scheduleInstant(d.starts_at);d.ends_at=scheduleInstant(d.ends_at);let saved;
 const submit=f.querySelector('button[type=submit]');if(f.dataset.saving==='1')return;f.dataset.saving='1';if(submit)submit.disabled=true;
 try{Object.assign(d,scheduleBookingTypeSelection(f));await scheduleCreateBookingPatient(f,d);
 if(f.dataset.id){delete d.patient_id;saved=await api(`/api/v1/appointments/${f.dataset.id}`,'PUT',d,Number(f.dataset.version));}else{d.request_id=f.dataset.request;d.source_history_id=f.dataset.source||null;saved=await api('/api/v1/appointments','POST',d);}
 if(f.dataset.chartPatient){
  const patient=f.dataset.chartPatient,visit=f.dataset.chartVisit||'',section=f.dataset.chartOrigin||'visits';
  if(selected===patient&&(activeVisit?.id||'')===visit){
   await selectPatient(patient,visit||null);
   if(selected===patient&&(activeVisit?.id||'')===visit){
    showChartSection(section);
    notice(f.dataset.id?'Appointment updated.':'Appointment booked.');
   }
  }
  return;
 }
 scheduleDate=localTime(saved.starts_at).slice(0,10);await showSchedule();await appointmentDetail(saved.id);notice(f.dataset.id?'Appointment updated.':'Appointment booked.');return;}finally{delete f.dataset.saving;if(submit)submit.disabled=false;}}
 if(f.id==='schedule-action'){
  const patient=f.closest('#schedule-detail')?.dataset.chartPatient;
  const view=scheduleAppointmentView({id:f.dataset.id,patient_id:patient},patient);
  if(!view.atPanel())return;
  const saved=await api(`/api/v1/appointments/${f.dataset.id}/actions`,'POST',d,Number(f.dataset.version));
  if(await view.refresh(saved))notice('Appointment action recorded.');
  return;
 }
 if(f.id==='schedule-block-form'){
  if(d.repeat&&d.repeat!=='none'){await blockRepeatSave(f,e.submitter?.hasAttribute?.('data-block-skip'));return;}
  await api('/api/v1/schedule/blocks','POST',{request_id:f.dataset.request,clinician_id:d.clinician_id,label:d.label,starts_at:scheduleInstant(d.starts_at),ends_at:scheduleInstant(d.ends_at)});await showSchedule();notice('Provider time blocked.');return;}
 if(f.id==='schedule-block-cancel'&&e.submitter?.dataset?.blockSeries){const from=e.submitter.dataset.blockSeries==='following'?f.dataset.starts:null,data=await api(`/api/v1/schedule/block-series/${f.dataset.series}/cancel`,'POST',{reason:d.reason,from});await showSchedule();notice(`Removed ${data.cancelled} time block${data.cancelled===1?'':'s'}.`);return;}
 if(f.id==='schedule-block-cancel'){await api(`/api/v1/schedule/blocks/${f.dataset.id}/cancel`,'POST',d,Number(f.dataset.version));await showSchedule();notice('Time block removed.');}
 });});

document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('schedule-detail')&&!$('schedule-detail').hidden){e.preventDefault();closeSchedulePane();}});

// Sync to my calendar. Each person gets a private link that their own Google or Microsoft 365
// calendar subscribes to. It shows when they are busy in the practice schedule: the times only,
// never who the appointment is with or what it is for.
function calendarSyncLinks(path){
 const web=`${location.origin}${path}`,cal=web.replace(/^https?:/,'webcal:');
 return {web,google:`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(cal)}`,microsoft:`https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(web)}&name=${encodeURIComponent('SunCharts schedule')}`,outlook:`https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(web)}&name=${encodeURIComponent('SunCharts schedule')}`,apple:cal};
}
function calendarSyncMarkup(state,path){
 const privacy='<p class="muted">Only the times are shared. Your calendar shows “Busy: appointment” or “Busy: blocked time” and nothing else: no patient, no reason, no room.</p>';
 if(path){
  const links=calendarSyncLinks(path);
  return `<p><b>Your calendar link is ready.</b> Add it to the calendar you use:</p><div class="calendar-sync-actions"><a href="${esc(links.google)}" target="_blank" rel="noopener noreferrer">Add to Google Calendar</a><a href="${esc(links.microsoft)}" target="_blank" rel="noopener noreferrer">Add to Microsoft 365 (work or school)</a><a href="${esc(links.outlook)}" target="_blank" rel="noopener noreferrer">Add to Outlook.com (personal)</a><a href="${esc(links.apple)}">Add to Apple Calendar</a></div><p class="muted">Apple Calendar opens on this device and asks to subscribe. On an iPhone, open this page on the phone, or copy the link below.</p><label>Or copy the link into any other calendar that can subscribe to one<input type="text" readonly data-calendar-link value="${esc(links.web)}"></label><div class="actions"><button type="button" data-calendar-copy>Copy link</button></div>${privacy}<p class="muted">Keep this link to yourself: anyone who has it can see when you are busy. It is shown only this once. If you lose it, make a new one and the old one stops.</p><p class="muted">Google and Microsoft check the link on their own timetable. A new appointment usually shows within a few hours in Microsoft 365, and can take up to a day in Google Calendar.</p><p class="muted" data-calendar-status role="status"></p>`;
 }
 if(state.allowed===false&&!path)return `<p><b>Calendar links are turned off for this practice.</b> ${state.active?'Your link is paused and works again if the practice owner turns them back on.':'The practice owner can turn them on in Practice administration.'}</p><p class="muted" data-calendar-status role="status"></p>`;
 if(state.active){
  return `<p><b>Your calendar link is on.</b> ${state.last_read_at?`Your calendar last checked it ${esc(date(state.last_read_at))}.`:'No calendar has checked it yet.'}</p>${privacy}<div class="actions"><button type="button" class="primary" data-calendar-make>Make a new link</button><button type="button" data-calendar-off>Turn off</button></div><p class="muted">Making a new link stops the old one, so you would add the new one to your calendar again.</p><p class="muted" data-calendar-status role="status"></p>`;
 }
 return `<p>See your busy times from this schedule in your own Google, Microsoft or Apple calendar.</p>${privacy}<div class="actions"><button type="button" class="primary" data-calendar-make>Turn on</button></div><p class="muted" data-calendar-status role="status"></p>`;
}
async function calendarSyncSheet(){
 const state=await api('/api/v1/schedule/calendar-link'),panel=document.createElement('div');panel.className='calendar-sync-sheet';
 panel.innerHTML=calendarSyncMarkup(state,null);
 const dialog=sheetOpen('Sync to my calendar',panel);
 if(me?.role==='owner'){const manage=document.createElement('p');manage.className='calendar-sync-manage';manage.innerHTML='<button type="button" class="text-button" data-calendar-links-admin>See everyone’s calendar links</button>';panel.after(manage);manage.addEventListener('click',()=>sheetClose(dialog));}
 panel.addEventListener('click',event=>{
  const button=event.target.closest?.('button');if(!button)return;
  const status=()=>panel.querySelector('[data-calendar-status]');
  if(button.hasAttribute('data-calendar-make'))run(async()=>{const made=await api('/api/v1/schedule/calendar-link','POST',{});panel.innerHTML=calendarSyncMarkup(made,made.path);});
  else if(button.hasAttribute('data-calendar-off'))run(async()=>{const off=await api('/api/v1/schedule/calendar-link','DELETE');panel.innerHTML=calendarSyncMarkup(off,null);status().textContent='Turned off. The old link no longer works.';});
  else if(button.hasAttribute('data-calendar-copy')){const field=panel.querySelector('[data-calendar-link]');field.select();(navigator.clipboard?.writeText?navigator.clipboard.writeText(field.value):Promise.reject()).then(()=>{status().textContent='Link copied.';},()=>{status().textContent='Select the link and copy it.';});}
 });
}
document.addEventListener('click',event=>{const button=event.target?.closest?.('[data-calendar-sync]');if(!button?.hasAttribute?.('data-calendar-sync'))return;event.preventDefault();run(calendarSyncSheet);},true);

// The owner's view of calendar links: the practice switch, who has a link on, and a way to turn
// one off. The links themselves are never shown here.
function calendarLinksAdminMarkup(data){
 const rows=(data.items||[]).map(item=>`<tr><td>${esc(item.name)}</td><td>${esc(date(item.created_at))}</td><td>${item.last_read_at?esc(date(item.last_read_at)):'Not read yet'}</td><td><button type="button" data-calendar-admin-off="${esc(item.user_id)}" data-name="${esc(item.name)}">Turn off</button></td></tr>`).join('');
 return `<p>Staff can show their own busy times in their personal calendar. Only times are shared: no patient, reason or room.</p><label class="calendar-links-switch"><input type="checkbox" data-calendar-admin-switch ${data.enabled?'checked':''}> Allow calendar links in this practice</label><p class="muted">${data.enabled?'Turning this off stops every link at once and nobody can make a new one.':'Links are off. Existing links are paused and work again if you turn this back on.'}</p>${rows?`<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Person</th><th>Turned on</th><th>Last read by their calendar</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted">Turning off one person’s link stops it at once. They can make a new one while links are allowed.</p>`:'<p class="muted">Nobody has a calendar link on.</p>'}<p class="muted" data-calendar-status role="status"></p>`;
}
async function calendarLinksAdminSheet(){
 const panel=document.createElement('div');panel.className='calendar-sync-sheet calendar-links-admin';
 const paint=async message=>{panel.innerHTML='<p class="frame-admin-breadcrumb" aria-label="Breadcrumb">Admin / Practice / Calendar links</p>'+calendarLinksAdminMarkup(await api('/api/v1/practice/calendar-links'));if(message)panel.querySelector('[data-calendar-status]').textContent=message;};
 await paint();const dialog=sheetOpen('Calendar links',panel);
 // A way back to the person's own link, so the two sheets lead to each other.
 const back=document.createElement('p');back.className='calendar-sync-manage';back.innerHTML='<button type="button" class="text-button" data-calendar-back>← Back to my calendar link</button>';panel.before(back);
 back.addEventListener('click',()=>{sheetClose(dialog);run(calendarSyncSheet);});
 panel.addEventListener('change',event=>{const box=event.target;if(!box?.hasAttribute?.('data-calendar-admin-switch'))return;const on=box.checked;run(async()=>{await api('/api/v1/practice/calendar-links','PUT',{enabled:on});await paint(on?'Calendar links are allowed.':'Calendar links are off. Every link has stopped.');});});
 panel.addEventListener('click',event=>{const button=event.target.closest?.('[data-calendar-admin-off]');if(!button)return;run(async()=>{await api(`/api/v1/practice/calendar-links/${button.dataset.calendarAdminOff}`,'DELETE');await paint(`Turned off the calendar link for ${button.dataset.name}.`);});});
}
document.addEventListener('click',event=>{const button=event.target?.closest?.('[data-calendar-links-admin]');if(!button?.hasAttribute?.('data-calendar-links-admin'))return;event.preventDefault();run(calendarLinksAdminSheet);},true);

// Repeating block time. Staff choose how it repeats and the last day; the dates are worked out
// here in local time, so "noon every weekday" stays at noon across a clock change. Every date
// becomes an ordinary block, so one can be removed alone later.
const blockWeekdayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function blockRepeatPlan(d,weekdays){
 const [startDay,startTime]=String(d.starts_at||'').split('T'),[endDay,endTime]=String(d.ends_at||'').split('T');
 if(!startDay||!startTime||!endDay||!endTime)throw new Error('Choose the start and end first.');
 if(!d.until)throw new Error('Choose the last day this repeats.');
 const day=86400000,parse=text=>{const [y,m,n]=text.split('-').map(Number);return new Date(Date.UTC(y,m-1,n));},text=t=>t.toISOString().slice(0,10);
 const first=parse(startDay),span=Math.round((parse(endDay)-first)/day),last=parse(d.until);
 if(!(last>first))throw new Error('The last day must be after the first block.');
 if(last-first>366*day)throw new Error('A repeating block can run for up to a year. Choose an earlier last day.');
 const on=new Set(weekdays.length?weekdays:[first.getUTCDay()]),dates=[];
 for(let t=first,i=0;t<=last;t=new Date(t.getTime()+day),i++){
  const weekday=t.getUTCDay(),week=Math.floor((i+first.getUTCDay())/7);
  const wanted=d.repeat==='daily'||(d.repeat==='weekdays'&&weekday>=1&&weekday<=5)||(d.repeat==='weekly'&&on.has(weekday))||(d.repeat==='biweekly'&&on.has(weekday)&&week%2===0)||(d.repeat==='monthly'&&t.getUTCDate()===first.getUTCDate());
  if(wanted)dates.push({starts:`${text(t)}T${startTime}`,ends:`${text(new Date(t.getTime()+span*day))}T${endTime}`});
 }
 const pretty=new Date(`${d.until}T12:00`).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
 const days=[...on].sort().map(n=>blockWeekdayNames[n]).join(', ');
 const words={daily:'Every day',weekdays:'Every weekday',weekly:`Every week on ${days}`,biweekly:`Every 2 weeks on ${days}`,monthly:`Every month on day ${first.getUTCDate()}`}[d.repeat];
 return {dates,repeat:`${words} until ${pretty}`};
}
function blockRepeatRead(form){const d=Object.fromEntries(new FormData(form));return [d,[...form.querySelectorAll('[name="weekday"]')].filter(box=>box.checked).map(box=>Number(box.value))];}
function blockRepeatPaint(form){
 const [d,weekdays]=blockRepeatRead(form),box=form.querySelector('[data-block-repeat]'),days=form.querySelector('[data-block-weekdays]'),summary=form.querySelector('[data-block-repeat-summary]');
 const repeating=d.repeat&&d.repeat!=='none';box.hidden=!repeating;days.hidden=!['weekly','biweekly'].includes(d.repeat);
 form.querySelector('[name="until"]').required=!!repeating;
 const conflicts=form.querySelector('[data-block-conflicts]');if(conflicts){conflicts.hidden=true;conflicts.replaceChildren();}
 if(!repeating){summary.textContent='';return;}
 if(!days.hidden&&!weekdays.length&&d.starts_at){const start=new Date(d.starts_at);if(Number.isFinite(start.getTime())){const own=form.querySelector(`[name="weekday"][value="${start.getDay()}"]`);if(own)own.checked=true;}}
 if(!d.until){summary.textContent='Choose the last day this repeats.';return;}
 try{const plan=blockRepeatPlan(...blockRepeatRead(form));summary.textContent=plan.dates.length<2?'That makes fewer than two blocks. Choose a later last day.':plan.dates.length>260?'That is more than 260 blocks. Choose an earlier last day.':`${plan.repeat}: ${plan.dates.length} blocks.`;}
 catch(error){summary.textContent=error.message;}
}
async function blockRepeatSave(form,skip){
 const [d,weekdays]=blockRepeatRead(form),plan=blockRepeatPlan(d,weekdays);
 if(plan.dates.length<2)throw new Error('That makes fewer than two blocks. Choose a later last day.');
 if(plan.dates.length>260)throw new Error('That is more than 260 blocks. Choose an earlier last day.');
 const occurrences=plan.dates.map(o=>({starts_at:scheduleInstant(o.starts),ends_at:scheduleInstant(o.ends)}));
 // A second press after the taken dates were shown is a new request: the first wrote nothing.
 if(skip)form.dataset.request=crypto.randomUUID();
 const data=await api('/api/v1/schedule/block-series','POST',{request_id:form.dataset.request,clinician_id:d.clinician_id,label:d.label,repeat:plan.repeat,occurrences,skip_conflicts:!!skip});
 if(!data.created){
  const host=form.querySelector('[data-block-conflicts]'),free=occurrences.length-data.conflicts.length;
  host.hidden=false;
  host.innerHTML=`<p><b>${data.conflicts.length} of the ${occurrences.length} dates already ${data.conflicts.length===1?'has':'have'} an appointment or a block.</b> Nothing has been blocked yet.</p><ul>${data.conflicts.slice(0,12).map(o=>`<li>${esc(date(o.starts_at))}</li>`).join('')}${data.conflicts.length>12?`<li>and ${data.conflicts.length-12} more</li>`:''}</ul>${free?`<button type="submit" data-block-skip>Block the other ${free} date${free===1?'':'s'}</button>`:'<p>Every date is taken. Change the time or the dates.</p>'}`;
  return;
 }
 await showSchedule();
 notice(`Blocked ${data.blocks} date${data.blocks===1?'':'s'}${data.skipped?.length?`. Skipped ${data.skipped.length} that ${data.skipped.length===1?'was':'were'} already taken`:''}.`);
}
for(const kind of ['change','input'])document.addEventListener(kind,event=>{const form=event.target?.closest?.('#schedule-block-form');if(form?.id==='schedule-block-form'&&typeof form.querySelector==='function'&&form.querySelector('[data-block-repeat]'))blockRepeatPaint(form);},true);

// Read the practice catalog for each new form. An open form keeps the version it displayed.
async function scheduleVisitTypes(){
 const directory=await api('/api/v1/practice/visit-types');
 return directory.items.filter(type=>type.enabled!==false);
}
function scheduleTypeOptions(types,saved){
 const options=['<option value="">Choose a visit type</option>'];
 if(saved)options.push(`<option value="current" selected>${esc(saved.name)} · ${esc(saved.duration_minutes)} min (booked)</option>`);
 for(const type of types){
  if(type.id===saved?.id&&type.version===saved.version)continue;
  options.push(`<option value="${esc(type.id)}" data-version="${esc(type.version)}" data-name="${esc(type.name)}" data-category="${esc(type.category)}" data-minutes="${esc(type.duration_minutes)}">${esc(type.name)} · ${esc(type.duration_minutes)} min</option>`);
 }
 return options.join('');
}
function scheduleBookingTypeSelection(form){
 const option=form.querySelector?.('[data-booking-type]')?.selectedOptions?.[0];
 if(option?.dataset.version)return {visit_type:{id:option.value,version:Number(option.dataset.version)}};
 return option?.value===''&&form.dataset.existingType?{visit_type:null}:{};
}
function scheduleApplyBookingType(form){
 const option=form.querySelector('[data-booking-type]').selectedOptions[0];
 if(!option?.dataset.version){
  if(option?.value==='current'){
   form.elements.title.value=form.dataset.originalTitle;
   form.elements.category.value=form.dataset.originalCategory;
   scheduleSetBookingDuration(form,Number(form.dataset.originalMinutes));
  }
  return;
 }
 form.elements.title.value=option.dataset.name;form.elements.category.value=option.dataset.category;
 scheduleSetBookingDuration(form,Number(option.dataset.minutes));
}
function scheduleSetBookingDuration(form,minutes){
 if(!form.elements.starts_at.value||!Number.isFinite(minutes)||minutes<=0)return;
 const start=scheduleInstant(form.elements.starts_at.value);
 form.elements.ends_at.value=localTime(new Date(new Date(start).getTime()+minutes*60000).toISOString());
}
function scheduleNewPatient(name,picker){
 const form=$('schedule-booking'),block=form.querySelector('[data-booking-new-patient]');
 block.hidden=false;block.disabled=false;form.dataset.newPatient='1';delete form.dataset.createdPatient;delete form.dataset.createdIdentity;delete form.dataset.contactSaved;delete form.dataset.contactRefreshed;delete form.dataset.insuranceSaved;delete form.dataset.insuranceRequest;
 const parts=name.trim().split(/\s+/);form.elements.new_given_name.value=parts.shift()||'';form.elements.new_family_name.value=parts.join(' ');
 picker.field.value='';picker.input.required=false;closePatientPicker(picker);
 form.elements.new_given_name.focus({preventScroll:true});
}
function scheduleCancelNewPatient(){
 const form=$('schedule-booking'),block=form?.querySelector('[data-booking-new-patient]');if(!block)return;
 block.hidden=true;block.disabled=true;delete form.dataset.newPatient;
 if(scheduleBookingPatientPicker)scheduleBookingPatientPicker.input.required=true;
}
async function scheduleCreateBookingPatient(form,data){
 if(form.dataset.newPatient==='1'){
  // Keep the saved identity on this form if contact saving or booking needs a retry.
  const wantsInsurance=!!(data.new_insurance_id||data.new_insurance_name||data.new_member_id);
  if(wantsInsurance&&(!data.new_insurance_id||!data.new_member_id?.trim()))throw new Error('Choose an insurer and enter the Member ID, or leave both empty for self-pay.');
  if(!form.dataset.createdPatient){const patient=await api('/api/v1/patients','POST',{given_name:data.new_given_name.trim(),family_name:data.new_family_name.trim(),birth_date:data.new_birth_date});form.dataset.createdPatient=patient.id;schedulePatients.unshift(patient);if(typeof patientPickerReads!=='undefined')patientPickerReads.clear();}
  const identity=JSON.stringify([data.new_given_name.trim(),data.new_family_name.trim(),data.new_birth_date]);
  if(form.dataset.createdIdentity&&form.dataset.createdIdentity!==identity)throw new Error('The patient was already registered. Choose the existing patient to review their identity before booking.');
  form.dataset.createdIdentity=identity;data.patient_id=form.dataset.createdPatient;
  if(!form.dataset.contactSaved){await api(`/api/v1/patients/${encodeURIComponent(data.patient_id)}/demographics`,'PUT',{content:{phone:data.new_phone,administrative_gender:data.new_sex||null},reason:'Contact details recorded during patient registration'},0);form.dataset.contactSaved='1';}
  if(!form.dataset.contactRefreshed){
   const [patient,demographics]=await Promise.all([api(`/api/v1/patients/${encodeURIComponent(data.patient_id)}`),api(`/api/v1/patients/${encodeURIComponent(data.patient_id)}/demographics`)]);
   const index=schedulePatients.findIndex(p=>p.id===data.patient_id);
   const refreshed={...schedulePatients[index],...patient,demographics};
   if(index<0)schedulePatients.unshift(refreshed);else schedulePatients[index]=refreshed;
   form.dataset.contactRefreshed='1';
  }
  if(wantsInsurance&&!form.dataset.insuranceSaved){
   const today=localIsoDate(),appointmentDay=localIsoDate(new Date(data.starts_at)),effectiveDate=appointmentDay<today?appointmentDay:today;
   form.dataset.insuranceRequest ||= crypto.randomUUID();
   await api(`/api/v1/patients/${encodeURIComponent(data.patient_id)}/coverages`,'POST',{request_id:form.dataset.insuranceRequest,source_history_id:null,reason:'Insurance recorded during patient registration',content:{payer_id:data.new_insurance_id,member_id:data.new_member_id.trim(),priority:'primary',status:'active',group_number:'',plan_name:'',subscriber_name:[data.new_given_name.trim(),data.new_family_name.trim()].join(' '),subscriber_birth_date:data.new_birth_date,relationship:'self',effective_date:effectiveDate,end_date:null,copay_cents:null,verification:'unverified',notes:''}});
   form.dataset.insuranceSaved='1';
  }
 }
 for(const key of Object.keys(data))if(key.startsWith('new_'))delete data[key];
 if(!data.patient_id)throw new Error('Choose a patient or enter the new patient details.');
}
document.addEventListener('change',event=>{const form=event.target.closest?.('#schedule-booking');if(!form)return;
 if(event.target.hasAttribute?.('data-booking-type'))scheduleApplyBookingType(form);
 if(event.target.name==='starts_at'){
  const option=form.querySelector('[data-booking-type]')?.selectedOptions[0];
  const minutes=option?.value==='current'?form.dataset.originalMinutes:option?.dataset.minutes;
  if(minutes&&!form.dataset.customDuration)scheduleSetBookingDuration(form,Number(minutes));
 }
 if(event.target.name==='ends_at')form.dataset.customDuration='1';
 if(event.target.hasAttribute?.('data-booking-type'))delete form.dataset.customDuration;});
document.addEventListener('click',event=>{if(!event.target.closest?.('[data-booking-existing]'))return;scheduleCancelNewPatient();scheduleBookingPatientPicker?.input.focus({preventScroll:true});});
