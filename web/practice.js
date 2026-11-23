// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let practiceLoad=0,practiceData,practiceBoardMode='agenda',practiceFlowFilter='all',practiceQuery='',practiceResultFilter='all';
// The board shows today's list; the patient box also looks through the whole patient list so
// staff can open anyone's chart from Home without a separate search screen.
const practicePatientLimit=8,practicePatientDelay=200,practicePatientPages=8;
let practicePatients=[],practicePatientCursor=null,practicePatientSequence=0,practicePatientTimer=null,practicePatientError='',practicePatientBusy=false;
const practiceTime=value=>new Date(value).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
const practiceStatus=value=>displayStatus(value);
const practiceProvider=label=>displayPerson(label)||'Provider not set';
const practiceWhere=item=>[item.facility,item.room?'Room '+item.room:''].filter(Boolean).join(' · ');
function practiceAction(action,label,primary=false){return `<button type="button" class="${primary?'primary':'quiet'}" data-practice-action="${action}">${label}</button>`;}
function practiceUnavailable(index,label){return `<div class="practice-unavailable" role="status"><b>${label} could not be loaded</b><p>${esc(practiceData.results[index].reason?.message||'Refresh to try again.')}</p>${practiceAction('refresh','Try again')}</div>`;}
async function showPracticeWorkspace(){
 const generation=++practiceLoad;
 showTool('Practice overview');
 $('tools').innerHTML='<section id="practice-home" class="practice-home" aria-busy="true">'+(typeof skeletonMarkup==='function'?skeletonMarkup('tiles')+skeletonMarkup('rows'):'<p class="muted" role="status">Loading today…</p>')+'</section>';
 const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
 const results=await Promise.allSettled([
  api(`/api/v1/schedule?${new URLSearchParams({start:start.toISOString(),end:end.toISOString()})}`),
  api('/api/v1/labs/inbox'),api('/api/v1/practice/worklist'),
  api('/api/v1/previsit/readiness'),api('/api/v1/follow-up/tasks?status=open'),
  api('/api/v1/referrals/worklist?_count=100'),api('/api/v1/billing/claims'),
  api(`/api/v1/practice/overview?${new URLSearchParams({tz:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})}`)
 ]);
 if(generation!==practiceLoad||!$('practice-home')||!me)return;
 const value=i=>results[i].status==='fulfilled'?results[i].value:null;
 const schedule=value(0),inbox=value(1),unfinished=value(2),previsit=value(3),followup=value(4),referrals=value(5),claims=value(6),overview=value(7);
 practiceData={start,loadedAt:new Date(),results,schedule,inbox,unfinished,previsit,followup,referrals,claims,overview,
  appointments:(schedule?.appointments||[]).filter(a=>!['cancelled','no_show'].includes(a.status)).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)),
  reports:inbox?[...inbox.items].sort((a,b)=>Number(b.critical)-Number(a.critical)):[]};
 renderPracticeWorkspace();
}
function practiceTab(mode,label,count){return `<button type="button" data-practice-board="${mode}" aria-pressed="${practiceBoardMode===mode}">${label}<span>${count===null?'—':esc(count)}</span></button>`;}
// The Home step is titled for the areas the practice actually shows. Before the workspace
// settings have loaded, checkout is treated as shown.
function practiceCheckoutHidden(){return typeof workspaceChartTabEnabled==='function'&&!workspaceChartTabEnabled('checkout');}
function practiceJourneyStep(index,action,label,description,count,tone=''){
 const amount=Number.isFinite(count)?count:null;
 const state=amount===null?'unavailable':amount>0?(tone||'attention'):'clear';
 return `<button type="button" class="${state}" data-practice-action="${action}"><b>${label}</b><small>${esc(description)}</small>${amount===null?'':`<em>${amount}</em>`}</button>`;
}

