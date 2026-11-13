// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The schedule board: one appointment card shared by the day, week, month and list
// views, the markers that say what each visit still needs, and the appointment panel.
// Appointments are drawn first; markers arrive from one read per visible range.

const scheduleStatusLabels={booked:'Booked',checked_in:'Checked in',in_progress:'In progress',completed:'Completed',cancelled:'Cancelled',no_show:'No-show'};
const scheduleZoomScale={comfortable:2,compact:1.2}; // pixels per minute
const scheduleMinimumMinutes=15; // shortest height a card is drawn at
const scheduleIcons={
 forms:'<path d="M5 2.5h6l2 2v9H5z"/><path d="M7 7h4M7 9.5h4"/>',
 insurance:'<path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/>',
 copay:'<circle cx="8" cy="8" r="5.5"/><path d="M9.8 6.2c-.4-.6-1-.9-1.8-.9-1 0-1.8.5-1.8 1.3 0 1.9 3.7.8 3.7 2.8 0 .8-.8 1.3-1.9 1.3-.9 0-1.6-.4-2-1M8 4.3v7.4"/>',
 balance:'<rect x="2.5" y="4" width="11" height="8" rx="1.2"/><path d="M2.5 7h11"/>',
 new:'<path d="M8 2.5l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 11l-3.3 1.7.7-3.7-2.7-2.6 3.7-.5z"/>',
 note:'<path d="M3 13l.6-2.8L10.8 3l2.2 2.2L5.8 12.4z"/>',
 charges:'<path d="M4 2.5h8v11l-2-1.2-2 1.2-2-1.2-2 1.2z"/><path d="M6 6h4M6 8.5h4"/>'
};
function scheduleIcon(kind){return `<svg class="marker-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${scheduleIcons[kind]||''}</svg>`;}
// Wording, names, times and counts come from the shared display helpers when they are loaded.
function scheduleStatusLabel(status){
 if(scheduleStatusLabels[status])return scheduleStatusLabels[status];
 if(typeof displayStatus==='function')return displayStatus(status);
 const text=String(status||'').replaceAll('_',' ');return text?text[0].toUpperCase()+text.slice(1):'';
}
function scheduleCountLabel(count,singular,plural){return typeof displayCount==='function'?displayCount(count,singular,plural):`${count} ${count===1?singular:(plural||singular+'s')}`;}
function scheduleVisitType(a){
 const text=String(a.category||'').toLowerCase();
 return /new/.test(text)?'new':/follow/.test(text)?'followup':/tele|video|virtual/.test(text)?'telehealth':/procedure|surgery/.test(text)?'procedure':/office|visit/.test(text)?'office':'other';
}
function scheduleVisitTitle(a){return a.title&&a.title!==a.category?a.title:(a.category||a.title||'Visit');}
function scheduleProviderName(entry){
 const listed=scheduleProviders.find(p=>p.id===entry.clinician_id)?.label||'',recorded=entry.provider_label||'';
 // A name wins over a sign-in email wherever either source has one.
 return typeof displayPerson==='function'?displayPerson(listed,displayPerson(recorded,listed)):listed||recorded;
}
function scheduleClock(value){return typeof displayTime==='function'?displayTime(value):new Date(value).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});}
function scheduleWhen(value){return typeof displayDateTime==='function'?displayDateTime(value):date(value);}
function scheduleClockRange(entry){return `${scheduleClock(entry.starts_at)} – ${scheduleClock(entry.ends_at)}`;}
function scheduleMoney(cents){return new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',minimumFractionDigits:cents%100?2:0,maximumFractionDigits:2}).format(cents/100);}
function scheduleDayLabel(day,options={weekday:'long',month:'long',day:'numeric',year:'numeric'}){return new Date(`${day}T12:00:00`).toLocaleDateString(undefined,options);}
function scheduleToday(){return localTime(new Date().toISOString()).slice(0,10);}
function scheduleClosed(a){return ['cancelled','no_show'].includes(a.status);}
function scheduleAllowed(resource,action='view'){return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource,action);}
function scheduleCanBill(){return ['owner','clinician','front_desk'].includes(me?.role)&&scheduleAllowed('billing','create');}
function scheduleCanSendForms(){return ['owner','clinician','front_desk'].includes(me?.role);}
function scheduleCanCheckInsurance(){return ['owner','clinician','front_desk'].includes(me?.role)&&scheduleAllowed('billing','create')&&scheduleAllowed('claims','create');}
function scheduleCanStartVisit(a){return scheduleAllowed('clinical')&&(['nurse','medical_assistant'].includes(me?.role)||(['owner','clinician'].includes(me?.role)&&a.clinician_id===me.user_id));}

