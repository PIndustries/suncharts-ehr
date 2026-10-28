// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const referralDeliveryBase='/api/v1/referral-delivery';
const referralDeliveryReviews=new Map(),referralDeliveryDrafts=new Map(),referralDeliveryPending=new Set(),referralDeliverySendBaselines=new WeakMap();
let referralDeliveryGeneration=0,referralDestinationItems=[],referralDestinationDraft=null;
const referralDeliveryKey=(patient,id)=>patient+':'+id;
function referralDeliveryHasDrafts(){return referralDeliveryDrafts.size>0||!!referralDestinationDraft?.dirty;}
function clearReferralDeliverySession(){referralDeliveryReviews.clear();referralDeliveryDrafts.clear();referralDeliveryPending.clear();referralDeliveryGeneration++;referralDestinationItems=[];referralDestinationDraft=null;}
function referralDestinationValues(form){const v=Object.fromEntries(new FormData(form));return {name:v.name,endpoint:v.endpoint,enabled:!!form.elements.enabled.checked,reason:v.reason};}
function captureReferralDeliveryDraft(){
 const settings=$('referral-destination-form');
 if(settings&&referralDestinationDraft){const values=referralDestinationValues(settings);referralDestinationDraft.values=values;referralDestinationDraft.dirty=JSON.stringify(values)!==referralDestinationDraft.baseline;}
 const form=$('referral-send-form');if(!form)return;
 const values={reason:form.elements.reason.value,reviewed:form.elements.reviewed.checked},key=referralDeliveryKey(form.dataset.patient,form.dataset.referral);
 const baseline=referralDeliverySendBaselines.get(form);
 if(baseline&&values.reason===baseline.reason&&values.reviewed===baseline.reviewed){referralDeliveryDrafts.delete(key);return;}
 if(values.reason||values.reviewed)referralDeliveryDrafts.set(key,values);else referralDeliveryDrafts.delete(key);
}
function deliveryStatusLabel(status){return ({queued:'Queued',sending:'Sending',sent:'Gateway accepted',uncertain:'Delivery outcome unknown',not_sent:'Not sent',cancelled:'Cancelled'})[status]||human(status);}
function referralDeliveryControls(entry){const retained=referralDeliveryDrafts.has(referralDeliveryKey(selected,entry.id));return `${retained?'<p role="status">Unapplied delivery edits are retained. Open Delivery status to inspect or discard them.</p>':''}<div class="actions">${['owner','clinician'].includes(me?.role)&&entry.status==='ready'?`<button type="button" data-referral-delivery-review="${esc(entry.id)}">Review external delivery</button>`:''}<button type="button" data-referral-delivery-jobs="${esc(entry.id)}">Delivery status</button></div><div id="referral-delivery-${esc(entry.id)}"></div>`;}
function deliveryManifestMarkup(manifest){const p=manifest.patient||{},docs=manifest.documents||[];return `<dl><dt>Receiving practice</dt><dd>${esc(manifest.recipient)}</dd><dt>Requested service</dt><dd>${esc(manifest.requested_service)}</dd><dt>Patient</dt><dd>${esc(p.family_name)}, ${esc(p.given_name)} · MRN ${esc(p.mrn)} · DOB ${esc(p.birth_date)}</dd></dl><h4>Documents to send · ${docs.length}</h4>${docs.map(d=>`<p><b>${esc(d.title)}</b> · v${esc(d.version)}<br>${esc(d.filename)} · ${esc(d.content_type)} · ${esc(d.size_bytes)} bytes<details><summary>Reviewed file integrity</summary><small>SHA-256 ${esc(d.sha256)}</small></details></p>`).join('')||'<p>No document attachments.</p>'}<p class="muted">Referral details and the listed original documents will be sent to the selected destination.</p>`;}
function showReferralSendReview(patient,id,data){
 const host=$('referral-delivery-'+id);if(!host||selected!==patient)return;
 const key=referralDeliveryKey(patient,id),draft=referralDeliveryDrafts.get(key)||{reason:'',reviewed:false};
 const expired=!Number.isFinite(Date.parse(data.expires_at))||Date.parse(data.expires_at)<=Date.now();
 host.innerHTML=`<section class="clinical-domain"><div class="section-head"><h3>Review external referral delivery</h3><span class="pill">${expired?'Review expired':'Ready for review'}</span></div><p><b>${esc(data.destination.name)}</b><br>${esc(data.destination.endpoint)}</p>${data.destination.loopback_test?'<p class="muted">Local test receiver</p>':''}${deliveryManifestMarkup(data.manifest)}<p class="muted">Gateway acceptance records a delivery receipt. Clinical acceptance and follow-up remain separate milestones.</p><form id="referral-send-form" data-patient="${esc(patient)}" data-referral="${esc(id)}"><label>Delivery reason<input name="reason" required maxlength="1000" value="${esc(draft.reason)}"></label><label class="review-ack"><input type="checkbox" name="reviewed" required ${draft.reviewed?'checked':''}>I reviewed the patient, destination and document package.</label><div class="actions"><button type="submit" ${expired?'disabled':''}>Send reviewed referral</button><button type="button" data-referral-delivery-preview="${esc(id)}">Refresh delivery review</button><button type="button" data-referral-delivery-discard="${esc(id)}">Close delivery review</button></div></form></section>`;
}
async function reviewReferralDelivery(id){
 captureReferralDeliveryDraft();const patient=selected,account=me,generation=++referralDeliveryGeneration;
 if(!['owner','clinician'].includes(account?.role))return;
 if(typeof referralDrafts!=='undefined'&&referralDrafts.has(patient))throw new Error('Save or discard referral edits before reviewing delivery.');
 const host=$('referral-delivery-'+id);if(!host)return;
 const response=await api(referralDeliveryBase+'/destinations');
 if(me!==account||selected!==patient||generation!==referralDeliveryGeneration||$('referral-delivery-'+id)!==host)return;
 const destinations=response.items.filter(d=>d.enabled);
 host.innerHTML=`<section class="clinical-domain"><h3>Choose referral destination</h3>${destinations.length?`<form id="referral-destination-select" data-patient="${esc(patient)}" data-referral="${esc(id)}"><label>Receiving gateway<select name="destination_id" required>${destinations.map(d=>`<option value="${esc(d.id)}">${esc(d.name)} · ${esc(d.endpoint)}${d.loopback_test?' · Local test':''}</option>`).join('')}</select></label><button type="submit">Review recipient and documents</button></form>`:'<p>No enabled referral destination is configured.</p>'}${me.role==='owner'?'<button type="button" data-referral-delivery-settings>Configure delivery destinations</button>':''}</section>`;
}
async function previewReferralDelivery(patient,id,destination){
 captureReferralDeliveryDraft();const account=me,generation=++referralDeliveryGeneration,host=$('referral-delivery-'+id);
 if(selected!==patient||!host)return;
 const data=await api(`/api/v1/patients/${patient}/referrals/${id}/delivery/preview`,'POST',{destination_id:destination});
 if(me!==account||selected!==patient||generation!==referralDeliveryGeneration||$('referral-delivery-'+id)!==host)return;
 const key=referralDeliveryKey(patient,id);referralDeliveryReviews.set(key,{data,request_id:crypto.randomUUID()});
 // A refreshed package requires a fresh acknowledgment, while retaining the reason.
 const draft=referralDeliveryDrafts.get(key);if(draft)draft.reviewed=false;
 showReferralSendReview(patient,id,data);
}
function deliveryJobMarkup(job,patient){const canReconcile=['owner','clinician'].includes(me?.role)&&job.status==='uncertain';return `<article class="clinical-entry"><div class="section-head"><h4>${esc(job.destination_name)}</h4><span class="pill">${esc(deliveryStatusLabel(job.status))}</span></div><p>${esc(job.endpoint)}</p><p>Created ${esc(date(job.created_at))}${job.receipt?` · Receipt ${esc(job.receipt)}`:''}</p>${job.outcome_reason?`<p>${esc(job.outcome_reason)}</p>`:''}<button type="button" data-referral-delivery-events="${esc(job.id)}">Delivery events</button><div id="referral-delivery-events-${esc(job.id)}"></div>${job.status==='sent'?'<p class="muted">The gateway accepted this package. Receiving-clinician acceptance is recorded separately.</p>':''}${job.status==='uncertain'?'<p role="status">A delivery may have reached the receiver. Verify its delivery record before reconciling this job.</p>':''}${['owner','clinician'].includes(me?.role)&&job.status==='queued'?`<form class="referral-reconcile-form" data-job="${esc(job.id)}" data-version="${esc(job.version)}" data-patient="${esc(patient)}" data-referral="${esc(job.referral_id)}"><input type="hidden" name="action" value="cancel"><input type="hidden" name="receipt" value=""><label>Cancellation reason<input name="reason" required maxlength="1000"></label><button type="submit">Cancel queued delivery</button></form>`:''}${canReconcile?`<form class="referral-reconcile-form" data-job="${esc(job.id)}" data-version="${esc(job.version)}" data-patient="${esc(patient)}" data-referral="${esc(job.referral_id)}"><label>Verified outcome<select name="action"><option value="reconcile_sent">Receiver confirms receipt</option><option value="reconcile_not_sent">Receiver confirms not received</option></select></label><label>Receiver receipt / verification evidence<input name="receipt" required maxlength="200"></label><label>Reconciliation reason<input name="reason" required maxlength="1000"></label><button type="submit">Record verified outcome</button></form>`:''}</article>`;}
async function showReferralDeliveryJobs(id){
 captureReferralDeliveryDraft();const patient=selected,account=me,generation=++referralDeliveryGeneration,host=$('referral-delivery-'+id);if(!host)return;
 const data=await api(`/api/v1/patients/${patient}/referrals/${id}/deliveries`);
 if(me!==account||selected!==patient||generation!==referralDeliveryGeneration||$('referral-delivery-'+id)!==host)return;
 let targetHost=host;
 if(data.items.some(job=>job.status==='sent')&&typeof referralStates!=='undefined'){const current=await api(`/api/v1/patients/${patient}/referrals/${id}`);if(me!==account||selected!==patient||generation!==referralDeliveryGeneration||$('referral-delivery-'+id)!==host)return;const state=referralStates.get(patient),index=state?.items.findIndex(row=>row.id===id);if(index>=0&&state.items[index].version!==current.version){state.items[index]=current;showReferrals();targetHost=$('referral-delivery-'+id);if(!targetHost)return;}}
 captureReferralDeliveryDraft();
 targetHost.innerHTML=`<section class="clinical-domain"><div class="section-head"><h3>Referral delivery history</h3><button type="button" data-referral-delivery-jobs="${esc(id)}">Refresh delivery status</button></div>${data.items.map(job=>deliveryJobMarkup(job,patient)).join('')||'<p>No delivery jobs recorded.</p>'}${data.truncated?'<p class="muted">Older delivery jobs are omitted from this view.</p>':''}${referralDeliveryDrafts.has(referralDeliveryKey(patient,id))?`<section role="status"><p>Unapplied delivery edits remain in this tab. They are separate from any queued package.</p><details><summary>View/copy retained delivery edits</summary><textarea readonly>${esc(JSON.stringify(referralDeliveryDrafts.get(referralDeliveryKey(patient,id)),null,2))}</textarea></details><button type="button" data-referral-delivery-discard="${esc(id)}">Discard retained delivery edits</button></section>`:''}</section>`;
}
async function showReferralDeliverySettings(){
 if(me?.role!=='owner')return;
 captureReferralDeliveryDraft();const account=me,generation=++referralDeliveryGeneration;
 const data=await api(referralDeliveryBase+'/destinations');if(me!==account||generation!==referralDeliveryGeneration)return;
 referralDestinationItems=data.items;showTool('Referral delivery settings');
 $('tools').innerHTML=`<section id="referral-delivery-settings"><div class="section-head"><h2>Referral delivery destinations</h2><button type="button" data-referral-destination-new>+ Destination</button></div><p>Configure the receiving practice’s referral gateway. Staff review each patient package before sending.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Destination</th><th>Delivery</th><th>Credential</th><th></th></tr></thead><tbody>${data.items.map(d=>`<tr><td><b>${esc(d.name)}</b><small>${esc(d.endpoint)}</small>${d.loopback_test?'<small>Local test receiver</small>':''}</td><td>${d.enabled?'Enabled':'Disabled'}</td><td>${d.credential_configured?'Configured':'Not configured'}</td><td><button type="button" data-referral-destination-edit="${esc(d.id)}">Edit destination</button></td></tr>`).join('')||'<tr><td colspan="4">No delivery destinations configured.</td></tr>'}</tbody></table></div><div id="referral-destination-editor"></div></section>`;
 if(referralDestinationDraft)showReferralDestinationEditor(referralDestinationDraft);
}
function showReferralDestinationEditor(draft){const host=$('referral-destination-editor');if(!host)return;const v=draft.values;host.innerHTML=`<form id="referral-destination-form"><h3>${draft.id?'Edit destination':'New delivery destination'}</h3><div class="form-grid"><label>Destination name<input name="name" required maxlength="200" value="${esc(v.name)}"></label><label>Gateway HTTPS address<input name="endpoint" type="url" required ${draft.loopback_test?'readonly':'pattern="https://.*"'} maxlength="2000" value="${esc(v.endpoint)}"></label><label>Bearer token ${draft.id?'(leave blank to keep saved credential)':''}<input name="bearer_token" type="password" minlength="16" maxlength="4096" autocomplete="new-password" spellcheck="false"></label></div><label><input type="checkbox" name="enabled" ${v.enabled?'checked':''}>Enable destination for reviewed deliveries</label><label>Reason for this change<input name="reason" required maxlength="1000" value="${esc(v.reason)}"></label>${draft.conflict?'<p role="status">The destination changed. Reload its saved settings before saving again. Your nonsecret edits remain below for comparison.</p>':''}${draft.current?`<section role="status"><h4>Current saved destination · v${esc(draft.current.version)}</h4><p>${esc(draft.current.name)}<br>${esc(draft.current.endpoint)} · ${draft.current.enabled?'Enabled':'Disabled'}</p><button type="button" data-referral-destination-rebase>Keep edits against current destination version</button></section>`:''}<div class="actions"><button type="submit" ${draft.conflict?'disabled':''}>Save destination</button>${draft.id?`<button type="button" data-referral-destination-reload="${esc(draft.id)}">Reload saved destination</button>`:''}<button type="button" data-referral-destination-discard>Discard destination edits</button></div></form>`;}
document.addEventListener('input',event=>{if(event.target.closest?.('#referral-send-form,#referral-destination-form'))captureReferralDeliveryDraft();});
document.addEventListener('change',event=>{if(event.target.closest?.('#referral-send-form,#referral-destination-form'))captureReferralDeliveryDraft();});
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-referral-delivery-settings],[data-referral-destination-new],[data-referral-destination-edit],[data-referral-destination-reload],[data-referral-destination-rebase],[data-referral-destination-discard],[data-referral-delivery-review],[data-referral-delivery-jobs],[data-referral-delivery-events],[data-referral-delivery-preview],[data-referral-delivery-discard]');if(!button)return;event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  captureReferralDeliveryDraft();
  if(button.hasAttribute('data-referral-delivery-events')){const patient=selected,account=me,job=button.dataset.referralDeliveryEvents,host=$('referral-delivery-events-'+job);if(!host)return;const data=await api(referralDeliveryBase+'/jobs/'+job);if(me!==account||selected!==patient||$('referral-delivery-events-'+job)!==host)return;host.innerHTML=`<h4>Recent delivery events</h4>${(data.history||[]).map(item=>`<p>v${esc(item.version)} · ${esc(deliveryStatusLabel(item.status))} · ${esc(date(item.created_at))}<br>${esc(item.reason)}${item.receipt?' · Receipt '+esc(item.receipt):''}</p>`).join('')||'<p>No delivery events returned.</p>'}${data.history?.length===100?'<p>Only the latest100 events are shown.</p>':''}`;return;}
  if(button.hasAttribute('data-referral-delivery-settings')){await showReferralDeliverySettings();return;}
  if(button.hasAttribute('data-referral-destination-discard')){referralDestinationDraft=null;const host=$('referral-destination-editor');if(host)host.replaceChildren();return;}
  if(button.hasAttribute('data-referral-destination-new')||button.hasAttribute('data-referral-destination-edit')){
   if(me?.role!=='owner')return;if(referralDestinationDraft?.dirty&&!window.confirm('Replace unsaved destination settings?'))return;
   const item=referralDestinationItems.find(d=>d.id===button.dataset.referralDestinationEdit),values={name:item?.name||'',endpoint:item?.endpoint||'',enabled:item?.enabled??false,reason:''};
   referralDestinationDraft={id:item?.id,version:item?.version,loopback_test:item?.loopback_test||false,request_id:crypto.randomUUID(),values,baseline:JSON.stringify(values),dirty:false};showReferralDestinationEditor(referralDestinationDraft);return;
  }
  if(button.hasAttribute('data-referral-destination-rebase')){const draft=referralDestinationDraft;if(!draft?.current)return;draft.version=draft.current.version;draft.conflict=false;delete draft.current;showReferralDestinationEditor(draft);return;}
  if(button.hasAttribute('data-referral-destination-reload')){const draft=referralDestinationDraft,account=me;const data=await api(referralDeliveryBase+'/destinations');if(me!==account||referralDestinationDraft!==draft)return;const saved=data.items.find(d=>d.id===draft.id);if(!saved)throw new Error('Destination no longer available.');captureReferralDeliveryDraft();draft.current=saved;draft.conflict=true;showReferralDestinationEditor(draft);return;}
  const id=button.dataset.referralDeliveryReview||button.dataset.referralDeliveryJobs||button.dataset.referralDeliveryPreview||button.dataset.referralDeliveryDiscard;
  if(button.hasAttribute('data-referral-delivery-discard')){referralDeliveryDrafts.delete(referralDeliveryKey(selected,id));referralDeliveryReviews.delete(referralDeliveryKey(selected,id));$('referral-delivery-'+id)?.replaceChildren();return;}
  if(button.hasAttribute('data-referral-delivery-review')){await reviewReferralDelivery(id);return;}
  if(button.hasAttribute('data-referral-delivery-jobs')){await showReferralDeliveryJobs(id);return;}
  if(button.hasAttribute('data-referral-delivery-preview')){const review=referralDeliveryReviews.get(referralDeliveryKey(selected,id));if(review)await previewReferralDelivery(selected,id,review.data.destination.id);}
 });
},true);
document.addEventListener('submit',event=>{
 const form=event.target;if(!['referral-destination-form','referral-destination-select','referral-send-form'].includes(form.id)&&!form.classList?.contains('referral-reconcile-form'))return;
 event.preventDefault();event.stopImmediatePropagation();run(async()=>{
  if(form.id==='referral-destination-select'){const patient=form.dataset.patient,id=form.dataset.referral;if(selected!==patient)throw new Error('Patient changed; reopen delivery review.');await previewReferralDelivery(patient,id,new FormData(form).get('destination_id'));return;}
  if(form.id==='referral-destination-form'){
   if(me?.role!=='owner')return;captureReferralDeliveryDraft();const account=me,draft=referralDestinationDraft;if(!draft||draft.conflict)return;
   const submitted=structuredClone(draft.values),token=form.elements.bearer_token.value;form.elements.bearer_token.value='';
   const body={...submitted,bearer_token:token||null,loopback_test:!!draft.loopback_test,...draft.id?{}:{request_id:draft.request_id}};
   let saved;try{saved=await api(referralDeliveryBase+'/destinations'+(draft.id?'/'+draft.id:''),draft.id?'PUT':'POST',body,draft.id?draft.version:undefined);}catch(error){if(me===account&&referralDestinationDraft===draft){draft.conflict=/changed|conflict|version/i.test(error.message);if($('referral-destination-form')===form)showReferralDestinationEditor(draft);}throw error;}
   if(me!==account||referralDestinationDraft!==draft)return;if($('referral-destination-form')===form)captureReferralDeliveryDraft();
   if(JSON.stringify(draft.values)===JSON.stringify(submitted))referralDestinationDraft=null;else{draft.id=saved.id;draft.version=saved.version;draft.baseline=JSON.stringify({...submitted,reason:''});draft.request_id=crypto.randomUUID();}
   await showReferralDeliverySettings();notice('Referral delivery destination saved.');return;
  }
  const patient=form.dataset.patient,id=form.dataset.referral,account=me,generation=referralDeliveryGeneration;
  if(patient!==selected)throw new Error('Patient changed; reopen the delivery workflow.');
  if(form.classList?.contains('referral-reconcile-form')){if(!['owner','clinician'].includes(me?.role))return;const body=Object.fromEntries(new FormData(form));await api(`${referralDeliveryBase}/jobs/${form.dataset.job}/actions`,'POST',body,Number(form.dataset.version));if(me!==account||selected!==patient||generation!==referralDeliveryGeneration)return;await showReferralDeliveryJobs(id);notice('Verified delivery outcome recorded.');return;}
  captureReferralDeliveryDraft();const key=referralDeliveryKey(patient,id),review=referralDeliveryReviews.get(key),draft=referralDeliveryDrafts.has(key)?structuredClone(referralDeliveryDrafts.get(key)):null;
  if(!review||!draft?.reviewed||!draft.reason.trim())throw new Error('Review the patient, destination and document package before sending.');
  if(Date.parse(review.data.expires_at)<=Date.now())throw new Error('Delivery review expired. Refresh it before sending.');
  if(referralDeliveryPending.has(key))throw new Error('This package is already being queued.');referralDeliveryPending.add(key);
  let job;try{job=await api(`/api/v1/patients/${patient}/referrals/${id}/delivery`,'POST',{destination_id:review.data.destination.id,destination_version:review.data.destination.version,request_id:review.request_id,review_digest:review.data.review_digest,reason:draft.reason},review.data.referral_version);}finally{referralDeliveryPending.delete(key);}
  if(me!==account||selected!==patient||generation!==referralDeliveryGeneration)return;referralDeliverySendBaselines.set(form,structuredClone(draft));captureReferralDeliveryDraft();referralDeliveryReviews.delete(key);await showReferralDeliveryJobs(id);notice(`Referral delivery ${deliveryStatusLabel(job.status).toLowerCase()}.`);
 });
},true);
