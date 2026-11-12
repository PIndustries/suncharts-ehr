// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Shared plan UI. Drafts remain in this tab and are discarded across identities.
let patientPlanDraftOwner=null,patientPlanBaselines=new WeakMap();
const patientPlanDrafts=new Map();
function patientPlanDraftSession(){if(patientPlanDraftOwner!==me){patientPlanDrafts.clear();patientPlanBaselines=new WeakMap();patientPlanDraftOwner=me;}}
function patientPlanDraftKey(s,kind){return JSON.stringify([me?.tenant_id,s.patientId,kind]);}
function patientPlanFormDraft(form){
 const values=[];for(const field of form.querySelectorAll('input,textarea,select'))if(field.name)values.push({name:field.name,value:field.value,checked:field.type==='checkbox'?false:undefined});
 return {values,invoice:form.dataset.invoice||null,schedule:form.id==='installment-preview-form'?[...form.querySelectorAll('[data-installment-row]')].map(row=>({due_on:row.querySelector('[name="due_on"]').value,amount:row.querySelector('[name="amount"]').value})):[]};
}
function capturePatientPaymentPlanDrafts(){
 patientPlanDraftSession();const s=patientBillingWorkspace;if(!patientBillingCurrent(s))return;
 for(const form of s.host.querySelectorAll('form[data-patient-plan-draft]')){
  const baseline=patientPlanBaselines.get(form);if(!baseline)continue;const record=patientPlanFormDraft(form),key=patientPlanDraftKey(s,form.dataset.patientPlanDraft);
  if(JSON.stringify(record)===baseline)patientPlanDrafts.delete(key);else patientPlanDrafts.set(key,record);
 }
}
function patientPaymentPlansHaveDrafts(){patientPlanDraftSession();return patientPlanDrafts.size>0;}
function restorePatientPlanDraft(s,form){
 patientPlanDraftSession();patientPlanBaselines.set(form,JSON.stringify(patientPlanFormDraft(form)));
 const record=patientPlanDrafts.get(patientPlanDraftKey(s,form.dataset.patientPlanDraft));if(!record)return;
 const fields=[...form.querySelectorAll('input,textarea,select')],used=new Set();
 for(const value of record.values){const field=fields.find((field,index)=>!used.has(index)&&field.name===value.name);if(!field)continue;used.add(fields.indexOf(field));field.value=value.value;if(field.type==='checkbox')field.checked=false;}
 if(form.id==='installment-preview-form'&&record.schedule.length){
  form.querySelector('#installment-proposed-schedule').innerHTML=`<p class="mapping-notice">Your unsaved schedule is retained. Preview it again against the current invoice before agreeing to a plan.</p><table class="billing-table"><tbody>${record.schedule.map((row,index)=>`<tr data-installment-row><td>${index+1}</td><td><input aria-label="Installment ${index+1} due date" name="due_on" type="date" value="${esc(row.due_on)}" required></td><td><input aria-label="Installment ${index+1} amount in USD" name="amount" inputmode="decimal" value="${esc(row.amount)}" required></td></tr>`).join('')}</tbody></table>`;
  form.dataset.invoice=record.invoice;form.querySelector('button[type="submit"]').disabled=form.elements.invoice_id.value!==record.invoice;
 }
}
function settlePatientPlanDraft(s,form,submitted){
 if(!submitted)return;
 const kind=form.dataset.patientPlanDraft,key=patientPlanDraftKey(s,kind),current=[...s.host.querySelectorAll('form[data-patient-plan-draft]')].find(item=>item.dataset.patientPlanDraft===kind);
 if(!current){patientPlanDrafts.delete(key);return;}
 const value=patientPlanFormDraft(current);
 if(JSON.stringify(value)===JSON.stringify(submitted)){patientPlanDrafts.delete(key);patientPlanBaselines.delete(current);}
 else patientPlanDrafts.set(key,value);
}
function patientPlansCurrent(s,host,request){return patientBillingCurrent(s)&&s.tab==='subscriptions'&&s.planRequest===request&&host.isConnected!==false;}
function membershipCadence(price){return `${patientBillingAmount(price.amount_cents,price.currency)} every ${price.interval_count} ${price.interval}${price.interval_count===1?'':'s'}`;}
function membershipPricePendingMarkup(pending){
 const retry=pending.body&&pending.retry_allowed&&Date.now()<pending.deadline;
 return `<section class="mapping-notice"><h4>Unresolved approved-price request</h4>${pending.body?`<p>${esc(pending.body.name)} · ${esc(membershipCadence(pending.body))}. Retry uses these original approved terms.</p>`:'<p>The original price request requires review by its initiating practice owner.</p>'}${pending.error?`<p role="status">${esc(pending.error)}</p>`:''}<button type="button" data-membership-price-check="${esc(pending.request_id)}">Check original price request</button>${retry?'<button type="button" data-membership-price-retry>Retry original price request</button>':'<p>Creating a new price is paused until the original request is resolved.</p>'}</section>`;
}

