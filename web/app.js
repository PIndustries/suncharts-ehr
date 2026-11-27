// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Chart list layout helpers.
function chartListHeader(title,primary='',more=''){
 return `<div class="section-head chart-list-header"><h2 tabindex="-1">${esc(title)}</h2><div class="actions">${primary}${more?`<details class="frame-add-menu chart-list-more" data-inline data-menu><summary>More ▾</summary><div class="frame-add-items">${more}</div></details>`:''}</div></div>`;
}
function chartListTable(columns,rows,empty){
 return `<div class="chart-list-table"><table><thead><tr>${columns.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(cells=>`<tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${columns.length}" class="chart-empty-row">${esc(empty)}</td></tr>`}</tbody></table></div>`;
}
function chartRecordTemplate(id,html){return `<template id="${esc(id)}"><div>${html}</div></template>`;}
function chartOpenEditor(id,title){
 const host=$(id);if(!host||host.closest('dialog'))return host;
 const owner=host.closest('.panel')?.id;const marker=document.createComment(id);host.before(marker);
 const record=[...document.querySelectorAll('dialog[data-chart-record]')].at(-1);
 const dialog=record||sheetOpen(title,host);if(record)record.querySelector('.sheet-body').prepend(host);dialog.classList.add('chart-record-sheet');if(owner)dialog.dataset.chartOwner=owner;
 dialog.addEventListener('close',()=>{if(id==='erx-setup-panel')host.hidden=true;if(marker.isConnected)marker.replaceWith(host);else host.remove();},{once:true});
 return host;
}
function chartResetSectionSheets(panel){for(const dialog of document.querySelectorAll('dialog[data-chart-owner]'))if(dialog.dataset.chartOwner===panel.id){dialog.close();dialog.remove();}}
function chartCloseSheets(){
 const codeDialog=document.querySelector?.('[data-encounter-codes-dialog][open]');if(codeDialog)codeDialog.close();
 for(const dialog of document.querySelectorAll('dialog.chart-record-sheet')){dialog.close();dialog.remove();}
}
function chartLoadingMarkup(){return '<div class="chart-section-skeleton" role="status" aria-label="Loading section"><span></span><span></span><span></span></div>';}
function chartStickySizes(){
 const bar=document.querySelector('.shell-topbar'),banner=$('patient-banner');
 const top=bar?.getBoundingClientRect().height||0,patient=banner?.getBoundingClientRect().height||0;
 document.documentElement.style.setProperty('--frame-top-height',top+'px');
 document.documentElement.style.setProperty('--frame-banner-height',patient+'px');
 const mobile=document.querySelector('.frame-chart-select'),navigation=mobile&&getComputedStyle(mobile).display!=='none'?mobile.closest('.chart-context')?.getBoundingClientRect().height||0:0;
 if(typeof visitClaimLayout==='function')visitClaimLayout();
 return top+patient+navigation;
}
function chartContentTop(){
 const chart=$('chart'),header=$('patient-banner');if(!chart||!header)return 0;
 // offsetTop is stable even after the banner sticks. Its rect no longer describes its flow position.
 const anchor=$('chart-content-top'),offset=anchor?anchor.offsetTop:header.offsetTop+header.offsetHeight+16;
 return Math.max(0,chart.getBoundingClientRect().top+window.scrollY+offset-chartStickySizes());
}
let chartHeadingFocusPending=null;
function chartVisibleHeading(){return [...$('chart').children].filter(n=>!n.hidden&&!n.matches('#patient-banner,.chart-context,#record-context')).map(n=>n.querySelector('h2')).find(Boolean);}
function alignChartContent(){
 if(typeof window==='undefined'||!$('patient-banner')||$('clinical-workspace')?.hidden)return;
 chartStickySizes();
 const heading=chartVisibleHeading();
 chartHeadingFocusPending=heading?null:{patient:selected,section:chartSection};
 if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
}
if(typeof document!=='undefined'){
 document.addEventListener('click',event=>{
  const target=event.target.closest('button');
  if(target?.hasAttribute('data-chart-sidebar-toggle')){
   const navigation=$('frame-chart-navigation');
   if(!navigation)return;
   const collapsed=navigation.dataset.sidebarCollapsed!=='true';
   chartSidebarCollapsed(collapsed);
   applyChartSidebarCollapsed(navigation,collapsed);
   chartStickySizes();
   return;
  }
  if(target?.hasAttribute('data-chart-group-toggle')){
   const group=target.closest('[data-chart-sidebar-group]');
   if(!group)return;
   if(chartSidebarIsRail(group)){
    const panel=group.querySelector('[data-chart-group-flyout]');
    if(panel.hasAttribute('open')&&(event.detail===0||event.pointerType==='touch'))closeChartSidebarFlyout(true);
    else openChartSidebarFlyout(group,event.detail===0);
    return;
   }
   const open=group.dataset.sidebarGroupOpen!=='true';
   chartSidebarGroupOpen(group,open);
   chartSidebarGroups(group.dataset.chartSidebarGroup,open);
   return;
  }
  if(target?.hasAttribute('data-chart-erx')){showErxSetup();const host=$('erx-setup-panel');if(host){host.hidden=false;chartOpenEditor(host.id,'E-prescribing setup');}return;}
  if(target?.hasAttribute('data-chart-record-vitals')){if(!canRecordVisitVitals(activeVisit)){run(()=>openEncounterStartFlow('new'));return;}openVitalsForm();if($('vitals-form'))chartOpenEditor('vitals-form','Record vitals');return;}
  if(target?.dataset.chartAppointment){run(()=>appointmentDetail(target.dataset.chartAppointment,selected));return;}
  if(target?.dataset.chartWorkflow){const id=target.dataset.chartWorkflow;const host=document.createElement('div');host.id='chart-workflow-detail';host.innerHTML=chartLoadingMarkup();sheetOpen('Practice workflow',host).classList.add('chart-record-sheet');run(()=>pathwaySelect(id));return;}
  if(target?.hasAttribute('data-chart-file-status')){const state=documentStates.get(selected);if(state){state.status=state.status?'':'active';showDocuments();}return;}
  if(target?.hasAttribute('data-chart-payment')){if($('visit-billing-collect'))openVisitCollect();else{const host=document.createElement('div');host.innerHTML=chartListTable(['Encounter',''],(patientBillingWorkspace.native?.accounts.items||[]).map(row=>[esc(row.service_date||'Office visit'),`<button type="button" data-billing-patient="${esc(selected)}" data-account="${esc(row.id)}">Open</button>`]),'Start an encounter to take a payment.');sheetOpen('Choose encounter',host);}return;}
  const button=event.target.closest('[data-chart-detail]');
  if(button){const source=$(button.dataset.chartDetail);if(!source)return;const host=document.createElement('div');host.append(source.content.cloneNode(true));if(typeof typeaheadInit==='function')typeaheadInit(host);if(button.hasAttribute('data-review-no-known'))host.querySelector('[name="review_state"]').value='no_known';const dialog=sheetOpen(button.textContent.trim(),host);dialog.classList.add('chart-record-sheet');dialog.dataset.chartRecord=button.dataset.chartDetail;dialog.dataset.chartOwner=source.closest('.panel')?.id||'';button.closest('details')?.removeAttribute('open');const edit=host.querySelector('[data-edit-clinical],[data-history-edit],[data-immunization-edit],[data-referral-edit],[data-rx-edit]');edit?.click();return;}
  const row=event.target.closest('.chart-list-table tbody tr');if(row&&!event.target.closest('button,a,input,select'))row.querySelector('button,a')?.click();
 });
 document.addEventListener('pointerover',event=>{
  const toggle=event.target.closest('[data-chart-group-toggle]');
  const group=toggle?.closest('[data-chart-sidebar-group]');
  if(event.pointerType==='mouse'&&group&&chartSidebarIsRail(group))openChartSidebarFlyout(group);
  else if(chartSidebarFlyout?.group.contains(event.target))clearTimeout(chartSidebarCloseTimer);
 });
 document.addEventListener('pointerout',event=>{
  const state=chartSidebarFlyout;
  if(!state||!state.group.contains(event.target)||state.group.contains(event.relatedTarget))return;
  clearTimeout(chartSidebarCloseTimer);
  chartSidebarCloseTimer=setTimeout(()=>{
   if(chartSidebarFlyout===state&&!state.panel.contains(document.activeElement))closeChartSidebarFlyout();
  },200);
 });
 document.addEventListener('pointerdown',event=>{
  if(chartSidebarFlyout&&!chartSidebarFlyout.group.contains(event.target))closeChartSidebarFlyout();
 });
 document.addEventListener('focusout',event=>{
  const state=chartSidebarFlyout;
  if(state?.group.contains(event.target)&&!state.group.contains(event.relatedTarget)&&!state.group.matches(':hover'))closeChartSidebarFlyout();
 });
 document.addEventListener('click',event=>{
  if(chartSidebarFlyout?.panel.contains(event.target)&&event.target.closest('button'))closeChartSidebarFlyout();
 },true);
 document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&chartSidebarFlyout){
   event.preventDefault();
   closeChartSidebarFlyout(chartSidebarFlyout.group.contains(document.activeElement));
   return;
  }
  const toggle=event.target.closest('[data-chart-group-toggle]');
  const group=toggle?.closest('[data-chart-sidebar-group]');
  if(group&&chartSidebarIsRail(group)&&['ArrowRight','ArrowDown'].includes(event.key)){
   event.preventDefault();openChartSidebarFlyout(group,true);
  }
 });
 window.addEventListener('resize',()=>closeChartSidebarFlyout());
 document.addEventListener('scroll',event=>{
  if(chartSidebarFlyout&&!chartSidebarFlyout.panel.contains(event.target))closeChartSidebarFlyout();
 },true);
 document.addEventListener('keydown',event=>{const row=event.target.closest('.chart-list-table tbody tr');if(row&&event.target===row&&['Enter',' '].includes(event.key)){event.preventDefault();row.querySelector('button,a')?.click();}});
 document.addEventListener('DOMContentLoaded',()=>{
  const bar=document.querySelector('.shell-topbar');if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(()=>chartStickySizes());observer.observe(document.documentElement);if(bar)observer.observe(bar);const chart=$('chart');if(chart)new MutationObserver(()=>{if(typeof visitClaimLayout==='function')visitClaimLayout();const banner=$('patient-banner');if(banner)observer.observe(banner);if(chartHeadingFocusPending&&chartHeadingFocusPending.patient===selected&&chartHeadingFocusPending.section===chartSection){const heading=chartVisibleHeading();if(heading){chartHeadingFocusPending=null;heading.tabIndex=-1;heading.focus({preventScroll:true});}}}).observe(chart,{childList:true,subtree:true});}
  chartStickySizes();
 });
}
// End chart list layout helpers.

function organizeWorkspaceNavigation(){
 const navigation=$('workspace-navigation');if(!navigation||typeof document.createElement!=='function'||navigation.dataset.organized==='true')return;
 const items={home:$('nav-practice'),schedule:$('nav-schedule'),queue:$('nav-followup'),messages:$('nav-portal'),communications:$('nav-communications'),patients:$('nav-clinical'),clinical:$('nav-labs'),specialty:$('nav-specialty'),referrals:$('nav-referrals'),billing:$('nav-billing'),claims:$('nav-claims'),clearinghouse:$('nav-edi'),workflows:$('nav-workflows'),automation:$('nav-automation'),aiReview:$('nav-ai-review'),admin:$('nav-admin'),apps:$('nav-apps'),migration:$('nav-migration')};
 const labels={home:'Home',schedule:'Schedule',queue:'Work queue',messages:'Inbox',communications:'Communications',patients:'Patients',clinical:'Orders & results',specialty:'Specialty care',referrals:'Referrals',billing:'Patient balances',claims:'Claims',clearinghouse:'Claim lifecycle',workflows:'Workflow Studio',automation:'Automation Center',aiReview:'Sun review',admin:'Practice administration',apps:'Integrations',migration:'Data import'};
 for(const [key,item] of Object.entries(items)){const label=item?.querySelector('span');if(label)label.textContent=labels[key];}
 const top=document.createElement('div');top.className='frame-primary';
 const billing=document.createElement('button');billing.id='frame-billing';billing.type='button';billing.className='nav-item';billing.textContent='Billing';
 if(items.admin?.querySelector('span'))items.admin.querySelector('span').textContent='Admin';
 top.append(items.home,items.schedule,items.patients,billing,items.admin);
 const kept=document.createElement('div');kept.hidden=true;
 const customize=document.createElement('button');customize.id='nav-customize';customize.type='button';customize.textContent='Customize menu';customize.dataset.offMenu='';
 for(const key of ['apps','workflows','clearinghouse','migration'])if(items[key])items[key].dataset.offMenu='';
 kept.append(...Object.values(items).filter(node=>node&&!top.contains(node)),customize);
 navigation.replaceChildren(top,kept);
 const tabs=document.createElement('div');tabs.id='frame-patient-tabs';tabs.className='frame-patient-tabs';tabs.setAttribute('aria-label','Open patients');navigation.append(tabs);
 const bar=document.querySelector('.shell-topbar');bar.prepend(navigation);bar.prepend(document.querySelector('.sidebar-brand .wordmark'));
 const menu=document.createElement('div');menu.id='frame-user-menu';menu.className='frame-user-menu';
 menu.innerHTML='<button id="frame-user-toggle" type="button" aria-label="User menu" aria-haspopup="true" aria-expanded="false" aria-controls="frame-user-panel"><span id="frame-user-initials" class="account-avatar">SC</span></button><div id="frame-user-panel" class="frame-user-panel" hidden><button id="frame-help" type="button" data-support-help>Help</button></div>';
 const panel=menu.querySelector('.frame-user-panel');panel.prepend(document.querySelector('.sidebar-account'),items.queue,items.messages);
 const support=document.createElement('button');support.type='button';support.id='frame-support';support.textContent='Support';panel.append(support);
 const environment=$('frame-build-context')||document.querySelector('.shell-environment');
 const logout=$('logout');if(logout){logout.textContent='Sign out';}
 const actions=document.querySelector('.shell-topbar-actions');
 actions.prepend($('shell-find-patient'));actions.append(menu);
 const theme=actions.querySelector('.theme-control');if(theme)panel.append(theme);
 if(environment)panel.append(environment);if(logout)panel.append(logout);
 const billingTabs=document.createElement('nav');billingTabs.id='frame-billing-tabs';billingTabs.className='frame-billing-tabs';billingTabs.setAttribute('aria-label','Billing');billingTabs.hidden=true;const payments=document.createElement('button');payments.id='nav-insurance-payments';payments.type='button';payments.textContent='Insurance payments';payments.onclick=()=>run(()=>{billingInsuranceTab='payments';return showClaimsWorkspace();});items.claims.addEventListener?.('click',()=>{billingInsuranceTab='claims';});billingTabs.append(items.claims,payments,items.billing);
 document.querySelector('.workspace-header').after(billingTabs);
 navigation.dataset.organized='true';
}

