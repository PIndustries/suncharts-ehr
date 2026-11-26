// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The schedule board: one appointment card shared by the day, week, month and list
// views, the markers that say what each encounter still needs, and the appointment panel.
// Appointments are drawn first; markers arrive from one read per visible range.

const scheduleStatusLabels={booked:'Booked',checked_in:'Checked in',in_progress:'In progress',completed:'Completed',cancelled:'Cancelled',no_show:'No-show'};
const scheduleZoomScale={comfortable:1.6,compact:1.6}; // pixels per minute
const scheduleMinimumCardHeight=24;
const scheduleTwoLineHeight=46;
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
function scheduleVisitTitle(a){return a.title&&a.title!==a.category?a.title:(a.category||a.title||'Encounter');}
function scheduleProviderName(entry){
 const listed=scheduleProviders.find(p=>p.id===entry.clinician_id)?.label||'',recorded=entry.provider_label||'';
 // A name wins over a sign-in email wherever either source has one.
 return typeof displayPerson==='function'?displayPerson(listed,displayPerson(recorded,listed)):listed||recorded;
}
function scheduleClock(value){return typeof displayTime==='function'?displayTime(value):new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(value));}
function scheduleWhen(value){return typeof displayDateTime==='function'?displayDateTime(value):date(value);}
function scheduleClockRange(entry){return `${scheduleClock(entry.starts_at)} – ${scheduleClock(entry.ends_at)}`;}
const scheduleMoneyFormatter=new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2});
const scheduleMoneyWholeFormatter=new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',minimumFractionDigits:0,maximumFractionDigits:0});
function scheduleMoney(cents){return cents%100?scheduleMoneyFormatter.format(cents/100):scheduleMoneyWholeFormatter.format(cents/100);}
function scheduleDayLabel(day,options={weekday:'long',month:'long',day:'numeric',year:'numeric'}){return new Date(`${day}T12:00:00`).toLocaleDateString(undefined,options);}
function scheduleClosed(a){return ['cancelled','no_show'].includes(a.status);}
function scheduleAllowed(resource,action='view'){return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource,action);}
function scheduleCanBill(){return ['owner','clinician','front_desk'].includes(me?.role)&&scheduleAllowed('billing','create');}
function scheduleCanSendForms(){return ['owner','clinician','front_desk'].includes(me?.role);}
function scheduleCanCheckInsurance(){return ['owner','clinician','front_desk'].includes(me?.role)&&scheduleAllowed('billing','create')&&scheduleAllowed('claims','create');}
function scheduleCanStartVisit(a){return scheduleAllowed('clinical')&&(['nurse','medical_assistant'].includes(me?.role)||(['owner','clinician'].includes(me?.role)&&a.clinician_id===me.user_id));}

