// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One billing card per visit. Every amount comes from the server's visit billing summary;
// this file only words and lays it out. One vocabulary names an encounter's billing state here,
// in the insurance claims list and on the patient billing page.
const visitBillingStateNames={add_charges:'Add charges',sign_visit:'Sign the encounter',post_charges:'Post charges',self_pay_collect:'Self-pay: collect payment',prepare_claim:'Preparing claim',claim_cancelled:'Claim cancelled',fix_claim:'Claim needs details',send_claim:'Send claim',correct_claim:'Charges changed after the claim was sent',waiting_insurer:'Waiting on insurer',claimmd_correction:'Needs correcting',claimmd_received:'Received by the clearinghouse',post_response:'Insurer answered: review payment',denied:'Denied: fix and resend',review_response:'Review insurer answer',patient_owes:'Patient owes',review_balance:'Balance not on the statement',patient_credit:'Patient credit',paid_in_full:'Paid in full',insurance_outside:'Insurance billed outside SunCharts',claim_restricted:'Posted'};
function visitBillingStateName(state){return visitBillingStateNames[state]||'Billing status unavailable';}
// A claim row carries only its own status; name it with the same words the encounter card uses.
function visitBillingClaimState(claim){
 if(!claim)return '';
 if((claim.crossover_tracking_only||claim.crossover)&&claim.status==='submitted')return 'Secondary insurer answered';
 if(['submitted','accepted'].includes(claim.status)&&claim.claimmd_position?.needs_correction===true)return visitBillingStateNames.claimmd_correction;
 if(claim.status==='submitted'&&claim.claimmd_position?.acknowledged===true)return visitBillingStateNames.claimmd_received;
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
// The card's own one-click send. It does the work the review panel's final button does today
// (see visitClaimDirectSend in web/visit-review.js, which loads before the click handlers run);
// the panel stays one small link away for anyone who wants to look at the claim first.
// It is offered only on the card of the encounter the screen is actually on, where the send can read
// the live account: a card drawn from a copy elsewhere keeps opening the claim instead.
function visitBillingDirectSend(s,ctx){
 if(s.state!=='send_claim'||!s.claim?.id||s.claim.status!=='ready')return '';
 if(!visitBillingDirectFlow(s,ctx,s.claim))return '';
 return `<button type="button" class="primary" data-visit-claim-direct-send="${esc(s.claim.id)}">Send claim to ${esc(visitBillingInsurer(s))}</button><button type="button" class="text-button" data-visit-review-open="account">Review claim</button>`;
}
// The one main button for a claim that has reached the point of sending. The review panel
// beside the charge table holds the checks, the form and the send itself; until it is loaded
// the card's own buttons do the same jobs.
function reviewButton(s,ctx){return typeof visitBillingReviewButton==='function'?visitBillingReviewButton(s,ctx):'';}
// The charges step fills an encounter's table in from the patient's last visit on its own. When that
// is on the way the card stops telling staff to type charges by hand; with nothing to fill in
// from it says what it always said. encounterChargesProposed is the charge table's own answer.
function visitBillingChargesFilled(){return typeof encounterChargesProposed==='function'&&encounterChargesProposed();}
// The status line: what is happening, who is waiting on whom, and the one next step.
function visitBillingStatus(s,ctx={}){
 const insurer=visitBillingInsurer(s),owes=money(s.patient.owes_now_cents),paid=money(s.insurance.paid_cents),account=s.account?.id||'',claim=s.claim?.id||'',write=ctx.canWrite,create=ctx.canCreate;
 const button=(label,attribute)=>`<button type="button" class="primary" ${attribute}>${esc(label)}</button>`;
 switch(s.state){
   case 'add_charges':return visitBillingChargesFilled()?{headline:'Check the charges',detail:'Filled in from the last visit.',action:create?button('Check the charges','data-encounter-charges'):''}:{headline:'Add charges',detail:'Add the procedures done at this encounter.',action:create?button('Add charges','data-encounter-charges'):''};
   case 'sign_visit':return {headline:'Charges can still be changed',detail:'The encounter note must be signed before the charges are posted.',action:reviewButton(s,ctx)||button('Continue the encounter note','data-revenue-documentation')};
   case 'post_charges':{
    // Something the claim cannot go without is asked for first, with the button that opens the codes.
    const need=visitBillingBeforePosting(s);
    if(need&&write)return {headline:need.headline,detail:`${need.detail} The claim to ${insurer} cannot be sent without it.`,action:button(need.label,'data-encounter-charges')};
    return {headline:'Post charges',detail:`Check the charges, then post them. ${s.insurance.insured?`The claim to ${insurer} is prepared for you next.`:'The patient is billed next.'}`,action:button(write?'Post charges':'Review charges',`data-visit-post-charges="${esc(account)}"`)};
   }
   case 'self_pay_collect':return {headline:'Self-pay: collect payment',detail:`Patient owes ${owes}. Waiting for the patient.`,action:create?button('Collect payment','data-visit-collect'):''};
  case 'prepare_claim':return ctx.prepareError?{headline:`The claim to ${insurer} could not be prepared`,detail:ctx.prepareError,action:create?button('Try again','data-visit-claim-prepare'):''}:create?{headline:`Preparing the claim to ${insurer}`,detail:'The claim is filled in from this encounter. Nothing is sent until you send it.',action:ctx.preparing?'':button('Prepare claim','data-visit-claim-prepare')}:{headline:'Posted',detail:`Billing staff prepare the claim to ${insurer}.`,action:''};
   case 'claim_cancelled':return {headline:`The claim to ${insurer} was cancelled`,detail:'Nothing is with the insurer.',action:create?button('Prepare a new claim','data-visit-claim-prepare="again"'):''};
   case 'fix_claim':return {headline:`Claim to ${insurer} needs details`,detail:'Nothing has been sent yet. Fill in what is missing right on the claim below.',issues:s.claim?.issues||[],action:write?button('Fix claim details',`data-visit-claim-fix="${esc(claim)}"`):''};
    case 'send_claim':return {headline:`Claim ready to send to ${insurer}`,detail:'Nothing has been sent yet.',action:visitBillingDirectSend(s,ctx)||reviewButton(s,ctx)||(write?button('Review and send claim',`data-visit-claim-send="${esc(claim)}"`):'')};
    case 'correct_claim':return {headline:'Charges changed after the claim was sent',detail:`Send a corrected claim to ${insurer}.`,action:button('Open claim',`data-revenue-claim="${esc(claim)}"`)};
   case 'claimmd_correction':return {headline:'The clearinghouse found a problem with this claim',detail:`${s.claimmd?.message?`The clearinghouse says: “${s.claimmd.message}” `:''}Nothing has reached ${insurer} yet. Fix it in Edit charges (for example, add the modifier it asks for) and resend, or if nothing needs to change, approve the claim in your clearinghouse account.`,action:button('Open claim',`data-revenue-claim="${esc(claim)}"`)};
   case 'claimmd_received':return {headline:'Received by the clearinghouse',detail:`${insurer} has not answered yet. If the clearinghouse is holding it for approval, approve it in your clearinghouse account (in Claim.MD: Manage Claims → Pending Approval).`,action:button('Check claim status',`data-revenue-claim="${esc(claim)}"`)};
   case 'waiting_insurer':return {headline:`Waiting on ${insurer}`,detail:`${s.insurance.sent_on?`Claim sent ${visitBillingDate(s.insurance.sent_on)}. `:''}Nothing to do until they answer.`,action:button('Check claim status',`data-revenue-claim="${esc(claim)}"`)};
   case 'post_response':return {headline:`${insurer} answered`,detail:'Review their payment and post it to this encounter.',action:button('Review insurer payment',`data-revenue-remittance="${esc(s.claim?.response_to_review||'')}"`)};
   case 'denied':return {headline:`Denied by ${insurer}`,detail:'Fix the claim and send it again.',action:button('Fix and resend claim',`data-revenue-claim="${esc(claim)}"`)};
   case 'review_response':return {headline:`Insurance paid ${paid}`,detail:`${money(s.insurance.unassigned_cents)} is not paid, written off or assigned to the patient yet. Review the insurer’s answer.`,action:button('Review insurer answer',`data-revenue-claim="${esc(claim)}"`)};
   case 'review_balance':return {headline:`${money(s.insurance.unassigned_cents)} is not on the patient’s statement`,detail:'The latest statement is paid, but the encounter still has a balance. Write the rest off or adjust it; a new statement then shows what is left.',action:create?button('Write off or adjust','data-new-ledger'):''};
   case 'patient_owes':return {headline:`Patient owes ${owes}`,detail:`Insurance paid ${paid}. Waiting for the patient.`,action:create?button('Collect payment','data-visit-collect'):''};
  case 'patient_credit':return {headline:`Patient has a ${money(s.patient.credit_cents)} credit`,detail:'Nothing more is owed for this encounter. Refund the credit or keep it for another visit.',action:button('Review payments','data-visit-history="payments"')};
  case 'paid_in_full':return {headline:'Paid in full',detail:'Nothing is owed for this encounter.',action:''};
  case 'insurance_outside':return {headline:`${insurer} is billed outside SunCharts`,detail:'This insurer has no payer ID here, so no claim is sent from SunCharts. Record their payment when it arrives.',action:create?button('Record insurer payment','data-new-ledger'):''};
   case 'claim_restricted':return {headline:'Posted',detail:`Billing staff handle the claim to ${insurer}.`,action:''};
  default:return {headline:'Billing status unavailable',detail:'Refresh before relying on these amounts.',action:''};
 }
}
// The one place an encounter says it can go straight from posting to a sent claim. The right to write
// and to see claims, insurance that can be billed electronically, and the card of the encounter the
// screen is actually on: on the post_charges state a draft in hand, on the send_claim state the
// claim the server has already filled in and checked.
function visitBillingDirectFlow(s,ctx,claim){
 if(!ctx.canWrite||ctx.claimsAllowed===false||ctx.noDirectSend)return false;
 if(!s.insurance?.insured||!s.insurance.electronic||!s.account)return false;
 if(typeof visitBillingCardCurrent==='function'&&!visitBillingCardCurrent(s))return false;
 if(claim&&(claim.secondary||claim.crossover||['submitted','accepted','adjudicated','void'].includes(claim.status)))return false;
 return true;
}
// Whether the draft in hand can go straight from posting to a sent claim. Whether the claim lands
// ready or needs details is the server's answer after the post: a claim that lands in fix_claim
// stops there and shows its issues. A self-pay visit keeps "Post charges".
function directFlowPostSend(s,ctx){
 // Only an encounter with no claim yet: one already prepared, released or sent has its own next step,
 // and the one press has nothing to prepare there.
 if(s.state!=='post_charges'||s.claim?.id)return false;
 return visitBillingDirectFlow(s,ctx,s.claim);
}
// The one next step a charge table hands to the person working in it, in the card's own words.
// The card above (visitBillingStatus) and the footer under the charge table are asked the same
// question, so both are answered from this one line and can never drift apart. A state that is
// not about charges at all has no next step here, and is given nothing to press.
// What the server found missing before the charges post, in the words staff use. One item at a time:
// the first is the one to fix.
function visitBillingBeforePosting(s){
 const item=(s?.before_posting||[])[0];if(!item)return null;
 if(item.code==='diagnoses')return {headline:'Add a diagnosis',detail:'This encounter has no diagnosis yet.',label:'Add a diagnosis',note:'Add a diagnosis before you post: the claim cannot be sent without one.'};
 if(item.code==='line_diagnoses'){const n=Number(item.lines)||0;return {headline:'Link a diagnosis to every charge',detail:n===1?'One charge has no diagnosis linked.':`${n} charges have no diagnosis linked.`,label:'Open the codes',note:n===1?'One charge has no diagnosis linked: the claim cannot be sent until it has one.':`${n} charges have no diagnosis linked: the claim cannot be sent until they do.`};}
 return null;
}
function visitBillingChargeStep(s,ctx={}){
 if(!s)return null;
 const write=ctx.canWrite===true;
 switch(s.state){
   case 'sign_visit':return {text:'Sign the encounter note to send these charges.',label:'Open the encounter note',attribute:'data-revenue-documentation'};
   case 'post_charges':{
    const flow=write&&directFlowPostSend(s,ctx),need=write?visitBillingBeforePosting(s):null;
    return {text:need?need.note:write?flow?'Check the charges, then post them — the claim is sent as soon as it is ready.':'Check the charges, then post them.':'Check the charges; someone who can change them posts them.',label:flow?'Post charges and send claim':write?'Post charges':'Review charges',attribute:flow?`data-visit-review-open="account" data-post-and-send="account"`:`data-visit-post-charges="${esc(s.account?.id||'')}"`};
   }
    case 'send_claim':case 'fix_claim':{
     // The card's own one-click send is the button here too, with the same small review link
     // beside it; where the card answers with the review panel instead, so does this line.
     const status=visitBillingStatus(s,ctx),direct=visitBillingDirectSend(s,ctx);
     if(direct)return {text:status.detail,label:`Send claim to ${visitBillingInsurer(s)}`,attribute:`data-visit-claim-direct-send="${esc(s.claim.id)}"`,reviewMarkup:`<button type="button" class="text-button" data-visit-review-open="account">Review claim</button>`};
     const card=typeof reviewButton==='function'?reviewButton(s,ctx):'';
     if(card)return {text:status.detail,label:'Review and send claim',attribute:'data-visit-review-open="account"',review:true};
     if(!write||!s.claim?.id)return null;
     return {text:status.detail,label:'Review and send claim',attribute:`data-visit-claim-send="${esc(s.claim.id)}"`};
    }
    case 'correct_claim':{
     const status=visitBillingStatus(s,ctx);
     if(!s.claim?.id)return null;
     return {text:status.detail,label:'Open claim',attribute:`data-revenue-claim="${esc(s.claim.id)}"`};
    }
    default:return null;
 }
}
// The one line under the charge table: the same next step the card above gives, or nothing at all.
function visitBillingChargeStepMarkup(s,ctx={}){
 const step=visitBillingChargeStep(s,ctx);if(!step)return '';
 return `<p class="charge-table-next"><span>${esc(step.text)}</span> <button type="button" class="primary" ${step.attribute}>${esc(step.label)}</button>${step.reviewMarkup?` ${step.reviewMarkup}`:''}</p>`;
}
// Parts of one payment (card, cash, check) share a payment_group_id and read as one transaction.
function visitBillingReceiptEntries(receipts){
 const entries=[],groups=new Map();
 for(const r of receipts||[]){
  if(!r.payment_group_id){entries.push({receipt:r});continue;}
  let entry=groups.get(r.payment_group_id);
  if(!entry){entry={group:r.payment_group_id,appointment:r.appointment_id,total:0,parts:[]};groups.set(r.payment_group_id,entry);entries.push(entry);}
  entry.total+=Number(r.amount_cents||0)-Number(r.refunded_cents||0);entry.parts.push(r);
 }
 for(const entry of entries){
  if(!entry.group)continue;
  const byMethod=new Map();
  for(const r of entry.parts){const key=r.method==='card'?'card':r.method||'other';byMethod.set(key,(byMethod.get(key)||0)+Number(r.amount_cents||0)-Number(r.refunded_cents||0));}
  entry.tenders=[...byMethod].map(([key,cents])=>[visitBillingMethod(key)||key,cents]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([label,cents])=>`${label} ${money(cents)}`).join(', ');
 }
 return entries;
}
function visitBillingReceiptNote(receipt){const how=visitBillingMethod(receipt.method),when=visitBillingDate(receipt.occurred_on);return [how,when].filter(Boolean).join(', ');}
// What the claim is missing, grouped by where it is fixed. Each group is its own short line
// with one button that opens the right place; everything else stays with the claim editor.
const visitBillingMissingGroups=[
 {key:'practice',label:'Practice billing setup',action:'Open practice billing setup',attribute:'data-billing-organizations',
  fields:['billing_provider_name','billing_address','billing_npi','tax_id','billing_organization_name','billing_organization_tax_id','billing_organization_address','npi','provider_npi','rendering_npi','provider_directory'],
  keywords:/\bbilling provider\b|\bbilling organization\b|tax id|\bbilling address\b|\bbilling npi\b|provider npi|\bnpi\b/i},
 {key:'patient',label:'Patient',action:'Edit patient details',attribute:'data-chart-section="profile"',
  fields:['patient_address','patient_birth_date','patient_name','patient_date_of_birth','patient'],
  keywords:/patient address|patient (date of birth|birth date|dob)|patient name/i},
 {key:'insurance',label:'Insurance',action:'Edit insurance',attribute:'data-chart-section="insurance"',
  fields:['subscriber_address','subscriber_birth_date','subscriber_name','subscriber','policy_holder_address','policy_holder_birth_date','member_id','payer_name','payer_code','insurer_name','insurer','insurance'],
  keywords:/policy holder|subscriber|member id|insurer|payer/i},
];
function visitBillingMissingGroupsFor(issues){
 const buckets=Object.fromEntries(visitBillingMissingGroups.map(group=>[group.key,[]]));buckets.claim=[];
 const seen=new Set();
 for(const issue of issues){
  const text=String(issue?.missing??issue?.detail??'').trim();if(!text)continue;
  const key=text.toLocaleLowerCase();if(seen.has(key))continue;seen.add(key);
  const code=String(issue?.code??'').trim().toLocaleLowerCase();
  const group=visitBillingMissingGroups.find(candidate=>code&&candidate.fields.includes(code))
   ||visitBillingMissingGroups.find(candidate=>candidate.keywords.test(text))
   ||{key:'claim'};
  buckets[group.key].push(text);
 }
 return buckets;
}
// Lines in order: practice, patient, insurance, then the claim. The claim line lists its items as
// text only; the card's main action button is the one "Fix claim details", never a second one here.
function visitBillingMissingMarkup(issues,claimId,ctx){
 // The claim page's own plain wording, one short line per place, with no buttons that leave the
 // visit: the card's one Fix claim details opens the boxes right here.
 if(typeof claimMissingGroupsFor==='function'&&typeof claimMissingGroups!=='undefined'){
  const listed=claimMissingGroupsFor(issues||[]);
  const rows=claimMissingGroups.map(group=>listed[group.key]?.words?.length?`<li data-missing-group="${group.key}"><b>${esc(group.label)}</b> ${listed[group.key].words.map(esc).join(' · ')}</li>`:'').join('');
  return rows?`<ul class="visit-billing-missing-list">${rows}</ul>`:'';
 }
 const buckets=visitBillingMissingGroupsFor(issues||[]);
 const line=(group,items,button)=>items.length?`<p class="visit-billing-missing" data-missing-group="${group.key}"><b>${esc(group.label)}:</b> ${items.map(esc).join(', ')}${button?' '+button:''}</p>`:'';
 return visitBillingMissingGroups.map(group=>line(group,buckets[group.key],`<button type="button" ${group.attribute}>${esc(group.action)}</button>`)).join('')+line({key:'claim',label:'Claim'},buckets.claim,'');
}
// One small table: charges, the insurer's side, the patient's side, and what the patient owes now.
function visitBillingBreakdown(s,ctx={}){
 const i=s.insurance,p=s.patient,posted=s.account?.status==='posted',row=(label,note,amount,cls='')=>`<tr class="${cls}"><th scope="row">${label}</th><td>${note||''}</td><td class="money-cell">${amount}</td></tr>`,group=label=>`<tr class="visit-billing-group"><th scope="rowgroup" colspan="3">${label}</th></tr>`;
 const receipts=(s.receipts||[]).filter(r=>!r.voided),collect=ctx.canCreate&&s.visit?'<button type="button" class="text-button" data-visit-collect>Collect</button>':'';
 let rows=row('Charges',s.charges_cents==null?'':posted?'Posted':'Charges can still be changed',s.charges_cents==null?'Not added yet':money(s.charges_cents));
 if(i.insured){
  rows+=group(`Insurance: ${esc(i.insurer||'insurer on file')}`);
  const status={not_billed:'Billed after the charges are posted',not_sent:'Not sent yet',waiting:`Waiting${i.sent_on?` since ${esc(visitBillingDate(i.sent_on))}`:''}`,denied:'Denied',answered:s.claim?.answer?.payment_date?`Answered ${esc(visitBillingDate(s.claim.answer.payment_date))}`:'Answered',outside:'Billed outside SunCharts',restricted:'Handled by billing staff'}[i.status]||'';
  rows+=row('Insurance paid',status,posted?money(i.paid_cents):'');
  if(i.adjusted_cents)rows+=row('Insurance adjustments',i.adjusted_cents>0?'Written off, not owed by anyone':'Added back to the balance',money(Math.abs(i.adjusted_cents)));
  if(i.pending_cents>0)rows+=row('Insurance pending',i.status==='denied'?'Denied. Fix and resend the claim':i.status==='not_sent'?'Not the patient’s to pay unless the insurer says so':'Waiting on the insurer’s answer',money(i.pending_cents));
  if(i.unassigned_cents>0)rows+=row('Not assigned yet','Review the insurer’s answer',money(i.unassigned_cents));
 }else if(posted&&i.unassigned_cents>0)rows+=row('Not on the statement','Write it off, adjust it or send a new statement',money(i.unassigned_cents));
 if(!i.insured&&posted&&i.adjusted_cents)rows+=row('Adjustments',i.adjusted_cents>0?'Taken off the charges':'Added to the charges',money(Math.abs(i.adjusted_cents)));
 rows+=group(i.insured?'Patient':'Patient (self-pay)');
 const copay=p.copay_cents,links=visitBillingReceiptEntries(receipts).map(entry=>entry.group?`<button type="button" class="text-button" data-payment-group="${esc(entry.group)}" data-appointment="${esc(entry.appointment)}">Receipt: Payment ${money(entry.total)} · ${esc(entry.tenders)}</button>`:`<button type="button" class="text-button" data-copay-receipt="${esc(entry.receipt.id)}" data-appointment="${esc(entry.receipt.appointment_id)}">Receipt: ${money(entry.receipt.amount_cents)}${visitBillingReceiptNote(entry.receipt)?' '+esc(visitBillingReceiptNote(entry.receipt)):''}</button>`).join(' ');
 if(copay!=null){
  const fromCheck=p.copay_from_insurer_check,due=p.copay_due_cents,paidTowards=p.copay_paid_cents;
  const note=fromCheck?`from the insurer check on ${esc(visitBillingDate(p.copay_source_date))}`:due===0?'Paid':paidTowards>0?`${money(paidTowards)} paid, ${money(due)} still due ${collect}`:`Not paid yet ${collect}`;
  rows+=row(`Copay ${money(copay)}`,note,paidTowards>0?money(paidTowards):'');
 }else if(i.insured)rows+=row('Copay','No copay recorded for this plan','');
 if(p.other_patient_payments_cents)rows+=row(copay!=null?'Other patient payments':'Patient payments','',money(p.other_patient_payments_cents));
 // One line for what the patient paid; each payment and its receipt are in the Payments list.
 const paidEntries=visitBillingReceiptEntries(receipts),paidTotal=paidEntries.reduce((sum,entry)=>sum+(entry.group?entry.total:Number(entry.receipt.amount_cents||0)-Number(entry.receipt.refunded_cents||0)),0);
 if(paidEntries.length)rows+=`<tr class="visit-billing-receipts"><th scope="row">Patient paid</th><td>${paidEntries.length===1?'1 payment':paidEntries.length+' payments'} · ${links.split('</button>')[0]?'<button type="button" class="text-button" data-invoice-tab-key="payments">See payments</button>':''}</td><td class="money-cell">${money(paidTotal)}</td></tr>`;
 if(p.adjustment_cents)rows+=row('Patient adjustments',p.adjustment_cents>0?'Taken off what the patient owes':'Added to what the patient owes',money(Math.abs(p.adjustment_cents)));
 if(p.unapplied_cents>0)rows+=row('Paid but not applied yet',posted&&s.balance_cents>0&&ctx.canWrite?'<button type="button" class="text-button" data-apply-copays>Apply to this encounter</button>':'Credit on the patient’s account',money(p.unapplied_cents));
 if(p.overpaid_cents>0)rows+=row('Paid more than owed','Refund it or keep it as a credit',money(p.overpaid_cents));
 const basis=p.copay_from_insurer_check?`Based on the insurer check on ${esc(visitBillingDate(p.copay_source_date))}`:({self_pay:'No insurance on this encounter',plan_copay:'The plan copay, until the insurer answers',reviewed_statement:'What the latest statement says, less what they paid',copay_not_recorded:posted?'Nothing until the insurer answers':'',insurer_response:'What the insurer says the patient owes, less what they paid',not_final:'Set when the charges are posted'}[p.responsibility_source]||'');
 const standing=visitBillingDue(s);
 if(standing.copayOnly)rows+=row('Copay due now','The rest is set when the charges are posted',money(standing.due),'visit-billing-total');
 else rows+=row('Patient owes now',standing.paidUp?standing.note:basis,money(p.owes_now_cents),'visit-billing-total');
 return `<table class="visit-billing-breakdown"><caption class="sr-only">Money for this encounter</caption><tbody>${rows}</tbody></table>${p.receipt_needs_review?'<p role="status">A payment for this encounter needs review. Open History before collecting again.</p>':''}`;
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
 return `<details class="visit-billing-more" data-revenue-disclosure="more"><summary>More actions</summary><div class="actions">${items.join('')}</div></details>`;
}
// The money in one line, for the Billing areas where the full table would push the work down the
// page. The table itself stays on Payments.
// What can be collected on this encounter right now, and whether the patient has paid all of it.
// Before the charges are posted only the plan copay can be due.
function visitBillingDue(s){
 const p=s?.patient||{},posted=s?.account?.status==='posted',owes=Number(p.owes_now_cents)||0,copay=posted?0:Number(p.copay_due_cents)||0;
 const paid=(s?.receipts||[]).filter(r=>!r.voided).reduce((sum,r)=>sum+Number(r.amount_cents||0)-Number(r.refunded_cents||0),0);
 const due=owes>0?owes:copay;
 // 'Paid in full' is only said once the charges are final.
 // While the insurer has not answered, more may still fall to the patient, so it is 'nothing due now'.
 const waiting=Number(s?.insurance?.pending_cents)>0;
 return {due,copayOnly:owes<=0&&copay>0,paid,paidUp:posted&&due===0&&paid>0,label:waiting?'Nothing due now':'Paid in full',note:waiting?'Paid. Nothing more is due unless the insurer says so':'Paid in full'};
}
function visitBillingTotalsLine(s){
 if(s.charges_cents==null)return '';
 const i=s.insurance||{},p=s.patient||{},item=(label,value,tone='')=>`<span${tone?` class="${tone}"`:''}><small>${label}</small><b>${value}</b></span>`;
 return `<p class="visit-billing-totals">${item('Charges',money(s.charges_cents))}${i.insured?item(i.paid_cents>0?'Insurance paid':'Insurance pending',money(i.paid_cents>0?i.paid_cents:i.pending_cents||0)):''}${p.overpaid_cents>0?item('Patient credit',money(p.overpaid_cents)):''}${(d=>d.copayOnly?item('Copay due now',money(d.due),'is-due'):d.paidUp?item('Patient paid',money(d.paid)+' · '+d.label,'is-clear'):item('Patient owes now',money(p.owes_now_cents||0),p.owes_now_cents>0?'is-due':'is-clear'))(visitBillingDue(s))}</p>`;
}
function visitBillingCardMarkup(s,ctx={}){
   const status=visitBillingStatus(s,ctx),owing=['patient_owes','self_pay_collect'].includes(s.state),posted=s.account?.status==='posted';
   const issues=visitBillingMissingMarkup(status.issues,s.claim?.id||'',ctx);
   const secondary=owing&&ctx.canCreate?'<button type="button" data-visit-statement>Patient statement</button>':'';
   const sent=typeof visitBillingSentLine==='function'?visitBillingSentLine(s,ctx):'';
   const direct=s.state==='send_claim'?visitBillingDirectSend(s,ctx):'';
   const main=status.action;
   const review='<button type="button" class="text-button" data-visit-review-open="account">Review claim</button>';
   // The one-click send keeps its small review link beside it; a card left opening the review
   // panel says it once, as its single main button.
   const action=direct&&!main.includes(direct)?`${main}${review}`:main;
      return `<section class="visit-billing-card" data-visit-billing-state="${esc(s.state)}"><div class="visit-billing-status"><div><span class="eyebrow">${s.waiting_on==='nobody'?'Status':'Next step'}</span><p class="visit-billing-headline">${esc(status.headline)}</p><p class="muted">${esc(status.detail)}</p>${issues}</div><div class="actions">${action||''}${secondary}</div></div>${sent}${visitBillingTotalsLine(s)}${visitBillingBreakdown(s,ctx)}${posted||s.account||s.visit?visitBillingMore(s,ctx):''}</section>`;
}
const visitBillingFilters=[['all','Everything'],['charges','Charges'],['insurance','Insurance'],['payments','Payments'],['statements','Statements']];
function visitBillingEventText(event){
 const amount=event.amount_cents==null?'':money(event.amount_cents),insurer=event.insurer||'the insurer',how=visitBillingMethod(event.method),by=how?` (${how})`:'';
 switch(event.code){
  case 'charges_added':return `Charges added: ${amount}`;
  case 'charges_changed':return 'Charges changed';
   case 'charges_posted':return `Charges posted: ${amount}. Charges are posted`;
  case 'charges_removed':return 'Charges removed';
  case 'payment_received':return `Payment taken: ${amount}${by}`;
  case 'receipt_voided':return `Receipt cancelled: ${amount}${by}`;
  case 'receipt_applied':return `${amount} of a payment applied to this encounter`;
  case 'patient_payment':return `Patient payment: ${amount}${by}`;
  case 'other_payment':return `Other payment: ${amount}${by}`;
  case 'adjustment_credit':return `Adjustment: ${amount} taken off`;
  case 'adjustment_debit':return `Adjustment: ${amount} added`;
  case 'card_refund':return `Card refund: ${amount}`;
  case 'reversal':return `Entry undone: ${amount}`;
  case 'insurer_payment':return `Insurance paid ${amount}`;
  case 'insurer_adjustment':return `Insurance adjustment: ${amount} written off`;
  case 'claim_prepared_auto':return `Claim to ${insurer} prepared from this encounter`;
  case 'claim_prepared':return `${event.frequency==='replacement'?'Corrected claim':event.frequency==='void_request'?'Request to void the claim':event.secondary?'Secondary claim':'Claim'} to ${insurer} prepared`;
  case 'claim_crossover':return `${insurer} answered a claim forwarded by the primary insurer`;
  case 'claim_changed':return 'Claim details changed';
  case 'claim_ready':return 'Claim checked and ready to send';
  case 'claim_sent':return `Claim sent to ${insurer}`;
  case 'claim_accepted':return `${insurer} accepted the claim for processing`;
  case 'claim_rejected':return `${insurer} rejected the claim`;
  case 'claim_answered':return `${insurer} answered${event.patient_responsibility_cents==null?'':`: patient owes ${money(event.patient_responsibility_cents)}`}`;
  case 'claim_cancelled':return 'Claim cancelled';
  case 'statement':return `Statement given: ${amount} due`;
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
 return `<div class="actions visit-billing-filters" role="group" aria-label="Show">${visitBillingFilters.map(([key,label])=>`<button type="button" data-visit-history-filter="${key}" aria-pressed="${key===filter}">${label}</button>`).join('')}</div>${events.length?`<ol class="visit-billing-timeline">${events.map(event=>`<li data-group="${esc(event.group)}"><time>${esc(visitBillingDate(event.at))}</time><span>${esc(visitBillingEventText(event))}${event.test&&typeof testPaymentTag==='function'&&testPaymentTag()?' · '+esc(testPaymentTag()):''}</span>${visitBillingEventActions(event,ctx)}</li>`).join('')}</ol>`:`<p class="muted">${filter==='statements'?'No statement has been prepared for this encounter.':'Nothing here yet.'}</p>`}`;
}
// Identifiers and versions are for the practice owner only; the server leaves them out for everyone else.
function visitBillingTechnical(s){
 const t=s.technical;if(!t)return '';
 const pair=(label,value)=>value==null||value===''?'':`<dt>${label}</dt><dd>${esc(value)}</dd>`;
 return `<dl class="billing-dl">${pair('Charge account',t.account_id)}${pair('Charge account version',t.account_version)}${pair('Imported record',t.source_history_id)}${pair('Member ID',t.member_id)}${pair('Coverage check',t.coverage_verification?human(t.coverage_verification):'')}${pair('Payer ID',t.payer_code)}${(t.claims||[]).map(c=>pair('Claim',`${c.control_number} · version ${c.version} · ${human(c.status)}${c.payer_control_number?' · insurer number '+c.payer_control_number:''}`)).join('')}</dl>`;
}
function visitBillingPrepareMessage(error){
 const text=String(error?.message||'');
 if(/forbidden|not allowed|permission/i.test(text))return 'Your sign-in cannot prepare claims. Ask billing staff to open this encounter.';
 return text?`${text}. Try again, or open Insurance and eligibility to check the coverage.`:'Try again in a moment.';
}
// A blank message addressed to the patient; staff attach the saved PDF. No amount or
// visit detail is put in the link.
function visitBillingStatementMailto(invoice){
 const email=typeof workspace!=='undefined'?workspace?.demographics?.content?.email:'';
 if(!invoice||!email||!/^[^\s@<>,;:?&]+@[^\s@<>,;:?&]+$/.test(email))return '';
 return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Your statement')}`;
}
