// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One timeline for an encounter. The patient header, the encounter's own page and the small chip on
// lists elsewhere all draw their progress from encounterTimelineSteps, so they cannot disagree. Every
// amount and state comes from the server's billing summary; this file only words and lays it out.
// The functions here are pure: they read what they are given and touch no screen until a click.
const encounterTimelineStateWords={done:'Done',now:'Now',later:'Later',skipped:'Skipped'};
function encounterTimelineMoney(cents){return typeof money==='function'?money(cents):`$${(Number(cents)/100).toFixed(2)}`;}
function encounterTimelineTime(value){
 if(!value)return '';
 if(typeof displayTime==='function'){try{return displayTime(value)||'';}catch{return '';}}
 const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'':parsed.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
}
function encounterTimelineDay(value){return typeof visitBillingDate==='function'?visitBillingDate(value):'';}
// The step staff can act on, taken from the server's own state word so the timeline and the next-step
// bar say the same thing. A state with no entry here falls back to the first step not done.
const encounterTimelineStateStep={sign_visit:'note',post_charges:'charges',prepare_claim:'claim',fix_claim:'claim',send_claim:'claim',correct_claim:'claim',claim_cancelled:'claim',denied:'claim',claimmd_correction:'claim',claim_restricted:'claim',claimmd_received:'insurer',waiting_insurer:'insurer',post_response:'insurer',review_response:'insurer',insurance_outside:'insurer',patient_owes:'closed',self_pay_collect:'closed',review_balance:'closed',patient_credit:'closed'};
const encounterTimelineClaimFix=['fix_claim','denied','claimmd_correction','correct_claim'];
function encounterTimelineSteps(summary,visit,appointment){
 const s=summary||null,p=s?.patient||{},i=s?.insurance||{},insured=!!s&&i.insured===true;
 const signed=visit?.status==='signed'||!!visit?.signed_at,posted=s?.account?.status==='posted';
 const state=s?.state||'',owes=Number(p.owes_now_cents)||0,pending=Number(i.pending_cents)||0,unassigned=Number(i.unassigned_cents)||0,balance=Number(s?.balance_cents)||0;
 const arrived=!!visit||['checked_in','in_progress','completed'].includes(appointment?.status);
 const steps=[],add=(key,label,detail,done)=>steps.push({key,label,detail:detail||'',done:!!done,state:done?'done':'later'});
 add('checkin','Checked in',arrived?encounterTimelineTime(appointment?.checked_in_at||appointment?.arrived_at):'',arrived);
 if(s&&p.copay_cents!=null){
  const due=Number(p.copay_due_cents)||0,paid=Number(p.copay_paid_cents)||0,done=posted||due<=0;
  // Once the charges are posted and the patient owes nothing, the copay line never says money is due.
  const settled=posted&&(Number(p.owes_now_cents)||0)<=0;
  add('copay','Copay',settled?(paid>0?`${encounterTimelineMoney(paid)} paid`:'Nothing due'):paid>0&&due<=0?`${encounterTimelineMoney(paid)} paid`:due>0?`${encounterTimelineMoney(due)} due`:done?'Nothing due':'',done);
 }
 add('note','Note signed',signed?encounterTimelineTime(visit?.signed_at):'',signed);
 add('charges',posted?'Charges posted':'Charges',s&&s.charges_cents!=null?encounterTimelineMoney(s.charges_cents)+(s.account?.status==='draft'?' (not posted)':''):'',posted);
 let sentDetail='',insurerDone=false,claimDone=false;
 if(insured){
  const sent=['waiting','answered','denied'].includes(i.status)&&!encounterTimelineClaimFix.includes(state)&&state!=='claim_cancelled';
  claimDone=sent;
  add('claim','Claim sent',sent?(i.sent_on?encounterTimelineDay(i.sent_on):''):'',sent);
  insurerDone=i.status==='answered'&&pending<=0&&unassigned<=0&&!['post_response','review_response'].includes(state);
  add('insurer','Insurer paid',insurerDone?`${encounterTimelineMoney(Number(i.paid_cents)||0)} paid`:pending>0&&posted?`${encounterTimelineMoney(pending)} pending`:'',insurerDone);
 }
 const nothingOwed=posted&&owes<=0&&pending<=0&&unassigned<=0&&balance<=0&&(!insured||insurerDone)&&!(state in encounterTimelineStateStep);
 add('closed','Closed',nothingOwed?'Nothing owed':'',nothingOwed);
 // The step staff can act on right now.
 let nowKey=null;
 const mapped=encounterTimelineStateStep[state];
 if(state==='add_charges')nowKey=signed?'charges':'note';
 else if(mapped&&steps.some(step=>step.key===mapped))nowKey=mapped;
 else if(state==='paid_in_full')nowKey=null;
 else nowKey=(steps.find(step=>!step.done)||{}).key||null;
 let reached=false;
 for(const step of steps){
  if(step.key===nowKey){step.state='now';step.done=false;reached=true;}
  else if(step.done)step.state='done';
  else step.state=reached||nowKey===null?'later':'skipped';
 }
 // What the step in hand needs said about it.
 const now=steps.find(step=>step.state==='now');
 if(now&&s){
  const set=text=>{now.detail=text;};
  if(now.key==='claim')set(encounterTimelineClaimFix.includes(state)?'Needs fixing':state==='send_claim'?'Ready to send':state==='prepare_claim'?'Being prepared':state==='claim_cancelled'?'Cancelled':state==='claim_restricted'?'Billing staff':'Not sent yet');
  else if(now.key==='insurer')set(state==='post_response'||state==='review_response'?'Review the answer':state==='insurance_outside'?'Billed outside':pending>0?`${encounterTimelineMoney(pending)} pending`:'Waiting');
  else if(now.key==='closed')set(state==='patient_credit'?`Patient credit ${encounterTimelineMoney(Number(p.credit_cents)||0)}`:state==='review_balance'?`${encounterTimelineMoney(unassigned)} not on the statement`:`Patient owes ${encounterTimelineMoney(owes)}`);
  else if(now.key==='charges'&&!now.detail)set(s.account?'Not posted yet':'Not added yet');
  else if(now.key==='note'&&!now.detail)set('Not signed yet');
  else if(now.key==='copay'&&!now.detail)set('Not paid yet');
 }
 return steps.map(({key,label,detail,state:value})=>({key,label,detail,state:value}));
}
function encounterTimelineDoneCount(steps){return steps.filter(step=>step.state==='done').length;}
function encounterTimelineLabel(step){return `${encounterTimelineStateWords[step.state]||'Later'}: ${step.label}.${step.detail?' '+step.detail:''}`;}
function encounterTimelineMarkup(steps,{title='',subtitle='',nextAction=''}={}){
 const done=encounterTimelineDoneCount(steps);
 const head=`<div class="encounter-timeline-head"><b>${esc(title)}</b>${subtitle?`<span class="muted">${esc(subtitle)}</span>`:''}<span class="encounter-timeline-count">${done} of ${steps.length} done</span></div>`;
 const action=nextAction.match(/<button\b([^>]*)>/)?.[1]||' type="button" data-timeline-now';
 const items=steps.map(step=>{const body=`<span class="encounter-timeline-bar"></span><b>${esc(step.label)}</b><small>${esc(step.detail)}</small>`;return `<li class="is-${esc(step.state)}" data-timeline-step="${esc(step.key)}"${step.state==='now'?' aria-current="step"':''}>${step.state==='now'?`<button${action} aria-label="${esc(encounterTimelineLabel(step))}">${body}</button>`:body}</li>`;}).join('');
 return `<section class="encounter-timeline-block" aria-label="Encounter progress">${head}<ol class="encounter-timeline">${items}</ol></section>`;
}
// The small inline version for lists. With no steps (nothing is known about the money) it is a plain chip.
function encounterTimelineChip(steps,number,extra={}){
 const id=extra.visit||extra.visitId||'',attrs=`${id?` data-encounter-chip="${esc(id)}"`:' data-encounter-chip=""'}${extra.patient?` data-patient="${esc(extra.patient)}"`:''}${extra.amount!=null&&extra.amount!==''?` data-payment-amount="${esc(extra.amount)}"`:''}${extra.date?` data-payment-date="${esc(extra.date)}"`:''}${number?` data-encounter-number="${esc(number)}"`:''}`;
 if(!steps||!steps.length)return `<button type="button" class="encounter-chip is-plain"${attrs} title="Open this encounter">${esc(number||'Encounter')}<span class="encounter-chip-now">Open</span></button>`;
 const now=steps.find(step=>step.state==='now'),words=now?now.label:'Closed';
 return `<button type="button" class="encounter-chip"${attrs} aria-label="${esc(`${number||'Encounter'}. ${now?`Now: ${now.label}`:'Closed'}`)}">${esc(number||'Encounter')}<span class="encounter-chip-steps" aria-hidden="true">${steps.map(step=>`<i class="is-${esc(step.state)}"></i>`).join('')}</span><span class="encounter-chip-now">${esc(words)}</span></button>`;
}
// "ENC-0005" from the encounter number a server row carries (empty when it has none).
function encounterNumberLabel(n){return typeof encounterNumberText==='function'?encounterNumberText({encounter_number:n}):'';}
// The chip for a list row that names its encounter (visit_id, encounter_number). The number comes from
// the row itself, so it shows even when that patient's chart is not open. A row with no encounter
// gets nothing.
function encounterRowChip(row,extra={}){
 const id=row?.visit_id;if(!id||typeof encounterTimelineChip!=='function')return '';
 let number=encounterNumberLabel(row.encounter_number);
 if(!number&&typeof workspace!=='undefined'&&typeof encounterNumberText==='function')number=encounterNumberText((workspace?.visits||[]).find(v=>v.id===id));
 return encounterTimelineChip(null,number,{...extra,visit:id,patient:row.patient_id||extra.patient});
}
// The line above the timeline: which encounter, when, with whom.
function encounterTimelineHeading(visit,appointment,summary){
 const number=typeof encounterNumberText==='function'?encounterNumberText(visit):'',kind=appointment?.title||'';
 const when=appointment?.starts_at?(typeof displayDate==='function'?displayDate(appointment.starts_at):''):'',insurer=summary?.insurance?.insured===false?'Self-pay':(summary?.claim?.payer_name||summary?.insurance?.insurer||'');
 const nextAction=summary&&typeof visitBillingStatus==='function'?visitBillingStatus(summary,{canWrite:typeof billingCan==='function'&&billingCan(),canCreate:typeof billingCan==='function'&&billingCan('create')}).action:'';
 return {title:[number||'Encounter',kind].filter(Boolean).join(' · '),subtitle:[when,insurer].filter(Boolean).join(' · '),nextAction};
}
// The summary for an open encounter is already on the page; any other is read once, the way the
// encounter page reads it. Without one (no access, or the read failed) the steps come from the encounter alone.
async function encounterTimelineSummary(visitId,patientId){
 if(typeof encounterRevenueState!=='undefined'&&encounterRevenueState?.visit===visitId&&encounterRevenueState.data?.summary)return encounterRevenueState.data.summary;
 const patient=patientId||(typeof selected!=='undefined'?selected:null);
 if(!patient||typeof api!=='function')return null;
 try{return await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/visit-summary?visit_id=${encodeURIComponent(visitId)}`);}catch{return null;}
}
// A short look at one encounter from anywhere in the chart: its timeline, what was charged, and a way to go to it.
async function encounterPreviewOpen(visitId,extra={}){
 const visit=(workspace?.visits||[]).find(v=>v.id===visitId);if(!visit||typeof sheetOpen!=='function')return;
 const appointment=(workspace?.appointments||[]).find(a=>a.id===visit.appointment_id),number=typeof encounterNumberText==='function'?encounterNumberText(visit):'';
 const panel=document.createElement('div');panel.className='payment-encounter-preview';panel.dataset.timelineVisit=visitId;panel.dataset.timelinePatient=typeof selected!=='undefined'?selected:'';
 const fact=(label,value)=>value?`<div><dt>${label}</dt><dd>${value}</dd></div>`:'';
 const paid=extra.amount!=null&&extra.amount!==''?`${money(Number(extra.amount))}${extra.date?' on '+esc(date(extra.date)):''}`:'';
 const paint=summary=>{const host=panel.querySelector('[data-preview-timeline]');if(host)host.innerHTML=encounterTimelineMarkup(encounterTimelineSteps(summary,visit,appointment),encounterTimelineHeading(visit,appointment,summary));};
 panel.innerHTML=`<div data-preview-timeline></div><dl class="payment-encounter-facts">${fact('Encounter',esc(appointment?.title||'Encounter'))}${fact('Date',appointment?.starts_at?esc(date(appointment.starts_at)):'')}${fact('Note',visit.status==='signed'?'Signed':'Not signed yet')}${fact('This payment',paid)}</dl><div data-preview-codes><p class="muted">Loading charges…</p></div><div class="actions"><button type="button" class="primary" data-preview-open>Go to encounter</button><button type="button" data-sheet-close>Close</button></div>`;
 paint(null);
 const dialog=sheetOpen(number?`Encounter ${number}`:'Encounter',panel);
 panel.querySelector('[data-preview-open]').addEventListener('click',()=>{sheetClose(dialog);run(()=>encounterGoTo(visit.id,visit.patient_id||(typeof selected!=='undefined'?selected:null)));});
 void encounterTimelineSummary(visit.id).then(summary=>{if(summary&&dialog.isConnected!==false)paint(summary);});
 const evidence=typeof visitReceiptEvidence==='function'?await visitReceiptEvidence(visit.appointment_id).catch(()=>null):null,host=panel.querySelector('[data-preview-codes]');if(!host)return;
 const lines=evidence?.lines||[],diagnoses=evidence?.diagnoses||[],total=lines.reduce((sum,line)=>sum+(Number(line.amount_cents)||0),0);
 host.innerHTML=lines.length||diagnoses.length?`${lines.length?`<table class="billing-table"><thead><tr><th>Charge</th><th></th><th>Amount</th></tr></thead><tbody>${lines.map(line=>`<tr><td><b>${esc(line.code||'')}</b></td><td>${esc(line.description||'')}${Number(line.units)>1?` × ${esc(line.units)}`:''}</td><td>${line.amount_cents==null?'':money(line.amount_cents)}</td></tr>`).join('')}<tr><td colspan="2"><b>Total charges</b></td><td><b>${money(total)}</b></td></tr></tbody></table>`:'<p class="muted">No charges on this encounter yet.</p>'}${diagnoses.length?`<p><span class="muted">Diagnoses</span> ${diagnoses.map(d=>`<b>${esc(String(d.code).trim())}</b> ${esc(d.display||'')}`).join(' · ')}</p>`:''}`:'<p class="muted">No charges on this encounter yet.</p>';
}
// Go to an encounter from anywhere: the patient area, that patient's chart, then the encounter.
async function encounterGoTo(visitId,patientId){
 const identity=me;
 if(me!==identity)return;
 const patient=patientId||(typeof selected!=='undefined'?selected:null);
 if(patient&&(selected!==patient||!(workspace?.visits||[]).some(v=>v.id===visitId)))await selectPatient(patient,null);
 if(me!==identity||(patient&&selected!==patient))return;
 if(!(workspace?.visits||[]).some(v=>v.id===visitId))throw new Error('This encounter could not be found in the patient’s chart.');
 await openPatientEncounter(visitId);
}
// The preview of an encounter whose chart is not open: its timeline, read on its own, and the way in.
async function encounterPreviewElsewhere(visitId,patient,number){
 if(typeof sheetOpen!=='function')return;
 const identity=me,panel=document.createElement('div');panel.className='payment-encounter-preview';panel.dataset.timelineVisit=visitId;panel.dataset.timelinePatient=patient;
 panel.innerHTML=`<div data-preview-timeline>${typeof skeletonMarkup==='function'?skeletonMarkup('card'):'<p class="muted" role="status">Loading…</p>'}</div><div class="actions"><button type="button" class="primary" data-preview-open>Go to encounter</button><button type="button" data-sheet-close>Close</button></div>`;
 const dialog=sheetOpen(number?`Encounter ${number}`:'Encounter',panel);
 panel.querySelector('[data-preview-open]').addEventListener('click',()=>{sheetClose(dialog);run(()=>encounterGoTo(visitId,patient));});
 const [visit,summary]=await Promise.all([api(`/api/v1/visits/${encodeURIComponent(visitId)}`).catch(()=>null),encounterTimelineSummary(visitId,patient)]);
 const host=panel.querySelector('[data-preview-timeline]');if(!host||dialog.isConnected===false||me!==identity)return;
 if(!visit){host.innerHTML='<p class="muted">This encounter’s details could not be loaded. Use Go to encounter.</p>';return;}
 host.innerHTML=encounterTimelineMarkup(encounterTimelineSteps(summary,visit,null),encounterTimelineHeading(visit,null,summary));
}
// From a chip on a list: the open patient's encounter opens its full preview; a chip on another
// patient's row previews it in place.
async function encounterChipOpen(chip){
 const visitId=chip.dataset.encounterChip,patient=chip.dataset.patient,extra={amount:chip.dataset.paymentAmount,date:chip.dataset.paymentDate};
 if(!visitId)return;
 const identity=me,own=()=>typeof workspace!=='undefined'&&(workspace?.visits||[]).some(v=>v.id===visitId)&&(!patient||selected===patient);
 if(!own()){
  if(!patient)throw new Error('This encounter is in another patient’s chart. Open the patient first.');
  // A chip on a list previews the encounter where you are; the chart opens only on Go to encounter.
  await encounterPreviewElsewhere(visitId,patient,chip.dataset.encounterNumber||'');return;
 }
 await encounterPreviewOpen(visitId,extra);
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',event=>{
 const chip=event.target?.closest?.('[data-encounter-chip]');if(!chip||!chip.dataset?.encounterChip)return;
 event.preventDefault();event.stopPropagation();run(()=>encounterChipOpen(chip));
},true);

if(typeof document!=='undefined')document.addEventListener('click',event=>{
 const button=event.target.closest?.('.encounter-timeline button');if(!button)return;
 const preview=button.closest('.payment-encounter-preview');
 if(preview){event.preventDefault();event.stopImmediatePropagation();const attr=Array.from(button.attributes).find(a=>a.name.startsWith('data-')&&a.name!=='data-timeline-now');let next,patient;run(async()=>{const dialog=preview.closest('dialog');if(dialog)sheetClose(dialog);await encounterGoTo(preview.dataset.timelineVisit,preview.dataset.timelinePatient);patient=selected;if(typeof loadEncounterRevenueStatus==='function')await loadEncounterRevenueStatus(typeof encounterChargeAccount==='function'?encounterChargeAccount():null);const scope=$('encounter-revenue');if(attr)next=Array.from(scope?.querySelectorAll(`[${attr.name}]`)||[]).find(b=>b.getAttribute(attr.name)===attr.value);else next=document.querySelector('.visit-billing-status .actions button,#patient-next-action button');}).then(()=>{if(next?.isConnected&&selected===patient)next.click();});return;}
 if(!button.hasAttribute('data-timeline-now'))return;event.preventDefault();event.stopImmediatePropagation();
 const next=document.querySelector('.visit-billing-status .actions button,#patient-next-action button');next?.click();
},true);
