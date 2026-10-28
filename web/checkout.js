// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let checkoutState,checkoutContext,checkoutGeneration=0,followupItems=[],followupAssignees=[],followupFilter='open',followupOwner='all';
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
 return {label:!activeVisit?'Select an encounter':!state?'Review checkout':state.checkout.completed?'Checked out':state.current_avs?'AVS released · checkout pending':'AVS not released',complete:!!state?.checkout.completed};
}
function avsSummary(snapshot){
 if(!snapshot)return '<p class="muted">No snapshot available.</p>';
 const medications=snapshot.medications||[],orders=snapshot.orders||[],reviews=snapshot.list_reviews||[],v=snapshot.vitals;
 const review=kind=>reviews.find(r=>r.kind===kind)?.review_state;
 const allergies=Array.isArray(snapshot.allergies)?`<section><h4>Allergies</h4>${snapshot.allergies.length?`<ul>${snapshot.allergies.map(a=>`<li><strong>${esc(a.title)}</strong><br>${esc([a.reaction,a.severity,a.verification?human(a.verification):''].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`:`<p>${review('allergy')==='no_known'?'No known allergies documented at review.':'Allergy status not confirmed in this snapshot.'}</p>`}</section>`:'';
 const problems=Array.isArray(snapshot.problems)?`<section><h4>Recorded problems</h4>${snapshot.problems.length?`<ul>${snapshot.problems.map(p=>`<li>${esc(p.title)} · ${esc(human(p.status))}${p.verification?' · '+esc(human(p.verification)):''}</li>`).join('')}</ul>`:`<p>${review('problem')==='no_known'?'No known problems documented at review.':'No active problems recorded; absence is not confirmation.'}</p>`}</section>`:'';
 const vitals=v?`<section><h4>Encounter vitals</h4><p>Blood pressure ${esc(v.systolic_mm_hg)}/${esc(v.diastolic_mm_hg)} mmHg · Pulse ${esc(v.heart_rate_bpm)} bpm<br>Temperature ${esc(v.temperature_c)} °C · Oxygen saturation ${esc(v.oxygen_saturation_pct)}%<br>Weight ${esc(v.weight_kg)} kg · Height ${esc(v.height_cm)} cm</p></section>`:'';
 return `<div class="avs-summary-grid">${allergies}${problems}<section><h4>Medication statements</h4>${medications.length?`<ul>${medications.map(m=>`<li><strong>${esc(m.title)}</strong><br>${esc([m.dose,m.route,m.frequency,m.status,m.verification?human(m.verification):''].filter(Boolean).join(' · '))}</li>`).join('')}</ul>`:`<p>${review('medication')==='no_known'?'No current medications documented at review.':'No active medication statements in this snapshot. This does not confirm an empty medication list.'}</p>`}</section><section><h4>Orders</h4>${orders.length?`<ul>${orders.map(o=>`<li><strong>${esc(o.title)}</strong> · ${esc(human(o.status))}</li>`).join('')}</ul>`:'<p>No linked orders in this snapshot.</p>'}</section>${vitals}</div>`;
}

function releasedAvs(avs){
 return `<article class="released-avs"><div class="section-head"><div><h3>After-visit summary · version ${avs.version}</h3><p class="muted">Released ${esc(date(avs.released_at))}</p></div><button type="button" data-avs-preview="${avs.version}">View / print summary</button></div><h4>Patient instructions</h4><p class="note-text">${esc(avs.content.instructions)}</p><h4>Follow-up instructions</h4><p class="note-text">${esc(avs.content.follow_up_instructions||'No follow-up instructions entered.')}</p>${avsSummary(avs.snapshot)}</article>`;
}
function taskCanUpdate(t){return t.can_update??(me.role==='owner'||t.assignee_id===me.user_id||t.created_by===me.user_id);}
function taskRows(items){
 const today=localTime(new Date().toISOString()).slice(0,10);
 return items.map(t=>`<article class="followup-task"><div class="section-head"><div><h4>${esc(t.title)}</h4><p class="muted">${esc(t.assignee_label||'Assigned staff')} · Due ${esc(t.due_date)} · <span class="pill">${esc(human(t.status))}</span>${t.status==='open'&&t.due_date<today?' <strong class="critical-label">Overdue</strong>':''}</p></div><button type="button" data-followup-patient="${esc(t.patient_id)}" data-followup-visit="${esc(t.visit_id)}">Open encounter</button></div><p class="note-text">${esc(t.instructions)}</p>${taskCanUpdate(t)?`<form class="followup-action-form" data-id="${esc(t.id)}" data-version="${t.version}"><div class="form-grid"><label>Task action<select name="action">${t.status==='open'?'<option value="complete">Complete task</option><option value="cancel">Cancel task</option><option value="reassign">Reassign</option><option value="reschedule">Change due date</option>':'<option value="reopen">Reopen task</option>'}</select></label><label data-followup-reassign hidden>New assignee (for reassignment)<select name="assignee_id"><option value="">Keep current assignee</option>${followupAssignees.map(a=>`<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('')}</select></label><label data-followup-reschedule hidden>New due date (for rescheduling)<input type="date" name="due_date"></label><label>Task update reason<input name="reason" required maxlength="1000"></label></div><button type="submit">Record task update</button></form>`:''}<details><summary>Task history</summary><div data-task-history>${(t.events||[]).map(e=>`<p>v${e.version} · ${esc(human(e.action))} · ${esc(date(e.created_at))}<br>${esc(e.reason)}</p>`).join('')||`<button type="button" data-followup-history="${esc(t.id)}">Load task history</button>`}${t.events_truncated?'<p class="muted">Older history is not included in this response.</p>':''}</div></details></article>`).join('')||'<p class="muted">No follow-up tasks recorded.</p>';
}
async function loadVisitCheckout(){
 if(!activeVisit||!$('visit-checkout'))return;
 captureCheckoutDraft();
 const patient=selected,visit=activeVisit.id,key=checkoutKey(patient,visit),generation=++checkoutGeneration;
 const panel=$('visit-checkout');panel.innerHTML='<p class="muted" role="status">Loading checkout and follow-up…</p>';
 const [data,assignees]=await Promise.all([api(`${checkoutBase(patient,visit)}/checkout`),canCheckout()?api('/api/v1/follow-up/assignees'):Promise.resolve({items:[]})]);
 if(generation!==checkoutGeneration||selected!==patient||activeVisit?.id!==visit||!$('visit-checkout'))return;
 checkoutState=data;checkoutContext={patient,visit,key};checkoutStates.set(key,data);followupAssignees=assignees.items;
 renderVisitCheckoutContent();refreshEncounterProgress();
}
function renderVisitCheckout(){
 if(!activeVisit)return;
 loadVisitCheckout().catch(e=>{if($('visit-checkout'))$('visit-checkout').innerHTML=`<div class="notice error">${esc(e.message)}</div><button type="button" data-checkout-refresh>Retry checkout</button>`;});
}
function renderVisitCheckoutContent(){
 const accounts=workspace?.billing?.accounts.filter(a=>a.content.visit_id===activeVisit?.id)||[];
 const d=checkoutState,canAuthor=['owner','clinician'].includes(me.role)&&d.visit.clinician_id===me.user_id,signed=d.visit.status==='signed',draft=checkoutDrafts.get(checkoutContext.key),content=draft||d.current_avs?.content||{},version=draft?.version??d.version,digest=draft?.digest??d.preview_digest;
 $('visit-checkout').innerHTML=`<section class="panel checkout-workspace"><div class="section-head"><div><h2>Checkout & after-visit summary</h2><p class="muted">Clinical signing, patient handoff, follow-up and payment retain independent status.</p></div><span class="status-badge ${d.checkout.completed?'completed':'in_progress'}">${d.checkout.completed?'Checked out':'Checkout pending'}</span></div>${!signed?'<div class="mapping-notice">Sign the encounter before releasing its after-visit summary or completing checkout. You can create follow-up tasks now.</div>':''}${d.current_avs?releasedAvs(d.current_avs):'<p class="muted">No after-visit summary has been released for this encounter.</p>'}<div id="avs-print-preview"></div>
 ${canAuthor&&signed?`<details ${d.current_avs?'':'open'} class="avs-editor"><summary>${d.current_avs?'Release a revised summary':'Prepare patient instructions'}</summary><form id="avs-release-form" data-context="${esc(checkoutContext.key)}" data-version="${version}" data-digest="${esc(digest)}"><label>Patient instructions<textarea name="instructions" required maxlength="10000">${esc(content.instructions)}</textarea></label><label>Follow-up instructions<textarea name="follow_up_instructions" maxlength="5000">${esc(content.follow_up_instructions)}</textarea></label><h4>Clinical snapshot for review</h4>${avsSummary(d.preview_snapshot)}<p class="muted">The released summary preserves this clinical snapshot. It does not prescribe medication or include private SOAP documentation.</p>${draft&&(draft.version!==d.version||draft.digest!==d.preview_digest)?'<div class="notice error">The checkout record or clinical snapshot changed. Your instructions are retained. Review the current snapshot above, then continue.<button type="button" data-checkout-rebase>Use this reviewed snapshot</button></div>':''}<label>Release / revision reason<input name="reason" required maxlength="1000"></label><label class="review-ack"><input name="reviewed" type="checkbox" required>I reviewed the patient instructions, clinical snapshot and follow-up instructions for this summary.</label><div class="actions"><button type="submit" class="primary">Release after-visit summary</button><button type="button" data-checkout-discard>Discard instruction edits</button></div></form></details>`:''}
 ${canCheckout()&&d.current_avs?`<section class="checkout-handoff"><h3>Patient handoff</h3><p class="muted">Viewing or opening the print dialog does not record delivery. Record what actually happened.</p><form id="avs-delivery-form" data-version="${d.version}" data-avs-version="${d.current_avs.version}"><div class="form-grid"><label>Summary handoff outcome<select name="method"><option value="print">Printed copy provided</option><option value="declined">Patient declined a copy</option><option value="other">Other documented handoff</option></select></label><label>Handoff details / reason<input name="reason" required maxlength="1000"></label></div><button type="submit">Record summary handoff</button></form><form id="checkout-complete-form" data-version="${d.version}"><label>Administrative checkout note<input name="reason" required maxlength="1000"></label><button class="primary" type="submit" ${d.checkout.completed?'disabled':''}>Complete administrative checkout</button></form>${d.checkout.completed?`<p>Checked out ${esc(date(d.checkout.checked_out_at))}. Follow-up tasks and balances remain independent.</p>`:'<p class="muted">A handoff outcome for the current released summary is required before checkout.</p>'}</section>`:''}
 <section class="checkout-followups"><div class="section-head"><h3>Follow-up tasks</h3><button type="button" data-followup-board>Open follow-up worklist</button></div>${taskRows(d.followups)}${canCheckout()?`<details><summary>Create follow-up task</summary><form id="followup-create-form" data-request="${crypto.randomUUID()}"><div class="form-grid"><label>Follow-up task title<input name="title" required maxlength="200"></label><label>Assigned staff<select name="assignee_id" required><option value="">Choose responsible staff</option>${followupAssignees.map(a=>`<option value="${esc(a.id)}" ${a.id===d.visit.clinician_id?'selected':''}>${esc(a.label)} · ${esc(human(a.role))}</option>`).join('')}</select></label><label>Follow-up due date<input name="due_date" type="date" required></label></div><label>Task instructions<textarea name="instructions" required maxlength="4000"></textarea></label><label>Task creation reason<input name="reason" required maxlength="1000"></label><button type="submit">Create assigned follow-up</button></form></details>`:''}</section>
 <section><div class="section-head"><h3>Encounter financials</h3><button type="button" data-encounter-step="billing">Review charges & payments</button></div><p class="muted">Administrative checkout does not collect a payment or mark an account paid.</p>${accounts.length?accounts.map(a=>`<div class="section-head"><span>${esc(a.content.service_date)} · ${esc(human(a.status))} · ${money(a.total_cents)}</span></div>${a.status==='posted'?`<div id="checkout-payment-${esc(a.id)}"></div>`:'<p class="muted">Post reviewed charges in Financials before collecting payment.</p>'}`).join(''):'<p class="muted">No charge account is linked to this encounter.</p>'}</section><details><summary>Summary versions & checkout history</summary>${d.releases.map(a=>releasedAvs(a)).join('')}${d.events.map(e=>`<p>v${e.version} · ${esc(human(e.action))} · ${esc(date(e.created_at))}<br>${esc(e.reason)}</p>`).join('')||'<p>No checkout events recorded.</p>'}</details></section>`;
 for(const a of accounts.filter(a=>a.status==='posted'))if(typeof renderAccountPaymentPanel==='function')renderAccountPaymentPanel(a.id,`checkout-payment-${a.id}`).catch(e=>{const host=$(`checkout-payment-${a.id}`);if(host)host.textContent=e.message;});
}
async function showFollowupWorkspace(){
 const [data,assignees]=await Promise.all([api(`/api/v1/follow-up/tasks?${new URLSearchParams({status:followupFilter,...(followupOwner==='mine'?{assignee_id:me.user_id}:{})})}`),canCheckout()?api('/api/v1/follow-up/assignees'):Promise.resolve({items:[]})]);
 followupItems=data.items;followupAssignees=assignees.items;showTool('Follow-up tasks');
 $('tools').innerHTML=`<section id="followup-workspace"><div class="section-head"><div><h2>Follow-up worklist</h2><p class="muted">Assigned tasks remain open until explicitly completed or cancelled. Booking an appointment does not complete a task.</p></div><button type="button" data-followup-board>Refresh tasks</button></div><form id="followup-filter-form"><div class="form-grid"><label>Filter task status<select id="followup-status">${[['open','Open tasks'],['all','All statuses'],['completed','Completed'],['cancelled','Cancelled']].map(([v,l])=>`<option value="${v}" ${followupFilter===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Filter responsibility<select id="followup-owner"><option value="all" ${followupOwner==='all'?'selected':''}>All staff</option><option value="mine" ${followupOwner==='mine'?'selected':''}>Assigned to me</option></select></label></div><button type="submit">Apply task filters</button></form><p class="muted">${data.items.length} of ${data.total??data.items.length} matching tasks loaded${data.has_more?' · additional tasks are not included':''}.</p><div id="followup-rows"></div></section>`;
 renderFollowupRows();
}
function renderFollowupRows(){
 const status=$('followup-status').value,mine=$('followup-owner').value==='mine';
 const items=followupItems.filter(t=>(status==='all'||t.status===status)&&(!mine||t.assignee_id===me.user_id));
 $('followup-rows').innerHTML=items.map(t=>`<section class="panel"><p class="eyebrow">${esc(t.patient_name)} · MRN ${esc(t.mrn)}</p>${taskRows([t])}</section>`).join('')||'<p>No tasks match these filters.</p>';
}
function showAvsPrint(version){
 const avs=checkoutState.releases.find(a=>a.version===version)||checkoutState.current_avs;if(!avs||avs.version!==version)throw new Error('Reload the summary before printing.');
 const p=avs.snapshot.patient,frame=document.createElement('iframe');frame.id='avs-print-frame';frame.title=`After-visit summary version ${version} print preview`;frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');
 frame.srcdoc=`<!doctype html><html lang="en"><meta charset="utf-8"><title>After-visit summary</title><link rel="stylesheet" href="/avs-print.css"><h1>SunCharts EHR · After-visit summary</h1><p>${esc(p.given_name)} ${esc(p.family_name)} · MRN ${esc(p.mrn)}<br>Date of birth ${esc(p.birth_date)}<br>Summary version ${version} · Released ${esc(date(avs.released_at))}</p><p>Encounter ${avs.snapshot.visit?.starts_at?esc(date(avs.snapshot.visit.starts_at)):''} · ${esc(avs.snapshot.visit?.title||'')}<br>${esc([avs.snapshot.visit?.clinician_label,avs.snapshot.visit?.facility].filter(Boolean).join(' · '))}</p><h2>Patient instructions</h2><p>${esc(avs.content.instructions)}</p><h2>Follow-up instructions</h2><p>${esc(avs.content.follow_up_instructions||'No follow-up instructions entered.')}</p>${avsSummary(avs.snapshot)}</html>`;
 const target=$('avs-print-preview');target.innerHTML='<div class="section-head"><h3>Patient summary print preview</h3><button type="button" data-avs-print>Print this summary</button></div>';target.append(frame);target.scrollIntoView({block:'start'});
}
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
  const values=formData(f);if(f.id==='followup-filter-form'){followupFilter=$('followup-status').value;followupOwner=$('followup-owner').value;await showFollowupWorkspace();return;}const base=checkoutContext?checkoutBase(checkoutContext.patient,checkoutContext.visit):'';
  if(f.id==='avs-release-form'){await api(base+'/checkout/actions','POST',{action:'release_avs',instructions:values.instructions,follow_up_instructions:values.follow_up_instructions,reason:values.reason,reviewed:true,reviewed_snapshot_digest:f.dataset.digest},Number(f.dataset.version));checkoutDrafts.delete(checkoutContext.key);f.remove();}
  else if(f.id==='avs-delivery-form')await api(base+'/checkout/actions','POST',{action:'delivery',method:values.method,reason:values.reason,avs_version:Number(f.dataset.avsVersion)},Number(f.dataset.version));
  else if(f.id==='checkout-complete-form')await api(base+'/checkout/actions','POST',{action:'checkout',reason:values.reason},Number(f.dataset.version));
  else if(f.id==='followup-create-form')await api(base+'/follow-ups','POST',{request_id:f.dataset.request,...values});
  else {const body={action:values.action,reason:values.reason};if(values.action==='reassign')body.assignee_id=values.assignee_id;if(values.action==='reschedule')body.due_date=values.due_date;await api(`/api/v1/follow-up/tasks/${f.dataset.id}/actions`,'POST',body,Number(f.dataset.version));}
  if(f.closest('#followup-workspace'))await showFollowupWorkspace();else await loadVisitCheckout();
  notice('Checkout / follow-up change saved with history.');
 });
},true);
