// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const insuranceAppointmentSelection=new Map();
// The appointment whose copay the schedule asked for, per patient, used while no encounter is open.
const copayAppointmentSelection=new Map();
function remittancePatientResponsibility(row){
 const explicit=(row?.adjustments||[]).some(adjustment=>adjustment.group==='PR')||row?.patient_responsibility_cents>0;
 return explicit?`Payer-reported patient responsibility ${money(row.patient_responsibility_cents||0)}`:'Patient responsibility not specified in PR evidence; review the response';
}
function revenueAppointment(){
 const selectedAppointment=typeof chartSection!=='undefined'&&chartSection==='insurance'?insuranceAppointmentSelection.get(selected):null;
 if(selectedAppointment){const appointment=(workspace.appointments||[]).find(a=>a.id===selectedAppointment);if(appointment)return appointment;}
 if(typeof activeVisit!=='undefined'&&activeVisit)return workspace.appointments.find(a=>a.id===activeVisit.appointment_id);
 const open=(workspace.appointments||[]).filter(a=>['checked_in','in_progress','booked'].includes(a.status)),asked=copayAppointmentSelection.get(selected);
 return open.find(a=>a.id===asked)||open[0];
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
// The diagnoses editor's stable home on the one-page visit: the first child of #encounter-revenue,
// above the part of the block this file rewrites. Its markup is never thrown away by a charge
// re-render, so the ICD list always reads above the CPT lines and survives every post and close.
// The note gives up its own #visit-diagnoses while billing is on screen (visitNoteOwnsDiagnoses),
// so this host holds the one editor the encounter has.
const ENCOUNTER_DIAGNOSES_ID='encounter-diagnoses';
function encounterDiagnosesHost(){
 const block=$('encounter-revenue');if(!block)return null;
 // The host is the element kept across renders, not whatever answers to the id: it lives outside the
 // markup the block rewrites, so an id lookup finds it only where it already sits, or a stale copy
 // of a page that was thrown away. A page whose block cannot take children has nowhere to keep the
 // editor, so it gets no host: the diagnoses stay where that page already shows them rather than
 // half-appearing in markup the next re-render replaces.
 let host=$(ENCOUNTER_DIAGNOSES_ID);
 if(host&&host.parentElement!==block)host=null;
 if(!host&&typeof block.insertBefore==='function'){
  host=document.createElement('section');
  host.id=ENCOUNTER_DIAGNOSES_ID;
  host.className='billing-section encounter-diagnoses';
  const only=(block.children||[]).length===1?String(block.children[0].textContent||''):'';
  if((block.children||[]).length<=1&&(!only.trim()||/^Select an encounter/.test(only)))block.replaceChildren();
  block.insertBefore(host,block.firstChild||null);
 }
 return host;
}
// What an empty host is filled with: a placeholder until the encounter's diagnoses load.
function encounterDiagnosesPlaceholderMarkup(){return '<div id="visit-diagnoses"><p class="muted">Loading…</p></div>';}
function renderEncounterDiagnoses(){
 const host=encounterDiagnosesHost();if(!host)return;
 if(!host.firstElementChild)host.innerHTML=encounterDiagnosesPlaceholderMarkup();
 if(typeof renderVisitDiagnoses==='function')void renderVisitDiagnoses();
}
function copayUnapplied(receipt){return Math.max(0,receipt.amount_cents-Number(receipt.allocated_cents||0)-Number(receipt.hosted_checkout?.refunded_unapplied_cents||0));}
function availableCopayCreditForAccount(account){const visit=(workspace.visits||[]).find(v=>v.id===account.content.visit_id);return (typeof copaysForAppointment==='function'?copaysForAppointment(visit?.appointment_id):(workspace.billing?.copays||[])).filter(r=>r.appointment_id===visit?.appointment_id&&!r.voided&&!r.reversed_cents&&r.hosted_checkout?.status!=='needs_review').reduce((sum,r)=>sum+copayUnapplied(r),0);}
function appointmentCopays(appointment=revenueAppointment()){return (typeof copaysForAppointment==='function'?copaysForAppointment(appointment?.id):(workspace.billing?.copays||[])).filter(r=>r.appointment_id===appointment?.id);}
function copayReceiptMarkup(receipts,options={}){
 return receipts.map(r=>{const hosted=r.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),reversed=Number(r.reversed_cents||0),allocated=Number(r.allocated_cents||0),unapplied=copayUnapplied(r),held=hosted?.status==='needs_review',status=r.voided?'Voided receipt':held?'Card payment requires reconciliation':refunded===r.amount_cents?'Card payment refunded':refunded?'Card payment partially refunded':reversed?'Corrected on ledger':unapplied?(hosted?'Card payment captured · not yet applied to charges':'Recorded · not yet applied to charges'):(hosted?'Card payment captured · applied to visit charges':'Applied to visit charges');return `<div class="timeline-row"><div><b>${hosted?.livemode===false&&!options.modeShown?testPaymentTag(' · '):hosted?.livemode===true&&options.modeShown?'LIVE · ':''}${money(r.amount_cents)} · ${esc(status)}</b><small>${hosted?'Card · Confirmed':esc(human(r.method))} · ${esc(r.occurred_on)}${r.reference&&!/^(ch|pi|py|txn|cs|in|re|pyr)_[A-Za-z0-9]{8,}$/.test(String(r.reference))?' · '+esc(r.reference):''}</small>${refunded?`<small>Verified refunds ${money(refunded)} · Net received ${money(r.amount_cents-refunded)}</small>`:''}${!r.voided&&!reversed&&!held&&unapplied?`<small>${money(unapplied)} credit not yet applied</small>`:''}${reversed?`<small>${money(reversed)} reversed. Review the account ledger before recording any replacement receipt.</small>`:''}</div><div class="actions"><button type="button" ${options.primary?'class="primary"':''} data-copay-receipt="${esc(r.id)}" data-appointment="${esc(r.appointment_id)}">View / print receipt</button>${(options.encounter?[]:r.account_ids||[]).map(id=>`<button type="button" data-copay-account="${esc(id)}">Review ledger</button>`).join('')}${billingCan()&&!hosted&&!r.voided&&!allocated?`<button type="button" data-copay-void="${esc(r.id)}">Correct receipt</button>`:''}</div></div>`;}).join('')||'<p class="muted">No copay receipt recorded for this appointment.</p>';
}
// One payment taken in parts prints as one receipt: each tender, the total and what is still owed.
function paymentTenderLines(receipts){
 return (receipts||[]).filter(r=>!r.voided).map(r=>{
  const net=Number(r.amount_cents||0)-Number(r.hosted_checkout?.refunded_cents||0),hosted=r.hosted_checkout||r.method==='card';
  const brand=String(r.card_brand||r.hosted_checkout?.card_brand||'').trim(),last4=String(r.card_last4||r.hosted_checkout?.card_last4||'').trim();
  let label;
  if(hosted)label=brand&&last4?`${brand.charAt(0).toUpperCase()+brand.slice(1)} ending ${last4}`:'Card';
  else if(r.method==='check')label=r.reference?`Check #${String(r.reference).replace(/^#/,'')}`:'Check';
  else if(r.method==='cash')label='Cash';
  else label=typeof invoicePaymentMethod==='function'?invoicePaymentMethod(r.method):human(r.method);
  return {label,amount:net,appointment:r.appointment_id,desk:!hosted&&(r.method==='cash'||r.method==='check')};
 });
}
function paymentGroupReceiptFacts(receipts,context){
 // Cash or one check recorded once for each encounter is still one tender on the receipt.
 const lines=[];for(const line of paymentTenderLines(receipts)){const same=line.desk&&lines.find(l=>l.desk&&l.label===line.label&&!l.appointments.includes(line.appointment));if(same){same.amount+=line.amount;same.appointments.push(line.appointment);}else lines.push({...line,appointments:[line.appointment]});}
 const total=lines.reduce((sum,line)=>sum+line.amount,0);
 // When the payment covers more than one encounter, the receipt says how much went to each.
 const shares=new Map();for(const r of (receipts||[]).filter(r=>!r.voided)){const parts=Array.isArray(r.hosted_checkout?.splits)?r.hosted_checkout.splits.map(p=>[p.appointment_id,Number(p.amount_cents||0)-Number(p.refunded_cents||0)]):[[r.appointment_id,Number(r.amount_cents||0)-Number(r.hosted_checkout?.refunded_cents||0)]];for(const [id,amount] of parts)shares.set(id,(shares.get(id)||0)+amount);}
 const encounters=shares.size>1?[...shares].map(([id,amount])=>({label:typeof collectEncounterLabel==='function'?collectEncounterLabel(id):'Encounter',amount})):[];
 const dates=(receipts||[]).map(r=>r.occurred_on).filter(Boolean).sort(),when=dates.length?dates[dates.length-1]:'';
 const appointmentId=receipts?.[0]?.appointment_id,number=context?.encounterNumber||(typeof encounterNumberForAppointment==='function'?encounterNumberForAppointment(appointmentId):'');
 return {lines,total,when,number,balance:context?.balanceCents,encounters};
}
function paymentGroupTenderRows(facts){
 return facts.lines.map(line=>`<div><dt>${esc(line.label)}</dt><dd>${money(line.amount)}</dd></div>`).join('')+(facts.encounters||[]).map(e=>`<div><dt>Paid toward ${esc(e.label)}</dt><dd>${money(e.amount)}</dd></div>`).join('');
}
// A receipt reads like a visit receipt: diagnoses (ICD-10), then the procedures and their charges,
// then how the patient paid. Both come from the encounter the payment belongs to: its diagnoses
// list and the charge lines on its billing account. Loaded just before printing; a failed read
// prints a plain note in that section instead of an empty table.
async function visitReceiptEvidence(appointmentId){
 const visit=(typeof workspace!=='undefined'&&workspace?.visits||[]).find(v=>v.appointment_id===appointmentId)||null;
 if(!visit)return null;
 const account=(workspace?.billing?.accounts||[]).filter(a=>a.status!=='void'&&a.content?.visit_id===visit.id).pop()||null;
 let diagnoses=null;
 try{const data=await (typeof visitDiagnosisLoad==='function'?visitDiagnosisLoad(visit.id):api(`/api/v1/visits/${encodeURIComponent(visit.id)}/diagnoses`));diagnoses=(data?.diagnoses||[]).filter(d=>d&&String(d.code||'').trim()).sort((a,b)=>(a.rank??99)-(b.rank??99));}catch{}
 return {visit,account,diagnoses,lines:Array.isArray(account?.content?.lines)?account.content.lines:[]};
}
function visitReceiptServiceDate(evidence){return evidence?.account?.content?.service_date||'';}
function visitReceiptSections(evidence){
 if(!evidence)return '';
 const day=visitReceiptServiceDate(evidence),list=evidence.diagnoses;
 const diagnoses=`<h2>Diagnoses</h2>${list===null?'<p>Diagnoses could not be loaded. Ask the practice for an updated copy.</p>':list.length?`<table><thead><tr><th>ICD-10</th><th>Description</th></tr></thead><tbody>${list.map(d=>`<tr><td><b>${esc(String(d.code).trim())}</b></td><td>${esc(d.display||'')}</td></tr>`).join('')}</tbody></table>`:'<p>No diagnoses recorded.</p>'}`;
 const lines=evidence.lines,total=lines.reduce((sum,l)=>sum+Number(l.amount_cents||0),0);
 const rows=lines.map(l=>{const from=l.service_from||day,to=l.service_to&&l.service_to!==from?' – '+l.service_to:'';return `<tr><td>${esc(from+to)}</td><td><b>${esc(l.code)}</b></td><td>${esc(String(l.modifiers||'').trim())}</td><td>${esc(l.description||'')}</td><td class="amount">${esc(String(l.units??''))}</td><td class="amount">${money(Number(l.amount_cents||0))}</td></tr>`;}).join('');
 const procedures=`<h2>Procedures</h2>${lines.length?`<table><thead><tr><th>Date</th><th>Code</th><th>Modifiers</th><th>Description</th><th class="amount">Units</th><th class="amount">Charge</th></tr></thead><tbody>${rows}</tbody></table><dl><dt>Total charges</dt><dd>${money(total)}</dd></dl>`:'<p>No charges posted yet.</p>'}`;
 const coverage=evidence.account?.coverage_id||evidence.account?.content?.coverage_id;
 const plan=coverage?(workspace?.billing?.coverages||[]).find(c=>c.id===coverage)?.content?.plan_name:'';
 const insurance=coverage?`<h2>Insurance</h2><dl><dt>Billed to</dt><dd>${esc(plan||'Insurance on file')}</dd></dl>`:'';
 return diagnoses+procedures+insurance;
}
function visitReceiptVisitFacts(evidence,number){
 const day=visitReceiptServiceDate(evidence),provider=evidence?.account?.content?.claim_details?.rendering_provider_name||'';
 if(!number&&evidence?.visit&&typeof encounterNumberText==='function')number=encounterNumberText(evidence.visit);
 return `${number?'Encounter '+esc(number)+'<br>':''}${day?'Date of service '+esc(day)+'<br>':''}${provider?'Provider '+esc(provider)+'<br>':''}`;
}
function paymentGroupReceiptDocument(receipts,context){
 const facts=paymentGroupReceiptFacts(receipts,context),patient=context.patient,branding=patientPrintBranding(context.practiceName),title='Payment receipt';
 return `${patientPrintHead(title,branding)}<body class="patient-receipt">${patientPrintHeader(title,branding)}<section class="document-meta"><div><span class="document-label">Received from</span><p class="patient-print-name">${esc(patient.given_name)} ${esc(patient.family_name)}</p>${patient.mrn?`<small>MRN ${esc(patient.mrn)}</small>`:''}</div><div class="document-reference"><span class="document-label">Receipt details</span><small>${(n=>n?(n.startsWith('Payment ')?esc(n):'Receipt '+esc(n))+'<br>':'')(typeof receiptNumberFor!=='function'?'':receiptNumberFor(receipts[0]?.appointment_id,receipts[0]?.payment_group_id||receipts[0]?.id))}${visitReceiptVisitFacts(context.visitEvidence,facts.number)}Payment received ${esc(facts.when)}</small></div></section>${visitReceiptSections(context.visitEvidence)}<section class="document-total"><span>Total paid</span><strong>${money(facts.total)}</strong></section><h2>How it was paid</h2><dl>${facts.lines.map(line=>`<dt>${esc(line.label)}</dt><dd>${money(line.amount)}</dd>`).join('')}<dt>Total paid</dt><dd>${money(facts.total)}</dd>${Number.isSafeInteger(facts.balance)?`<dt>Patient balance after this payment</dt><dd>${money(Math.max(0,facts.balance))}</dd>`:''}</dl>${facts.encounters?.length?`<h2>What it paid for</h2><dl>${facts.encounters.map(e=>`<dt>${esc(e.label)}</dt><dd>${money(e.amount)}</dd>`).join('')}</dl>`:''}<footer><p>This is a copy of the practice’s recorded payment receipt. It is not an invoice and does not determine final insurance or patient responsibility.</p><small>Copy prepared ${esc(date(context.printedAt||new Date().toISOString()))}.</small>${patientPrintFooter()}</footer></body></html>`;
}
function paymentGroupReceiptCardMarkup(receipts,context){
 const facts=paymentGroupReceiptFacts(receipts,context),patient=context.patient,branding=patientPrintBranding(context.practiceName);
 return `<article class="copay-receipt-card" data-copay-receipt-view data-payment-group-receipt><header>${branding.logo?`<img src="${esc(branding.logo)}" alt="Current practice logo" referrerpolicy="no-referrer">`:''}<div><p>${esc(branding.name||'Practice payment record')}</p><h3 tabindex="-1">Payment receipt</h3></div><button type="button" data-print-copay-card>Print / save PDF</button></header><div class="copay-receipt-amount"><div><span>Total paid</span><strong>${money(facts.total)}</strong></div><span class="copay-receipt-status">Payment recorded</span></div><dl><div><dt>Patient</dt><dd>${esc(patient.given_name)} ${esc(patient.family_name)}</dd></div>${facts.number?`<div><dt>Encounter</dt><dd>${esc(facts.number)}</dd></div>`:''}<div><dt>Payment date</dt><dd>${esc(facts.when)}</dd></div>${paymentGroupTenderRows(facts)}${Number.isSafeInteger(facts.balance)?`<div><dt>Balance after payment</dt><dd>${money(Math.max(0,facts.balance))}</dd></div>`:''}</dl><footer><p>Recorded payment evidence, not an invoice or a determination of insurance responsibility.</p>${patientPrintFooter()}</footer></article>`;
}
// Receipts open in a preview window first, so staff see exactly what the patient gets (practice
// logo, codes, charges and payments), then press Print. Closing it returns to where they were.
// The address a receipt is emailed to starts as the patient's own, and staff can change it.
function receiptEmailMarkup(mail){
 if(!mail?.receipt?.id||typeof billingCan==='function'&&!billingCan('create'))return '';
 const onFile=workspace?.demographics?.content?.email||'';
 return `<form class="receipt-email" data-receipt-email><label>Email receipt to<input type="email" name="email" required maxlength="254" autocomplete="off" value="${esc(onFile)}" placeholder="name@example.com"></label><label class="review-ack"><input type="checkbox" name="include_services"> Include services and codes</label><p class="muted">Tick this when the patient asks for an itemised receipt. The email will list what was done at the encounter.</p><button type="submit">Email receipt</button><p class="muted" data-receipt-email-note>${onFile?'The patient’s email on file. Change it if they want it sent somewhere else.':'No email is on file for this patient. Type the address to send to.'} By default the email gives the amount, date and receipt number only.</p></form>`;
}
function receiptEmailNumber(receipt){
 const number=typeof receiptNumberFor==='function'?receiptNumberFor(receipt.appointment_id,receipt.payment_group_id||receipt.id):'';
 return /^[A-Za-z0-9-]{1,40}$/.test(number)?number:'R-'+String(receipt.id).replace(/-/g,'').slice(0,8).toUpperCase();
}
async function sendReceiptEmail(form,mail){
 const email=String(new FormData(form).get('email')||'').trim(),services=Boolean(form.querySelector('[name=include_services]')?.checked),key=email+'|'+(services?'services':'plain'),note=form.querySelector('[data-receipt-email-note]'),button=form.querySelector('button');
 // The same address pressed twice is the same request, so the patient gets one email.
 mail.requests??=new Map();if(!mail.requests.has(key))mail.requests.set(key,crypto.randomUUID());
 button.disabled=true;
 try{
  await api(`/api/v1/patients/${encodeURIComponent(mail.patient)}/billing/copays/${encodeURIComponent(mail.receipt.id)}/email`,'POST',{request_id:mail.requests.get(key),email,receipt_number:receiptEmailNumber(mail.receipt),...(services?{include_services:true}:{})});
  if(note){note.textContent=`Sent to ${email}.`;note.setAttribute('role','status');}
 }catch(error){if(note){note.textContent=error.message||'The receipt could not be emailed. Try again.';note.setAttribute('role','alert');}}
 finally{button.disabled=false;}
}
function openReceiptPreview(documentHtml,title,mail){
 const panel=document.createElement('div');panel.className='receipt-preview';
 panel.innerHTML=`<iframe class="receipt-preview-frame" title="${esc(title||'Payment receipt')}" sandbox="allow-same-origin allow-modals"></iframe>${receiptEmailMarkup(mail)}<div class="actions"><button type="button" class="primary" data-receipt-preview-print>Print</button><button type="button" data-sheet-close>Close</button></div>`;
 const frame=panel.querySelector('iframe');frame.srcdoc=documentHtml;
 panel.querySelector('[data-receipt-email]')?.addEventListener('submit',event=>{event.preventDefault();void sendReceiptEmail(event.target,mail);});
 const dialog=sheetOpen(title||'Payment receipt',panel);dialog.classList.add('sheet-wide','receipt-preview-sheet');
 panel.querySelector('[data-receipt-preview-print]').addEventListener('click',()=>{frame.contentWindow?.focus();frame.contentWindow?.print();});
 return dialog;
}
let paymentGroupOpening=0;
async function showPaymentGroupReceipt(group,appointmentId){
 const view=hostedCopayView(),opening=++paymentGroupOpening;
 if(!selected||!workspace.patient)throw new Error('This receipt is unavailable for the current patient. Refresh the payment list.');
 const data=await api(`/api/v1/patients/${encodeURIComponent(view.patient)}/billing/payment-groups/${encodeURIComponent(group)}`);
 const receipts=(data.receipts||[]).filter(r=>r.payment_group_id===group);
 if(opening!==paymentGroupOpening||!currentHostedCopayView(view)||!receipts.length)return;
 // The context (patient, practice) comes from the same receipt endpoint a single receipt uses.
 const first=await api(`/api/v1/billing/copay-receipts/${encodeURIComponent(receipts[0].id)}`);
 if(opening!==paymentGroupOpening||!currentHostedCopayView(view))return;
 const p=encounterRevenueState?.data?.summary?.patient||{},balance=Number.isSafeInteger(p.owes_now_cents)?p.owes_now_cents:undefined;
 const visitEvidence=await visitReceiptEvidence(appointmentId||receipts[0].appointment_id);
 if(opening!==paymentGroupOpening||!currentHostedCopayView(view))return;
 openReceiptPreview(paymentGroupReceiptDocument(receipts,{...first.context,balanceCents:balance,visitEvidence,printedAt:new Date().toISOString()}),undefined,{patient:view.patient,receipt:receipts[0]});
}
// 'Print receipt' inside the Collect payment window: load the same grouped receipt a moment after
// the payment lands and send it straight to the browser print dialog. The window stays open and the
// page does not move — no section switch, no scroll, nothing dropped into the encounter.
async function printPaymentGroupReceiptFromCollect(group,button){
 // run() already disables the pressed button while this loads, so a second press cannot start another.
 if(!group||!button||!collectDialog?.isConnected)return;
 const view=hostedCopayView();
 try{
  const data=await api(`/api/v1/patients/${encodeURIComponent(view.patient)}/billing/payment-groups/${encodeURIComponent(group)}`);
  const receipts=(data.receipts||[]).filter(r=>r.payment_group_id===group);
  if(!receipts.length)throw new Error('This receipt is unavailable for the current patient. Refresh the payment list.');
  // The context (patient, practice) comes from the same receipt endpoint a single receipt uses.
  const first=await api(`/api/v1/billing/copay-receipts/${encodeURIComponent(receipts[0].id)}`);
  const p=encounterRevenueState?.data?.summary?.patient||{},balance=Number.isSafeInteger(p.owes_now_cents)?p.owes_now_cents:undefined;
  const visitEvidence=await visitReceiptEvidence(receipts[0].appointment_id);
  const context={...first.context,balanceCents:balance,visitEvidence,printedAt:new Date().toISOString()};
  if(me!==view.identity||!collectDialog?.isConnected||!button.isConnected)return;
  button.closest('.collect-done')?.querySelector('.collect-print-error')?.remove();
  openReceiptPreview(paymentGroupReceiptDocument(receipts,context),undefined,{patient:view.patient,receipt:receipts[0]});
 }catch(error){
  const host=button.closest?.('.collect-done')||collectDialog;
  if(host?.isConnected!==false)host?.querySelector?.('.collect-print-error')?.remove();
  if(host){const message=document.createElement('p');message.className='muted collect-print-error';message.setAttribute('role','status');message.textContent='The receipt could not be loaded. Try again.';host.append(message);}
 }
}
function copayReceiptDocument(receipt,context){
 const patient=context.patient,appointment=context.appointment,corrected=Number(receipt.reversed_cents||0)>0,hosted=receipt.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),test=hosted?.livemode===false;
 const status=receipt.voided?'Voided receipt':corrected?'Receipt with corrected allocation':refunded?'Card payment receipt with verified refund':hosted?'Card payment receipt':'Payment receipt';
 const allocation=receipt.voided?'<p>This receipt record was voided and is retained for history. Voiding the record does not issue a refund.</p>':corrected?'<p>A charge allocation was reversed after this payment was recorded. Contact the practice to confirm its current disposition. A ledger reversal does not establish that a refund was issued.</p>':`<dt>${refunded?'Original charge allocations':'Applied to visit charges'}</dt><dd>${money(Number(receipt.allocated_cents||0))}</dd><dt>Remaining credit not yet applied</dt><dd>${money(copayUnapplied(receipt))}</dd>`;
 const branding=patientPrintBranding(context.practiceName),title=(test?testPaymentTag(' - '):'')+status;
 return `${patientPrintHead(title,branding)}<body class="patient-receipt">${patientPrintHeader(title,branding)}<section class="document-meta"><div><span class="document-label">Received from</span><p class="patient-print-name">${esc(patient.given_name)} ${esc(patient.family_name)}</p>${patient.mrn?`<small>MRN ${esc(patient.mrn)}</small>`:''}</div><div class="document-reference"><span class="document-label">Receipt details</span><small>${(n=>n?(n.startsWith('Payment ')?esc(n):'Receipt '+esc(n))+'<br>':'')(typeof receiptNumberFor!=='function'?'':receiptNumberFor(receipt.appointment_id,receipt.payment_group_id||receipt.id))}${visitReceiptVisitFacts(context.visitEvidence,typeof encounterNumberForAppointment==='function'?encounterNumberForAppointment(receipt.appointment_id):'')}${hosted?'Payment received (UTC date)':'Payment received'} ${esc(receipt.occurred_on)}${receipt.created_at?'<br>Recorded '+esc(date(receipt.created_at)):''}</small></div></section>${visitReceiptSections(context.visitEvidence)}<section class="document-total"><span>${receipt.voided?'Original recorded amount':'Amount received'}</span><strong>${money(receipt.amount_cents)}</strong></section><p class="document-appointment">${appointment?`Appointment: ${esc(appointment.title||'Scheduled appointment')}<br>${esc(date(appointment.starts_at))}`:`Appointment reference: <span class="reference">${esc(receipt.appointment_id)}</span>`}</p><h2>Payment details</h2><dl><dt>Payment method</dt><dd>${hosted?'Card · Confirmed':esc(invoicePaymentMethod(receipt.method))}</dd>${refunded?`<dt>Verified refunded amount</dt><dd>${money(refunded)}</dd><dt>Net card payment</dt><dd>${money(receipt.amount_cents-refunded)}</dd>`:''}${receipt.reference?`<dt>Receipt / check reference</dt><dd class="reference">${esc(receipt.reference)}</dd>`:''}${!receipt.voided&&!corrected?allocation:''}</dl>${receipt.voided||corrected?allocation:''}<footer>${test&&testPaymentTag()?`<p class="copay-mode-label">${testPaymentTag()}</p>`:''}${hosted?.status==='needs_review'?'<p class="document-warning">This payment requires reconciliation. Confirm its current status with the practice.</p>':''}<p>This is a copy of the practice’s recorded payment receipt. It is not an invoice and does not determine final insurance or patient responsibility.</p><small>Copy prepared ${esc(date(context.printedAt))}. Patient, appointment and practice branding reflect the chart when this copy was prepared.</small>${patientPrintFooter()}</footer></body></html>`;
}
function copayReceiptCardMarkup(receipt,context){
 const branding=patientPrintBranding(context.practiceName),hosted=receipt.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),reversed=Number(receipt.reversed_cents||0),held=hosted?.status==='needs_review';
 const status=receipt.voided?'Voided':held?'Needs reconciliation':refunded===receipt.amount_cents?'Refunded':refunded?'Partially refunded':reversed?'Allocation corrected':hosted?'Payment captured':'Payment recorded';
 const appointment=context.appointment,patient=context.patient;
 return `<article class="copay-receipt-card" data-copay-receipt-view><header>${branding.logo?`<img src="${esc(branding.logo)}" alt="Current practice logo" referrerpolicy="no-referrer">`:''}<div><p>${esc(branding.name||'Practice payment record')}</p><h3 tabindex="-1">Payment receipt</h3></div><button type="button" data-print-copay-card>Print / save PDF</button></header><div class="copay-receipt-amount"><div><span>${receipt.voided||refunded?'Original recorded amount':'Amount received'}</span><strong>${money(receipt.amount_cents)}</strong></div><span class="copay-receipt-status">${esc(status)}</span></div>${hosted?.livemode===false&&testPaymentTag()?`<p class="copay-mode-label">${testPaymentTag()}</p>`:''}<dl><div><dt>Patient</dt><dd>${esc(patient.given_name)} ${esc(patient.family_name)}</dd></div><div><dt>${hosted?'Payment date (UTC)':'Payment date'}</dt><dd>${esc(receipt.occurred_on)}</dd></div><div><dt>Appointment</dt><dd>${appointment?`${esc(appointment.title||'Scheduled appointment')}<small>${esc(date(appointment.starts_at))}</small>`:`Reference ${esc(receipt.appointment_id)}`}</dd></div><div><dt>Payment method</dt><dd>${hosted?'Card · Confirmed':esc(invoicePaymentMethod(receipt.method))}</dd></div>${refunded?`<div><dt>Verified refund</dt><dd>${money(refunded)}</dd></div><div><dt>Net received</dt><dd>${money(receipt.amount_cents-refunded)}</dd></div>`:''}${!receipt.voided&&!held&&!reversed?`<div><dt>${refunded?'Original charge allocations':'Applied to charges'}</dt><dd>${money(Number(receipt.allocated_cents||0))}</dd></div><div><dt>Unapplied credit</dt><dd>${money(copayUnapplied(receipt))}</dd></div>`:''}</dl>${receipt.voided?'<p role="status">This receipt was voided and is retained in history. Voiding a receipt does not issue a refund.</p>':held?'<p role="status">This payment requires reconciliation. Review its status before collecting or applying another payment.</p>':reversed?'<p role="status">An allocation was reversed. Review the ledger; this does not establish that a refund was issued.</p>':''}<details><summary>Receipt reference</summary><p>${esc(receipt.id)}${receipt.reference?'<br>'+esc(receipt.reference):''}</p></details><footer><p>Recorded payment evidence, not an invoice or a determination of insurance responsibility.</p>${patientPrintFooter()}</footer></article>`;
}
function renderCopayReceiptCard(host,receipt,context,current){
 host.hidden=false;host.innerHTML=copayReceiptCardMarkup(receipt,context);
 const card=host.querySelector('[data-copay-receipt-view]');
 card.copayPrint={receipt,context,identity:me,current};
 host.scrollIntoView({block:'start'});card.querySelector('h3')?.focus({preventScroll:true});
}
async function printCopayReceiptCard(card,button){
 const state=card?.copayPrint;if(!state||state.identity!==me||card.isConnected===false||!state.current())return;
 card.querySelector('.copay-print-source')?.remove();button.disabled=true;
 const frame=document.createElement('iframe');frame.className='copay-print-source';frame.title='Payment receipt print document';frame.setAttribute('aria-hidden','true');frame.setAttribute('sandbox','allow-same-origin allow-modals');
 frame.addEventListener('load',()=>{button.disabled=false;if(state.identity!==me||card.isConnected===false||!state.current())return;frame.contentWindow.focus();frame.contentWindow.print();},{once:true});
 const appointmentId=(state.group?state.receipt[0]:state.receipt)?.appointment_id;
 const visitEvidence=state.context.visitEvidence!==undefined?state.context.visitEvidence:await visitReceiptEvidence(appointmentId);
 if(state.identity!==me||card.isConnected===false||!state.current()){button.disabled=false;return;}
 frame.srcdoc=(state.group?paymentGroupReceiptDocument:copayReceiptDocument)(state.receipt,{...state.context,visitEvidence,printedAt:new Date().toISOString()});card.append(frame);
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
  const visitEvidence=await visitReceiptEvidence(expected);
  if(!current())return;
  openReceiptPreview(copayReceiptDocument(receipt,{...context,visitEvidence,printedAt:new Date().toISOString()}),undefined,{patient:view.patient,receipt});
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
// The encounter's billing card. Every amount and the next step come from the server's summary
// for this encounter; nothing here adds or subtracts money.
function visitBillingStateContext(extra={}){return {delegated:typeof me!=='undefined'&&me?.delegated===true||encounterRevenueState.data?.summary?.viewer?.delegated===true,canCreate:billingCan('create'),canWrite:billingCan(),claimsAllowed:typeof workspaceResourceAllowed!=='function'?true:workspaceResourceAllowed('claims','view'),...extra};}
function visitBillingContext(extra={}){return visitBillingStateContext(extra);}
// Whether this encounter's charges are on their way onto the table filled in from the patient's last
// visit, or already sit there untouched. The billing card asks the charge table's own code (see
// visitBillingChargesFilled in web/visit-billing.js, which loads first) so the wording the card
// offers and the table the step builds are always the same answer. With nothing to fill in from
// the card says what it always said.
function encounterChargesFilledIn(){return typeof visitBillingChargesFilled==='function'&&visitBillingChargesFilled();}
// Whether the staff member is looking at this encounter's charges. On the one-page visit the charges
// block sits on the encounter itself, so the page helper answers; where app.js is not loaded the
// page works as before and the encounter's own charges state decides.
function encounterOnBillingStep(){
 if(typeof encounterShows==='function')return encounterShows('charges');
 return typeof encounterSection==='undefined'||encounterSection==='charges';
}
function encounterRevenueStatusMarkup(account,data={}){
 // A card with something wrong to answer for keeps its own button: while a claim could not be
 // prepared, or is preparing, the review panel has nothing to offer yet.
 if(data.summary)return visitBillingCardMarkup(data.summary,visitBillingContext({prepareError:data.prepareError,preparing:data.preparing,noReview:!!data.prepareError||!!data.preparing}))+(data.stale?'<p role="status">These amounts could not be refreshed just now. Refresh before relying on them.</p>':'');
 return `<section class="visit-billing-card"><div class="section-head"><h3>Next step</h3>${data.error?'<button type="button" class="text-button" data-refresh-revenue>Refresh</button>':''}</div>${data.error?'<p role="status">Billing for this encounter could not be loaded. Refresh before relying on any amount.</p>':typeof skeletonMarkup==='function'?skeletonMarkup('card'):'<p class="muted" role="status">Loading billing for this encounter…</p>'}</section>`;
}
function paintEncounterRevenue(state,current){
 if(!current())return;const node=$('encounter-revenue-status');if(!node)return;
 if(typeof encounterCodesStripClaimSync==='function')encounterCodesStripClaimSync();
  const open=Array.from(node.querySelectorAll?.('details[data-revenue-disclosure][open]')||[]).map(d=>d.dataset.revenueDisclosure);
  // A failure line beside the send survives the refresh that follows it: the card is the same
  // card, and the person needs to still see why the send stopped once the card settles.
  const held=node.querySelector?.('[data-claim-send-error]')?.textContent||'';
state.reviewCard=state.data?.summary||null;node.innerHTML=encounterRevenueStatusMarkup(encounterChargeAccount(),state.data||{});
  if(typeof encounterBarSync==='function')encounterBarSync();
  if(typeof patientBannerEncounterSync==='function'&&state.data?.summary&&typeof activeVisit!=='undefined'&&activeVisit)patientBannerEncounterSync(state.data.summary,activeVisit);
  if(typeof billingRowCodesFill==='function')billingRowCodesFill();
  if(held&&!node.querySelector?.('[data-claim-send-error]'))node.querySelector?.('.visit-billing-status .actions')?.insertAdjacentHTML?.('beforeend',`<p class="claim-send-error" data-claim-send-error role="alert">${esc(held)}</p>`);
  for(const d of node.querySelectorAll?.('details[data-revenue-disclosure]')||[])d.open=open.includes(d.dataset.revenueDisclosure);
 // Show what just changed: the step that became done, and the amount the patient owes.
 if(typeof motionFlash==='function'){
  const doneNow=Array.from(node.querySelectorAll?.('[data-billing-row]')||[]).filter(r=>r.querySelector?.('.billing-row-mark.is-done')),owesNow=state.data?.summary?.patient?.owes_now_cents,before=state.motionPrev;
  state.motionPrev={done:doneNow.map(r=>r.dataset?.billingRow),owes:owesNow};
  if(before){
   for(const row of doneNow)if(!before.done.includes(row.dataset?.billingRow)){motionFlash(row);if(typeof motionMarkDone==='function')motionMarkDone(row.querySelector('.billing-row-mark.is-done'));}
   if(before.owes!==owesNow&&Number.isFinite(before.owes)&&Number.isFinite(owesNow)){const total=node.querySelector?.('.billing-column-total');if(total){motionFlash(total);if(typeof motionCount==='function')motionCount(total.querySelector('b'),before.owes,owesNow);}}
  }
 }
  // The review panel beside the table is the person's own working space. A background refresh
  // redraws the card underneath it; the panel is redrawn only if it was taken out of the DOM.
  const panel=$('visit-billing-review'),review=state.review;
  if(panel&&panel.hidden===false){
    if(panel.isConnected===false&&typeof visitReviewPaint==='function')visitReviewPaint();
    else if(!review?.busy&&!review?.sent&&!review?.stopped&&typeof visitReviewPanelMarkup==='function'&&state.data?.summary)panel.innerHTML=visitReviewPanelMarkup(state.data.summary,visitReviewContext());
  }

 const summary=state.data?.summary,context=visitBillingContext();if(!summary)return;
 // The line under the charge table is the same next step as the card's, so a refresh of the
 // card moves it too; the table itself and anything typed in it are left exactly as they are.
 if(typeof chargeTableNextRefresh==='function')chargeTableNextRefresh();
 const timeline=$('visit-billing-timeline');if(timeline)timeline.innerHTML=visitBillingTimeline(summary,context,state.filter||'all');
 const technical=$('visit-billing-technical');if(technical)technical.innerHTML=visitBillingTechnical(summary);
 const details=$('visit-billing-details');if(details)details.hidden=!summary.technical;
 if(typeof renderEncounterInvoices==='function')renderEncounterInvoices();
}
async function loadEncounterRevenueStatus(account,force=false){
 const visit=typeof activeVisit!=='undefined'?activeVisit:null;if(!visit)return;
 let state=encounterRevenueState;
 if(state.patient!==selected||state.identity!==me||state.visit!==visit.id||state.account!==(account?.id||null)||state.version!==(account?.version||null)){if(typeof clearTimeout==='function')clearTimeout(state.timer);const sameVisit=state.patient===selected&&state.identity===me&&state.visit===visit.id;state={reviewOpen:sameVisit&&state.reviewOpen===true,patient:selected,identity:me,visit:visit.id,account:account?.id||null,version:account?.version||null,pending:null,data:null,loadedAt:0,filter:'all',prepared:false,review:null,reviewCard:null};encounterRevenueState=state;}
 const current=()=>encounterRevenueState===state&&selected===state.patient&&me===state.identity&&activeVisit?.id===state.visit&&(encounterChargeAccount()?.id||null)===state.account;
 const render=()=>paintEncounterRevenue(state,current);
 if(state.pending){render();return state.pending;}
 // The claim is prepared only while the billing step itself is showing, never because the
 // visit was opened on its note or another step.
 const onBillingStep=()=>encounterOnBillingStep();
 const mayPrepare=summary=>summary?.state==='prepare_claim'&&summary.account&&billingCan('create')&&!state.prepared&&onBillingStep()&&me?.delegated!==true&&summary.viewer?.delegated!==true;
 if(state.data?.summary&&!force&&!mayPrepare(state.data.summary)&&Date.now()-state.loadedAt<15000){render();return;}
 if(!state.data)state.data={};render();
 state.pending=(async()=>{
  try{
   const read=()=>api(`/api/v1/patients/${encodeURIComponent(state.patient)}/billing/visit-summary?visit_id=${encodeURIComponent(state.visit)}`);
   let summary=await read();if(!current())return;
   let prepareError=state.data.prepareError||null;
   // The claim prepares itself once the charges are final: on posting, and the first time an
   // older posted visit is opened. It stays a draft; a person still reviews and sends it.
   if(current()&&mayPrepare(summary)){
    state.prepared=true;state.data={summary,preparing:true};render();
    try{await api(`/api/v1/patients/${encodeURIComponent(state.patient)}/billing/accounts/${encodeURIComponent(summary.account.id)}/claims/prepare`,'POST',{});prepareError=null;}catch(error){prepareError=visitBillingPrepareMessage(error);}
    if(!current())return;summary=await read();if(!current())return;
   }
   // The read finished: the card answers for the encounter as the server now describes it, so the
   // version it was opened at is replaced with the one that produced this summary.
   if(encounterRevenueState===state&&summary?.account)state.version=summary.account.version??state.version;
   state.data={summary,prepareError:summary.state==='prepare_claim'?prepareError:null};state.loadedAt=Date.now();
  }catch{state.data=state.data?.summary?{...state.data,stale:true,preparing:false}:{error:true};}
  finally{state.pending=null;render();
   // The claim made from these codes shows under them as soon as the summary names it.
   if(current()&&$('encounter-revenue')?.dataset?.invoiceTab==='billing'&&typeof encounterClaimMount==='function')encounterClaimMount();
   // The banner's progress line follows this encounter: its claim, or its self-pay steps.
   if(current()&&typeof patientBannerEncounterSync==='function')patientBannerEncounterSync(state.data?.summary,typeof activeVisit!=='undefined'?activeVisit:null);
   const claimId=state.data?.summary?.claim?.id;
   if(current()&&claimId&&!(typeof patientBannerEncounterOpen==='function'&&patientBannerEncounterOpen())&&typeof patientBannerClaim!=='undefined'&&patientBannerClaim.claim?.id!==claimId&&typeof claimMdClaimLifecycle==='function'&&typeof claimsBase!=='undefined')void api(`${claimsBase}/${encodeURIComponent(claimId)}`).then(detail=>{if(current()&&detail?.claim?.id===claimId)claimMdClaimLifecycle(detail.claim,detail);}).catch(()=>{});
  if(current()&&typeof setTimeout==='function'&&state.data?.summary?.account?.status==='posted'){clearTimeout(state.timer);state.timer=setTimeout(()=>{const node=$('encounter-revenue-status');if(current()&&node&&(!node.getClientRects||node.getClientRects().length))void loadEncounterRevenueStatus(encounterChargeAccount(),true);},20000);}}
 })();
 return state.pending;
}
async function prepareVisitClaim(again,quiet){
 const account=encounterChargeAccount(),state=encounterRevenueState,patient=selected,identity=me;if(!account)throw new Error('Post the charges for this encounter first.');
 state.prepared=true;
 const result=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/accounts/${encodeURIComponent(account.id)}/claims/prepare`,'POST',again?{again:true}:{});
 if(selected!==patient||me!==identity)return;
 if(encounterRevenueState===state&&state.data)state.data.prepareError=null;
 await loadEncounterRevenueStatus(encounterChargeAccount(),true);
 if(result.outcome==='prepared'&&!quiet)notice('Claim prepared from this encounter. Nothing was sent.');
}
// A cancelled claim goes out again in one press: the claim is prepared again (keeping what a person
// corrected on the cancelled one), the encounter is read back, and when nothing needs fixing the same
// send the review panel's own button runs goes ahead. Otherwise the review panel shows what to fix.
async function visitClaimResend(button){
 const patient=selected,identity=me;
 if(button){button.disabled=true;button.textContent='Sending…';}
 try{
  await prepareVisitClaim(true,true);
  if(selected!==patient||me!==identity)return;
  const summary=encounterRevenueState.data?.summary;
  const clear=summary?.state==='send_claim'&&!visitReviewMustFix(visitReviewChecks(summary,visitReviewContext())).length;
  const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
  const options=clear?visitReviewSendContext(summary,account):null;
  visitReviewOpen();
  if(options)await visitReviewRun(summary.claim?.id||null,options);
 }catch(error){
  visitClaimSendFailure(error,button);
  if(button&&button.isConnected!==false){button.disabled=false;button.textContent='Send the claim again';}
 }
}
// The statement is the patient's side of this encounter. Its record is saved the first time it
// is opened to print or send, and reused while the amount is unchanged.
async function openVisitStatement(){
 const account=encounterChargeAccount();if(!account||account.status!=='posted')throw new Error('Post the charges before preparing a statement.');
 const view=hostedCopayView();
 const result=await api(`/api/v1/patients/${encodeURIComponent(view.patient)}/billing/accounts/${encodeURIComponent(account.id)}/statement`,'POST',{});
 if(!currentHostedCopayView(view,false)||result.invoice?.patient_id!==view.patient||result.invoice.account_id!==account.id)return;
 showVisitStatement(result.invoice);
 void loadEncounterRevenueStatus(encounterChargeAccount(),true);
}
function showVisitStatement(invoice){
 if(!invoice)throw new Error('This statement is unavailable. Refresh and try again.');
 const mail=visitBillingStatementMailto(invoice);
 openBillingEditor(`<div class="section-head"><h3>Invoice</h3><div class="actions"><button type="button" class="primary" data-print-patient-invoice>Print / save PDF</button>${mail?`<a class="button" href="${esc(mail)}">Email the patient</a>`:''}<button type="button" data-visit-statement-close>Close</button></div></div><p class="muted">${money(invoice.snapshot?.amount_due_cents||0)} due as of ${esc(visitBillingDate(invoice.created_at))}. Opening a statement does not charge a card.${mail?' Email opens a message to the patient; attach the saved PDF.':''}</p><div id="patient-invoice-preview"></div>`);
 if(typeof sheetOpen==='function'&&document.body&&typeof billingEditorHost==='function'){const host=billingEditorHost(),holder=document.createElement('div');holder.className='invoice-sheet';while(host?.firstChild)holder.append(host.firstChild);holder.querySelector('.section-head h3')?.remove();if(holder.childNodes.length)sheetOpen('Invoice',holder).classList.add('sheet-wide');}
 const frame=document.createElement('iframe');frame.id='patient-invoice-frame';frame.title='Patient statement print preview';frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');frame.srcdoc=patientInvoiceDocument(invoice);$('patient-invoice-preview')?.append(frame);
}
// The panel is titled for what staff will do in it: collect while something is due, otherwise
// it is simply the encounter's payments.
function visitCollectHeading(){
 // Asked once, when the panel is first shown: whether the reader is on, for its button.
 if(!hostedCopayState.readers&&!hostedCopayState.readersAsked&&typeof api==='function'){hostedCopayState.readersAsked=true;Promise.resolve(api('/api/v1/billing/payments/readers')).then(data=>{hostedCopayState.readers=data?.readers||[];const node=$('encounter-hosted-copay'),state=node?.dataset?.appointment&&typeof hostedCopayStateFor==='function'?hostedCopayStateFor(node.dataset.appointment):null;if(state)paintHostedCopayState(state);}).catch(()=>{});}
 const heading=$('visit-billing-collect')?.querySelector?.('.section-head h3');if(!heading)return;
 const summary=encounterRevenueState.data?.summary,due=summary&&typeof visitBillingDue==='function'?visitBillingDue(summary).due:null;
 heading.textContent=due>0||due==null?'Collect payment':'Payments';
}
function openVisitCollect(){
 if(typeof sheetOpen==='function'&&typeof document!=='undefined'&&document.createElement&&openCollectModal())return;
 const panel=$('visit-billing-collect');if(!panel)return;
 const summary=encounterRevenueState.data?.summary,note=$('visit-billing-collect-note');
 if(note)note.textContent=summary?`Patient owes now ${money(summary.patient.owes_now_cents)}.`:'';
 panel.hidden=false;visitCollectHeading();panel.scrollIntoView?.({block:'nearest'});const heading=panel.querySelector?.('h3');if(heading){heading.tabIndex=-1;heading.focus?.({preventScroll:true});}
}
// The amount a payment form starts with: what the patient owes now on the open visit,
// otherwise the plan copay. Staff can change it before anything is charged.
function visitCollectAmount(appointmentId,plan){
 const summary=encounterRevenueState.data?.summary;
 if(typeof chartSection!=='undefined'&&chartSection==='visits'&&summary&&summary.visit?.appointment_id===appointmentId&&encounterRevenueState.patient===selected&&summary.patient.owes_now_cents>0)return summary.patient.owes_now_cents;
 return plan;
}
function openVisitHistory(filter){
 const history=$('visit-billing-history');if(!history)return;
 history.open=true;encounterRevenueState.filter=visitBillingFilters.some(([key])=>key===filter)?filter:'all';
 const summary=encounterRevenueState.data?.summary,timeline=$('visit-billing-timeline');if(summary&&timeline)timeline.innerHTML=visitBillingTimeline(summary,visitBillingContext(),encounterRevenueState.filter);
 if(typeof invoiceTabSet==='function')invoiceTabSet('history');
 history.scrollIntoView?.({block:'start'});
}
function insuranceCoverageCard(coverage){
 const c=coverage.content;
 return `<article class="insurance-coverage-card"><div class="section-head"><div><h3>${esc(payerName(c.payer_id))}</h3><p>${esc(human(c.priority))} · ${esc(c.plan_name||'Plan name not recorded')}</p></div><span class="pill">${esc(human(c.status))}</span></div><dl class="billing-dl"><dt>Member / policy</dt><dd>${esc(c.member_id)}</dd><dt>Recorded plan copay</dt><dd>${c.copay_cents==null?'Not recorded':money(c.copay_cents)}</dd></dl><div class="insurance-eligibility-summary" id="insurance-eligibility-${esc(coverage.id)}"></div><div class="actions">${typeof claimmdEligibilityButton==='function'?claimmdEligibilityButton(coverage):''}<button type="button" data-coverage-open="${esc(coverage.id)}">Insurance details</button>${billingCan()?`<button type="button" data-edit-coverage="${esc(coverage.id)}">Edit insurance</button>`:''}</div></article>`;
}
function insuranceContinueMarkup(appointment){
 if(!appointment)return '<p>Select an appointment above to continue its encounter.</p>';
 if((typeof chartAreaEnabled==='function'&&!chartAreaEnabled('visits'))||(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('clinical')))return '<p>Continuing this encounter needs clinical access. The appointment selection above remains the scope for billing.</p>';
 const visit=(workspace.visits||[]).find(v=>v.appointment_id===appointment.id);
 const context=`${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}`;
 if(visit)return `<p>${context}</p><button type="button" data-visit="${esc(visit.id)}">${visit.status==='signed'?'Open encounter':'Continue encounter'}</button><p class="muted">${visit.status==='signed'?'Signed. Changes are added as signed corrections.':'Pick up where this encounter left off.'}</p>`;
 if(workspace.patient?.archived)return `<p>${context}</p><p class="muted">This patient chart is archived. Restore it before checking in or starting a new encounter. Existing visits remain available.</p>`;
 if(appointment.status==='booked'&&typeof canSchedule==='function'&&canSchedule())return `<p>${context} · Not checked in</p><button type="button" data-insurance-check-in="${esc(appointment.id)}">Check in this appointment</button>`;
 if(appointment.status==='checked_in'&&((typeof isRoomingStaff==='function'&&isRoomingStaff())||(['owner','clinician'].includes(me?.role)&&appointment.clinician_id===me.user_id)))return `<p>${context} · Checked in</p><button type="button" data-start="${esc(appointment.id)}">Start this encounter</button>`;
 return `<p>${context} · ${esc(human(appointment.status))}</p><p class="muted">No visit is linked to this appointment. Its status and assigned clinician determine the next clinical action.</p>`;
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
// Where this appointment stands, shown on each step so staff see at a glance what is done
// (green check), what needs a look (amber) and what is not done (red).
function appointmentPrepState(appointment,current){
 const visit=appointment?(workspace.visits||[]).find(v=>v.appointment_id===appointment.id):null;
 const primary=current?.[0],copay=primary?.content?.copay_cents;
 const paid=appointmentCopays(appointment).filter(r=>!r.voided).reduce((sum,r)=>sum+Number(r.amount_cents||0)-Number(r.hosted_checkout?.refunded_cents||0),0);
 const count=appointmentCopays(appointment).filter(r=>!r.voided).length;
 const insurance=current?.length?{tone:'done',text:'Insurance on file'}:{tone:'todo',text:'No insurance on file'};
 const copayState=!appointment?{tone:'todo',text:'No appointment'}:copay==null?(paid>0?{tone:'done',text:`${money(paid)} paid`}:{tone:'check',text:'No copay recorded'}):paid>=copay?{tone:'done',text:`Copay ${money(copay)} paid`}:paid>0?{tone:'check',text:`${money(paid)} of ${money(copay)} paid`}:{tone:'todo',text:`Copay ${money(copay)} due`};
 const encounter=!visit?{tone:'todo',text:'Not started'}:visit.status==='signed'?{tone:'done',text:'Encounter signed'}:{tone:'check',text:'In progress'};
 return {visit,signed:visit?.status==='signed',paid,count,copay,insurance,copayState,encounter};
}
function prepStageMark(state){return `<span class="prep-mark prep-${state.tone}" aria-hidden="true">${state.tone==='done'?'✓':state.tone==='todo'?'!':'•'}</span>`;}
// The appointment's copay controls: before an encounter exists they sit on the Encounters tab with
// the checked-in or booked appointment; once the encounter is open its copay is in Billing.
function appointmentCopaySectionMarkup(appointment,prep){
 const copayDone=prep.copayState.tone==='done';
 return `<section class="insurance-workflow-stage" aria-labelledby="insurance-copay-title"><h3 id="insurance-copay-title" tabindex="-1">${copayDone?'Copay':'Collect copay'}</h3>${copayDone?`<p class="prep-summary">${prepStageMark(prep.copayState)} ${esc(prep.copayState.text)} · ${prep.count===1?'1 payment':prep.count+' payments'}, ${money(prep.paid)} in all</p><details class="insurance-supporting-records"><summary>Payments, receipts and taking another payment</summary>`:''}${appointment?hostedCopayPanel(appointment,'insurance-hosted-copay')||copayReceiptMarkup(appointmentCopays(appointment)):'<p>Select or book an appointment before collecting its copay.</p>'}${billingCan('create')&&appointment?`<details class="insurance-supporting-records"><summary>Record cash, check or an external receipt</summary><p>This records money already received; it does not charge a card.</p><button type="button" data-record-copay="${esc(appointment.id)}">Record received payment</button></details>`:''}${copayDone?'</details>':''}</section>`;
}
function appointmentCopayCard(){
 const appointment=revenueAppointment();
 if(!appointment||!workspace.billing||(workspace.visits||[]).some(v=>v.appointment_id===appointment.id)||['cancelled','canceled','no_show','completed'].includes(appointment.status))return '';
 const serviceDate=revenueServiceDate(appointment),current=(workspace.billing.coverages||[]).filter(c=>c.content.status==='active'&&c.content.effective_date<=serviceDate&&(!c.content.end_date||c.content.end_date>=serviceDate)).sort((a,b)=>({primary:0,secondary:1,tertiary:2}[a.content.priority]??3)-({primary:0,secondary:1,tertiary:2}[b.content.priority]??3));
 const prep=appointmentPrepState(appointment,current);
 if(billingCan('create')&&typeof setTimeout==='function')setTimeout(()=>{void loadHostedCopays(appointment.id);},0);
 return `<section class="panel appointment-copay-card" id="appointment-copay-card"><div class="section-head"><div><h2>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</h2><p class="muted">${esc(displayStatus(appointment.status))} · Start the visit from the top of the chart when the patient is ready.</p></div></div><p class="prep-summary">${prepStageMark(prep.insurance)} ${esc(prep.insurance.text)}</p>${prep.copayState.tone==='done'?'':`<p class="prep-summary">${prepStageMark(prep.copayState)} ${esc(prep.copayState.text)}</p>`}${appointmentCopaySectionMarkup(appointment,prep)}</section>`;
}
function renderPatientInsurance(){
 if(!workspace.billing)return;
 let host=$('insurance-workspace');if(!host){host=document.createElement('section');host.id='insurance-workspace';host.className='panel';$('chart').insertBefore(host,$('appointments-panel'));}
 const appointment=revenueAppointment(),serviceDate=revenueServiceDate(appointment),coverages=workspace.billing.coverages||[],current=coverages.filter(c=>c.content.status==='active'&&c.content.effective_date<=serviceDate&&(!c.content.end_date||c.content.end_date>=serviceDate)).sort((a,b)=>({primary:0,secondary:1,tertiary:2}[a.content.priority]??3)-({primary:0,secondary:1,tertiary:2}[b.content.priority]??3)),history=coverages.filter(c=>!current.includes(c));
 if(typeof refreshPatientChartContext==='function')refreshPatientChartContext();
 const key=JSON.stringify([selected,appointment?.id,appointment?.status,serviceDate,coverages.map(c=>[c.id,c.version]),workspace.billing.copays,(workspace.visits||[]).map(v=>[v.id,v.status])]);if(host.dataset.insuranceKey===key){for(const coverage of coverages)loadInsuranceEligibility(coverage.id);insuranceAutoEligibility(current,appointment,serviceDate);if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);return;}host.dataset.insuranceKey=key;
 const options=(workspace.appointments||[]).filter(a=>!['cancelled','canceled','no_show'].includes(a.status)||a.id===appointment?.id);
 const prep=appointmentPrepState(appointment,current),copayDone=prep.copayState.tone==='done';
 host.innerHTML=`<div class="section-head"><div><h2>Insurance</h2><p class="muted">Plans on file and eligibility${appointment?' for the visit on '+esc(displayDate(serviceDate)):''}. Copays are taken on the appointment or in the encounter’s Billing.</p></div></div><section class="insurance-workflow-stage" aria-labelledby="insurance-review-title"><div class="section-head"><h3 id="insurance-review-title" tabindex="-1">Plans on file</h3><div class="actions"><button type="button" data-chart-section="documents">Insurance documents</button>${billingCan('create')?'<button type="button" data-new-coverage>Add insurance</button>':''}</div></div>${current.length?`<div class="insurance-coverage-list">${current.map(insuranceCoverageCard).join('')}</div>`:'<p>No insurance on file for this encounter date.</p>'}${history.length?`<details class="insurance-supporting-records"><summary>Inactive &amp; prior coverage (${history.length})</summary><div class="insurance-coverage-list">${history.map(insuranceCoverageCard).join('')}</div></details>`:''}</section><div id="insurance-editor"></div>`;
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
 const owner=typeof me!=='undefined'&&me?.role==='owner';
  // Whether this role sees codes & charges at all. A person without billing keeps the note's own
  // diagnoses editor, so the codes block draws none of its own (visitNoteOwnsDiagnoses).
  const codesVisible=typeof visitBillingAreaVisible!=='function'||visitBillingAreaVisible();
  // The diagnoses host is the block's first child and this rewrite never parses over it: the editor
  // keeps the nodes it already has, so a diagnosis being typed into it is not rebuilt from markup by
  // an unrelated recalculation. The rest of the block is built as markup as before, into a detached
  // holder, and its nodes are hung under the host the rewrite left alone. With codes hidden for this
  // role the host is emptied and put away, because an editor nobody may bill with is no reason to
  // keep one. A page whose block cannot hold children gets no host either (encounterDiagnosesHost).
  const diagnosesHost=encounterDiagnosesHost();
  if(diagnosesHost){
   if(codesVisible)diagnosesHost.hidden=false;
   else{diagnosesHost.replaceChildren();diagnosesHost.hidden=true;}
   if(diagnosesHost.parentNode===host)host.removeChild(diagnosesHost);
  }
 // A detached holder for the body markup, so the diagnoses host is never inside what is rewritten.
 // A page whose document cannot hand out elements gets a plain string holder instead; that page has
 // no live nodes to protect, and the host is re-written there (below).
 const holder=typeof document.createElement==='function'?document.createElement('div'):null;
 const rebuilt=holder||{set innerHTML(html){this._html=html;},get innerHTML(){return this._html||'';}};
 rebuilt.innerHTML=`${typeof invoiceTabsMarkup==='function'?invoiceTabsMarkup():''}<div class="section-head"><div><h2>Procedures (CPT)</h2><p class="muted">${esc(visitBillingDate(serviceDate))} · ${account?account.status==='posted'?'Posted':'Charges can still be changed':'No charges yet'}</p></div></div><div id="encounter-revenue-status">${encounterRevenueStatusMarkup(account,encounterRevenueState.visit===visit.id&&encounterRevenueState.patient===selected?encounterRevenueState.data||{}:{})}</div><section id="visit-billing-collect" class="billing-section" hidden><div class="section-head"><h3>Collect payment</h3><button type="button" class="text-button" data-visit-collect-close>Close</button></div><p class="muted" id="visit-billing-collect-note"></p>${hostedCopayPanel(appointment,'encounter-hosted-copay')}${billingCan('create')&&appointment?`<div class="actions visit-billing-collect-cash"><button type="button" data-record-copay="${esc(appointment.id)}">Cash or check</button></div>`:''}</section><div id="encounter-copay-receipt" hidden></div><section id="visit-billing-review" class="billing-section" hidden></section><div id="encounter-billing-editor"></div>${account?'<div class="invoice-lines" id="encounter-billing-detail"></div>':''}${account?'<section class="billing-section" id="visit-billing-payments"><h3>Payments</h3><div id="visit-billing-ledger"></div></section>':''}${account?'<section class="billing-section" id="visit-billing-invoices"></section>':''}<details class="encounter-account-record" id="visit-billing-history"><summary>History</summary><div id="visit-billing-timeline"><p class="muted">Loading history…</p></div>${owner?`<details class="encounter-account-record" id="visit-billing-details" hidden><summary>Technical details</summary><div id="visit-billing-technical"></div><p class="muted">${coverage?esc(payerName(coverage.content.payer_id)):'No insurance on file'} · Plan copay ${coverage?.content.copay_cents==null?'not recorded':money(coverage.content.copay_cents)}</p>${typeof billingCoverageOrderMarkup==='function'?billingCoverageOrderMarkup(serviceDate,account?.content.coverage_id||coverage?.id):''}${account?'<div class="actions"><button type="button" data-bill-history>Change log for these charges</button></div><div id="bill-history"></div>':''}</details>`:''}</details><section id="encounter-claims" hidden></section>`;
  // The body is written as before; the host, held outside that markup, is then moved to the top of
  // the block above the charge lines — moved, never re-created, so what it holds comes with it.
  const bodyMarkup=rebuilt.innerHTML;
  host.innerHTML=bodyMarkup;
  if(diagnosesHost&&typeof host.insertBefore==='function'){
   // insertBefore moves the node: the host was already taken out above, so it is only put back.
   host.insertBefore(diagnosesHost,host.firstChild||null);
   const tabs=host.querySelector?.('.invoice-tabs');if(tabs){host.insertBefore(tabs,host.firstChild);const status=host.querySelector?.('#encounter-revenue-status');if(status)host.insertBefore(status,tabs.nextSibling);}
  }else host.innerHTML=(diagnosesHost?diagnosesHost.outerHTML:'')+bodyMarkup;
 // A chart opened on another page keeps its panel empty; the billing step re-opens it.
 if(chartSection!=='visits'&&typeof visitReviewClose==='function')visitReviewClose();
 else if(typeof visitReviewRestore==='function')visitReviewRestore();
 if(account&&typeof chartSection!=='undefined'&&chartSection==='visits')showBillingAccount(account.id,false);
 // Whether this encounter's charges are on their way onto the table filled in from the patient's
 // last visit. An encounter opened on its billing step with no charges yet is asked first, because
 // that is the one case where charges are about to appear without anyone pressing anything.
 // An encounter whose charges already exist is a table staff have dealt with, so it is never offered
 // charges filled in from an earlier visit. That is decided outside the billing step: on the
 // step itself, charges the practice is about to fill in are already sitting on the table, and
 // this same visit would otherwise be written off as finished before its own table is opened.
 if(account&&!encounterOnBillingStep()&&typeof chargeProposalTouched==='function')chargeProposalTouched(visit);
 // An encounter that is still being worked on and has no charges yet has its table built when the
 // step is opened, so the filled-in charges are on it before anyone presses anything. A visit
 // with nothing to fill in from keeps waiting for its Add charges button.
 if(!account&&typeof chartSection!=='undefined'&&chartSection==='visits'&&encounterOnBillingStep()&&encounterChargesFilledIn())openEncounterCharges();

 if(typeof encounterBillingChrome==='function')encounterBillingChrome(host);
 if(typeof invoiceTabSet==='function')invoiceTabSet(invoiceTabRemembered(),false);
 loadEncounterRevenueStatus(account);
 if(codesVisible&&encounterDiagnosesHost())renderEncounterDiagnoses();
 if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);
 if(typeof resumeEncounterChargeDraft==='function')resumeEncounterChargeDraft();
}
// The card's "Post charges" asks first, then sends exactly what the lower form would send
// with its reason box left as rendered. A payer with no electronic ID still needs the
// acknowledgement in that form, so the button only scrolls down to it.
// With the one-press flow asked for (the line under the charge table, or the card on an encounter
// whose claim is already prepared), the ask names the send that follows the post.
// What the last press found: whether anything was posted, and whether the ask was cancelled
// before anything was sent. The one-press flow answers for both.
let visitChargePostResult=null;
async function postVisitChargesFromCard(options={}){
 visitChargePostResult={posted:false,cancelled:false};
 const account=encounterChargeAccount(),state=encounterRevenueState;if(!account||account.status!=='draft')return false;
 if(typeof encounterRevenueVisitUnsigned==='function'&&encounterRevenueVisitUnsigned(account))return false;
 if(account.content.coverage_id){
  const coverage=(workspace.billing?.coverages||[]).find(c=>c.id===account.content.coverage_id);
  const payer=(typeof billingPayers!=='undefined'?billingPayers:[]).find(p=>p.id===coverage?.content.payer_id);
  if(!String(payer?.content.payer_code||'').trim()){
   billingSelected=account.id;showBillingAccount(account.id,false);
   $('encounter-billing-detail')?.scrollIntoView({behavior:'smooth',block:'start'});
   return false;
  }
 }
const insured=state.data?.summary?.insurance?.insured===true&&account.content.coverage_id!=null;
 const message=options.send&&insured?`Charges of ${money(account.total_cents)} become final and the claim is sent once it is ready.`:insured?`Charges of ${money(account.total_cents)} become final and the insurance claim is prepared.`:`Charges of ${money(account.total_cents)} become final.`;
 // Codes are checked on every post, as approving an encounter does elsewhere: what must be fixed
 // stops the post and is shown on the table; what should be checked is asked about once.
 const form=$('billing-account-form'),findings=form&&typeof encounterCodeFindings==='function'?encounterCodeFindings(form):[];
 const fixes=findings.filter(f=>f.level==='fix'),reviews=findings.filter(f=>f.level==='review');
 if(fixes.length){
  // What has to be fixed is listed beside the codes, so the codes open over the page to show it.
  if(typeof encounterCodesEditorOpen==='function'&&$('encounter-revenue')?.dataset?.codesEditing!=='')encounterCodesEditorOpen();
  const host=form.querySelector('[data-code-check]');if(host){host.innerHTML=encounterCodeFindingsMarkup(findings);host.scrollIntoView?.({block:'center',behavior:'smooth'});if(typeof flashUpdated==='function')flashUpdated(host);}notice(`${fixes.length===1?'1 thing needs':fixes.length+' things need'} fixing before these charges can be posted.`,true);visitChargePostResult.cancelled=true;return false;}
 const held=account.content.claim_details?.review_requested===true;
 const checks=reviews.length?`\n\nCheck before posting:\n${reviews.map(f=>'• '+f.text).join('\n')}`:'';
 if(!await confirmAction(message+(held?' These charges were held for review; posting approves them.':'')+checks,{title:held?'Approve and post these charges?':'Post these charges?',confirmLabel:held?'Approve and post':options.send&&insured?'Post charges and send claim':'Post charges'})){visitChargePostResult.cancelled=true;return false;}
 visitChargePostResult.posted=true;
 const patient=selected,identity=me;
 await api(`${billingBase()}/${account.id}/actions`,'POST',{action:'post',reason:held?'Charges reviewed and posted':'Charges posted',local_only:false,...(held?{review_approved:true}:{})},account.version);
 if(selected!==patient||me!==identity)return;
 // The same refresh the lower form does: this encounter reopened on its billing step. Then the
 // card's own state is dropped so it reads what the server now says. A chart opened on
 // another page stays on that page.
 const returnSection=typeof chartSection!=='undefined'?chartSection:'billing';
 await selectPatient(patient,typeof activeVisit!=='undefined'?activeVisit?.id:undefined);
 if(selected!==patient||me!==identity)return;
 showChartSection(returnSection==='visits'?'visits':'billing');
 if(returnSection==='visits'&&typeof showEncounterSection==='function')showEncounterSection('charges');
 if(encounterRevenueState===state)encounterRevenueState={patient:null,identity:null,account:null,pending:null,data:null,loadedAt:0};
  await loadEncounterRevenueStatus(encounterChargeAccount(),true);
  notice('Charges posted.');
}
function visitBillingRefreshButton(){
 // The pressed button is remembered, exactly as the shared runner remembers the buttons it
 // releases: the line under the charge table and the card are both inside the billing step, and
 // only the press itself knows which one was pressed.
 const form=$('billing-account-form'),slot=form?.querySelector?.('[data-charge-next]'),footer=slot?.querySelector?.('[data-visit-review-open][data-post-and-send]');
 return footer||$('encounter-revenue-status')?.querySelector?.('[data-visit-post-and-send],[data-visit-claim-direct-send]')||null;
}
// The server's own words stay beside the button that failed; nothing else on the encounter changes.
// A button the refresh already redrew (a claim that moved on anyway) is left as the card now says.
function visitClaimSendFailure(error,button){
 // The press may have been on the card or on the line under the charge table; the message goes
 // under whichever button was pressed, where the person looking at is already looking.
 const form=$('billing-account-form'),slot=form?.querySelector?.('[data-charge-next]'),inFooter=!!(slot&&button&&typeof slot.contains==='function'&&slot.contains(button));
 if(inFooter){
  slot.querySelector('[data-claim-send-error]')?.remove?.();
  slot.insertAdjacentHTML?.('beforeend',`<p class="claim-send-error" data-claim-send-error role="alert">${esc(error?.message||'The claim could not be sent. Try again.')}</p>`);
  return;
 }
 const card=$('encounter-revenue-status');if(!card)return;
 // A card redrawn by the refresh has no room left for a line about a send it no longer offers.
 if(card.querySelector('.visit-billing-status .actions')===null)return;
 card.querySelector('[data-claim-send-error]')?.remove?.();
 card.querySelector('.visit-billing-status .actions')?.insertAdjacentHTML?.('beforeend',`<p class="claim-send-error" data-claim-send-error role="alert">${esc(error?.message||'The claim could not be sent. Try again.')}</p>`);
}
// One press: post the charges, let the claim draft be prepared as it is after any post, then send
// what is ready. A claim that lands in fix_claim stops here, shown as its own card with its issues.
async function postVisitChargesAndSend(){
 const account=encounterChargeAccount();if(!account||account.status!=='draft')return;
 const state=encounterRevenueState,patient=selected,identity=me;
const insured=state.data?.summary?.insurance?.insured===true&&account.content.coverage_id!=null;
 if(insured&&typeof encounterRevenueVisitUnsigned==='function'&&encounterRevenueVisitUnsigned(account)){
  notice('The encounter note is not signed yet. Post the charges from the review, which asks about the signature first.',true);
  if(typeof visitReviewOpen==='function')visitReviewOpen();
  return;
 }
 const button=visitBillingRefreshButton();
 if(button){button.disabled=true;button.textContent='Sending…';}
 await postVisitChargesFromCard({send:true});
 if(visitChargePostResult.cancelled||!visitChargePostResult.posted){
  // Nothing happened, so the button is pressed again exactly as it was before the press.
  if(button&&button.isConnected!==false){button.disabled=false;button.textContent='Post charges and send claim';}
  return;
 }
 if(selected!==patient||me!==identity)return;
 const summary=encounterRevenueState.data?.summary;
 if(summary?.state==='fix_claim'){notice('The claim needs details before it can be sent. They are listed on the encounter.',true);return;}
 if(summary?.state!=='send_claim')return;
 // The claim the server just prepared, answering for the encounter this screen is on.
 let claim=summary.claim?.id?summary.claim:null;
 if(!claim){
  const fresh=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/visit-summary?visit_id=${encodeURIComponent(summary?.visit?.id||'')}`);
  if(selected!==patient||me!==identity)return;
  claim=fresh?.claim?.id?fresh.claim:null;
  if(fresh?.state==='fix_claim'){encounterRevenueState.data={summary:fresh};paintEncounterRevenue(encounterRevenueState,()=>true);notice('The claim needs details before it can be sent. They are listed on the encounter.',true);return;}
 }
 if(!claim){notice('The claim for this encounter could not be found. Open the encounter again.',true);return;}
 try{await visitClaimDirectSend(claim.id,button);}
 catch(error){visitClaimSendFailure(error,button);}
}
// A card's button answers for the live visit's summary, read back from the server first: a screen
// left open while the claim moved on sends nothing on the copy it remembers.
async function sendVisitClaimNow(claimId,button){
 // The encounter's own card decides what a press means: charges still a draft go through the combined
 // post-and-send, anything else is the send itself. The card is the server's word on this encounter,
 // and the send re-reads the claim from the server before it releases or sends anything.
 const summary=encounterRevenueState.data?.summary;
 if(summary?.state==='post_charges'&&summary.insurance?.insured&&summary.account?.status==='draft')return postVisitChargesAndSend();
 try{await visitClaimDirectSend(claimId,button);}
 catch(error){visitClaimSendFailure(error,button);}
}
function openEncounterCharges(){
 if(typeof activeVisit==='undefined'||!activeVisit){showChartSection('visits');notice('Select or start the encounter before entering its procedures.',true);return;}
 if(typeof setEncounterSection==='function')setEncounterSection('charges');else showChartSection('visits');
 if(!$('encounter-billing-editor'))renderEncounterRevenue();
 const account=encounterChargeAccount();
 // Charges for an encounter are worked on in one live table: rows, not a form with a save button.
 if(typeof chargeTableAllowed==='function'&&!(account&&account.status==='draft'&&chargeTableAllowed(account))){
  if(account){billingSelected=account.id;showBillingAccount(account.id,false);if(account.status==='draft'&&typeof chargeTableFinishedMarkup==='function')openBillingEditor(chargeTableFinishedMarkup(account));return;}
  if(typeof chargeTableAllowed==='function'&&!chargeTableAllowed(null)){notice('This encounter cannot take charges here yet.',true);return;}
  accountEditor(null,null,true);return;
 }
 if(account){billingSelected=account.id;showBillingAccount(account.id,false);if(account.status==='draft')accountEditor(account,null,true);}else accountEditor(null,null,true);
}
function openCopayReceiptEditor(appointmentId){
 if(appointmentId)insuranceAppointmentSelection.set(selected,appointmentId);
 const inEncounter=chartSection==='visits'&&typeof activeVisit!=='undefined'&&activeVisit&&(!appointmentId||appointmentId===activeVisit.appointment_id);
 if(inEncounter)setEncounterSection('charges');else showChartSection('insurance');
 const appointment=revenueAppointment();if(!appointment){notice('Book or select an appointment before recording its copay.',true);return;}
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=inEncounter?visitCollectAmount(appointment.id,plan):plan;
 openBillingEditor(`<form id="copay-receipt-form" data-patient="${esc(selected)}" data-visit="${esc(inEncounter?activeVisit.id:'')}" data-request="${crypto.randomUUID()}" data-appointment="${esc(appointment.id)}" data-coverage="${esc(coverage?.id||'')}"><h3>Record a cash or check copay</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p class="muted">${plan!=null?'Recorded plan copay: '+money(plan)+'. Confirm the amount received for this encounter.':'Confirm the patient’s responsibility and the amount already received.'} Charges can be prepared later; the receipt remains linked to this appointment.</p><div class="form-grid"><label>Amount received (USD)<input name="amount" inputmode="decimal" required value="${amount==null?'':esc(dollars(amount))}"></label><label>Received by<select name="method"><option value="cash">Cash</option><option value="check">Check</option><option value="external">External payment receipt</option></select></label><label>Receipt / check reference<input name="reference" maxlength="200"></label><label>Receipt date<input name="occurred_on" type="date" required value="${esc(revenueServiceDate(null))}"></label></div><label>Receipt evidence / reason<input name="reason" required maxlength="1000" placeholder="Reviewed copay and payment receipt"></label><label class="review-ack"><input type="checkbox" name="received_confirmed" required> I confirm this payment has already been received. No card or bank transaction will be initiated.</label><button type="submit" class="primary">Save copay receipt</button></form>`);
 const form=$('copay-receipt-form');if(form)form.revenueIdentity=me;
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.insuranceStage){event.preventDefault();if(chartSection!=='insurance'||!['insurance-review-title','insurance-copay-title','insurance-continue-title'].includes(button.dataset.insuranceStage))return;const heading=$(button.dataset.insuranceStage);heading?.focus({preventScroll:true});heading?.scrollIntoView({block:'start',behavior:'smooth'});return;}
 if(button.dataset.insuranceCheckIn){event.preventDefault();run(()=>checkInInsuranceAppointment(button.dataset.insuranceCheckIn));return;}
 if(button.dataset.refreshEligibility){event.preventDefault();loadInsuranceEligibility(button.dataset.refreshEligibility,true);return;}
 if(button.hasAttribute('data-refresh-revenue')){event.preventDefault();loadEncounterRevenueStatus(encounterChargeAccount(),true);return;}
 if(button.hasAttribute('data-visit-collect')){event.preventDefault();openVisitCollect();return;}
 if(button.hasAttribute('data-visit-collect-close')){event.preventDefault();if(collectDialog){sheetClose(collectDialog);return;}const panel=$('visit-billing-collect');if(panel)panel.hidden=true;return;}
 if(button.hasAttribute('data-visit-claim-resend')){event.preventDefault();button.disabled=true;button.textContent='Sending…';run(()=>visitClaimResend(button));return;}
 if(button.dataset.visitClaimPrepare!==undefined){event.preventDefault();button.disabled=true;run(()=>prepareVisitClaim(button.dataset.visitClaimPrepare==='again'));return;}
 if(button.dataset.visitClaimDirectSend){event.preventDefault();run(()=>sendVisitClaimNow(button.dataset.visitClaimDirectSend,button));return;}
 if(button.dataset.visitPostAndSend){event.preventDefault();run(()=>postVisitChargesAndSend());return;}
 if(button.dataset.visitClaimSend||button.dataset.visitClaimFix){event.preventDefault();run(async()=>{const account=encounterChargeAccount();if(!account)throw new Error('Open the encounter for these charges first.');const id=button.dataset.visitClaimSend||button.dataset.visitClaimFix;await showEncounterClaim(id,account.id);if(button.dataset.visitClaimFix&&typeof claimCurrent!=='undefined'&&claimCurrent?.id===id&&claimCurrent.status==='draft'){if(typeof openClaimQuickFix==='function'&&openClaimQuickFix())return;claimEditor(claimCurrent.snapshot.account,claimCurrent);}else{
  // The claim's own next step (its Send claim button) is folded away on the Billing tab while the
  // review panel does the sending. When this button is the way in (no review panel for this
  // session), show it, or the press lands on a claim with nothing to press.
  const host=$('encounter-claims');host?.setAttribute?.('data-claim-send-open','');
  const step=host?.querySelector?.('[data-claim-primary]');(step||host)?.scrollIntoView?.({block:'start'});
  step?.querySelector?.('.claim-primary-buttons button')?.focus?.({preventScroll:true});
 }});return;}
 if(button.hasAttribute('data-visit-statement')){event.preventDefault();run(()=>openVisitStatement());return;}
 if(button.dataset.visitStatementOpen){event.preventDefault();run(async()=>{const view=hostedCopayView(),invoice=await api(`/api/v1/billing/invoices/${encodeURIComponent(button.dataset.visitStatementOpen)}`);if(!currentHostedCopayView(view,false))return;if(invoice.patient_id!==view.patient||invoice.account_id!==encounterChargeAccount()?.id)throw new Error('This statement does not belong to the open visit.');showVisitStatement(invoice);});return;}
 if(button.hasAttribute('data-visit-statement-close')){event.preventDefault();const sheet=button.closest?.('dialog.sheet-dialog');if(sheet&&typeof sheetClose==='function')sheetClose(sheet);$('encounter-billing-editor')?.replaceChildren();return;}
 if(button.dataset.visitHistory){event.preventDefault();openVisitHistory(button.dataset.visitHistory);return;}
 if(button.dataset.visitHistoryFilter){event.preventDefault();openVisitHistory(button.dataset.visitHistoryFilter);return;}
 if(button.hasAttribute('data-revenue-documentation')){event.preventDefault();setEncounterSection('documentation');return;}
 if(button.dataset.visitPostCharges){event.preventDefault();run(()=>postVisitChargesFromCard());return;}
 if(button.dataset.revenueAccount){event.preventDefault();if(billingSelected!==button.dataset.revenueAccount||!$('encounter-billing-detail')?.innerHTML)showBillingAccount(button.dataset.revenueAccount,false);const details=$('encounter-charge-details');if(details)details.open=true;$('encounter-billing-detail')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
 if(button.dataset.revenueClaim||button.dataset.revenueRemittance){event.preventDefault();run(async()=>{if(button.dataset.revenueClaim){const account=encounterChargeAccount();if(!account)throw new Error('Select the encounter charge account.');await showEncounterClaim(button.dataset.revenueClaim,account.id);}else{await showClaimsWorkspace();await showEra(button.dataset.revenueRemittance);}});return;}
 if(button.dataset.revenueInvoice||button.dataset.revenueInvoices){event.preventDefault();billingSelected=button.dataset.revenueInvoice||button.dataset.revenueInvoices;run(async()=>{if(button.dataset.revenueInvoice)patientInvoiceEditor();else await showPatientInvoices();});return;}
 if(button.dataset.paymentGroup){event.preventDefault();run(()=>showPaymentGroupReceipt(button.dataset.paymentGroup,button.dataset.appointment));return;}
 if(button.dataset.copayReceipt){event.preventDefault();run(()=>showCopayReceipt(button.dataset.copayReceipt,button.dataset.appointment));return;}
 if(button.hasAttribute('data-print-copay-card')){event.preventDefault();printCopayReceiptCard(button.closest('[data-copay-receipt-view]'),button).catch(()=>{button.disabled=false;});return;}
 if(button.dataset.copayAccount){event.preventDefault();run(()=>openEncounterBillingAccount(button.dataset.copayAccount));return;}
 if(button.hasAttribute('data-record-copay')){event.preventDefault();openCopayReceiptEditor(button.dataset.recordCopay);return;}
 if(button.hasAttribute('data-encounter-charges')){event.preventDefault();openEncounterCharges();return;}
 if(button.hasAttribute('data-encounter-charges-correct')){event.preventDefault();const account=encounterChargeAccount();if(account?.status==='posted'){billingSelected=account.id;showBillingAccount(account.id,false);accountEditor(account,null,true,{correction:true});}return;}
 if(button.dataset.copayVoid){event.preventDefault();openBillingEditor(`<form id="copay-void-form" data-receipt="${esc(button.dataset.copayVoid)}"><h3>Correct an unapplied receipt</h3><p>This voids the recorded receipt. It does not refund cash, a check or an external card payment.</p><label>Correction reason<input name="reason" required maxlength="1000"></label><button type="submit">Void recorded receipt</button></form>`);return;}
 if(button.hasAttribute('data-apply-copays')){event.preventDefault();run(async()=>{const account=workspace.billing.accounts.find(a=>a.id===billingSelected),patient=selected,identity=me,visit=activeVisit?.id,section=chartSection;if(!account)throw new Error('Open the encounter account before applying its copay.');const result=await api(`${billingBase()}/${account.id}/copays/apply`,'POST',{},account.version);if(selected!==patient||me!==identity||activeVisit?.id!==visit)return;await selectPatient(patient,visit);if(selected!==patient||me!==identity||activeVisit?.id!==visit)return;showChartSection(section);if(section==='visits'&&typeof setEncounterSection==='function')setEncounterSection('charges');notice(`${money(result.applied_cents)} of recorded copay credit applied.`);});}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(!['copay-receipt-form','copay-void-form'].includes(form.id))return;event.preventDefault();
 run(async()=>{const data=Object.fromEntries(new FormData(form)),patient=selected,identity=me,visit=typeof activeVisit!=='undefined'?activeVisit?.id:null,section=chartSection;
 if(form.revenueIdentity&&form.revenueIdentity!==me||form.dataset.patient&&form.dataset.patient!==patient||form.dataset.visit&&form.dataset.visit!==visit)throw new Error('This copay form belongs to a different visit. Open it again for the selected visit.');
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
 return `<div class="timeline-row"><div><b>${operation.livemode?(options.modeShown?'LIVE · ':''):(options.modeShown?'':testPaymentTag(' · '))}${money(operation.amount_cents)} · ${esc(labels[operation.status]||'Payment status unknown')}</b><small>${esc(date(operation.created_at))}</small>${operation.refunded_cents?`<small>Verified refunds ${money(operation.refunded_cents)} · Net received ${money(operation.amount_cents-operation.refunded_cents)}</small>`:''}${operation.status==='needs_review'?'<small>Do not collect this amount again until the processor status is resolved.</small>':''}${operation.status==='paid'&&!operation.receipt_id?'<small>Payment was received; the receipt still needs reconciliation. Check payment status.</small>':''}</div><div class="actions">${url?`<a class="button ${options.primary?'primary':''}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Continue to secure checkout</a>`:''}${operation.receipt_id&&!options.receiptShown?`<button type="button" ${options.primary?'class="primary"':''} data-hosted-copay-receipt="${esc(operation.receipt_id)}" data-appointment="${esc(operation.appointment_id)}">View / print receipt</button>`:''}${waitingOnReader?`<button type="button" data-watch-reader-copay="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Show progress</button><button type="button" data-cancel-reader-copay="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Cancel payment</button>`:''}${openLink&&!operation.cancel_requested?`<button type="button" data-cancel-copay-link="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Cancel link</button>`:''}${operation.status!=='expired'&&!options.hideRefresh?`<button type="button" data-refresh-hosted-copay="${esc(operation.id)}" data-appointment="${esc(operation.appointment_id)}">Refresh payment status</button>`:''}</div></div>`;
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
 const setup=!state.availability?.available?(me?.role==='owner'?'<p><button type="button" data-payment-settings>Set up card payments</button></p>':'<p class="muted">Ask the practice owner to set up card payments.</p>'):'';
 const historyContent=`${received&&!pending&&!state.uncertain?collect:''}${historyReceipts.length?copayReceiptMarkup(historyReceipts,{modeShown:test,encounter}):''}${history.map(item=>hostedCopayOperationMarkup(item,{modeShown:test,hideRefresh:true})).join('')}${state.uncertain&&state.retry?`<button type="button" data-retry-hosted-copay="${esc(state.appointment)}">${state.retry.reader_id?`Send the same ${money(state.retry.amount_cents)} payment to the reader`:state.retry.saved_card_setup_id?`Check the ${money(state.retry.amount_cents)} card charge`:`Retry the same ${money(state.retry.amount_cents)} checkout request`}</button>`:''}`;
 // On the encounter's billing card these are the ways to collect; cash or check sits beside them.
 if(encounter){
  // Staff see that the reader is off before they start a payment that cannot reach it.
  const known=hostedCopayState.readers,readerOffline=Array.isArray(known)&&known.length>0&&!known.some(reader=>reader.online);
  const options=state.availability?.available?`<div class="actions visit-billing-collect-options"><button type="button" data-reader-copay="${esc(state.appointment)}" ${available?'':'disabled'}${readerOffline?' title="The reader is offline. Check that it is switched on."':''}>Card on reader${readerOffline?' · offline':''}</button><button type="button" data-saved-card-copay="${esc(state.appointment)}" ${available?'':'disabled'}>Card on file</button><button type="button" data-collect-card-copay="${esc(state.appointment)}" ${available?'':'disabled'}>Online payment link</button>${typeof billingCan==='function'&&billingCan('create')?`<button type="button" data-record-copay="${esc(state.appointment)}">Cash or check</button>`:''}</div>`:'';
  const earlier=`${receipts.length?copayReceiptMarkup(receipts,{modeShown:test,encounter}):''}${history.map(item=>hostedCopayOperationMarkup(item,{modeShown:test,hideRefresh:true})).join('')}${state.uncertain&&state.retry?`<button type="button" data-retry-hosted-copay="${esc(state.appointment)}">${state.retry.reader_id?`Send the same ${money(state.retry.amount_cents)} payment to the reader`:state.retry.saved_card_setup_id?`Check the ${money(state.retry.amount_cents)} card charge`:`Retry the same ${money(state.retry.amount_cents)} checkout request`}</button>`:''}`;
  // The lone "Test payment" line used to sit here above the payments; the Collect payment window
  // now carries the same fact as a small badge beside its title, so the list keeps no line of it.
  return `${state.uncertain?'<p role="status">The previous request has an uncertain result. Check its status before collecting again.</p>':''}${state.error?'<p role="status">Card payment status is unavailable. Check its status before collecting.</p>':!state.availability?'<p class="muted">Loading card payment options…</p>':!state.availability.available?`<p class="muted">Card payments aren’t set up yet.</p>`:''}${setup}${active.map(item=>hostedCopayOperationMarkup(item,{modeShown:test,hideRefresh:true,receiptShown:receiptIds.has(item.receipt_id)})).join('')}${options}${state.items.length||state.uncertain||state.error?`<button type="button" class="text-button" ${refresh?`data-refresh-hosted-copay="${esc(refresh.id)}" data-appointment="${esc(state.appointment)}"`:`data-refresh-hosted-copay-list="${esc(state.appointment)}"`}>Check card payment status</button>`:''}${earlier?`<details class="encounter-account-record" data-hosted-disclosure="history"><summary>Payments taken for this encounter</summary>${earlier}</details>`:''}`;
 }
 return `${test&&typeof testPaymentLabel==='function'&&testPaymentLabel()?`<p class="copay-mode-label">${testPaymentLabel()}</p>`:''}${state.uncertain?'<p role="status">The previous request has an uncertain result. Check its status before collecting again.</p>':''}${state.error?'<p role="status">Card payment status is unavailable. Check its status before collecting.</p>':!state.availability?'<p class="muted">Loading card payment availability…</p>':!state.availability.available?`<p class="muted">${esc(state.availability.reason||'Card collection is unavailable for this practice.')}</p>`:''}${setup}${active.map(item=>hostedCopayOperationMarkup(item,{modeShown:test,primary:!encounter,hideRefresh:true,receiptShown:receiptIds.has(item.receipt_id)})).join('')}${currentReceipts.length?copayReceiptMarkup(currentReceipts.slice(0,1),{modeShown:test,primary:!encounter&&!pending,encounter}):''}${!received&&!pending&&!state.uncertain?collect:''}<button type="button" class="text-button" ${refresh?`data-refresh-hosted-copay="${esc(refresh.id)}" data-appointment="${esc(state.appointment)}"`:`data-refresh-hosted-copay-list="${esc(state.appointment)}"`}>Check payment status</button>${historyContent?`<details class="${encounter?'encounter-account-record':'insurance-supporting-records'}" data-hosted-disclosure="history"><summary>${encounter?'Card payment details':'Payment history'}${received?' &amp; additional collection':''}</summary>${historyContent}</details>`:''}`;
}
function encounterHostedCopayMarkup(state){return hostedCopayMarkup(state,true);}
function paintHostedCopayState(state){
 if(!currentHostedCopayState(state))return;
 for(const id of ['insurance-hosted-copay','encounter-hosted-copay','hosted-copay-operation']){const node=$(id);if(node?.dataset.appointment===state.appointment){const expanded=node.querySelector?.('[data-hosted-disclosure]')?.open;node.innerHTML=hostedCopayMarkup(state,id==='encounter-hosted-copay');const details=node.querySelector?.('[data-hosted-disclosure]');if(details)details.open=!!expanded;}}
 // A card payment that is waiting or uncertain must stay in view on the encounter's billing card.
 const collect=$('visit-billing-collect');if(collect&&$('encounter-hosted-copay')?.dataset.appointment===state.appointment&&(state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))))collect.hidden=false;
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
// staff stay on the encounter billing step or the Insurance tab they were on. In the Collect
// payment window the panel stays blank until its tab is pressed (data-collect-holder).
async function openHostedCopayEditor(appointmentId,panelId,attemptedCents){
 const holder=collectDialog?.querySelector('[data-collect-holder]'),view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)?attemptedCents:visitCollectAmount(appointmentId,plan);
 if(holder)holder.innerHTML=`<form id="hosted-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Send a payment link</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p>${plan==null?'No plan copay has been recorded. Confirm the amount for this encounter.':'Recorded plan copay: '+money(plan)+'. Confirm the benefit and amount before collection.'}</p><label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label><p class="muted">Card details are entered on a secure checkout page. A receipt appears only after SunCharts verifies payment. Returning from checkout alone does not record a payment.</p><button type="submit" class="primary">Prepare secure card checkout</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`;
 else drawReaderCopay(panelId,`<form id="hosted-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Collect card copay${state.availability.livemode?'':testPaymentTag()&&' · '+testPaymentTag()}</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p>${plan==null?'No plan copay has been recorded. Confirm the amount for this encounter.':'Recorded plan copay: '+money(plan)+'. Confirm the benefit and amount before collection.'}</p><label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label><p class="muted">Card details are entered on a secure checkout page. A receipt appears only after SunCharts verifies payment. Returning from checkout alone does not record a payment.</p><button type="submit" class="primary">Prepare secure card checkout</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`);
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
 const holder=collectDialog?.querySelector('[data-collect-holder]'),view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 const readers=await readersForPayment();if(!readers||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)?attemptedCents:visitCollectAmount(appointmentId,plan),test=!state.availability.livemode&&typeof testPaymentLabel==='function'?testPaymentLabel():'';
 hostedCopayState.readers=readers;
 const form=`<form id="reader-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Take card payment on reader</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}${test?' · '+test:''}</p>${plan==null?'':`<p>Recorded plan copay: ${money(plan)}.</p>`}<label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label>${readerChoiceMarkup(readers)}<p class="muted">The patient taps, inserts or swipes their card on the reader.</p><button type="submit" class="primary">Take payment</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`;
 if(holder)holder.innerHTML=form;else drawReaderCopay(panelId,form);
}
// Charging a card on file uses the same slot under the copay controls: the form, the amount
// check and the result all stay where the button was pressed.
async function openSavedCardCopayEditor(appointmentId,panelId,attemptedCents){
 const holder=collectDialog?.querySelector('[data-collect-holder]'),view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 const found=await savedCardsForCharge(state.patient);if(!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)?attemptedCents:visitCollectAmount(appointmentId,plan),test=state.availability.livemode?'':testPaymentTag();
 hostedCopayState.savedCards=found.cards;
 const form=`<form id="saved-card-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Charge card on file</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}${test?' · '+test:''}</p>${plan==null?'':`<p>Recorded plan copay: ${money(plan)}.</p>`}${found.cards.length?`<label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label>`:''}${savedCardChoiceMarkup(found)}${found.cards.length?'<p class="muted">The patient does not need to be here.</p><button type="submit" class="primary">Review charge</button>':''}<button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`;
 if(holder)holder.innerHTML=form;else drawReaderCopay(panelId,form);
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
  finished:done=>{if(collectDialog&&['paid','refunded'].includes(done.status))collectPartTaken(done.amount_cents,'card on file',done.receipt_id?{id:done.receipt_id}:null,done.appointment_id,{kind:'card'});},
  approved:paid=>paid.receipt_id&&!collectDialog?`<button type="button" class="primary" data-hosted-copay-receipt="${esc(paid.receipt_id)}" data-appointment="${esc(paid.appointment_id)}">View / print receipt</button>`:'',
  // One press makes the card link for the same amount; it appears in the copay list above.
  link:async declined=>{if(!currentHostedCopayState(state))return;const made=await api(hostedCopayBase(state),'POST',{request_id:crypto.randomUUID(),amount_cents:declined.amount_cents,coverage_id:state.savedCardCoverage||null,livemode:declined.livemode===true,reason:'Card link sent after the bank asked the patient to confirm',...collectCardFields(declined.amount_cents,state.appointment)});if(!currentHostedCopayState(state))return;acceptHostedCopayOperation(state,made.operation);stopSavedCardPayment();const slot=readerCopaySlot(panelId);if(slot)slot.innerHTML='<p role="status">Card link created. Open it or send it from the copay list.</p>';}});
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
 watchReaderPayment({operation,readerName:reader?.name,statusUrl:base,cancelUrl:`${base}/reader-cancel`,simulateUrl:`${base}/reader-simulate-tap`,simulated:reader?.simulated===true,
  // Try again keeps the amount that was just attempted.
  again:()=>openReaderCopayEditor(state.appointment,panelId,operation.amount_cents),
  finished:done=>{if(collectDialog&&['paid','refunded'].includes(done.status))collectPartTaken(done.amount_cents,'card on the reader',done.receipt_id?{id:done.receipt_id}:null,done.appointment_id,{kind:'card'});},
  accept:next=>{if(currentHostedCopayState(state))acceptHostedCopayOperation(state,next);},
  approved:paid=>paid.receipt_id&&!collectDialog?`<button type="button" class="primary" data-hosted-copay-receipt="${esc(paid.receipt_id)}" data-appointment="${esc(paid.appointment_id)}">View / print receipt</button>`:''});
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
// A payment still waiting on the reader can be brought back on screen after a reload or after
// coming back to the encounter: the same steps, Cancel, and the test tap where it applies.
async function watchReaderCopay(appointment,id,panelId){
 const state=hostedCopayStateFor(appointment),operation=state.items.find(item=>item.id===id);if(!operation)throw new Error('Refresh the appointment’s card payment list first.');
 if(!hostedCopayState.readers){try{hostedCopayState.readers=(await api('/api/v1/billing/payments/readers')).readers||[];}catch{hostedCopayState.readers=[];}}
 if(!currentHostedCopayState(state))return;
 showReaderCopay(state,operation,panelId);
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
 if(button.dataset.watchReaderCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay')?.id;run(()=>watchReaderCopay(button.dataset.appointment,button.dataset.watchReaderCopay,panel));return;}
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
 await createReaderCopay(state,{request_id:form.dataset.request,amount_cents:cents(data.amount),coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Appointment copay taken on card reader',reader_id:data.reader,...collectCardFields(cents(data.amount),state.appointment)},form.dataset.panel||undefined);
 });
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='saved-card-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 if(!data.card)throw new Error('Choose a card on file.');
 const amount=cents(data.amount);if(!Number.isSafeInteger(amount)||amount<50)throw new Error('Enter the copay amount.');
 confirmSavedCardCopay(state,{request_id:form.dataset.request,amount_cents:amount,coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Copay charged to card on file',saved_card_setup_id:data.card,...collectCardFields(amount,state.appointment)},form.dataset.panel||undefined);
 });
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='hosted-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 const body={request_id:form.dataset.request,amount_cents:cents(data.amount),coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Reviewed appointment copay before hosted card collection',...collectCardFields(cents(data.amount),state.appointment)};
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
// The encounter's invoice is one record shown in tabs: Invoice (diagnoses, line items, totals and the
// next step), Claim, Payments and History. The tab last used is remembered, so moving between
// visits and patients comes back to the same place instead of a long scroll.
const invoiceTabs=[['note','Note'],['billing','Billing'],['history','History']];
// The tabs that belong to billing; only these are remembered from one encounter to the next.
const encounterBillingTabs=['billing','history'];
// Older names of the tabs, kept so saved places and links still land: codes and the claim are on
// Billing, invoices are statements on Payments.
// Payments are a section of Billing; the encounter summary and follow-up close the Note.
const encounterTabAliases={checkout:'note',encounter:'billing',invoice:'billing',codes:'billing',claim:'billing',invoices:'billing',payments:'billing'};
// The tab open on the encounter on the screen, kept while that encounter is re-drawn after a save.
let encounterTabFor={visit:null,key:null};
// The Billing tab shows one area at a time: the codes, the claim details, the payments, the claim.
// The next step and the money stay above them. The area used last is remembered.
const billingParts=[['details','Claim details'],['payments','Payments'],['claim','Claim']],billingPartKeys=['summary','codes','details','payments','claim'];
// Billing opens on its one-column summary. An area opened from it (claim details, payments, the
// claim) takes its place, with one way back.
function billingPartsMarkup(){return `<nav class="billing-parts" aria-label="Billing for this encounter"><button type="button" data-billing-part-key="summary">← Billing</button><b data-billing-part-title></b></nav>`;}
// The area open on the encounter on the screen is kept while that encounter is re-drawn; another
// encounter starts on the summary.
let billingPartFor={visit:null,key:'summary'};
function billingPartRemembered(){const visit=typeof activeVisit!=='undefined'&&activeVisit?activeVisit.id:null;return visit&&billingPartFor.visit===visit?billingPartFor.key:'summary';}
function billingPartSet(key,remember=true){
 const host=typeof $==='function'?$('encounter-revenue'):null;if(!host?.dataset||!billingPartKeys.includes(key))return;
 host.dataset.billingPart=key;
 if(typeof motionIn==='function')motionIn($('encounter-revenue-status'));
 if(key!=='codes'){const visit=typeof activeVisit!=='undefined'&&activeVisit?activeVisit.id:null;billingPartFor={visit,key};}
 const title=typeof host.querySelector==='function'?host.querySelector('[data-billing-part-title]'):null;
 if(title)title.textContent=(billingParts.find(([k])=>k===key)||[])[1]||'';
 if(key!=='codes')encounterCodesStripRender();
 if(key==='details'&&typeof encounterDetailsSummaryRender==='function')encounterDetailsSummaryRender();
 // Payments is never an empty screen: before any charge exists there is no payments table yet,
 // so the panel that lists the payments taken and offers another one is shown in its place.
 if(key==='payments'&&!$('visit-billing-payments')&&!$('visit-billing-invoices')){const panel=$('visit-billing-collect');if(panel)panel.hidden=false;}
 if(key==='payments')visitCollectHeading();
}
// The codes on this encounter, read-only, on every tab: diagnoses (ICD-10) then procedures (CPT).
// The Codes area of Billing shows them in full, so the strip steps aside there.
function encounterCodesStripMarkup(evidence){
 const list=evidence?.diagnoses,lines=evidence?.lines||[],letter=i=>typeof visitDiagnosisLetter==='function'?visitDiagnosisLetter(i):String.fromCharCode(65+i);
 const diagnoses=!evidence||list===null||list===undefined?'<p class="muted">Diagnoses could not be loaded.</p>':list.length?`<ol>${list.map((d,i)=>`<li><b>${letter(i)}</b> <span class="codes-strip-code">${esc(String(d.code).trim())}</span> <span>${esc(d.display||'')}</span>${i===0?' <span class="muted">primary</span>':''}</li>`).join('')}</ol>`:'<p class="muted">No diagnoses yet.</p>';
 const total=lines.reduce((sum,line)=>sum+(Number(line.amount_cents)||0),0);
 const procedures=lines.length?`<ol>${lines.map(line=>`<li><span class="codes-strip-code">${esc(line.code||'')}${line.modifiers?'-'+esc(String(line.modifiers).trim().replace(/[,\s]+/g,'-')):''}</span> <span>${esc(line.description||'')}${Number(line.units)>1?` × ${esc(line.units)}`:''}</span><span class="codes-strip-amount">${line.amount_cents==null?'':money(line.amount_cents)}</span></li>`).join('')}</ol><p class="codes-strip-total"><span>Total charges</span><b>${money(total)}</b></p>`:'<p class="muted">No procedures yet.</p>';
 const any=(list&&list.length)||lines.length;
 return `<div class="codes-strip-col"><h4>Diagnoses (ICD-10)</h4>${diagnoses}</div><div class="codes-strip-col"><h4>Procedures (CPT)</h4>${procedures}</div><div class="codes-strip-actions"><button type="button" class="${any?'text-button':'primary'}" data-codes-strip-edit>${any?'Edit codes':'Add codes'}</button><button type="button" class="text-button" data-codes-strip-cms hidden>Preview CMS-1500</button></div>`;
}
// The claim form is offered beside the codes once this encounter has a claim to show.
function encounterCodesStripClaimSync(){
 const button=typeof $==='function'?$('encounter-codes-strip')?.querySelector?.('[data-codes-strip-cms]'):null;if(!button)return;
 const claim=encounterRevenueState.data?.summary?.claim,id=claim?.id&&claim.status!=='void'&&!claim.secondary&&!claim.crossover?claim.id:'';
 button.hidden=!id;button.dataset.codesStripCms=id;
}
// The CMS-1500 view of the claim, opened over the page. Looking at it sends nothing.
async function openClaimFormPreview(claimId){
 const response=await fetch(`/api/v1/billing/claims/${encodeURIComponent(claimId)}/cms1500`,{credentials:'same-origin'});
 if(!response.ok)throw new Error('The claim form could not be opened. Refresh the encounter and try again.');
 // The form's own zoom and print buttons need its script, which a preview does not run; the sheet has Print.
 const html=(await response.text()).replace(/<div class=preview-actions[\s\S]*?<\/div>/,'');
 const dialog=openReceiptPreview(html,'Claim form (CMS-1500)'),frame=dialog.querySelector('iframe');
 // Open fitted to the window: the whole width of the form is visible without scrolling sideways.
 const fit=()=>{
  const page=frame.contentDocument?.documentElement;if(!page)return;
  frame.style.transform='';frame.style.width='11.2in';frame.style.height='auto';
  const width=page.scrollWidth,height=page.scrollHeight,room=frame.parentElement.clientWidth,scale=Math.min(1,room/width);
  frame.style.width=`${width}px`;frame.style.height=`${height}px`;frame.style.transformOrigin='top left';frame.style.transform=`scale(${scale})`;
  frame.style.marginBottom=`${Math.round(height*(scale-1))}px`;frame.style.marginRight=`${Math.round(width*(scale-1))}px`;frame.style.maxWidth='none';
 };
 frame.addEventListener('load',()=>{fit();setTimeout(fit,300);});
}
let encounterCodesStripToken=0;
async function encounterCodesStripRender(){
 const strip=typeof $==='function'?$('encounter-codes-strip'):null,visit=typeof activeVisit!=='undefined'?activeVisit:null;if(!strip?.isConnected||!visit)return;
 const token=++encounterCodesStripToken;
 if(!strip.innerHTML)strip.innerHTML=typeof skeletonMarkup==='function'?skeletonMarkup('card'):'<p class="muted">Loading codes…</p>';
 const evidence=await visitReceiptEvidence(visit.appointment_id);
 if(token!==encounterCodesStripToken||(typeof activeVisit!=='undefined'?activeVisit:null)!==visit)return;
 const node=$('encounter-codes-strip');if(node){node.innerHTML=encounterCodesStripMarkup(evidence);encounterCodesStripClaimSync();}
 encounterCodesEvidence={visit:visit.id,evidence};billingRowCodesFill();
}
// The Charges row of the Billing column names the codes behind the amount.
let encounterCodesEvidence={visit:null,evidence:null};
function billingRowCodesFill(){
 const node=typeof $==='function'?$('encounter-revenue-status')?.querySelector?.('[data-billing-row-codes]'):null,visit=typeof activeVisit!=='undefined'?activeVisit:null;
 if(!node||!visit||encounterCodesEvidence.visit!==visit.id)return;
 const evidence=encounterCodesEvidence.evidence,lines=evidence?.lines||[],diagnoses=evidence?.diagnoses||[];
 const host=node.parentElement;if(!host?.insertAdjacentHTML)return;
 host.querySelector('.billing-row-lines')?.remove();
 if(!lines.length&&!diagnoses.length)return;
 // The diagnoses first, then each charge billed under them on its own line with its amount.
 const items=lines.map(line=>`<li><span class="codes-strip-code">${esc(String(line.code||'').trim())}${line.modifiers?'-'+esc(String(line.modifiers).trim().replace(/[,\s]+/g,'-')):''}</span><span>${esc(line.description||'')}${Number(line.units)>1?` × ${esc(line.units)}`:''}</span><b>${line.amount_cents==null?'':money(line.amount_cents)}</b></li>`).join('');
 const dx=diagnoses.length?`<p class="billing-row-dx"><span class="muted">Diagnoses</span> ${diagnoses.map(d=>`<span class="codes-strip-code">${esc(String(d.code).trim())}</span> ${esc(d.display||'')}`).join(' · ')}</p>`:'';
 host.insertAdjacentHTML('beforeend',`<div class="billing-row-lines">${dx}${items?`<ul>${items}</ul>`:''}</div>`);
}
// Put the strip under the encounter tabs and the Billing areas under the next step.
function encounterBillingChrome(host){
 if(!host?.querySelector||typeof document==='undefined'||typeof document.createElement!=='function')return;
 const tabs=host.querySelector('.invoice-tabs'),status=host.querySelector('#encounter-revenue-status');
 if(tabs&&typeof tabs.after==='function'&&!host.querySelector('#encounter-codes-strip')){const strip=document.createElement('section');strip.id='encounter-codes-strip';strip.className='encounter-codes-strip';strip.setAttribute('aria-label','Codes on this encounter');tabs.after(strip);}
 if(status&&typeof status.insertAdjacentHTML==='function'&&!host.querySelector('.billing-parts'))status.insertAdjacentHTML('afterend',billingPartsMarkup());
 if(tabs&&!host.querySelector('.codes-editor-bar'))tabs.insertAdjacentHTML?.('beforebegin','<div class="codes-editor-bar"><h3>Edit codes</h3><button type="button" data-codes-editor-close aria-label="Close without checking">Close</button></div>');
 if(!host.querySelector('.codes-editor-foot'))host.insertAdjacentHTML?.('beforeend','<div class="codes-editor-foot"><p class="muted" data-codes-editor-state role="status">Diagnoses and procedures save as you go.</p><button type="button" class="primary" data-codes-editor-save>Save and close</button></div>');
 billingPartSet(host.dataset?.codesEditing!==undefined?'codes':billingPartRemembered(),false);
 if(!host.querySelector('#encounter-details-summary')){const parts=host.querySelector('.billing-parts');parts?.insertAdjacentHTML?.('afterend','<section id="encounter-details-summary" class="encounter-details-summary" hidden></section>');}
 encounterDetailsSummaryRender();
 encounterBarWatch(host);encounterBarSync();
}
// Editing the codes happens over the page: the diagnoses and the procedure lines open as a panel on
// top of whatever tab is showing, and the page under it does not move. Nothing is taken out of the
// page to do it, so saving and refreshing work as they always did.
function encounterCodesEditorOpen(tries=0,create=false,what='codes'){
 const host=typeof $==='function'?$('encounter-revenue'):null;if(!host?.dataset)return;
 if(!host.querySelector?.('#billing-account-form')){
  // No charges yet: open the encounter's charge table first, without leaving the tab that is showing.
  if(create&&tries===0&&typeof openEncounterCharges==='function'){const tab=host.dataset.invoiceTab;openEncounterCharges();if(tab&&$('encounter-revenue')?.dataset.invoiceTab!==tab)invoiceTabSet(tab,false);}
  if(tries<20){setTimeout(()=>encounterCodesEditorOpen(tries+1,create,what),100);return;}
  invoiceTabSet('billing');return;
 }
 if(host.dataset.codesEditing!==undefined)return;
 host.dataset.partBeforeEditing=host.dataset.billingPart||billingPartRemembered();
 // The same panel edits the codes or the claim details; it shows the one that was asked for.
 const details=what==='details';
 billingPartSet(details?'details':'codes',false);host.dataset.codesEditing=details?'details':'';
 const title=host.querySelector('.codes-editor-bar h3'),state=host.querySelector('[data-codes-editor-state]');
 if(title)title.textContent=details?'Edit claim details':'Edit codes';
 if(state)state.textContent=details?'Claim details save as you go.':'Diagnoses and procedures save as you go.';
 if(!details&&typeof renderEncounterDiagnoses==='function'&&!$('encounter-diagnoses')?.firstElementChild)renderEncounterDiagnoses();
 host.scrollTop=0;host.querySelector('[data-codes-editor-close]')?.focus?.({preventScroll:true});
}
// Save and close: save what is waiting (the diagnoses list, the procedure lines), and close only once
// it is all saved. Whatever stops a save is said in plain words beside the button.
async function encounterCodesEditorSave(){
 const host=typeof $==='function'?$('encounter-revenue'):null;if(!host)return;
 const say=text=>{const node=$('encounter-revenue')?.querySelector?.('[data-codes-editor-state]');if(node)node.textContent=text;};
 const diagnosesForm=()=>$('visit-diagnoses-form'),diagnosesDirty=()=>!!diagnosesForm()?.querySelector?.('[data-diagnosis-discard],[data-action="discard-diagnosis-draft"]')||/have not saved yet/.test(diagnosesForm()?.textContent||'');
 const chargeForm=()=>$('billing-account-form');
 const waiting=()=>{const form=chargeForm();return form&&typeof chargeTableWaiting==='function'?chargeTableWaiting(form):'';};
 say('Saving…');
 if(diagnosesDirty())diagnosesForm()?.requestSubmit?.();
 const form=chargeForm();
 if(form&&typeof chargeLiveRows==='function'&&chargeLiveRows(form).some(row=>(row.querySelector('[name="code"]')?.value||'').trim())){
  clearTimeout(form.chargeSaveTimer);form.chargeSaveTimer=null;
  if(typeof saveChargeTable==='function'&&form.dataset.autosave!=='off')await saveChargeTable(form);
 }
 for(let tries=0;tries<40;tries+=1){
  await new Promise(resolve=>setTimeout(resolve,150));
  const now=chargeForm(),failed=now?.querySelector?.('[data-charge-status] [data-retry-charge-save]');
  if(failed){say('The procedures could not be saved. The reason is shown under the table.');return;}
  if(!now?.dataset.chargeSaving&&!diagnosesDirty()){
   // Everything complete is saved. A line still missing something would be lost on closing, so say so and stay.
   const held=waiting();if(held){say(`Everything else is saved. ${held} Finish it or remove it to close.`);return;}
   say('Saved.');encounterCodesEditorClose();return;
  }
 }
 say(diagnosesDirty()?'The diagnoses are not saved yet. Check the list above, then try again.':'Still saving. Try again in a moment.');
}
function encounterCodesEditorClose(){
 const host=typeof $==='function'?$('encounter-revenue'):null;if(!host?.dataset||host.dataset.codesEditing===undefined)return;
 // In a browser the sheet eases out first; the page behind it is put back when that has played.
 if(typeof host.getAnimations==='function'&&!host.codesCloseNow){
  if(host.dataset.codesClosing!==undefined)return;
  host.dataset.codesClosing='';
  const finish=()=>{if(host.dataset.codesClosing===undefined)return;host.codesCloseNow=true;encounterCodesEditorClose();};
  host.addEventListener('animationend',event=>{if(event.target===host)finish();},{once:true});setTimeout(finish,260);return;
 }
 host.codesCloseNow=false;delete host.dataset.codesClosing;
 delete host.dataset.codesEditing;
 const back=host.dataset.partBeforeEditing;delete host.dataset.partBeforeEditing;
 billingPartSet(billingPartKeys.includes(back)&&back!=='codes'?back:billingPartRemembered(),false);encounterCodesStripRender();encounterDetailsSummaryRender();
}
// Claim details, read first. What the claim will carry besides its codes (who is billed, the date,
// the provider and place, and anything filled in beyond that) reads as a short list; Edit opens the
// same fields over the page. Only what has a value is listed, so an ordinary encounter stays short.
function encounterDetailsSummaryRows(form){
 const rows=[],seen=new Set();
 const scopes=form.querySelectorAll('[data-visit-charge-options],[data-charge-prior-auth],[data-encounter-provider],details.charge-more-options');
 for(const scope of scopes){
  for(const field of scope.querySelectorAll('input,select,textarea')){
   if(!field.name||seen.has(field.name)||field.type==='hidden'||['visit_id','coverage_id','fee_facility','fee_setting'].includes(field.name)||field.closest('[data-encounter-provider-fields]'))continue;
   const label=field.closest('label');if(!label)continue;
   let value='';
   if(field.type==='checkbox'||field.type==='radio'){if(!field.checked)continue;value='Yes';}
   else if(field.tagName==='SELECT')value=field.value?(field.selectedOptions?.[0]?.textContent||'').trim():'';
   else value=String(field.value||'').trim();
   if(!value)continue;
   if(field.type==='date'&&typeof visitBillingDate==='function')value=visitBillingDate(value);
   const name=[...label.childNodes].filter(node=>node.nodeType===3).map(node=>node.textContent).join(' ').replace(/\s+/g,' ').trim()||field.name;
   seen.add(field.name);rows.push([name,value]);
  }
 }
 return rows;
}
function encounterDetailsSummaryRender(){
 const host=typeof $==='function'?$('encounter-revenue'):null,node=typeof $==='function'?$('encounter-details-summary'):null;if(!host||!node)return;
 const form=host.querySelector?.('#billing-account-form');
 if(!form||typeof form.querySelectorAll!=='function'){if(!node.hidden){node.hidden=true;node.replaceChildren?.();node.summaryHtml='';}return;}
 const coverage=form.querySelector('.encounter-coverage-line'),provider=form.querySelector('[data-encounter-provider-summary]'),rows=encounterDetailsSummaryRows(form),locked=!!form.dataset.draftReadOnly;
 const html=`<div class="section-head"><h3>Claim details</h3>${locked?'':'<button type="button" data-details-edit>Edit claim details</button>'}</div>${coverage?`<p class="encounter-coverage-line">${coverage.innerHTML}</p>`:''}<dl class="encounter-details-list">${provider?provider.innerHTML:''}${rows.map(([name,value])=>`<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
 // Written only when it changed, so watching the page for changes never feeds itself.
 if(node.hidden)node.hidden=false;
 if(node.summaryHtml!==html){node.innerHTML=html;node.summaryHtml=html;}
}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('click',event=>{
  const part=event.target?.closest?.('[data-billing-part-key]');
  if(part?.dataset?.billingPartKey){
   event.preventDefault();billingPartSet(part.dataset.billingPartKey);
   // The Claim area opens this encounter's claim by itself; nobody has to find a button first.
   if(part.dataset.billingPartKey==='claim'&&$('encounter-claims')?.hidden&&typeof showEncounterClaim==='function'){
    const claim=encounterRevenueState?.data?.summary?.claim?.id,account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
    if(claim&&account)run(()=>showEncounterClaim(claim,account.id));
   }
   return;
  }
  if(event.target?.closest?.('[data-codes-strip-edit]')?.hasAttribute?.('data-codes-strip-edit')){event.preventDefault();encounterCodesEditorOpen(0,true);return;}
  const form=event.target?.closest?.('[data-claim-form-preview]');if(form?.dataset?.claimFormPreview){event.preventDefault();run(()=>openClaimFormPreview(form.dataset.claimFormPreview));return;}
  const cms=event.target?.closest?.('[data-codes-strip-cms]');if(cms?.hasAttribute?.('data-codes-strip-cms')){event.preventDefault();if(cms.dataset?.codesStripCms)run(()=>openClaimFormPreview(cms.dataset.codesStripCms));return;}
  if(event.target?.closest?.('[data-codes-editor-save]')?.hasAttribute?.('data-codes-editor-save')){event.preventDefault();run(()=>encounterCodesEditorSave());return;}
  if(event.target?.closest?.('[data-codes-editor-close]')?.hasAttribute?.('data-codes-editor-close')){event.preventDefault();encounterCodesEditorClose();return;}
  if(event.target?.closest?.('[data-details-edit]')?.hasAttribute?.('data-details-edit')){event.preventDefault();encounterCodesEditorOpen(0,false,'details');return;}
 });
 // A button whose work lands in another area opens that area first, so nothing happens out of sight.
 document.addEventListener('click',event=>{
  const button=event.target?.closest?.('button');if(!button?.closest?.('#encounter-revenue,#patient-banner,#encounter-bar'))return;
  const has=names=>names.some(name=>button.hasAttribute(name));
  if(has(['data-encounter-charges'])||button.dataset?.visitReviewFix==='line')setTimeout(()=>encounterCodesEditorOpen(),0);
  else if(has(['data-visit-claim-send','data-visit-claim-fix','data-visit-claim-prepare','data-visit-claim-resend','data-revenue-claim','data-claim-open','data-revenue-remittance']))billingPartSet('claim',false);
 },true);
 document.addEventListener('keydown',event=>{if(event.key!=='Escape'||document.querySelector?.('dialog[open]'))return;if($('encounter-revenue')?.dataset?.codesEditing!==undefined){event.preventDefault();encounterCodesEditorClose();}});
 // A field the browser refuses on save has to be on screen to be fixed.
 document.addEventListener('invalid',event=>{const field=event.target;if(!field?.closest?.('#billing-account-form'))return;if(field.closest('[data-visit-charge-options],[data-encounter-provider],details.charge-more-options')){if($('encounter-revenue')?.dataset?.codesEditing!=='details'){encounterCodesEditorClose();invoiceTabSet('billing');encounterCodesEditorOpen(0,false,'details');}}else if($('encounter-revenue')?.dataset?.codesEditing!==''){encounterCodesEditorClose();encounterCodesEditorOpen();}},true);
}
function invoiceTabsMarkup(){return `<nav class="invoice-tabs encounter-tabs" role="tablist" aria-label="This encounter">${invoiceTabs.map(([key,label])=>`<button type="button" role="tab" data-invoice-tab-key="${key}" aria-selected="false">${label}</button>`).join('')}</nav>`;}
// Which tab an encounter opens on: the one already open on it; the note while it is being written
// (Visit, Rooming, Notes, and the summary and follow-up that close it); otherwise the billing tab used last.
function invoiceTabRemembered(){
 const visit=typeof activeVisit!=='undefined'&&activeVisit?activeVisit.id:null;
 if(visit&&encounterTabFor.visit===visit&&encounterTabFor.key)return encounterTabFor.key;
 const step=typeof encounterSection==='undefined'?'charges':encounterSection;
 if(['visit','intake','documentation','checkout'].includes(step))return 'note';
 try{let key=localStorage.getItem('suncharts.invoiceTab');key=encounterTabAliases[key]||key;return encounterBillingTabs.includes(key)?key:'billing';}catch{return 'billing';}
}
function encounterTabForget(){encounterTabFor={visit:null,key:null};}
function invoiceTabSet(key,remember=true){
 key=encounterTabAliases[key]||key;
 const host=typeof $==='function'?$('encounter-revenue'):null;if(!host||!invoiceTabs.some(([k])=>k===key))return;
 host.dataset.invoiceTab=key;
 // The whole encounter page follows the tab: the note, checkout and the other encounters list
 // show only on their own tab, so nothing is stacked under anything else.
 const page=$('visit-page-host');if(page?.dataset)page.dataset.encounterTab=key;
 if(typeof motionIn==='function'&&page)motionIn(page);
 if(typeof activeVisit!=='undefined'&&activeVisit)encounterTabFor={visit:activeVisit.id,key};
 const buttons=typeof host.querySelectorAll==='function'?Array.from(host.querySelectorAll('[data-invoice-tab-key]')||[]):[];
 for(const button of buttons){if(!button?.dataset)continue;const on=button.dataset.invoiceTabKey===key;button.setAttribute?.('aria-selected',String(on));button.classList?.toggle('active',on);}
 if(remember&&encounterBillingTabs.includes(key))try{localStorage.setItem('suncharts.invoiceTab',key);}catch{}
 if(key==='history'){const history=$('visit-billing-history');if(history)history.open=true;}
 if(key==='billing')renderEncounterInvoices();
 if(typeof encounterCodesStripRender==='function')encounterCodesStripRender();
 // Billing: the codes are edited right there, and the insurance claim made from them sits below.
 if(key==='billing'){encounterChargeTableInline();encounterClaimMount();}
}
// The claim made from these codes, under them on the Billing tab. A patient without insurance has
// no claim, so nothing is shown.
let encounterClaimMounting=false;
function encounterClaimMount(){
 const claims=typeof $==='function'?$('encounter-claims'):null;if(!claims||!claims.hidden)return;
 const summary=encounterRevenueState?.data?.summary,claimId=summary?.claim?.id,account=encounterChargeAccount();
 if(claimId&&account&&typeof showEncounterClaim==='function'){if(encounterClaimMounting)return;encounterClaimMounting=true;run(async()=>{try{await showEncounterClaim(claimId,account.id);}finally{encounterClaimMounting=false;}});return;}
 if(summary&&summary.insurance?.insured===false)return;
 if(account?.status==='posted'||!summary)return;
 claims.hidden=false;claims.innerHTML='<p class="muted encounter-claim-pending">The insurance claim is made from these codes when the charges are posted.</p>';
}
// The live charge table, open on the Billing tab without an Edit button: rows are added and removed
// in place. Draft charges save as they are typed; posted charges take a correction, saved with one
// button that appears on the table itself.
function encounterChargeTableInline(){
 const editor=typeof $==='function'?$('encounter-billing-editor'):null;if(!editor||editor.querySelector?.('form'))return;
 if(typeof accountEditor!=='function'||typeof billingCan!=='function'||!billingCan('create'))return;
 const account=encounterChargeAccount();
 const quiet=typeof billingEditorQuiet!=='undefined';if(quiet)billingEditorQuiet=true;
 try{
  if(!account){if(typeof chargeTableAllowed==='function'&&chargeTableAllowed(null))accountEditor(null,null,true);return;}
  if(account.source_history_id)return;
  billingSelected=account.id;
  if(account.status==='draft')accountEditor(account,null,true);
  else if(account.status==='posted'&&account.content?.visit_id)accountEditor(account,null,true,{correction:true});
 }finally{if(quiet)billingEditorQuiet=false;}
}
// The bar's note-side steps: the Note tab, at the Sign button or at the summary and follow-up.
if(typeof document!=='undefined')document.addEventListener('click',event=>{
 const next=event.target?.closest?.('[data-encounter-next]')?.dataset?.encounterNext;if(!next)return;event.preventDefault();
 if(next==='finish'){if(typeof setEncounterSection==='function')setEncounterSection('checkout');return;}
 invoiceTabSet('note',false);
 const target=document.querySelector?.('#visit-editor [data-action="sign"]')||$('note-form')||$('visit-editor');
 target?.scrollIntoView?.({block:'center'});target?.focus?.({preventScroll:true});
});
document.addEventListener('click',event=>{const tab=event.target?.closest?.('[data-invoice-tab-key]');if(!tab?.dataset?.invoiceTabKey)return;event.preventDefault();invoiceTabSet(tab.dataset.invoiceTabKey);});
// The statements on the Payments tab: each one the balance the patient owed on the day it was given.
// The balance itself stays on the encounter.
function renderEncounterInvoices(){
 const host=typeof $==='function'?$('visit-billing-invoices'):null;if(!host)return;
 const summary=encounterRevenueState?.data?.summary,account=encounterChargeAccount();
 const statements=(summary?.timeline||[]).filter(event=>event.code==='statement'&&event.invoice_id);
 const owes=summary?.patient?.owes_now_cents,give=account?.status==='posted'&&billingCan('create')&&(owes==null||owes>0)?'<button type="button" data-visit-statement>Patient statement</button>':'';
 // A statement is the encounter's balance on paper for the patient, not a record of its own: the
 // charges are the codes, and payments always go to the encounter.
 host.innerHTML=`<div class="section-head"><div><h3>Statements</h3><p class="muted">${owes==null?'':owes>0?`The patient owes ${money(owes)}. `:'The patient owes nothing on this encounter. '}A statement shows the patient what they owe today.</p></div>${give}</div>${statements.length?`<ol class="encounter-invoice-list">${statements.map(event=>`<li><span><b>${esc(visitBillingDate(event.at))}</b><small>${event.amount_cents==null?'Statement':`Statement · ${money(event.amount_cents)} due`}</small></span><button type="button" data-visit-statement-open="${esc(event.invoice_id)}">View</button></li>`).join('')}</ol>`:''}`;
}

