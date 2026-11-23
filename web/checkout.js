// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let checkoutState,checkoutContext,checkoutReferrals=[],checkoutGeneration=0,followupItems=[],followupAssignees=[],followupFilter='open',followupOwner='all';
const checkoutDrafts=new Map(),checkoutStates=new Map();
const checkoutKey=(p,v)=>`${p}:${v}`;
const checkoutBase=(p=selected,v=activeVisit?.id)=>`/api/v1/patients/${p}/visits/${v}`;
const canCheckout=()=>['owner','clinician','front_desk'].includes(me.role);
function captureCheckoutDraft(){
 const f=$('avs-release-form');if(!f||!checkoutContext||f.dataset.context!==checkoutContext.key)return;
 const values=formData(f),saved=checkoutState?.current_avs?.content||{};
 if(values.instructions!==String(saved.instructions||'')||values.follow_up_instructions!==String(saved.follow_up_instructions||''))checkoutDrafts.set(checkoutContext.key,{...values,version:Number(f.dataset.version),digest:f.dataset.digest});
 else checkoutDrafts.delete(checkoutContext.key);
}
function checkoutProgress(){
 const state=activeVisit?checkoutStates.get(checkoutKey(selected,activeVisit.id)):null;
 return {label:!activeVisit?'Select an encounter':!state?'Review summary':state.checkout.completed?'Finished':state.current_avs?'Summary given · not finished':'Summary not given',complete:!!state?.checkout.completed};
}
function avsSummary(snapshot){
 if(!snapshot)return '<p class="muted">Nothing to review yet.</p>';
 const medications=snapshot.medications||[],orders=snapshot.orders||[],reviews=snapshot.list_reviews||[],v=snapshot.vitals;
 const review=kind=>reviews.find(r=>r.kind===kind)?.review_state;
 const allergies=Array.isArray(snapshot.allergies)?`<section><h4>Allergies</h4>${snapshot.allergies.length?`<ul>${snapshot.allergies.map(a=>`<li><strong>${esc(a.title)}</strong><br>${esc([a.reaction,a.severity,a.verification?human(a.verification):''].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`:`<p>${review('allergy')==='no_known'?'No known allergies.':'Allergies not reviewed yet.'}</p>`}</section>`:'';
 const problems=Array.isArray(snapshot.problems)?`<section><h4>Recorded problems</h4>${snapshot.problems.length?`<ul>${snapshot.problems.map(p=>`<li>${esc(p.title)} · ${esc(human(p.status))}${p.verification?' · '+esc(human(p.verification)):''}</li>`).join('')}</ul>`:`<p>${review('problem')==='no_known'?'No known problems.':'No problems recorded.'}</p>`}</section>`:'';
 const measuredVital=k=>v&&v[k]!==undefined&&v[k]!==null&&v[k]!==''&&Number.isFinite(Number(v[k]));
 const vitalItems=[];
 if(measuredVital('systolic_mm_hg')&&measuredVital('diastolic_mm_hg'))vitalItems.push(`Blood pressure ${esc(v.systolic_mm_hg)}/${esc(v.diastolic_mm_hg)} mmHg`);else if(measuredVital('systolic_mm_hg')||measuredVital('diastolic_mm_hg'))vitalItems.push(`Blood pressure ${esc(v.systolic_mm_hg??'—')}/${esc(v.diastolic_mm_hg??'—')} mmHg`);
 if(measuredVital('heart_rate_bpm'))vitalItems.push(`Pulse ${esc(v.heart_rate_bpm)} bpm`);
 const both=(key,unit)=>typeof vitalBothUnits==='function'?vitalBothUnits(key,v[key]):`${v[key]} ${unit}`;
 if(measuredVital('temperature_c'))vitalItems.push(`Temperature ${esc(both('temperature_c','°C'))}`);
 if(measuredVital('oxygen_saturation_pct'))vitalItems.push(`Oxygen saturation ${esc(v.oxygen_saturation_pct)}%`);
 if(measuredVital('weight_kg'))vitalItems.push(`Weight ${esc(both('weight_kg','kg'))}`);
 if(measuredVital('height_cm'))vitalItems.push(`Height ${esc(both('height_cm','cm'))}`);
 const vitals=vitalItems.length?`<section><h4>Visit vitals</h4><p>${vitalItems.join(' · ')}</p></section>`:'';
 return `<div class="avs-summary-grid">${allergies}${problems}<section><h4>Medication statements</h4>${medications.length?`<ul>${medications.map(m=>`<li><strong>${esc(m.title)}</strong><br>${esc([m.dose,m.route,m.frequency,m.status,m.verification?human(m.verification):''].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`:`<p>${review('medication')==='no_known'?'No current medications.':'No medications recorded.'}</p>`}</section><section><h4>Orders</h4>${orders.length?`<ul>${orders.map(o=>`<li><strong>${esc(o.title)}</strong> · ${esc(human(o.status))}</li>`).join('')}</ul>`:'<p>No linked orders on this summary.</p>'}</section>${vitals}</div>`;
}

function releasedAvs(avs){
 return `<article class="released-avs"><div class="section-head"><div><h3>After-visit summary · version ${avs.version}</h3><p class="muted">Released ${esc(date(avs.released_at))}</p></div><button type="button" data-avs-preview="${avs.version}">View / print summary</button></div><h4>Patient instructions</h4><p class="note-text">${esc(avs.content.instructions)}</p><h4>Follow-up instructions</h4><p class="note-text">${esc(avs.content.follow_up_instructions||'No follow-up instructions entered.')}</p>${avsSummary(avs.snapshot)}</article>`;
}
function taskCanUpdate(t){return t.can_update??(me.role==='owner'||t.assignee_id===me.user_id||t.created_by===me.user_id);}
// Follow-ups suggested from what was ordered or referred at this encounter. Pressing one fills in
// the Add follow-up task form; nothing is saved until staff choose who does it and press Add task.
function followupSuggestions(d){
 const visit=d.visit.id,have=new Set((d.followups||[]).map(t=>String(t.title||'').toLowerCase()));
 const day=n=>{const x=new Date();x.setDate(x.getDate()+n);return localTime(x.toISOString()).slice(0,10);},clip=text=>String(text).slice(0,200);
 const out=[];
 for(const o of (typeof workspace!=='undefined'&&workspace?.labs?.orders)||[])if(o.visit_id===visit&&['ordered','in_progress'].includes(o.status))out.push({title:clip(`Check result: ${o.content.title}`),due:day(7),instructions:`Confirm the result for “${o.content.title}” has arrived and been reviewed with the patient.`,reason:'Ordered at this encounter'});
 for(const r of checkoutReferrals)if(r.visit_id===visit&&['draft','ready','sent','accepted'].includes(r.status))out.push({title:clip(`Follow up on referral: ${r.content.requested_service}`),due:r.content.follow_up_due||day(14),instructions:`Confirm ${r.content.recipient} received the referral and the patient has an appointment.`,reason:'Referred at this encounter'});
 return out.filter(s=>!have.has(s.title.toLowerCase())).slice(0,6);
}
function followupSuggestionsMarkup(d){
 const items=canCheckout()?followupSuggestions(d):[];
 return items.length?`<div class="followup-suggestions"><span class="muted">Suggested from this encounter</span>${items.map((s,i)=>`<button type="button" data-followup-suggest="${i}">+ ${esc(s.title)}</button>`).join('')}</div>`:'';
}
function taskRows(items){
 const today=localTime(new Date().toISOString()).slice(0,10);
 return items.map(t=>`<article class="followup-task"><div class="section-head"><div><h4>${esc(t.title)}</h4><p class="muted">${esc(t.assignee_label||'Assigned staff')} · Due ${esc(t.due_date)} · <span class="pill">${esc(human(t.status))}</span>${t.status==='open'&&t.due_date<today?' <strong class="critical-label">Overdue</strong>':''}</p></div><button type="button" data-followup-patient="${esc(t.patient_id)}" data-followup-visit="${esc(t.visit_id)}">Open encounter</button></div><p class="note-text">${esc(t.instructions)}</p>${taskCanUpdate(t)?`<form class="followup-action-form" data-id="${esc(t.id)}" data-version="${t.version}"><div class="form-grid"><label>Task action<select name="action">${t.status==='open'?'<option value="complete">Complete task</option><option value="cancel">Cancel task</option><option value="reassign">Reassign</option><option value="reschedule">Change due date</option>':'<option value="reopen">Reopen task</option>'}</select></label><label data-followup-reassign hidden>New assignee (for reassignment)<select name="assignee_id"><option value="">Keep current assignee</option>${followupAssignees.map(a=>`<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}</select></label><label data-followup-reschedule hidden>New due date (for rescheduling)<input type="date" name="due_date"></label><label>Task update reason<input name="reason" required maxlength="1000"></label></div><button type="submit">Record task update</button></form>`:''}<details><summary>Task history</summary><div data-task-history>${(t.events||[]).map(e=>`<p>v${e.version} · ${esc(human(e.action))} · ${esc(date(e.created_at))}<br>${esc(e.reason)}</p>`).join('')||`<button type="button" data-followup-history="${esc(t.id)}">Load task history</button>`}${t.events_truncated?'<p class="muted">Older history is not included in this response.</p>':''}</div></details></article>`).join('')||'<p class="muted">No follow-up tasks recorded.</p>';
}
async function loadVisitCheckout(){
 if(!activeVisit||!$('visit-checkout'))return;
 captureCheckoutDraft();
 const patient=selected,visit=activeVisit.id,key=checkoutKey(patient,visit),generation=++checkoutGeneration;
 const panel=$('visit-checkout');panel.innerHTML='<p class="muted" role="status">Loading summary and follow-up…</p>';
 const [data,assignees,referrals]=await Promise.all([api(`${checkoutBase(patient,visit)}/checkout`),canCheckout()?api('/api/v1/follow-up/assignees'):Promise.resolve({items:[]}),canCheckout()?api(`/api/v1/patients/${patient}/referrals`).catch(()=>({items:[]})):Promise.resolve({items:[]})]);
 if(generation!==checkoutGeneration||selected!==patient||activeVisit?.id!==visit||!$('visit-checkout'))return;
 checkoutReferrals=referrals?.items||[];checkoutState=data;checkoutContext={patient,visit,key};checkoutStates.set(key,data);followupAssignees=assignees.items;
 renderVisitCheckoutContent();refreshEncounterProgress();if(typeof encounterBarSync==='function')encounterBarSync();
}
function renderVisitCheckout(){
 if(!activeVisit)return;
 loadVisitCheckout().catch(e=>{if($('visit-checkout'))$('visit-checkout').innerHTML=`<div class="notice error">${esc(e.message)}</div><button type="button" data-checkout-refresh>Try again</button>`;});
}
function renderVisitCheckoutContent(){
 const d=checkoutState,canAuthor=['owner','clinician'].includes(me.role)&&!me.delegated,signed=d.visit.status==='signed',draft=checkoutDrafts.get(checkoutContext.key),content=draft||d.current_avs?.content||{},version=draft?.version??d.version,digest=draft?.digest??d.preview_digest;
 $('visit-checkout').innerHTML=`<section class="panel checkout-workspace"><div class="section-head"><div><h2>Visit summary and follow-up</h2></div><span class="status-badge ${d.checkout.completed?'completed':'in_progress'}">${d.checkout.completed?'Finished':'Not finished'}</span></div>${!signed?'<div class="mapping-notice">Sign the note before giving the after-visit summary or finishing the encounter. You can add follow-up tasks now.</div>':''}${d.current_avs?releasedAvs(d.current_avs):'<p class="muted">No after-visit summary yet.</p>'}<div id="avs-print-preview"></div>
 ${canAuthor&&signed?`<details ${d.current_avs?'':'open'} class="avs-editor"><summary>${d.current_avs?'Release a revised summary':'Prepare patient instructions'}</summary><form id="avs-release-form" data-context="${esc(checkoutContext.key)}" data-version="${version}" data-digest="${esc(digest)}"><label>Patient instructions<textarea name="instructions" required maxlength="10000">${esc(content.instructions)}</textarea></label><label>Follow-up instructions<textarea name="follow_up_instructions" maxlength="5000">${esc(content.follow_up_instructions)}</textarea></label><h4>Clinical snapshot for review</h4>${avsSummary(d.preview_snapshot)}<p class="muted">The released summary preserves this clinical snapshot. It does not prescribe medication or include private SOAP documentation.</p>${draft&&(draft.version!==d.version||draft.digest!==d.preview_digest)?'<div class="notice error">The encounter or its clinical information changed. Your instructions are retained. Review the current information above, then continue.<button type="button" data-checkout-rebase>Use this reviewed copy</button></div>':''}<label>Release / revision reason<input name="reason" required maxlength="1000"></label><div class="actions"><button type="submit" class="primary">Release visit summary</button><button type="button" data-checkout-discard>Discard instruction edits</button></div></form></details>`:''}
 ${canCheckout()&&d.current_avs?`<section class="checkout-handoff"><h3>Patient handoff</h3><p class="muted">Record how the patient received the summary.</p><form id="avs-delivery-form" data-version="${d.version}" data-avs-version="${d.current_avs.version}"><div class="form-grid"><label>How it was given<select name="method"><option value="print">Printed copy provided</option><option value="declined">Patient declined a copy</option><option value="other">Other documented handoff</option></select></label><label>Details<input name="reason" required maxlength="1000"></label></div><button type="submit">Save</button></form><form id="checkout-complete-form" data-version="${d.version}"><label>Closing note<input name="reason" required maxlength="1000"></label><button class="primary" type="submit" ${d.checkout.completed?'disabled':''}>Finish encounter</button></form>${d.checkout.completed?`<p>Checked out ${esc(date(d.checkout.checked_out_at))}.</p>`:'<p class="muted">Record how the summary was given before checking out.</p>'}</section>`:''}
 <section class="checkout-followups"><div class="section-head"><h3>Follow-up tasks</h3><button type="button" data-followup-board>Open work queue</button></div>${taskRows(d.followups)}${followupSuggestionsMarkup(d)}${canCheckout()?`<details id="followup-create"><summary>Add follow-up task</summary><form id="followup-create-form" data-request="${crypto.randomUUID()}"><div class="form-grid"><label>Task<input name="title" required maxlength="200"></label><label>Assigned to<select name="assignee_id" required><option value="">Choose staff</option>${followupAssignees.map(a=>`<option value="${esc(a.id)}" ${a.id===d.visit.clinician_id?'selected':''}>${esc(displayPerson(a.label))} · ${esc(displayStatus(a.role))}</option>`).join('')}</select></label><label>Due date<input name="due_date" type="date" required></label></div><label>Instructions<textarea name="instructions" required maxlength="4000"></textarea></label><label>Reason<input name="reason" required maxlength="1000"></label><button type="submit">Add task</button></form></details>`:''}</section>
 <details><summary>History</summary>${d.releases.map(a=>releasedAvs(a)).join('')}${d.events.map(e=>`<p>${esc(displayStatus(e.action))} · ${esc(date(e.created_at))}<br>${esc(e.reason)}</p>`).join('')||'<p>Nothing yet.</p>'}</details><details class="how-this-works"><summary>How this works</summary><p class="muted">Signing the note, giving the summary and follow-up tasks are each recorded separately. Releasing the summary and checking out does not collect a payment or mark charges paid, and opening the print dialog does not record that the summary was given.</p></details></section>`;
}
// ---- Work queue -------------------------------------------------------------------------
// Everything waiting on the practice, gathered from where each kind of work already lives: notes
// still open, encounters whose billing is waiting on staff, results nobody has reviewed, referrals
// past their follow-up date, and the tasks staff set for each other. Each row opens the exact place
// the work is done.
const workQueueKinds=[['notes','Notes to finish'],['billing','Charges and claims'],['results','Results to review'],['referrals','Overdue referrals'],['tasks','Tasks']];
// The billing steps that wait on the practice. An encounter waiting on the insurer or the patient is
// not work for staff yet, so it is not listed.
const workQueueStaffStates=['sign_visit','post_charges','self_pay_collect','fix_claim','send_claim','correct_claim','claimmd_correction','post_response','denied','review_response','review_balance'];
var workQueueSources={},workQueueKind='all';
function workQueueItems(src){
 const rows=[],day=value=>value?(typeof displayDate==='function'?displayDate(String(value).slice(0,10)):String(value).slice(0,10)):'';
 const cash=cents=>Number.isFinite(Number(cents))&&cents!=null?money(cents):'';
 const join=parts=>parts.filter(Boolean).join(' · ');
 for(const v of src.unfinished?.items||[])rows.push({kind:'notes',visit:v.visit_id,number:v.encounter_number,patientId:v.patient_id,patient:v.patient_name,mrn:v.mrn,what:v.note_saved?'Finish and sign the note':'Write the encounter note',detail:join([v.title,day(v.starts_at),v.provider_label]),label:'Open encounter',attrs:`data-queue-visit="${esc(v.visit_id)}" data-patient="${esc(v.patient_id)}"`});
 const listed=new Set();
 for(const a of src.accounts?.items||[]){
  if(!workQueueStaffStates.includes(a.billing_state))continue;listed.add(a.id);
  rows.push({kind:'billing',visit:a.visit_id,number:a.encounter_number,patientId:a.patient_id,patient:a.patient_name,mrn:a.mrn,what:typeof visitBillingStateName==='function'?visitBillingStateName(a.billing_state):'Billing needs attention',detail:join([day(a.service_date),cash(a.total_cents),a.payer_name]),label:'Open encounter',attrs:`data-queue-account="${esc(a.id)}" data-patient="${esc(a.patient_id)}"`});
 }
 // A claim whose encounter is not in the list above still needs sending or correcting.
 for(const c of src.claims?.items||[]){
  const fix=c.status==='rejected'||c.claimmd_position?.needs_correction===true;
  if(listed.has(c.account_id)||(!fix&&!['draft','ready'].includes(c.status)))continue;listed.add(c.account_id);
  rows.push({kind:'billing',visit:c.visit_id,number:c.encounter_number,patientId:c.patient_id,patient:c.patient_name,mrn:'',what:fix?'Claim needs correcting':'Send claim',detail:join([c.payer_name,cash(c.total_cents)]),urgent:fix,label:'Open encounter',attrs:`data-queue-account="${esc(c.account_id)}" data-patient="${esc(c.patient_id)}"`});
 }
 for(const r of src.results?.items||[])rows.push({kind:'results',patient:r.patient_name,mrn:r.mrn,what:r.critical?'Critical result to review':'Result to review',detail:r.title,urgent:!!r.critical,label:'Review chart',attrs:`data-open-lab-patient="${esc(r.patient_id)}" data-order="${esc(r.order_id)}"`});
 for(const e of src.referrals?.items||[])rows.push({kind:'referrals',patient:e.patient_label,mrn:e.mrn,what:'Referral is past its follow-up date',detail:e.content?.requested_service||'',label:'Open referrals',attrs:'data-queue-referrals'});
 return rows;
}
function workQueueMarkup(rows,tasks,kind,missing){
 const count=key=>key==='tasks'?tasks:rows.filter(row=>row.kind===key).length,total=rows.length+tasks;
 const chip=(key,label,n)=>`<button type="button" data-queue-kind="${key}" aria-pressed="${kind===key}">${esc(label)} <span class="pill">${n}</span></button>`;
 const groups=workQueueKinds.filter(([key])=>key!=='tasks'&&(kind==='all'||kind===key)).map(([key,label])=>{
  const mine=rows.filter(row=>row.kind===key);if(!mine.length)return '';
  return `<section class="work-queue-group" data-queue-group="${key}"><h3>${esc(label)} <span class="pill">${mine.length}</span></h3><ul class="work-queue-list">${mine.map(row=>`<li${row.urgent?' class="is-urgent"':''}><div><p class="work-queue-who"><b>${esc(row.patient||'Patient')}</b>${row.mrn?` <span class="record-id">MRN ${esc(row.mrn)}</span>`:''}${row.visit&&typeof encounterTimelineChip==='function'?' '+encounterTimelineChip(null,typeof encounterNumberLabel==='function'?encounterNumberLabel(row.number):'',{visit:row.visit,patient:row.patientId}):''}</p><p class="work-queue-what"><strong>${esc(row.what)}</strong>${row.detail?` · ${esc(row.detail)}`:''}</p></div><button type="button" ${row.attrs}>${esc(row.label)}</button></li>`).join('')}</ul></section>`;
 }).join('');
 const nothing=kind==='all'?total===0:count(kind)===0;
 return `<p class="muted">Everything waiting on the practice, in one list. Open a row to do the work; it leaves the list when it is done.</p><div class="work-queue-kinds" role="group" aria-label="Show">${chip('all','Everything',total)}${workQueueKinds.map(([key,label])=>chip(key,label,count(key))).join('')}</div>${missing?'<p class="muted" role="status">Some lists are not shown: they could not be loaded, or are outside your access.</p>':''}${groups}${nothing&&kind!=='tasks'?`<p class="work-queue-empty" role="status">${kind==='all'?'Nothing is waiting on the practice right now.':'Nothing is waiting here right now.'}</p>`:''}`;
}
async function showFollowupWorkspace(){
 const settle=request=>request.then(value=>({value}),()=>({failed:true}));
 const [taskData,assignees,unfinished,accounts,claims,results,referrals]=await Promise.all([api(`/api/v1/follow-up/tasks?${new URLSearchParams({status:followupFilter,...(followupOwner==='mine'?{assignee_id:me.user_id}:{})})}`),canCheckout()?api('/api/v1/follow-up/assignees'):Promise.resolve({items:[]}),settle(api('/api/v1/practice/worklist')),settle(api('/api/v1/billing/overview')),settle(api('/api/v1/billing/claims')),settle(api('/api/v1/labs/inbox')),settle(api('/api/v1/referrals/worklist?overdue=true&_count=100'))]);
 const data=taskData;
 followupItems=data.items;followupAssignees=assignees.items;showTool('Work queue');
 workQueueSources={unfinished:unfinished.value,accounts:accounts.value?.accounts,claims:claims.value,results:results.value,referrals:referrals.value,missing:[unfinished,accounts,claims,results,referrals].some(part=>part.failed)};
 $('tools').innerHTML=`<section id="followup-workspace"><div class="section-head"><div><h2>Work queue</h2></div><div class="actions">${typeof showWorkflowRunQueue==='function'&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('workflows','view'))?'<button type="button" data-journey-workqueue>Patient journeys</button>':''}<button type="button" data-followup-board>Refresh</button></div></div><div id="work-queue-rows"></div><section class="work-queue-group" id="work-queue-tasks" data-queue-group="tasks"><h3>Tasks</h3><form id="followup-filter-form"><div class="form-grid"><label>Show<select id="followup-status">${[['open','Open tasks'],['all','All statuses'],['completed','Completed'],['cancelled','Cancelled']].map(([v,l])=>`<option value="${v}" ${followupFilter===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Assigned to<select id="followup-owner"><option value="all" ${followupOwner==='all'?'selected':''}>All staff</option><option value="mine" ${followupOwner==='mine'?'selected':''}>Assigned to me</option></select></label></div><button type="submit">Apply</button></form>${data.has_more?`<p class="muted">Showing the first ${data.items.length} of ${data.total??'many'} tasks.</p>`:''}<div id="followup-rows"></div></section></section>`;
 renderFollowupRows();renderWorkQueue();
}
function renderWorkQueue(){
 const host=$('work-queue-rows');if(!host)return;
 const open=followupItems.filter(task=>task.status==='open').length;
 host.innerHTML=workQueueMarkup(workQueueItems(workQueueSources),open,workQueueKind,workQueueSources.missing);
 const tasks=$('work-queue-tasks');if(tasks)tasks.hidden=!(workQueueKind==='all'||workQueueKind==='tasks');
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',async event=>{
 const button=event.target?.closest?.('#followup-workspace button');if(!button)return;
 if(button.dataset.queueKind){workQueueKind=button.dataset.queueKind;renderWorkQueue();return;}
 if(button.dataset.queueVisit){await showClinical();await selectPatient(button.dataset.patient,button.dataset.queueVisit);if(typeof showChartSection==='function')showChartSection('visits');return;}
 // The encounter that owns the charges or the claim opens on its billing, where the next step is.
 if(button.dataset.queueAccount){const identity=me,patient=button.dataset.patient;await showClinical();if(me!==identity)return;await selectPatient(patient,null);if(me!==identity||selected!==patient)return;await openEncounterBillingAccount(button.dataset.queueAccount);return;}
 if(button.hasAttribute('data-queue-referrals')&&typeof showReferralWorkspace==='function'){if(typeof referralBoard!=='undefined')referralBoard.overdue=true;await showReferralWorkspace();}
});
function renderFollowupRows(){
 const status=$('followup-status').value,mine=$('followup-owner').value==='mine';
 const items=followupItems.filter(t=>(status==='all'||t.status===status)&&(!mine||t.assignee_id===me.user_id));
 $('followup-rows').innerHTML=items.map(t=>`<section class="panel"><p class="eyebrow">${esc(t.patient_name)} · MRN ${esc(t.mrn)}</p>${taskRows([t])}</section>`).join('')||'<div class="empty-state"><p>No tasks match. Staff add a task from an encounter’s note when something needs following up.</p></div>';
}
function showAvsPrint(version){
 const avs=checkoutState.releases.find(a=>a.version===version)||checkoutState.current_avs;if(!avs||avs.version!==version)throw new Error('Reload the summary before printing.');
 const p=avs.snapshot.patient,frame=document.createElement('iframe');frame.id='avs-print-frame';frame.title=`After-visit summary version ${version} print preview`;frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');
 frame.srcdoc=`<!doctype html><html lang="en"><meta charset="utf-8"><title>After-visit summary</title><link rel="stylesheet" href="/avs-print.css"><h1>SunCharts EHR · After-visit summary</h1><p>${esc(p.given_name)} ${esc(p.family_name)} · MRN ${esc(p.mrn)}<br>Date of birth ${esc(p.birth_date)}<br>Summary version ${version} · Released ${esc(date(avs.released_at))}</p><p>Visit ${avs.snapshot.visit?.starts_at?esc(date(avs.snapshot.visit.starts_at)):''} · ${esc(avs.snapshot.visit?.title||'')}<br>${esc([avs.snapshot.visit?.signed_by_label?`Seen by ${avs.snapshot.visit.signed_by_label}`:avs.snapshot.visit?.clinician_label,avs.snapshot.visit?.facility].filter(Boolean).join(' · '))}</p><h2>Patient instructions</h2><p>${esc(avs.content.instructions)}</p><h2>Follow-up instructions</h2><p>${esc(avs.content.follow_up_instructions||'No follow-up instructions entered.')}</p>${avsSummary(avs.snapshot)}</html>`;
 const target=$('avs-print-preview');target.innerHTML='<div class="section-head"><h3>Patient summary print preview</h3><button type="button" data-avs-print>Print this summary</button></div>';target.append(frame);target.scrollIntoView({block:'start'});
}
document.addEventListener('click',e=>{
 const b=e.target.closest?.('[data-followup-suggest]');if(!b||!checkoutState)return;e.preventDefault();
 const s=followupSuggestions(checkoutState)[Number(b.dataset.followupSuggest)],form=$('followup-create-form'),box=$('followup-create');if(!s||!form)return;
 if(box)box.open=true;
 for(const [name,value] of [['title',s.title],['due_date',s.due],['instructions',s.instructions],['reason',s.reason]])if(form.elements[name])form.elements[name].value=value;
 form.scrollIntoView?.({block:'center'});(form.elements.assignee_id?.value?form.querySelector('button[type=submit]'):form.elements.assignee_id)?.focus?.({preventScroll:true});
});
document.addEventListener('input',e=>{if(e.target.closest?.('#avs-release-form'))captureCheckoutDraft();});
document.addEventListener('change',e=>{if(e.target.name!=='action')return;const form=e.target.closest?.('.followup-action-form');if(!form)return;for(const [kind,field] of [['reassign','assignee_id'],['reschedule','due_date']]){form.querySelector(`[data-followup-${kind}]`).hidden=e.target.value!==kind;form.elements[field].required=e.target.value===kind;}});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||!['data-checkout-refresh','data-checkout-discard','data-checkout-rebase','data-followup-board','data-followup-patient','data-followup-history','data-avs-preview','data-avs-print'].some(a=>b.hasAttribute(a)))return;
 e.preventDefault();e.stopImmediatePropagation();
 run(async()=>{
  if(b.dataset.followupHistory){const d=await api(`/api/v1/follow-up/tasks/${b.dataset.followupHistory}`),target=b.closest('.followup-task').querySelector('[data-task-history]');target.innerHTML=(d.events||[]).map(e=>`<p>v${e.version} · ${esc(human(e.action))} · ${esc(date(e.created_at))}<br>${esc(e.reason)}</p>`).join('')+(d.events_truncated?'<p>Older history is not included.</p>':'');return;}
  if(b.hasAttribute('data-followup-board')){await showFollowupWorkspace();return;}
  if(b.dataset.followupPatient){await showClinical();await selectPatient(b.dataset.followupPatient,b.dataset.followupVisit);showChartSection('checkout');return;}
  if(b.dataset.avsPreview){showAvsPrint(Number(b.dataset.avsPreview));return;}
  if(b.hasAttribute('data-avs-print')){$('avs-print-frame').contentWindow.focus();$('avs-print-frame').contentWindow.print();return;}
  if(b.hasAttribute('data-checkout-rebase')){captureCheckoutDraft();const draft=checkoutDrafts.get(checkoutContext.key);if(draft)checkoutDrafts.set(checkoutContext.key,{...draft,version:checkoutState.version,digest:checkoutState.preview_digest});renderVisitCheckoutContent();return;}
  if(b.hasAttribute('data-checkout-discard')){checkoutDrafts.delete(checkoutContext.key);$('avs-release-form')?.remove();}
  await loadVisitCheckout();
 });
},true);
document.addEventListener('submit',e=>{
 const f=e.target;if(!['avs-release-form','avs-delivery-form','checkout-complete-form','followup-create-form','followup-filter-form'].includes(f.id)&&!f.classList.contains('followup-action-form'))return;
 e.preventDefault();e.stopImmediatePropagation();
 run(async()=>{
  const values=formData(f);if(f.id==='followup-filter-form'){followupFilter=$('followup-status').value;followupOwner=$('followup-owner').value;await showFollowupWorkspace();return;}const base=checkoutContext?checkoutBase(checkoutContext.patient,checkoutContext.visit):'';let saved='Saved.';
 if(f.id==='avs-release-form'){await api(base+'/checkout/actions','POST',{action:'release_avs',instructions:values.instructions,follow_up_instructions:values.follow_up_instructions,reason:values.reason,reviewed:true,reviewed_snapshot_digest:f.dataset.digest},Number(f.dataset.version));checkoutDrafts.delete(checkoutContext.key);f.remove();saved='After-visit summary released.';}
 else if(f.id==='avs-delivery-form'){await api(base+'/checkout/actions','POST',{action:'delivery',method:values.method,reason:values.reason,avs_version:Number(f.dataset.avsVersion)},Number(f.dataset.version));saved='Delivery recorded.';}
 else if(f.id==='checkout-complete-form'){await api(base+'/checkout/actions','POST',{action:'checkout',reason:values.reason},Number(f.dataset.version));saved='Encounter finished.';}
 else if(f.id==='followup-create-form'){await api(base+'/follow-ups','POST',{request_id:f.dataset.request,...values});saved='Follow-up added.';}
 else {const body={action:values.action,reason:values.reason};if(values.action==='reassign')body.assignee_id=values.assignee_id;if(values.action==='reschedule')body.due_date=values.due_date;await api(`/api/v1/follow-up/tasks/${f.dataset.id}/actions`,'POST',body,Number(f.dataset.version));saved='Follow-up updated.';}
 if(f.closest('#followup-workspace'))await showFollowupWorkspace();else await loadVisitCheckout();
 notice(saved);
 });
},true);

// The work queue follows its filters as they change; there is no separate step to apply them.
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('change',event=>{const form=event.target?.closest?.('#followup-filter-form');if(form?.requestSubmit)form.requestSubmit();});
