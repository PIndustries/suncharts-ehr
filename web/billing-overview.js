// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let billingOverviewGeneration=0,billingOverviewMode='recorded';
let billingOverviewPaging={identity:null,accountsAfter:null,copaysAfter:null};
const billingOverviewAllowed=resource=>typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);
function billingOverviewCurrent(context){return context.identity===me&&context.generation===billingOverviewGeneration&&$('billing-overview')===context.host&&!$('tools').hidden&&billingOverviewAllowed('billing');}
function billingOverviewPatient(row){return `<b>${esc(row.patient_name)}</b><small>MRN ${esc(row.mrn)}</small>`;}
function billingOverviewAccountRows(rows){
 return rows.map(row=>`<tr><td>${billingOverviewPatient(row)}<small>${esc(displayDate(row.service_date))}</small></td><td>${esc(row.billing_state&&typeof visitBillingStateName==='function'?visitBillingStateName(row.billing_state):displayStatus(row.status))}<small>${esc(row.payer_name||'No insurer attached')}</small></td><td class="money-cell">${money(row.total_cents)}<small>${row.account_balance_cents==null?'Not posted yet':'Balance '+money(row.account_balance_cents)}</small></td><td>${row.patient_owes_now_cents==null?'':`<b>${money(row.patient_owes_now_cents)}</b>`}${row.insurance_pending_cents>0?`<small>Insurance pending: ${money(row.insurance_pending_cents)}</small>`:''}${row.invoice_id?`<small>Statement of ${esc(date(row.invoice_created_at))}: ${money(row.invoice_due_cents)} due then${row.invoice_needs_review&&row.patient_owes_now_cents!==0?'. Needs review: payments or charges changed since':''}</small>`:'<small>No statement sent</small>'}</td><td>${row.invoice_id?`<button type="button" data-overview-invoice="${esc(row.invoice_id)}">View statement</button>`:''}${billingOverviewAllowed('clinical')?`<button type="button" data-billing-patient="${esc(row.patient_id)}" data-account="${esc(row.id)}">Open visit billing</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5">No visits with charges yet.</td></tr>';
}
function billingOverviewCopayRows(rows){
 return rows.map(row=>`<tr><td>${billingOverviewPatient(row)}<small>${esc(row.occurred_on)}</small></td><td>${row.hosted_operation_id?'Card · verified capture':esc(invoicePaymentMethod(row.method))}<small>${row.voided?'Voided; retained in history':row.needs_review?'Needs review':row.refunded_cents===row.amount_cents?'Refunded':row.refunded_cents?'Partially refunded':row.usable_unapplied_cents?'Credit awaiting allocation':'Allocated to charges'}</small></td><td class="money-cell">${money(row.net_received_cents)}<small>Recorded ${money(row.amount_cents)}${row.refunded_cents?' · refunded '+money(row.refunded_cents):''}</small></td><td class="money-cell">${money(row.usable_unapplied_cents)}${row.needs_review?'<small>Review required before any reuse.</small>':''}</td><td><button type="button" data-overview-receipt="${esc(row.id)}">View / print receipt</button></td></tr>`).join('')||'<tr><td colspan="5">No payments received yet.</td></tr>';
}
function billingOverviewMarkup(data,paging={}){
 const a=data.summary.accounts,c=data.summary.copays,testBuild=typeof testPaymentLabel==='function'&&!!testPaymentLabel();
 return `<div class="section-head"><div><h2>Patient billing</h2><p>Invoices, collected copays and unapplied credit across patients.</p></div><div class="actions"><button type="button" data-overview-refresh>Refresh</button><button type="button" data-overview-settings>Billing tools & payers</button>${me.role==='owner'?'<button type="button" data-payment-settings>Payment settings</button>':''}</div></div>${testBuild||data.mode==='test'?`<label>Activity<select id="billing-overview-mode"><option value="recorded" ${data.mode==='recorded'?'selected':''}>Clinic records</option><option value="test" ${data.mode==='test'?'selected':''}>Test payments</option></select></label>`:''}${data.mode==='test'&&testBuild?'<p class="copay-mode-label">Test payments</p>':''}<dl class="billing-dl"><dt>Open invoices</dt><dd>${esc(a.open_invoice_count)} · ${money(a.reviewed_patient_due_cents)}</dd><dt>Invoices requiring review</dt><dd>${esc(a.invoice_review_count)} · excluded from the open amount above</dd><dt>Collected copays</dt><dd>${money(c.net_received_cents)} · ${esc(c.receipts)} receipt records</dd><dt>Unapplied copay credit</dt><dd>${money(c.usable_unapplied_cents)}${c.review_count?' · '+esc(c.review_count)+' receipt records require review':''}</dd></dl><details class="amendment"><summary>How these totals are calculated</summary><p>Totals cover all records in this view, including archived patients. An account containing any TEST ledger activity is excluded in full from the recorded view and appears only in the TEST view. Voided receipts contribute no received amount. Allocating a copay does not collect it again. Invoice amounts exclude insurance responsibility; changes after issuance require review. Only the latest invoice per account contributes to totals; earlier invoices remain unchanged.</p></details><section class="billing-section"><h3>Patient invoices & charge accounts</h3><p class="muted">Gross charges and account balances include patient and insurer shares.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Patient / service</th><th>Account / payer</th><th>Gross charges</th><th>Latest patient invoice</th><th>Actions</th></tr></thead><tbody>${billingOverviewAccountRows(data.accounts.items)}</tbody></table></div>${paging.accountsAfter?'<button type="button" data-overview-accounts-first>First accounts page</button>':''}${data.accounts.next_cursor?`<button type="button" data-overview-accounts="${esc(data.accounts.next_cursor)}">Next accounts</button>`:''}</section><section class="billing-section"><h3>Copay receipts</h3><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Patient / received</th><th>Evidence / status</th><th>Net recorded</th><th>Usable credit</th><th>Actions</th></tr></thead><tbody>${billingOverviewCopayRows(data.copays.items)}</tbody></table></div>${paging.copaysAfter?'<button type="button" data-overview-copays-first>First receipts page</button>':''}${data.copays.next_cursor?`<button type="button" data-overview-copays="${esc(data.copays.next_cursor)}">Next receipts</button>`:''}</section><section id="billing-overview-claims" class="billing-section"><h3>Insurance claim status · all claims</h3><p>${billingOverviewAllowed('claims')?'Loading recorded claim status…':'Claim information is not available to this role. Billing records remain available above.'}</p></section><section id="billing-overview-preview" class="billing-section" aria-live="polite"></section>`;
}
async function renderBillingOverview(_status,_after,options={}){
 if(typeof showPatientBillingWorkspace==='function')return showPatientBillingWorkspace(options);
 const identity=me,generation=++billingOverviewGeneration;
 if(billingOverviewPaging.identity!==identity){billingOverviewMode='recorded';billingOverviewPaging={identity,accountsAfter:null,copaysAfter:null};}
 billingOverviewMode=options.mode||billingOverviewMode;
 const paging=options.preserveOther?{...billingOverviewPaging}:{identity,accountsAfter:null,copaysAfter:null};
 for(const key of ['accountsAfter','copaysAfter'])if(Object.hasOwn(options,key))paging[key]=options[key];
 billingOverviewPaging=paging;
 showTool('Billing & insurance');$('tools').innerHTML='<section id="billing-tool"><div id="billing-overview"><h2>Patient billing</h2><p role="status">Loading invoices and copays…</p></div></section>';
 const context={identity,generation,host:$('billing-overview')},query=new URLSearchParams({mode:billingOverviewMode});
 if(paging.accountsAfter)query.set('accounts_after',paging.accountsAfter);if(paging.copaysAfter)query.set('copays_after',paging.copaysAfter);
 try{
  const data=await api('/api/v1/billing/overview?'+query);
  if(!billingOverviewCurrent(context))return;
  context.host.innerHTML=billingOverviewMarkup(data,paging);
  if(billingOverviewAllowed('claims'))void loadBillingOverviewClaims(context);
 }catch(error){if(billingOverviewCurrent(context))context.host.innerHTML=`<h2>Patient billing</h2><p role="alert">${esc(error.message||'Billing overview unavailable.')}</p><button type="button" data-overview-refresh>Try again</button>`;}
}
async function loadBillingOverviewClaims(context,after){
 const host=$('billing-overview-claims');if(!host||!billingOverviewCurrent(context)||!billingOverviewAllowed('claims'))return;
 try{
  const data=await api('/api/v1/billing/claims'+(after?'?after='+encodeURIComponent(after):''));
  if(!billingOverviewCurrent(context)||$('billing-overview-claims')!==host||!billingOverviewAllowed('claims'))return;
  host.innerHTML=`<h3>Insurance claim status · all claims</h3><p class="muted">Claim status does not establish payment. Review payer responses before changing patient responsibility.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Patient</th><th>Payer</th><th>Recorded status</th></tr></thead><tbody>${data.items.map(row=>`<tr><td>${esc(row.patient_name)}</td><td>${esc(row.payer_name||'Not recorded')}<small>${esc(row.coverage_priority||'')}</small></td><td>${row.synthetic_test?'TEST · ':''}${row.crossover_tracking_only?'Received crossover · ':''}${esc(human(row.status))}</td></tr>`).join('')||'<tr><td colspan="3">No claims recorded.</td></tr>'}</tbody></table></div>${data.next_cursor?`<button type="button" data-overview-claims="${esc(data.next_cursor)}">Next claims</button>`:''}<button type="button" data-overview-claims-workspace>Review insurance claims</button>`;
 }catch(_error){if(billingOverviewCurrent(context)&&$('billing-overview-claims')===host)host.innerHTML='<h3>Insurance claim status · all claims</h3><p role="status">Claim information is unavailable. The invoices and receipts above remain available.</p>';}
}
async function showBillingOverviewDocument(kind,id){
 const context={identity:me,generation:billingOverviewGeneration,host:$('billing-overview')},host=$('billing-overview-preview');
 if(!host||!billingOverviewCurrent(context))return;
 host.innerHTML='<p role="status">Loading saved document…</p>';
 const request=Symbol();host.billingDocumentRequest=request;
 try{
  const data=await api(`/api/v1/billing/${kind==='invoice'?'invoices':'copay-receipts'}/${encodeURIComponent(id)}`);
  if(!billingOverviewCurrent(context)||$('billing-overview-preview')!==host||host.billingDocumentRequest!==request)return;
  host.innerHTML=`<div class="section-head"><h3>${kind==='invoice'?'Saved patient invoice':'Copay receipt'}</h3><button type="button" data-overview-print>Print / save PDF</button></div><p class="muted">Saved record · viewing does not collect payment.</p>`;
  const frame=document.createElement('iframe');frame.id='billing-overview-print-frame';frame.title=kind==='invoice'?'Patient invoice print preview':'Copay receipt print preview';frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');frame.srcdoc=kind==='invoice'?patientInvoiceDocument(data):copayReceiptDocument(data.receipt,data.context);host.append(frame);host.scrollIntoView({block:'start'});
 }catch(error){if(billingOverviewCurrent(context)&&$('billing-overview-preview')===host&&host.billingDocumentRequest===request)host.innerHTML=`<p role="alert">${esc(error.message||'Document unavailable.')}</p>`;}
}
document.addEventListener('change',event=>{if(event.target.id==='billing-overview-mode')run(()=>renderBillingOverview(null,null,{mode:event.target.value}));});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button?.closest('#billing-overview'))return;
 if(button.hasAttribute('data-overview-print')){const frame=$('billing-overview-print-frame');frame?.contentWindow?.focus();frame?.contentWindow?.print();return;}
 if(button.hasAttribute('data-overview-refresh'))run(()=>renderBillingOverview(null,null,{preserveOther:true}));
 else if(button.hasAttribute('data-overview-settings'))run(()=>showBillingQueue('',undefined,true));
 else if(button.hasAttribute('data-overview-accounts-first'))run(()=>renderBillingOverview(null,null,{accountsAfter:null,preserveOther:true}));
 else if(button.dataset.overviewAccounts)run(()=>renderBillingOverview(null,null,{accountsAfter:button.dataset.overviewAccounts,preserveOther:true}));
 else if(button.hasAttribute('data-overview-copays-first'))run(()=>renderBillingOverview(null,null,{copaysAfter:null,preserveOther:true}));
 else if(button.dataset.overviewCopays)run(()=>renderBillingOverview(null,null,{copaysAfter:button.dataset.overviewCopays,preserveOther:true}));
 else if(button.dataset.overviewInvoice)run(()=>showBillingOverviewDocument('invoice',button.dataset.overviewInvoice));
 else if(button.dataset.overviewReceipt)run(()=>showBillingOverviewDocument('receipt',button.dataset.overviewReceipt));
 else if(button.dataset.overviewClaims)run(()=>loadBillingOverviewClaims({identity:me,generation:billingOverviewGeneration,host:$('billing-overview')},button.dataset.overviewClaims));
 else if(button.hasAttribute('data-overview-claims-workspace')&&billingOverviewAllowed('claims'))run(()=>showClaimsWorkspace());
});