// ---- Collect payment, in one window ----------------------------------------------------------
// Every way a patient pays sits in one window over the encounter: cash, check, the card reader,
// a card on file, or a payment link. The reader and card flows are the existing ones, drawn in
// the window, so their live status is what staff watch while the patient pays. The window opens
// with no method chosen: a panel appears only once its tab is pressed.
const collectMethods=[['cash','Cash'],['check','Check'],['reader','Card reader'],['saved','Card on file'],['link','Payment link']];
let collectDialog=null;
// One payment can be taken in parts — card, then cash, then a check — against one amount to
// collect. Each method starts at what is left; the window lists what was taken.
let collectSession={target:null,owedAtOpen:null,taken:[],group:null,encounters:[],current:null,typed:false};
// Every part taken while the window is open carries the same id, so the parts read as one payment.
function collectGroupField(){return collectDialog&&collectSession.group?{payment_group_id:collectSession.group}:{};}
// A payment can cover other encounters the patient owes for. The open encounter comes first,
// then the others, oldest first; each takes up to what it still owes.
function collectChosen(){return (collectSession.encounters||[]).filter(e=>e.on);}
function collectOthers(){return (collectSession.encounters||[]).some(e=>e.appointment!==collectSession.current);}
function collectChosenLeft(){return collectChosen().reduce((sum,e)=>sum+Math.max(0,e.owes-e.paid),0);}
function collectParts(amount){
 if(!collectOthers()||!Number.isSafeInteger(amount)||amount<=0)return null;
 const rows=collectChosen();if(!rows.length)return null;
 let left=amount;const parts=[];
 for(const e of rows){const take=Math.min(left,Math.max(0,e.owes-e.paid));if(take>0){parts.push({appointment_id:e.appointment,amount_cents:take});left-=take;}}
 // Anything beyond what the chosen encounters owe stays with the first of them, as credit.
 if(left>0){const first=parts.find(part=>part.appointment_id===rows[0].appointment);if(first)first.amount_cents+=left;else parts.unshift({appointment_id:rows[0].appointment,amount_cents:left});}
 return parts;
}
// What a card request carries: the payment it belongs to and, when it pays for other
// encounters, how much goes to each.
function collectCardFields(amount,appointment){
 const out=collectGroupField();if(!collectDialog)return out;
 const parts=collectParts(amount);
 if(parts&&!(parts.length===1&&parts[0].appointment_id===appointment))out.splits=parts;
 return out;
}
function collectEncounterLabel(appointmentId){
 const visit=(workspace.visits||[]).find(v=>v.appointment_id===appointmentId),appointment=(workspace.appointments||[]).find(a=>a.id===appointmentId);
 const number=typeof encounterNumberText==='function'?encounterNumberText(visit):'',date=appointment?.starts_at&&typeof visitBillingDate==='function'?visitBillingDate(appointment.starts_at):'';
 return [number,date].filter(Boolean).join(' · ')||'Encounter';
}
function collectEncountersMarkup(){
 const rows=collectSession.encounters||[];if(!collectOthers())return '';
 // Encounters already paid in this window are shown as paid and no longer counted.
 const open=rows.filter(e=>e.owes-e.paid>0),chosen=open.filter(e=>e.on),all=open.length>0&&chosen.length===open.length;
 return `<fieldset class="collect-encounters"><legend>Pay for</legend>${rows.map(e=>{const left=Math.max(0,e.owes-e.paid);return `<label class="collect-encounter${left?'':' is-paid'}"><input type="checkbox" data-collect-encounter="${esc(e.appointment)}"${e.on?' checked':''}${left?'':' disabled'}><span>${esc(collectEncounterLabel(e.appointment))}${e.appointment===collectSession.current?' <em>This encounter</em>':''}</span><b>${left?money(left):'Paid'}</b></label>`;}).join('')}<p class="collect-encounters-foot"><button type="button" class="text-button" data-collect-all="${all?'none':'all'}">${all?'Clear all':'Select all'}</button><span>${chosen.length} of ${open.length} ${open.length===1?'encounter':'encounters'} · ${money(collectChosenLeft())}</span></p></fieldset>`;
}
function collectEncountersPaint(){const node=collectDialog?.querySelector('[data-collect-encounters]');if(node)node.innerHTML=collectEncountersMarkup();}
// The amount follows the ticked encounters until staff type their own.
function collectEncountersChanged(){
 if(!collectSession.typed){const left=collectChosenLeft();collectSession.target=left>0||collectTakenCents()>0?collectTakenCents()+left:null;}
 collectEncountersPaint();collectProgressPaint();
 const active=collectDialog?.querySelector('[data-collect-method].active')?.dataset.collectMethod,slot=$('encounter-hosted-copay-reader');
 if(active&&!slot?.querySelector('[data-reader-payment="waiting"],[data-reader-payment="finishing"]')&&!collectDialog.querySelector('.collect-done'))collectMethod(active);
}
// The patient's other encounters that owe money join the list once they are read.
async function collectLoadEncounters(dialog,patient){
 if(typeof api!=='function'||!patient)return;
 let data;try{data=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/encounters`);}catch{return;}
 if(collectDialog!==dialog||selected!==patient)return;
 const when=id=>String((workspace.appointments||[]).find(a=>a.id===id)?.starts_at||'');
 const others=(data?.items||[]).filter(item=>item.appointment_id&&item.appointment_id!==collectSession.current&&Number.isSafeInteger(item.owes_now_cents)&&item.owes_now_cents>0)
  .sort((a,b)=>when(a.appointment_id)<when(b.appointment_id)?-1:when(a.appointment_id)>when(b.appointment_id)?1:0);
 if(!others.length)return;
 const fresh=!collectSession.taken.length;
 for(const item of others)if(!collectSession.encounters.some(e=>e.appointment===item.appointment_id))collectSession.encounters.push({appointment:item.appointment_id,owes:item.owes_now_cents,paid:0,on:fresh});
 collectEncountersChanged();
}
function collectTakenCents(){return collectSession.taken.reduce((sum,part)=>sum+part.amount,0);}
function collectLeftCents(){return collectSession.target==null?null:Math.max(0,collectSession.target-collectTakenCents());}
function collectProgressMarkup(){
 const left=collectLeftCents(),taken=collectSession.taken;
 return `<div class="collect-target"><label>Amount to collect<input name="collect_target" inputmode="decimal" value="${collectSession.target==null?'':esc(dollars(collectSession.target))}" autocomplete="off" data-collect-target></label>${taken.length?`<ul class="collect-taken">${taken.map(part=>`<li>✓ ${money(part.amount)} ${esc(part.label)}</li>`).join('')}</ul>`:''}<p class="collect-left"><span>Left to pay</span><b>${left==null?'—':money(Math.max(0,left))}</b></p></div>`;
}
function collectProgressPaint(){const node=collectDialog?.querySelector('[data-collect-progress]');if(node){node.innerHTML=collectProgressMarkup();if(typeof flashUpdated==='function')flashUpdated(node);}}
// A part was taken: count it, and either ask for the rest or finish.
function collectPartTaken(amount,label,receipt,appointment,detail){
 if(!collectDialog)return;
 for(const part of collectParts(amount)||[]){const e=collectSession.encounters.find(x=>x.appointment===part.appointment_id);if(e)e.paid+=part.amount_cents;}
 collectSession.taken.push({amount,label,...(detail||{})});collectDialog.dataset.refresh='1';collectEncountersPaint();collectProgressPaint();
 // What the patient has paid is read again, so the copay shows Paid right away.
 const dialog=collectDialog;if(typeof loadEncounterRevenueStatus==='function')void Promise.resolve(loadEncounterRevenueStatus(encounterChargeAccount(),true)).then(()=>{const node=dialog?.querySelector('[data-collect-owed]');if(node&&dialog.isConnected){node.innerHTML=collectOwedMarkup();if(typeof flashUpdated==='function')flashUpdated(node);}}).catch(()=>{});
 const left=collectLeftCents(),slot=collectPanelTarget();if(!slot)return;
 const receiptButton=receipt?.id&&collectSession.group?`<button type="button" data-collect-receipt="${esc(collectSession.group)}" data-appointment="${esc(appointment||'')}">Print receipt</button>`:'';
 if(left>0){slot.innerHTML=`<section class="collect-step-done" role="status"><p><b>✓ ${money(amount)} ${esc(label)} taken.</b> ${money(left)} left to pay. Choose how to take the rest above.</p></section>`;return;}
 slot.innerHTML=collectDoneMarkup(amount,label,receiptButton);
}
function collectAppointmentId(){return $('encounter-hosted-copay')?.dataset.appointment||(typeof revenueAppointment==='function'?revenueAppointment()?.id:null)||null;}
// The amount a card panel asks for is the plan's copay only while that copay is what is being
// taken: the whole copay is still due and it is the figure in front of staff. Any other figure
// is simply an amount, so the label must not call it a copay.
function copayAmountLabel(planCents,amountCents){
 // Only the Collect payment window knows what is being taken and can name the field by it.
 // Elsewhere the panel sits under the copay controls and keeps asking for the copay amount.
 if(!collectDialog)return 'Copay amount (USD)';
 const p=encounterRevenueState?.data?.summary?.patient||{};
 // The whole plan copay is what is being taken: it is still all due and it is the figure shown.
 const unpaidCopay=Number(planCents)>0&&p.copay_due_cents===planCents;
 return unpaidCopay&&amountCents===planCents?'Copay amount (USD)':'Amount (USD)';
}
// One line beside the window title says the payments are test payments; it is never a line of
// its own above the payments list.
function collectTestBadgeMarkup(){return typeof testPaymentLabel==='function'&&testPaymentLabel()?'<span class="status-badge test-badge collect-test-badge">Test mode</span>':'';}
function collectPanelTarget(){
 const holder=collectDialog?.querySelector('[data-collect-holder]');if(holder)return holder;
 const slot=$('encounter-hosted-copay-reader');return slot&&collectDialog?.contains(slot)?slot:null;
}
function collectDoneMarkup(amount,label,receiptButton){
 // What the extra does is what the server does with it: allocate_copays caps what a receipt
 // applies at the posted balance, so anything beyond it stays unapplied credit on the
 // patient's account. The encounter's balance is never driven negative.
 const several=collectOthers(),paidFor=(collectSession.encounters||[]).filter(e=>e.paid>0).length;
 const owed=several?collectSession.encounters.filter(e=>e.on||e.paid>0).reduce((sum,e)=>sum+e.owes,0):Number.isSafeInteger(collectSession.owedAtOpen)?collectSession.owedAtOpen:0;
 const taken=collectTakenCents(),parts=collectSession.taken.length,over=Math.max(0,taken-owed);
 const head=parts>1?`${money(taken)} paid in ${parts} parts`:`${money(amount)} ${esc(label)} recorded`;
 const sentence=over>0?(over<taken?`${money(over)} more than ${several?'these encounters':'this encounter'} owed stays as credit on the patient's account.`:`${money(taken)} stays as credit on the patient's account. This encounter owed nothing.`):several&&paidFor>1?`The payment is shared between ${paidFor} encounters.`:several&&paidFor===1&&!collectSession.encounters.find(e=>e.paid>0&&e.appointment===collectSession.current)?'The payment goes to the encounter you chose.':collectSession.copayOnly?'The copay is held for this encounter and comes off the bill when its charges are posted.':'The payment goes to this encounter\'s balance.';
 return `<section class="collect-done" role="status"><div class="collect-done-mark" aria-hidden="true">✓</div><h3>${head}</h3><p class="muted">${sentence}</p><div class="actions">${receiptButton}<button type="button" class="primary" data-sheet-close>Done</button></div></section>`;
}
function collectOwedMarkup(){
 const summary=encounterRevenueState?.data?.summary,p=summary?.patient||{},owes=p.owes_now_cents;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,number=typeof encounterNumberText==='function'?encounterNumberText(visit):'';
 // What the patient has already paid toward this encounter, and any credit on the account that
 // can be used before taking more money.
 const receipts=(summary?.receipts||[]).filter(r=>!r.voided);
 const copay=p.copay_cents!=null?`<li><span>Plan copay</span><b>${money(p.copay_cents)}</b>${p.copay_due_cents===0?'<em class="is-paid">Paid</em>':p.copay_paid_cents?`<em>${money(p.copay_paid_cents)} paid · ${money(p.copay_due_cents)} due</em>`:'<em>Due</em>'}</li>`:'';
 const paidTotal=receipts.reduce((sum,r)=>sum+Number(r.amount_cents||0)-Number(r.refunded_cents||0),0),payments=new Set(receipts.map(r=>r.payment_group_id||r.id)).size;
 const paid=receipts.length?`<li><span>Paid on this encounter</span><b>${money(paidTotal)}</b><em title="${esc(receipts.map(r=>`${money(r.amount_cents)} ${r.method==='card'?'card':r.method||''}`).join(', '))}">${payments===1?'1 payment':payments+' payments'}</em></li>`:'';
 const credit=Number(p.unapplied_cents||0)>0&&(typeof encounterChargeAccount==='function'?encounterChargeAccount():null)?.status==='posted'?`<li class="has-credit"><span>Credit on account</span><b>${money(p.unapplied_cents)}</b><button type="button" data-apply-copays>Use ${money(p.unapplied_cents)} credit</button></li>`:'';
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null,lines=account?.content?.lines||[];
 const items=lines.length?`<details class="collect-lines"${lines.length<=4?' open':''}><summary>${lines.length} ${lines.length===1?'charge':'charges'} · ${money(account.total_cents??lines.reduce((sum,l)=>sum+Number(l.amount_cents||0),0))}</summary><ul>${lines.map(l=>`<li><span><b>${esc(l.code)}</b>${l.modifiers?' · '+esc(l.modifiers):''} ${esc(l.description||'')}</span><span>${Number(l.units)>1?esc(String(l.units))+' × ':''}${money(l.amount_cents)}</span></li>`).join('')}</ul>${summary?.insurance?.insured&&p.owes_now_cents!=null&&summary.charges_cents!=null?`<p class="muted">Insurance is billed for the rest; the patient pays their share now.</p>`:''}</details>`:'';
 const posted=account?.status==='posted',dueBefore=!posted&&p.copay_due_cents!=null?p.copay_due_cents:null;
 const standing=typeof visitBillingDue==='function'?visitBillingDue(summary):null;
 const heldCopay=Number(p.copay_cents)>0&&p.copay_due_cents===0&&Number(p.copay_paid_cents)>0,settledText=!standing||standing.due!==0?'':standing.paidUp?`✓ ${standing.note}.`:heldCopay?'':'Nothing is due on this encounter right now.';
 const settled=settledText?`<p class="collect-settled" role="status">${settledText}</p>`:'';
 const copayHeld=!posted&&Number(p.copay_cents)>0&&p.copay_due_cents===0&&Number(p.copay_paid_cents)>0;
 return `${items}${settled}<div class="collect-owed${copayHeld?' is-paid':''}"><span>${number?esc(number)+' · ':''}${copayHeld?'Copay paid':dueBefore!=null?'Copay due now':'Patient owes now'}</span><b>${copayHeld?money(p.copay_paid_cents):dueBefore!=null?money(dueBefore):owes==null?'—':money(owes)}</b>${copayHeld?'<small>Held for this encounter. It comes off the bill when the charges are posted.</small>':dueBefore!=null?'<small>The rest is set when the charges are posted.</small>':''}</div>${copay||paid||credit?`<ul class="collect-paid-so-far">${copay}${paid}${credit}</ul>`:''}`;
}
function openCollectModal(){
 const panel=$('visit-billing-collect');if(!panel)return false;
 if(collectDialog?.isConnected){collectDialog.querySelector('[data-collect-method].active')?.focus?.();return true;}
 const home=panel.parentNode,marker=document.createComment('visit-billing-collect');home.insertBefore(marker,panel);
 let head=panel.querySelector('[data-collect-head]');if(!head){head=document.createElement('div');head.dataset.collectHead='';panel.prepend(head);}
 const pm=encounterRevenueState?.data?.summary?.patient||{},owes=pm.owes_now_cents,due=Number.isSafeInteger(owes)&&owes>0?owes:Number.isSafeInteger(pm.copay_due_cents)&&pm.copay_due_cents>0?pm.copay_due_cents:null;
 // What this encounter owed when the window opened, frozen for the success panel: the same
 // 'Patient owes now' figure staff read on the window itself, in cents.
 const current=collectAppointmentId();
 collectSession={target:due,owedAtOpen:due||0,copayOnly:!(Number.isSafeInteger(owes)&&owes>0)&&due>0,taken:[],group:crypto.randomUUID(),encounters:current&&due?[{appointment:current,owes:due,paid:0,on:true}]:[],current,typed:false};
 head.innerHTML=`<div data-collect-owed>${collectOwedMarkup()}</div><div data-collect-encounters></div><div data-collect-progress>${collectProgressMarkup()}</div><nav class="invoice-tabs collect-methods" role="tablist" aria-label="How the patient is paying">${collectMethods.map(([key,label])=>`<button type="button" role="tab" data-collect-method="${key}" aria-selected="false">${label}</button>`).join('')}</nav><div data-collect-holder></div>`;
 panel.hidden=false;
 const dialog=sheetOpen('Collect payment',panel);dialog.classList.add('sheet-wide','collect-sheet');collectDialog=dialog;
 const badge=collectTestBadgeMarkup();if(badge){const heading=dialog.querySelector('.sheet-head h3');if(heading)heading.insertAdjacentHTML('afterend',badge);}
 dialog.addEventListener('close',()=>{collectDialog=null;if(marker.parentNode){panel.hidden=true;head.remove();const slot=$('encounter-hosted-copay-reader');if(slot&&!slot.querySelector('[data-reader-payment="waiting"],[data-reader-payment="finishing"]'))slot.replaceChildren();marker.parentNode.insertBefore(panel,marker);marker.remove();}else panel.remove();if(dialog.dataset.refresh)void collectRefresh();},{once:true});
 void collectLoadEncounters(dialog,selected);
 return true;
}
// No method is chosen when the window opens: its panel stays blank until a tab is pressed.
function collectMethod(key){
 const dialog=collectDialog;if(!dialog)return;
 for(const b of dialog.querySelectorAll('[data-collect-method]')){const on=b.dataset.collectMethod===key;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));}
 dialog.dataset.method=key;
 try{localStorage.setItem('suncharts.collectMethod',key);}catch{}
 const slot=$('encounter-hosted-copay-reader'),panel=collectPanelTarget(),appointment=collectAppointmentId();
 if(typeof stopReaderPayment==='function'&&!slot?.querySelector('[data-reader-payment="waiting"],[data-reader-payment="finishing"]'))stopReaderPayment();
 if(!panel)return;
 if(!appointment){panel.innerHTML='<p role="status">Book or select the appointment for this encounter before taking a payment.</p>';return;}
 if(key==='cash'||key==='check'){panel.innerHTML=collectCashMarkup(key,appointment);panel.querySelector('[name="amount"]')?.focus();return;}
 panel.innerHTML='<p class="muted collect-loading">Getting ready…</p>';
 const opener=key==='reader'?openReaderCopayEditor:key==='saved'?openSavedCardCopayEditor:openHostedCopayEditor,left=collectLeftCents();
 run(async()=>{try{await opener(appointment,'encounter-hosted-copay',left!=null&&left>0?left:undefined);}finally{const loading=panel.querySelector('.collect-loading');if(loading)loading.remove();}});
}
function collectCashMarkup(method,appointmentId){
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);
 const coverage=typeof revenueCoverage==='function'?revenueCoverage(revenueServiceDate(appointment)):null,plan=coverage?.content.copay_cents;
 const left=collectLeftCents(),amount=left!=null&&left>0?left:visitCollectAmount(appointmentId,plan),check=method==='check';
 return `<form id="collect-cash-form" class="collect-cash" data-method="${method}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-patient="${esc(selected)}" data-request="${crypto.randomUUID()}"><label class="collect-amount">Amount received<input name="amount" inputmode="decimal" required value="${amount==null?'':esc(dollars(amount))}" autocomplete="off"></label>${check?'<label>Check number<input name="reference" required maxlength="200" autocomplete="off"></label>':'<label>Note (optional)<input name="reference" maxlength="200" autocomplete="off"></label>'}<button type="submit" class="primary collect-submit" data-collect-submit>Record ${amount==null?'':money(amount)+' '}${check?'check':'cash'}</button><p class="muted">Pressing this records that the money was received. Nothing is charged.</p></form>`;
}
function collectToday(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
async function submitCollectCash(form){
 const amountText=String(form.elements.amount.value||'').replace(/[$\s,]/g,'');let amount;try{amount=cents(amountText);}catch{amount=null;}
 if(!amount||amount<=0)throw new Error('Enter the amount received.');
 const patient=form.dataset.patient,method=form.dataset.method,button=form.querySelector('[data-collect-submit]');
 if(patient!==selected)throw new Error('This payment window belongs to another patient. Close it and open it again.');
 button.disabled=true;button.textContent='Recording…';
 // Money for several encounters is recorded once for each, under the one payment.
 const parts=collectParts(amount)||[{appointment_id:form.dataset.appointment,amount_cents:amount}],label=method==='check'?'check':'cash';
 let receipt,done=0;
 try{for(const [index,part] of parts.entries()){
  const own=part.appointment_id===form.dataset.appointment;
  receipt=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/copays`,'POST',{request_id:index?crypto.randomUUID():form.dataset.request,appointment_id:part.appointment_id,coverage_id:own?form.dataset.coverage||null:null,amount_cents:part.amount_cents,method,reference:String(form.elements.reference?.value||'').trim(),occurred_on:collectToday(),reason:method==='check'?'Check received at the desk':'Cash received at the desk',received_confirmed:true,...collectGroupField()});
  done+=part.amount_cents;}}
 catch(error){
  // What was recorded before the failure is kept and shown; the rest is still left to pay.
  if(done>0)collectPartTaken(done,label,receipt,form.dataset.appointment);
  else{button.disabled=false;button.textContent=`Record ${money(amount)} ${method}`;}
  throw error;}
 collectPartTaken(amount,label,receipt,form.dataset.appointment);
}
// After the window closes, the encounter reads its balance and payments again.
async function collectRefresh(){
 const patient=selected,visit=typeof activeVisit!=='undefined'?activeVisit?.id:null;if(!patient)return;
 await selectPatient(patient,visit);if(selected!==patient)return;
 if(typeof setEncounterSection==='function')setEncounterSection('charges');
}
if(typeof document!=='undefined'){
 document.addEventListener('click',event=>{
  const tab=event.target?.closest?.('[data-collect-method]');if(tab?.dataset?.collectMethod){event.preventDefault();collectMethod(tab.dataset.collectMethod);return;}
  const receipt=event.target?.closest?.('[data-collect-receipt]');if(receipt?.dataset?.collectReceipt){event.preventDefault();void run(()=>printPaymentGroupReceiptFromCollect(receipt.dataset.collectReceipt,receipt));return;}
 });
 document.addEventListener('submit',event=>{if(event.target?.id!=='collect-cash-form')return;event.preventDefault();run(()=>submitCollectCash(event.target));});
 document.addEventListener('change',event=>{const box=event.target;if(!box?.dataset?.collectEncounter||!collectDialog)return;const e=collectSession.encounters.find(x=>x.appointment===box.dataset.collectEncounter);if(!e)return;e.on=!!box.checked;collectEncountersChanged();});
 document.addEventListener('click',event=>{const all=event.target?.closest?.('[data-collect-all]');if(!all?.dataset?.collectAll||!collectDialog)return;event.preventDefault();const on=all.dataset.collectAll==='all';for(const e of collectSession.encounters)if(e.owes-e.paid>0)e.on=on;collectEncountersChanged();});
 document.addEventListener('change',event=>{if(!event.target?.hasAttribute?.('data-collect-target'))return;let value=null;try{value=cents(String(event.target.value||'').replace(/[$\s,]/g,''));}catch{}collectSession.target=value&&value>0?value:null;collectSession.typed=collectSession.target!=null;collectProgressPaint();const active=collectDialog?.querySelector('[data-collect-method].active')?.dataset.collectMethod;if(active==='cash'||active==='check')collectMethod(active);});
 document.addEventListener('input',event=>{const form=event.target?.closest?.('#collect-cash-form');if(!form||event.target.name!=='amount')return;const button=form.querySelector('[data-collect-submit]');let amount=null;try{amount=cents(String(event.target.value||'').replace(/[$\s,]/g,''));}catch{}button.textContent=`Record ${amount?money(amount)+' ':''}${form.dataset.method==='check'?'check':'cash'}`;});
}

// Using credit from the payment window closes it first, so the encounter reloads with the credit applied.
if(typeof document!=='undefined')document.addEventListener('click',event=>{const b=event.target?.closest?.('[data-apply-copays]');if(!b||!collectDialog||!collectDialog.contains(b))return;const account=encounterChargeAccount();if(account)billingSelected=account.id;delete collectDialog.dataset.refresh;sheetClose(collectDialog);},true);

// The encounter bar. Where this encounter stands, its money and the one next step sit in a single
// line that stays in view on every tab of the encounter. It is a live copy of the billing card's
// own next step, so every button in it is the card's button; the full money table opens over the
// page. An encounter with no charges yet has no bar: Add codes is already beside the codes.
let encounterBarTimer=null;
function encounterBarSync(){
 const page=typeof $==='function'?$('visit-page-host'):null,node=typeof $==='function'?$('encounter-revenue-status'):null;
 if(!page?.querySelector||typeof document==='undefined'||typeof document.createElement!=='function'||typeof page.insertBefore!=='function')return;
 const card=node?.querySelector?.('.visit-billing-card'),state=card?.getAttribute?.('data-visit-billing-state')||'';
 let bar=$('encounter-bar');
 const status=card?.querySelector?.('.visit-billing-status');
 // Before any charges exist the bar is only shown when a copay is due, so it can be taken at check-in.
 const standing=typeof visitBillingDue==='function'?visitBillingDue(encounterRevenueState?.data?.summary):{due:1};
 // The note comes before the money. With no charges and nothing due, an unsigned encounter's next
 // step is its note; once signed it is the card's own Add charges. Without an open encounter to
 // read there is no bar.
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,noCharges=state==='add_charges'&&!(typeof visitBillingDue==='function'&&standing.due>0);
 if(!status||!state||(noCharges&&!visit)){bar?.remove?.();return;}
 const noteFirst=noCharges&&visit.status!=='signed';
 const step=noteFirst?`<div class="visit-billing-status"><div><span class="eyebrow">Next step</span><p class="visit-billing-headline">Finish and sign the note</p><p class="muted">Charges can be added before or after signing.</p></div><div class="actions"><button type="button" class="primary" data-encounter-next="note">Go to the note</button>${status.querySelector?.('[data-encounter-charges]')?'<button type="button" data-encounter-charges>Add charges</button>':''}</div></div>`:status.outerHTML;
 // A signed encounter that is not finished keeps Finish encounter in reach; it is the main button
 // only when billing has nothing left for staff to press.
 const wrapUp=typeof checkoutProgress==='function'&&typeof checkoutStates!=='undefined'&&typeof checkoutKey==='function'&&visit?checkoutStates.get(checkoutKey(selected,visit.id)):null;
 const finish=!noteFirst&&visit?.status==='signed'&&wrapUp&&!wrapUp.checkout?.completed?`<div class="actions encounter-bar-next"><button type="button"${/class="primary/.test(step)?'':' class="primary"'} data-encounter-next="finish">Finish encounter</button></div>`:'';
 const totals=card.querySelector('.visit-billing-totals'),sent=card.querySelector('.visit-billing-sent'),table=card.querySelector('.visit-billing-breakdown');
 // When the patient owes something on this encounter, taking the payment is one press away from
 // the bar, whatever the next billing step is. It opens the same payment sheet (card on file,
 // card reader, payment link) as the Payments part of the Billing tab. Not repeated when the
 // next step is itself the payment.
 // Shown only while something is due: once the encounter is paid, the bar says so and offers nothing to take.
 const collectable=standing.due>0&&!!card.querySelector('[data-visit-collect]')&&!status.querySelector?.('[data-visit-collect]');
 // One main button at a time: Take payment is quiet beside another next step.
 const takePayment=collectable?`<button type="button" class="${/class="primary/.test(step)?'':'primary '}encounter-bar-pay" data-visit-collect>Take payment</button>`:'';
 const html=`${step}${finish}${totals?totals.outerHTML.replace(/<\/p>$/,`${table?'<button type="button" class="text-button" data-money-details>Money details</button>':''}${takePayment}</p>`):takePayment?`<p class="visit-billing-totals"><span class="is-due"><small>${standing.copayOnly?'Copay due now':'Patient owes now'}</small><b>${money(standing.due)}</b></span>${takePayment}</p>`:''}${sent?sent.outerHTML:''}`;
 if(!bar){
  bar=document.createElement('section');bar.id='encounter-bar';bar.className='encounter-bar';bar.setAttribute('aria-label','Where this encounter stands');
  const after=$('encounter-progress');page.insertBefore(bar,after?.parentNode===page?after.nextSibling:page.firstChild);
 }
 if(bar.barHtml!==html){bar.innerHTML=html;bar.barHtml=html;}
 bar.dataset.visitBillingState=state;
 // The bar sits right under the patient banner, whatever height that banner has today.
 const banner=document.querySelector?.('.patient-banner');
 if(banner?.getBoundingClientRect&&page.style?.setProperty){const top=parseFloat(getComputedStyle(banner).top)||0;page.style.setProperty('--encounter-bar-top',`${Math.round(top+banner.getBoundingClientRect().height)}px`);}
}
// Anything that changes the card (a refresh, a failed send's message, a button going busy) reaches
// the bar by itself.
function encounterBarWatch(host){
 if(!host||host.encounterBarWatched||typeof MutationObserver!=='function')return;
 host.encounterBarWatched=true;
 new MutationObserver(()=>{clearTimeout(encounterBarTimer);encounterBarTimer=setTimeout(()=>{encounterBarSync();if($('encounter-revenue')?.dataset?.codesEditing===undefined)encounterDetailsSummaryRender();},30);}).observe(host,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden','data-visit-billing-state']});
}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('click',event=>{
  const button=event.target?.closest?.('[data-money-details]');if(!button?.hasAttribute?.('data-money-details'))return;
  event.preventDefault();
  const table=$('encounter-revenue-status')?.querySelector('.visit-billing-breakdown');if(!table||typeof sheetOpen!=='function')return;
  const panel=document.createElement('div');panel.className='money-details-sheet';panel.append(table.cloneNode(true));
  const dialog=sheetOpen('Money for this encounter',panel);
  // A button pressed in the sheet does its work on the page, so the sheet steps aside for it.
  panel.addEventListener('click',inner=>{if(inner.target.closest?.('button'))setTimeout(()=>sheetClose(dialog),0);});
 },true);
 if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('resize',()=>encounterBarSync());
}
