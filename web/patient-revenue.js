// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const insuranceAppointmentSelection=new Map();
function remittancePatientResponsibility(row){
 const explicit=(row?.adjustments||[]).some(adjustment=>adjustment.group==='PR')||row?.patient_responsibility_cents>0;
 return explicit?`Payer-reported patient responsibility ${money(row.patient_responsibility_cents||0)}`:'Patient responsibility not specified in PR evidence; review the response';
}
function revenueAppointment(){
 const selectedAppointment=typeof chartSection!=='undefined'&&chartSection==='insurance'?insuranceAppointmentSelection.get(selected):null;
 if(selectedAppointment){const appointment=(workspace.appointments||[]).find(a=>a.id===selectedAppointment);if(appointment)return appointment;}
 if(typeof activeVisit!=='undefined'&&activeVisit)return workspace.appointments.find(a=>a.id===activeVisit.appointment_id);
 return (workspace.appointments||[]).find(a=>['checked_in','in_progress','booked'].includes(a.status));
}
function revenueServiceDate(appointment=revenueAppointment()){
 const value=appointment?.starts_at?new Date(appointment.starts_at):new Date();
 const fields=new Intl.DateTimeFormat('en-CA',{timeZone:appointment?.timezone||undefined,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
 const part=name=>fields.find(p=>p.type===name)?.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}
function revenueCoverage(serviceDate=revenueServiceDate()){
 const active=(workspace.billing?.coverages||[]).filter(c=>c.content.status==='active'&&c.content.effective_date<=serviceDate&&(!c.content.end_date||c.content.end_date>=serviceDate));
 return active.find(c=>c.content.priority==='primary')||null;
}
function encounterChargeAccount(){return typeof activeVisit!=='undefined'&&activeVisit?(workspace.billing?.accounts||[]).find(a=>a.status!=='void'&&a.content.visit_id===activeVisit.id):null;}
function copayUnapplied(receipt){return Math.max(0,receipt.amount_cents-Number(receipt.allocated_cents||0)-Number(receipt.hosted_checkout?.refunded_unapplied_cents||0));}
function availableCopayCreditForAccount(account){const visit=(workspace.visits||[]).find(v=>v.id===account.content.visit_id);return (workspace.billing?.copays||[]).filter(r=>r.appointment_id===visit?.appointment_id&&!r.voided&&!r.reversed_cents&&r.hosted_checkout?.status!=='needs_review').reduce((sum,r)=>sum+copayUnapplied(r),0);}
function appointmentCopays(appointment=revenueAppointment()){return (workspace.billing?.copays||[]).filter(r=>r.appointment_id===appointment?.id);}
function copayReceiptMarkup(receipts,options={}){
 return receipts.map(r=>{const hosted=r.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),reversed=Number(r.reversed_cents||0),allocated=Number(r.allocated_cents||0),unapplied=copayUnapplied(r),held=hosted?.status==='needs_review',status=r.voided?'Voided receipt':held?'Card payment requires reconciliation':refunded===r.amount_cents?'Card payment refunded':refunded?'Card payment partially refunded':reversed?'Corrected on ledger':unapplied?(hosted?'Card payment captured · not yet applied to charges':'Recorded · not yet applied to charges'):(hosted?'Card payment captured · applied to encounter charges':'Applied to encounter charges');return `<div class="timeline-row"><div><b>${hosted?.livemode===false&&!options.modeShown?testPaymentTag(' · '):hosted?.livemode===true&&options.modeShown?'LIVE · ':''}${money(r.amount_cents)} · ${esc(status)}</b><small>${hosted?'Card · Confirmed by Stripe':esc(human(r.method))} · ${esc(r.occurred_on)}${r.reference?' · '+esc(r.reference):''}</small>${refunded?`<small>Verified refunds ${money(refunded)} · Net received ${money(r.amount_cents-refunded)}</small>`:''}${!r.voided&&!reversed&&!held&&unapplied?`<small>${money(unapplied)} credit not yet applied</small>`:''}${reversed?`<small>${money(reversed)} reversed. Review the account ledger before recording any replacement receipt.</small>`:''}</div><div class="actions"><button type="button" ${options.primary?'class="primary"':''} data-copay-receipt="${esc(r.id)}" data-appointment="${esc(r.appointment_id)}">View / print receipt</button>${(options.encounter?[]:r.account_ids||[]).map(id=>`<button type="button" data-copay-account="${esc(id)}">Review ledger</button>`).join('')}${billingCan()&&!hosted&&!r.voided&&!allocated?`<button type="button" data-copay-void="${esc(r.id)}">Correct receipt</button>`:''}</div></div>`;}).join('')||'<p class="muted">No copay receipt recorded for this appointment.</p>';
}
function copayReceiptDocument(receipt,context){
 const patient=context.patient,appointment=context.appointment,corrected=Number(receipt.reversed_cents||0)>0,hosted=receipt.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),test=hosted?.livemode===false;
 const status=receipt.voided?'Voided receipt':corrected?'Receipt with corrected allocation':refunded?'Card copay receipt with verified refund':hosted?'Card copay receipt':'Copay receipt';
 const allocation=receipt.voided?'<p>This receipt record was voided and is retained for history. Voiding the record does not issue a refund.</p>':corrected?'<p>A charge allocation was reversed after this payment was recorded. Contact the practice to confirm its current disposition. A ledger reversal does not establish that a refund was issued.</p>':`<dt>${refunded?'Original charge allocations':'Applied to encounter charges'}</dt><dd>${money(Number(receipt.allocated_cents||0))}</dd><dt>Remaining credit not yet applied</dt><dd>${money(copayUnapplied(receipt))}</dd>`;
 const branding=patientPrintBranding(context.practiceName),title=(test?testPaymentTag(' - '):'')+status;
 return `${patientPrintHead(title,branding)}<body class="patient-receipt">${patientPrintHeader(title,branding)}<section class="document-meta"><div><span class="document-label">Received from</span><p class="patient-print-name">${esc(patient.given_name)} ${esc(patient.family_name)}</p>${patient.mrn?`<small>MRN ${esc(patient.mrn)}</small>`:''}</div><div class="document-reference"><span class="document-label">Receipt details</span><small>Receipt ${esc(receipt.id)}<br>${hosted?'Payment received (UTC date)':'Payment received'} ${esc(receipt.occurred_on)}${receipt.created_at?'<br>Recorded '+esc(date(receipt.created_at)):''}</small></div></section><section class="document-total"><span>${receipt.voided?'Original recorded amount':'Amount received'}</span><strong>${money(receipt.amount_cents)}</strong></section><p class="document-appointment">${appointment?`Appointment: ${esc(appointment.title||'Scheduled appointment')}<br>${esc(date(appointment.starts_at))}`:`Appointment reference: <span class="reference">${esc(receipt.appointment_id)}</span>`}</p><h2>Payment details</h2><dl><dt>Payment method</dt><dd>${hosted?'Card · Confirmed by Stripe':esc(invoicePaymentMethod(receipt.method))}</dd>${refunded?`<dt>Verified refunded amount</dt><dd>${money(refunded)}</dd><dt>Net card payment</dt><dd>${money(receipt.amount_cents-refunded)}</dd>`:''}${receipt.reference?`<dt>Receipt / check reference</dt><dd class="reference">${esc(receipt.reference)}</dd>`:''}${!receipt.voided&&!corrected?allocation:''}</dl>${receipt.voided||corrected?allocation:''}<footer>${test&&testPaymentTag()?`<p class="copay-mode-label">${testPaymentTag()}</p>`:''}${hosted?.status==='needs_review'?'<p class="document-warning">This payment requires reconciliation. Confirm its current status with the practice.</p>':''}<p>This is a copy of the practice’s recorded payment receipt. It is not an invoice and does not determine final insurance or patient responsibility.</p><small>Copy prepared ${esc(date(context.printedAt))}. Patient, appointment and practice branding reflect the chart when this copy was prepared.</small>${patientPrintFooter()}</footer></body></html>`;
}
function copayReceiptCardMarkup(receipt,context){
 const branding=patientPrintBranding(context.practiceName),hosted=receipt.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),reversed=Number(receipt.reversed_cents||0),held=hosted?.status==='needs_review';
 const status=receipt.voided?'Voided':held?'Needs reconciliation':refunded===receipt.amount_cents?'Refunded':refunded?'Partially refunded':reversed?'Allocation corrected':hosted?'Payment captured':'Payment recorded';
 const appointment=context.appointment,patient=context.patient;
 return `<article class="copay-receipt-card" data-copay-receipt-view><header>${branding.logo?`<img src="${esc(branding.logo)}" alt="Current practice logo" referrerpolicy="no-referrer">`:''}<div><p>${esc(branding.name||'Practice payment record')}</p><h3 tabindex="-1">Payment receipt</h3></div><button type="button" data-print-copay-card>Print / save PDF</button></header><div class="copay-receipt-amount"><div><span>${receipt.voided||refunded?'Original recorded amount':'Amount received'}</span><strong>${money(receipt.amount_cents)}</strong></div><span class="copay-receipt-status">${esc(status)}</span></div>${hosted?.livemode===false&&testPaymentTag()?`<p class="copay-mode-label">${testPaymentTag()}</p>`:''}<dl><div><dt>Patient</dt><dd>${esc(patient.given_name)} ${esc(patient.family_name)}</dd></div><div><dt>${hosted?'Payment date (UTC)':'Payment date'}</dt><dd>${esc(receipt.occurred_on)}</dd></div><div><dt>Appointment</dt><dd>${appointment?`${esc(appointment.title||'Scheduled appointment')}<small>${esc(date(appointment.starts_at))}</small>`:`Reference ${esc(receipt.appointment_id)}`}</dd></div><div><dt>Payment method</dt><dd>${hosted?'Card · Confirmed by Stripe':esc(invoicePaymentMethod(receipt.method))}</dd></div>${refunded?`<div><dt>Verified refund</dt><dd>${money(refunded)}</dd></div><div><dt>Net received</dt><dd>${money(receipt.amount_cents-refunded)}</dd></div>`:''}${!receipt.voided&&!held&&!reversed?`<div><dt>${refunded?'Original charge allocations':'Applied to charges'}</dt><dd>${money(Number(receipt.allocated_cents||0))}</dd></div><div><dt>Unapplied credit</dt><dd>${money(copayUnapplied(receipt))}</dd></div>`:''}</dl>${receipt.voided?'<p role="status">This receipt was voided and is retained in history. Voiding a receipt does not issue a refund.</p>':held?'<p role="status">This payment requires reconciliation. Review its status before collecting or applying another payment.</p>':reversed?'<p role="status">An allocation was reversed. Review the ledger; this does not establish that a refund was issued.</p>':''}<details><summary>Receipt reference</summary><p>${esc(receipt.id)}${receipt.reference?'<br>'+esc(receipt.reference):''}</p></details><footer><p>Recorded payment evidence, not an invoice or a determination of insurance responsibility.</p>${patientPrintFooter()}</footer></article>`;
}
function renderCopayReceiptCard(host,receipt,context,current){
 host.hidden=false;host.innerHTML=copayReceiptCardMarkup(receipt,context);
 const card=host.querySelector('[data-copay-receipt-view]');
 card.copayPrint={receipt,context,identity:me,current};
 host.scrollIntoView({block:'start'});card.querySelector('h3')?.focus({preventScroll:true});
}
function printCopayReceiptCard(card,button){
 const state=card?.copayPrint;if(!state||state.identity!==me||card.isConnected===false||!state.current())return;
 card.querySelector('.copay-print-source')?.remove();button.disabled=true;
 const frame=document.createElement('iframe');frame.className='copay-print-source';frame.title='Payment receipt print document';frame.setAttribute('aria-hidden','true');frame.setAttribute('sandbox','allow-same-origin allow-modals');
 frame.addEventListener('load',()=>{button.disabled=false;if(state.identity!==me||card.isConnected===false||!state.current())return;frame.contentWindow.focus();frame.contentWindow.print();},{once:true});
 frame.srcdoc=copayReceiptDocument(state.receipt,{...state.context,printedAt:new Date().toISOString()});card.append(frame);
}
let copayReceiptOpening=0;
async function showCopayReceipt(id,appointmentId){
 const view=hostedCopayView(),opening=++copayReceiptOpening;
 const known=(workspace.billing?.copays||[]).find(r=>r.id===id),expected=appointmentId||known?.appointment_id;
 if(!selected||!workspace.patient||!expected||(known?.patient_id&&known.patient_id!==selected))throw new Error('This receipt is unavailable for the current patient. Refresh the payment list.');
 // Coverage editors have no retained-draft contract. Keep them intact instead of navigating away.
 if(chartSection==='insurance'&&$('insurance-editor')?.querySelector('form')){notice('Save or cancel the open insurance form before opening the receipt.',true);return;}
 const current=()=>opening===copayReceiptOpening&&currentHostedCopayView(view);
 const data=await api(`/api/v1/billing/copay-receipts/${encodeURIComponent(id)}`);
 if(!current())return;
 const receipt=data.receipt,context=data.context;
 if(receipt?.id!==id||receipt.patient_id!==view.patient||receipt.appointment_id!==expected||!context?.patient||context.appointment&&context.appointment.id!==expected)throw new Error('This receipt does not match the selected patient and appointment.');
 const visit=(workspace.visits||[]).find(v=>v.appointment_id===expected),clinical=typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical');
 if(visit&&clinical&&(typeof chartAreaEnabled!=='function'||chartAreaEnabled('visits'))){
  if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
  if(activeVisit?.id!==visit.id)await selectPatient(view.patient,visit.id,current);
  if(opening!==copayReceiptOpening||me!==view.identity||selected!==view.patient||activeVisit?.id!==visit.id||activeVisit.appointment_id!==expected)return;
  setEncounterSection('charges');
  const host=$('encounter-copay-receipt');if(!host)return;
  const visible=()=>me===view.identity&&selected===view.patient&&chartSection==='visits'&&activeVisit?.id===visit.id&&activeVisit.appointment_id===expected&&$('encounter-copay-receipt')===host;
  renderCopayReceiptCard(host,receipt,context,visible);
 }else{
  const s=await showPatientBillingWorkspace({patientId:view.patient,tab:'payments',mode:receipt.hosted_checkout?.livemode===false?'test':'recorded'});
  if(opening!==copayReceiptOpening||me!==view.identity||!patientBillingCurrent(s)||s.patientId!==view.patient)return;
  await showPatientBillingDocument('receipt',id,{appointmentId:expected});
 }
}
// Keep responses scoped to the current patient and sign-in; never carry chart evidence across patients.
let insuranceEligibilityState={patient:null,identity:null,items:new Map()};
let encounterRevenueState={patient:null,identity:null,account:null,pending:null,data:null,loadedAt:0};
function eligibilityState(){
 if(insuranceEligibilityState.patient!==selected||insuranceEligibilityState.identity!==me)insuranceEligibilityState={patient:selected,identity:me,items:new Map()};
 return insuranceEligibilityState;
}
function insuranceEligibilityMarkup(state,coverageId,serviceDate){
 const coverage=(workspace?.billing?.coverages||[]).find(c=>c.id===coverageId);
 if(!state||state.loading)return '<p class="muted">Loading eligibility…</p>';
 if(state.error)return `<p>The eligibility history could not be loaded.</p><button type="button" data-refresh-eligibility="${esc(coverageId)}">Try again</button>`;
 if(!coverage||typeof claimmdEligibilityCard!=='function')return '';
 return claimmdEligibilityCard(coverage,state.history?.items||[],{serviceDate});
}
function refreshInsuranceEligibility(coverageId){
 const entry=eligibilityState().items.get(coverageId),node=$('insurance-eligibility-'+coverageId);
 if(node&&entry)node.innerHTML=insuranceEligibilityMarkup(entry,coverageId,revenueServiceDate());
}
// Opening the insurance step of an appointment checks each current coverage once,
// when there is no recent answer to show. Nothing runs for a chart that is only open.
function insuranceAutoEligibility(coverages,appointment,serviceDate){
 if(!appointment||typeof chartSection==='undefined'||chartSection!=='insurance'||typeof claimmdEligibilityAuto!=='function')return;
 const state=eligibilityState();
 for(const coverage of coverages)Promise.resolve(loadInsuranceEligibility(coverage.id)).then(()=>{
  const entry=state.items.get(coverage.id);
  if(insuranceEligibilityState!==state||selected!==state.patient||me!==state.identity||!entry?.history||chartSection!=='insurance'||revenueAppointment()?.id!==appointment.id)return;
  claimmdEligibilityAuto(coverage,entry.history.items,{appointmentId:appointment.id,serviceDate});
 }).catch(()=>{});
}
function updateInsuranceEligibility(coverageId,history){
 const state=eligibilityState();state.items.set(coverageId,{history,loading:false});
 const node=$('insurance-eligibility-'+coverageId);if(node)node.innerHTML=insuranceEligibilityMarkup(state.items.get(coverageId),coverageId,revenueServiceDate());
}
async function loadInsuranceEligibility(coverageId,force=false){
 const state=eligibilityState(),existing=state.items.get(coverageId),node=$('insurance-eligibility-'+coverageId);
 if(existing&&!force){if(node)node.innerHTML=insuranceEligibilityMarkup(existing,coverageId,revenueServiceDate());return existing.pending;}
 const entry={loading:true};state.items.set(coverageId,entry);if(node)node.innerHTML=insuranceEligibilityMarkup(entry,coverageId,revenueServiceDate());
 entry.pending=(async()=>{try{const history=await api(`/api/v1/patients/${state.patient}/coverages/${coverageId}/claimmd-eligibility`);if(insuranceEligibilityState!==state||selected!==state.patient||me!==state.identity||state.items.get(coverageId)!==entry)return;entry.history={...history,items:[...(history.items||[])].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))};}catch{entry.error=true;}finally{entry.loading=false;if(insuranceEligibilityState===state&&selected===state.patient&&me===state.identity&&state.items.get(coverageId)===entry){const current=$('insurance-eligibility-'+coverageId);if(current)current.innerHTML=insuranceEligibilityMarkup(entry,coverageId,revenueServiceDate());}}})();
 return entry.pending;
}
function encounterPaymentTotals(account,ledger=workspace.billing?.entries||[]){
 const entries=ledger.filter(e=>e.account_id===account.id),byId=new Map(entries.map(e=>[e.id,e]));
 const totals={patient:0,insurer:0,copay:0,balance:account.total_cents,testActivity:entries.some(e=>e.content?.test_mode)};
 for(const entry of entries){totals.balance+=Number(entry.effect_cents);let source=entry;const seen=new Set();while(source.reverses_id&&byId.has(source.reverses_id)&&!seen.has(source.id)){seen.add(source.id);source=byId.get(source.reverses_id);}if((source.kind==='payment'||source.kind==='adjustment_debit'&&(source.content?.managed_payment_id||source.content?.hosted_copay_operation_id))&&['patient','insurer'].includes(source.content?.party))totals[source.content.party]-=Number(entry.effect_cents);if(source.content?.copay_receipt_id)totals.copay-=Number(entry.effect_cents);}
 return totals;
}
function encounterRevenueSummary(account,data={}){
 const appointment=(workspace.appointments||[]).find(a=>a.id===activeVisit?.appointment_id),receipts=(data.financialCopays||workspace.billing?.copays||[]).filter(r=>r.appointment_id===appointment?.id&&!r.voided),financialAccount=data.financialAccount||account,totals=financialAccount?encounterPaymentTotals(financialAccount,data.financialEntries):null;
 const net=receipts.reduce((sum,r)=>sum+Math.max(0,r.amount_cents-Number(r.hosted_checkout?.refunded_cents||0)),0),held=receipts.some(r=>r.reversed_cents||r.hosted_checkout?.status==='needs_review'),test=receipts.some(r=>r.hosted_checkout?.livemode===false)||totals?.testActivity,unavailable=data.loading||data.financialError,posted=account?.status==='posted';
 return `<div class="revenue-metrics"><div><span>Charges</span><strong>${account?money(financialAccount.total_cents):'Not recorded'}</strong></div><div><span>Paid by patient</span><strong>${data.financialError?'Unavailable':money(net)}</strong></div><div><span>Applied to this visit</span><strong>${posted?(unavailable?'Unavailable':money(totals.copay)):'Not posted'}</strong></div><div><span>Balance</span><strong>${posted?(unavailable?'Unavailable':money(totals.balance)):'Not posted'}</strong></div></div>${data.financialError?'<p role="status">Current ledger totals could not be refreshed. Refresh before relying on the balance.</p>':data.loading?'<p class="muted">Refreshing current ledger totals…</p>':''}${held?'<p role="status">A copay requires review. Check its receipt and ledger before collecting or applying another payment.</p>':''}${posted?'<p class="muted">The balance includes what insurance and the patient owe.</p>':account?'':''}`;
}
function encounterRevenueStatusMarkup(account,data={}){
 if(!account)return encounterRevenueSummary(null,data)+`<div class="revenue-next-stage"><p>Add the services performed during this encounter.</p>${billingCan('create')?'<button type="button" class="primary" data-encounter-charges>Add CPT / HCPCS charges</button>':''}</div>`;
 const financialAccount=data.financialAccount||account,totals=encounterPaymentTotals(financialAccount,data.financialEntries),financialUnavailable=data.loading||data.financialError,claims=data.claims||[],claim=claims.find(c=>c.status!=='void')||claims[0],history=data.history,head=history?.active_head;
 const currentRemittance=head?(history.items||[]).find(row=>row.remittance_id===head.remittance_id&&row.row_index===head.row_index):null;
 const isPosted=account.status==='posted',claimState={draft:'Draft — review before submission',ready:'Ready for submission review',submitted:'Submission recorded — review delivery and response evidence',accepted:'Acceptance recorded — review adjudication evidence',rejected:'Rejected — correction needed',adjudicated:'Adjudicated — review remittance',void:'Voided claim'};
 let action='',next='';
 if(!isPosted){next=activeVisit?.status==='signed'?'Post the charges to apply the copay.':'Finish and sign this encounter before posting charges.';action=activeVisit?.status==='signed'?`<button type="button" class="primary" data-revenue-account="${esc(account.id)}">${billingCan()?'Review and post charges':'Review charges'}</button>`:'<button type="button" class="primary" data-revenue-documentation>Continue encounter documentation</button>';}
 else if(data.error){next='Claim status could not be loaded. Refresh before preparing another claim.';}
 else if(data.restricted){next='Claim review requires access to insurance claims.';}
 else if(!data.loaded){next='Loading this encounter’s claim and remittance evidence…';}
 else if(claim){next=(claim.crossover_tracking_only||claim.snapshot?.coordination_of_benefits?.crossover)&&claim.status==='submitted'?'Secondary crossover response received — review the linked remittance':claimState[claim.status]||human(claim.status);action=`<button type="button" class="primary" data-revenue-claim="${esc(claim.id)}">${claim.status==='draft'?'Review claim':claim.status==='ready'?'Review submission':claim.status==='rejected'?'Review and correct claim':'Review claim status'}</button>`;}
 else if(String(account.coverage_snapshot?.payer?.content?.payer_code||'').trim()){next='Charges are posted. Prepare the insurance claim for review.';action=billingCan('create')?`<button type="button" class="primary" data-new-claim="${esc(account.id)}">Prepare insurance claim</button>`:'';}
 else{next='Review patient responsibility before issuing an invoice.';action=billingCan('create')?`<button type="button" class="primary" data-revenue-invoice="${esc(account.id)}">Review patient invoice</button>`:'<button type="button" data-chart-section="insurance">Review insurance</button>';}
 const remit=currentRemittance?`<b>${currentRemittance.claim?.status==='22'?'Reversal posted':currentRemittance.claim?.status==='4'?'Denial response posted':'Remittance posted'}</b><small>${esc(human(claim?.coverage_priority||claim?.snapshot?.account?.coverage_snapshot?.coverage?.content?.priority||'Recorded coverage'))} · ${esc(claim?.payer_name||'Recorded payer')} · Trace ${esc(currentRemittance.trace)} · ${esc(remittancePatientResponsibility(currentRemittance.claim))}</small><button type="button" data-revenue-remittance="${esc(currentRemittance.remittance_id)}">Review posted remittance</button>`:head?`<b>Remittance posting recorded</b><button type="button" data-revenue-remittance="${esc(head.remittance_id)}">Review remittance details</button>`:data.historyLoading?'<p class="muted">Loading posted remittance history…</p>':data.historyError?'<p>Posted remittance history could not be loaded.</p>':claim&&data.loaded?'<p class="muted">No active remittance posting for the current claim. Submission and acceptance do not mean payment was received.</p>':'<p class="muted">Insurance payments and adjustments appear after remittance review and posting.</p>';
 return `<section class="encounter-revenue-status"><div class="section-head"><h3>Encounter billing</h3>${isPosted?'<button type="button" data-refresh-revenue>Refresh status</button>':''}</div>${encounterRevenueSummary(account,data)}<div class="revenue-next-stage"><div><span class="eyebrow">Next step</span><p>${esc(next)}</p></div><div class="actions">${action}</div></div>${isPosted?`<div class="actions">${billingCan('create')&&!action.includes('data-revenue-invoice')?`<button type="button" data-revenue-invoice="${esc(account.id)}">Review patient invoice</button>`:''}<button type="button" data-revenue-invoices="${esc(account.id)}">Saved invoices</button></div><details data-revenue-disclosure="claims"><summary>Claim &amp; payment history</summary>${claim?`<p>${esc(claim.control_number)} · ${esc(human(claim.frequency))} · ${esc(date(claim.created_at))}</p>`:''}${claims.length>1?`<ul>${claims.map(c=>`<li>${esc(human(c.coverage_priority||c.snapshot?.account?.coverage_snapshot?.coverage?.content?.priority||'Recorded coverage'))} · ${esc(c.payer_name||'Recorded payer')} · ${esc((c.crossover_tracking_only||c.snapshot?.coordination_of_benefits?.crossover)&&c.status==='submitted'?'Crossover response received':human(c.status))} · <button type="button" data-revenue-claim="${esc(c.id)}">Review ${esc(c.control_number)}</button></li>`).join('')}</ul>`:''}<dl class="billing-dl"><dt>Posted patient payments</dt><dd>${financialUnavailable?'Unavailable':money(totals.patient)}</dd><dt>Posted insurance payments</dt><dd>${financialUnavailable?'Unavailable':money(totals.insurer)}</dd></dl><div class="revenue-remittance">${remit}</div>${data.tracking&&typeof claimMdTrackingSummary==='function'?claimMdTrackingSummary(data.tracking):''}</details>`:''}</section>`;
}
async function loadEncounterRevenueStatus(account,force=false){
 if(!account)return;
 let state=encounterRevenueState;
 if(state.patient!==selected||state.identity!==me||state.account!==account.id||state.version!==account.version){state={patient:selected,identity:me,account:account.id,version:account.version,pending:null,data:null,loadedAt:0};encounterRevenueState=state;}
 const current=()=>encounterRevenueState===state&&selected===state.patient&&me===state.identity&&encounterChargeAccount()?.id===state.account;
 const render=()=>{const node=$('encounter-revenue-status');if(current()&&node){const open=Array.from(node.querySelectorAll?.('details[data-revenue-disclosure][open]')||[]).map(d=>d.dataset.revenueDisclosure);node.innerHTML=encounterRevenueStatusMarkup(account,state.data||{});for(const d of node.querySelectorAll?.('details[data-revenue-disclosure]')||[])d.open=open.includes(d.dataset.revenueDisclosure);}};
 if(account.status!=='posted'){render();return;}
 const restricted=typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims','view');
 if(state.pending){render();return state.pending;}
 if(state.data&&!force&&Date.now()-state.loadedAt<15000){render();return;}
 state.data={loading:true};render();
 state.pending=(async()=>{
  try{
   const claims=[];
   if(!restricted){let after=null;do{const page=await api(`/api/v1/billing/claims?patient_id=${encodeURIComponent(state.patient)}&account_id=${encodeURIComponent(account.id)}${after?'&after='+encodeURIComponent(after):''}`);if(!current())return;claims.push(...(page.items||[]));after=page.next_cursor;}while(after);}
   claims.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
   const claim=claims.find(c=>c.status!=='void')||claims[0];state.data={claims,loaded:true,restricted,historyLoading:!!claim};
   if(claim){try{const [history,detail]=await Promise.all([api(`/api/v1/billing/claims/${claim.id}/era-history`),api(`/api/v1/billing/claims/${claim.id}`)]);if(!current())return;state.data.history=history;state.data.tracking=detail.tracking;state.data.claims=claims.map(item=>item.id===detail.claim.id?{...item,...detail.claim}:item);}catch{state.data.historyError=true;}finally{state.data.historyLoading=false;}}
   // Read the current ledger after remittance evidence. Keep it in this status
   // snapshot so a background refresh never rebases an open charge/claim draft.
   try{const billing=await api(`/api/v1/patients/${encodeURIComponent(state.patient)}/billing`);if(!current())return;const fresh=(billing.accounts||[]).find(a=>a.id===state.account&&a.content.visit_id===account.content.visit_id);if(!fresh||!Array.isArray(billing.entries))throw new Error('The encounter ledger is unavailable.');state.data.financialAccount=fresh;state.data.financialEntries=billing.entries.filter(e=>e.account_id===state.account);state.data.financialCopays=billing.copays;}catch{state.data.financialError=true;}
   state.loadedAt=Date.now();
  }catch{state.data={error:true,financialError:true};}
  finally{state.pending=null;render();if(current()&&typeof setTimeout==='function'){clearTimeout(state.timer);state.timer=setTimeout(()=>{const node=$('encounter-revenue-status');if(current()&&node&&(!node.getClientRects||node.getClientRects().length))void loadEncounterRevenueStatus(encounterChargeAccount(),true);},20000);}}
 })();
 return state.pending;
}
function insuranceCoverageCard(coverage){
 const c=coverage.content;
 return `<article class="insurance-coverage-card"><div class="section-head"><div><h3>${esc(payerName(c.payer_id))}</h3><p>${esc(human(c.priority))} · ${esc(c.plan_name||'Plan name not recorded')}</p></div><span class="pill">${esc(human(c.status))}</span></div><dl class="billing-dl"><dt>Member / policy</dt><dd>${esc(c.member_id)}</dd><dt>Recorded plan copay</dt><dd>${c.copay_cents==null?'Not recorded':money(c.copay_cents)}</dd></dl><div class="insurance-eligibility-summary" id="insurance-eligibility-${esc(coverage.id)}"></div><div class="actions">${typeof claimmdEligibilityButton==='function'?claimmdEligibilityButton(coverage):''}<button type="button" data-coverage-open="${esc(coverage.id)}">Coverage details</button>${billingCan()?`<button type="button" data-edit-coverage="${esc(coverage.id)}">Edit coverage</button>`:''}</div></article>`;
}
function insuranceContinueMarkup(appointment){
 if(!appointment)return '<p>Select an appointment above to continue its visit.</p>';
 if((typeof chartAreaEnabled==='function'&&!chartAreaEnabled('visits'))||(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('clinical')))return '<p>Continuing the encounter requires clinical access. The appointment selection above remains the scope for billing.</p>';
 const visit=(workspace.visits||[]).find(v=>v.appointment_id===appointment.id);
 const context=`${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}`;
 if(visit)return `<p>${context}</p><button type="button" data-visit="${esc(visit.id)}">${visit.status==='signed'?'Review signed encounter':'Continue encounter'}</button><p class="muted">${visit.status==='signed'?'The signed note stays unchanged. Corrections use its existing amendment workflow.':'Open this appointment’s existing encounter.'}</p>`;
 if(workspace.patient?.archived)return `<p>${context}</p><p class="muted">This patient chart is archived. Restore it before checking in or starting a new encounter. Existing encounters remain available.</p>`;
 if(appointment.status==='booked'&&typeof canSchedule==='function'&&canSchedule())return `<p>${context} · Not checked in</p><button type="button" data-insurance-check-in="${esc(appointment.id)}">Check in this appointment</button>`;
 if(appointment.status==='checked_in'&&((typeof isRoomingStaff==='function'&&isRoomingStaff())||(['owner','clinician'].includes(me?.role)&&appointment.clinician_id===me.user_id)))return `<p>${context} · Checked in</p><button type="button" data-start="${esc(appointment.id)}">Start this encounter</button>`;
 return `<p>${context} · ${esc(human(appointment.status))}</p><p class="muted">No encounter is linked to this appointment. Its status and assigned clinician determine the next clinical action.</p>`;
}
async function checkInInsuranceAppointment(id){
 const view=hostedCopayView(),source=workspace,appointment=source.appointments.find(a=>a.id===id);
 if(chartSection!=='insurance'||revenueAppointment()?.id!==id||!appointment||appointment.status!=='booked'||source.patient?.archived||typeof canSchedule!=='function'||!canSchedule()||(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('clinical')))throw new Error('Review this appointment and patient status before checking in.');
 const updated=await api(`/api/v1/appointments/${encodeURIComponent(id)}/check-in`,'POST');
 if(workspace!==source||!currentHostedCopayView(view))return;
 if(updated.id!==id||updated.patient_id!==view.patient)throw new Error('The appointment response does not match this patient. Refresh the chart.');
 source.appointments=source.appointments.map(a=>a.id===id?updated:a);
 // Checking in changes the appointment, not the selected clinical note or an open coverage draft.
 const editor=$('insurance-editor');renderPatientInsurance();
 if(editor&&$('insurance-editor')!==editor)$('insurance-editor')?.replaceWith(editor);
}
function renderPatientInsurance(){
 if(!workspace.billing)return;
 let host=$('insurance-workspace');if(!host){host=document.createElement('section');host.id='insurance-workspace';host.className='panel';$('chart').insertBefore(host,$('appointments-panel'));}
 const appointment=revenueAppointment(),serviceDate=revenueServiceDate(appointment),coverages=workspace.billing.coverages||[],current=coverages.filter(c=>c.content.status==='active'&&c.content.effective_date<=serviceDate&&(!c.content.end_date||c.content.end_date>=serviceDate)).sort((a,b)=>({primary:0,secondary:1,tertiary:2}[a.content.priority]??3)-({primary:0,secondary:1,tertiary:2}[b.content.priority]??3)),history=coverages.filter(c=>!current.includes(c));
 if(typeof refreshPatientChartContext==='function')refreshPatientChartContext();
 const key=JSON.stringify([selected,appointment?.id,appointment?.status,serviceDate,coverages.map(c=>[c.id,c.version]),workspace.billing.copays,(workspace.visits||[]).map(v=>[v.id,v.status])]);if(host.dataset.insuranceKey===key){for(const coverage of coverages)loadInsuranceEligibility(coverage.id);insuranceAutoEligibility(current,appointment,serviceDate);if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);return;}host.dataset.insuranceKey=key;
 const options=(workspace.appointments||[]).filter(a=>!['cancelled','canceled','no_show'].includes(a.status)||a.id===appointment?.id);
 host.innerHTML=`<div class="section-head"><div><h2>Prepare this appointment</h2><p class="muted">Review insurance, handle the copay, then continue the same appointment.</p></div></div><div class="insurance-appointment-context"><label>Appointment being prepared<select id="insurance-appointment" ${options.length?'':'disabled'}>${options.map(a=>`<option value="${esc(a.id)}" ${appointment?.id===a.id?'selected':''}>${esc(a.title||'Visit')} · ${esc(date(a.starts_at))} · ${esc(human(a.status))}</option>`).join('')||'<option>No appointment available</option>'}</select></label><p class="muted">Insurance and every copay action below use this appointment${appointment?' and service date '+esc(serviceDate):''}.</p></div><ol class="insurance-workflow-stages" aria-label="Appointment preparation"><li><button type="button" data-insurance-stage="insurance-review-title"><span>1</span> Review insurance</button></li><li><button type="button" data-insurance-stage="insurance-copay-title"><span>2</span> Collect copay</button></li><li><button type="button" data-insurance-stage="insurance-continue-title"><span>3</span> Continue encounter</button></li></ol><section class="insurance-workflow-stage" aria-labelledby="insurance-review-title"><div class="section-head"><h3 id="insurance-review-title" tabindex="-1">1. Review insurance</h3><div class="actions"><button type="button" data-chart-section="documents">Insurance documents</button>${billingCan('create')?'<button type="button" data-new-coverage>Add coverage</button>':''}</div></div>${current.length?`<div class="insurance-coverage-list">${current.map(insuranceCoverageCard).join('')}</div>`:'<p>No insurance on file for this visit date.</p>'}${history.length?`<details class="insurance-supporting-records"><summary>Inactive &amp; prior coverage (${history.length})</summary><div class="insurance-coverage-list">${history.map(insuranceCoverageCard).join('')}</div></details>`:''}</section><section class="insurance-workflow-stage" aria-labelledby="insurance-copay-title"><h3 id="insurance-copay-title" tabindex="-1">2. Collect copay</h3>${appointment?hostedCopayPanel(appointment,'insurance-hosted-copay')||copayReceiptMarkup(appointmentCopays(appointment)):'<p>Select or book an appointment before collecting its copay.</p>'}${billingCan('create')&&appointment?`<details class="insurance-supporting-records"><summary>Record cash, check or an external receipt</summary><p>This records money already received; it does not charge a card.</p><button type="button" data-record-copay="${esc(appointment.id)}">Record received payment</button></details>`:''}</section><section class="insurance-workflow-stage" aria-labelledby="insurance-continue-title"><h3 id="insurance-continue-title" tabindex="-1">3. Continue encounter</h3>${insuranceContinueMarkup(appointment)}</section><div id="insurance-editor"></div>`;
 for(const coverage of coverages)loadInsuranceEligibility(coverage.id);
 insuranceAutoEligibility(current,appointment,serviceDate);
 if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);
 host.hidden=typeof chartSection!=='undefined'&&chartSection!=='insurance';
}
function renderEncounterRevenue(){
 const host=$('encounter-revenue');if(!host)return;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,account=encounterChargeAccount(),appointment=(workspace.appointments||[]).find(a=>a.id===visit?.appointment_id),serviceDate=revenueServiceDate(appointment),coverage=revenueCoverage(serviceDate);
 if(!visit){host.innerHTML='<p>Select an encounter to record its procedures and charges.</p>';return;}
 const key=JSON.stringify([selected,visit.id,visit.version,appointment?.id,account?.id,account?.version,(workspace.billing?.coverages||[]).map(c=>[c.id,c.version]),workspace.billing?.copays]);if(host.dataset.revenueKey===key){if(account&&chartSection==='visits'&&!$('encounter-billing-detail')?.innerHTML)showBillingAccount(account.id,false);loadEncounterRevenueStatus(account);if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);if(typeof resumeEncounterChargeDraft==='function')resumeEncounterChargeDraft();return;}if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();host.dataset.revenueKey=key;
 const receipts=appointmentCopays(appointment);
 host.innerHTML=`<div class="section-head"><div><h2>Procedures &amp; billing</h2><p class="muted">${esc(serviceDate)} · ${account?esc(human(account.status))+' charges':'No charges recorded'}</p></div>${billingCan('create')&&account?.status==='draft'?'<button type="button" data-encounter-charges>Edit CPT / HCPCS charges</button>':''}</div><div id="encounter-revenue-status">${encounterRevenueStatusMarkup(account)}</div><section class="billing-section"><h3>Copay</h3>${hostedCopayPanel(appointment,'encounter-hosted-copay')||copayReceiptMarkup(receipts,{encounter:true})}<div id="encounter-copay-receipt" hidden></div>${billingCan('create')&&appointment?`<details class="encounter-account-record"><summary>${receipts.some(r=>!r.voided)?'Record a cash or check payment':'Record cash, check or an external receipt'}</summary><button type="button" data-record-copay="${esc(appointment.id)}">Record a cash or check copay</button></details>`:''}</section><details class="encounter-account-record"><summary>Insurance &amp; coverage details</summary><p>${coverage?esc(payerName(coverage.content.payer_id)):'Review coverage'} · Plan copay ${coverage?.content.copay_cents==null?'not recorded':money(coverage.content.copay_cents)}</p><button type="button" data-chart-section="insurance">Insurance & eligibility</button>${typeof billingCoverageOrderMarkup==='function'?billingCoverageOrderMarkup(serviceDate,account?.content.coverage_id||coverage?.id):''}</details>${account?'<details class="encounter-account-record" id="encounter-charge-details"><summary>Charges &amp; ledger details</summary><div id="encounter-billing-detail"></div></details>':''}<div id="encounter-billing-editor"></div><section id="encounter-claims" hidden></section>`;
 if(account&&typeof chartSection!=='undefined'&&chartSection==='visits')showBillingAccount(account.id,false);
 loadEncounterRevenueStatus(account);
 if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);
 if(typeof resumeEncounterChargeDraft==='function')resumeEncounterChargeDraft();
}
function openEncounterCharges(){
 if(typeof activeVisit==='undefined'||!activeVisit){showChartSection('visits');notice('Select or start the encounter before entering its procedures.',true);return;}
 if(typeof setEncounterSection==='function')setEncounterSection('charges');else showChartSection('visits');
 if(!$('encounter-billing-editor'))renderEncounterRevenue();
 const account=encounterChargeAccount();if(account){billingSelected=account.id;showBillingAccount(account.id,false);if(account.status==='draft')accountEditor(account,null,true);}else accountEditor(null,null,true);
}
function openCopayReceiptEditor(appointmentId){
 if(appointmentId)insuranceAppointmentSelection.set(selected,appointmentId);
 const inEncounter=chartSection==='visits'&&typeof activeVisit!=='undefined'&&activeVisit&&(!appointmentId||appointmentId===activeVisit.appointment_id);
 if(inEncounter)setEncounterSection('charges');else showChartSection('insurance');
 const appointment=revenueAppointment();if(!appointment){notice('Book or select an appointment before recording its copay.',true);return;}
 const coverage=revenueCoverage(revenueServiceDate(appointment)),amount=coverage?.content.copay_cents;
 openBillingEditor(`<form id="copay-receipt-form" data-patient="${esc(selected)}" data-visit="${esc(inEncounter?activeVisit.id:'')}" data-request="${crypto.randomUUID()}" data-appointment="${esc(appointment.id)}" data-coverage="${esc(coverage?.id||'')}"><h3>Record a cash or check copay</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p class="muted">${amount!=null?'Recorded plan copay: '+money(amount)+'. Confirm the amount received for this visit.':'Confirm the patient’s responsibility and the amount already received.'} Charges can be prepared later; the receipt remains linked to this appointment.</p><div class="form-grid"><label>Amount received (USD)<input name="amount" inputmode="decimal" required value="${amount==null?'':esc(dollars(amount))}"></label><label>Received by<select name="method"><option value="cash">Cash</option><option value="check">Check</option><option value="external">External payment receipt</option></select></label><label>Receipt / check reference<input name="reference" maxlength="200"></label><label>Receipt date<input name="occurred_on" type="date" required value="${esc(revenueServiceDate(null))}"></label></div><label>Receipt evidence / reason<input name="reason" required maxlength="1000" placeholder="Reviewed copay and payment receipt"></label><label class="review-ack"><input type="checkbox" name="received_confirmed" required> I confirm this payment has already been received. No card or bank transaction will be initiated.</label><button type="submit" class="primary">Save copay receipt</button></form>`);
 const form=$('copay-receipt-form');if(form)form.revenueIdentity=me;
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.insuranceStage){event.preventDefault();if(chartSection!=='insurance'||!['insurance-review-title','insurance-copay-title','insurance-continue-title'].includes(button.dataset.insuranceStage))return;const heading=$(button.dataset.insuranceStage);heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start',behavior:'smooth'});return;}
 if(button.dataset.insuranceCheckIn){event.preventDefault();run(()=>checkInInsuranceAppointment(button.dataset.insuranceCheckIn));return;}
 if(button.dataset.refreshEligibility){event.preventDefault();loadInsuranceEligibility(button.dataset.refreshEligibility,true);return;}
 if(button.hasAttribute('data-refresh-revenue')){event.preventDefault();loadEncounterRevenueStatus(encounterChargeAccount(),true);return;}
 if(button.hasAttribute('data-revenue-documentation')){event.preventDefault();setEncounterSection('documentation');return;}
 if(button.dataset.revenueAccount){event.preventDefault();if(billingSelected!==button.dataset.revenueAccount||!$('encounter-billing-detail')?.innerHTML)showBillingAccount(button.dataset.revenueAccount,false);const details=$('encounter-charge-details');if(details)details.open=true;$('encounter-billing-detail')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
 if(button.dataset.revenueClaim||button.dataset.revenueRemittance){event.preventDefault();run(async()=>{if(button.dataset.revenueClaim){const account=encounterChargeAccount();if(!account)throw new Error('Select the encounter charge account.');await showEncounterClaim(button.dataset.revenueClaim,account.id);}else{await showClaimsWorkspace();await showEra(button.dataset.revenueRemittance);}});return;}
 if(button.dataset.revenueInvoice||button.dataset.revenueInvoices){event.preventDefault();billingSelected=button.dataset.revenueInvoice||button.dataset.revenueInvoices;run(async()=>{if(button.dataset.revenueInvoice)patientInvoiceEditor();else await showPatientInvoices();});return;}
 if(button.dataset.copayReceipt){event.preventDefault();run(()=>showCopayReceipt(button.dataset.copayReceipt,button.dataset.appointment));return;}
 if(button.hasAttribute('data-print-copay-card')){event.preventDefault();printCopayReceiptCard(button.closest('[data-copay-receipt-view]'),button);return;}
 if(button.dataset.copayAccount){event.preventDefault();run(()=>openEncounterBillingAccount(button.dataset.copayAccount));return;}
 if(button.hasAttribute('data-record-copay')){event.preventDefault();openCopayReceiptEditor(button.dataset.recordCopay);return;}
 if(button.hasAttribute('data-encounter-charges')){event.preventDefault();openEncounterCharges();return;}
 if(button.dataset.copayVoid){event.preventDefault();openBillingEditor(`<form id="copay-void-form" data-receipt="${esc(button.dataset.copayVoid)}"><h3>Correct an unapplied receipt</h3><p>This voids the recorded receipt. It does not refund cash, a check or an external card payment.</p><label>Correction reason<input name="reason" required maxlength="1000"></label><button type="submit">Void recorded receipt</button></form>`);return;}
 if(button.hasAttribute('data-apply-copays')){event.preventDefault();run(async()=>{const account=workspace.billing.accounts.find(a=>a.id===billingSelected),patient=selected,identity=me,visit=activeVisit?.id,section=chartSection;if(!account)throw new Error('Open the encounter account before applying its copay.');const result=await api(`${billingBase()}/${account.id}/copays/apply`,'POST',{},account.version);if(selected!==patient||me!==identity||activeVisit?.id!==visit)return;await selectPatient(patient,visit);if(selected!==patient||me!==identity||activeVisit?.id!==visit)return;showChartSection(section);if(section==='visits'&&typeof setEncounterSection==='function')setEncounterSection('charges');notice(`${money(result.applied_cents)} of recorded copay credit applied.`);});}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(!['copay-receipt-form','copay-void-form'].includes(form.id))return;event.preventDefault();
 run(async()=>{const data=Object.fromEntries(new FormData(form)),patient=selected,identity=me,visit=typeof activeVisit!=='undefined'?activeVisit?.id:null,section=chartSection;
 if(form.revenueIdentity&&form.revenueIdentity!==me||form.dataset.patient&&form.dataset.patient!==patient||form.dataset.visit&&form.dataset.visit!==visit)throw new Error('The copay form belongs to another encounter. Open it again for the selected visit.');
 if(form.id==='copay-receipt-form')await api(`/api/v1/patients/${patient}/billing/copays`,'POST',{request_id:form.dataset.request,appointment_id:form.dataset.appointment,coverage_id:form.dataset.coverage||null,amount_cents:cents(data.amount),method:data.method,reference:data.reference,occurred_on:data.occurred_on,reason:data.reason,received_confirmed:data.received_confirmed==='on'});
 else await api(`/api/v1/patients/${patient}/billing/copays/${form.dataset.receipt}/void`,'POST',{reason:data.reason});
 if(selected!==patient||me!==identity||section==='visits'&&activeVisit?.id!==visit)return;await selectPatient(patient,visit);if(selected!==patient||me!==identity)return;if(section==='visits')setEncounterSection('charges');else showChartSection('insurance');notice(form.id==='copay-receipt-form'?'Copay receipt recorded for the appointment.':'Receipt voided; the original evidence is retained.');});
});

