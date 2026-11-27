// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const insuranceAppointmentSelection=new Map();
function resetInsuranceCopayAppointment(patient,previousVisit,nextVisit){
 if(nextVisit&&(nextVisit.id!==previousVisit?.id||(nextVisit.appointment_id??null)!==(previousVisit?.appointment_id??null)))insuranceAppointmentSelection.delete(patient);
}
// The appointment whose copay the schedule asked for, per patient, used while no encounter is open.
const copayAppointmentSelection=new Map();
function remittancePatientResponsibility(row){
 const explicit=(row?.adjustments||[]).some(adjustment=>adjustment.group==='PR')||row?.patient_responsibility_cents>0;
 return explicit?`Payer-reported patient responsibility ${money(row.patient_responsibility_cents||0)}`:'Patient responsibility not specified in PR evidence; review the response';
}
function revenueAppointment(){
 const currentVisit=typeof activeVisit!=='undefined'?activeVisit:null;
 const selectedAppointment=!currentVisit||typeof chartSection!=='undefined'&&chartSection==='insurance'?insuranceAppointmentSelection.get(selected):null;
 if(selectedAppointment){const appointment=(workspace.appointments||[]).find(a=>a.id===selectedAppointment);if(appointment)return appointment;}
 if(currentVisit)return currentVisit.appointment_id?(workspace.appointments||[]).find(a=>a.id===currentVisit.appointment_id):undefined;
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
 if(host&&host.parentElement!==block&&!$('visit-page-host')?.contains?.(host))host=null;
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
function copayUnapplied(receipt){return Math.max(0,receipt.amount_cents-Number(receipt.allocated_cents||0)-Number(receipt.hosted_checkout?.refunded_unapplied_cents||0)-Number(receipt.cash_refunded_cents||0));}
function availableCopayCreditForAccount(account){const visit=(workspace.visits||[]).find(v=>v.id===account.content.visit_id);return (typeof copaysForAppointment==='function'?copaysForAppointment(visit?.appointment_id):(workspace.billing?.copays||[])).filter(r=>r.appointment_id===visit?.appointment_id&&!r.voided&&!r.reversed_cents&&r.hosted_checkout?.status!=='needs_review').reduce((sum,r)=>sum+copayUnapplied(r),0);}
function appointmentCopays(appointment=revenueAppointment()){return (typeof copaysForAppointment==='function'?copaysForAppointment(appointment?.id):(workspace.billing?.copays||[])).filter(r=>r.appointment_id===appointment?.id);}
function copayReceiptMarkup(receipts,options={}){
 return receipts.map(r=>{const hosted=r.hosted_checkout,refunded=Number(hosted?.refunded_cents||0),reversed=Number(r.reversed_cents||0),allocated=Number(r.allocated_cents||0),unapplied=copayUnapplied(r),held=hosted?.status==='needs_review',status=r.voided?'Voided receipt':held?'Card payment requires reconciliation':refunded===r.amount_cents?'Card payment refunded':refunded?'Card payment partially refunded':reversed?'Corrected on ledger':unapplied?(hosted?'Card payment captured · not yet applied to charges':'Recorded · not yet applied to charges'):(hosted?'Card payment captured · applied to visit charges':'Applied to visit charges');return `<div class="timeline-row"><div><b>${hosted?.livemode===false&&!options.modeShown?testPaymentTag(' · '):hosted?.livemode===true&&options.modeShown?'LIVE · ':''}${money(r.amount_cents)} · ${esc(status)}</b><small>${hosted?'Card · Confirmed':esc(human(r.method))} · ${esc(r.occurred_on)}${r.reference&&!/^(ch|pi|py|txn|cs|in|re|pyr)_[A-Za-z0-9]{8,}$/.test(String(r.reference))?' · '+esc(r.reference):''}</small>${refunded?`<small>Verified refunds ${money(refunded)} · Net received ${money(r.amount_cents-refunded)}</small>`:''}${!r.voided&&!reversed&&!held&&unapplied?`<small>${money(unapplied)} credit not yet applied</small>`:''}${reversed?`<small>${money(reversed)} reversed. Review the account ledger before recording any replacement receipt.</small>`:''}</div><div class="actions"><button type="button" ${options.primary?'class="primary"':''} data-copay-receipt="${esc(r.id)}" data-appointment="${esc(r.appointment_id)}">View / print receipt</button>${(options.encounter?[]:r.account_ids||[]).map(id=>`<button type="button" data-copay-account="${esc(id)}">Review ledger</button>`).join('')}${!options.readOnly&&billingCan()&&!hosted&&!r.voided&&!allocated?`<button type="button" data-copay-void="${esc(r.id)}">Correct receipt</button>`:''}</div></div>`;}).join('')||'<p class="muted">No copay receipt recorded for this appointment.</p>';
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
 const view=hostedCopayView(),appointment=view.collect?collectSession.insurance?.appointment:null;
 try{
  const data=await api(`/api/v1/patients/${encodeURIComponent(view.patient)}/billing/payment-groups/${encodeURIComponent(group)}`);
  const receipts=(data.receipts||[]).filter(r=>r.payment_group_id===group&&(!appointment||r.appointment_id===appointment));
  if(!receipts.length)throw new Error('This receipt is unavailable for the current patient. Refresh the payment list.');
  // The context (patient, practice) comes from the same receipt endpoint a single receipt uses.
  const first=await api(`/api/v1/billing/copay-receipts/${encodeURIComponent(receipts[0].id)}`);
  const p=encounterRevenueState?.data?.summary?.patient||{},balance=!appointment&&Number.isSafeInteger(p.owes_now_cents)?p.owes_now_cents:undefined;
  const visitEvidence=await visitReceiptEvidence(receipts[0].appointment_id);
  const context={...first.context,balanceCents:balance,visitEvidence,printedAt:new Date().toISOString()};
  if(me!==view.identity||!collectDialog?.isConnected||!button.isConnected||(view.collect&&!currentHostedCopayView(view,false)))return;
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
 const allocation=receipt.voided?'<p>This receipt record was voided and is retained for history. Voiding the record does not issue a refund.</p>':corrected?'<p>A charge allocation was reversed after this payment was recorded. Contact the practice to confirm its current disposition. A ledger reversal does not establish that a refund was issued.</p>':context.reviewAllocation?'<dt>Application to charges</dt><dd>Contact the practice to confirm how this payment was applied.</dd>':`<dt>${refunded?'Original charge allocations':'Applied to visit charges'}</dt><dd>${money(Number(receipt.allocated_cents||0))}</dd><dt>Remaining credit not yet applied</dt><dd>${money(copayUnapplied(receipt))}</dd>`;
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
 if(chartSection==='insurance'&&!view.collect&&$('insurance-editor')?.querySelector('form')){notice('Save or cancel the open insurance form before opening the receipt.',true);return;}
 const current=()=>opening===copayReceiptOpening&&currentHostedCopayView(view);
 const data=await api(`/api/v1/billing/copay-receipts/${encodeURIComponent(id)}`);
 if(!current())return;
 const receipt=data.receipt,context=data.context;
 if(receipt?.id!==id||receipt.patient_id!==view.patient||receipt.appointment_id!==expected||!context?.patient||context.appointment&&context.appointment.id!==expected)throw new Error('This receipt does not match the selected patient and appointment.');
 const visit=(workspace.visits||[]).find(v=>v.appointment_id===expected),clinical=typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical');
 const inCopay=!!view.collect&&collectSession.insurance?.appointment===expected;
 const canSeeVisit=visit&&clinical&&(typeof chartAreaEnabled!=='function'||chartAreaEnabled('visits'));
 if(inCopay||canSeeVisit){
  const visitEvidence=canSeeVisit?await visitReceiptEvidence(expected):undefined;
  if(!current())return;
  const summary=encounterRevenueState.data?.summary;
  const reviewAllocation=summary?.insurance?.insured===false&&summary.visit?.id===visit.id&&typeof visitBillingSelfPayCredits==='function'
   &&(!Number.isSafeInteger(receipt.allocated_cents)||visitBillingSelfPayCredits({...summary,receipts:[receipt]},[receipt],encounterPaymentLedger(summary)).conflicts.has(id));
  openReceiptPreview(copayReceiptDocument(receipt,{...context,visitEvidence,reviewAllocation,printedAt:new Date().toISOString()}),undefined,{patient:view.patient,receipt});
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
 const items=state.history?.items||[],latest=[...items].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
 const ui=typeof claimmdEligibilityUiFor==='function'?claimmdEligibilityUiFor(coverageId):null;
 const reasons={subscriber_birth_date:'Policy holder date of birth is needed.',subscriber_name:'Policy holder name is needed.',member_id:'Member ID is needed.',payer_id:'The insurance company needs a payer ID.',provider:'Choose a provider.',provider_npi:'A provider NPI is needed.',billing_organization:'Choose a billing organization.',billing_organization_missing:'A billing organization with a tax ID is needed.',claim_connection:'the clearinghouse is not connected yet.'};
 const patient=workspace.patient?.id===selected?workspace.patient:null;
 const birthMissing=typeof claimmdSubscriberBirthMissing==='function'&&claimmdSubscriberBirthMissing(coverage.content,patient);
 const reason=ui?.needs?.length?reasons[ui.needs[0].kind]||'More information is needed.':!coverage.content.member_id?'Member ID is needed.':birthMissing?'Policy holder date of birth is needed.':'No eligibility request has been recorded.';
 return `<p class="muted">Last eligibility check: ${latest?esc(displayDate(String(latest.completed_at||latest.created_at).slice(0,10))):'Not checked'}.${!latest?' '+esc(reason):''}</p>`+claimmdEligibilityCard(coverage,items,{serviceDate});
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
 if($('visit-page-host')?.dataset?.encounterSteps!==undefined)return true;
 if(typeof encounterShows==='function')return encounterShows('charges');
 return typeof encounterSection==='undefined'||encounterSection==='charges';
}
function encounterRevenueStatusMarkup(account,data={}){
 // A card with something wrong to answer for keeps its own button: while a claim could not be
 // prepared, or is preparing, the review panel has nothing to offer yet.
 if(data.summary)return visitBillingCardMarkup(data.summary,visitBillingContext({encounterSteps:!!$('visit-page-host'),prepareError:data.prepareError,preparing:data.preparing,noReview:!!data.prepareError||!!data.preparing}))+(data.stale?`<p role="status">These amounts could not be refreshed just now. ${esc(data.errorReason||'Refresh before relying on them.')}</p>`:'');
 return `<section class="visit-billing-card"><div class="section-head"><h3>Next step</h3>${data.error?'<button type="button" class="text-button" data-refresh-revenue>Refresh</button>':''}</div>${data.error?`<p role="status">Billing for this encounter could not be loaded. ${esc(data.errorReason||'Refresh before relying on any amount.')}</p>`:typeof skeletonMarkup==='function'?skeletonMarkup('card'):'<p class="muted" role="status">Loading billing for this encounter…</p>'}</section>`;
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
 const visitStatus=visit.status;
 let state=encounterRevenueState;
 if(state.patient!==selected||state.identity!==me||state.visit!==visit.id||state.visitStatus!==visitStatus||state.account!==(account?.id||null)||state.version!==(account?.version||null)){
  if(typeof clearTimeout==='function')clearTimeout(state.timer);
  const sameVisit=state.patient===selected&&state.identity===me&&state.visit===visit.id;
  state={reviewOpen:sameVisit&&state.reviewOpen===true,patient:selected,identity:me,visit:visit.id,visitStatus,account:account?.id||null,version:account?.version||null,pending:null,data:null,loadedAt:0,filter:'all',prepared:false,review:null,reviewCard:null};
  encounterRevenueState=state;
 }
 const current=()=>encounterRevenueState===state&&selected===state.patient&&me===state.identity&&activeVisit?.id===state.visit&&activeVisit.status===visitStatus&&(encounterChargeAccount()?.id||null)===state.account;
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
   // Until the claim exists, validate against the directory as of this summary refresh.
   if(summary.insurance?.insured&&!summary.claim?.id&&visitBillingStateContext().claimsAllowed){
    summary.practice_directory=await api('/api/v1/billing/claimmd/provider-defaults').catch(()=>null);
    if(!current())return;
   }
   // The read finished: the card answers for the encounter as the server now describes it, so the
   // version it was opened at is replaced with the one that produced this summary.
   if(encounterRevenueState===state&&summary?.account)state.version=summary.account.version??state.version;
   state.data={summary,prepareError:summary.state==='prepare_claim'?prepareError:null};state.loadedAt=Date.now();
  }catch(error){state.data=state.data?.summary?{...state.data,stale:true,preparing:false,errorReason:error?.message}:{error:true,errorReason:error?.message};}
  finally{state.pending=null;render();
   // The claim made from these codes shows under them as soon as the summary names it.
   if(current()&&typeof visitReviewRestore==='function')visitReviewRestore();
   // The banner's progress line follows this encounter: its claim, or its self-pay steps.
   if(current()&&typeof patientBannerEncounterSync==='function')patientBannerEncounterSync(state.data?.summary,typeof activeVisit!=='undefined'?activeVisit:null);
   const claimId=state.data?.summary?.claim?.id;
   if(current()&&claimId&&!(typeof patientBannerEncounterOpen==='function'&&patientBannerEncounterOpen())&&typeof patientBannerClaim!=='undefined'&&patientBannerClaim.claim?.id!==claimId&&typeof claimMdClaimLifecycle==='function'&&typeof claimsBase!=='undefined')void api(`${claimsBase}/${encodeURIComponent(claimId)}`).then(detail=>{if(current()&&detail?.claim?.id===claimId)claimMdClaimLifecycle(detail.claim,detail);}).catch(()=>{});
  if(current()&&typeof setTimeout==='function'&&state.data?.summary?.account?.status==='posted'){clearTimeout(state.timer);state.timer=setTimeout(()=>{const node=$('encounter-revenue-status');if(current()&&node&&(!node.getClientRects||node.getClientRects().length))void loadEncounterRevenueStatus(encounterChargeAccount(),true);},20000);}}
 })();
 return state.pending;
}
async function prepareVisitClaim(again,quiet){
 const account=encounterChargeAccount(),state=encounterRevenueState,patient=selected,identity=me,visit=activeVisit?.id;
 if(!account)throw new Error('Post the charges for this encounter first.');
 const current=()=>selected===patient&&me===identity&&activeVisit?.id===visit&&encounterChargeAccount()?.id===account.id;
 state.prepared=true;
 const result=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/accounts/${encodeURIComponent(account.id)}/claims/prepare`,'POST',again?{again:true}:{});
 if(!current())return;
 if(encounterRevenueState===state&&state.data)state.data.prepareError=null;
 await loadEncounterRevenueStatus(account,true);
 if(current()&&result.outcome==='prepared'&&!quiet)notice('Claim prepared from this encounter. Nothing was sent.');
}
// A cancelled claim goes out again in one press: the claim is prepared again (keeping what a person
// corrected on the cancelled one), the encounter is read back, and when nothing needs fixing the same
// send the review panel's own button runs goes ahead. Otherwise the review panel shows what to fix.
async function visitClaimResend(button){
 const patient=selected,identity=me,visit=activeVisit?.id;
 const current=()=>selected===patient&&me===identity&&activeVisit?.id===visit;
 if(button){button.disabled=true;button.textContent='Sending…';}
 try{
  await prepareVisitClaim(true,true);
  if(!current())return;
  const summary=encounterRevenueState.data?.summary;
  const clear=summary?.state==='send_claim'&&!visitReviewMustFix(visitReviewChecks(summary,visitReviewContext())).length;
  const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
  const options=clear?visitReviewSendContext(summary,account):null;
  visitReviewOpen();
  if(options)await visitReviewRun(summary.claim?.id||null,options);
 }catch(error){
  if(current())visitClaimSendFailure(error,button);
 }finally{
  if(current()&&button&&button.isConnected!==false){button.disabled=false;button.textContent='Send the claim again';}
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
 currentVisitStatement={invoice,patient:selected,identity:me,request:crypto.randomUUID()};
 openBillingEditor(`<div class="section-head"><h3>Invoice</h3><div class="actions"><button type="button" class="primary" data-print-patient-invoice>Print / save PDF</button><span id="statement-send-actions" role="status">Checking sending channels…</span><button type="button" data-visit-statement-close>Close</button></div></div><p class="muted">${money(invoice.snapshot?.amount_due_cents||0)} due as of ${esc(visitBillingDate(invoice.created_at))}. Opening a statement does not charge a card.</p><div id="statement-deliveries"></div><div id="patient-invoice-preview"></div>`);
 if(typeof sheetOpen==='function'&&document.body&&typeof billingEditorHost==='function'){const host=billingEditorHost(),holder=document.createElement('div');holder.className='invoice-sheet';while(host?.firstChild)holder.append(host.firstChild);holder.querySelector('.section-head h3')?.remove();if(holder.childNodes.length)sheetOpen('Invoice',holder).classList.add('sheet-wide');}
 const frame=document.createElement('iframe');frame.id='patient-invoice-frame';frame.title='Patient statement print preview';frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');frame.srcdoc=patientInvoiceDocument(invoice);$('patient-invoice-preview')?.append(frame);
 void loadStatementDeliveries(currentVisitStatement).catch(()=>{const host=$('statement-send-actions');if(host)host.textContent='Sending channels could not be checked. Refresh and try again, or use Print / save PDF.';});
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
 if(typeof encounterHistoryOpen==='function')encounterHistoryOpen();
}
function insuranceCoverageCard(coverage){
 const c=coverage.content,payer=(typeof billingPayers!=='undefined'?billingPayers:[]).find(p=>p.id===c.payer_id);
 const field=(label,value)=>`<dt>${esc(label)}</dt><dd>${esc(value||'Not recorded')}</dd>`;
 return `<article class="insurance-coverage-card"><div class="section-head"><div><h3>${esc(payerName(c.payer_id))}</h3><p>${esc(c.plan_name||'Plan name not recorded')}</p></div><span class="pill ${c.status==='active'?'green':c.status==='inactive'?'grey':'amber'}">${esc(displayStatus(c.status))}</span>${billingCan()?`<button type="button" data-edit-coverage="${esc(coverage.id)}">Edit</button>`:''}</div><dl class="billing-dl">${field('Member ID',c.member_id)}${field('Group',c.group_number)}${field('Priority',human(c.priority))}${field('Copay',c.copay_cents==null?null:money(c.copay_cents))}${field('Subscriber name',c.subscriber_name)}${field('Relationship',c.relationship?human(c.relationship):null)}${field('Subscriber date of birth',c.subscriber_birth_date?displayDate(c.subscriber_birth_date):null)}${field('Payer ID',payer?.content?.payer_code)}${field('Start date',c.effective_date?displayDate(c.effective_date):null)}${field('End date',c.end_date?displayDate(c.end_date):null)}${field('Checked by staff',c.verification?human(c.verification):null)}${field('Notes',c.notes)}</dl><div class="insurance-eligibility-summary" id="insurance-eligibility-${esc(coverage.id)}">${insuranceEligibilityMarkup(eligibilityState().items.get(coverage.id),coverage.id,revenueServiceDate())}</div><div class="actions">${typeof claimmdEligibilityButton==='function'?claimmdEligibilityButton(coverage):''}<button type="button" data-coverage-open="${esc(coverage.id)}">Details</button></div></article>`;
}
async function loadInsuranceCardImages(){
 const patient=selected,identity=me,source=workspace,host=$('insurance-card-images');if(!host)return;
 try{
  const data=await api(`/api/v1/patients/${encodeURIComponent(patient)}/documents`);
  if(selected!==patient||me!==identity||workspace!==source||$('insurance-card-images')!==host)return;
  const cards=(data.items||[]).filter(d=>d.content?.category==='insurance'&&d.content.status==='active');
  host.innerHTML=cards.length?`<h3>Insurance cards</h3><p class="muted">Cards on this patient’s record.</p>${cards.map(d=>{const url=`/api/v1/patients/${encodeURIComponent(patient)}/documents/${encodeURIComponent(d.id)}/preview`;return `<figure><figcaption>${esc(d.content.title)}</figcaption><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${['image/png','image/jpeg'].includes(d.content_type)?`<img src="${esc(url)}" alt="${esc(d.content.title)}" style="max-width:100%;max-height:180px" loading="lazy" referrerpolicy="no-referrer">`:'Open card document'}</a></figure>`;}).join('')}`:'<p class="muted">No insurance cards uploaded.</p>';
 }catch{if(selected===patient&&me===identity&&workspace===source&&$('insurance-card-images')===host)host.innerHTML='<p class="muted">Insurance cards could not be loaded. Open Insurance documents to try again.</p>';}
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
function appointmentCopaySectionMarkup(appointment,prep,panelId='insurance-hosted-copay'){
 const copayDone=prep.copayState.tone==='done';
 return `<section class="insurance-workflow-stage" aria-labelledby="${esc(panelId)}-title"><h3 id="${esc(panelId)}-title" tabindex="-1">${copayDone?'Copay':'Collect copay'}</h3>${copayDone?`<p class="prep-summary">${prepStageMark(prep.copayState)} ${esc(prep.copayState.text)} · ${prep.count===1?'1 payment':prep.count+' payments'}, ${money(prep.paid)} in all</p><details class="insurance-supporting-records"><summary>Payments, receipts and taking another payment</summary>`:''}${appointment?hostedCopayPanel(appointment,panelId)||copayReceiptMarkup(appointmentCopays(appointment)):'<p>Select or book an appointment before collecting its copay.</p>'}${billingCan('create')&&appointment?`<details class="insurance-supporting-records"><summary>Record cash, check or an external receipt</summary><p>This records money already received; it does not charge a card.</p><button type="button" data-record-copay="${esc(appointment.id)}">Record received payment</button></details>`:''}${copayDone?'</details>':''}</section>`;
}
function appointmentCopayCard(){
 const appointment=revenueAppointment();
 if(!appointment||!workspace.billing||(workspace.visits||[]).some(v=>v.appointment_id===appointment.id)||['cancelled','canceled','no_show','completed'].includes(appointment.status))return '';
 const serviceDate=revenueServiceDate(appointment),current=(workspace.billing.coverages||[]).filter(c=>c.content.status==='active'&&c.content.effective_date<=serviceDate&&(!c.content.end_date||c.content.end_date>=serviceDate)).sort((a,b)=>({primary:0,secondary:1,tertiary:2}[a.content.priority]??3)-({primary:0,secondary:1,tertiary:2}[b.content.priority]??3));
 const prep=appointmentPrepState(appointment,current);
 if(billingCan('create')&&typeof setTimeout==='function')setTimeout(()=>{void loadHostedCopays(appointment.id);},0);
 return `<section class="panel appointment-copay-card" id="appointment-copay-card"><div class="section-head"><div><h2>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</h2><p class="muted">${esc(displayStatus(appointment.status))} · Start the visit from the top of the chart when the patient is ready.</p></div></div><p class="prep-summary">${prepStageMark(prep.insurance)} ${esc(prep.insurance.text)}</p>${prep.copayState.tone==='done'?'':`<p class="prep-summary">${prepStageMark(prep.copayState)} ${esc(prep.copayState.text)}</p>`}${appointmentCopaySectionMarkup(appointment,prep)}</section>`;
}
function insuranceCopayCanCollect(appointment){
 return !!appointment&&billingCan('create')&&!workspace.patient?.archived&&!['cancelled','canceled','no_show'].includes(appointment.status);
}
function insuranceCopayContext(appointment){
 const coverage=revenueCoverage(revenueServiceDate(appointment)),summary=encounterRevenueState.data?.summary;
 const patient=encounterRevenueState.patient===selected&&encounterRevenueState.identity===me&&summary?.visit?.appointment_id===appointment.id?summary.patient:null;
 const receipts=appointmentCopays(appointment);
 const usable=receipts.filter(receipt=>!receipt.voided&&!receipt.reversed_cents&&receipt.hosted_checkout?.status!=='needs_review');
 const paid=usable.reduce((sum,receipt)=>sum+Math.max(0,receipt.amount_cents-(receipt.hosted_checkout?.refunded_cents||0)-(receipt.cash_refunded_cents||0)),0);
 const recorded=patient?.copay_cents??coverage?.content.copay_cents;
 const plan=Number.isSafeInteger(recorded)?recorded:null;
 const due=plan==null?null:Math.max(0,plan-paid);
 const needsReview=receipts.some(receipt=>!receipt.voided&&(receipt.reversed_cents>0||receipt.hosted_checkout?.status==='needs_review'));
 return {patient:selected,identity:me,appointment:appointment.id,coverage:coverage?.id??null,plan,due,paid,receipts,needsReview,canCollect:insuranceCopayCanCollect(appointment)};
}
function insuranceCopayReadout(context,state){
 const operation=state.items.find(item=>['creating','open','needs_review'].includes(item.status));
 if(state.uncertain||context.needsReview||operation?.status==='needs_review')return {amount:operation?`${money(operation.amount_cents)} payment needs review`:'Payment needs review',action:'Review payment'};
 if(operation)return {amount:`${money(operation.amount_cents)} payment pending`,action:'Review payment'};
 // A processor confirmation can arrive before the workspace has fetched its new receipt.
 const verified=state.items.find(item=>item.status==='paid'&&item.receipt_id&&!context.receipts.some(receipt=>receipt.id===item.receipt_id));
 if(verified)return {amount:`${money(verified.amount_cents)} payment verified`,action:'View payments'};
 const amount=context.due>0?`${money(context.due)} copay due`:context.paid>0?`${money(context.paid)} paid`:context.due===0?'No copay due':'No copay recorded';
 const action=context.canCollect&&(context.due>0||context.due==null&&context.paid===0)?'Collect copay':'View payments';
 return {amount,action};
}
function insuranceCopaySectionMarkup(appointment){
 if(!appointment)return '<section id="insurance-page-copay" aria-labelledby="insurance-copay-title"><h3 id="insurance-copay-title">Copay</h3><p>Select or book an appointment to collect a copay.</p></section>';
 const context=insuranceCopayContext(appointment),readout=insuranceCopayReadout(context,hostedCopayStateFor(appointment.id));
 return `<section id="insurance-page-copay" class="insurance-workflow-stage" data-appointment="${esc(appointment.id)}" aria-labelledby="insurance-copay-title"><div class="section-head insurance-copay-summary"><div><h3 id="insurance-copay-title" tabindex="-1">Copay</h3><p data-insurance-copay-status role="status">${esc(readout.amount)}</p></div><button type="button" class="primary" data-insurance-copay-collect="${esc(appointment.id)}" data-patient="${esc(context.patient)}">${esc(readout.action)}</button></div></section>`;
}
function paintInsuranceCopaySummary(state){
 if(chartSection!=='insurance')return;
 const host=$('insurance-page-copay'),appointment=revenueAppointment();
 if(host?.dataset?.appointment!==state.appointment||appointment?.id!==state.appointment)return;
 const {amount,action}=insuranceCopayReadout(insuranceCopayContext(appointment),state);
 const status=host.querySelector?.('[data-insurance-copay-status]'),button=host.querySelector?.('[data-insurance-copay-collect]');
 if(status&&status.textContent!==amount)status.textContent=amount;
 if(button&&button.textContent!==action)button.textContent=action;
}
function renderPatientInsurance(){
 if(!workspace.billing)return;
 let host=$('insurance-workspace');if(!host){host=document.createElement('section');host.id='insurance-workspace';host.className='panel';$('chart').insertBefore(host,$('appointments-panel'));}
 const appointment=revenueAppointment(),serviceDate=revenueServiceDate(appointment),coverages=workspace.billing.coverages||[],current=coverages.filter(c=>c.content.status==='active'&&c.content.effective_date<=serviceDate&&(!c.content.end_date||c.content.end_date>=serviceDate)).sort((a,b)=>({primary:0,secondary:1,tertiary:2}[a.content.priority]??3)-({primary:0,secondary:1,tertiary:2}[b.content.priority]??3)),history=coverages.filter(c=>!current.includes(c));
 if(typeof refreshPatientChartContext==='function')refreshPatientChartContext();
 const key=JSON.stringify([selected,appointment?.id,appointment?.status,serviceDate,coverages.map(c=>[c.id,c.version]),workspace.billing.copays,(workspace.visits||[]).map(v=>[v.id,v.status]),billingCan('create')]);if(host.dataset.insuranceKey===key){for(const coverage of coverages)loadInsuranceEligibility(coverage.id);insuranceAutoEligibility(current,appointment,serviceDate);if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);return;}host.dataset.insuranceKey=key;
 const options=(workspace.appointments||[]).filter(a=>!['cancelled','canceled','no_show'].includes(a.status)||a.id===appointment?.id);
 host.innerHTML=chartListHeader('Insurance & copay',billingCan('create')?'<button type="button" class="primary" data-new-coverage>+ Add insurance</button>':'','<button type="button" data-chart-section="documents">Insurance documents</button>')+`${appointment?`<p class="muted">For the visit on ${esc(displayDate(serviceDate))}</p>`:''}${options.length?`<label>Visit<select id="insurance-appointment">${appointment?'':'<option value="" disabled selected>Choose an appointment</option>'}${options.map(a=>`<option value="${esc(a.id)}" ${a.id===appointment?.id?'selected':''}>${esc(displayDate(revenueServiceDate(a)))} · ${esc(a.title||'Appointment')}</option>`).join('')}</select></label>`:''}<h3>Current insurance</h3><div class="insurance-coverage-list">${current.map(insuranceCoverageCard).join('')||'<div class="chart-empty-row">No insurance recorded for this visit date.</div>'}</div><details class="insurance-supporting-records"><summary>Inactive &amp; prior (${history.length})</summary><div class="insurance-coverage-list">${history.map(insuranceCoverageCard).join('')||'<p>No inactive or prior insurance.</p>'}</div></details>${insuranceCopaySectionMarkup(appointment)}<section id="insurance-card-images"><p class="muted">Loading insurance cards…</p></section><div id="insurance-editor"></div>`;
 void loadInsuranceCardImages();
 for(const coverage of coverages)loadInsuranceEligibility(coverage.id);
 insuranceAutoEligibility(current,appointment,serviceDate);
 if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);
 host.hidden=typeof chartSection!=='undefined'&&chartSection!=='insurance';
}
function renderEncounterRevenue(){
 const host=$('encounter-revenue');if(!host)return;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,account=encounterChargeAccount(),appointment=(workspace.appointments||[]).find(a=>a.id===visit?.appointment_id),serviceDate=revenueServiceDate(appointment),coverage=revenueCoverage(serviceDate);
 if(!visit){host.innerHTML='<p>Select an encounter to record its procedures and charges.</p>';return;}
 const codesVisible=typeof visitBillingAreaVisible!=='function'||visitBillingAreaVisible();
 const key=JSON.stringify([selected,visit.id,visit.version,appointment?.id,account?.id,account?.version,(workspace.billing?.coverages||[]).map(c=>[c.id,c.version]),workspace.billing?.copays,codesVisible]);if(host.dataset.revenueKey===key&&$('encounter-billing-editor')){if(account&&chartSection==='visits'&&!$('encounter-billing-detail')?.innerHTML)showBillingAccount(account.id,false);loadEncounterRevenueStatus(account);if(appointment&&billingCan('create'))void loadHostedCopays(appointment.id);if(typeof resumeEncounterChargeDraft==='function')resumeEncounterChargeDraft();return;}if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();host.dataset.revenueKey=key;
 const owner=typeof me!=='undefined'&&me?.role==='owner';
  // Whether this role sees codes & charges at all. A person without billing keeps the note's own
  // diagnoses editor, so the codes block draws none of its own (visitNoteOwnsDiagnoses).
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
 rebuilt.innerHTML=`${typeof invoiceTabsMarkup==='function'?invoiceTabsMarkup():''}<div class="section-head"><div><h2>Procedures (CPT)</h2><p class="muted">${esc(visitBillingDate(serviceDate))} · ${account?account.status==='posted'?'Posted':'Charges can still be changed':'No charges yet'}</p></div></div><div id="encounter-revenue-status">${encounterRevenueStatusMarkup(account,encounterRevenueState.visit===visit.id&&encounterRevenueState.patient===selected?encounterRevenueState.data||{}:{})}</div><section id="visit-billing-collect" class="billing-section" hidden><div class="section-head"><h3>Collect payment</h3><button type="button" class="text-button" data-visit-collect-close>Close</button></div><p class="muted" id="visit-billing-collect-note"></p>${hostedCopayPanel(appointment,'encounter-hosted-copay')}${billingCan('create')&&appointment?`<div class="actions visit-billing-collect-cash"><button type="button" data-record-copay="${esc(appointment.id)}">Cash or check</button></div>`:''}</section><div id="encounter-copay-receipt" hidden></div><div id="encounter-billing-editor"></div>${account?'<div class="invoice-lines" id="encounter-billing-detail"></div>':''}${account?'<section class="billing-section" id="visit-billing-payments"><h3>Payments</h3><div id="visit-billing-ledger"></div></section>':''}${account?'<section class="billing-section" id="visit-billing-invoices"></section>':''}<details class="encounter-account-record" id="visit-billing-history"><summary>History</summary><div id="visit-billing-timeline"><p class="muted">Loading history…</p></div>${owner?`<details class="encounter-account-record" id="visit-billing-details" hidden><summary>Technical details</summary><div id="visit-billing-technical"></div><p class="muted">${coverage?esc(payerName(coverage.content.payer_id)):'No insurance on file'} · Plan copay ${coverage?.content.copay_cents==null?'not recorded':money(coverage.content.copay_cents)}</p>${typeof billingCoverageOrderMarkup==='function'?billingCoverageOrderMarkup(serviceDate,account?.content.coverage_id||coverage?.id):''}${account?'<div class="actions"><button type="button" data-bill-history>Change log for these charges</button></div><div id="bill-history"></div>':''}</details>`:''}</details><section id="encounter-claims" hidden></section>`;
  // The body is written as before; the host, held outside that markup, is then moved to the top of
  // the block above the charge lines — moved, never re-created, so what it holds comes with it.
  const codeDialog=$('visit-page-host')?.querySelector?.('[data-encounter-codes-dialog]');
  const keepDiagnoses=codesVisible&&codeDialog&&encounterCodesDialogCurrent(codeDialog)&&codeDialog.contains(diagnosesHost);
  const existingEditor=codeDialog?.querySelector?.('#encounter-billing-editor');
  const liveForm=existingEditor?.querySelector('#billing-account-form');
  const compatible=codesVisible&&liveForm&&encounterCodesDialogCurrent(codeDialog)&&liveForm.dataset.patient===selected&&
    (liveForm.elements.visit_id?.value===visit.id)&&((liveForm.dataset.id||'')===(account?.id||''))&&
    (!account||Number(liveForm.dataset.version)===account.version)&&((liveForm.dataset.mode==='correction')===(account?.status==='posted'));
  if(compatible)holder?.querySelector?.('#encounter-billing-editor')?.remove();
  else if(existingEditor){if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();existingEditor.remove();}
  const bodyMarkup=rebuilt.innerHTML;
  for(const id of ['encounter-revenue-status','encounter-billing-editor','encounter-billing-detail','visit-billing-payments','visit-billing-invoices','encounter-copay-receipt','encounter-claims']){const old=$(id);if(old&&!host.contains?.(old)&&(!old.closest?.('dialog')||old.closest?.('[data-encounter-codes-dialog]')&&!(compatible&&old===existingEditor)))old.remove?.();}
  host.innerHTML=bodyMarkup;
  if(diagnosesHost&&typeof host.insertBefore==='function'){
   // insertBefore moves the node: the host was already taken out above, so it is only put back.
   if(!keepDiagnoses)host.insertBefore(diagnosesHost,host.firstChild||null);
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
 const dxState=typeof visitDiagnosisStates==='undefined'?null:visitDiagnosisStates.get(visit.id);
 if(codesVisible&&encounterDiagnosesHost()&&!(keepDiagnoses&&dxState?.patientId===selected&&dxState.version===visit.version&&diagnosesHost.querySelector('#visit-diagnoses-form')))renderEncounterDiagnoses();
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
 let account=encounterChargeAccount();
 const state=encounterRevenueState;if(!account||account.status!=='draft')return false;
 const patient=selected,identity=me,visit=typeof activeVisit==='undefined'?null:activeVisit?.id,accountId=account.id;
 const current=()=>selected===patient&&me===identity&&(typeof activeVisit==='undefined'?null:activeVisit?.id)===visit&&encounterChargeAccount()?.id===accountId;
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
 // Codes are checked on every post, as approving an encounter does elsewhere: what must be fixed
 // stops the post and is shown on the table; what should be checked is asked about once.
 const editor=$('billing-account-form');
 const form=editor?.dataset.id===accountId&&editor.dataset.patient===patient&&editor.elements.visit_id?.value===account.content.visit_id?editor:null;
 const findings=form&&typeof encounterCodeFindings==='function'?encounterCodeFindings(form):[];
 const fixes=findings.filter(f=>f.level==='fix'),reviews=findings.filter(f=>f.level==='review');
 if(fixes.length){
  // What has to be fixed is listed beside the codes, so the codes open over the page to show it.
  encounterCodesEditorOpen();
  renderEncounterCodeChecks(form,findings);
  const first=fixes[0],target=first.row?.querySelector(first.fieldProblem?'[data-charge-problem]':'[data-line-code-check]')||form.querySelector('[data-code-check]');
  if(target){
   target.setAttribute('tabindex','-1');target.focus({preventScroll:true});
   target.scrollIntoView({block:'center',behavior:typeof motionReduced==='function'&&motionReduced()?'instant':'smooth'});
  }
  notice(`${fixes.length===1?'1 thing needs':fixes.length+' things need'} fixing before these charges can be posted.`,true);
  visitChargePostResult.cancelled=true;return false;
 }
 if(form&&typeof flushEncounterProcedures==='function')await flushEncounterProcedures(form,current);
 if(!current())return false;
 account=encounterChargeAccount();if(account.status!=='draft')return false;
 const insured=state.data?.summary?.insurance?.insured===true&&account.content.coverage_id!=null;
 const message=options.send&&insured?`Charges of ${money(account.total_cents)} become final. Review and submit the claim on the Claim.MD form.`:insured?`Charges of ${money(account.total_cents)} become final and the insurance claim is prepared.`:`Charges of ${money(account.total_cents)} become final.`;
 const held=account.content.claim_details?.review_requested===true;
 const checks=reviews.length?`\n\nCheck before posting:\n${reviews.map(f=>'• '+(f.code?f.code+' · ':'')+f.text).join('\n')}`:'';
 if(!await confirmAction(message+(held?' These charges were held for review; posting approves them.':'')+checks,{title:held?'Approve and post these charges?':'Post these charges?',confirmLabel:held?'Approve and post':'Post charges'})){visitChargePostResult.cancelled=true;return false;}
 if(!current())return false;
 if(encounterChargeAccount()?.version!==account.version)throw new Error('The charges changed. Review the saved amount before posting.');
 await api(`${billingBase()}/${account.id}/actions`,'POST',{action:'post',reason:held?'Charges reviewed and posted':'Charges posted',local_only:false,...(held?{review_approved:true}:{})},account.version);
 visitChargePostResult.posted=true;
 if(!current())return;
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
 if($('visit-page-host')?.dataset?.encounterSteps!==undefined&&state.data?.summary?.visit?.id===activeVisit?.id&&activeVisit?.status==='signed')return visitClaimHandoff(false);
 const button=visitBillingRefreshButton();
 if(button){button.disabled=true;button.textContent='Sending…';}
 await postVisitChargesFromCard({send:true});
 if(visitChargePostResult.cancelled||!visitChargePostResult.posted){
  // Nothing happened, so the button is pressed again exactly as it was before the press.
  if(button&&button.isConnected!==false){button.disabled=false;button.textContent='Post charges and review claim';}
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
 if($('visit-page-host')?.dataset?.encounterSteps!==undefined&&activeVisit?.status==='signed'&&summary?.visit?.id===activeVisit?.id&&summary?.claim?.id===claimId)return visitClaimHandoff(false);
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
 if(button.dataset.insuranceStage){event.preventDefault();if(chartSection!=='insurance'||!['insurance-review-title','insurance-copay-title','insurance-continue-title'].includes(button.dataset.insuranceStage))return;const heading=$(button.dataset.insuranceStage);heading?.focus({preventScroll:true});alignChartContent();return;}
 if(button.dataset.insuranceCheckIn){event.preventDefault();run(()=>checkInInsuranceAppointment(button.dataset.insuranceCheckIn));return;}
 if(button.dataset.refreshEligibility){event.preventDefault();loadInsuranceEligibility(button.dataset.refreshEligibility,true);return;}
 if(button.hasAttribute('data-refresh-revenue')){event.preventDefault();loadEncounterRevenueStatus(encounterChargeAccount(),true);return;}
 if(button.dataset.insuranceCopayCollect){
  event.preventDefault();
  if(chartSection!=='insurance'||button.dataset.patient!==selected||workspace.patient?.id&&workspace.patient.id!==selected)return;
  const appointment=revenueAppointment();
  if(appointment?.id!==button.dataset.insuranceCopayCollect)return;
  if($('insurance-editor')?.querySelector?.('form')){notice('Save or cancel the insurance form before opening payments.',true);return;}
  if(!openInsuranceCopayModal(insuranceCopayContext(appointment),button))notice('Reopen copay payments from the selected appointment.',true);
  return;
 }
 if(button.hasAttribute('data-visit-collect')){event.preventDefault();openVisitCollect();return;}
 if(button.hasAttribute('data-visit-collect-close')){event.preventDefault();if(collectDialog){sheetClose(collectDialog);return;}const panel=$('visit-billing-collect');if(panel)panel.hidden=true;return;}
 if(button.hasAttribute('data-prior-auth-save')){
  event.preventDefault();
  const box=button.closest('[data-prior-auth-edit]'),input=box?.querySelector('input');
  if(!box||!input)return;
  const dialog=box.closest('[data-signed-claim-details]'),person=selected,visit=activeVisit?.id,identity=me;
  const current=()=>person===selected&&visit===activeVisit?.id&&identity===me&&(!dialog||dialog.open&&dialog.isConnected&&encounterRevenueState.data?.summary?.claim?.id===box.dataset.claim);
  const alert=dialog?.querySelector('[data-signed-claim-authorization-alert]');
  const value=input.value;
  button.disabled=true;
  run(async()=>{
   try{
    const saved=await chargePriorAuthorizationSave(box.dataset.claim,value,current);
    if(!saved||!current())return;
    const number=saved.content?.encounter?.prior_authorization_number||'';
    if(input.value===value)input.value=number;
    input.defaultValue=number;
    const display=dialog?.querySelector('[data-signed-claim-authorization]');
    if(display)display.textContent=number||'Not entered';
    if(alert)alert.hidden=true;
    notice('Prior authorization number saved.');
    await loadEncounterRevenueStatus(encounterChargeAccount(),true);
   }catch(error){
    if(!alert||!current())throw error;
    alert.textContent=visitClaimErrorText(error);
    alert.hidden=false;
   }finally{button.disabled=false;}
  });
  return;
 }
 if(button.hasAttribute('data-visit-claim-resend')){event.preventDefault();button.disabled=true;button.textContent='Sending…';run(()=>visitClaimResend(button));return;}
 if(button.dataset.visitClaimPrepare!==undefined){event.preventDefault();button.disabled=true;run(()=>prepareVisitClaim(button.dataset.visitClaimPrepare==='again'));return;}
 if(button.dataset.visitClaimDirectSend){event.preventDefault();run(()=>sendVisitClaimNow(button.dataset.visitClaimDirectSend,button));return;}
 if(button.dataset.visitPostAndSend){event.preventDefault();run(()=>postVisitChargesAndSend());return;}
 if(button.dataset.visitClaimSend){event.preventDefault();visitReviewOpen();return;}
 if(button.dataset.visitClaimFix&&button.dataset.visitReviewFix!=='claim'){event.preventDefault();run(async()=>{const account=encounterChargeAccount();if(!account)throw new Error('Open the encounter for these charges first.');const id=button.dataset.visitClaimSend||button.dataset.visitClaimFix;await showEncounterClaim(id,account.id);if(button.dataset.visitClaimFix&&typeof claimCurrent!=='undefined'&&claimCurrent?.id===id&&claimCurrent.status==='draft'){if(typeof openClaimQuickFix==='function'&&openClaimQuickFix())return;claimEditor(claimCurrent.snapshot.account,claimCurrent);}else{
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
 if(button.dataset.visitPostCharges){
  event.preventDefault();
  if(button.hasAttribute('data-encounter-post-charges')&&encounterChargeAccount()?.id!==button.dataset.visitPostCharges)return;
  run(()=>postVisitChargesFromCard());return;
 }
 if(button.dataset.revenueAccount){event.preventDefault();if(billingSelected!==button.dataset.revenueAccount||!$('encounter-billing-detail')?.innerHTML)showBillingAccount(button.dataset.revenueAccount,false);const details=$('encounter-charge-details');if(details)details.open=true;$('encounter-billing-detail')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
 if(button.dataset.revenueClaim||button.dataset.revenueRemittance){
  event.preventDefault();
  run(async()=>{
   if(button.dataset.revenueRemittance){await showClaimsWorkspace();await showEra(button.dataset.revenueRemittance);return;}
   const account=encounterChargeAccount();if(!account)throw new Error('Select the encounter charge account.');
   const claimId=button.dataset.revenueClaim;
   if(typeof visitOpenCurrentEncounterClaim==='function'&&await visitOpenCurrentEncounterClaim(claimId,account.id))return;
   if($('visit-page-host')?.dataset?.encounterSteps!==undefined){await showClaimsWorkspace();await showClaim(claimId);}
   else await showEncounterClaim(claimId,account.id);
  });return;
 }
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

document.addEventListener('change',event=>{
 if(event.target.id!=='insurance-appointment'||chartSection!=='insurance')return;
 const appointment=event.target.value;
 if((workspace.appointments||[]).some(row=>row.id===appointment))insuranceAppointmentSelection.set(selected,appointment);
 else insuranceAppointmentSelection.delete(selected);
 renderPatientInsurance();
});

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
 return {patient:selected,identity:me,section:chartSection,visit:typeof activeVisit==='undefined'?null:activeVisit?.id,step:typeof encounterSection==='undefined'?null:encounterSection,appointment:revenueAppointment()?.id,editor,editorChild:editor?.firstChild,collect:collectDialog,method:collectDialog?.dataset.method};
}
function currentHostedCopayView(view,checkEditor=true){
 return selected===view.patient&&me===view.identity&&chartSection===view.section&&(typeof activeVisit==='undefined'?null:activeVisit?.id)===view.visit&&(typeof encounterSection==='undefined'?null:encounterSection)===view.step&&revenueAppointment()?.id===view.appointment&&(!view.collect||collectDialog===view.collect&&view.collect.isConnected&&view.method===view.collect.dataset.method)&&(!checkEditor||!view.editor||typeof billingEditorHost==='function'&&billingEditorHost()===view.editor&&view.editor.firstChild===view.editorChild);
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
  const loaded=await selectPatient(operation.patient_id,null,current,{deferPresentation:true});
  if(!loaded||!current())return;
  if(selected!==operation.patient_id||workspace?.patient?.id!==operation.patient_id||!workspace.appointments?.some(item=>item.id===operation.appointment_id))throw new Error('The appointment could not be opened. Review its payment status before collecting again.');
  insuranceAppointmentSelection.set(operation.patient_id,operation.appointment_id);
  activeVisit=workspace.visits?.find(visit=>visit.appointment_id===operation.appointment_id);
  chartSection=activeVisit?'visits':'insurance';encounterSection='visit';
  showTool('Patients & encounters');$('tools').replaceChildren();$('tools').hidden=true;$('clinical-workspace').hidden=false;
  $('new-patient').hidden=!canRegisterPatient();$('toggle-directory').hidden=false;
  const state=hostedCopayStateFor(operation.appointment_id);acceptHostedCopayOperation(state,operation);
  renderChart();revealPatientChart();showChartSection(chartSection);
  if(typeof frameOpenPatient==='function')frameOpenPatient(workspace.patient);
  const insurancePage=chartSection==='insurance';
  if(activeVisit){encounterStepsSync();encounterStepOpen('2',{focus:true});}
  else $('insurance-page-copay')?.scrollIntoView?.({block:'center'});
  notice(refreshFailed?statusMessage:operation.status==='paid'&&operation.receipt_id?(insurancePage?'Card payment verified. Open View payments for the receipt.':'Card payment verified. Review the recorded receipt below.'):operation.status==='open'?'Checkout is still awaiting payment. Returning here did not charge the card.':insurancePage?'Open the Copay panel for the recorded card status.':'Review the recorded card payment status below.',refreshFailed);
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
 paintInsuranceCopaySummary(state);
 for(const id of ['insurance-hosted-copay','insurance-page-hosted-copay','encounter-hosted-copay','hosted-copay-operation']){const node=$(id);if(node?.dataset.appointment===state.appointment){const expanded=node.querySelector?.('[data-hosted-disclosure]')?.open;node.innerHTML=hostedCopayMarkup(state,id==='encounter-hosted-copay');const details=node.querySelector?.('[data-hosted-disclosure]');if(details)details.open=!!expanded;}}
 if(collectDialog?.isConnected&&collectSession.insurance?.appointment===state.appointment)paintInsuranceCopayModal(state);
 else if(collectDialog?.isConnected)paintEncounterCollectModal(state);
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
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)||panelId==='insurance-collect-payment'?attemptedCents:visitCollectAmount(appointmentId,plan);
 if(holder)holder.innerHTML=`<form id="hosted-copay-form" class="billing-section"${collectSession.encounter&&holder?' data-encounter-collect':''} data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Send a payment link</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p>${plan==null?'No plan copay has been recorded. Confirm the amount for this encounter.':'Recorded plan copay: '+money(plan)+'. Confirm the benefit and amount before collection.'}</p><label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label><p class="muted">Card details are entered on a secure checkout page. A receipt appears only after SunCharts verifies payment. Returning from checkout alone does not record a payment.</p><button type="submit" class="primary">Prepare secure card checkout</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`;
 else drawReaderCopay(panelId,`<form id="hosted-copay-form" class="billing-section" data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Collect card copay${state.availability.livemode?'':testPaymentTag()&&' · '+testPaymentTag()}</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p><p>${plan==null?'No plan copay has been recorded. Confirm the amount for this encounter.':'Recorded plan copay: '+money(plan)+'. Confirm the benefit and amount before collection.'}</p><label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label><p class="muted">Card details are entered on a secure checkout page. A receipt appears only after SunCharts verifies payment. Returning from checkout alone does not record a payment.</p><button type="submit" class="primary">Prepare secure card checkout</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`);
}
// The reader form and its live status are drawn directly under the copay controls that were
// pressed, on the screen staff are already on. Nothing here changes the page or the tab.
function readerCopaySlot(panelId){
 if(panelId==='insurance-collect-payment')return collectDialog?.isConnected&&collectSession.insurance?collectPanelTarget():null;
 const known=['encounter-hosted-copay','insurance-hosted-copay','insurance-page-hosted-copay'],preferred=known.includes(panelId)?panelId:(typeof chartSection!=='undefined'&&chartSection==='visits'?known[0]:known[1]);
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
 const auto=holder&&!collectSession.insurance&&!collectSession.tenderChosen&&collectDialog?.dataset.method==='reader';
 const readers=await readersForPayment(!auto);if(!readers||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 hostedCopayState.readers=readers;
 if(holder&&collectSession.encounter)paintEncounterCollectModal(state);
 if(auto&&!collectSession.tenderChosen&&!readers.some(reader=>reader.online)){collectMethod('cash',false);return;}
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)||panelId==='insurance-collect-payment'?attemptedCents:visitCollectAmount(appointmentId,plan),test=!state.availability.livemode&&typeof testPaymentLabel==='function'?testPaymentLabel():'';
 const form=`<form id="reader-copay-form" class="billing-section"${collectSession.encounter&&holder?' data-encounter-collect':''} data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Take card payment on reader</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}${test?' · '+test:''}</p>${plan==null?'':`<p>Recorded plan copay: ${money(plan)}.</p>`}<label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label>${readerChoiceMarkup(readers)}<p class="muted">The patient taps, inserts or swipes their card on the reader.</p><button type="submit" class="primary">Take payment</button><button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`;
 if(holder)holder.innerHTML=form;else drawReaderCopay(panelId,form);
}
// Charging a card on file uses the same slot under the copay controls: the form, the amount
// check and the result all stay where the button was pressed.
async function openSavedCardCopayEditor(appointmentId,panelId,attemptedCents){
 const holder=collectDialog?.querySelector('[data-collect-holder]'),view=hostedCopayView(),state=await loadHostedCopays(appointmentId,true);if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(!state.availability?.available||typeof state.availability.livemode!=='boolean'||state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status))){paintHostedCopayState(state);notice('Review the current card payment status before collecting another copay.',true);return;}
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);if(!appointment||['cancelled','canceled','no_show'].includes(appointment.status))throw new Error('Choose an active appointment for card collection.');
 const found=await savedCardsForCharge(state.patient);if(!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;
 if(holder&&!collectSession.insurance&&!collectSession.tenderChosen&&!found.cards.length){collectMethod('cash',false);return;}
 const coverage=revenueCoverage(revenueServiceDate(appointment)),plan=coverage?.content.copay_cents,amount=Number.isSafeInteger(attemptedCents)||panelId==='insurance-collect-payment'?attemptedCents:visitCollectAmount(appointmentId,plan),test=state.availability.livemode?'':testPaymentTag();
 hostedCopayState.savedCards=found.cards;
 const form=`<form id="saved-card-copay-form" class="billing-section"${collectSession.encounter&&holder?' data-encounter-collect':''} data-panel="${esc(panelId||'')}" data-patient="${esc(state.patient)}" data-appointment="${esc(appointmentId)}" data-coverage="${esc(coverage?.id||'')}" data-livemode="${state.availability.livemode===true}" data-request="${crypto.randomUUID()}"><h3>Charge card on file</h3><p>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}${test?' · '+test:''}</p>${plan==null?'':`<p>Recorded plan copay: ${money(plan)}.</p>`}${found.cards.length?`<label>${copayAmountLabel(plan,amount)}<input name="amount" required inputmode="decimal" value="${amount==null?'':esc(dollars(amount))}"></label>`:''}${savedCardChoiceMarkup(found)}${found.cards.length?'<p class="muted">The patient does not need to be here.</p><button type="submit" class="primary">'+(collectSession.encounter&&holder?'Charge card on file':'Review charge')+'</button>':''}<button type="button" data-close-reader-copay="${esc(panelId||'')}">Cancel</button></form>`;
 if(holder)holder.innerHTML=form;else drawReaderCopay(panelId,form);
}
// The amount is shown once more before the card is charged.
function confirmSavedCardCopay(state,body,panelId){
 const card=(hostedCopayState.savedCards||[]).find(item=>item.setup_id===body.saved_card_setup_id);
 hostedCopayState.savedCardCharge={state,body,panelId};
 drawReaderCopay(panelId,`<section class="billing-section" id="saved-card-copay-confirm"><h3>Charge card on file</h3><p>Charge <b>${money(body.amount_cents)}</b>${card?' to '+esc(savedCardName(card)):''}?</p><div class="actions"><button type="button" class="primary" data-saved-card-copay-charge>Charge ${money(body.amount_cents)}</button><button type="button" data-saved-card-copay-back>Back</button></div></section>`);
}
function showSavedCardCopay(state,operation,panelId){
 const dialog=collectDialog;
 const base=`${hostedCopayBase(state)}/${encodeURIComponent(operation.id)}`;
 const marker=panelId==='insurance-collect-payment'?` data-appointment-pos-operation="${esc(operation.id)}"`:'';
 if(!drawReaderCopay(panelId,`<div id="saved-card-payment-live"${marker}></div>`))return;
 if(marker)paintInsuranceCopayModal(state);
 watchSavedCardPayment({operation,refreshUrl:`${base}/refresh`,
  accept:next=>{if(currentHostedCopayState(state))acceptHostedCopayOperation(state,next);},
  finished:done=>{if(dialog&&collectDialog===dialog&&(panelId==='insurance-collect-payment'?done.status==='paid'&&done.receipt_id:['paid','refunded'].includes(done.status)))collectPartTaken(done.amount_cents,'card on file',done.receipt_id?{id:done.receipt_id}:null,done.appointment_id,{kind:'card'});},
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
 const dialog=collectDialog;
 const reader=(hostedCopayState.readers||[]).find(item=>item.id===operation.reader_id),base=`${hostedCopayBase(state)}/${encodeURIComponent(operation.id)}`;
 const marker=panelId==='insurance-collect-payment'?` data-appointment-pos-operation="${esc(operation.id)}"`:'';
 if(!drawReaderCopay(panelId,`<div id="reader-payment-live"${marker}></div>`))return;
 if(marker)paintInsuranceCopayModal(state);
 watchReaderPayment({operation,readerName:reader?.name,statusUrl:base,cancelUrl:`${base}/reader-cancel`,simulateUrl:`${base}/reader-simulate-tap`,simulated:reader?.simulated===true,
  // Try again keeps the amount that was just attempted.
  again:()=>openReaderCopayEditor(state.appointment,panelId,operation.amount_cents),
  finished:done=>{if(dialog&&collectDialog===dialog&&(panelId==='insurance-collect-payment'?done.status==='paid'&&done.receipt_id:['paid','refunded'].includes(done.status)))collectPartTaken(done.amount_cents,'card on the reader',done.receipt_id?{id:done.receipt_id}:null,done.appointment_id,{kind:'card'});},
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
  if(view.collect&&collectSession.insurance?.appointment===appointment){await refreshInsuranceCopayChart(collectSession.insurance);return;}
  const section=chartSection,visit=typeof activeVisit!=='undefined'?activeVisit?.id:null;
  await selectPatient(state.patient,visit);if(!currentHostedCopayState(state)||!currentHostedCopayView(view,false))return;showChartSection(section);if(section==='visits'&&typeof setEncounterSection==='function')setEncounterSection('charges');
 }
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.copayReturnRetry){event.preventDefault();run(()=>openHostedCopayReturn(button.dataset.copayReturnRetry));return;}
 if(button.dataset.collectCardCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay,#insurance-page-hosted-copay,#insurance-collect-payment')?.id;run(()=>openHostedCopayEditor(button.dataset.collectCardCopay,panel));return;}
 if(button.dataset.readerCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay,#insurance-page-hosted-copay,#insurance-collect-payment')?.id;run(()=>openReaderCopayEditor(button.dataset.readerCopay,panel));return;}
 if('closeReaderCopay' in button.dataset){event.preventDefault();const slot=readerCopaySlot(button.dataset.closeReaderCopay);if(slot)slot.innerHTML='';return;}
 if(button.dataset.watchReaderCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay,#insurance-page-hosted-copay,#insurance-collect-payment')?.id;run(()=>watchReaderCopay(button.dataset.appointment,button.dataset.watchReaderCopay,panel));return;}
 if(button.dataset.cancelReaderCopay){event.preventDefault();run(()=>cancelReaderCopay(button.dataset.appointment,button.dataset.cancelReaderCopay));return;}
 if(button.dataset.cancelCopayLink){event.preventDefault();run(()=>cancelCopayLink(button.dataset.appointment,button.dataset.cancelCopayLink));return;}
 if(button.dataset.savedCardCopay){event.preventDefault();const panel=button.closest?.('#encounter-hosted-copay,#insurance-hosted-copay,#insurance-page-hosted-copay,#insurance-collect-payment')?.id;run(()=>openSavedCardCopayEditor(button.dataset.savedCardCopay,panel));return;}
 if('savedCardCopayCharge' in button.dataset){event.preventDefault();const pending=hostedCopayState.savedCardCharge;if(!pending)return;hostedCopayState.savedCardCharge=null;button.disabled=true;run(async()=>{if(pending.panelId==='insurance-collect-payment')await checkInsuranceCopayTender(pending.panelId,pending.state.appointment,'saved');await createSavedCardCopay(pending.state,pending.body,pending.panelId);});return;}
 if('savedCardCopayBack' in button.dataset){event.preventDefault();const pending=hostedCopayState.savedCardCharge;if(!pending)return;hostedCopayState.savedCardCharge=null;run(()=>openSavedCardCopayEditor(pending.state.appointment,pending.panelId,pending.body.amount_cents));return;}
 if(button.dataset.retryHostedCopay){event.preventDefault();run(async()=>{const state=hostedCopayStateFor(button.dataset.retryHostedCopay);if(!state.uncertain||!state.retry)throw new Error('Refresh the current card payment status.');if(state.retry.reader_id)await createReaderCopay(state,state.retry,state.retryPanel);else if(state.retry.saved_card_setup_id)await createSavedCardCopay(state,state.retry,state.retryPanel);else await createHostedCopay(state,state.retry,state.retryPanel);});return;}
 if(button.dataset.refreshHostedCopay){event.preventDefault();run(()=>refreshHostedCopay(button.dataset.appointment,button.dataset.refreshHostedCopay));return;}
 if(button.dataset.hostedCopayReceipt){event.preventDefault();run(async()=>{const state=hostedCopayStateFor(button.dataset.appointment),receipt=button.dataset.hostedCopayReceipt;if(!state.items.some(item=>item.receipt_id===receipt))throw new Error('Refresh this appointment’s card payments first.');await showCopayReceipt(receipt,state.appointment);});return;}
 if(button.dataset.refreshHostedCopayList){
  event.preventDefault();run(async()=>{
   const view=hostedCopayView(),state=await loadHostedCopays(button.dataset.refreshHostedCopayList,true);
   if(!state||!currentHostedCopayState(state)||!currentHostedCopayView(view))return;
   if(view.collect&&collectSession.insurance?.appointment===state.appointment){await refreshInsuranceCopayChart(collectSession.insurance);return;}
   if(!state.items.some(item=>item.receipt_id))return;
   const section=chartSection;
   await selectPatient(state.patient,typeof activeVisit!=='undefined'?activeVisit?.id:null);
   if(currentHostedCopayState(state)&&currentHostedCopayView(view,false))showChartSection(section);
  });
 }
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='reader-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 if(!data.reader)throw new Error('Choose a card reader.');
 if(form.dataset.panel==='insurance-collect-payment')await checkInsuranceCopayTender(form.dataset.panel,state.appointment,'reader');
 const amount=cents(data.amount);
 const body={request_id:form.dataset.request,amount_cents:amount,coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Appointment copay taken on card reader',reader_id:data.reader,...collectCardFields(amount,state.appointment)};
 await runEncounterCollectTender(form,'reader',()=>createReaderCopay(state,body,form.dataset.panel||undefined));
 });
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='saved-card-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 if(!data.card)throw new Error('Choose a card on file.');
 if(form.dataset.panel==='insurance-collect-payment'&&!insuranceCopayTenderAvailable(collectSession.insurance,'saved',state))throw new Error('Review the current payment status before taking another payment.');
 const amount=cents(data.amount);if(!Number.isSafeInteger(amount)||amount<50)throw new Error('Enter the payment amount.');
 const body={request_id:form.dataset.request,amount_cents:amount,coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Copay charged to card on file',saved_card_setup_id:data.card,...collectCardFields(amount,state.appointment)};
 if(form.hasAttribute('data-encounter-collect'))await runEncounterCollectTender(form,'saved',()=>createSavedCardCopay(state,body,form.dataset.panel||undefined));
 else confirmSavedCardCopay(state,body,form.dataset.panel||undefined);
 });
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='hosted-copay-form')return;event.preventDefault();
 run(async()=>{const patient=form.dataset.patient,state=hostedCopayStateFor(form.dataset.appointment),data=Object.fromEntries(new FormData(form));
 if(patient!==selected||state.patient!==patient)throw new Error('Patient changed. Reopen card collection from the correct chart.');
 const amount=cents(data.amount);
 const body={request_id:form.dataset.request,amount_cents:amount,coverage_id:form.dataset.coverage||null,livemode:form.dataset.livemode==='true',reason:'Reviewed appointment copay before hosted card collection',...collectCardFields(amount,state.appointment)};
 if(form.dataset.panel==='insurance-collect-payment')await checkInsuranceCopayTender(form.dataset.panel,state.appointment,'link');
 await runEncounterCollectTender(form,'link',()=>createHostedCopay(state,body,form.dataset.panel||undefined));
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
// Existing billing destinations remain available to legacy actions and the editor sheet.
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
function encounterCodesStripMarkup(evidence,{interactive=true,includeProcedures=true,needsDiagnosis=false,needsProcedure=false}={}){
 const list=evidence?.diagnoses,lines=evidence?.lines||[],letter=i=>typeof visitDiagnosisLetter==='function'?visitDiagnosisLetter(i):String.fromCharCode(65+i);
 const diagnoses=!evidence||list===null||list===undefined?'<p class="muted">Diagnoses could not be loaded.</p>':list.length?`<ol>${list.map((d,i)=>`<li><b>${letter(i)}</b> <span class="codes-strip-code">${esc(String(d.code).trim())}</span> <span>${esc(d.display||'')}</span>${i===0?' <span class="muted">primary</span>':''}</li>`).join('')}</ol>`:needsDiagnosis?'<p class="encounter-code-needed">Add a diagnosis to bill this visit.</p>':'<p class="muted">No diagnoses yet.</p>';
 const total=lines.reduce((sum,line)=>sum+(Number(line.amount_cents)||0),0);
 const procedures=lines.length?`<ol>${lines.map(line=>`<li><span class="codes-strip-code">${esc(line.code||'')}${line.modifiers?'-'+esc(String(line.modifiers).trim().replace(/[,\s]+/g,'-')):''}</span> <span>${esc(line.description||'')}${Number(line.units)>(interactive?1:0)?` × ${esc(line.units)}`:''}</span><span class="codes-strip-amount">${line.amount_cents==null?'':money(line.amount_cents)}</span></li>`).join('')}</ol>${interactive?`<p class="codes-strip-total"><span>Total charges</span><b>${money(total)}</b></p>`:''}`:needsProcedure?'<p class="encounter-code-needed">Add a procedure to bill this visit.</p>':'<p class="muted">No procedures yet.</p>';
 const any=(list&&list.length)||lines.length;
 return `<div class="codes-strip-col"><h4>Diagnoses (ICD-10)</h4>${diagnoses}</div>${includeProcedures?`<div class="codes-strip-col"><h4>Procedures (CPT)</h4>${procedures}</div>`: ''}${interactive?`<div class="codes-strip-actions"><button type="button" class="${any?'text-button':'secondary'}" data-codes-strip-edit>${any?'Edit codes':'Add codes'}</button><button type="button" class="text-button" data-codes-strip-cms hidden>Preview CMS-1500</button></div>`:''}`;
}
// The claim form is offered beside the codes once this encounter has a claim to show.
function encounterCodesStripClaimSync(){
 const button=typeof $==='function'?$('encounter-codes-strip')?.querySelector?.('[data-codes-strip-cms]'):null;if(!button)return;
 const claim=encounterRevenueState.data?.summary?.claim,id=claim?.id&&claim.status!=='void'&&!claim.secondary&&!claim.crossover?claim.id:'';
 button.hidden=!id;button.dataset.codesStripCms=id;
}
// The CMS-1500 view of the claim, opened over the page. Looking at it sends nothing.
async function openClaimFormPreview(claimId,current=()=>true){
 const response=await fetch(`/api/v1/billing/claims/${encodeURIComponent(claimId)}/cms1500`,{credentials:'same-origin'});
 if(!current())return;
 if(!response.ok)throw new Error('The claim form could not be opened. Refresh the encounter and try again.');
 // The form's own zoom and print buttons need its script, which a preview does not run; the sheet has Print.
 const html=(await response.text()).replace(/<div class=preview-actions[\s\S]*?<\/div>/,'');
 if(!current())return;
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
 const strip=typeof $==='function'?$('encounter-codes-strip'):null,visit=typeof activeVisit!=='undefined'?activeVisit:null;
 const page=typeof $==='function'?$('visit-page-host'):null;
 if(!visit||(!strip?.isConnected&&typeof page?.append!=='function'))return;
 const token=++encounterCodesStripToken;
 if(strip&&!strip.innerHTML)strip.innerHTML=typeof skeletonMarkup==='function'?skeletonMarkup('card'):'<p class="muted">Loading codes…</p>';
 const evidence=await visitReceiptEvidence(visit.appointment_id);
 if(token!==encounterCodesStripToken||(typeof activeVisit!=='undefined'?activeVisit:null)!==visit)return;
 const node=$('encounter-codes-strip');if(node){node.innerHTML=encounterCodesStripMarkup(evidence);encounterCodesStripClaimSync();}
 encounterCodesEvidence={visit:visit.id,evidence};billingRowCodesFill();
 if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();
 if(!encounterRevenueState.review?.busy&&typeof visitReviewPaint==='function')visitReviewPaint();
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
 if(!host?.querySelector||typeof document.createElement!=='function')return;
 if(!host.querySelector('.codes-editor-bar'))host.insertAdjacentHTML?.('afterbegin','<div class="codes-editor-bar"><h3>Edit codes</h3><button type="button" data-codes-editor-close>Close</button></div>');
 if(!host.querySelector('.codes-editor-foot'))host.insertAdjacentHTML?.('beforeend','<div class="codes-editor-foot"><p data-codes-editor-state role="status">Diagnoses and procedures save as you go.</p><button type="button" class="primary" data-codes-editor-save>Save and close</button></div>');
 encounterBarWatch(host);encounterBarSync();
}
// Editing the codes happens over the page: the diagnoses and the procedure lines open as a panel on
// top of whatever tab is showing, and the page under it does not move. Nothing is taken out of the
// page to do it, so saving and refreshing work as they always did.
function encounterCodesEditorOpen(tries=0,create=false,what='codes'){
 const host=typeof $==='function'?$('encounter-revenue'):null;if(!host?.dataset)return;
 if($('visit-page-host')?.dataset.encounterSteps!==undefined){
  encounterOpenCodesDialog(document.activeElement,what);return;
 }
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
  const button=event.target?.closest?.('button');if(!button?.closest?.('#encounter-revenue,#patient-banner,#encounter-bar,#patient-next-action'))return;
  const has=names=>names.some(name=>button.hasAttribute(name));
  if(has(['data-encounter-charges','data-encounter-charges-correct']))setTimeout(()=>encounterCodesEditorOpen(),0);
  else if(has(['data-visit-claim-fix','data-visit-claim-prepare','data-visit-claim-resend','data-revenue-claim','data-claim-open','data-revenue-remittance']))billingPartSet('claim',false);
 },true);
 document.addEventListener('keydown',event=>{if(event.key!=='Escape'||document.querySelector?.('dialog[open]'))return;if($('encounter-revenue')?.dataset?.codesEditing!==undefined){event.preventDefault();encounterCodesEditorClose();}});
 // A field the browser refuses on save has to be on screen to be fixed.
 document.addEventListener('invalid',event=>{const field=event.target;if(!field?.closest?.('#billing-account-form'))return;
  const codes=field.closest('[data-encounter-codes-dialog]');
  if(codes&&encounterCodesDialogCurrent(codes)){
   if(!codes.open)encounterOpenCodesDialog(document.activeElement);
   for(let ancestor=field.parentElement;ancestor&&ancestor!==codes;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS')ancestor.open=true;
   return;
  }
  if(field.closest('[data-visit-charge-options],[data-encounter-provider],details.charge-more-options')){if($('encounter-revenue')?.dataset?.codesEditing!=='details'){encounterCodesEditorClose();invoiceTabSet('billing');encounterCodesEditorOpen(0,false,'details');}}else if($('encounter-revenue')?.dataset?.codesEditing!==''){encounterCodesEditorClose();encounterCodesEditorOpen();}},true);
}
function invoiceTabsMarkup(){return '';}
// Compatibility routes from existing actions open a step on the single encounter page.
function invoiceTabRemembered(){return 'billing';}
function encounterTabForget(){encounterStepView={visit:null,current:null};}
function encounterQueueChargesLink(){
 encounterChargesLink={patient:selected,visit:activeVisit?.id};
 encounterStepsSchedule();
}
function invoiceTabSet(key,remember=true){
 const host=$('encounter-revenue'),page=$('visit-page-host');
 if(host?.dataset)delete host.dataset.invoiceTab;
 if(page?.dataset)delete page.dataset.encounterTab;
 if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();
 if(typeof encounterStepOpen==='function'&&remember){
  if(key==='history'){encounterHistoryOpen();return;}
  encounterStepOpen(key==='note'?1:key==='payments'?2:'claim');
 }
 if(typeof encounterChargeTableInline==='function')encounterChargeTableInline();
 if(typeof encounterCodesStripRender==='function')void encounterCodesStripRender();
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
 if(typeof chartSection==='undefined'||chartSection!=='visits'||typeof inRecordArea==='function'&&inRecordArea())return;
 const editor=typeof $==='function'?$('encounter-billing-editor'):null;if(!editor||editor.firstElementChild)return;
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
 if(typeof showChartSection==='function'&&typeof chartSection!=='undefined'&&chartSection!=='visits')showChartSection('visits');
 if(next==='finish'){run(()=>finishVisitEncounter());return;}
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
 const sent=(summary?.timeline||[]).filter(event=>event.code==='statement_sent');
 const owes=summary?.patient?.owes_now_cents,give=account?.status==='posted'&&billingCan('create')&&(owes==null||owes>0)?'<button type="button" data-visit-statement>Patient statement</button>':'';
 // A statement is the encounter's balance on paper for the patient, not a record of its own: the
 // charges are the codes, and payments always go to the encounter.
 host.innerHTML=`<div class="section-head"><div><h3>Statements</h3><p class="muted">${account?.status!=='posted'?'Statements use posted charges. ':owes==null?'':owes>0?`The patient owes ${money(owes)}. `:'The patient owes nothing on this encounter. '}A statement shows the patient what they owe today.</p></div>${give}</div>${statements.length?`<ol class="encounter-invoice-list">${statements.map(event=>`<li><span><b>${esc(visitBillingDate(event.at))}</b><small>${event.amount_cents==null?'Statement':`Statement · ${money(event.amount_cents)} due`}</small></span><button type="button" data-visit-statement-open="${esc(event.invoice_id)}">View</button></li>`).join('')}</ol>`:''}<h4>Statements sent</h4>${sent.length?'<ul>'+sent.map(event=>`<li>${esc(date(event.at))} · ${esc(event.channel==='portal'?'Patient portal':event.channel)} · ${esc(event.actor_label)}</li>`).join('')+'</ul>':'<p>No deliveries recorded.</p>'}`;
}

// ---- Collect payment, in one window ----------------------------------------------------------
// Every way a patient pays sits in one window over the encounter: cash, check, the card reader,
// a card on file, or a payment link. The reader and card flows are the existing ones, drawn in
// the window, where staff can see the live payment status. A default tender opens its
// form without recording or charging anything.
const collectMethods=[['cash','Cash'],['check','Check'],['reader','Card reader'],['saved','Card on file'],['link','Payment link']];
let collectDialog=null;
// One payment can be taken in parts — card, then cash, then a check — against one amount to
// collect. Each method starts at what is left; the window lists what was taken.
let collectSession={target:null,owedAtOpen:null,taken:[],group:null,encounters:[],current:null};
// Every part taken while the window is open carries the same id, so the parts read as one payment.
function collectGroupField(){return collectDialog&&collectSession.group?{payment_group_id:collectSession.group}:{};}
// A payment can cover other encounters the patient owes for. The open encounter comes first,
// then the others, oldest first; each takes up to what it still owes.
function collectChosen(){return (collectSession.encounters||[]).filter(e=>e.on);}
function collectOthers(){return (collectSession.encounters||[]).some(e=>e.appointment!==collectSession.current);}
function collectIncludesPastBalance(){return (collectSession.encounters||[]).some(e=>e.appointment!==collectSession.current&&(e.on||e.paid>0));}
function collectChosenLeft(){return collectChosen().reduce((sum,e)=>sum+Math.max(0,e.owes-e.paid),0);}
function collectParts(amount){
 if(!collectIncludesPastBalance()||!Number.isSafeInteger(amount)||amount<=0)return null;
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
 return `<details class="collect-past-balances" data-collect-past-balances><summary>Include past balances</summary><fieldset class="collect-encounters"><legend>Encounters to pay</legend>${rows.map(e=>{const left=Math.max(0,e.owes-e.paid);return `<label class="collect-encounter${left?'':' is-paid'}"><input type="checkbox" data-collect-encounter="${esc(e.appointment)}"${e.on?' checked':''}${left?'':' data-collect-paid="true" disabled'}><span>${esc(collectEncounterLabel(e.appointment))}${e.appointment===collectSession.current?' <em>This encounter</em>':''}</span><b>${left?money(left):'Paid'}</b></label>`;}).join('')}<p class="collect-encounters-foot"><button type="button" class="text-button" data-collect-all="${all?'none':'all'}">${all?'Clear all':'Select all'}</button><span>${chosen.length} of ${open.length} ${open.length===1?'encounter':'encounters'} · ${money(collectChosenLeft())}</span></p></fieldset></details>`;
}
function collectEncountersPaint(){
 const node=collectDialog?.querySelector('[data-collect-encounters]');if(!node)return;
 const open=node.querySelector('[data-collect-past-balances]')?.open;
 const active=document.activeElement,appointment=active?.dataset.collectEncounter;
 const all=active?.hasAttribute?.('data-collect-all');
 node.innerHTML=collectEncountersMarkup();
 const details=node.querySelector('[data-collect-past-balances]');
 if(details&&open)details.open=true;
 if(appointment)Array.from(node.querySelectorAll('[data-collect-encounter]')).find(box=>box.dataset.collectEncounter===appointment)?.focus({preventScroll:true});
 else if(all)node.querySelector('[data-collect-all]')?.focus({preventScroll:true});
}
// Each tender asks for one amount. Selecting past balances changes its default amount.
function collectEncountersChanged(){
 collectSession.target=collectTakenCents()+collectChosenLeft();
 collectEncountersPaint();collectProgressPaint();
 const active=collectDialog?.dataset.method,state=hostedCopayStateFor(collectSession.current);
 paintEncounterCollectModal(state);
 if(active&&encounterCollectTenderAvailable(active,state)&&!collectDialog.querySelector('.collect-done'))collectMethod(active,false);
 else if(collectLeftCents()===0)collectPanelTarget()?.replaceChildren();
}
// The patient's other encounters that owe money join the list once they are read.
async function collectLoadEncounters(dialog,patient){
 if(typeof api!=='function'||!patient)return;
 let data;try{data=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/encounters`);}catch{return;}
 if(collectDialog!==dialog||!currentEncounterCollect(collectSession.encounter))return;
 const when=id=>String((workspace.appointments||[]).find(a=>a.id===id)?.starts_at||'');
 const others=(data?.items||[]).filter(item=>item.appointment_id&&item.appointment_id!==collectSession.current&&Number.isSafeInteger(item.owes_now_cents)&&item.owes_now_cents>0)
  .sort((a,b)=>when(a.appointment_id)<when(b.appointment_id)?-1:when(a.appointment_id)>when(b.appointment_id)?1:0);
 if(!others.length)return;
 for(const item of others)if(!collectSession.encounters.some(e=>e.appointment===item.appointment_id))collectSession.encounters.push({appointment:item.appointment_id,owes:item.owes_now_cents,paid:0,on:false});
 collectEncountersPaint();
}
function collectTakenCents(){return collectSession.taken.reduce((sum,part)=>sum+part.amount,0);}
function collectLeftCents(){return collectSession.target==null?null:Math.max(0,collectSession.target-collectTakenCents());}
function collectProgressMarkup(){
 const left=collectLeftCents(),taken=collectSession.taken;
 if(!taken.length)return '';
 return `<div class="collect-progress"><ul class="collect-taken">${taken.map(part=>`<li>✓ ${money(part.amount)} ${esc(part.label)}</li>`).join('')}</ul><p class="collect-left"><span>Left to pay</span><b>${left==null?'—':money(left)}</b></p></div>`;
}
function collectProgressPaint(){const node=collectDialog?.querySelector('[data-collect-progress]');if(node){node.innerHTML=collectProgressMarkup();if(typeof flashUpdated==='function')flashUpdated(node);}}
// A part was taken: count it, and either ask for the rest or finish.
function collectPartTaken(amount,label,receipt,appointment,detail){
 const insurance=collectSession.insurance,encounter=collectSession.encounter,paymentScope=insurance||encounter;
 if(!collectDialog||insurance&&(!currentInsuranceCopay(insurance)||insurance.appointment!==appointment)||
    encounter&&(!currentEncounterCollect(encounter)||encounter.appointment!==appointment))return;
 if(receipt?.id&&paymentScope?.counted?.has(receipt.id))return;
 if(receipt?.id&&paymentScope){paymentScope.counted??=new Set();paymentScope.counted.add(receipt.id);}
 const allocations=collectParts(amount)||[{appointment_id:appointment,amount_cents:amount}];
 for(const part of allocations){
  const encounter=collectSession.encounters?.find(row=>row.appointment===part.appointment_id);
  if(encounter)encounter.paid+=part.amount_cents;
 }
 collectSession.taken.push({amount,label,...(detail||{})});collectDialog.dataset.refresh='1';collectEncountersPaint();collectProgressPaint();
 // What the patient has paid is read again, so the copay shows Paid right away.
 const dialog=collectDialog,scope=collectSession.insurance;
 if(scope){
  if(receipt?.appointment_id===scope.appointment&&!scope.receipts.some(item=>item.id===receipt.id))scope.receipts.unshift(receipt);
  scope.paid+=amount;
  if(scope.due!=null)scope.due=Math.max(0,scope.due-amount);
  paintInsuranceCopayModal(hostedCopayStateFor(scope.appointment));
 }else if(typeof loadEncounterRevenueStatus==='function')void Promise.resolve(loadEncounterRevenueStatus(encounterChargeAccount(),true)).then(()=>{const node=dialog?.querySelector('[data-collect-owed]');if(node&&dialog.isConnected){node.innerHTML=collectOwedMarkup({showDue:false});if(typeof flashUpdated==='function')flashUpdated(node);}}).catch(()=>{});
 const left=collectLeftCents(),slot=collectPanelTarget();if(!slot)return;
 const receiptButton=receipt?.id&&collectSession.group?`<button type="button" data-collect-receipt="${esc(collectSession.group)}" data-appointment="${esc(appointment||'')}">Print receipt</button>`:'';
 if(left>0){slot.innerHTML=`<section class="collect-step-done" role="status"><p><b>✓ ${money(amount)} ${esc(label)} taken.</b> ${money(left)} left to pay. Choose how to take the rest above.</p></section>`;return;}
 slot.innerHTML=collectDoneMarkup(amount,label,receiptButton);
}
function collectAppointmentId(){return collectDialog&&collectSession.current||revenueAppointment()?.id||null;}
// The amount a card panel asks for is the plan's copay only while that copay is what is being
// taken: the whole copay is still due and it is the figure in front of staff. Any other figure
// is simply an amount, so the label must not call it a copay.
function copayAmountLabel(planCents,amountCents){
 // Only the Collect payment window knows what is being taken and can name the field by it.
 // Elsewhere the panel sits under the copay controls and keeps asking for the copay amount.
 if(!collectDialog)return 'Copay amount (USD)';
 const p=collectSession.insurance?{copay_due_cents:collectLeftCents()}:encounterRevenueState?.data?.summary?.patient||{};
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
 const several=collectIncludesPastBalance(),paidFor=(collectSession.encounters||[]).filter(e=>e.paid>0).length;
 const owed=several?collectSession.encounters.filter(e=>e.on||e.paid>0).reduce((sum,e)=>sum+e.owes,0):Number.isSafeInteger(collectSession.owedAtOpen)?collectSession.owedAtOpen:0;
 const taken=collectTakenCents(),parts=collectSession.taken.length,over=Math.max(0,taken-owed);
 const head=parts>1?`${money(taken)} paid in ${parts} parts`:`${money(amount)} ${esc(label)} recorded`;
 const sentence=collectSession.insurance?'Recorded for the selected appointment.':over>0?(over<taken?`${money(over)} more than ${several?'these encounters':'this encounter'} owed stays as credit on the patient's account.`:`${money(taken)} stays as credit on the patient's account. This encounter owed nothing.`):several&&paidFor>1?`The payment is shared between ${paidFor} encounters.`:several&&paidFor===1&&!collectSession.encounters.find(e=>e.paid>0&&e.appointment===collectSession.current)?'The payment goes to the encounter you chose.':collectSession.copayOnly?'The copay is held for this encounter and comes off the bill when its charges are posted.':'The payment goes to this encounter\'s balance.';
 return `<section class="collect-done" role="status"><div class="collect-done-mark" aria-hidden="true">✓</div><h3>${head}</h3><p class="muted">${sentence}</p><div class="actions">${receiptButton}<button type="button" class="primary" data-sheet-close>Done</button></div></section>`;
}
function collectOwedMarkup({showDue=true}={}){
 const summary=encounterRevenueState?.data?.summary,p=summary?.patient||{},owes=p.owes_now_cents;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,number=typeof encounterNumberText==='function'?encounterNumberText(visit):'';
 // What the patient has already paid toward this encounter, and any credit on the account that
 // can be used before taking more money.
 const receipts=(summary?.receipts||[]).filter(r=>!r.voided);
 const copay=summary?.account?.status!=='posted'&&p.copay_cents!=null?`<li><span>Plan copay</span><b>${money(p.copay_cents)}</b>${p.copay_due_cents===0?'<em class="is-paid">Paid</em>':p.copay_paid_cents?`<em>${money(p.copay_paid_cents)} paid · ${money(p.copay_due_cents)} due</em>`:'<em>Due</em>'}</li>`:'';
 const paidTotal=receipts.reduce((sum,r)=>sum+Number(r.amount_cents||0)-Number(r.refunded_cents||0),0),payments=new Set(receipts.map(r=>r.payment_group_id||r.id)).size;
 const paid=receipts.length?`<li><span>Paid on this encounter</span><b>${money(paidTotal)}</b><em title="${esc(receipts.map(r=>`${money(r.amount_cents)} ${r.method==='card'?'card':r.method||''}`).join(', '))}">${payments===1?'1 payment':payments+' payments'}</em></li>`:'';
 const evidence=summary?.insurance?.insured===false&&typeof visitBillingSelfPayCredits==='function'?encounterSelfPayCredits(summary):null;
 const creditCents=evidence?.credit??Number(p.unapplied_cents||0);
 const credit=creditCents>0&&(typeof encounterChargeAccount==='function'?encounterChargeAccount():null)?.status==='posted'
  ?`<li class="has-credit"><span>${evidence?'Unapplied credit':'Credit on account'}</span><b>${money(creditCents)}</b>${!evidence?.review&&!p.receipt_needs_review?`<button type="button" data-apply-copays>Use ${money(creditCents)} credit</button>`:''}</li>`:'';
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null,lines=account?.content?.lines||[];
 const items=lines.length?`<details data-inline class="collect-lines"><summary>${lines.length} ${lines.length===1?'charge':'charges'} · ${money(account.total_cents??lines.reduce((sum,l)=>sum+Number(l.amount_cents||0),0))}</summary><ul>${lines.map(l=>`<li><span><b>${esc(l.code)}</b>${l.modifiers?' · '+esc(l.modifiers):''} ${esc(l.description||'')}</span><span>${Number(l.units)>1?esc(String(l.units))+' × ':''}${money(l.amount_cents)}</span></li>`).join('')}</ul>${summary?.insurance?.insured&&p.owes_now_cents!=null&&summary.charges_cents!=null?`<p class="muted">Insurance is billed for the rest; the patient pays their share now.</p>`:''}</details>`:'';
 const posted=account?.status==='posted',dueBefore=!posted&&p.copay_due_cents!=null?p.copay_due_cents:null;
 const standing=typeof visitBillingDue==='function'?visitBillingDue(summary):null;
 const heldCopay=Number(p.copay_cents)>0&&p.copay_due_cents===0&&Number(p.copay_paid_cents)>0,settledText=!standing||standing.due!==0?'':standing.paidUp?`✓ ${standing.note}.`:heldCopay?'':'Nothing is due on this encounter right now.';
 const settled=settledText?`<p class="collect-settled" role="status">${settledText}</p>`:'';
 const copayHeld=!posted&&Number(p.copay_cents)>0&&p.copay_due_cents===0&&Number(p.copay_paid_cents)>0;
 const due=showDue?`${settled}<div class="collect-owed${copayHeld?' is-paid':''}"><span>${number?esc(number)+' · ':''}${copayHeld?'Copay paid':dueBefore!=null?'Copay due now':'Patient owes now'}</span><b>${copayHeld?money(p.copay_paid_cents):dueBefore!=null?money(dueBefore):owes==null?'—':money(owes)}</b>${copayHeld?'<small>Held for this encounter. It comes off the bill when the charges are posted.</small>':dueBefore!=null?'<small>The rest is set when the charges are posted.</small>':''}</div>`:'';
 const patientName=[workspace.patient?.given_name,workspace.patient?.family_name].filter(Boolean).join(' ');
 const context=[patientName,number,dueBefore!=null?'Copay':'Patient balance'].filter(Boolean).join(' · ');
 return `${showDue?due:`<p class="muted collect-context">${esc(context)}</p>`}${items}${showDue&&(copay||paid||credit)||credit?`<ul class="collect-paid-so-far">${showDue?copay+paid:''}${credit}</ul>`:''}`;
}
function currentInsuranceCopay(scope){
 return !!scope&&scope.identity===me&&scope.patient===selected&&chartSection==='insurance'&&revenueAppointment()?.id===scope.appointment;
}
function insuranceCopayPending(state,scope){
 if(scope.needsReview||state?.uncertain)return true;
 const receipts=new Set(scope.receipts.map(receipt=>receipt.id));
 return state?.items?.some(operation=>['creating','open','needs_review'].includes(operation.status)||operation.status==='paid'&&!receipts.has(operation.receipt_id)&&!scope.counted?.has(operation.receipt_id));
}
function insuranceCopayTenderAvailable(scope,key,state){
 if(!currentInsuranceCopay(scope)||!scope.canCollect||!insuranceCopayCanCollect(revenueAppointment())||!state?.availability||state.pending||state.error||insuranceCopayPending(state,scope))return false;
 return ['cash','check','external'].includes(key)||(state.availability.available&&typeof state.availability.livemode==='boolean');
}
async function checkInsuranceCopayTender(panel,appointment,key){
 if(panel!=='insurance-collect-payment')return;
 const dialog=collectDialog,scope=collectSession.insurance;
 const belongs=()=>collectDialog===dialog&&dialog?.isConnected&&currentInsuranceCopay(scope)&&scope.appointment===appointment&&scope.canCollect&&insuranceCopayCanCollect(revenueAppointment());
 if(!belongs())throw new Error('Open the payment window for the selected appointment again.');
 const current=insuranceCopayContext(revenueAppointment());
 if(current.coverage!==scope.coverage||current.plan!==scope.plan)throw new Error('The appointment’s coverage changed. Reopen the copay window to review it.');
 const state=await loadHostedCopays(appointment,true);
 if(!belongs()||!insuranceCopayTenderAvailable(scope,key,state))throw new Error('Review the current payment status before taking another payment.');
}
function paintInsuranceCopayModal(state){
 const dialog=collectDialog,scope=collectSession.insurance;
 if(!dialog?.isConnected||!scope)return;
 if(!currentInsuranceCopay(scope)){sheetClose(dialog);return;}
 if(!state&&scope.canCollect)state=hostedCopayStateFor(scope.appointment);
 const activity=dialog.querySelector('[data-appointment-pos-activity]'),amount=dialog.querySelector('[data-appointment-pos-amount]');
 if(amount){
  amount.textContent=scope.due==null?'Copay not recorded':scope.due>0?`${money(scope.due)} due`:'No copay due';
 }
 if(activity){
  const receipts=scope.receipts||[],ids=new Set(receipts.map(receipt=>receipt.id));
  const showing=dialog.querySelector('[data-appointment-pos-operation]')?.dataset.appointmentPosOperation;
  const operations=(state?.items||[]).filter(operation=>operation.id!==showing&&operation.status!=='expired'&&!ids.has(operation.receipt_id));
  const status=!scope.canCollect?'':scope.needsReview?'<p role="status">Resolve the receipt that needs review before collecting another payment.</p>':state?.error?'<p role="status">Payment status could not be checked.</p>':state?.uncertain?'<p role="status">The last card request has an uncertain result.</p>':!state?.availability?'<p role="status">Checking payment status…</p>':!state.availability.available?'<p class="muted">Card payments are unavailable.</p>':'';
  const retry=state?.uncertain&&state.retry?`<button type="button" data-retry-hosted-copay="${esc(scope.appointment)}">Retry the same ${money(state.retry.amount_cents)} request</button>`:'';
  const refresh=scope.canCollect&&(state?.error||state?.uncertain||scope.needsReview)?`<button type="button" data-refresh-hosted-copay-list="${esc(scope.appointment)}">Check payment status</button>`:'';
  const markup=status+operations.map(operation=>hostedCopayOperationMarkup(operation)).join('')+retry+refresh+(receipts.length?copayReceiptMarkup(receipts,{encounter:true,readOnly:true}):scope.canCollect?'':'<p>No receipts for this appointment.</p>');
  if(activity.copayMarkup!==markup){activity.copayMarkup=markup;activity.innerHTML=markup;}
 }
 for(const button of dialog.querySelectorAll('[data-collect-method]'))button.disabled=!insuranceCopayTenderAvailable(scope,button.dataset.collectMethod,state);
}
async function refreshInsuranceCopayChart(scope){
 const current=()=>currentInsuranceCopay(scope);
 if(!current())return;
 await selectPatient(scope.patient,typeof activeVisit==='undefined'?null:activeVisit?.id||null,current);
 if(!current()||collectSession.insurance!==scope||!collectDialog?.isConnected)return;
 Object.assign(scope,insuranceCopayContext(revenueAppointment()));
 if(!collectSession.taken.length)collectSession.target=scope.due>0?scope.due:null;
 paintInsuranceCopayModal(hostedCopayStateFor(scope.appointment));
}
function openInsuranceCopayModal(context,opener=document.activeElement){
 if(!currentInsuranceCopay(context))return false;
 if(collectDialog?.isConnected)return collectSession.insurance?.appointment===context.appointment;
 const appointment=revenueAppointment();
 const canCollect=context.canCollect&&insuranceCopayCanCollect(appointment);
 const scope={...context,paid:Number(context.paid)||0,canCollect,receipts:(context.receipts||[]).filter(receipt=>receipt.appointment_id===appointment.id&&(!receipt.patient_id||receipt.patient_id===context.patient))};
 const due=Number.isSafeInteger(scope.due)&&scope.due>0?scope.due:null;
 collectSession={target:due,owedAtOpen:due||0,copayOnly:true,taken:[],group:crypto.randomUUID(),encounters:[],current:scope.appointment,insurance:scope};
 const panel=document.createElement('section');panel.id='insurance-collect-payment';
 const methods=[...collectMethods,['external','External payment']];
 const patient=workspace.patient;
 const name=[patient?.given_name,patient?.family_name].filter(Boolean).join(' ');
 panel.innerHTML=`<div data-appointment-pos-context><b data-appointment-pos-amount></b><p data-appointment-pos-name>${esc(name)}</p><p data-appointment-pos-date>${esc(appointment.title||'Appointment')} · ${esc(date(appointment.starts_at))}</p></div><div data-appointment-pos-activity aria-live="polite"></div>${canCollect?`<nav class="invoice-tabs collect-methods" role="tablist" aria-label="Payment method">${methods.map(([key,label])=>`<button type="button" role="tab" data-collect-method="${key}" aria-selected="false" disabled>${label}</button>`).join('')}</nav><div data-collect-holder></div>`:''}`;
 const dialog=sheetOpen(canCollect?'Collect copay':'Copay payments',panel,{className:'collect-sheet appointment-copay-pos',label:true});
 collectDialog=dialog;
 const badge=collectTestBadgeMarkup();if(badge)dialog.querySelector('.sheet-head h3')?.insertAdjacentHTML('afterend',badge);
 const restoreFocus=()=>{
  if(collectDialog?.isConnected||!currentInsuranceCopay(scope))return;
  const entry=$('insurance-page-copay')?.querySelector('[data-insurance-copay-collect]');
  (opener?.isConnected&&opener!==document.body?opener:entry)?.focus({preventScroll:true});
 };
 dialog.addEventListener('close',()=>{
  if(collectDialog!==dialog)return;
  collectDialog=null;restoreFocus();
  if(dialog.dataset.refresh)void refreshInsuranceCopayChart(scope).catch(error=>notice(error.message,true)).finally(restoreFocus);
 },{once:true});
 const state=canCollect?hostedCopayStateFor(scope.appointment):null;
 if(canCollect)void loadHostedCopays(scope.appointment,true);
 paintInsuranceCopayModal(state);
 return true;
}
function currentEncounterCollect(scope){
 return !!scope&&scope.patient===selected&&scope.identity===me&&chartSection==='visits'&&
  activeVisit?.id===scope.visit&&(activeVisit?.appointment_id??null)===scope.appointment;
}
function encounterCollectProblem(state){
 const scope=collectSession.encounter;
 if(!currentEncounterCollect(scope))return 'Open the payment window for the current encounter.';
 if(!scope.appointment)return 'Link an appointment to this encounter to take a payment.';
 if(!scope.canCollect)return scope.status;
 if(collectSession.recording)return '';
 if(typeof navigator!=='undefined'&&navigator.onLine===false)return 'You’re offline. Connect to take a payment.';
 if(encounterRevenueState.data?.stale||encounterRevenueState.data?.error)return 'The current balance could not be confirmed.';
 if(!state?.availability)return 'Checking payment options…';
 if(state.error)return 'Payment status could not be checked.';
 const receipts=encounterRevenueState.data?.summary?.receipts||[];
 const accounted=new Set(receipts.filter(receipt=>!receipt.voided).map(receipt=>receipt.id));
 if(state.uncertain||state.items.some(item=>['creating','open','needs_review'].includes(item.status)||
    item.status==='paid'&&!accounted.has(item.receipt_id)&&!scope.counted?.has(item.receipt_id)))return 'Check the payment in progress before taking another.';
 return '';
}
function encounterCollectTenderAvailable(key,state){
 const scope=collectSession.encounter;
 if(!scope?.canCollect||state?.pending||!billingCan('create')||collectSession.recording||encounterCollectProblem(state)||!(collectLeftCents()>0))return false;
 if(key==='cash'||key==='check')return true;
 if(!state.availability.available||typeof state.availability.livemode!=='boolean')return false;
 if(key==='reader'&&Array.isArray(hostedCopayState.readers)&&!hostedCopayState.readers.some(reader=>reader.online))return false;
 return true;
}
function paintEncounterCollectModal(state){
 const dialog=collectDialog,scope=collectSession.encounter;
 if(!dialog?.isConnected||!scope||scope.appointment!==state?.appointment)return;
 if(!currentEncounterCollect(scope)){sheetClose(dialog);return;}
 const problem=encounterCollectProblem(state),status=dialog.querySelector('[data-collect-availability]');
 if(status&&status.textContent!==problem)status.textContent=problem;
 dialog.toggleAttribute?.('data-collect-attention',Boolean(problem&&state.availability));
 const submit=dialog.querySelector('[data-collect-holder] button[type="submit"]');
 if(submit)submit.disabled=!!problem||!!collectSession.recording||!encounterCollectTenderAvailable(dialog.dataset.method,state);
 for(const button of dialog.querySelectorAll('[data-collect-method]')){
  const key=button.dataset.collectMethod;
  button.disabled=!encounterCollectTenderAvailable(key,state);
  button.hidden=!['cash','check'].includes(key)&&state.availability?.available===false&&!state.error;
 }
 for(const control of dialog.querySelectorAll('[data-collect-encounter],[data-collect-all]')){
  control.disabled=!!collectSession.recording||!!problem||control.dataset.collectPaid==='true';
 }
 collectInitialMethod(state);
}
async function runEncounterCollectTender(form,key,action){
 if(!form.hasAttribute?.('data-encounter-collect'))return action();
 const dialog=collectDialog,session=collectSession,scope=session.encounter;
 if(session.recording)return;
 if(!dialog?.contains(form)||!currentEncounterCollect(scope)||scope.appointment!==form.dataset.appointment)
  throw new Error('Open the payment window for the current encounter.');
 const state=hostedCopayStateFor(scope.appointment);
 if(!encounterCollectTenderAvailable(key,state))
  throw new Error(encounterCollectProblem(state)||'This payment method is unavailable.');
 session.recording=true;
 paintEncounterCollectModal(state);
 try{return await action();}
 finally{
  session.recording=false;
  if(collectDialog===dialog)paintEncounterCollectModal(state);
 }
}
function openCollectModal(){
 const panel=$('visit-billing-collect');if(!panel)return false;
 if(collectDialog?.isConnected){collectDialog.querySelector('[data-collect-method].active')?.focus?.();return true;}
 const data=encounterRevenueState.data,summary=data?.summary,visit=activeVisit,patient=summary?.patient||{};
 const appointment=revenueAppointment(),current=appointment?.id??null,posted=summary?.account?.status==='posted';
 const scoped=summary?.visit?.id===visit?.id&&summary?.patient_id===selected&&summary.visit.appointment_id===current;
 const review=patient.receipt_needs_review||summary?.receipts?.some(receipt=>!receipt.voided&&receipt.needs_review);
 const balance=posted?patient.owes_now_cents:summary?.insurance?.insured===true?patient.copay_due_cents:null;
 const known=scoped&&!data.error&&!data.stale&&!review&&Number.isSafeInteger(balance)&&balance>=0;
 const due=known&&balance>0?balance:null;
 const canCollect=!!(current&&appointment.patient_id===selected&&!['cancelled','canceled','no_show'].includes(appointment.status)&&due&&billingCan('create'));
 const scope={patient:selected,identity:me,visit:visit?.id,appointment:current,canCollect,
  status:review?'Review the payment history before collecting.':!known?'The current balance could not be confirmed.':balance===0?(posted?'No patient amount due.':'No copay due.'):!canCollect?'Payment collection is unavailable for this encounter.':''};
 const home=panel.parentNode,marker=document.createComment('visit-billing-collect');home.insertBefore(marker,panel);
 const head=document.createElement('div');head.dataset.collectHead='';panel.prepend(head);
 collectSession={target:due,owedAtOpen:due||0,copayOnly:!posted&&due>0,taken:[],group:crypto.randomUUID(),encounters:canCollect?[{appointment:current,owes:due,paid:0,on:true}]:[],current,encounter:scope};
 head.innerHTML=`<div data-collect-owed>${known?collectOwedMarkup({showDue:false}):''}</div><div data-collect-encounters></div><div data-collect-progress></div><p data-collect-availability role="status">${esc(current?scope.status:'Link an appointment to this encounter to take a payment.')}</p>${canCollect?`<nav class="invoice-tabs collect-methods" role="tablist" aria-label="Payment method">${collectMethods.map(([key,label])=>`<button type="button" role="tab" data-collect-method="${key}" aria-selected="false" disabled>${label}</button>`).join('')}</nav><div data-collect-holder></div>`:''}`;
 panel.hidden=false;
 const dialog=sheetOpen(canCollect?'Take payment':'Patient payments',panel);dialog.classList.add('sheet-wide','collect-sheet');collectDialog=dialog;
 const badge=collectTestBadgeMarkup();if(badge){const heading=dialog.querySelector('.sheet-head h3');if(heading)heading.insertAdjacentHTML('afterend',badge);}
 dialog.addEventListener('close',()=>{collectDialog=null;if(marker.parentNode){panel.hidden=true;head.remove();const slot=$('encounter-hosted-copay-reader');if(slot&&!slot.querySelector('[data-reader-payment="waiting"],[data-reader-payment="finishing"]'))slot.replaceChildren();marker.parentNode.insertBefore(panel,marker);marker.remove();}else panel.remove();if(dialog.dataset.refresh&&currentEncounterCollect(scope))void collectRefresh();},{once:true});
 if(canCollect){
  const state=hostedCopayStateFor(current);
  paintEncounterCollectModal(state);
  void loadHostedCopays(current);
  void collectLoadEncounters(dialog,selected);
 }
 return true;
}
// A saved tender is a preference. A cash form is the safe default and never submits itself.
function collectInitialMethod(state){
 if(!collectDialog||collectDialog.dataset.method||!encounterCollectTenderAvailable('cash',state))return;
 let preferred='';try{preferred=localStorage.getItem('suncharts.collectMethod')||'';}catch{}
 const known=collectMethods.some(([key])=>key===preferred)&&encounterCollectTenderAvailable(preferred,state);
 void collectMethod(known?preferred:'cash',false);
}
async function collectMethod(key,remember=true){
 const dialog=collectDialog;if(!dialog)return;
 const scope=collectSession.insurance;
 if(scope&&!insuranceCopayTenderAvailable(scope,key,hostedCopayStateFor(scope.appointment)))return;
 if(collectSession.encounter&&!encounterCollectTenderAvailable(key,hostedCopayStateFor(collectSession.current)))return;
 for(const b of dialog.querySelectorAll('[data-collect-method]')){const on=b.dataset.collectMethod===key;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));}
 dialog.dataset.method=key;
 if(remember){collectSession.tenderChosen=true;try{localStorage.setItem('suncharts.collectMethod',key);}catch{}}
 const panelId=scope?'insurance-collect-payment':'encounter-hosted-copay';
 const slot=scope?collectPanelTarget():$('encounter-hosted-copay-reader'),panel=collectPanelTarget(),appointment=collectAppointmentId();
 if(typeof stopReaderPayment==='function'&&!slot?.querySelector('[data-reader-payment="waiting"],[data-reader-payment="finishing"]'))stopReaderPayment();
 if(!panel)return;
 if(!appointment){panel.innerHTML='<p role="status">Book or select the appointment for this encounter before taking a payment.</p>';return;}
 if(key==='cash'||key==='check'||key==='external'){panel.innerHTML=collectCashMarkup(key,appointment);panel.querySelector('[name="amount"]')?.focus();return;}
 panel.innerHTML='<p class="muted collect-loading">Getting ready…</p>';
 const opener=key==='reader'?openReaderCopayEditor:key==='saved'?openSavedCardCopayEditor:openHostedCopayEditor,left=collectLeftCents();
 try{await opener(appointment,panelId,left!=null&&left>0?left:scope?null:undefined);}
 catch(error){
  if(collectDialog===dialog&&dialog.dataset.method===key&&panel.isConnected){
   const message=document.createElement('p');message.setAttribute('role','status');
   message.textContent=error.message||'This payment method could not be loaded.';panel.replaceChildren(message);
  }
 }finally{
  if(collectDialog===dialog&&dialog.dataset.method===key)panel.querySelector('.collect-loading')?.remove();
 }
}
function collectCashMarkup(method,appointmentId){
 const appointment=(workspace.appointments||[]).find(item=>item.id===appointmentId);
 const coverage=typeof revenueCoverage==='function'?revenueCoverage(revenueServiceDate(appointment)):null;
 const scope=collectSession.insurance,left=collectLeftCents(),amount=left!=null&&left>0?left:null;
 const label=method==='external'?'external payment':method;
 return `<form id="collect-cash-form" class="collect-cash"${collectSession.encounter?' data-encounter-collect':''} data-method="${method}" data-appointment="${esc(appointmentId)}" data-panel="${scope?'insurance-collect-payment':''}" data-coverage="${esc((scope?scope.coverage:coverage?.id)||'')}" data-patient="${esc(selected)}" data-request="${crypto.randomUUID()}"><label class="collect-amount">Amount received<input name="amount" inputmode="decimal" required value="${amount==null?'':esc(dollars(amount))}" autocomplete="off"></label>${method==='check'?'<label>Check number<input name="reference" required maxlength="200" autocomplete="off"></label>':method==='external'?'<label>Receipt reference<input name="reference" required maxlength="200" autocomplete="off"></label>':collectSession.encounter?'':'<label>Note (optional)<input name="reference" maxlength="200" autocomplete="off"></label>'}<button type="submit" class="primary collect-submit" data-collect-submit>Record ${amount==null?'':money(amount)+' '}${label}</button></form>`;
}
function collectToday(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
async function submitCollectCash(form){
 const amountText=String(form.elements.amount.value||'').replace(/[$\s,]/g,'');let amount;try{amount=cents(amountText);}catch{amount=null;}
 if(!amount||amount<=0)throw new Error('Enter the amount received.');
 const patient=form.dataset.patient,method=form.dataset.method,button=form.querySelector('[data-collect-submit]');
 if(patient!==selected)throw new Error('This payment window belongs to another patient. Close it and open it again.');
 if(form.collectRecording)return;
 const dialog=collectDialog,scope=collectSession.insurance,encounter=collectSession.encounter,label=method==='external'?'external payment':method;
 if(scope&&(!dialog?.contains(form)||scope.appointment!==form.dataset.appointment))throw new Error('Open the payment window for the selected appointment again.');
 form.collectRecording=true;button.disabled=true;button.textContent='Recording…';
 // Money for several encounters is recorded once for each, under the one payment.
 const parts=collectParts(amount)||[{appointment_id:form.dataset.appointment,amount_cents:amount}],group=collectGroupField();
 let receipt,done=0;
 try{
  await runEncounterCollectTender(form,method,async()=>{
   if(form.dataset.panel==='insurance-collect-payment')await checkInsuranceCopayTender(form.dataset.panel,form.dataset.appointment,method);
   for(const [index,part] of parts.entries()){
    if(encounter&&(!currentEncounterCollect(encounter)||collectDialog!==dialog))throw new Error('Open the payment window for the current encounter.');
    const own=part.appointment_id===form.dataset.appointment;
    receipt=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/copays`,'POST',{request_id:index?crypto.randomUUID():form.dataset.request,appointment_id:part.appointment_id,coverage_id:own?form.dataset.coverage||null:null,amount_cents:part.amount_cents,method,reference:String(form.elements.reference?.value||'').trim(),occurred_on:collectToday(),reason:method==='external'?'Payment received outside SunCharts':method==='check'?'Check received at the desk':'Cash received at the desk',received_confirmed:true,...group});
    done+=part.amount_cents;
   }
  });
 }catch(error){
  // What was recorded before the failure is kept and shown; the rest is still left to pay.
  if(done>0&&collectDialog===dialog)collectPartTaken(done,label,receipt,form.dataset.appointment);
  else{button.disabled=false;button.textContent=`Record ${money(amount)} ${label}`;}
  throw error;
 }finally{form.collectRecording=false;}
 if(collectDialog===dialog)collectPartTaken(amount,label,receipt,form.dataset.appointment);
 else if(scope)void refreshInsuranceCopayChart(scope).catch(error=>notice(error.message,true));
 else if(currentEncounterCollect(encounter))void collectRefresh().catch(error=>notice(error.message,true));
}
// After the window closes, the encounter reads its balance and payments again.
async function collectRefresh(){
 const patient=selected,visit=typeof activeVisit!=='undefined'?activeVisit?.id:null;if(!patient)return;
 const restore=encounterStepPosition();
 await selectPatient(patient,visit);restore?.();if(selected!==patient)return;
 if($('visit-page-host')?.dataset.encounterSteps===undefined&&typeof setEncounterSection==='function')setEncounterSection('charges');
}
if(typeof document!=='undefined'){
 document.addEventListener('click',event=>{
  const tab=event.target?.closest?.('[data-collect-method]');if(tab?.dataset?.collectMethod){event.preventDefault();return collectMethod(tab.dataset.collectMethod);}
  const receipt=event.target?.closest?.('[data-collect-receipt]');if(receipt?.dataset?.collectReceipt){event.preventDefault();void run(()=>printPaymentGroupReceiptFromCollect(receipt.dataset.collectReceipt,receipt));return;}
 });
 document.addEventListener('submit',event=>{if(event.target?.id!=='collect-cash-form')return;event.preventDefault();run(()=>submitCollectCash(event.target));});
 document.addEventListener('change',event=>{const box=event.target;if(!box?.dataset?.collectEncounter||!collectDialog||box.disabled)return;const e=collectSession.encounters.find(x=>x.appointment===box.dataset.collectEncounter);if(!e)return;e.on=!!box.checked;collectEncountersChanged();});
 document.addEventListener('click',event=>{const all=event.target?.closest?.('[data-collect-all]');if(!all?.dataset?.collectAll||!collectDialog||all.disabled)return;event.preventDefault();const on=all.dataset.collectAll==='all';for(const e of collectSession.encounters)if(e.owes-e.paid>0)e.on=on;collectEncountersChanged();});
 document.addEventListener('input',event=>{const form=event.target?.closest?.('#collect-cash-form');if(!form||event.target.name!=='amount')return;const button=form.querySelector('[data-collect-submit]');let amount=null;try{amount=cents(String(event.target.value||'').replace(/[$\s,]/g,''));}catch{}button.textContent=`Record ${amount?money(amount)+' ':''}${form.dataset.method==='external'?'external payment':form.dataset.method}`;});
}

if(typeof window!=='undefined'&&window.addEventListener){
 for(const event of ['online','offline'])window.addEventListener(event,()=>{
  const scope=collectSession.encounter;
  if(!collectDialog||!currentEncounterCollect(scope)||!scope.appointment)return;
  if(event==='online'&&scope.canCollect)void loadHostedCopays(scope.appointment,true);
  else paintEncounterCollectModal(hostedCopayStateFor(scope.appointment));
 });
}
// Using credit from the payment window closes it first, so the encounter reloads with the credit applied.
if(typeof document!=='undefined')document.addEventListener('click',event=>{const b=event.target?.closest?.('[data-apply-copays]');if(!b||!collectDialog||!collectDialog.contains(b))return;const account=encounterChargeAccount();if(account)billingSelected=account.id;delete collectDialog.dataset.refresh;sheetClose(collectDialog);},true);

// The encounter bar. Where this encounter stands, its money and the one next step sit in a single
// line that stays in view on every tab of the encounter. It is a live copy of the billing card's
// own next step, so every button in it is the card's button; the full money table opens over the
// page. An encounter with no charges yet has no bar: Add codes is already beside the codes.
let encounterBarTimer=null;
function encounterBarSync(){
 $('encounter-bar')?.remove?.();
 if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();
}
// Anything that changes the card (a refresh, a failed send's message, a button going busy) reaches
// the bar by itself.
function encounterBarWatch(host){
 if(host&&typeof encounterStepsSchedule==='function')encounterStepsSchedule();
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

async function visitNotePaymentCards(){
 if(typeof savedCardsForCharge!=='function')return [];
 try{return (await savedCardsForCharge(selected)).cards||[];}catch{return [];}
}
async function visitNoteOpenPayment(){
 openVisitCollect();
 const patient=selected,identity=me,id=activeVisit?.id,cards=await visitNotePaymentCards();
 if(selected!==patient||me!==identity||activeVisit?.id!==id)return;
 const button=collectDialog?.querySelector('[data-collect-method="saved"]'),amount=encounterRevenueState.data?.summary?.patient?.owes_now_cents;
 if(button&&cards.length)button.textContent=`Charge card on file${amount>0?' '+money(amount):''}`;
}
async function visitNoteBillPayment(summary){
 const patient=selected,identity=me,id=activeVisit?.id,cards=await visitNotePaymentCards();
 if(selected!==patient||me!==identity||activeVisit?.id!==id)return;
 const amount=summary?.patient?.owes_now_cents,host=$('note-message');if(!host)return;
 host.hidden=false;
 host.innerHTML=`Claim sent to ${esc(visitBillingInsurer(summary))}.${Number.isSafeInteger(amount)?` Patient portion ${money(amount)}.`:''} ${amount>0?`${cards.length?`<button type="button" data-note-bill-card>Charge card on file ${money(amount)}</button>`:''}<button type="button" data-visit-collect>Take payment</button>`:''}`;
}
document.addEventListener('click',event=>{
 if(!event.target.closest?.('[data-note-bill-card]'))return;
 event.preventDefault();openVisitCollect();collectMethod('saved');
});

// One continuous encounter shares the existing forms and server operations. Moving a node keeps
// unsaved typing, event handlers and payment request identities intact across the layout.
let encounterChargesLink=null;
let encounterStepView={visit:null,current:null},encounterStepsTimer=null,encounterStepsObserver=null,encounterStepsPage=null,encounterScrollView=null;
const encounterStepChips=[[1,'Visit'],[2,'Payment']];
function encounterStepsModel(s={},v={},_appointment={},closed=false){
 const p=s.patient||{},i=s.insurance||{},signed=v.status==='signed'||!!v.signed_at;
 const selfPay=i.insured===false&&!s.claim?.id;
 const handoff=typeof visitHandoffEvidence==='function'?visitHandoffEvidence(s):null;
 const sent=handoff?['delivered','recorded_externally'].includes(handoff.outcome):!['claim_cancelled','correct_claim','claim_rejected','denied','claimmd_correction'].includes(s.state)&&(['waiting','received','answered'].includes(i.status)||['submitted','accepted','adjudicated'].includes(s.claim?.status));
 const patientSettled=signed&&s.account?.status==='posted'&&p.owes_now_cents===0&&!p.receipt_needs_review;
 const insurerSettled=selfPay||i.status==='answered'&&!(i.pending_cents>0)&&!(i.unassigned_cents>0)&&
  !['claim_rejected','denied','post_response','review_response','review_balance','patient_credit'].includes(s.state);
 const paid=s.state==='paid_in_full'||patientSettled&&insurerSettled;
 const serviceReady=selfPay?s.account?.status==='posted':sent;
 const current=!signed||!serviceReady?1:2;
 const states=[signed&&serviceReady?'done':'todo',paid?'done':'todo'];
 if(!closed&&(!paid||!serviceReady))states[current-1]='current';
 return {current,states,selfPay,closed,signed,sent,paid};
}
function encounterStepsSchedule(){
 if(typeof document==='undefined'||typeof document.createElement!=='function')return;
 clearTimeout(encounterStepsTimer);encounterStepsTimer=setTimeout(encounterStepsSync,0);
}
function encounterStepSection(number,parent){
 let node=parent.querySelector(`:scope > [data-encounter-step-number="${number}"]`);
 if(!node){node=document.createElement('section');node.className='encounter-step';node.dataset.encounterStepNumber=String(number);node.innerHTML=`<div class="encounter-step-body"><h3>${['Note','Payment'][number-1]}</h3><p data-step-summary class="muted"></p></div>`;parent.append(node);}
 return node;
}
function encounterStepMove(node,target){
 if(!node||!target||node.parentNode===target||node.closest?.('dialog'))return;
 // A block renderer can supply a new node while its previous copy is in a step.
 if(node.id){const previous=target.querySelector('#'+node.id);if(previous&&previous!==node)previous.remove();}
 target.append(node);
}
function encounterStepDetails(parent,key,title){
 let panel=parent.querySelector(`[data-step-${key}]`);
 if(!panel){
  panel=document.createElement('details');panel.setAttribute(`data-step-${key}`,'');
  panel.innerHTML=`<summary>${esc(title)}</summary>`;parent.append(panel);
 }
 return panel;
}
// Keep the original claim controls alive while viewing details in the sheet.
function encounterClaimOptionsMount(dialog){
 const home=$('visit-page-host')?.querySelector('[data-step-claim-actions][hidden]');
 const controls=home?.querySelector(':scope > [data-claim-option-controls]');
 const host=dialog?.querySelector('[data-claim-secondary-host]');
 if(!controls||!host)return;
 dialog.claimOptionsHome=home;
 dialog.claimOptionsControls=controls;
 host.append(controls);
}
function encounterClaimOptionsRestore(dialog){
 const home=dialog?.claimOptionsHome,controls=dialog?.claimOptionsControls;
 if(home?.isConnected&&controls&&home.dataset.visit===activeVisit?.id&&home.dataset.patient===selected)home.append(controls);
 if(dialog){dialog.claimOptionsHome=null;dialog.claimOptionsControls=null;}
}
function encounterSavedCodes(visit,account){
 const known=typeof visitDiagnosisStates!=='undefined'?visitDiagnosisStates.get(visit.id):null;
 const evidence=typeof encounterCodesEvidence!=='undefined'&&encounterCodesEvidence.visit===visit.id?encounterCodesEvidence.evidence:null;
 const diagnoses=known?.patientId===selected?known.diagnoses:evidence?.diagnoses||visit.diagnoses;
 return {diagnoses,lines:account?.content?.lines||evidence?.lines||[]};
}
// Keep the live editors under the encounter while the native dialog is closed. The visit note
// can redraw without destroying their inputs or replacing the dialog currently in the top layer.
function encounterCodesDialogCurrent(dialog){
 return dialog?.isConnected&&dialog.dataset.patient===selected&&dialog.dataset.visit===activeVisit?.id&&dialog.codesAccount===(typeof me==='undefined'?null:me)&&(typeof chartSection==='undefined'||chartSection==='visits')&&(typeof inRecordArea!=='function'||!inRecordArea());
}
function encounterTemplateCodeChoices(dialog){
 if(!encounterCodesDialogCurrent(dialog)||activeVisit.status!=='in_progress')return null;
 const appointment=workspace.appointments?.find(a=>a.id===activeVisit.appointment_id&&a.patient_id===selected);
 const type=appointment?.visit_type;
 if(!type||(!type.diagnoses?.length&&!type.procedures?.length))return null;
 const dx=dialog.querySelector('#visit-diagnoses-form'),charges=dialog.querySelector('#billing-account-form');
 const canDX=dx?.dataset.visitId===activeVisit.id&&dx.querySelector('button[type="submit"]:not([disabled])')&&!dialog.querySelector('[data-diagnosis-rebase]');
 const canCharge=charges&&charges.elements.visit_id?.value===activeVisit.id&&!charges.dataset.draftReadOnly&&!charges.dataset.draftStale&&!charges.dataset.chargeConflict&&encounterChargeAccount()?.status!=='posted';
 const procedureKey=line=>[line.code_system||(/^[A-Z]/i.test(line.code)?'HCPCS':'CPT'),line.code,String(line.modifiers||'').split(/[\s,]+/).filter(Boolean).sort().join(','),line.ndc_code||''].join('|').toUpperCase();
 const dxCodes=new Set(canDX?visitDiagnosisFormValues(dx).diagnoses.map(row=>row.code.toUpperCase()):[]);
 const serviceCodes=new Set(canCharge?chargeLiveRows(charges).map(row=>procedureKey(chargeRowValue(row))):[]);
 const choices=[];
 if(canDX)for(const [i,item] of (type.diagnoses||[]).entries()){
  if(!dxCodes.has(item.code.toUpperCase()))choices.push({key:'dx-'+i,kind:'ICD-10-CM',item});
 }
 if(canCharge)for(const [i,item] of (type.procedures||[]).entries()){
  if(!serviceCodes.has(procedureKey(item)))choices.push({key:'service-'+i,kind:item.code_system,item});
 }
 return {type,choices};
}
function encounterTemplateCodesPaint(dialog){
 const suggestions=encounterTemplateCodeChoices(dialog);
 const body=dialog.querySelector('.sheet-body');
 let panel=body.querySelector('[data-visit-type-codes]');
 if(!suggestions?.choices.length){if(panel)panel.remove();return;}
 if(!panel){
  panel=document.createElement('fieldset');panel.dataset.visitTypeCodes='';panel.className='visit-type-codes';
  body.prepend(panel);
 }
 const {type,choices}=suggestions;
 const signature=JSON.stringify([type.id,type.version,choices.map(c=>c.key)]);
 if(signature===panel.codesSignature)return;
 const unchecked=new Set([...panel.querySelectorAll('input:not(:checked)')].map(i=>i.value));
 panel.codesSignature=signature;
 panel.innerHTML=`<legend>${esc(type.name)} · Suggested codes</legend>${choices.map(({key,kind,item})=>`<label class="review-ack"><input type="checkbox" value="${esc(key)}" ${unchecked.has(key)?'':'checked'}> ${esc(kind)} ${esc(item.code)}${item.modifiers?'–'+esc(item.modifiers):''} · ${esc(item.description)}${item.units>1?' × '+esc(item.units):''}</label>`).join('')}<button type="button" data-use-visit-type-codes>Add selected to encounter</button>`;
}
function encounterApplyTemplateCodes(dialog){
 const suggestions=encounterTemplateCodeChoices(dialog);
 if(!dialog.open||!suggestions)return;
 const keys=new Set([...dialog.querySelectorAll('[data-visit-type-codes] input:checked')].map(input=>input.value));
 const selectedCodes=suggestions.choices.filter(choice=>keys.has(choice.key));
 const state=dialog.querySelector('[data-codes-editor-state]');
 if(!selectedCodes.length){state.textContent='Select the codes that apply to this visit.';return;}
 let added=0;const lines=[];
 for(const {kind,item} of selectedCodes){
  if(kind==='ICD-10-CM'){
   if(visitDiagnosisAppendRow({code:item.code,display:item.description},'Added from the visit type'))added++;
  }else{
   lines.push({code_system:item.code_system,code:item.code,description:item.description,units:item.units,
    modifiers:String(item.modifiers||'').split(/[\s,]+/).filter(Boolean).join(','),
    ...(item.ndc_code?{ndc_code:item.ndc_code,ndc_unit:item.ndc_unit,ndc_quantity:item.ndc_quantity}:{})});
  }
 }
 if(lines.length)added+=chargeLinesAppend(lines).length;
 state.textContent=added===selectedCodes.length?'Selected codes added. Review the codes and fees.':'Some codes could not be added. Review the encounter.';
 encounterTemplateCodesPaint(dialog);
 if(typeof diagnosisSuggestCheck==='function')diagnosisSuggestCheck();
}
function encounterOpenCodesDialog(launcher,area='codes'){
 const dialog=$('visit-page-host')?.querySelector('[data-encounter-codes-dialog]');
 if(!encounterCodesDialogCurrent(dialog)||dialog.hidden)return;
 if(!dialog.open){
  dialog.codesLauncher=launcher||document.activeElement;
  dialog.querySelector('[data-retain-encounter-codes]').hidden=true;
  const state=dialog.querySelector('[data-codes-editor-state]');
  state.classList.remove('is-problem');state.textContent='Draft changes save automatically.';
  dialog.showModal();
 }
 encounterTemplateCodesPaint(dialog);
 const body=dialog.querySelector('.sheet-body');
 const diagnosisField=body.querySelector('#visit-diagnoses-form input[name="code"]:not([disabled]):not([readonly])');
 const enteringFirst=area==='codes'&&(diagnosisField?!diagnosisField.value.trim():!encounterSavedCodes(activeVisit,null).diagnoses?.length);
 if(enteringFirst)area='diagnoses';
 dialog.codesFocusDiagnosis=area==='diagnoses'&&!diagnosisField;
 const targets={diagnoses:'#visit-diagnoses',details:'[data-visit-charge-options]',procedures:'.billing-charge-row',rendering:'[data-encounter-provider]'};
 const target=targets[area]?body.querySelector(targets[area]):null;
 if(target){
  for(let parent=target;parent&&parent!==body;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
  if(area==='rendering'&&typeof encounterProviderFieldsOpen==='function')encounterProviderFieldsOpen(target,true);
  const dx=area==='diagnoses'?target.querySelector('#visit-diagnoses-form'):null;
  const pick=area==='rendering'?target.querySelector('[name="cd_rendering_pick"]:not([disabled])'):area==='procedures'?target.querySelector('[name="line_code"]:not([disabled]),[name="code"]:not([disabled])'):null;
  const field=pick||dx?.querySelector('[data-diagnosis-row] input[name="code"]:not([disabled]):not([readonly])')||dx?.querySelector('[data-diagnosis-add]:not([disabled])')||target.querySelector('input:not([type="hidden"]):not([disabled]):not([readonly]),select:not([disabled]),button:not([disabled])')||dialog.querySelector('h2');
  if(dx&&field?.name==='code'&&typeof visitDiagnosisFocusCode==='function')visitDiagnosisFocusCode(field);
  else field?.focus?.({preventScroll:true});
  body.scrollTop=Math.max(0,target.getBoundingClientRect().top-body.getBoundingClientRect().top+body.scrollTop);
 }
}
async function encounterSaveCodesDialog(dialog,{applyCorrection=false}={}){
 if(!encounterCodesDialogCurrent(dialog)||!dialog.open||dialog.codesSaving)return;
 const state=dialog.querySelector('[data-codes-editor-state]'),save=dialog.querySelector('[data-save-encounter-codes]');
 const current=()=>encounterCodesDialogCurrent(dialog)&&dialog.open;
 const close=dialog.querySelector('[data-close-encounter-codes]'),retain=dialog.querySelector('[data-retain-encounter-codes]');
 retain.hidden=true;
 dialog.codesSaving=true;save.disabled=true;close.disabled=true;
 state.classList.remove('is-problem');state.textContent='Saving…';
 try{
  await flushVisitCodeDiagnoses(dialog.querySelector('#visit-diagnoses-form'));
  if(!current())return;
  const charges=dialog.querySelector('#billing-account-form');
  if(charges?.dataset.mode!=='correction'||applyCorrection)await flushEncounterProcedures(charges,current);
  if(current())dialog.close();
 }catch(error){
  if(current()){state.classList.add('is-problem');state.textContent=error.message||'The changes could not be saved.';retain.hidden=false;}
 }finally{dialog.codesSaving=false;save.disabled=false;close.disabled=false;}
}
function encounterCodeEditorParent(documentation,visit,account,diagnoses,editor,{needsDiagnosis=false,needsProcedure=false,postAccount=null}={}){
 const section=documentation.closest('[data-encounter-step-number]')?.querySelector('.encounter-step-body')||documentation;
 const identity=typeof me==='undefined'?null:me;
 let dialog=section.querySelector('[data-encounter-codes-dialog]');
 if(dialog&&(dialog.dataset.visit!==visit.id||dialog.dataset.patient!==selected||dialog.codesAccount!==identity)){
  if(dialog.open)dialog.close();
  dialog.remove();dialog=null;
 }
 const saved=encounterSavedCodes(visit,account);
 const includeProcedures=typeof visitBillingAreaVisible!=='function'||visitBillingAreaVisible();
 const visible=Boolean(diagnoses&&!diagnoses.hidden||includeProcedures&&editor&&!editor.hidden&&editor.firstElementChild);
 let heading=documentation.querySelector('[data-encounter-codes-heading]');
 if(!heading){
  heading=document.createElement('div');heading.className='section-head';heading.dataset.encounterCodesHeading='';
  heading.innerHTML='<h3>Diagnoses &amp; procedures</h3><div class="actions"><button type="button" data-open-encounter-codes aria-haspopup="dialog" aria-controls="encounter-codes-dialog">Add diagnosis</button><button type="button" class="primary" data-encounter-post-charges hidden>Post charges</button></div>';
  const noteActions=documentation.querySelector('#note-form > [data-note-actions]');
  if(noteActions){
   const footerStart=noteActions.parentElement.querySelector('#note-message')||noteActions;
   footerStart.before(heading);
  }else documentation.append(heading);
 }
 let summary=documentation.querySelector('[data-encounter-codes-summary]');
 if(!summary){summary=document.createElement('div');summary.dataset.encounterCodesSummary='';summary.className='encounter-codes-strip';heading.after(summary);}
 heading.hidden=!visible;summary.hidden=!visible;
 if(!dialog){
  dialog=document.createElement('dialog');dialog.className='sheet-dialog encounter-codes-dialog';dialog.dataset.encounterCodesDialog='';dialog.id='encounter-codes-dialog';dialog.setAttribute('aria-labelledby','encounter-codes-title');
  dialog.dataset.visit=visit.id;dialog.dataset.patient=selected;dialog.codesAccount=identity;
  dialog.innerHTML='<div class="sheet-head"><h2 id="encounter-codes-title" tabindex="-1" autofocus>Diagnoses &amp; procedures</h2><button type="button" data-close-encounter-codes>Close</button></div><div class="sheet-body"></div><div class="encounter-codes-footer"><span data-codes-editor-state role="status"></span><button type="button" data-retain-encounter-codes hidden>Keep draft in this tab</button><button type="button" class="primary" data-save-encounter-codes>Done</button></div>';
  // Claim fields share the procedure save, even if no lines were edited.
  const changedDetails=event=>{
   const field=event.target,form=field.closest?.('#billing-account-form');
   if(form&&field.name&&!field.closest('.billing-charge-row')&&(/^(?:cd_|fee_)/.test(field.name)||['coverage_id','service_date','notes'].includes(field.name))){
    form.dataset.codesDetailsChanged=String(Number(form.dataset.codesDetailsChanged||0)+1);
    if(form.dataset.mode!=='correction'&&!form.querySelector(':invalid')&&typeof scheduleChargeAutosave==='function')scheduleChargeAutosave(form);
   }
  };
  dialog.addEventListener('input',changedDetails,true);
  dialog.addEventListener('change',changedDetails,true);
  dialog.addEventListener('click',event=>{
   if(event.target.closest('[data-use-visit-type-codes]')){encounterApplyTemplateCodes(dialog);return;}
   if(event.target.closest('[data-retain-encounter-codes]')){dialog.close();return;}
   if(event.target.closest('[data-close-encounter-codes]')){void encounterSaveCodesDialog(dialog);return;}
   if(event.target.closest('[data-save-encounter-codes]')){void encounterSaveCodesDialog(dialog,{applyCorrection:true});return;}
   if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)void encounterSaveCodesDialog(dialog);}
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();void encounterSaveCodesDialog(dialog);});
  dialog.addEventListener('close',()=>{
   if(!encounterCodesDialogCurrent(dialog))return;
   if(typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
   if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
   const opener=dialog.codesLauncher?.isConnected?dialog.codesLauncher:$('encounter-documentation')?.querySelector('[data-open-encounter-codes]');
   opener?.focus?.({preventScroll:true});
   if(typeof encounterCodesStripRender==='function')void encounterCodesStripRender();
  });
  section.append(dialog);
 }
 if((!visible||!encounterCodesDialogCurrent(dialog))&&dialog.open)dialog.close();
 dialog.hidden=!visible;
 const editDiagnosis=!!diagnoses?.querySelector('#visit-diagnoses-form button[type="submit"]:not([disabled])');
 const editProcedure=includeProcedures&&!!editor?.querySelector('#billing-account-form:not([data-draft-read-only]),[data-edit-charges]');
 const editable=editDiagnosis||editProcedure;
 const launcher=heading.querySelector('[data-open-encounter-codes]');
 const area=editDiagnosis&&!saved.diagnoses?.length?'diagnoses':editProcedure&&!saved.lines.some(line=>line.code)?'procedures':'codes';
 const label=area==='diagnoses'?'Add diagnosis':area==='procedures'?'Add procedure':editable?'Edit codes':'View codes';
 const title=includeProcedures?'Diagnoses & procedures':'Diagnoses';
 for(const element of [heading.querySelector('h3'),dialog.querySelector('h2')])if(element.textContent!==title)element.textContent=title;
 if(launcher.textContent!==label)launcher.textContent=label;
 launcher.dataset.encounterCodesArea=area;
 const post=heading.querySelector('[data-encounter-post-charges]');
 const postId=editable&&postAccount?.id;
 post.hidden=!postId;
 if(postId)post.dataset.visitPostCharges=postId;else delete post.dataset.visitPostCharges;
 launcher.classList.toggle('primary',editable&&area!=='codes'&&!postId);
 const save=dialog.querySelector('[data-save-encounter-codes]');save.hidden=!editable;
 const correcting=editor?.querySelector('#billing-account-form[data-mode="correction"]');
 const doneLabel=correcting?'Save correction and close':'Done';
 if(save.textContent!==doneLabel)save.textContent=doneLabel;
 const codes=encounterCodesStripMarkup(saved,{interactive:false,includeProcedures,needsDiagnosis,needsProcedure});
 if(summary.codesMarkup!==codes){summary.codesMarkup=codes;summary.innerHTML=codes;}
 const body=dialog.querySelector('.sheet-body');
 const dxTitle=diagnoses?.querySelector('#visit-diagnoses .section-head h3');
 if(dxTitle&&dxTitle.textContent!=='Diagnoses (ICD-10)')dxTitle.textContent='Diagnoses (ICD-10)';
 const procedureTitle=editor?.querySelector('.charge-lines-title');
 if(procedureTitle&&procedureTitle.textContent!=='Procedures & fees (CPT/HCPCS)')procedureTitle.textContent='Procedures & fees (CPT/HCPCS)';
 const form=editor?.querySelector('#billing-account-form'),serviceDate=form?.elements.service_date?.value;
 if(serviceDate){
  for(const dates of form.querySelectorAll('details.charge-line-dates:not([data-codes-dates-checked])')){
   dates.dataset.codesDatesChecked='';dates.dataset.inline='';
   const fields=[...dates.querySelectorAll('input[type="date"]')];
   if(fields.every(f=>f.validity.valid&&(!f.value||f.value===serviceDate))){
    dates.open=false;dates.querySelector('summary').textContent='Different dates for this line';
   }
  }
 }
 for(const selector of ['[data-previous-procedure-choices]','[data-clinical-diagnosis-search]']){
  const fresh=documentation.querySelector(selector);if(!fresh)continue;
  const old=body.querySelector(selector);if(old&&old!==fresh)old.remove();
  encounterStepMove(fresh,body);
 }
 if(dialog.open)encounterTemplateCodesPaint(dialog);
 return body;
}
function encounterPaymentLedger(s){return (workspace.billing?.entries||[]).filter(entry=>s.account?.id&&entry.account_id===s.account.id);}
function encounterSelfPayCredits(s){return visitBillingSelfPayCredits(s,workspace.billing?.copays||[],encounterPaymentLedger(s));}
function encounterPaymentHistory(body){
 let dialog=body.querySelector('dialog[data-step-payment-details]');
 if(!dialog){
  dialog=document.createElement('dialog');dialog.dataset.stepPaymentDetails='';
  dialog.className='sheet-dialog sheet-wide';dialog.setAttribute('aria-label','Payment history');
  dialog.innerHTML='<header class="sheet-head"><h3>Payment history</h3><button type="button" class="sheet-close" data-close-encounter-payment-history aria-label="Close payment history">×</button></header><div class="sheet-body"></div>';
  body.append(dialog);
  dialog.addEventListener('click',event=>{
   if(event.target.closest('[data-close-encounter-payment-history]'))dialog.close();
   else if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();}
  });
  dialog.addEventListener('close',()=>{
   dialog.querySelector('[data-encounter-payment-editor]')?.remove();
   if(dialog.dataset.visit===activeVisit?.id&&dialog.dataset.patient===selected)body.querySelector('[data-open-encounter-payment-history]')?.focus({preventScroll:true});
  });
 }
 if(dialog.dataset.visit!==activeVisit?.id||dialog.dataset.patient!==selected){
  if(dialog.open)dialog.close();
  dialog.dataset.visit=activeVisit?.id||'';dialog.dataset.patient=selected;
  dialog.querySelector('.sheet-body').replaceChildren();
 }
 return dialog;
}
function openEncounterPaymentHistoryEditor(dialog,html){
 if(!dialog.open||dialog.dataset.visit!==activeVisit?.id||dialog.dataset.patient!==selected)return;
 const body=dialog.querySelector('.sheet-body');
 let host=body.querySelector('[data-encounter-payment-editor]');
 if(!host){host=document.createElement('div');host.dataset.encounterPaymentEditor='';body.prepend(host);}
 host.innerHTML=html;
 const form=host.querySelector('form');
 form.dataset.patient=selected;form.dataset.visit=activeVisit.id;form.revenueIdentity=me;
 if(form.id==='billing-ledger-form'){
  const account=encounterChargeAccount();
  if(!account||account.content.visit_id!==activeVisit.id){host.replaceChildren();throw new Error('Refresh this encounter’s billing account before editing.');}
  form.dataset.account=account.id;form.dataset.version=account.version;
 }
 const field=form.querySelector('input:not([type="hidden"]),select');
 field?.focus();
}
function encounterStepPayments(body,revenue,status,s,model,locked){
 const selfPay=model.selfPay,posted=s.account?.status==='posted',draftInsured=!posted&&s.insurance?.insured===true;
 const amount=posted?s.patient?.owes_now_cents:draftInsured?s.patient?.copay_due_cents:null;
 const known=Number.isSafeInteger(amount)&&amount>=0;
 const stale=encounterRevenueState.data?.stale,failed=encounterRevenueState.data?.error,review=s.patient?.receipt_needs_review||s.receipts?.some(r=>!r.voided&&r.needs_review);
 const canCollect=!stale&&!failed&&!review&&known&&amount>0&&(posted?!locked:draftInsured)&&(typeof billingCan!=='function'||billingCan('create'));
 let text='Balance pending';
 if(failed)text='Balance could not be loaded.';
 else if(stale)text='Balance could not be refreshed.';
 else if(review)text='Review the payment history before collecting.';
 else if(known)text=posted?(amount===0?'No patient amount due':'Patient amount due '+money(amount)):(amount===0?'No copay due':'Copay due '+money(amount));
 else if(s.patient&&selfPay&&!posted)text='Balance available after charges are posted.';
 else if(s.patient&&draftInsured)text='Copay not confirmed.';
 const retry=failed||stale?'<button type="button" class="text-button" data-refresh-revenue>Retry balance</button>':'';
 const insurer=posted&&s.insurance?.insured&&!failed&&!stale?encounterInsurerPayment(s,model):'';
 const remittance=insurer&&s.state==='post_response'&&s.claim?.response_to_review?
  `<button type="button" class="primary" data-revenue-remittance="${esc(s.claim.response_to_review)}">Review insurer payment</button>`:'';
 const receipt=posted&&amount===0?visitBillingSelfPayReceipt(s):'';
 const dialog=encounterPaymentHistory(body),destination=dialog.querySelector('.sheet-body');
 for(const id of ['visit-billing-payments','visit-billing-invoices','encounter-copay-receipt']){
  encounterStepMove(revenue.querySelector(`:scope > #${id}`)||$(id),destination);
 }
 const ledger=destination.querySelector('#visit-billing-payments'),statements=destination.querySelector('#visit-billing-invoices');
 for(const selector of ['.visit-billing-totals','.visit-billing-breakdown','.visit-billing-more']){
  const fresh=status?.querySelector(selector);
  if(selfPay||draftInsured&&selector!=='.visit-billing-more'){fresh?.remove();destination.querySelector(selector)?.remove();continue;}
  if(fresh){destination.querySelector(selector)?.remove();destination.append(fresh);}
 }
 let payment=body.querySelector('[data-step-payment]');
 if(!payment){
  payment=document.createElement('div');payment.dataset.stepPayment='';body.prepend(payment);
  payment.addEventListener('click',event=>{
   if(event.target.closest('[data-open-encounter-payment-history]')&&!dialog.open)dialog.showModal();
  });
 }
 const write=(node,markup)=>{if(node.paymentMarkup!==markup){node.paymentMarkup=markup;node.innerHTML=markup;}};
 const history=!!(ledger||statements||s.receipts?.length||s.timeline?.length||posted||review);
 write(payment,`<div class="encounter-payment-summary" aria-live="polite"><p data-payment-summary>${esc(text)}</p>${insurer?`<p class="muted" data-insurer-payment-summary>${esc(insurer)}</p>`:''}</div>${retry}${remittance}${canCollect?'<button type="button" class="primary" data-visit-collect>Take payment</button>':''}${receipt}${history?'<button type="button" class="text-button" data-open-encounter-payment-history>Payment history</button>':''}`);
 for(const button of ledger?.querySelectorAll('[data-visit-collect]')||[])button.hidden=true;
 let actions=destination.querySelector('[data-payment-detail-actions]');
 if(!actions){actions=document.createElement('div');actions.dataset.paymentDetailActions='';destination.append(actions);}
 if(selfPay){
  const ctx=typeof visitBillingStateContext==='function'?visitBillingStateContext():{canCreate:typeof billingCan!=='function'||billingCan('create'),canWrite:typeof billingCan!=='function'||billingCan()};
  write(actions,visitBillingSelfPayDetails(s,ctx,encounterSelfPayCredits(s),{ledger:!!ledger,statements:!!statements,due:amount}));
  return;
 }
 // The ledger presents the receipt once. Keep receipts absent from that list (including
 // voids and visits without a charge account) and vetted correction actions accessible.
 const ids=new Set([...ledger?.querySelectorAll('[data-copay-receipt]')||[]].map(button=>button.dataset.copayReceipt));
 const groups=new Set([...ledger?.querySelectorAll('[data-payment-group]')||[]].map(button=>button.dataset.paymentGroup));
 const supplemental=visitBillingReceiptEntries(s.receipts).filter(entry=>entry.group?
  !groups.has(entry.group)&&!entry.parts.every(receipt=>ids.has(receipt.id)):!ids.has(entry.receipt.id));
 const links=supplemental.map(entry=>{
  const receipt=entry.receipt||entry.parts[0],key=entry.group||receipt.id;
  if(!key||!receipt.appointment_id)return '';
  const label=typeof receiptNumberFor==='function'?receiptNumberFor(receipt.appointment_id,key):'';
  const voided=(entry.parts||[receipt]).every(row=>row.voided);
  return `<button type="button" ${entry.group?'data-payment-group':'data-copay-receipt'}="${esc(key)}" data-appointment="${esc(receipt.appointment_id)}">View receipt${label?' '+esc(label):''}${voided?' (voided)':''}</button>`;
 });
 if(typeof billingCan==='function'&&billingCan()){
  for(const receipt of encounterSelfPayCredits(s).correctable){
   const number=typeof receiptNumberFor==='function'?receiptNumberFor(receipt.appointment_id,receipt.payment_group_id||receipt.id):'';
   links.push(`<button type="button" data-copay-void="${esc(receipt.id)}">Correct receipt${number?' '+esc(number):''}</button>`);
  }
 }
 if(draftInsured&&s.receipts?.length)links.push('<button type="button" data-visit-history="payments">Payment history and refunds</button>');
 const facts=draftInsured?visitBillingDraftPayments(s):'';
 write(actions,(facts?`<p>${esc(facts)}</p>`:'')+(links.length?`<div class="actions">${links.join('')}</div>`:''));
}
function encounterInsurerPayment(s,model){
 const insurance=s.insurance;
 if(s.state==='post_response')return 'Insurer payment ready to review';
 if(s.state==='claim_rejected'||s.state==='claimmd_correction')return 'Insurer payment pending claim correction';
 if(s.state==='denied')return 'Payer denial recorded';
 if(insurance.paid_cents>0){
  const posted=`Insurer payment posted ${money(insurance.paid_cents)}`;
  return insurance.pending_cents>0?`${posted} · ${money(insurance.pending_cents)} still pending`:posted;
 }
 if(insurance.status==='answered'&&model.paid)return 'Insurer response posted';
 if(s.state==='insurance_outside')return 'Insurer billed outside SunCharts';
 return model.sent?'Insurer payment pending':'Insurer payment pending claim submission';
}
function encounterStepsSync(){
 const page=$('visit-page-host'),v=typeof activeVisit!=='undefined'?activeVisit:null;
 if(!page?.querySelector||!v||typeof page.append!=='function')return;
 const focused=document.activeElement;
 const focusedChip=page.contains(focused)?focused?.closest?.('[data-encounter-step-open]')?.dataset.encounterStepOpen:null;
 const focusedLabel=page.contains(focused)?focused?.closest?.('[data-encounter-label]'):null;
 encounterStepsObserver?.disconnect();
 try{
  page.dataset.encounterSteps='';delete page.dataset.encounterTab;
  const inEncounter=typeof chartSection==='undefined'||chartSection==='visits';
  const showing=inEncounter&&(typeof inRecordArea!=='function'||!inRecordArea());
  const wasVisible=page.dataset.stepsVisible==='true';page.dataset.stepsVisible=String(showing);page.hidden=!inEncounter;
  const revenue=$('encounter-revenue');if(!revenue)return;
  delete revenue.dataset.invoiceTab;
  const scoped=(!encounterRevenueState.visit||encounterRevenueState.visit===v.id)&&(!encounterRevenueState.patient||encounterRevenueState.patient===selected);
  const raw=scoped?encounterRevenueState.data?.summary||{}:{},s=typeof visitReviewPreviewSummary==='function'?visitReviewPreviewSummary(raw):raw,wrap=typeof checkoutStates!=='undefined'?checkoutStates.get(checkoutKey(selected,v.id)):null;
  const model=encounterStepsModel(s,v,null,!!wrap?.checkout?.completed);
  if(encounterStepView.visit!==v.id){encounterStepView={visit:v.id,current:model.current,viewed:model.closed||model.paid?2:1};}
  else encounterStepView.current=model.current;

  encounterStepView.patientDue=s.patient?.owes_now_cents;
  const one=encounterStepSection(1,page),three=encounterStepSection(2,revenue);
  const body=node=>node.querySelector('.encounter-step-body');
  const opening=showing&&(!wasVisible||page.dataset.stepsVisit!==v.id);
  if(opening){
   encounterStepView.viewed=model.closed||model.paid?2:1;
   encounterStepView.scrollDestination=null;encounterStepView.landing=null;
   if(typeof encounterChargeTableInline==='function')encounterChargeTableInline();
  }

  page.dataset.stepViewed=String(encounterStepView.viewed);
  page.dataset.stepsVisit=v.id;
  page.dataset.stepCurrent=String(model.current);
  encounterStepMove($('visit-editor'),body(one));
  const checkout=$('visit-checkout');
  if(checkout){
   encounterMountFollowup(checkout,body(one),v,showing);
  }
  const heading=$('encounter-progress');
  let stepper=$('encounter-stepper');if(!stepper){stepper=document.createElement('section');stepper.id='encounter-stepper';}
  stepper.hidden=!showing;
  const editorRooming=$('visit-editor')?.querySelector('[id="encounter-rooming-vitals"]');
  const mountedRooming=Array.from(page.children).find(node=>node.id==='encounter-rooming-vitals');
  const roomingBlock=editorRooming||mountedRooming;
  if(editorRooming&&mountedRooming&&editorRooming!==mountedRooming)mountedRooming.remove();
  const order=[heading,stepper,roomingBlock,one,revenue,$('encounter-orders-actions')].filter(Boolean);
  let nextNode=null;
  for(const node of [...order].reverse()){
   if(node.parentNode!==page||node.nextElementSibling!==nextNode)page.insertBefore(node,nextNode);
   nextNode=node;
  }
  const documentation=$('encounter-documentation')||body(one);
  if(showing&&typeof visitNoteEnableAutosave==='function')visitNoteEnableAutosave(documentation.querySelector('#note-form'));
  const billingAllowed=typeof visitBillingAreaVisible!=='function'||visitBillingAreaVisible();
  const clinicalOnly=documentation.querySelector('[data-encounter-diagnoses-only]')||page.querySelector('[data-encounter-codes-dialog] [data-encounter-diagnoses-only]');
  const diagnoses=billingAllowed?(revenue.querySelector(':scope > #encounter-diagnoses')||$('encounter-diagnoses')):clinicalOnly;
  const editor=billingAllowed?(revenue.querySelector(':scope > #encounter-billing-editor')||$('encounter-billing-editor')):null;
  // Claim previews include a placeholder row for typing. Only saved evidence can fold the code editor.
  const account=typeof encounterChargeAccount==='function'?encounterChargeAccount()||raw.account:raw.account;
  const focusedCode=document.activeElement;
  const restoreCodeFocus=diagnoses?.contains(focusedCode)||editor?.contains(focusedCode);
  const billableCodes=raw.insurance?.insured===true&&!model.sent&&['sign_visit','add_charges','post_charges','send_claim','fix_claim'].includes(raw.state);
  const postAccount=model.selfPay&&model.signed&&raw.state==='post_charges'&&raw.account?.status==='draft'&&
   !encounterRevenueState.data?.stale&&!encounterRevenueState.data?.error&&billingAllowed&&typeof billingCan==='function'&&billingCan()?raw.account:null;
  const codeParent=encounterCodeEditorParent(documentation,v,account,diagnoses,editor,{needsDiagnosis:billableCodes,needsProcedure:billableCodes,postAccount});
  if(clinicalOnly&&diagnoses===clinicalOnly){
   const previous=codeParent.querySelector('[data-encounter-diagnoses-only]');if(previous&&previous!==clinicalOnly)previous.remove();
  }
  if(billingAllowed&&clinicalOnly){
   if(typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
   clinicalOnly.remove();
   if(diagnoses&&!diagnoses.querySelector('#visit-diagnoses-form'))renderEncounterDiagnoses();
  }
  encounterStepMove(diagnoses,codeParent);encounterStepMove(editor,codeParent);
  if(restoreCodeFocus&&focusedCode.isConnected&&document.activeElement!==focusedCode)focusedCode.focus({preventScroll:true});
  const status=revenue.querySelector(':scope > #encounter-revenue-status')||$('encounter-revenue-status');
  const billingData=scoped?encounterRevenueState.data:null;
  const showClaim=billingAllowed&&!!s.insurance&&!model.selfPay;
  let claimStatus=documentation.querySelector('[data-encounter-claim-status]');
  if(!claimStatus){
   claimStatus=document.createElement('div');claimStatus.dataset.encounterClaimStatus='';
   const codesSummary=documentation.querySelector('[data-encounter-codes-summary]');
   // Only the read-only code summary belongs in the note form, never the claim controls.
   const claimAnchor=codesSummary?.closest('#note-form')||codesSummary;
   if(claimAnchor)claimAnchor.after(claimStatus);
   else documentation.append(claimStatus);
  }
  claimStatus.hidden=!showClaim;
  encounterStepMove(status,claimStatus);
  const paymentLocked=!model.signed||s.account?.status!=='posted';
  encounterStepPayments(body(three),revenue,status,s,model,paymentLocked);
  const roomingHost=$('visit-rooming');
  if(roomingBlock){
   let warnings=roomingBlock.querySelector('[data-signed-intake-warnings]');
   if(!warnings){
    warnings=document.createElement('p');warnings.dataset.signedIntakeWarnings='';warnings.setAttribute('role','status');
    roomingBlock.append(warnings);
   }
   const failed=typeof roomingUnfinished!=='undefined'&&roomingUnfinished.get(v.id)===selected;
   const message=model.signed?[roomingHost?.dataset.roomingRecordMissing,failed?'Rooming changes did not save before signing.':''].filter(Boolean).join(' · '):'';
   if(warnings.textContent!==message)warnings.textContent=message;
   warnings.hidden=!message;
  }
  let claimOptions=null;
  if(showClaim){
   let home=claimStatus.querySelector(':scope > [data-step-claim-actions]');
   if(!home){home=document.createElement('div');home.dataset.stepClaimActions='';home.hidden=true;claimStatus.append(home);}
   home.dataset.visit=v.id;home.dataset.patient=selected;
   const openDialog=document.querySelector('dialog[data-signed-claim-details][open]');
   claimOptions=openDialog?.claimOptionsHome===home?openDialog.claimOptionsControls:home.querySelector(':scope > [data-claim-option-controls]');
   if(!claimOptions){claimOptions=document.createElement('div');claimOptions.dataset.claimOptionControls='';home.append(claimOptions);}
  }
  const nextForCodes=editor?.querySelector('[data-charge-next] [data-visit-post-charges]');
  const addProcedure=raw.state==='add_charges'&&editor?.querySelector('[data-add-charge]');
  const needsCodesAction=model.selfPay&&model.signed&&['add_charges','post_charges'].includes(raw.state)&&!nextForCodes&&!addProcedure;
  const originalActions=status?.querySelector('.visit-billing-status');
  const codingActions=page.querySelector('[data-step-coding-actions]');
  if(codingActions)codingActions.hidden=!needsCodesAction;
  if(originalActions){
   for(const panel of [claimOptions,codingActions])panel?.querySelector('.visit-billing-status')?.remove();
   if(claimOptions)claimOptions.append(originalActions);
   else if(needsCodesAction){
    const actions=codingActions||document.createElement('div');
    actions.dataset.stepCodingActions='';actions.hidden=false;
    if(!codingActions)editor?.after(actions);
    actions.append(originalActions);
   }
  }
  if(claimOptions)encounterStepMove($('encounter-claims'),claimOptions);
  const detail=$('encounter-billing-detail');
  if(model.selfPay&&detail){
   const details=encounterStepDetails(codeParent,'service-details','Service details');
   encounterStepMove(detail,details);
   const inline=!!editor?.querySelector('#billing-account-form,.charge-table-finished');
   if(details.dataset.inline!==String(inline))details.open=!inline;
   details.dataset.inline=String(inline);
   const sections=detail.querySelector('.billing-account-detail')?.children||[];
   const hasOtherDetails=[...sections].some(node=>!node.matches('.section-head,.billing-table-wrap,p:not(.note-text)')&&(node.children.length||node.textContent.trim()));
   details.hidden=inline&&!hasOtherDetails;
  }else{
   encounterStepMove(detail,claimOptions);
   const details=documentation.querySelector('[data-step-service-details]');if(details&&!details.contains(detail))details.remove();
  }
  if(status)status.hidden=!showClaim;
  for(const [index,node] of [one,three].entries()){
   node.dataset.stepState=model.states[index];
   node.hidden=!showing||(index===1&&!billingAllowed);
   node.querySelector('[data-step-summary]')?.remove();
   body(node).querySelector(':scope > h3')?.remove();
  }
  // Section labels and status are separate from navigation. Nothing collapses when progress changes.
  const label=(node,title,status)=>{
   let head=node.querySelector(':scope > [data-encounter-label]');
   if(!head){
    head=document.createElement('div');head.dataset.encounterLabel='';head.className='encounter-section-label';
    head.tabIndex=-1;head.setAttribute('role','heading');head.setAttribute('aria-level','3');node.prepend(head);
   }
   head.innerHTML=`<span>${esc(title)}</span>${status?`<span class="pill">${esc(status)}</span>`:''}`;
  };
  if(roomingBlock){
   roomingBlock.dataset.encounterSection='rooming';
   roomingBlock.hidden=!showing;
   roomingBlock.querySelector(':scope > h3')?.remove();
   roomingBlock.querySelector('.badge[data-rooming-status]')?.remove();
   label(roomingBlock,'Rooming & vitals','');
  }
  label(one,'Note','');
  label(three,'Payment','');

  const stage=!model.signed||model.selfPay&&paymentLocked||showClaim&&!model.sent?'visit':'payment';
  const done={1:model.signed,2:model.paid};
  const currentStep=stage==='visit'?'1':'2';
  const originalSign=page.querySelector('[data-action="sign-bill"]');
  const originalAction=!model.signed?originalSign:null;
  if(originalAction){
   const sameVisit=raw.visit?.id===v.id&&raw.patient_id===selected;
   const mayCombine=sameVisit&&billingData&&!billingData.error&&!billingData.stale&&s.insurance?.insured===true&&
    typeof visitEncounterCanSignAndSubmit==='function'&&visitEncounterCanSignAndSubmit(s,account);
   const mode=mayCombine?'queue':null;
   if(mode)originalAction.dataset.claimHandoff=mode;else delete originalAction.dataset.claimHandoff;
   const name=mode==='queue'?'Sign & submit claim':'Sign & bill';
   if(originalAction.textContent!==name)originalAction.textContent=name;
   originalAction.hidden=!sameVisit||s.insurance?.insured!==false&&!mode;
   const signOnly=page.querySelector('#note-form [data-action="sign"]');
   const signLabel=originalAction.hidden?'Sign note':'Sign only';
   if(signOnly){
    if(signOnly.textContent!==signLabel)signOnly.textContent=signLabel;
    signOnly.classList.toggle('primary',originalAction.hidden);
   }
  }
  const chips=billingAllowed?encounterStepChips:encounterStepChips.slice(0,1);
  const markup=`<div class="encounter-step-toolbar"><nav class="encounter-step-chips" aria-label="Encounter sections">${chips.map(([key,name])=>{
   const current=!model.closed&&String(key)===currentStep;
   return `<button type="button" data-encounter-step-open="${key}" data-step-state="${done[key]?'done':current?'current':'todo'}"${current?' aria-current="step"':''}><span>${done[key]?'✓ ':''}${name}</span></button>`;
  }).join('')}</nav></div>`;
  if(stepper.encounterMarkup!==markup){
   stepper.innerHTML=markup;
   stepper.encounterMarkup=markup;
  }
  encounterStepsWatchScroll(page,showing);
  if(showing&&!opening&&document.activeElement!==focused){
   const restore=focusedChip?stepper.querySelector(`[data-encounter-step-open="${focusedChip}"]`):focusedLabel;
   if(restore?.isConnected)restore.focus({preventScroll:true});
   else if(focused?.isConnected&&page.contains(focused)&&focused.getClientRects?.().length)focused.focus?.({preventScroll:true});
  }
  $('patient-banner-claim')?.remove();
  if(opening){const frame=encounterStepFrame();if(frame)frame.scrollTop=0;}
  if(encounterChargesLink){
   if(encounterChargesLink.visit!==v.id||encounterChargesLink.patient!==selected)encounterChargesLink=null;
   else if(showing&&(raw.insurance||encounterRevenueState.data?.error)){
    encounterChargesLink=null;
    encounterStepOpen('claim');
   }
  }
  if(showing&&opening)void encounterStepReviewLoad();
 }finally{
  if(typeof MutationObserver==='function'){
   if(!encounterStepsObserver)encounterStepsObserver=new MutationObserver(()=>encounterStepsSchedule());
   encounterStepsPage=page;encounterStepsObserver.observe(page,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','disabled','data-codes-editing']});
  }
 }
}
// Scroll position is independent of the workflow's current/done marks.
function encounterStepsWatchScroll(page,showing){
 encounterScrollView?.disconnect();
 encounterScrollView=null;
 const frame=showing?encounterStepFrame():null;
 let visibleKey=encounterStepView.scrollKey||'1',markedKey;
 const update=()=>{
  let key=visibleKey;
  const destination=encounterStepView.scrollDestination;
  if(destination&&frame){
   const position=frame.scrollTop,limit=encounterScrollLimit(frame);
   const atDestination=Math.abs(position-Math.min(destination.top,limit))<1;
   // A redraw can resize the frame's scroll range and clamp its scroll position.
   const samePosition=Math.abs(position-destination.position)<1;
   if(atDestination||destination.reached&&(samePosition||limit!==destination.limit)){
    destination.reached=true;destination.position=position;destination.limit=limit;key=destination.key;
   }else if(destination.reached)encounterStepView.scrollDestination=null;
  }
  if(key===markedKey)return;
  markedKey=key;encounterStepView.scrollKey=key;
  for(const button of page.querySelectorAll('[data-encounter-step-open]')){
   const viewed=button.dataset.encounterStepOpen===key;
   button.dataset.stepViewed=String(viewed);
   if(viewed)button.setAttribute('aria-description','Section in view');else button.removeAttribute('aria-description');
  }
 };
 update();
 if(!showing)return;
 const visible=new Map();
 let observer;
 if(typeof IntersectionObserver==='function'){
  observer=new IntersectionObserver(entries=>{
   for(const entry of entries){if(entry.isIntersecting)visible.set(entry.target,entry);else visible.delete(entry.target);}
   const first=[...visible.values()].sort((a,b)=>a.target.getBoundingClientRect().top-b.target.getBoundingClientRect().top)[0];
   if(first)visibleKey=first.target.dataset.encounterSection?'1':first.target.dataset.encounterStepNumber;
   update();
  },{root:frame,rootMargin:`-${encounterScrollInset(frame)}px 0px -45% 0px`,threshold:0});
  for(const node of page.querySelectorAll('[data-encounter-section],[data-encounter-step-number]:not([hidden])'))observer.observe(node);
 }
 // A near-bottom section can be reached without crossing the observer's active band.
 const scroll=()=>{if(encounterStepView.scrollDestination)update();};
 const cancelLanding=()=>{encounterStepView.landing=null;};
 const settle=()=>{
  const landing=encounterStepView.landing;
  if(!frame||!landing)return;
  if(!landing.target.isConnected||landing.target.closest('[hidden]')){cancelLanding();return;}
  // Focusing a step can enqueue scrollend before its new smooth scroll has moved.
  const destination=encounterStepView.scrollDestination;
  if(!landing.settled&&destination&&!destination.reached&&Math.abs(frame.scrollTop-landing.startTop)<1&&
     Math.abs(frame.scrollTop-Math.min(destination.top,encounterScrollLimit(frame)))>=1)return;
  landing.settled=true;
  const bounds=frame.getBoundingClientRect(),inset=encounterScrollInset(frame),heading=landing.target.getBoundingClientRect().top;
  if(heading>=bounds.top+inset-8&&heading<bounds.bottom)return;
  const top=Math.min(encounterScrollLimit(frame),Math.max(0,frame.scrollTop+heading-bounds.top-inset));
  if(Math.abs(frame.scrollTop-top)<1)return;
  encounterStepView.scrollDestination={key:landing.key,top,reached:false};
  frame.scrollTo({top,behavior:'instant'});
  update();
 };
 frame?.addEventListener?.('scroll',scroll,{passive:true});
 frame?.addEventListener?.('scrollend',settle);
 const manualEvents=['wheel','keydown','pointerdown','touchstart'];
 for(const type of manualEvents)frame?.addEventListener?.(type,cancelLanding,{passive:true});
 if(encounterStepView.landing?.settled)settle();
 encounterScrollView={update,disconnect(){
  observer?.disconnect();
  frame?.removeEventListener?.('scroll',scroll);frame?.removeEventListener?.('scrollend',settle);
  for(const type of manualEvents)frame?.removeEventListener?.(type,cancelLanding);
 }};
}
function encounterScrollLimit(frame){return Math.max(0,frame.scrollHeight-frame.clientHeight);}
function encounterScrollInset(frame){
 const frameTop=frame?.getBoundingClientRect().top||0,stepper=$('encounter-stepper');
 const bottom=node=>node?.getBoundingClientRect?.().bottom||frameTop;
 // Use the sticky position where the stepper will land when starting at the top of the page.
 const stickyBar=stepper&&typeof getComputedStyle==='function'&&getComputedStyle(stepper).display==='contents'?stepper.querySelector('.encounter-step-toolbar'):stepper;
 const stickyTop=stickyBar&&typeof getComputedStyle==='function'?parseFloat(getComputedStyle(stickyBar).top):NaN;
 const stepperBottom=Number.isFinite(stickyTop)&&stickyBar.offsetHeight?frameTop+stickyTop+stickyBar.offsetHeight:bottom(stickyBar);
 return Math.max(frameTop,bottom($('patient-banner')),stepperBottom)-frameTop+8;
}
function encounterContentScroll(target,behavior='instant',sectionKey=null){
 if(!target)return;const frame=encounterStepFrame();if(!frame?.scrollTo)return;
 for(let parent=target.parentElement;parent&&parent!==frame;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
 const top=Math.max(0,target.getBoundingClientRect().top-frame.getBoundingClientRect().top+frame.scrollTop-encounterScrollInset(frame));
 encounterStepView.landing=sectionKey?{target,key:sectionKey,startTop:frame.scrollTop,settled:false}:null;
 encounterStepView.scrollDestination=sectionKey?{key:sectionKey,top:Math.min(top,encounterScrollLimit(frame)),reached:false}:null;
 frame.scrollTo({top,behavior});
 if(sectionKey)encounterScrollView?.update();
}
function encounterStepFrame(){return $('chart')?.closest('.frame-content')||document.querySelector('#app > main');}
async function encounterStepReviewLoad(){
 if(typeof loadEncounterRevenueStatus!=='function')return;
 const visit=activeVisit?.id,patient=selected;
 try{
  await loadEncounterRevenueStatus(typeof encounterChargeAccount==='function'?encounterChargeAccount():null);
  if(activeVisit?.id!==visit||selected!==patient)return;
  if(typeof visitReviewRestore==='function')visitReviewRestore();
 }catch(error){
  if(activeVisit?.id!==visit||selected!==patient)return;
  const host=$('encounter-revenue-status');
  if(host)host.innerHTML=`<p role="alert">${esc(error?.message||'Billing for this encounter could not be loaded.')}</p><button type="button" data-refresh-revenue>Refresh</button>`;
 }
 encounterStepsSchedule();
}
function encounterMountFollowup(checkout,home,visit,showing){
 let section=home.querySelector('[data-step-followup]');
 if(!section){
  section=document.createElement('section');section.dataset.stepFollowup='';
  section.innerHTML='<button type="button" data-open-visit-followup aria-haspopup="dialog" aria-controls="visit-followup-dialog">Patient instructions &amp; follow-up</button><dialog id="visit-followup-dialog" class="sheet-dialog" data-visit-followup-dialog aria-labelledby="visit-followup-title"><header class="sheet-head"><h3 id="visit-followup-title">Patient instructions &amp; follow-up</h3><button type="button" data-close-visit-followup aria-label="Close">×</button></header><p class="notice" role="status" data-checkout-feedback hidden></p><div class="sheet-body"></div></dialog>';
  home.append(section);
  const dialog=section.querySelector('dialog'),launcher=section.querySelector('[data-open-visit-followup]');
  launcher.onclick=()=>encounterOpenFollowup();
  section.querySelector('[data-close-visit-followup]').onclick=()=>dialog.close();
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  dialog.addEventListener('close',()=>{if(!section.hidden&&launcher.isConnected&&section.dataset.visit===activeVisit?.id)launcher.focus({preventScroll:true});});
 }
 const dialog=section.querySelector('dialog'),hidden=typeof chartAreaEnabled==='function'&&!chartAreaEnabled('checkout');
 if(dialog.open&&(!showing||hidden||section.dataset.visit!==visit.id))dialog.close();
 if(section.dataset.visit!==visit.id)dialog.querySelector('[data-checkout-feedback]').hidden=true;
 section.hidden=hidden;section.dataset.visit=visit.id;
 encounterStepMove(checkout,dialog.querySelector('.sheet-body'));
 if(typeof mountVisitCheckoutTabs==='function')mountVisitCheckoutTabs(checkout);
}
function encounterOpenFollowup({focus=true}={}){
 const checkout=$('visit-checkout');if(!checkout||!activeVisit)return;
 if(!checkout.closest('[data-visit-followup-dialog]'))encounterStepsSync();
 const section=checkout.closest('[data-step-followup]'),dialog=checkout.closest('[data-visit-followup-dialog]');
 if(!dialog||section.hidden||section.dataset.visit!==activeVisit.id)return;
 if(!dialog.open)dialog.showModal();
 if(focus)(dialog.querySelector('[data-checkout-tab][aria-pressed="true"]')||dialog.querySelector('[data-close-visit-followup]'))?.focus({preventScroll:true});
}
function encounterStepOpen(number,{fromChip=false,focus=false}={}){
 if(String(number)==='3'){encounterOpenFollowup({focus});return;}
 const page=$('visit-page-host');
 const smooth=fromChip&&(typeof motionReduced!=='function'||!motionReduced());
 if(number==='claim'){
  const target=page?.querySelector('[data-encounter-claim-status]:not([hidden]) [data-open-signed-claim-details]')||
   page?.querySelector('[data-encounter-codes-heading]')||$('encounter-documentation');
  if(focus)target?.focus({preventScroll:true});
  encounterContentScroll(target,smooth?'smooth':'instant','1');
  return;
 }
 const node=page?.querySelector(`[data-encounter-step-number="${Number(number)}"]`);
 const heading=node?.querySelector('[data-encounter-label]');
 if(focus)heading?.focus({preventScroll:true});
 encounterContentScroll(heading||node,smooth?'smooth':'instant',fromChip?String(number):null);
}
function encounterHistoryOpen(){
 const history=$('visit-billing-history');if(!history||history.closest?.('dialog'))return;
 const home=history.parentNode,marker=document.createComment('history');home.insertBefore(marker,history);history.hidden=false;history.open=true;
 const dialog=sheetOpen('Encounter history',history);
 dialog.addEventListener('close',()=>{if(marker.parentNode){marker.replaceWith(history);history.hidden=true;}},{once:true});
}
if(typeof document!=='undefined'&&document.addEventListener){
 if(typeof window!=='undefined')window.addEventListener?.('resize',encounterStepsSchedule);
 for(const type of ['input','change'])document.addEventListener(type,event=>{if(event.target.closest?.('#rooming-form'))encounterStepsSchedule();});
 document.addEventListener('click',event=>{
  const target=event.target;
  const openCodes=target.closest?.('[data-open-encounter-codes],[data-encounter-codes-anchor]');
  if(openCodes){event.preventDefault();encounterOpenCodesDialog(openCodes,openCodes.dataset.encounterCodesArea);return;}
  const chip=target.closest?.('[data-encounter-step-open]');
  if(chip){
   event.preventDefault();
   encounterStepOpen(chip.dataset.encounterStepOpen,{fromChip:true,focus:event.detail===0});
   return;
  }
  if(target.closest?.('[data-encounter-history-sheet]')){event.preventDefault();encounterHistoryOpen();return;}
  const preview=target.closest?.('[data-encounter-claim-form]');
  if(preview){
   event.preventDefault();
   const claim=preview.dataset.encounterClaimForm||encounterRevenueState.data?.summary?.claim?.id;
   if(claim){
    const person=selected,visit=activeVisit?.id,identity=me;
    const current=()=>person===selected&&visit===activeVisit?.id&&identity===me&&encounterRevenueState.data?.summary?.claim?.id===claim;
    if(current())run(()=>openClaimFormPreview(claim,current));
    return;
   }
   const panel=document.createElement('div');panel.innerHTML=visitReviewFormMarkup(encounterRevenueState.data?.summary||{});sheetOpen('View claim form',panel);
  }
 });
}

// Signing refreshes the chart, so restore the live Visit's scroll after its nodes are rebuilt.
function encounterStepPosition(){
 const page=$('visit-page-host');if(page?.dataset?.encounterSteps===undefined)return null;
 const visit=activeVisit?.id,patient=selected,viewed=Number(page.dataset.stepViewed||1);
 const frame=encounterStepFrame(),top=frame?.scrollTop||0;
 const offset=page.querySelector(`[data-encounter-step-number="${viewed}"] .encounter-step-body`)?.scrollTop||0;
 return ()=>{
  if(activeVisit?.id!==visit||selected!==patient)return;
  encounterStepView.viewed=viewed;encounterStepsSync();
  const body=$('visit-page-host')?.querySelector(`[data-encounter-step-number="${viewed}"] .encounter-step-body`);
  if(body)body.scrollTop=offset;if(frame)frame.scrollTop=top;
 };
}

// A prepared statement is separate from each confirmed delivery.
var currentVisitStatement=null;
async function loadStatementDeliveries(state){
 const data=await api(`/api/v1/patients/${encodeURIComponent(state.patient)}/billing/statements/${encodeURIComponent(state.invoice.id)}/deliveries`);
 if(currentVisitStatement!==state||selected!==state.patient||me!==state.identity)return;
 const actions=$('statement-send-actions'),history=$('statement-deliveries');
 const email=workspace?.demographics?.content?.email;
 if(actions)actions.innerHTML=(data.portal?'<button type="button" class="primary" data-send-statement>Send statement</button>':'No sending channel is configured. Use Print / save PDF.')+(!email?'<p>No email on file — add one in Profile <button type="button" data-statement-profile>Open Profile</button></p>':'');
 if(history)history.innerHTML='<h4>Statements sent</h4>'+(data.items.length?'<ul>'+data.items.map(item=>`<li>${esc(date(item.at))} · ${esc(item.channel==='portal'?'Patient portal':item.channel)} · ${esc(item.actor_label)}</li>`).join('')+'</ul>':'<p>No deliveries recorded.</p>');
}
// Denial actions have their own review sheet so they cannot replace an encounter's coding draft.
function openVisitDenialSheet(title,html){
 const content=document.createElement('div');
 content.innerHTML=html;
 const dialog=sheetOpen(title,content,{className:'chart-record-sheet',label:true});
 dialog.setAttribute('data-visit-denial-editor','');
 return content;
}
function closeVisitDenialSheet(form){
 const sheet=form.closest('dialog[data-visit-denial-editor]');
 if(!sheet)return;
 sheet.close();sheet.remove();
 const source=document.querySelector('dialog[data-signed-claim-details][open]');
 if(source){source.close();source.remove();}
}
function openDeniedClaimAction(action){
 const summary=encounterRevenueState.data?.summary,account=encounterChargeAccount();
 if(!summary?.claim?.id||summary.state!=='denied'||summary.claim.status!=='adjudicated'||summary.claim.answer?.denied!==true||!account)throw new Error('Open the payer’s recorded denial before changing the balance.');
 const label=action==='write_off'?'Write off':'Move to patient balance';
 openVisitDenialSheet(label,`<form id="denial-resolution" data-visit="${esc(activeVisit.id)}" data-patient="${esc(selected)}" data-account="${esc(account.id)}" data-claim="${esc(summary.claim.id)}" data-version="${account.version}" data-request="${crypto.randomUUID()}" data-action="${esc(action)}"><p>${action==='write_off'?'Take the remaining balance off this encounter as a ledger adjustment.':'Assign the remaining encounter balance to the patient. Review coverage and the insurer’s answer first.'}</p><label>Reason<input name="reason" required maxlength="1000"></label><button class="primary" type="submit">${label}</button><button type="button" data-sheet-close>Cancel</button></form>`);
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-send-statement],[data-statement-profile],[data-denial-action],[data-denial-appeal]');if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();run(async()=>{
  if(button.hasAttribute('data-statement-profile')){const sheet=button.closest?.('dialog.sheet-dialog');if(sheet&&typeof sheetClose==='function')sheetClose(sheet);showChartSection('profile');return;}
  if(button.dataset.denialAction){openDeniedClaimAction(button.dataset.denialAction);return;}
  if(button.dataset.denialAppeal){await startVisitClaimAppeal(button.dataset.denialAppeal);return;}
  const state=currentVisitStatement;if(!state||state.patient!==selected||state.identity!==me)return;
  button.disabled=true;
  try{await api(`/api/v1/patients/${encodeURIComponent(state.patient)}/billing/statements/${encodeURIComponent(state.invoice.id)}/deliveries`,'POST',{request_id:state.request});if(currentVisitStatement!==state||selected!==state.patient||me!==state.identity)return;state.request=crypto.randomUUID();await loadStatementDeliveries(state);notice('Statement sent to the patient portal.');await loadEncounterRevenueStatus(encounterChargeAccount(),true);}
  finally{if(button.isConnected)button.disabled=false;}
 });
},true);
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='denial-resolution')return;event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{const patient=selected,identity=me;if(form.dataset.patient!==patient||form.dataset.visit!==activeVisit?.id||form.dataset.account!==encounterChargeAccount()?.id)return;const button=form.querySelector('button[type="submit"]');button.disabled=true;try{await api(`/api/v1/patients/${patient}/billing/accounts/${form.dataset.account}/denial`,'POST',{request_id:form.dataset.request,claim_id:form.dataset.claim,action:form.dataset.action,reason:form.elements.reason.value},Number(form.dataset.version));if(selected!==patient||me!==identity||form.dataset.visit!==activeVisit?.id)return;closeVisitDenialSheet(form);await loadEncounterRevenueStatus(encounterChargeAccount(),true);notice('Balance updated.');}finally{if(button.isConnected)button.disabled=false;}});
},true);