function membershipPriceForm(){return `<details class="billing-section"><summary>Approve a practice membership price</summary><form id="membership-price-form" data-patient-plan-draft="membership-price"><p>This fixed USD service price applies to the practice. It does not enroll or charge a patient. Changing an approved price requires a new price.</p><div class="form-grid"><label>Generic service plan name<input name="name" maxlength="100" required autocomplete="off" placeholder="Practice service plan"></label><label>Price (USD)<input name="amount" inputmode="decimal" required placeholder="50.00"></label><label>Every<input name="interval_count" type="number" min="1" max="12" value="1" required></label><label>Interval<select name="interval"><option value="month">Month</option><option value="year">Year</option><option value="week">Week</option><option value="day">Day</option></select></label></div><label>Reason for approving this price<textarea name="approval_reason" maxlength="500" required></textarea></label><label class="check"><input name="approved" type="checkbox" required> I approve this fixed practice price and billing interval.</label><button type="submit">Approve practice price</button></form></details>`;}
function membershipSelectionForm(s){
 const prices=(s.membershipPrices||[]).filter(price=>price.status==='active'&&!(s.memberships||[]).some(op=>op.price?.id===price.id&&!['expired','canceled'].includes(op.status)));
 if(s.membershipCatalogError)return `<p role="status">${esc(s.membershipCatalogError)}</p><p>Approved prices are unavailable; existing memberships remain visible.</p>`;
 if(!s.membershipAvailable)return '<p class="muted">Starting a membership is unavailable for the configured payment account. Existing memberships remain visible.</p>';
 if(!prices.length)return '<p>No approved active membership prices are available. A practice owner must approve a fixed price before enrollment.</p>';
 return `<form id="patient-membership-form" data-patient-plan-draft="membership"><h4>Start a membership or recurring service</h4><label>Approved practice price<select name="price_id" required><option value="">Choose an approved price</option>${prices.map(price=>`<option value="${esc(price.id)}">${esc(price.name)} · ${esc(membershipCadence(price))}</option>`).join('')}</select></label><div id="patient-membership-terms"><p>Choose a price to review its exact amount and cadence.</p></div><label class="check"><input name="consent" type="checkbox" required> The patient has agreed to this recurring price and schedule. They will separately authorize recurring charges on the secure Stripe page.</label><button type="submit" class="primary">Review on secure checkout</button></form>`;
}
function patientMembershipTerms(s,form){
 const price=(s.membershipPrices||[]).find(price=>price.id===form.elements.price_id.value&&price.status==='active'),host=form.querySelector('#patient-membership-terms');if(!host)return;
 host.innerHTML=price?`<section class="mapping-notice"><b>${esc(price.name)}</b><p>${esc(membershipCadence(price))}. Billing continues until canceled. Cancellation is scheduled for the end of the paid period; it does not issue an immediate refund.</p><p>Only the secure checkout can start this membership. Saving a card alone does not enroll the patient.</p></section>`:'<p>Choose a price to review its exact amount and cadence.</p>';
}
function installmentScheduleRows(rows){return rows.map((row,index)=>`<tr data-installment-row><td>${index+1}</td><td><input aria-label="Installment ${index+1} due date" name="due_on" type="date" value="${esc(row.due_on)}" required></td><td><input aria-label="Installment ${index+1} amount in USD" name="amount" inputmode="decimal" value="${esc(dollars(row.amount_cents))}" required></td></tr>`).join('');}
function proposeInstallmentSchedule(amount,count,first){
 if(!Number.isSafeInteger(amount)||!Number.isSafeInteger(count)||count<2||count>24||Math.floor(amount/count)<50||!/^\d{4}-\d{2}-\d{2}$/.test(first))throw new Error('Choose 2–24 installments of at least $0.50 and a valid first due date.');
 const [year,month,day]=first.split('-').map(Number),initial=new Date(Date.UTC(year,month-1,day));
 if(initial.toISOString().slice(0,10)!==first)throw new Error('Enter a valid first due date.');
 const base=Math.floor(amount/count),remainder=amount%count;
 return Array.from({length:count},(_,index)=>{const maxDay=new Date(Date.UTC(year,month+index,0)).getUTCDate(),due=new Date(Date.UTC(year,month-1+index,Math.min(day,maxDay))).toISOString().slice(0,10);return {due_on:due,amount_cents:base+(index<remainder?1:0)};});
}
function installmentScheduleValue(form){
 return [...form.querySelectorAll('[data-installment-row]')].map(row=>({due_on:row.querySelector('[name="due_on"]').value,amount_cents:cents(row.querySelector('[name="amount"]').value)}));
}
document.addEventListener('input',event=>{const form=event.target.closest?.('form[data-patient-plan-draft]');if(!form)return;const s=patientBillingWorkspace;if(patientBillingCurrent(s)&&form.closest('.patient-billing-hub')===s.host){if(form.id==='membership-price-form'&&event.target.name!=='approved')form.elements.approved.checked=false;if(form.id==='installment-preview-form'){s.installmentPreview=null;s.installmentPreviewRequest=null;s.host.querySelector('#installment-plan-review')?.replaceChildren();}capturePatientPaymentPlanDrafts();}});
document.addEventListener('change',event=>{
 const form=event.target.closest?.('form[data-patient-plan-draft]');if(!form)return;
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||form.closest('.patient-billing-hub')!==s.host)return;
 if(form.id==='patient-membership-form'&&event.target.name==='price_id'){form.elements.consent.checked=false;patientMembershipTerms(s,form);}
 if(form.id==='installment-preview-form'){s.installmentPreview=null;s.installmentPreviewRequest=null;const review=s.host.querySelector('#installment-plan-review');if(review)review.replaceChildren();if(['invoice_id','count','first_due'].includes(event.target.name)){form.querySelector('#installment-proposed-schedule').replaceChildren();form.querySelector('button[type="submit"]').disabled=true;}}
 if(form.id==='membership-price-form'&&event.target.name==='interval')form.elements.interval_count.max=String({day:365,week:52,month:12,year:1}[event.target.value]);
 capturePatientPaymentPlanDrafts();
});
let membershipRequestOwner=null;
const membershipRequests=new Map(),membershipPriceRequests=new Map(),membershipCancelRequests=new Map();
function membershipSession(){if(membershipRequestOwner!==me){membershipRequests.clear();membershipPriceRequests.clear();membershipCancelRequests.clear();membershipRequestOwner=me;}}
function membershipCurrentRequest(s){membershipSession();return membershipRequests.get(s.patientId);}
function membershipRequestMarkup(op){
 if(!op)return '';
 const names={creating:'Preparing membership checkout',open:'Membership checkout is ready',pending:'Membership verification pending',active:'Membership active',canceled:'Membership canceled',expired:'Membership checkout expired',needs_review:'Membership needs review',unknown:'Membership result unknown'};
 const url=op.status==='open'?patientBillingCheckoutUrl(op.session?.url):null;
 return `<section class="mapping-notice"><h4>${esc(names[op.status]||'Membership status unavailable')}</h4>${op.price?`<p>${esc(op.price.name)} · ${esc(membershipCadence(op.price))}</p>`:''}${op.error?`<p role="status">${esc(op.error)}</p>`:''}${url?`<a class="button primary" href="${esc(url)}" rel="noreferrer" referrerpolicy="no-referrer">Continue secure membership checkout</a>`:''}<button type="button" data-membership-refresh="${esc(op.request_id)}">Check membership status</button>${op.retry_allowed&&Date.parse(op.retry_safe_until)>Date.now()&&billingCan('create')?`<button type="button" data-membership-retry="${esc(op.request_id)}">Retry this membership request</button>`:''}<p class="muted">Checkout return alone does not confirm a subscription or payment.</p></section>`;
}
function patientMembershipRows(s){
 return (s.memberships||[]).map(op=>`<article class="patient-billing-card"><h4>${esc(op.price?.name||'Practice membership')}</h4><p>${op.price?esc(membershipCadence(op.price)):'Price unavailable'}</p><p>${esc(human(op.subscription_status||op.status))}${op.cancel_at_period_end?' · cancellation scheduled at period end':''}</p>${op.current_period_end?`<small>Current period ends ${esc(patientBillingProviderDate(op.current_period_end))}</small>`:''}${['creating','open','pending','needs_review'].includes(op.status)?membershipRequestMarkup(op):`<button type="button" data-membership-refresh="${esc(op.request_id)}">Refresh verified status</button>`}${op.subscription_id&&!op.cancel_at_period_end&&!['canceled','incomplete_expired'].includes(op.subscription_status)&&billingCan('edit')&&!s.membershipPending?.some(p=>p.kind==='cancel')?`<button type="button" data-membership-cancel="${esc(op.request_id)}">Cancel at period end</button>`:''}</article>`).join('')||'<p>No memberships created through this practice are recorded for this patient.</p>';
}
function renderPatientMembershipPanel(s){
 const host=s.host.querySelector('#patient-billing-memberships');if(!host||!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
 capturePatientPaymentPlanDrafts();
 const local=membershipCurrentRequest(s),listed=local&&(s.memberships||[]).some(op=>op.request_id===local.request_id),pending=(s.memberships||[]).some(op=>['creating','open','pending','needs_review'].includes(op.status))||(s.membershipPending||[]).some(op=>op.kind==='membership');
 host.innerHTML=`<div class="section-head"><h3>Memberships & recurring services</h3><button type="button" data-memberships-refresh>Refresh memberships</button></div>${s.membershipLive===false?'<p class="mapping-notice"><b>TEST memberships — no real funds.</b></p>':''}<div class="patient-billing-cards">${patientMembershipRows(s)}</div>${local&&!listed?membershipRequestMarkup(local):''}${patientMembershipPendingMarkup(s)}${s.membershipsAfter?'<button type="button" data-memberships-first>First memberships page</button>':''}${s.membershipsNext?`<button type="button" data-memberships-next="${esc(s.membershipsNext)}">Next memberships</button>`:''}${billingCan('create')?local&&!['active','canceled','expired'].includes(local.status)||pending?'<p class="muted">Review the pending request above before beginning another enrollment.</p>':membershipSelectionForm(s):'<p class="muted">Your role can view memberships. Enrollment requires billing creation access.</p>'}${s.membershipPricesNext?`<button type="button" data-membership-prices-next="${esc(s.membershipPricesNext)}">Load more approved prices</button>`:''}${me.role==='owner'?(membershipPriceRequests.has(me.tenant_id)?membershipPricePendingMarkup(membershipPriceRequests.get(me.tenant_id)):s.catalogCreationAvailable?membershipPriceForm():''):''}`;
 for(const form of host.querySelectorAll('form[data-patient-plan-draft]'))restorePatientPlanDraft(s,form);
 const enrollment=host.querySelector('#patient-membership-form');if(enrollment)patientMembershipTerms(s,enrollment);
}
async function loadPatientMemberships(s,request){
 const host=s.host.querySelector('#patient-billing-memberships');if(!host)return;
 const generation=s.membershipRead=(s.membershipRead||0)+1,current=()=>patientPlansCurrent(s,host,request)&&s.membershipRead===generation;
 const query=new URLSearchParams();if(s.membershipsAfter)query.set('after',s.membershipsAfter);
 try{
  const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/memberships`+(query.size?'?'+query:''));
  if(!current())return;
  if(data.patient_id!==s.patientId||typeof data.livemode!=='boolean'||!Array.isArray(data.items))throw new Error('The membership records could not be verified for this patient.');
  s.memberships=data.items;s.membershipPending=data.pending_operations||[];s.membershipLive=data.livemode;s.membershipAvailable=data.creation_available===true;s.membershipsNext=data.next_cursor||null;
  const local=membershipCurrentRequest(s),listed=local&&data.items.find(op=>op.request_id===local.request_id);if(listed)membershipRequests.set(s.patientId,listed);
  try{const prices=await api('/api/v1/billing/membership-prices');if(!current())return;s.membershipPrices=Array.isArray(prices.items)?prices.items:[];s.membershipPricesNext=prices.next_cursor||null;s.catalogCreationAvailable=prices.creation_available===true;s.membershipCatalogError=null;s.pricePending=prices.pending_operations||[];const pendingPrice=s.pricePending.find(op=>op.kind==='price');if(pendingPrice)membershipPriceRequests.set(me.tenant_id,{request_id:pendingPrice.request_id,body:pendingPrice.request,deadline:Date.parse(pendingPrice.retry_safe_until),retry_allowed:pendingPrice.retry_allowed===true});}catch(error){if(!current())return;s.membershipPrices=[];s.catalogCreationAvailable=false;s.membershipCatalogError=error.message||'Approved prices could not be loaded.';}
  renderPatientMembershipPanel(s);
  const external=s.host.querySelector('#patient-billing-profile-section');if(external&&s.profile)external.innerHTML=patientBillingProfileMarkup(s.profile,'subscriptions',s);
 }catch(error){if(current())host.innerHTML=`<h3>Memberships & recurring services</h3><p role="alert">${esc(error.message||'Membership records are unavailable.')}</p><p>The number of memberships is unknown.</p><button type="button" data-memberships-refresh>Retry memberships</button>`;}
}
async function loadMoreMembershipPrices(s,cursor){
 const identity=s.identity,host=s.host.querySelector('#patient-billing-memberships'),request=s.planRequest;
 const generation=s.membershipRead=(s.membershipRead||0)+1,current=()=>patientPlansCurrent(s,host,request)&&s.membershipRead===generation;
 const data=await api('/api/v1/billing/membership-prices?after='+encodeURIComponent(cursor));
 if(me!==identity||!current())return;
 const known=new Set((s.membershipPrices||[]).map(p=>p.id));s.membershipPrices.push(...(data.items||[]).filter(p=>!known.has(p.id)));s.membershipPricesNext=data.next_cursor||null;renderPatientMembershipPanel(s);
}
function checkedMembership(data,s,request){
 const op=data.membership;
 if(data.patient_id!==s.patientId||!op||op.request_id!==request)throw new Error('The membership response did not match this patient and request.');
 return op;
}
async function createPatientMembership(s,form,existing){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create')||!s.membershipAvailable)return;
 membershipSession();const current=membershipCurrentRequest(s);if(!existing&&current&&!['active','canceled','expired'].includes(current.status))return;let body;
 if(existing){if(membershipCurrentRequest(s)!==existing||!existing.retry_allowed||!(Date.parse(existing.retry_safe_until)>Date.now())||(!existing.input&&!existing.price?.id))return;body=existing.input||{request_id:existing.request_id,price_id:existing.price.id,consent:true};}
 else{
  if(!form.elements.consent.checked)return;
  const price=s.membershipPrices?.find(p=>p.id===form.elements.price_id.value&&p.status==='active');if(!price)throw new Error('Choose an approved active membership price.');
  if((s.memberships||[]).some(op=>op.price?.id===price.id&&!['expired','canceled'].includes(op.status)))throw new Error('Review the existing membership for this price before starting another.');
  body={request_id:crypto.randomUUID(),price_id:price.id,consent:true};
 }
 s.membershipRead=(s.membershipRead||0)+1;
 const pending={request_id:body.request_id,status:'creating',input:body,price:s.membershipPrices?.find(p=>p.id===body.price_id),retry_safe_until:existing?.retry_safe_until||new Date(Date.now()+23*3600000).toISOString()};membershipRequests.set(s.patientId,pending);renderPatientMembershipPanel(s);
 try{
  const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/memberships`,'POST',body);
  if(me!==s.identity)return;membershipRequests.set(s.patientId,{...checkedMembership(data,s,body.request_id),input:body});patientPlanDrafts.delete(patientPlanDraftKey(s,'membership'));
 }catch(error){if(me===s.identity)membershipRequests.set(s.patientId,{...pending,status:'unknown',retry_allowed:true,error:error.message||'No response was received. Check the original request before trying again.'});}
 if(patientBillingCurrent(s)&&s.tab==='subscriptions')renderPatientMembershipPanel(s);
}
function beginMembershipStatusRead(s){
 const host=s.host.querySelector('#patient-billing-memberships'),request=s.planRequest;
 const generation=s.membershipRead=(s.membershipRead||0)+1;
 return ()=>host&&patientPlansCurrent(s,host,request)&&s.membershipRead===generation;
}
async function refreshPatientMembership(s,id){
 const current=beginMembershipStatusRead(s);
 const data=await api('/api/v1/billing/memberships/'+encodeURIComponent(id));
 if(!current())return;
 const op=checkedMembership(data,s,id),prior=membershipCurrentRequest(s);membershipRequests.set(s.patientId,{...op,...(prior?.request_id===id&&prior.input?{input:prior.input}:{})});
 const index=(s.memberships||[]).findIndex(item=>item.request_id===id);if(index>=0)s.memberships[index]=op;else(s.memberships??=[]).unshift(op);renderPatientMembershipPanel(s);
}
async function approveMembershipPrice(s,form){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||me.role!=='owner'||!billingCan('create')||!s.catalogCreationAvailable||form&&!form.elements.approved.checked)return;
 membershipSession();const old=membershipPriceRequests.get(me.tenant_id);if(!form&&!old)return;
 const body=old?.body||{request_id:crypto.randomUUID(),name:form.elements.name.value.trim(),amount_cents:cents(form.elements.amount.value),currency:'usd',interval:form.elements.interval.value,interval_count:Number(form.elements.interval_count.value),approved:true,approval_reason:form.elements.approval_reason.value.trim()};
 if(!body.name||!body.approval_reason||body.amount_cents<50||body.amount_cents>100000000||!Number.isInteger(body.interval_count)||body.interval_count<1||body.interval_count>({day:365,week:52,month:12,year:1}[body.interval]||0))throw new Error('Review the fixed price, interval and approval reason.');
 if(old&&(!old.body||!old.retry_allowed||Date.now()>=old.deadline))throw new Error('This price request needs review. Refresh the catalog; do not create a second request.');
 s.membershipRead=(s.membershipRead||0)+1;
 membershipPriceRequests.set(me.tenant_id,{request_id:body.request_id,body,deadline:old?.deadline||Date.now()+23*3600000,retry_allowed:true});renderPatientMembershipPanel(s);
 try{
  const result=await api('/api/v1/billing/membership-prices','POST',body);
  if(me!==s.identity)return;if(result.price?.request_id!==body.request_id)throw new Error('The approved-price response did not match this request.');
  if(result.price.status==='active'||result.price.provider_price_id)membershipPriceRequests.delete(me.tenant_id);patientPlanDrafts.delete(patientPlanDraftKey(s,'membership-price'));
  if(patientBillingCurrent(s)&&s.tab==='subscriptions')await loadPatientMemberships(s,s.planRequest);
 }catch(error){if(me===s.identity){const pending=membershipPriceRequests.get(me.tenant_id);if(pending)pending.error=error.message||'The price request result is unknown.';if(patientBillingCurrent(s)&&s.tab==='subscriptions')renderPatientMembershipPanel(s);}}
}
function patientMembershipPendingMarkup(s){
 return (s.membershipPending||[]).filter(op=>op.kind==='cancel'||(op.kind==='membership'&&!(s.memberships||[]).some(item=>item.request_id===op.request_id)&&membershipCurrentRequest(s)?.request_id!==op.request_id)).map(op=>`<section class="mapping-notice"><h4>${op.kind==='cancel'?'Pending cancellation':'Pending enrollment request'}</h4><p>${esc(human(op.status))}. Review the original request; a new request is not needed.</p><button type="button" data-membership-operation-check="${esc(op.request_id)}">Check original request</button>${op.retry_allowed&&op.request&&Date.parse(op.retry_safe_until)>Date.now()?`<button type="button" data-membership-operation-retry="${esc(op.request_id)}">Retry original request</button>`:''}</section>`).join('');
}
async function refreshMembershipPrice(s,id){
 const current=beginMembershipStatusRead(s);
 const result=await api('/api/v1/billing/membership-prices/'+encodeURIComponent(id));if(!current())return;
 if(result.price?.request_id!==id)throw new Error('The price result did not match the original request.');
 const old=membershipPriceRequests.get(me.tenant_id);
 if(result.price.status==='active'||result.price.provider_price_id)membershipPriceRequests.delete(me.tenant_id);
 else if(old?.request_id===id)membershipPriceRequests.set(me.tenant_id,{...old,retry_allowed:result.retry_allowed===true,deadline:Math.min(old.deadline,Date.parse(result.retry_safe_until))});
 await loadPatientMemberships(s,s.planRequest);
}
async function refreshMembershipOperation(s,id){
 const current=beginMembershipStatusRead(s);
 const result=await api('/api/v1/billing/memberships/'+encodeURIComponent(id));if(!current())return;
 if(result.patient_id!==s.patientId||(result.membership?.request_id||result.request_id)!==id)throw new Error('The result did not match the selected patient and original request.');
 if(result.membership)membershipRequests.set(s.patientId,result.membership);
 await loadPatientMemberships(s,s.planRequest);
}
async function retryMembershipOperation(s,id){
 const op=s.membershipPending?.find(op=>op.request_id===id);
 if(!op?.retry_allowed||!op.request||Date.parse(op.retry_safe_until)<=Date.now())return;
 if(op.kind==='membership'){
  const price=s.membershipPrices?.find(price=>price.id===op.request.price_id),pending={...op,price,input:op.request};membershipRequests.set(s.patientId,pending);await createPatientMembership(s,null,pending);
 }else if(op.kind==='cancel')await cancelPatientMembership(s,null,op);
}
async function cancelPatientMembership(s,id,pending){
 const op=pending?null:s.memberships?.find(item=>item.request_id===id),subscription=pending?.request?.subscription_id||op?.subscription_id;
 if(!subscription||op?.cancel_at_period_end||!billingCan('edit'))return;
 if(pending&&(!pending.retry_allowed||Date.parse(pending.retry_safe_until)<=Date.now()))return;
 if(!await confirmAction(`${op?.price?.name||'This membership'} will end after its paid period. This does not issue an immediate refund.`,{title:'Cancel membership at period end?',confirmLabel:pending?'Retry original cancellation':'Schedule cancellation'}))return;
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||(!pending&&s.memberships?.find(item=>item.request_id===id)!==op)||!billingCan('edit'))return;
 s.membershipRead=(s.membershipRead||0)+1;
 membershipSession();const key=s.patientId+':'+subscription,request=pending?.request_id||membershipCancelRequests.get(key)||crypto.randomUUID();membershipCancelRequests.set(key,request);
 const body={request_id:request,expected_cancel_at_period_end:false};
 try{
  const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/memberships/${encodeURIComponent(subscription)}/cancel-at-period-end`,'POST',body);
  if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
  if(data.patient_id!==s.patientId||data.request_id!==request||data.subscription?.id!==subscription)throw new Error('The cancellation result did not match this membership. Refresh its status.');
  membershipCancelRequests.delete(key);await loadPatientMemberships(s,s.planRequest);
 }catch(error){if(patientBillingCurrent(s)&&s.tab==='subscriptions'){
  const current={request_id:request,kind:'cancel',status:'unknown',retry_allowed:true,retry_safe_until:pending?.retry_safe_until||new Date(Date.now()+23*3600000).toISOString(),request:{...body,subscription_id:subscription}};
  s.membershipPending=[...(s.membershipPending||[]).filter(item=>item.request_id!==request),current];renderPatientMembershipPanel(s);notice(error.message||'The cancellation result is unknown. Check the original request before retrying.',true);
 }}
}

let installmentRequestOwner=null;
const installmentCreateRequests=new Map(),installmentCheckoutRequests=new Map();
function installmentSession(){if(installmentRequestOwner!==me){installmentCreateRequests.clear();installmentCheckoutRequests.clear();installmentRequestOwner=me;}}
function installmentPlanForm(s){
 const eligible=(s.eligibleInvoices||[]).filter(invoice=>invoice.eligible&&invoice.remaining_cents>=100);
 if(!eligible.length)return '<p>No reviewed patient invoice is currently eligible for an installment plan. Review the patient’s responsibility in the encounter before arranging collection.</p>';
 return `<details class="billing-section"><summary>Create a finite encounter payment plan</summary><form id="installment-preview-form" data-patient-plan-draft="installment-preview"><p>This divides the reviewed remaining patient amount. It does not charge a card, change the invoice or authorize automatic payments.</p><label>Reviewed patient invoice<select name="invoice_id" required><option value="">Choose a reviewed invoice</option>${eligible.map(invoice=>`<option value="${esc(invoice.invoice_id)}">Issued ${esc(date(invoice.invoice_created_at))} · ${money(invoice.remaining_cents)} remaining</option>`).join('')}</select></label><div class="form-grid"><label>Number of monthly installments<input name="count" type="number" min="2" max="24" value="2" required></label><label>First due date<input name="first_due" type="date" required></label></div><button type="button" data-installment-divide>Propose schedule</button><div id="installment-proposed-schedule"></div><button type="submit" disabled>Review exact schedule</button></form></details>`;
}
function installmentOperationMarkup(op){
 const url=op.status==='open'?patientBillingCheckoutUrl(op.checkout_url):null;
 return `<section class="mapping-notice"><b>${esc(human(op.status||'Unknown'))} · ${money(op.amount_cents)}</b>${op.livemode===false?' · TEST':''}<p>${op.paid_entry_id?'Verified capture recorded in the patient ledger.':'No patient ledger capture is confirmed.'}${op.captured_at?' Received '+esc(date(op.captured_at))+'.':''}${op.refunded_cents?' Refunded '+money(op.refunded_cents)+'.':''}${op.unapplied_cents?' Unapplied '+money(op.unapplied_cents)+'.':''}</p>${url?`<a class="button primary" href="${esc(url)}" rel="noreferrer" referrerpolicy="no-referrer">Continue secure installment checkout</a>`:''}<button type="button" data-invoice-checkout-review="${esc(op.id)}">Check payment status</button>${op.status==='creating'&&billingCan('create')?`<button type="button" data-installment-checkout-resume="${esc(op.id)}">Resume this checkout request</button>`:''}</section>`;
}
function installmentPlanMarkup(plan,s){
 const writable=billingCan('create')&&s.installmentAvailability?.available;
 return `<article class="billing-section" data-installment-plan="${esc(plan.id)}"><div class="section-head"><h4>Encounter payment plan</h4><span class="pill">${esc(human(plan.status))}${plan.livemode===false?' · TEST':''}</span></div><p>${money(plan.total_cents)} originally arranged · ${money(plan.remaining_cents)} remaining. <b>No automatic payments.</b></p>${plan.blocked_reason?`<p class="mapping-notice">${esc(plan.blocked_reason)}</p>`:''}<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Installment / due</th><th>Scheduled</th><th>Collected / collectible</th><th>Status</th><th></th></tr></thead><tbody>${(plan.installments||[]).map(row=>`<tr><td>${esc(row.number)} · ${esc(row.due_on)}</td><td>${money(row.amount_cents)}</td><td>${money(row.collected_cents)} collected<small>${money(row.collectible_cents)} collectible now</small></td><td>${esc(human(row.status))}</td><td>${installmentCheckoutRequests.has(s.patientId+':'+plan.id+':'+row.number)?`<button type="button" data-installment-local-resume="${esc(plan.id)}" data-installment-number="${esc(row.number)}">Review pending checkout request</button>`:writable&&plan.status==='active'&&!plan.blocked_reason&&row.collectible_cents>=50?`<button type="button" data-installment-collect="${esc(plan.id)}" data-installment-number="${esc(row.number)}">Collect installment</button>`:''}</td></tr>`).join('')}</tbody></table></div>${(plan.attempts||[]).map(installmentOperationMarkup).join('')}</article>`;
}
function renderPatientInstallments(s){
 const host=s.host.querySelector('#patient-billing-installments');if(!host||!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
 capturePatientPaymentPlanDrafts();installmentSession();const pending=installmentCreateRequests.get(s.patientId);
 host.innerHTML=`<div class="section-head"><h3>Encounter payment plans</h3><button type="button" data-installments-refresh>Refresh plans</button></div><p class="muted">Each plan belongs to one reviewed patient invoice. Every installment requires an explicit patient-present collection; nothing charges automatically.</p>${!s.installmentAvailability?.available?`<p class="mapping-notice">${esc(s.installmentAvailability?.reason||'Installment collection is unavailable for the configured account.')}</p>`:''}${(s.installmentPlans||[]).map(plan=>installmentPlanMarkup(plan,s)).join('')||'<p>No finite encounter payment plans are recorded for this patient.</p>'}${pending?`<section class="mapping-notice"><p>The result of the original ${money(pending.total)} plan request is not confirmed. Review or retry this same request before creating another.</p><button type="button" data-installment-create-retry>Retry original plan request</button></section>`:billingCan('create')&&billingCan('edit')&&s.installmentAvailability?.available?installmentPlanForm(s):''}<div id="installment-plan-review"></div><div id="installment-collection"></div>`;
 for(const form of host.querySelectorAll('form[data-patient-plan-draft]'))restorePatientPlanDraft(s,form);
}
async function loadPatientInstallments(s,request){
 const host=s.host.querySelector('#patient-billing-installments');if(!host)return;
 const generation=s.installmentRead=(s.installmentRead||0)+1,current=()=>patientPlansCurrent(s,host,request)&&s.installmentRead===generation;
 try{
  const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans`);
  if(!current())return;
  if(!Array.isArray(data.items)||data.items.some(plan=>plan.patient_id!==s.patientId))throw new Error('The installment plans do not match this patient.');
  s.installmentPlans=data.items;installmentSession();const pending=installmentCreateRequests.get(s.patientId);if(pending&&data.items.some(plan=>plan.request_id===pending.body.request_id))installmentCreateRequests.delete(s.patientId);
  for(const plan of data.items)for(const op of plan.attempts||[]){const key=s.patientId+':'+plan.id+':'+op.installment_number;if(installmentCheckoutRequests.get(key)?.body.request_id===op.request_id)installmentCheckoutRequests.delete(key);}
  s.eligibleInvoices=data.eligible_invoices||[];s.installmentAvailability=data.availability;
  if(s.planTargetId&&!s.installmentPlans.some(plan=>plan.id===s.planTargetId)){
   const detail=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans/${encodeURIComponent(s.planTargetId)}`);
   if(!current())return;
   const plan=detail;if(plan?.id!==s.planTargetId||plan.patient_id!==s.patientId)throw new Error('The returned plan does not match this patient.');s.installmentPlans.unshift(plan);
  }
  renderPatientInstallments(s);
  if(s.planTargetId&&s.planFocused!==s.planTargetId){const chosen=[...host.querySelectorAll('[data-installment-plan]')].find(node=>node.dataset.installmentPlan===s.planTargetId);if(chosen){chosen.scrollIntoView({block:'nearest'});s.planFocused=s.planTargetId;}}
 }catch(error){if(current())host.innerHTML=`<h3>Encounter payment plans</h3><p role="alert">${esc(error.message||'Installment plans are unavailable.')}</p><p>The number of plans is unknown.</p><button type="button" data-installments-refresh>Retry plans</button>`;}
}
async function loadPatientPaymentPlans(s){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!s.patientId)return;
 const request=s.planRequest=(s.planRequest||0)+1;
 await Promise.allSettled([loadPatientMemberships(s,request),loadPatientInstallments(s,request)]);
}
function divideInstallmentSchedule(s,form){
 const invoice=s.eligibleInvoices?.find(item=>item.invoice_id===form.elements.invoice_id.value&&item.eligible);if(!invoice)throw new Error('Choose an eligible reviewed invoice.');
 const rows=proposeInstallmentSchedule(invoice.remaining_cents,Number(form.elements.count.value),form.elements.first_due.value);
 form.querySelector('#installment-proposed-schedule').innerHTML=`<p>${money(invoice.remaining_cents)} divided into ${rows.length} proposed payments. Review or adjust every due date and amount.</p><table class="billing-table"><thead><tr><th>Number</th><th>Due</th><th>USD amount</th></tr></thead><tbody>${installmentScheduleRows(rows)}</tbody></table>`;
 form.querySelector('button[type="submit"]').disabled=false;form.dataset.invoice=invoice.invoice_id;capturePatientPaymentPlanDrafts();
}
async function previewInstallmentPlan(s,form){
 if(!patientBillingCurrent(s)||!billingCan('create')||!billingCan('edit'))return;
 if(form.dataset.invoice!==form.elements.invoice_id.value)throw new Error('Propose the schedule again for the selected invoice.');
 const body={invoice_id:form.elements.invoice_id.value,livemode:s.installmentAvailability.livemode,installments:installmentScheduleValue(form)},host=s.host.querySelector('#installment-plan-review'),request=Symbol();s.installmentPreviewRequest=request;
 const preview=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans/preview`,'POST',body);
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||s.installmentPreviewRequest!==request||s.host.querySelector('#installment-plan-review')!==host)return;
 if(preview.invoice_id!==body.invoice_id||preview.livemode!==body.livemode||!Number.isInteger(preview.account_version))throw new Error('The plan preview did not match this invoice.');
 s.installmentPreview={preview,body};
 host.innerHTML=preview.eligible?`<form id="installment-confirm-form" data-patient-plan-draft="installment-confirm"><h4>Confirm reviewed patient payment schedule</h4><p>Reviewed patient responsibility ${money(preview.responsibility_cents)} · existing patient credit ${money(preview.patient_credit_cents)} · remaining ${money(preview.remaining_cents)}.</p><table class="billing-table"><thead><tr><th>Installment</th><th>Due</th><th>USD amount</th></tr></thead><tbody>${preview.installments.map(row=>`<tr><td>${esc(row.number)}</td><td>${esc(row.due_on)}</td><td>${money(row.amount_cents)}</td></tr>`).join('')}</tbody></table><p><b>No automatic card charges.</b> Each payment will require the patient to be present and an explicit checkout.</p><label>Reason for the arrangement<textarea name="reason" maxlength="1000" required></textarea></label><label class="check"><input type="checkbox" name="consent" required> The patient agrees to this exact finite payment schedule.</label><button type="submit" class="primary">Create agreed plan</button></form>`:`<p role="alert">${esc(preview.blocked_reason||'This invoice is not eligible. Review patient responsibility before arranging payment.')}</p>`;const confirmation=host.querySelector('#installment-confirm-form');if(confirmation)restorePatientPlanDraft(s,confirmation);host.scrollIntoView({block:'nearest'});
}
async function createInstallmentPlan(s,form,retry){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create'))return;installmentSession();
 let operation=retry?installmentCreateRequests.get(s.patientId):null;
 if(!operation){
  if(!s.installmentPreview?.preview.eligible||!form?.elements.consent.checked||!form.elements.reason.value.trim())return;
  const {preview,body}=s.installmentPreview;operation={body:{...body,request_id:crypto.randomUUID(),reason:form.elements.reason.value.trim(),consent:true},version:preview.account_version,total:preview.remaining_cents};installmentCreateRequests.set(s.patientId,operation);
 }
 renderPatientInstallments(s);
 try{
  const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans`,'POST',operation.body,operation.version);
  if(me!==s.identity)return;
  const plan=data;if(plan?.patient_id!==s.patientId||plan.invoice_id!==operation.body.invoice_id||plan.request_id!==operation.body.request_id)throw new Error('The saved plan did not match the reviewed invoice.');
  installmentCreateRequests.delete(s.patientId);patientPlanDrafts.delete(patientPlanDraftKey(s,'installment-preview'));patientPlanDrafts.delete(patientPlanDraftKey(s,'installment-confirm'));
  if(patientBillingCurrent(s)&&s.tab==='subscriptions'){s.planTargetId=plan.id;await loadPatientInstallments(s,s.planRequest);}
 }catch(error){if(patientBillingCurrent(s)&&s.tab==='subscriptions'){renderPatientInstallments(s);const host=s.host.querySelector('#installment-plan-review');host.innerHTML=`<p role="alert">${esc(error.message||'The plan response was not received.')} The original request is retained for explicit retry.</p>`;}}
}
function openInstallmentCollection(s,planId,number,existing){
 const plan=s.installmentPlans?.find(item=>item.id===planId),row=plan?.installments.find(item=>item.number===Number(number));
 if(!plan||!row||!billingCan('create'))return;
 const host=s.host.querySelector('#installment-collection');
 host.innerHTML=`<form id="installment-checkout-form" data-patient-plan-draft="installment-checkout:${esc(plan.id)}:${esc(row.number)}" data-plan="${esc(plan.id)}" data-version="${esc(plan.version)}" data-number="${esc(row.number)}" data-amount="${esc(existing?.amount_cents??row.collectible_cents)}" ${existing?`data-request="${esc(existing.request_id)}"`:''}><h4>${existing?'Resume original':'Collect'} installment ${esc(row.number)}</h4><p>${money(existing?.amount_cents??row.collectible_cents)} · due ${esc(row.due_on)}${plan.livemode===false?' · TEST card payment':''}</p><p>This opens a secure payment page for this installment. It does not authorize future automatic charges.</p><label>Collection reason<input name="reason" maxlength="1000" required autocomplete="off" value="${esc(existing?.reason||'')}" ${existing?'readonly':''}></label><label class="check"><input name="patient_present" type="checkbox" required> The patient is present and agrees to this payment amount.</label><button type="submit" class="primary">${existing?'Resume same checkout request':'Create secure installment checkout'}</button></form>`;const form=host.querySelector('#installment-checkout-form');if(form&&!existing)restorePatientPlanDraft(s,form);host.scrollIntoView({block:'nearest'});host.querySelector('input[name="reason"]')?.focus();
}
async function createInstallmentCheckout(s,form){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create')||!form.elements.patient_present.checked)return;
 installmentSession();const key=s.patientId+':'+form.dataset.plan+':'+form.dataset.number,submitted=patientPlanBaselines.has(form)?patientPlanFormDraft(form):null;
 let saved=installmentCheckoutRequests.get(key);
 if(!saved){saved={body:{request_id:form.dataset.request||crypto.randomUUID(),amount_cents:Number(form.dataset.amount),patient_present:true,reason:form.elements.reason.value.trim()},version:Number(form.dataset.version),plan:form.dataset.plan,number:Number(form.dataset.number),amount:Number(form.dataset.amount)};if(!saved.body.reason||!Number.isSafeInteger(saved.body.amount_cents)||saved.body.amount_cents<50)return;installmentCheckoutRequests.set(key,saved);}
 try{
 const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans/${encodeURIComponent(saved.plan)}/installments/${saved.number}/checkout`,'POST',saved.body,saved.version);
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
 if(data.plan?.patient_id!==s.patientId||data.plan.id!==saved.plan||data.operation?.patient_id!==s.patientId||data.operation.plan_id!==saved.plan||data.operation.request_id!==saved.body.request_id)throw new Error('The checkout result did not match the reviewed payment plan.');
 installmentCheckoutRequests.delete(key);settlePatientPlanDraft(s,form,submitted);const index=s.installmentPlans.findIndex(plan=>plan.id===saved.plan);if(index>=0)s.installmentPlans[index]=data.plan;renderPatientInstallments(s);
 }catch(error){if(patientBillingCurrent(s)&&s.tab==='subscriptions'){openInstallmentCollection(s,saved.plan,saved.number,{request_id:saved.body.request_id,reason:saved.body.reason,amount_cents:saved.amount});s.host.querySelector('#installment-collection').insertAdjacentHTML('afterbegin',`<p role="alert">${esc(error.message||'The checkout response was not received.')} Refresh the plan or explicitly retry this same request. No new request will be created.</p>`);}}
}
async function openPatientMembershipReturn(id){
 if(typeof me==='undefined'||!me)return;
 showTool('Billing & insurance');$('tools').innerHTML='<section id="billing-tool"><div id="membership-return"><p role="status">Checking membership status…</p></div></section>';
 const identity=me,host=$('membership-return'),current=()=>identity===me&&$('membership-return')===host&&!$('tools').hidden;
 try{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))throw new Error('The membership return link is invalid.');
  const data=await api('/api/v1/billing/memberships/'+encodeURIComponent(id));if(!current())return;
  if(data.membership?.request_id!==id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.patient_id||''))throw new Error('This membership result could not be verified.');
  membershipSession();membershipRequests.set(data.patient_id,data.membership);
  if(typeof clearPatientMembershipSignInReturn==='function')clearPatientMembershipSignInReturn();
  await showPatientBillingWorkspace({patientId:data.patient_id,tab:'subscriptions'});
 }catch(error){if(current())host.innerHTML=`<h2>Membership result unavailable</h2><p role="alert">${esc(error.message||'This result is unavailable with your current access.')}</p><p>Returning here did not start or charge a membership.</p><button type="button" data-membership-return-retry="${esc(id||'')}">Check again</button>`;}
}
async function openInvoiceCheckoutReturn(id){
 if(typeof me==='undefined'||!me)return;
 showTool('Billing & insurance');$('tools').innerHTML='<section id="billing-tool"><div id="invoice-checkout-return"><p role="status">Checking installment payment…</p></div></section>';
 const identity=me,host=$('invoice-checkout-return'),current=()=>identity===me&&$('invoice-checkout-return')===host&&!$('tools').hidden;
 try{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))throw new Error('The installment payment link is invalid.');
  let data=await api('/api/v1/billing/invoice-checkouts/'+encodeURIComponent(id));if(!current())return;
  const original=data.operation;if(original?.id!==id||!original.patient_id||!original.plan_id)throw new Error('This payment result could not be verified.');
  let refreshError=null;
  if(billingCan('edit'))try{
   const fresh=await api('/api/v1/billing/invoice-checkouts/'+encodeURIComponent(id)+'/refresh','POST',{});if(!current())return;
   if(fresh.operation?.id!==id||fresh.operation.patient_id!==original.patient_id||fresh.operation.plan_id!==original.plan_id)throw new Error('Payment verification did not match the original operation.');data=fresh;
  }catch(error){if(!current())return;refreshError='Current provider status could not be refreshed. The saved status remains available; do not collect again while it is uncertain.';}
  if(typeof clearInvoiceCheckoutSignInReturn==='function')clearInvoiceCheckoutSignInReturn();
  const s=await showPatientBillingWorkspace({patientId:data.operation.patient_id,tab:'subscriptions',planId:data.operation.plan_id});
  if(patientBillingCurrent(s)&&refreshError)notice(refreshError,true);
 }catch(error){if(current())host.innerHTML=`<h2>Installment payment result unavailable</h2><p role="alert">${esc(error.message||'This payment could not be loaded with your current access.')}</p><p>No new checkout was created by returning here.</p><button type="button" data-invoice-checkout-review="${esc(id||'')}">Check again</button>`;}
}
document.addEventListener('submit',event=>{
 const form=event.target;if(!['membership-price-form','patient-membership-form','installment-preview-form','installment-confirm-form','installment-checkout-form'].includes(form.id))return;
 event.preventDefault();const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||form.closest('.patient-billing-hub')!==s.host)return;
 run(()=>form.id==='membership-price-form'?approveMembershipPrice(s,form):form.id==='patient-membership-form'?createPatientMembership(s,form):form.id==='installment-preview-form'?previewInstallmentPlan(s,form):form.id==='installment-confirm-form'?createInstallmentPlan(s,form,false):createInstallmentCheckout(s,form));
});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;const d=button.dataset;
 if(d.membershipReturnRetry){run(()=>openPatientMembershipReturn(d.membershipReturnRetry));return;}
 if(d.invoiceCheckoutReview){run(()=>openInvoiceCheckoutReturn(d.invoiceCheckoutReview));return;}
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||button.closest('.patient-billing-hub')!==s.host)return;
 if(button.hasAttribute('data-memberships-refresh'))run(()=>loadPatientMemberships(s,s.planRequest));
 else if(d.membershipRefresh)run(()=>refreshPatientMembership(s,d.membershipRefresh));
 else if(d.membershipRetry){const op=membershipCurrentRequest(s)?.request_id===d.membershipRetry?membershipCurrentRequest(s):s.memberships?.find(item=>item.request_id===d.membershipRetry);if(op){membershipRequests.set(s.patientId,op);run(()=>createPatientMembership(s,null,op));}}
 else if(d.membershipPriceCheck)run(()=>refreshMembershipPrice(s,d.membershipPriceCheck));
 else if(d.membershipOperationCheck)run(()=>refreshMembershipOperation(s,d.membershipOperationCheck));
 else if(d.membershipOperationRetry)run(()=>retryMembershipOperation(s,d.membershipOperationRetry));
 else if(button.hasAttribute('data-membership-price-retry'))run(()=>approveMembershipPrice(s,null));
 else if(d.membershipCancel)run(()=>cancelPatientMembership(s,d.membershipCancel));
 else if(d.membershipPricesNext)run(()=>loadMoreMembershipPrices(s,d.membershipPricesNext));
 else if(d.membershipsNext||button.hasAttribute('data-memberships-first')){s.membershipsAfter=d.membershipsNext||null;run(()=>loadPatientMemberships(s,s.planRequest));}
 else if(button.hasAttribute('data-installments-refresh'))run(()=>loadPatientInstallments(s,s.planRequest));
 else if(button.hasAttribute('data-installment-divide')){try{divideInstallmentSchedule(s,button.closest('form'));}catch(error){notice(error.message,true);}}
 else if(button.hasAttribute('data-installment-create-retry'))run(()=>createInstallmentPlan(s,null,true));
 else if(d.installmentLocalResume){const saved=installmentCheckoutRequests.get(s.patientId+':'+d.installmentLocalResume+':'+d.installmentNumber);if(saved)openInstallmentCollection(s,saved.plan,saved.number,{request_id:saved.body.request_id,reason:saved.body.reason,amount_cents:saved.amount});}
 else if(d.installmentCollect)openInstallmentCollection(s,d.installmentCollect,Number(d.installmentNumber));
 else if(d.installmentCheckoutResume){const plan=s.installmentPlans?.find(plan=>plan.attempts.some(op=>op.id===d.installmentCheckoutResume)),op=plan?.attempts.find(op=>op.id===d.installmentCheckoutResume);if(op)openInstallmentCollection(s,plan.id,op.installment_number,op);}
});