document.addEventListener('change',event=>{if(event.target.id!=='insurance-appointment')return;insuranceAppointmentSelection.set(selected,event.target.value);renderPatientInsurance();});

// Appointment card collection is reconciled from server-verified processor evidence.
// These states retain only public operation metadata, never card details.
let hostedCopayState={patient:null,identity:null,items:new Map()};
function hostedCopayStateFor(appointment){
 if(hostedCopayState.patient!==selected||hostedCopayState.identity!==me)hostedCopayState={patient:selected,identity:me,items:new Map()};
 if(!hostedCopayState.items.has(appointment))hostedCopayState.items.set(appointment,{patient:selected,identity:me,appointment,items:[],availability:null,pending:null,loadedAt:0});
 return hostedCopayState.items.get(appointment);
}
function currentHostedCopayState(state){return selected===state.patient&&me===state.identity&&hostedCopayState.items.get(state.appointment)===state;}
function hostedCopayView(){
 const editor=typeof billingEditorHost==='function'?billingEditorHost():null;
 return {patient:selected,identity:me,section:chartSection,visit:typeof activeVisit==='undefined'?null:activeVisit?.id,step:typeof encounterSection==='undefined'?null:encounterSection,appointment:revenueAppointment()?.id,editor,editorChild:editor?.firstChild};
}
function currentHostedCopayView(view,checkEditor=true){
 return selected===view.patient&&me===view.identity&&chartSection===view.section&&(typeof activeVisit==='undefined'?null:activeVisit?.id)===view.visit&&(typeof encounterSection==='undefined'?null:encounterSection)===view.step&&revenueAppointment()?.id===view.appointment&&(!checkEditor||!view.editor||typeof billingEditorHost==='function'&&billingEditorHost()===view.editor&&view.editor.firstChild===view.editorChild);
}
function hostedCopayBase(state){return `/api/v1/patients/${encodeURIComponent(state.patient)}/appointments/${encodeURIComponent(state.appointment)}/copay-checkouts`;}
function validCopayReturnId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}
function validateCopayReturn(operation,id,previous){
 if(!operation||!validCopayReturnId(operation.id)||operation.id.toLowerCase()!==id.toLowerCase()||!validCopayReturnId(operation.patient_id)||!validCopayReturnId(operation.appointment_id)||(previous&&(operation.patient_id!==previous.patient_id||operation.appointment_id!==previous.appointment_id)))throw new Error('The card payment could not be matched to this return. Open its appointment from the patient chart.');
 return operation;
}
function copayReturnStatusMarkup(operation,id,message){
 const labels={creating:'Payment request is still being reconciled',open:'Awaiting card payment',paid:'Card payment verified',refunded:'Card payment refunded',expired:'Checkout expired',needs_review:'Payment status needs review'};
 return `<h2>Card payment status</h2>${operation?`<p><b>${operation.livemode?'':testPaymentTag(' · ')}${money(operation.amount_cents)} · ${esc(labels[operation.status]||'Payment status unavailable')}</b></p>${operation.receipt_id?'<p>A verified payment receipt is recorded.</p>':''}`:''}<p role="status">${esc(message)}</p><p class="muted">Returning from checkout does not confirm payment or cancellation. Do not collect again until the recorded status is resolved.</p>${validCopayReturnId(id)?`<button type="button" data-copay-return-retry="${esc(id)}">Refresh returned payment</button>`:''}`;
}
async function openHostedCopayReturn(id){
 if(!me)return;
 const identity=me;
 showTool('Card payment status');
 $('tools').innerHTML='<section id="copay-return-result" class="panel"><h2>Card payment status</h2><p role="status">Loading the authorized payment record…</p></section>';
 const host=$('copay-return-result'),current=()=>me===identity&&$('copay-return-result')===host&&$('page-title')?.textContent==='Card payment status'&&!$('tools').hidden;
 if(!validCopayReturnId(id)){host.innerHTML=copayReturnStatusMarkup(null,null,'This card payment return link is invalid. Open the appointment from its patient chart.');return;}
 let operation,refreshFailed=false;
 try{
  const base=`/api/v1/billing/copay-checkouts/${encodeURIComponent(id)}`;
  operation=validateCopayReturn((await api(base)).operation,id);
  if(!current())return;
  if(billingCan('edit')&&!['expired','refunded'].includes(operation.status)){
   try{const refreshed=await api(`${base}/refresh`,'POST',{});if(!current())return;operation=validateCopayReturn(refreshed.operation,id,operation);}
   catch{if(!current())return;refreshFailed=true;}
  }
  if(!current())return;
  const statusMessage=refreshFailed?'The latest processor check could not complete. The last saved status is shown; refresh before collecting again.':'Status was loaded from the authorized payment record.';
  if(!billingCan('create')||(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('clinical'))){host.innerHTML=copayReturnStatusMarkup(operation,id,statusMessage+' Your access does not include opening this appointment’s full billing chart.');return;}
  await selectPatient(operation.patient_id,null,current);
  if(!current())return;
  if(selected!==operation.patient_id||workspace?.patient?.id!==operation.patient_id||!workspace.appointments?.some(item=>item.id===operation.appointment_id))throw new Error('The appointment could not be opened. Review its payment status before collecting again.');
  insuranceAppointmentSelection.set(operation.patient_id,operation.appointment_id);
  activeVisit=workspace.visits?.find(visit=>visit.appointment_id===operation.appointment_id);
  chartSection=activeVisit?'visits':'insurance';encounterSection='charges';
  showTool('Patients & encounters');$('tools').replaceChildren();$('tools').hidden=true;$('clinical-workspace').hidden=false;
  $('new-patient').hidden=!canRegisterPatient();$('toggle-directory').hidden=false;
  const state=hostedCopayStateFor(operation.appointment_id);acceptHostedCopayOperation(state,operation);
  renderChart();showChartSection(chartSection);if(activeVisit)setEncounterSection('charges');
  const panel=$(activeVisit?'encounter-hosted-copay':'insurance-hosted-copay');panel?.scrollIntoView({block:'center'});
  notice(refreshFailed?statusMessage:operation.status==='paid'&&operation.receipt_id?'Card payment verified. Review the recorded receipt below.':operation.status==='open'?'Checkout is still awaiting payment. Returning here did not charge the card.':'Review the recorded card payment status below.',refreshFailed);
 }catch{
  if(current())host.innerHTML=copayReturnStatusMarkup(operation,id,operation?'The payment record is available, but the chart could not be opened. Refresh or open the appointment from the patient directory.':'This card payment could not be loaded with your current access. Refresh or open the appointment from its patient chart.');
 }
}
function safeHostedCopayUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='checkout.stripe.com'&&!url.username&&!url.password&&!url.port?url.href:null;}catch{return null;}}
// The label shown on a test payment. A production build shows nothing.
function testPaymentTag(after=''){const label=typeof testPaymentLabel==='function'?testPaymentLabel():'';return label?label+after:'';}
function hostedCopayOperationMarkup(operation,options={}){
 const onReader=operation.channel==='reader',waitingOnReader=onReader&&['creating','open'].includes(operation.status),onSavedCard=operation.channel==='saved_card',openLink=!onReader&&!onSavedCard&&['creating','open'].includes(operation.status);
 const labels={creating:'Preparing secure checkout',open:'Awaiting card payment',paid:'Card payment verified',refunded:'Card payment refunded',expired:'Checkout expired',needs_review:'Payment status needs review'},url=operation.status==='open'?safeHostedCopayUrl(operation.checkout_url):null;
 if(onReader&&!['paid','refunded'].includes(operation.status)&&typeof readerPaymentLabel==='function')labels[operation.status]=readerPaymentLabel(operation);
 if(onSavedCard&&!['paid','refunded'].includes(operation.status)&&typeof savedCardPaymentLabel==='function')labels[operation.status]=savedCardPaymentLabel(operation);
 if(openLink&&operation.cancel_requested)labels[operation.status]='Cancelling';
 if(operation.status==='expired'&&operation.last_result==='link_cancelled')labels.expired='Cancelled';
 return `<div class="timeline-row"><div><b>${operation.livemode?(options.modeShown?'LIVE · ':''):(options.modeShown?'':testPaymentTag(' · '))}${money(operation.amount_cents)} · ${esc(labels[operation.status]||'Payment status unknown')}</b><small>${esc(date(operation.created_at))}</small>${operation.refunded_cents?`<small>Verified refunds ${money(operation.refunded_cents)} · Net received ${money(operation.amount_cents-operation.refunded_cents)}</small>`:''}${operation.status==='needs_review'?'<small>Do not collect this amount again until the processor status is resolved.</small>':''}${operation.status==='paid'&&!operation.receipt_id?'<small>Payment was received; the receipt still needs reconciliation. Check payment status.</small>':''}</div><div class="actions">${url?`<a class="button ${options.primary?'primary':''}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Continue to Stripe checkout</a>`:''}${operation.receipt_id&&!options.receiptShown?`<button type="button" ${options.primary?'class="primary"':''} data-hosted-copay-receipt="${esc(operation.receipt_id)}" data-appointment="${esc(operation.appointment_id)}">View / print receipt</button>`:''}${waitingOnReader?`<button type="button" data-cancel-reader-copay="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Cancel payment</button>`:''}${openLink&&!operation.cancel_requested?`<button type="button" data-cancel-copay-link="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Cancel link</button>`:''}${operation.status!=='expired'&&!options.hideRefresh?`<button type="button" data-refresh-hosted-copay="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Refresh payment status</button>`:''}</div></div>`;
}
function hostedCopayMarkup(state,encounter=false){
 const receipts=appointmentCopays({id:state.appointment}),receiptIds=new Set(receipts.map(r=>r.id));
 const active=state.items.filter(item=>['creating','open','needs_review'].includes(item.status)||item.status==='paid'&&!receiptIds.has(item.receipt_id));
 const pending=state.items.some(item=>['creating','open','needs_review'].includes(item.status)),received=receipts.some(r=>!r.voided)||state.items.some(item=>['paid','refunded'].includes(item.status));
 const available=state.availability?.available&&typeof state.availability.livemode==='boolean'&&!pending&&!state.uncertain;
 const test=state.availability?.livemode===false,currentReceipts=receipts.filter(r=>!r.voided),historyReceipts=[...currentReceipts.slice(1),...receipts.filter(r=>r.voided)],history=state.items.filter(item=>!active.includes(item)&&!receiptIds.has(item.receipt_id));
 // The reader button sits beside the card link and is left out until card payments are set up.
 const collect=`<button type="button" ${!encounter&&!received&&!pending?'class="primary"':''} data-collect-card-copay="${esc(state.appointment)}" ${available?'':'disabled'}>${received?'Take another card payment':'Collect card copay'}</button>${state.availability?.available?`<button type="button" data-reader-copay="${esc(state.appointment)}" ${available?'':'disabled'}>Take card payment on reader</button><button type="button" data-saved-card-copay="${esc(state.appointment)}" ${available?'':'disabled'}>Charge card on file</button>`:''}`;
 const refresh=active[0]||state.items.find(item=>item.status!=='expired');
 const setup=!state.availability?.available?(me?.role==='owner'?'<p><button type="button" data-payment-settings>Stripe setup & card readiness</button></p>':'<p class="muted">A practice administrator must review Stripe setup and card readiness.</p>'):'';
 const historyContent=`${received&&!pending&&!state.uncertain?collect:''}${historyReceipts.length?copayReceiptMarkup(historyReceipts,{modeShown:test,encounter}):''}${history.map(item=>hostedCopayOperationMarkup(item,{modeShown:test,hideRefresh:true})).join('')}${state.uncertain&&state.retry?`<button type="button" data-retry-hosted-copay="${esc(state.appointment)}">${state.retry.reader_id?`Send the same ${money(state.retry.amount_cents)} payment to the reader`:state.retry.saved_card_setup_id?`Check the ${money(state.retry.amount_cents)} card charge`:`Retry the same ${money(state.retry.amount_cents)} checkout request`}</button>`:''}`;
 return `${test&&typeof testPaymentLabel==='function'&&testPaymentLabel()?`<p class="copay-mode-label">${testPaymentLabel()}</p>`:''}${state.uncertain?'<p role="status">The previous request has an uncertain result. Check its status before collecting again.</p>':''}${state.error?'<p role="status">Card payment status is unavailable. Check its status before collecting.</p>':!state.availability?'<p class="muted">Loading card payment availability…</p>':!state.availability.available?`<p class="muted">${esc(state.availability.reason||'Card collection is unavailable for this practice.')}</p>`:''}${setup}${active.map(item=>hostedCopayOperationMarkup(item,{modeShown:test,primary:!encounter,hideRefresh:true,receiptShown:receiptIds.has(item.receipt_id)})).join('')}${currentReceipts.length?copayReceiptMarkup(currentReceipts.slice(0,1),{modeShown:test,primary:!encounter&&!pending,encounter}):''}${!received&&!pending&&!state.uncertain?collect:''}<button type="button" class="text-button" ${refresh?`data-refresh-hosted-copay="${esc(refresh.id)}" data-appointment="${esc(state.appointment)}"`:`data-refresh-hosted-copay-list="${esc(state.appointment)}"`}>Check payment status</button>${historyContent?`<details class="${encounter?'encounter-account-record':'insurance-supporting-records'}" data-hosted-disclosure="history"><summary>${encounter?'Card payment details':'Payment history'}${received?' &amp; additional collection':''}</summary>${historyContent}</details>`:''}`;
}
function encounterHostedCopayMarkup(state){return hostedCopayMarkup(state,true);}
function paintHostedCopayState(state){
 if(!currentHostedCopayState(state))return;
 for(const id of ['insurance-hosted-copay','encounter-hosted-copay','hosted-copay-operation']){const node=$(id);if(node?.dataset.appointment===state.appointment){const expanded=node.querySelector?.('[data-hosted-disclosure]')?.open;node.innerHTML=hostedCopayMarkup(state,id==='encounter-hosted-copay');const details=node.querySelector?.('[data-hosted-disclosure]');if(details)details.open=!!expanded;}}
}
async function loadHostedCopays(appointment,force=false){
 const state=hostedCopayStateFor(appointment);if(state.pending)return state.pending;
 if(!force&&state.availability&&Date.now()-state.loadedAt<15000){paintHostedCopayState(state);return state;}
 state.pending=(async()=>{try{const data=await api(hostedCopayBase(state));if(!currentHostedCopayState(state))return state;state.items=(data.items||[]).filter(item=>item.patient_id===state.patient&&item.appointment_id===state.appointment);state.availability=data.availability||{available:false,reason:'Card collection is unavailable for this practice.'};state.error=false;state.loadedAt=Date.now();if(state.items.some(item=>['creating','open','needs_review'].includes(item.status)||item.request_id===state.retry?.request_id)){state.uncertain=false;state.retry=null;}}catch{state.error=true;state.availability={available:false,reason:'Card payment status could not be loaded.'};}finally{state.pending=null;paintHostedCopayState(state);}return state;})();
 return state.pending;
}
function hostedCopayPanel(appointment,id){
 return appointment&&billingCan('create')?`<section id="${id}" data-appointment="${esc(appointment.id)}" class="billing-section">${hostedCopayMarkup(hostedCopayStateFor(appointment.id),id==='encounter-hosted-copay')}</section><div id="${id}-reader"></div>`:'';
}
// The card link form opens under the copay controls that were pressed, like the reader form:
// staff stay on the encounter billing step or the Insurance tab they were on.
async function openHostedCopayEditor(appointmentId,panelId){
 const view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 const coverage=revenueCoverage(revenueServiceDate(appointment)),amount=coverage?.content.copay_cents;
 drawReaderCopay(panelId,`<form id="hosted-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Collect card copay${state.availability.livemode?'':testPaymentTag()&&' · '+testPaymentTag()}</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p>${amount==null?'No plan copay has been recorded. Confirm the amount for this visit.':'Recorded plan copay: '+money(amount)+'. Confirm the benefit and amount before collection.'}</p><label>Reviewed copay amount (USD)<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label><p class="muted">Card details are entered on Stripe’s secure checkout page. A receipt appears only after SunCharts verifies payment. Returning from checkout alone does not record a payment.</p><button type="submit" class="primary">Prepare secure card checkout</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`);
}
// The reader form and its live status are drawn directly under the copay controls that were
// pressed, on the screen staff are already on. Nothing here changes the page or the tab.
function readerCopaySlot(panelId){
 const known=['encounter-hosted-copay','insurance-hosted-copay'],preferred=known.includes(panelId)?panelId:(typeof chartSection!=='undefined'&&chartSection==='visits'?known[0]:known[1]);
 return $(preferred+'-reader')||$(known[0]+'-reader')||$(known[1]+'-reader');
}
function drawReaderCopay(panelId,html){
 const slot=readerCopaySlot(panelId);if(!slot)return null;
 slot.innerHTML=html;slot.scrollIntoView?.({block:'nearest'});
 const heading=slot.querySelector?.('h3');if(heading){heading.tabIndex=-1;heading.focus?.({preventScroll:true});}
 return slot;
}
async function openReaderCopayEditor(appointmentId,panelId,attemptedCents){
 const view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 const readers=await readersForPayment();if(!readers||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)?attemptedCents:plan,test=!state.availability.livemode&&typeof testPaymentLabel==='function'?testPaymentLabel():'';
 hostedCopayState.readers=readers;
 drawReaderCopay(panelId,`<form id="reader-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Take card payment on reader</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}${test?' · '+test:''}</p>${plan==null?'':`<p>Recorded plan copay: ${money(plan)}.</p>`}<label>Copay amount (USD)<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label>${readerChoiceMarkup(readers)}<p class="muted">The patient taps, inserts or swipes their card on the reader.</p><button type="submit" class="primary">Take payment</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`);
}
// Charging a card on file uses the same slot under the copay controls: the form, the amount
// check and the result all stay where the button was pressed.
async function openSavedCardCopayEditor(appointmentId,panelId,attemptedCents){
 const view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 const found=await savedCardsForCharge(state.patient);if(!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)?attemptedCents:plan,test=state.availability.livemode?'':testPaymentTag();
 hostedCopayState.savedCards=found.cards;
 drawReaderCopay(panelId,`<form id="saved-card-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Charge card on file</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}${test?' · '+test:''}</p>${plan==null?'':`<p>Recorded plan copay: ${money(plan)}.</p>`}${found.cards.length?`<label>Copay amount (USD)<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label>`:''}${savedCardChoiceMarkup(found)}${found.cards.length?'<p class="muted">The patient does not need to be here.</p><button type="submit" class="primary">Review charge</button>':''}<button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`);
}
// The amount is shown once more before the card is charged.
function confirmSavedCardCopay(state,body,panelId){
 const card=(hostedCopayState.savedCards||[]).find(item=>item.setup_id===body.saved_card_setup_id);
 hostedCopayState.savedCardCharge={state,body,panelId};
 drawReaderCopay(panelId,`<section class="billing-section" id="saved-card-copay-confirm"><h3>Charge card on file</h3><p>Charge <b>${money(body.amount_cents)}</b>${card?' to '+esc(savedCardName(card)):''}?</p><div class="actions"><button type="button" class="primary" data-saved-card-copay-charge>Charge ${money(body.amount_cents)}</button><button type="button" data-saved-card-copay-back>Back</button></div></section>`);
}
function showSavedCardCopay(state,operation,panelId){
 const base=`${hostedCopayBase(state)}/${encodeURIComponent(operation.id)}`;
 if(!drawReaderCopay(panelId,'<div id="saved-card-payment-live"></div>'))return;
 watchSavedCardPayment({operation,refreshUrl:`${base}/refresh`,
  accept:next=>{if(currentHostedCopayState(state))acceptHostedCopayOperation(state,next);},
  approved:paid=>paid.receipt_id?`<button type="button" class="primary" data-hosted-copay-receipt="${esc(paid.receipt_id)}" data-appointment="${esc(paid.appointment_id)}">View / print receipt</button>`:'',
  // One press makes the card link for the same amount; it appears in the copay list above.
  link:async declined=>{if(!currentHostedCopayState(state))return;const made=await api(hostedCopayBase(state),'POST',{request_id:crypto.randomUUID(),amount_cents:declined.amount_cents,coverage_id:state.savedCardCoverage||null,livemode:declined.livemode===true,reason:'Card link sent after the bank asked the patient to confirm'});if(!currentHostedCopayState(state))return;acceptHostedCopayOperation(state,made.operation);stopSavedCardPayment();const slot=readerCopaySlot(panelId);if(slot)slot.innerHTML='<p role="status">Card link created. Open it or send it from the copay list.</p>';}});
}
async function createSavedCardCopay(state,body,panelId){
 if(!currentHostedCopayState(state))return;
 const view=hostedCopayView();state.savedCardCoverage=body.coverage_id;
 let response;try{response=await api(hostedCopayBase(state),'POST',body);}catch(error){state.uncertain=true;state.retry=body;state.retryPanel=panelId;paintHostedCopayState(state);const slot=readerCopaySlot(panelId);if(slot)slot.innerHTML='';if(!currentHostedCopayView(view,false))return;throw error;}
 if(!currentHostedCopayState(state))return;acceptHostedCopayOperation(state,response.operation);
 if(!currentHostedCopayView(view,false))return;
 showSavedCardCopay(state,response.operation,panelId);
}
async function cancelCopayLink(appointment,id){
 const state=hostedCopayStateFor(appointment);if(!state.items.some(item=>item.id===id))throw new Error('Refresh the appointment’s card payment list first.');
 const data=await api(`${hostedCopayBase(state)}/${encodeURIComponent(id)}/cancel`,'POST',{});if(!currentHostedCopayState(state))return;
 acceptHostedCopayOperation(state,data.operation);
}
function showReaderCopay(state,operation,panelId){
 const reader=(hostedCopayState.readers||[]).find(item=>item.id===operation.reader_id),base=`${hostedCopayBase(state)}/${encodeURIComponent(operation.id)}`;
 if(!drawReaderCopay(panelId,'<div id="reader-payment-live"></div>'))return;
 watchReaderPayment({operation,readerName:reader?.name,statusUrl:base,cancelUrl:`${base}/reader-cancel`,
  // Try again keeps the amount that was just attempted.
  again:()=>openReaderCopayEditor(state.appointment,panelId,operation.amount_cents),
  accept:next=>{if(currentHostedCopayState(state))acceptHostedCopayOperation(state,next);},
  approved:paid=>paid.receipt_id?`<button type="button" class="primary" data-hosted-copay-receipt="${esc(paid.receipt_id)}" data-appointment="${esc(paid.appointment_id)}">View / print receipt</button>`:''});
}
async function createReaderCopay(state,body,panelId){
 if(!currentHostedCopayState(state))return;
 const view=hostedCopayView();
 let response;try{response=await api(hostedCopayBase(state),'POST',body);}catch(error){state.uncertain=true;state.retry=body;state.retryPanel=panelId;paintHostedCopayState(state);if(!currentHostedCopayView(view,false))return;throw error;}
 if(!currentHostedCopayState(state))return;acceptHostedCopayOperation(state,response.operation);
 rememberCardReader(body.reader_id);
 if(!currentHostedCopayView(view,false))return;
 showReaderCopay(state,response.operation,panelId);
}
async function cancelReaderCopay(appointment,id){
 const state=hostedCopayStateFor(appointment);if(!state.items.some(item=>item.id===id))throw new Error('Refresh the appointment’s card payment list first.');
 const data=await api(`${hostedCopayBase(state)}/${encodeURIComponent(id)}/reader-cancel`,'POST',{});if(!currentHostedCopayState(state))return;
 acceptHostedCopayOperation(state,data.operation);
}
function acceptHostedCopayOperation(state,operation){
 if(!operation||operation.patient_id!==state.patient||operation.appointment_id!==state.appointment)throw new Error('Card payment response does not match this patient and appointment. Refresh the chart.');
 state.items=[operation,...state.items.filter(item=>item.id!==operation.id)];state.uncertain=false;state.retry=null;state.error=false;state.loadedAt=Date.now();paintHostedCopayState(state);
}
async function refreshHostedCopay(appointment,id){
 const view=hostedCopayView(),state=hostedCopayStateFor(appointment),operation=state.items.find(item=>item.id===id);if(!operation)throw new Error('Refresh the appointment’s card payment list first.');
 const data=await api(`${hostedCopayBase(state)}/${encodeURIComponent(id)}/refresh`,'POST',{});if(!currentHostedCopayState(state))return;
 acceptHostedCopayOperation(state,data.operation);
 if(!currentHostedCopayView(view))return;
 if(data.operation.receipt_id){
  const section=chartSection,visit=typeof activeVisit!=='undefined'?activeVisit?.id:null;
  await selectPatient(state.patient,visit);if(!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;showChartSection(section);if(section==='visits'&&typeof setEncounterSection==='function')setEncounterSection('charges');
 }
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.copayReturnRetry){event.preventDefault();run(()=>openHostedCopayReturn(button.dataset.copayReturnRetry));return;}
 if(button.dataset.collectCardCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay')?.id;run(()=>openHostedCopayEditor(button.dataset.collectCardCopay,panel));return;}
 if(button.dataset.readerCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay')?.id;run(()=>openReaderCopayEditor(button.dataset.readerCopay,panel));return;}
 if('closeReaderCopay' in button.dataset){event.preventDefault();const slot=readerCopaySlot(button.dataset.closeReaderCopay);if(slot)slot.innerHTML='';return;}
 if(button.dataset.cancelReaderCopay){event.preventDefault();run(()=>cancelReaderCopay(button.dataset.appointment,button.dataset.cancelReaderCopay));return;}
 if(button.dataset.cancelCopayLink){event.preventDefault();run(()=>cancelCopayLink(button.dataset.appointment,button.dataset.cancelCopayLink));return;}
 if(button.dataset.savedCardCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay')?.id;run(()=>openSavedCardCopayEditor(button.dataset.savedCardCopay,panel));return;}
 if('savedCardCopayCharge' in button.dataset){event.preventDefault();const pending=hostedCopayState.savedCardCharge;if(!pending)return;hostedCopayState.savedCardCharge=null;button.disabled=true;run(()=>createSavedCardCopay(pending.state,pending.body,pending.panelId));return;}
 if('savedCardCopayBack' in button.dataset){event.preventDefault();const pending=hostedCopayState.savedCardCharge;if(!pending)return;hostedCopayState.savedCardCharge=null;run(()=>openSavedCardCopayEditor(pending.state.appointment,pending.panelId,pending.body.amount_cents));return;}
 if(button.dataset.retryHostedCopay){event.preventDefault();run(async()=>{const state=hostedCopayStateFor(button.dataset.retryHostedCopay);if(!state.uncertain||!state.retry)throw new Error('Refresh the current card payment status.');if(state.retry.reader_id)await createReaderCopay(state,state.retry,state.retryPanel);else if(state.retry.saved_card_setup_id)await createSavedCardCopay(state,state.retry,state.retryPanel);else await createHostedCopay(state,state.retry,state.retryPanel);});return;}
 if(button.dataset.refreshHostedCopay){event.preventDefault();run(()=>refreshHostedCopay(button.dataset.appointment,button.dataset.refreshHostedCopay));return;}
 if(button.dataset.hostedCopayReceipt){event.preventDefault();run(async()=>{const state=hostedCopayStateFor(button.dataset.appointment),receipt=button.dataset.hostedCopayReceipt;if(!state.items.some(item=>item.receipt_id===receipt))throw new Error('Refresh this appointment’s card payments first.');await showCopayReceipt(receipt,state.appointment);});return;}
 if(button.dataset.refreshHostedCopayList){event.preventDefault();run(async()=>{const view=hostedCopayView(),state=await loadHostedCopays(button.dataset.refreshHostedCopayList,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view)||!state.items.some(item=>item.receipt_id))return;const section=chartSection;await selectPatient(state.patient,typeof activeVisit!=='undefined'?activeVisit?.id:null);if(currentHostedCopayState(state)&&currentHostedCopayView(view,false))showChartSection(section);});}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='reader-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 if(!data.reader)throw new Error('Choose a card reader.');
 await createReaderCopay(state,{request_id:form.dataset.request,amount_cents:cents(data.amount),coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Appointment copay taken on card reader',reader_id:data.reader},form.dataset.panel||undefined);
 });
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='saved-card-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 if(!data.card)throw new Error('Choose a card on file.');
 const amount=cents(data.amount);if(!Number.isSafeInteger(amount)||amount<50)throw new Error('Enter the copay amount.');
 confirmSavedCardCopay(state,{request_id:form.dataset.request,amount_cents:amount,coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Copay charged to card on file',saved_card_setup_id:data.card},form.dataset.panel||undefined);
 });
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='hosted-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 const body={request_id:form.dataset.request,amount_cents:cents(data.amount),coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Reviewed appointment copay before hosted card collection'};
 await createHostedCopay(state,body,form.dataset.panel||undefined);
 });
});

async function createHostedCopay(state,body,panelId){
 if(!currentHostedCopayState(state))return;
 const view=hostedCopayView();
 let response;try{response=await api(hostedCopayBase(state),'POST',body);}catch(error){state.uncertain=true;state.retry=body;state.retryPanel=panelId;paintHostedCopayState(state);if(!currentHostedCopayView(view,false))return;throw error;}
 if(!currentHostedCopayState(state))return;acceptHostedCopayOperation(state,response.operation);
 if(!currentHostedCopayView(view,false))return;
 // The checkout link and its status now show in the copay panel just above; close the form.
 const slot=readerCopaySlot(panelId);if(slot){slot.innerHTML='';$(slot.id.replace(/-reader$/,''))?.scrollIntoView?.({block:'nearest'});}
}
