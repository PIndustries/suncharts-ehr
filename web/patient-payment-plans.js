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
// Forms of this tab live either in the page or in the sheet that "Start membership" / "Start payment plan" opens.
function patientPlanForms(s){
 const sheet=s.plansSheet?.isConnected!==false?s.plansSheet:null;
 return [...s.host.querySelectorAll('form[data-patient-plan-draft]'),...(sheet?sheet.querySelectorAll('form[data-patient-plan-draft]'):[])];
}
function patientPlanInScope(s,node){
 if(!node?.closest)return false;
 return node.closest('.patient-billing-hub')===s.host||(!!s.plansSheet&&s.plansSheet.isConnected!==false&&node.closest('dialog')===s.plansSheet);
}
function closePlansSheet(s){if(s?.plansSheet){const sheet=s.plansSheet;s.plansSheet=null;if(typeof sheetClose==='function')sheetClose(sheet);}}
// Where the schedule review and its errors show: in the sheet while it is open, else on the page.
function planReviewHost(s){
 const sheet=s.plansSheet?.isConnected!==false?s.plansSheet:null;
 return (sheet&&sheet.querySelector('#installment-plan-review'))||s.host.querySelector('#installment-plan-review');
}
// A toast would sit behind an open sheet, so a failure inside the sheet is written into the sheet.
function planSheetRun(s,node,fn){
 const sheet=s.plansSheet&&s.plansSheet.isConnected!==false&&node?.closest&&node.closest('dialog')===s.plansSheet?s.plansSheet:null;
 if(!sheet){run(fn);return;}
 const show=message=>{const body=sheet.querySelector('.sheet-body')||sheet;let alert=body.querySelector('[data-sheet-error]');if(!alert){alert=document.createElement('p');alert.setAttribute('role','alert');alert.setAttribute('data-sheet-error','');body.prepend(alert);}alert.textContent=message;};
 Promise.resolve().then(fn).then(()=>{sheet.querySelector('[data-sheet-error]')?.remove();},error=>show(error?.message||'That did not work. Try again.'));
}
function capturePatientPaymentPlanDrafts(){
 patientPlanDraftSession();const s=patientBillingWorkspace;if(!patientBillingCurrent(s))return;
 for(const form of patientPlanForms(s)){
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
  form.querySelector('#installment-proposed-schedule').innerHTML=`<p class="mapping-notice">Your unsaved schedule is retained. Preview it again against the current invoice before agreeing to a plan.</p><table class="billing-table"><tbody>${record.schedule.map((row,index)=>`<tr data-installment-row><td>${index+1}</td><td><input aria-label="Installment ${index+1} due date" name="due_on" type="date" ${installmentDueDateAttributes()} value="${esc(row.due_on)}" required></td><td><input aria-label="Installment ${index+1} amount in USD" name="amount" inputmode="decimal" value="${esc(row.amount)}" required></td></tr>`).join('')}</tbody></table>`;
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
 return `<section class="mapping-notice"><h4>A membership price is waiting to be confirmed</h4>${pending.body?`<p>${esc(pending.body.name)} · ${esc(membershipCadence(pending.body))}. Trying again uses these same terms.</p>`:'<p>The practice owner who added this price needs to check it.</p>'}${pending.error?`<p role="status">${esc(pending.error)}</p>`:''}<button type="button" data-membership-price-check="${esc(pending.request_id)}">Check this price</button>${retry?'<button type="button" data-membership-price-retry>Try again</button>':'<p>Adding another price is paused until this one is confirmed.</p>'}</section>`;
}

function membershipPriceForm(){return `<form id="membership-price-form"><p>This price applies to the whole practice. It does not start a membership or charge anyone. An approved price cannot be changed; add a new one instead.</p><div class="form-grid"><label>Name<input name="name" maxlength="100" required autocomplete="off" placeholder="Monthly membership"></label><label>Price (USD)<input name="amount" inputmode="decimal" required placeholder="50.00"></label><label>Every<input name="interval_count" type="number" min="1" max="12" value="1" required></label><label>Interval<select name="interval"><option value="month">Month</option><option value="year">Year</option><option value="week">Week</option><option value="day">Day</option></select></label></div><label>Reason for approving this price<textarea name="approval_reason" maxlength="500" required></textarea></label><label class="check"><input name="approved" type="checkbox" required> I approve this price and how often it is charged.</label><div class="actions"><button type="submit" class="primary">Approve price</button></div></form>`;}
// Why a membership cannot be started right now, with the button that fixes it. `form:true` means it can.
function membershipEnrolment(s){
 const paymentsFix=me?.role==='owner'?'<button type="button" data-payment-settings>Set up card payments</button>':'<small class="muted">Ask the practice owner to set up card payments.</small>';
 if(s.membershipCatalogError)return {text:s.membershipCatalogError+' Memberships already started stay listed above.',fix:'<button type="button" data-memberships-refresh>Try again</button>'};
 if(!Array.isArray(s.membershipPrices))return {text:'Membership prices have not loaded yet.',fix:'<button type="button" data-memberships-refresh>Check again</button>'};
 if(!s.membershipAvailable)return {text:'Card payments are not set up yet, so a membership cannot be started.',fix:paymentsFix};
 const activePrices=s.membershipPrices.filter(price=>price.status==='active');
 const prices=activePrices.filter(price=>!(s.memberships||[]).some(op=>op.price?.id===price.id&&!['expired','canceled'].includes(op.status)));
 if(!prices.length&&s.membershipPricesNext)return {text:'No other membership prices are in the results loaded so far.',fix:`<button type="button" data-membership-prices-next="${esc(s.membershipPricesNext)}">Load more prices</button>`};
 if(!prices.length&&activePrices.length)return {text:'This patient already has every membership the practice offers.',fix:''};
 if(!prices.length)return {text:'No membership prices have been added yet.',fix:me?.role==='owner'?'<button type="button" data-open-membership-prices>Add a membership price</button>':'<small class="muted">Ask the practice owner to add a membership price.</small>'};
 return {form:true,prices};
}
function membershipSelectionForm(s){
 const state=membershipEnrolment(s);
 if(!state.form)return `<p class="muted" role="status">${esc(state.text)}</p>${state.fix}`;
 const prices=state.prices;
 return `<form id="patient-membership-form" data-patient-plan-draft="membership"><label>Membership price<select name="price_id" required><option value="">Choose a price</option>${prices.map(price=>`<option value="${esc(price.id)}">${esc(price.name)} · ${esc(membershipCadence(price))}</option>`).join('')}</select></label><div id="patient-membership-terms"><p>Choose a price to see the amount and how often it is charged.</p></div><label class="check"><input name="consent" type="checkbox" required> The patient has agreed to this recurring price and schedule. They will separately authorize recurring charges on the secure page.</label><div class="actions"><button type="submit" class="primary">Continue to secure card page</button></div></form>`;
}
function patientMembershipTerms(s,form){
 const price=(s.membershipPrices||[]).find(price=>price.id===form.elements.price_id.value&&price.status==='active'),host=form.querySelector('#patient-membership-terms');if(!host)return;
 host.innerHTML=price?`<section class="mapping-notice"><b>${esc(price.name)}</b><p>${esc(membershipCadence(price))}. Billing continues until canceled. Cancellation is scheduled for the end of the paid period; it does not issue an immediate refund.</p><p>Only the secure checkout can start this membership. Saving a card alone does not enroll the patient.</p></section>`:'<p>Choose a price to see the amount and how often it is charged.</p>';
}
function installmentDueDateBounds(){
 const earliest=new Date().toISOString().slice(0,10);
 return {earliest,latest:new Date(Date.parse(earliest+'T00:00:00Z')+1826*86400000).toISOString().slice(0,10)};
}
function installmentDueDateAttributes(){const dates=installmentDueDateBounds();return `min="${dates.earliest}" max="${dates.latest}"`;}
function validateInstallmentDueDates(rows){
 const dates=installmentDueDateBounds();
 for(const [index,row] of rows.entries()){
  if(row.due_on<dates.earliest)throw new Error(`Installment ${index+1} must be due on or after ${dates.earliest}. Payment plans use today in UTC, which may be tomorrow in your local time.`);
  if(row.due_on>dates.latest)throw new Error(`Installment ${index+1} must be due on or before ${dates.latest}, within the five-year scheduling limit.`);
 }
}
function installmentScheduleRows(rows){return rows.map((row,index)=>`<tr data-installment-row><td>${index+1}</td><td><input aria-label="Installment ${index+1} due date" name="due_on" type="date" ${installmentDueDateAttributes()} value="${esc(row.due_on)}" required></td><td><input aria-label="Installment ${index+1} amount in USD" name="amount" inputmode="decimal" value="${esc(dollars(row.amount_cents))}" required></td></tr>`).join('');}
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
document.addEventListener('input',event=>{const form=event.target.closest?.('form[data-patient-plan-draft]');if(!form)return;const s=patientBillingWorkspace;if(patientBillingCurrent(s)&&patientPlanInScope(s,form)){if(form.id==='installment-preview-form'){s.installmentPreview=null;s.installmentPreviewRequest=null;planReviewHost(s)?.replaceChildren();}capturePatientPaymentPlanDrafts();}});
document.addEventListener('change',event=>{
 const form=event.target.closest?.('form[data-patient-plan-draft]');if(!form)return;
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||!patientPlanInScope(s,form))return;
 if(form.id==='patient-membership-form'&&event.target.name==='price_id'){form.elements.consent.checked=false;patientMembershipTerms(s,form);}
 if(form.id==='installment-preview-form'){s.installmentPreview=null;s.installmentPreviewRequest=null;const review=planReviewHost(s);if(review)review.replaceChildren();if(['invoice_id','count','first_due'].includes(event.target.name)){form.querySelector('#installment-proposed-schedule').replaceChildren();form.querySelector('button[type="submit"]').disabled=true;}}
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
// Plain words for where a membership stands.
function membershipStatusWords(op){
 const subscription={active:'Active',trialing:'Active',past_due:'Payment overdue',unpaid:'Payment overdue',canceled:'Cancelled',incomplete:'Waiting for the card page',incomplete_expired:'Card page expired',paused:'Paused'};
 const request={creating:'Getting the card page ready',open:'Waiting for the patient on the card page',pending:'Checking the payment',active:'Active',canceled:'Cancelled',expired:'Card page expired',needs_review:'Needs a check',unknown:'Result not confirmed'};
 return subscription[op.subscription_status]||request[op.status]||'Status not available';
}
function patientMembershipRows(s){
 return (s.memberships||[]).map(op=>{
  const ending=op.cancel_at_period_end,live=['active','trialing'].includes(op.subscription_status)||(!op.subscription_status&&op.status==='active');
  const when=op.current_period_end?(ending?`Ends ${esc(patientBillingProviderDate(op.current_period_end))}`:live?`Next charge ${esc(patientBillingProviderDate(op.current_period_end))}`:''):'';
  return `<article class="patient-billing-card"><h4>${esc(op.price?.name||'Practice membership')}</h4><p>${op.price?esc(membershipCadence(op.price)):'Price not available'}</p><p>${esc(membershipStatusWords(op))}${ending?' · will end at the end of the paid period':''}</p>${when?`<small>${when}</small>`:''}${['creating','open','pending','needs_review'].includes(op.status)?membershipRequestMarkup(op):''}${op.cancellation_available===true&&op.subscription_id&&!op.cancel_at_period_end&&!['canceled','incomplete_expired'].includes(op.subscription_status)&&billingCan('edit')&&!s.membershipPending?.some(p=>p.kind==='cancel')?`<button type="button" data-membership-cancel="${esc(op.request_id)}">Cancel at period end</button>`:''}</article>`;
 }).join('')||'<p>This patient has no memberships yet.</p>';
}
function renderPatientMembershipPanel(s){
 const host=s.host.querySelector('#patient-billing-memberships');if(!host||!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
 capturePatientPaymentPlanDrafts();
 const local=membershipCurrentRequest(s),listed=local&&(s.memberships||[]).some(op=>op.request_id===local.request_id),pending=(s.memberships||[]).some(op=>['creating','open','pending','needs_review'].includes(op.status))||(s.membershipPending||[]).some(op=>op.kind==='membership');
 const blocked=local&&!['active','canceled','expired'].includes(local.status)||pending;
 let start='',note='';
 if(!billingCan('create'))note='<p class="muted">Your role can view memberships. Starting one needs billing access.</p>';
 else if(blocked)note='<p class="muted">Finish the membership request above before starting another.</p>';
 else{const state=membershipEnrolment(s);if(state.form)start='<button type="button" class="primary" data-start-membership>Start membership</button>';else note=`<p class="muted" role="status">${esc(state.text)}</p>${state.fix?`<p>${state.fix}</p>`:''}`;}
 host.innerHTML=`<div class="section-head"><h3>Memberships</h3>${start}</div>${s.membershipLive===false&&planTestTag()?`<p class="copay-mode-label">${planTestTag()}</p>`:''}<div class="patient-billing-cards">${patientMembershipRows(s)}</div>${local&&!listed?membershipRequestMarkup(local):''}${patientMembershipPendingMarkup(s)}${s.membershipsAfter?'<button type="button" data-memberships-first>First memberships page</button>':''}${s.membershipsNext?`<button type="button" data-memberships-next="${esc(s.membershipsNext)}">Next memberships</button>`:''}${note}`;
}
// "Start membership" opens the enrolment form in a sheet over the page.
function openStartMembershipSheet(s){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create')||typeof sheetOpen!=='function')return null;
 if(!membershipEnrolment(s).form)return null;
 closePlansSheet(s);
 const holder=document.createElement('div');holder.innerHTML=membershipSelectionForm(s);
 s.plansSheet=sheetOpen('Start membership',holder);
 const form=holder.querySelector('#patient-membership-form');if(form){restorePatientPlanDraft(s,form);patientMembershipTerms(s,form);}
 return s.plansSheet;
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
  try{const prices=await api('/api/v1/billing/membership-prices');if(!current())return;if(!Array.isArray(prices.items))throw new Error('Approved membership prices could not be verified.');s.membershipPrices=prices.items;s.membershipPricesNext=prices.next_cursor||null;s.catalogCreationAvailable=prices.creation_available===true;s.membershipCatalogError=null;s.pricePending=prices.pending_operations||[];const pendingPrice=s.pricePending.find(op=>op.kind==='price');if(pendingPrice)membershipPriceRequests.set(me.tenant_id,{request_id:pendingPrice.request_id,body:pendingPrice.request,deadline:Date.parse(pendingPrice.retry_safe_until),retry_allowed:pendingPrice.retry_allowed===true});}catch(error){if(!current())return;s.membershipPrices=[];s.catalogCreationAvailable=false;s.membershipCatalogError=error.message||'Approved prices could not be loaded.';}
  renderPatientMembershipPanel(s);
  const external=s.host.querySelector('#patient-billing-profile-section');if(external&&s.profile)external.innerHTML=patientBillingProfileMarkup(s.profile,'subscriptions',s);
 }catch(error){if(current())host.innerHTML=`<h3>Memberships</h3><p role="alert">${esc(error.message||'Membership records are unavailable.')}</p><p>The number of memberships is unknown.</p><button type="button" data-memberships-refresh>Retry memberships</button>`;}
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
function patientMembershipPendingMarkup(s){
 return (s.membershipPending||[]).filter(op=>op.kind==='cancel'||(op.kind==='membership'&&!(s.memberships||[]).some(item=>item.request_id===op.request_id)&&membershipCurrentRequest(s)?.request_id!==op.request_id)).map(op=>`<section class="mapping-notice"><h4>${op.kind==='cancel'?'Pending cancellation':'Pending enrollment request'}</h4><p>${esc(human(op.status))}. Review the original request; a new request is not needed.</p><button type="button" data-membership-operation-check="${esc(op.request_id)}">Check original request</button>${op.retry_allowed&&op.request&&Date.parse(op.retry_safe_until)>Date.now()?`<button type="button" data-membership-operation-retry="${esc(op.request_id)}">Retry original request</button>`:''}</section>`).join('');
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
 if(!subscription||(!pending&&op?.cancellation_available!==true)||op?.cancel_at_period_end||!billingCan('edit'))return;
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

// ---- Practice administration > Memberships: the practice's membership prices -------------------
// A price belongs to the whole practice, so it is added here and not from a patient. When the
// server can retire a price, add a "Retire" button to each row of membershipPriceRows below.
let membershipAdmin=null;
function membershipAdminState(){
 membershipSession();
 if(!membershipAdmin||membershipAdmin.owner!==me)membershipAdmin={owner:me,prices:null,next:null,available:false,error:null,generation:0,sheet:null};
 return membershipAdmin;
}
// Practice administration asks for these two when it draws its tabs.
function practiceAdminExtraTabs(active){return `<button type="button" data-admin-tab="memberships" aria-pressed="${active==='memberships'}">Memberships</button>`;}
function practiceAdminExtraRender(tab,target){if(tab!=='memberships')return false;renderMembershipPricesAdmin(target);return true;}
function membershipEvery(price){return price.interval_count===1?`Every ${price.interval}`:`Every ${price.interval_count} ${price.interval}s`;}
function membershipPriceRows(items){
 return items.map(price=>`<tr><td><strong>${esc(price.name)}</strong></td><td>${esc(patientBillingAmount(price.amount_cents,price.currency))}</td><td>${esc(membershipEvery(price))}</td><td>${esc(price.status==='active'?'Active':human(price.status||'unknown'))}</td></tr>`).join('');
}
function membershipPricesAdminMarkup(st){
 const owner=me?.role==='owner',pending=membershipPriceRequests.get(me?.tenant_id);
 const action=owner&&!pending&&!st.error&&st.available&&billingCan('create')?'<button type="button" class="primary" data-membership-price-new>Add membership price</button>':'';
 const unavailable=owner&&st.prices&&!st.available&&!st.error?'<p class="muted">Card payments must be set up before a membership price can be added.</p><p><button type="button" data-payment-settings>Set up card payments</button></p>':'';
 const body=st.error?`<p role="alert">${esc(st.error)}</p><button type="button" data-membership-prices-reload>Try again</button>`:!st.prices?'<p role="status">Loading membership prices…</p>':`<div class="practice-table-wrap"><table class="practice-table"><caption class="sr-only">Membership prices</caption><thead><tr><th scope="col">Name</th><th scope="col">Price</th><th scope="col">How often</th><th scope="col">Status</th></tr></thead><tbody>${membershipPriceRows(st.prices)||'<tr><td colspan="4">No membership prices yet.</td></tr>'}</tbody></table></div>${st.next?`<button type="button" data-membership-prices-admin-next="${esc(st.next)}">Load more prices</button>`:''}`;
 return `<div class="section-head"><div><h3>Membership prices</h3><p class="muted">A membership price is a fixed amount charged on a schedule. Patients are enrolled from their own billing page.</p></div>${action}</div>${pending&&owner?membershipPricePendingMarkup(pending):''}${unavailable}${body}`;
}
function paintMembershipPricesAdmin(target){
 const st=membershipAdminState(),host=target.querySelector?.('#membership-prices-admin')||(typeof $==='function'?$('membership-prices-admin'):null);
 if(host)host.innerHTML=membershipPricesAdminMarkup(st);
}
function renderMembershipPricesAdmin(target){
 const st=membershipAdminState();
 target.innerHTML=`<div class="section-head"><div><h2>Practice administration</h2><p class="muted">Staff, providers, locations and billing setup for the practice.</p></div><button type="button" data-admin-refresh>Refresh directory</button></div>${typeof adminTabs==='function'?adminTabs('memberships'):''}<section id="membership-prices-admin" class="panel">${membershipPricesAdminMarkup(st)}</section>`;
 void loadMembershipPrices(target,null);
}
async function loadMembershipPrices(target,cursor){
 const st=membershipAdminState(),generation=++st.generation,identity=me;
 const current=()=>me===identity&&membershipAdmin===st&&st.generation===generation&&(typeof practiceAdminState==='undefined'||practiceAdminState?.tab==='memberships');
 try{
  const data=await api('/api/v1/billing/membership-prices'+(cursor?'?after='+encodeURIComponent(cursor):''));
  if(!current())return;
  if(!Array.isArray(data.items))throw new Error('Membership prices could not be loaded.');
  const known=new Set(cursor?(st.prices||[]).map(price=>price.id):[]);
  st.prices=cursor?[...(st.prices||[]),...data.items.filter(price=>!known.has(price.id))]:data.items;st.next=data.next_cursor||null;st.available=data.creation_available===true;st.error=null;
  const pendingPrice=(data.pending_operations||[]).find(op=>op.kind==='price');
  if(pendingPrice)membershipPriceRequests.set(me.tenant_id,{request_id:pendingPrice.request_id,body:pendingPrice.request,deadline:Date.parse(pendingPrice.retry_safe_until),retry_allowed:pendingPrice.retry_allowed===true});
 }catch(error){if(!current())return;st.error=error.message||'Membership prices could not be loaded.';}
 paintMembershipPricesAdmin(target);
}
function openMembershipPriceSheet(){
 const st=membershipAdminState();
 if(me?.role!=='owner'||!st.available||!billingCan('create')||typeof sheetOpen!=='function')return null;
 if(st.sheet?.isConnected)return st.sheet;
 const holder=document.createElement('div');holder.innerHTML=membershipPriceForm();
 st.sheet=sheetOpen('Add membership price',holder);return st.sheet;
}
async function approveMembershipPrice(form){
 const st=membershipAdminState(),identity=me;
 if(me?.role!=='owner'||!billingCan('create')||!st.available||form&&!form.elements.approved.checked)return;
 const old=membershipPriceRequests.get(me.tenant_id);if(!form&&!old)return;
 const body=old?.body||{request_id:crypto.randomUUID(),name:form.elements.name.value.trim(),amount_cents:cents(form.elements.amount.value),currency:'usd',interval:form.elements.interval.value,interval_count:Number(form.elements.interval_count.value),approved:true,approval_reason:form.elements.approval_reason.value.trim()};
 if(!body.name||!body.approval_reason||body.amount_cents<50||body.amount_cents>100000000||!Number.isInteger(body.interval_count)||body.interval_count<1||body.interval_count>({day:365,week:52,month:12,year:1}[body.interval]||0))throw new Error('Check the price, how often it is charged and the reason.');
 if(old&&(!old.body||!old.retry_allowed||Date.now()>=old.deadline))throw new Error('This price needs to be checked first. Choose Check this price; do not add a second one.');
 membershipPriceRequests.set(me.tenant_id,{request_id:body.request_id,body,deadline:old?.deadline||Date.now()+23*3600000,retry_allowed:true});
 if(st.sheet){const sheet=st.sheet;st.sheet=null;if(typeof sheetClose==='function')sheetClose(sheet);}
 const target=typeof $==='function'?$('practice-admin-panel'):null;if(target)paintMembershipPricesAdmin(target);
 try{
  const result=await api('/api/v1/billing/membership-prices','POST',body);
  if(me!==identity)return;if(result.price?.request_id!==body.request_id)throw new Error('The answer did not match this price. Check it before trying again.');
  if(result.price.status==='active'||result.price.provider_price_id)membershipPriceRequests.delete(me.tenant_id);
  const panel=typeof $==='function'?$('practice-admin-panel'):null;if(panel&&membershipAdmin===st)await loadMembershipPrices(panel,null);
 }catch(error){if(me===identity){const pending=membershipPriceRequests.get(me.tenant_id);if(pending)pending.error=error.message||'The result is not known yet. Check this price.';const panel=typeof $==='function'?$('practice-admin-panel'):null;if(panel&&membershipAdmin===st)paintMembershipPricesAdmin(panel);}}
}
async function checkMembershipPrice(id){
 const st=membershipAdminState(),identity=me;
 const result=await api('/api/v1/billing/membership-prices/'+encodeURIComponent(id));if(me!==identity)return;
 if(result.price?.request_id!==id)throw new Error('The answer did not match the original price.');
 const old=membershipPriceRequests.get(me.tenant_id);
 if(result.price.status==='active'||result.price.provider_price_id)membershipPriceRequests.delete(me.tenant_id);
 else if(old?.request_id===id)membershipPriceRequests.set(me.tenant_id,{...old,retry_allowed:result.retry_allowed===true,deadline:Math.min(old.deadline,Date.parse(result.retry_safe_until))});
 const panel=typeof $==='function'?$('practice-admin-panel'):null;if(panel&&membershipAdmin===st)await loadMembershipPrices(panel,null);
}
if(typeof document!=='undefined'){
 document.addEventListener('click',event=>{
  const button=event.target?.closest?.('button');if(!button)return;
  if(button.hasAttribute('data-membership-price-new')){event.preventDefault();openMembershipPriceSheet();return;}
  const panel=button.closest('#practice-admin-panel');if(!panel)return;
  if(button.dataset.membershipPriceCheck)run(()=>checkMembershipPrice(button.dataset.membershipPriceCheck));
  else if(button.hasAttribute('data-membership-price-retry'))run(()=>approveMembershipPrice(null));
  else if(button.hasAttribute('data-membership-prices-reload'))run(()=>loadMembershipPrices(panel,null));
  else if(button.dataset.membershipPricesAdminNext)run(()=>loadMembershipPrices(panel,button.dataset.membershipPricesAdminNext));
 });
 document.addEventListener('input',event=>{const form=event.target?.closest?.('#membership-price-form');if(form&&event.target.name!=='approved')form.elements.approved.checked=false;});
 document.addEventListener('change',event=>{const form=event.target?.closest?.('#membership-price-form');if(form&&event.target.name==='interval')form.elements.interval_count.max=String({day:365,week:52,month:12,year:1}[event.target.value]);});
 document.addEventListener('submit',event=>{
  const form=event.target;if(form?.id!=='membership-price-form')return;
  event.preventDefault();const sheet=form.closest('dialog');
  const show=message=>{const body=sheet?.querySelector('.sheet-body');if(!body)return;let alert=body.querySelector('[data-sheet-error]');if(!alert){alert=document.createElement('p');alert.setAttribute('role','alert');alert.setAttribute('data-sheet-error','');body.prepend(alert);}alert.textContent=message;};
  Promise.resolve().then(()=>approveMembershipPrice(form)).catch(error=>show(error?.message||'The price was not added. Try again.'));
 });
}

let installmentRequestOwner=null;
const installmentCreateRequests=new Map(),installmentCheckoutRequests=new Map();
function installmentSession(){if(installmentRequestOwner!==me){installmentCreateRequests.clear();installmentCheckoutRequests.clear();installmentRequestOwner=me;}}
function installmentEligibleInvoices(s){return (s.eligibleInvoices||[]).filter(invoice=>invoice.eligible&&invoice.remaining_cents>=100);}
// The plan form, or one line saying why there is none (with the button that leads on).
function installmentPlanForm(s){
 const eligible=installmentEligibleInvoices(s);
 if(!eligible.length&&s.eligibleInvoices?.length&&s.eligibleInvoices.every(invoice=>invoice.existing_plan_id&&s.installmentPlans?.some(plan=>plan.id===invoice.existing_plan_id)))return '<p class="muted">Every billed statement already has a payment plan.</p>';
 if(!eligible.length&&s.installmentPlans?.length)return '<p class="muted">No other billed statement is waiting for a payment plan.</p>';
 if(!eligible.length)return '<p class="muted">A payment plan is made from a statement for an encounter that has been billed.</p><p><button type="button" data-hub-tab="overview">Go to billing</button></p>';
 return `<form id="installment-preview-form" data-patient-plan-draft="installment-preview"><p>This splits what is left on a billed statement into dated payments. It does not charge a card, change the statement or start automatic payments.</p><label>Statement<select name="invoice_id" required><option value="">Choose a statement</option>${eligible.map(invoice=>`<option value="${esc(invoice.invoice_id)}">Issued ${esc(date(invoice.invoice_created_at))} · ${money(invoice.remaining_cents)} remaining</option>`).join('')}</select></label><div class="form-grid"><label>Number of monthly payments<input name="count" type="number" min="2" max="24" value="2" required></label><label>First due date<input name="first_due" type="date" ${installmentDueDateAttributes()} aria-describedby="installment-date-guidance" required></label></div><p id="installment-date-guidance">Earliest due date: ${installmentDueDateBounds().earliest} (today in UTC). This may be tomorrow in your local time. All payments must be due by ${installmentDueDateBounds().latest}.</p><div class="actions"><button type="button" data-installment-divide>Propose schedule</button></div><div id="installment-proposed-schedule"></div><div class="actions"><button type="submit" disabled>Review schedule</button></div></form>`;
}
// "Start payment plan" opens the plan steps in a sheet over the page.
function openStartPaymentPlanSheet(s){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create')||!billingCan('edit')||!s.installmentAvailability?.available||!installmentEligibleInvoices(s).length||typeof sheetOpen!=='function')return null;
 closePlansSheet(s);
 const holder=document.createElement('div');holder.innerHTML=installmentPlanForm(s)+'<div id="installment-plan-review"></div>';
 s.plansSheet=sheetOpen('Start payment plan',holder);
 const form=holder.querySelector('#installment-preview-form');if(form)restorePatientPlanDraft(s,form);
 return s.plansSheet;
}
// The label shown on a test payment. A production build shows nothing.
function planTestTag(){return typeof testPaymentLabel==='function'?testPaymentLabel():'';}
function installmentOperationMarkup(op){
 const url=op.status==='open'?patientBillingCheckoutUrl(op.checkout_url):null,onReader=op.channel==='reader'&&typeof readerPaymentLabel==='function',onSavedCard=op.channel==='saved_card'&&typeof savedCardPaymentLabel==='function',test=op.livemode===false&&planTestTag()?' · '+planTestTag():'';
 if(onSavedCard&&!['paid','refunded'].includes(op.status)){const state=savedCardPaymentState(op);return `<section class="mapping-notice"><b>${esc(state.text)} · ${money(op.amount_cents)}</b>${test}<p>Card on file. ${state.key==='charging'?'The bank has not answered yet.':'Nothing has been recorded for this payment.'}</p>${state.final&&state.key!=='review'?'':`<button type="button" data-invoice-checkout-review="${esc(op.id)}">Check payment status</button>`}</section>`;}
 const openLink=op.channel==='hosted'&&['creating','open'].includes(op.status),label=op.status==='expired'&&op.last_result==='link_cancelled'?'Cancelled':openLink&&op.cancel_requested?'Cancelling':human(op.status||'Unknown');
 if(onReader&&!['paid','refunded'].includes(op.status))return `<section class="mapping-notice"><b>${esc(readerPaymentLabel(op))} · ${money(op.amount_cents)}</b>${op.livemode===false&&typeof testPaymentLabel==='function'&&testPaymentLabel()?' · '+testPaymentLabel():''}<p>Card payment on reader. Nothing has been recorded for this payment.</p>${['creating','open'].includes(op.status)&&billingCan('edit')?`<button type="button" data-cancel-reader-invoice="${esc(op.id)}">Cancel payment</button>`:''}${op.status==='needs_review'?`<button type="button" data-invoice-checkout-review="${esc(op.id)}">Check payment status</button>`:''}</section>`;
 return `<section class="mapping-notice"><b>${esc(label)} · ${money(op.amount_cents)}</b>${test}<p>${op.paid_entry_id?'Verified capture recorded in the patient ledger.':'No patient ledger capture is confirmed.'}${op.captured_at?' Received '+esc(date(op.captured_at))+'.':''}${op.refunded_cents?' Refunded '+money(op.refunded_cents)+'.':''}${op.unapplied_cents?' Unapplied '+money(op.unapplied_cents)+'.':''}</p>${url?`<a class="button primary" href="${esc(url)}" rel="noreferrer" referrerpolicy="no-referrer">Continue secure installment checkout</a>`:''}<button type="button" data-invoice-checkout-review="${esc(op.id)}">Check payment status</button>${openLink&&!op.cancel_requested&&billingCan('edit')?`<button type="button" data-cancel-invoice-link="${esc(op.id)}">Cancel link</button>`:''}${op.status==='creating'&&!op.cancel_requested&&billingCan('create')?`<button type="button" data-installment-checkout-resume="${esc(op.id)}">Resume this checkout request</button>`:''}</section>`;
}
function installmentPlanSummary(plan){
 const rows=plan.installments||[],paid=rows.filter(row=>row.status==='paid'||(row.amount_cents>0&&row.collected_cents>=row.amount_cents)).length,next=rows.find(row=>!(row.status==='paid'||(row.amount_cents>0&&row.collected_cents>=row.amount_cents)));
 return `${money(plan.total_cents)} in ${rows.length} payments · ${paid} paid · ${money(plan.remaining_cents)} left${next?' · Next due '+esc(next.due_on):''}`;
}
function installmentPlanMarkup(plan,s){
 const writable=billingCan('create')&&s.installmentAvailability?.available;
 return `<article class="billing-section" data-installment-plan="${esc(plan.id)}"><div class="section-head"><h4>Payment plan</h4><span class="pill">${esc(human(plan.status))}${plan.livemode===false&&planTestTag()?' · '+planTestTag():''}</span></div><p>${installmentPlanSummary(plan)}</p><p class="muted">${plan.created_at?'Arranged '+esc(date(plan.created_at))+'. ':''}${plan.reason?esc(plan.reason)+'. ':''}<b>No automatic payments.</b></p>${plan.blocked_reason?`<p class="mapping-notice">${esc(plan.blocked_reason)}</p>`:''}<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Payment / due</th><th>Amount</th><th>Collected</th><th>Status</th><th></th></tr></thead><tbody>${(plan.installments||[]).map(row=>`<tr><td>${esc(row.number)} · ${esc(row.due_on)}</td><td>${money(row.amount_cents)}</td><td>${money(row.collected_cents)}<small>${money(row.collectible_cents)} can be collected now</small></td><td>${esc(human(row.status))}</td><td>${installmentCheckoutRequests.has(s.patientId+':'+plan.id+':'+row.number)?`<button type="button" data-installment-local-resume="${esc(plan.id)}" data-installment-number="${esc(row.number)}">Review the waiting payment</button>`:writable&&plan.status==='active'&&!plan.blocked_reason&&row.collectible_cents>=50?`<button type="button" data-installment-collect="${esc(plan.id)}" data-installment-number="${esc(row.number)}">Collect payment</button>`:''}</td></tr>`).join('')}</tbody></table></div>${(plan.attempts||[]).map(installmentOperationMarkup).join('')}</article>`;
}
function renderPatientInstallments(s){
 const host=s.host.querySelector('#patient-billing-installments');if(!host||!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
 capturePatientPaymentPlanDrafts();installmentSession();const pending=installmentCreateRequests.get(s.patientId);
 const can=billingCan('create')&&billingCan('edit'),available=s.installmentAvailability?.available===true,eligible=installmentEligibleInvoices(s).length>0;
 const start=can&&available&&eligible&&!pending?'<button type="button" class="primary" data-start-payment-plan-sheet>Start payment plan</button>':'';
 const paymentsFix=me?.role==='owner'?'<p><button type="button" data-payment-settings>Set up card payments</button></p>':'<p class="muted">Ask the practice owner to set up card payments.</p>';
 let note='';
 if(!available)note=`<p class="muted" role="status">${esc(s.installmentAvailability?.reason||'Card payments are not set up yet, so payments cannot be collected.')}</p>${paymentsFix}`;
 else if(!can)note='<p class="muted">Your role can view payment plans. Starting one needs billing access.</p>';
 else if(!pending&&!eligible)note=installmentPlanForm(s);
 host.innerHTML=`<div class="section-head"><h3>Payment plans</h3>${start}</div><p class="muted">A plan splits one billed statement into dated payments. Each payment is collected on purpose; nothing charges automatically.</p>${(s.installmentPlans||[]).map(plan=>installmentPlanMarkup(plan,s)).join('')||'<p>This patient has no payment plans yet.</p>'}${pending?`<section class="mapping-notice"><p>We did not get an answer for the ${money(pending.total)} plan. Try this same request again before making another.</p><button type="button" data-installment-create-retry>Try the same request again</button></section>`:''}${note}<div id="installment-plan-review"></div><div id="installment-collection"></div>`;
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
  if(s.openPlanSheet){s.openPlanSheet=false;openStartPaymentPlanSheet(s);}
  if(s.planTargetId&&s.planFocused!==s.planTargetId){const chosen=[...host.querySelectorAll('[data-installment-plan]')].find(node=>node.dataset.installmentPlan===s.planTargetId);if(chosen){chosen.scrollIntoView({block:'nearest'});s.planFocused=s.planTargetId;}}
 }catch(error){if(current())host.innerHTML=`<h3>Payment plans</h3><p role="alert">${esc(error.message||'Payment plans are unavailable.')}</p><p>The number of plans is unknown.</p><button type="button" data-installments-refresh>Try again</button>`;}
}
async function loadPatientPaymentPlans(s){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!s.patientId)return;
 const request=s.planRequest=(s.planRequest||0)+1;
 await Promise.allSettled([loadPatientMemberships(s,request),loadPatientInstallments(s,request)]);
}
function divideInstallmentSchedule(s,form){
 const invoice=s.eligibleInvoices?.find(item=>item.invoice_id===form.elements.invoice_id.value&&item.eligible);if(!invoice)throw new Error('Choose an eligible reviewed invoice.');
 const rows=proposeInstallmentSchedule(invoice.remaining_cents,Number(form.elements.count.value),form.elements.first_due.value);
 validateInstallmentDueDates(rows);
 form.querySelector('#installment-proposed-schedule').innerHTML=`<p>${money(invoice.remaining_cents)} divided into ${rows.length} proposed payments. Review or adjust every due date and amount.</p><table class="billing-table"><thead><tr><th>Number</th><th>Due</th><th>USD amount</th></tr></thead><tbody>${installmentScheduleRows(rows)}</tbody></table>`;
 form.querySelector('button[type="submit"]').disabled=false;form.dataset.invoice=invoice.invoice_id;capturePatientPaymentPlanDrafts();
}
async function previewInstallmentPlan(s,form){
 if(!patientBillingCurrent(s)||!billingCan('create')||!billingCan('edit'))return;
 if(form.dataset.invoice!==form.elements.invoice_id.value)throw new Error('Propose the schedule again for the selected invoice.');
 const body={invoice_id:form.elements.invoice_id.value,livemode:s.installmentAvailability.livemode,installments:installmentScheduleValue(form)},host=planReviewHost(s),request=Symbol();s.installmentPreviewRequest=request;
 validateInstallmentDueDates(body.installments);
 const preview=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans/preview`,'POST',body);
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||s.installmentPreviewRequest!==request||planReviewHost(s)!==host)return;
 if(preview.invoice_id!==body.invoice_id||preview.livemode!==body.livemode||!Number.isInteger(preview.account_version))throw new Error('The plan preview did not match this invoice.');
 s.installmentPreview={preview,body};
 host.innerHTML=preview.eligible?`<form id="installment-confirm-form" data-patient-plan-draft="installment-confirm"><h4>Confirm the payment schedule</h4><p>The patient owes ${money(preview.responsibility_cents)} · credit already on account ${money(preview.patient_credit_cents)} · left to pay ${money(preview.remaining_cents)}.</p><table class="billing-table"><thead><tr><th>Payment</th><th>Due</th><th>Amount</th></tr></thead><tbody>${preview.installments.map(row=>`<tr><td>${esc(row.number)}</td><td>${esc(row.due_on)}</td><td>${money(row.amount_cents)}</td></tr>`).join('')}</tbody></table><p><b>No automatic card charges.</b> Each payment is collected on purpose, with the patient present or with a card they have saved for later.</p><label>Reason for the arrangement<textarea name="reason" maxlength="1000" required></textarea></label><label class="check"><input type="checkbox" name="consent" required> The patient agrees to this exact payment schedule.</label><div class="actions"><button type="submit" class="primary">Create payment plan</button></div></form>`:`<p role="alert">${esc(preview.blocked_reason||'This statement cannot have a payment plan yet.')}</p>`;const confirmation=host.querySelector('#installment-confirm-form');if(confirmation)restorePatientPlanDraft(s,confirmation);host.scrollIntoView({block:'nearest'});
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
  closePlansSheet(s);
  if(patientBillingCurrent(s)&&s.tab==='subscriptions'){s.planTargetId=plan.id;await loadPatientInstallments(s,s.planRequest);}
 }catch(error){closePlansSheet(s);if(patientBillingCurrent(s)&&s.tab==='subscriptions'){renderPatientInstallments(s);const host=planReviewHost(s);if(host)host.innerHTML=`<p role="alert">${esc(error.message||'No answer was received.')} The original request is kept so you can try the same one again.</p>`;}}
}
// The collection form and the reader status sit directly under the plan they belong to.
function installmentCollectionHost(s,planId){
 const host=s.host.querySelector('#installment-collection');if(!host)return null;
 const plan=[...(s.host.querySelectorAll?.('[data-installment-plan]')||[])].find(node=>node.dataset?.installmentPlan===planId);
 if(plan&&plan.nextElementSibling!==host)plan.after?.(host);
 return host;
}
function openInstallmentCollection(s,planId,number,existing){
 const plan=s.installmentPlans?.find(item=>item.id===planId),row=plan?.installments.find(item=>item.number===Number(number));
 if(!plan||!row||!billingCan('create'))return;
 const host=installmentCollectionHost(s,planId);if(!host)return;
 host.innerHTML=`<form id="installment-checkout-form" data-patient-plan-draft="installment-checkout:${esc(plan.id)}:${esc(row.number)}" data-plan="${esc(plan.id)}" data-version="${esc(plan.version)}" data-number="${esc(row.number)}" data-amount="${esc(existing?.amount_cents??row.collectible_cents)}" ${existing?`data-request="${esc(existing.request_id)}"`:''}><h4>${existing?'Resume original':'Collect'} installment ${esc(row.number)}</h4><p>${money(existing?.amount_cents??row.collectible_cents)} · due ${esc(row.due_on)}${plan.livemode===false&&planTestTag()?' · '+planTestTag():''}</p><p>This opens a secure payment page for this installment. It does not authorize future automatic charges.</p><label>Collection reason (optional)<input name="reason" maxlength="1000" autocomplete="off" value="${esc(existing?.reason||'')}" ${existing?'readonly':''}></label><label class="check"><input name="patient_present" type="checkbox" required> The patient is present and agrees to this payment amount.</label><button type="submit" class="primary">${existing?'Resume same checkout request':'Create secure installment checkout'}</button>${existing?'':'<button type="button" data-installment-reader>Take card payment on reader</button><div id="installment-reader-choice"></div><button type="button" data-installment-saved-card>Charge card on file</button><div id="installment-saved-card-choice"></div>'}</form>`;const form=host.querySelector('#installment-checkout-form');if(form&&!existing)restorePatientPlanDraft(s,form);host.scrollIntoView({block:'nearest'});host.querySelector('input[name="patient_present"]')?.focus();
}
// Charging a card on file uses the same reviewed form. The first press shows the card and the
// amount; the card is charged when staff press the Charge button.
async function chooseInstallmentSavedCard(s,form){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create'))return;
 const found=await savedCardsForCharge(s.patientId);if(!patientBillingCurrent(s)||!form.isConnected)return;
 const host=form.querySelector('#installment-saved-card-choice'),amount=money(Number(form.dataset.amount));
 if(host)host.innerHTML=`${savedCardChoiceMarkup(found)}${found.cards.length?`<p>${amount} will be charged to the card. The patient does not need to be here.</p><button type="button" class="primary" data-installment-saved-card-pay>Charge ${amount}</button>`:''}`;
}
async function chargeInstallmentSavedCard(s,form){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create'))return;
 const card=form.elements.card?.value,reason=form.elements.reason?.value.trim()||'Installment charged to card on file',amount=Number(form.dataset.amount);
 if(!card||!Number.isSafeInteger(amount)||amount<50)throw new Error('Choose a card on file.');
 installmentSession();const key=s.patientId+':'+form.dataset.plan+':'+form.dataset.number;
 let saved=installmentCheckoutRequests.get(key);
 if(!saved||saved.body.saved_card_setup_id!==card){saved={body:{request_id:crypto.randomUUID(),amount_cents:amount,patient_present:false,reason,saved_card_setup_id:card},version:Number(form.dataset.version),plan:form.dataset.plan,number:Number(form.dataset.number),amount};installmentCheckoutRequests.set(key,saved);}
 const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans/${encodeURIComponent(saved.plan)}/installments/${saved.number}/checkout`,'POST',saved.body,saved.version);
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
 if(data.plan?.patient_id!==s.patientId||data.plan.id!==saved.plan||data.operation?.patient_id!==s.patientId||data.operation.plan_id!==saved.plan||data.operation.request_id!==saved.body.request_id)throw new Error('The payment result did not match the reviewed payment plan.');
 installmentCheckoutRequests.delete(key);
 const index=s.installmentPlans.findIndex(plan=>plan.id===saved.plan);if(index>=0)s.installmentPlans[index]=data.plan;renderPatientInstallments(s);
 showInstallmentSavedCardPayment(s,data.operation,saved.plan,saved.number);
}
function showInstallmentSavedCardPayment(s,operation,planId,number){
 const host=installmentCollectionHost(s,planId);if(!host)return;
 host.innerHTML='<div id="saved-card-payment-live"></div>';host.scrollIntoView({block:'nearest'});
 watchSavedCardPayment({operation,refreshUrl:'/api/v1/billing/invoice-checkouts/'+encodeURIComponent(operation.id)+'/refresh',
  approved:()=>'<p>The payment is recorded in the patient ledger.</p>',
  // One press makes the card link for the same installment; it appears under the plan.
  link:async asked=>{
   if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
   const plan=s.installmentPlans?.find(item=>item.id===planId);if(!plan)throw new Error('Refresh the payment plans first.');
   const made=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans/${encodeURIComponent(planId)}/installments/${number}/checkout`,'POST',{request_id:crypto.randomUUID(),amount_cents:asked.amount_cents,patient_present:false,reason:'Card link sent after the bank asked the patient to confirm',after_saved_card:asked.id},plan.version);
   if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
   stopSavedCardPayment();const index=s.installmentPlans.findIndex(item=>item.id===planId);if(index>=0&&made.plan?.id===planId)s.installmentPlans[index]=made.plan;renderPatientInstallments(s);
   const next=installmentCollectionHost(s,planId);if(next)next.innerHTML='<p role="status">Card link created. Open it or send it from the plan above.</p>';
  },
  // The plan is read again so its balance and history match, then the result is shown once more.
  finished:async final=>{if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;const live=savedCardPaymentLive;try{await loadPatientInstallments(s,s.planRequest);}catch{/* The result stays on screen. */}if(!patientBillingCurrent(s)||savedCardPaymentLive!==live)return;const next=installmentCollectionHost(s,planId);if(next&&live){next.innerHTML='<div id="saved-card-payment-live"></div>';live.operation=final;paintSavedCardPayment();}}});
}
async function cancelInstallmentLink(s,id){
 await api('/api/v1/billing/invoice-checkouts/'+encodeURIComponent(id)+'/cancel','POST',{});
 if(patientBillingCurrent(s)&&s.tab==='subscriptions')await loadPatientInstallments(s,s.planRequest);
}
// Taking the installment on a reader uses the same reviewed form. The first press shows which
// reader will be used; the payment is sent when staff press Take payment.
async function chooseInstallmentReader(s,form){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create'))return;
 const readers=await readersForPayment();if(!readers||!patientBillingCurrent(s)||!form.isConnected)return;
 s.paymentReaders=readers;
 const host=form.querySelector('#installment-reader-choice');
 if(host)host.innerHTML=`${readerChoiceMarkup(readers)}<p>${money(Number(form.dataset.amount))} will be taken on the reader.</p><button type="button" class="primary" data-installment-reader-pay>Take payment</button>`;
}
async function takeInstallmentOnReader(s,form){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create'))return;
 // A reader payment needs no typed reason or confirmation box: the patient is at the reader.
 const reader=form.elements.reader?.value,reason=form.elements.reason?.value.trim()||'Installment taken on card reader',amount=Number(form.dataset.amount);
 if(!reader||!Number.isSafeInteger(amount)||amount<50)throw new Error('Choose a card reader.');
 installmentSession();const key=s.patientId+':'+form.dataset.plan+':'+form.dataset.number;
 let saved=installmentCheckoutRequests.get(key);
 if(!saved||saved.body.reader_id!==reader){saved={body:{request_id:crypto.randomUUID(),amount_cents:amount,patient_present:true,reason,reader_id:reader},version:Number(form.dataset.version),plan:form.dataset.plan,number:Number(form.dataset.number),amount};installmentCheckoutRequests.set(key,saved);}
 const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/installment-plans/${encodeURIComponent(saved.plan)}/installments/${saved.number}/checkout`,'POST',saved.body,saved.version);
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;
 if(data.plan?.patient_id!==s.patientId||data.plan.id!==saved.plan||data.operation?.patient_id!==s.patientId||data.operation.plan_id!==saved.plan||data.operation.request_id!==saved.body.request_id)throw new Error('The payment result did not match the reviewed payment plan.');
 installmentCheckoutRequests.delete(key);rememberCardReader(reader);
 const index=s.installmentPlans.findIndex(plan=>plan.id===saved.plan);if(index>=0)s.installmentPlans[index]=data.plan;renderPatientInstallments(s);
 showInstallmentReaderPayment(s,data.operation,saved.plan,saved.number);
}
function showInstallmentReaderPayment(s,operation,planId,number){
 const host=installmentCollectionHost(s,planId);if(!host)return;
 const base='/api/v1/billing/invoice-checkouts/'+encodeURIComponent(operation.id),reader=(s.paymentReaders||[]).find(item=>item.id===operation.reader_id),name=reader?.name;
 host.innerHTML='<div id="reader-payment-live"></div>';host.scrollIntoView({block:'nearest'});
 watchReaderPayment({operation,readerName:name,statusUrl:base,cancelUrl:base+'/reader-cancel',simulateUrl:base+'/reader-simulate-tap',simulated:reader?.simulated===true,accept:()=>{},
  again:async()=>{if(patientBillingCurrent(s)&&s.tab==='subscriptions')openInstallmentCollection(s,planId,number);},
  approved:()=>'<p>The payment is recorded in the patient ledger.</p>',
  // The plan is read again so its balance and history match, then the result is shown once more.
  finished:async final=>{if(!patientBillingCurrent(s)||s.tab!=='subscriptions')return;const live=readerPaymentLive;try{await loadPatientInstallments(s,s.planRequest);}catch{/* The result stays on screen. */}if(!patientBillingCurrent(s)||readerPaymentLive!==live)return;const next=installmentCollectionHost(s,planId);if(next&&live){next.innerHTML='<div id="reader-payment-live"></div>';live.operation=final;paintReaderPayment();}}});
}
async function cancelInstallmentReaderPayment(s,id){
 await api('/api/v1/billing/invoice-checkouts/'+encodeURIComponent(id)+'/reader-cancel','POST',{});
 if(patientBillingCurrent(s)&&s.tab==='subscriptions')await loadPatientInstallments(s,s.planRequest);
}
async function createInstallmentCheckout(s,form){
 if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!billingCan('create')||!form.elements.patient_present.checked)return;
 installmentSession();const key=s.patientId+':'+form.dataset.plan+':'+form.dataset.number,submitted=patientPlanBaselines.has(form)?patientPlanFormDraft(form):null;
 let saved=installmentCheckoutRequests.get(key);
 if(!saved){saved={body:{request_id:form.dataset.request||crypto.randomUUID(),amount_cents:Number(form.dataset.amount),patient_present:true,reason:form.elements.reason.value.trim()||'Installment card link'},version:Number(form.dataset.version),plan:form.dataset.plan,number:Number(form.dataset.number),amount:Number(form.dataset.amount)};if(!Number.isSafeInteger(saved.body.amount_cents)||saved.body.amount_cents<50)return;installmentCheckoutRequests.set(key,saved);}
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
 const form=event.target;if(!['patient-membership-form','installment-preview-form','installment-confirm-form','installment-checkout-form'].includes(form.id))return;
 event.preventDefault();const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||!patientPlanInScope(s,form))return;
 planSheetRun(s,form,async()=>{
  if(form.id==='patient-membership-form'){await createPatientMembership(s,form);closePlansSheet(s);}
  else if(form.id==='installment-preview-form')await previewInstallmentPlan(s,form);
  else if(form.id==='installment-confirm-form')await createInstallmentPlan(s,form,false);
  else await createInstallmentCheckout(s,form);
 });
});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;const d=button.dataset;
 if(d.membershipReturnRetry){run(()=>openPatientMembershipReturn(d.membershipReturnRetry));return;}
 if(d.invoiceCheckoutReview){run(()=>openInvoiceCheckoutReturn(d.invoiceCheckoutReview));return;}
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||s.tab!=='subscriptions'||!patientPlanInScope(s,button))return;
 if(button.hasAttribute('data-start-membership'))openStartMembershipSheet(s);
 else if(button.hasAttribute('data-start-payment-plan-sheet'))openStartPaymentPlanSheet(s);
 else if(button.hasAttribute('data-open-membership-prices')){closePlansSheet(s);run(()=>showPracticeAdmin('memberships'));}
 else if(button.hasAttribute('data-memberships-refresh'))run(()=>loadPatientMemberships(s,s.planRequest));
 else if(d.membershipRefresh)run(()=>refreshPatientMembership(s,d.membershipRefresh));
 else if(d.membershipRetry){const op=membershipCurrentRequest(s)?.request_id===d.membershipRetry?membershipCurrentRequest(s):s.memberships?.find(item=>item.request_id===d.membershipRetry);if(op){membershipRequests.set(s.patientId,op);run(()=>createPatientMembership(s,null,op));}}
 else if(d.membershipOperationCheck)run(()=>refreshMembershipOperation(s,d.membershipOperationCheck));
 else if(d.membershipOperationRetry)run(()=>retryMembershipOperation(s,d.membershipOperationRetry));
 else if(d.membershipCancel)run(()=>cancelPatientMembership(s,d.membershipCancel));
 else if(d.membershipPricesNext)run(()=>loadMoreMembershipPrices(s,d.membershipPricesNext));
 else if(d.membershipsNext||button.hasAttribute('data-memberships-first')){s.membershipsAfter=d.membershipsNext||null;run(()=>loadPatientMemberships(s,s.planRequest));}
 else if(button.hasAttribute('data-installments-refresh'))run(()=>loadPatientInstallments(s,s.planRequest));
 else if(button.hasAttribute('data-installment-divide')){planSheetRun(s,button,()=>divideInstallmentSchedule(s,button.closest('form')));}
 else if(button.hasAttribute('data-installment-create-retry'))run(()=>createInstallmentPlan(s,null,true));
 else if(d.installmentLocalResume){const saved=installmentCheckoutRequests.get(s.patientId+':'+d.installmentLocalResume+':'+d.installmentNumber);if(saved)openInstallmentCollection(s,saved.plan,saved.number,{request_id:saved.body.request_id,reason:saved.body.reason,amount_cents:saved.amount});}
 else if(d.installmentCollect)openInstallmentCollection(s,d.installmentCollect,Number(d.installmentNumber));
 else if(button.hasAttribute('data-installment-reader'))run(()=>chooseInstallmentReader(s,button.closest('form')));
 else if(button.hasAttribute('data-installment-reader-pay'))run(()=>takeInstallmentOnReader(s,button.closest('form')));
 else if(d.cancelReaderInvoice)run(()=>cancelInstallmentReaderPayment(s,d.cancelReaderInvoice));
 else if(d.cancelInvoiceLink)run(()=>cancelInstallmentLink(s,d.cancelInvoiceLink));
 else if(button.hasAttribute('data-installment-saved-card'))run(()=>chooseInstallmentSavedCard(s,button.closest('form')));
 else if(button.hasAttribute('data-installment-saved-card-pay')){button.disabled=true;run(()=>chargeInstallmentSavedCard(s,button.closest('form')));}
 else if(d.installmentCheckoutResume){const plan=s.installmentPlans?.find(plan=>plan.attempts.some(op=>op.id===d.installmentCheckoutResume)),op=plan?.attempts.find(op=>op.id===d.installmentCheckoutResume);if(op)openInstallmentCollection(s,plan.id,op.installment_number,op);}
});
// From an encounter's Billing tab: open this patient's billing page on Memberships & payment plans
// with the Start payment plan sheet ready.
async function startPaymentPlanFromEncounter(){
 const patientId=typeof selected!=='undefined'?selected:null;if(!patientId)return;
 const s=await showPatientBillingWorkspace({patientId,tab:'subscriptions'});
 if(!s)return;
 s.openPlanSheet=true;
 if(s.installmentPlans&&patientBillingCurrent(s)&&s.tab==='subscriptions'&&s.eligibleInvoices){s.openPlanSheet=false;openStartPaymentPlanSheet(s);}
}
if(typeof document!=='undefined')document.addEventListener('click',event=>{
 const button=event.target?.closest?.('button[data-start-payment-plan]');if(!button)return;
 event.preventDefault();run(()=>startPaymentPlanFromEncounter());
});
