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
 if(values.instructions!==String(saved.instructions||'')||values.follow_up_instructions!==String(saved.follow_up_instructions||'')||Boolean(values.reason?.trim()))checkoutDrafts.set(checkoutContext.key,{...values,version:Number(f.dataset.version),digest:f.dataset.digest});
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

function releasedAvs(avs, compact=false, inVisit=false){
 const snapshot=inVisit?'<details data-inline><summary>Included clinical information</summary>'+avsSummary(avs.snapshot)+'</details>':avsSummary(avs.snapshot);
 const content=`<h4>Patient instructions</h4><p class="note-text">${esc(avs.content.instructions)}</p><h4>Follow-up instructions</h4><p class="note-text">${esc(avs.content.follow_up_instructions||'No follow-up instructions entered.')}</p>${snapshot}`;
 return `<article class="released-avs"><div class="section-head"><div><h3>Encounter summary · version ${avs.version}</h3><p class="muted">Released ${esc(date(avs.released_at))}</p></div><button type="button" data-avs-preview="${avs.version}">View / print summary</button></div>${compact?`<details data-inline data-checkout-disclosure="released"><summary>Read released instructions</summary>${content}</details>`:content}</article>`;
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
 const panel=$('visit-checkout');if(!panel.firstElementChild)panel.innerHTML='<p class="muted" role="status">Sign the note to release the patient summary. Follow-up tasks can be added here.</p>';
 const [data,assignees,referrals]=await Promise.all([api(`${checkoutBase(patient,visit)}/checkout`),canCheckout()?api('/api/v1/follow-up/assignees'):Promise.resolve({items:[]}),canCheckout()?api(`/api/v1/patients/${patient}/referrals`).catch(()=>({items:[]})):Promise.resolve({items:[]})]);
 if(generation!==checkoutGeneration||selected!==patient||activeVisit?.id!==visit||!$('visit-checkout'))return;
 checkoutReferrals=referrals?.items||[];checkoutState=data;checkoutContext={patient,visit,key};checkoutStates.set(key,data);followupAssignees=assignees.items;
 renderVisitCheckoutContent();refreshEncounterProgress();if(typeof encounterBarSync==='function')encounterBarSync();
}
function renderVisitCheckout(){
 if(!activeVisit)return;
 const visit=activeVisit.id,patient=selected,identity=me,panel=$('visit-checkout');
 loadVisitCheckout().catch(e=>{if(panel&&panel===$('visit-checkout')&&activeVisit?.id===visit&&selected===patient&&me===identity)panel.innerHTML=`<div class="notice error">${esc(e.message)}</div><button type="button" data-checkout-refresh>Try again</button>`;});
}
// Within the encounter the dialog presents one task at a time. The forms below are
// the same nodes used by the standalone checkout workspace and keep their own versions.
function checkoutDialogFeedback(dialog,message,error=false,refresh=false){
 const feedback=dialog?.open&&dialog.querySelector('[data-checkout-feedback]');if(!feedback)return false;
 feedback.className=error?'notice error':'notice';feedback.textContent=message;feedback.hidden=!message;
 if(refresh){
  const retry=document.createElement('button');retry.type='button';retry.dataset.checkoutRefresh='';
  retry.textContent='Load current version';feedback.append(' ',retry);
 }
 return true;
}
function showVisitCheckoutTab(panel,name){
 const nav=panel.querySelector('[data-checkout-tabs]');if(!nav)return;
 const buttons=Array.from(nav.querySelectorAll('[data-checkout-tab]'));
 const picked=buttons.find(b=>b.dataset.checkoutTab===name)||buttons[0];if(!picked)return;
 panel.dataset.activeCheckoutTab=picked.dataset.checkoutTab;
 for(const button of buttons)button.setAttribute('aria-pressed',String(button===picked));
 for(const pane of panel.querySelectorAll('[data-checkout-pane]'))pane.hidden=pane.dataset.checkoutPane!==picked.dataset.checkoutTab;
}
function mountVisitCheckoutTabs(panel){
 const work=panel?.querySelector?.('.checkout-workspace');
 if(!work||!panel.closest('[data-visit-followup-dialog]')||work.querySelector('[data-checkout-tabs]'))return;
 const oldHeading=work.querySelector(':scope > .section-head');if(oldHeading)oldHeading.remove();
 const nav=document.createElement('nav');nav.dataset.checkoutTabs='';nav.className='actions';nav.setAttribute('aria-label','Patient instructions and follow-up sections');
 const initialNodes=Array.from(work.children),panes={};
 const groups=[['instructions','Instructions'],['followups','Tasks'],['handoff','Patient handoff'],['history','History']];
 for(const [key,label] of groups){
  const section=work.querySelector(':scope > [data-checkout-disclosure="'+key+'"]');
  if(!section&&key!=='instructions')continue;
  const pane=document.createElement('section');pane.dataset.checkoutPane=key;panes[key]=pane;
  pane.id='visit-checkout-pane-'+key;pane.setAttribute('aria-label',label);
  const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.checkoutTab=key;button.setAttribute('aria-controls',pane.id);
  button.onclick=()=>showVisitCheckoutTab(panel,key);nav.append(button);work.append(pane);
 }
 for(const node of initialNodes){
  if(node===oldHeading)continue;
  const key=node.dataset.checkoutDisclosure;
  if(key==='instructions'&&work.querySelector('.released-avs')&&!node.open){panes.instructions.append(node);continue;}
  if(panes[key]){
   for(const child of Array.from(node.children))if(child.tagName!=='SUMMARY')panes[key].append(child);
   node.remove();
  }else if(node.matches('[data-checkout-book]')){(panes.followups||panes.instructions).append(node);}
  else if(node.matches('[data-checkout-next],.encounter-result')){(panes.handoff||panes.instructions).append(node);}
  else panes.instructions.append(node);
 }
 const info=panes.history?.querySelector('.how-this-works');if(info)info.remove();
 for(const link of panes.followups?.querySelectorAll('[data-followup-visit]')||[]){
  if(link.dataset.followupVisit===activeVisit?.id)link.remove();
 }
 work.prepend(nav);showVisitCheckoutTab(panel,panel.dataset.activeCheckoutTab||(checkoutState?.visit?.status==='signed'?'instructions':'followups'));
}
function renderVisitCheckoutContent(){
 const d=checkoutState,canAuthor=['owner','clinician'].includes(me.role)&&!me.delegated,signed=d.visit.status==='signed',draft=checkoutDrafts.get(checkoutContext.key),content=draft||d.current_avs?.content||{},version=draft?.version??d.version,digest=draft?.digest??d.preview_digest;
 const restore=typeof encounterStepPosition==='function'?encounterStepPosition():null;
 const panel=$('visit-checkout');
 const inVisit=Boolean(panel.closest?.('[data-step-followup]'));
 const changedSnapshot=draft&&(draft.version!==d.version||draft.digest!==d.preview_digest);
 const sameVisit=panel.dataset.checkoutContext===checkoutContext.key;
 if(!sameVisit)delete panel.dataset.activeCheckoutTab;
 const disclosures=sameVisit?new Set(Array.from(panel.querySelectorAll?.('details[data-checkout-disclosure][open]')||[],el=>el.dataset.checkoutDisclosure)):new Set();
 const sameRelease=sameVisit&&panel.dataset.checkoutRelease===String(d.current_avs?.version??'');
 const activeTasks=d.followups.filter(task=>task.status==='open');
 const overdue=activeTasks.some(task=>task.due_date<localTime(new Date().toISOString()).slice(0,10));
 panel.dataset.checkoutContext=checkoutContext.key;
 panel.dataset.checkoutRelease=String(d.current_avs?.version??'');
 panel.innerHTML=`<section class="panel checkout-workspace">${inVisit?'':`<div class="section-head"><h2>Patient instructions and follow-up</h2><span class="status-badge ${d.checkout.completed?'completed':'in_progress'}">${d.checkout.completed?'Finished':'Not finished'}</span></div>` }${!signed?'<div class="mapping-notice">Sign the note to release instructions and finish the visit. You can add follow-up tasks now.</div>':''}${d.current_avs?releasedAvs(d.current_avs,!inVisit,inVisit):signed&&!canAuthor?'<p class="muted">Awaiting patient instructions from the clinician.</p>':''}<div id="avs-print-preview"></div>
 ${canAuthor&&signed?`<details class="avs-editor" data-inline data-checkout-disclosure="instructions"${draft||(sameRelease&&disclosures.has('instructions'))?' open':''}><summary>${d.current_avs?'Release a revised summary':'Prepare patient instructions'}</summary><form id="avs-release-form" data-context="${esc(checkoutContext.key)}" data-version="${version}" data-digest="${esc(digest)}"><label>Patient instructions<textarea name="instructions" required maxlength="10000">${esc(content.instructions)}</textarea></label><label>Follow-up instructions<textarea name="follow_up_instructions" maxlength="5000">${esc(content.follow_up_instructions)}</textarea></label><details data-checkout-snapshot data-inline data-checkout-disclosure="snapshot"${changedSnapshot?' open':''}><summary>Clinical information included in the summary</summary>${avsSummary(d.preview_snapshot)}</details>${changedSnapshot?'<div class="notice error">The encounter or its clinical information changed. Your instructions are retained. Review the current information above, then continue.<button type="button" data-checkout-rebase>Use this reviewed copy</button></div>':''}<label>Release / revision reason<input name="reason" value="${esc(draft?.reason||'')}" required maxlength="1000"></label><div class="actions"><button type="submit" class="primary">Release encounter summary</button><button type="button" data-checkout-discard>Discard instruction edits</button></div></form></details>`:''}
 ${canCheckout()&&d.current_avs?`<details class="checkout-handoff" data-inline data-checkout-disclosure="handoff"><summary>Patient handoff${(d.events||[]).some(event=>event.action==='delivery'&&event.avs_version===d.current_avs.version)?' · recorded':''}</summary><form id="avs-delivery-form" data-version="${d.version}" data-avs-version="${d.current_avs.version}"><div class="form-grid"><label>How it was given<select name="method"><option value="print">Printed copy provided</option><option value="declined">Patient declined a copy</option><option value="other">Other documented handoff</option></select></label><label>Details<input name="reason" required maxlength="1000"></label></div><button type="submit">Save</button></form><form id="checkout-complete-form" data-version="${d.version}"><label>Closing note<input name="reason" required maxlength="1000"></label><button class="primary" type="submit" ${d.checkout.completed?'disabled':''}>Finish encounter</button></form>${d.checkout.completed?`<p>Checked out ${esc(date(d.checkout.checked_out_at))}.</p>`:'<p class="muted">Record how the summary was given before checking out.</p>'}</details>`:''}
 <details class="checkout-followups" data-checkout-followups data-inline data-checkout-disclosure="followups"><summary>Follow-up tasks${activeTasks.length?' · '+activeTasks.length+' open':''}${overdue?' · overdue':''}</summary><div class="section-head"><button type="button" data-followup-board>Open work queue</button></div>${taskRows(d.followups)}${followupSuggestionsMarkup(d)}${canCheckout()?`<details id="followup-create" data-inline data-checkout-disclosure="create-task"><summary>Add follow-up task</summary><form id="followup-create-form" data-request="${crypto.randomUUID()}"><div class="form-grid"><label>Task<input name="title" required maxlength="200"></label><label>Assigned to<select name="assignee_id" required><option value="">Choose staff</option>${followupAssignees.map(a=>`<option value="${esc(a.id)}" ${a.id===d.visit.clinician_id?'selected':''}>${esc(displayPerson(a.display_name||a.name||a.label||'Staff member'))} · ${esc(displayStatus(a.role))}</option>`).join('')}</select></label><label>Due date<input name="due_date" type="date" required></label></div><label>Instructions<textarea name="instructions" required maxlength="4000"></textarea></label><label>Reason<input name="reason" required maxlength="1000"></label><button type="submit">Add task</button></form></details>`:''}</details>
 ${typeof canSchedule!=='function'||canSchedule()?'<button type="button" data-checkout-book>Book next visit</button>':''}${d.checkout.completed?checkoutResultMarkup():''}
 <details data-inline data-checkout-disclosure="history"><summary>Instructions and handoff history</summary>${d.releases.map(a=>releasedAvs(a)).join('')}${d.events.map(e=>`<p>${esc(displayStatus(e.action))} · ${esc(date(e.created_at))}<br>${esc(e.reason)}</p>`).join('')||'<p>Nothing yet.</p>'}<details class="how-this-works"><summary>How this works</summary><p class="muted">Signing the note, giving the summary and follow-up tasks are each recorded separately. Releasing the summary and checking out does not collect a payment or mark charges paid, and opening the print dialog does not record that the summary was given.</p></details></details></section>`;
 for(const el of panel.querySelectorAll?.('details[data-checkout-disclosure]')||[]){
  if(disclosures.has(el.dataset.checkoutDisclosure)&&(sameRelease||['followups','create-task','history'].includes(el.dataset.checkoutDisclosure)))el.open=true;
 }
 mountVisitCheckoutTabs(panel);restore?.();
 if(d.checkout.completed&&typeof encounterStepsSchedule==='function')void checkoutFindNext().catch(()=>{checkoutNext.promise=null;const button=$('visit-checkout')?.querySelector?.('[data-checkout-next]');if(button)button.textContent='Retry next patient';});
}
// Completion uses current encounter money; pending insurance remains distinct from patient payment.
function checkoutResultMarkup(){
 const summary=typeof encounterRevenueState!=='undefined'?encounterRevenueState.data?.summary:null;
 const sent=summary&&typeof encounterStepsModel==='function'?encounterStepsModel(summary,checkoutState.visit).sent:false;
 const handoff=summary&&typeof visitHandoffEvidence==='function'?visitHandoffEvidence(summary):null;
 const claimStatus=handoff?.outcome==='queued'?'claim queued':sent?'claim sent':'';
 const paid=summary?.patient?.received_cents??summary?.patient?.paid_cents??summary?.patient?.copay_paid_cents;
 return `<div class="encounter-result" role="status">Encounter finished${claimStatus?' · '+claimStatus:''}${Number.isSafeInteger(paid)?' · '+money(paid)+' paid':''}</div><button type="button" data-checkout-next>Next patient</button>`;
}
let checkoutNext={key:null,appointment:null,promise:null};
async function checkoutFindNext(){
 const patient=selected,visit=activeVisit?.id,identity=me,provider=activeVisit?.clinician_id,key=checkoutKey(patient,visit);
 if(checkoutNext.key===key&&checkoutNext.promise)return checkoutNext.promise;
 checkoutNext={key,appointment:null,promise:null};const state=checkoutNext;
 state.promise=(async()=>{
  if(!provider){const button=$('visit-checkout')?.querySelector?.('[data-checkout-next]');if(button)button.textContent='Schedule';return null;}
  const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
  const data=await api(`/api/v1/schedule?${new URLSearchParams({start:start.toISOString(),end:end.toISOString(),clinician_id:provider})}`);
  if(selected!==patient||activeVisit?.id!==visit||me!==identity)return null;
  const current=(workspace.appointments||[]).find(a=>a.id===activeVisit.appointment_id);
  state.appointment=(data.appointments||[]).filter(a=>a.id!==activeVisit.appointment_id&&a.clinician_id===provider&&['booked','checked_in','in_progress'].includes(a.status)&&new Date(a.starts_at)>=start&&new Date(a.starts_at)<end&&(!current||a.starts_at>current.starts_at)).sort((a,b)=>a.starts_at.localeCompare(b.starts_at))[0]||null;
  const button=$('visit-checkout')?.querySelector?.('[data-checkout-next]');if(button)button.textContent=state.appointment?'Next patient':'Schedule';
  return state.appointment;
 })();
 return state.promise;
}
async function checkoutNextPatient(){
 const patient=selected,visitId=activeVisit?.id,identity=me;
 const next=await checkoutFindNext();
 if(selected!==patient||activeVisit?.id!==visitId||me!==identity)return;
 if(!next){await showSchedule();return;}
 await showClinical();await selectPatient(next.patient_id,next.visit_id||null);
 const visit=(workspace.visits||[]).find(v=>v.appointment_id===next.id);
 if(visit&&activeVisit?.id!==visit.id)await selectPatient(next.patient_id,visit.id);
 showChartSection(visit?'visits':'encounters');
 if(!visit&&typeof appointmentDetail==='function')await appointmentDetail(next.id,next.patient_id);
}
async function checkoutBookNext(){
 const patient=selected,visit=activeVisit?.id,identity=me,provider=activeVisit?.clinician_id;
 if(!patient||workspace?.patient?.archived||!canSchedule())return;
 await openPatientAppointmentEditor(patient);
 if(selected!==patient||activeVisit?.id!==visit||me!==identity)return;
 const field=$('schedule-booking')?.elements.clinician_id;if(field&&[...field.options].some(option=>option.value===provider))field.value=provider;
}
// ---- Work queue -------------------------------------------------------------------------
// Everything waiting on the practice, gathered from where each kind of work already lives: notes
// still open, encounters whose billing is waiting on staff, results nobody has reviewed, referrals
// past their follow-up date, and the tasks staff set for each other. Each row opens the exact place
// the work is done.
const workQueueKinds=[['notes','Notes to finish'],['billing','Charges and claims'],['results','Results to review'],['referrals','Overdue referrals'],['intake','Intake forms to review'],['insurance','Insurance not checked'],['remittances','Insurance payments to review'],['balances','Balances to collect'],['tasks','Tasks']];
// The billing steps that wait on the practice. An encounter waiting on the insurer or the patient is
// not work for staff yet, so it is not listed.
const workQueueStaffStates=['sign_visit','post_charges','self_pay_collect','fix_claim','send_claim','correct_claim','claimmd_correction','post_response','denied','review_response','review_balance'];
var workQueueSources={},workQueueKind='all';
let workQueueIdentity,workQueueRemittancePages=1;
const queueCanReviewClaims=()=>typeof workspaceResourceAllowed!=='function'||(workspaceResourceAllowed('billing')&&workspaceResourceAllowed('claims'));
const queueCanOpenClinical=()=>typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical');
function queueKindAllowed(kind){
 if(kind==='remittances')return queueCanReviewClaims();
 if(typeof workspaceResourceAllowed!=='function')return true;
 if(kind==='insurance')return workspaceResourceAllowed('scheduling')&&workspaceResourceAllowed('clinical')&&workspaceResourceAllowed('billing');
 return workspaceResourceAllowed(['billing','balances'].includes(kind)?'billing':'clinical');
}
function selectWorkQueueKind(kind){
 workQueueKind=workQueueKinds.some(([key])=>key===kind)&&queueKindAllowed(kind)?kind:'all';renderWorkQueue();
}
async function openWorkQueuePatient(patient,{section,visit=null,step='visit'}){
 if(typeof frameSelectPatient==='function')return frameSelectPatient(patient,{section,visit,step});
 const identity=me;
 await selectPatient(patient,visit,()=>me===identity,{section,step});
 if(me===identity&&selected===patient)showChartSection(section);
}
async function queueReviewPayments(){
 const base='/api/v1/billing/remittances?needs_review=true';
 const payments=await api(base);
 for(let p=1;p<workQueueRemittancePages&&payments.next_cursor;p++){
  const next=await api(base+'&after='+encodeURIComponent(payments.next_cursor));
  payments.items.push(...next.items);payments.next_cursor=next.next_cursor;
 }
 return payments;
}
function workQueueItems(src){
 const rows=[],day=value=>value?(typeof displayDate==='function'?displayDate(String(value).slice(0,10)):String(value).slice(0,10)):'';
 const cash=cents=>Number.isFinite(Number(cents))&&cents!=null?money(cents):'';
 const join=parts=>parts.filter(Boolean).join(' · ');
 for(const v of src.unfinished?.items||[])rows.push({kind:'notes',visit:v.visit_id,number:v.encounter_number,patientId:v.patient_id,patient:v.patient_name,mrn:v.mrn,what:v.note_saved?'Finish and sign the note':'Write the encounter note',detail:join([v.title,day(v.starts_at),v.provider_label]),label:'Open encounter',attrs:`data-queue-visit="${esc(v.visit_id)}" data-patient="${esc(v.patient_id)}"`});
 const listed=new Set();
 const needsClaimWork=c=>c.status==='rejected'||c.claimmd_position?.needs_correction===true||['draft','ready'].includes(c.status);
 const claimAccounts=new Set((src.claims?.items||[]).filter(c=>c.id&&needsClaimWork(c)&&!c.crossover_tracking_only).map(c=>c.account_id));
 for(const a of src.accounts?.items||[]){
  if(!workQueueStaffStates.includes(a.billing_state))continue;
  if(claimAccounts.has(a.id)&&['fix_claim','send_claim','correct_claim','claimmd_correction'].includes(a.billing_state))continue;
  listed.add(a.id);
  const gross=cash(a.total_cents);
  rows.push({kind:'billing',visit:a.visit_id,number:a.encounter_number,patientId:a.patient_id,patient:a.patient_name,mrn:a.mrn,what:typeof visitBillingStateName==='function'?visitBillingStateName(a.billing_state):'Billing needs attention',detail:join([day(a.service_date),gross?gross+' gross charges':'',a.payer_name]),label:queueCanOpenClinical()?'Open encounter':'Review charge account',attrs:`data-queue-account="${esc(a.id)}" data-patient="${esc(a.patient_id)}"`});
 }
 // A claim whose encounter is not in the list above still needs sending or correcting.
 for(const c of src.claims?.items||[]){
  const fix=c.status==='rejected'||c.claimmd_position?.needs_correction===true;
  if(c.crossover_tracking_only||!needsClaimWork(c)||!c.id&&listed.has(c.account_id))continue;
  if(!c.id&&!queueCanOpenClinical()&&!src.accounts?.items.some(a=>a.id===c.account_id&&a.patient_id===c.patient_id))continue;
  if(!c.id)listed.add(c.account_id);
  rows.push({kind:'billing',visit:c.visit_id,number:c.encounter_number,patientId:c.patient_id,patient:c.patient_name,mrn:'',what:fix?'Claim needs correcting':'Send claim',detail:join([c.payer_name,cash(c.total_cents)]),urgent:fix,label:c.id?'Review claim':queueCanOpenClinical()?'Open encounter':'Review charge account',attrs:c.id?`data-queue-claim="${esc(c.id)}"`:`data-queue-account="${esc(c.account_id)}" data-patient="${esc(c.patient_id)}"`});
 }
 for(const payment of src.remittances?.items||[]){
  if(!payment.id||!['staged','reconciled'].includes(payment.status))continue;
  rows.push({kind:'remittances',patient:payment.payer_name||'Insurance payment',what:payment.status==='reconciled'?'Review reconciled payment':'Review insurance payment',detail:join([day(payment.payment_date),cash(payment.total_paid_cents),payment.trace]),label:'Open payment',attrs:`data-queue-remittance="${esc(payment.id)}"`});
 }
 for(const r of src.results?.items||[])rows.push({kind:'results',patient:r.patient_name,mrn:r.mrn,what:r.critical?'Critical result to review':'Result to review',detail:r.title,urgent:!!r.critical,label:'Review chart',attrs:`data-open-lab-patient="${esc(r.patient_id)}" data-order="${esc(r.order_id)}"`});
 for(const e of src.referrals?.items||[]){
  const exact=e.id&&e.patient_id;
  rows.push({kind:'referrals',patient:e.patient_label,mrn:e.mrn,what:'Referral is past its follow-up date',detail:e.content?.requested_service||'',label:exact?'Open referral':'Open referrals',attrs:exact?`data-referral-open-patient="${esc(e.patient_id)}" data-referral-id="${esc(e.id)}"`:'data-queue-referrals'});
 }
 for(const item of src.intake?.items||[])if(item.status==='submitted')rows.push({kind:'intake',patient:item.patient_name,mrn:item.mrn,what:'Review the submitted intake form',detail:day(item.submitted_at),label:'Review form',attrs:`data-queue-intake="${esc(item.packet_id)}"`});
 for(const a of src.accounts?.items||[])if(Number(a.patient_owes_now_cents)>0)rows.push({kind:'balances',patient:a.patient_name,mrn:a.mrn,visit:a.visit_id,patientId:a.patient_id,number:a.encounter_number,what:'Collect patient balance',detail:cash(a.patient_owes_now_cents),label:queueCanOpenClinical()?'Collect payment':'Review charge account',attrs:`data-queue-account="${esc(a.id)}" data-patient="${esc(a.patient_id)}" data-queue-collect`});
 const markers=new Map((src.markers?.items||[]).map(item=>[item.appointment_id,item]));
 const now=src.now?new Date(src.now):new Date(),end=new Date(now);end.setDate(end.getDate()+7);
 for(const a of src.schedule?.appointments||[]){
  const marker=markers.get(a.id),at=new Date(a.starts_at);if(at<now||at>=end||['cancelled','no_show'].includes(a.status)||marker?.insurance?.status!=='not_checked')continue;
  rows.push({kind:'insurance',patient:a.patient_name||a.patient_label,mrn:a.mrn,what:'Insurance has not been checked',detail:day(a.starts_at),label:'Check insurance',attrs:`data-queue-insurance="${esc(a.patient_id)}" data-appointment="${esc(a.id)}"`});
 }
 return rows;
}
function workQueueMarkup(rows,tasks,kind,missing,moreRemittances=false){
 const count=key=>key==='tasks'?tasks:rows.filter(row=>row.kind===key).length,total=rows.length+tasks;
 const chip=(key,label,n)=>`<button type="button" data-queue-kind="${key}" aria-pressed="${kind===key}">${esc(label)} <span class="pill">${n}${moreRemittances&&['all','remittances'].includes(key)?'+':''}</span></button>`;
 const encounter=row=>{
  if(!row.visit)return '';
  const number=typeof encounterNumberLabel==='function'?encounterNumberLabel(row.number):'';
  if(queueCanOpenClinical()&&typeof encounterTimelineChip==='function')return ' '+encounterTimelineChip(null,number,{visit:row.visit,patient:row.patientId});
  return number?` <span class="record-id">${esc(number)}</span>`:'';
 };
 const groups=workQueueKinds.filter(([key])=>key!=='tasks'&&queueKindAllowed(key)&&(kind==='all'||kind===key)).map(([key,label])=>{
  const mine=rows.filter(row=>row.kind===key);if(!mine.length)return '';
  return `<section class="work-queue-group" data-queue-group="${key}"><h3>${esc(label)} <span class="pill">${mine.length}</span></h3>${key==='insurance'?'<p class="muted">Appointments in the next 7 days.</p>':''}<ul class="work-queue-list">${mine.map(row=>`<li${row.urgent?' class="is-urgent"':''}><div><p class="work-queue-who"><b>${esc(row.patient||'Patient')}</b>${row.mrn?` <span class="record-id">MRN ${esc(row.mrn)}</span>`:''}${encounter(row)}</p><p class="work-queue-what"><strong>${esc(row.what)}</strong>${row.detail?` · ${esc(row.detail)}`:''}</p></div><button type="button" ${row.attrs}>${esc(row.label)}</button></li>`).join('')}</ul></section>`;
 }).join('');
 const nothing=kind==='all'?total===0:count(kind)===0;
 return `<div class="work-queue-kinds" role="group" aria-label="Show">${chip('all','Everything',total)}${workQueueKinds.filter(([key])=>queueKindAllowed(key)).map(([key,label])=>chip(key,label,count(key))).join('')}</div>${missing?'<p class="muted" role="status">Some lists are not shown. Refresh to check again.</p>':''}${groups}${moreRemittances&&['all','remittances'].includes(kind)?'<button type="button" data-queue-more-remittances>Load more insurance payments</button>':''}${nothing&&!missing&&kind!=='tasks'?`<p class="work-queue-empty" role="status">${kind==='all'?'Nothing is waiting on the practice right now.':'Nothing is waiting here right now.'}</p>`:''}`;
}
async function showFollowupWorkspace({kind='all'}={}){
 if(workQueueIdentity!==me){workQueueIdentity=me;workQueueRemittancePages=1;}
 const identity=me;
 const settle=request=>request.then(value=>({value}),()=>({failed:true}));
 const start=new Date(),end=new Date(start);end.setDate(end.getDate()+7);
 const range={start:start.toISOString(),end:end.toISOString()};
 const read=(kind,path)=>queueKindAllowed(kind)?settle(api(path)):{};
 const [taskData,assignees,unfinished,accounts,claims,results,referrals,remittances,intake,schedule,markers]=await Promise.all([
  read('tasks',`/api/v1/follow-up/tasks?${new URLSearchParams({status:followupFilter,...(followupOwner==='mine'?{assignee_id:me.user_id}:{})})}`),
  canCheckout()?read('tasks','/api/v1/follow-up/assignees'):{},read('notes','/api/v1/practice/worklist'),read('billing','/api/v1/billing/overview'),
  queueCanReviewClaims()?settle(api('/api/v1/billing/claims')):{},read('results','/api/v1/labs/inbox'),read('referrals','/api/v1/referrals/worklist?overdue=true&_count=100'),
  queueCanReviewClaims()?settle(queueReviewPayments()):{},
  read('intake','/api/v1/previsit/review-queue'),
  read('insurance',`/api/v1/schedule?${new URLSearchParams(range)}`),
  read('insurance',`/api/v1/schedule/markers?${new URLSearchParams({from:range.start,to:range.end})}`)
 ]);
 if(identity!==me)return;
 const data=taskData.value||{items:[]};
 followupItems=data.items;followupAssignees=assignees.value?.items||[];showTool('Work queue');
 workQueueSources={unfinished:unfinished.value,accounts:accounts.value?.accounts,claims:claims.value,results:results.value,referrals:referrals.value,remittances:remittances.value,intake:intake.value,schedule:schedule.value,markers:markers.value,tasksUnavailable:!!taskData.failed,missing:[taskData,unfinished,accounts,claims,results,referrals,remittances,intake,schedule,markers].some(part=>part.failed)};
 $('tools').innerHTML=`<section id="followup-workspace"><div class="section-head"><div><h2>Work queue</h2></div><div class="actions">${typeof showWorkflowRunQueue==='function'&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('workflows','view'))?'<button type="button" data-journey-workqueue>Patient journeys</button>':''}<button type="button" data-followup-board>Refresh</button></div></div><div id="work-queue-rows"></div><section class="work-queue-group" id="work-queue-tasks" data-queue-group="tasks"><h3>Tasks</h3><form id="followup-filter-form"><div class="form-grid"><label>Show<select id="followup-status">${[['open','Open tasks'],['all','All statuses'],['completed','Completed'],['cancelled','Cancelled']].map(([v,l])=>`<option value="${v}" ${followupFilter===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Assigned to<select id="followup-owner"><option value="all" ${followupOwner==='all'?'selected':''}>All staff</option><option value="mine" ${followupOwner==='mine'?'selected':''}>Assigned to me</option></select></label></div></form>${data.has_more?`<p class="muted">Showing the first ${data.items.length} of ${data.total??'many'} tasks.</p>`:''}<div id="followup-rows"></div></section></section>`;
 renderFollowupRows();selectWorkQueueKind(kind);
}
function renderWorkQueue(){
 const host=$('work-queue-rows');if(!host)return;
 const open=followupItems.filter(task=>task.status==='open').length;
 host.innerHTML=workQueueMarkup(workQueueItems(workQueueSources),open,workQueueKind,workQueueSources.missing,Boolean(workQueueSources.remittances?.next_cursor));
 const tasks=$('work-queue-tasks');if(tasks)tasks.hidden=!queueKindAllowed('tasks')||!(workQueueKind==='all'||workQueueKind==='tasks');
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',async event=>{
 const button=event.target?.closest?.('#followup-workspace button');if(!button)return;
 if(button.dataset.queueIntake){if(!queueKindAllowed('intake'))return;await openWorkflowIntakePacket(button.dataset.queueIntake);return;}
 if(button.dataset.queueInsurance){if(!queueKindAllowed('insurance'))return;const identity=me,patient=button.dataset.queueInsurance;await openWorkQueuePatient(patient,{section:'insurance'});if(me!==identity||selected!==patient)return;if(typeof insuranceAppointmentSelection!=='undefined')insuranceAppointmentSelection.set(patient,button.dataset.appointment);showChartSection('insurance');return;}
 if(button.dataset.queueKind){selectWorkQueueKind(button.dataset.queueKind);return;}
 if(button.dataset.queueVisit){await run(()=>openWorkQueuePatient(button.dataset.patient,{section:'visits',visit:button.dataset.queueVisit}));return;}
 if(button.dataset.queueRemittance||button.dataset.queueClaim){
  if(!queueCanReviewClaims())return;
  await run(async()=>{const identity=me;await showClaimsWorkspace({filter:button.dataset.queueRemittance?'remittance-review':'all'});if(me!==identity||!$('claims-tool'))return;
   if(button.dataset.queueRemittance)await showEra(button.dataset.queueRemittance);else await showClaim(button.dataset.queueClaim);
  });return;
 }
 if(button.hasAttribute('data-queue-more-remittances')){
  await run(async()=>{const sources=workQueueSources,payments=sources.remittances,identity=me;
   if(!payments?.next_cursor||!queueCanReviewClaims())return;
   const page=await api('/api/v1/billing/remittances?'+new URLSearchParams({needs_review:'true',after:payments.next_cursor}));
   if(sources!==workQueueSources||identity!==me||!$('followup-workspace'))return;
   payments.items.push(...page.items);payments.next_cursor=page.next_cursor;workQueueRemittancePages++;renderWorkQueue();
  });return;
 }
 // The encounter that owns the charges or the claim opens on its billing, where the next step is.
 if(button.dataset.queueAccount){await run(async()=>{const identity=me,patient=button.dataset.patient;
  if(!queueKindAllowed('billing'))return;
  if(!queueCanOpenClinical()){
   const matches=row=>row.id===button.dataset.queueAccount&&row.patient_id===patient;
   const source=workQueueIdentity===identity&&workQueueSources.accounts?.items.find(matches);
   if(!source)return;
   const scope=await showPatientBillingWorkspace({patientId:patient,tab:'overview',mode:'recorded'});
   if(me!==identity||!patientBillingCurrent(scope)||scope.patientId!==patient)return;
   const preview=scope.host.querySelector('#patient-billing-preview'),row=scope.native?.accounts.items.find(matches)||source;
   await showBillingAccountReview(preview,row,()=>patientBillingCurrent(scope)&&scope.host.querySelector('#patient-billing-preview')===preview);
   return;
  }
  await openWorkQueuePatient(patient,{section:'billing'});
  if(me!==identity||selected!==patient)return;
  await openEncounterBillingAccount(button.dataset.queueAccount);
  if(me===identity&&selected===patient&&button.hasAttribute('data-queue-collect'))openVisitCollect();
 });return;}
 if(button.hasAttribute('data-queue-referrals')&&typeof showReferralWorkspace==='function'){if(typeof referralBoard!=='undefined')referralBoard.overdue=true;await showReferralWorkspace();}
});
document.addEventListener('click',event=>{
 if(event.target.closest?.('[data-checkout-next]')){event.target.closest('[data-visit-followup-dialog]')?.close();event.preventDefault();run(()=>checkoutNextPatient());}
 if(event.target.closest?.('[data-checkout-book]')){event.target.closest('[data-visit-followup-dialog]')?.close();event.preventDefault();run(()=>checkoutBookNext());}
});
function renderFollowupRows(){
 if(workQueueSources.tasksUnavailable){$('followup-rows').innerHTML='<p role="status">Tasks could not be loaded. Refresh to try again.</p>';return;}
 const status=$('followup-status').value,mine=$('followup-owner').value==='mine';
 const items=followupItems.filter(t=>(status==='all'||t.status===status)&&(!mine||t.assignee_id===me.user_id));
 $('followup-rows').innerHTML=items.map(t=>`<section class="panel"><p class="eyebrow">${esc(t.patient_name)} · MRN ${esc(t.mrn)}</p>${taskRows([t])}</section>`).join('')||'<div class="empty-state"><p>No tasks match. Staff add a task from an encounter’s note when something needs following up.</p></div>';
}
function showAvsPrint(version){
 const avs=checkoutState.releases.find(a=>a.version===version)||checkoutState.current_avs;if(!avs||avs.version!==version)throw new Error('Reload the summary before printing.');
 const p=avs.snapshot.patient,frame=document.createElement('iframe');frame.id='avs-print-frame';frame.title=`Encounter summary version ${version} print preview`;frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');
 frame.srcdoc=`<!doctype html><html lang="en"><meta charset="utf-8"><title>After-visit summary</title><link rel="stylesheet" href="/avs-print.css"><h1>SunCharts EHR · After-visit summary</h1><p>${esc(p.given_name)} ${esc(p.family_name)} · MRN ${esc(p.mrn)}<br>Date of birth ${esc(p.birth_date)}<br>Summary version ${version} · Released ${esc(date(avs.released_at))}</p><p>Visit ${avs.snapshot.visit?.starts_at?esc(date(avs.snapshot.visit.starts_at)):''} · ${esc(avs.snapshot.visit?.title||'')}<br>${esc([avs.snapshot.visit?.signed_by_label?`Seen by ${avs.snapshot.visit.signed_by_label}`:avs.snapshot.visit?.clinician_label,avs.snapshot.visit?.facility].filter(Boolean).join(' · '))}</p><h2>Patient instructions</h2><p>${esc(avs.content.instructions)}</p><h2>Follow-up instructions</h2><p>${esc(avs.content.follow_up_instructions||'No follow-up instructions entered.')}</p>${avsSummary(avs.snapshot)}</html>`;
 const target=$('avs-print-preview');target.innerHTML='<div class="section-head"><h3>Patient summary print preview</h3><button type="button" data-avs-print>Print this summary</button></div>';target.append(frame);if(typeof encounterContentScroll==='function')encounterContentScroll(target);else target.scrollIntoView({block:'start'});
}
document.addEventListener('click',e=>{
 const b=e.target.closest?.('[data-followup-suggest]');if(!b||!checkoutState)return;e.preventDefault();
 const s=followupSuggestions(checkoutState)[Number(b.dataset.followupSuggest)],form=$('followup-create-form'),box=$('followup-create');if(!s||!form)return;
 if(box)box.open=true;
 for(const [name,value] of [['title',s.title],['due_date',s.due],['instructions',s.instructions],['reason',s.reason]])if(form.elements[name])form.elements[name].value=value;
 if(typeof encounterContentScroll==='function')encounterContentScroll(form);else form.scrollIntoView?.({block:'center'});(form.elements.assignee_id?.value?form.querySelector('button[type=submit]'):form.elements.assignee_id)?.focus?.({preventScroll:true});
});
document.addEventListener('input',e=>{if(e.target.closest?.('#avs-release-form'))captureCheckoutDraft();});
document.addEventListener('change',e=>{if(e.target.name!=='action')return;const form=e.target.closest?.('.followup-action-form');if(!form)return;for(const [kind,field] of [['reassign','assignee_id'],['reschedule','due_date']]){form.querySelector(`[data-followup-${kind}]`).hidden=e.target.value!==kind;form.elements[field].required=e.target.value===kind;}});
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||!['data-checkout-refresh','data-checkout-discard','data-checkout-rebase','data-followup-board','data-followup-patient','data-followup-history','data-avs-preview','data-avs-print'].some(a=>b.hasAttribute(a)))return;
 e.preventDefault();e.stopImmediatePropagation();
 run(async()=>{
  if(b.dataset.followupHistory){const d=await api(`/api/v1/follow-up/tasks/${b.dataset.followupHistory}`),target=b.closest('.followup-task').querySelector('[data-task-history]');target.innerHTML=(d.events||[]).map(e=>`<p>v${e.version} · ${esc(human(e.action))} · ${esc(date(e.created_at))}<br>${esc(e.reason)}</p>`).join('')+(d.events_truncated?'<p>Older history is not included.</p>':'');return;}
  if(b.hasAttribute('data-followup-board')){b.closest('[data-visit-followup-dialog]')?.close?.();await showFollowupWorkspace({kind:b.closest('#followup-workspace')?workQueueKind:'all'});return;}
  if(b.dataset.followupPatient){b.closest('[data-visit-followup-dialog]')?.close?.();await showClinical();await selectPatient(b.dataset.followupPatient,b.dataset.followupVisit);showChartSection('checkout');return;}
  if(b.dataset.avsPreview){const panel=b.closest('[data-visit-followup-dialog]')?.querySelector('#visit-checkout');if(panel)showVisitCheckoutTab(panel,'instructions');showAvsPrint(Number(b.dataset.avsPreview));return;}
  if(b.hasAttribute('data-avs-print')){$('avs-print-frame').contentWindow.focus();$('avs-print-frame').contentWindow.print();return;}
  if(b.hasAttribute('data-checkout-rebase')){captureCheckoutDraft();const draft=checkoutDrafts.get(checkoutContext.key);if(draft)checkoutDrafts.set(checkoutContext.key,{...draft,version:checkoutState.version,digest:checkoutState.preview_digest});renderVisitCheckoutContent();return;}
  if(b.hasAttribute('data-checkout-refresh')){
   const dialog=b.closest('[data-visit-followup-dialog]'),identity=me,patient=selected,visit=activeVisit?.id;
   try{await loadVisitCheckout();if(me===identity&&selected===patient&&activeVisit?.id===visit)checkoutDialogFeedback(dialog,'');}
   catch(error){if(me===identity&&selected===patient&&activeVisit?.id===visit&&!error.signedOut)checkoutDialogFeedback(dialog,error.message,true,true);throw error;}
   return;
  }
  if(b.hasAttribute('data-checkout-discard')){checkoutDrafts.delete(checkoutContext.key);$('avs-release-form')?.remove();}
  await loadVisitCheckout();
 });
},true);
document.addEventListener('submit',e=>{
 const f=e.target;if(!['avs-release-form','avs-delivery-form','checkout-complete-form','followup-create-form','followup-filter-form'].includes(f.id)&&!f.classList.contains('followup-action-form'))return;
 e.preventDefault();e.stopImmediatePropagation();
 run(async()=>{
  const values=formData(f);if(f.id==='followup-filter-form'){followupFilter=$('followup-status').value;followupOwner=$('followup-owner').value;await showFollowupWorkspace({kind:workQueueKind});return;}const context=checkoutContext,identity=me,dialog=f.closest('[data-visit-followup-dialog]');
  const current=()=>!dialog||(identity===me&&context?.patient===selected&&context?.visit===activeVisit?.id&&context?.key===checkoutContext?.key);
  if(!current())return;
  const base=context?checkoutBase(context.patient,context.visit):'';let saved='Saved.';
 checkoutDialogFeedback(dialog,'');
 try{
 if(f.id==='avs-release-form'){await api(base+'/checkout/actions','POST',{action:'release_avs',instructions:values.instructions,follow_up_instructions:values.follow_up_instructions,reason:values.reason,reviewed:true,reviewed_snapshot_digest:f.dataset.digest},Number(f.dataset.version));if(current()){checkoutDrafts.delete(context.key);f.remove();}saved='After-visit summary released.';}
 else if(f.id==='avs-delivery-form'){await api(base+'/checkout/actions','POST',{action:'delivery',method:values.method,reason:values.reason,avs_version:Number(f.dataset.avsVersion)},Number(f.dataset.version));saved='Delivery recorded.';}
 else if(f.id==='checkout-complete-form'){await api(base+'/checkout/actions','POST',{action:'checkout',reason:values.reason},Number(f.dataset.version));saved='Encounter finished.';}
 else if(f.id==='followup-create-form'){await api(base+'/follow-ups','POST',{request_id:f.dataset.request,...values});saved='Follow-up added.';}
 else {const body={action:values.action,reason:values.reason};if(values.action==='reassign')body.assignee_id=values.assignee_id;if(values.action==='reschedule')body.due_date=values.due_date;await api(`/api/v1/follow-up/tasks/${f.dataset.id}/actions`,'POST',body,Number(f.dataset.version));saved='Follow-up updated.';}
 }catch(error){
  if(current()&&!error.signedOut)checkoutDialogFeedback(dialog,error.message,true,error.status===409);
  throw error;
 }
 if(!current())return;
 try{if(f.closest('#followup-workspace'))await showFollowupWorkspace({kind:workQueueKind});else await loadVisitCheckout();}
 catch(error){
  if(current()&&!error.signedOut)checkoutDialogFeedback(dialog,saved+' The updated view could not be loaded.',true,true);
  throw error;
 }
 if(current()&&!checkoutDialogFeedback(dialog,saved))notice(saved);
 });
},true);

// The work queue follows its filters as they change; there is no separate step to apply them.
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('change',event=>{const form=event.target?.closest?.('#followup-filter-form');if(form?.requestSubmit)form.requestSubmit();});

// Explicit completion from a clinical handoff uses the validated form and reviewed version.
async function finishVisitEncounter(){
 const patient=selected,visit=activeVisit?.id,identity=me;
 if(!visit||!canCheckout())return;
 if(checkoutContext?.key!==checkoutKey(patient,visit)||!checkoutState)await loadVisitCheckout();
 if(selected!==patient||activeVisit?.id!==visit||me!==identity)return;
 if(checkoutState.checkout.completed)return;
 let target;
 if(activeVisit.status!=='signed')target=$('note-form')?.querySelector('[data-action="sign-bill"]');
 else if(!checkoutState.current_avs)target=$('avs-release-form')?.elements.instructions;
 else if(!checkoutState.events.some(e=>e.action==='delivery'&&e.avs_version===checkoutState.current_avs.version))target=$('avs-delivery-form')?.elements.reason;
 else{
  const form=$('checkout-complete-form');
  if(form?.checkValidity()){form.requestSubmit();return;}
  target=form?.querySelector(':invalid');
 }
 if(target){
  const dialog=target.closest('[data-visit-followup-dialog]'),pane=target.closest('[data-checkout-pane]');
  if(dialog&&typeof encounterOpenFollowup==='function'){encounterOpenFollowup({focus:false});if(pane)showVisitCheckoutTab($('visit-checkout'),pane.dataset.checkoutPane);}
  for(let panel=target.closest('details');panel;panel=panel.parentElement?.closest('details'))panel.setAttribute('open','');target.setAttribute('aria-invalid','true');if(!dialog&&typeof encounterContentScroll==='function')encounterContentScroll(target);else target.scrollIntoView?.({block:'center'});target.focus?.({preventScroll:true});}
}
document.addEventListener('input',event=>{if(event.target.closest?.('.checkout-workspace'))event.target.removeAttribute?.('aria-invalid');});