// Only an opaque navigation ID may cross the explicit same-tab Connect sign-in.
// Never store payment status, patient identifiers/content, or handoff credentials.
function rememberHostedCopaySignInReturn(){
 const id=new URLSearchParams(location.search).get('copay_checkout');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.copay-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takeHostedCopaySignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.copay-return');sessionStorage.removeItem('suncharts.copay-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearHostedCopaySignInReturn(){
 try{sessionStorage.removeItem('suncharts.copay-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('copay_checkout'))return;query.delete('copay_checkout');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

function rememberPatientPaymentSetupSignInReturn(){
 const id=new URLSearchParams(location.search).get('payment_setup');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.payment-setup-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takePatientPaymentSetupSignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.payment-setup-return');sessionStorage.removeItem('suncharts.payment-setup-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearPatientPaymentSetupSignInReturn(){
 try{sessionStorage.removeItem('suncharts.payment-setup-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('payment_setup'))return;query.delete('payment_setup');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

function rememberPatientMembershipSignInReturn(){
 const id=new URLSearchParams(location.search).get('payment_membership');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.membership-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takePatientMembershipSignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.membership-return');sessionStorage.removeItem('suncharts.membership-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearPatientMembershipSignInReturn(){
 try{sessionStorage.removeItem('suncharts.membership-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('payment_membership'))return;query.delete('payment_membership');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

function rememberInvoiceCheckoutSignInReturn(){
 const id=new URLSearchParams(location.search).get('invoice_checkout');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.invoice-checkout-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takeInvoiceCheckoutSignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.invoice-checkout-return');sessionStorage.removeItem('suncharts.invoice-checkout-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearInvoiceCheckoutSignInReturn(){
 try{sessionStorage.removeItem('suncharts.invoice-checkout-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('invoice_checkout'))return;query.delete('invoice_checkout');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

// Connect delivers delegated support codes in the fragment so they never reach an HTTP log.
// Remove it before making any request, then exchange through this EHR's same-origin server.
async function acceptConnectLaunch(){
 const support=location.pathname==='/api/v1/connect/support/accept';
 // Current Connect launches onto the public shell so older EHR servers do not
 // reject the browser's initial GET before JavaScript can consume the fragment.
 // The legacy acceptance path remains supported for existing launch links.
 const identity=location.pathname==='/api/v1/connect/identity/accept'||location.pathname==='/';
 // A screen address (#/claims, #/patients/…) is not a Connect launch; leave it for navigation.
 if((!support&&!identity)||!location.hash||location.hash.startsWith('#/'))return false;
 let code,issuer;
 try{
  const input=new URLSearchParams(location.hash.slice(1));
  code=input.get('code');issuer=input.get('issuer');
  const requested=input.get('next');
  const next=requested==='claimmd'?'claimmd':requested==='care-pathways'?'workflow-studio':null;
  const returnQuery=new URLSearchParams();
  if(next)returnQuery.set('open',next);
  const savedCopayReturn=takeHostedCopaySignInReturn();
  const copayReturn=new URLSearchParams(location.search).get('copay_checkout')??savedCopayReturn;
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(copayReturn||''))returnQuery.set('copay_checkout',copayReturn);
  const savedSetupReturn=takePatientPaymentSetupSignInReturn();
  const setupReturn=new URLSearchParams(location.search).get('payment_setup')??savedSetupReturn;
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupReturn||''))returnQuery.set('payment_setup',setupReturn);
  for(const [key,saved] of [['payment_membership',takePatientMembershipSignInReturn()],['invoice_checkout',takeInvoiceCheckoutSignInReturn()]]){const id=new URLSearchParams(location.search).get(key)??saved;if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))returnQuery.set(key,id);}
  history.replaceState(null,'',returnQuery.size?'/?'+returnQuery.toString():'/');
  let issuerUrl;
  try{issuerUrl=new URL(issuer);}catch{throw new Error('This support sign-in link is invalid or incomplete.');}
  const loopback=issuerUrl.protocol==='http:'&&['127.0.0.1','::1'].includes(issuerUrl.hostname);
  if(!code||code.length<32||code.length>256||issuerUrl.origin!==issuer||(!loopback&&issuerUrl.protocol!=='https:'))throw new Error('This support sign-in link is invalid or incomplete.');
  const response=await fetch(support?'/api/v1/connect/support/accept':'/api/v1/connect/identity/accept',{method:'POST',headers:{'Content-Type':'application/json','X-SunCharts-Identity-Handoff':'1'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({code,issuer})});
  if(!response.ok)throw new Error('This Connect sign-in link expired, was already used, or was revoked.');
  const accepted=await response.json().catch(()=>({}));
  if(accepted.kind==='patient'){location.replace('/patient-portal');return new Promise(()=>{});}
  return true;
 }finally{code=undefined;issuer=undefined;}
}
const connectLaunchAcceptance=acceptConnectLaunch();
let chartSection='overview',encounterSection='visit',patientDirectoryPreference=storedPatientDirectoryPreference();
// The order the one-page visit shows: heading + actions, vitals, note, codes & charges, finish.
// The block hosts live in this fixed row inside #visit-page-host; re-rendering a block only ever
// replaces its own host, and an inserted panel (Insurance, Orders, Billing…) is placed after the
// row, so the DOM keeps this order through every re-render and after switching visits.
const VISIT_PAGE_HOST_ID='visit-page-host';
// The blocks the one scrolling page owns, top to bottom: heading + action buttons, vitals and the
// note (#visit-editor), codes & charges, finish. Every re-render re-places this row in this order
// and inserted panels (Insurance, Orders, Billing…) go after it, so DOM order survives every
// re-render and an encounter switch.
const VISIT_PAGE_BLOCK_IDS=['encounter-progress','visit-editor','encounter-revenue','visit-checkout','encounter-orders-actions'];
// Places the row of visit hosts at its fixed order, creating whatever is missing. Safe to call
// before every block render: an already-correct page only passes the host back.
function ensureVisitPageHost(){
 if(typeof document==='undefined'||typeof document.createElement!=='function'||typeof document.getElementById!=='function')return null;
 const chart=$('chart');if(!chart||typeof chart.appendChild!=='function')return null;
 let host=$(VISIT_PAGE_HOST_ID),owned=Boolean(host?.parentElement);
 if(!host){host=document.createElement('div');host.id=VISIT_PAGE_HOST_ID;}
 if(!owned){
  host.replaceChildren();
  for(const id of VISIT_PAGE_BLOCK_IDS){
   const block=$(id)||document.createElement(id==='encounter-revenue'?'section':'div');
   block.id=id;if(id==='encounter-revenue')block.className='panel';
   host.appendChild(block);
  }
  // The row sits where the encounter heading always sat: below the patient banner and chart tabs, above
  // the start-visit editor and the chart panels.
  const anchor=$('encounter-start-editor');
  if(anchor&&anchor.parentElement===chart)chart.insertBefore(host,anchor);else if(chart.children)chart.insertBefore(host,chart.children[0]??null);else chart.appendChild(host);
 }
 return host;
}
// The patient list stays out of the way of an open chart unless this device asked to keep it.
function storedPatientDirectoryPreference(){try{return localStorage.getItem('suncharts.patientDirectory.besideChart')==='shown';}catch{return false;}}
function rememberPatientDirectoryPreference(visible){patientDirectoryPreference=Boolean(visible);try{localStorage.setItem('suncharts.patientDirectory.besideChart',visible?'shown':'hidden');}catch{}}
let patientWorkspaceGeneration=0;
// After a note is signed, a short reminder that nothing is billed yet sits above the
// encounter until the clinician moves on. Text and a step link only — never amounts.
let postSignReminder=null;
function postSignReminderMarkup(){
 if(!postSignReminder||typeof activeVisit==='undefined'||activeVisit?.id!==postSignReminder.visitId)return '';
 // The one-page visit shows its charges block on the same screen as the note, so the reminder
 // is not needed there; it only speaks while a record area is open on its own.
 if(!inRecordArea())return '';
 // Once the encounter's charges are posted the reminder has done its job; nothing is kept in the browser.
 if(typeof encounterChargeAccount==='function'&&encounterChargeAccount()?.status==='posted'){postSignReminder=null;return '';}
 return `<div id="sign-charge-reminder" class="notice notice-with-action" role="status"><span>${esc(postSignReminder.message)}</span><button type="button" class="text-button" data-encounter-section="charges">Open Charges &amp; billing</button></div>`;
}
// What comes after signing depends on which chart areas the practice shows. Staff are
// only pointed at steps that exist for them, so nothing names a hidden area. Each entry
// is the sign question, the notice after signing, and the step staff are moved to.
const SIGN_NEXT_TEXT={
 'charges,checkout':{ask:'Continue to charges and the encounter summary after signing.',done:'Note signed. Next: charges, then the encounter summary.',step:'charges'},
 'charges':{ask:'Continue to charges after signing.',done:'Note signed. Next: charges.',step:'charges'},
 'checkout':{ask:'Continue to the encounter summary after signing.',done:'Note signed. Next: the encounter summary.',step:'checkout'},
 none:{ask:'',done:'Note signed.',step:''},
};
function signNextPlan(){
 // The encounter is one page, so signing leaves staff where the charges and checkout already sit.
 // What comes after only names areas this practice actually shows.
 const next=[visitBillingAreaVisible()?'charges':null,visitCheckoutAreaVisible()?'checkout':null].filter(Boolean).join(',');
 return SIGN_NEXT_TEXT[next]||SIGN_NEXT_TEXT.none;
}
function setPatientDirectoryVisible(visible){
 if(typeof selected!=='undefined'&&selected)visible=false;
 $('clinical-workspace')?.classList.toggle('frame-chart-open',typeof selected!=='undefined'&&Boolean(selected));
 $('clinical-workspace')?.classList.toggle('directory-collapsed',!visible);
 const button=$('toggle-directory');if(!button)return;
 button.textContent=visible?'Hide patients':'Show patients';
 button.setAttribute('aria-expanded',String(Boolean(visible)));
 button.title=visible?'Hide patient directory':'Show patient directory';
 button.setAttribute('aria-label',button.title);
}
function patientDirectoryLanding(){
 return '<section class="panel empty patient-directory-landing"><h2>Patient directory</h2><p>Choose a patient from the list, or search by name or MRN.</p></section>';
}
// Unsaved clinical edits live only in this tab, isolated by encounter and patient.
const visitDrafts=new Map();
// Note text sections in display order. A draft saves with any subset filled; Procedure is optional, and signing needs the first four.
const noteSectionKeys=['subjective','objective','assessment','plan','procedure'];
const noteProcedureHint='Procedure performed, site, medication and dose, lot number, guidance, tolerance, complications';
// The earlier note a draft was started from, as stable text so the form, the retained draft and the saved note compare equal.
function noteSourceText(value){
 let source=value;
 if(typeof source==='string'){if(!source)return '';try{source=JSON.parse(source);}catch{return '';}}
 if(!source?.visit_id)return '';
 return JSON.stringify({visit_id:String(source.visit_id),version:Number(source.version),sections:noteSectionKeys.filter(key=>(source.sections||[]).includes(key))});
}
function noteFieldText(key,value){return key==='started_from'?noteSourceText(value):key==='procedure'&&!String(value??'').trim()?'':String(value??'');}
function noteMatchesSaved(values,saved){return Boolean(saved)&&[...noteSectionKeys,'started_from'].every(key=>noteFieldText(key,values[key])===noteFieldText(key,saved[key]));}
// The saved note as one comparable text: its sections and where it was started from, not who saved it.
function noteSavedText(note){return JSON.stringify([...noteSectionKeys,'started_from'].map(key=>noteFieldText(key,note?.[key])));}
function noteSaverName(note){const by=note?.saved_by;return by?by.name||(by.support?'Support staff':'a staff member'):'';}
// Who may write, sign and correct an encounter note. The server enforces the same rule.
function clinicalAccess(action){return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical',action);}
function canDraftNote(v){return v?.status==='in_progress'&&['owner','clinician','nurse','medical_assistant'].includes(me?.role)&&clinicalAccess('edit');}
function canSignNote(){return ['owner','clinician'].includes(me?.role)&&!me?.delegated&&clinicalAccess('edit');}
function canAmendNote(v){return v?.status==='signed'&&['owner','clinician'].includes(me?.role)&&!me?.delegated&&clinicalAccess('create');}
function noteRequestBody(values){
 const body=Object.fromEntries(noteSectionKeys.slice(0,4).map(key=>[key,values[key]])),source=noteSourceText(values.started_from);
 if(String(values.procedure??'').trim())body.procedure=values.procedure;
 if(source)body.started_from=JSON.parse(source);
 return body;
}
function noteDay(value){const day=new Date(value);return Number.isNaN(day.getTime())?'':day.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});}
// The encounter date comes from the saved note when it names the same earlier visit, otherwise from what is already loaded.
function noteSourceDay(source,saved){
 const known=typeof visitNoteSourceDate==='function'?visitNoteSourceDate(source.visit_id):null,row=workspace?.visits?.find(visit=>visit.id===source.visit_id);
 const stamp=(saved?.visit_id===source.visit_id?saved.visit_date:null)||known||(row?workspace.appointments?.find(a=>a.id===row.appointment_id)?.starts_at||row.signed_at:null);
 return stamp?noteDay(stamp):'';
}
function noteSourceLine(text,signed,saved){
 if(!text)return '';
 const day=noteSourceDay(JSON.parse(text),saved),from=day?`the encounter on ${day}`:'an earlier visit';
 return signed?`Started from ${from}.`:`Started from ${from}. Review every section before signing.`;
}
const visitAmendmentDrafts=new Map(),visitAmendmentContexts=new WeakMap();
let visitAmendmentOwner;
function clearVisitAmendmentDrafts(){visitAmendmentDrafts.clear();visitAmendmentOwner=me;}
function amendmentContextKey(context){return JSON.stringify([context.tenantId,context.patientId,context.visitId]);}
function currentAmendmentDraft(visit=activeVisit){
 if(visitAmendmentOwner!==me)clearVisitAmendmentDrafts();
 return visit?visitAmendmentDrafts.get(amendmentContextKey({tenantId:me?.tenant_id,patientId:selected,visitId:visit.id})):undefined;
}
function visitAmendmentsHaveDrafts(){if(visitAmendmentOwner!==me)clearVisitAmendmentDrafts();return visitAmendmentDrafts.size>0;}
function amendmentValues(form){const values=formData(form);return {reason:values.reason||'',text:values.text||''};}
function sameAmendmentValues(a,b){return a.reason===b.reason&&a.text===b.text;}
function captureVisitAmendmentDraft(){
 if(visitAmendmentOwner!==me)clearVisitAmendmentDrafts();
 const form=$('amendment-form'),context=form&&visitAmendmentContexts.get(form);
 if(!context||context.identity!==me||context.tenantId!==me?.tenant_id)return;
 const values=amendmentValues(form),key=amendmentContextKey(context);
 if(values.reason||values.text)visitAmendmentDrafts.set(key,{...context,values});else visitAmendmentDrafts.delete(key);
 updateVisitAmendmentStatus();
}
function currentAmendmentContext(form){
 const context=form&&visitAmendmentContexts.get(form);
 return context&&context.identity===me&&context.tenantId===me?.tenant_id&&context.patientId===selected&&context.visitId===activeVisit?.id&&canAmendNote(activeVisit)&&$('amendment-form')===form?context:null;
}
function updateVisitAmendmentStatus(){
 const form=$('amendment-form'),context=currentAmendmentContext(form),status=$('amendment-draft-status');if(!context||!status)return;
 const draft=visitAmendmentDrafts.get(amendmentContextKey(context)),stale=draft&&context.version!==activeVisit.version;
 status.textContent=stale?'This visit changed. Review the signed note and its corrections before signing.':draft?'Draft saved in this tab.':'Your signed correction will appear below the original note.';
 const launch=$('visit-editor')?.querySelector?.('[data-action="focus-amendment"]');
 if(launch)launch.textContent=draft?'Continue correction':'Add correction';
 const review=$('amendment-review-current');if(review){review.hidden=!stale;review.dataset.version=String(activeVisit.version);}
 const discard=$('amendment-discard');if(discard)discard.hidden=!draft;
 const submit=$('amendment-submit');if(submit)submit.disabled=stale;
}
function focusVisitAmendment(){
 const form=$('amendment-form');if(!currentAmendmentContext(form))return;
 setEncounterSection('documentation');alignChartContent();
 form.hidden=false;
 if(typeof encounterContentScroll==='function')encounterContentScroll(form);
 form.elements.reason.focus({preventScroll:true});
}
function reviewVisitAmendmentVersion(button){
 const form=$('amendment-form'),context=currentAmendmentContext(form);
 if(!context)return;
 // The encounter page stays on the current record; a stale review only re-confirms a draft against it.
 if(Number(button.dataset.version)!==activeVisit.version)return;
 captureVisitAmendmentDraft();context.version=activeVisit.version;form.dataset.version=String(context.version);
 const draft=visitAmendmentDrafts.get(amendmentContextKey(context));if(draft)draft.version=context.version;
 updateVisitAmendmentStatus();form.elements.text.focus();
}
async function discardVisitAmendmentDraft(){
 const form=$('amendment-form'),context=currentAmendmentContext(form);if(!context)return;
 captureVisitAmendmentDraft();const key=amendmentContextKey(context),draft=visitAmendmentDrafts.get(key);if(!draft)return;
 if(!await confirmAction('Only this unsaved correction will be removed. The signed note and recorded amendments stay unchanged.',{title:'Discard unsaved correction?',confirmLabel:'Discard correction',tone:'danger'}))return;
 if(!currentAmendmentContext(form)||context.identity!==me)return;
 if(!sameAmendmentValues(amendmentValues(form),draft.values))throw new Error('Your correction changed. Review it before discarding.');
 form.elements.reason.value='';form.elements.text.value='';visitAmendmentDrafts.delete(key);renderVisit(false);focusVisitAmendment();
}
async function submitVisitAmendment(form){
 const context=currentAmendmentContext(form);if(!context)throw new Error('Open the signed visit before signing this correction.');
 if(context.version!==activeVisit.version)throw new Error('Review the changed visit and confirm its current version before signing this correction.');
 captureVisitAmendmentDraft();
 const submitted=amendmentValues(form),key=amendmentContextKey(context),version=context.version;
 const visit=await api(`/api/v1/visits/${context.visitId}/amendments`,'POST',submitted,version);
 if(context.identity!==me||context.tenantId!==me?.tenant_id)return;
 if(visit.id!==context.visitId||visit.patient_id!==context.patientId)throw new Error('The saved amendment came back against the wrong visit. Reload the original chart.');
 const visibleForm=$('amendment-form'),visibleContext=currentAmendmentContext(visibleForm),visible=visibleContext&&amendmentContextKey(visibleContext)===key;
 const retained=visitAmendmentDrafts.get(key),latest=visible?amendmentValues(visibleForm):retained?.values||submitted;
 if(sameAmendmentValues(latest,submitted)){
  visitAmendmentDrafts.delete(key);
  if(visible){visibleForm.elements.reason.value='';visibleForm.elements.text.value='';}
 }else{
  visitAmendmentDrafts.set(key,{...context,version:(retained?.version??version)===version?visit.version:retained.version,values:latest});
 }
 if(!visible)return;
 visibleContext.version=visitAmendmentDrafts.get(key)?.version??visit.version;visibleForm.dataset.version=String(visibleContext.version);
 await selectPatient(context.patientId,context.visitId);
 if(context.identity===me&&selected===context.patientId&&activeVisit?.id===context.visitId)notice('Amendment signed and appended. The original note is unchanged.');
}
function captureVisitDrafts(includeRooming=true){
 captureVisitAmendmentDraft();
 if(typeof captureClaimDraft==='function')captureClaimDraft();
 if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
 if(typeof capturePatientPaymentPlanDrafts==='function')capturePatientPaymentPlanDrafts();
 if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
 if(typeof capturePortalStaffDrafts==='function')capturePortalStaffDrafts();
 if(typeof captureSupportDrafts==='function')captureSupportDrafts();
 if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
 if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
 if(typeof captureDocumentDraft==='function')captureDocumentDraft();
 if(typeof captureReferralDraft==='function')captureReferralDraft();
 if(typeof captureOrderDiagnosisLinkDraft==='function')captureOrderDiagnosisLinkDraft();
 if(typeof captureAccountDiagnosisLinkDraft==='function')captureAccountDiagnosisLinkDraft();
 if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft(); if(typeof captureImmunizationDraft==='function')captureImmunizationDraft();
 if(includeRooming&&typeof captureRoomingDraft==='function')captureRoomingDraft();
 if(includeRooming&&typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
 if(typeof captureCheckoutDraft==='function')captureCheckoutDraft();
 if(!activeVisit||activeVisit.status==='signed')return;
 const key=activeVisit.id, draft=visitDrafts.get(key)||{patientId:selected};
 for(const kind of ['note','vitals']){
  const form=$(kind+'-form');if(!form||form.dataset?.visitId!==key)continue;
  const values=formData(form),saved=kind==='vitals'?vitalsToForm(activeVisit.vitals):activeVisit[kind]||{};
  const changed=Object.entries(values).some(([k,v])=>kind==='vitals'?(v===''?null:Number(v))!==(saved[k]??null):noteFieldText(k,v)!==noteFieldText(k,saved[k]));
  if(changed)draft[kind]={values,version:Number(form.dataset.version),...(kind==='note'?{base:draft.note?.base??noteSavedText(saved)}:{})};else delete draft[kind];
 }
 if(draft.note||draft.vitals)visitDrafts.set(key,draft);else visitDrafts.delete(key);
 updateDraftStatus();
}
// Saving vitals, intake or diagnoses moves the encounter's shared version without touching the note text, so the note being written still applies to the current record.
function followUnchangedNote(){
 const draft=visitDrafts.get(activeVisit?.id),form=$('note-form');
 if(!draft?.note||draft.note.version===activeVisit.version||draft.note.base!==noteSavedText(activeVisit.note))return;
 draft.note.version=activeVisit.version;if(form?.dataset?.visitId===activeVisit.id)form.dataset.version=String(activeVisit.version);
}
function updateDraftStatus(){
 if(!activeVisit)return;
 followUnchangedNote();
 const draft=visitDrafts.get(activeVisit.id),status=$('visit-draft-status'),conflict=$('note-conflict'),copy=$('note-saved-copy');
 const parts=['note','vitals'].filter(k=>draft?.[k]),noteChanged=Boolean(draft?.note)&&draft.note.version!==activeVisit.version,by=activeVisit.note?.saved_by;
 const changed=noteChanged?`${noteSaverName(activeVisit.note)||'Someone else'} saved this note${by?.at?' on '+date(by.at):''} while you were writing. Nothing was overwritten. Your text is still here and has not been saved.`:'';
 // The choice sits with the note itself, where the person is writing.
 if(conflict&&conflict.isConnected!==false){conflict.hidden=!noteChanged;conflict.innerHTML=noteChanged?`<p>${esc(changed)}</p><div class="actions"><button type="button" data-action="show-saved-note" aria-controls="note-saved-copy">See the saved note</button><button type="button" data-action="keep-note-draft">Keep my text</button><button type="button" data-action="discard-visit-draft">Use the saved note</button></div>`:'';}
 if(copy&&copy.isConnected!==false&&!noteChanged){copy.hidden=true;copy.innerHTML='';}
 if(!status)return;
 status.textContent=parts.length?`Unsaved ${parts.join(' and ')} edits retained in this tab. Save before closing or reloading.`:'';
 if(noteChanged)status.textContent+=' '+changed;
 if(draft?.vitals&&draft.vitals.version!==activeVisit.version)status.textContent+=' The saved visit changed. Your edits are preserved; compare them with the current record before saving.';
 if(parts.length)status.innerHTML+=' <button type="button" class="text-button" data-action="discard-visit-draft">Discard unsaved edits and use saved record</button>';
}
// The saved note, read-only, beside the text still being written.
function showSavedNoteCopy(){
 const copy=$('note-saved-copy');if(!copy||!activeVisit)return;
 if(!copy.hidden){copy.hidden=true;copy.innerHTML='';return;}
 const note=activeVisit.note||{},by=note.saved_by;
 copy.innerHTML=`<h4>Saved note${by?.at?` · ${esc(noteSaverName(note))}, ${esc(date(by.at))}`:''}</h4>${noteSectionKeys.filter(key=>String(note[key]??'').trim()).map(key=>`<p class="muted">${key[0].toUpperCase()+key.slice(1)}</p><p class="note-text">${esc(note[key])}</p>`).join('')||'<p class="muted">The saved note is empty.</p>'}<p class="muted">Copy anything you need into your text, then choose Keep my text and save.</p>`;
 copy.hidden=false;
}
// An explicit choice: the text in this tab replaces the saved note on the next save.
function keepNoteDraft(){
 const draft=visitDrafts.get(activeVisit?.id),form=$('note-form');if(!draft?.note||form?.dataset?.visitId!==activeVisit.id)return;
 draft.note.version=activeVisit.version;draft.note.base=noteSavedText(activeVisit.note);form.dataset.version=String(activeVisit.version);updateDraftStatus();
 const retry=form.querySelector?.('[data-note-autosave-retry]');
 if(retry){retry.hidden=false;retry.textContent='Save my text';}
 notice(retry?'Choose Save my text to keep your version.':'Your text is kept. Save note to replace the saved note with it.');
}
// Saves the note. If the encounter moved on, the current record is loaded first: a change that left the note text alone is retried once, a change to the note itself is shown and never overwritten.
async function saveVisitNote(form,data){
 // A draft is kept with any section filled; a note with nothing in it says so beside the buttons.
 if(!hasVisitNoteText(form)){showVisitNoteMessage('Write something in the note before saving.');return;}
 hideVisitNoteMessage();
 const id=activeVisit.id,identity=me;
 for(let attempt=0;;attempt++){
  try{const saved=await api(`/api/v1/visits/${id}/note`,'PUT',noteRequestBody(data),Number(form.dataset.version));if(me!==identity||activeVisit?.id!==id)return;rememberVisit(saved,'note');break;}
  catch(error){
   if(error.status!==409||error.code!=='conflict'||me!==identity||activeVisit?.id!==id)throw error;
   const opened=activeVisit,current=await api(`/api/v1/visits/${id}`);
   if(me!==identity||activeVisit?.id!==id)return;
   if(current.status==='signed'){rememberVisit(current);throw new Error('This note was signed while you were writing, so your text was not saved. Copy anything you still need, then reload the patient.');}
   const held=visitDrafts.get(id)||{patientId:selected},base=held.note?.base??noteSavedText(opened.note);
   held.note={values:held.note?.values||data,version:held.note?.version??Number(form.dataset.version),base};visitDrafts.set(id,held);
   rememberVisit(current);
   if(attempt===0&&Number(form.dataset.version)===current.version)continue;
   throw new Error(`${noteSaverName(current.note)||'Someone else'} saved this note while you were writing. Nothing was overwritten and your text is still here.`);
  }
 }
 if(typeof visitNoteSaved==='function')visitNoteSaved(activeVisit);
 if(typeof diagnosisSuggestCheck==='function')diagnosisSuggestCheck();
}

let me, patients = [], cursor, selected, workspace, activeVisit, startupRequest, busy = false;
async function api(path, method = 'GET', body, version) {
  const requestIdentity = me;
  const headers = {};
  if(me?.tenant_id&&me?.user_id)headers['X-SunCharts-Staff-Context']=`${me.tenant_id}:${me.user_id}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (version !== undefined) headers['If-Match'] = `"${version}"`;
  let response;
  try { response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials:'same-origin', cache:'no-store'}); }
  catch { throw new Error(method === 'GET' ? 'Connection interrupted. Please try loading again.' : 'Connection interrupted. This change may have saved. Reload the patient before trying again.'); }
  const data = await response.json().catch(() => ({}));
  if(me!==requestIdentity)throw new Error('Staff account changed. Sign in again to continue.');
  if(response.status===409&&data.message==='Staff account changed. Sign in again to continue.'){signInScreen();$('login-error').textContent=data.message;const changed=new Error(data.message);changed.signedOut=true;throw changed;}
  if (response.status === 401) { signInScreen(Boolean(requestIdentity)); const out=new Error('Please sign in to continue.');out.signedOut=true;throw out; }
  if(!response.ok&&/credential key missing; restore the private server key from backup/i.test(data.message||'')){console.error(data.message);data.message="Claims can't be sent yet: the clearinghouse connection is not set up.";}
  if (!response.ok) { const error=new Error((data.message==='ready for clinician requires chief complaint and medication/allergy review'?'Rooming not finished: add the chief complaint and tick medications and allergies reviewed.':data.message) || (response.status === 409 ? 'This encounter changed. Reload it before saving.' : 'Unable to complete this action. Please check your entries.'));error.status=response.status;error.code=data.error;throw error; }
  // A save anywhere may change what the open chart's banner shows.
  if(method!=='GET'&&typeof patientBannerChanged==='function')patientBannerChanged();
  return data;
}
function signInScreen(sessionEnded = false) {
  startupRequest=undefined;
  if(typeof clearFramePatients==='function')clearFramePatients();
  if(typeof clearAutoRefreshSession==='function')clearAutoRefreshSession();
  if(typeof clearScheduleSession==='function')clearScheduleSession();
  if(typeof clearClaimDrafts==='function')clearClaimDrafts();
  if(typeof clearBillingChargeDrafts==='function')clearBillingChargeDrafts();
  if(typeof clearWorkspaceAccessSession==='function')clearWorkspaceAccessSession();
  if(typeof clearStudioAccessSession==='function')clearStudioAccessSession();
  if(typeof clearStudioWorkspaceSession==='function')clearStudioWorkspaceSession();
  if(typeof clearSunSession==='function')clearSunSession();
  if(typeof clearCardReadersSession==='function')clearCardReadersSession();
 if(typeof clearTerminologySession==='function')clearTerminologySession();
  if(typeof clearSunEventsSession==='function')clearSunEventsSession();
  if(typeof clearPrescribingSession==='function')clearPrescribingSession();
  if(typeof clearPortalStaffSession==='function')clearPortalStaffSession();
  if(typeof clearConnectUpdatesSession==='function')clearConnectUpdatesSession();
  if(typeof clearSupportSession==='function')clearSupportSession();
  if(typeof clearConnectionStatusSession==='function')clearConnectionStatusSession();
  if(typeof clearPatientIdentitySession==='function')clearPatientIdentitySession();
  if(typeof clearPatientLifecycleSession==='function')clearPatientLifecycleSession();
  if(typeof clearPatientBannerSession==='function')clearPatientBannerSession();
  if(typeof clearReferralDeliverySession==='function')clearReferralDeliverySession();
  if(typeof clearDocumentsSession==='function')clearDocumentsSession();
  if(typeof clearReferralSession==='function')clearReferralSession();
  if(typeof resetOrderDiagnosisLinkDrafts==='function')resetOrderDiagnosisLinkDrafts();
  if(typeof resetAccountDiagnosisLinkDrafts==='function')resetAccountDiagnosisLinkDrafts();
  if(typeof clearHealthHistorySession==='function')clearHealthHistorySession(); if(typeof clearImmunizationSession==='function')clearImmunizationSession();
  visitDrafts.clear();
  if(typeof clearVisitNoteSession==='function')clearVisitNoteSession();
  clearVisitAmendmentDrafts();
  if(typeof roomingDrafts!=='undefined'){roomingDrafts.clear();roomingPending.clear();roomingUnfinished.clear();roomingGeneration++;}
  if(typeof visitDiagnosisDrafts!=='undefined'){visitDiagnosisDrafts.clear();visitDiagnosisStates.clear();visitDiagnosisPending.clear();visitDiagnosisGeneration++;}
  if(typeof practiceAdminGeneration!=='undefined'){practiceAdminState=null;practiceAdminGeneration++;}
  if(typeof checkoutDrafts!=='undefined'){checkoutDrafts.clear();checkoutStates.clear();checkoutGeneration++;checkoutState=undefined;checkoutContext=undefined;}
  patientWorkspaceGeneration++;patientDirectoryPreference=storedPatientDirectoryPreference();
  me = undefined; patients = []; cursor = undefined; selected = undefined; workspace = undefined; activeVisit = undefined;
  closeNavigation();
  $('app').hidden = true; $('app').setAttribute('inert','');
  $('workspace-startup').hidden = true; $('login-screen').hidden = false;
  $('login-error').textContent='';
  if($('login-signed-out'))$('login-signed-out').textContent=sessionEnded?'Your session ended. Sign in again to carry on.':'';
  $('patients').replaceChildren(); $('chart').replaceChildren(); $('patient-form').reset(); $('patient-form').hidden=true;
  $('search').value=''; $('notice').hidden=true; $('tools').replaceChildren(); $('tools').hidden=true; $('clinical-workspace').hidden=true;
  postSignReminder=null;
  void refreshSignInMode();
}
async function refreshSignInMode(){
 try{
  const mode=await fetch('/auth/mode',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject());
  const connected=mode.mode==='connect';$('local-login-fields').hidden=connected;$('connect-login').hidden=!connected;
  for(const input of $('local-login-fields').querySelectorAll('input'))input.required=!connected;
  if(connected){$('connect-login').href=mode.staff_sign_in_url;$('login-description').textContent='Use your SunCharts Connect passkey or emailed sign-in link.';}
  else{$('connect-login').href='#';$('login-description').textContent='Sign in to your self-hosted SunCharts EHR.';}
 }catch{}
}
function notice(message, error = false) { $('notice').textContent=message; $('notice').className=`notice${error?' error':''}`; $('notice').hidden=false; if(typeof motionNotice==='function')motionNotice($('notice'),error); }
async function run(action) {
  if (busy) return;
  busy=true; $('notice').hidden=true;
  $('shell-loading').hidden=false;
  document.documentElement?.classList.add('app-busy');
  const buttons = Array.from(document.querySelectorAll('button'), b=>[b,b.disabled]);
  buttons.forEach(([b])=>{b.disabled=true;});
  // A successful save in any screen releases the shared auto-refresh quiet
  // window, so open revenue screens show the new data within a second.
  let saved=false;
  try { await action(); saved=true; } catch(e) { if(!e.signedOut){if (me) notice(e.message,true); else $('login-error').textContent=e.message;} }
  finally { if(saved&&typeof autoRefreshTickSoon==='function')autoRefreshTickSoon(); busy=false;$('shell-loading').hidden=true;document.documentElement?.classList.remove('app-busy');buttons.forEach(([b,disabled])=>{b.disabled=disabled;});if($('encounter-stepper')&&typeof encounterStepsSchedule==='function')encounterStepsSchedule();if(typeof paintInsuranceCopayModal==='function')paintInsuranceCopayModal();window.SunChartsDialog?.restoreFocus(); }
}
async function enter() {
  const identity=me=await api('/auth/me');
  organizeWorkspaceNavigation();
  if($('frame-user-initials'))$('frame-user-initials').textContent=(me.display_name||me.email||'SC').split(/[\s@]+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
  if(typeof loadPracticeWorkspaceSettings==='function')await loadPracticeWorkspaceSettings();
  if(me!==identity)return;
  if($('nav-portal'))$('nav-portal').hidden=!['owner','clinician','front_desk'].includes(me.role)||$('nav-portal').dataset.workspaceHidden==='true';
  if($('nav-communications'))$('nav-communications').hidden=!['owner','clinician','nurse','medical_assistant','front_desk'].includes(me.role);
  if($('nav-ai-review'))$('nav-ai-review').hidden=!['owner','clinician','nurse','medical_assistant','front_desk'].includes(me.role);
  const roleLabel=me.delegated_role==='partner_admin'
    ?'Partner administrator (delegated)'
    :me.delegated_role==='workflow_manager'?'Partner workflow manager'
    :({owner:'Practice owner',clinician:'Clinician',front_desk:'Front desk',read_only:'Read only',nurse:'Nurse',medical_assistant:'Medical assistant',partner_support:'Partner support · read only'})[me.role]||me.role.replaceAll('_',' ');
  const userLabel=me.display_name||me.email||'Signed-in user';
  $('sidebar-user').textContent=userLabel;
  $('sidebar-user').title=me.email||userLabel;
  $('sidebar-role').textContent=roleLabel;
  $('identity-name').textContent=userLabel;
  $('identity-role').textContent=roleLabel;
  $('identity').title=me.email&&me.email!==userLabel?`${userLabel} · ${me.email} · ${roleLabel}`:`${userLabel} · ${roleLabel}`;
  $('identity').setAttribute('aria-label',`Signed in as ${userLabel}, ${roleLabel}`);
  $('nav-migration').hidden=me.role!=='owner'||$('nav-migration').dataset.workspaceHidden==='true';
  if($('nav-admin'))$('nav-admin').hidden=me.role!=='owner';
  if($('nav-partners'))$('nav-partners').hidden=me.role!=='owner';
  if(typeof applyWorkspaceAccessVisibility==='function')applyWorkspaceAccessVisibility();
  if(me.role==='partner_support')notice('Delegated partner support session. Clinical and administrative changes are disabled.');
  // Render the chosen workspace at its normal size while the startup screen is active.
  $('app').hidden=false;
  await openInitialWorkspace();
}
async function openInitialWorkspace(){
  if(typeof finishConnectOnboarding==='function'&&await finishConnectOnboarding())return;
  if (new URLSearchParams(location.search).has('oauth_request')) { await showConsent(); return; }
  if(new URLSearchParams(location.search).has('payment_membership')&&typeof openPatientMembershipReturn==='function'){await openPatientMembershipReturn(new URLSearchParams(location.search).get('payment_membership'));return;}
  if(new URLSearchParams(location.search).has('invoice_checkout')&&typeof openInvoiceCheckoutReturn==='function'){await openInvoiceCheckoutReturn(new URLSearchParams(location.search).get('invoice_checkout'));return;}
  if(new URLSearchParams(location.search).has('payment_setup')&&typeof openPatientPaymentSetupReturn==='function'){
    await openPatientPaymentSetupReturn(new URLSearchParams(location.search).get('payment_setup'));return;
  }
  if(new URLSearchParams(location.search).has('copay_checkout')&&typeof openHostedCopayReturn==='function'){
    await openHostedCopayReturn(new URLSearchParams(location.search).get('copay_checkout'));return;
  }
  const paymentId=new URLSearchParams(location.search).get('payment_checkout');
  if(paymentId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId)&&typeof openPaymentStatus==='function'){
    await showBillingQueue();await openPaymentStatus(paymentId);return;
  }
  if(new URLSearchParams(location.search).get('payment_settings')==='1'&&typeof openPaymentSettings==='function'){
    await showBillingQueue();await openPaymentSettings();return;
  }
  if(new URLSearchParams(location.search).get('open')==='claimmd'&&typeof showEdiWorkspace==='function'){
    await showEdiWorkspace();return;
  }
  if(new URLSearchParams(location.search).get('open')==='sun'&&typeof showSunPage==='function'){await showSunPage();return;}
  if(new URLSearchParams(location.search).get('open')==='workflow-studio'&&typeof showWorkflowStudio==='function'){
    await showWorkflowStudio();return;
  }
  const batchId=new URLSearchParams(location.search).get('era_batch');
  if (batchId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) {
    await showClaimsWorkspace();
    await showEraBatch(batchId);
    return;
  }
  if(typeof restoreInitialWorkspaceRoute==='function'&&await restoreInitialWorkspaceRoute())return;
  await showInitialWorkspaceLanding();
}
async function showInitialWorkspaceLanding(){
  if(typeof showPracticeWorkspace==='function'&&(typeof workspaceModuleAllowed!=='function'||workspaceModuleAllowed('practice')))await showPracticeWorkspace();
  else if(typeof showAllowedWorkspaceLanding==='function')await showAllowedWorkspaceLanding();
}
function renderPatients() {
  const q=$('search').value.trim().toLowerCase();
  const filtered=patients.filter(p=>`${p.given_name} ${p.family_name} ${p.mrn}`.toLowerCase().includes(q));
  $('patient-count').textContent=patients.length;
  document.querySelectorAll('[data-directory-status]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.directoryStatus===(typeof patientDirectoryStatus==='string'?patientDirectoryStatus:'active'))));
  $('patients').innerHTML=(typeof patientDirectoryMissingMarkup==='function'?patientDirectoryMissingMarkup():'')+`<table class="directory-table"><caption class="sr-only">Patients</caption><thead><tr><th scope="col">Name</th><th scope="col">DOB (age)</th><th scope="col">MRN</th></tr></thead><tbody>${filtered.map(p=>`<tr data-directory-patient="${esc(p.id)}" class="${p.id===selected?'selected':''}"><td><button type="button" class="text-button" data-patient="${esc(p.id)}">${esc(p.family_name)}, ${esc(p.given_name)}</button>${p.archived?'<small>Archived</small>':''}</td><td>${esc(displayBirthDate(p.birth_date))}${typeof displayAge==='function'&&displayAge(p.birth_date)!==null?` (${esc(displayAge(p.birth_date))})`:''}</td><td class="record-id">${esc(p.mrn)}</td></tr>`).join('')||'<tr><td colspan="3">No patients found.</td></tr>'}</tbody></table>`;
  $('load-more').hidden=!cursor;
}
// Clinical content stays in memory, scoped to the current authenticated session.
const patientChartCache=new Map(),patientChartAccessKeys=new WeakMap(),patientTabReads=new Map();
let patientChartCacheOwner;
function patientChartAccess(){
 const allowed=resource=>typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);
 const clinical=allowed('clinical'),billing=allowed('billing'),claims=allowed('claims'),migration=allowed('migration'),workflows=allowed('workflows');
 return {billing,source:clinical&&billing&&claims&&migration,key:[clinical,billing,claims,migration,workflows].join(':')};
}
function patientChartAccessMatches(chart,identity,access){
 const saved=patientChartAccessKeys.get(chart);
 return saved?.identity===identity&&saved?.key===access;
}
function readPatientWorkspace(id,identity,access,share){
 const path=`/api/v1/patients/${id}/workspace`;
 if(!share)return api(path);
 const previous=patientTabReads.get(id);
 if(previous?.identity===identity&&previous.access===access)return previous.promise;
 const entry={identity,access,promise:api(path).finally(()=>{if(patientTabReads.get(id)===entry)patientTabReads.delete(id);})};
 patientTabReads.set(id,entry);
 return entry.promise;
}
function rememberPatientChart(){
 if(patientChartCacheOwner!==me){patientChartCache.clear();patientChartCacheOwner=me;}
 if($('clinical-workspace').hidden||!selected||workspace?.patient?.id!==selected)return;
 patientChartCache.set(selected,{workspace,billingPayers,section:chartSection,step:encounterSection,
  visit:activeVisit?.id||null,focus:typeof frameClinicalFocus==='undefined'?'problem':frameClinicalFocus,
  banner:typeof patientBanner==='undefined'?null:{...patientBanner},nodes:Array.from($('chart').childNodes),
  scroll:{left:window.scrollX||0,top:window.scrollY||0}});
}
function revealPatientChart(){
 $('clinical-workspace').hidden=false;$('tools').hidden=true;
 if(setPage.last!=='Patients & encounters')setPage('Patients & encounters');
 setPatientDirectoryVisible(false);
 $('clinical-workspace').classList.add('frame-chart-open');
}
function patientChartSkeleton(){
 const bar=kind=>`<span class="skeleton skeleton-${kind}" aria-hidden="true"></span>`;
 return `<section id="patient-banner" class="patient-banner chart-skeleton-header" aria-label="Opening chart">${bar('heading')}${bar('line')}</section><div class="chart-context chart-skeleton-menu" aria-hidden="true">${bar('row').repeat(9)}</div><section class="panel chart-skeleton-content" role="status"><span class="sr-only">Opening chart</span>${bar('heading')}${bar('row').repeat(6)}</section>`;
}
async function selectPatient(id, keepVisit, stillCurrent=()=>true, destination=null) {
  const openingIdentity=me;
  const openingGeneration=++patientWorkspaceGeneration;
  captureVisitDrafts();rememberPatientChart();
  const previousChartVisit=selected===id?activeVisit:null;
  const access=patientChartAccess(),cachedEntry=patientChartCache.get(id);
  const cached=cachedEntry&&patientChartAccessMatches(cachedEntry.workspace,openingIdentity,access.key)?cachedEntry:null;
  const accessChanged=Boolean(workspace&&patientChartAccessKeys.has(workspace)&&!patientChartAccessMatches(workspace,openingIdentity,access.key));
  const switching=id!==selected||!workspace||$('clinical-workspace').hidden||accessChanged;
  const current=()=>me===openingIdentity&&openingGeneration===patientWorkspaceGeneration&&stillCurrent()&&patientChartAccess().key===access.key;
  if(cached&&switching&&!destination?.deferPresentation){
   workspace=cached.workspace;billingPayers=cached.billingPayers;selected=id;
   chartSection=destination?.section||(keepVisit?'visits':cached.section);encounterSection=destination?.step||(keepVisit&&keepVisit!==cached.visit?'visit':cached.step);
   activeVisit=workspace.visits.find(v=>v.id===(keepVisit===undefined?cached.visit:keepVisit));
   if(typeof resetInsuranceCopayAppointment==='function')resetInsuranceCopayAppointment(id,previousChartVisit,activeVisit);
   if(typeof frameClinicalFocus!=='undefined')frameClinicalFocus=destination?.focus||cached.focus;
   if(cached.banner&&typeof patientBanner!=='undefined'){clearTimeout(patientBanner.timer);patientBanner={...cached.banner,timer:null,request:null};}
   $('chart').replaceChildren(...cached.nodes);revealPatientChart();applyChartSection();
   window.scrollTo({...cached.scroll,behavior:'instant'});
   if(typeof motionChartIn==='function')motionChartIn();
   if(typeof frameRenderPatients==='function')frameRenderPatients();
  }else if(!cached&&switching&&!destination?.deferPresentation){
   selected=id;workspace=undefined;activeVisit=undefined;chartSection=keepVisit?'visits':'overview';
   $('chart').innerHTML=patientChartSkeleton();revealPatientChart();
   if(typeof frameRenderPatients==='function')frameRenderPatients();
  }
  // Publish one complete chart only after every patient-scoped read succeeds.
  let next,payers;
  try {
   next=await readPatientWorkspace(id,openingIdentity,access.key,destination?.tabSelection);
   if(!current())return;
   const [history,clinical,labs,billing,loadedPayers,demographics]=await Promise.all([
    access.source?api(`/api/v1/patients/${id}/history`):null,api(`/api/v1/patients/${id}/clinical`),
    api(`/api/v1/patients/${id}/orders`),access.billing?api(`/api/v1/patients/${id}/billing`):null,
    access.billing?api('/api/v1/billing/payers'):{items:[]},api(`/api/v1/patients/${id}/demographics`)
   ]);
   if(!current())return;
   next.history=history?.items??null;next.clinical=clinical;next.labs=labs;next.billing=billing;next.demographics=demographics;
   payers=loadedPayers;
  }catch(error){
   if(!current())return;
   if(!destination?.deferPresentation&&selected===id&&!workspace){
    const host=$('chart');
    host.innerHTML=`<section class="panel" role="alert"><h2>Patient chart could not load</h2><button type="button" data-frame-retry="${esc(id)}">Retry</button></section>`;
    host.querySelector?.('[data-frame-retry]')?.addEventListener('click',()=>{
     if(!current())return;
     void selectPatient(id,keepVisit,stillCurrent,destination).catch(error=>notice(error.message,true));
    },{once:true});
   }
   throw error;
  }
  patientChartAccessKeys.set(next,{identity:openingIdentity,key:access.key});
  captureVisitDrafts(); // Include edits made while the chart reads were in flight.
  if(!cached&&switching){chartSection=destination?.section||(keepVisit?'visits':'overview');encounterSection=destination?.step||'visit';}
  if(keepVisit&&activeVisit?.id!==keepVisit){chartSection='visits';encounterSection='visit';}
  const previousVisit=selected===id?activeVisit:null;
  workspace=next;billingPayers=payers.items;selected=id;
  activeVisit=keepVisit===null ? undefined : keepVisit ? workspace.visits.find(v=>v.id===keepVisit) : cached ? workspace.visits.find(v=>v.id===(activeVisit?.id||cached.visit)) : workspace.visits.find(v=>v.status==='in_progress'&&v.clinician_id===me.user_id)||workspace.visits.find(v=>v.status==='in_progress');
  if(typeof resetInsuranceCopayAppointment==='function')resetInsuranceCopayAppointment(id,previousVisit,activeVisit);
  // Opening a different encounter retires the sign reminder; signing then re-opening the
  // same visit keeps it, because the charges may still be missing. 'id' here is the patient,
  // so compare against the encounter actually being opened, not the patient id.
  if(typeof postSignReminder!=='undefined'&&postSignReminder&&activeVisit?.id!==postSignReminder.visitId)postSignReminder=null;
  // A checkout return keeps its authorized status page until the appointment is verified.
  if(destination?.deferPresentation)return true;
  const retain=typeof motionRetainChart==='function'&&cached?motionRetainChart($('chart')):null;
  renderChart();if(retain)retain();revealPatientChart();
  if(typeof motionChartIn==='function'&&switching&&!cached)motionChartIn();
  if(typeof frameOpenPatient==='function')frameOpenPatient(workspace.patient);
  for(const key of patientChartCache.keys())if(!framePatients.some(p=>p.id===key))patientChartCache.delete(key);
  setPatientDirectoryVisible(false);if(!cached&&typeof alignChartContent==='function')alignChartContent();
  rememberPatientChart();
}

async function openPatientEncounter(id){
 const openingIdentity=me,openingPatient=selected,openingWorkspace=workspace;
 if(!openingPatient||!openingWorkspace?.visits?.some(visit=>visit.id===id))throw new Error('Choose an encounter from this patient’s history.');
 const openingGeneration=++patientWorkspaceGeneration;
 captureVisitDrafts();
 const visit=await api(`/api/v1/visits/${id}`);
 if(me!==openingIdentity||selected!==openingPatient||workspace!==openingWorkspace||openingGeneration!==patientWorkspaceGeneration)return;
 if(visit.id!==id||visit.patient_id!==openingPatient)throw new Error('This encounter does not belong to the selected patient.');
 captureVisitDrafts();rememberVisit(visit);
 chartSection='visits';
 encounterSection='visit';
 // Opening a different encounter retires the sign reminder; re-opening the same visit keeps it.
 if(typeof postSignReminder!=='undefined'&&postSignReminder&&postSignReminder.visitId!==id)postSignReminder=null;
 renderChart();rememberPatientChart();
 if(typeof alignChartContent==='function')alignChartContent();
}

const date = s => new Date(s).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
function renderChart() {
  captureVisitAmendmentDraft();
  if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
  if(typeof capturePatientLifecycleDraft==='function')capturePatientLifecycleDraft();
  if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
  if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
  if(typeof captureDocumentDraft==='function')captureDocumentDraft();
  if(typeof captureReferralDraft==='function')captureReferralDraft();
  if(typeof captureOrderDiagnosisLinkDraft==='function')captureOrderDiagnosisLinkDraft();
  if(typeof captureAccountDiagnosisLinkDraft==='function')captureAccountDiagnosisLinkDraft();
  if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft(); if(typeof captureImmunizationDraft==='function')captureImmunizationDraft();
  if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
  let tabs=[['overview','Summary'],['profile','Patient details'],['clinical','Clinical lists'],['care_pathways','Care pathways'],['prescribing','Prescribing'],['immunizations','Immunizations'],['functional_status','Functional status'],['specialty_care','Specialty care'],['history','Surgical & dental history'],['documents','Documents'],['referrals','Referrals'],['orders','Orders & results'],['visits','Encounters'],['checkout','Encounter summary and follow-up'],['billing','Financials'],['source','Source records']];
  if(typeof configuredChartTabs==='function')tabs=configuredChartTabs(tabs);
  if(tabs.some(([key])=>key==='billing'))tabs.splice(tabs.findIndex(([key])=>key==='billing'),0,['insurance','Insurance']);
  if(typeof chartCloseSheets==='function')chartCloseSheets();
  const stableBanner=$('patient-banner')?.classList.contains('chart-skeleton-header')?null:$('patient-banner'),stableNavigation=$('chart').querySelector('.chart-context:not(.chart-skeleton-menu)');
  $('chart').innerHTML=`<section id="patient-banner" class="patient-banner" aria-label="Patient summary">${typeof patientBannerMarkup==='function'?patientBannerMarkup():''}</section><div class="chart-context">${chartNavigation(tabs)}</div><div id="chart-content-top" aria-hidden="true"></div>
  <div id="record-context"></div>
  <section id="patient-lifecycle" class="panel" hidden></section>
  <div id="encounter-progress">${typeof postSignReminderMarkup==='function'?postSignReminderMarkup():''}${encounterWorkflow()}</div>
  <div id="encounter-start-editor"></div>
  ${chartOverview()}
  ${patientVitalsHistory()}
  <section id="patient-demographics"></section>
  <section id="patient-intake-panel" class="panel" tabindex="-1" hidden></section>
  <section id="functional-status-panel" class="panel" hidden></section>
  <section id="specialty-care-panel" class="panel" hidden></section>
  <section id="care-pathways-panel" class="panel care-pathways-panel" hidden></section>
  ${patientAppointmentWorkspace()}`;
  // Keep the header and left panel mounted while replacing patient/encounter content.
  const nextBanner=$('patient-banner'),nextNavigation=$('chart').querySelector('.chart-context');
  if(stableBanner){if(stableBanner.dataset.patientId!==selected)stableBanner.innerHTML=nextBanner.innerHTML;stableBanner.dataset.patientId=selected;nextBanner.replaceWith(stableBanner);}else if(nextBanner)nextBanner.dataset.patientId=selected;
  if(stableNavigation&&nextNavigation){
   const signature=host=>host.querySelector('.frame-chart-navigation')?.dataset.navigationSignature;
   if(stableNavigation.dataset.patientId!==selected||signature(stableNavigation)!==signature(nextNavigation))stableNavigation.innerHTML=nextNavigation.innerHTML;
   stableNavigation.dataset.patientId=selected;nextNavigation.replaceWith(stableNavigation);
  }else if(nextNavigation)nextNavigation.dataset.patientId=selected;
  // The encounter's own blocks live in one fixed-order row placed after every panel an inserted
  // module may bring, then re-placed before the renderers run; #encounter-progress and
  // #encounter-orders-actions keep the markup above, and #visit-editor, #encounter-revenue and
  // #visit-checkout find their existing hosts inside the row untouched.
  ensureVisitPageHost();
  if(typeof renderPrescribing==='function')void renderPrescribing(); renderClinical(); renderLabs(); renderBilling(); renderHistory(); if(typeof renderHealthHistory==='function')void renderHealthHistory(); if(typeof renderImmunizations==='function')void renderImmunizations(); if(typeof renderDocuments==='function')void renderDocuments(); if(typeof renderPatientIdentity==='function')void renderPatientIdentity(); if(typeof renderPatientLifecycle==='function')void renderPatientLifecycle(); if(typeof renderReferrals==='function')void renderReferrals(); if(typeof renderDemographics==='function')renderDemographics(selected,workspace.demographics); if(typeof renderPatientIntakePackets==='function')void renderPatientIntakePackets(); if(typeof renderSpecialtyPatientWorkspace==='function')void renderSpecialtyPatientWorkspace(); if(typeof renderCarePathways==='function'&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('workflows')))void renderCarePathways(); if(typeof renderPatientInsurance==='function')void renderPatientInsurance(); if(activeVisit) renderVisit(false); applyChartSection(); if(chartSection==='vitals')void loadPatientVitalsReadings(); if(typeof patientBannerChartRendered==='function')void patientBannerChartRendered();
}
function canRegisterPatient(){return ['owner','clinician','front_desk'].includes(me?.role)&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical','create'));}
function isRoomingStaff(){return ['nurse','medical_assistant'].includes(me?.role);}
// Vitals follow their own rule: rooming staff, the assigned or a covering clinician or
// owner, and an enabled front desk account. Front desk records vitals and nothing else.
// One compact summary line for the one-page visit: a measurement that was not taken is left out.
// The vitals the form holds, in display order; the labels also name the form's inputs.
const VISIT_VITAL_LABELS={systolic_mm_hg:'Systolic BP (mmHg)',diastolic_mm_hg:'Diastolic BP (mmHg)',heart_rate_bpm:'Heart rate (bpm)',temperature_c:'Temperature (°F)',weight_kg:'Weight (lb)',height_cm:'Height (in)',oxygen_saturation_pct:'Oxygen saturation (%)'};
// Match Vitals::validate after converting the entered units to the stored units.
const VISIT_VITAL_RANGES={systolic_mm_hg:[30,350],diastolic_mm_hg:[10,250],heart_rate_bpm:[10,350],temperature_c:[20,50],weight_kg:[0.1,700],height_cm:[10,300],oxygen_saturation_pct:[0,100]};
// Staff type temperature, weight and height in US units; the record keeps them in metric, as it
// always has. The form's boxes keep their record names and hold the US figure; it is converted
// when the form is filled from the record and when it is saved. Metric is kept to enough decimals
// that the US figure typed comes back exactly.
const VITAL_US_UNITS={temperature_c:{toUs:c=>c*9/5+32,toMetric:f=>(f-32)*5/9,places:1,metricPlaces:2,unit:'°F',metric:'°C'},weight_kg:{toUs:kg=>kg/0.45359237,toMetric:lb=>lb*0.45359237,places:1,metricPlaces:2,unit:'lb',metric:'kg'},height_cm:{toUs:cm=>cm/2.54,toMetric:inches=>inches*2.54,places:1,metricPlaces:1,unit:'in',metric:'cm'}};
function vitalRounded(value,places){return Number(Number(value).toFixed(places));}
function vitalToForm(key,value){const u=VITAL_US_UNITS[key];return u&&value!==''&&value!==null&&value!==undefined&&Number.isFinite(Number(value))?vitalRounded(u.toUs(Number(value)),u.places):value;}
function vitalFromForm(key,value){const u=VITAL_US_UNITS[key];return u?vitalRounded(u.toMetric(Number(value)),u.metricPlaces):Number(value);}
function vitalsToForm(vitals){return Object.fromEntries(Object.entries(vitals||{}).map(([key,value])=>[key,vitalToForm(key,value)]));}
function visitVitalsFeedback(form,{validateValues=false}={}){
 if(!canRecordVisitVitals(activeVisit)||form.dataset.visitId!==activeVisit.id)return null;
 const [systolic,diastolic]=['systolic_mm_hg','diastolic_mm_hg'];
 const fields=form.elements,issues={},measured={};
 const rangeMessage='Vitals outside supported recording ranges.';
 if(validateValues)form.vitalsValidated=true;
 for(const [key,[min,max]] of Object.entries(VISIT_VITAL_RANGES)){
  const field=fields[key];
  if(!form.vitalsValidated||!field||field.disabled)continue;
  if(field.validity?.badInput||field.validity?.stepMismatch){issues[key]=field.validationMessage||'Enter a valid number.';continue;}
  if(field.value==='')continue;
  const value=measured[key]=vitalFromForm(key,field.value);
  if(!Number.isFinite(value)||value<min||value>max)issues[key]=rangeMessage;
 }
 const hasSystolic=Boolean(fields[systolic]?.value),hasDiastolic=Boolean(fields[diastolic]?.value);
 if(hasSystolic&&!hasDiastolic&&!issues[diastolic])issues[diastolic]='Enter diastolic blood pressure.';
 if(hasDiastolic&&!hasSystolic&&!issues[systolic])issues[systolic]='Enter systolic blood pressure.';
 if(!issues[systolic]&&!issues[diastolic]&&measured[systolic]<=measured[diastolic]){
  issues[systolic]=rangeMessage;
  issues[diastolic]=rangeMessage;
 }
 for(const key of Object.keys(VISIT_VITAL_LABELS)){
  const field=fields[key],hint=form.querySelector?.(`[data-vital-issue="${key}"]`),issue=issues[key];
  if(issue){
   field?.setAttribute?.('aria-invalid','true');
   field?.setAttribute?.('aria-describedby','vital-issue-'+key);
  }else{
   field?.removeAttribute?.('aria-invalid');
   field?.removeAttribute?.('aria-describedby');
  }
  if(hint&&hint.textContent!==(issue||''))hint.textContent=issue||'';
  if(hint&&hint.hidden!==!issue)hint.hidden=!issue;
 }
 const key=Object.keys(VISIT_VITAL_LABELS).find(name=>issues[name]);
 if(!key)delete form.vitalsValidated;
 return key?{field:fields[key],message:issues[key]}:null;
}
function focusVisitVitalsIssue(field){
 if(!field)return;
 const withinEncounter=typeof encounterContentScroll==='function'&&!field.closest?.('dialog');
 if(withinEncounter)encounterContentScroll(field);
 field.focus?.({preventScroll:withinEncounter});
}
// A recorded measurement as it is read: the US figure first, the metric one beside it.
function vitalBothUnits(key,value){const u=VITAL_US_UNITS[key];return u?`${vitalToForm(key,value)} ${u.unit} (${vitalRounded(value,1)} ${u.metric})`:String(value);}
function visitVitalsSummary(vitals){
 const shown=value=>value!==undefined&&value!==null&&value!==''&&!(typeof value==='number'&&!Number.isFinite(value)),parts=[];
 if(shown(vitals.systolic_mm_hg)||shown(vitals.diastolic_mm_hg))parts.push(`BP ${esc(vitals.systolic_mm_hg??'—')}/${esc(vitals.diastolic_mm_hg??'—')}`);
 if(shown(vitals.heart_rate_bpm))parts.push(`Pulse ${esc(vitals.heart_rate_bpm)}`);
 if(shown(vitals.temperature_c))parts.push(`Temp ${esc(vitalBothUnits('temperature_c',vitals.temperature_c))}`);
 if(shown(vitals.oxygen_saturation_pct))parts.push(`SpO₂ ${esc(vitals.oxygen_saturation_pct)}%`);
 if(shown(vitals.weight_kg))parts.push(`Weight ${esc(vitalBothUnits('weight_kg',vitals.weight_kg))}`);
 if(shown(vitals.height_cm))parts.push(`Height ${esc(vitalBothUnits('height_cm',vitals.height_cm))}`);
 return parts.join(' · ');
}
function visitVitalsBlockMarkup(v,retained,vitalsLocked){
 // Compact on the one-page visit: recorded vitals show one summary line and an Edit vitals button
 // that opens today's form; with nothing recorded the form is shown as it has always been.
 // While the summary stands the form sits in a closed template, kept out of the page's ids so a
 // stale copy can never be captured or submitted; opening it moves the real form back into the page.
 // A retained tab edit keeps the open form, as it did before the page went compact.
 const version=retained?.vitals?.version??v.version;
 const form=`<form id="vitals-form" data-visit-id="${v.id}" data-version="${version}"><div class="form-grid vitals-grid">${Object.entries(VISIT_VITAL_LABELS).map(([key,label])=>`<div><label>${label}<input name="${key}" type="number" step="${['systolic_mm_hg','diastolic_mm_hg','heart_rate_bpm'].includes(key)?'1':'any'}" value="${esc(vitalsFormValues(v,retained)[key]??'')}" ${vitalsLocked?'disabled':''}></label><small id="vital-issue-${key}" data-vital-issue="${key}" role="status" hidden></small></div>`).join('')}</div>${vitalsLocked?'':'<details data-menu><summary>More ▾</summary><div class="frame-add-items"><button type="submit">Save vitals</button></div></details>'}</form>`;
 const summary=visitVitalsSummary(v.vitals||{});
 if(!summary||retained?.vitals)return form;
 return `<p id="visit-vitals-summary" class="visit-vitals-summary" role="status"><span>${summary}</span>${vitalsLocked?'':`<button type="button" class="text-button" data-action="edit-vitals">Edit vitals</button>`}</p><template id="vitals-form-holder">${form}</template>`;
}
// The values today's vitals form opens with: retained tab edits first, then the saved record.
function vitalsFormValues(v,retained){return retained?.vitals?.values||vitalsToForm(v.vitals);}
// The summary line, or today's form carrying a retained tab edit's values as it always has.
function visitVitalsMarkup(v,retained,vitalsLocked){
 return visitVitalsBlockMarkup(v,retained,vitalsLocked);
}
// The template holding today's vitals form while the summary line stands. In the real page a
// browser keeps template contents out of the document; here the markup is read out and swapped.
function vitalsFormHolder(){
 const holder=$('vitals-form-holder');
 return holder&&(holder.content?.querySelector?.('form')||typeof holder.innerHTML==='string')?holder:null;
}
function vitalsFormMarkupOf(holder){
 if(!holder)return '';
 return holder.content?.querySelector('form')?.outerHTML||String(holder.innerHTML||'');
}
// Opens the compact vitals editor: the form leaves its template, is put back where it was, and
// takes focus. A copy left over from an earlier render is replaced by this encounter's own form.
function openVitalsForm(){
 if(!canRecordVisitVitals(activeVisit))return;
 const holder=vitalsFormHolder(),markup=vitalsFormMarkupOf(holder);
 if(!markup.includes('id="vitals-form"'))return;
 const stale=$('vitals-form'),form=markup.slice(markup.indexOf('<form'),markup.lastIndexOf('</form>')+7);
 const host=document.createElement('div');host.innerHTML=form;const opened=host.querySelector('form');
 if(!opened)return;
 if(stale)stale.replaceWith(opened);else holder.replaceWith(opened);
 visitVitalsFeedback(opened);
 opened.querySelector('input')?.focus?.({preventScroll:true});
}
// A signed note reads as a record: each part that was written, as text. Empty parts are left out.
function visitNoteReadMarkup(note){
 const parts=noteSectionKeys.map(key=>[key[0].toUpperCase()+key.slice(1),String(note?.[key]??'').trim()]).filter(([,text])=>text);
 if(!parts.length)return '<p class="muted note-read-empty">No note text was written for this encounter.</p>';
 return `<dl class="note-read">${parts.map(([label,text])=>`<dt>${esc(label)}</dt><dd class="note-text">${esc(text)}</dd>`).join('')}</dl>`;
}
function canRecordVisitVitals(v){return v?.status==='in_progress'&&clinicalAccess('edit')&&(isRoomingStaff()||me?.role==='front_desk'||(['owner','clinician'].includes(me?.role)&&(v.clinician_id===me.user_id||!me?.delegated)));}
function renderVisit(activate=true) {
  captureVisitAmendmentDraft();
  if(typeof roomingRememberPanel==='function')for(const panel of ['[data-rooming-review]','[data-rooming-vitals-review]'])roomingRememberPanel($('visit-rooming')?.closest('#encounter-rooming-vitals')?.querySelector(panel));
  if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
  if(typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
  if(activate){chartSection='visits';}
  followUnchangedNote();
  const v=activeVisit, draft=visitDrafts.get(v.id), retained=draft?.patientId===selected&&v.status!=='signed'?draft:null, note=retained?.note?.values||v.note||{}, noteSource=noteSourceText(retained?.note?.values?retained.note.values.started_from:v.note?.started_from), signed=v.status==='signed', canDraft=canDraftNote(v), canSign=canSignNote(), canAmend=canAmendNote(v), locked=signed||!canDraft, vitalsLocked=!canRecordVisitVitals(v);
  const correction=canAmend?currentAmendmentDraft(v):null, authorship=typeof visitNoteAuthorshipLine==='function'?visitNoteAuthorshipLine(v):'', supportSession=Boolean(me.delegated);
  const amendments=workspace.amendments.filter(a=>a.visit_id===v.id),billWithNote=visitBillingAreaVisible();
  $('visit-editor').innerHTML=`<section class="panel">
  <p id="visit-draft-status" class="muted" role="status"></p><div id="encounter-intake"><section id="encounter-rooming-vitals"><h3 class="visit-section-label">Rooming &amp; vitals</h3><div class="visit-rooming-vitals-grid"><div id="visit-rooming"></div>${signed?visitVitalsSummary(v.vitals||{})?visitVitalsMarkup(v,null,true):'':`<details class="visit-vitals" data-rooming-vitals-review data-rooming-panel="vitals" data-visit-id="${esc(v.id)}" data-inline${retained?.vitals||(typeof roomingPanelOpen==='function'&&roomingPanelOpen(v.id,'vitals'))?' open':''}><summary>${visitVitalsSummary(v.vitals||{})?'View vitals':vitalsLocked?'Vitals':'Record vitals'}</summary>${visitVitalsMarkup(v,retained,vitalsLocked)}</details>`}</div></section>
  </div><div id="encounter-documentation"><h3 class="visit-section-label">Note</h3>${signed?`<p class="note-signed-line muted" id="signed-note-help"><span id="note-signed-by">${esc(typeof visitNoteSignedLine==='function'?visitNoteSignedLine(v):`Signed ${date(v.signed_at)}.`)}</span>${canAmend?' <button type="button" class="text-button" data-action="focus-amendment" aria-haspopup="dialog" aria-controls="amendment-form">'+(correction?'Continue correction':'Add correction')+'</button>':''}</p>`:''}${visitNoteOwnsDiagnoses()?'<section data-encounter-diagnoses-only><div id="visit-diagnoses"></div></section>':''}${signed?`<div id="signed-note-record" data-visit-id="${esc(v.id)}">`:''}<form id="note-form" data-visit-id="${v.id}" data-version="${retained?.note?.version??v.version}"${signed?' aria-describedby="signed-note-help"':''}><p class="muted note-save-line"${signed?' hidden':''}><small id="note-save-status" role="status">Saved</small>${!signed&&!canSign?'<span class="pill">Needs clinician signature</span>':''}</p><p id="note-authorship" class="note-authorship muted"${authorship?'':' hidden'}>${esc(authorship)}</p>${locked?'':'<div id="voice-note-panel" data-voice-note-panel hidden></div>'}${locked?'':'<div id="note-conflict" class="notice error note-conflict" role="alert" hidden></div><div id="note-saved-copy" class="note-saved-copy" hidden></div>'}${locked?'':`<div id="note-previous" class="note-previous" hidden></div><input type="hidden" name="started_from" value="${esc(noteSource)}">`}${signed?visitNoteReadMarkup(note):''}<div class="form-grid note-grid"${signed?' hidden':''}>${noteSectionKeys.filter(key=>key!=='procedure'||!locked||String(note.procedure??'').trim()).map(key=>{const label=key[0].toUpperCase()+key.slice(1);return `<div class="note-section${key==='procedure'?' note-procedure':''}"><label>${label}<textarea name="${key}" maxlength="10000" ${locked?'readonly':key==='procedure'?`placeholder="${esc(noteProcedureHint)}"`:''}>${esc(note[key])}</textarea></label></div>`;}).join('')}</div>${noteSource||!locked?`<p id="note-source-line" class="note-source muted"${noteSource?'':' hidden'}>${esc(noteSourceLine(noteSource,signed,v.note?.started_from))}</p>`:''}<div id="note-message" class="note-message muted" role="status" hidden></div>${locked?'':`<div class="actions" data-note-actions><button type="submit" class="quiet">Save note</button>${canSign?(billWithNote?'<button class="primary" type="button" data-action="sign-bill">Sign &amp; bill</button><button type="button" data-action="sign">Sign only</button>':'<button type="button" class="primary" data-action="sign">Sign note</button>'):`<span id="note-sign-help" class="muted">${supportSession?'You can draft this note. A clinician at the practice must sign it.':'You can draft this note. A clinician signs it.'}</span>`}</div>`}</form>
  ${!locked&&visitNoteOwnsDiagnoses()?`<details data-inline data-clinical-diagnosis-search><summary>Search diagnoses</summary>${visitNoteInlineDiagnosesMarkup()}</details>`:!locked&&visitBillingAreaVisible()&&typeof billingCan==='function'&&billingCan('create')?'<details data-inline data-previous-procedure-choices hidden><summary>Use procedures from the previous encounter</summary><div id="note-previous-procedures" class="actions"></div></details>':''}
  ${signed?`${amendments.length?'<h3>Changes after signing</h3>':''}${amendments.map(a=>`<div class="amendment"><p><b>${esc(a.reason)}</b></p><p class="note-text">${esc(a.text)}</p><small class="muted">Recorded ${esc(date(a.created_at))}<span id="amendment-author-${esc(a.id)}">${esc(typeof visitNoteAmendmentAuthor==='function'?visitNoteAmendmentAuthor(v,a):'')}</span></small></div>`).join('')}${canAmend?`<form id="amendment-form" data-visit-id="${esc(v.id)}" data-patient-id="${esc(selected)}" data-version="${correction?.version??v.version}" aria-describedby="amendment-draft-status" hidden><p id="amendment-draft-status" class="muted" role="status"></p><button id="amendment-review-current" type="button" data-action="review-amendment-version" hidden>I reviewed the current record — keep my correction</button><label>What changed<input name="reason" required maxlength="1000" placeholder="For example: corrected the dose" value="${esc(correction?.values.reason||'')}"></label><label>Updated text<textarea name="text" required maxlength="10000">${esc(correction?.values.text||'')}</textarea></label><div class="actions"><button id="amendment-submit" class="primary" type="submit">Sign correction</button><button id="amendment-discard" type="button" data-action="discard-amendment-draft" class="quiet" hidden>Discard unsaved correction</button></div></form>`:''}`:''}${signed?'</div>':''}${!signed&&!canDraft?'<p id="note-read-only" class="muted">You can read this note. Clinical staff write it and a clinician signs it.</p>':''}</div></section>`;
  const vitalsForm=$('vitals-form');if(retained?.vitals&&vitalsForm)visitVitalsFeedback(vitalsForm,{validateValues:true});
  if(canAmend){const form=$('amendment-form');if(form)visitAmendmentContexts.set(form,{identity:me,tenantId:me.tenant_id,patientId:selected,visitId:v.id,version:correction?.version??v.version});updateVisitAmendmentStatus();}
  updateDraftStatus();if(!locked&&typeof renderVisitNoteSource==='function')void renderVisitNoteSource();if(typeof renderVisitNoteAuthorship==='function')void renderVisitNoteAuthorship();refreshEncounterProgress();if(!locked&&typeof visitNoteInlineMount==='function')void visitNoteInlineMount();if(typeof renderRooming==='function')void renderRooming();if(typeof renderVisitDiagnoses==='function')void renderVisitDiagnoses();if(typeof renderVisitCheckout==='function')renderVisitCheckout();if(typeof renderEncounterRevenue==='function')void renderEncounterRevenue();renderEncounterOrderActions();if(encounterSection==='files'&&typeof renderEncounterFiles==='function')void renderEncounterFiles();applyChartSection();
}
function renderHistory() {
  if(workspace.history===null)return;
  const panel=document.createElement('section');panel.className='panel';panel.id='source-history';
  const reconcileActions=r=>`${['insurance','billing','transaction'].includes(r.kind)&&['owner','clinician','front_desk'].includes(me.role)?`<div class="actions"><button type="button" data-map-billing="${esc(r.id)}">${r.kind==='insurance'&&r.source_data?.coverage?'Add as coverage':'Review billing / insurance source'}</button></div>`:''}${r.kind==='claim'&&billingWrite()?`<button type="button" data-map-claim="${esc(r.id)}">Review claim mapping</button>`:''}${r.kind==='appointment'&&['owner','clinician','front_desk'].includes(me.role)?`<div class="actions"><button type="button" data-map-appointment="${esc(r.id)}">Review appointment mapping</button></div>`:''}${['lab_order','lab_result'].includes(r.kind)&&['owner','clinician'].includes(me.role)?`<div class="actions"><button type="button" data-map-lab="${esc(r.id)}">Reconcile lab source</button></div>`:''}${['medical_problem','allergy','medication'].includes(r.kind)&&['owner','clinician'].includes(me.role)?`<div class="actions"><button type="button" data-map-clinical="${esc(r.id)}">Review and add to chart</button></div>`:''}`;
  const reconciled=r=>Boolean(r.native_id||[...(workspace.clinical?.items||[]),...(workspace.labs?.orders||[]),...(workspace.labs?.reports||[]),...(workspace.appointments||[]),...(workspace.billing?.accounts||[]),...(workspace.billing?.coverages||[]),...(typeof claimRows==='undefined'?[]:claimRows.filter(e=>e.patient_id===selected)),...(workspace.claims?.items||[])].some(e=>e.source_history_id===r.id));
  panel.innerHTML=chartListHeader('Imported records','',typeof importedContactBlock==='function'?'<button type="button" data-chart-detail="source-contacts">Imported contacts</button>':'')+'<p class="muted">Kept as they were, not signed in SunCharts. These records came from your previous system.</p>'+chartListTable(['Record','Type','Imported','Source','Reconciliation','Actions'],workspace.history.map(r=>[`<button type="button" class="text-button" data-chart-detail="source-record-${esc(r.id)}">${esc(r.data?.title||r.data?.name||human(r.kind))}</button>`,esc(human(r.kind)),esc(displayDate(r.imported_at)),esc(r.source_instance),displayStatusPill(reconciled(r)?'reconciled':'pending'),reconcileActions(r)]),'No imported records recorded.')+workspace.history.map(r=>{const data=r.data||{};const fields=Object.entries(data).filter(([k,v])=>!['id','pid','uuid','puuid','patient_id'].includes(k)&&['string','number','boolean'].includes(typeof v));return `<template id="source-record-${esc(r.id)}"><div><h3><b>${esc(r.kind.replaceAll('_',' '))}</b> ${esc(data.title||data.name||data.description||'')}</h3><p class="muted">From previous system: ${esc(r.source_instance)}</p><dl>${fields.map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd class="note-text">${esc(v)}</dd>`).join('')}</dl><small class="muted">Imported ${esc(displayDate(r.imported_at))} · Read only</small>${reconcileActions(r)}</div></template>`;}).join('')+(typeof importedContactBlock==='function'?chartRecordTemplate('source-contacts',importedContactBlock()):'');
  $('chart').append(panel);
}
function encounterWorkflow(){
 const canView=resource=>typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);
 const v=activeVisit,appointment=v?workspace.appointments.find(a=>a.id===v.appointment_id):workspace.appointments.find(a=>['checked_in','booked'].includes(a.status));
 if(!v&&workspace.patient?.archived)return '<section class="panel encounter-empty"><h2>Archived patient chart</h2><p>Review the past encounters here, or restore the patient before starting a new encounter.</p></section>';
 // No encounter open: the patient banner's Start visit button starts one, so nothing repeats it here.
 // A checked-in or booked appointment shows its insurance and copay, taken before the visit starts.
 if(!v)return ['visits','encounters'].includes(chartSection)&&typeof appointmentCopayCard==='function'?appointmentCopayCard():'';
 const runs=typeof patientPathways==='undefined'?[]:patientPathways.filter(item=>item.patient_id===selected&&item.status==='active'&&(!item.appointment_id||item.appointment_id===v.appointment_id));
 const visitPage=!inRecordArea();
 if(visitPage&&encounterUsesPatientBanner())return '';
 return `<section class="encounter-workspace-heading"><div class="section-head"><div><p class="eyebrow">SELECTED ENCOUNTER</p><h2>${esc(appointment?.title||'Encounter')}</h2><p class="muted">${typeof encounterNumberText==='function'&&encounterNumberText(v)?`<b class="encounter-number">${esc(encounterNumberText(v))}</b> · `:''}${esc(encounterDateLabel(v))} · ${v.status==='signed'?'Signed clinical record':'In progress'}</p></div><div class="encounter-selection">${visitPage?encounterAddMenu():''}<details class="frame-add-menu" data-menu><summary>More ▾</summary><div class="frame-add-items"><button type="button" data-encounter-history-sheet>History</button></div></details>${runs.length&&chartAreaEnabled('care_pathways')?'<button type="button" data-chart-section="care_pathways">Practice workflow</button>':''}</div></div><div class="encounter-visit-actions">${visitPage?'':'<button type="button" data-encounter-back>← Back to encounter</button>'}</div></section>`;
}
// The encounter is one scrolling page: vitals, note, codes & charges, payment, finish. Everything
// else hangs off it as a button, shown only where the practice shows that area and this person
// may use it — the same rules the old step list applied.
function encounterVisitActions(){
 const canView=resource=>typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);
 const actions=[];
 if(chartAreaEnabled('prescribing')&&canView('clinical'))actions.push('<button type="button" data-encounter-step="prescription">+ Prescription</button>');
 if(chartAreaEnabled('orders')&&canView('clinical'))actions.push('<button type="button" data-encounter-step="new-order">+ Order</button>');
 if(chartAreaEnabled('referrals')&&canView('clinical'))actions.push('<button type="button" data-chart-section="referrals">+ Referral</button>');
 if(chartAreaEnabled('documents')&&canView('clinical'))actions.push('<button type="button" data-encounter-section="files">+ Attach file</button>');
 return actions;
}
function encounterUsesPatientBanner(){
 return !!activeVisit&&typeof patientBannerEncounterContext==='function'&&
  patientBannerArea('visits')&&patientBannerCan('clinical');
}
function encounterAddMenu(){
 const actions=encounterVisitActions();
 return actions.length?`<details class="frame-add-menu" data-menu><summary>Add ▾</summary><div class="frame-add-items">${actions.join('')}</div></details>`:'';
}
function encounterSections(){
 return [['visit','Overview'],['intake','Rooming'],['documentation','Notes & diagnoses'],['charges','Charges & billing'],['orders','Orders & prescriptions'],['files','Files & recordings'],['checkout','Encounter summary and follow-up']];
}
function renderEncounterOrderActions(){
 const host=$('encounter-orders-actions');if(!host||!activeVisit)return;
 host.innerHTML=`<div class="section-head"><div><h2>Prescriptions & referrals</h2><p class="muted">Order medication or send a referral for the encounter you have selected.</p></div><div class="actions">${chartAreaEnabled('prescribing')?'<button type="button" data-chart-section="prescribing">Prescriptions</button>':''}${chartAreaEnabled('referrals')?'<button type="button" data-chart-section="referrals">Referrals</button>':''}</div></div>`;
}
function setEncounterSection(key,{openLink=false}={}){
 if(!activeVisit){showChartSection('visits');return;}
 if(!encounterSections().some(([step])=>step===key))return;
 const samePage=chartSection==='visits',changed=encounterSection!==key;
 captureVisitDrafts();encounterSection=key;showChartSection('visits');
 if(samePage&&changed)applyChartSection();
 // Legacy section links open the content beneath the sticky chart header.
 // The encounter is in tabs: the note steps and the summary and follow-up open the Note tab, and charges
 // the billing tab used last.
 const tab=['visit','intake','documentation','checkout'].includes(key)?'note':null;
 if(tab&&typeof invoiceTabSet==='function')invoiceTabSet(tab,false);
 if(key==='visit')return;
 if(key==='intake'){const host=$('encounter-intake');alignChartContent();return;}
 if(key==='documentation'){const host=$('note-form')||$('visit-diagnoses');alignChartContent();return;}
 if(key==='checkout'){if(typeof encounterOpenFollowup==='function')encounterOpenFollowup();return;}
 if(key==='charges'){
  if(typeof encounterTabForget==='function')encounterTabForget();
  if(typeof renderEncounterRevenue==='function')void renderEncounterRevenue();
  alignChartContent();
  if(openLink&&typeof encounterQueueChargesLink==='function')encounterQueueChargesLink();
  return;
 }
 if(key==='files'&&typeof renderEncounterFiles==='function')void renderEncounterFiles();
}
function refreshEncounterProgress(){if(workspace&&$('encounter-progress'))$('encounter-progress').innerHTML=(typeof postSignReminderMarkup==='function'?postSignReminderMarkup():'')+encounterWorkflow();if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();}
function openEncounterStep(step){
 if(step==='checkout'){setEncounterSection('checkout');return;}
 if(step==='clinical'){showChartSection('clinical');return;}
 // The encounter page's "+ Prescription" button: the prescribing area, with a fresh draft started
 // for this encounter where the practice may prepare one.
 if(step==='prescription'){
  showChartSection('prescribing');
  if(typeof renderPrescribing==='function')void renderPrescribing();
  return;
 }
 if(['orders','new-order'].includes(step)){
  setEncounterSection('orders');
  if(step==='new-order'&&activeVisit&&canDocument()){editLabOrder();$('lab-order-form').elements.visit_id.value=activeVisit.id;}
  return;
 }
 if(['billing','new-account'].includes(step)){
  setEncounterSection('charges');
  if(typeof openEncounterCharges==='function')openEncounterCharges();
  return;
 }
 setEncounterSection(step==='vitals'||step==='rooming'?'intake':'documentation');
 alignChartContent();
}
function encounterDateLabel(v){
 const timestamp=workspace.appointments.find(a=>a.id===v.appointment_id)?.starts_at||v.created_at||v.signed_at;
 return timestamp?date(timestamp):'Visit date not recorded';
}
// Switch encounter: a sheet with the patient's encounters listed on the left and a month calendar
// on the right. Picking an encounter moves the calendar to its date and marks it; picking a date
// marks the encounters of that day in the list. Either way, one button opens the chosen encounter.
let encounterSwitch={month:null,selected:null,day:null,query:'',dialog:null};
function encounterSwitchWhen(v){const t=workspace.appointments.find(a=>a.id===v.appointment_id)?.starts_at||v.created_at||v.signed_at;const d=t?new Date(t):null;return d&&!Number.isNaN(d.getTime())?d:null;}
function encounterSwitchKey(d){return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';}
function encounterSwitchRows(){return (workspace.visits||[]).map(v=>{const when=encounterSwitchWhen(v);return {visit:v,when,key:encounterSwitchKey(when),number:typeof encounterNumberText==='function'?encounterNumberText(v):'',title:workspace.appointments.find(a=>a.id===v.appointment_id)?.title||v.category||'Encounter',label:encounterDateLabel(v),status:displayStatus(v.status)};}).sort((a,b)=>(b.when?.getTime()||0)-(a.when?.getTime()||0));}
function encounterSwitchListMarkup(){
 const st=encounterSwitch,q=st.query.trim().toLowerCase(),rows=encounterSwitchRows().filter(r=>!q||`${r.number} ${r.title} ${r.label} ${r.status}`.toLowerCase().includes(q));
 if(!rows.length)return '<p class="muted">No encounter matches.</p>';
 return `<ul class="encounter-switch-list" role="listbox" aria-label="Encounters">${rows.map(r=>`<li><button type="button" role="option" data-encounter-switch-pick="${esc(r.visit.id)}" aria-selected="${r.visit.id===st.selected}" class="${r.visit.id===st.selected?'is-selected':''}${st.day&&r.key===st.day?' is-on-day':''}"><b>${esc(r.number||'Encounter')}</b><span>${esc(r.title)}</span><small>${esc(r.label)} · ${esc(r.status)}${typeof activeVisit!=='undefined'&&activeVisit?.id===r.visit.id?' · Open now':''}</small></button></li>`).join('')}</ul>`;
}
function encounterSwitchCalendarMarkup(){
 const st=encounterSwitch,first=st.month,year=first.getFullYear(),month=first.getMonth(),days=new Date(year,month+1,0).getDate(),lead=first.getDay(),today=encounterSwitchKey(new Date());
 const counts=new Map();for(const r of encounterSwitchRows())if(r.key)counts.set(r.key,(counts.get(r.key)||0)+1);
 let cells='';for(let i=0;i<lead;i++)cells+='<span class="encounter-switch-blank"></span>';
 for(let d=1;d<=days;d++){const key=encounterSwitchKey(new Date(year,month,d)),n=counts.get(key)||0;
  cells+=`<button type="button" data-encounter-switch-day="${key}" class="${n?'has-encounter':''}${key===st.day?' is-selected':''}${key===today?' is-today':''}" ${n?`title="${n} ${n===1?'encounter':'encounters'}"`:'disabled'} aria-pressed="${key===st.day}" aria-label="${esc(new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',year:'numeric'}).format(new Date(year,month,d)))}${n?`, ${n} ${n===1?'encounter':'encounters'}`:', no encounter'}">${d}${n?`<i aria-hidden="true"${n>1?' class="is-many"':''}></i>`:''}</button>`;}
 return `<div class="encounter-switch-month"><button type="button" data-encounter-switch-move="-1" aria-label="Previous month">‹</button><b aria-live="polite">${esc(new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric'}).format(first))}</b><button type="button" data-encounter-switch-move="1" aria-label="Next month">›</button></div><div class="encounter-switch-grid"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>${cells}</div>`;
}
function encounterSwitchFootMarkup(){
 const row=encounterSwitchRows().find(r=>r.visit.id===encounterSwitch.selected),current=typeof activeVisit!=='undefined'&&activeVisit?.id===row?.visit.id;
 return `<button type="button" class="text-button encounter-switch-history" data-encounter-history data-sheet-close>All encounters and history</button><button type="button" class="primary" data-encounter-switch-open ${row&&!current?'':'disabled'}>${row?(current?'This encounter is open':`Use ${esc(row.number||'encounter')}`):'Choose an encounter'}</button><button type="button" data-sheet-close>Cancel</button>`;
}
function encounterSwitchPaint(scroll=false){
 const dialog=encounterSwitch.dialog;if(!dialog?.isConnected)return;
 dialog.querySelector('[data-encounter-switch-list]').innerHTML=encounterSwitchListMarkup();
 dialog.querySelector('[data-encounter-switch-calendar]').innerHTML=encounterSwitchCalendarMarkup();
 dialog.querySelector('[data-encounter-switch-foot]').innerHTML=encounterSwitchFootMarkup();
 if(scroll)dialog.querySelector('.encounter-switch-list .is-selected,.encounter-switch-list .is-on-day')?.scrollIntoView?.({block:'nearest'});
}
function encounterSwitchChoose(id){
 const row=encounterSwitchRows().find(r=>r.visit.id===id);if(!row)return;
 encounterSwitch.selected=id;encounterSwitch.day=row.key||null;if(row.when)encounterSwitch.month=new Date(row.when.getFullYear(),row.when.getMonth(),1);
 encounterSwitchPaint();
}
function openEncounterSwitch(){
 if(typeof sheetOpen!=='function'||!workspace?.visits?.length||encounterSwitch.dialog?.open)return;
 const current=workspace.visits.find(v=>v.id===activeVisit?.id),when=(current&&encounterSwitchWhen(current))||encounterSwitchRows()[0]?.when||new Date();
 const panel=document.createElement('div');panel.className='encounter-switch';
 panel.innerHTML='<div class="encounter-switch-side"><label class="sr-only" for="encounter-switch-search">Find an encounter</label><input id="encounter-switch-search" type="search" placeholder="Find by number, visit type or date" autocomplete="off" data-encounter-switch-search><div data-encounter-switch-list></div></div><div class="encounter-switch-main"><div data-encounter-switch-calendar></div><p class="muted">Days with a dot have an encounter.</p></div><div class="actions encounter-switch-foot" data-encounter-switch-foot></div>';
 const dialog=sheetOpen('Switch encounter',panel);dialog.classList.add('sheet-wide','encounter-switch-sheet');
 encounterSwitch={month:new Date(when.getFullYear(),when.getMonth(),1),patient:selected,identity:me,selected:current?.id||null,day:current?encounterSwitchKey(encounterSwitchWhen(current)):null,query:'',dialog};
 const heading=dialog.querySelector('.sheet-head h3');heading.id='encounter-switch-title';dialog.setAttribute('aria-labelledby',heading.id);
 const originPatient=selected;
 dialog.addEventListener('close',()=>{if(encounterSwitch.dialog===dialog)encounterSwitch.dialog=null;if(selected===originPatient)$('patient-banner')?.querySelector('[data-encounter-switch]')?.focus({preventScroll:true});},{once:true});
 encounterSwitchPaint(true);
}
// The banner shows who the chart is for and what is under way; nothing else to refresh here.
function refreshPatientChartContext(){if(typeof renderPatientBanner==='function')renderPatientBanner();}
function chartContactSummary(){
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('clinical'))return '';
 const contact=workspace.demographics?.content||{},canDetails=chartAreaEnabled('profile');
 return `<section class="panel chart-summary-section patient-contact-summary"><div class="section-head"><h2>Contact details</h2>${canDetails?'<button type="button" class="text-button" data-chart-section="profile">View / edit contact</button>':''}</div><dl><div><dt>Phone</dt><dd data-chart-contact="phone">${esc(contact.phone||'Not recorded')}</dd></div><div><dt>Email</dt><dd data-chart-contact="email">${esc(contact.email||'Not recorded')}</dd></div></dl><div class="chart-summary-footer"><span id="patient-intake-summary" role="status">No intake form sent yet.</span>${chartAreaEnabled('documents')?'<button type="button" class="text-button" data-patient-intakes-open>Send an intake form</button>':''}</div></section>`;
}
function refreshChartContactSummary(){
 const chart=$('chart'),contact=workspace.demographics?.content||{};
 for(const key of ['phone','email']){const selector=`[data-chart-contact="${key}"]`,values=chart?.querySelectorAll?[...chart.querySelectorAll(selector)]:[chart?.querySelector(selector)];for(const value of values)if(value)value.textContent=contact[key]||'Not recorded';}
 if(typeof renderPatientBanner==='function')renderPatientBanner();
}
function chartOverview(){
 const items=workspace.clinical.items,active=e=>e.content.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification),problems=items.filter(e=>e.kind==='problem'&&active(e)),meds=items.filter(e=>e.kind==='medication'&&active(e));
 const critical=r=>r.content.observations.some(o=>['critical','critical_high','critical_low'].includes(o.flag));
 const reports=workspace.labs.reports.filter(r=>['preliminary','final','corrected'].includes(r.status)&&!workspace.labs.acknowledgments.some(a=>a.report_id===r.id&&a.version===r.version)).sort((a,b)=>Number(critical(b))-Number(critical(a)));
 // A measurement that was not taken is left out; the card never prints an empty or "undefined" value.
 const measured=value=>value!==undefined&&value!==null&&value!==''&&!(typeof value==='number'&&!Number.isFinite(value)),hasVitals=v=>Boolean(v?.vitals)&&Object.values(v.vitals).some(measured);
 const recordedVisit=hasVitals(activeVisit)?activeVisit:workspace.visits.find(hasVitals),vitals=recordedVisit?.vitals;
 const observations=vitals?[['Blood pressure',measured(vitals.systolic_mm_hg)&&measured(vitals.diastolic_mm_hg)?`${vitals.systolic_mm_hg}/${vitals.diastolic_mm_hg}`:undefined,'mmHg'],['Pulse',vitals.heart_rate_bpm,'bpm'],['Temperature',measured(vitals.temperature_c)?vitalBothUnits('temperature_c',vitals.temperature_c):undefined,''],['Oxygen saturation',vitals.oxygen_saturation_pct,'%'],['Weight',measured(vitals.weight_kg)?vitalBothUnits('weight_kg',vitals.weight_kg):undefined,''],['Height',measured(vitals.height_cm)?vitalBothUnits('height_cm',vitals.height_cm):undefined,'']].filter(([,value])=>measured(value)):[];
 const row=(title,detail)=>`<div class="chart-data-row"><strong>${esc(title)}</strong><small>${esc(detail)}</small></div>`;
 const problemRows=problems.slice(0,6).map(e=>row(e.content.title,`${displayStatus(e.content.verification)}${e.content.onset_date?' · Since '+displayDate(e.content.onset_date):''}`)).join('');
 const medRows=meds.slice(0,6).map(e=>row(e.content.title,[e.content.detail?.dose,e.content.detail?.route,e.content.detail?.frequency].filter(Boolean).join(' · ')||'No dose recorded')).join('');
 return `${patientWorkflowActions()}<section id="chart-overview" class="chart-overview-workbench"><div class="chart-primary-column"><section class="panel chart-summary-section"><div class="section-head"><h2>Clinical summary</h2><div class="clinical-summary-links" aria-label="Clinical record"><button type="button" class="text-button" data-clinical-focus="allergy">Allergies</button><button type="button" class="text-button" data-clinical-focus="problem">Problems</button><button type="button" class="text-button" data-clinical-focus="medication">Medications</button></div></div><div class="clinical-summary-columns"><section><h3>Active problems <span class="pill">${problems.length}</span></h3>${problemRows||'<div class="chart-empty-row">No problems recorded. <button type="button" class="text-button" data-clinical-focus="problem">Add problem</button></div>'}${problems.length>6?'<button type="button" class="text-button" data-chart-section="clinical">View all recorded problems</button>':''}</section><section><h3>Medications <span class="pill">${meds.length}</span></h3>${medRows||'<div class="chart-empty-row">No medications recorded. <button type="button" class="text-button" data-clinical-focus="medication">Add medication</button></div>'}${meds.length>6?'<button type="button" class="text-button" data-chart-section="clinical">View all recorded medications</button>':''}</section></div></section><section class="panel chart-summary-section"><div class="section-head"><h2>Results to review <span class="pill">${reports.length}</span></h2><button type="button" class="text-button" data-chart-section="orders">Orders & results →</button></div>${reports.length?`<table class="chart-results-table"><thead><tr><th>Report</th><th>Status</th><th>Reported</th></tr></thead><tbody>${reports.slice(0,5).map(r=>`<tr><td><strong>${esc(r.content.accession)}</strong><small>${esc(r.content.performing_lab||'Laboratory not recorded')}</small></td><td>${critical(r)?'<span class="critical-label">Critical</span>':esc(displayStatus(r.status))}</td><td>${esc(date(r.content.reported_at))}</td></tr>`).join('')}</tbody></table>`:'<div class="chart-empty-row">No results to review.</div>'}${workspace.labs.orders.length?`<div class="chart-summary-footer">${displayCount(workspace.labs.orders.length,'order')} on file</div>`:''}</section></div><aside class="chart-secondary-column">${chartContactSummary()}<section class="panel chart-summary-section"><div class="section-head"><h2>Latest vitals</h2><button type="button" class="text-button" data-chart-section="vitals">Open →</button></div>${observations.length?`<dl class="chart-vital-list">${observations.map(([label,value,unit])=>`<div><dt>${label}</dt><dd>${esc(value)}${unit?` <small>${unit}</small>`:''}</dd></div>`).join('')}</dl><p class="chart-summary-footer">${recordedVisit.id===activeVisit?.id?'This encounter':'Last recorded'} · ${esc(encounterDateLabel(recordedVisit))}</p>`:'<div class="chart-empty-row">No vitals recorded yet.</div>'}</section><section class="panel chart-summary-section"><div class="section-head"><h2>Encounter history</h2><button type="button" class="text-button" data-encounter-history>View all →</button></div>${patientEncounterHistoryRows(4,true)}</section></aside></section>`;
}
let patientVitalsReadings;
async function loadPatientVitalsReadings(){
 const patient=selected,identity=me,source=workspace;
 const state={patient,identity,source,rows:[],loading:true,failed:false,limited:false};patientVitalsReadings=state;
 await Promise.all((source.visits||[]).map(async visit=>{
  try{
   const data=await api(`/api/v1/visits/${encodeURIComponent(visit.id)}/rooming`);
   if((data.history||[]).length>=100)state.limited=true;
   const history=(data.history||[]).filter(r=>r.kind==='vitals');
   for(const r of history)state.rows.push({vitals:r.snapshot?.vitals||{},when:r.created_at,by:r.actor_label||r.actor_id});
   if(!history.length&&visit.vitals)state.rows.push({vitals:visit.vitals,when:source.appointments?.find(a=>a.id===visit.appointment_id)?.starts_at||visit.created_at||visit.signed_at});
  }catch{state.failed=true;if(visit.vitals)state.rows.push({vitals:visit.vitals,when:source.appointments?.find(a=>a.id===visit.appointment_id)?.starts_at||visit.created_at||visit.signed_at});}
 }));
 state.loading=false;
 if(patientVitalsReadings!==state||selected!==patient||me!==identity||workspace!==source||chartSection!=='vitals')return;
 const panel=$('patient-vitals-history');if(panel){panel.outerHTML=patientVitalsHistory();$('patient-vitals-history').hidden=false;}
}
function patientVitalsTrend(label,readings,keys){
 const series=keys.map(key=>readings.filter(r=>r.vitals[key]!=null&&r.vitals[key]!==''&&Number.isFinite(Number(r.vitals[key]))).map(r=>({when:new Date(r.when).getTime(),value:Number(r.vitals[key])})).filter(p=>Number.isFinite(p.when)).reverse());
 const points=series.flat();if(!series.some(values=>values.length>=2))return `<span>${esc(label)}: more readings needed for a trend.</span>`;
 const min=Math.min(...points.map(p=>p.value)),range=Math.max(...points.map(p=>p.value))-min||1,first=Math.min(...points.map(p=>p.when)),span=Math.max(...points.map(p=>p.when))-first||1;
 return `<figure><figcaption>${esc(label)} <small>Oldest → newest</small></figcaption><svg viewBox="0 0 160 44" role="img" aria-label="${esc(label)} trend, oldest to newest">${series.map((values,i)=>`<polyline class="vitals-trend-line vitals-trend-line-${i}" points="${values.map(p=>`${4+(p.when-first)/span*152},${40-(p.value-min)/range*36}`).join(' ')}"/>`).join('')}</svg></figure>`;
}
function patientVitalsHistory(){
 const state=patientVitalsReadings?.patient===selected&&patientVitalsReadings.identity===me&&patientVitalsReadings.source===workspace?patientVitalsReadings:null;
 const measured=v=>Object.values(v||{}).some(value=>value!=null&&value!==''&&Number.isFinite(Number(value)));
 const readings=(state&&!state.loading?state.rows:(workspace.visits||[]).map(v=>({vitals:v.vitals,when:workspace.appointments?.find(a=>a.id===v.appointment_id)?.starts_at||v.created_at||v.signed_at}))).filter(r=>measured(r.vitals)).sort((a,b)=>(new Date(b.when).getTime()||0)-(new Date(a.when).getTime()||0));
 const value=(v,key,unit)=>v[key]==null||v[key]===''?'—':`${v[key]} ${unit}`;
 const both=(v,key)=>v[key]==null||v[key]===''?'—':vitalBothUnits(key,v[key]);
 const columns=['Date','BP','Pulse','Temperature','Respiratory rate','SpO2','Weight','Height','BMI','Pain','Recorded by'];
 const rows=readings.map(r=>{const v=r.vitals;return [r.when?displayDate(r.when):'Not recorded',v.systolic_mm_hg==null&&v.diastolic_mm_hg==null?'—':`${v.systolic_mm_hg??'—'}/${v.diastolic_mm_hg??'—'} mmHg`,value(v,'heart_rate_bpm','bpm'),both(v,'temperature_c'),value(v,'respiratory_rate_per_min','breaths/min'),value(v,'oxygen_saturation_pct','%'),both(v,'weight_kg'),both(v,'height_cm'),v.weight_kg>0&&v.height_cm>0?`${(v.weight_kg/(v.height_cm/100)**2).toFixed(1)} kg/m²`:'—',value(v,'pain_score','/10'),r.by||'Not recorded'].map(esc);});
 const table=rows.length?chartListTable(columns,rows,'No vitals recorded.'):`<div class="chart-list-table"><table><thead><tr>${columns.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${columns.length}">No vitals recorded.</td></tr></tbody></table></div>`;
 return `<section id="patient-vitals-history" class="panel" hidden>${chartListHeader('Vitals','<button type="button" class="primary" data-chart-record-vitals>+ Record vitals</button>')}${state?.loading?'<p role="status">Loading readings…</p>':''}${state?.failed?'<p role="status">Some earlier readings could not be loaded. Reopen Vitals to try again.</p>':''}${state?.limited?'<p class="muted">Earlier readings may be missing for encounters with a long history.</p>':''}${readings.length?`<div class="patient-vitals-trends">${patientVitalsTrend('Blood pressure (mmHg): systolic (solid), diastolic (dashed)',readings,['systolic_mm_hg','diastolic_mm_hg'])}${patientVitalsTrend('Weight (kg)',readings,['weight_kg'])}${patientVitalsTrend('Pulse (bpm)',readings,['heart_rate_bpm'])}</div>`:''}${table}</section>`;
}

function chartAreaEnabled(key){
 return typeof workspaceChartTabEnabled!=='function'||workspaceChartTabEnabled(key==='insurance'?'billing':['vitals','encounters'].includes(key)?'visits':key);
}
function visitBillingAreaVisible(){
 return chartAreaEnabled('billing')&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('billing'));
}
function visitCheckoutAreaVisible(){return chartAreaEnabled('checkout');}
// Where each part of the encounter lives. On the one-page visit the vitals, the note, the charges and
// checkout are all on screen at once, so anything asking "is the staff member looking at the
// charges?" must get yes for the whole page. 'orders' and 'files' stay areas of their own, reached
// from the encounter's buttons, so they are deliberately not answered here.
function encounterShows(part){
 if(typeof encounterSection==='undefined')return typeof chartSection==='undefined'||chartSection==='visits';
 if(!['intake','documentation','charges','checkout','visit'].includes(encounterSection))return false;
 return ['charges','note','intake','checkout'].includes(part);
}
// Whether the screen is a record area opened on its own (Orders, Files, or another chart tab)
// rather than the encounter page itself.
function inRecordArea(){
 if(typeof encounterSection!=='undefined'&&['orders','files'].includes(encounterSection))return true;
 if(typeof encounterSection==='undefined')return typeof chartSection!=='undefined'&&chartSection!=='visits';
 return typeof chartSection!=='undefined'&&chartSection!=='visits'&&chartSection!=='overview';
}
function patientSectionVisible(key){
 if(!chartAreaEnabled(key))return false;
 if(key===chartSection)return true;
 // On the one-page visit the checkout block sits on the page itself; orders and files stay
 // separate areas opened from the encounter's buttons.
 return chartSection==='visits'&&Boolean(activeVisit)&&((key==='checkout'&&!inRecordArea())||(key==='documents'&&encounterSection==='files'));
}
// Whether the note block carries its own diagnoses editor. The codes & charges block owns the
// diagnoses on the one-page visit (its stable #encounter-diagnoses host keeps one editor, ICD
// above the CPT lines, open or closed charge table, draft or posted), so while that block is on
// screen the note must not draw a second editor under the same id. On a record area opened from a
// button, nothing else draws the encounter, and where billing is hidden there is no codes block at
// all — both leave the note the editor's only home.
function visitNoteOwnsDiagnoses(){
 if(inRecordArea())return false;
 return !encounterShows('charges')||!visitBillingAreaVisible();
}
function applyChartSection(){
 if(!chartAreaEnabled(chartSection))chartSection='overview';
 if(typeof paintInsuranceCopayModal==='function')paintInsuranceCopayModal();
 if(typeof encounterSection!=='undefined'&&typeof encounterSections==='function'&&!encounterSections().some(([key])=>key===encounterSection))encounterSection='visit';
 const groups={vitals:['patient-vitals-history'],overview:['chart-overview','patient-next-action'],profile:['patient-identity-panel','patient-demographics'],clinical:['clinical-lists'],care_pathways:['care-pathways-panel'],prescribing:['prescribing-panel'],immunizations:['immunizations-panel'],functional_status:['functional-status-panel'],specialty_care:['specialty-care-panel'],history:['health-history-panel'],documents:['documents-panel'],referrals:['referrals-panel'],orders:['lab-workspace'],insurance:['insurance-workspace'],billing:['billing-workspace'],checkout:['visit-checkout'],source:['source-history']};
 for(const [key,ids] of Object.entries(groups))for(const id of ids)if($(id))$(id).hidden=!patientSectionVisible(key);
 if($('patient-intake-panel'))$('patient-intake-panel').hidden=chartSection!=='documents';
 const inEncounter=chartSection==='visits',hasVisit=typeof activeVisit!=='undefined'&&Boolean(activeVisit),step=typeof encounterSection==='undefined'?'visit':encounterSection,onVisitPage=!inRecordArea();
 $('chart')?.classList?.toggle('frame-encounter-open',inEncounter);
 if($('visit-page-host'))$('visit-page-host').hidden=!(inEncounter||chartSection==='encounters'&&!hasVisit);
 if($('encounter-start-editor'))$('encounter-start-editor').hidden=!inEncounter;
 const timeline=$('patient-banner-claim');if(timeline)timeline.hidden=!inEncounter;
 if($('appointments-panel'))$('appointments-panel').hidden=chartSection!=='encounters';
 // One scrolling visit page: vitals, note, codes & charges, payment, finish, top to bottom.
 if($('visit-editor'))$('visit-editor').hidden=!(inEncounter&&hasVisit&&onVisitPage);
 if($('encounter-intake'))$('encounter-intake').hidden=!(inEncounter&&hasVisit&&onVisitPage);
 if($('encounter-documentation'))$('encounter-documentation').hidden=!(inEncounter&&hasVisit&&onVisitPage);
 const canViewBilling=typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('billing');
 const revenueVisible=inEncounter&&hasVisit&&onVisitPage&&encounterShows('charges')&&chartAreaEnabled('billing')&&canViewBilling;
 if($('encounter-revenue'))$('encounter-revenue').hidden=!revenueVisible;
 // Without the billing block there is no tab bar, so the page shows every block as before.
 if(!revenueVisible&&$('visit-page-host')?.dataset)delete $('visit-page-host').dataset.encounterTab;
 // Coming back to the encounter puts the page on the tab its tab bar already shows, so one tab's
 // blocks are on screen, never all of them at once.
 if(revenueVisible&&$('visit-page-host')?.dataset&&!$('visit-page-host').dataset.encounterTab&&$('encounter-revenue')?.dataset?.invoiceTab)$('visit-page-host').dataset.encounterTab=$('encounter-revenue').dataset.invoiceTab;
 if($('encounter-orders-actions'))$('encounter-orders-actions').hidden=!(inEncounter&&hasVisit&&!onVisitPage&&step==='orders'&&chartAreaEnabled('orders'));
 if($('visit-checkout'))$('visit-checkout').hidden=!(inEncounter&&hasVisit&&onVisitPage&&chartAreaEnabled('checkout'));
 if($('encounter-progress')){const showProgress=inEncounter||chartSection==='encounters'&&!hasVisit;$('encounter-progress').hidden=!showProgress;if(showProgress&&typeof refreshEncounterProgress==='function')refreshEncounterProgress();}
 const primary=['overview','visits','insurance','billing','documents'];
 if(typeof applyLabEncounterScope==='function')applyLabEncounterScope();
 if(typeof documentFileNavigationChanged==='function')documentFileNavigationChanged();
 const navHost=$('chart')?.querySelector?.('.chart-context');
 let nav=navHost?.querySelector('.frame-chart-navigation');
 const encounterNav=chartNavigationEncounter();
 if(nav&&chartNavigation.tabs&&nav.hasAttribute('data-encounter-navigation')!==encounterNav){
  closeChartSidebarFlyout();
  const focused=document.activeElement,hadFocus=nav.contains(focused);
  navHost.innerHTML=chartNavigation(chartNavigation.tabs);
  nav=navHost.querySelector('.frame-chart-navigation');
  if(hadFocus)(focused.id==='frame-chart-select'?nav.querySelector('select'):nav.querySelector('[aria-pressed="true"]'))?.focus({preventScroll:true});
 }
 if(nav)applyChartSidebarCollapsed(nav,chartSidebarCollapsed());
 const activeChartItem=chartNavigationKey(encounterNav);
 document.querySelectorAll('.chart-tabs button[data-chart-section], .chart-tabs button[data-clinical-focus]').forEach(b=>{
  const active=(b.dataset.clinicalFocus||b.dataset.chartSection)===(b.closest?.('.frame-chart-navigation')?activeChartItem:chartSection);
  b.setAttribute('aria-pressed',String(active));
  // Section selection has one source; discard legacy/default selection markers on reloads.
  b.removeAttribute('aria-current');b.classList.remove('active','selected','default-active');
 });
 const select=$('frame-chart-select');if(select)select.value=activeChartItem;
 if(nav&&nav.dataset.currentChartItem!==activeChartItem){
  closeChartSidebarFlyout();
  const activeGroup=nav.querySelector('button[aria-pressed="true"]')?.closest('[data-chart-sidebar-group]');
  if(activeGroup)chartSidebarGroupOpen(activeGroup,true);
  nav.dataset.currentChartItem=activeChartItem;
 }
 const record=$('patient-record-navigation');if(record){record.classList.toggle('active',!primary.includes(chartSection));if(primary.includes(chartSection))record.open=false;}
 const context=$('record-context');if(context){context.hidden=!hasVisit||inEncounter||!!nav?.hasAttribute('data-encounter-navigation');context.innerHTML='<button type="button" data-chart-section="visits">← Return to the selected encounter</button>';}
 if(typeof refreshChartNavigationMarkers==='function')refreshChartNavigationMarkers();
 syncPatientNextAction();
 if(chartSection==='billing'&&typeof renderPatientBillingChart==='function')void renderPatientBillingChart();
}
function openPatientEncounterList(){showChartSection('encounters');}
let frameClinicalFocus='problem';
function focusClinicalSection(kind){
 if(!['problem','allergy','medication'].includes(kind))return;
 if(!chartAreaEnabled('clinical'))return;
 const changed=frameClinicalFocus!==kind,wasClinical=chartSection==='clinical';frameClinicalFocus=kind;
 showChartSection('clinical');if(chartSection!=='clinical')return;
 if(changed&&wasClinical&&typeof chartCloseSheets==='function')chartCloseSheets();
 if(typeof renderClinical==='function'&&(changed||!$('clinical-lists')?.querySelector('h2')))renderClinical();
 if(wasClinical&&changed)applyChartSection();if(typeof alignChartContent==='function')alignChartContent();
}

function syncPatientNextAction(){
 const next=$('patient-next-action'),bar=$('encounter-bar');
 // The encounter bar belongs to the encounter page. Summary keeps its own single box,
 // refreshed after asynchronous billing loads and encounter changes.
 if(bar)bar.hidden=chartSection!=='visits';
 if(next){
  next.innerHTML=patientWorkflowActionContent();
  next.hidden=chartSection!=='overview';
 }
}
function chartNavigationMarkers(key){
 const data=typeof workspace==='undefined'?null:workspace;if(!data)return '';
 const badge=(text,tone='',label='')=>`<span class="frame-nav-count ${tone}"${text===0?' data-zero="true"':''}${label?` aria-label="${esc(label)}" title="${esc(label)}"`:''}>${esc(text)}</span>`;
 const dot=label=>`<span class="frame-nav-dot" role="img" aria-label="${esc(label)}" title="${esc(label)}"></span>`;
 if(['problem','allergy','medication'].includes(key)){
  const count=(data.clinical?.items||[]).filter(e=>e.kind===key&&e.content?.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification)).length;
  const reviewed=(data.clinical?.reviews||[]).some(r=>r.kind===key&&['reviewed','no_known'].includes(r.review_state));
  return badge(count,'',`${count} active`)+(reviewed?'':dot('Not reviewed'));
 }
 if(key==='visits'){
  const visits=data.visits||[],unsigned=visits.filter(v=>v.status==='in_progress').length;
  return badge(visits.length)+(unsigned?dot(`${unsigned} unsigned note${unsigned===1?'':'s'}`):'');
 }
 if(key==='orders'){
  const count=(data.labs?.reports||[]).filter(r=>['preliminary','final','corrected'].includes(r.status)&&!(data.labs?.acknowledgments||[]).some(a=>a.report_id===r.id&&a.version===r.version)).length;
  return count?badge(count,'is-danger',`${count} results to review`):'';
 }
 const banner=typeof patientBannerCurrent==='function'&&patientBannerCurrent()?patientBanner.data:null;
 if(key==='billing'){
  const due=banner?.billing?.patient_due_cents;
  return Number.isSafeInteger(due)&&due>0?badge(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(due/100),'is-warning','Patient owes'):'';
 }
 if(key==='insurance'){
  const coverages=typeof patientBannerCoverages==='function'?patientBannerCoverages():data.billing?.coverages;
  return coverages?.length&&coverages.some(c=>!banner?.eligibility?.some(check=>check.coverage_id===c.id&&check.status==='completed'))?dot('Insurance not checked'):'';
 }
 return '';
}
function refreshChartNavigationMarkers(){
 document.querySelectorAll('[data-chart-markers]').forEach(node=>{const html=chartNavigationMarkers(node.dataset.chartMarkers);if(node.innerHTML!==html)node.innerHTML=html;});
}
function chartNavigationEncounter(){
 const visit=typeof activeVisit==='undefined'?null:activeVisit;
 const patient=typeof selected==='undefined'?null:selected;
 if(!visit?.id||!patient||visit.patient_id&&visit.patient_id!==patient){chartNavigation.encounter=null;return false;}
 if(chartSection==='visits')chartNavigation.encounter={patient,visit:visit.id};
 return chartNavigation.encounter?.patient===patient&&chartNavigation.encounter.visit===visit.id;
}
function chartNavigationKey(encounter){
 if(chartSection==='clinical')return frameClinicalFocus;
 return chartSection==='encounters'&&!encounter?'visits':chartSection;
}
function chartSidebarCollapsed(value){
 if(typeof me==='undefined'||!me?.tenant_id||!me?.user_id)return value??true;
 const owner=JSON.stringify([me.tenant_id,me.user_id]);
 const scope=chartSection==='visits'?'visit':'record';
 // The existing preference belongs to Visit. The patient record has its own collapsed default.
 const preference='suncharts.chart-sidebar.'+owner+(scope==='record'?'.record':'');
 if(chartSidebarCollapsed.session?.owner!==owner)chartSidebarCollapsed.session={owner};
 const session=chartSidebarCollapsed.session;
 if(typeof value==='boolean'){
  session[scope]=value;
  try{localStorage.setItem(preference,value?'collapsed':'expanded');}catch{}
  return value;
 }
 if(typeof session[scope]==='boolean')return session[scope];
 try{return localStorage.getItem(preference)!=='expanded';}catch{return true;}
}
function applyChartSidebarCollapsed(navigation,collapsed){
 if(navigation.dataset.sidebarCollapsed===String(collapsed))return;
 closeChartSidebarFlyout();
 navigation.closest('#chart')?.classList.add('chart-sidebar-animate');
 navigation.dataset.sidebarCollapsed=String(collapsed);
 for(const group of navigation.querySelectorAll('[data-chart-sidebar-group]'))chartSidebarGroupOpen(group,group.dataset.sidebarGroupOpen==='true');
 const toggle=navigation.parentElement.querySelector('[data-chart-sidebar-toggle]');
 if(toggle){
  const label=collapsed?'Expand sidebar':'Collapse sidebar';
  toggle.setAttribute('aria-expanded',String(!collapsed));
  toggle.setAttribute('aria-label',label);
  toggle.title=label;
 }
}
function chartSidebarGroups(key,open){
 const fallback=['Care tools'];
 if(typeof me==='undefined'||!me?.tenant_id||!me?.user_id)return fallback;
 const preference='suncharts.chart-groups.'+JSON.stringify([me.tenant_id,me.user_id]);
 let groups;
 if(chartSidebarGroups.session?.preference===preference)groups=chartSidebarGroups.session.groups;
 else{
  try{groups=JSON.parse(localStorage.getItem(preference));}catch{}
  if(!Array.isArray(groups))groups=fallback;
 }
 if(key){
  groups=open?[...new Set([...groups,key])]:groups.filter(name=>name!==key);
  chartSidebarGroups.session={preference,groups};
  try{localStorage.setItem(preference,JSON.stringify(groups));}catch{}
 }
 return groups;
}
let chartSidebarFlyout=null,chartSidebarCloseTimer;
function chartSidebarIsRail(group){
 return group.closest('[data-sidebar-collapsed]')?.dataset.sidebarCollapsed==='true'&&
  typeof matchMedia==='function'&&matchMedia('(min-width:901px)').matches;
}
function chartSidebarGroupOpen(group,open){
 group.dataset.sidebarGroupOpen=String(open);
 const toggle=group.querySelector('[data-chart-group-toggle]');
 const panel=group.querySelector('[data-chart-group-flyout]');
 const rail=group.closest('[data-sidebar-collapsed]')?.dataset.sidebarCollapsed==='true';
 toggle.setAttribute('aria-expanded',String(rail?panel.hasAttribute('open'):open));
 panel.toggleAttribute('inert',!rail&&!open);
}
function closeChartSidebarFlyout(restoreFocus=false){
 clearTimeout(chartSidebarCloseTimer);
 if(!chartSidebarFlyout)return;
 const {panel,toggle}=chartSidebarFlyout;
 chartSidebarFlyout=null;
 if(panel.isConnected&&panel.hasAttribute('popover'))panel.hidePopover();
 panel.removeAttribute('open');
 panel.removeAttribute('popover');
 toggle.setAttribute('aria-expanded','false');
 if(restoreFocus&&toggle.isConnected)toggle.focus({preventScroll:true});
}
function openChartSidebarFlyout(group,focus=false){
 clearTimeout(chartSidebarCloseTimer);
 if(chartSidebarFlyout?.group!==group){
  closeChartSidebarFlyout();
  const toggle=group.querySelector('[data-chart-group-toggle]');
  const panel=group.querySelector('[data-chart-group-flyout]');
  const rect=toggle.getBoundingClientRect();
  const rail=group.closest('.chart-context').getBoundingClientRect();
  panel.style.setProperty('--chart-flyout-left',(rail.right+6)+'px');
  panel.style.setProperty('--chart-flyout-top',rect.top+'px');
  panel.setAttribute('open','');
  if(typeof panel.showPopover==='function'){
   panel.setAttribute('popover','manual');
   panel.showPopover();
  }
  const bottom=panel.getBoundingClientRect().bottom;
  if(bottom>window.innerHeight-10)panel.style.setProperty('--chart-flyout-top',Math.max(8,rect.top-(bottom-window.innerHeight+10))+'px');
  toggle.setAttribute('aria-expanded','true');
  chartSidebarFlyout={group,panel,toggle};
 }
 if(focus)chartSidebarFlyout.panel.querySelector('button')?.focus({preventScroll:true});
}
function chartNavigation(tabs){
 chartNavigation.tabs=tabs;
 const encounter=chartNavigationEncounter();
 const activeKey=chartNavigationKey(encounter);
 // Existing renderers update the chart after local saves and asynchronous banner loads.
 // Refresh markers from those loaded values without fetching or replacing the menu.
 if(typeof MutationObserver!=='undefined'&&!chartNavigation.observer&&$('chart')){
  chartNavigation.observer=new MutationObserver(refreshChartNavigationMarkers);
  chartNavigation.observer.observe($('chart'),{childList:true,subtree:true});
 }
 const available=new Map(tabs),can=key=>available.has(key)&&chartAreaEnabled(key)&&(typeof workspaceResourceAllowed!=='function'||(key==='source'?['clinical','billing','claims','migration']:['insurance','billing'].includes(key)?['billing']:key==='care_pathways'?['workflows']:['clinical']).every(resource=>workspaceResourceAllowed(resource)));
 const icons={
  careTools:'M4 6h16v14H4ZM9 6V3h6v3m-5 7h4m-2-2v4',
  patientChart:'M5 3h10l4 4v14H5ZM14 3v5h5m-10 4h6m-6 4h6',
  billingGroup:'M4 3h16v18l-4-2-4 2-4-2-4 2ZM8 8h8m-8 4h8m-8 4h4',
  records:'M3 5h7l2 2h9v13H3ZM7 12h10m-10 4h7',
  overview:'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9',
  profile:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
  problem:'M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z',
  allergy:'M12 3 2 21h20ZM12 9v5M12 17v1',
  medication:'m8 4-4 4a5 5 0 0 0 7 7l4-4a5 5 0 0 0-7-7ZM6 6l7 7M16 17h6M19 14v6',
  vitals:'M2 12h5l3-8 4 16 3-8h5',
  visits:'M5 5h14v16H5ZM8 2v6M16 2v6M5 10h14M8 14h3M8 17h7',
  encounters:'M4 3h13v3H4ZM7 8h13v13H7ZM10 12h7M10 16h5',
  orders:'M9 3h6M10 3v7L4 20h16l-6-10V3M8 15h8',
  referrals:'M4 5h7M4 5v14h14v-7M13 3h8v8M21 3 10 14',
  prescribing:'M4 3h11v6M4 3v18h16V9h-5V3M8 12h8M8 16h5',
  immunizations:'m14 3 7 7M17 6 6 17M4 15l5 5M6 17l-3 4M10 7l7 7',
  history:'M3 12a9 9 0 1 0 3-7M3 3v6h6M12 7v6l4 2',
  insurance:'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6ZM8 12l3 3 5-6',
  billing:'M3 5h18v14H3ZM3 9h18M6 15h4',
  documents:'M3 6h7l2 3h9v12H3ZM3 6V3h7l2 3h9v3',
  source:'M5 3h14v18H5ZM12 6v9M8 11l4 4 4-4M8 18h8',
  care_pathways:'M4 3h6v6H4ZM14 15h6v6h-6ZM7 9v9h7M10 6h7v9',
  functional_status:'M8 3h8v3h4v15H4V6h4ZM8 3v5h8V3M8 12h8M8 16h5',
  specialty_care:'M4 3v6a5 5 0 0 0 10 0V3M2 3h4M12 3h4M9 14v3a4 4 0 0 0 8 0v-3M20 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0'
 };
 const groups=[
  ['',encounter?[['visits','Current encounter']]:[]],
  ['Care tools',[['orders','Orders & results'],['prescribing','Prescribing'],['referrals','Referrals']],'careTools'],
  ['Patient chart',[['overview','Summary'],['profile','Profile'],['problem','Problems'],['allergy','Allergies'],['medication','Medications'],['vitals','Vitals']],'patientChart'],
  ['Billing',[['insurance','Insurance & copay'],['billing','Billing & payments']],'billingGroup'],
  ['History & records',[[encounter?'encounters':'visits','Encounter history'],['documents','Files'],['immunizations','Immunizations'],['history','Surgical & dental history'],['source','Imported records'],['care_pathways','Practice workflows'],['functional_status','Function & assessments'],['specialty_care','Specialty care']],'records']
 ];
 const clinicalKeys=['problem','allergy','medication'];
 const visible=groups.map(([label,items,icon])=>[label,items.filter(([key])=>['vitals','encounters'].includes(key)?can('visits'):can(clinicalKeys.includes(key)?'clinical':key)),icon]).filter(([,items])=>items.length);
 const button=([key,label])=>{
  const marker=encounter&&key==='visits'?'':key==='encounters'?'visits':key;
  const action=clinicalKeys.includes(key)?`data-clinical-focus="${key}"`:`data-chart-section="${key}"${key==='visits'&&!encounter?' data-encounter-history':''}`;
  return `<button type="button" title="${esc(label)}" aria-label="${esc(label)}"${marker?` aria-describedby="frame-chart-markers-${marker}"`:''} ${action} aria-pressed="${key===activeKey}"><span class="frame-section-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[key]}"/></svg></span><span class="frame-section-label">${esc(label)}</span>${marker?`<span id="frame-chart-markers-${marker}" class="frame-section-markers" data-chart-markers="${marker}">${chartNavigationMarkers(marker)}</span>`:''}</button>`;
 };
 const options=visible.map(([label,items])=>{
  const rows=items.map(([key,name])=>`<option value="${key}"${key===activeKey?' selected':''}>${esc(name)}</option>`).join('');
  return label?`<optgroup label="${esc(label)}">${rows}</optgroup>`:rows;
 }).join('');
 const collapsed=chartSidebarCollapsed();
 const openGroups=chartSidebarGroups();
 const links=visible.map(([label,items,icon],index)=>{
  const rows=items.map(button).join('');
  if(!label)return `<div class="frame-chart-group">${rows}</div>`;
  const open=openGroups.includes(label)||items.some(([key])=>key===activeKey);
  const id='frame-chart-group-'+index;
  return `<div class="frame-chart-group" data-chart-sidebar-group="${esc(label)}" data-sidebar-group-open="${open}">
   <button type="button" class="frame-chart-group-toggle" id="${id}-toggle" data-chart-group-toggle aria-label="${esc(label)}" aria-expanded="${open&&!collapsed}" aria-controls="${id}">
    <svg class="frame-chart-group-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[icon]}"/></svg>
    <span class="frame-chart-group-label">${esc(label)}</span>
    <svg class="frame-chart-group-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
   </button>
   <div id="${id}" class="frame-chart-group-panel" data-chart-group-flyout role="group" aria-labelledby="${id}-toggle"${open||collapsed?'':' inert'}><div><p class="frame-chart-flyout-title" aria-hidden="true">${esc(label)}</p>${rows}</div></div>
  </div>`;
 }).join('');
 const signature=[encounter?'encounter':'chart',...visible.flatMap(([,items])=>items.map(([key])=>key))].join(' ');
 const sidebarAction=collapsed?'Expand sidebar':'Collapse sidebar';
 const toggle=`<button type="button" class="frame-chart-sidebar-toggle" data-chart-sidebar-toggle aria-expanded="${!collapsed}" aria-controls="frame-chart-navigation" aria-label="${sidebarAction}" title="${sidebarAction}"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14m7-10-3 3 3 3"/></svg></button>`;
 return toggle+`<nav id="frame-chart-navigation" data-sidebar-collapsed="${collapsed}" data-current-chart-item="${esc(activeKey)}" class="chart-tabs patient-workspace-tabs frame-chart-navigation" data-navigation-signature="${esc(signature)}" aria-label="Patient workspace"${encounter?' data-encounter-navigation':''}><label class="frame-chart-select">Chart section<select id="frame-chart-select">${options}</select></label><div class="frame-chart-items">${links}</div></nav>`;
}
function patientWorkflowActions(){
 return `<section id="patient-next-action" class="patient-next-action">${patientWorkflowActionContent()}</section>`;
}
function patientWorkflowActionContent(){
 const open=(workspace.visits||[]).filter(visit=>visit.status==='in_progress'),v=activeVisit||open.find(visit=>visit.clinician_id===me?.user_id)||open[0];
 if(workspace.patient?.archived&&!v)return '<div><b>Archived patient chart</b><p>Review past encounters below. Restore the patient to book or start a new encounter.</p></div>';
 const appointment=v?workspace.appointments.find(a=>a.id===v.appointment_id):workspace.appointments.find(a=>['checked_in','booked'].includes(a.status));
 let action=typeof canStartEncounterFlow==='function'&&canStartEncounterFlow()?'<button type="button" class="primary" data-start-encounter-flow>Start encounter</button>':'<button type="button" class="primary" data-chart-section="visits">Appointments & visits</button>',detail='Check insurance, then start the encounter.';
 if(v){action=`<button type="button" class="primary" ${activeVisit?.id===v.id?'data-chart-section="visits"':`data-visit="${esc(v.id)}"`}>${v.status==='signed'?'Review encounter':'Continue encounter'}</button>`;detail=`${encounterDateLabel(v)} · ${v.status==='signed'?'Review procedures, checkout and billing for this encounter.':'Continue the selected visit, diagnoses and procedures.'}`;}
 else if(appointment?.status==='checked_in'&&(isRoomingStaff()||(['owner','clinician'].includes(me?.role)&&appointment.clinician_id===me.user_id))){action=`<button type="button" class="primary" data-start="${esc(appointment.id)}">Start encounter</button>`;detail='The patient is checked in and ready for their visit.';}
 else if(appointment?.status==='booked'&&['owner','clinician','front_desk'].includes(me?.role)){action=`<button type="button" class="primary" data-check-in="${esc(appointment.id)}">Check in patient</button>`;detail='Review insurance and copay before starting the encounter.';}
 const bar=$('encounter-bar'),step=v&&activeVisit?.id===v.id&&bar?.dataset?.visitId===v.id?bar.querySelector?.('.visit-billing-status'):null;
 if(step)return `${step.outerHTML}<div class="actions">${action}</div>`;
 return `<div><b>${v?'Current encounter':'Before the encounter'}</b><p>${esc(detail)}</p></div><div class="actions">${!v&&chartAreaEnabled('insurance')?'<button type="button" data-chart-section="insurance">Insurance & copay</button>':''}${action}</div>`;
}
function showChartSection(key){
 if(['problem','allergy','medication'].includes(key)){focusClinicalSection(key);return;}
 if(!['vitals','encounters','overview','profile','clinical','care_pathways','prescribing','immunizations','functional_status','specialty_care','history','documents','referrals','orders','visits','checkout','insurance','billing','source'].includes(key))return;
 if(!chartAreaEnabled(key)){notice('This chart area is hidden in the practice workspace.',true);return;}
 if(typeof workspaceResourceAllowed==='function'){
  const resources=['billing','insurance'].includes(key)?['billing']:key==='source'?['clinical','billing','claims','migration']:key==='care_pathways'?['workflows']:['clinical'];
  if(!resources.every(resource=>workspaceResourceAllowed(resource))){notice('Your role does not have access to this chart area.',true);return;}
 }
 if(typeof captureVisitDrafts==='function')captureVisitDrafts();
 if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
 if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
 if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
 if(typeof captureDocumentDraft==='function')captureDocumentDraft();
 if(typeof captureReferralDraft==='function')captureReferralDraft();
 if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft(); if(typeof captureImmunizationDraft==='function')captureImmunizationDraft();
 if(key==='checkout'&&activeVisit){setEncounterSection('checkout');return;}
 if(key==='checkout')key='visits';
 if(key===chartSection){applyChartSection();if(typeof alignChartContent==='function')alignChartContent();return;}
 const retain=typeof motionRetainChart==='function'?motionRetainChart($('chart'),true):null;
 const recordMenu=$('patient-record-navigation');if(recordMenu)recordMenu.open=false;
 if(key==='vitals'&&$('patient-vitals-history')){$('patient-vitals-history').outerHTML=patientVitalsHistory();void loadPatientVitalsReadings();}
 if(typeof chartCloseSheets==='function')chartCloseSheets();
 chartSection=key;applyChartSection();
 // A new chart section starts at its heading, even when the preceding encounter was scrolled far down.
 const frame=$('chart')?.closest?.('.frame-content')||document.querySelector?.('#app > main');
 if(frame)frame.scrollTop=0;
 if(typeof motionChartIn==='function')motionChartIn();
 if(key==='insurance'&&typeof renderPatientInsurance==='function')void renderPatientInsurance();
 if(key==='documents'&&typeof renderDocuments==='function')void renderDocuments();
 const refresh={referrals:typeof renderReferrals==='function'?renderReferrals:null,prescribing:typeof renderPrescribing==='function'?renderPrescribing:null,immunizations:typeof renderImmunizations==='function'?renderImmunizations:null,history:typeof renderHealthHistory==='function'?renderHealthHistory:null,care_pathways:typeof renderCarePathways==='function'?renderCarePathways:null};
 if(refresh[key])void refresh[key]();
 if(retain)retain();
 if(typeof alignChartContent==='function')alignChartContent();
}

const formData=f=>Object.fromEntries(new FormData(f));
function closeNavigation() {const wasOpen=$('sidebar').classList.contains('menu-open');$('sidebar').classList.remove('menu-open');$('nav-toggle').setAttribute('aria-expanded','false');$('nav-toggle').setAttribute('aria-label','Open navigation');if(wasOpen)$('page-title').focus({preventScroll:true});}
// A screen's first heading often repeats the page title right above it. The repeat is kept for
// screen-reader structure and taken out of sight, so each screen says its name once.
function hideRepeatedPageTitle(){
 const host=typeof $==='function'?$('tools'):null,title=($('page-title')?.textContent||'').trim().toLowerCase();if(!host?.querySelector||!title)return;
 const first=host.querySelector('h2');if(!first?.classList)return;
 first.classList.toggle('page-title-repeat',(first.textContent||'').trim().toLowerCase()===title);
}
if(typeof MutationObserver==='function'&&typeof document!=='undefined'&&document.addEventListener)document.addEventListener('DOMContentLoaded',()=>{const host=document.getElementById('tools');if(host)new MutationObserver(()=>hideRepeatedPageTitle()).observe(host,{childList:true});});
function setPage(title) {
 if(title!=='Sun'&&$('tools')?.classList.contains('sun-page'))$('tools').className='panel';
 if(title!=='Sun'&&typeof sunPanelView!=='undefined'&&sunPanelView==='page'){sunPanelView='chat';if(typeof mountSunWorkspace==='function')mountSunWorkspace();}
 if(!title.startsWith('Patient portal')&&typeof leavePortalStaffWorkspace==='function')leavePortalStaffWorkspace();
 const descriptions={
  'Practice home':'Today’s schedule, visits still open, and clinical work needing attention',
  'Practice overview':'Today’s schedule, visits still open, and clinical work needing attention',
  'Practice administration':'Manage staff access, providers, facilities and rooms',
  'Codes & prices':'Choose the code sets staff look up and the prices your codes start a charge at',
  'Partners':'Set up payments and choose the billing partner that works this practice',
  'Patients & encounters':'Find a patient, review their chart and continue visit work',
  'Schedule':'Book appointments, manage provider availability and follow reminders',
  'Pre-visit readiness':'Review public bookings, patient forms and visit preparation',
  'Appointment reminders':'Review due reminders, contact readiness and delivery history',
  'Reminder settings':'Configure appointment delivery and sender identity',
  'Labs & results':'Review ordered tests, reported results and acknowledgment work',
  'Specialty care':'Review functional status and specialty treatment worklists',
  'Workflow Studio':'Design intake, visit and follow-up pathways with reusable modules',
  'Automation Center':'Operate reviewed connectors, exact triggers and governed actions',
  'Billing & insurance':'Manage coverage, charges, balances and patient payments',
  'Clearinghouse':'Verify coverage, submit reviewed claims and reconcile payer responses',
  'Claim lifecycle':'Verify coverage, submit reviewed claims and reconcile payer responses',
  'Claims & remittances':'Prepare claims, post remittances and resolve corrections',
  'Payment settings':'Set up card payments for this practice',
  'Payment review':'Review checkout status and verified payment history',
  'Referral delivery settings':'Configure receiving partners and delivery credentials',
  'Referrals':'Coordinate referral handoffs, follow-up dates and outcomes',
  'Follow-up tasks':'Work assigned tasks by due date and completion status',
  'Integrations':'Configure this EHR instance’s communications, scheduling partners, AI and authorized applications',
  'Inbox':'Review patient messages, calls, texts, faxes and referral email in one place',
  'Communications':'Review calls, text messages, faxes and referral email in the Inbox',
  'Send & review':'Prepare and review calls, text messages, faxes and email before sending',
  'AI review':'Generate and review clinic-owned AI drafts before they affect workflow',
  'Sun':'Ask questions, navigate and review answers in your practice workspace',
  'Sun review':'Prepare and review Sun drafts using your practice’s AI provider',
  'Connect services':'Manage reminders and SunCharts support services',
  'Support tickets':'Track SunCharts service requests and replies',
  'Data import':'Bring in patient records from your previous system'
 };
 const today=['Practice home','Practice overview','Schedule','Pre-visit readiness','Appointment reminders','Reminder settings','Follow-up tasks','Inbox','Patient portal inbox','Communications','Send & review'];
 const care=['Patients & encounters','Labs & results','Specialty care','Referrals','Referral delivery settings'];
 const revenue=['Billing & insurance','Payment settings','Payment review','Claims & remittances','Clearinghouse','Claim connections'];
 const manage=['Sun','Workflow Studio','Automation Center','AI review','Sun review','Practice administration','Codes & prices','Partners','Integrations','Connect services','Support tickets','Data import'];
 // One name per screen: the heading says what the menu item that opened it says.
 const shown={'Practice home':'Home','Practice overview':'Home','Patients & encounters':'Patients','Labs & results':'Orders & results','Billing & insurance':'Billing','Claims & remittances':'Billing','Follow-up tasks':'Work queue','Claim lifecycle':'Claim connections','Clearinghouse':'Claim connections'};
 $('page-title').textContent=shown[title]||title;
 // The browser tab and the screen reader's page name follow the screen (WCAG 2.4.2).
 if(typeof document!=='undefined'&&'title' in document)document.title=`${shown[title]||title} · SunCharts EHR`;
 if(typeof hideRepeatedPageTitle==='function')hideRepeatedPageTitle();
 // A screen that has just been opened fades in briefly; staying on the same screen does not replay it.
 if(setPage.last!==title){setPage.last=title;for(const id of ['tools','clinical-workspace']){const node=$(id);if(!node?.classList?.add)continue;node.classList.remove('screen-in');void node.offsetWidth;node.classList.add('screen-in');}}
 $('page-description').textContent=descriptions[title]||'Practice workspace';
 $('workspace-section').textContent=(today.includes(title)||title.startsWith('Patient portal'))?'TODAY':care.includes(title)?'CARE':revenue.includes(title)?'REVENUE':manage.includes(title)?'MANAGE':'PRACTICE';
 const active=['Practice home','Practice overview'].includes(title)?'nav-practice':title==='Workflow Studio'?'nav-workflows':title==='Automation Center'?'nav-automation':['AI review','Sun review'].includes(title)?'nav-ai-review':['Inbox','Communications','Send & review'].includes(title)||title.startsWith('Patient portal')?'nav-portal':title==='Patients & encounters'?'nav-clinical':title==='Pre-visit readiness'?'nav-previsit':['Schedule','Appointment reminders','Reminder settings'].includes(title)?'nav-schedule':title==='Labs & results'?'nav-labs':title==='Specialty care'?'nav-specialty':['Billing & insurance','Payment settings','Payment review'].includes(title)?'nav-billing':['Clearinghouse','Claim connections','Claim lifecycle'].includes(title)?'nav-edi':title==='Claims & remittances'?'nav-claims':['Referrals','Referral delivery settings'].includes(title)?'nav-referrals':title==='Follow-up tasks'?'nav-followup':['Integrations','Connect services','Support tickets'].includes(title)?'nav-apps':title==='Data import'?'nav-migration':['Practice administration','Codes & prices'].includes(title)?'nav-admin':null;
 // A screen opened from inside Practice administration lights that menu item.
 const lit=active&&$(active)?.dataset?.offMenu!==undefined?'nav-admin':active;
 for(const id of ['nav-practice','nav-workflows','nav-automation','nav-ai-review','nav-communications','nav-clinical','nav-schedule','nav-previsit','nav-labs','nav-specialty','nav-referrals','nav-followup','nav-portal','nav-billing','nav-claims','nav-edi','nav-apps','nav-migration','nav-admin']){if(!$(id))continue;if(id===lit)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}
 const activeItem=active?$(active):null,activeMore=activeItem?.closest?.('.nav-more');
 document.querySelectorAll?.('#workspace-navigation .nav-more').forEach(more=>{
  more.open=more===activeMore;
  const summary=more.querySelector?.('summary');
  if(summary)summary.textContent=more===activeMore?`More tools · ${activeItem?.textContent?.trim()||'Current'}`:'More tools';
 });
 if(typeof framePage==='function')framePage(title);
 closeNavigation();
}
function showTool(title) {
 if(typeof captureSupportDrafts==='function')captureSupportDrafts();
 const query=new URLSearchParams(location.search);
 const keep={open:({'Sun':'sun','Workflow Studio':'workflow-studio','Automation Center':'automation-center','Claim connections':'claimmd','Claim lifecycle':'claimmd','Clearinghouse':'claimmd'})[title],era_batch:title==='Claims & remittances',payment_checkout:title==='Payment review',payment_settings:title==='Payment settings',copay_checkout:title==='Card payment status'};
 for(const key of Object.keys(keep))if(query.has(key)&&(!keep[key]||(key==='open'&&query.get(key)!==keep[key])))query.delete(key);
 const search=query.size?'?'+query.toString():'';
 if(search!==location.search)history.replaceState(null,'',location.pathname+search+location.hash);
 const motionPrev=typeof $==='function'?$('page-title')?.textContent:null;
 if(typeof rememberPatientChart==='function')rememberPatientChart();
 patientWorkspaceGeneration++;
 setPage(title);if(typeof motionIn==='function'&&motionPrev!==title)motionIn($('tools'));$('clinical-workspace').hidden=true;$('patient-form').hidden=true;$('tools').hidden=false;$('new-patient').hidden=true;$('toggle-directory').hidden=true;
 if(typeof frameRenderPatients==='function')frameRenderPatients();
}
let sunReturnWorkspace='nav-practice';
async function showSunPage(){
 if(!me||me.role==='patient')return;
 const openingAccount=me,openingGeneration=typeof sunGeneration==='undefined'?null:sunGeneration,openingPage=$('page-title')?.textContent;
 const inStudio=String($('tools')?.className||'').split(/\s+/).includes('workflow-studio')&&!$('tools')?.hidden;
 if($('page-title')?.textContent!=='Sun'&&((typeof sunDirtyPage!=='undefined'&&sunDirtyPage)||(inStudio&&((typeof studioDirty!=='undefined'&&studioDirty)||(typeof studioWorkspaceDirty!=='undefined'&&studioWorkspaceDirty))))){
  if(!(await confirmAction('Open the Sun page? Unsaved changes on this page may be lost.',{title:'Open Sun page',confirmLabel:'Open Sun page'})))return;
 }
 if(me!==openingAccount||openingPage!==$('page-title')?.textContent||(typeof sunGeneration!=='undefined'&&openingGeneration!==sunGeneration))return;
 if(typeof sunDirtyPage!=='undefined')sunDirtyPage=false;
 if($('page-title')?.textContent!=='Sun')sunReturnWorkspace=document.querySelector('#workspace-navigation [aria-current="page"]')?.id||'nav-practice';
 const presentationAnswer=typeof sunCapturePresentationAnswer==='function'?sunCapturePresentationAnswer('page'):null;
 // Keep the same transcript and listeners when switching presentations.
 const panel=$('sun-panel');if(panel)document.body.append(panel);
 showTool('Sun');sunPanelView='page';
 $('tools').className='sun-page';$('tools').innerHTML='<div id="sun-page-root"></div>';
 const query=new URLSearchParams(location.search);query.set('open','sun');history.replaceState(null,'',location.pathname+'?'+query.toString()+location.hash);
 await openSun();
 if(typeof sunRestorePresentationAnswer==='function')sunRestorePresentationAnswer(presentationAnswer);
}
function returnSunToChat(){
 if($('page-title')?.textContent==='Sun'){
  const available=button=>button&&!button.hidden&&!button.disabled&&button.dataset.workspaceHidden!=='true';
  const previous=$(sunReturnWorkspace),target=available(previous)?previous:$('nav-practice');
  if(busy||!available(target)){if(typeof sunStatus==='function')sunStatus('Finish the current action before returning to the floating chat.');return false;}
  const presentationAnswer=typeof sunCapturePresentationAnswer==='function'?sunCapturePresentationAnswer('chat'):null;
  sunPanelView='chat';mountSunWorkspace();target.click();
  if(typeof sunRestorePresentationAnswer==='function')sunRestorePresentationAnswer(presentationAnswer);
 }else{sunPanelView='chat';mountSunWorkspace();}
 return true;
}
async function showClinical() {
 const openingIdentity=me;
 captureVisitDrafts();rememberPatientChart();showTool('Patients & encounters');
 const openingGeneration=patientWorkspaceGeneration;
 selected=undefined;activeVisit=undefined;workspace=undefined;chartSection='overview';
 $('chart').innerHTML=patientDirectoryLanding();setPatientDirectoryVisible(true);
 $('tools').innerHTML=typeof skeletonMarkup==='function'?skeletonMarkup('rows'):'<p class="muted" role="status">Loading patient directory…</p>';
 const page=await api(typeof patientDirectoryQuery==='function'?patientDirectoryQuery():'/api/v1/patients');if(me!==openingIdentity||openingGeneration!==patientWorkspaceGeneration)return;
 patients=page.items;cursor=page.next_cursor;renderPatients();$('tools').replaceChildren();$('tools').hidden=true;
 $('clinical-workspace').hidden=false;$('new-patient').hidden=!canRegisterPatient();$('toggle-directory').hidden=false;
 if(typeof frameRenderPatients==='function')frameRenderPatients();
 $('search')?.focus({preventScroll:true});
}
const scopeNames={'clinical.read':'Read clinical records','clinical.write':'Update records using your clinical permissions','billing.read':'Read insurance and billing records','billing.write':'Update insurance and local billing records','events.read':'Receive record-change notices','migration.manage':'Stage and import EHR exports','offline_access':'Stay connected while you are away'};
async function showConsent() {
  const id=new URLSearchParams(location.search).get('oauth_request');
  if(!/^[0-9a-f-]{36}$/i.test(id||''))throw new Error('This connection request is invalid. Start again from SunCharts.');
  const request=await api(`/oauth/requests/${id}`);showTool('Authorize connection');
  $('tools').innerHTML=`<p class="eyebrow">CONNECT YOUR CLINICAL TOOLS</p><h2>Allow ${esc(request.name)} to connect?</h2><p>This grants access using your account on this SunCharts EHR installation.</p>${['https://connect.suncharts.app/oauth/ehr/callback','https://my.suncharts.app/oauth/ehr/callback'].includes(request.redirect_uri)?'<p>Connect your SunCharts workspace with access to clinical records, billing, imports and change notices allowed by your account role.</p>':`<ul>${request.scope.split(' ').map(s=>`<li>${esc(scopeNames[s]||s)}</li>`).join('')}</ul>`}<p>You can revoke access at any time in Integrations.</p><p class="muted">Return address: ${esc(new URL(request.redirect_uri).origin)}</p><div class="actions"><button class="primary" data-consent="allow" data-request="${esc(id)}">Allow connection</button><button data-consent="deny" data-request="${esc(id)}">Decline</button></div>`;
}
async function showApps() {
  const connection=typeof refreshConnectionBadge==='function'?await refreshConnectionBadge():null;
  const onboarding=me.role==='owner'?await api('/api/v1/connect/onboarding'):null;
  const grants=await api('/api/v1/oauth/grants');const clients=me.role==='owner'?await api('/api/v1/oauth/clients'):{items:[]};
  if(typeof showInstanceIntegrations==='function')return showInstanceIntegrations({connection,onboarding,grants,clients});
  showTool('Integrations');
  $('tools').innerHTML=`<p class="eyebrow">YOUR INTEGRATIONS</p><h2>Integrations</h2>${typeof connectStatusCard==='function'?connectStatusCard(connection):''}${me.role==='owner'?connectOnboardingCard(onboarding,connection):''}<p>Each person authorizes their own account. Revoking access also stops its live change feed.</p>${grants.items.map(g=>`<div class="timeline-row"><div><p><b>${esc(g.name)}</b></p><small>${g.revoked_at?'Access revoked':g.name==='SunCharts'?'SunCharts installation connection':esc(g.scope.split(' ').map(s=>scopeNames[s]||s).join(' · '))}</small></div>${g.revoked_at?'':`<button data-revoke="${esc(g.id)}">Revoke access</button>`}</div>`).join('')||'<p class="muted">No authorized applications yet.</p>'}
  <section class="billing-section"><div class="section-head"><div><h3>SunCharts Connect services</h3><p>Managed appointment email and support tickets for connected practices.</p></div><button type="button" data-connect-services>Open Connect services</button></div><p class="muted">Prefer your own branding? Configure your practice’s Resend account in Reminder settings. The self-hosted EHR works independently.</p></section>${me.role==='owner'?`<h3>Registered applications</h3>${clients.items.map(c=>`<p>${esc(c.name)} <small class="muted">${esc(new URL(c.redirect_uri).origin)}</small> ${c.disabled?'Disabled':`<button type="button" data-disable-client="${esc(c.id)}">Disable application</button>`}</p>`).join('')}` :''}`;
}
function rememberVisit(v,savedKind) {
 const previous=activeVisit;
 if(savedKind){
  const draft=visitDrafts.get(v.id);if(draft){delete draft[savedKind];for(const kind of ['note','vitals'])if(draft[kind]?.version===previous.version)draft[kind].version=v.version;if(!draft.note&&!draft.vitals)visitDrafts.delete(v.id);}
  for(const kind of ['note','vitals']){const form=$(kind+'-form');if(form?.dataset?.visitId===v.id&&Number(form.dataset.version)===previous.version)form.dataset.version=String(v.version);}
 }
 // A saved visit comes back without its encounter number (that is counted on the chart list); keep it.
 if(v.encounter_number==null){const known=workspace.visits.find(old=>old.id===v.id)?.encounter_number??(activeVisit?.id===v.id?activeVisit.encounter_number:null);if(known!=null)v.encounter_number=known;}
 if(savedKind){
  for(const id of ['rooming-form','visit-diagnoses-form']){const form=$(id);if(form?.dataset?.visitId===v.id&&Number(form.dataset.version)===previous.version)form.dataset.version=String(v.version);}
  for(const store of [typeof roomingDrafts==='undefined'?null:roomingDrafts,typeof visitDiagnosisDrafts==='undefined'?null:visitDiagnosisDrafts]){const draft=store?.get(v.id);if(draft?.version===previous.version)draft.version=v.version;}
  const diagnoses=typeof visitDiagnosisStates==='undefined'?null:visitDiagnosisStates.get(v.id);if(diagnoses?.version===previous.version)diagnoses.version=v.version;
 }
 if(typeof resetInsuranceCopayAppointment==='function')resetInsuranceCopayAppointment(selected,previous,v);
 activeVisit=v; workspace.visits=workspace.visits.map(old=>old.id===v.id?v:old); if(savedKind)captureVisitDrafts(false);updateDraftStatus();if(typeof showVisitNoteAuthorship==='function')showVisitNoteAuthorship();refreshEncounterProgress();if(savedKind&&savedKind!=='rooming'&&!$('rooming-form')&&typeof renderRooming==='function')void renderRooming();if(savedKind&&savedKind!=='diagnoses'&&!$('visit-diagnoses-form')&&typeof renderVisitDiagnoses==='function')void renderVisitDiagnoses();
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('submit',e=>{
  const form=e.target; if(!['login-form','patient-form','note-form','vitals-form','amendment-form','migration-form'].includes(form.id))return;
  e.preventDefault();run(async()=>{
    const data=formData(form);
    if(form.id==='login-form'){await api('/auth/login','POST',data);form.reset();void startApp(true);return;}
    if(form.id==='migration-form'){await uploadMigration(form);return;}
    if(form.id==='patient-form'){
      const contactKeys=['administrative_gender','email','phone','address_line1','address_line2','city','region','postal_code','country'];
      const contact=Object.fromEntries(contactKeys.map(key=>[key,data[key]||null]));contactKeys.forEach(key=>delete data[key]);
      const p=await api('/api/v1/patients','POST',data);patients.unshift(p);let contactError=null;
      if(Object.values(contact).some(Boolean))try{await api(`/api/v1/patients/${p.id}/demographics`,'PUT',{content:{preferred_name:null,pronouns:null,language:null,administrative_gender:contact.administrative_gender,phone:contact.phone,email:contact.email,address:{line1:contact.address_line1,line2:contact.address_line2,city:contact.city,region:contact.region,postal_code:contact.postal_code,country:contact.country},emergency_contact:null},reason:'Contact details recorded during patient registration'},0);}catch(error){contactError=error;}
      form.reset();form.hidden=true;await selectPatient(p.id);notice(contactError?`Patient ${p.mrn} was created, but contact details need review: ${contactError.message}`:`Patient registered with MRN ${p.mrn}.`,Boolean(contactError));$('notice').insertAdjacentHTML('beforeend','<div class="actions"><button type="button" data-chart-section="insurance">Add insurance</button><button type="button" data-chart-book="'+esc(p.id)+'">Book appointment</button><button type="button" data-patient-intakes-open>Send intake form</button></div>');if(form.dataset.referralEntry)await integrationReferralRegistered(p,form);return;
    }
    if(form.id==='vitals-form'){
      if(form.dataset.visitId!==activeVisit?.id||!canRecordVisitVitals(activeVisit))return;
      if(!Object.values(data).some(value=>value!=='')&&!Object.keys(activeVisit.vitals||{}).length)return;
      await visitNoteFlush({focusVitals:true});notice('Vitals saved.');return;
    }
    if(form.id==='note-form'){
      const automatic=form.querySelector?.('[data-note-autosave-retry]');
      if(automatic)visitNoteSaveStatus('Saving…');
      try{await visitNoteEnqueue(()=>saveVisitNote(form,formData(form)));}
      catch(error){if(automatic&&$('note-form')===form)visitNoteSaveStatus('Not saved');throw error;}
      return;
    }
    if(form.id==='amendment-form'){await submitVisitAmendment(form);}
  });
});
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',e=>{
  if(e.target.closest?.('#connect-login')?.id==='connect-login'){rememberHostedCopaySignInReturn();rememberPatientPaymentSetupSignInReturn();rememberPatientMembershipSignInReturn();rememberInvoiceCheckoutSignInReturn();return;}
  const button=e.target.closest('button');if(!button||(button.type==='submit' && button.form))return;
  if(button.dataset.action==='focus-amendment'){if(!busy){if(typeof noteEditSheetOpen==='function'&&typeof HTMLDialogElement!=='undefined')noteEditSheetOpen();else focusVisitAmendment();}return;}
  if(button.dataset.action==='show-saved-note'){if(!busy)showSavedNoteCopy();return;}
  if(button.dataset.action==='keep-note-draft'){if(!busy)keepNoteDraft();return;}
  if(button.dataset.action==='review-amendment-version'){if(!busy)reviewVisitAmendmentVersion(button);return;}
  // The compact vitals line: Edit vitals brings today's form out of the closed template and back
  // into the page, where it is the live #vitals-form and keeps the draft and autosave rules.
  if(button.dataset.action==='edit-vitals'){openVitalsForm();return;}
  if(button.id==='toggle-directory'){const show=$('clinical-workspace').classList.contains('directory-collapsed');setPatientDirectoryVisible(show);if(selected&&workspace)rememberPatientDirectoryPreference(show);return;}
  if(button.hasAttribute('data-encounter-history')){openPatientEncounterList();return;}
  if(button.dataset.clinicalFocus){focusClinicalSection(button.dataset.clinicalFocus);return;}
  if(button.dataset.chartSection){showChartSection(button.dataset.chartSection);return;}
  if(button.dataset.encounterSection){setEncounterSection(button.dataset.encounterSection,{openLink:true});return;}
  if(button.hasAttribute('data-encounter-back')){setEncounterSection('visit');return;}
  if(button.dataset.encounterStep){openEncounterStep(button.dataset.encounterStep);return;}
  if(button.id==='nav-toggle'){const open=$('sidebar').classList.toggle('menu-open');button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',open?'Close navigation':'Open navigation');return;}
  if(button.closest('#edi-tool')||button.dataset.ediClaim)return;
  if(button.closest('#claims-tool')||button.closest('#encounter-claims')||button.dataset.newClaim||button.dataset.mapClaim)return;
  if(button.closest('#billing-workspace')||button.closest('#billing-tool')||button.dataset.mapBilling)return;
  if(button.closest('#schedule-workspace')||button.dataset.mapAppointment)return;
  if(button.closest('#patient-demographics'))return;
  if(button.dataset.importSource||button.dataset.useContact||button.dataset.reconcileAll||button.dataset.importFilesAdd||button.dataset.importFilesRetry)return;
  if(button.closest('#clinical-lists')||button.closest('#lab-workspace')||button.dataset.mapLab||button.dataset.openLabPatient||button.dataset.mapClinical)return;
  if(button.id==='new-patient'){ if(!canRegisterPatient())return; $('patient-form').hidden=false;$('patient-form').elements.given_name.focus();return; }
  if(button.id==='cancel-patient'){ $('patient-form').reset();$('patient-form').hidden=true;return; }
  // Module handlers must be allowed to claim their own actions without this
  // listener briefly acquiring the shared busy gate and swallowing the click.
  const navigationTitles={'nav-schedule':'Schedule','nav-workflows':'Workflow Studio','nav-automation':'Automation Center','nav-communications':'Inbox','nav-ai-review':'Sun review','nav-referrals':'Referrals','nav-portal':'Inbox','nav-followup':'Follow-up tasks','nav-labs':'Labs & results','nav-specialty':'Specialty care','nav-edi':'Claim lifecycle','nav-claims':'Claims & remittances','nav-billing':'Billing & insurance','nav-admin':'Practice administration','nav-apps':'Integrations','nav-migration':'Data import','nav-clinical':'Patients & encounters','nav-customize':'Practice administration'};
  const navigationTitle=navigationTitles[button.id]||(button.hasAttribute('data-open-schedule')?'Schedule':null);
  const ownsAction=navigationTitle||['logout','load-more'].includes(button.id)||['data-consent','data-disable-client','data-revoke','data-reconcile','data-commit','data-patient','data-check-in','data-start','data-visit'].some(name=>button.hasAttribute(name))||['reload','discard-visit-draft','discard-amendment-draft','sign','sign-bill'].includes(button.dataset.action);
  if(!ownsAction)return;
  run(async()=>{
    if(navigationTitle){captureVisitDrafts();showTool(navigationTitle);$('tools').innerHTML=`<p class="muted" role="status">Loading ${esc(navigationTitle.toLowerCase())}…</p>`;}
    if(button.id==='nav-schedule'||button.hasAttribute('data-open-schedule')){await showSchedule({entry:true});return;}
    if(button.id==='nav-workflows'){studioView='overview';await showWorkflowStudio();return;}
    if(button.id==='nav-automation'){await showAutomationCenter();return;}
    if(button.id==='nav-communications'){await showIntegrationInbox();return;}
    if(button.id==='nav-ai-review'){await showAiReviewWorkspace();return;}
    if(button.id==='nav-referrals'){await showReferralWorkspace();return;}
    if(button.id==='nav-portal'){await showPortalInbox();return;}
    if(button.id==='nav-followup'){await showFollowupWorkspace();return;}
    if(button.id==='nav-labs'){await showLabInbox();return;}
    if(button.id==='nav-specialty'){await showSpecialtyWorklist();return;}
    if(button.id==='nav-edi'){await showEdiWorkspace();return;}
    if(button.id==='nav-claims'){await showClaimsWorkspace();return;}
    if(button.id==='nav-billing'){await showPatientBillingWorkspace({patientId:null,tab:'overview'});return;}
    if(button.id==='nav-customize'){await showPracticeAdmin('workspace');return;}
    if(button.id==='nav-admin'){await showPracticeAdmin();return;}
    if(button.id==='nav-partners'){await showPartners();return;}
    if(button.id==='nav-apps'){await showApps();return;}
    if(button.id==='nav-migration'){await showMigrations();return;}
    if(button.id==='nav-clinical'){await showClinical();return;}
    if(button.dataset.consent){const d=await api(`/oauth/requests/${button.dataset.request}/decision`,'POST',{approved:button.dataset.consent==='allow'});location.assign(d.redirect_uri);return;}
    if(button.dataset.disableClient){await api(`/api/v1/oauth/clients/${button.dataset.disableClient}/disable`,'POST');await showApps();notice('Application disabled and its grants revoked.');return;}
    if(button.dataset.revoke){await api(`/api/v1/oauth/grants/${button.dataset.revoke}/revoke`,'POST');await showApps();notice('Connection access revoked.');return;}
    if(button.dataset.reconcile){const report=await api(`/api/v1/migrations/${button.dataset.reconcile}/reconcile`,'POST');await showMigrations();if(typeof importNotice==='function')importNotice(report);return;}
    if(button.dataset.commit){await importCommit(button);return;}
    if(button.id==='logout'){await api('/auth/logout','POST');clearHostedCopaySignInReturn();clearPatientPaymentSetupSignInReturn();clearPatientMembershipSignInReturn();clearInvoiceCheckoutSignInReturn();signInScreen();return;}
    if(button.id==='load-more'){const page=await api(typeof patientDirectoryQuery==='function'?patientDirectoryQuery(cursor):`/api/v1/patients?after=${encodeURIComponent(cursor)}`);patients.push(...page.items);cursor=page.next_cursor;renderPatients();return;}
    if(button.dataset.patient){await selectPatient(button.dataset.patient);return;}
    if(button.dataset.checkIn){await api(`/api/v1/appointments/${button.dataset.checkIn}/check-in`,'POST');await selectPatient(selected);showChartSection('visits');notice('Patient checked in.');return;}
    if(button.dataset.start){const v=await api('/api/v1/visits','POST',{appointment_id:button.dataset.start});await selectPatient(selected,v.id);setEncounterSection('documentation');return;}
    if(button.dataset.visit){await openPatientEncounter(button.dataset.visit);return;}
    if(button.dataset.action==='reload'){await selectPatient(selected,activeVisit?.id);return;}
    if(button.dataset.action==='discard-amendment-draft'){await discardVisitAmendmentDraft();return;}
    if(button.dataset.action==='discard-visit-draft'){if(!await confirmAction('The unsaved note and vitals edits in this tab will be removed and the saved record will be shown.',{title:'Discard visit edits?',confirmLabel:'Discard edits',tone:'danger'}))return;visitDrafts.delete(activeVisit.id);if(typeof visitNoteSaved==='function')visitNoteSaved(activeVisit);renderVisit();notice('Unsaved visit edits discarded. The saved record is shown.');return;}
    if(['sign','sign-bill'].includes(button.dataset.action)){
      if(!canSignNote())throw new Error('A clinician must sign this note.');
      const patient=selected,visitId=activeVisit?.id,signer=me;
      const handoff=button.dataset.action==='sign-bill'&&button.dataset.claimHandoff;
      if(!handoff&&button.dataset.action==='sign-bill'&&$('visit-page-host')?.dataset?.encounterSteps!==undefined){
        const data=encounterRevenueState.data,summary=data?.summary;
        if(summary?.visit?.id&&summary.patient_id&&
          (data.stale||data.error||summary.visit.id!==visitId||summary.patient_id!==patient||summary.insurance?.insured))throw new Error('Refresh this encounter to review its claim, or use Sign only.');
      }
      const noteForm=$('note-form');
      // Subjective, Objective, Assessment and Plan must have text before the sign question appears.
      const missing=noteMissingForSign(noteForm);
      if(missing.length){refuseVisitNoteSigning(noteForm,missing);return;}
      await visitNoteFlush({signing:true});
      if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
      if(selected!==patient||activeVisit?.id!==visitId||me!==signer)return;
      if(handoff){
        await visitClaimHandoff(true,handoff);
        return;
      }
      const signing=activeVisit;
      if(signing.clinician_id!==me.user_id){
        // Covering a colleague's visit: one clear question. The encounter itself is not reassigned.
        const name=(typeof visitNoteAssignedName==='function'?await visitNoteAssignedName(signing):'')||'the assigned clinician';
        if(me!==signer||activeVisit!==signing)return;
        if(!await confirmAction(`The encounter stays assigned to ${name}. Check the rendering provider on the claim if you saw the patient.`,{eyebrow:'COVERING A VISIT',title:`Sign as yourself for ${name}’s visit?`,confirmLabel:'Sign',cancelLabel:'Cancel'}))return;
      }
      if(me!==signer||activeVisit!==signing)return;
      await visitNoteFlush({signing:true});
      if(me!==signer||activeVisit?.id!==signing.id)return;
      if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
      const v=await api(`/api/v1/visits/${activeVisit.id}/sign`,'POST',undefined,activeVisit.version);
      if(selected!==patient||activeVisit?.id!==visitId||me!==signer)return;
      // Nothing is posted yet and the practice shows billing, so leave a short reminder. On the
      // one-page visit it stays quiet while the encounter itself is open, because its charges block
      // is right there. It never blocks signing or checkout.
      const billingVisible=visitBillingAreaVisible();
      const posted=(workspace.billing?.accounts||[]).some(a=>a.status==='posted'&&a.status!=='void'&&String(a.content?.visit_id||'')===v.id);
      postSignReminder=billingVisible&&!posted&&v.status==='signed'?{visitId:v.id,message:'No charges are posted for this encounter yet.'}:null;
      // Signing leaves staff on the encounter page itself, where the charges and checkout follow in order.
      const restorePosition=typeof encounterStepPosition==='function'?encounterStepPosition():null;
      try{
        if(typeof clearVisitNoteSession==='function')clearVisitNoteSession();await selectPatient(selected,v.id);
        restorePosition?.();
        if(button.dataset.action==='sign-bill')await visitNoteBill();else notice(signNextPlan().done);
      }finally{restorePosition?.();}
    }
  });
});
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('sidebar').classList.contains('menu-open')){closeNavigation();$('nav-toggle').focus();}});
if(typeof document!=='undefined')$('search').addEventListener('input',renderPatients);
// All workspace modules are deferred. Publish the destination after they have rendered it.
function startApp(focusWorkspace=false){
  if(startupRequest)return startupRequest;
  const startup=$('workspace-startup'),status=$('startup-status'),retry=$('startup-retry'),app=$('app');
  app.setAttribute('inert','');$('login-screen').hidden=true;startup.hidden=false;
  status.textContent='Opening SunCharts…';retry.hidden=true;
  const opening=enter().then(()=>{
    if(startupRequest!==opening||!me)return;
    if(typeof restoreInitialWorkspaceScroll==='function')restoreInitialWorkspaceScroll();
    app.querySelectorAll('.screen-in,.motion-in').forEach(node=>node.classList.remove('screen-in','motion-in'));
    if(typeof initSun==='function')initSun();
    app.removeAttribute('inert');startup.hidden=true;
    if(focusWorkspace)$('page-title').focus({preventScroll:true});
    if(typeof startSunEvents==='function')void startSunEvents(me);
    if(typeof refreshConnectionBadge==='function')void refreshConnectionBadge();
    if(typeof startConnectUpdates==='function')void startConnectUpdates(me);
  }).catch(error=>{
    if(startupRequest!==opening||error?.signedOut)return;
    status.textContent="SunCharts couldn't finish loading. Try again.";
    retry.hidden=false;(retry.disabled?status:retry).focus();
  }).finally(()=>{if(startupRequest===opening)startupRequest=undefined;});
  startupRequest=opening;
  return opening;
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('DOMContentLoaded',()=>{
  $('startup-retry').onclick=()=>void startApp(true);
  void connectLaunchAcceptance.then(()=>startApp(),error=>{signInScreen();if(error?.message!=='Please sign in to continue.')$('login-error').textContent=error?.message||'';});
},{once:true});

if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('input',e=>{if(e.target.closest?.('#note-form,#vitals-form'))captureVisitDrafts();else if(e.target.closest?.('#amendment-form'))captureVisitAmendmentDraft();});
if(typeof window!=='undefined')window.addEventListener('beforeunload',e=>{captureVisitDrafts();if(visitAmendmentsHaveDrafts()||(typeof patientPaymentPlansHaveDrafts==='function'&&patientPaymentPlansHaveDrafts())||(typeof patientLifecycleHasDrafts==='function'&&patientLifecycleHasDrafts())||(typeof billingChargeHasDrafts==='function'&&billingChargeHasDrafts())||(typeof prescribingHaveDrafts==='function'&&prescribingHaveDrafts())||(typeof portalStaffHasDrafts==='function'&&portalStaffHasDrafts())||(typeof supportHasDrafts==='function'&&supportHasDrafts())||(typeof patientIdentityHasDrafts==='function'&&patientIdentityHasDrafts())||(typeof referralDeliveryHasDrafts==='function'&&referralDeliveryHasDrafts())||(typeof documentsHaveDrafts==='function'&&documentsHaveDrafts())||(typeof referralHasDrafts==='function'&&referralHasDrafts())||(typeof orderDiagnosisLinkDrafts!=='undefined'&&orderDiagnosisLinkDrafts.size)||(typeof accountDiagnosisLinkDrafts!=='undefined'&&accountDiagnosisLinkDrafts.size)||(typeof healthHistoryHasDrafts==='function'&&healthHistoryHasDrafts())||(typeof immunizationHasDrafts==='function'&&immunizationHasDrafts())||visitDrafts.size||(typeof visitDiagnosisDrafts!=='undefined'&&visitDiagnosisDrafts.size)||(typeof roomingDrafts!=='undefined'&&roomingDrafts.size)||(typeof checkoutDrafts!=='undefined'&&checkoutDrafts.size)){e.preventDefault();e.returnValue='';}});

if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('change',event=>{if(event.target.id!=='encounter-picker')return;const id=event.target.value;run(()=>openPatientEncounter(id));});

// Change notes never block saving. Every save is already recorded with who made it and when, so
// the note is optional: note fields are not required, most are tucked away, and a standard note is
// filled in when one is left blank. Notes that carry meaning for staff (cancelling, rescheduling,
// appeals, archiving, revoking, closing) stay visible but are still optional.
(()=>{
 if(typeof document==='undefined'||typeof document.querySelectorAll!=='function'||typeof MutationObserver!=='function')return;
 const selector='input[name="reason"],textarea[name="reason"]';
 const keepVisible=/cancel|reschedul|appeal|archiv|revok|close|reopen|refund|void/i;
 function prepare(field){
  if(field.dataset.optionalNote)return;field.dataset.optionalNote='1';
  field.removeAttribute('required');field.removeAttribute('minlength');
  const label=field.closest('label');
  if(label&&keepVisible.test(label.textContent||'')){if(!field.placeholder)field.placeholder='Optional';return;}
  const holder=label&&label.querySelectorAll('input,textarea,select').length===1?label:field;
  holder.hidden=true;holder.style.display='none';
 }
 function prepareAll(root){if(root.matches?.(selector))prepare(root);root.querySelectorAll?.(selector).forEach(prepare);}
 function standardNote(form,button){
  const action=(button?.textContent||form.querySelector('button[type="submit"],button:not([type])')?.textContent||'Saved').trim().replace(/\s+/g,' ').slice(0,80);
  return `${action||'Saved'} - no note entered`;
 }
 function fill(form,button){form?.querySelectorAll?.(selector).forEach(field=>{if(!field.value.trim())field.value=standardNote(form,button);});}
 // Runs before the browser validates and before any form handler reads the note.
 document.addEventListener('click',event=>{const button=event.target.closest?.('button,input[type="submit"]');const form=button?.form||button?.closest?.('form');if(form&&(button.type||'submit')==='submit')fill(form,button);},true);
 document.addEventListener('submit',event=>fill(event.target,event.submitter),true);
 const start=()=>{prepareAll(document.body);new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)prepareAll(node);}).observe(document.body,{childList:true,subtree:true});};
 if(document.body)start();else document.addEventListener('DOMContentLoaded',start);
})();

// An encounter's number in the practice, as staff and patients refer to it: ENC-0042.
function encounterNumberText(visit){const n=Number(visit?.encounter_number);return Number.isSafeInteger(n)&&n>0?`ENC-${String(n).padStart(4,'0')}`:'';}
function encounterNumberForAppointment(appointmentId){const visit=(typeof workspace!=='undefined'?workspace?.visits:null)?.find?.(v=>v.appointment_id===appointmentId);return encounterNumberText(visit);}

// A button on an empty screen that leads to where the work starts: it opens that menu item.
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',event=>{const button=event.target?.closest?.('[data-go-nav]'),target=button?.dataset?.goNav;if(!target)return;const item=document.getElementById(target);if(item?.click){event.preventDefault();item.click();}});

// Switch encounter sheet: its clicks, double-click to open, and the search box.
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('click',event=>{
  const target=event.target?.closest?.('[data-encounter-switch],[data-encounter-switch-pick],[data-encounter-switch-day],[data-encounter-switch-move],[data-encounter-switch-open]');if(!target?.dataset)return;
  if('encounterSwitch' in target.dataset){event.preventDefault();openEncounterSwitch();return;}
  if(!encounterSwitch.dialog?.isConnected||selected!==encounterSwitch.patient||me!==encounterSwitch.identity)return;
  if(target.dataset.encounterSwitchPick){event.preventDefault();encounterSwitchChoose(target.dataset.encounterSwitchPick);encounterSwitch.dialog.querySelector('[aria-selected="true"]')?.focus({preventScroll:true});return;}
  if(target.dataset.encounterSwitchDay){event.preventDefault();const key=target.dataset.encounterSwitchDay,onDay=encounterSwitchRows().filter(r=>r.key===key);encounterSwitch.day=key;if(onDay.length&&!onDay.some(r=>r.visit.id===encounterSwitch.selected))encounterSwitch.selected=onDay[0].visit.id;encounterSwitch.query='';const box=encounterSwitch.dialog.querySelector('[data-encounter-switch-search]');if(box)box.value='';encounterSwitchPaint(true);encounterSwitch.dialog.querySelector('[data-encounter-switch-day][aria-pressed="true"]')?.focus({preventScroll:true});return;}
  if(target.dataset.encounterSwitchMove){event.preventDefault();const m=encounterSwitch.month;encounterSwitch.month=new Date(m.getFullYear(),m.getMonth()+Number(target.dataset.encounterSwitchMove),1);encounterSwitchPaint();encounterSwitch.dialog.querySelector(`[data-encounter-switch-move="${target.dataset.encounterSwitchMove}"]`)?.focus({preventScroll:true});return;}
  if('encounterSwitchOpen' in target.dataset){event.preventDefault();const id=encounterSwitch.selected,dialog=encounterSwitch.dialog;if(!id||busy)return;const patient=selected,identity=me;
   run(async()=>{
    if(chartSection==='insurance'&&$('insurance-editor')?.querySelector('form'))throw new Error('Save or cancel the insurance form before switching encounters.');
    await openPatientEncounter(id);
    if(typeof sheetClose==='function')sheetClose(dialog);else dialog.close?.();
    if(selected===patient&&me===identity)$('patient-banner')?.querySelector('[data-encounter-switch]')?.focus({preventScroll:true});
   });}
 });
 document.addEventListener('dblclick',event=>{const pick=event.target?.closest?.('[data-encounter-switch-pick]');if(!pick?.dataset?.encounterSwitchPick||!encounterSwitch.dialog?.isConnected)return;encounterSwitch.selected=pick.dataset.encounterSwitchPick;encounterSwitch.dialog.querySelector('[data-encounter-switch-open]:not([disabled])')?.click();});
 document.addEventListener('input',event=>{if(!event.target?.hasAttribute?.('data-encounter-switch-search'))return;encounterSwitch.query=String(event.target.value||'');const dialog=encounterSwitch.dialog,list=dialog?.querySelector('[data-encounter-switch-list]');if(!list)return;
  list.innerHTML=encounterSwitchListMarkup();
  if(encounterSwitch.selected&&!list.querySelector('[aria-selected="true"]')){encounterSwitch.selected=null;encounterSwitch.day=null;encounterSwitchPaint();}});
}

