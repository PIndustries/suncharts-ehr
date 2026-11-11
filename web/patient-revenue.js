// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const insuranceAppointmentSelection=new Map();
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
function copayReceiptMarkup(receipts){
 return receipts.map(r=>{const hosted=r.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),reversed=Number(r.reversed_cents||0),allocated=Number(r.allocated_cents||0),unapplied=copayUnapplied(r),held=hosted?.status==='needs_review',status=r.voided?'Voided receipt':held?'Card payment requires reconciliation':refunded===r.amount_cents?'Card payment refunded':refunded?'Card payment partially refunded':reversed?'Corrected on ledger':unapplied?'Recorded · awaiting charge allocation':'Applied to encounter charges';return `<div class="timeline-row"><div><b>${hosted?.livemode===false?'TEST · ':''}${money(r.amount_cents)} · ${esc(status)}</b><small>${hosted?'Card · Verified processor capture':esc(human(r.method))} · ${esc(r.occurred_on)}${r.reference?' · '+esc(r.reference):''}</small>${refunded?`<small>Verified refunds ${money(refunded)} · Net received ${money(r.amount_cents-refunded)}</small>`:''}${!r.voided&&!reversed&&!held&&unapplied?`<small>${money(unapplied)} unapplied credit</small>`:''}${reversed?`<small>${money(reversed)} reversed. Review the account ledger before recording any replacement receipt.</small>`:''}</div><div class="actions"><button type="button" data-copay-receipt="${esc(r.id)}">View / print receipt</button>${(r.account_ids||[]).map(id=>`<button type="button" data-copay-account="${esc(id)}">Review ledger</button>`).join('')}${billingCan()&&!hosted&&!r.voided&&!allocated?`<button type="button" data-copay-void="${esc(r.id)}">Correct receipt</button>`:''}</div></div>`;}).join('')||'<p class="muted">No copay receipt recorded for this appointment.</p>';
}
function copayReceiptDocument(receipt,context){
 const patient=context.patient,appointment=context.appointment,corrected=Number(receipt.reversed_cents||0)>0,hosted=receipt.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),test=hosted?.livemode===false;
 const status=receipt.voided?'Voided receipt':corrected?'Receipt with corrected allocation':refunded?'Card copay receipt with verified refund':hosted?'Card copay receipt':'Copay receipt';
 const allocation=receipt.voided?'<p>This receipt record was voided and is retained for history. Voiding the record does not issue a refund.</p>':corrected?'<p>A charge allocation was reversed after this payment was recorded. Contact the practice to confirm its current disposition. A ledger reversal does not establish that a refund was issued.</p>':`<dt>${refunded?'Original charge allocations':'Applied to encounter charges'}</dt><dd>${money(Number(receipt.allocated_cents||0))}</dd><dt>Remaining unapplied credit</dt><dd>${money(copayUnapplied(receipt))}</dd>`;
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'"><title>Copay receipt</title><link rel="stylesheet" href="/patient-print.css"></head><body class="patient-receipt"><p><b>${esc(context.practiceName||'')}</b></p><h1>${test?'TEST — ':''}${esc(status)}</h1><p>${esc(patient.given_name)} ${esc(patient.family_name)}${patient.mrn?`<small>MRN ${esc(patient.mrn)}</small>`:''}</p><small>Receipt ${esc(receipt.id)}<br>${hosted?'Payment received (UTC date)':'Payment received'} ${esc(receipt.occurred_on)}${receipt.created_at?'<br>Recorded '+esc(date(receipt.created_at)):''}</small><p>${appointment?`Appointment: ${esc(appointment.title||'Office visit')}<br>${esc(date(appointment.starts_at))}`:`Appointment reference: <span class="reference">${esc(receipt.appointment_id)}</span>`}</p><dl><dt>${receipt.voided?'Original recorded amount':'Amount received'}</dt><dd><b>${money(receipt.amount_cents)}</b></dd><dt>Payment method</dt><dd>${hosted?'Card · Verified processor capture':esc(invoicePaymentMethod(receipt.method))}</dd>${refunded?`<dt>Verified refunded amount</dt><dd>${money(refunded)}</dd><dt>Net card payment</dt><dd>${money(receipt.amount_cents-refunded)}</dd>`:''}${receipt.reference?`<dt>Receipt / check reference</dt><dd class="reference">${esc(receipt.reference)}</dd>`:''}${!receipt.voided&&!corrected?allocation:''}</dl>${receipt.voided||corrected?allocation:''}<footer>${test?'<p>This is test payment evidence. No real funds were collected.</p>':''}${hosted?.status==='needs_review'?'<p>This payment requires reconciliation. Confirm its current status with the practice.</p>':''}<p>This is a copy of the practice’s recorded payment receipt. It is not an invoice and does not determine final insurance or patient responsibility.</p><small>Copy prepared ${esc(date(context.printedAt))}. Patient and appointment details reflect the chart when this copy was prepared.</small></footer></body></html>`;
}
function showCopayReceipt(id){
 const receipt=(workspace.billing?.copays||[]).find(r=>r.id===id);
 if(!receipt||!workspace.patient||(receipt.patient_id&&receipt.patient_id!==selected))throw new Error('This receipt is unavailable for the current patient. Refresh the chart.');
 const context={patient:workspace.patient,appointment:(workspace.appointments||[]).find(a=>a.id===receipt.appointment_id),practiceName:document.querySelector('.practice-identity strong')?.textContent||'',printedAt:new Date().toISOString()};
 openBillingEditor('<div class="section-head"><h3>Copay receipt</h3><button type="button" data-print-copay>Print / save PDF</button></div><div id="copay-receipt-preview"></div>');
 const frame=document.createElement('iframe');frame.id='copay-receipt-frame';frame.title='Copay receipt print preview';frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');frame.srcdoc=copayReceiptDocument(receipt,context);$('copay-receipt-preview').append(frame);
}
// Keep responses scoped to the current patient and sign-in; never carry chart evidence across patients.
let insuranceEligibilityState={patient:null,identity:null,items:new Map()};
let encounterRevenueState={patient:null,identity:null,account:null,pending:null,data:null,loadedAt:0};
function eligibilityState(){
 if(insuranceEligibilityState.patient!==selected||insuranceEligibilityState.identity!==me)insuranceEligibilityState={patient:selected,identity:me,items:new Map()};
 return insuranceEligibilityState;
}
function insuranceEligibilityMarkup(state,coverageId,serviceDate){
 if(!state||state.loading)return '<p class="muted">Loading recorded eligibility checks…</p>';
 if(state.error)return `<p>Eligibility history could not be loaded. Coverage status is unknown.</p><button type="button" data-refresh-eligibility="${esc(coverageId)}">Retry eligibility history</button>`;
 const check=state.history?.items?.[0];
 if(!check)return '<p class="muted">No eligibility check recorded. Confirm benefits for this service date.</p>';
 const checkedDate=check.request_snapshot?.request?.service_date||check.request_snapshot?.service_date;
 const status={completed:'Payer response received',pending:'Eligibility request pending',failed:'Eligibility request failed'}[check.status]||human(check.status);
 return `<div class="section-head"><div><b>${esc(status)}</b><small>Requested ${esc(date(check.created_at))}${checkedDate?' · Service '+esc(checkedDate):''}</small></div><button type="button" data-eligibility-report="${esc(coverageId)}">View eligibility report</button></div>${checkedDate&&checkedDate!==serviceDate?`<p class="eligibility-caution">This check is for ${esc(checkedDate)}; the selected visit is ${esc(serviceDate)}.</p>`:''}<p class="muted">${check.status==='completed'?'Review the returned benefits, network and service limits. A response does not guarantee coverage or payment.':'No completed benefit response from this request. Do not assume the patient is uninsured.'}</p>${check.status==='completed'&&checkedDate===serviceDate&&typeof claimmdBenefitSummary==='function'?claimmdBenefitSummary(check):''}`;
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
 const totals={patient:0,insurer:0,balance:account.total_cents,testActivity:entries.some(e=>e.content?.test_mode)};
 for(const entry of entries){totals.balance+=Number(entry.effect_cents);let source=entry;const seen=new Set();while(source.reverses_id&&byId.has(source.reverses_id)&&!seen.has(source.id)){seen.add(source.id);source=byId.get(source.reverses_id);}if((source.kind==='payment'||source.kind==='adjustment_debit'&&(source.content?.managed_payment_id||source.content?.hosted_copay_operation_id))&&['patient','insurer'].includes(source.content?.party))totals[source.content.party]-=Number(entry.effect_cents);}
 return totals;
}
function encounterRevenueStatusMarkup(account,data={}){
 if(!account)return '<p class="muted">Add procedures and charges for this encounter to begin the billing workflow.</p>';
 const financialAccount=data.financialAccount||account,totals=encounterPaymentTotals(financialAccount,data.financialEntries),financialUnavailable=data.loading||data.financialError,claims=data.claims||[],claim=claims.find(c=>c.status!=='void')||claims[0],history=data.history,head=history?.active_head;
 const currentRemittance=head?(history.items||[]).find(row=>row.remittance_id===head.remittance_id&&row.row_index===head.row_index):null;
 const isPosted=account.status==='posted',claimState={draft:'Draft — review before submission',ready:'Ready for submission review',submitted:'Submission recorded — review delivery and response evidence',accepted:'Acceptance recorded — review adjudication evidence',rejected:'Rejected — correction needed',adjudicated:'Adjudicated — review remittance',void:'Voided claim'};
 let action='',next='';
 if(!isPosted){next=activeVisit?.status==='signed'?'Review and post charges to apply recorded copays.':'Finish and sign this encounter before posting charges.';action=activeVisit?.status==='signed'?`<button type="button" data-revenue-account="${esc(account.id)}">Review charges for posting</button>`:'<button type="button" data-revenue-documentation>Continue encounter documentation</button>';}
 else if(data.error){next='Claim status could not be loaded. Refresh before preparing another claim.';}
 else if(data.restricted){next='Claim review requires access to insurance claims.';}
 else if(!data.loaded){next='Loading this encounter’s claim and remittance evidence…';}
 else if(claim){next=claimState[claim.status]||human(claim.status);action=`<button type="button" data-revenue-claim="${esc(claim.id)}">${claim.status==='draft'?'Review claim':claim.status==='ready'?'Review submission':claim.status==='rejected'?'Review and correct claim':'Review claim status'}</button>`;}
 else if(String(account.coverage_snapshot?.payer?.content?.payer_code||'').trim()){next='Charges are posted. Prepare the insurance claim for review.';action=billingCan('create')?`<button type="button" data-new-claim="${esc(account.id)}">Prepare insurance claim</button>`:'';}
 else{next='Review insurance and patient responsibility before invoicing.';action='<button type="button" data-chart-section="insurance">Review insurance</button>';}
 const remit=currentRemittance?`<b>${currentRemittance.claim?.status==='22'?'Reversal posted':'Remittance posted'}</b><small>Trace ${esc(currentRemittance.trace)} · Payer-reported patient responsibility ${money(currentRemittance.claim?.patient_responsibility_cents||0)}</small><button type="button" data-revenue-remittance="${esc(currentRemittance.remittance_id)}">Review posted remittance</button>`:head?`<b>Remittance posting recorded</b><button type="button" data-revenue-remittance="${esc(head.remittance_id)}">Review remittance details</button>`:data.historyLoading?'<p class="muted">Loading posted remittance history…</p>':data.historyError?'<p>Posted remittance history could not be loaded.</p>':claim&&data.loaded?'<p class="muted">No active remittance posting for the current claim. Submission and acceptance do not mean payment was received.</p>':'<p class="muted">Insurance payments and adjustments appear after remittance review and posting.</p>';
 return `<section class="encounter-revenue-status"><div class="section-head"><h3>Encounter revenue status</h3>${isPosted?'<button type="button" data-refresh-revenue>Refresh status</button>':''}</div><div class="revenue-metrics"><div><span>Gross charges</span><strong>${money(financialAccount.total_cents)}</strong></div><div><span>Posted patient payments</span><strong>${isPosted?(financialUnavailable?'Unavailable':money(totals.patient)):'Not posted'}</strong></div><div><span>Posted insurance payments</span><strong>${isPosted?(financialUnavailable?'Unavailable':money(totals.insurer)):'Not posted'}</strong></div><div><span>Open account balance</span><strong>${isPosted?(financialUnavailable?'Unavailable':money(totals.balance)):'Not posted'}</strong></div></div>${data.financialError?'<p role="status">Current ledger totals could not be refreshed. Refresh before relying on the balance.</p>':data.loading?'<p class="muted">Refreshing current ledger totals…</p>':''}${totals.testActivity?'<p class="mapping-notice">These totals include test processor activity. Test entries do not establish that real funds were received.</p>':''}<p class="muted">The open balance combines patient and insurance amounts and includes all posted adjustments. Review the patient’s share before invoicing.</p><div class="revenue-next-stage"><div><span class="eyebrow">Next step</span><p>${esc(next)}</p>${claim?`<small>${esc(claim.control_number)} · ${esc(human(claim.frequency))} · ${esc(date(claim.created_at))}${claims.length>1?' · '+claims.length+' claims for this account':''}</small>`:''}</div><div class="actions">${action}${isPosted&&billingCan('create')?`<button type="button" data-revenue-invoice="${esc(account.id)}">Review patient invoice</button>`:''}${isPosted?`<button type="button" data-revenue-invoices="${esc(account.id)}">Saved invoices</button>`:''}</div></div>${isPosted?`<div class="revenue-remittance">${remit}</div>${data.tracking&&typeof claimMdTrackingSummary==='function'?claimMdTrackingSummary(data.tracking):''}`:''}</section>`;
}
async function loadEncounterRevenueStatus(account,force=false){
 if(!account)return;
 let state=encounterRevenueState;
 if(state.patient!==selected||state.identity!==me||state.account!==account.id||state.version!==account.version){state={patient:selected,identity:me,account:account.id,version:account.version,pending:null,data:null,loadedAt:0};encounterRevenueState=state;}
 const current=()=>encounterRevenueState===state&&selected===state.patient&&me===state.identity&&encounterChargeAccount()?.id===state.account;
 const render=()=>{const node=$('encounter-revenue-status');if(current()&&node)node.innerHTML=encounterRevenueStatusMarkup(account,state.data||{});};
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
   try{const billing=await api(`/api/v1/patients/${encodeURIComponent(state.patient)}/billing`);if(!current())return;const fresh=(billing.accounts||[]).find(a=>a.id===state.account&&a.content.visit_id===account.content.visit_id);if(!fresh||!Array.isArray(billing.entries))throw new Error('The encounter ledger is unavailable.');state.data.financialAccount=fresh;state.data.financialEntries=billing.entries.filter(e=>e.account_id===state.account);}catch{state.data.financialError=true;}
   state.loadedAt=Date.now();
  }catch{state.data={error:true,financialError:true};}
  finally{state.pending=null;render();if(current()&&typeof setTimeout==='function'){clearTimeout(state.timer);state.timer=setTimeout(()=>{const node=$('encounter-revenue-status');if(current()&&node&&(!node.getClientRects||node.getClientRects().length))void loadEncounterRevenueStatus(encounterChargeAccount(),true);},20000);}}
 })();
 return state.pending;
}
function renderPatientInsurance(){
 if(!workspace.billing)return;
 let host=$('insurance-workspace');if(!host){host=document.createElement('section');host.id='insurance-workspace';host.className='panel';$('chart').insertBefore(host,$('appointments-panel'));}
 const appointment=revenueAppointment(),serviceDate=revenueServiceDate(),primary=revenueCoverage(serviceDate),coverages=workspace.billing.coverages||[];
 const key=JSON.stringify([selected,appointment?.id,serviceDate,coverages.map(c=>[c.id,c.version]),workspace.billing.copays]);if(host.dataset.insuranceKey===key){for(const coverage of coverages)loadInsuranceEligibility(coverage.id);if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);return;}host.dataset.insuranceKey=key;
 host.innerHTML=`<div class="section-head"><div><h2>Insurance & copay</h2><p class="muted">Review coverage and benefits for ${esc(serviceDate)} before the visit.</p></div><div class="actions"><button type="button" data-chart-section="documents">Insurance documents</button>${billingCan('create')?'<button type="button" data-new-coverage>+ Insurance coverage</button>':''}</div></div><section class="insurance-summary"><div><h3>${primary?esc(payerName(primary.content.payer_id)):'No active primary coverage for this service date'}</h3><p>${primary?`${esc(primary.content.plan_name||'Plan name not recorded')} · Member ${esc(primary.content.member_id)}`:'Add or review coverage before checking benefits. This does not establish that the patient is uninsured.'}</p></div><div><span class="muted">Recorded plan copay</span><strong>${primary?.content.copay_cents!=null?money(primary.content.copay_cents):'Not recorded'}</strong><small>Confirm the benefit for this visit; eligibility does not guarantee payment.</small></div></section><div class="insurance-coverage-list">${coverages.map(c=>`<article class="insurance-coverage-card"><div class="section-head"><div><h3>${esc(payerName(c.content.payer_id))}</h3><p>${esc(human(c.content.priority))} · ${esc(c.content.plan_name||'Plan name not recorded')}</p></div><span class="pill">${esc(human(c.content.status))}</span></div><dl class="billing-dl"><dt>Member / policy</dt><dd>${esc(c.content.member_id)}</dd><dt>Group</dt><dd>${esc(c.content.group_number||'Not recorded')}</dd><dt>Covered dates</dt><dd>${esc(c.content.effective_date)} – ${esc(c.content.end_date||'Open-ended')}</dd><dt>Recorded copay</dt><dd>${c.content.copay_cents==null?'Not recorded':money(c.content.copay_cents)}</dd></dl><div class="insurance-eligibility-summary" id="insurance-eligibility-${esc(c.id)}"></div><div class="actions">${typeof claimmdEligibilityButton==='function'?claimmdEligibilityButton(c):''}<button type="button" data-coverage-open="${esc(c.id)}">Coverage details</button>${billingCan()?`<button type="button" data-edit-coverage="${esc(c.id)}">Edit coverage</button>`:''}</div></article>`).join('')}</div><section class="billing-section">${(workspace.appointments||[]).length>1?`<label>Appointment for insurance review<select id="insurance-appointment">${workspace.appointments.filter(a=>!['cancelled','canceled','no_show'].includes(a.status)).map(a=>`<option value="${esc(a.id)}" ${appointment?.id===a.id?'selected':''}>${esc(a.title||'Visit')} · ${esc(date(a.starts_at))} · ${esc(human(a.status))}</option>`).join('')}</select></label>`:''}<div class="section-head"><div><h3>Appointment copay</h3><p class="muted">${appointment?esc(appointment.title||'Visit')+' · '+esc(date(appointment.starts_at)):'Select or book an appointment to record its copay.'}</p></div>${billingCan('create')&&appointment?`<button type="button" class="primary" data-record-copay="${esc(appointment.id)}">Record received copay</button>`:''}</div>${copayReceiptMarkup(appointmentCopays(appointment))}<p class="muted">Record cash, check or a payment already collected externally using its receipt.</p></section>${hostedCopayPanel(appointment,'insurance-hosted-copay')}<div id="insurance-editor"></div>`;
 for(const coverage of coverages)loadInsuranceEligibility(coverage.id);
 if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);
 host.hidden=typeof chartSection!=='undefined'&&chartSection!=='insurance';
}
function renderEncounterRevenue(){
 const host=$('encounter-revenue');if(!host)return;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,account=encounterChargeAccount(),appointment=(workspace.appointments||[]).find(a=>a.id===visit?.appointment_id),serviceDate=revenueServiceDate(appointment),coverage=revenueCoverage(serviceDate);
 if(!visit){host.innerHTML='<p>Select an encounter to record its procedures and charges.</p>';return;}
 const key=JSON.stringify([selected,visit.id,visit.version,appointment?.id,account?.id,account?.version,coverage?.id,coverage?.version,workspace.billing?.copays]);if(host.dataset.revenueKey===key){if(account&&chartSection==='visits'&&!$('encounter-billing-detail')?.innerHTML)showBillingAccount(account.id,false);loadEncounterRevenueStatus(account);if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);if(typeof resumeEncounterChargeDraft==='function')resumeEncounterChargeDraft();return;}if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();host.dataset.revenueKey=key;
 host.innerHTML=`<div class="section-head"><div><h2>Procedures, charges & copay</h2><p class="muted">${esc(serviceDate)} · ${account?esc(human(account.status))+' encounter charges':'No charges recorded for this encounter'}</p></div>${billingCan('create')&&(!account||account.status==='draft')?`<button type="button" class="primary" data-encounter-charges>${account?'Edit CPT / HCPCS charges':'Add CPT / HCPCS charges'}</button>`:''}</div><div class="encounter-revenue-summary"><span>Insurance <b>${coverage?esc(payerName(coverage.content.payer_id)):'Review coverage'}</b></span><span>Recorded plan copay <b>${coverage?.content.copay_cents==null?'Not recorded':money(coverage.content.copay_cents)}</b></span><button type="button" data-chart-section="insurance">Review insurance & benefits</button>${billingCan('create')&&appointment?`<button type="button" data-record-copay="${esc(appointment.id)}">Record received copay</button>`:''}</div>${copayReceiptMarkup(appointmentCopays(appointment))}${hostedCopayPanel(appointment,'encounter-hosted-copay')}<p class="muted">Record procedures and link this encounter’s ICD diagnoses. After signing, post charges to apply recorded copays, prepare the patient invoice and review the insurance claim.</p><div id="encounter-revenue-status">${encounterRevenueStatusMarkup(account)}</div><details class="encounter-account-record" ${account?.status==='draft'?'open':''}><summary>Charge details & ledger</summary><div id="encounter-billing-detail"></div></details><div id="encounter-billing-editor"></div><section id="encounter-claims" hidden></section>`;
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
 openBillingEditor(`<form id="copay-receipt-form" data-patient="${esc(selected)}" data-visit="${esc(inEncounter?activeVisit.id:'')}" data-request="${crypto.randomUUID()}" data-appointment="${esc(appointment.id)}" data-coverage="${esc(coverage?.id||'')}"><h3>Record received copay</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p class="muted">${amount!=null?'Recorded plan copay: '+money(amount)+'. Confirm the amount received for this visit.':'Confirm the patient’s responsibility and the amount already received.'} Charges can be prepared later; the receipt remains linked to this appointment.</p><div class="form-grid"><label>Amount received (USD)<input name="amount" inputmode="decimal" required value="${amount==null?'':esc(dollars(amount))}"></label><label>Received by<select name="method"><option value="cash">Cash</option><option value="check">Check</option><option value="external">External payment receipt</option></select></label><label>Receipt / check reference<input name="reference" maxlength="200"></label><label>Receipt date<input name="occurred_on" type="date" required value="${esc(revenueServiceDate(null))}"></label></div><label>Receipt evidence / reason<input name="reason" required maxlength="1000" placeholder="Reviewed copay and payment receipt"></label><label class="review-ack"><input type="checkbox" name="received_confirmed" required> I confirm this payment has already been received. No card or bank transaction will be initiated.</label><button type="submit" class="primary">Save copay receipt</button></form>`);
 const form=$('copay-receipt-form');if(form)form.revenueIdentity=me;
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.eligibilityReport){event.preventDefault();run(async()=>{const patient=selected,identity=me,coverage=workspace.billing.coverages.find(c=>c.id===button.dataset.eligibilityReport);if(!coverage)throw new Error('Coverage is no longer available.');await loadInsuranceEligibility(coverage.id);if(selected!==patient||me!==identity)return;const entry=eligibilityState().items.get(coverage.id);await openClaimmdEligibility(coverage,{readOnly:true,history:entry?.history,serviceDate:revenueServiceDate()});});return;}
 if(button.dataset.refreshEligibility){event.preventDefault();loadInsuranceEligibility(button.dataset.refreshEligibility,true);return;}
 if(button.hasAttribute('data-refresh-revenue')){event.preventDefault();loadEncounterRevenueStatus(encounterChargeAccount(),true);return;}
 if(button.hasAttribute('data-revenue-documentation')){event.preventDefault();setEncounterSection('documentation');return;}
 if(button.dataset.revenueAccount){event.preventDefault();showBillingAccount(button.dataset.revenueAccount,false);$('encounter-billing-detail')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
 if(button.dataset.revenueClaim||button.dataset.revenueRemittance){event.preventDefault();run(async()=>{if(button.dataset.revenueClaim){const account=encounterChargeAccount();if(!account)throw new Error('Select the encounter charge account.');await showEncounterClaim(button.dataset.revenueClaim,account.id);}else{await showClaimsWorkspace();await showEra(button.dataset.revenueRemittance);}});return;}
 if(button.dataset.revenueInvoice||button.dataset.revenueInvoices){event.preventDefault();billingSelected=button.dataset.revenueInvoice||button.dataset.revenueInvoices;run(async()=>{if(button.dataset.revenueInvoice)patientInvoiceEditor();else await showPatientInvoices();});return;}
 if(button.dataset.copayReceipt){event.preventDefault();run(async()=>showCopayReceipt(button.dataset.copayReceipt));return;}
 if(button.hasAttribute('data-print-copay')){event.preventDefault();$('copay-receipt-frame').contentWindow.focus();$('copay-receipt-frame').contentWindow.print();return;}
 if(button.dataset.copayAccount){event.preventDefault();showBillingAccount(button.dataset.copayAccount);return;}
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
function safeHostedCopayUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='checkout.stripe.com'&&!url.username&&!url.password&&!url.port?url.href:null;}catch{return null;}}
function hostedCopayOperationMarkup(operation){
 const labels={creating:'Preparing secure checkout',open:'Awaiting card payment',paid:'Card payment verified',refunded:'Card payment refunded',expired:'Checkout expired',needs_review:'Payment status needs review'},url=operation.status==='open'?safeHostedCopayUrl(operation.checkout_url):null;
 return `<div class="timeline-row"><div><b>${operation.livemode?'':'TEST · '}${money(operation.amount_cents)} · ${esc(labels[operation.status]||'Payment status unknown')}</b><small>${esc(date(operation.created_at))}</small>${operation.refunded_cents?`<small>Verified refunds ${money(operation.refunded_cents)} · Net received ${money(operation.amount_cents-operation.refunded_cents)}</small>`:''}${operation.status==='needs_review'?'<small>Do not collect this amount again until the processor status is resolved.</small>':''}${operation.status==='paid'&&!operation.receipt_id?'<small>Payment was received; the receipt still needs reconciliation. Refresh status.</small>':''}</div><div class="actions">${url?`<a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open secure card checkout</a>`:''}${operation.receipt_id?`<button type="button" data-hosted-copay-receipt="${esc(operation.receipt_id)}" data-appointment="${esc(operation.appointment_id)}">View / print receipt</button>`:''}${operation.status!=='expired'?`<button type="button" data-refresh-hosted-copay="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Refresh payment status</button>`:''}</div></div>`;
}
function hostedCopayMarkup(state){
 const pending=state.items.some(item=>['creating','open','needs_review'].includes(item.status)),available=state.availability?.available&&typeof state.availability.livemode==='boolean'&&!pending&&!state.uncertain;
 return `<div class="section-head"><h3>Card copay</h3><button type="button" data-collect-card-copay="${esc(state.appointment)}" ${available?'':'disabled'}>Collect card copay</button></div>${state.availability?.livemode===false?'<p class="mapping-notice">Test card collection · Synthetic patients only. No real funds are collected.</p>':''}${state.uncertain?'<p role="status">The last checkout request has an uncertain result. Refresh status before starting another collection. Retrying the same open form uses the same request.</p>':''}${state.error?'<p role="status">Card payment status could not be loaded. Refresh before collecting another payment.</p>':!state.availability?'<p class="muted">Loading card payment availability…</p>':!state.availability.available?`<p class="muted">${esc(state.availability.reason||'Card collection is unavailable for this practice.')}</p>`:''}${state.items.map(hostedCopayOperationMarkup).join('')}${state.uncertain&&state.retry?`<button type="button" data-retry-hosted-copay="${esc(state.appointment)}">Retry the same ${money(state.retry.amount_cents)} checkout request</button>`:''}<button type="button" data-refresh-hosted-copay-list="${esc(state.appointment)}">Refresh card payments</button>`;
}
function paintHostedCopayState(state){
 if(!currentHostedCopayState(state))return;
 for(const id of ['insurance-hosted-copay','encounter-hosted-copay','hosted-copay-operation']){const node=$(id);if(node?.dataset.appointment===state.appointment)node.innerHTML=hostedCopayMarkup(state);}
}
async function loadHostedCopays(appointment,force=false){
 const state=hostedCopayStateFor(appointment);if(state.pending)return state.pending;
 if(!force&&state.availability&&Date.now()-state.loadedAt<15000){paintHostedCopayState(state);return state;}
 state.pending=(async()=>{try{const data=await api(hostedCopayBase(state));if(!currentHostedCopayState(state))return state;state.items=(data.items||[]).filter(item=>item.patient_id===state.patient&&item.appointment_id===state.appointment);state.availability=data.availability||{available:false,reason:'Card collection is unavailable for this practice.'};state.error=false;state.loadedAt=Date.now();if(state.items.some(item=>['creating','open','needs_review'].includes(item.status)||item.request_id===state.retry?.request_id)){state.uncertain=false;state.retry=null;}}catch{state.error=true;state.availability={available:false,reason:'Card payment status could not be loaded.'};}finally{state.pending=null;paintHostedCopayState(state);}return state;})();
 return state.pending;
}
function hostedCopayPanel(appointment,id){
 return appointment&&billingCan('create')?`<section id="${id}" data-appointment="${esc(appointment.id)}" class="billing-section">${hostedCopayMarkup(hostedCopayStateFor(appointment.id))}</section>`:'';
}
async function openHostedCopayEditor(appointmentId){
 const view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 insuranceAppointmentSelection.set(selected,appointmentId);showChartSection('insurance');
 const coverage=revenueCoverage(revenueServiceDate(appointment)),amount=coverage?.content.copay_cents;
 openBillingEditor(`<form id="hosted-copay-form" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>${state.availability.livemode?'Collect card copay':'Collect test card copay'}</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p>${amount==null?'No plan copay has been recorded. Confirm the amount for this visit.':'Recorded plan copay: '+money(amount)+'. Confirm the benefit and amount before collection.'}</p><label>Reviewed copay amount (USD)<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label><label class="review-ack"><input type="checkbox" name="reviewed" required> I reviewed this visit’s copay and the amount to collect.</label><p class="muted">Card details are entered on Stripe’s secure checkout page. A receipt appears only after SunCharts verifies payment. Returning from checkout alone does not record a payment.</p><button type="submit" class="primary">Prepare secure card checkout</button><button type="button" data-refresh-hosted-copay-list="${esc(appointmentId)}">Refresh existing card payments</button></form>`);
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
 if(button.dataset.collectCardCopay){event.preventDefault();run(()=>openHostedCopayEditor(button.dataset.collectCardCopay));return;}
 if(button.dataset.retryHostedCopay){event.preventDefault();run(async()=>{const state=hostedCopayStateFor(button.dataset.retryHostedCopay);if(!state.uncertain||!state.retry)throw new Error('Refresh the current card payment status.');await createHostedCopay(state,state.retry);});return;}
 if(button.dataset.refreshHostedCopay){event.preventDefault();run(()=>refreshHostedCopay(button.dataset.appointment,button.dataset.refreshHostedCopay));return;}
 if(button.dataset.hostedCopayReceipt){event.preventDefault();run(async()=>{const view=hostedCopayView(),state=hostedCopayStateFor(button.dataset.appointment),receipt=button.dataset.hostedCopayReceipt;if(!state.items.some(item=>item.receipt_id===receipt))throw new Error('Refresh this appointment’s card payments first.');const section=chartSection;await selectPatient(state.patient,typeof activeVisit!=='undefined'?activeVisit?.id:null);if(!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;showChartSection(section);showCopayReceipt(receipt);});return;}
 if(button.dataset.refreshHostedCopayList){event.preventDefault();run(async()=>{const view=hostedCopayView(),state=await loadHostedCopays(button.dataset.refreshHostedCopayList,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view)||!state.items.some(item=>item.receipt_id))return;const section=chartSection;await selectPatient(state.patient,typeof activeVisit!=='undefined'?activeVisit?.id:null);if(currentHostedCopayState(state)&&currentHostedCopayView(view,false))showChartSection(section);});}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='hosted-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 if(data.reviewed!=='on')throw new Error('Review the copay amount before opening card checkout.');
 const body={request_id:form.dataset.request,amount_cents:cents(data.amount),coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Reviewed appointment copay before hosted card collection'};
 await createHostedCopay(state,body);
 });
});

async function createHostedCopay(state,body){
 if(!currentHostedCopayState(state))return;
 const view=hostedCopayView();
 let response;try{response=await api(hostedCopayBase(state),'POST',body);}catch(error){state.uncertain=true;state.retry=body;paintHostedCopayState(state);if(!currentHostedCopayView(view))return;throw error;}
 if(!currentHostedCopayState(state))return;acceptHostedCopayOperation(state,response.operation);
 if(!currentHostedCopayView(view))return;
 openBillingEditor('');
 $('insurance-hosted-copay')?.scrollIntoView({block:'center'});
 notice(response.operation.status==='open'?'Secure checkout is ready. Open the card checkout link, then refresh payment status.':response.operation.receipt_id?'Payment evidence is available. Review its receipt and current status.':'The payment request is being reconciled. Refresh its status before collecting again.');
}
