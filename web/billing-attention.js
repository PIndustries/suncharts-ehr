// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The billing work queue: what a person has to put right, and how long the money has been
// waiting. It leads the Billing screen and only ever opens work that already lives elsewhere,
// so nothing here changes a record. Loaded before both patient billing screens, which each ask
// for the queue and paint it into their own panel.

const billingAttentionKinds={rejected:'Rejected',denied:'Denied',era_needs_review:'Payment to post',ready_to_send:'Ready to send',waiting_on_payer:'Waiting on insurance',patient_balance:'Patient owes'};
const billingAttentionOrder=['rejected','denied','era_needs_review','ready_to_send','waiting_on_payer','patient_balance'];
const billingAttentionTargets=['visit_review','claim','era','patient_billing'];
let billingAttentionFilter='all',billingAttentionLoaded=null;
function billingAttentionAllowed(resource){return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);}
function billingAttentionLabel(kind){return billingAttentionKinds[kind]||'Needs review';}
function billingAttentionKind(kind){return Object.hasOwn(billingAttentionKinds,kind)?kind:'other';}
function billingAttentionEmpty(){return {items:[],aging:{buckets:[],total_cents:0}};}
function billingAttentionItems(data){return Array.isArray(data&&data.items)?data.items.filter(item=>item&&typeof item==='object'):[];}
function billingAttentionAging(data){
 const buckets=Array.isArray(data&&data.aging&&data.aging.buckets)?data.aging.buckets.filter(bucket=>bucket&&typeof bucket==='object'):[];
 return {buckets,cents:Number.isSafeInteger(data&&data.aging&&data.aging.total_cents)?data.aging.total_cents:null};
}
function billingAttentionCount(items,kind){return kind==='all'?items.length:items.filter(item=>billingAttentionKind(item.kind)===kind).length;}
function billingAttentionMoney(value){return Number.isSafeInteger(value)?money(value):'Amount not recorded';}
function billingAttentionAge(days){return Number.isSafeInteger(days)&&days>=0?(days===1?'1 day waiting':`${days} days waiting`):'';}
function billingAttentionRow(item){
 const kind=billingAttentionKind(item.kind),age=billingAttentionAge(item.age_days),action=item.action&&typeof item.action==='object'?item.action:{};
 const target=billingAttentionTargets.includes(action.target)?action.target:'';
 const identifier=value=>esc(value==null?'':String(value));
 return `<tr class="billing-attention-row is-${kind}" data-attention-kind="${kind}"><td><span class="billing-attention-chip is-${kind}">${esc(billingAttentionLabel(item.kind))}</span></td><td><b>${esc(item.patient_name==null?'Patient':String(item.patient_name))}</b>${age?`<small>${esc(age)}</small>`:''}</td><td class="money-cell">${billingAttentionMoney(item.amount_cents)}</td><td>${item.message?esc(String(item.message)):'<span class="muted">No note recorded.</span>'}</td><td>${target?`<button type="button" data-attention-open="${target}" data-attention-patient="${identifier(item.patient_id)}" data-attention-visit="${identifier(item.visit_id)}" data-attention-claim="${identifier(item.claim_id)}">${esc(action.label==null?'Open':String(action.label))}</button>`:'<span class="muted">No screen to open for this one.</span>'}</td></tr>`;
}
function billingAttentionMarkup(data){
 const items=billingAttentionItems(data),aging=billingAttentionAging(data);
 const kinds=billingAttentionOrder.filter(kind=>billingAttentionCount(items,kind)>0);
 const shown=billingAttentionFilter==='all'?items:items.filter(item=>billingAttentionKind(item.kind)===billingAttentionFilter);
 const chips=['all',...kinds].map(kind=>`<button type="button" data-attention-filter="${kind}" aria-pressed="${billingAttentionFilter===kind}">${kind==='all'?'Everything':esc(billingAttentionLabel(kind))}<span>${billingAttentionCount(items,kind)}</span></button>`).join('');
 const buckets=aging.buckets.length?aging.buckets.map(bucket=>`<div class="billing-aging-bucket"><b>${billingAttentionMoney(bucket.cents)}</b><span>${esc(bucket.label==null?'':String(bucket.label))}</span><small>${Number.isSafeInteger(bucket.count)?bucket.count:'—'} item${bucket.count===1?'':'s'}</small></div>`).join(''):'<div class="billing-aging-bucket"><span>No aging recorded yet</span></div>';
 const total=Number.isSafeInteger(aging.cents)?`<div class="billing-aging-bucket is-total"><b>${billingAttentionMoney(aging.cents)}</b><span>Waiting in total</span><small>${items.length} item${items.length===1?'':'s'}</small></div>`:'';
 const list=items.length?`<nav class="billing-attention-filters" aria-label="Filter by what needs doing">${chips}</nav><div class="billing-table-wrap"><table class="billing-table billing-attention-table"><thead><tr><th>What it is</th><th>Patient</th><th class="money-cell">Amount</th><th>What to know</th><th></th></tr></thead><tbody>${shown.map(billingAttentionRow).join('')||'<tr><td colspan="5" class="table-empty">Nothing here in this filter. Choose Everything to see the whole list.</td></tr>'}</tbody></table></div>`:'<p class="billing-attention-clear" role="status">Nothing needs attention.</p>';
 return `<section class="billing-attention" id="billing-attention" aria-labelledby="billing-attention-heading"><div class="section-head"><div><h3 id="billing-attention-heading">Needs your attention</h3><p class="muted">Work down this list. Nothing here changes on its own until you open it.</p></div><div class="actions"><button type="button" data-attention-refresh>Check again</button></div></div><div class="billing-aging" role="group" aria-label="How long money has been waiting">${buckets}${total}</div>${list}</section>`;
}
function billingAttentionLoadingMarkup(){return '<div class="billing-attention billing-attention-shell" id="billing-attention"><div class="section-head"><div><h3>Needs your attention</h3></div></div><p role="status">Checking what needs attention…</p></div>';}
function billingAttentionUnavailableMarkup(){return '<section class="billing-attention" id="billing-attention"><div class="section-head"><div><h3>Needs your attention</h3></div><div class="actions"><button type="button" data-attention-refresh>Check again</button></div></div><p role="status">This list could not be loaded just now. Everything below still works.</p></section>';}
// Each screen gives its own host; the queue only ever replaces the block it drew there.
function billingAttentionHostIn(host){return host&&host.querySelector?host.querySelector('#billing-attention'):null;}
function paintBillingAttention(host,data){
 const block=billingAttentionHostIn(host);if(!block)return false;
 billingAttentionLoaded=data;
 block.outerHTML=billingAttentionMarkup(data);
 return true;
}
const billingAttentionRequests=new Map();
async function loadBillingAttention(host){
 if(!host||!host.querySelector)return;
 const block=billingAttentionHostIn(host);
 if(!block)return; // the screen has moved on; its host no longer holds the queue
 const request={cancelled:false};billingAttentionRequests.set(block,request);
 try{
  const data=await api('/api/v1/billing/attention');
  if(request.cancelled||billingAttentionHostIn(host)!==block)return; // explicit re-check won, or the screen moved on
  paintBillingAttention(host,data);
 }catch(_error){
  // A queue that cannot be read is a note, never a wall: the rest of the screen stays usable.
  if(!request.cancelled&&billingAttentionHostIn(host)===block)block.innerHTML=billingAttentionUnavailableMarkup();
 }finally{
  if(billingAttentionRequests.get(block)===request)billingAttentionRequests.delete(block);
 }
}
// The shared auto-refresh repaints the whole billing screen and the queue rides
// along with it: it only paints into a block the screen left in place, so a late
// answer after the screen moved on is dropped. It stays silent on failure; the
// next pass retries, and a deliberate "Check again" cancels this quiet read.
async function autoRefreshBillingAttention(host){
 if(!host||host.isConnected===false||typeof billingAttentionHostIn!=='function')return;
 const block=billingAttentionHostIn(host);if(!block)return;
 try{
  const data=await api('/api/v1/billing/attention');
  if(billingAttentionHostIn(host)!==block)return;
  paintBillingAttention(host,data);
 }catch(_error){/* the next pass retries; no popup on a quiet update */}
}
function cancelBillingAttentionLoad(){billingAttentionRequests.forEach(request=>{request.cancelled=true;});}
function selectBillingAttentionFilter(host,kind){
 if(!billingAttentionLoaded||!billingAttentionLoaded.items.length)return; // nothing read yet, or nothing to narrow
 billingAttentionFilter=['all',...billingAttentionOrder].includes(kind)?kind:'all';
 paintBillingAttention(host,billingAttentionLoaded);
}
// Each row opens the work where it already lives. A screen that cannot show it says so plainly
// instead of failing silently, and nothing is changed on the way.
async function openBillingAttention(button){
 const target=button.dataset.attentionOpen,patient=button.dataset.attentionPatient||'',visit=button.dataset.attentionVisit||'',claim=button.dataset.attentionClaim||'';
 if(target==='claim'){
  if(!claim||!billingAttentionAllowed('claims'))return notice('This needs insurance claim access. A billing staff member can open it.',true);
  await showClaimsWorkspace();await showClaim(claim);return;
 }
 if(target==='era'){
  if(!billingAttentionAllowed('claims'))return notice('This needs insurance payment access. A billing staff member can open it.',true);
  await showClaimsWorkspace();
  if(!claim)return notice('Open this insurance payment from the claims list.',true);
  await showEra(claim);return;
 }
 if(target==='patient_billing'){
  if(!patient)return notice('This one does not say which patient it belongs to yet.',true);
  if(typeof showPatientBillingWorkspace!=='function')return notice('Patient billing is not available on this screen.',true);
  await showPatientBillingWorkspace({patientId:patient,tab:'overview'});return;
 }
 if(target!=='visit_review')return notice('This screen has not been set up to open from here yet.',true);
 if(!patient||!visit||!billingAttentionAllowed('clinical'))return notice('Open this visit from the patient chart to check its billing.',true);
 const identity=me;
 await showClinical();if(me!==identity)return;
 await selectPatient(patient,visit);if(me!==identity)return;
 if(typeof setEncounterSection==='function')setEncounterSection('charges');
 if(typeof renderEncounterRevenue==='function')renderEncounterRevenue();
 if(typeof visitReviewOpen==='function')visitReviewOpen();
 const panel=$('visit-billing-review');
 if(panel&&panel.hidden===false)panel.scrollIntoView({block:'start'});
 else notice('The visit is open on its billing step. Use “Review and send” there to check the claim.',true);
}
async function refreshBillingAttention(host){
 // Show the working note first; when the screen paints its body it keeps the queue's markup.
 const block=billingAttentionHostIn(host);if(block)block.outerHTML=billingAttentionLoadingMarkup();
 await loadBillingAttention(host);
}
// One listener serves both screens: a click anywhere inside a billing panel is a queue action.
document.addEventListener('click',event=>{
 const button=event.target&&event.target.closest?event.target.closest('button'):null;
 if(!button||!button.closest('.billing-attention'))return;
 const host=(button.closest('.patient-billing-hub')||$('billing-overview'))||null;
  if(button.hasAttribute('data-attention-refresh')){cancelBillingAttentionLoad();run(()=>refreshBillingAttention(host));return;}
 if(button.dataset.attentionFilter!==undefined){selectBillingAttentionFilter(host,button.dataset.attentionFilter);return;}
 if(button.dataset.attentionOpen)run(()=>openBillingAttention(button));
});
