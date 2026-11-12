// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

// One patient billing view serves the chart and the practice worklist. Only opaque
// navigation identifiers enter history; patient data stays in memory.
const patientBillingTabs=[['overview','Overview'],['invoices','Invoices'],['payments','Payments'],['methods','Payment methods'],['subscriptions','Subscriptions & plans']];
let patientBillingWorkspace=null,patientBillingGeneration=0;
function patientBillingAllowed(resource='billing'){
 return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);
}
function patientBillingCurrent(s){
 if(!s||patientBillingWorkspace!==s||s.identity!==me||!patientBillingAllowed()||$(s.host.id)!==s.host||s.host.isConnected===false)return false;
 return s.surface==='chart'?selected===s.patientId&&chartSection==='billing'&&$('clinical-workspace')?.hidden===false:$('tools')?.hidden===false;
}
function patientBillingName(patient){return patient?`${patient.family_name}, ${patient.given_name}`:'All patients';}
function patientBillingAmount(amount,currency='USD'){
 if(!Number.isSafeInteger(amount))return 'Not available';
 if(!/^[a-z]{3}$/i.test(currency||''))return 'Currency not available';
 // Stripe minor units differ from ISO for ISK/UGX. See https://docs.stripe.com/currencies.
 const zeroDecimal=['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF'];
 const unit=zeroDecimal.includes(currency.toUpperCase())?1:100;
 try{return new Intl.NumberFormat('en-US',{style:'currency',currency:currency.toUpperCase()}).format(amount/unit);}catch{return 'Currency not available';}
}
function patientBillingRoute(){
 const s=patientBillingWorkspace;
 return patientBillingCurrent(s)?{patient:s.patientId||null,tab:s.tab,mode:s.mode,surface:s.surface,plan:s.planTargetId||null}:null;
}
async function restorePatientBillingRoute(route){
 const options={patientId:route?.patient||null,tab:route?.tab,mode:route?.mode,planId:route?.plan||null};
 if(route?.surface==='chart'&&selected===options.patientId){showChartSection('billing');return renderPatientBillingChart(options);}
 return showPatientBillingWorkspace(options);
}
function patientBillingShell(s){
 const patient=s.patient;
 const selector=s.surface==='global'?`<section class="patient-billing-selector" aria-label="Choose patient"><form id="billing-patient-search-form"><label for="billing-patient-search">Find a patient</label><div class="patient-billing-search-row"><input id="billing-patient-search" name="q" type="search" maxlength="100" autocomplete="off" placeholder="Name or medical record number"><button type="submit">Search</button>${s.patientId?'<button type="button" data-hub-all>All patients</button>':''}</div></form><div id="billing-patient-results" aria-live="polite"></div></section>`:'';
 return `<header class="patient-billing-header"><div><p class="chart-record-label">PATIENT BILLING</p><h2 id="patient-billing-heading">${esc((s.patientId&&!patient?'Selected patient':patientBillingName(patient)))}</h2><p id="patient-billing-context">${s.patientId?(patient?`MRN ${esc(patient.mrn)}${patient.archived?' · Archived patient':''}`:'Loading selected patient…'):'Practice overview · choose a patient to manage their billing'}</p></div><div class="actions"><button type="button" data-hub-refresh>Refresh</button>${s.surface==='global'?'<button type="button" data-hub-tools>Practice billing tools</button>':''}${me.role==='owner'?'<button type="button" data-payment-settings>Practice payment settings</button>':''}</div></header>${selector}<nav class="patient-billing-tabs" role="tablist" aria-label="Patient billing">${patientBillingTabs.map(([key,label])=>`<button type="button" id="patient-billing-tab-${key}" role="tab" aria-controls="patient-billing-panel" aria-selected="${s.tab===key}" tabindex="${s.tab===key?0:-1}" data-hub-tab="${key}">${label}</button>`).join('')}</nav><div class="patient-billing-scope" ${['methods','subscriptions'].includes(s.tab)?'hidden':''}><label>Payment records<select id="patient-billing-mode"><option value="recorded" ${s.mode==='recorded'?'selected':''}>Clinic records</option><option value="test" ${s.mode==='test'?'selected':''}>TEST card activity</option></select></label><p>Test card activity is shown separately from clinic records.</p></div><section id="patient-billing-panel" role="tabpanel" aria-labelledby="patient-billing-tab-${s.tab}" aria-live="polite"><p role="status">Loading billing records…</p></section><section id="patient-billing-preview" aria-live="polite" hidden></section>`;
}
function patientBillingState(host,surface,options={}){
 const previous=patientBillingWorkspace?.identity===me?patientBillingWorkspace:null;
 const patientId=Object.hasOwn(options,'patientId')?options.patientId:surface==='chart'?selected:previous?.surface==='global'?previous.patientId:null;
 const same=previous?.patientId===patientId;
 return {identity:me,generation:++patientBillingGeneration,host,surface,patientId:patientId||null,
  patient:surface==='chart'?workspace.patient:options.patient|| (same?previous.patient:null),
  tab:patientBillingTabs.some(([key])=>key===options.tab)?options.tab:same?previous.tab:'overview',
  mode:['recorded','test'].includes(options.mode)?options.mode:same?previous.mode:'recorded',
  accountsAfter:options.accountsAfter||null,copaysAfter:options.copaysAfter||null,invoicesAfter:options.invoicesAfter||null,paymentsAfter:options.paymentsAfter||null,
  planTargetId:options.planId||null,native:null,profile:null,profileCursors:{},searchRequest:0,panelRequest:0,profileRequest:0};
}
async function showPatientBillingWorkspace(options={}){
 if(!patientBillingAllowed())throw new Error('Your role does not have access to patient billing.');
 if(typeof captureVisitDrafts==='function')captureVisitDrafts();
 if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
 showTool('Billing & insurance');
 $('tools').innerHTML='<section id="billing-tool"><div id="patient-billing-global" class="patient-billing-hub"></div></section>';
 return renderPatientBillingWorkspace($('patient-billing-global'),'global',options);
}
function preparePatientBillingChart(panel){
 panel.innerHTML='<div id="patient-billing-chart" class="patient-billing-hub"></div><div id="billing-detail"></div><div id="billing-editor"></div>';
}
async function renderPatientBillingChart(options={}){
 const host=$('patient-billing-chart');
 if(!host||chartSection!=='billing'||!patientBillingAllowed())return;
 if(!Object.keys(options).length&&patientBillingCurrent(patientBillingWorkspace)&&patientBillingWorkspace.host===host)return patientBillingWorkspace;
 return renderPatientBillingWorkspace(host,'chart',{...options,patientId:selected});
}
async function renderPatientBillingWorkspace(host,surface,options={}){
 const s=patientBillingState(host,surface,options);patientBillingWorkspace=s;
 host.innerHTML=patientBillingShell(s);
 await loadPatientBillingTab(s);
 return s;
}
function patientBillingQuery(s,extra={}){
 const q=new URLSearchParams({mode:s.mode,...extra});
 if(s.patientId)q.set('patient_id',s.patientId);
 return q;
}
async function patientBillingNative(s){
 if(s.native)return s.native;
 const q=patientBillingQuery(s);
 if(s.accountsAfter)q.set('accounts_after',s.accountsAfter);
 if(s.copaysAfter)q.set('copays_after',s.copaysAfter);
 const data=await api('/api/v1/billing/overview?'+q);
 if(!patientBillingCurrent(s))return null;
 if(s.patientId&&data.patient?.id!==s.patientId)throw new Error('The returned billing records do not match the selected patient.');
 s.native=data;if(data.patient)s.patient=data.patient;
 const heading=s.host.querySelector('#patient-billing-heading'),context=s.host.querySelector('#patient-billing-context');
 if(heading)heading.textContent=patientBillingName(s.patient);
 if(context&&s.patient)context.textContent=`MRN ${s.patient.mrn}${s.patient.archived?' · Archived patient':''}`;
 return data;
}
function patientBillingTestNotice(s){return s.mode==='test'?'<p class="mapping-notice"><b>TEST activity — no real card funds collected.</b></p>':'';}
function patientBillingSummary(data){
 const a=data.summary.accounts,c=data.summary.copays;
 return `<div class="patient-billing-totals"><section><span>Reviewed patient amount due</span><strong>${money(a.reviewed_patient_due_cents)}</strong><small>${esc(a.open_invoice_count)} current open invoices${a.invoice_review_count?` · ${esc(a.invoice_review_count)} need review and are excluded`:''}</small></section><section><span>Copays received</span><strong>${money(c.net_received_cents)}</strong><small>${esc(c.receipts)} receipts · net of verified refunds</small></section><section><span>Unapplied credit</span><strong>${money(c.usable_unapplied_cents)}</strong><small>${c.review_count?`${esc(c.review_count)} receipts require review`:'Available recorded credit; not another collection'}</small></section></div>`;
}
function patientBillingAccounts(data,s){
 return `<section class="billing-section"><h3>Encounter charges & latest invoices</h3><p class="muted">Gross charges include patient and insurer shares. Review the exact encounter to change charges, post a payment or prepare an insurance claim.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Patient / service</th><th>Account / payer</th><th>Gross charges</th><th>Latest patient invoice</th><th>Actions</th></tr></thead><tbody>${billingOverviewAccountRows(data.accounts.items)}</tbody></table></div>${s.accountsAfter?'<button type="button" data-hub-accounts-first>First accounts page</button>':''}${data.accounts.next_cursor?`<button type="button" data-hub-accounts="${esc(data.accounts.next_cursor)}">Next accounts</button>`:''}</section>`;
}
function patientBillingReceipts(data,s){
 return `<section class="billing-section"><h3>Copay receipts</h3><p class="muted">A receipt means funds were recorded. Applying it to an encounter does not collect it again.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Patient / received</th><th>Evidence / status</th><th>Net recorded</th><th>Usable credit</th><th>Actions</th></tr></thead><tbody>${billingOverviewCopayRows(data.copays.items)}</tbody></table></div>${s.copaysAfter?'<button type="button" data-hub-copays-first>First receipts page</button>':''}${data.copays.next_cursor?`<button type="button" data-hub-copays="${esc(data.copays.next_cursor)}">Next receipts</button>`:''}</section>`;
}
async function patientBillingPaymentHistory(s){
 const query=new URLSearchParams({mode:s.mode});if(s.paymentsAfter)query.set('after',s.paymentsAfter);
 const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/payment-history?${query}`);
 if(!patientBillingCurrent(s))return null;
 if(data.patient_id!==s.patientId||data.mode!==s.mode||!Array.isArray(data.items))throw new Error('The payment history does not match the selected patient and activity view.');
 const kinds={copay:'Copay receipt',account_payment:'Account card payment',recorded_payment:'Recorded account payment',invoice_checkout:'Invoice installment payment'};
 return `<section class="billing-section"><h3>Payment history</h3><p class="muted">Received amounts are shown only when supported by saved evidence. Allocating a copay is not a second payment. Pending attempts remain separate from received funds.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Recorded / kind</th><th>Status</th><th>Received</th><th>Refunded / unapplied</th><th></th></tr></thead><tbody>${data.items.map(item=>`<tr><td>${esc(date(item.created_at))}<small>${esc(kinds[item.kind]||'Payment record')}${item.test_activity?' · TEST':''}</small></td><td>${esc(human(item.status||'Status unavailable'))}<small>${item.ledger_recorded?'Recorded in ledger':'No ledger posting confirmed'}</small>${item.reference?`<small>${esc(item.reference)}</small>`:''}</td><td>${item.received_cents==null?'Not verified':money(item.received_cents)}</td><td>${item.refunded_cents==null?'Refund not available':money(item.refunded_cents)+' refunded'}<small>${item.unapplied_cents==null?'Unapplied credit not available':money(item.unapplied_cents)+' unapplied'}</small></td><td>${item.kind==='copay'&&item.receipt_id?`<button type="button" data-overview-receipt="${esc(item.receipt_id)}">View / print receipt</button>`:''}${item.kind==='invoice_checkout'?`<button type="button" data-invoice-checkout-review="${esc(item.id)}">Review installment payment</button>`:''}${item.account_id&&patientBillingAllowed('clinical')?`<button type="button" data-billing-patient="${esc(s.patientId)}" data-account="${esc(item.account_id)}">Review encounter billing</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5">No payment records in this view.</td></tr>'}</tbody></table></div>${s.paymentsAfter?'<button type="button" data-hub-payments-first>First payments page</button>':''}${data.next_cursor?`<button type="button" data-hub-payments="${esc(data.next_cursor)}">Next payments</button>`:''}</section>`;
}
function patientBillingChoosePatient(label){return `<section class="patient-billing-empty"><h3>Choose a patient to view ${esc(label)}</h3><p>Use the patient selector above. Records are retrieved only for the selected patient.</p></section>`;}
async function patientBillingInvoices(s){
 if(!s.patientId){const data=await patientBillingNative(s);return data?patientBillingChoosePatient('their invoices')+patientBillingAccounts(data,s):null;}
 const q=new URLSearchParams({mode:s.mode});if(s.invoicesAfter)q.set('after',s.invoicesAfter);
 const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/invoices?${q}`);
 if(!patientBillingCurrent(s))return null;
 if(!Array.isArray(data.items)||data.items.some(invoice=>invoice.patient_id!==s.patientId))throw new Error('The invoice list does not match the selected patient.');
 return `<section class="billing-section"><h3>Patient invoices</h3><p class="muted">Saved invoices retain their original charges, credits and amount due. Later account changes may require a new review.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Issued / service</th><th>Amount at issuance</th><th>Review status</th><th></th></tr></thead><tbody>${data.items.map(i=>`<tr><td>${esc(date(i.created_at))}<small>${esc(i.snapshot?.service_date||'Service date in invoice')}</small></td><td>${money(i.snapshot?.amount_due_cents)}<small>Saved invoice amount</small></td><td>${i.needs_review?'Needs review — account changed':i.is_latest?'Latest invoice':'Earlier invoice · retained'}<small>${esc(human(i.account_status||''))}</small></td><td><button type="button" data-overview-invoice="${esc(i.id)}">View / print invoice</button></td></tr>`).join('')||'<tr><td colspan="4">No patient invoices in this view.</td></tr>'}</tbody></table></div>${s.invoicesAfter?'<button type="button" data-hub-invoices-first>First invoices page</button>':''}${data.next_cursor?`<button type="button" data-hub-invoices="${esc(data.next_cursor)}">Next invoices</button>`:''}</section><section id="patient-billing-stripe-invoices" class="billing-section"><h3>Stripe customer invoices</h3><p role="status">Loading separately recorded Stripe invoices…</p></section>`;
}
async function loadPatientBillingTab(s){
 const panel=s.host.querySelector('#patient-billing-panel');if(!panel||!patientBillingCurrent(s))return;
 const request=++s.panelRequest;panel.innerHTML='<p role="status">Loading billing records…</p>';
 try{
  let html;
  if(s.patientId&&!s.patient){if(!await patientBillingNative(s))return;}
  if(s.tab==='payments'&&s.patientId)html=patientBillingTestNotice(s)+await patientBillingPaymentHistory(s);
  else if(s.tab==='overview'||s.tab==='payments'){
   const data=await patientBillingNative(s);if(!data)return;
   html=patientBillingTestNotice(s)+patientBillingSummary(data)+(s.tab==='overview'?`<div class="actions"><button type="button" data-hub-tab="invoices">View invoices</button><button type="button" data-hub-tab="payments">View payments & receipts</button>${s.patientId?'<button type="button" data-hub-tab="methods">Manage payment methods</button><button type="button" data-hub-tab="subscriptions">View subscriptions</button>':''}</div>${patientBillingAccounts(data,s)}`:patientBillingReceipts(data,s));
  }else if(s.tab==='invoices')html=patientBillingTestNotice(s)+await patientBillingInvoices(s);
  else if(s.tab==='subscriptions'&&s.patientId&&typeof loadPatientPaymentPlans==='function')html='<section id="patient-billing-memberships" class="billing-section"><p role="status">Loading practice memberships…</p></section><section id="patient-billing-installments" class="billing-section"><p role="status">Loading encounter payment plans…</p></section><details class="billing-section"><summary>Other Stripe subscription records</summary><section id="patient-billing-profile-section"><p role="status">Loading Stripe subscription records…</p></section></details>';
  else html=s.patientId?`<section id="patient-billing-profile-section"><p role="status">Loading ${s.tab==='methods'?'payment methods':'subscriptions'}…</p></section>`:patientBillingChoosePatient(s.tab==='methods'?'payment methods':'subscriptions');
  if(!patientBillingCurrent(s)||s.panelRequest!==request||s.host.querySelector('#patient-billing-panel')!==panel)return;
  panel.innerHTML=html;
  if(s.patientId&&['methods','subscriptions','invoices'].includes(s.tab))void loadPatientBillingProfile(s,request);
  if(s.tab==='subscriptions'&&s.patientId&&typeof loadPatientPaymentPlans==='function')void loadPatientPaymentPlans(s);
 }catch(error){if(patientBillingCurrent(s)&&s.panelRequest===request)panel.innerHTML=`<p role="alert">${esc(error.message||'Billing records are unavailable.')}</p><button type="button" data-hub-refresh>Try again</button>`;}
}

function patientBillingProviderDate(value){return Number.isSafeInteger(value)&&value>0?date(new Date(value*1000).toISOString()):'Not recorded';}
function patientBillingProfileKey(tab){return tab==='methods'?'payment_methods':tab==='subscriptions'?'subscriptions':'invoices';}
function patientBillingProfileTarget(s){return s.host.querySelector(s.tab==='invoices'?'#patient-billing-stripe-invoices':'#patient-billing-profile-section');}
async function loadPatientBillingProfile(s,request){
 const target=patientBillingProfileTarget(s);if(!target)return;
 const profileRequest=++s.profileRequest,tab=s.tab,key=patientBillingProfileKey(tab),query=new URLSearchParams();
 if(s.profileCursors[key])query.set(tab==='methods'?'methods_after':tab==='subscriptions'?'subscriptions_after':'invoices_after',s.profileCursors[key]);
 try{
  const data=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/payment-profile`+(query.size?'?'+query:''));
  if(!patientBillingCurrent(s)||s.panelRequest!==request||s.profileRequest!==profileRequest||patientBillingProfileTarget(s)!==target)return;
  if(data.patient_id!==s.patientId||typeof data.livemode!=='boolean')throw new Error('The payment profile does not match the selected patient.');
  s.profile=data;
  if(tab==='methods'&&data.active_setup){
   const active=data.active_setup;
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(active.request_id||''))throw new Error('The pending setup reference could not be verified.');
   const local=patientBillingSetupFor(s);
   if(local?.request_id!==active.request_id)patientBillingSetups.set(s.patientId,{request_id:active.request_id,patient_id:s.patientId,status:active.status});
   try{
    const setup=await api('/api/v1/billing/payment-setups/'+encodeURIComponent(active.request_id));
    if(!patientBillingCurrent(s)||s.panelRequest!==request||s.profileRequest!==profileRequest||patientBillingProfileTarget(s)!==target)return;
    if(setup.request_id!==active.request_id||setup.patient_id!==s.patientId)throw new Error('The pending setup does not match this patient.');
    patientBillingSetups.set(s.patientId,setup);
   }catch(error){if(!patientBillingCurrent(s)||s.panelRequest!==request||s.profileRequest!==profileRequest)return;const current=patientBillingSetupFor(s);if(current?.request_id===active.request_id)patientBillingSetups.set(s.patientId,{...current,error:error.message||'The pending setup is unavailable.'});}
  }
  target.innerHTML=patientBillingProfileMarkup(data,tab,s);
 }catch(error){if(patientBillingCurrent(s)&&s.panelRequest===request&&s.profileRequest===profileRequest&&patientBillingProfileTarget(s)===target)target.innerHTML=`<h3>${tab==='methods'?'Payment methods':tab==='subscriptions'?'Memberships & recurring services':'Stripe customer invoices'}</h3><p role="status">${esc(error.message||'Stripe customer records are unavailable.')}</p><p class="muted">Availability is unknown. This is not an empty list and does not change the patient ledger.</p><button type="button" data-hub-profile-refresh>Retry Stripe records</button>${tab==='methods'?patientBillingSetupMarkup(s):''}`;}
}
function patientBillingProfileMarkup(data,tab,s){
 const label=tab==='methods'?'Saved payment methods':tab==='subscriptions'?'Memberships & recurring services':'Stripe customer invoices',key=patientBillingProfileKey(tab),section=data[key];
 const mode=data.livemode===false?'<p class="mapping-notice"><b>Stripe TEST account — no real card funds.</b></p>':'<p class="muted">Connected live Stripe account</p>';
 let html=`<h3>${label}</h3>${mode}<p class="muted">For this patient’s linked Stripe customer. Native invoices and receipts remain separate.${data.checked_at?' Checked '+esc(date(data.checked_at))+'.':''}</p>`;
 if(data.customer?.status==='creating')html+='<p role="status">The customer link is being prepared. Refresh to check its verified state.</p>';
 if(section?.status==='not_created')html+='<p>No Stripe customer has been created for this patient in the configured account. A previous copay does not establish a reusable saved card.</p>';
 else if(section?.status!=='available'||!Array.isArray(section.data?.items))html+='<p role="status">These Stripe customer records are unavailable. The number of records is unknown.</p><button type="button" data-hub-profile-refresh>Retry Stripe records</button>';
 else{
  const items=tab==='subscriptions'&&s?.memberships?section.data.items.filter(item=>!s.memberships.some(m=>m.subscription_id===item.id)):section.data.items;
  const rows=items.map(item=>{
   if(tab==='methods')return `<article class="patient-billing-card"><h4>${esc(human(item.brand||'Card'))} ending ${esc(item.last4||'—')}</h4><p>Expires ${esc(item.exp_month)}/${esc(item.exp_year)}</p></article>`;
   if(tab==='subscriptions')return `<article class="patient-billing-card"><h4>${esc(human(item.status||'Status unavailable'))}</h4>${(item.items||[]).map(line=>`<p>${patientBillingAmount(line.unit_amount,item.currency)} per unit${line.interval?' every '+esc(line.interval_count||1)+' '+esc(line.interval):''} · quantity ${esc(line.quantity??'Not recorded')}</p><small>Current period: ${esc(patientBillingProviderDate(line.current_period_start))} – ${esc(patientBillingProviderDate(line.current_period_end))}</small>`).join('')}${item.cancel_at_period_end?'<p>Cancellation scheduled at period end.</p>':''}</article>`;
   return `<article class="patient-billing-card"><h4>${esc(human(item.status||'Status unavailable'))}</h4><p>Remaining ${patientBillingAmount(item.amount_remaining,item.currency)} · Paid ${patientBillingAmount(item.amount_paid,item.currency)}</p><p>Total ${patientBillingAmount(item.total,item.currency)}</p><small>Created ${esc(patientBillingProviderDate(item.created))}${item.due_date?' · Due '+esc(patientBillingProviderDate(item.due_date)):''}</small></article>`;
  }).join('');
  html+=rows?`<div class="patient-billing-cards">${rows}</div>`:`<p>No ${tab==='methods'?'saved payment methods':tab==='subscriptions'?'subscriptions':'Stripe invoices'} were returned for this patient’s linked customer.</p>`;
  if(s?.profileCursors[key])html+='<button type="button" data-hub-profile-first>First Stripe page</button>';
  if(section.data.has_more)html+=section.data.next_cursor?`<button type="button" data-hub-profile-next="${esc(section.data.next_cursor)}">Next Stripe page</button>`:'<p class="muted">Additional records exist, but a safe next page is unavailable.</p>';
 }
 if(tab==='methods'){
  html+=patientBillingSetupMarkup(s);
  if(!patientBillingSetupFor(s)&&data.setup_available&&typeof billingCan==='function'&&billingCan('create'))html+='<button type="button" class="primary" data-hub-add-method>Add payment method</button>';
  else if(!data.setup_available)html+='<p class="muted">Hosted card setup is not available for the configured account. Existing saved methods remain listed above.</p>';
 }else if(tab==='subscriptions'&&typeof loadPatientPaymentPlans!=='function')html+='<section class="billing-section"><h3>Encounter payment plans</h3><p>Encounter balances and saved invoices are available in Overview and Invoices. Creating a fixed-balance installment plan is not available in this workspace yet.</p></section>';
 return html;
}
let patientBillingSetupOwner=null;
const patientBillingSetups=new Map();
function patientBillingSetupFor(s){
 if(patientBillingSetupOwner!==me){patientBillingSetups.clear();patientBillingSetupOwner=me;}
 return s?.patientId?patientBillingSetups.get(s.patientId):null;
}
function patientBillingCheckoutUrl(value){
 try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='checkout.stripe.com'&&!u.port&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
function patientBillingSetupMarkup(s){
 const op=patientBillingSetupFor(s);if(!op)return '';
 const labels={creating:'Preparing secure card setup',open:'Ready to open secure card setup',pending:'Card setup is awaiting verification',succeeded:'Payment method setup verified',expired:'Card setup expired',needs_review:'Card setup needs review',unknown:'Card setup result is not yet known'};
 const url=['open','pending'].includes(op.status)?patientBillingCheckoutUrl(op.session?.url):null;
 return `<section class="mapping-notice" aria-live="polite"><h4>${esc(labels[op.status]||labels.unknown)}</h4><p>Saving a card does not charge it or start a subscription. Only the verified Stripe result determines whether setup completed.</p>${op.error?`<p role="status">${esc(op.error)}</p>`:''}${url?`<a class="button primary" href="${esc(url)}" rel="noreferrer" referrerpolicy="no-referrer">Continue secure card setup</a>`:''}<button type="button" data-hub-setup-refresh>Check setup status</button>${op.retry_allowed&&Number.isFinite(Date.parse(op.retry_safe_until))&&Date.parse(op.retry_safe_until)>Date.now()&&typeof billingCan==='function'&&billingCan('create')?'<button type="button" data-hub-setup-retry>Retry this setup request</button>':''}${['succeeded','expired'].includes(op.status)?'<button type="button" data-hub-setup-dismiss>Close setup result</button>':''}</section>`;
}
function patientBillingShowSetupConsent(s){
 if(!patientBillingCurrent(s)||s.tab!=='methods'||!s.profile?.setup_available||!billingCan('create')||patientBillingSetupFor(s))return;
 const target=patientBillingProfileTarget(s);target.insertAdjacentHTML('beforeend','<form id="patient-billing-setup-form"><h4>Save a payment method</h4><p>The patient enters card details on Stripe’s secure page. This step does not collect a payment or authorize a recurring plan.</p><label class="check"><input type="checkbox" name="consent" required> The patient has agreed to save this payment method for future use with the patient present. Recurring payments require separate consent.</label><div class="actions"><button type="submit" class="primary">Continue to secure setup</button><button type="button" data-hub-setup-cancel>Cancel</button></div></form>');
 target.querySelector('[data-hub-add-method]')?.remove();target.querySelector('input[name="consent"]')?.focus();
}
async function patientBillingCreateSetup(s,existing){
 if(!patientBillingCurrent(s)||s.tab!=='methods'||!billingCan('create')||!s.profile?.setup_available)return;
 const prior=patientBillingSetupFor(s);if(existing?(prior!==existing||!existing.retry_allowed||!(Date.parse(existing.retry_safe_until)>Date.now())):Boolean(prior))return;
 const requestId=existing?.request_id||crypto.randomUUID(),op={...existing,request_id:requestId,patient_id:s.patientId,status:'creating',retry_safe_until:existing?.retry_safe_until||new Date(Date.now()+23*60*60*1000).toISOString()};
 patientBillingSetups.set(s.patientId,op);const target=patientBillingProfileTarget(s);target.innerHTML=patientBillingProfileMarkup(s.profile,'methods',s);
 try{
  const result=await api(`/api/v1/billing/patients/${encodeURIComponent(s.patientId)}/payment-setups`,'POST',{request_id:requestId,consent:true});
  if(me!==s.identity)return;
  if(result.request_id!==requestId||result.patient_id!==s.patientId)throw new Error('The setup response did not match this patient and request.');
  patientBillingSetups.set(s.patientId,result);
 }catch(error){if(me===s.identity)patientBillingSetups.set(s.patientId,{...op,status:'unknown',retry_allowed:false,error:error.message||'The setup response was not received. Check this request before starting another.'});}
 if(patientBillingCurrent(s)&&s.tab==='methods'&&patientBillingProfileTarget(s)===target)target.innerHTML=patientBillingProfileMarkup(s.profile,'methods',s);
}
async function patientBillingRefreshSetup(s){
 const op=patientBillingSetupFor(s);if(!op||!patientBillingCurrent(s))return;
 try{
  const result=await api('/api/v1/billing/payment-setups/'+encodeURIComponent(op.request_id));
  if(me!==s.identity)return;
  if(result.request_id!==op.request_id||result.patient_id!==s.patientId)throw new Error('The setup status did not match this patient and request.');
  if(patientBillingSetups.get(s.patientId)===op)patientBillingSetups.set(s.patientId,result);
 }catch(error){if(me===s.identity&&patientBillingSetups.get(s.patientId)===op)patientBillingSetups.set(s.patientId,{...op,error:error.message||'Setup status is unavailable.'});}
 if(patientBillingCurrent(s)&&s.tab==='methods')await loadPatientBillingProfile(s,s.panelRequest);
}
async function openPatientPaymentSetupReturn(id){
 if(typeof me==='undefined'||!me)return;
 showTool('Billing & insurance');$('tools').innerHTML='<section id="billing-tool"><div id="patient-payment-setup-return"><p role="status">Checking secure card setup…</p></div></section>';
 const identity=me,host=$('patient-payment-setup-return');
 const current=()=>me===identity&&$('patient-payment-setup-return')===host&&!$('tools').hidden;
 try{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))throw new Error('This card setup return link is invalid.');
  const result=await api('/api/v1/billing/payment-setups/'+encodeURIComponent(id));
  if(!current())return;
  if(result.request_id!==id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.patient_id||''))throw new Error('This setup result could not be verified.');
  patientBillingSetupFor({patientId:result.patient_id});patientBillingSetups.set(result.patient_id,result);
  if(typeof clearPatientPaymentSetupSignInReturn==='function')clearPatientPaymentSetupSignInReturn();
  await showPatientBillingWorkspace({patientId:result.patient_id,tab:'methods'});
 }catch(error){if(current())host.innerHTML=`<h2>Card setup result unavailable</h2><p role="alert">${esc(error.message||'This result could not be loaded with your current access.')}</p><p>No new setup or payment was created by returning here.</p><button type="button" data-setup-return-retry="${esc(id||'')}">Check again</button>`;}
}
async function searchPatientBillingPatients(s,query,after){
 const host=s.host.querySelector('#billing-patient-results');if(!host||!patientBillingCurrent(s))return;
 const request=++s.searchRequest;host.innerHTML='<p role="status">Searching patients…</p>';
 try{
  const q=new URLSearchParams({q:query,limit:'20'});if(after)q.set('after',after);
  const data=await api('/api/v1/billing/patients?'+q);
  if(!patientBillingCurrent(s)||s.searchRequest!==request||s.host.querySelector('#billing-patient-results')!==host)return;
  s.searchQuery=query;s.searchResults=data.items;
  host.innerHTML=`<div class="patient-billing-search-results">${data.items.map(p=>`<button type="button" data-hub-patient="${esc(p.id)}"><b>${esc(patientBillingName(p))}</b><small>MRN ${esc(p.mrn)}${p.archived?' · Archived':''}</small></button>`).join('')||'<p>No matching patients.</p>'}</div>${data.next_cursor?`<button type="button" data-hub-patient-next="${esc(data.next_cursor)}">More matching patients</button>`:''}`;
 }catch(error){if(patientBillingCurrent(s)&&s.searchRequest===request)host.innerHTML=`<p role="alert">${esc(error.message||'Patient search is unavailable.')}</p>`;}
}
async function changePatientBillingTab(tab){
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||!patientBillingTabs.some(([key])=>key===tab))return;
 if(typeof capturePatientPaymentPlanDrafts==='function')capturePatientPaymentPlanDrafts();
 s.tab=tab;s.paymentsAfter=null;const scope=s.host.querySelector('.patient-billing-scope');if(scope)scope.hidden=['methods','subscriptions'].includes(tab);s.invoicesAfter=null;s.accountsAfter=null;s.copaysAfter=null;s.native=null;s.profileCursors={};s.profileRequest++;
 for(const button of s.host.querySelectorAll('[role="tab"]')){const active=button.dataset.hubTab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}
 const panel=s.host.querySelector('#patient-billing-panel');panel.setAttribute('aria-labelledby','patient-billing-tab-'+tab);
 const preview=s.host.querySelector('#patient-billing-preview');preview.hidden=true;preview.replaceChildren();
 await loadPatientBillingTab(s);
}
async function showPatientBillingDocument(kind,id){
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s))return;
 const host=s.host.querySelector('#patient-billing-preview'),request=Symbol();host.billingRequest=request;host.hidden=false;host.innerHTML='<p role="status">Loading saved document…</p>';
 try{
  const data=await api(`/api/v1/billing/${kind==='invoice'?'invoices':'copay-receipts'}/${encodeURIComponent(id)}`);
  if(!patientBillingCurrent(s)||host.billingRequest!==request||s.host.querySelector('#patient-billing-preview')!==host)return;
  const returnedPatient=kind==='invoice'?data.patient_id:data.receipt?.patient_id;
  if(s.patientId&&returnedPatient!==s.patientId)throw new Error('This document does not belong to the selected patient.');
  host.innerHTML=`<div class="section-head"><h3>${kind==='invoice'?'Saved patient invoice':'Copay receipt'}</h3><div class="actions"><button type="button" data-hub-print>Print / save PDF</button><button type="button" data-hub-preview-close>Close preview</button></div></div><p class="muted">Saved record · viewing does not collect payment.</p>`;
  const frame=document.createElement('iframe');frame.id='patient-billing-print-frame';frame.title=kind==='invoice'?'Patient invoice print preview':'Copay receipt print preview';frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');frame.srcdoc=kind==='invoice'?patientInvoiceDocument(data):copayReceiptDocument(data.receipt,data.context);host.append(frame);host.scrollIntoView({block:'start'});
 }catch(error){if(patientBillingCurrent(s)&&host.billingRequest===request)host.innerHTML=`<p role="alert">${esc(error.message||'Saved document is unavailable.')}</p>`;}
}
document.addEventListener('submit',event=>{
 if(event.target.id==='patient-billing-setup-form'){event.preventDefault();const s=patientBillingWorkspace;if(patientBillingCurrent(s)&&event.target.closest('.patient-billing-hub')===s.host&&event.target.elements.consent.checked)run(()=>patientBillingCreateSetup(s));return;}
 if(event.target.id!=='billing-patient-search-form')return;
 event.preventDefault();const s=patientBillingWorkspace;if(!patientBillingCurrent(s))return;
 void searchPatientBillingPatients(s,String(new FormData(event.target).get('q')||'').trim());
});
document.addEventListener('change',event=>{
 if(event.target.id!=='patient-billing-mode')return;
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s))return;
 s.mode=event.target.value==='test'?'test':'recorded';s.native=null;s.accountsAfter=null;s.copaysAfter=null;s.invoicesAfter=null;s.paymentsAfter=null;run(()=>loadPatientBillingTab(s));
});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(button?.dataset.setupReturnRetry){run(()=>openPatientPaymentSetupReturn(button.dataset.setupReturnRetry));return;}
 if(!button?.closest('.patient-billing-hub'))return;
 const s=patientBillingWorkspace;if(!patientBillingCurrent(s)||button.closest('.patient-billing-hub')!==s.host)return;
 const d=button.dataset;
 if(d.hubTab){event.preventDefault();run(()=>changePatientBillingTab(d.hubTab));}
 else if(d.hubPatient){const patient=s.searchResults?.find(p=>p.id===d.hubPatient);if(patient)run(async()=>{await showPatientBillingWorkspace({patientId:patient.id,patient,tab:'overview',mode:s.mode});});}
 else if(button.hasAttribute('data-hub-all'))run(()=>showPatientBillingWorkspace({patientId:null,tab:'overview',mode:s.mode}));
 else if(d.hubPatientNext)void searchPatientBillingPatients(s,s.searchQuery||'',d.hubPatientNext);
 else if(button.hasAttribute('data-hub-refresh')){s.native=null;run(()=>loadPatientBillingTab(s));}
 else if(button.hasAttribute('data-hub-profile-refresh'))run(()=>loadPatientBillingProfile(s,s.panelRequest));
 else if(button.hasAttribute('data-hub-add-method'))patientBillingShowSetupConsent(s);
 else if(button.hasAttribute('data-hub-setup-cancel')){patientBillingProfileTarget(s).innerHTML=patientBillingProfileMarkup(s.profile,'methods',s);}
 else if(button.hasAttribute('data-hub-setup-refresh'))run(()=>patientBillingRefreshSetup(s));
 else if(button.hasAttribute('data-hub-setup-retry'))run(()=>patientBillingCreateSetup(s,patientBillingSetupFor(s)));
 else if(button.hasAttribute('data-hub-setup-dismiss')){const op=patientBillingSetupFor(s);if(['succeeded','expired'].includes(op?.status)){patientBillingSetups.delete(s.patientId);run(()=>loadPatientBillingProfile(s,s.panelRequest));}}
 else if(d.hubProfileNext||button.hasAttribute('data-hub-profile-first')){s.profileCursors[patientBillingProfileKey(s.tab)]=d.hubProfileNext||null;run(()=>loadPatientBillingProfile(s,s.panelRequest));}
 else if(button.hasAttribute('data-hub-tools'))run(()=>showBillingQueue('',undefined,true));
 else if(d.overviewInvoice)run(()=>showPatientBillingDocument('invoice',d.overviewInvoice));
 else if(d.overviewReceipt)run(()=>showPatientBillingDocument('receipt',d.overviewReceipt));
 else if(button.hasAttribute('data-hub-print')){const frame=s.host.querySelector('#patient-billing-print-frame');frame?.contentWindow?.focus();frame?.contentWindow?.print();}
 else if(button.hasAttribute('data-hub-preview-close')){const host=s.host.querySelector('#patient-billing-preview');host.billingRequest=null;host.hidden=true;host.replaceChildren();}
 else for(const [field,attribute] of [['accountsAfter','hubAccounts'],['copaysAfter','hubCopays'],['invoicesAfter','hubInvoices'],['paymentsAfter','hubPayments']])if(d[attribute]||button.hasAttribute('data-hub-'+attribute.slice(3).toLowerCase()+'-first')){s[field]=d[attribute]||null;s.native=null;run(()=>loadPatientBillingTab(s));break;}
});
document.addEventListener('keydown',event=>{
 const current=event.target.closest?.('[role="tab"][data-hub-tab]');if(!current||!current.closest('.patient-billing-hub'))return;
 const tabs=[...current.parentElement.querySelectorAll('[role="tab"]')],index=tabs.indexOf(current);
 const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
 if(next===null)return;event.preventDefault();tabs[next].focus();run(()=>changePatientBillingTab(tabs[next].dataset.hubTab));
});