// Open charts are session-only presentation state; never persist patient names to storage.
let framePatients=[];
let frameRecentPatients=[];
function frameRenderPatients(){
 const host=$('frame-patient-tabs');if(!host)return;
 const existing=host.querySelectorAll?.('[data-frame-patient]');
 if(existing?.length===framePatients.length&&Array.from(existing).every((button,i)=>button.dataset.framePatient===framePatients[i].id)){
  for(const button of existing){const active=selected===button.dataset.framePatient&&setPage.last==='Patients & encounters'&&!$('clinical-workspace').hidden;button.setAttribute('aria-current',active?'page':'false');button.parentElement.classList.toggle('active',active);}return;
 }
 host.innerHTML=framePatients.map(p=>`<span class="frame-patient-tab${selected===p.id&&setPage.last==='Patients & encounters'&&!$('clinical-workspace').hidden?' active':''}"><button type="button" data-frame-patient="${esc(p.id)}" aria-current="${selected===p.id&&setPage.last==='Patients & encounters'&&!$('clinical-workspace').hidden?'page':'false'}" title="${esc(p.family_name)}, ${esc(p.given_name)}"><span class="avatar" aria-hidden="true">${esc((p.given_name||'')[0]||'')}${esc((p.family_name||'')[0]||'')}</span><span class="frame-patient-name">${esc(p.family_name)}, ${esc(p.given_name)}</span></button><button type="button" data-frame-close="${esc(p.id)}" aria-label="Close chart for ${esc(p.family_name)}, ${esc(p.given_name)}">×</button></span>`).join('');
}
function frameOpenPatient(patient){
 if(!patient?.id)return;
 const existing=framePatients.find(p=>p.id===patient.id);
 const name={given_name:patient.given_name,family_name:patient.family_name};
 if(existing)Object.assign(existing,name);
 else framePatients=[...framePatients,{id:patient.id,...name}].slice(-5);
 frameRecentPatients=frameRecentPatients.filter(id=>framePatients.some(p=>p.id===id));
 if(selected===patient.id)frameRecentPatients=[...frameRecentPatients.filter(id=>id!==patient.id),patient.id];
 frameRenderPatients();
}
function frameUserMenuOpen(open){
 const toggle=$('frame-user-toggle'),panel=$('frame-user-panel');
 if(toggle)toggle.setAttribute('aria-expanded',String(open));if(panel)panel.hidden=!open;
}
function clearFramePatients(){if(typeof patientChartCache!=='undefined'){patientChartCache.clear();patientTabReads.clear();patientWorkspaceGeneration++;}framePatients=[];frameRecentPatients=[];frameRenderPatients();const menu=$('frame-user-menu');if(menu)frameUserMenuOpen(false);}
async function frameSelectPatient(id,{section,visit,step}={}){
 if(id===selected&&workspace?.patient?.id===id&&!$('clinical-workspace').hidden&&!section&&visit===undefined&&step===undefined&&patientChartAccessMatches(workspace,me,patientChartAccess().key))return;
 return selectPatient(id,visit,undefined,{section,step,tabSelection:true});
}
async function frameClosePatient(id){
 if(typeof patientChartCache!=='undefined'){patientChartCache.delete(id);patientTabReads.delete(id);}
 framePatients=framePatients.filter(p=>p.id!==id);frameRecentPatients=frameRecentPatients.filter(patient=>patient!==id);frameRenderPatients();
 if(selected!==id||$('clinical-workspace').hidden)return;
 const next=frameRecentPatients.at(-1)||framePatients.at(-1)?.id;
 if(next)await frameSelectPatient(next);else await showClinical();
}
function framePage(title){
 const help=$('frame-help');if(help)help.hidden=typeof supportHelpAvailable==='function'&&!supportHelpAvailable();
 const billing=['Billing & insurance','Claims & remittances'].includes(title),primary=$('frame-billing');
 if(primary){primary.hidden=['nav-billing','nav-claims'].every(id=>$(id)?.hidden);if(billing)primary.setAttribute('aria-current','page');else primary.removeAttribute('aria-current');}
 const tabs=$('frame-billing-tabs');if(tabs)tabs.hidden=!billing;
 if(title==='Claims & remittances')$('nav-billing')?.removeAttribute('aria-current');
 const payments=$('nav-insurance-payments');if(payments){payments.hidden=$('nav-claims')?.hidden??true;if(title==='Claims & remittances'&&typeof billingInsuranceTab!=='undefined'&&billingInsuranceTab==='payments'){payments.setAttribute('aria-current','page');$('nav-claims')?.removeAttribute('aria-current');}else payments.removeAttribute('aria-current');}
 if(['Labs & results','Referrals','Follow-up tasks','Inbox'].includes(title))$('nav-practice')?.setAttribute('aria-current','page');
 frameRenderPatients();
}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('change',event=>{if(event.target.id==='frame-chart-select')run(()=>event.target.value==='visits'&&!event.target.closest('[data-encounter-navigation]')?openPatientEncounterList():showChartSection(event.target.value));});
 document.addEventListener('click',event=>{
  const menu=$('frame-user-menu'),b=event.target.closest?.('button');
  if(b?.id==='frame-user-toggle'){frameUserMenuOpen(b.getAttribute('aria-expanded')!=='true');return;}
  if((menu&&!menu.contains(event.target))||(b&&menu?.contains(b)&&!b.closest?.('.theme-control')))frameUserMenuOpen(false);
  if(!b)return;
  if(b.id==='frame-support')run(()=>showSupportTickets());
  const add=b.closest?.('.frame-add-menu');if(add)add.open=false;
  if(b.id==='frame-billing'){const id=['nav-claims','nav-billing'].find(id=>!$(id)?.hidden);if(id)$(id).click();}
  if(b.dataset.framePatient)void frameSelectPatient(b.dataset.framePatient).catch(error=>notice(error.message,true));
  if(b.dataset.frameClose)run(()=>frameClosePatient(b.dataset.frameClose));
 });
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('frame-user-toggle')?.getAttribute('aria-expanded')==='true'){frameUserMenuOpen(false);$('frame-user-toggle').focus();}});
}

// Row clicks use the same chart opener as the accessible patient-name button.
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',event=>{
 const row=event.target.closest?.('[data-directory-patient]');
 if(row&&!event.target.closest('button'))row.querySelector('[data-patient]')?.click();
 const status=event.target.closest?.('[data-directory-status]');
 if(status){const select=$('patient-status-filter');select.value=status.dataset.directoryStatus;select.dispatchEvent(new Event('change',{bubbles:true}));}
});