// ---- Markers -------------------------------------------------------------
let scheduleMarkerState={key:'',items:new Map(),loaded:false,failed:false};
function scheduleMarkerKey(bounds,provider){return [me?.tenant_id||'',me?.user_id||'',bounds.start,bounds.end,provider||''].join('|');}
function scheduleMarker(id){return scheduleMarkerState.items.get(id);}
async function loadScheduleMarkers(ranges,provider,generation){
 const bounds={start:ranges[0].start,end:ranges.at(-1).end},key=scheduleMarkerKey(bounds,provider);
 // A different range starts empty; the same range keeps what it shows until fresh facts arrive.
 if(scheduleMarkerState.key!==key){scheduleMarkerState={key,items:new Map(),loaded:false,failed:false};}
 let pages;
 try{pages=await Promise.all(ranges.map(range=>api(`/api/v1/schedule/markers?${new URLSearchParams({from:range.start,to:range.end,...(provider?{provider}:{})})}`)));}
 catch{if(generation===scheduleLoadGeneration&&scheduleMarkerState.key===key){scheduleMarkerState.failed=true;paintScheduleMarkers();}return;}
 if(generation!==scheduleLoadGeneration||scheduleMarkerState.key!==key)return;
 scheduleMarkerState={key,items:new Map(pages.flatMap(page=>page.items||[]).map(item=>[item.appointment_id,item])),loaded:true,failed:false};
 paintScheduleMarkers();
}
// Every marker for one appointment, each with how urgently it needs someone.
function scheduleMarkerList(a){
 const m=scheduleMarker(a.id);if(!m)return [];
 const out=[],closed=scheduleClosed(a),done=a.status==='completed',started=done||a.status==='in_progress';
 const add=(kind,label,tone,tip,rank)=>out.push({kind,label,tone,tip,rank});
 // A cancelled or missed visit needs nothing done before it; only money matters still.
 if(!closed){
 if(m.new_patient)add('new','New patient','info','This is the patient’s first appointment here.',9);
 const forms={sent:['Forms sent','grey','Intake form sent. The patient has not started it yet.',8],in_progress:['Forms started','grey','The patient started the intake form but has not sent it in.',8],submitted:['Forms in','amber','The patient filled in the intake form. It needs review.',3],reviewed:['Forms done','green','The intake form was reviewed.',20]}[m.forms?.status];
 if(forms)add('forms',...forms);
 const insurance={active:['Active','green','Insurance is active.',20],not_active:['Not active','red','The insurer says this coverage is not active.',1],not_checked:['Not checked','grey','Insurance has not been checked for this visit.',7],check_failed:['Check failed','amber','The last insurance check could not confirm coverage.',4],self_pay:['Self-pay','grey','No active insurance is on file for this visit date.',21]}[m.insurance?.status];
 if(insurance)add('insurance',...insurance);
 }
 if(m.copay){
  const due=Number(m.copay.due_cents)||0,paid=Number(m.copay.paid_cents)||0,test=Number(m.copay.test_paid_cents)||0;
  if(paid>0&&paid>=due)add('copay','Copay paid','green',`${scheduleMoney(paid)} copay received.`,20);
  else if(test>0&&paid+test>=due)add('copay','Copay paid (test)','grey','Paid with a test card. No money was received.',10);
  else if(due>paid&&!closed)add('copay',`${scheduleMoney(due-paid)} due`,'amber',paid?`${scheduleMoney(paid)} of the ${scheduleMoney(due)} copay was received.`:`The plan’s copay of ${scheduleMoney(due)} has not been collected.`,2);
 }
 if(Number(m.balance_cents)>0)add('balance',`Owes ${scheduleMoney(Number(m.balance_cents))}`,'amber','The patient has an unpaid balance from earlier invoices.',6);
 if(started&&'note' in m){
  const note={signed:['Note signed','green','The visit note is signed.',20],in_progress:['Note in progress',done?'amber':'grey',done?'The visit is finished but its note is not signed.':'The visit note has been started.',done?5:11]}[m.note]||['Note not started',done?'amber':'grey',done?'The visit is finished but no note was written.':'The visit note has not been started.',done?5:11];
  add('note',...note);
 }
 if(started&&'charges' in m){
  if(m.charges==='posted')add('charges','Charges posted','green','Charges for this visit are posted.',20);
  else if(m.charges==='draft')add('charges','Charges draft',done?'amber':'grey','Charges were entered but are not posted yet.',done?5:11);
  else if(done)add('charges','No charges','amber','The visit is finished but no charges were entered.',5);
 }
 return out;
}
function scheduleMarkerHtml(a,marker){
 return `<button type="button" class="appt-marker tone-${marker.tone}" data-marker="${marker.kind}" data-marker-appointment="${esc(a.id)}" title="${esc(marker.tip)}">${scheduleIcon(marker.kind)}<span>${esc(marker.label)}</span></button>`;
}
// Day cards show everything, what needs attention first, so a card too small for all
// of them cuts off the ones that are fine. Week, month and list cards show the two most urgent.
const scheduleToneOrder={red:0,amber:1,info:2,grey:3,green:4};
function scheduleMarkersHtml(a,variant='day'){
 const all=scheduleMarkerList(a),m=scheduleMarker(a.id);
 const shown=variant==='day'?all.map((marker,index)=>[marker,index]).sort((x,y)=>scheduleToneOrder[x[0].tone]-scheduleToneOrder[y[0].tone]||x[1]-y[1]).map(pair=>pair[0]):all.filter(marker=>marker.rank<20).sort((x,y)=>x.rank-y.rank).slice(0,2);
 const offer=variant==='day'&&m&&!m.forms&&['booked','checked_in'].includes(a.status)&&scheduleCanSendForms()?`<button type="button" class="appt-marker appt-marker-offer" data-board-action="send-intake" data-appointment="${esc(a.id)}" title="Make a link the patient can use to fill in their intake form.">${scheduleIcon('forms')}<span>Send intake form</span></button>`:'';
 return shown.map(marker=>scheduleMarkerHtml(a,marker)).join('')+offer;
}

// ---- The appointment card ------------------------------------------------
function scheduleCard(a,variant='day',day=''){
 const status=scheduleStatusLabel(a.status),provider=scheduleProviderName(a),title=scheduleVisitTitle(a),range=scheduleClockRange(a);
 const continued=day&&localTime(a.starts_at).slice(0,10)!==day,place=variant==='row'?[a.facility,a.room?'Room '+a.room:''].filter(Boolean).join(' · '):'';
 const movable=variant==='week'&&canSchedule()&&a.status==='booked',wide=variant==='day'||variant==='row';
 const say=[range,a.patient_name,title,provider,status].filter(Boolean).join(', ');
 return `<article class="appt-card appt-${variant} status-${esc(a.status)} type-${scheduleVisitType(a)}${a.id===scheduleSelected?' is-selected':''}" data-schedule-id="${esc(a.id)}"><button type="button" class="appt-card-main" data-schedule-open="${esc(a.id)}" aria-label="${esc(say)}"${movable?` draggable="true" data-drag-appointment="${esc(a.id)}"`:''}><span class="appt-time">${esc(scheduleClock(a.starts_at))}<span class="appt-time-end"> – ${esc(scheduleClock(a.ends_at))}</span>${continued?' · continued':''}</span><strong class="appt-patient">${esc(a.patient_name)}</strong>${wide?`<span class="appt-meta">${esc(title)}${provider?' · '+esc(provider):''}${place?' · '+esc(place):''}</span>`:''}<span class="appt-status">${esc(status)}</span></button><div class="appt-markers" data-markers-for="${esc(a.id)}" data-markers-variant="${variant}">${scheduleMarkersHtml(a,variant)}</div></article>`;
}
function scheduleBlockLabel(block){return `${block.label} · ${scheduleProviderName(block)||'Provider'} unavailable`;}