// The overview's numbers: a row of tiles that each open their list, three small charts and what
// needs attention. Money and claims appear only when the server returned them (billing view).
function practiceMoney(cents){return Number.isFinite(cents)?money(cents):'—';}
function practiceTile(action,label,value,hint,tone=''){return `<button type="button" class="practice-tile${tone?` is-${tone}`:''}" data-practice-action="${action}"><span>${esc(label)}</span><b>${esc(value)}</b>${hint?`<small>${esc(hint)}</small>`:''}</button>`;}
function practiceClaimCount(o,status){return Number(o?.claims?.by_status?.[status]?.count||0);}
function practiceClaimBilled(o,status){return Number(o?.claims?.by_status?.[status]?.billed_cents||0);}
function practiceBars(rows){
 // Labels and numbers are page text; only each bar is drawn, stretched to its share of the widest.
 const max=Math.max(1,...rows.map(r=>r.value));
 return `<div class="practice-bars" role="img" aria-label="${esc(rows.map(r=>`${r.label} ${r.value}`).join(', '))}">${rows.map(r=>`<div class="practice-bar-row"><span>${esc(r.label)}</span><svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" width="${Math.max(1,Math.round(r.value/max*100))}" height="10" rx="1" class="practice-chart-bar ${r.tone||''}"></rect></svg><b>${esc(r.value)}</b></div>`).join('')}</div>`;
}
function practiceTrend(trend){
 if(!Array.isArray(trend)||!trend.length)return '<p class="muted">No charges or payments in the last 30 days.</p>';
 const w=360,h=120,max=Math.max(1,...trend.flatMap(d=>[d.charges_cents,d.collected_cents]));
 const line=key=>trend.map((d,i)=>`${Math.round(i/(trend.length-1||1)*w)},${Math.round(h-(d[key]/max)*h)}`).join(' ');
 const total=key=>trend.reduce((sum,d)=>sum+Number(d[key]||0),0);
 return `<svg class="practice-chart" viewBox="0 0 ${w} ${h+4}" role="img" aria-label="Last 30 days: charges ${esc(money(total('charges_cents')))}, collected ${esc(money(total('collected_cents')))}"><polyline points="${line('charges_cents')}" class="practice-chart-line charges"></polyline><polyline points="${line('collected_cents')}" class="practice-chart-line collected"></polyline></svg><p class="practice-chart-key"><span class="charges">Charges ${esc(money(total('charges_cents')))}</span><span class="collected">Collected ${esc(money(total('collected_cents')))}</span></p>`;
}
function practiceDashboardMarkup(d,journey=''){
 const o=d.overview,appointments=d.appointments||[],unfinished=d.unfinished;
 const arrived=appointments.filter(a=>['checked_in','in_progress','completed'].includes(a.status)).length;
 const attention=o?.claims?Number(o.claims.needs_correction||0)+practiceClaimCount(o,'rejected'):null;
 const tiles=[
  practiceTile('schedule','Today’s patients',String(appointments.length),`${arrived} arrived`),
  practiceTile('followup','Unfinished encounters',unfinished?String(unfinished.total):'—','Notes to finish',unfinished?.total?'attention':''),
  o?.claims?(toSend=>practiceTile('claims','Claims to send',String(toSend),attention?`${attention} ${attention===1?'needs':'need'} correcting`:'None need correcting',toSend||attention?'attention':''))(practiceClaimCount(o,'draft')+practiceClaimCount(o,'ready')):'',
  o?.money?practiceTile('claims','Waiting on insurers',practiceMoney(o.money.waiting_on_insurers_cents),`${practiceClaimCount(o,'submitted')+practiceClaimCount(o,'accepted')} claims sent`):'',
  o?.money?practiceTile('billing','Collected today',practiceMoney(o.money.collected_today_cents),`${practiceMoney(o.money.collected_month_cents)} this month`,'good'):'',
  o?.money?practiceTile('billing','Charges this month',practiceMoney(o.money.charges_month_cents),o.money.payment_account_balance?`Payout account ${practiceMoney(o.money.payment_account_balance.available_cents)}`:'Posted visit charges'):''
 ].join('');
 const claimRows=o?.claims?[
  {label:'Ready to send',value:practiceClaimCount(o,'draft')+practiceClaimCount(o,'ready')},
  {label:'With the clearinghouse',value:Number(o.claims.received_by_clearinghouse||0)},
  {label:'Waiting on payer',value:Math.max(0,practiceClaimCount(o,'submitted')+practiceClaimCount(o,'accepted')-Number(o.claims.received_by_clearinghouse||0)-Number(o.claims.needs_correction||0))},
  {label:'Needs correcting',value:Number(o.claims.needs_correction||0)+practiceClaimCount(o,'rejected'),tone:'attention'},
  {label:'Paid / answered',value:practiceClaimCount(o,'adjudicated'),tone:'good'}]:null;
 const p=o?.patients;
 const mix=p?practiceBars([{label:'Insurance',value:Number(p.insured||0)},{label:'Self-pay',value:Number(p.self_pay||0),tone:'neutral'}]):'';
 const gaps=p?[['Missing address',p.missing_address],['Missing phone',p.missing_phone],['Insured, no member ID',p.missing_member_id]].filter(([,n])=>Number(n)>0):[];
 const needs=[
  attention?`<li><span>Claims needing correction</span><b>${esc(attention)}</b><button type="button" data-practice-action="claims">Open claims</button></li>`:'',
  unfinished?.total?`<li><span>Unfinished encounters</span><b>${esc(unfinished.total)}</b><button type="button" data-practice-action="followup">Open work queue</button></li>`:'',
  ...gaps.map(([label,n])=>`<li><span>Patients: ${esc(label.toLowerCase())}</span><b>${esc(n)}</b><button type="button" data-practice-action="patients">Find patients</button></li>`)
 ].filter(Boolean).join('');
 return `<section class="practice-dashboard" aria-label="Practice at a glance"><div class="practice-tiles">${tiles}</div>${journey}
 <div class="practice-charts">${claimRows?`<article class="practice-chart-card"><h3>Claims</h3>${practiceBars(claimRows)}</article>`:''}${o?.trend?`<article class="practice-chart-card"><h3>Last 30 days</h3>${practiceTrend(o.trend)}</article>`:''}${p?`<article class="practice-chart-card"><h3>Patients</h3>${mix}<p class="muted">${esc(p.active)} active patients</p></article>`:''}</div>
 ${needs?`<article class="practice-needs"><h3>Needs attention</h3><ul>${needs}</ul></article>`:''}</section>`;
}
function renderPracticeWorkspace(){
 const {start,loadedAt,schedule,inbox,unfinished,previsit,followup,referrals,claims,appointments}=practiceData;
 const dateLabel=start.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
 const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
 $('practice-home').outerHTML=`<section id="practice-home" class="practice-home">
 <div class="practice-commandbar"><div><h2>${esc(dateLabel)}</h2><p class="muted" title="Times shown in ${esc(tz)}">All providers · Updated ${esc(practiceTime(loadedAt))}</p></div><div class="actions">${practiceAction('refresh','Refresh')}${practiceAction('patients','Find patient')}${practiceAction('schedule','Open schedule',true)}</div></div>
 ${practiceDashboardMarkup(practiceData,`<section class="practice-journey-shell" aria-labelledby="practice-journey-heading"><div class="practice-journey-heading"><h3 id="practice-journey-heading">Where patients are today</h3></div><nav class="practice-journey" aria-label="Patient journey">
 ${practiceJourneyStep(1,'intake','Intake','New requests and forms',Array.isArray(previsit?.items)?previsit.items.filter(item=>['not_issued','submitted'].includes(item.status)).length:null)}
 ${practiceJourneyStep(2,'schedule','Ready','Scheduled and preparing',schedule?appointments.length:null,'active')}
 ${practiceJourneyStep(3,'patients','Visit','Arrivals and open encounters',unfinished?unfinished.total:null)}
 ${practiceJourneyStep(4,'patients',...(practiceCheckoutHidden()?['Charges','Charges for signed visits']:['Wrap-up','Instructions, charges and handoff']),unfinished?unfinished.items.filter(item=>item.note_saved).length:null)}
 ${practiceJourneyStep(5,'claims','Claim','Coding, submission and payer response',Array.isArray(claims?.items)?claims.items.length:null)}
 ${practiceJourneyStep(6,'followup','Follow-up','Tasks, referrals and recall',[followup?.items,referrals?.items].every(Array.isArray)?followup.items.length+referrals.items.length:null)}
 </nav></section>`)}
 <div class="practice-board-layout"><section class="practice-board" aria-label="Patient and visit worklist"><header class="practice-board-header"><nav class="practice-board-tabs" aria-label="Clinical worklists">${practiceTab('agenda','Today’s patients',schedule?appointments.length:null)}${practiceTab('unfinished','Unfinished encounters',unfinished?unfinished.total:null)}</nav><span class="practice-board-scope">${practiceBoardMode==='agenda'?'Today · all providers':'All dates · oldest first'}</span></header>
 <div class="practice-board-toolbar"><label class="practice-search"><span class="sr-only">Find a patient by name, date of birth or record number</span><input id="practice-search" type="search" value="${esc(practiceQuery)}" placeholder="Find a patient by name, date of birth or record number" autocomplete="off" spellcheck="false" aria-controls="practice-patient-results" aria-describedby="practice-patient-status" aria-activedescendant="${practicePatientActive>=0?`practice-patient-option-${practicePatientActive}`:''}"></label><p id="practice-patient-status" class="muted practice-patient-status" role="status" ${practiceQuery.trim().length>=2?'':'hidden'}>${esc(practicePatientStatus())}</p><div class="practice-patient-search" id="practice-patient-results" role="listbox" aria-label="Matching patients" ${practiceQuery.trim().length>=2?'':'hidden'}>${practicePatientRows()}</div><div class="practice-status-strip" aria-label="Filter today’s appointments" ${practiceBoardMode==='agenda'?'':'hidden'}>${[['all','All'],['arrivals','Arrived'],['in_progress','In progress'],['completed','Completed']].map(([key,label])=>`<button type="button" data-practice-flow="${key}" aria-pressed="${practiceFlowFilter===key}">${label}<span>${schedule?appointments.filter(a=>practiceMatchesFlow(a,key)).length:'—'}</span></button>`).join('')}</div></div>
 <div id="practice-worklist" class="practice-worklist"></div><footer class="practice-board-footer"><span id="practice-row-summary" role="status" aria-live="polite"></span>${practiceAction('schedule','Manage schedule →')}</footer></section>
 <aside class="practice-queue-sidebar" aria-label="Work needing attention"><header class="practice-board-header"><div><h3>Results to review</h3></div><span class="pill">${inbox?`${inbox.items.length}${inbox.items.length>=inbox.limit?'+':''}`:'—'}</span></header><div class="practice-result-filters" aria-label="Filter result review queue"><button type="button" data-practice-result-filter="all" aria-pressed="${practiceResultFilter==='all'}">All results</button><button type="button" data-practice-result-filter="critical" aria-pressed="${practiceResultFilter==='critical'}">Critical <span>${inbox?practiceData.reports.filter(r=>r.critical).length:'—'}</span></button></div><div id="practice-results"></div><footer class="practice-board-footer">${practiceAction('results','Review all results →')}</footer></aside></div>
 </section>`;
 renderPracticeRows();renderPracticeResults();
}
function practiceMatchesFlow(a,filter){return filter==='all'||(filter==='arrivals'?['checked_in','in_progress'].includes(a.status):a.status===filter);}
function practiceMatchesQuery(item){const query=practiceQuery.trim().toLocaleLowerCase();return !query||`${item.patient_name} ${item.mrn} ${item.title||''}`.toLocaleLowerCase().includes(query);}
// Results while typing: name, a date of birth typed as a date, or the record number.
let practicePatientActive=-1;
function practicePatientMatches(){return practicePatients.filter(p=>patientPickerMatches(p,practiceQuery)).slice(0,practicePatientLimit);}
function practicePatientStatus(){
 if(practicePatientError)return practicePatientError;
 if(practicePatientBusy)return 'Searching…';
 const query=practiceQuery.trim();
 if(query.length<2)return '';
 const count=practicePatientMatches().length;
 if(!count)return practicePatientCursor?'No patient matches yet. More patients are still being looked through.':'No patient matches this. Check the spelling or try the record number.';
 return `${count===1?'One patient matches':`${count} patients match`}. Choose one to open their chart.`;
}
function practicePatientRows(){
 const rows=practicePatientMatches();
 return rows.map((p,index)=>`<button type="button" class="patient-picker-row${index===practicePatientActive?' is-active':''}" role="option" aria-selected="${index===practicePatientActive}" id="practice-patient-option-${index}" data-practice-patient="${esc(p.id)}">${patientPickerRowHtml(p)}</button>`).join('')||'<p class="muted">Type a name, a date of birth or a record number.</p>';
}
function practicePatientPaint(){
 const list=$('practice-patient-results');
 if(list){list.innerHTML=practicePatientRows();list.hidden=practiceQuery.trim().length<2;}
 const status=$('practice-patient-status');if(status){status.textContent=practicePatientStatus();status.hidden=practiceQuery.trim().length<2;}
 const box=$('practice-search');if(box){box.setAttribute('aria-busy',String(practicePatientBusy));box.setAttribute('aria-activedescendant',practicePatientActive>=0?`practice-patient-option-${practicePatientActive}`:'');}
}
function practicePatientReadPage(sequence,after){
 return api(after?`/api/v1/patients?after=${encodeURIComponent(after)}`:'/api/v1/patients').then(page=>{
  if(sequence!==practicePatientSequence)return;
  const seen=new Set(practicePatients.map(p=>p.id));
  practicePatients=[...practicePatients,...(Array.isArray(page?.items)?page.items:[]).filter(p=>!seen.has(p.id))];
  practicePatientCursor=page?.next_cursor||null;
 },()=>{if(sequence===practicePatientSequence){practicePatientCursor=null;practicePatientError='Patient names could not be loaded right now. Refresh to try again.';}});
}
function practicePatientSearch(){
 const sequence=++practicePatientSequence,query=practiceQuery.trim(),short=()=>{if(sequence!==practicePatientSequence)return;practicePatientBusy=false;practicePatientPaint();};
 practicePatientError='';practicePatientActive=-1;practicePatientBusy=true;practicePatientPaint();
 if(query.length<2){practicePatients=[];practicePatientCursor=null;practicePatientBusy=false;practicePatientPaint();return;}
 const step=pagesLeft=>{
  if(sequence!==practicePatientSequence)return Promise.resolve();
  if(practicePatientMatches().length||!practicePatientCursor||pagesLeft<=0)return Promise.resolve();
  return practicePatientReadPage(sequence,practicePatientCursor).then(()=>step(pagesLeft-1));
 };
 // Read on from the first page until something matches, so the box is not limited to who
 // happens to be on today's board.
 const known=practicePatients.length?Promise.resolve():practicePatientReadPage(sequence,null);
 known.then(()=>step(practicePatientPages)).then(short,short);
}
function renderPracticeRows(){
 const {schedule,unfinished,appointments}=practiceData;
 const agenda=practiceBoardMode==='agenda',loaded=agenda?schedule:unfinished;
 if(!loaded){$('practice-worklist').innerHTML=practiceUnavailable(agenda?0:2,agenda?'Today’s agenda':'Unfinished encounters');$('practice-row-summary').textContent='This list could not be loaded.';return;}
 const original=agenda?appointments:unfinished.items;
 const rows=original.filter(item=>practiceMatchesQuery(item)&&(!agenda||practiceMatchesFlow(item,practiceFlowFilter)));
 const existingVisit=a=>unfinished?.items.find(v=>v.appointment_id===a.id);
 const agendaRow=a=>{const visit=existingVisit(a);return `<tr><td class="practice-time"><b>${esc(practiceTime(a.starts_at))}</b><small>${esc(practiceTime(a.ends_at))}</small></td><td><button type="button" class="text-button practice-patient" data-practice-patient="${esc(a.patient_id)}">${esc(a.patient_name)}</button><small>${esc(a.title||'Appointment')} · <span class="record-id">MRN ${esc(a.mrn)}</span></small></td><td>${esc(practiceProvider(a.provider_label))}${practiceWhere(a)?`<small>${esc(practiceWhere(a))}</small>`:''}</td><td><span class="status-badge ${esc(a.status)}">${esc(practiceStatus(a.status))}</span></td><td>${visit?`<button type="button" data-practice-visit="${esc(visit.visit_id)}" data-practice-visit-patient="${esc(a.patient_id)}">Resume encounter</button>`:`<button type="button" data-practice-appointment="${esc(a.id)}">${a.status==='booked'?(['owner','clinician','front_desk'].includes(me.role)?'Manage arrival':'Review appointment'):a.status==='checked_in'?'Open appointment':'Manage'}</button>`}</td></tr>`;};
 const unfinishedRow=v=>`<tr><td class="practice-time"><b>${esc(new Date(v.starts_at||v.created_at).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}))}</b><small>${esc(practiceTime(v.starts_at||v.created_at))}</small></td><td><button type="button" class="text-button practice-patient" data-practice-patient="${esc(v.patient_id)}">${esc(v.patient_name)}</button><small>${esc(v.title||'Visit')} · <span class="record-id">MRN ${esc(v.mrn)}</span>${v.visit_id&&typeof encounterTimelineChip==='function'?' '+encounterTimelineChip(null,'',{visit:v.visit_id,patient:v.patient_id}):''}</small></td><td>${esc(displayPerson(v.provider_label)||(v.clinician_id===me.user_id?'Your visit':'Assigned clinician'))}${practiceWhere(v)?`<small>${esc(practiceWhere(v))}</small>`:''}</td><td><span class="status-badge in_progress">Not signed</span><small>${v.note_saved?'Note saved':'Note not saved'} · ${v.vitals_saved?'Vitals recorded':'Vitals not recorded'}</small></td><td><button type="button" data-practice-visit="${esc(v.visit_id)}" data-practice-visit-patient="${esc(v.patient_id)}">Resume encounter</button></td></tr>`;
 let content;
 if(rows.length)content=`<div class="practice-table-wrap"><table class="practice-table"><caption class="sr-only">${agenda?'Today’s patient appointments':'Unfinished patient visits across all dates'}</caption><thead><tr><th scope="col">${agenda?'Time':'Visit date'}</th><th scope="col">Patient</th><th scope="col">Provider</th><th scope="col">${agenda?'Status':'Note'}</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map(agenda?agendaRow:unfinishedRow).join('')}</tbody></table></div>`;
 else if(original.length)content='<div class="practice-empty"><b>No matching patients</b><p>Change the search or filter.</p><button type="button" data-practice-clear>Clear filters</button></div>';
 else content=agenda?'<div class="practice-empty"><b>No active appointments today</b><p>Open the schedule to book an appointment or choose another date.</p></div>':'<div class="practice-empty"><b>No unfinished visits</b><p>Every visit is signed.</p></div>';
 $('practice-worklist').innerHTML=content;
 $('practice-row-summary').textContent=agenda?(rows.length===appointments.length?displayCount(appointments.length,'appointment')+' today':`Showing ${rows.length} of ${displayCount(appointments.length,'appointment')}`):(unfinished.has_more?`Showing the oldest ${unfinished.items.length} of ${unfinished.total} unsigned visits`:rows.length===unfinished.items.length?displayCount(unfinished.total,'unsigned visit'):`Showing ${rows.length} of ${displayCount(unfinished.items.length,'unsigned visit')}`);
 document.querySelectorAll('[data-practice-flow]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.practiceFlow===practiceFlowFilter)));
}
function renderPracticeResults(){
 const {inbox,reports}=practiceData;
 if(!inbox){$('practice-results').innerHTML=practiceUnavailable(1,'Results queue');return;}
 const visible=reports.filter(r=>practiceResultFilter!=='critical'||r.critical);
 $('practice-results').innerHTML=visible.length?`<div class="practice-result-list">${visible.slice(0,8).map(r=>`<article class="practice-queue-item ${r.critical?'practice-critical':''}"><div class="section-head"><span class="${r.critical?'critical-label':'practice-result-status'}">${r.critical?'Critical result':esc(practiceStatus(r.status))}</span></div><h4>${esc(r.patient_name)}</h4><p>${esc(r.title)}</p><small class="record-id">MRN ${esc(r.mrn)}</small><button type="button" class="text-button" data-practice-result="${esc(r.order_id)}" data-practice-result-patient="${esc(r.patient_id)}">Review result →</button></article>`).join('')}</div>${visible.length>8?`<p class="practice-footnote">Showing 8 of ${visible.length}. Critical results are listed first.</p>`:''}`:`<div class="practice-empty"><b>${practiceResultFilter==='critical'?'No critical results':'No results to review'}</b>${practiceResultFilter==='critical'?'<p>Choose All results to see the rest.</p>':''}</div>`;
 document.querySelectorAll('[data-practice-result-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.practiceResultFilter===practiceResultFilter)));
}
// The box filters today's list at once and looks through the whole patient list as it types.
function practicePatientType(value){
 practiceQuery=String(value??'');practicePatientActive=-1;
 clearTimeout(practicePatientTimer);practicePatientTimer=null;
 renderPracticeRows();
 if(practiceQuery.trim().length<2){practicePatients=[];practicePatientCursor=null;practicePatientSequence++;practicePatientBusy=false;practicePatientError='';practicePatientPaint();return;}
 practicePatientPaint();
 practicePatientTimer=setTimeout(()=>{practicePatientTimer=null;practicePatientSearch();},practicePatientDelay);
}
function practicePatientStep(direction){
 const rows=practicePatientMatches();if(!rows.length)return;
 practicePatientActive=(practicePatientActive+direction+rows.length)%rows.length;
 practicePatientPaint();
}
document.addEventListener('input',event=>{
 if(event.target.id!=='practice-search'||!practiceData)return;
 practicePatientType(event.target.value);
});
document.addEventListener('keydown',event=>{
 if(event.target.id!=='practice-search'||!practiceData||event.isComposing)return;
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopImmediatePropagation();practicePatientStep(event.key==='ArrowDown'?1:-1);return;}
 if(event.key==='Escape'){
  // Escape empties the box; the board comes back. The screen behind it stays as it was.
  if(practiceQuery){event.preventDefault();event.stopImmediatePropagation();const box=$('practice-search');if(box)box.value='';practicePatientType('');}
  return;
 }
 if(event.key!=='Enter'&&event.key!=='Tab')return;
 // One match opens that chart; several are stepped through with Enter. Tab keeps moving on.
 if(practicePatientBusy||event.key==='Tab')return;
 const rows=practicePatientMatches(),chosen=rows.length===1?rows[0]:rows[practicePatientActive];
 if(!chosen)return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{await showClinical();await selectPatient(chosen.id);});
});
// Capture this workbench’s controls before generic application click handlers.
document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!(button.id==='nav-practice'||['data-practice-action','data-practice-patient','data-practice-appointment','data-practice-result','data-practice-visit','data-practice-board','data-practice-flow','data-practice-clear','data-practice-result-filter'].some(name=>button.hasAttribute(name))))return;
 event.preventDefault();event.stopImmediatePropagation();
 if(button.dataset.practiceBoard){practiceBoardMode=button.dataset.practiceBoard;renderPracticeWorkspace();return;}
 if(button.dataset.practiceFlow){practiceFlowFilter=button.dataset.practiceFlow;renderPracticeRows();return;}
 if(button.hasAttribute('data-practice-clear')){practiceFlowFilter='all';const box=$('practice-search');if(box)box.value='';practicePatientType('');return;}
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
