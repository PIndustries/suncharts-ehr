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
async function showPracticeWorkspace({board='agenda'}={}){
 practiceBoardMode=board==='unfinished'?'unfinished':'agenda';practiceQuery='';practiceFlowFilter='all';
 const generation=++practiceLoad;
 showTool('Practice overview');
 $('tools').innerHTML='<section id="practice-home" class="practice-home" aria-busy="true">'+(typeof skeletonMarkup==='function'?skeletonMarkup('tiles')+skeletonMarkup('rows'):'<p class="muted" role="status">Loading today…</p>')+'</section>';
 const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
 const results=await Promise.allSettled([
  api(`/api/v1/schedule?${new URLSearchParams({start:start.toISOString(),end:end.toISOString()})}`),
  api('/api/v1/labs/inbox'),api('/api/v1/practice/worklist'),
  api('/api/v1/previsit/readiness'),api('/api/v1/follow-up/tasks?status=open'),
  api('/api/v1/referrals/worklist?_count=100'),typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('claims')?api('/api/v1/billing/claims'):null,
  api(`/api/v1/practice/overview?${new URLSearchParams({tz:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'})}`),
  api(`/api/v1/schedule/markers?${new URLSearchParams({from:start.toISOString(),to:end.toISOString()})}`),
  practiceCanOpenIntakeReview()?api('/api/v1/previsit/readiness?status=submitted'):null
 ]);
 if(generation!==practiceLoad||!$('practice-home')||!me)return;
 const value=i=>results[i].status==='fulfilled'?results[i].value:null;
 const schedule=value(0),inbox=value(1),unfinished=value(2),previsit=value(3),followup=value(4),referrals=value(5),claims=value(6),overview=value(7),markers=value(8),intakeReview=value(9);
 practiceData={start,loadedAt:new Date(),results,schedule,inbox,unfinished,previsit,followup,referrals,claims,overview,markers,intakeReview,
  appointments:(schedule?.appointments||[]).filter(a=>!['cancelled','no_show'].includes(a.status)).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)),
  reports:inbox?[...inbox.items].sort((a,b)=>Number(b.critical)-Number(a.critical)):[]};
 renderPracticeWorkspace();
}
function practiceMoney(cents){return Number.isFinite(cents)?money(cents):'—';}
function practiceTile(action,label,value,hint,tone=''){const href={today:'#/home',notes:'#/home/unfinished','claims-send':'#/claims/send','claims-fix':'#/claims/fix',collected:'#/billing/collected-today'}[action];return `<a href="${href}" class="practice-tile${tone?` is-${tone}`:''}" data-practice-action="${action}"><span>${esc(label)}</span><b>${esc(value)}</b>${hint?`<small>${esc(hint)}</small>`:''}</a>`;}
function practiceClaimCount(o,status){return Number(o?.claims?.by_status?.[status]?.count||0);}
function practiceClaimBilled(o,status){return Number(o?.claims?.by_status?.[status]?.billed_cents||0);}
function practiceBars(rows){
 // Labels and numbers are page text; only each bar is drawn, stretched to its share of the widest.
 const max=Math.max(1,...rows.map(r=>r.value));
 return `<div class="practice-bars" role="img" aria-label="${esc(rows.map(r=>`${r.label} ${r.value}`).join(', '))}">${rows.map(r=>`<div class="practice-bar-row"><span>${esc(r.label)}</span><svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" width="${Math.max(0,Math.round(r.value/max*100))}" height="10" rx="1" class="practice-chart-bar ${r.tone||''}"></rect></svg><b>${esc(r.value)}</b></div>`).join('')}</div>`;
}
function practiceTrend(trend){
 if(!Array.isArray(trend)||!trend.length)return '<p class="muted">No charges or payments in the last 30 days.</p>';
 const w=720,h=160,step=w/trend.length,max=Math.max(1,...trend.flatMap(d=>[Number(d.charges_cents)||0,Number(d.collected_cents)||0]));
 const total=key=>trend.reduce((sum,d)=>sum+Number(d[key]||0),0);
 const dateLabel=d=>{const value=String(d.day||d.date||'');return /^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(value+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric'}):value;};
 const bars=trend.map((d,i)=>['charges_cents','collected_cents'].map((key,j)=>{const height=Math.max(0,Number(d[key])||0)/max*h;return `<rect x="${i*step+step*(j?0.52:0.12)}" y="${h-height}" width="${step*0.36}" height="${height}" class="practice-daily-bar ${j?'collected':'charges'}"><title>${esc(dateLabel(d))}: ${j?'Collected':'Charges'} ${esc(money(Number(d[key])||0))}</title></rect>`;}).join('')).join('');
 const ticks=trend.map((d,i)=>i===0||i===trend.length-1||i%7===0?`<text x="${i*step+step/2}" y="${h+22}" text-anchor="${i===0?'start':i===trend.length-1?'end':'middle'}">${esc(dateLabel(d))}</text>`:'').join('');
 return `<svg class="practice-chart" viewBox="0 0 ${w} ${h+32}" role="img" aria-label="Daily charges and collected, ${esc(dateLabel(trend[0]))} to ${esc(dateLabel(trend.at(-1)))}: charges ${esc(money(total('charges_cents')))}, collected ${esc(money(total('collected_cents')))}">${bars}${ticks}</svg><p class="practice-chart-key"><span class="charges">Charges ${esc(money(total('charges_cents')))}</span><span class="collected">Collected ${esc(money(total('collected_cents')))}</span></p>`;
}
function practiceDashboardMarkup(d){
 const o=d.overview, waiting=n=>Number(n)>0?'attention':'';
 return `<nav class="practice-dashboard practice-tiles" aria-label="Today's work">${[
  practiceTile('today','Appointments today',d.schedule?String(d.appointments.length):'—',''),
  practiceTile('notes','Notes to finish',d.unfinished?String(d.unfinished.total):'—','',waiting(d.unfinished?.total)),
  practiceTile('claims-send','Claims to send',o?.claims?String(practiceClaimCount(o,'draft')+practiceClaimCount(o,'ready')):'—','',waiting(practiceClaimCount(o,'draft')+practiceClaimCount(o,'ready'))),
  practiceTile('claims-fix','Claims needing a fix',o?.claims?String(Number(o.claims.needs_correction||0)+practiceClaimCount(o,'rejected')):'—','',waiting(Number(o?.claims?.needs_correction||0)+practiceClaimCount(o,'rejected'))),
  practiceCanOpenCollections(o?.money)?practiceTile('collected','Collected today',practiceMoney(o.money.collected_today_cents),''):'<div class="practice-tile"><span>Collected today</span><b>—</b></div>'
 ].join('')}</nav>`;
}
function practiceCanOpenClaims(){
 return $('nav-claims')?.hidden!==true&&(typeof workspaceResourceAllowed!=='function'||(workspaceResourceAllowed('claims')&&workspaceResourceAllowed('billing')));
}
function practiceCanOpenCollections(m){
 return Number.isFinite(m?.collected_today_cents)&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('billing'));
}
function practiceMoneyMarkup(d){
 const m=d.overview?.money,waiting=m?.waiting_on_insurers_cents,canOpenClaims=practiceCanOpenClaims();
 const waitingAmount=esc(practiceMoney(waiting));
 const waitingMarkup=canOpenClaims&&Number.isFinite(waiting)?practiceAction('claims-wait',`<span class="sr-only">View claims waiting on insurers, </span>${waitingAmount}`):waitingAmount;
 const collectedAmount=esc(practiceMoney(m?.collected_today_cents));
 const collectedMarkup=practiceCanOpenCollections(m)?practiceAction('collected',`<span class="sr-only">View payments collected today, </span>${collectedAmount}`):collectedAmount;
 return `<section class="practice-money-card" aria-labelledby="practice-money-heading"><h3 id="practice-money-heading">Money</h3><dl><dt>Waiting on insurers</dt><dd>${waitingMarkup}</dd><dt>Collected today</dt><dd>${collectedMarkup}<small>${practiceMoney(m?.collected_month_cents)} this month</small></dd><dt>Charges this month</dt><dd>${practiceMoney(m?.charges_month_cents)}</dd></dl>${m?.payment_account_balance?`<p>Payout account ${practiceMoney(m.payment_account_balance.available_cents)}</p>`:''}<div class="actions">${practiceAction('billing','Open billing')}${canOpenClaims?practiceAction('claims','Open claims'):''}${practiceAction('trends','Trends')}</div></section>`;
}
// Shared with the practice Billing overview; these charts are not rendered on Home.
function practiceTrendsMarkup(o){
 return ` <div class="practice-charts"><article class="practice-chart-card"><h3>Claims</h3>${o?.claims?practiceBars([
 {label:'Ready to send',value:practiceClaimCount(o,'draft')+practiceClaimCount(o,'ready')},
 {label:'With the clearinghouse',value:Number(o.claims.received_by_clearinghouse||0)},
 {label:'Waiting on payer',value:Math.max(0,practiceClaimCount(o,'submitted')+practiceClaimCount(o,'accepted')-Number(o.claims.received_by_clearinghouse||0)-Number(o.claims.needs_correction||0))},
 {label:'Needs correcting',value:Number(o.claims.needs_correction||0)+practiceClaimCount(o,'rejected'),tone:'attention'},
 {label:'Paid / answered',value:practiceClaimCount(o,'adjudicated'),tone:'good'}]):'<p>Claims could not be loaded.</p>'}</article><article class="practice-chart-card"><h3>Last 30 days</h3>${o?.trend?practiceTrend(o.trend):'<p>Charges and payments could not be loaded.</p>'}</article></div>
 ${o?.patients?`<article class="practice-chart-card"><h3>Patients</h3>${practiceBars([{label:'Insurance',value:Number(o.patients.insured||0)},{label:'Self-pay',value:Number(o.patients.self_pay||0),tone:'neutral'}])}<p>${esc(o.patients.active??'—')} active patients · ${esc(o.patients.missing_member_id??'—')} insured patients missing member ID</p></article>`:''}`;
}

function practiceCanOpenIntakeReview(){
 return typeof workspaceResourceAllowed!=='function'||(workspaceResourceAllowed('scheduling')&&workspaceResourceAllowed('clinical'));
}
function practiceAttentionMarkup(d){
 const count=(data,items)=>data?`${items.length}${data.next_cursor||data.limit&&items.length>=data.limit?'+':''}`:'—';
 const reports=d.inbox?.items||[],capped=d.inbox?.limit>0&&reports.length>=d.inbox.limit;
 const criticalOnPage=reports.filter(report=>report.critical).length;
 const criticalCount=d.inbox?.critical_count??(capped?(criticalOnPage?`${criticalOnPage}+`:'—'):criticalOnPage);
 const overdue=(d.referrals?.items||[]).filter(r=>!['completed','cancelled','entered_in_error'].includes(r.status)&&r.content?.follow_up_due&&r.content.follow_up_due<(d.referrals.overdue_as_of||localIsoDate()));
 const canOpenPatients=typeof canOpenPatientDirectory!=='function'||canOpenPatientDirectory();
 const rows=[
  ['Intake to review',d.intakeReview?.total??'—','intake','Review intake'],
  ['Unfinished encounters',d.unfinished?.total??'—','notes','Open encounters'],
  ['Missing address',d.overview?.patients?.missing_address??'—','missing-address','<span class="sr-only">Patients with a missing address. </span>Open patients'],
  ['Missing phone',d.overview?.patients?.missing_phone??'—','missing-phone','<span class="sr-only">Patients with a missing phone. </span>Open patients'],
  ...(criticalCount?[['Critical results',criticalCount,'critical-results','Review critical results']]:[]),
  ['Results to review',d.inbox?.total??count(d.inbox,reports),'results','Review results'],
  ['Overdue referrals',count(d.referrals,overdue),'referrals','Open referrals'],
  ['Open tasks',count(d.followup,d.followup?.items||[]),'tasks','Open tasks']
 ];
 return `<aside class="practice-needs" aria-labelledby="practice-needs-heading"><h3 id="practice-needs-heading">Needs attention</h3><ul>${rows.map(([label,n,action,button])=>`<li><span>${label}</span><b>${esc(n)}</b>${(action!=='intake'||practiceCanOpenIntakeReview())&&(!action.startsWith('missing-')||canOpenPatients)?practiceAction(action,button):''}</li>`).join('')}</ul></aside>`;
}
function renderPracticeWorkspace(){
 const {start,schedule,appointments}=practiceData;
 const dateLabel=start.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
 $('practice-home').outerHTML=`<section id="practice-home" class="practice-home">
 <div class="practice-commandbar"><h2>Today · ${esc(dateLabel)}</h2><div class="actions">${practiceAction('appointment','+ Appointment',true)}${practiceAction('find-patient','Find a patient')}</div></div>
 ${practiceDashboardMarkup(practiceData)}
 <div class="practice-board-layout"><section class="practice-board" aria-labelledby="practice-board-title"><header class="practice-board-header"><h3 id="practice-board-title">${practiceBoardMode==='agenda'?"Today's appointments":'Unfinished encounters'}</h3></header>
 <div class="practice-board-toolbar"><label class="practice-search"><span class="sr-only">Find a patient by name, date of birth or record number</span><input id="practice-search" type="search" value="${esc(practiceQuery)}" placeholder="Find a patient by name, date of birth or record number" autocomplete="off" spellcheck="false" aria-controls="practice-patient-results" aria-describedby="practice-patient-status" aria-activedescendant="${practicePatientActive>=0?`practice-patient-option-${practicePatientActive}`:''}"></label><p id="practice-patient-status" class="muted practice-patient-status" role="status" ${practiceQuery.trim().length>=2?'':'hidden'}>${esc(practicePatientStatus())}</p><div class="practice-patient-search" id="practice-patient-results" role="listbox" aria-label="Matching patients" ${practiceQuery.trim().length>=2?'':'hidden'}>${practicePatientRows()}</div><div class="practice-status-strip" aria-label="Filter today’s appointments" ${practiceBoardMode==='agenda'?'':'hidden'}>${[['all','All'],['arrivals','Arrived'],['in_progress','In progress'],['completed','Completed']].map(([key,label])=>`<button type="button" data-practice-flow="${key}" aria-pressed="${practiceFlowFilter===key}">${label}<span>${schedule?appointments.filter(a=>practiceMatchesFlow(a,key)).length:'—'}</span></button>`).join('')}</div></div>
 <div id="practice-worklist" class="practice-worklist"></div><footer class="practice-board-footer"><span id="practice-row-summary" role="status" aria-live="polite"></span>${practiceAction('schedule','Open schedule')}</footer></section>
 <div class="practice-side-column">${practiceAttentionMarkup(practiceData)}${practiceMoneyMarkup(practiceData)}</div></div>
 </section>`;
 renderPracticeRows();
}
function practiceMatchesFlow(a,filter){return filter==='all'||(filter==='arrivals'?['checked_in','in_progress'].includes(a.status):a.status===filter);}
function selectPracticeBoard(board){
 practiceBoardMode=board==='unfinished'?'unfinished':'agenda';
 practiceQuery='';practiceFlowFilter='all';
 renderPracticeWorkspace();
 $('practice-worklist').scrollIntoView({block:'nearest'});
}
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
// Match evidence to this appointment/visit, never another encounter for the patient.
function practiceStage(a,visit){
 if(visit&&a.status!=='completed')return visit.note_saved?'Wrap-up':'Encounter';
 if(a.status==='in_progress')return 'Encounter';
 if(a.status==='completed'){
  const marker=practiceData.markers?.items?.find(m=>m.appointment_id===a.id);
  if(marker){
   if(marker.note&&marker.note!=='signed')return 'Wrap-up';
   if(marker.claim&&['not_sent','rejected'].includes(marker.claim.status))return 'Claim';
   if(marker.charges==='draft')return 'Wrap-up';
   if(marker.claim||Object.hasOwn(marker,'claim')&&marker.charges)return 'Done';
  }
  const visitId=a.visit_id||visit?.visit_id||visit?.id;
  const claims=(practiceData.claims?.items||[]).filter(c=>visitId&&c.visit_id===visitId);
  if(claims.some(c=>!['submitted','accepted','adjudicated','paid'].includes(c.status)))return 'Claim';
  return claims.length?'Done':'Wrap-up';
 }
 if(a.status==='checked_in')return 'Ready';
 const intake=practiceData.previsit?.items?.find(i=>i.appointment_id===a.id);
 return intake&&!['reviewed','not_needed'].includes(intake.status)?'Intake':'Ready';
}
function practiceStagePill(a,visit){const stage=practiceStage(a,visit);return `<span class="practice-stage stage-${stage.toLowerCase()}">${stage}</span>`;}
function renderPracticeRows(){
 const {schedule,unfinished,appointments}=practiceData;
 const agenda=practiceBoardMode==='agenda',loaded=agenda?schedule:unfinished;
 if(!loaded){$('practice-worklist').innerHTML=practiceUnavailable(agenda?0:2,agenda?'Today’s agenda':'Unfinished encounters');$('practice-row-summary').textContent='This list could not be loaded.';return;}
 const original=agenda?appointments:unfinished.items;
 const rows=original.filter(item=>practiceMatchesQuery(item)&&(!agenda||practiceMatchesFlow(item,practiceFlowFilter)));
 const existingVisit=a=>unfinished?.items?.find(v=>v.appointment_id===a.id);
 const agendaRow=a=>{const visit=existingVisit(a);return `<tr><td class="practice-time"><b>${esc(practiceTime(a.starts_at))}</b><small>${esc(practiceTime(a.ends_at))}</small></td><td><button type="button" class="text-button practice-patient" data-practice-patient="${esc(a.patient_id)}">${esc(a.patient_name)}</button></td><td>${esc(a.title||'Appointment')}</td><td>${practiceStagePill(a,visit)}</td><td><span class="status-badge ${esc(a.status)}">${esc(practiceStatus(a.status))}</span></td><td>${visit?`<button type="button" data-practice-visit="${esc(visit.visit_id)}" data-practice-visit-patient="${esc(a.patient_id)}">Resume encounter</button>`:`<button type="button" data-practice-appointment="${esc(a.id)}">${a.status==='booked'?(['owner','clinician','front_desk'].includes(me.role)?'Manage arrival':'Review appointment'):a.status==='checked_in'?'Open appointment':'Manage'}</button>`}</td></tr>`;};
 const unfinishedRow=v=>`<tr><td class="practice-time"><b>${esc(new Date(v.starts_at||v.created_at).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}))}</b><small>${esc(practiceTime(v.starts_at||v.created_at))}</small></td><td><button type="button" class="text-button practice-patient" data-practice-patient="${esc(v.patient_id)}">${esc(v.patient_name)}</button><small>${esc(v.title||'Encounter')} · <span class="record-id">MRN ${esc(v.mrn)}</span>${v.visit_id&&typeof encounterTimelineChip==='function'?' '+encounterTimelineChip(null,'',{visit:v.visit_id,patient:v.patient_id}):''}</small></td><td>${esc(displayPerson(v.provider_label)||(v.clinician_id===me.user_id?'Your encounter':'Assigned clinician'))}${practiceWhere(v)?`<small>${esc(practiceWhere(v))}</small>`:''}</td><td><span class="status-badge in_progress">Not signed</span><small>${v.note_saved?'Note saved':'Note not saved'} · ${v.vitals_saved?'Vitals recorded':'Vitals not recorded'}</small></td><td><button type="button" data-practice-visit="${esc(v.visit_id)}" data-practice-visit-patient="${esc(v.patient_id)}">Resume encounter</button></td></tr>`;
 let content;
 if(rows.length)content=`<div class="practice-table-wrap" tabindex="0" role="region" aria-labelledby="practice-board-title"><table class="practice-table"><caption class="sr-only">${agenda?'Today’s patient appointments':'Unfinished patient encounters across all dates'}</caption><thead><tr><th scope="col">${agenda?'Time':'Encounter date'}</th><th scope="col">Patient</th><th scope="col">${agenda?'Encounter type':'Provider'}</th>${agenda?'<th scope="col">Stage</th>':''}<th scope="col">${agenda?'Status':'Note'}</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map(agenda?agendaRow:unfinishedRow).join('')}</tbody></table></div>`;
 else if(original.length)content='<div class="practice-empty"><b>No matching patients</b><p>Change the search or filter.</p><button type="button" data-practice-clear>Clear filters</button></div>';
 else content=agenda?'<div class="practice-empty"><b>No active appointments today</b><p>Open the schedule to book an appointment or choose another date.</p></div>':'<div class="practice-empty"><b>No unfinished encounters</b><p>Every encounter is signed.</p></div>';
 $('practice-worklist').innerHTML=content;
 $('practice-row-summary').textContent=agenda?(rows.length===appointments.length?displayCount(appointments.length,'appointment')+' today':`Showing ${rows.length} of ${displayCount(appointments.length,'appointment')}`):(unfinished.has_more?`Showing the oldest ${unfinished.items.length} of ${unfinished.total} unsigned encounters`:rows.length===unfinished.items.length?displayCount(unfinished.total,'unsigned encounter'):`Showing ${rows.length} of ${displayCount(unfinished.items.length,'unsigned encounter')}`);
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
 run(()=>frameSelectPatient(chosen.id,{section:'overview'}));
});
// Capture this workbench’s controls before generic application click handlers.
document.addEventListener('click',event=>{
 const button=event.target.closest('button,a[data-practice-action]');
 if(!button||!(button.id==='nav-practice'||['data-practice-action','data-practice-patient','data-practice-appointment','data-practice-result','data-practice-visit','data-practice-board','data-practice-flow','data-practice-clear','data-practice-result-filter'].some(name=>button.hasAttribute(name))))return;
 event.preventDefault();event.stopImmediatePropagation();
 if(button.dataset.practiceBoard){selectPracticeBoard(button.dataset.practiceBoard);return;}
 if(button.dataset.practiceFlow){practiceFlowFilter=button.dataset.practiceFlow;renderPracticeRows();return;}
 if(button.hasAttribute('data-practice-clear')){practiceFlowFilter='all';const box=$('practice-search');if(box)box.value='';practicePatientType('');return;}
 if(button.dataset.practiceResultFilter){practiceResultFilter=button.dataset.practiceResultFilter;renderPracticeResults();return;}
 run(async()=>{
  if(button.id==='nav-practice'){await showPracticeWorkspace();return;}
  if(button.dataset.practiceAction==='refresh'){await showPracticeWorkspace({board:practiceBoardMode});return;}
  if(button.dataset.practiceVisit){await frameSelectPatient(button.dataset.practiceVisitPatient,{section:'visits',visit:button.dataset.practiceVisit,step:'visit'});return;}
  if(button.dataset.practicePatient){await frameSelectPatient(button.dataset.practicePatient,{section:'overview'});return;}
  if(button.dataset.practiceAppointment){await showSchedule({entry:true,view:'day',unfiltered:true});await appointmentDetail(button.dataset.practiceAppointment);return;}
  if(button.dataset.practiceResult){await showClinical();await selectPatient(button.dataset.practiceResultPatient);await showOrder(button.dataset.practiceResult);return;}
  if(button.dataset.practiceAction==='find-patient'){$('practice-search')?.focus();return;}
  if(button.dataset.practiceAction==='schedule'){await showSchedule({entry:true});return;}
  if(button.dataset.practiceAction==='appointment'){await showSchedule({entry:true});scheduleSelected=undefined;await appointmentEditor();return;}
  if(button.dataset.practiceAction==='billing'){await showPatientBillingWorkspace({patientId:null,tab:'overview'});return;}
  if(button.dataset.practiceAction==='collected'){await renderBillingOverview(null,null,{practiceWide:true,view:'collected'});return;}
  if(button.dataset.practiceAction==='trends'){await renderBillingOverview(null,null,{practiceWide:true});$('billing-overview-trends')?.scrollIntoView({block:'start'});return;}
  if(['today','notes'].includes(button.dataset.practiceAction)){selectPracticeBoard(button.dataset.practiceAction==='notes'?'unfinished':'agenda');return;}
  const claimFilter={'claims-send':'send','claims-fix':'fix','claims-wait':'wait'}[button.dataset.practiceAction];
  if(claimFilter||button.dataset.practiceAction==='claims'){
   if(practiceCanOpenClaims())await showClaimsWorkspace(claimFilter?{filter:claimFilter}:undefined);
   return;
  }
  if(button.dataset.practiceAction==='referrals'){referralBoard.status='';referralBoard.overdue=true;await showReferralWorkspace();return;}
  if(button.dataset.practiceAction==='tasks'){followupFilter='open';followupOwner='all';await showFollowupWorkspace();return;}
  if(button.dataset.practiceAction==='critical-results'){await showLabInbox('critical');return;}
  if(['missing-address','missing-phone'].includes(button.dataset.practiceAction)){
   await openMissingPatients(button.dataset.practiceAction.slice('missing-'.length));return;
  }
  if(button.dataset.practiceAction==='intake'){if(practiceCanOpenIntakeReview())await showPrevisit({submitted:true});return;}
  const routes={results:showLabInbox};
  await routes[button.dataset.practiceAction]?.();
 });
},true);
