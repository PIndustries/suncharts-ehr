// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One billing card per visit. Every amount comes from the server's visit billing summary;
// this file only words and lays it out. One vocabulary names a visit's billing state here,
// in the insurance claims list and on the patient billing page.
const visitBillingStateNames={add_charges:'Add charges',sign_visit:'Sign the visit',post_charges:'Post charges',self_pay_collect:'Self-pay: collect payment',prepare_claim:'Preparing claim',claim_cancelled:'Claim cancelled',fix_claim:'Claim needs details',send_claim:'Send claim',waiting_insurer:'Waiting on insurer',post_response:'Insurer answered: review payment',denied:'Denied: fix and resend',review_response:'Review insurer answer',patient_owes:'Patient owes',patient_credit:'Patient credit',paid_in_full:'Paid in full',insurance_outside:'Insurance billed outside SunCharts',claim_restricted:'Charges are final'};
function visitBillingStateName(state){return visitBillingStateNames[state]||'Billing status unavailable';}
// A claim row carries only its own status; name it with the same words the visit card uses.
function visitBillingClaimState(claim){
 if(!claim)return '';
 if((claim.crossover_tracking_only||claim.crossover)&&claim.status==='submitted')return 'Secondary insurer answered';
 return ({draft:visitBillingStateNames.send_claim,ready:visitBillingStateNames.send_claim,submitted:visitBillingStateNames.waiting_insurer,accepted:visitBillingStateNames.waiting_insurer,rejected:visitBillingStateNames.denied,adjudicated:'Insurer answered',void:visitBillingStateNames.claim_cancelled})[claim.status]||'Claim status unavailable';
}
function visitBillingDate(value){
 if(!value)return '';
 const text=String(value),dayOnly=/^\d{4}-\d{2}-\d{2}$/.test(text),parsed=new Date(dayOnly?text+'T00:00:00Z':text);
 if(Number.isNaN(parsed.getTime()))return '';
 return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',...(dayOnly?{timeZone:'UTC'}:{})}).format(parsed);
}
function visitBillingMethod(method){return ({cash:'cash',check:'check',external:'paid elsewhere',card:'card',other:'other',none:''})[method]||'';}
function visitBillingInsurer(s){return s.claim?.payer_name||s.insurance?.insurer||'the insurer';}
// The status line: what is happening, who is waiting on whom, and the one next step.
function visitBillingStatus(s,ctx={}){
 const insurer=visitBillingInsurer(s),owes=money(s.patient.owes_now_cents),paid=money(s.insurance.paid_cents),account=s.account?.id||'',claim=s.claim?.id||'',write=ctx.canWrite,create=ctx.canCreate;
 const button=(label,attribute)=>`<button type="button" class="primary" ${attribute}>${esc(label)}</button>`;
 switch(s.state){
  case 'add_charges':return {headline:'Add charges',detail:'Add the procedures done at this visit. Waiting on your office.',action:create?button('Add charges','data-encounter-charges'):''};
  case 'sign_visit':return {headline:'Charges can still be changed',detail:'The visit note must be signed before the charges are posted. Waiting on the clinician.',action:button('Continue the visit note','data-revenue-documentation')};
  case 'post_charges':return {headline:'Post charges',detail:`Check the charges, then post them. ${s.insurance.insured?`The claim to ${insurer} is prepared for you next.`:'The patient is billed next.'} Waiting on your office.`,action:button(write?'Review and post charges':'Review charges',`data-revenue-account="${esc(account)}"`)};
  case 'self_pay_collect':return {headline:'Self-pay: collect payment',detail:`Patient owes ${owes}. Waiting on the patient.`,action:create?button('Collect payment','data-visit-collect'):''};
  case 'prepare_claim':return ctx.prepareError?{headline:`The claim to ${insurer} could not be prepared`,detail:ctx.prepareError,action:create?button('Try again','data-visit-claim-prepare'):''}:create?{headline:`Preparing the claim to ${insurer}`,detail:'The claim is filled in from this visit. Nothing is sent until you send it.',action:ctx.preparing?'':button('Prepare claim','data-visit-claim-prepare')}:{headline:'Charges are final',detail:`Billing staff prepare the claim to ${insurer}.`,action:''};
  case 'claim_cancelled':return {headline:`The claim to ${insurer} was cancelled`,detail:'Nothing is with the insurer. Waiting on your office.',action:create?button('Prepare a new claim','data-visit-claim-prepare="again"'):''};
  case 'fix_claim':return {headline:`Claim to ${insurer} needs details`,detail:'Nothing has been sent yet. Waiting on your office.',issues:s.claim?.issues||[],action:write?button('Fix claim details',`data-visit-claim-fix="${esc(claim)}"`):''};
  case 'send_claim':return {headline:`Claim ready to send to ${insurer}`,detail:'Nothing has been sent yet. Waiting on your office.',action:write?button('Review and send claim',`data-visit-claim-send="${esc(claim)}"`):''};
  case 'waiting_insurer':return {headline:`Waiting on ${insurer}`,detail:`${s.insurance.sent_on?`Claim sent ${visitBillingDate(s.insurance.sent_on)}. `:''}Nothing to do until they answer.`,action:button('Check claim status',`data-revenue-claim="${esc(claim)}"`)};
  case 'post_response':return {headline:`${insurer} answered`,detail:'Review their payment and post it to this visit. Waiting on your office.',action:button('Review insurer payment',`data-revenue-remittance="${esc(s.claim?.response_to_review||'')}"`)};
  case 'denied':return {headline:`Denied by ${insurer}`,detail:'Fix the claim and send it again. Waiting on your office.',action:button('Fix and resend claim',`data-revenue-claim="${esc(claim)}"`)};
  case 'review_response':return {headline:`Insurance paid ${paid}`,detail:`${money(s.insurance.unassigned_cents)} is not paid, written off or assigned to the patient yet. Review the insurer’s answer. Waiting on your office.`,action:button('Review insurer answer',`data-revenue-claim="${esc(claim)}"`)};
  case 'patient_owes':return {headline:`Patient owes ${owes}`,detail:`Insurance paid ${paid}. Waiting on the patient.`,action:create?button('Collect payment','data-visit-collect'):''};
  case 'patient_credit':return {headline:`Patient has a ${money(s.patient.credit_cents)} credit`,detail:'Nothing more is owed for this visit. Refund the credit or keep it for another visit.',action:button('Review payments','data-visit-history="payments"')};
  case 'paid_in_full':return {headline:'Paid in full',detail:'Nothing is owed for this visit.',action:''};
  case 'insurance_outside':return {headline:`${insurer} is billed outside SunCharts`,detail:'This insurer has no payer ID here, so no claim is sent from SunCharts. Record their payment when it arrives.',action:create?button('Record insurer payment','data-new-ledger'):''};
  case 'claim_restricted':return {headline:'Charges are final',detail:`Billing staff handle the claim to ${insurer}.`,action:''};
  default:return {headline:'Billing status unavailable',detail:'Refresh before relying on these amounts.',action:''};
 }
}
function visitBillingReceiptNote(receipt){const how=visitBillingMethod(receipt.method),when=visitBillingDate(receipt.occurred_on);return [how,when].filter(Boolean).join(', ');}
function visitBillingReceiptButtons(receipts){return receipts.map(r=>`<button type="button" class="text-button" data-copay-receipt="${esc(r.id)}" data-appointment="${esc(r.appointment_id)}">Receipt</button>`).join('');}
// One small table: charges, the insurer's side, the patient's side, and what the patient owes now.
function visitBillingBreakdown(s,ctx={}){
 const i=s.insurance,p=s.patient,posted=s.account?.status==='posted',row=(label,note,amount,cls='')=>`<tr class="${cls}"><th scope="row">${label}</th><td>${note||''}</td><td class="money-cell">${amount}</td></tr>`,group=label=>`<tr class="visit-billing-group"><th scope="rowgroup" colspan="3">${label}</th></tr>`;
 const receipts=(s.receipts||[]).filter(r=>!r.voided),received=p.received_cents,collect=ctx.canCreate&&s.visit?'<button type="button" class="text-button" data-visit-collect>Collect</button>':'';
 let rows=row('Charges',s.charges_cents==null?'':posted?'Charges are final':'Charges can still be changed',s.charges_cents==null?'Not added yet':money(s.charges_cents));
 if(i.insured){
  rows+=group(`Insurance: ${esc(i.insurer||'insurer on file')}`);
  const status={not_billed:'Billed after the charges are posted',not_sent:'Not sent yet',waiting:`Waiting${i.sent_on?` since ${esc(visitBillingDate(i.sent_on))}`:''}`,denied:'Denied',answered:s.claim?.answer?.payment_date?`Answered ${esc(visitBillingDate(s.claim.answer.payment_date))}`:'Answered',outside:'Billed outside SunCharts',restricted:'Handled by billing staff'}[i.status]||'';
  rows+=row('Insurance paid',status,posted?money(i.paid_cents):'');
  if(i.adjusted_cents)rows+=row('Insurance adjustments',i.adjusted_cents>0?'Written off, not owed by anyone':'Added back to the balance',money(Math.abs(i.adjusted_cents)));
  if(i.pending_cents>0)rows+=row('Insurance pending',i.status==='denied'?'Denied. Fix and resend the claim':i.status==='not_sent'?'Not the patient’s to pay unless the insurer says so':'Waiting on the insurer’s answer',money(i.pending_cents));
  if(i.unassigned_cents>0)rows+=row('Not assigned yet','Review the insurer’s answer',money(i.unassigned_cents));
 }else if(posted&&i.adjusted_cents)rows+=row('Adjustments',i.adjusted_cents>0?'Taken off the charges':'Added to the charges',money(Math.abs(i.adjusted_cents)));
 rows+=group(i.insured?'Patient':'Patient (self-pay)');
 const copay=p.copay_cents,notes=receipts.map(visitBillingReceiptNote).filter(Boolean).join('; '),links=visitBillingReceiptButtons(receipts);
 if(copay!=null){
  const due=p.copay_due_cents,paidTowards=p.copay_paid_cents;
  rows+=row(`Copay ${money(copay)}`,due===0?`Paid${notes?` (${esc(notes)})`:''} ${links}`:paidTowards>0?`${money(paidTowards)} paid${notes?` (${esc(notes)})`:''}, ${money(due)} due ${links} ${collect}`:`Due ${collect}`,money(paidTowards));
  if(p.paid_above_copay_cents>0)rows+=row('Paid above the copay','',money(p.paid_above_copay_cents));
 }else if(received>0||receipts.length)rows+=row('Paid at the visit',`${notes?esc(notes):''} ${links}`,money(received));
 else if(i.insured)rows+=row('Copay','No copay recorded for this plan','');
 if(p.other_payments_cents)rows+=row('Other patient payments','',money(p.other_payments_cents));
 if(p.adjustment_cents)rows+=row('Patient adjustments',p.adjustment_cents>0?'Taken off what the patient owes':'Added to what the patient owes',money(Math.abs(p.adjustment_cents)));
 if(p.unapplied_cents>0)rows+=row('Paid but not applied yet',posted&&s.balance_cents>0&&ctx.canWrite?'<button type="button" class="text-button" data-apply-copays>Apply to this visit</button>':'Credit on the patient’s account',money(p.unapplied_cents));
 if(p.overpaid_cents>0)rows+=row('Paid more than owed','Refund it or keep it as a credit',money(p.overpaid_cents));
 const basis={self_pay:'No insurance on this visit',plan_copay:'The plan copay, until the insurer answers',copay_not_recorded:posted?'Nothing until the insurer answers':'',insurer_response:'What the insurer says the patient owes, less what they paid',not_final:'Set when the charges are posted'}[p.responsibility_source]||'';
 rows+=row('Patient owes now',basis,money(p.owes_now_cents),'visit-billing-total');
 return `<table class="visit-billing-breakdown"><caption class="sr-only">Money for this visit</caption><tbody>${rows}</tbody></table>${p.receipt_needs_review?'<p role="status">A payment for this visit needs review. Open History before collecting again.</p>':''}`;
}
function visitBillingMore(s,ctx={}){
 const posted=s.account?.status==='posted',claim=s.claim,items=[];
 if(ctx.canCreate&&s.account?.status==='draft')items.push('<button type="button" data-encounter-charges>Change charges</button>');
 if(posted&&ctx.canCreate&&s.state!=='self_pay_collect'&&s.state!=='patient_owes'&&s.visit)items.push('<button type="button" data-visit-collect>Collect a payment</button>');
 if(posted&&ctx.canCreate)items.push('<button type="button" data-visit-statement>Patient statement</button>');
 if(posted&&ctx.canCreate)items.push('<button type="button" data-new-ledger>Record a payment, write-off or adjustment</button>');
 if(posted)items.push('<button type="button" data-visit-history="payments">Refunds and card payments</button>');
 if(claim&&ctx.claimsAllowed){
  items.push(`<button type="button" data-revenue-claim="${esc(claim.id)}">${claim.status==='adjudicated'||claim.status==='rejected'?'Open claim: correct, void or bill secondary insurance':'Open claim'}</button>`);
  if(!claim.secondary&&!claim.crossover)items.push(`<a class="button" href="/api/v1/billing/claims/${esc(claim.id)}/cms1500" target="_blank" rel="noopener">Claim form (CMS-1500) ↗</a>`);
 }
 items.push('<button type="button" data-chart-section="insurance">Insurance and eligibility</button>');
 return `<details class="visit-billing-more" data-revenue-disclosure="more"><summary>More</summary><div class="actions">${items.join('')}</div></details>`;
}
function visitBillingCardMarkup(s,ctx={}){
 const status=visitBillingStatus(s,ctx),owing=['patient_owes','self_pay_collect'].includes(s.state),posted=s.account?.status==='posted';
 const issues=status.issues?.length?`<p class="visit-billing-missing">Missing: ${status.issues.map(issue=>esc(issue.missing)).join(', ')}</p>`:'';
 const secondary=owing&&ctx.canCreate?'<button type="button" data-visit-statement>Statement</button>':'';
 return `<section class="visit-billing-card" data-visit-billing-state="${esc(s.state)}"><div class="section-head"><h3>Visit billing</h3>${s.account?'<button type="button" class="text-button" data-refresh-revenue>Refresh</button>':''}</div><div class="visit-billing-status"><div><span class="eyebrow">${s.waiting_on==='nobody'?'Status':'Next step'}</span><p class="visit-billing-headline">${esc(status.headline)}</p><p class="muted">${esc(status.detail)}</p>${issues}</div><div class="actions">${status.action||''}${secondary}</div></div>${visitBillingBreakdown(s,ctx)}${posted||s.account||s.visit?visitBillingMore(s,ctx):''}</section>`;
}
const visitBillingFilters=[['all','Everything'],['charges','Charges'],['insurance','Insurance'],['payments','Payments'],['statements','Statements sent']];
function visitBillingEventText(event){
 const amount=event.amount_cents==null?'':money(event.amount_cents),insurer=event.insurer||'the insurer',how=visitBillingMethod(event.method),by=how?` (${how})`:'';
 switch(event.code){
  case 'charges_added':return `Charges added: ${amount}`;
  case 'charges_changed':return 'Charges changed';
  case 'charges_posted':return `Charges posted: ${amount}. Charges are final`;
  case 'charges_removed':return 'Charges removed';
  case 'payment_received':return `Payment taken: ${amount}${by}`;
  case 'receipt_voided':return `Receipt cancelled: ${amount}${by}`;
  case 'receipt_applied':return `${amount} of a payment applied to this visit`;
  case 'patient_payment':return `Patient payment: ${amount}${by}`;
  case 'other_payment':return `Other payment: ${amount}${by}`;
  case 'adjustment_credit':return `Adjustment: ${amount} taken off`;
  case 'adjustment_debit':return `Adjustment: ${amount} added`;
  case 'card_refund':return `Card refund: ${amount}`;
  case 'reversal':return `Entry undone: ${amount}`;
  case 'insurer_payment':return `Insurance paid ${amount}`;
  case 'insurer_adjustment':return `Insurance adjustment: ${amount} written off`;
  case 'claim_prepared_auto':return `Claim to ${insurer} prepared from this visit`;
  case 'claim_prepared':return `${event.frequency==='replacement'?'Corrected claim':event.frequency==='void_request'?'Request to void the claim':event.secondary?'Secondary claim':'Claim'} to ${insurer} prepared`;
  case 'claim_crossover':return `${insurer} answered a claim forwarded by the primary insurer`;
  case 'claim_changed':return 'Claim details changed';
  case 'claim_ready':return 'Claim checked and ready to send';
  case 'claim_sent':return `Claim sent to ${insurer}`;
  case 'claim_accepted':return `${insurer} accepted the claim for processing`;
  case 'claim_rejected':return `${insurer} rejected the claim`;
  case 'claim_answered':return `${insurer} answered${event.patient_responsibility_cents==null?'':`: patient owes ${money(event.patient_responsibility_cents)}`}`;
  case 'claim_cancelled':return 'Claim cancelled';
  case 'statement':return `Statement prepared: ${amount} due`;
  default:return 'Billing activity';
 }
}
function visitBillingEventActions(event,ctx={}){
 if(event.receipt_id)return `<button type="button" class="text-button" data-copay-receipt="${esc(event.receipt_id)}" data-appointment="${esc(event.appointment_id)}">Receipt</button>`;
 if(event.invoice_id)return `<button type="button" class="text-button" data-visit-statement-open="${esc(event.invoice_id)}">View statement</button>`;
 if(event.claim_id&&ctx.claimsAllowed)return `<button type="button" class="text-button" data-revenue-claim="${esc(event.claim_id)}">Open claim</button>`;
 return '';
}
function visitBillingTimeline(s,ctx={},filter='all'){
 const events=(s.timeline||[]).filter(event=>filter==='all'||event.group===filter);
 return `<div class="actions visit-billing-filters" role="group" aria-label="Show">${visitBillingFilters.map(([key,label])=>`<button type="button" data-visit-history-filter="${key}" aria-pressed="${key===filter}">${label}</button>`).join('')}</div>${events.length?`<ol class="visit-billing-timeline">${events.map(event=>`<li data-group="${esc(event.group)}"><time>${esc(visitBillingDate(event.at))}</time><span>${esc(visitBillingEventText(event))}${event.test&&typeof testPaymentTag==='function'&&testPaymentTag()?' · '+esc(testPaymentTag()):''}</span>${visitBillingEventActions(event,ctx)}</li>`).join('')}</ol>`:`<p class="muted">${filter==='statements'?'No statement has been prepared for this visit.':'Nothing here yet.'}</p>`}`;
}
// Identifiers and versions are for the practice owner only; the server leaves them out for everyone else.
function visitBillingTechnical(s){
 const t=s.technical;if(!t)return '';
 const pair=(label,value)=>value==null||value===''?'':`<dt>${label}</dt><dd>${esc(value)}</dd>`;
 return `<dl class="billing-dl">${pair('Charge account',t.account_id)}${pair('Charge account version',t.account_version)}${pair('Imported record',t.source_history_id)}${pair('Member ID',t.member_id)}${pair('Coverage check',t.coverage_verification?human(t.coverage_verification):'')}${pair('Payer ID',t.payer_code)}${(t.claims||[]).map(c=>pair('Claim',`${c.control_number} · version ${c.version} · ${human(c.status)}${c.payer_control_number?' · insurer number '+c.payer_control_number:''}`)).join('')}</dl>`;
}
function visitBillingPrepareMessage(error){
 const text=String(error?.message||'');
 if(/forbidden|not allowed|permission/i.test(text))return 'Your sign-in cannot prepare claims. Ask billing staff to open this visit.';
 return text?`${text}. Try again, or open Insurance and eligibility to check the coverage.`:'Try again in a moment.';
}
// A blank message addressed to the patient; staff attach the saved PDF. No amount or
// visit detail is put in the link.
function visitBillingStatementMailto(invoice){
 const email=typeof workspace!=='undefined'?workspace?.demographics?.content?.email:'';
 if(!invoice||!email||!/^[^\s@<>,;:?&]+@[^\s@<>,;:?&]+$/.test(email))return '';
 return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Your statement')}`;
}
