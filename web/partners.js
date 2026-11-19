// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The agreement the owner reads and accepts on this screen; the server refuses any other version.
const PARTNER_AGREEMENT_VERSION='partner-enrollment-v1';
// One page where an owner sets up payments and starts working with a billing partner.
// The partner list and every enrollment come from SunCharts Connect through this EHR;
// this EHR keeps no copy of an agreement.
const partnersApi='/api/v1/practice/partners';
let partnersState=null,partnersGeneration=0;

function partnersDay(value){const d=new Date(value);return value&&!Number.isNaN(d.getTime())?d.toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'}):'';}
// Only an address on the SunCharts connection itself may be opened as a link.
function partnersSetupUrl(payments){const url=payments?.native_setup_url||payments?.connect_portal_url||'';return /^https:\/\/[^\s"'<>]+$/.test(url)?url:'';}
function partnersPaymentStep(payments){
 const state=payments?.state;
 if(state==='ready')return '<div class="partners-step"><div><h3>1 · Payments</h3><p>Payments are set up. Patient charges and clinic payouts run through the practice’s own payment account.</p></div><span class="status-badge checked_in">Payments set up</span></div>';
 if(state==='started')return `<div class="partners-step"><div><h3>1 · Payments</h3><p>Payment setup has started. Finish the practice’s business and bank details so charges and payouts are live.</p><div class="actions">${partnersSetupUrl(payments)?`<a class="button primary" href="${esc(partnersSetupUrl(payments))}" target="_blank" rel="noopener noreferrer">Continue payments setup ↗</a>`:'<button type="button" class="primary" data-partners-payments>Continue payments setup</button>'}</div></div><span class="status-badge in_progress">Payments need finishing</span></div>`;
 if(state==='unavailable')return '<div class="partners-step"><div><h3>1 · Payments</h3><p>Connect this EHR to SunCharts to set up the practice’s payment account.</p></div><span class="status-badge blocked">Payments not set up</span></div>';
 if(state!=='none')return `<div class="partners-step"><div><h3>1 · Payments</h3><p>The payment account status could not be read right now${payments?.reason?`: ${esc(payments.reason)}`:''}. Nothing has been changed.</p></div><span class="status-badge">Status unavailable</span></div>`;
 return `<div class="partners-step"><div><h3>1 · Payments</h3><p>Set up the practice’s own payment account before patients are billed. SunCharts handles the payment provider securely; this EHR never asks for a payment key.</p><div class="actions">${partnersSetupUrl(payments)?`<a class="button primary" href="${esc(partnersSetupUrl(payments))}" target="_blank" rel="noopener noreferrer">Set up payments ↗</a>`:'<button type="button" class="primary" data-partners-payments>Set up payments</button>'}</div></div><span class="status-badge blocked">Payments not set up</span></div>`;
}
// Not paired: the existing Connect setup action takes the place of the list.
function partnersConnectCard(onboarding){
 return `<div class="mapping-notice"><b>This EHR is not connected to SunCharts yet</b><p>Billing partners come from SunCharts Connect. Connect this EHR first and the partners listed for your practice appear here.</p></div>${typeof connectOnboardingCard==='function'?connectOnboardingCard(onboarding,null):'<div class="actions"><button type="button" data-partners-integrations>Open Integrations</button></div>'}`;
}
function partnerCard(partner){
 const services=(partner.services||[]).filter(service=>typeof service==='string'&&service).slice(0,6);
 return `<article class="integration-card partner-card${partner.enrolled?' ready':''}"><header><div><h3>${esc(partner.name)}</h3><p>${esc(partner.summary||'')}</p></div>${partner.preferred&&!partner.enrolled?'<span class="status-badge checked_in">Recommended</span>':partner.enrolled?'<span class="status-badge checked_in">Current partner</span>':''}</header>${services.length?`<div class="integration-capabilities">${services.map(service=>`<span>${esc(service)}</span>`).join('')}</div>`:''}<footer><small>${partner.enrolled?'This practice works with this partner now.':'One partner at a time can work this practice’s claims.'}</small>${partner.enrolled?'':`<button type="button" class="primary" data-partner-enroll="${esc(partner.slug)}">Enroll</button>`}</footer></article>`;
}
// What an owner must be told before agreeing: exactly what the partner gains.
function partnerEnrollConfirm(partner){
 return `<form class="partner-confirm" data-kind="enroll" data-slug="${esc(partner.slug)}" data-name="${esc(partner.name)}" data-request="${crypto.randomUUID()}"><h4>Work with ${esc(partner.name)}</h4><p>${esc(partner.name)} will be able to see your claims and payments, work your support tickets, and sign in to help when you allow it.</p><label class="review-ack"><input type="checkbox" name="agree" required> I agree to share this practice with ${esc(partner.name)}</label><div class="actions"><button type="submit" class="primary">Enroll with ${esc(partner.name)}</button><button type="button" data-partner-cancel>Cancel</button></div></form>`;
}
function partnerLeaveConfirm(enrollment){
 return `<form class="partner-confirm" data-kind="leave" data-slug="${esc(enrollment.partner_slug)}" data-name="${esc(enrollment.partner_name)}" data-request="${crypto.randomUUID()}"><h4>Stop working with ${esc(enrollment.partner_name)}</h4><p>${esc(enrollment.partner_name)} loses access to this practice’s claims, payments and support. Nothing in the patient record changes, and you can choose another partner afterwards.</p><div class="actions"><button type="submit" class="primary">Leave ${esc(enrollment.partner_name)}</button><button type="button" data-partner-cancel>Keep working together</button></div></form>`;
}
function partnersEnrollment(enrollment){
 if(!enrollment||enrollment.status!=='active')return '';
 return `<div class="partners-current"><p><b>Enrolled with ${esc(enrollment.partner_name)} on ${esc(partnersDay(enrollment.enrolled_at))}.</b> They have been notified.</p><div class="actions"><button type="button" data-partner-leave>Leave ${esc(enrollment.partner_name)}</button></div></div>`;
}
function partnersBillingSection(data){
 const partners=data?.partners||{};
 if(partners.connect_error)return partnersConnectCard(data?.onboarding);
 const enrollment=partners.enrollment,items=partners.items||[];
 return `${partnersEnrollment(enrollment)}${items.length?`<div class="integration-grid">${items.map(partnerCard).join('')}</div>`:'<p class="muted">No billing partner is listed for this practice yet. SunCharts decides which partners are listed here.</p>'}${partners.incomplete?'<p class="muted">Some partner listings could not be shown.</p>':''}<div id="partner-confirm"></div>`;
}
function renderPartners(){
 const data=partnersState;if(!data)return;
 $('tools').innerHTML=`<header class="integration-hero"><div><p class="eyebrow">PRACTICE SETUP</p><h2>Partners</h2><p>Set up payments and choose the billing partner that works this practice’s claims. SunCharts Connect holds the agreement; this EHR keeps no copy of it.</p></div><button type="button" data-partners-refresh>Refresh</button></header><section class="integration-section">${partnersPaymentStep(data.partners?.payments)}<div class="billing-section"><div class="section-head"><div><h3>2 · Billing partner</h3><p class="muted">Partners listed for this practice. Enrolling shares claims, payments and support access with one partner at a time.</p></div></div>${partnersBillingSection(data)}</section>`;
}
async function showPartners(){
 if(me?.role!=='owner')throw new Error('Practice owner access is required.');
 const generation=++partnersGeneration;
 showTool('Partners');$('tools').className='integration-workspace';
 const loading='<div class="automation-loading" role="status"><span></span><p>Loading billing partners…</p></div>';
 $('tools').innerHTML=loading;
 const data=await api(partnersApi);
 if(generation!==partnersGeneration||me?.role!=='owner'||$('tools')?.innerHTML!==loading)return;
 const onboarding=me.role==='owner'&&data?.partners?.connect_error?await api('/api/v1/connect/onboarding').catch(()=>null):null;
 if(generation!==partnersGeneration||$('tools')?.innerHTML!==loading)return;
 partnersState={...data,onboarding};
 renderPartners();
}
function partnerConfirmHost(){const host=$('partner-confirm');if(host)host.replaceChildren();return host;}
function partnerFromList(slug){
 const enrollment=partnersState?.partners?.enrollment;
 if(enrollment?.status==='active'&&enrollment.partner_slug===slug)return {slug,name:enrollment.partner_name};
 return (partnersState?.partners?.items||[]).find(partner=>partner.slug===slug)||null;
}
// The accepted party is the signed-in owner. This EHR confirms the name and email
// against the account itself before recording the agreement, so what the browser
// sent cannot decide whose acceptance was recorded.
function partnerAcceptedBy(){
 const email=typeof me?.email==='string'?me.email.trim():'';
 if(!email.includes('@'))throw new Error('This owner account has no email address on record. Add it in Practice administration first.');
 return {name:(typeof me?.display_name==='string'?me.display_name.trim():'')||email,email};
}
document.addEventListener('submit',event=>{
 const form=event.target;if(!form?.classList?.contains('partner-confirm'))return;
 event.preventDefault();event.stopImmediatePropagation();
 const values=Object.fromEntries(new FormData(form)),slug=form.dataset.slug,name=form.dataset.name,request=form.dataset.request;
 run(async()=>{
  if(form.dataset.kind==='enroll'){
   if(values.agree!=='on')throw new Error('Tick the box to agree to share this practice with this partner first.');
   await api(`${partnersApi}/${encodeURIComponent(slug)}/enroll`,'POST',{request_id:request,agreement_version:PARTNER_AGREEMENT_VERSION,accepted_by:partnerAcceptedBy()});
   await showPartners();notice(`Enrolled with ${name}. They have been notified.`);return;
  }
  await api(`${partnersApi}/${encodeURIComponent(slug)}/leave`,'POST',{request_id:request});
  await showPartners();notice(`${name} no longer works with this practice.`);
 });
},true);
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button');if(!button)return;
 const host=partnerConfirmHost();
 if(button.hasAttribute('data-partner-cancel')){event.preventDefault();event.stopImmediatePropagation();if(host)host.replaceChildren();return;}
 if(button.hasAttribute('data-partner-enroll')){
  const partner=partnerFromList(button.dataset.partnerEnroll);if(!partner)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(host)host.innerHTML=partnerEnrollConfirm(partner);return;
 }
 if(button.hasAttribute('data-partner-leave')&&partnersState?.partners?.enrollment){
  event.preventDefault();event.stopImmediatePropagation();
  if(host)host.innerHTML=partnerLeaveConfirm(partnersState.partners.enrollment);return;
 }
 if(button.hasAttribute('data-partners-payments')){event.preventDefault();event.stopImmediatePropagation();run(async()=>{await openPaymentSettings();});return;}
 if(button.hasAttribute('data-partners-integrations')){event.preventDefault();event.stopImmediatePropagation();run(async()=>{await showApps();});return;}
 if(button.hasAttribute('data-partners-refresh')){event.preventDefault();event.stopImmediatePropagation();run(async()=>{await showPartners();notice('Partners and payment status refreshed.');});return;}
},true);
