// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The patient banner: one compact strip that stays in view while a chart is open.
// It only reads. Identity, allergies and coverage come from the chart that is already
// loaded; the next and last visit, balance, latest eligibility answer and flags come
// from GET /api/v1/patients/{id}/banner. Every item links to the place that changes it.
let patientBanner={patient:null,identity:null,data:null,failed:false,revision:null,stale:false,own:false,request:null,timer:null,open:null};
function clearPatientBannerSession(){clearTimeout(patientBanner.timer);patientBanner={patient:null,identity:null,data:null,failed:false,revision:null,stale:false,own:false,request:null,timer:null,open:null};}
function patientBannerCurrent(){return typeof selected!=='undefined'&&!!selected&&typeof workspace!=='undefined'&&workspace?.patient?.id===selected&&patientBanner.patient===selected&&patientBanner.identity===me;}

// Dates, times, ages, statuses and counts are worded by display-format.js, like the rest of the app.
function patientBannerSameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
function patientBannerMoney(cents){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);}
function patientBannerCan(resource){return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);}
function patientBannerArea(key){return typeof chartAreaEnabled!=='function'||chartAreaEnabled(key);}

// Allergies. "No known allergies" is shown only when a clinician recorded exactly that.
// The schedule's appointment panel passes the clinical lists it read for its own patient.
function patientBannerAllergies(clinical=workspace.clinical||{items:[],reviews:[]}){
 const active=(clinical.items||[]).filter(e=>e.kind==='allergy'&&e.content?.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification));
 const review=(clinical.reviews||[]).find(r=>r.kind==='allergy')?.review_state||'unknown';
 if(active.length){
  const detail=e=>[e.content.title,[e.content.detail?.reaction,e.content.detail?.severity].filter(Boolean).join(', '),e.content.verification&&e.content.verification!=='confirmed'?displayStatus(e.content.verification):''].filter(Boolean).join(' — ');
  return {state:'recorded',names:active.map(e=>e.content.title),text:'Allergies: '+active.slice(0,2).map(e=>e.content.title).join(', '),more:active.length>2?`+${active.length-2}`:'',title:'Allergies: '+active.map(detail).join('; ')+'. Open the allergy list.'};
 }
 if(review==='no_known')return {state:'none',names:[],text:'No known allergies',title:'Reviewed: no known allergies. Open the allergy list.'};
 if(review==='reviewed')return {state:'empty',names:[],text:'No allergies recorded',title:'The allergy list was reviewed and has no active allergies. Open the allergy list.'};
 return {state:'unreviewed',names:[],text:'Allergies not reviewed',title:'Nobody has reviewed this patient\'s allergies yet. Open the allergy list to review it.'};
}
// Coverage in force today, primary first, from the coverage the chart already loaded.
function patientBannerCoverages(now=new Date()){
 if(!workspace.billing)return null;
 const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,order=['primary','secondary','tertiary'];
 return (workspace.billing.coverages||[]).filter(c=>c.content?.status==='active'&&(!c.content.effective_date||c.content.effective_date<=today)&&(!c.content.end_date||c.content.end_date>=today)).sort((a,b)=>order.indexOf(a.content.priority)-order.indexOf(b.content.priority));
}
function patientBannerPayer(coverage){
 const id=coverage.content.payer_id,payer=typeof billingPayers==='undefined'?null:(billingPayers||[]).find(p=>p.id===id);
 return payer?.content?.name||(typeof payerName==='function'?payerName(id):'')||'Insurance';
}
// The insurer's latest answer, in the same four words the eligibility card uses.
function patientBannerEligibility(coverage){
 const checks=patientBanner.data?.eligibility;if(!Array.isArray(checks)||!patientBannerCurrent())return null;
 const check=checks.find(item=>item.coverage_id===coverage.id);
 if(!check)return {state:'none',icon:'–',label:'Not checked',title:'Eligibility has not been checked with the insurer. Open Insurance to check it.',differs:[]};
 const when=displayDate(check.completed_at||check.created_at),label=typeof claimmdStatusLabel==='function'?claimmdStatusLabel(check):'Could not confirm';
 if(check.status==='pending')return {state:'none',icon:'…',label,title:`Asked the insurer ${when}. No answer yet.`,differs:[]};
 if(check.status!=='completed')return {state:'unknown',icon:'!',label,title:`The check on ${when} did not get an answer. Open Insurance to try again.`,differs:[]};
 const summary=typeof claimmdEligibilitySummary==='function'?claimmdEligibilitySummary(check):{status:'unknown',differs:[]};
 if(summary.status==='active')return {state:'active',icon:'✓',label,title:`Active as of ${when}`,differs:summary.differs||[]};
 if(summary.status==='inactive')return {state:'inactive',icon:'✕',label,title:`The insurer answered "not active" on ${when}`,differs:summary.differs||[]};
 return {state:'unknown',icon:'!',label,title:`The insurer's answer on ${when} did not say whether coverage is active`,differs:summary.differs||[]};
}
function patientBannerVisits(now=new Date()){
 const data=patientBannerCurrent()?patientBanner.data:null;if(!data)return null;
 const next=data.next_appointment,last=data.last_visit,out={next:null,last:last?{text:'Last: '+displayDate(last.starts_at),title:`Last visit ${displayDate(last.starts_at)} · ${last.title||'Office visit'}`}:null};
 if(next){
  const starts=new Date(next.starts_at),today=patientBannerSameDay(starts,now),status=['checked_in','in_progress'].includes(next.status)?displayStatus(next.status):'';
  // Today's visit keeps its status in view; a later one keeps its type for wider screens.
  out.next=today||status?{today:true,text:`${today?'Today '+displayTime(next.starts_at):displayDateTime(next.starts_at)} · ${status||next.title||'Office visit'}`,extra:'',title:`${next.title||'Office visit'} · ${status||displayStatus(next.status)}`}
   :{today:false,text:`Next: ${displayDateTime(next.starts_at)}`,extra:next.title||'Office visit',title:`Next appointment ${displayDateTime(next.starts_at)} · ${next.title||'Office visit'}`};
 }
 return out;
}
function patientBannerFlags(insurance){
 const flags=[],data=patientBannerCurrent()?patientBanner.data:null,f=data?.flags||{},portal=['owner','clinician','front_desk'].includes(me?.role);
 const add=(key,text,tone,attrs,title)=>flags.push({key,text,tone,attrs,title});
 if(patientBanner.stale&&patientBannerCurrent())add('stale','Updated — refresh','info','data-action="reload" aria-label="This chart was updated elsewhere. Refresh"','Someone changed this chart after you opened it. Refresh to see the latest.');
 if(workspace.patient.archived)add('archived','Archived','muted','','This chart is archived. Restore it to book or start a visit.');
 if(insurance?.eligibility?.differs?.length)add('differs','Insurer has different details','warning','data-chart-section="insurance"',`The insurer's answer shows a different ${insurance.eligibility.differs.join(', ')}. Open Insurance to compare.`);
 if(f.intake_to_review>0)add('intake-review','Intake form to review','warning',patientBannerArea('documents')?'data-patient-intakes-open':'',f.intake_to_review===1?'The patient sent in an intake form that nobody has reviewed yet.':`${displayCount(f.intake_to_review,'intake form')} are waiting for review.`);
 if(f.intake_sent>0)add('intake-sent','Intake form sent','muted',patientBannerArea('documents')?'data-patient-intakes-open':'','An intake form was sent and the patient has not finished it yet.');
 if((workspace.visits||[]).some(v=>v.status==='in_progress'))add('unsigned','Unsigned note','warning','data-chart-section="visits"','A visit note is still open and has not been signed.');
 if(f.portal_status==='active')add('portal','Portal active','success',portal?`data-portal-access="${esc(selected)}"`:'','The patient has an active portal account.');
 return flags;
}
// One primary button for what usually comes next, using the same actions the chart already has.
function patientBannerPrimary(now=new Date()){
 const v=typeof activeVisit==='undefined'?null:activeVisit,archived=workspace.patient.archived,rooming=typeof isRoomingStaff==='function'&&isRoomingStaff(),clinician=['owner','clinician'].includes(me?.role);
 if(v)return `<button type="button" class="primary" data-chart-section="visits">${v.status==='signed'?'Review visit':'Continue visit'}</button>`;
 // A note left open is picked up again before anything new is started.
 const open=(workspace.visits||[]).filter(visit=>visit.status==='in_progress'),mine=open.find(visit=>visit.clinician_id===me?.user_id)||open[0];
 if(mine)return `<button type="button" class="primary" data-visit="${esc(mine.id)}">Continue visit</button>`;
 if(archived)return '';
 const today=(workspace.appointments||[]).filter(a=>patientBannerSameDay(new Date(a.starts_at),now)).sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at)));
 const ready=today.find(a=>a.status==='checked_in'&&(rooming||(clinician&&a.clinician_id===me.user_id)));
 if(ready)return `<button type="button" class="primary" data-start="${esc(ready.id)}">Start visit</button>`;
 const booked=today.find(a=>a.status==='booked');
 if(booked&&['owner','clinician','front_desk'].includes(me?.role))return `<button type="button" class="primary" data-check-in="${esc(booked.id)}">Check in</button>`;
 if(typeof canStartEncounterFlow==='function'&&canStartEncounterFlow())return '<button type="button" class="primary" data-start-encounter-flow>Start visit</button>';
 return '';
}
function patientBannerMenu(facts){
 const items=[],lifecycle=typeof patientLifecycleStates==='undefined'?null:patientLifecycleStates.get(selected);
 if(patientBannerArea('profile'))items.push('<button type="button" role="menuitem" data-chart-section="profile">Contact details</button>');
 if(['owner','clinician','front_desk'].includes(me?.role))items.push(`<button type="button" role="menuitem" data-portal-access="${esc(selected)}">Patient portal</button>`);
 if(patientBannerArea('documents')&&patientBannerCan('clinical'))items.push('<button type="button" role="menuitem" data-patient-intakes-open>Intake forms</button>');
 items.push('<button type="button" role="menuitem" data-action="reload" aria-label="Reload patient chart">Refresh</button>');
 const help=typeof supportHelpButton==='function'?supportHelpButton('patient','role="menuitem"'):'';if(help)items.push(help);
 // Archiving keeps today's rule: only people the server says may manage the chart see it.
 if(lifecycle?.can_manage&&!lifecycle.archived&&!workspace.patient.archived)items.push('<button type="button" role="menuitem" class="patient-banner-danger" data-patient-lifecycle-open>Archive this patient…</button>');
 return `<details class="patient-banner-more" data-banner-pop="more"${patientBanner.open==='more'?' open':''}><summary aria-label="More patient actions">More</summary><div class="patient-banner-menu" role="menu" aria-label="More patient actions">${facts?`<div class="patient-banner-menu-facts">${facts}</div>`:''}${items.join('')}</div></details>`;
}
function patientBannerDetails(allergies,coverages,visits,flags){
 const p=workspace.patient,c=patientBannerCan('clinical')?workspace.demographics?.content||{}:{},a=c.address,data=patientBannerCurrent()?patientBanner.data:null;
 const row=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${esc(value||'Not recorded')}</dd></div>`,rows=[];
 rows.push(row('Name',`${p.family_name}, ${p.given_name}`),row('MRN',p.mrn),row('Date of birth',displayBirthDate(p.birth_date)));
 if(patientBannerCan('clinical')){
  rows.push(row('Phone',c.phone),row('Email',c.email),row('Address',a?[a.line1,a.line2,a.city,a.region,a.postal_code].filter(Boolean).join(', '):''));
  if(c.preferred_name)rows.push(row('Goes by',c.preferred_name));
  if(c.pronouns)rows.push(row('Pronouns',c.pronouns));
  if(c.language)rows.push(row('Language',c.language));
 }
 rows.push(row('Allergies',allergies.names.length?allergies.names.join(', '):allergies.text));
 if(coverages)rows.push(coverages.length?coverages.map(cv=>row(`${displayStatus(cv.content.priority)} insurance`,[patientBannerPayer(cv),cv.content.plan_name,cv.content.member_id?'Member '+cv.content.member_id:''].filter(Boolean).join(' · '))).join(''):row('Insurance','Self-pay'));
 if(visits){rows.push(row('Last visit',visits.last?visits.last.title.replace(/^Last visit /,''):'None yet'));rows.push(row('Next appointment',visits.next?[visits.next.text.replace(/^Next: /,''),visits.next.extra].filter(Boolean).join(' · '):'None booked'));}
 if(flags.length)rows.push(row('Flags',flags.map(f=>f.text).join(', ')));
 if(data?.flags)rows.push(row('Patient portal',{active:'Active',invited:'Invited, not signed in yet',revoked:'Access removed'}[data.flags.portal_status]||'Not invited'));
 return `<details class="patient-banner-details" data-banner-pop="details"${patientBanner.open==='details'?' open':''}><summary aria-label="More about this patient">Details</summary><div class="patient-banner-panel"><dl>${rows.join('')}</dl>${patientBannerArea('profile')?'<button type="button" class="text-button" data-chart-section="profile">Edit contact details</button>':''}</div></details>`;
}
function patientBannerMarkup(now=new Date()){
 const p=workspace.patient,contact=patientBannerCan('clinical')?workspace.demographics?.content||{}:{};
 const age=displayAge(p.birth_date,now),sex={female:'F',male:'M',other:'Other'}[contact.administrative_gender]||'',sexWord={female:'Female',male:'Male',other:'Other'}[contact.administrative_gender]||'';
 const name=`${p.family_name}, ${p.given_name}`,ageSex=[age===null?'':String(age),sex].filter(Boolean).join(' · ');
 const allergies=patientBannerAllergies(),coverages=patientBannerArea('insurance')?patientBannerCoverages(now):null,visits=patientBannerVisits(now);
 const item=(key,attrs,body,title,cls='')=>attrs?`<button type="button" class="patient-banner-item ${cls}" data-banner-item="${key}" ${attrs} title="${esc(title)}">${body}</button>`:`<span class="patient-banner-item ${cls}" data-banner-item="${key}" title="${esc(title)}">${body}</span>`;
 const who=`<div class="patient-banner-who"><span class="avatar" aria-hidden="true">${esc((p.given_name||'')[0]||'')}${esc((p.family_name||'')[0]||'')}</span><div class="patient-banner-identity"><h2 class="patient-banner-name" title="${esc(name)}">${esc(name)}</h2><p class="patient-banner-facts">${ageSex?`<span title="${esc([age===null?'':age+' years old',sexWord].filter(Boolean).join(', '))}">${esc(ageSex)}</span>`:''}<span title="Date of birth">${esc(displayDate(p.birth_date))}</span><span class="patient-banner-mrn patient-banner-mid">MRN ${esc(p.mrn)}</span>${contact.preferred_name?`<span class="patient-banner-goes-by patient-banner-mid">goes by ${esc(contact.preferred_name)}</span>`:''}</p></div></div>`;
 const allergyIcon={recorded:'⚠',unreviewed:'!',none:'✓',empty:'✓'}[allergies.state];
 const allergy=item('allergies','data-clinical-focus="allergy"',`<span class="patient-banner-icon" aria-hidden="true">${allergyIcon}</span><span class="patient-banner-text">${esc(allergies.text)}</span>${allergies.more?`<span class="patient-banner-count">${esc(allergies.more)}</span>`:''}`,allergies.title,`patient-banner-allergies is-${allergies.state}`);
 let insurance=null,insuranceHtml='';
 if(coverages){
  if(coverages.length){
   const primary=coverages[0],eligibility=patientBannerEligibility(primary),payer=patientBannerPayer(primary),plan=primary.content.plan_name,copay=Number.isSafeInteger(primary.content.copay_cents)?patientBannerMoney(primary.content.copay_cents).replace(/\.00$/,'')+' copay':'',more=coverages.length-1;
   insurance={eligibility};
   const title=[`${displayStatus(primary.content.priority)} insurance: ${payer}${plan?' · '+plan:''}`,eligibility?.title,copay,more?`${displayCount(more,'more coverage')}: ${coverages.slice(1).map(patientBannerPayer).join(', ')}`:'','Open Insurance.'].filter(Boolean).join('. ');
   insuranceHtml=item('insurance','data-chart-section="insurance"',`<span class="patient-banner-text"><b>${esc(payer)}</b>${plan?` <span class="patient-banner-plan patient-banner-wide">${esc(plan)}</span>`:''}</span>${eligibility?`<span class="eligibility-pill patient-banner-pill ${eligibility.state==='none'?'':eligibility.state}" data-eligibility-state="${eligibility.state}"><span aria-hidden="true">${eligibility.icon}</span> ${esc(eligibility.label)}</span>`:''}${copay?`<span class="patient-banner-sub patient-banner-mid">${esc(copay)}</span>`:''}${more?`<span class="patient-banner-sub patient-banner-more-count">+${more} more</span>`:''}`,title,'patient-banner-insurance');
  }else insuranceHtml=item('insurance','data-chart-section="insurance"','<span class="patient-banner-text patient-banner-quiet">Self-pay</span>','No active insurance on file. Open Insurance to add coverage.','patient-banner-insurance');
 }
 const billing=patientBannerCurrent()&&patientBannerArea('billing')&&patientBannerCan('billing')?patientBanner.data?.billing:null;
 let balanceHtml='';
 if(billing&&Number.isSafeInteger(billing.patient_due_cents)){
  const owes=billing.patient_due_cents>0,count=Number(billing.open_invoice_count)||0,recheck=Number(billing.invoice_review_count)||0;
  const title=[owes?`Patient owes ${patientBannerMoney(billing.patient_due_cents)} across their visits. Money still with insurance is not counted`:'Nothing is owed by the patient. Money still with insurance is not counted',recheck?`${displayCount(recheck,'statement')} sent before a later change`:'',billing.card_on_file?'A card is saved on file':'','Open Billing.'].filter(Boolean).join('. ');
  balanceHtml=item('balance','data-chart-section="billing"',`<span class="patient-banner-text ${owes?'patient-banner-owes':'patient-banner-quiet'}">${owes?'Owes '+esc(patientBannerMoney(billing.patient_due_cents)):'No balance'}</span>${billing.card_on_file?'<span class="patient-banner-sub patient-banner-card">Card on file</span>':''}`,title,'patient-banner-balance');
 }
 let visitHtml='';
 if(visits){
  const book=!visits.next&&typeof canSchedule==='function'&&canSchedule()&&!p.archived?`<button type="button" class="text-button patient-banner-book" data-chart-book="${esc(selected)}">Book</button>`:'';
  const nextText=visits.next?visits.next.text:'No upcoming appointment';
  visitHtml=`<span class="patient-banner-visit" data-banner-item="visit">${item('visit-link','data-chart-section="visits"',`<span class="patient-banner-text${visits.next?.today?' patient-banner-today':visits.next?'':' patient-banner-quiet'}">${visits.last?`<span class="patient-banner-wide">${esc(visits.last.text)} · </span>`:''}${esc(nextText)}${visits.next?.extra?`<span class="patient-banner-wide"> · ${esc(visits.next.extra)}</span>`:''}</span>`,[visits.last?.title,visits.next?.title,'Open appointments and visits.'].filter(Boolean).join('. '),'patient-banner-visit-link')}${book}</span>`;
 }
 const flags=patientBannerFlags(insurance),flagHtml=flags.length?`<span class="patient-banner-flags" data-banner-item="flags">${flags.map(f=>f.attrs?`<button type="button" class="patient-banner-flag is-${f.tone}" data-banner-flag="${f.key}" ${f.attrs} title="${esc(f.title)}">${esc(f.text)}</button>`:`<span class="patient-banner-flag is-${f.tone}" data-banner-flag="${f.key}" title="${esc(f.title)}">${esc(f.text)}</span>`).join('')}</span>`:'';
 // The same facts again inside More, shown there only when the row has no room for them.
 const menuFacts=[flagHtml&&`<div data-banner-collapsed="flags">${flagHtml}</div>`,visitHtml&&`<div data-banner-collapsed="visit">${visitHtml}</div>`,balanceHtml&&`<div data-banner-collapsed="balance">${balanceHtml}</div>`,insuranceHtml&&`<div data-banner-collapsed="insurance">${insuranceHtml}</div>`].filter(Boolean).join('');
 const loading=!patientBannerCurrent()||(!patientBanner.data&&!patientBanner.failed)?'<span class="patient-banner-loading" role="status">Loading…</span>':patientBanner.failed&&!patientBanner.data?'<span class="patient-banner-loading" role="status">Some details could not be loaded. Use Refresh in More.</span>':'';
 return `<div class="patient-banner-row patient-banner-top">${who}${flagHtml}<div class="patient-banner-actions">${patientBannerPrimary(now)}${patientBannerDetails(allergies,coverages,visits,flags)}${patientBannerMenu(menuFacts)}</div></div><div class="patient-banner-row patient-banner-bottom">${allergy}${insuranceHtml}${balanceHtml}${visitHtml}${loading}</div>`;
}
function patientBannerStickyOffset(host){
 const header=document.querySelector?.('.workspace-header'),style=header&&typeof getComputedStyle==='function'?getComputedStyle(header):null;
 if(host?.style?.setProperty)host.style.setProperty('--patient-banner-top',(style?.position==='sticky'?Math.round(header.getBoundingClientRect().height):0)+'px');
}
let patientBannerPainted={host:null,html:''};
function renderPatientBanner(){
 const host=$('patient-banner');if(!host||typeof workspace==='undefined'||!workspace?.patient||workspace.patient.id!==selected)return;
 const html=patientBannerMarkup();
 if(patientBannerPainted.host!==host||patientBannerPainted.html!==html){
  const focus=typeof document!=='undefined'&&document.activeElement&&host.contains?.(document.activeElement)?document.activeElement:null,key=focus?.dataset?.bannerItem,flag=focus?.dataset?.bannerFlag,pop=focus?.tagName==='SUMMARY'?focus.parentElement?.dataset?.bannerPop:null;
  host.innerHTML=html;patientBannerPainted={host,html};
  // Keep the keyboard where it was when the banner repaints under it.
  if(pop)host.querySelector?.(`[data-banner-pop="${pop}"]>summary`)?.focus?.();
  else if(key)host.querySelector?.(`[data-banner-item="${key}"]`)?.focus?.();
  else if(flag)host.querySelector?.(`[data-banner-flag="${flag}"]`)?.focus?.();
 }
 patientBannerStickyOffset(host);
}
// Chart opened or redrawn: paint from what is in memory, then read the rest.
function patientBannerChartRendered(){
 if(patientBanner.patient!==selected||patientBanner.identity!==me){clearTimeout(patientBanner.timer);patientBanner={patient:selected,identity:me,data:null,failed:false,revision:null,stale:false,own:false,request:null,timer:null,open:null};}
 // A fresh chart read is the new baseline for "someone else changed this chart".
 if(patientBanner.chart!==workspace){patientBanner.chart=workspace;patientBanner.own=true;patientBanner.stale=false;}
 renderPatientBanner();
 return loadPatientBanner();
}
async function loadPatientBanner(){
 if(!selected||typeof workspace==='undefined'||!workspace?.patient)return;
 const state=patientBanner,patient=selected,identity=me;
 // One read at a time; a change that lands meanwhile asks for one more afterwards.
 if(state.request){state.again=true;return state.request;}
 const own=state.own;state.own=false;
 state.request=(async()=>{
  try{
   const data=await api(`/api/v1/patients/${patient}/banner`);
   if(patientBanner!==state||selected!==patient||me!==identity)return;
   if(data.patient_id!==patient)throw new Error('The banner details do not match this chart.');
   // The chart in memory was read before this answer. If its records changed since and
   // it was not this person's own save, say so instead of quietly showing an old chart.
   if(own||state.revision===null){state.revision=data.revision;state.stale=false;}
   else if(data.revision!==state.revision)state.stale=true;
   state.data=data;state.failed=false;
  }catch{if(patientBanner===state&&selected===patient&&me===identity)state.failed=true;}
  finally{
   if(patientBanner===state){
    state.request=null;
    if(selected===patient&&me===identity){renderPatientBanner();if(state.again){state.again=false;void loadPatientBanner();}}
   }
  }
 })();
 return state.request;
}
// Called after every successful save in the app. A short pause groups a burst of saves
// (and lets a chart reload, which repaints the banner anyway, go first).
function patientBannerChanged(){
 if(!patientBannerCurrent()||!$('patient-banner'))return;
 patientBanner.own=true;
 const state=patientBanner;clearTimeout(state.timer);
 state.timer=setTimeout(()=>{state.timer=null;if(patientBanner===state&&patientBannerCurrent()&&$('patient-banner'))void loadPatientBanner();},400);
}
function patientBannerClosePop(focus=false){
 const host=$('patient-banner'),open=host?.querySelector?.('details[data-banner-pop][open]');patientBanner.open=null;
 if(!open)return;open.open=false;if(focus)open.querySelector('summary')?.focus();
}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('toggle',event=>{const pop=event.target;if(!pop?.dataset?.bannerPop)return;if(pop.open){patientBanner.open=pop.dataset.bannerPop;for(const other of $('patient-banner')?.querySelectorAll?.('details[data-banner-pop][open]')||[])if(other!==pop)other.open=false;}else if(patientBanner.open===pop.dataset.bannerPop)patientBanner.open=null;},true);
 // Listens ahead of the action handlers (several of them stop the click) and only closes.
 (typeof window!=='undefined'&&window.addEventListener?window:document).addEventListener('click',event=>{
  const inside=event.target.closest?.('details[data-banner-pop]');
  if(!inside){patientBannerClosePop();return;}
  // Choosing something from a menu or panel closes it; the action itself is handled elsewhere.
  if(event.target.closest('.patient-banner-menu button,.patient-banner-panel button'))patientBannerClosePop();
 },true);
 document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&patientBanner.open){patientBannerClosePop(true);return;}
  const menu=event.target.closest?.('.patient-banner-menu');if(!menu||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const items=[...menu.querySelectorAll('button')].filter(node=>node.offsetParent!==null),at=items.indexOf(document.activeElement);if(!items.length)return;
  event.preventDefault();(event.key==='Home'?items[0]:event.key==='End'?items[items.length-1]:items[(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]).focus();
 });
 // Coming back to the tab is the cheap moment to notice a change made somewhere else.
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&patientBannerCurrent()&&$('patient-banner')&&!patientBanner.request)void loadPatientBanner();});
 if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('resize',()=>{const host=$('patient-banner');if(host)patientBannerStickyOffset(host);});
}
