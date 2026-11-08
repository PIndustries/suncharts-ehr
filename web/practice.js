// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let practiceLoad=0,practiceData,practiceBoardMode='agenda',practiceFlowFilter='all',practiceQuery='',practiceResultFilter='all';
const practiceTime=value=>new Date(value).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
const practiceStatus=value=>String(value).replaceAll('_',' ');
function practiceAction(action,label,primary=false){return `<button type="button" class="${primary?'primary':'quiet'}" data-practice-action="${action}">${label}</button>`;}
function practiceUnavailable(index,label){return `<div class="practice-unavailable" role="status"><b>${label} could not be loaded</b><p>${esc(practiceData.results[index].reason?.message||'Refresh to try again.')}</p>${practiceAction('refresh','Retry loading queues')}</div>`;}
async function showPracticeWorkspace(){
 const generation=++practiceLoad;
 showTool('Practice overview');
 $('tools').innerHTML='<section id="practice-home" class="practice-home" aria-busy="true"><p class="muted" role="status">Loading clinical worklists…</p></section>';
 const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
 const results=await Promise.allSettled([
  api(`/api/v1/schedule?${new URLSearchParams({start:start.toISOString(),end:end.toISOString()})}`),
  api('/api/v1/labs/inbox'),api('/api/v1/practice/worklist'),
  api('/api/v1/previsit/readiness'),api('/api/v1/follow-up/tasks?status=open'),
  api('/api/v1/referrals/worklist?_count=100'),api('/api/v1/billing/claims')
 ]);
 if(generation!==practiceLoad||!$('practice-home')||!me)return;
 const value=i=>results[i].status==='fulfilled'?results[i].value:null;
 const schedule=value(0),inbox=value(1),unfinished=value(2),previsit=value(3),followup=value(4),referrals=value(5),claims=value(6);
 practiceData={start,loadedAt:new Date(),results,schedule,inbox,unfinished,previsit,followup,referrals,claims,
  appointments:(schedule?.appointments||[]).filter(a=>!['cancelled','no_show'].includes(a.status)).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)),
  reports:inbox?[...inbox.items].sort((a,b)=>Number(b.critical)-Number(a.critical)):[]};
 renderPracticeWorkspace();
}
function practiceTab(mode,label,count){return `<button type="button" data-practice-board="${mode}" aria-pressed="${practiceBoardMode===mode}">${label}<span>${count===null?'—':esc(count)}</span></button>`;}
function practiceJourneyStep(index,action,label,description,count,tone=''){
 const amount=Number.isFinite(count)?count:null;
 const state=amount===null?'unavailable':amount>0?(tone||'attention'):'clear';
 return `<button type="button" class="${state}" data-practice-action="${action}"><span>${index}</span><b>${label}</b><small>${esc(description)}</small>${amount===null?'':`<em>${amount}</em>`}</button>`;
}
function renderPracticeWorkspace(){
 const {start,loadedAt,schedule,inbox,unfinished,previsit,followup,referrals,claims,appointments}=practiceData;
 const dateLabel=start.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
 const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
 $('practice-home').outerHTML=`<section id="practice-home" class="practice-home">
 <div class="practice-commandbar"><div><p class="eyebrow">CLINICAL OPERATIONS</p><h2>${esc(dateLabel)}</h2><p class="muted">All providers · ${esc(tz)} <span aria-hidden="true">/</span> Updated ${esc(practiceTime(loadedAt))}</p></div><div class="actions">${practiceAction('refresh','Refresh')}${practiceAction('patients','Find patient')}${practiceAction('schedule','Open schedule',true)}</div></div>
 <section class="practice-journey-shell" aria-labelledby="practice-journey-heading"><div class="practice-journey-heading"><div><p class="eyebrow">PATIENT JOURNEY</p><h3 id="practice-journey-heading">Move work forward</h3></div><p>Choose a stage to open the people and tasks waiting there.</p></div><nav class="practice-journey" aria-label="Patient journey">
 ${practiceJourneyStep(1,'intake','Intake','New requests and forms',Array.isArray(previsit?.items)?previsit.items.length:null)}
 ${practiceJourneyStep(2,'schedule','Ready','Scheduled and preparing',schedule?appointments.length:null,'active')}
 ${practiceJourneyStep(3,'patients','Visit','Arrivals and open encounters',unfinished?unfinished.total:null)}
 ${practiceJourneyStep(4,'patients','Checkout','Instructions, charges and handoff',unfinished?unfinished.items.filter(item=>item.note_saved).length:null)}
 ${practiceJourneyStep(5,'claims','Claim','Coding, submission and payer response',Array.isArray(claims?.items)?claims.items.length:null)}
 ${practiceJourneyStep(6,'followup','Follow-up','Tasks, referrals and recall',[followup?.items,referrals?.items].every(Array.isArray)?followup.items.length+referrals.items.length:null)}
 </nav></section>
 <div class="practice-board-layout"><section class="practice-board" aria-label="Patient and encounter worklist"><header class="practice-board-header"><nav class="practice-board-tabs" aria-label="Clinical worklists">${practiceTab('agenda','Today’s patients',schedule?appointments.length:null)}${practiceTab('unfinished','Unfinished encounters',unfinished?unfinished.total:null)}</nav><span class="practice-board-scope">${practiceBoardMode==='agenda'?'Today · all providers':'All dates · oldest first'}</span></header>
 <div class="practice-board-toolbar"><label class="practice-search"><span class="sr-only">Search loaded patients or MRN</span><input id="practice-search" type="search" value="${esc(practiceQuery)}" placeholder="Search loaded patients or MRN" autocomplete="off"></label><div class="practice-status-strip" aria-label="Filter today’s appointments" ${practiceBoardMode==='agenda'?'':'hidden'}>${[['all','All'],['arrivals','Arrived'],['in_progress','In progress'],['completed','Completed']].map(([key,label])=>`<button type="button" data-practice-flow="${key}" aria-pressed="${practiceFlowFilter===key}">${label}<span>${schedule?appointments.filter(a=>practiceMatchesFlow(a,key)).length:'—'}</span></button>`).join('')}</div></div>
 <div id="practice-worklist" class="practice-worklist"></div><footer class="practice-board-footer"><span id="practice-row-summary" role="status" aria-live="polite"></span>${practiceAction('schedule','Manage schedule →')}</footer></section>
 <aside class="practice-queue-sidebar" aria-label="Work needing attention"><header class="practice-board-header"><div><p class="eyebrow">MY WORK</p><h3>Needs attention</h3><p class="muted">Results requiring clinical review</p></div><span class="pill">${inbox?`${inbox.items.length}${inbox.items.length>=inbox.limit?'+':''}`:'—'}</span></header><div class="practice-result-filters" aria-label="Filter result review queue"><button type="button" data-practice-result-filter="all" aria-pressed="${practiceResultFilter==='all'}">All results</button><button type="button" data-practice-result-filter="critical" aria-pressed="${practiceResultFilter==='critical'}">Critical <span>${inbox?practiceData.reports.filter(r=>r.critical).length:'—'}</span></button></div><div id="practice-results"></div><footer class="practice-board-footer">${practiceAction('results','Review all results →')}</footer></aside></div>
 <nav class="practice-workspace-links" aria-label="Practice workspaces"><span>Continue work</span>${practiceAction('billing','Patient billing')}${practiceAction('claims','Insurance claims')}${practiceAction('clearinghouse','Claim connections')}${practiceAction('apps','Integrations')}${me.role==='owner'?practiceAction('migration','Data import'):''}</nav></section>`;
 renderPracticeRows();renderPracticeResults();
}
function practiceMatchesFlow(a,filter){return filter==='all'||(filter==='arrivals'?['checked_in','in_progress'].includes(a.status):a.status===filter);}
function practiceMatchesQuery(item){const query=practiceQuery.trim().toLocaleLowerCase();return !query||`${item.patient_name} ${item.mrn} ${item.title||''}`.toLocaleLowerCase().includes(query);}
function renderPracticeRows(){
 const {schedule,unfinished,appointments}=practiceData;
 const agenda=practiceBoardMode==='agenda',loaded=agenda?schedule:unfinished;
 if(!loaded){$('practice-worklist').innerHTML=practiceUnavailable(agenda?0:2,agenda?'Today’s agenda':'Unfinished encounters');$('practice-row-summary').textContent='Queue unavailable · other worklists remain available';return;}
 const original=agenda?appointments:unfinished.items;
 const rows=original.filter(item=>practiceMatchesQuery(item)&&(!agenda||practiceMatchesFlow(item,practiceFlowFilter)));
 const existingVisit=a=>unfinished?.items.find(v=>v.appointment_id===a.id);
 const agendaRow=a=>{const visit=existingVisit(a);return `<tr><td class="practice-time"><b>${esc(practiceTime(a.starts_at))}</b><small>${esc(practiceTime(a.ends_at))}</small></td><td><button type="button" class="text-button practice-patient" data-practice-patient="${esc(a.patient_id)}">${esc(a.patient_name)}</button><small>MRN ${esc(a.mrn)} · ${esc(a.title||'Appointment')}</small></td><td>${esc(a.provider_label)}<small>${esc([a.facility,a.room?'Room '+a.room:''].filter(Boolean).join(' · ')||'Location not recorded')}</small></td><td><span class="status-badge ${esc(a.status)}">${esc(practiceStatus(a.status))}</span></td><td>${visit?`<button type="button" data-practice-visit="${esc(visit.visit_id)}" data-practice-visit-patient="${esc(a.patient_id)}">Resume encounter</button>`:`<button type="button" data-practice-appointment="${esc(a.id)}">${a.status==='booked'?(['owner','clinician','front_desk'].includes(me.role)?'Manage arrival':'Review appointment'):a.status==='checked_in'?'Open appointment':'Manage'}</button>`}</td></tr>`;};
 const unfinishedRow=v=>`<tr><td class="practice-time"><b>${esc(new Date(v.starts_at||v.created_at).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}))}</b><small>${esc(practiceTime(v.starts_at||v.created_at))}</small></td><td><button type="button" class="text-button practice-patient" data-practice-patient="${esc(v.patient_id)}">${esc(v.patient_name)}</button><small>MRN ${esc(v.mrn)} · ${esc(v.title||'Encounter')}</small></td><td>${esc(v.provider_label||(v.clinician_id===me.user_id?'Your encounter':'Assigned clinician'))}<small>${esc([v.facility,v.room?'Room '+v.room:''].filter(Boolean).join(' · ')||'Location not recorded')}</small></td><td><span class="status-badge in_progress">Unsigned</span><small>${v.note_saved?'Note saved':'Note not saved'} · ${v.vitals_saved?'Vitals recorded':'Vitals not recorded'}</small></td><td><button type="button" data-practice-visit="${esc(v.visit_id)}" data-practice-visit-patient="${esc(v.patient_id)}">Resume encounter</button></td></tr>`;
 let content;
 if(rows.length)content=`<div class="practice-table-wrap"><table class="practice-table"><caption class="sr-only">${agenda?'Today’s patient appointments':'Unfinished patient encounters across all dates'}</caption><thead><tr><th scope="col">${agenda?'Time':'Visit date'}</th><th scope="col">Patient / encounter</th><th scope="col">Provider / location</th><th scope="col">${agenda?'Patient status':'Documentation'}</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map(agenda?agendaRow:unfinishedRow).join('')}</tbody></table></div>`;
 else if(original.length)content='<div class="practice-empty"><b>No matching patients</b><p>Change the search or status filter to see other loaded records.</p><button type="button" data-practice-clear>Clear filters</button></div>';
 else content=agenda?'<div class="practice-empty"><b>No active appointments today</b><p>Open the schedule to book an appointment or choose another date.</p></div>':'<div class="practice-empty"><b>No unfinished encounters</b><p>No open native visits were returned for this practice.</p></div>';
 $('practice-worklist').innerHTML=content;
 $('practice-row-summary').textContent=agenda?`${rows.length} of ${appointments.length} loaded appointments · ${schedule.blocks.length} provider time blocks · cancellations and no-shows excluded`:`${rows.length} of ${unfinished.items.length} loaded encounters · ${unfinished.total} total open${unfinished.has_more?' · oldest 100 loaded; complete and refresh for more':''}`;
 document.querySelectorAll('[data-practice-flow]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.practiceFlow===practiceFlowFilter)));
}
function renderPracticeResults(){
 const {inbox,reports}=practiceData;
 if(!inbox){$('practice-results').innerHTML=practiceUnavailable(1,'Results queue');return;}
 const visible=reports.filter(r=>practiceResultFilter!=='critical'||r.critical);
 $('practice-results').innerHTML=visible.length?`<div class="practice-result-list">${visible.slice(0,8).map(r=>`<article class="practice-queue-item ${r.critical?'practice-critical':''}"><div class="section-head"><span class="${r.critical?'critical-label':'practice-result-status'}">${r.critical?'Critical result':esc(practiceStatus(r.status))}</span><small>Revision ${esc(r.version)}</small></div><h4>${esc(r.patient_name)}</h4><p>${esc(r.title)}</p><small>MRN ${esc(r.mrn)} · ${esc(practiceStatus(r.status))}</small><button type="button" class="text-button" data-practice-result="${esc(r.order_id)}" data-practice-result-patient="${esc(r.patient_id)}">Review result →</button></article>`).join('')}</div><p class="practice-footnote">${Math.min(8,visible.length)} of ${visible.length} matching loaded reports. Oldest ${inbox.limit} unacknowledged revisions are fetched; critical flags are prioritized within that set.</p>`:`<div class="practice-empty"><b>${practiceResultFilter==='critical'?'No critical results in the loaded queue':'No results awaiting acknowledgment'}</b><p>${practiceResultFilter==='critical'?'Switch to All results to review other unacknowledged revisions.':'No unacknowledged revisions were returned by the results queue.'}</p></div>`;
 document.querySelectorAll('[data-practice-result-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.practiceResultFilter===practiceResultFilter)));
}
document.addEventListener('input',event=>{
 if(event.target.id!=='practice-search'||!practiceData)return;
 practiceQuery=event.target.value;renderPracticeRows();
});
// Capture this workbench’s controls before generic application click handlers.
document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!(button.id==='nav-practice'||['data-practice-action','data-practice-patient','data-practice-appointment','data-practice-result','data-practice-visit','data-practice-board','data-practice-flow','data-practice-clear','data-practice-result-filter'].some(name=>button.hasAttribute(name))))return;
 event.preventDefault();event.stopImmediatePropagation();
 if(button.dataset.practiceBoard){practiceBoardMode=button.dataset.practiceBoard;renderPracticeWorkspace();return;}
 if(button.dataset.practiceFlow){practiceFlowFilter=button.dataset.practiceFlow;renderPracticeRows();return;}
 if(button.hasAttribute('data-practice-clear')){practiceFlowFilter='all';practiceQuery='';$('practice-search').value='';renderPracticeRows();return;}
 if(button.dataset.practiceResultFilter){practiceResultFilter=button.dataset.practiceResultFilter;renderPracticeResults();return;}
 run(async()=>{
  if(button.id==='nav-practice'||button.dataset.practiceAction==='refresh'){await showPracticeWorkspace();return;}
  if(button.dataset.practiceVisit){await showClinical();await selectPatient(button.dataset.practiceVisitPatient,button.dataset.practiceVisit);showChartSection('visits');return;}
  if(button.dataset.practicePatient){await showClinical();await selectPatient(button.dataset.practicePatient);return;}
  if(button.dataset.practiceAppointment){scheduleDate=localTime(new Date().toISOString()).slice(0,10);scheduleMode='day';scheduleProvider='';await showSchedule();await appointmentDetail(button.dataset.practiceAppointment);return;}
  if(button.dataset.practiceResult){await showClinical();await selectPatient(button.dataset.practiceResultPatient);await showOrder(button.dataset.practiceResult);return;}
  const routes={patients:showClinical,intake:showPrevisit,followup:showFollowupWorkspace,schedule:async()=>{scheduleDate=localTime(new Date().toISOString()).slice(0,10);scheduleProvider='';await showSchedule();},results:showLabInbox,billing:showBillingQueue,claims:showClaimsWorkspace,clearinghouse:showEdiWorkspace,apps:showApps,migration:showMigrations};
  await routes[button.dataset.practiceAction]?.();
 });
},true);