// ---- Markers -------------------------------------------------------------
let scheduleMarkerState={key:'',items:new Map(),loaded:false,failed:false};
let scheduleChartMarker;
function scheduleMarkerKey(bounds,provider){return [me?.tenant_id||'',me?.user_id||'',bounds.start,bounds.end,provider||''].join('|');}
function currentChartMarker(id){
 return scheduleChartMarker?.appointment===id&&scheduleChartMarker.identity===me&&selected===scheduleChartMarker.patient&&$('clinical-workspace')?.hidden===false;
}
function scheduleMarker(id){return currentChartMarker(id)?scheduleChartMarker.item:scheduleMarkerState.items.get(id);}
async function loadScheduleMarkers(ranges,provider,generation){
 const identity=me,bounds={start:ranges[0].start,end:ranges.at(-1).end},key=scheduleMarkerKey(bounds,provider);
 // A different range starts empty; the same range keeps what it shows until fresh facts arrive.
 if(scheduleMarkerState.key!==key){scheduleMarkerState={key,items:new Map(),loaded:false,failed:false};}
 let pages;
 try{pages=await Promise.all(ranges.map(range=>api(`/api/v1/schedule/markers?${new URLSearchParams({from:range.start,to:range.end,...(provider?{provider}:{})})}`)));}
 catch{if(generation===scheduleLoadGeneration&&me===identity&&scheduleMarkerState.key===key){scheduleMarkerState.failed=true;paintScheduleMarkers();}return;}
 if(generation!==scheduleLoadGeneration||me!==identity||scheduleMarkerState.key!==key)return;
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
  const forms={sent:['Forms sent','grey','Intake form sent. The patient has not started it yet.',8],in_progress:['Forms started','grey','The patient started the intake form but has not sent it in.',8],submitted:['Forms in','info','The patient filled in the intake form. It needs review.',3],reviewed:['Forms done','green','The intake form was reviewed.',20],not_needed:['No form needed','grey','No intake form is needed for this encounter.',20]}[m.forms?.status];
 if(forms)add('forms',...forms);
 const insurance={active:['Active','green','Insurance is active.',20],not_active:['Not active','red','The insurer says this coverage is not active.',1],not_checked:['Insurance not checked','amber','Insurance has not been checked for this encounter.',7],check_failed:['Check failed','red','The last insurance check could not confirm coverage.',4],self_pay:['Self-pay','grey','No active insurance is on file for this encounter date.',21]}[m.insurance?.status];
 if(insurance)add('insurance',...insurance);
 }
 if(m.copay){
  const due=Number(m.copay.due_cents)||0,paid=Number(m.copay.paid_cents)||0,test=Number(m.copay.test_paid_cents)||0;
  if(paid>0&&paid>=due)add('copay','Copay paid','green',`${scheduleMoney(paid)} copay received.`,20);
  else if(test>0&&paid+test>=due)add('copay','Copay paid (test)','grey','Paid with a test card. No money was received.',10);
  // Test-card money is not money received, so it never shrinks what is due; it is only named.
  else if(due>paid&&!closed)add('copay',`Copay ${scheduleMoney(due-paid)} due`,'amber',(paid?`${scheduleMoney(paid)} of the ${scheduleMoney(due)} copay was received.`:`The plan’s copay of ${scheduleMoney(due)} has not been collected.`)+(test>0?` ${scheduleMoney(test)} was paid with a test card.`:''),2);
 }
 if(Number(m.balance_cents)>0)add('balance',`Owes ${scheduleMoney(Number(m.balance_cents))}`,'amber','The patient owes this from earlier visits. Money still with insurance is not counted.',6);
 if(started&&'note' in m){
  const note={signed:['Note signed','green','The encounter note is signed.',20],in_progress:['Note in progress',done?'amber':'grey',done?'The encounter is finished but its note is not signed.':'The encounter note has been started.',done?5:11]}[m.note]||['Note not started',done?'amber':'grey',done?'The encounter is finished but no note was written.':'The encounter note has not been started.',done?5:11];
  add('note',...note);
 }
 if(started&&'charges' in m){
   if(m.charges==='posted')add('charges','Charges posted','green','Charges for this encounter are posted.',20);
   else if(m.charges==='draft')add('charges','Charges draft',done?'amber':'grey','Charges were entered but are not posted yet.',done?5:11);
   else if(done)add('charges','No charges','amber','The encounter is finished but no charges were entered.',5);
  }
  // Keep the encounter claim state alongside the other recorded facts.
  if(m.claim){
   const claim={not_sent:['Claim not sent','red','Charges are posted but the claim has not been sent.',2],sent:['Claim sent','grey','The claim was sent. No answer yet.',2],accepted:['Claim accepted','green','The insurer accepted the claim for processing.',2],rejected:['Claim rejected','red','The insurer rejected the claim. It needs fixing and resending.',1],answered:['Insurer answered','green','The insurer has answered. Check the payment.',2]}[m.claim.status];
   if(claim)add('claim',...claim);
  }
 return out;
}
function scheduleMarkerHtml(a,marker){
 return `<button type="button" class="appt-marker tone-${marker.tone}" data-marker="${marker.kind}" data-marker-appointment="${esc(a.id)}" title="${esc(marker.tip)}">${scheduleIcon(marker.kind)}<span>${esc(marker.label)}</span></button>`;
}
// Every recorded status stays on the appointment block.
const scheduleToneOrder={red:0,amber:1,info:2,grey:3,green:4};
function scheduleMarkersHtml(a,variant='day'){
 const shown=scheduleMarkerList(a).sort((x,y)=>x.rank-y.rank||scheduleToneOrder[x.tone]-scheduleToneOrder[y.tone]);
 const grid=['day','week'].includes(variant);
 return (grid?`<span class="appt-grid-type">${esc(scheduleVisitTitle(a))}</span>`:'')+(grid?shown.slice(0,2):shown).map(marker=>scheduleMarkerHtml(a,marker)).join('')+(grid&&shown.length>2?`<span class="appt-more-markers">+${shown.length-2}</span>`:'');
}
function scheduleInitials(name){return String(name||'').replace(/^Dr\.?\s+/i,'').split(/[\s,]+/).filter(Boolean).slice(0,2).map(word=>word[0]).join('').toUpperCase();}
function scheduleDuration(a){return Math.round((new Date(a.ends_at)-new Date(a.starts_at))/60000);}
// ---- The appointment card ------------------------------------------------
function scheduleCardTitle(a){return [scheduleClockRange(a),a.patient_name,scheduleVisitTitle(a),scheduleProviderName(a),scheduleStatusLabel(a.status),...scheduleMarkerList(a).map(m=>`${m.label}: ${m.tip}`)].filter(Boolean).join(', ');}
function scheduleMarkerCountHtml(markers){return markers.length?`<span class="appt-marker-count" aria-hidden="true" title="${esc(markers.map(m=>m.label).join(', '))}">+${markers.length}</span>`:'';}
function scheduleCard(a,variant='day',day=''){
 const title=scheduleVisitTitle(a),movable=variant==='week'&&canSchedule()&&a.status==='booked';
 const clock=scheduleClock(a.starts_at).replace(/\s*[AP]M$/i,''),duration=scheduleDuration(a),provider=scheduleProviderName(a),status=scheduleStatusLabel(a.status);
 const accessibleLabel=[a.patient_name,scheduleClockRange(a),`${duration} min`,title,provider,status].filter(Boolean).join(', ');
 return `<article class="appt-card appt-${variant} status-${esc(a.status)} type-${scheduleVisitType(a)}${a.id===scheduleSelected?' is-selected':''}" data-schedule-id="${esc(a.id)}" title="${esc(scheduleCardTitle(a))}"><button type="button" class="appt-card-main" data-schedule-open="${esc(a.id)}" aria-label="${esc(accessibleLabel)}"${movable?` draggable="true" data-drag-appointment="${esc(a.id)}"`:''}><span class="appt-clock">${esc(clock)} ·</span><strong class="appt-patient">${esc(a.patient_name)}</strong><span class="appt-meta">${esc(clock)} · ${duration}m · ${esc(title)} · ${esc(provider)}</span><span class="appt-status-pill">${esc(status)}</span>${scheduleMarkerCountHtml(scheduleMarkerList(a))}</button><div class="appt-markers" data-markers-for="${esc(a.id)}" data-markers-variant="${variant}">${scheduleMarkersHtml(a,variant)}</div></article>`;
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
   case 'claim_not_sent':return m?.claim?.status==='not_sent';
   case 'claim_rejected':return m?.claim?.status==='rejected';
   case 'active':return !scheduleClosed(a);
  default:return true;
 }
}
function scheduleRailProviders(){return [...scheduleProviders,...[...new Map([...scheduleState.appointments,...scheduleState.blocks].filter(a=>!scheduleProviders.some(p=>p.id===a.clinician_id)).map(a=>[a.clinician_id,{id:a.clinician_id,label:a.provider_label||'Unmapped provider'}])).values()]];}
function scheduleProviderVisible(id){return scheduleUnfiltered||(scheduleProvider?id===scheduleProvider:!scheduleHiddenProviders.has(id));}
function scheduleLocationEnabled(location){return scheduleUnfiltered||!scheduleHiddenLocations.has(location);}
function scheduleLocationVisible(a){return scheduleLocationEnabled(a.facility||'No location');}
function scheduleVisibleAppointments(){return scheduleState.appointments.filter(a=>scheduleProviderVisible(a.clinician_id)&&scheduleLocationVisible(a));}
function scheduleShownAppointments(){return scheduleVisibleAppointments().filter(a=>scheduleFilterMatches(a,scheduleFilter));}
function scheduleCount(key){return scheduleVisibleAppointments().filter(a=>scheduleFilterMatches(a,key)).length;}
function scheduleEntriesForDay(day,appointments=scheduleShownAppointments()){
 const start=new Date(`${day}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);
 return [...appointments.map(a=>({...a,kind:'appointment'})),...scheduleState.blocks.filter(b=>scheduleProviderVisible(b.clinician_id)).map(b=>({...b,kind:'block'}))].filter(a=>new Date(a.starts_at)<end&&new Date(a.ends_at)>start).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.id.localeCompare(b.id));
}
function scheduleCountButton(key,count,label){
 return `<button type="button" class="schedule-count${scheduleFilter===key?' is-on':''}" data-schedule-filter="${key}" data-focus-key="filter-${key}" aria-pressed="${scheduleFilter===key}"><b>${count}</b> ${esc(label)}</button>`;
}
function scheduleSummaryOptionsHtml(){
 const total=scheduleCount('all'),plural=(n,one,many)=>n===1?one:many,parts=[scheduleCountButton('all',total,plural(total,'appointment','appointments')),scheduleCountButton('checked_in',scheduleCount('checked_in'),'checked in'),scheduleCountButton('in_progress',scheduleCount('in_progress'),'in progress')];
 const forms=scheduleCount('forms_review'),insurance=scheduleCount('insurance_unchecked');
 if(forms||scheduleFilter==='forms_review')parts.push(scheduleCountButton('forms_review',forms,plural(forms,'form to review','forms to review')));
 if(insurance||scheduleFilter==='insurance_unchecked')parts.push(scheduleCountButton('insurance_unchecked',insurance,'insurance not checked'));
 const notSent=scheduleCount('claim_not_sent'),rejected=scheduleCount('claim_rejected');
 if(notSent||scheduleFilter==='claim_not_sent')parts.push(scheduleCountButton('claim_not_sent',notSent,'claims not sent'));
 if(rejected||scheduleFilter==='claim_rejected')parts.push(scheduleCountButton('claim_rejected',rejected,'claims rejected'));
 const groups=scheduleMode==='day'?`<div class="schedule-groups" role="group" aria-label="Show appointments by stage">${[['scheduled','Scheduled'],['in_office','In office'],['finished','Finished']].map(([key,label])=>`<button type="button" class="${scheduleFilter===key?'is-on':''}" data-schedule-filter="${key}" data-focus-key="filter-${key}" aria-pressed="${scheduleFilter===key}">${label} <b>${scheduleCount(key)}</b></button>`).join('')}</div>`:'';
 const batch=scheduleMode==='day'&&insurance&&scheduleCanCheckInsurance()&&['owner','front_desk'].includes(me?.role)?`<button type="button" data-board-action="check-day-insurance">${scheduleDate===scheduleToday()?'Check insurance for today':'Check insurance for this day'}</button>`:'';
 return `${groups}<div class="schedule-summary" role="group" aria-label="Summary. Choose a count to show only those appointments.">${parts.join('<span aria-hidden="true">·</span>')}</div>${scheduleFilter!=='all'?'<button type="button" class="schedule-show-all" data-schedule-filter="all" data-focus-key="filter-reset">Show all</button>':''}${batch}<span class="schedule-batch-status" role="status">${esc(scheduleBatchMessage)}</span>${scheduleMarkerState.failed?'<span class="schedule-marker-problem" role="status">Forms, insurance and payment details could not be loaded. They will be tried again shortly.</span>':''}`;
}

function scheduleSummaryHtml(){
 return `<div class="schedule-summary" aria-label="Filter appointments by status">${[['scheduled','Scheduled','grey'],['in_office','In office','green'],['finished','Finished','green'],['insurance_unchecked','Not checked','amber'],['claim_not_sent','Claims not sent','red'],['forms_review','Forms to review','info']].map(([key,label,tone])=>scheduleCountButton(key,scheduleCount(key),label).replace('schedule-count','schedule-count tone-'+tone)).join(' · ')}</div>${scheduleFilter!=='all'?'<button type="button" data-schedule-filter="all">Show all</button>':''}<span id="schedule-batch-status" role="status">${esc(scheduleBatchMessage)}</span>${scheduleMarkerState.failed?'<span role="status">Encounter details could not be loaded.</span>':''}`;
}
// ---- Time grid -----------------------------------------------------------
// Wall-clock minutes of one entry inside one local day, clipped to that day.
function scheduleDayMinutes(entry,day){
 const minute=value=>{const local=localTime(value),date=local.slice(0,10);return date<day?0:date>day?1440:Number(local.slice(11,13))*60+Number(local.slice(14,16));};
 const start=minute(entry.starts_at);return {start,end:Math.max(minute(entry.ends_at),start+1)};
}
// Pack the displayed bounds side by side, even when adjacent short bookings do not overlap in time.
function scheduleLayoutColumn(entries,day,minimumMinutes=1){
 const items=entries.map(a=>({a,...scheduleDayMinutes(a,day)})).sort((x,y)=>x.start-y.start||y.end-x.end||String(x.a.id).localeCompare(String(y.a.id)));
 let cluster=[],clusterEnd=-1;
 const flush=()=>{const lanes=Math.max(...cluster.map(item=>item.lane))+1;for(const item of cluster)item.lanes=lanes;cluster=[];};
 for(const item of items){
  item.shownEnd=Math.max(item.end,item.start+minimumMinutes);
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
 for(const column of columns)for(const entry of [...column.appointments,...column.blocks]){const m=scheduleDayMinutes(entry,column.day);first=Math.min(first,m.start);last=Math.max(last,m.end);}
 return {first:Math.floor(first/60)*60,last:Math.min(1440,Math.ceil(last/60)*60)};
}
const scheduleHourLabelFormatter=new Intl.DateTimeFormat(undefined,{hour:'numeric'});
function scheduleHourLabel(minute){return scheduleHourLabelFormatter.format(new Date(2001,0,1,Math.floor(minute/60)%24,0));}
// Day view keeps a column for each checked provider, including an empty day.
function scheduleDayColumns(){
 const day=scheduleDate,entries=scheduleEntriesForDay(day);
 return scheduleRailProviders().filter(p=>scheduleProviderVisible(p.id)).map(p=>({day,provider:p.id,label:scheduleProviderName({clinician_id:p.id,provider_label:p.label}),appointments:entries.filter(e=>e.kind==='appointment'&&e.clinician_id===p.id),blocks:entries.filter(e=>e.kind==='block'&&e.clinician_id===p.id)}));
}
function scheduleWeekColumns(){
 return scheduleWeekDays().flatMap(day=>{const entries=scheduleEntriesForDay(day);return scheduleRailProviders().filter(p=>scheduleProviderVisible(p.id)).map(p=>({day,provider:p.id,label:scheduleDayLabel(day,{weekday:'short',month:'short',day:'numeric'})+' · '+scheduleProviderName({clinician_id:p.id,provider_label:p.label}),weekday:true,appointments:entries.filter(e=>e.kind==='appointment'&&e.clinician_id===p.id),blocks:entries.filter(e=>e.kind==='block'&&e.clinician_id===p.id)}));});
}
function scheduleGridHtml(columns,variant){
 if(!columns.length)return '<p class="schedule-list-empty">Select a provider to show the schedule.</p>';
 const range=scheduleGridRange(columns),today=scheduleToday(),hours=[],scale=scheduleZoomScale[scheduleZoom]||scheduleZoomScale.comfortable;
 let displayLast=range.last,maxLanes=1;
 for(let minute=range.first;minute<range.last;minute+=60)hours.push(minute);
 const count=column=>{const n=column.appointments.length;return n?scheduleCountLabel(n,'appointment'):'No appointments';};
 const head=columns.map(column=>`<div class="grid-col-head${column.day===today?' is-today':''}">${column.weekday?`<button type="button" class="grid-day-link" data-calendar-day="${column.day}" aria-label="Open ${esc(scheduleDayLabel(column.day))}">${esc(column.label)}</button>`:`<strong>${esc(column.label)}</strong>`}<small>${count(column)}</small>${canSchedule()?`<button type="button" class="grid-add" data-calendar-book="${column.day}" data-slot-provider="${esc(column.provider)}" aria-label="Book an appointment${column.weekday?' on '+esc(scheduleDayLabel(column.day)):column.provider?' with '+esc(column.label):''}">+</button>`:''}</div>`).join('');
 const body=columns.map(column=>{
  const cards=scheduleLayoutColumn(column.appointments,column.day,scheduleMinimumCardHeight/scale).map(item=>{
   const duration=item.end-item.start;
   displayLast=Math.max(displayLast,item.shownEnd);maxLanes=Math.max(maxLanes,item.lanes);
   return `<div class="grid-item${duration*scale<scheduleTwoLineHeight?' is-short':''}${item.lanes>1?' is-narrow':''}" data-start="${item.start}" data-len="${duration}" data-display-len="${item.shownEnd-item.start}" data-lane="${item.lane}" data-lanes="${item.lanes}">${scheduleCard(item.a,variant,column.day)}</div>`;
  }).join('');
  const opening=schedulePracticeHours(column.day),closed=(scheduleHours?[[range.first,opening.first],[opening.last,range.last]]:[]).filter(([start,end])=>end>start).map(([start,end])=>`<div class="grid-block grid-closed" data-start="${start}" data-len="${end-start}" data-lane="0" data-lanes="1"><strong>Closed</strong></div>`).join('');
  const blocks=column.blocks.map(block=>{const m=scheduleDayMinutes(block,column.day);return `<button type="button" class="grid-block" data-schedule-id="${esc(block.id)}" data-schedule-block="${esc(block.id)}" data-start="${m.start}" data-len="${m.end-m.start}" data-lane="0" data-lanes="1" title="${esc(scheduleBlockLabel(block))}"><strong>${esc(block.label)}</strong><small>${esc(scheduleClockRange(block))}${columns.length===1&&!column.weekday?'':' · '+esc(scheduleProviderName(block))}</small></button>`;}).join('');
  return `<div class="grid-col${column.day===today?' is-today':''}" data-grid-column data-grid-day="${column.day}" data-grid-provider="${esc(column.provider)}" role="group" aria-label="${esc(column.weekday?scheduleDayLabel(column.day):column.label)}"${canSchedule()?' title="Click an empty time to book an appointment"':''}>${closed}${blocks}${cards}${column.day===today?'<div class="grid-now" data-now-line hidden></div>':''}</div>`;
 }).join('');
 return `<section class="schedule-grid schedule-grid-${variant} zoom-${scheduleZoom}" data-first="${range.first}" data-last="${range.last}" data-display-last="${displayLast}" data-columns="${columns.length}" data-max-lanes="${maxLanes}" aria-label="${variant==='week'?'Week':'Day'} schedule"><div class="grid-scroll" tabindex="0" role="region" aria-label="Time grid"><div class="grid-inner"><div class="grid-head"><div class="grid-corner"></div>${head}</div><div class="grid-body"><div class="grid-axis" aria-hidden="true">${hours.map(minute=>`<span class="grid-hour" data-start="${minute}" data-len="60" data-lane="0" data-lanes="1">${esc(scheduleHourLabel(minute))}</span>`).join('')}</div>${body}</div></div></div></section>`;
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
function scheduleHeadHtml(filtersOpen=false){
 const views=[['day','Day'],['week_grid','Week'],['month','Month'],['week','List']],zone=scheduleZoneNote();
 return `<div class="schedule-commandbar"><div class="schedule-toolbar"><div class="schedule-views" role="group" aria-label="View">${views.map(([key,label])=>`<button type="button" class="${scheduleMode===key?'is-on':''}" data-schedule-view="${key}" data-focus-key="view-${key}" aria-pressed="${scheduleMode===key}">${label}</button>`).join('')}</div><button type="button" data-schedule-today data-focus-key="today">Today</button><button type="button" data-schedule-shift="-1" data-focus-key="previous-period" aria-label="Previous period">‹</button><button type="button" data-schedule-shift="1" data-focus-key="next-period" aria-label="Next period">›</button></div><div class="actions"><button type="button" data-schedule-filters data-focus-key="filters" aria-expanded="${filtersOpen}" aria-controls="schedule-rail">Filters</button><details class="schedule-more" data-menu><summary>More ▾</summary><div class="schedule-more-menu">${canSchedule()?'<button type="button" data-new-block>Block time</button>':''}<div class="schedule-zoom" role="group" aria-label="Density">${['compact','comfortable'].map(key=>`<button type="button" data-schedule-zoom="${key}" aria-pressed="${scheduleZoom===key}">${key==='compact'?'Compact':'Comfortable'}</button>`).join('')}</div><button type="button" data-previsit-refresh>Intake readiness</button><button type="button" data-series-list>Recurring series</button><button type="button" data-reminder-workspace>Reminders</button><button type="button" data-calendar-sync>Sync to my calendar</button><div id="schedule-options">${scheduleSummaryOptionsHtml()}</div></div></details>${canSchedule()?'<button type="button" class="primary" data-new-appointment>+ Appointment</button>':''}</div></div><div class="schedule-statusbar" id="schedule-statusbar">${scheduleSummaryHtml()}</div><h2 class="schedule-period">${esc(schedulePeriodLabel())}</h2>${zone?`<p class="muted schedule-zone">${esc(zone)}</p>`:''}`;
}
function scheduleRailHtml(){
 const days=scheduleCalendarDays(),month=scheduleDate.slice(0,7),today=scheduleToday();
 const locations=[...new Set(scheduleState.appointments.map(a=>a.facility||'No location'))].sort();
 return `<div class="schedule-rail"><section class="schedule-mini"><div class="schedule-mini-head"><button type="button" data-mini-shift="-1" data-focus-key="previous-month" aria-label="Previous calendar month">‹</button><strong>${esc(scheduleDayLabel(scheduleDate,{month:'long',year:'numeric'}))}</strong><button type="button" data-mini-shift="1" data-focus-key="next-month" aria-label="Next calendar month">›</button></div><div class="schedule-mini-days">${['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=>`<span>${d}</span>`).join('')}${days.map(day=>`<button type="button" data-calendar-day="${day}" aria-label="${esc(scheduleDayLabel(day))}" aria-pressed="${day===scheduleDate}"${day===today?' aria-current="date"':''} class="${day.slice(0,7)!==month?'outside-month':''}">${Number(day.slice(-2))}</button>`).join('')}</div></section><fieldset><legend>LOCATIONS</legend>${locations.map(location=>`<label><input type="checkbox" data-schedule-location="${esc(location)}" data-focus-key="location-${esc(location)}" ${scheduleLocationEnabled(location)?'checked':''}><span>${esc(location)}</span></label>`).join('')||'<p class="muted">No locations in this range</p>'}</fieldset><fieldset><legend>PROVIDERS</legend>${scheduleRailProviders().map(p=>`<label><input type="checkbox" data-schedule-provider="${esc(p.id)}" data-focus-key="provider-${esc(p.id)}" ${scheduleProviderVisible(p.id)?'checked':''}><span class="schedule-initials">${esc(scheduleInitials(p.label))}</span><span>${esc(scheduleProviderName({clinician_id:p.id,provider_label:p.label}))}</span></label>`).join('')}</fieldset><section class="schedule-type-legend" aria-label="Encounter type colours"><h3>Encounter types</h3>${[['office','Office encounter'],['new','New patient'],['followup','Follow-up'],['telehealth','Telehealth'],['procedure','Procedure'],['other','Other']].map(([type,label])=>`<span class="type-${type}">${label}</span>`).join('')}</section></div>`;
}
function scheduleBodyHtml(){return scheduleMode==='month'?scheduleMonthCalendar():scheduleMode==='week_grid'?scheduleWeekCalendar():scheduleMode==='week'?scheduleListView():scheduleDayCalendar();}
function renderSchedule(){
 const page=$('schedule-workspace'),rail=$('schedule-rail'),filtersOpen=page?.dataset?.filtersOpen==='true';
 const railTop=rail?.scrollTop||0,focus=document.activeElement?.dataset?.focusKey;
 rememberScheduleScroll();
 $('tools').innerHTML=`<section id="schedule-workspace" data-filters-open="${filtersOpen}"><div id="schedule-head">${scheduleHeadHtml(filtersOpen)}</div><div class="schedule-layout"><div id="schedule-rail" tabindex="0" role="region" aria-label="Schedule filters">${scheduleRailHtml()}</div><div class="schedule-agenda" id="schedule-body"${scheduleMode==='month'||scheduleMode==='week'?' tabindex="0"':''} role="region" aria-label="Schedule calendar">${scheduleBodyHtml()}</div><section id="schedule-detail" class="schedule-detail" aria-label="Appointment details" hidden></section></div></section>`;
 if(railTop)$('schedule-rail').scrollTop=railTop;
 placeScheduleContent();
 restoreScheduleControlFocus(focus);
}
function restoreScheduleControlFocus(key){
 if(!key||typeof document.querySelectorAll!=='function')return;
 const control=Array.from(document.querySelectorAll('#schedule-head [data-focus-key], #schedule-rail [data-focus-key]')).find(node=>node.dataset.focusKey===key);
 control?.focus({preventScroll:!control.closest('.schedule-summary')});
}
function setScheduleFiltersOpen(open){
 const page=$('schedule-workspace'),button=page?.querySelector?.('[data-schedule-filters]');
 if(!button)return;
 page.dataset.filtersOpen=String(open);
 button.setAttribute('aria-expanded',String(open));
 (open?$('schedule-rail'):button)?.focus({preventScroll:true});
}
// Redraws the header and the calendar but leaves an open appointment panel alone.
function repaintSchedule(){
 const head=$('schedule-head'),body=$('schedule-body');
 if(!scheduleState||!head||!body||head.isConnected===false){return;}
 const focus=document.activeElement?.dataset?.focusKey,rail=$('schedule-rail'),railTop=rail?.scrollTop||0;
 rememberScheduleScroll();
 head.innerHTML=scheduleHeadHtml($('schedule-workspace')?.dataset?.filtersOpen==='true');body.innerHTML=scheduleBodyHtml();
 if(rail){rail.innerHTML=scheduleRailHtml();rail.scrollTop=railTop;}
 placeScheduleContent();
 restoreScheduleControlFocus(focus);
}
// Markers fill in without redrawing the cards they sit on.
function paintScheduleMarkers(){
 if(!scheduleState)return;
 if(['forms_review','insurance_unchecked','claim_not_sent','claim_rejected'].includes(scheduleFilter)||typeof document.querySelectorAll!=='function'){repaintSchedule();}
 else{
  const byId=new Map(scheduleState.appointments.map(a=>[a.id,a]));
  for(const host of document.querySelectorAll('#schedule-body [data-markers-for]')){const a=byId.get(host.dataset.markersFor);if(a){host.innerHTML=scheduleMarkersHtml(a,host.dataset.markersVariant);const card=host.closest('.appt-card');card.title=scheduleCardTitle(a);card.querySelector('.appt-marker-count')?.remove();card.querySelector('.appt-card-main').insertAdjacentHTML('beforeend',scheduleMarkerCountHtml(scheduleMarkerList(a)));}}
  rememberScheduleScroll();placeScheduleGrid();
  const bar=$('schedule-statusbar'),active=document.activeElement;
  const focus=active?.closest?.('#schedule-statusbar')?active.dataset.focusKey:null;
  if(bar){
   const left=bar.querySelector?.('.schedule-summary')?.scrollLeft||0;
   bar.innerHTML=scheduleSummaryHtml();
   const summary=bar.querySelector?.('.schedule-summary');
   if(summary)summary.scrollLeft=left;
   restoreScheduleControlFocus(focus);
  }
  const options=$('schedule-options');if(options)options.innerHTML=scheduleSummaryOptionsHtml();
 }
 const insuranceHost=$('schedule-panel-insurance'),selectedAppointment=scheduleState.appointments.find(a=>a.id===scheduleSelected);if(insuranceHost&&selectedAppointment)insuranceHost.innerHTML=scheduleInsuranceHtml(selectedAppointment);
 const copayHost=$('schedule-panel-copay');if(copayHost&&selectedAppointment)copayHost.innerHTML=scheduleCopayHtml(selectedAppointment);
 const facts=$('appt-panel-facts'),open=scheduleState.appointments.find(a=>a.id===scheduleSelected);
 if(facts&&open&&facts.isConnected!==false&&$('schedule-detail')?.hidden===false)facts.innerHTML=schedulePanelFacts(open);
}
let scheduleScrollMemory=new Map(),scheduleScrollSession=0;
function scheduleScrollKey(){return `${scheduleScrollSession}|${scheduleMode}|${scheduleDate}|${scheduleZoom}`;}
function rememberScheduleScroll(){
 if(typeof document.querySelector!=='function')return;
 const grid=document.querySelector('#schedule-workspace .schedule-grid'),body=$('schedule-body');
 const scroll=grid?.querySelector('.grid-scroll')||body,key=(grid||body)?.dataset?.scrollKey;
 if(key)scheduleScrollMemory.set(key,{top:scroll.scrollTop,left:scroll.scrollLeft});
}
function placeScheduleContent(){
 if(typeof document.querySelector!=='function')return;
 const body=$('schedule-body');
 if(body?.querySelector?.('.schedule-grid')){placeScheduleGrid();return;}
 if(!body?.dataset)return;
 const key=scheduleScrollKey(),saved=scheduleScrollMemory.get(key);
 body.dataset.scrollKey=key;
 body.scrollTop=saved?.top||0;
 body.scrollLeft=saved?.left||0;
}
// Geometry is written through the style API (inline style attributes are not allowed),
// with a fixed time scale so markers never stretch the day.
function placeScheduleGrid(){
 if(typeof document.querySelector!=='function')return;
 const grid=document.querySelector('#schedule-workspace .schedule-grid');if(!grid)return;
 const first=Number(grid.dataset.first),last=Number(grid.dataset.displayLast||grid.dataset.last);
 const scale=scheduleZoomScale[scheduleZoom]||scheduleZoomScale.comfortable;
 grid.style.setProperty('--minute',`${scale}px`);grid.style.setProperty('--grid-minutes',String(last-first));grid.style.setProperty('--grid-columns',grid.dataset.columns);grid.style.setProperty('--grid-max-lanes',grid.dataset.maxLanes||'1');
 for(const node of grid.querySelectorAll('[data-start]')){
  node.style.setProperty('--s',String(Number(node.dataset.start)-first));node.style.setProperty('--l',node.dataset.displayLen||node.dataset.len);
  node.style.setProperty('--lane',node.dataset.lane);node.style.setProperty('--lanes',node.dataset.lanes);
 }
 placeScheduleNow();
 const scroll=grid.querySelector('.grid-scroll');if(!scroll)return;
 const key=scheduleScrollKey();grid.dataset.scrollKey=key;
 const saved=scheduleScrollMemory.get(key);
 if(saved){scroll.scrollTop=saved.top;scroll.scrollLeft=saved.left;return;}
 const now=new Date(),nowMinute=now.getHours()*60+now.getMinutes();
 const items=Array.from(grid.querySelectorAll('.grid-item'));
 const starts=items.map(node=>Number(node.dataset.start));
 const todayStarts=items.filter(node=>node.closest('[data-grid-day]')?.dataset.gridDay===scheduleToday()).map(node=>Number(node.dataset.start));
 const upcoming=todayStarts.filter(start=>start>=nowMinute);
 const next=upcoming.length?Math.min(...upcoming):null;
 const header=grid.querySelector('.grid-head')?.offsetHeight||0;
 const targetMinute=next??(todayStarts.length?Math.min(...todayStarts):starts.length?Math.min(...starts):first);
 const target=(targetMinute-first)*scale-(next===null?0:Math.min(32,Math.max(0,scroll.clientHeight-header)/3));
 scroll.scrollTop=Math.max(0,target);scroll.scrollLeft=0;
 scheduleScrollMemory.set(key,{top:scroll.scrollTop,left:0});
}
function placeScheduleNow(){
 if(typeof document.querySelector!=='function')return;
 const grid=document.querySelector('#schedule-workspace .schedule-grid');if(!grid)return;
 const first=Number(grid.dataset.first),last=Number(grid.dataset.last),now=new Date(),minute=now.getHours()*60+now.getMinutes();
 for(const line of grid.querySelectorAll('[data-now-line]')){line.hidden=minute<first||minute>last||line.closest('[data-grid-day]')?.dataset.gridDay!==scheduleToday();line.style.setProperty('--s',String(minute-first));}
}
// Anchor to the selected block and keep the card inside the viewport.
function placeSchedulePanel(panel){
 if(typeof document.querySelector!=='function'||typeof window==='undefined')return;
 const anchor=Array.from(document.querySelectorAll('[data-schedule-id]')).find(node=>node.dataset.scheduleId===scheduleSelected);
 const headerBottom=Math.max(0,...['.shell-topbar','#patient-banner','#schedule-head'].map(selector=>{const node=document.querySelector(selector);return node?.getBoundingClientRect?.().bottom||0;})),minimumTop=Math.max(12,headerBottom+8);
 const box=anchor?.getBoundingClientRect(),width=Math.min(panel.classList.contains('is-editor')?540:320,window.innerWidth-24);
 panel.style.setProperty('width',`${width}px`);
 panel.style.setProperty('left',`${Math.max(12,Math.min(box?box.left+24:window.innerWidth-width-16,window.innerWidth-width-12))}px`);
 panel.style.setProperty('top',`${Math.max(minimumTop,Math.min(box?box.bottom+4:100,window.innerHeight-620))}px`);
 panel.style.setProperty('max-height',`calc(100dvh - ${panel.style.getPropertyValue('top')} - 12px)`);
}
function scheduleGridTimeAt(column,offsetY){
 const grid=column.closest('.schedule-grid'),scale=parseFloat(grid.style?.getPropertyValue('--minute'))||scheduleZoomScale[scheduleZoom]||scheduleZoomScale.comfortable;
 const coordinate=Number(grid.dataset.first)+offsetY/scale;
 if(coordinate>=Number(grid.dataset.last))return null;
 const minute=Math.min(1425,Math.max(0,Math.floor(coordinate/15)*15));
 return `${column.dataset.gridDay}T${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
}

// ---- Appointment panel -----------------------------------------------------
let scheduleIntakeLink=null;
function schedulePanelRow(label,state,tone,actions=''){
 return `<div class="appt-fact" data-schedule-fact="${({'Intake form':'forms',Insurance:'insurance',Copay:'copay',Balance:'balance','Visit note':'note',Charges:'charges','Insurance claim':'claim',Registration:'new'})[label]||''}" tabindex="-1"><dt>${esc(label)}</dt><dd><span class="appt-fact-state${tone?' tone-'+tone:''}">${esc(state)}</span>${actions?`<span class="appt-fact-actions">${actions}</span>`:''}</dd></div>`;
}
function schedulePanelButton(action,a,label,primary=false){return `<button type="button"${primary?' class="primary"':''} data-board-action="${action}" data-appointment="${esc(a.id)}">${esc(label)}</button>`;}
// The claim panel button also carries the claim it opens, so the click can follow the
// same route the claims screen uses.
// Forms, insurance, payment, note, charges and the claim for the open appointment.
function scheduleClaimButton(a,claim){return `<button type="button" data-board-action="open-claim" data-appointment="${esc(a.id)}" data-claim="${esc(claim)}">Open claim</button>`;}
function schedulePanelFacts(a){
 const m=scheduleMarker(a.id);
 if(!m)return currentChartMarker(a.id)||scheduleMarkerState.failed?'<p class="muted">Forms, insurance and payment details could not be loaded.</p>':scheduleMarkerState.loaded?'':'<p class="muted" role="status">Loading forms, insurance and payment details…</p>';
 const markers=new Map(scheduleMarkerList(a).map(marker=>[marker.kind,marker])),closed=scheduleClosed(a),rows=[];
 if(m.new_patient)rows.push(schedulePanelRow('Registration','Review contact details and registration information.','info',schedulePanelButton('registration',a,'Open registration details')));
 const forms=markers.get('forms'),canSend=!closed&&scheduleCanSendForms();
 if(!closed)rows.push(schedulePanelRow('Intake form',forms?forms.tip:m.forms?.status==='not_needed'?'No intake form is needed for this encounter.':'No intake form has been sent.',forms?.tone,m.forms?.status==='submitted'?schedulePanelButton('review-intake',a,'Review answers'):m.forms?.status==='reviewed'?schedulePanelButton('review-intake',a,'View answers'):m.forms?.status==='not_needed'?'':canSend?schedulePanelButton('send-intake',a,m.forms?'Send a new link':'Send intake form'):''));
 if(m.insurance&&!closed){
  const insurance=markers.get('insurance'),checked=m.insurance.checked_at?` Checked ${scheduleWhen(m.insurance.checked_at)}.`:'';
  rows.push(schedulePanelRow('Insurance',insurance.tip+checked,insurance.tone,(m.insurance.coverage_id&&!closed&&scheduleCanCheckInsurance()?schedulePanelButton('check-eligibility',a,m.insurance.status==='not_checked'?'Check eligibility':'Check again'):'')+schedulePanelButton('insurance',a,m.insurance.status==='self_pay'?'Add insurance':'Open insurance')));
 }
 if('copay' in m&&(!closed||markers.has('copay'))){
  const copay=markers.get('copay'),paid=Number(m.copay?.paid_cents)>0||Number(m.copay?.test_paid_cents)>0;
  rows.push(schedulePanelRow('Copay',copay?copay.tip:'No copay is recorded for this encounter.',copay?.tone,(!closed&&scheduleCanBill()&&copay?.tone!=='green'?schedulePanelButton('collect-copay',a,'Collect copay'):'')+(paid?schedulePanelButton('collect-copay',a,'View receipt'):'')));
 }
 if('balance_cents' in m){const balance=markers.get('balance');rows.push(schedulePanelRow('Balance',balance?`${balance.label}. ${balance.tip}`:'Nothing owed from earlier visits.',balance?.tone,balance?schedulePanelButton('billing',a,'Open billing'):''));}
 if(markers.has('note')){const note=markers.get('note');rows.push(schedulePanelRow('Visit note',note.tip,note.tone,m.visit_id&&scheduleAllowed('clinical')?schedulePanelButton(m.note==='signed'?'visit':'start-note',a,m.note==='signed'?'Open note':m.note==='in_progress'?'Continue note':'Start note'):a.status==='checked_in'&&scheduleCanStartVisit(a)?schedulePanelNext(a):'<small>An encounter cannot be started after this appointment is in progress or finished. Open the chart to review its encounters.</small>'+schedulePanelButton('encounters',a,'Review encounters')));}
  if(markers.has('charges')){const charges=markers.get('charges');rows.push(schedulePanelRow('Charges',charges.tip,charges.tone,m.visit_id&&scheduleAllowed('billing')?schedulePanelButton('charges',a,'Open charges'):''));}
  if(markers.has('claim')){
   const claim=markers.get('claim');
   const open=m.claim?.claim_id?scheduleClaimButton(a,m.claim.claim_id)
     :m.visit_id&&scheduleAllowed('billing')?schedulePanelButton('charges',a,'Open invoice'):'';
   rows.push(schedulePanelRow('Insurance claim',claim.tip,claim.tone,open));
  }
  return rows.join('');
}
function schedulePanelNext(a){
 const m=scheduleMarker(a.id);
 if(a.status==='booked'&&canSchedule()){
  if(scheduleCanStartVisit(a)&&localTime(a.starts_at).slice(0,10)===scheduleToday())return schedulePanelButton('check-in-start',a,'Check in & start encounter',true);
  return schedulePanelButton('check-in',a,'Check in',true);
 }
 if(a.status==='checked_in'&&scheduleCanStartVisit(a))return `<button type="button" class="primary" data-schedule-start="${esc(a.id)}" data-patient="${esc(a.patient_id)}">Start encounter</button>`;
 if(['in_progress','completed'].includes(a.status)&&m?.visit_id&&scheduleAllowed('clinical'))return schedulePanelButton('visit',a,a.status==='completed'?'Open encounter':'Continue encounter',a.status==='in_progress');
 return '';
}
function schedulePanelLink(a){
 const link=scheduleIntakeLink;if(!link||link.identity!==me||link.appointment!==a.id)return '';
 const mail=typeof patientIntakeMailto==='function'?patientIntakeMailto(a.patient_id,link.url,link.practice):'';
 return `<section class="mapping-notice intake-link" aria-live="polite"><h4>Send this link to the patient</h4><p>This link is shown only now. Copy or email it before you close this panel. It works until ${esc(scheduleWhen(link.expires))}.${link.replaced?' The earlier link no longer works.':''}</p><div class="actions"><button type="button" class="primary" data-board-action="copy-link" data-appointment="${esc(a.id)}">Copy link</button>${mail?`<a class="button" href="${esc(mail)}">Email the link</a>`:''}<button type="button" data-board-action="link-done" data-appointment="${esc(a.id)}">Done</button></div><label class="card-setup-link" hidden>Intake form link<input readonly value="${esc(link.url)}" data-schedule-intake-link></label></section>`;
}
// Keep automatic check explanations across panel rerenders and chart navigation in this session.
const scheduleInsuranceChecks=new Map();
function scheduleInsuranceCheckMessage(a){
 const entry=a&&scheduleInsuranceChecks.get(a.id);
 return entry?.identity===me&&entry.patient===a.patient_id&&entry.startsAt===a.starts_at?entry.message:'';
}
function scheduleInsuranceHtml(a){
 const status=scheduleMarker(a.id)?.insurance?.status,message=scheduleInsuranceCheckMessage(a);
 return `<span class="eyebrow">INSURANCE</span><span class="appt-status-pill ${['not_checked','self_pay'].includes(status)?'schedule-amber':''}">${esc(status==='self_pay'?'Missing':message||(status==='not_checked'?'Not checked':scheduleStatusLabel(status)||'Not loaded'))}</span>`;
}
function schedulePanelHtml(a,patientName,history,{inChart=false}={}){
 const provider=scheduleProviderName(a),place=[a.facility,a.room?'Room '+a.room:''].filter(Boolean).join(' · '),next=schedulePanelNext(a);
 const canAct=canSchedule()&&['booked','checked_in'].includes(a.status),late=a.status==='booked'&&new Date(a.starts_at)<=new Date();
 const m=scheduleMarker(a.id),patient=schedulePatients.find(p=>p.id===a.patient_id)||(typeof workspace!=='undefined'&&workspace?.patient?.id===a.patient_id?workspace.patient:{});
 const encounter=m?.visit_id&&scheduleAllowed('clinical')?schedulePanelButton('visit',a,'Open encounter ›'):a.status==='checked_in'&&scheduleCanStartVisit(a)?`<button type="button" class="primary" data-schedule-start="${esc(a.id)}" data-patient="${esc(a.patient_id)}">Start encounter</button>`:next;
 return `<div class="appt-panel status-${esc(a.status)}"><div class="appt-panel-head"><span class="schedule-initials">${esc(scheduleInitials(patientName))}</span><div><h2><button type="button" data-schedule-chart="${esc(a.patient_id)}">${esc(patientName||'Patient appointment')}</button></h2><p class="muted">MRN ${esc(a.mrn||patient.mrn||'unavailable')} · DOB ${esc(a.birth_date||patient.birth_date||'unavailable')}</p><p class="muted">${esc(a.phone||patient.phone||patient.demographics?.content?.phone||(typeof workspace!=='undefined'&&workspace?.patient?.id===a.patient_id?workspace.demographics?.content?.phone:'')||'Phone unavailable')}</p></div></div><p class="appt-panel-when">${esc(scheduleDayLabel(localTime(a.starts_at).slice(0,10),{month:'short',day:'numeric'}))} · ${esc(scheduleClock(a.starts_at))} · ${scheduleDuration(a)} min · ${esc(scheduleVisitTitle(a))}</p><p class="muted">${esc(provider)}${place?' · '+esc(place):''}</p><div class="actions">${encounter}</div><div class="schedule-insurance" id="schedule-panel-insurance">${scheduleInsuranceHtml(a)}</div><div id="schedule-panel-copay">${scheduleCopayHtml(a)}</div><div id="saved-card-payment-live"></div><label class="schedule-status-label">STATUS<select data-schedule-status="${esc(a.id)}"><option value="">${esc(scheduleStatusLabel(a.status))}</option>${canSchedule()&&a.status==='booked'?'<option value="check-in">Checked in</option>':''}${canAct?'<option value="cancel">Cancelled…</option>':''}${late&&canAct?'<option value="no_show">No-show…</option>':''}</select></label>
 <details class="schedule-encounter-details"><summary>Encounter details and actions</summary><p class="appt-panel-allergies" id="appt-panel-allergies" hidden></p>
 <div class="actions appt-panel-next"><button type="button" data-schedule-chart="${esc(a.patient_id)}" data-appointment="${esc(a.id)}">Open chart</button></div>
 <dl class="appt-panel-facts" id="appt-panel-facts">${schedulePanelFacts(a)}</dl><div id="appt-panel-link">${schedulePanelLink(a)}</div>
 ${a.notes?`<p class="note-text">${esc(a.notes)}</p>`:''}
 ${!inChart&&canSchedule()&&a.status==='booked'&&['week_grid','day'].includes(scheduleMode)?`<div class="actions"><button type="button" data-schedule-pick-move="${esc(a.id)}">Pick a new time on the calendar</button></div>`:''}

 <details class="appt-panel-history"><summary>Appointment history</summary>${history.map(r=>`<div class="amendment"><p><b>${esc(scheduleStatusLabel(r.snapshot.status))}</b> · ${esc(r.reason)}</p><p>${esc(scheduleWhen(r.snapshot.starts_at))} – ${esc(scheduleClock(r.snapshot.ends_at))} · ${esc(r.snapshot.title)}${r.snapshot.facility?' · '+esc(r.snapshot.facility):''}${r.snapshot.room?' '+esc(r.snapshot.room):''}</p><small>Recorded ${esc(scheduleWhen(r.created_at))}</small></div>`).join('')||'<p class="muted">No changes recorded.</p>'}</details>
 <details class="appt-panel-reminders"><summary>Reminders and recurring appointments</summary><div id="appointment-extras"></div></details></details>
 ${canAct?`<details class="appt-panel-cancel"><summary>Cancel${late?' or mark as no-show':''}</summary><form id="schedule-action" data-id="${esc(a.id)}" data-version="${a.version}"><label>What happened<select name="action"><option value="cancel">Cancel appointment</option>${late?'<option value="no_show">Patient did not show up</option>':''}</select></label><label>Reason for cancellation${late?' or no-show':''}<input name="reason" required maxlength="1000"></label><button type="submit">Save</button></form></details>`:''}
 <footer class="schedule-card-footer">${canAct?'<button type="button" data-open-cancel>Cancel appointment</button>':''}${canSchedule()&&a.status==='booked'?`<button type="button" data-schedule-edit="${esc(a.id)}">Edit appointment</button>`:''}</footer></div>`;
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
 await selectPatient(a.patient_id);
 if(typeof selected==='undefined'||selected!==a.patient_id)return;
 if(section==='insurance'&&typeof insuranceAppointmentSelection!=='undefined'&&workspace?.appointments?.some(row=>row.id===a.id))insuranceAppointmentSelection.set(a.patient_id,a.id);
 showChartSection(section);
 const target=focusId?$(focusId):null;if(target&&target.isConnected!==false){target.scrollIntoView?.({block:'start'});target.focus?.({preventScroll:true});}
}
async function scheduleOpenVisit(a,section){
 const visit=scheduleMarker(a.id)?.visit_id;if(!visit)throw new Error('No visit has been started for this appointment yet.');
 await selectPatient(a.patient_id,visit);
 if(section&&typeof setEncounterSection==='function'&&typeof activeVisit!=='undefined'&&activeVisit?.id===visit)setEncounterSection(section);
}
// A copay belongs to one appointment. With its encounter started, that encounter opens on Billing
// with the payment window up; before that, the chart shows this appointment's own copay card,
// never another encounter the patient happens to have open.
async function scheduleCollectCopay(a){
 const visit=scheduleMarker(a.id)?.visit_id;
 if(visit){
  await scheduleOpenVisit(a,'charges');
  if(typeof activeVisit==='undefined'||activeVisit?.id!==visit)return;
  if(typeof invoiceTabSet==='function')invoiceTabSet('billing',false);
  // What is owed is read first, so the window opens with the amount already filled in.
  if(typeof loadEncounterRevenueStatus==='function'&&typeof encounterChargeAccount==='function'){try{await loadEncounterRevenueStatus(encounterChargeAccount());}catch{}}
  if(typeof activeVisit==='undefined'||activeVisit?.id!==visit)return;
  if(typeof openVisitCollect==='function')openVisitCollect();
  return;
 }
 if(typeof copayAppointmentSelection!=='undefined')copayAppointmentSelection.set(a.patient_id,a.id);
 await selectPatient(a.patient_id,null);
 if(typeof selected==='undefined'||selected!==a.patient_id)return;
 showChartSection('visits');
 const panel=$('appointment-copay-card');if(panel){const marker=document.createComment('appointment-copay-card');panel.before(marker);const dialog=sheetOpen('Take payment',panel);dialog.addEventListener('close',()=>{if(marker.parentNode){marker.replaceWith(panel);}},{once:true});await loadHostedCopays(a.id,true);await openHostedCopayEditor(a.id,'insurance-hosted-copay',scheduleCopayDue(a));}
}
async function scheduleRefreshAfter(a){const expanded=document.querySelector?.('.schedule-encounter-details')?.open;await showSchedule();if(a)await appointmentDetail(a.id);if(expanded){const details=document.querySelector?.('.schedule-encounter-details');if(details)details.open=true;}}
function scheduleAppointmentView(a,patient=$('schedule-detail')?.dataset.chartPatient){
 const identity=me,section=patient?chartSection:null,generation=patient?patientWorkspaceGeneration:null;
 let panel=$('schedule-detail'),inChartPanel=patient&&panel?.dataset.chartPatient===patient;
 const current=()=>me===identity&&scheduleSelected===a.id&&(patient
  ?selected===patient&&patient===a.patient_id&&chartSection===section&&patientWorkspaceGeneration===generation&&$('clinical-workspace')?.hidden===false
  :$('clinical-workspace')?.hidden!==false);
 const atPanel=()=>current()&&$('schedule-detail')===panel&&(!inChartPanel||panel?.dataset.chartPatient===patient);
 const refresh=async saved=>{
  if(!atPanel())return false;
  if(patient){
   if(saved){
    if(saved.id!==a.id||saved.patient_id!==patient)throw new Error('Reload the appointment to confirm its updated status.');
    workspace.appointments=workspace.appointments.map(row=>row.id===a.id?{...row,...saved}:row);
    captureVisitDrafts();renderChart();
   }
   await appointmentDetail(a.id,patient,saved?current:atPanel);
  }else{await scheduleRefreshAfter(a);await scheduleMarkersReady;}
  panel=$('schedule-detail');inChartPanel=Boolean(patient);
  return atPanel();
 };
 return {identity,atPanel,refresh};
}
// The claims screen's own address opens a claim from anywhere else in the product, so
// Back, Forward and a reload land on the same claim. With no claim yet the encounter's own
// Charges & billing step is where the claim work starts.
const scheduleClaimUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function scheduleOpenClaimAddress(id){
 if(!scheduleClaimUuid(id))throw new Error('Open the schedule again and choose the claim.');
 if(typeof location==='undefined')throw new Error('This screen cannot open a claim address.');
 location.hash='#/claims/'+id;
}
async function scheduleOpenClaim(a,claim){
 if(!claim?.claim_id){await scheduleOpenVisit(a,'charges');return;}
 scheduleOpenClaimAddress(claim.claim_id);
}
async function scheduleSendIntake(a){
 if(!scheduleCanSendForms())throw new Error('Your role cannot send intake forms.');
 const view=scheduleAppointmentView(a),saved=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/intake-forms`,'POST',{appointment_id:a.id});
 if(!view.atPanel()||typeof saved?.intake_url!=='string')return;
 scheduleIntakeLink={identity:view.identity,appointment:a.id,url:`${location.origin}${saved.intake_url}`,expires:saved.expires_at,replaced:Number(saved.replaced)>0,practice:saved.practice_name};
 if(!await view.refresh())return;
 const copy=$('appt-panel-link')?.querySelector?.('[data-board-action="copy-link"]');
 if(copy){copy.closest('details').open=true;copy.focus();}
 notice('The intake form link is ready. Copy or email it now; it is not shown again.');
}
async function scheduleCheckEligibility(a){
 const coverage=scheduleMarker(a.id)?.insurance?.coverage_id;
 if(!coverage||!scheduleCanCheckInsurance())throw new Error('There is no active insurance to check for this encounter.');
 const view=scheduleAppointmentView(a);
 const reply=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/coverages/${encodeURIComponent(coverage)}/claimmd-eligibility/check`,'POST',{request_id:crypto.randomUUID(),automatic:false,appointment_id:a.id});
 if(!view.atPanel())return;
 if(reply?.outcome==='needs'){await scheduleOpenChartStep(a,'insurance','insurance-review-title');notice('The insurer needs a little more information before this check can run. Finish it here.');return;}
 scheduleInsuranceChecks.delete(a.id);
 if(!await view.refresh())return;
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
 if(kind==='claim'&&m?.claim){await scheduleOpenClaim(a,m.claim);return;}
 await appointmentDetail(a.id);
 const details=document.querySelector?.('.schedule-encounter-details');
 if(details){
  details.open=true;
  const row=details.querySelector(`[data-schedule-fact="${kind}"]`);
  if(row){row.scrollIntoView?.({block:'nearest'});row.focus?.({preventScroll:true});}
 }
 if(kind==='new'){await scheduleOpenChartStep(a,'profile');return;}
 if(kind==='forms'&&m?.forms?.status==='submitted'&&typeof openWorkflowIntakePacket==='function'){await openWorkflowIntakePacket(m.forms.packet_id);return;}
 if(kind==='copay'&&!scheduleClosed(a)&&scheduleAllowed('billing')&&Number(m?.copay?.due_cents)>Number(m?.copay?.paid_cents)){await scheduleCollectCopay(a);return;}
 if(kind==='balance'&&scheduleAllowed('billing')){await scheduleOpenChartStep(a,'billing');return;}
 if(kind==='charges'&&m?.visit_id&&scheduleAllowed('billing')&&scheduleAllowed('clinical')){await scheduleOpenVisit(a,'charges');return;}
}
// Called by the schedule's click handler before its own rules. Returns true when handled.
async function scheduleBoardClick(b){
 const d=b.dataset;
 if(b.hasAttribute?.('data-schedule-filters')){setScheduleFiltersOpen(b.getAttribute('aria-expanded')!=='true');return true;}
 if(d.calendarDay&&b.closest('#schedule-rail')&&$('schedule-workspace')?.dataset?.filtersOpen==='true')setScheduleFiltersOpen(false);
 if(d.miniShift){const date=new Date(`${scheduleDate}T12:00:00`);date.setDate(1);date.setMonth(date.getMonth()+Number(d.miniShift));scheduleDate=scheduleDayKey(date);await showSchedule();return true;}
 if(b.hasAttribute?.('data-open-cancel')){const form=document.querySelector('.appt-panel-cancel');if(form){form.open=true;form.querySelector('select').value='cancel';form.querySelector('input')?.focus();}return true;}
 if(d.scheduleView){if(!scheduleModes.has(d.scheduleView))return true;scheduleMode=d.scheduleView;saveSchedulePreference('view');await showSchedule();return true;}
 if(d.scheduleFilter){
  if(!scheduleStatusFilters.has(d.scheduleFilter))return true;
  scheduleFilter=scheduleFilter===d.scheduleFilter?'all':d.scheduleFilter;
  saveSchedulePreference('status');repaintSchedule();return true;
 }
 if(d.scheduleZoom){scheduleZoom=d.scheduleZoom==='compact'?'compact':'comfortable';saveSchedulePreference('zoom');repaintSchedule();return true;}
 if(d.marker){const a=scheduleState.appointments.find(row=>row.id===d.markerAppointment);if(a)await scheduleMarkerOpen(a,d.marker);return true;}
 if(!d.boardAction)return false;
 if(d.boardAction==='check-day-insurance'){await scheduleCheckDayInsurance();return true;}
 const chartPatient=$('schedule-detail')?.dataset.chartPatient;
 const a=chartPatient&&chartPatient===selected?workspace.appointments?.find(row=>row.id===d.appointment):scheduleState?.appointments?.find(row=>row.id===d.appointment);
 if(!a)throw new Error('Reload the schedule and open the appointment again.');
 switch(d.boardAction){
  case 'check-in':await scheduleCheckIn(a);break;
  case 'check-in-start':await scheduleStartAppointment(a,true);break;
  case 'visit':await scheduleOpenVisit(a);break;
  case 'start-note':await scheduleOpenVisit(a,'documentation');break;
   case 'charges':await scheduleOpenVisit(a,'charges');break;
   case 'open-claim':scheduleOpenClaimAddress(d.claim);break;
  case 'send-intake':await scheduleSendIntake(a);break;
  case 'review-intake':{const packet=scheduleMarker(a.id)?.forms?.packet_id;if(!packet||typeof openWorkflowIntakePacket!=='function')throw new Error('Reload the schedule and open the form again.');await openWorkflowIntakePacket(packet);break;}
  case 'check-eligibility':await scheduleCheckEligibility(a);break;
  case 'collect-copay':await scheduleCollectCopay(a);break;
  case 'charge-copay':await scheduleChargeCopay(a);break;
  case 'registration':await scheduleOpenChartStep(a,'profile');break;
  case 'encounters':await scheduleOpenChartStep(a,'encounters');break;
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
 if(!time)return;
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
 const menu=document.querySelector('#schedule-workspace details.schedule-more[open]');
 if(menu){menu.open=false;menu.querySelector('summary')?.focus();return;}
 if(document.querySelector('#schedule-workspace[data-filters-open=true]')&&e.target?.closest?.('#schedule-workspace'))setScheduleFiltersOpen(false);
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
 return !(active&&active.closest?.('#schedule-workspace')&&/^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName))&&!document.querySelector?.('#schedule-workspace details.schedule-more[open], #schedule-workspace[data-filters-open=true]');
}
async function refreshScheduleQuietly(){
 if(!scheduleState||!scheduleIdle())return;
 scheduleLastRefresh=Date.now();rememberScheduleScroll();
 // Whoever is tabbing through the page keeps their place.
 const active=typeof document.querySelector==='function'?document.activeElement:null,card=active?.closest?.('[data-schedule-id]')?.dataset.scheduleId,key=active?.dataset?.focusKey;
 try{await showSchedule({quiet:true});}catch{return;}
 if(card)Array.from(document.querySelectorAll('#schedule-body [data-schedule-id]')).find(node=>node.dataset.scheduleId===card)?.querySelector('button')?.focus({preventScroll:true});
 else if(key)Array.from(document.querySelectorAll('#schedule-head [data-focus-key], #schedule-rail [data-focus-key]')).find(node=>node.dataset.focusKey===key)?.focus({preventScroll:true});
}
if(typeof setInterval==='function'){
 setInterval(()=>{placeScheduleNow();if(Date.now()-scheduleLastRefresh>=120000)void refreshScheduleQuietly();},60000);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden'&&Date.now()-scheduleLastRefresh>=60000)void refreshScheduleQuietly();});
}

// Check-in commits first; an unavailable insurance service must not undo arrival.
const scheduleSelfPayPrompts=new Map();
const scheduleCheckIns=new Set(),scheduleCopayCards=new Map(),scheduleCopayCharges=new Map();
function clearScheduleBoardSession(){
 scheduleMarkerState={key:'',items:new Map(),loaded:false,failed:false};
 scheduleChartMarker=undefined;
 scheduleIntakeLink=null;
 scheduleBatchMessage='';
 scheduleLastRefresh=0;
 scheduleScrollMemory.clear();scheduleScrollSession++;
 scheduleInsuranceChecks.clear();
 scheduleSelfPayPrompts.clear();
 scheduleCheckIns.clear();scheduleCopayCards.clear();scheduleCopayCharges.clear();
}

const scheduleEncounterStarts=new Set();
async function scheduleStartAppointment(a,checkIn=false){
 if(!scheduleCanStartVisit(a)||checkIn&&(!canSchedule()||a.status!=='booked'||localTime(a.starts_at).slice(0,10)!==scheduleToday()))throw new Error('Open an appointment you can start.');
 if(scheduleEncounterStarts.has(a.id))return;
 const identity=me,initialSelection=scheduleSelected;
 const current=()=>me===identity&&scheduleSelected===initialSelection&&$('clinical-workspace')?.hidden!==false;
 scheduleEncounterStarts.add(a.id);
 try{
  let visit;
  if(checkIn){
   try{await scheduleCheckIn(a);}
   catch(error){
    if(!current())return;
    const chart=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/workspace`);
    visit=chart.visits?.find(v=>v.appointment_id===a.id&&v.patient_id===a.patient_id);
    if(!visit&&!chart.appointments?.some(row=>row.id===a.id&&row.status==='checked_in'))throw error;
   }
  }
  if(!current())return;
  if(!visit){
   try{visit=await api('/api/v1/visits','POST',{appointment_id:a.id});}
   catch(error){
    if(!current())return;
    const chart=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/workspace`);
    visit=chart.visits?.find(v=>v.appointment_id===a.id&&v.patient_id===a.patient_id);
    if(!visit)throw error;
   }
  }
  if(!current())return;
  await selectPatient(a.patient_id,visit.id);
  if(me===identity&&activeVisit?.id===visit.id)setEncounterSection('visit');
 }finally{scheduleEncounterStarts.delete(a.id);}
}

async function checkInChartAppointment(id){
 const a=workspace?.appointments?.find(row=>row.id===id&&row.patient_id===selected);
 if(!a)throw new Error('Open the appointment in its patient chart before checking in.');
 scheduleSelected=id;
 await scheduleCheckIn(a,selected);
}
async function scheduleCheckIn(a,chartPatient=$('schedule-detail')?.dataset.chartPatient){
 if(!canSchedule()||a.status!=='booked')throw new Error('Only a booked appointment can be checked in.');
 if(scheduleCheckIns.has(a.id))return;scheduleCheckIns.add(a.id);
 const view=scheduleAppointmentView(a,chartPatient),identity=view.identity;
 try{
  if(!view.atPanel())return;
  const saved=await api(`/api/v1/appointments/${encodeURIComponent(a.id)}/check-in`,'POST');
  if(!view.atPanel())return;
  if(chartPatient&&saved?.status!=='checked_in')throw new Error('Reload the appointment to confirm check-in.');
  if(!await view.refresh(saved))return;
  const coverage=scheduleMarker(a.id)?.insurance?.coverage_id;
  if(scheduleMarker(a.id)?.insurance?.status==='self_pay'){scheduleSelfPayPrompts.set(a.id,identity);const host=$('schedule-panel-copay');if(host)host.innerHTML=scheduleCopayHtml({...a,status:'checked_in'});}
  if(coverage&&scheduleCanCheckInsurance()){
   const host=$('schedule-panel-insurance');if(host)host.innerHTML='<span role="status">Checking insurance…</span>';
   let message='';
   try{
    const reply=await api(`/api/v1/patients/${encodeURIComponent(a.patient_id)}/coverages/${encodeURIComponent(coverage)}/claimmd-eligibility/check`,'POST',{request_id:crypto.randomUUID(),automatic:true,appointment_id:a.id});
    if(reply?.outcome==='needs')message=reply.needs?.some(item=>item.kind==='claim_connection')?'Insurance not checked: the clearinghouse is not connected yet.':'The insurer needs a little more information before this check can run. Finish it in insurance.';
   }catch(error){if(!/not connected|enable and verify a Claim.MD connection/.test(error.message))message='The check finished but could not confirm coverage. Open insurance to see why.';}
   if(me!==identity)return;
   if(message)scheduleInsuranceChecks.set(a.id,{identity,patient:a.patient_id,startsAt:a.starts_at,message});else scheduleInsuranceChecks.delete(a.id);
   if(!await view.refresh())return;
   const updated=$('schedule-panel-insurance');if(updated)updated.innerHTML=scheduleInsuranceHtml(a);
  }
  if(view.atPanel())notice('Patient checked in.');
 }finally{scheduleCheckIns.delete(a.id);}
}
function scheduleCopayDue(a){const c=scheduleMarker(a.id)?.copay;return Math.max(0,Number(c?.due_cents||0)-Number(c?.paid_cents||0));}
function scheduleCopayHtml(a){
 if(a.status==='checked_in'&&scheduleSelfPayPrompts.get(a.id)===me)return `<p>No insurance on file. Self-pay visit?</p><div class="actions"><button type="button" data-self-pay-dismiss="${esc(a.id)}">Self-pay</button><button type="button" data-add-insurance-sheet="${esc(a.patient_id)}">+ Add insurance</button></div>`;
 const due=scheduleCopayDue(a);if(a.status!=='checked_in'||!scheduleCanBill()||!due)return '';
 const entry=scheduleCopayCards.get(a.id),card=entry?.identity===me?entry.cards[0]:null;
 return `<p><b>Copay ${scheduleMoney(due)} due</b></p><div class="actions">${card?`${schedulePanelButton('charge-copay',a,'Charge card on file')}<small>${esc(savedCardName(card))}</small>`:schedulePanelButton('collect-copay',a,'Take payment')}</div>`;
}
async function loadScheduleCopayCards(a){
 if(a.status!=='checked_in'||!scheduleCanBill()||!scheduleCopayDue(a)||typeof savedCardsForCharge!=='function')return;
 const identity=me;let found;try{found=await savedCardsForCharge(a.patient_id);}catch{return;}
 if(me!==identity)return;scheduleCopayCards.set(a.id,{identity,cards:found.cards});
 const host=$('schedule-panel-copay');if(host&&scheduleSelected===a.id)host.innerHTML=scheduleCopayHtml(a);
}
async function scheduleChargeCopay(a){
 const entry=scheduleCopayCards.get(a.id),card=entry?.identity===me?entry.cards[0]:null,due=scheduleCopayDue(a);
 if(!scheduleCanBill()||a.status!=='checked_in'||!card||due<50)throw new Error('Reload the appointment and review its copay.');
 const identity=me,base=`/api/v1/patients/${encodeURIComponent(a.patient_id)}/appointments/${encodeURIComponent(a.id)}/copay-checkouts`;
 let charge=scheduleCopayCharges.get(a.id);
 if(charge?.identity!==identity){charge={identity,request:crypto.randomUUID(),busy:false};scheduleCopayCharges.set(a.id,charge);}
 if(charge.busy)return;charge.busy=true;
 try{
  const data=await api(base);if(me!==identity)return;
  let operation=data.items?.find(item=>item.request_id===charge.request);
  if(!operation){
   if(!data.availability?.available||typeof data.availability.livemode!=='boolean'||data.items?.some(item=>['creating','open','needs_review'].includes(item.status)))throw new Error('Review the current card payment status before collecting another copay.');
   if(!charge.body)charge.body={request_id:charge.request,amount_cents:due,coverage_id:scheduleMarker(a.id)?.insurance?.coverage_id||null,livemode:data.availability.livemode,saved_card_setup_id:card.setup_id,reason:'Copay charged to card on file'};
   const reply=await api(base,'POST',charge.body);operation=reply.operation;
  }
  if(me!==identity||scheduleSelected!==a.id)return;
  watchSavedCardPayment({operation,refreshUrl:`${base}/${encodeURIComponent(operation.id)}/refresh`,finished:done=>{if(['paid','refunded'].includes(done.status))void scheduleRefreshAfter(a);}});
 }finally{charge.busy=false;}
}

document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-self-pay-dismiss]');if(!button)return;
 event.preventDefault();scheduleSelfPayPrompts.delete(button.dataset.selfPayDismiss);
 const host=$('schedule-panel-copay');if(host)host.replaceChildren();
});
