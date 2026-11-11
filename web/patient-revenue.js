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
function availableCopayCreditForAccount(account){const visit=(workspace.visits||[]).find(v=>v.id===account.content.visit_id);return (workspace.billing?.copays||[]).filter(r=>r.appointment_id===visit?.appointment_id&&!r.voided&&!r.reversed_cents).reduce((sum,r)=>sum+Math.max(0,r.amount_cents-Number(r.allocated_cents||0)),0);}
function appointmentCopays(appointment=revenueAppointment()){return (workspace.billing?.copays||[]).filter(r=>r.appointment_id===appointment?.id);}
function copayReceiptMarkup(receipts){
 return receipts.map(r=>{const reversed=Number(r.reversed_cents||0),allocated=Number(r.allocated_cents||0),unapplied=Math.max(0,r.amount_cents-allocated),status=r.voided?'Voided receipt':reversed?'Corrected on ledger':unapplied?'Recorded · awaiting charge allocation':'Applied to encounter charges';return `<div class="timeline-row"><div><b>${money(r.amount_cents)} · ${esc(status)}</b><small>${esc(human(r.method))} · ${esc(r.occurred_on)}${r.reference?' · '+esc(r.reference):''}</small>${!r.voided&&!reversed&&unapplied?`<small>${money(unapplied)} unapplied credit</small>`:''}${reversed?`<small>${money(reversed)} reversed. Review the account ledger before recording any replacement receipt.</small>`:''}</div><div class="actions"><button type="button" data-copay-receipt="${esc(r.id)}">View / print receipt</button>${(r.account_ids||[]).map(id=>`<button type="button" data-copay-account="${esc(id)}">Review ledger</button>`).join('')}${billingCan()&&!r.voided&&!allocated?`<button type="button" data-copay-void="${esc(r.id)}">Correct receipt</button>`:''}</div></div>`;}).join('')||'<p class="muted">No copay receipt recorded for this appointment.</p>';
}
function copayReceiptDocument(receipt,context){
 const patient=context.patient,appointment=context.appointment,corrected=Number(receipt.reversed_cents||0)>0;
 const status=receipt.voided?'Voided receipt':corrected?'Receipt with corrected allocation':'Copay receipt';
 const allocation=receipt.voided?'<p>This receipt record was voided and is retained for history. Voiding the record does not issue a refund.</p>':corrected?'<p>A charge allocation was reversed after this payment was recorded. Contact the practice to confirm its current disposition. A ledger reversal does not establish that a refund was issued.</p>':`<dt>Applied to encounter charges</dt><dd>${money(Number(receipt.allocated_cents||0))}</dd><dt>Remaining unapplied credit</dt><dd>${money(Math.max(0,receipt.amount_cents-Number(receipt.allocated_cents||0)))}</dd>`;
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'"><title>Copay receipt</title><link rel="stylesheet" href="/patient-print.css"></head><body class="patient-receipt"><p><b>${esc(context.practiceName||'')}</b></p><h1>${esc(status)}</h1><p>${esc(patient.given_name)} ${esc(patient.family_name)}${patient.mrn?`<small>MRN ${esc(patient.mrn)}</small>`:''}</p><small>Receipt ${esc(receipt.id)}<br>Payment received ${esc(receipt.occurred_on)}${receipt.created_at?'<br>Recorded '+esc(date(receipt.created_at)):''}</small><p>${appointment?`Appointment: ${esc(appointment.title||'Office visit')}<br>${esc(date(appointment.starts_at))}`:`Appointment reference: <span class="reference">${esc(receipt.appointment_id)}</span>`}</p><dl><dt>${receipt.voided?'Original recorded amount':'Amount received'}</dt><dd><b>${money(receipt.amount_cents)}</b></dd><dt>Payment method</dt><dd>${esc(invoicePaymentMethod(receipt.method))}</dd>${receipt.reference?`<dt>Receipt / check reference</dt><dd class="reference">${esc(receipt.reference)}</dd>`:''}${!receipt.voided&&!corrected?allocation:''}</dl>${receipt.voided||corrected?allocation:''}<footer><p>This is a copy of the practice’s recorded payment receipt. It is not an invoice and does not determine final insurance or patient responsibility.</p><small>Copy prepared ${esc(date(context.printedAt))}. Patient and appointment details reflect the chart when this copy was prepared.</small></footer></body></html>`;
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
 const checkedDate=check.request_snapshot?.service_date;
 const status={completed:'Payer response received',pending:'Eligibility request pending',failed:'Eligibility request failed'}[check.status]||human(check.status);
 return `<div class="section-head"><div><b>${esc(status)}</b><small>Requested ${esc(date(check.created_at))}${checkedDate?' · Service '+esc(checkedDate):''}</small></div><button type="button" data-eligibility-report="${esc(coverageId)}">View eligibility report</button></div>${checkedDate&&checkedDate!==serviceDate?`<p class="eligibility-caution">This check is for ${esc(checkedDate)}; the selected visit is ${esc(serviceDate)}.</p>`:''}<p class="muted">${check.status==='completed'?'Review the returned benefits, network and service limits. A response does not guarantee coverage or payment.':'No completed benefit response from this request. Do not assume the patient is uninsured.'}</p>`;
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
function encounterPaymentTotals(account){
 const entries=(workspace.billing?.entries||[]).filter(e=>e.account_id===account.id),byId=new Map(entries.map(e=>[e.id,e]));
 const totals={patient:0,insurer:0,balance:account.total_cents,testActivity:entries.some(e=>e.content?.test_mode)};
 for(const entry of entries){totals.balance+=Number(entry.effect_cents);let source=entry;const seen=new Set();while(source.reverses_id&&byId.has(source.reverses_id)&&!seen.has(source.id)){seen.add(source.id);source=byId.get(source.reverses_id);}if((source.kind==='payment'||source.kind==='adjustment_debit'&&source.content?.managed_payment_id)&&['patient','insurer'].includes(source.content?.party))totals[source.content.party]-=Number(entry.effect_cents);}
 return totals;
}
function encounterRevenueStatusMarkup(account,data={}){
 if(!account)return '<p class="muted">Add procedures and charges for this encounter to begin the billing workflow.</p>';
 const totals=encounterPaymentTotals(account),claims=data.claims||[],claim=claims.find(c=>c.status!=='void')||claims[0],history=data.history,head=history?.active_head;
 const currentRemittance=head?(history.items||[]).find(row=>row.remittance_id===head.remittance_id&&row.row_index===head.row_index):null;
 const isPosted=account.status==='posted',claimState={draft:'Draft — review before submission',ready:'Ready for submission review',submitted:'Submitted — awaiting payer response',accepted:'Accepted — awaiting adjudication',rejected:'Rejected — correction needed',adjudicated:'Adjudicated — review remittance',void:'Voided claim'};
 let action='',next='';
 if(!isPosted){next=activeVisit?.status==='signed'?'Review and post charges to apply recorded copays.':'Finish and sign this encounter before posting charges.';action=activeVisit?.status==='signed'?`<button type="button" data-revenue-account="${esc(account.id)}">Review charges for posting</button>`:'<button type="button" data-revenue-documentation>Continue encounter documentation</button>';}
 else if(data.error){next='Claim status could not be loaded. Refresh before preparing another claim.';}
 else if(data.restricted){next='Claim review requires access to insurance claims.';}
 else if(!data.loaded){next='Loading this encounter’s claim and remittance evidence…';}
 else if(claim){next=claimState[claim.status]||human(claim.status);action=`<button type="button" data-revenue-claim="${esc(claim.id)}">${claim.status==='draft'?'Review claim':claim.status==='ready'?'Review submission':claim.status==='rejected'?'Review and correct claim':'Review claim status'}</button>`;}
 else if(String(account.coverage_snapshot?.payer?.content?.payer_code||'').trim()){next='Charges are posted. Prepare the insurance claim for review.';action=billingCan('create')?`<button type="button" data-new-claim="${esc(account.id)}">Prepare insurance claim</button>`:'';}
 else{next='Review insurance and patient responsibility before invoicing.';action='<button type="button" data-chart-section="insurance">Review insurance</button>';}
 const remit=currentRemittance?`<b>${currentRemittance.claim?.status==='22'?'Reversal posted':'Remittance posted'}</b><small>Trace ${esc(currentRemittance.trace)} · Payer-reported patient responsibility ${money(currentRemittance.claim?.patient_responsibility_cents||0)}</small><button type="button" data-revenue-remittance="${esc(currentRemittance.remittance_id)}">Review posted remittance</button>`:head?`<b>Remittance posting recorded</b><button type="button" data-revenue-remittance="${esc(head.remittance_id)}">Review remittance details</button>`:data.historyLoading?'<p class="muted">Loading posted remittance history…</p>':data.historyError?'<p>Posted remittance history could not be loaded.</p>':claim&&data.loaded?'<p class="muted">No active remittance posting for the current claim. Submission and acceptance do not mean payment was received.</p>':'<p class="muted">Insurance payments and adjustments appear after remittance review and posting.</p>';
 return `<section class="encounter-revenue-status"><div class="section-head"><h3>Encounter revenue status</h3>${isPosted?'<button type="button" data-refresh-revenue>Refresh status</button>':''}</div><div class="revenue-metrics"><div><span>Gross charges</span><strong>${money(account.total_cents)}</strong></div><div><span>Posted patient payments</span><strong>${isPosted?money(totals.patient):'Not posted'}</strong></div><div><span>Posted insurance payments</span><strong>${isPosted?money(totals.insurer):'Not posted'}</strong></div><div><span>Open account balance</span><strong>${isPosted?money(totals.balance):'Not posted'}</strong></div></div>${totals.testActivity?'<p class="mapping-notice">These totals include test processor activity. Test entries do not establish that real funds were received.</p>':''}<p class="muted">The open balance combines patient and insurance amounts and includes all posted adjustments. Review the patient’s share before invoicing.</p><div class="revenue-next-stage"><div><span class="eyebrow">Next step</span><p>${esc(next)}</p>${claim?`<small>${esc(claim.control_number)} · ${esc(human(claim.frequency))} · ${esc(date(claim.created_at))}${claims.length>1?' · '+claims.length+' claims for this account':''}</small>`:''}</div><div class="actions">${action}${isPosted&&billingCan('create')?`<button type="button" data-revenue-invoice="${esc(account.id)}">Review patient invoice</button>`:''}${isPosted?`<button type="button" data-revenue-invoices="${esc(account.id)}">Saved invoices</button>`:''}</div></div>${isPosted?`<div class="revenue-remittance">${remit}</div>`:''}</section>`;
}
async function loadEncounterRevenueStatus(account,force=false){
 if(!account)return;
 let state=encounterRevenueState;
 if(state.patient!==selected||state.identity!==me||state.account!==account.id||state.version!==account.version){state={patient:selected,identity:me,account:account.id,version:account.version,pending:null,data:null,loadedAt:0};encounterRevenueState=state;}
 const current=()=>encounterRevenueState===state&&selected===state.patient&&me===state.identity&&encounterChargeAccount()?.id===state.account;
 const render=()=>{const node=$('encounter-revenue-status');if(current()&&node)node.innerHTML=encounterRevenueStatusMarkup(account,state.data||{});};
 if(account.status!=='posted'){render();return;}
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims','view')){state.data={restricted:true};render();return;}
 if(state.pending){render();return state.pending;}
 if(state.data&&!force&&Date.now()-state.loadedAt<15000){render();return;}
 state.data=null;render();
 state.pending=(async()=>{try{const claims=[];let after=null;do{const page=await api(`/api/v1/billing/claims?patient_id=${encodeURIComponent(state.patient)}&account_id=${encodeURIComponent(account.id)}${after?'&after='+encodeURIComponent(after):''}`);if(!current())return;claims.push(...(page.items||[]));after=page.next_cursor;}while(after);claims.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));const claim=claims.find(c=>c.status!=='void')||claims[0];state.data={claims,loaded:true,historyLoading:!!claim};if(claim){try{state.data.history=await api(`/api/v1/billing/claims/${claim.id}/era-history`);}catch{state.data.historyError=true;}finally{state.data.historyLoading=false;}}state.loadedAt=Date.now();}catch{state.data={error:true};}finally{state.pending=null;render();}})();
 return state.pending;
}
function renderPatientInsurance(){
 if(!workspace.billing)return;
 let host=$('insurance-workspace');if(!host){host=document.createElement('section');host.id='insurance-workspace';host.className='panel';$('chart').insertBefore(host,$('appointments-panel'));}
 const appointment=revenueAppointment(),serviceDate=revenueServiceDate(),primary=revenueCoverage(serviceDate),coverages=workspace.billing.coverages||[];
 const key=JSON.stringify([selected,appointment?.id,serviceDate,coverages.map(c=>[c.id,c.version]),workspace.billing.copays]);if(host.dataset.insuranceKey===key){for(const coverage of coverages)loadInsuranceEligibility(coverage.id);return;}host.dataset.insuranceKey=key;
 host.innerHTML=`<div class="section-head"><div><h2>Insurance & copay</h2><p class="muted">Review coverage and benefits for ${esc(serviceDate)} before the visit.</p></div><div class="actions"><button type="button" data-chart-section="documents">Insurance documents</button>${billingCan('create')?'<button type="button" data-new-coverage>+ Insurance coverage</button>':''}</div></div><section class="insurance-summary"><div><h3>${primary?esc(payerName(primary.content.payer_id)):'No active primary coverage for this service date'}</h3><p>${primary?`${esc(primary.content.plan_name||'Plan name not recorded')} · Member ${esc(primary.content.member_id)}`:'Add or review coverage before checking benefits. This does not establish that the patient is uninsured.'}</p></div><div><span class="muted">Recorded plan copay</span><strong>${primary?.content.copay_cents!=null?money(primary.content.copay_cents):'Not recorded'}</strong><small>Confirm the benefit for this visit; eligibility does not guarantee payment.</small></div></section><div class="insurance-coverage-list">${coverages.map(c=>`<article class="insurance-coverage-card"><div class="section-head"><div><h3>${esc(payerName(c.content.payer_id))}</h3><p>${esc(human(c.content.priority))} · ${esc(c.content.plan_name||'Plan name not recorded')}</p></div><span class="pill">${esc(human(c.content.status))}</span></div><dl class="billing-dl"><dt>Member / policy</dt><dd>${esc(c.content.member_id)}</dd><dt>Group</dt><dd>${esc(c.content.group_number||'Not recorded')}</dd><dt>Covered dates</dt><dd>${esc(c.content.effective_date)} – ${esc(c.content.end_date||'Open-ended')}</dd><dt>Recorded copay</dt><dd>${c.content.copay_cents==null?'Not recorded':money(c.content.copay_cents)}</dd></dl><div class="insurance-eligibility-summary" id="insurance-eligibility-${esc(c.id)}"></div><div class="actions">${typeof claimmdEligibilityButton==='function'?claimmdEligibilityButton(c):''}<button type="button" data-coverage-open="${esc(c.id)}">Coverage details</button>${billingCan()?`<button type="button" data-edit-coverage="${esc(c.id)}">Edit coverage</button>`:''}</div></article>`).join('')}</div><section class="billing-section">${(workspace.appointments||[]).length>1?`<label>Appointment for insurance review<select id="insurance-appointment">${workspace.appointments.filter(a=>!['cancelled','canceled','no_show'].includes(a.status)).map(a=>`<option value="${esc(a.id)}" ${appointment?.id===a.id?'selected':''}>${esc(a.title||'Visit')} · ${esc(date(a.starts_at))} · ${esc(human(a.status))}</option>`).join('')}</select></label>`:''}<div class="section-head"><div><h3>Appointment copay</h3><p class="muted">${appointment?esc(appointment.title||'Visit')+' · '+esc(date(appointment.starts_at)):'Select or book an appointment to record its copay.'}</p></div>${billingCan('create')&&appointment?`<button type="button" class="primary" data-record-copay="${esc(appointment.id)}">Record received copay</button>`:''}</div>${copayReceiptMarkup(appointmentCopays(appointment))}<p class="muted">Record cash, check or a payment already collected externally. This records its receipt; live card capture is not enabled in this EHR.</p></section><div id="insurance-editor"></div>`;
 for(const coverage of coverages)loadInsuranceEligibility(coverage.id);
 host.hidden=typeof chartSection!=='undefined'&&chartSection!=='insurance';
}
function renderEncounterRevenue(){
 const host=$('encounter-revenue');if(!host)return;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,account=encounterChargeAccount(),appointment=(workspace.appointments||[]).find(a=>a.id===visit?.appointment_id),serviceDate=revenueServiceDate(appointment),coverage=revenueCoverage(serviceDate);
 if(!visit){host.innerHTML='<p>Select an encounter to record its procedures and charges.</p>';return;}
 const key=JSON.stringify([selected,visit.id,visit.version,appointment?.id,account?.id,account?.version,coverage?.id,coverage?.version,workspace.billing?.copays]);if(host.dataset.revenueKey===key){if(account&&chartSection==='visits'&&!$('encounter-billing-detail')?.innerHTML)showBillingAccount(account.id,false);loadEncounterRevenueStatus(account);if(typeof resumeEncounterChargeDraft==='function')resumeEncounterChargeDraft();return;}if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();host.dataset.revenueKey=key;
 host.innerHTML=`<div class="section-head"><div><h2>Procedures, charges & copay</h2><p class="muted">${esc(serviceDate)} · ${account?esc(human(account.status))+' encounter charges':'No charges recorded for this encounter'}</p></div>${billingCan('create')&&(!account||account.status==='draft')?`<button type="button" class="primary" data-encounter-charges>${account?'Edit CPT / HCPCS charges':'Add CPT / HCPCS charges'}</button>`:''}</div><div class="encounter-revenue-summary"><span>Insurance <b>${coverage?esc(payerName(coverage.content.payer_id)):'Review coverage'}</b></span><span>Recorded plan copay <b>${coverage?.content.copay_cents==null?'Not recorded':money(coverage.content.copay_cents)}</b></span><button type="button" data-chart-section="insurance">Review insurance & benefits</button>${billingCan('create')&&appointment?`<button type="button" data-record-copay="${esc(appointment.id)}">Record received copay</button>`:''}</div>${copayReceiptMarkup(appointmentCopays(appointment))}<p class="muted">Record procedures and link this encounter’s ICD diagnoses. After signing, post charges to apply recorded copays, prepare the patient invoice and review the insurance claim.</p><div id="encounter-revenue-status">${encounterRevenueStatusMarkup(account)}</div><details class="encounter-account-record" ${account?.status==='draft'?'open':''}><summary>Charge details & ledger</summary><div id="encounter-billing-detail"></div></details><div id="encounter-billing-editor"></div>`;
 if(account&&typeof chartSection!=='undefined'&&chartSection==='visits')showBillingAccount(account.id,false);
 loadEncounterRevenueStatus(account);
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
 showChartSection('insurance');
 const appointment=revenueAppointment();if(!appointment){notice('Book or select an appointment before recording its copay.',true);return;}
 const coverage=revenueCoverage(revenueServiceDate(appointment)),amount=coverage?.content.copay_cents;
 openBillingEditor(`<form id="copay-receipt-form" data-request="${crypto.randomUUID()}" data-appointment="${esc(appointment.id)}" data-coverage="${esc(coverage?.id||'')}"><h3>Record received copay</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p class="muted">${amount!=null?'Recorded plan copay: '+money(amount)+'. Confirm the amount received for this visit.':'Confirm the patient’s responsibility and the amount already received.'} Charges can be prepared later; the receipt remains linked to this appointment.</p><div class="form-grid"><label>Amount received (USD)<input name="amount" inputmode="decimal" required value="${amount==null?'':esc(dollars(amount))}"></label><label>Received by<select name="method"><option value="cash">Cash</option><option value="check">Check</option><option value="external">External payment receipt</option></select></label><label>Receipt / check reference<input name="reference" maxlength="200"></label><label>Receipt date<input name="occurred_on" type="date" required value="${esc(revenueServiceDate(null))}"></label></div><label>Receipt evidence / reason<input name="reason" required maxlength="1000" placeholder="Reviewed copay and payment receipt"></label><label class="review-ack"><input type="checkbox" name="received_confirmed" required> I confirm this payment has already been received. No card or bank transaction will be initiated.</label><button type="submit" class="primary">Save copay receipt</button></form>`);
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.eligibilityReport){event.preventDefault();run(async()=>{const patient=selected,identity=me,coverage=workspace.billing.coverages.find(c=>c.id===button.dataset.eligibilityReport);if(!coverage)throw new Error('Coverage is no longer available.');await loadInsuranceEligibility(coverage.id);if(selected!==patient||me!==identity)return;const entry=eligibilityState().items.get(coverage.id);await openClaimmdEligibility(coverage,{readOnly:true,history:entry?.history,serviceDate:revenueServiceDate()});});return;}
 if(button.dataset.refreshEligibility){event.preventDefault();loadInsuranceEligibility(button.dataset.refreshEligibility,true);return;}
 if(button.hasAttribute('data-refresh-revenue')){event.preventDefault();loadEncounterRevenueStatus(encounterChargeAccount(),true);return;}
 if(button.hasAttribute('data-revenue-documentation')){event.preventDefault();setEncounterSection('documentation');return;}
 if(button.dataset.revenueAccount){event.preventDefault();showBillingAccount(button.dataset.revenueAccount,false);$('encounter-billing-detail')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
 if(button.dataset.revenueClaim||button.dataset.revenueRemittance){event.preventDefault();run(async()=>{await showClaimsWorkspace();if(button.dataset.revenueClaim)await showClaim(button.dataset.revenueClaim);else await showEra(button.dataset.revenueRemittance);});return;}
 if(button.dataset.revenueInvoice||button.dataset.revenueInvoices){event.preventDefault();billingSelected=button.dataset.revenueInvoice||button.dataset.revenueInvoices;run(async()=>{if(button.dataset.revenueInvoice)patientInvoiceEditor();else await showPatientInvoices();});return;}
 if(button.dataset.copayReceipt){event.preventDefault();run(async()=>showCopayReceipt(button.dataset.copayReceipt));return;}
 if(button.hasAttribute('data-print-copay')){event.preventDefault();$('copay-receipt-frame').contentWindow.focus();$('copay-receipt-frame').contentWindow.print();return;}
 if(button.dataset.copayAccount){event.preventDefault();showBillingAccount(button.dataset.copayAccount);return;}
 if(button.hasAttribute('data-record-copay')){event.preventDefault();openCopayReceiptEditor(button.dataset.recordCopay);return;}
 if(button.hasAttribute('data-encounter-charges')){event.preventDefault();openEncounterCharges();return;}
 if(button.dataset.copayVoid){event.preventDefault();openBillingEditor(`<form id="copay-void-form" data-receipt="${esc(button.dataset.copayVoid)}"><h3>Correct an unapplied receipt</h3><p>This voids the recorded receipt. It does not refund cash, a check or an external card payment.</p><label>Correction reason<input name="reason" required maxlength="1000"></label><button type="submit">Void recorded receipt</button></form>`);return;}
 if(button.hasAttribute('data-apply-copays')){event.preventDefault();run(async()=>{const account=workspace.billing.accounts.find(a=>a.id===billingSelected);const result=await api(`${billingBase()}/${account.id}/copays/apply`,'POST',{},account.version);const section=chartSection;await selectPatient(selected,activeVisit?.id);showChartSection(section);if(section==='visits'&&typeof setEncounterSection==='function')setEncounterSection('charges');notice(`${money(result.applied_cents)} of recorded copay credit applied.`);});}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(!['copay-receipt-form','copay-void-form'].includes(form.id))return;event.preventDefault();
 run(async()=>{const data=Object.fromEntries(new FormData(form)),patient=selected,visit=typeof activeVisit!=='undefined'?activeVisit?.id:null;
 if(form.id==='copay-receipt-form')await api(`/api/v1/patients/${patient}/billing/copays`,'POST',{request_id:form.dataset.request,appointment_id:form.dataset.appointment,coverage_id:form.dataset.coverage||null,amount_cents:cents(data.amount),method:data.method,reference:data.reference,occurred_on:data.occurred_on,reason:data.reason,received_confirmed:data.received_confirmed==='on'});
 else await api(`/api/v1/patients/${patient}/billing/copays/${form.dataset.receipt}/void`,'POST',{reason:data.reason});
 await selectPatient(patient,visit);showChartSection('insurance');notice(form.id==='copay-receipt-form'?'Copay receipt recorded for the appointment.':'Receipt voided; the original evidence is retained.');});
});

document.addEventListener('change',event=>{if(event.target.id!=='insurance-appointment')return;insuranceAppointmentSelection.set(selected,event.target.value);renderPatientInsurance();});