// ---- Filters and the day summary ----------------------------------------
function scheduleFilterMatches(a,key){
 const m=scheduleMarker(a.id);
 switch(key){
  case 'scheduled':return a.status==='booked';
  case 'in_office':return ['checked_in','in_progress'].includes(a.status);
  case 'finished':return a.status==='completed';
  case 'checked_in':case 'in_progress':return a.status===key;
  case 'forms_review':return !scheduleClosed(a)&&m?.forms?.status==='submitted';
  case 'insurance_unchecked':return !scheduleClosed(a)&&a.status!=='completed'&&m?.insurance?.status==='not_checked';
  case 'active':return !scheduleClosed(a);
  default:return true;
 }
}
function scheduleShownAppointments(){return scheduleState.appointments.filter(a=>scheduleFilterMatches(a,scheduleFilter));}
function scheduleCount(key){return scheduleState.appointments.filter(a=>scheduleFilterMatches(a,key)).length;}
function scheduleEntriesForDay(day,appointments=scheduleShownAppointments()){
 const start=new Date(`${day}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);
 return [...appointments.map(a=>({...a,kind:'appointment'})),...scheduleState.blocks.map(b=>({...b,kind:'block'}))].filter(a=>new Date(a.starts_at)<end&&new Date(a.ends_at)>start).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.id.localeCompare(b.id));
}
function scheduleCountButton(key,count,label){
 return `<button type="button" class="schedule-count${scheduleFilter===key?' is-on':''}" data-schedule-filter="${key}" data-focus-key="filter-${key}" aria-pressed="${scheduleFilter===key}"><b>${count}</b> ${esc(label)}</button>`;
}
function scheduleSummaryHtml(){
 const total=scheduleCount('active'),plural=(n,one,many)=>n===1?one:many,parts=[scheduleCountButton('all',total,plural(total,'appointment','appointments')),scheduleCountButton('checked_in',scheduleCount('checked_in'),'checked in'),scheduleCountButton('in_progress',scheduleCount('in_progress'),'in progress')];
 const forms=scheduleCount('forms_review'),insurance=scheduleCount('insurance_unchecked');
 if(forms||scheduleFilter==='forms_review')parts.push(scheduleCountButton('forms_review',forms,plural(forms,'form to review','forms to review')));
 if(insurance||scheduleFilter==='insurance_unchecked')parts.push(scheduleCountButton('insurance_unchecked',insurance,'insurance not checked'));
 const groups=scheduleMode==='day'?`<div class="schedule-groups" role="group" aria-label="Show appointments by stage">${[['scheduled','Scheduled'],['in_office','In office'],['finished','Finished']].map(([key,label])=>`<button type="button" class="${scheduleFilter===key?'is-on':''}" data-schedule-filter="${key}" data-focus-key="filter-${key}" aria-pressed="${scheduleFilter===key}">${label} <b>${scheduleCount(key)}</b></button>`).join('')}</div>`:'';
 const batch=scheduleMode==='day'&&insurance&&scheduleCanCheckInsurance()&&['owner','front_desk'].includes(me?.role)?`<button type="button" data-board-action="check-day-insurance">${scheduleDate===scheduleToday()?'Check insurance for today':'Check insurance for this day'}</button>`:'';
 return `${groups}<div class="schedule-summary" role="group" aria-label="Summary. Choose a count to show only those appointments.">${parts.join('<span aria-hidden="true">·</span>')}</div>${scheduleFilter!=='all'?'<button type="button" class="schedule-show-all" data-schedule-filter="all" data-focus-key="filter-reset">Show all</button>':''}${batch}<span id="schedule-batch-status" class="schedule-batch-status" role="status">${esc(scheduleBatchMessage)}</span>${scheduleMarkerState.failed?'<span class="schedule-marker-problem" role="status">Forms, insurance and payment details could not be loaded. They will be tried again shortly.</span>':''}`;
}

// ---- Time grid -----------------------------------------------------------
// Wall-clock minutes of one entry inside one local day, clipped to that day.
function scheduleDayMinutes(entry,day){
 const minute=value=>{const local=localTime(value),date=local.slice(0,10);return date<day?0:date>day?1440:Number(local.slice(11,13))*60+Number(local.slice(14,16));};
 const start=minute(entry.starts_at);return {start,end:Math.max(minute(entry.ends_at),start+1)};
}
// Overlapping appointments share the column side by side.
function scheduleLayoutColumn(entries,day){
 const items=entries.map(a=>({a,...scheduleDayMinutes(a,day)})).sort((x,y)=>x.start-y.start||y.end-x.end||String(x.a.id).localeCompare(String(y.a.id)));
 let cluster=[],clusterEnd=-1;
 const flush=()=>{const lanes=Math.max(...cluster.map(item=>item.lane))+1;for(const item of cluster)item.lanes=lanes;cluster=[];};
 for(const item of items){
  item.shownEnd=Math.max(item.end,item.start+scheduleMinimumMinutes);
  if(cluster.length&&item.start>=clusterEnd){flush();clusterEnd=-1;}
  const used=new Set(cluster.filter(other=>other.shownEnd>item.start).map(other=>other.lane));
  let lane=0;while(used.has(lane))lane++;
  item.lane=lane;cluster.push(item);clusterEnd=Math.max(clusterEnd,item.shownEnd);
 }
 if(cluster.length)flush();
 return items;
}
function scheduleZoneOffset(zone,at){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(at).map(part=>[part.type,part.value]));
 return (Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute))-Math.floor(at.getTime()/60000)*60000)/60000;
}
// The practice's opening hours as this computer's clock shows them, or 7am to 7pm.
function schedulePracticeHours(day){
 const fallback={first:7*60,last:19*60},hours=scheduleHours;
 if(!hours||!/^\d\d:\d\d$/.test(hours.start||'')||!/^\d\d:\d\d$/.test(hours.end||''))return fallback;
 try{
  const noon=new Date(`${day}T12:00:00`),shift=-noon.getTimezoneOffset()-scheduleZoneOffset(hours.timezone,noon),minute=text=>Number(text.slice(0,2))*60+Number(text.slice(3,5))+shift;
  const first=Math.max(0,minute(hours.start)),last=Math.min(1440,minute(hours.end));
  return last>first?{first,last}:fallback;
 }catch{return fallback;}
}
function scheduleGridRange(columns){
 let {first,last}=schedulePracticeHours(columns[0].day);
 for(const column of columns)for(const entry of [...column.appointments,...column.blocks]){const m=scheduleDayMinutes(entry,column.day);first=Math.min(first,m.start);last=Math.max(last,entry.kind==='block'?m.end:Math.max(m.end,m.start+scheduleMinimumMinutes));}
 return {first:Math.floor(first/60)*60,last:Math.min(1440,Math.ceil(last/60)*60)};
}
function scheduleHourLabel(minute){return new Date(2001,0,1,Math.floor(minute/60)%24,0).toLocaleTimeString(undefined,{hour:'numeric'});}
// Day view: one column per provider when more than one has something that day.
function scheduleDayColumns(){
 const day=scheduleDate,entries=scheduleEntriesForDay(day),all=scheduleEntriesForDay(day,scheduleState.appointments),ids=[...new Set(all.map(entry=>entry.clinician_id))];
 const order=id=>{const index=scheduleProviders.findIndex(p=>p.id===id);return index<0?scheduleProviders.length:index;};
 ids.sort((a,b)=>order(a)-order(b)||String(a).localeCompare(String(b)));
 const pick=only=>({appointments:entries.filter(e=>e.kind==='appointment'&&(!only||e.clinician_id===only)),blocks:entries.filter(e=>e.kind==='block'&&(!only||e.clinician_id===only))});
 if(ids.length>1)return ids.map(id=>({day,provider:id,label:scheduleProviderName({clinician_id:id,provider_label:all.find(e=>e.clinician_id===id)?.provider_label})||'Provider',...pick(id)}));
 const provider=ids[0]||scheduleProvider||'';
 return [{day,provider,label:provider?scheduleProviderName({clinician_id:provider,provider_label:all[0]?.provider_label})||'Provider':'All providers',...pick('')}];
}
function scheduleWeekColumns(){
 return scheduleWeekDays().map(day=>{const entries=scheduleEntriesForDay(day);return {day,provider:scheduleProvider||'',label:scheduleDayLabel(day,{weekday:'short',month:'short',day:'numeric'}),weekday:true,appointments:entries.filter(e=>e.kind==='appointment'),blocks:entries.filter(e=>e.kind==='block')};});
}
function scheduleGridHtml(columns,variant){
 const range=scheduleGridRange(columns),today=scheduleToday(),hours=[],scale=scheduleZoomScale[scheduleZoom]||scheduleZoomScale.comfortable;
 for(let minute=range.first;minute<range.last;minute+=60)hours.push(minute);
 const count=column=>{const n=column.appointments.filter(a=>!scheduleClosed(a)).length;return n?scheduleCountLabel(n,'appointment'):'No appointments';};
 const head=columns.map(column=>`<div class="grid-col-head${column.day===today?' is-today':''}">${column.weekday?`<button type="button" class="grid-day-link" data-calendar-day="${column.day}" aria-label="Open ${esc(scheduleDayLabel(column.day))}">${esc(column.label)}</button>`:`<strong>${esc(column.label)}</strong>`}<small>${count(column)}</small>${canSchedule()?`<button type="button" class="grid-add" data-calendar-book="${column.day}" data-slot-provider="${esc(column.provider)}" aria-label="Book an appointment${column.weekday?' on '+esc(scheduleDayLabel(column.day)):column.provider?' with '+esc(column.label):''}">+</button>`:''}</div>`).join('');
 const body=columns.map(column=>{
  const cards=scheduleLayoutColumn(column.appointments,column.day).map(item=>`<div class="grid-item${(item.shownEnd-item.start)*scale<50?' is-short':''}${item.lanes>1?' is-narrow':''}" data-start="${item.start}" data-len="${item.shownEnd-item.start}" data-lane="${item.lane}" data-lanes="${item.lanes}">${scheduleCard(item.a,variant,column.day)}</div>`).join('');
  const blocks=column.blocks.map(block=>{const m=scheduleDayMinutes(block,column.day);return `<button type="button" class="grid-block" data-schedule-id="${esc(block.id)}" data-schedule-block="${esc(block.id)}" data-start="${m.start}" data-len="${m.end-m.start}" data-lane="0" data-lanes="1" title="${esc(scheduleBlockLabel(block))}"><strong>${esc(block.label)}</strong><small>${esc(scheduleClockRange(block))}${columns.length===1&&!column.weekday?'':' · '+esc(scheduleProviderName(block))}</small></button>`;}).join('');
  return `<div class="grid-col${column.day===today?' is-today':''}" data-grid-column data-grid-day="${column.day}" data-grid-provider="${esc(column.provider)}" role="group" aria-label="${esc(column.weekday?scheduleDayLabel(column.day):column.label)}"${canSchedule()?' title="Click an empty time to book an appointment"':''}>${blocks}${cards}${column.day===today?'<div class="grid-now" data-now-line hidden></div>':''}</div>`;
 }).join('');
 return `<section class="schedule-grid schedule-grid-${variant} zoom-${scheduleZoom}" data-first="${range.first}" data-last="${range.last}" data-columns="${columns.length}" aria-label="${variant==='week'?'Week':'Day'} schedule"><div class="grid-scroll"><div class="grid-inner"><div class="grid-head"><div class="grid-corner"></div>${head}</div><div class="grid-body"><div class="grid-axis" aria-hidden="true">${hours.map(minute=>`<span class="grid-hour" data-start="${minute}" data-len="60" data-lane="0" data-lanes="1">${esc(scheduleHourLabel(minute))}</span>`).join('')}</div>${body}</div></div></div></section>`;
}
function scheduleDayCalendar(){return scheduleGridHtml(scheduleDayColumns(),'day');}
function scheduleWeekCalendar(){return scheduleGridHtml(scheduleWeekColumns(),'week');}

// ---- Month and list views ------------------------------------------------
function scheduleMonthCalendar(){
 const days=scheduleCalendarDays(),today=scheduleToday(),month=scheduleDate.slice(0,7),monthLabel=scheduleDayLabel(scheduleDate,{month:'long',year:'numeric'});
 return `<section class="schedule-month" aria-label="${esc(monthLabel)}"><div class="calendar-scroll"><table class="month-calendar"><caption class="sr-only">${esc(monthLabel)} appointments and provider time blocks</caption><thead><tr>${days.slice(0,7).map(day=>`<th scope="col">${esc(scheduleDayLabel(day,{weekday:'short'}))}</th>`).join('')}</tr></thead><tbody>${Array.from({length:6},(_,week)=>`<tr>${days.slice(week*7,week*7+7).map(day=>{
  const entries=scheduleEntriesForDay(day),label=scheduleDayLabel(day),visits=entries.filter(e=>e.kind==='appointment').length;
  return `<td class="calendar-day ${day.slice(0,7)!==month?'outside-month ':''}${day===today?'calendar-today ':''}${day===scheduleDate?'calendar-selected':''}"><div class="calendar-date-row"><button type="button" data-calendar-day="${day}" aria-label="Open ${esc(label)}${visits?`, ${scheduleCountLabel(visits,'appointment')}`:''}" ${day===today?'aria-current="date"':''}>${Number(day.slice(-2))}</button>${canSchedule()?`<button type="button" class="calendar-add" data-calendar-book="${day}" aria-label="Book appointment on ${esc(label)}">+</button>`:''}</div><div class="calendar-events">${entries.slice(0,3).map(entry=>entry.kind==='block'?`<button type="button" class="calendar-event calendar-block" data-schedule-id="${esc(entry.id)}" data-schedule-block="${esc(entry.id)}"><span class="calendar-event-time">${esc(scheduleClock(entry.starts_at))}</span><strong>${esc(entry.label)}</strong><span>${esc(scheduleProviderName(entry))} unavailable</span></button>`:scheduleCard(entry,'compact',day)).join('')}${entries.length>3?`<button type="button" class="calendar-more" data-calendar-day="${day}" aria-label="${entries.length-3} more on ${esc(label)}">+${entries.length-3} more</button>`:''}</div></td>`;
 }).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}
function scheduleListView(){
 const days=Array.from({length:7},(_,i)=>{const d=new Date(`${scheduleDate}T12:00:00`);d.setDate(d.getDate()+i);return scheduleDayKey(d);});
 return days.map(day=>{
  const entries=scheduleEntriesForDay(day),visits=entries.filter(e=>e.kind==='appointment'&&!scheduleClosed(e)).length;
  return `<section class="schedule-day schedule-list-day"><h3>${esc(scheduleDayLabel(day))}${visits?`<small>${scheduleCountLabel(visits,'appointment')}</small>`:''}</h3><div class="schedule-list">${entries.map(entry=>entry.kind==='block'?`<button type="button" class="schedule-list-block" data-schedule-id="${esc(entry.id)}" data-schedule-block="${esc(entry.id)}"><span>${esc(scheduleClockRange(entry))}</span><strong>${esc(entry.label)}</strong><span>${esc(scheduleProviderName(entry))} unavailable</span></button>`:scheduleCard(entry,'row',day)).join('')||'<p class="schedule-list-empty">No appointments</p>'}</div></section>`;
 }).join('');
}

// ---- Page ------------------------------------------------------------------
let scheduleBatchMessage='';
function schedulePeriodLabel(){
 if(scheduleMode==='month')return scheduleDayLabel(scheduleDate,{month:'long',year:'numeric'});
 if(scheduleMode==='day')return scheduleDayLabel(scheduleDate);
 const days=scheduleMode==='week_grid'?scheduleWeekDays():[scheduleDate,(()=>{const d=new Date(`${scheduleDate}T12:00:00`);d.setDate(d.getDate()+6);return scheduleDayKey(d);})()];
 return `${scheduleDayLabel(days[0],{month:'short',day:'numeric'})} – ${scheduleDayLabel(days.at(-1),{month:'short',day:'numeric',year:'numeric'})}`;
}
// Shown only when the practice keeps a different time zone from this computer.
function scheduleZoneNote(){
 const mine=Intl.DateTimeFormat().resolvedOptions().timeZone,practice=scheduleHours?.timezone;
 if(!practice||practice===mine)return '';
 try{const now=new Date();if(scheduleZoneOffset(practice,now)===scheduleZoneOffset(mine,now))return '';}catch{return '';}
 return `Times are shown in this computer’s time zone (${mine}). The practice uses ${practice}.`;
}
function scheduleHeadHtml(){
 const views=[['day','Day'],['week_grid','Week'],['month','Month'],['week','List']],zone=scheduleZoneNote(),grid=['day','week_grid'].includes(scheduleMode);
 return `<div class="schedule-commandbar"><div><h2>Practice schedule</h2><p class="schedule-period">${esc(schedulePeriodLabel())}</p>${zone?`<p class="muted schedule-zone">${esc(zone)}</p>`:''}</div><div class="actions"><details class="schedule-more"><summary>More</summary><div class="schedule-more-menu"><button type="button" data-previsit-refresh>Intake readiness</button><button type="button" data-series-list>Recurring series</button><button type="button" data-reminder-workspace>Reminders</button></div></details>${canSchedule()?'<button type="button" data-new-block>Block time</button><button type="button" class="primary" data-new-appointment>+ Appointment</button>':''}</div></div>
 <form id="schedule-filter" class="schedule-toolbar"><div class="actions schedule-nav"><button type="button" data-schedule-shift="-1" aria-label="Previous ${scheduleMode==='month'?'month':scheduleMode==='day'?'day':'week'}">←</button><button type="button" data-schedule-today>Today</button><button type="button" data-schedule-shift="1" aria-label="Next ${scheduleMode==='month'?'month':scheduleMode==='day'?'day':'week'}">→</button></div><label>Date<input name="date" type="date" value="${esc(scheduleDate)}" required></label><div class="schedule-views" role="group" aria-label="View">${views.map(([key,label])=>`<button type="button" class="${scheduleMode===key?'is-on':''}" data-schedule-view="${key}" data-focus-key="view-${key}" aria-pressed="${scheduleMode===key}">${label}</button>`).join('')}</div><input type="hidden" name="view" value="${esc(scheduleMode)}"><label>Provider<select name="provider"><option value="">All providers</option>${scheduleProviders.map(p=>`<option value="${esc(p.id)}" ${scheduleProvider===p.id?'selected':''}>${esc(p.label)}</option>`).join('')}</select></label>${grid?`<div class="schedule-zoom" role="group" aria-label="Row height">${[['compact','Compact'],['comfortable','Comfortable']].map(([key,label])=>`<button type="button" class="${scheduleZoom===key?'is-on':''}" data-schedule-zoom="${key}" data-focus-key="zoom-${key}" aria-pressed="${scheduleZoom===key}">${label}</button>`).join('')}</div>`:''}</form>
 <div class="schedule-statusbar" id="schedule-statusbar">${scheduleSummaryHtml()}</div>`;
}
function scheduleBodyHtml(){return scheduleMode==='month'?scheduleMonthCalendar():scheduleMode==='week_grid'?scheduleWeekCalendar():scheduleMode==='week'?scheduleListView():scheduleDayCalendar();}
function renderSchedule(){
 rememberScheduleScroll();
 $('tools').innerHTML=`<section id="schedule-workspace"><div id="schedule-head">${scheduleHeadHtml()}</div><div class="schedule-layout"><div class="schedule-agenda" id="schedule-body">${scheduleBodyHtml()}</div><section id="schedule-detail" class="schedule-detail" aria-label="Appointment details" hidden></section></div></section>`;
 placeScheduleGrid();
}
// Redraws the header and the calendar but leaves an open appointment panel alone.
function repaintSchedule(){
 const head=$('schedule-head'),body=$('schedule-body');
 if(!scheduleState||!head||!body||head.isConnected===false){return;}
 const focus=typeof document.querySelector==='function'?document.activeElement?.dataset?.focusKey:'';
 rememberScheduleScroll();
 head.innerHTML=scheduleHeadHtml();body.innerHTML=scheduleBodyHtml();
 placeScheduleGrid();
 if(focus)Array.from(document.querySelectorAll('#schedule-head [data-focus-key]')).find(node=>node.dataset.focusKey===focus)?.focus({preventScroll:true});
}
// Markers fill in without redrawing the cards they sit on.
function paintScheduleMarkers(){
 if(!scheduleState)return;
 if(['forms_review','insurance_unchecked'].includes(scheduleFilter)||typeof document.querySelectorAll!=='function'){repaintSchedule();}
 else{
  const byId=new Map(scheduleState.appointments.map(a=>[a.id,a]));
  for(const host of document.querySelectorAll('#schedule-body [data-markers-for]')){const a=byId.get(host.dataset.markersFor);if(a)host.innerHTML=scheduleMarkersHtml(a,host.dataset.markersVariant);}
  const bar=$('schedule-statusbar');if(bar)bar.innerHTML=scheduleSummaryHtml();
 }
 const facts=$('appt-panel-facts'),open=scheduleState.appointments.find(a=>a.id===scheduleSelected);
 if(facts&&open&&facts.isConnected!==false&&$('schedule-detail')?.hidden===false)facts.innerHTML=schedulePanelFacts(open);
}
let scheduleScrollMemory={key:'',top:0,left:0};
function scheduleScrollKey(){return `${scheduleMode}|${scheduleDate}|${scheduleZoom}`;}
function rememberScheduleScroll(){
 if(typeof document.querySelector!=='function')return;
 const scroll=document.querySelector('#schedule-workspace .grid-scroll');
 if(scroll)scheduleScrollMemory={key:scheduleScrollKey(),top:scroll.scrollTop,left:scroll.scrollLeft};
}
// Geometry is written through the style API (inline style attributes are not allowed),
// in one pass of writes with no measuring in between.
function placeScheduleGrid(){
 if(typeof document.querySelector!=='function')return;
 const grid=document.querySelector('#schedule-workspace .schedule-grid');if(!grid)return;
 const first=Number(grid.dataset.first),last=Number(grid.dataset.last),scale=scheduleZoomScale[scheduleZoom]||scheduleZoomScale.comfortable;
 grid.style.setProperty('--minute',`${scale}px`);grid.style.setProperty('--grid-minutes',String(last-first));grid.style.setProperty('--grid-columns',grid.dataset.columns);
 for(const node of grid.querySelectorAll('[data-start]')){
  node.style.setProperty('--s',String(Number(node.dataset.start)-first));node.style.setProperty('--l',node.dataset.len);
  node.style.setProperty('--lane',node.dataset.lane);node.style.setProperty('--lanes',node.dataset.lanes);
 }
 placeScheduleNow();
 const scroll=grid.querySelector('.grid-scroll');if(!scroll)return;
 if(scheduleScrollMemory.key===scheduleScrollKey()){scroll.scrollTop=scheduleScrollMemory.top;scroll.scrollLeft=scheduleScrollMemory.left;return;}
 // Open on the current time today, otherwise on the first appointment of the day.
 const starts=Array.from(grid.querySelectorAll('.grid-item'),node=>Number(node.dataset.start)),now=new Date(),nowMinute=now.getHours()*60+now.getMinutes();
 const showsToday=grid.querySelector('[data-now-line]')&&nowMinute>=first&&nowMinute<=last;
 const target=showsToday?nowMinute-90:starts.length?Math.min(...starts)-30:first;
 scroll.scrollTop=Math.max(0,(target-first)*scale);
 scheduleScrollMemory={key:scheduleScrollKey(),top:scroll.scrollTop,left:0};
}
function placeScheduleNow(){
 if(typeof document.querySelector!=='function')return;
 const grid=document.querySelector('#schedule-workspace .schedule-grid');if(!grid)return;
 const first=Number(grid.dataset.first),last=Number(grid.dataset.last),now=new Date(),minute=now.getHours()*60+now.getMinutes();
 for(const line of grid.querySelectorAll('[data-now-line]')){line.hidden=minute<first||minute>last||line.closest('[data-grid-day]')?.dataset.gridDay!==scheduleToday();line.style.setProperty('--s',String(minute-first));}
}
// The panel sits under the page header however many lines that header wraps to.
function placeSchedulePanel(panel){
 if(typeof document.querySelector!=='function'||typeof getComputedStyle!=='function')return;
 const header=document.querySelector('.workspace-header');panel.style.removeProperty('top');
 if(!header||getComputedStyle(panel).position!=='fixed'||getComputedStyle(header).position!=='sticky')return;
 panel.style.setProperty('top',`${Math.max(0,Math.round(header.getBoundingClientRect().bottom))}px`);
}
function scheduleGridTimeAt(column,offsetY){
 const grid=column.closest('.schedule-grid'),scale=scheduleZoomScale[scheduleZoom]||scheduleZoomScale.comfortable;
 const minute=Math.min(1425,Math.max(0,Math.floor((Number(grid.dataset.first)+offsetY/scale)/15)*15));
 return `${column.dataset.gridDay}T${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
}

// ---- Appointment panel -----------------------------------------------------
let scheduleIntakeLink=null;
function schedulePanelRow(label,state,tone,actions=''){
 return `<div class="appt-fact"><dt>${esc(label)}</dt><dd><span class="appt-fact-state${tone?' tone-'+tone:''}">${esc(state)}</span>${actions?`<span class="appt-fact-actions">${actions}</span>`:''}</dd></div>`;
}
function schedulePanelButton(action,a,label,primary=false){return `<button type="button"${primary?' class="primary"':''} data-board-action="${action}" data-appointment="${esc(a.id)}">${esc(label)}</button>`;}
// Forms, insurance, payment, note and charges for the open appointment.
function schedulePanelFacts(a){
 const m=scheduleMarker(a.id);
 if(!m)return scheduleMarkerState.failed?'<p class="muted">Forms, insurance and payment details could not be loaded.</p>':scheduleMarkerState.loaded?'':'<p class="muted" role="status">Loading forms, insurance and payment details…</p>';
 const markers=new Map(scheduleMarkerList(a).map(marker=>[marker.kind,marker])),closed=scheduleClosed(a),open=['booked','checked_in'].includes(a.status),rows=[];
 const forms=markers.get('forms'),canSend=open&&scheduleCanSendForms();
 if(!closed)rows.push(schedulePanelRow('Intake form',forms?forms.tip:'No intake form has been sent.',forms?.tone,m.forms?.status==='submitted'?schedulePanelButton('review-intake',a,'Review answers'):m.forms?.status==='reviewed'?schedulePanelButton('review-intake',a,'View answers'):canSend?schedulePanelButton('send-intake',a,m.forms?'Send a new link':'Send intake form'):''));
 if(m.insurance&&!closed){
  const insurance=markers.get('insurance'),checked=m.insurance.checked_at?` Checked ${scheduleWhen(m.insurance.checked_at)}.`:'';
  rows.push(schedulePanelRow('Insurance',insurance.tip+checked,insurance.tone,(m.insurance.coverage_id&&!closed&&scheduleCanCheckInsurance()?schedulePanelButton('check-eligibility',a,m.insurance.status==='not_checked'?'Check eligibility':'Check again'):'')+schedulePanelButton('insurance',a,m.insurance.status==='self_pay'?'Add insurance':'Open insurance')));
 }
 if('copay' in m&&(!closed||markers.has('copay'))){
  const copay=markers.get('copay'),paid=Number(m.copay?.paid_cents)>0||Number(m.copay?.test_paid_cents)>0;
  rows.push(schedulePanelRow('Copay',copay?copay.tip:'No copay is recorded for this visit.',copay?.tone,(!closed&&scheduleCanBill()&&copay?.tone!=='green'?schedulePanelButton('collect-copay',a,'Collect copay'):'')+(paid?schedulePanelButton('collect-copay',a,'View receipt'):'')));
 }
 if('balance_cents' in m){const balance=markers.get('balance');rows.push(schedulePanelRow('Balance',balance?`${balance.label}. ${balance.tip}`:'Nothing owed from earlier invoices.',balance?.tone,balance?schedulePanelButton('billing',a,'Open billing'):''));}
 if(markers.has('note')){const note=markers.get('note');rows.push(schedulePanelRow('Visit note',note.tip,note.tone,m.visit_id?schedulePanelButton('visit',a,'Open note'):''));}
 if(markers.has('charges')){const charges=markers.get('charges');rows.push(schedulePanelRow('Charges',charges.tip,charges.tone,m.visit_id&&scheduleAllowed('billing')?schedulePanelButton('charges',a,'Open charges'):''));}
 return rows.join('');
}
function schedulePanelNext(a){
 const m=scheduleMarker(a.id);
 if(a.status==='booked'&&canSchedule())return schedulePanelButton('check-in',a,'Check in',true);
 if(a.status==='checked_in'&&scheduleCanStartVisit(a))return `<button type="button" class="primary" data-schedule-start="${esc(a.id)}" data-patient="${esc(a.patient_id)}">Start visit</button>`;
 if(['in_progress','completed'].includes(a.status)&&m?.visit_id&&scheduleAllowed('clinical'))return schedulePanelButton('visit',a,a.status==='completed'?'Open visit':'Continue visit',a.status==='in_progress');
 return '';
}
function schedulePanelLink(a){
 const link=scheduleIntakeLink;if(!link||link.identity!==me||link.appointment!==a.id)return '';
 const mail=typeof patientIntakeMailto==='function'?patientIntakeMailto(a.patient_id,link.url,link.practice):'';
 return `<section class="mapping-notice intake-link" aria-live="polite"><h4>Send this link to the patient</h4><p>This link is shown only now. Copy or email it before you close this panel. It works until ${esc(scheduleWhen(link.expires))}.${link.replaced?' The earlier link no longer works.':''}</p><div class="actions"><button type="button" class="primary" data-board-action="copy-link" data-appointment="${esc(a.id)}">Copy link</button>${mail?`<a class="button" href="${esc(mail)}">Email the link</a>`:''}<button type="button" data-board-action="link-done" data-appointment="${esc(a.id)}">Done</button></div><label class="card-setup-link" hidden>Intake form link<input readonly value="${esc(link.url)}" data-schedule-intake-link></label></section>`;
}
function schedulePanelHtml(a,patientName,history){
 const provider=scheduleProviderName(a),place=[a.facility,a.room?'Room '+a.room:''].filter(Boolean).join(' · '),next=schedulePanelNext(a);
 const canAct=canSchedule()&&['booked','checked_in'].includes(a.status),late=a.status==='booked'&&new Date(a.starts_at)<=new Date();
 return `<div class="appt-panel status-${esc(a.status)}"><div class="appt-panel-head"><div><h2>${esc(patientName||'Patient appointment')}</h2><p class="appt-panel-when">${esc(scheduleDayLabel(localTime(a.starts_at).slice(0,10),{weekday:'short',month:'short',day:'numeric'}))} · ${esc(scheduleClockRange(a))}</p><p class="muted">${esc(scheduleVisitTitle(a))}${provider?' · '+esc(provider):''}${place?' · '+esc(place):''}${a.source_history_id?' · Imported':''}</p></div><span class="appt-status-pill status-${esc(a.status)}">${esc(scheduleStatusLabel(a.status))}</span></div>
 <p class="appt-panel-allergies" id="appt-panel-allergies" hidden></p>
 <div class="actions appt-panel-next">${next}<button type="button" data-schedule-chart="${esc(a.patient_id)}" data-appointment="${esc(a.id)}">Open chart</button></div>
 <dl class="appt-panel-facts" id="appt-panel-facts">${schedulePanelFacts(a)}</dl><div id="appt-panel-link">${schedulePanelLink(a)}</div>
 ${a.notes?`<p class="note-text">${esc(a.notes)}</p>`:''}
 ${canSchedule()&&a.status==='booked'?`<div class="actions"><button type="button" data-schedule-edit="${esc(a.id)}">Reschedule or edit</button>${['week_grid','day'].includes(scheduleMode)?`<button type="button" data-schedule-pick-move="${esc(a.id)}">Pick a new time on the calendar</button>`:''}</div>`:''}
 ${canAct?`<details class="appt-panel-cancel"><summary>Cancel${late?' or mark as no-show':''}</summary><form id="schedule-action" data-id="${esc(a.id)}" data-version="${a.version}"><label>What happened<select name="action"><option value="cancel">Cancel appointment</option>${late?'<option value="no_show">Patient did not show up</option>':''}</select></label><label>Reason<input name="reason" required maxlength="1000"></label><button type="submit">Save</button></form></details>`:''}
 <details class="appt-panel-history"><summary>Appointment history</summary>${history.map(r=>`<div class="amendment"><p><b>${esc(scheduleStatusLabel(r.snapshot.status))}</b> · ${esc(r.reason)}</p><p>${esc(scheduleWhen(r.snapshot.starts_at))} – ${esc(scheduleClock(r.snapshot.ends_at))} · ${esc(r.snapshot.title)}${r.snapshot.facility?' · '+esc(r.snapshot.facility):''}${r.snapshot.room?' '+esc(r.snapshot.room):''}</p><small>Recorded ${esc(scheduleWhen(r.created_at))}</small></div>`).join('')||'<p class="muted">No changes recorded.</p>'}</details>
 <details class="appt-panel-reminders"><summary>Reminders and repeat visits</summary><div id="appointment-extras"></div></details></div>`;
}
// One line about allergies, read when the panel opens.
async function loadSchedulePanelAllergies(a){
 if(!scheduleAllowed('clinical'))return;
 let clinical;try{clinical=await api(`/api/v1/patients/${a.patient_id}/clinical`);}catch{return;}
 const host=$('appt-panel-allergies');if(!host||scheduleSelected!==a.id||host.isConnected===false)return;
 // The same wording and rules as the patient banner in the chart.
 let names,text;
 if(typeof patientBannerAllergies==='function'){const found=patientBannerAllergies(clinical);names=found.names;text=found.text;}
 else{
  names=(clinical.items||[]).filter(e=>e.kind==='allergy'&&e.content?.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification)).map(e=>e.content.title);
  const review=(clinical.reviews||[]).find(r=>r.kind==='allergy')?.review_state;
  text=review==='no_known'?'No known allergies':review==='reviewed'?'No allergies recorded':'Allergies not reviewed';
 }
 host.textContent=names.length?`Allergies: ${names.join(', ')}`:text;
 host.className=`appt-panel-allergies${names.length?' has-allergies':''}`;host.hidden=false;
}
async function scheduleOpenChartStep(a,section,focusId){
 await showClinical();await selectPatient(a.patient_id);
 if(typeof selected==='undefined'||selected!==a.patient_id)return;
 if(section==='insurance'&&typeof insuranceAppointmentSelection!=='undefined'&&workspace?.appointments?.some(row=>row.id===a.id))insuranceAppointmentSelection.set(a.patient_id,a.id);
 showChartSection(section);
 const target=focusId?$(focusId):null;if(target&&target.isConnected!==false){target.scrollIntoView?.({block:'start'});target.focus?.({preventScroll:true});}
}
async function scheduleOpenVisit(a,section){
 const visit=scheduleMarker(a.id)?.visit_id;if(!visit)throw new Error('No visit has been started for this appointment yet.');
 await showClinical();await selectPatient(a.patient_id,visit);
 if(section&&typeof setEncounterSection==='function'&&typeof activeVisit!=='undefined'&&activeVisit?.id===visit)setEncounterSection(section);
}
async function scheduleRefreshAfter(a){await showSchedule();if(a)await appointmentDetail(a.id);}
async function scheduleSendIntake(a){
 if(!scheduleCanSendForms())throw new Error('Your role cannot send intake forms.');
 const identity=me,saved=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/intake-forms`,'POST',{appointment_id:a.id});
 if(me!==identity||typeof saved?.intake_url!=='string')return;
 scheduleIntakeLink={identity,appointment:a.id,url:`${location.origin}${saved.intake_url}`,expires:saved.expires_at,replaced:Number(saved.replaced)>0,practice:saved.practice_name};
 await scheduleRefreshAfter(a);
 notice('The intake form link is ready. Copy or email it now; it is not shown again.');
}
async function scheduleCheckEligibility(a){
 const coverage=scheduleMarker(a.id)?.insurance?.coverage_id;
 if(!coverage||!scheduleCanCheckInsurance())throw new Error('There is no active insurance to check for this visit.');
 const reply=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/coverages/${encodeURIComponent(coverage)}/claimmd-eligibility/check`,'POST',{request_id:crypto.randomUUID(),automatic:false,appointment_id:a.id});
 if(reply?.outcome==='needs'){await scheduleOpenChartStep(a,'insurance','insurance-review-title');notice('The insurer needs a little more information before this check can run. Finish it here.');return;}
 await scheduleRefreshAfter(a);await scheduleMarkersReady;
 const status=scheduleMarker(a.id)?.insurance?.status;
 notice({active:'Insurance is active.',not_active:'The insurer says this coverage is not active.'}[status]||'The check finished but could not confirm coverage. Open insurance to see why.',status!=='active');
}
// Runs the one-click check for every visit on the day that still needs one, one at a
// time. The server decides what is worth asking and enforces its own request limit.
async function scheduleCheckDayInsurance(){
 if(!scheduleCanCheckInsurance())throw new Error('Your role cannot check insurance.');
 const seen=new Set(),targets=scheduleState.appointments.filter(a=>{const m=scheduleMarker(a.id),coverage=m?.insurance?.coverage_id;if(!coverage||seen.has(coverage)||!scheduleFilterMatches(a,'insurance_unchecked'))return false;seen.add(coverage);return true;});
 if(!targets.length){notice('Every visit on this day already has an insurance check.');return;}
 const say=text=>{scheduleBatchMessage=text;const host=$('schedule-batch-status');if(host)host.textContent=text;};
 const asked=[];let unable=0,limited=false;
 for(const [index,a] of targets.entries()){
  say(`Checking insurance… ${index+1} of ${targets.length}`);
  if(limited){unable++;continue;}
  try{
   const reply=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/coverages/${encodeURIComponent(scheduleMarker(a.id).insurance.coverage_id)}/claimmd-eligibility/check`,'POST',{request_id:crypto.randomUUID(),automatic:true,appointment_id:a.id});
   if(reply?.outcome==='checked'||(reply?.outcome==='skipped'&&reply.reason==='recent_check'))asked.push(a.id);
   else{unable++;if(reply?.reason==='rate_limited')limited=true;}
  }catch(error){if(me===undefined||error.status===401)throw error;unable++;}
 }
 say('');await showSchedule();await scheduleMarkersReady;
 let checked=0,inactive=0;
 for(const id of asked){const status=scheduleMarker(id)?.insurance?.status;if(status==='active')checked++;else if(status==='not_active'){checked++;inactive++;}else unable++;}
 const summary=`${checked} checked · ${inactive} not active · ${unable} could not be checked${limited?' (the insurer request limit was reached; try the rest later)':''}`;
 say(summary);const host=$('schedule-batch-status');if(host)host.textContent=summary;
 notice(`Insurance check finished: ${summary}.`,unable>0||inactive>0);
}
function scheduleCopyIntakeLink(button){
 const link=scheduleIntakeLink?.identity===me?scheduleIntakeLink.url:'';if(!link)return;
 const show=()=>{const field=button.closest('section')?.querySelector('[data-schedule-intake-link]');if(!field)return;field.closest('label').hidden=false;field.focus();field.select();button.textContent='Copy it from the box below';};
 Promise.resolve().then(()=>navigator.clipboard?.writeText?navigator.clipboard.writeText(link):Promise.reject(new Error('unavailable'))).then(()=>{button.textContent='Link copied';},show);
}
// Where each marker leads.
async function scheduleMarkerOpen(a,kind){
 const m=scheduleMarker(a.id);
 if(kind==='forms'&&m?.forms?.status==='submitted'&&typeof openWorkflowIntakePacket==='function'){await openWorkflowIntakePacket(m.forms.packet_id);return;}
 if(kind==='copay'&&!scheduleClosed(a)&&scheduleAllowed('billing')&&Number(m?.copay?.due_cents)>Number(m?.copay?.paid_cents)){await scheduleOpenChartStep(a,'insurance','insurance-copay-title');return;}
 if(kind==='balance'&&scheduleAllowed('billing')){await scheduleOpenChartStep(a,'billing');return;}
 if(kind==='note'&&m?.visit_id&&scheduleAllowed('clinical')){await scheduleOpenVisit(a);return;}
 if(kind==='charges'&&m?.visit_id&&scheduleAllowed('billing')&&scheduleAllowed('clinical')){await scheduleOpenVisit(a,'charges');return;}
 await appointmentDetail(a.id);
}
// Called by the schedule's click handler before its own rules. Returns true when handled.
async function scheduleBoardClick(b){
 const d=b.dataset;
 if(d.scheduleView){if(!scheduleModes.has(d.scheduleView))return true;scheduleMode=d.scheduleView;scheduleFilter='all';saveSchedulePreference();await showSchedule();return true;}
 if(d.scheduleFilter){scheduleFilter=scheduleFilter===d.scheduleFilter?'all':d.scheduleFilter;repaintSchedule();return true;}
 if(d.scheduleZoom){scheduleZoom=d.scheduleZoom==='compact'?'compact':'comfortable';saveSchedulePreference('zoom');repaintSchedule();return true;}
 if(d.marker){const a=scheduleState.appointments.find(row=>row.id===d.markerAppointment);if(a)await scheduleMarkerOpen(a,d.marker);return true;}
 if(!d.boardAction)return false;
 if(d.boardAction==='check-day-insurance'){await scheduleCheckDayInsurance();return true;}
 const a=scheduleState.appointments.find(row=>row.id===d.appointment);if(!a)throw new Error('Reload the schedule and open the appointment again.');
 switch(d.boardAction){
  case 'check-in':if(!canSchedule()||a.status!=='booked')throw new Error('Only a booked appointment can be checked in.');await api(`/api/v1/appointments/${encodeURIComponent(a.id)}/check-in`,'POST');await scheduleRefreshAfter(a);notice('Patient checked in.');break;
  case 'visit':await scheduleOpenVisit(a);break;
  case 'charges':await scheduleOpenVisit(a,'charges');break;
  case 'send-intake':await scheduleSendIntake(a);break;
  case 'review-intake':{const packet=scheduleMarker(a.id)?.forms?.packet_id;if(!packet||typeof openWorkflowIntakePacket!=='function')throw new Error('Reload the schedule and open the form again.');await openWorkflowIntakePacket(packet);break;}
  case 'check-eligibility':await scheduleCheckEligibility(a);break;
  case 'collect-copay':await scheduleOpenChartStep(a,'insurance','insurance-copay-title');break;
  case 'insurance':await scheduleOpenChartStep(a,'insurance','insurance-review-title');break;
  case 'billing':await scheduleOpenChartStep(a,'billing');break;
  case 'copy-link':scheduleCopyIntakeLink(b);break;
  case 'link-done':{scheduleIntakeLink=null;const host=$('appt-panel-link');if(host)host.innerHTML='';break;}
 }
 return true;
}

// Clicking an empty time books there; with a move in hand it reviews the move instead.
document.addEventListener('click',e=>{
 const column=e.target?.closest?.('[data-grid-column]');
 if(!column||(e.target!==column&&!e.target.hasAttribute?.('data-now-line'))||!canSchedule())return;
 const offset=e.target===column?e.offsetY:e.offsetY+e.target.offsetTop,time=scheduleGridTimeAt(column,offset),provider=column.dataset.gridProvider;
 run(async()=>{
  if(scheduleDrag){const drag=scheduleDrag;scheduleDrag=undefined;await reviewScheduleMove(drag.id,time,provider||drag.provider,drag.version);return;}
  scheduleSelected=undefined;await appointmentEditor(null,null,null,column.dataset.gridDay,time,provider||undefined);
 });
});
// Arrow keys walk the cards of the grid; Tab and Enter work as on any button.
document.addEventListener('keydown',e=>{
 if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key))return;
 const card=e.target?.closest?.('.schedule-grid .appt-card-main');if(!card)return;
 const column=card.closest('[data-grid-column]'),columns=Array.from(card.closest('.schedule-grid').querySelectorAll('[data-grid-column]'));
 const cardsOf=col=>Array.from(col.querySelectorAll('.grid-item')).sort((a,b)=>Number(a.dataset.start)-Number(b.dataset.start)||Number(a.dataset.lane)-Number(b.dataset.lane)).map(item=>item.querySelector('.appt-card-main'));
 const own=cardsOf(column),index=own.indexOf(card);let next;
 if(e.key==='ArrowDown')next=own[index+1];else if(e.key==='ArrowUp')next=own[index-1];
 else{
  const step=e.key==='ArrowRight'?1:-1,start=Number(card.closest('.grid-item').dataset.start);
  for(let i=columns.indexOf(column)+step;i>=0&&i<columns.length&&!next;i+=step){const others=cardsOf(columns[i]);next=others.sort((a,b)=>Math.abs(Number(a.closest('.grid-item').dataset.start)-start)-Math.abs(Number(b.closest('.grid-item').dataset.start)-start))[0];}
 }
 if(next){e.preventDefault();next.focus();}
});
document.addEventListener('click',e=>{
 if(typeof document.querySelectorAll!=='function')return;
 for(const menu of document.querySelectorAll('#schedule-workspace details.schedule-more[open]'))if(!menu.contains(e.target)||e.target.closest?.('.schedule-more-menu button'))menu.open=false;
});
document.addEventListener('keydown',e=>{
 if(e.key!=='Escape'||typeof document.querySelector!=='function')return;
 const menu=document.querySelector('#schedule-workspace details.schedule-more[open]');if(menu){menu.open=false;menu.querySelector('summary')?.focus();}
});

// ---- Keeping the page current ---------------------------------------------
// Every two minutes, and when the tab is looked at again, the schedule and its markers
// are read again, unless someone is in the middle of something.
let scheduleLastRefresh=0;
function scheduleIdle(){
 if(typeof me==='undefined'||!me||typeof busy!=='undefined'&&busy)return false;
 const page=$('schedule-workspace'),panel=$('schedule-detail');
 if(!page||page.isConnected===false||$('tools')?.hidden||!panel||panel.hidden===false||document.visibilityState==='hidden'||scheduleDrag||scheduleBatchMessage.startsWith('Checking'))return false;
 const active=document.activeElement;
 return !(active&&active.closest?.('#schedule-workspace')&&/^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName))&&!document.querySelector?.('#schedule-workspace details.schedule-more[open]');
}
async function refreshScheduleQuietly(){
 if(!scheduleState||!scheduleIdle())return;
 scheduleLastRefresh=Date.now();rememberScheduleScroll();
 // Whoever is tabbing through the page keeps their place.
 const active=typeof document.querySelector==='function'?document.activeElement:null,card=active?.closest?.('[data-schedule-id]')?.dataset.scheduleId,key=active?.dataset?.focusKey;
 try{await showSchedule({quiet:true});}catch{return;}
 if(card)Array.from(document.querySelectorAll('#schedule-body [data-schedule-id]')).find(node=>node.dataset.scheduleId===card)?.querySelector('button')?.focus({preventScroll:true});
 else if(key)Array.from(document.querySelectorAll('#schedule-head [data-focus-key]')).find(node=>node.dataset.focusKey===key)?.focus({preventScroll:true});
}
if(typeof setInterval==='function'){
 setInterval(()=>{placeScheduleNow();if(Date.now()-scheduleLastRefresh>=120000)void refreshScheduleQuietly();},60000);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden'&&Date.now()-scheduleLastRefresh>=60000)void refreshScheduleQuietly();});
}
