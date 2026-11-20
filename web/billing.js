// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let billingPayerSources=[],billingPayers=[],billingSelected,billingQueueStatus='',billingQueueCursor;
const billingWrite=()=>['owner','clinician','front_desk'].includes(me.role);
const billingCan=(action='edit')=>billingWrite()&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('billing',action));
const money=c=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(c/100);
const dollars=c=>c==null?'':`${Math.trunc(c/100)}.${String(c%100).padStart(2,'0')}`;
function cents(value,optional=false){if(optional&&value==='')return null;if(!/^\d+(\.\d{1,2})?$/.test(value))throw new Error('Enter USD amounts with at most two decimal places.');const [whole,fraction='']=value.split('.');const n=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(n)||n>1000000000)throw new Error('Amount exceeds the supported range.');return n;}
const billingBase=()=>`/api/v1/patients/${selected}/billing/accounts`;
const payerName=id=>billingPayers.find(p=>p.id===id)?.content.name||'Unavailable payer';
const entrySum=id=>workspace.billing.entries.filter(e=>e.account_id===id).reduce((n,e)=>n+e.effect_cents,0);
const billBalance=b=>b.status==='posted'?b.total_cents+entrySum(b.id):null;
const billingChargeDrafts=new Map();let billingChargeDraftIdentity;let billingChargeBaselines=new WeakMap();
function clearBillingChargeDrafts(){billingChargeDrafts.clear();billingChargeBaselines=new WeakMap();billingChargeDraftIdentity=me;}
// The form the draft routines last worked on; $('billing-account-form') is not wired in every
// host, and a save finishing after a re-render must still find the form it was saving.
let billingChargeDraftForm=null;
function billingChargeDraftSession(){if(billingChargeDraftIdentity!==me)clearBillingChargeDrafts();}
// One editor host is shared by the charge form and non-charge forms (copay receipt, ledger entry,
// statement). A non-charge render replaces the charge form, detaching it; a detached charge form
// holds no live input, so its retained draft must stay exactly as it was until it is opened again.
function chargeFormLive(){const form=$('billing-account-form');if(!form)return false;const host=billingEditorHost();return !host||typeof host.contains!=='function'||host.contains(form);}
function billingChargeKey(account,source,visit){return selected+':'+(account?'account:'+account:source?'source:'+source:'visit:'+(visit||'unlinked'));}
function billingChargeMarkup(form){
 if(!form?.cloneNode)return null;
 const copy=form.cloneNode(true),fields=form.querySelectorAll('input,textarea,select'),targets=copy.querySelectorAll('input,textarea,select');
 fields.forEach((field,index)=>{const target=targets[index];if(field.tagName==='SELECT'){Array.from(target.options).forEach((option,i)=>option.toggleAttribute('selected',field.options[i].selected));}else if(field.tagName==='TEXTAREA')target.textContent=field.value;else{target.setAttribute('value',field.value);if(['checkbox','radio'].includes(field.type))target.toggleAttribute('checked',field.checked);}});
 if(typeof clearTerminologyComboboxMarkup==='function')clearTerminologyComboboxMarkup(copy);
 copy.querySelectorAll('[data-charge-diagnoses]').forEach(node=>node.replaceChildren());
 copy.querySelectorAll('[data-charge-draft-notice]').forEach(node=>node.remove());copy.querySelectorAll('button[disabled]').forEach(button=>button.removeAttribute('disabled'));copy.removeAttribute('data-draft-stale');
 return copy.outerHTML;
}
function captureBillingChargeDraft(){
 billingChargeDraftSession();const form=$('billing-account-form')||billingChargeDraftForm;if(!form||form.dataset?.patient!==selected||form.dataset.draftReadOnly)return;
 // The editor host is shared with non-charge forms (copay receipts, ledger entries, statements).
 // Once one is on top, the charge form is detached; a detached form is not live input and must
 // never be captured. Its draft stays exactly as it was until the charge editor is opened again.
 if(!chargeFormLive())return;
 const baseline=billingChargeBaselines.get(form),html=billingChargeMarkup(form);if(!baseline||html===null)return;
 // A live table is compared on its charge lines; a retained editor copy on its own markup.
 const current=chargeTableHost(form)?chargeTableSignature({lines:chargeLiveRows(form).map(chargeRowValue)}):html;
 const key=form.dataset.draftKey;if(current===baseline)billingChargeDrafts.delete(key);else billingChargeDrafts.set(key,{key,patient:selected,account:form.dataset.id||null,visit:form.elements.visit_id?.value||null,version:Number(form.dataset.version),html,baseline});
}
function billingChargeHasDrafts(){billingChargeDraftSession();return billingChargeDrafts.size>0;}
function billingChargeDraftFor(account,source,visit){billingChargeDraftSession();return billingChargeDrafts.get(billingChargeKey(account,source,visit))||(account&&visit?billingChargeDrafts.get(billingChargeKey(null,null,visit)):null);}
function restoreBillingChargeDraft(account,source,visit){
 const draft=billingChargeDraftFor(account?.id,source,visit);if(!draft)return false;
 openBillingEditor(draft.html);const form=$('billing-account-form');if(!form)return false;billingChargeBaselines.set(form,draft.baseline);
 const replaced=!!account&&draft.account!==account.id,readOnly=!!account&&(account.status!=='draft'||replaced),stale=!!account&&Number(form.dataset.version)!==account.version;
 if(readOnly){form.dataset.draftReadOnly='true';form.querySelectorAll('input,textarea').forEach(field=>field.readOnly=true);form.querySelectorAll('select,button,input[type="checkbox"],input[type="radio"]').forEach(field=>field.disabled=true);}
 else if(stale){form.dataset.draftStale='true';form.querySelector('button[type="submit"]').disabled=true;}
 if(form.querySelector?.('#billing-charge-lines'))form.dataset.autosave='off';
 form.insertAdjacentHTML('afterbegin',`<section data-charge-draft-notice role="status"><p>${readOnly?'These retained edits are not part of the current saved account. Review or copy them; this account cannot accept this draft.':stale?'Saved charges changed since you started. Review the current charges above before keeping your edits.':'Unsaved charge edits have been restored in this tab.'}</p>${stale&&!readOnly?'<button type="button" data-rebase-charge-draft>Keep my edits after reviewing saved charges</button>':''}<button type="button" data-discard-charge-draft="${esc(draft.key)}">Discard retained charge edits</button></section>`);
 return true;
}
function resumeEncounterChargeDraft(){
 if(typeof activeVisit==='undefined'||!activeVisit||chartSection!=='visits')return;
 const host=$('encounter-billing-editor');if(!host||host.innerHTML.trim())return;
 // A charge editor still attached to another host was never replaced; its form is live and its
 // draft belongs to that editor. Resuming here would render a second copy of the same form.
 const form=$('billing-account-form');if(chargeFormLive())return;
 const account=(workspace.billing?.accounts||[]).find(a=>a.status!=='void'&&a.content.visit_id===activeVisit.id);
 if(billingChargeDraftFor(account?.id,null,activeVisit.id))restoreBillingChargeDraft(account,null,activeVisit.id);
}
function billingChargeDraftRecovery(account){return billingChargeDraftFor(account.id,null,account.content.visit_id)?`<p class="mapping-notice">Unsaved charge edits are retained in this tab. <button type="button" data-review-charge-draft="${esc(account.id)}">Review retained edits</button></p>`:'';}
function billingChargeSaved(form,saved,submitted){
 billingChargeDraftForm=form;
 billingChargeDrafts.delete(form.dataset.draftKey);
 form.dataset.id=saved.id;form.dataset.version=String(saved.version);form.dataset.draftKey=billingChargeKey(saved.id,null,null);
 // A table that saves itself is compared on its charge lines, which the save itself moves; a
 // reviewed reconciliation compares on the exact markup that was sent.
 if(!chargeTableHost(form))billingChargeBaselines.set(form,submitted);
 // Anything typed while the save was in flight is still an unsaved edit.
 captureBillingChargeDraft();
}
 // One edit to the charge table refreshes the amount remembered for the line, its totals and
// what still needs fixing, then leaves the save running on its own a short while after the
// typing stops, so nothing depends on anyone remembering to press a button.
function chargeTableEdited(form,target){
 if(!chargeTableHost(form)||form.dataset.autosave==='off')return false;
 if(target?.name==='amount'){const row=target.closest?.('.billing-charge-row');if(row)chargeRowCapture(row);}
 chargeTableTotals(form);renderChargeRowProblems(form);
 captureBillingChargeDraft();
 scheduleChargeAutosave(form);
 return true;
}
document.addEventListener('input',event=>{const form=event.target.closest?.('#billing-account-form');if(!form)return;if(chargeTableEdited(form,event.target))return;captureBillingChargeDraft();});
document.addEventListener('change',event=>{const form=event.target.closest?.('#billing-account-form');if(!form)return;if(chargeTableEdited(form,event.target))return;captureBillingChargeDraft();});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.reviewChargeDraft){event.preventDefault();run(async()=>{const account=workspace.billing.accounts.find(a=>a.id===button.dataset.reviewChargeDraft);if(account)accountEditor(account,null,chartSection==='visits');});return;}
 if(button.hasAttribute('data-rebase-charge-draft')){event.preventDefault();const form=$('billing-account-form'),account=workspace.billing.accounts.find(a=>a.id===form?.dataset.id);if(!form||form.dataset.patient!==selected||!account||account.status!=='draft')return;form.dataset.version=String(account.version);delete form.dataset.draftStale;form.querySelectorAll('[data-charge-draft-notice]').forEach(node=>node.remove());form.querySelector('button[type="submit"]').disabled=false;captureBillingChargeDraft();notice('Your edits are ready to save against the reviewed charges. Save when ready.');return;}
 if(button.dataset.discardChargeDraft){event.preventDefault();run(async()=>{const key=button.dataset.discardChargeDraft,patient=selected,identity=me,draft=billingChargeDrafts.get(key);if(!draft||draft.patient!==patient||!await confirmAction('The retained charge edits will be removed. Saved charges will remain unchanged.',{title:'Discard charge edits?',confirmLabel:'Discard edits',tone:'danger'}))return;if(selected!==patient||me!==identity)return;billingChargeDrafts.delete(key);const form=$('billing-account-form');if(form?.dataset.draftKey===key)form.remove();notice('Retained charge edits discarded. Saved charges are unchanged.');});}
});
const patientClaimAccounts=(billing=workspace.billing)=>billing.accounts.filter(a=>a.status==='posted'&&String(a.coverage_snapshot?.payer?.content?.payer_code||'').trim()).sort((a,b)=>String(b.content.service_date).localeCompare(String(a.content.service_date)));
const patientPaymentAccounts=(billing=workspace.billing)=>billing.accounts.filter(a=>a.status==='posted'&&billBalance(a)>=50).sort((a,b)=>String(b.content.service_date).localeCompare(String(a.content.service_date)));
const ledgerKind=k=>({payment:'Payment recorded',adjustment_credit:'Credit adjustment',adjustment_debit:'Debit adjustment',reversal:'Reversal'})[k]||k;
const billingField=(name,label,value='',type='text',max=200,required=false)=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${type==='text'?`maxlength="${max}"`:''} ${required?'required':''}></label>`;
function sourceNotice(m){return m?`<div class="mapping-notice"><b>Source reconciliation</b><p>${esc(m.policy)}</p><details><summary>Review original source fields</summary><pre class="billing-source">${esc(JSON.stringify(m.source_data,null,2))}</pre></details></div>`:'';}
// One button per thing staff can do to a draft account, so no option has to be picked
// before the button makes sense. Posting needs the encounter note signed first.
function encounterRevenueVisitUnsigned(a){
 // Outside an encounter the note's signing state is not shown here, so posting stays available.
 if(typeof activeVisit==='undefined'||!activeVisit||(a?.content?.visit_id&&a.content.visit_id!==activeVisit.id))return false;
 return activeVisit.status!=='signed';
}
function billingAccountActionForm(a,missingElectronicPayer,reasonLabel,helper,postLabel,voidLabel,localOnlyLabel){
 if(!billingCan()||a.status!=='draft')return '';
 const unsigned=encounterRevenueVisitUnsigned(a);
 return `<form id="billing-account-action" data-account="${esc(a.id)}" data-version="${a.version}"><h3>Review and post charges</h3><div class="form-grid">${billingField('reason',reasonLabel,'','text',1000,true)}</div>${missingElectronicPayer?`<div class="mapping-notice"><b>Claim.MD payer ID needed for electronic claims</b><p>Edit this coverage's payer mapping and add the correct Claim.MD payer ID before posting.</p><label class="review-ack"><input type="checkbox" name="local_only" value="true"> ${esc(localOnlyLabel)}</label></div>`:''}<p class="muted">${esc(helper)}</p><div class="actions"><button type="submit" class="primary" name="action" value="post"${unsigned?' disabled':''}>${esc(postLabel)}</button><button type="submit" name="action" value="void">${esc(voidLabel)}</button></div></form>`;
}
function billingEditorHost(){return (typeof chartSection!=='undefined'&&chartSection==='insurance'&&$('insurance-editor'))||(typeof chartSection!=='undefined'&&chartSection==='visits'&&$('encounter-billing-editor'))||$('billing-editor');}
function billingDetailHost(){return (typeof chartSection!=='undefined'&&chartSection==='visits'&&$('encounter-billing-detail'))||$('billing-detail');}
// True while the encounter's Billing tab opens its charge table by itself: nothing scrolls or takes focus.
let billingEditorQuiet=false;
function openBillingEditor(html){const host=billingEditorHost();if(!host)return;captureBillingChargeDraft();for(const id of ['billing-editor','insurance-editor','encounter-billing-editor'])if($(id)&&$(id)!==host)$(id).replaceChildren();host.innerHTML=html;if(billingEditorQuiet)return;host.scrollIntoView({block:'start'});const heading=host.querySelector('h2,h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
function renderBilling(){
 if(!workspace.billing)return;
 const b=workspace.billing,panel=document.createElement('section');panel.id='billing-workspace';panel.className='panel';
 if(typeof preparePatientBillingChart==='function'){preparePatientBillingChart(panel);$('chart').insertBefore(panel,$('appointments-panel'));return;}
 panel.innerHTML=`<div class="section-head"><h2>Account summary</h2><span class="pill">USD · Across visits</span></div><p class="muted">Review this patient's visit charges and balances. Open an encounter below to work on its copay, invoice or insurance claim.</p>
 <p class="muted">Coverage, eligibility and recorded copays are in <button type="button" class="text-button" data-chart-section="insurance">Insurance</button>. Choose the encounter charges below to review its invoice or claim.</p>
 <section class="billing-section"><div class="section-head"><h3>Visit charges</h3></div><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Service date / account</th><th>Status</th><th class="money-cell">Charges</th><th class="money-cell">Open balance</th><th></th></tr></thead><tbody>${b.accounts.map(a=>`<tr><td>${esc(displayDate(a.content.service_date))}<small>${a.id.slice(0,8)}${a.source_history_id?' · Reconciled source':''}</small></td><td><span class="pill">${esc(displayStatus(a.status))}</span></td><td class="money-cell">${money(a.total_cents)}</td><td class="money-cell">${a.status==='posted'?money(billBalance(a)):'—'}</td><td><button type="button" data-bill-open="${a.id}">${a.content.visit_id?'Open encounter':'Review source account'}</button></td></tr>`).join('')||'<tr><td colspan="5" class="table-empty">No native billing accounts. Create one from an encounter or reconcile a source billing record.</td></tr>'}</tbody></table></div></section><div id="billing-detail"></div><div id="billing-editor"></div>`;
 $('chart').insertBefore(panel,$('appointments-panel'));if(billingSelected&&b.accounts.some(a=>a.id===billingSelected))showBillingAccount(billingSelected,false);
}
async function openEncounterBillingAccount(id){
 const identity=me,patient=selected,account=(workspace.billing?.accounts||[]).find(a=>a.id===id);
 if(!account)throw new Error('This account is unavailable in the selected patient chart.');
 const visit=workspace.visits.find(v=>v.id===account.content.visit_id);
 if(visit){
  if(activeVisit?.id!==visit.id)await selectPatient(patient,visit.id);
  if(me!==identity||selected!==patient||activeVisit?.id!==visit.id)return;
  setEncounterSection('charges');billingSelected=id;showBillingAccount(id,false,true);
 }else showBillingAccount(id);
}
async function beginPatientClaim(){
 const accounts=patientClaimAccounts();
 if(!accounts.length)throw new Error('Post an insured charge account with a Claim.MD payer ID before creating a claim.');
 if(accounts.length===1){await beginClaim(accounts[0].id);return;}
 openBillingEditor(`<section><div class="section-head"><div><h3>Choose charges for this claim</h3><p class="muted">Select the posted insured account for the service being billed. Nothing is sent until the claim is reviewed, marked ready and explicitly submitted through Claim.MD.</p></div></div>${accounts.map(a=>`<button type="button" data-new-claim="${a.id}">${esc(a.content.service_date)} · ${money(a.total_cents)} · ${esc(a.coverage_snapshot.payer.content.name)}</button>`).join('')}</section>`);
}
function beginPatientPayment(){
 const accounts=patientPaymentAccounts();
 showChartSection('billing');
 if(!accounts.length&&typeof openCopayReceiptEditor==='function'){openCopayReceiptEditor();return;}
 if(!accounts.length){notice('Open Insurance to record a received copay for this appointment.',true);return;}
 if(accounts.length===1){showBillingAccount(accounts[0].id,false);$('account-payment-panel')?.scrollIntoView({block:'start'});return;}
 openBillingEditor(`<section><div class="section-head"><div><h3>Choose the patient account</h3><p class="muted">Select the posted service account that should receive this copay or patient payment. Stripe checkout is created only after you review the account balance and amount.</p></div></div>${accounts.map(a=>`<button type="button" data-bill-open="${a.id}">${esc(a.content.service_date)} · ${money(billBalance(a))} open balance</button>`).join('')}</section>`);
}
// A pasted "G81.14 - Spastic hemiplegia, left side" keeps only the code; claims need bare ICD-10 codes.
function diagnosisCodeList(parts){
 const looksLikeCode=/^[A-Za-z][0-9][0-9A-Za-z](\.[0-9A-Za-z]{1,4})?$/,out=[];
 for(const part of parts){
  const text=typeof part==='string'?part.trim():'';if(!text)continue;
  const first=text.split(/\s/)[0];
  if(looksLikeCode.test(first)){if(!out.includes(first.toUpperCase()))out.push(first.toUpperCase());}
  else if(!/\s/.test(text)&&!out.includes(text))out.push(text);
 }
 return out;
}
function chargeTable(lines){return `<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Code / description</th><th>Modifiers / diagnoses</th><th class="money-cell">Units</th><th class="money-cell">Line total</th></tr></thead><tbody>${lines.map(l=>`<tr><td><b>${esc(l.code_system)} ${esc(l.code)}</b><small>${esc(l.description)}</small>${typeof terminologySnapshotMarkup==='function'?terminologySnapshotMarkup(l.catalog_snapshot):''}</td><td>${esc(l.modifiers||'—')}<small>${l.diagnosis_codes.map(esc).join(', ')||'No diagnosis pointers'}</small></td><td class="money-cell">${l.units}</td><td class="money-cell">${money(l.amount_cents)}</td></tr>`).join('')}</tbody></table></div>`;}
// The same charges, payments and adjustments inside the encounter's billing card: charges under
// Charges, the ledger table under History. Wording is for clinic staff; identifiers are left out.
function showEncounterBillingAccount(a,entries,frozen,missingElectronicPayer,frozenElectronicPayer){
 const host=$('encounter-billing-detail');for(const id of ['billing-detail'])if($(id))$(id).replaceChildren();
 const state=a.status==='posted'?'Posted · can still be corrected':a.status==='void'?'Charges were removed':'Charges can still be changed';
 host.innerHTML=`<section class="billing-account-detail"><div class="section-head"><div><h3>Line items</h3><p class="muted">${esc(visitBillingDate(a.content.service_date))} · ${state}</p></div></div>
 <p>${frozen?`Insurance: <b>${esc(frozen.payer.content.name)}</b>`:a.content.coverage_id?'Insurance is chosen. It is fixed when the charges are posted.':'Self-pay. No insurance on this encounter.'}</p>${chargeTable(a.content.lines)}${billingChargeDraftRecovery(a)}${accountDiagnosisSummary(a.diagnosis_snapshot)}${accountDiagnosisDraftRecovery(a)}<p class="note-text">${esc(a.content.notes)}</p>
 <div class="actions">${billingCan()&&a.status==='draft'?'<button type="button" data-edit-bill>Edit draft</button>'+(a.content.visit_id?'<button type="button" data-link-account-diagnoses>Link visit diagnoses</button>':''):''}</div>${a.status==='posted'&&frozen&&!frozenElectronicPayer?'<div class="mapping-notice"><b>This insurer is billed outside SunCharts</b><p>The insurer had no payer ID when the charges were posted, so no electronic claim can be made for this encounter.</p></div>':''}
 ${billingAccountActionForm(a,missingElectronicPayer,'Reason (saved in the history)','Posting makes the charges final'+(a.content.coverage_id?' and prepares the insurance claim for you to review':'')+'. The encounter note must be signed first.','Post charges','Remove these charges','Post without an electronic claim. I understand this encounter cannot be billed to the insurer from SunCharts.')}</section>`;
 const ledger=$('visit-billing-ledger');if(!ledger)return;
 ledger.innerHTML=`<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>What was recorded</th><th>Reference / reason</th><th class="money-cell">Change to balance</th><th></th></tr></thead><tbody>${billingEncounterReceiptRows(a)}${entries.map(e=>`<tr><td>${esc(ledgerKind(e.kind))}<small>${esc(visitBillingDate(e.content.occurred_on))} · ${esc(e.content.party==='insurer'?'insurance':e.content.party)}</small></td><td>${esc(e.content.reference||'No reference')}<small>${esc(e.content.reason)}</small>${e.content.remittance_id?'<small>From the insurer’s payment. Change it from the claim.</small>':''}${e.content.managed_payment_id?'<small>Card payment. Refund it from the card payment below.</small>':''}${e.content.hosted_copay_operation_id?'<small>'+(e.content.test_mode?'Test card':'Card')+' payment taken for this encounter</small>':''}${e.reverses_id?'<small>Undoes an earlier entry</small>':''}</td><td class="money-cell">${money(e.effect_cents)}</td><td>${billingCan()&&!e.content.remittance_id&&!e.content.managed_payment_id&&!e.content.hosted_copay_operation_id&&e.kind!=='reversal'&&!entries.some(r=>r.reverses_id===e.id)?`<button type="button" data-reverse-entry="${e.id}">Reverse</button>`:''}</td></tr>`).join('')||(billingEncounterReceiptRows(a)?'':'<tr><td colspan="4">No payments or adjustments yet.</td></tr>')}</tbody></table></div>${billingCan('create')&&a.status==='posted'?`<div class="actions">${typeof $==='function'&&$('visit-billing-collect')?'<button type="button" class="primary" data-visit-collect>Take payment</button>':''}<button type="button" data-new-ledger>Write-off or adjustment</button></div>`:''}`;
 
}
// Money the patient paid at the desk for this encounter (cash, check, card on the reader, card on
// file, payment link) is listed with the other payments, so one list shows everything paid.
function billingEncounterReceiptRows(a){
 const visit=(workspace.visits||[]).find(v=>v.id===a?.content?.visit_id);if(!visit)return '';
 const receipts=(workspace.billing?.copays||[]).filter(r=>r.appointment_id===visit.appointment_id&&!r.voided);
 const how=r=>r.hosted_checkout?'Card':r.method==='check'?'Check':r.method==='cash'?'Cash':'Payment';
 const net=r=>r.amount_cents-Number(r.hosted_checkout?.refunded_cents||0);
 // One payment, however many ways it was paid, is one row and one receipt. How it was paid is
 // a short tag; the amounts per method show on hover and on the receipt.
 const groups=[],seen=new Map();
 for(const r of receipts){const key=r.payment_group_id||r.id;if(!seen.has(key)){seen.set(key,[]);groups.push(seen.get(key));}seen.get(key).push(r);}
 return groups.map(parts=>{const first=parts[0],total=parts.reduce((sum,r)=>sum+net(r),0),refunded=parts.reduce((sum,r)=>sum+Number(r.hosted_checkout?.refunded_cents||0),0);
  const methods=[...new Set(parts.map(how))],tag=methods.join(' + '),breakdown=parts.map(r=>`${how(r)} ${money(net(r))}${r.method==='check'&&r.reference?' (check #'+r.reference+')':''}`).join(', ');
  const test=parts.some(r=>r.hosted_checkout?.livemode===false)?'<small>Test payment</small>':'';
  const button=parts.length>1&&first.payment_group_id?`<button type="button" data-payment-group="${esc(first.payment_group_id)}" data-appointment="${esc(first.appointment_id)}">Receipt</button>`:`<button type="button" data-copay-receipt="${esc(first.id)}" data-appointment="${esc(first.appointment_id)}">Receipt</button>`;
  return `<tr class="payment-row"><td>Payment<small>${esc(visitBillingDate(first.occurred_on))}</small></td><td><span class="payment-tag" title="${esc(breakdown)}">${esc(tag)}</span>${test}${refunded?`<small>${money(refunded)} refunded</small>`:''}</td><td class="money-cell">−${money(total)}</td><td>${button}</td></tr>`;}).join('');
}
function showBillingAccount(id,activate=true,reveal=false){
 if(activate)showChartSection('billing');billingSelected=id;const a=workspace.billing.accounts.find(v=>v.id===id),entries=workspace.billing.entries.filter(e=>e.account_id===id),frozen=a.coverage_snapshot,coverage=workspace.billing.coverages.find(c=>c.id===a.content.coverage_id),payer=billingPayers.find(p=>p.id===coverage?.content.payer_id),missingElectronicPayer=!!a.content.coverage_id&&!String(payer?.content.payer_code||'').trim(),frozenElectronicPayer=String(frozen?.payer?.content?.payer_code||'').trim();
 const encounter=typeof chartSection!=='undefined'&&chartSection==='visits';
 if(encounter&&reveal&&$('encounter-charge-details'))$('encounter-charge-details').open=true;
 if(encounter&&$('encounter-billing-detail')&&typeof visitBillingDate==='function'){showEncounterBillingAccount(a,entries,frozen,missingElectronicPayer,frozenElectronicPayer);return;}
 const host=billingDetailHost();if(!host)return;for(const id of ['billing-detail','encounter-billing-detail'])if($(id)&&$(id)!==host)$(id).replaceChildren();host.innerHTML=`<section class="billing-account-detail"><div class="section-head"><div><h3>Invoice · ${esc(typeof displayDate==="function"?displayDate(a.content.service_date):a.content.service_date)}</h3><p class="muted">${a.source_history_id?'Brought over from the previous system':'Visit charges'}</p></div><span class="status-badge ${a.status==='posted'?'checked_in':'completed'}">${esc(a.status)}</span></div>
 ${!encounter?`<div class="billing-totals"><span>Charges <b>${money(a.total_cents)}</b></span><span>Payments and adjustments <b>${money(entrySum(a.id))}</b></span><span>Balance <b>${a.status==='posted'?money(billBalance(a)):'Not posted'}</b></span></div>`:''}
 <p>${frozen?`Payer on file: <b>${esc(frozen.payer.content.name)}</b> · Member ${esc(frozen.coverage.content.member_id)} · ${esc(frozen.coverage.content.verification)}`:a.content.coverage_id?'Insurance selected; coverage is captured when posted.':'Self-pay. No insurance selected.'}</p>${chargeTable(a.content.lines)}${billingChargeDraftRecovery(a)}${accountDiagnosisSummary(a.diagnosis_snapshot)}${accountDiagnosisDraftRecovery(a)}<p class="note-text">${esc(a.content.notes)}</p>
 <div class="actions">${billingCan()&&a.status==='draft'?'<button type="button" data-edit-bill>Edit draft</button>':''}${!encounter&&billingCan()&&a.status==='posted'&&frozenElectronicPayer?`<button type="button" class="primary" data-new-claim="${a.id}">Create insurance claim</button>`:''}<button type="button" data-bill-history>History</button></div>${a.status==='posted'&&frozen&&!frozenElectronicPayer?'<div class="mapping-notice"><b>Local-only insurance account</b><p>This frozen payer mapping has no Claim.MD payer ID, so it cannot create an electronic claim.</p></div>':''}<div id="bill-history"></div>
 ${billingAccountActionForm(a,missingElectronicPayer,'Review / action reason','Posting locks the charges. The encounter note must be signed first.','Post charges','Void draft','Post as local-only insurance activity. I understand this account cannot create an electronic claim.')}
 ${a.status==='posted'?`<section class="billing-section"><div class="actions">${!encounter&&billingCan('create')?'<button type="button" data-build-patient-invoice>Send the patient a statement</button>':''}${!encounter?'<button type="button" data-patient-invoices>Statements sent</button>':''}${billingCan()&&typeof availableCopayCreditForAccount==='function'&&availableCopayCreditForAccount(a)>0?'<button type="button" data-apply-copays>Apply recorded copay credit</button>':''}</div></section>`:''}${encounter?'<details class="encounter-account-record"><summary>Payments, adjustments &amp; processor history</summary>':''}<h3>Payments and adjustments</h3><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Recorded activity</th><th>Evidence / reason</th><th class="money-cell">Balance effect</th><th></th></tr></thead><tbody>${entries.map(e=>`<tr><td>${esc(ledgerKind(e.kind))}<small>${esc(e.content.occurred_on)} · ${esc(e.content.party)}</small></td><td>${esc(e.content.reference||'No reference')}<small>${esc(e.content.reason)}</small>${e.content.remittance_id?'<small>ERA posting · review in Claims & remittances</small>':''}${e.content.managed_payment_id?'<small>Verified test processor payment · reconcile or refund in Payments</small>':''}${e.content.hosted_copay_operation_id?'<small>Verified '+(e.content.test_mode?'test ':'')+'card copay · review hosted payment status in Insurance</small>':''}${e.reverses_id?`<small>Reverses ${esc(e.reverses_id.slice(0,8))}</small>`:''}</td><td class="money-cell">${money(e.effect_cents)}</td><td>${billingCan()&&!e.content.remittance_id&&!e.content.managed_payment_id&&!e.content.hosted_copay_operation_id&&e.kind!=='reversal'&&!entries.some(r=>r.reverses_id===e.id)?`<button type="button" data-reverse-entry="${e.id}">Reverse</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4">No recorded payments or adjustments.</td></tr>'}</tbody></table></div>
 ${billingCan('create')&&a.status==='posted'?'<div class="actions"><button type="button" data-new-ledger>Record a payment or adjustment</button></div>':''}${encounter?'</details>':''}</section>`;
 
}
// The insurance screen's payer directory, offered to the picker by the name it registers under.
function typeaheadPayerChoices(){return billingPayers;}
function insuranceOptionLabels(values){return values.map(value=>({primary:'Primary',secondary:'Secondary',tertiary:'Tertiary',active:'Active',inactive:'Inactive',entered_in_error:'Entered by mistake',self:'Self',spouse:'Spouse',child:'Child',other:'Other',unverified:'Not yet',manually_verified:'Yes, checked by hand'})[value]??human(value));}
// Insurance companies to choose from, and the picker markup that replaces the old dropdown.
// Typing narrows the list straight away; the hidden field carries the id the form submits.
// Registered when the insurance screen opens rather than at load: the screens stay in the order
// index.html lists them, and a screen whose own script is not present is simply not on the page.
function payerPickerMarkup(name,label,opts={}){
 typeaheadProvide('typeaheadPayerChoices',typeaheadPayerChoices);
 const id=opts.id||`${name}-name`,choice=String(opts.payerId||'');
 const payer=(typeof billingPayers==='undefined'?[]:billingPayers).find(p=>p.id===choice);
 return `<label>${esc(label)}<input type="text" id="${id}" name="${name}_name" value="${esc(payer?.content.name||opts.value||'')}" maxlength="200" ${opts.required===false?'':'required '}autocomplete="off" spellcheck="false" placeholder="Start typing a name" data-typeahead-payer>${typeaheadMarkup(name,id,choice)}</label>`;
}
// Keeps the name box and the submitted id in step when the choice is made elsewhere on screen.
// Keeps the name box and the submitted id in step when the choice is made elsewhere on screen —
// the Claim.MD directory, or a payer added from this very form.
function coveragePayerSelected(payer){
 const coverage=$('coverage-form');
 if(!typeaheadFill('payer',payer.id,payer.content.name)){
  const select=coverage?.elements?.payer_id;
  if(select)select.innerHTML=coveragePayerOptions(payer.id);
 }
 enableCoverageSubmit(coverage);
}
function coveragePayerOptions(selectedId=''){return `<option value="">Choose the insurance company</option>${billingPayers.map(p=>`<option value="${p.id}" ${selectedId===p.id?'selected':''}>${esc(p.content.name)}${p.content.payer_code?` · ${esc(p.content.payer_code)}`:''}${p.content.active?'':' (inactive)'}</option>`).join('')}`;}
// When the patient is their own policy holder, the policy holder fields mirror the chart.
function patientSelfPolicyHolder(form){
 const elements=form?.elements;if(!elements||elements.relationship?.value!=='self')return;
 if(elements.subscriber_name?.value)return;
 const patient=typeof workspace!=='undefined'&&workspace?.patient||{};
 const name=[patient.given_name,patient.family_name].filter(Boolean).join(' ');
 if(!name)return;
 elements.subscriber_name.value=name;
 if(elements.subscriber_birth_date&&!elements.subscriber_birth_date.value&&/^\d{4}-\d{2}-\d{2}$/.test(patient.birth_date||''))elements.subscriber_birth_date.value=patient.birth_date;
}
function billingEffectiveCoverages(serviceDate){
 const rank={primary:0,secondary:1,tertiary:2};
 return (workspace.billing?.coverages||[]).filter(c=>c.content.status==='active'&&c.content.effective_date<=serviceDate&&(!c.content.end_date||c.content.end_date>=serviceDate)).sort((a,b)=>(rank[a.content.priority]??3)-(rank[b.content.priority]??3));
}
// The shortened visit form keeps one insurance line per plan and drops the long claims note.
function billingCoverageOrderMarkup(serviceDate,selectedId,compact=false){
 const coverages=billingEffectiveCoverages(serviceDate);
  return `<section class="mapping-notice"><h4>Insurance on ${esc(serviceDate?displayDate(serviceDate):'the service date')}</h4>${coverages.length?`<ol>${coverages.map(c=>`<li><b>${esc(human(c.content.priority))}: ${esc(payerName(c.content.payer_id))}</b> · ${esc(c.content.member_id)}${c.id===selectedId?' · Selected for this account':''}</li>`).join('')}</ol>${compact?'':'<p>Record each service once. Primary and secondary claims use the same visit charges; do not add another charge line or account for the second payer. Review the primary response and crossover status before preparing secondary billing.</p>'}`:'<p>No insurance on file for this encounter date.</p>'}<button type="button" data-chart-section="insurance">Review all insurance & eligibility</button></section>`;
}
function chargeDiagnosisCurrent(form,state){return !!form&&$('billing-account-form')===form&&form.dataset.patient===selected&&state.identity===me&&state.patient===selected&&state.visit===form.elements.visit_id?.value&&form.chargeDiagnosisState===state;}
function renderChargeEncounterDiagnoses(form){
 if(!form)return;const state=form.chargeDiagnosisState,disabled=!!(form.dataset.draftReadOnly||form.dataset.draftStale);
 for(const row of form.querySelectorAll('.billing-charge-row')){
  const host=row.querySelector('[data-charge-diagnoses]');if(!host)continue;
  if(!state||!chargeDiagnosisCurrent(form,state)){host.innerHTML='';continue;}
  if(state.loading){host.innerHTML='<p class="muted">Loading the diagnoses above…</p>';continue;}
  if(state.error){host.innerHTML='<p>The diagnoses above could not be loaded. Your chosen codes are unchanged.</p><button type="button" data-reload-charge-diagnoses>Try again</button>';continue;}
  // A brand-new line starts with the encounter's diagnoses selected, once. A line that already
  // has codes, or that staff have changed, is never filled in again.
  const field=row.querySelector('[name="diagnoses"]');
  // The one-time default is consumed here, whether or not anything arrives to fill it in, so a
  // line whose codes were cleared by hand is never quietly refilled on a later refresh.
  if(row.dataset?.diagnosesDefault==='pending'){
   row.dataset.diagnosesDefault='done';
   if(!disabled&&field&&!field.value.trim()&&state.diagnoses.length){
    const given=chargeDiagnosisDefaultCodes(state.diagnoses);
    field.value=given;markChargeDiagnosisAuto(row,given);
    if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
   }
  }
  if(!field)continue;
  host.innerHTML=chargeDiagnosisChargesMarkup(state.diagnoses,field.value,disabled);
 }
}
// The letters the encounter's diagnoses are known by on this screen: A for the one the encounter lists
// first, B for the next, and so on in the encounter's order. The same letters head the diagnoses above
// the charge lines and the chips on every line, so the two read as one form rather than a list and
// a set of boxes. Past Z the letters start again; a claim line carries four diagnoses at most.
function visitDiagnosisLetter(index){return String.fromCharCode(65+(index%26));}
function chargeDiagnosisLetters(diagnoses){return diagnoses.map((d,index)=>({letter:visitDiagnosisLetter(index),code:d.code,display:d.display}));}
function chargeDiagnosisLetterOf(code,lettered){return (lettered||[]).find(d=>d.code.toUpperCase()===String(code||'').trim().toUpperCase())?.letter||'';}
function chargeDiagnosisChosen(value){return String(value||'').split(',').map(code=>code.trim().toUpperCase()).filter(Boolean);}
// The small letter badge in front of a diagnosis row. The diagnoses above the table are drawn by the
// visit's own editor, in its own words; this is the only piece of its markup this screen adds, and
// it changes nothing about how a diagnosis is entered or saved.
function diagnosisLetterBadge(index){return Number.isInteger(index)&&index>=0?`<span class="charge-dx-letter">${visitDiagnosisLetter(index)}</span>`:'';}
// One compact chip per letter. Pressing a chip is how a line says which of the encounter's diagnoses it
// was for, and the letters stop where a claim line stops: a fifth is refused, in words.
function chargeDiagnosisChipsMarkup(lettered,codes,disabled){
 if(!lettered.length)return '<p class="muted">Nothing here yet. Add the diagnoses above and they appear on every line as soon as they save.</p>';
 const on=code=>codes.includes(code.toUpperCase());
 return `<div class="charge-dx-chips">${lettered.map(d=>`<button type="button" class="charge-dx-chip"${on(d.code)?' data-chip-on=""':''}${disabled?' disabled':''} data-charge-diagnosis="${esc(d.code)}" aria-pressed="${on(d.code)?'true':'false'}" title="${esc(d.code)} · ${esc(d.display)}"><span class="charge-dx-chip-letter">${esc(d.letter)}</span><span class="sr-only">${esc(d.code)} · ${esc(d.display)}</span></button>`).join('')}</div><p class="charge-dx-chip-codes" data-charge-diagnosis-codes>${codes.length?esc(codes.map(code=>{const letter=chargeDiagnosisLetterOf(code,lettered);return letter?`${letter} (${code})`:code;}).join(', ')):'Nothing chosen yet.'}</p>`;
}
// The box on the line that answers for its diagnoses: one word over the letters, so the column's
// heading and the row's narrow-screen label say the same thing.
function chargeDiagnosisChargesMarkup(diagnoses,value,disabled){
 return `<fieldset><legend>Diagnoses</legend>${chargeDiagnosisChipsMarkup(chargeDiagnosisLetters(diagnoses),chargeDiagnosisChosen(value),disabled)}</fieldset>`;
}
// How many diagnoses a charge line can carry on the claim it goes out on. A new line is pointed at
// the encounter's diagnoses in order, up to this many.
const chargeDiagnosisLineLimit=4;
// A line whose codes were filled in from the encounter by the last refresh, and nothing since. Only
// such a line is moved when the encounter's diagnoses change: a code typed by hand, a tick unticked,
// or anything saved is the person's own answer and is left alone.
function chargeDiagnosisAutoFilled(row){return (row.dataset.diagnosesAuto||row.getAttribute?.('data-diagnoses-auto')||'')===(row.querySelector('[name="diagnoses"]')?.value||'').trim();}
// The marker has to be read back after a re-render, and a re-render builds rows from markup: like
// the code and the amount, what a line was filled with is written into the row's own markup, so it
// is still there when the table is drawn again.
function markChargeDiagnosisAuto(row,values){row.dataset.diagnosesAuto=values;if(row.setAttribute)row.setAttribute('data-diagnoses-auto',values);}
// An empty line — no code, no codes yet — was answered by nobody, so the encounter may still fill it
// in: at the first refresh, after a save on either screen, or the moment it is added. A line that
// came in carrying codes is a different thing; those are an answer already given.
function chargeDiagnosisLineUnanswered(row){return !String(row.querySelector?.('[name="code"]')?.value||'').trim()&&String(row.querySelector?.('[name="diagnoses"]')?.value||'').trim()==='';}
function chargeDiagnosisDefaultCodes(diagnoses){return diagnoses.slice(0,chargeDiagnosisLineLimit).map(d=>d.code).join(', ');}
// The encounter's diagnoses were just saved — from the section above the table, or from the encounter's
// Diagnoses screen. Every line's choices follow at once, with nothing reloaded and nothing the
// person typed disturbed: a line still holding what the encounter last gave it is re-pointed at the
// visit as it now stands, and any other line keeps exactly what it holds.
function chargeDiagnosesVisitUpdated(visitId){
 const form=$('billing-account-form');if(!form||form.elements.visit_id?.value!==visitId)return;
 if(!form.chargeDiagnosisState||!chargeDiagnosisCurrent(form,form.chargeDiagnosisState))return;
 // The encounter's own record is what a line must be pointed at — not the copy this screen last
 // loaded. The diagnoses save happens somewhere else on the page, so the list here is re-read
 // from the server before any line moves; a line whose codes were filled in by the encounter is
 // re-pointed at the encounter as it now stands, and any other line keeps exactly what it holds.
 void refreshChargeEncounterDiagnoses(form);
}
async function refreshChargeEncounterDiagnoses(form){
 const state=form.chargeDiagnosisState;
 try{
  const data=await api(`/api/v1/visits/${encodeURIComponent(state.visit)}/diagnoses`);
  if(!chargeDiagnosisCurrent(form,state))return;
  state.diagnoses=Array.isArray(data.diagnoses)?data.diagnoses:[];state.version=data.version;state.error=false;
 }catch{state.error=true;renderChargeEncounterDiagnoses(form);return;}
 for(const row of chargeLiveRows(form)){
  const field=row.querySelector('[name="diagnoses"]');if(!field)continue;
  if(!chargeDiagnosisAutoFilled(row)&&!chargeDiagnosisLineUnanswered(row))continue;
  const next=chargeDiagnosisDefaultCodes(state.diagnoses);
  if(field.value===next)continue;
  field.value=next;markChargeDiagnosisAuto(row,next);
 }
 renderChargeEncounterDiagnoses(form);captureBillingChargeDraft();
}
function followVisitDiagnoses(){
 if(typeof visitDiagnosisListeners==='undefined'||typeof activeVisit==='undefined')return;
 if(visitDiagnosisListeners.has(chargeDiagnosesVisitUpdated))return;
 visitDiagnosisListeners.add(chargeDiagnosesVisitUpdated);
}
async function loadChargeEncounterDiagnoses(form){
 if(!form||form.dataset.patient!==selected)return;
 const state={patient:selected,identity:me,visit:form.elements.visit_id?.value,loading:true,diagnoses:[]};form.chargeDiagnosisState=state;renderChargeEncounterDiagnoses(form);
 if(!state.visit){state.loading=false;renderChargeEncounterDiagnoses(form);return;}
 try{const data=await api(`/api/v1/visits/${encodeURIComponent(state.visit)}/diagnoses`);if(!chargeDiagnosisCurrent(form,state))return;state.diagnoses=Array.isArray(data.diagnoses)?data.diagnoses:[];state.version=data.version;}
 catch{if(chargeDiagnosisCurrent(form,state))state.error=true;}
 finally{
  if(chargeDiagnosisCurrent(form,state)){
   state.loading=false;
   // A line that arrived with the encounter's codes on it, or with nothing at all, keeps following the
   // visit from here on. One that came from the previous system, or that staff have changed, does
   // not — its codes are an answer already given.
   if(!form.dataset.draftReadOnly&&!form.dataset.draftStale)for(const row of chargeLiveRows(form)){const field=row.querySelector('[name="diagnoses"]');if(field&&chargeDiagnosisAutoFilled(row))markChargeDiagnosisAuto(row,(field.value||'').trim());}
   followVisitDiagnoses();
   // An empty line still gets its first answer from the encounter here, not from a render pass that
   // may have already run while the list was loading.
   if(!form.dataset.draftReadOnly&&!form.dataset.draftStale)for(const row of chargeLiveRows(form)){
    const field=row.querySelector('[name="diagnoses"]');if(!field||!chargeDiagnosisLineUnanswered(row))continue;
    const next=chargeDiagnosisDefaultCodes(state.diagnoses);
    if(field.value===next)continue;
    field.value=next;markChargeDiagnosisAuto(row,next);
   }
   renderChargeEncounterDiagnoses(form);
  }
 }
}
document.addEventListener('change',event=>{
 const form=event.target.closest?.('#billing-account-form');if(!form||form.dataset.patient!==selected)return;
 if(event.target.name==='visit_id'){void loadChargeEncounterDiagnoses(form);return;}
 if(['service_date','coverage_id'].includes(event.target.name)){const host=form.querySelector('[data-charge-coverage-order]');if(host)host.innerHTML=billingCoverageOrderMarkup(form.elements.service_date.value,form.elements.coverage_id.value,form.dataset.compact==='true');}
 // The chips answer for the line; a code put in by hand, or by something filling the box in, is an
 // answer too, and the chips are brought back in step with it.
 else if(event.target.name==='diagnoses')renderChargeEncounterDiagnoses(form);
});
document.addEventListener('click',event=>{
 if(event.target.closest?.('[data-reload-charge-diagnoses]')){event.preventDefault();void loadChargeEncounterDiagnoses($('billing-account-form'));return;}
 // Only the chip itself answers: a click that lands on anything else is whatever else it was for.
 const chip=event.target.hasAttribute?.('data-charge-diagnosis')?event.target:null;if(!chip)return;
 const form=chip.closest?.('#billing-account-form');if(!form||form.dataset.patient!==selected)return;
 event.preventDefault();
 const row=chip.closest('.billing-charge-row'),field=row?.querySelector('[name="diagnoses"]');if(!field)return;
 const state=form.chargeDiagnosisState;
 if(!state||!chargeDiagnosisCurrent(form,state)||state.loading||state.error||form.dataset.draftReadOnly||form.dataset.draftStale)return;
 if(!state.diagnoses.some(d=>d.code===chip.dataset.chargeDiagnosis))return;
 chargeDiagnosisChipToggle(row,field,chip.dataset.chargeDiagnosis);
});
// Pressing a chip is the line's own answer from that moment on, so the line stops being re-pointed
// at the encounter's list. A fifth letter is refused with the claim rule that sets the limit, in words a
// front desk person can act on.
function chargeDiagnosisChipToggle(row,field,code){
 const codes=chargeDiagnosisChosen(field.value),upper=code.toUpperCase();
 if(codes.includes(upper))field.value=codes.filter(c=>c!==upper).join(', ');
 else if(codes.length>=chargeDiagnosisLineLimit){notice(`A line can point to ${chargeDiagnosisLineLimit} diagnoses.`);return;}
 else field.value=[...codes,upper].join(', ');
 markChargeDiagnosisAuto(row,'');
 const form=$('billing-account-form');
 renderChargeEncounterDiagnoses(form);renderChargeRowProblems(form);captureBillingChargeDraft();scheduleChargeAutosave(form);
}
function coveragePayerSetup(){
 const search=typeof claimmdCoveragePayerSearch==='function'?claimmdCoveragePayerSearch():'';
 if(billingPayers.length)return `${search}${me.role==='owner'?`<details class="amendment"><summary>Add a payer that is not listed</summary>${coveragePayerForm()}</details>`:''}`;
 if(me.role!=='owner')return '<div class="mapping-notice"><b>No native payers are available</b><p>A practice owner must add the payer before this coverage can be saved. The plan name alone cannot identify the payer used for eligibility and claims.</p></div>';
 return `${search}<div class="mapping-notice"><b>Add the payer first</b><p>Create the native payer here without losing the coverage details above. If the practice uses Claim.MD, enter its Claim.MD payer ID so eligibility and claim work can resolve the same payer.</p></div>${coveragePayerForm()}`;
}
function coveragePayerForm(){return `<form id="coverage-payer-form" data-request="${crypto.randomUUID()}"><h4>Add native payer</h4><div class="form-grid">${billingField('name','Payer name','','text',200,true)}${billingField('payer_code','Claim.MD payer ID','','text',100,true)}${billingField('phone','Contact phone (optional)','','text',50)}</div><label>Address (optional)<textarea name="address" maxlength="1000"></textarea></label><p class="muted">Required here because insured accounts freeze this mapping when they are posted. Use the payer ID returned by the Claim.MD payer directory; do not guess or reuse a plan name as an ID.</p><button type="submit">Add payer and use it</button></form>`;}
// Replace only the submit control: run() restores disabled states captured
// before payer creation, while the existing coverage fields must stay intact.
function enableCoverageSubmit(coverage){
 const submit=coverage.querySelector('button[type="submit"]'),ready=submit.cloneNode(true);
 ready.disabled=false;submit.replaceWith(ready);
}
// Coverage form values from an imported insurance record. Nothing is saved until staff
// confirm the form; the payer is pre-selected only when its name matches one on file.
function importedCoverage(i){
 const name=String(i.payer_name||'').trim().toLowerCase(),payer=name?billingPayers.filter(p=>String(p.content.name||'').trim().toLowerCase()===name):[],self=i.relationship==='self',patient=typeof workspace!=='undefined'&&workspace?.patient||{},date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?value:'';
 return {payer_id:payer.length===1?payer[0].id:'',priority:['primary','secondary','tertiary'].includes(i.priority)?i.priority:'primary',status:'active',member_id:i.member_id||'',group_number:i.group_number||'',plan_name:i.plan_name||'',subscriber_name:i.subscriber_name||(self?[patient.given_name,patient.family_name].filter(Boolean).join(' '):''),subscriber_birth_date:self?date(patient.birth_date):'',relationship:['self','spouse','child','other'].includes(i.relationship)?i.relationship:'other',effective_date:date(i.effective_date),end_date:date(i.end_date),verification:'unverified',notes:''};
}
function importedCoverageNotice(i,v){return `<div class="mapping-notice"><b>From previous system</b><p>Filled in from the insurance record in the previous system. Check each field, then save.</p>${i.payer_name&&!v.payer_id?`<p>Payer in the previous system: <b>${esc(i.payer_name)}</b>. Choose the matching payer.</p>`:''}</div>`;}
function coverageEditor(c,m){
 showChartSection('insurance');const raw=m?.source_data||{},imported=!c&&raw.coverage&&typeof raw.coverage==='object'?raw.coverage:null,v=c?.content||(imported?importedCoverage(imported):null)||{priority:['primary','secondary','tertiary'].includes(raw.type)?raw.type:'primary',status:'active',member_id:raw.policy_number||'',group_number:raw.group_number||'',plan_name:raw.plan_name||'',subscriber_name:[raw.subscriber_fname,raw.subscriber_mname,raw.subscriber_lname].filter(Boolean).join(' '),subscriber_birth_date:raw.subscriber_DOB&&/^\d{4}-\d{2}-\d{2}$/.test(raw.subscriber_DOB)?raw.subscriber_DOB:'',relationship:'other',effective_date:'',end_date:'',verification:'unverified',notes:''};
 const adding=!c,effective=v.effective_date||(adding&&!imported?`${new Date().getFullYear()}-01-01`:'');
 openBillingEditor(`<form id="coverage-form" data-id="${c?.id||''}" data-version="${c?.version||''}" data-request="${crypto.randomUUID()}" data-source="${m?.source_history_id||''}"><h3>${c?'Edit insurance':imported?'Add coverage from previous system':m?'Reconcile source coverage':'Add insurance'}</h3>${imported?importedCoverageNotice(imported,v):sourceNotice(m)}<div class="form-grid">${payerPickerMarkup('payer','Insurance company',{payerId:v.payer_id,id:'coverage-payer-name'})}${selectField('priority','Order',['primary','secondary','tertiary'],v.priority,insuranceOptionLabels(['primary','secondary','tertiary']))}${adding?'':selectField('status','Status',['active','inactive','entered_in_error'],v.status,insuranceOptionLabels(['active','inactive','entered_in_error']))}${billingField('member_id','Member ID',v.member_id,'text',150,true)}${billingField('group_number','Group number',v.group_number,'text',150)}${billingField('plan_name','Plan name',v.plan_name)}${billingField('subscriber_name','Policy holder name',v.subscriber_name,'text',200,true)}${billingField('subscriber_birth_date','Policy holder date of birth',v.subscriber_birth_date||'','date')}${selectField('relationship',"Patient is the policy holder's",['self','spouse','child','other'],v.relationship,insuranceOptionLabels(['self','spouse','child','other']))}${billingField('effective_date','Effective date',effective,'date',0,true)}${billingField('end_date','End date',v.end_date||'','date')}${billingField('copay','Copay (optional)',dollars(v.copay_cents))}${selectField('verification','Checked by staff',['unverified','manually_verified'],v.verification,insuranceOptionLabels(['unverified','manually_verified']))}</div><p class="muted">Two active plans cannot share the same order.</p><label>Notes<textarea name="notes" maxlength="2000">${esc(v.notes)}</textarea></label>${imported?'<input type="hidden" name="reason" value="Added from previous system insurance record">':billingField('reason','Reason / evidence for change','','text',1000,true)}${m&&!imported?'<label class="review-ack"><input type="checkbox" required> I verified source patient, payer, subscriber, dates and coordination priority.</label>':''}<div class="actions"><button class="primary" type="submit" ${billingPayers.length?'':'disabled'}>Save insurance</button><button type="button" data-cancel-billing>Cancel</button></div></form><div id="coverage-payer-setup">${coveragePayerSetup()}</div>`);
 const form=$('coverage-form');typeaheadInit(form);if(!c){patientSelfPolicyHolder(form);form?.addEventListener('change',e=>{if(e.target?.name==='relationship')patientSelfPolicyHolder(form);});}
}
function openInvalidChargeOptions(form){const box=form.querySelector?.('[data-visit-charge-options]');if(!box)return;const bad=Array.from(box.querySelectorAll('input,select,textarea')).some(f=>typeof f.checkValidity==='function'&&!f.checkValidity());if(bad)box.open=true;}
// Drug given on a charge line: an injected drug (a J-code such as botulinum
// toxin) can carry its NDC code, the amount given and its unit.
const ndcUnits=[['',''],['UN','units'],['ML','milliliters'],['GR','grams'],['F2','international units'],['ME','milligrams']];
function chargeDrugMarkup(l){const code=String(l.ndc_code||'').trim();return code?{ndc_code:code,ndc_quantity:String(l.ndc_quantity||'').trim(),ndc_unit:String(l.ndc_unit||'').trim()}:{};}
// A drug line is one whose code starts with J; its NDC fields open inside the row so staff
// are never sent hunting through a closed box for a field the line needs.
function chargeIsDrugCode(code){return /^J\d/i.test(String(code||'').trim().toUpperCase());}
function chargeCodeSystem(l){const code=String(l.code||'').trim().toUpperCase();return l.code_system||(code.startsWith('J')?'HCPCS':'CPT');}
function chargeMiniField(name,label,value='',max=200,required=false){return `<label>${label}<input name="${name}" type="text" value="${esc(value)}" ${max?`maxlength="${max}"`:''} ${required?'required':''}></label>`;}
// One box per line carries the procedure: the code and the description the line submits ride on
// the row beside it, so the code cell holds the box and the description column only has what the
// code list was chosen from. With no procedure screen loaded, one plain box goes in the code cell
// and its matching description field stays in the description column.
// With no procedure screen loaded, one plain box takes the procedure; its matching description
// field travels on the line unseen, exactly as a chosen code's does.
function chargeProcedureFallback(l){return `<label>Code<input name="code" type="text" value="${esc(l.code||'')}" maxlength="100" required></label><label class="charge-description-field">Description<input name="description" type="text" value="${esc(l.description||'')}" maxlength="10000" autocomplete="off" placeholder="What this service was"></label>`;}
function chargeCodeCell(l){
 const extra=chargeIsDrugCode(l.code)||l.ndc_code||l.ndc_quantity||l.ndc_unit?'':' hidden';
 return `${typeof terminologyProcedureFields==='function'?terminologyProcedureFields(l):chargeProcedureFallback(l)}<div class="charge-drug"${extra}><p class="charge-drug-title">Drug given</p><div class="charge-drug-grid"><label>NDC code<input name="ndc_code" type="text" maxlength="13" value="${esc(l.ndc_code||'')}" placeholder="11 digits"></label><label>Quantity<input name="ndc_quantity" type="text" maxlength="7" value="${esc(l.ndc_quantity||'')}" placeholder="Amount given"></label><label>Unit<select name="ndc_unit">${ndcUnits.map(([v,name])=>`<option value="${v}" ${v===(l.ndc_unit||'')?'selected':''}>${v?`${v} — ${name}`:''}</option>`).join('')}</select></label></div><p class="muted">For an injected drug fill all three; leave them blank for any other service.</p></div>`;
}
// What the code list the line came from, kept with the procedure box that chose it. The box the
// person reads is the procedure box alone; the code list record and the lookup sit with it.
function chargeDescriptionCell(l){
 const extra=typeof terminologyLookupButton==='function'?terminologyLookupButton('procedure'):'';
 const snapshot=typeof terminologySnapshotMarkup==='function'?terminologySnapshotMarkup(l.catalog_snapshot):'';
 return `<div class="charge-description-extra">${extra}${snapshot}</div>`;
}
// What the line submits for the service, out of sight: a chosen code leaves its words in the
// procedure box a person reads, so the description never needs a box — or a column — of its own.
function chargeHiddenField(name,value,max){return `<input type="hidden" name="${name}" value="${esc(value||'')}" maxlength="${max}">`;}
function chargeLineDescriptionCell(){return '';}
// What a line says the service was, in the words it was chosen with. A code taken from the code
// list leaves those words in the procedure box as well as the field the line submits; a code typed
// straight into the box is described by the box, which is all anyone has for it.
function chargeLineDescription(row){
 if(!row?.querySelector)return '';
 const entered=row.querySelector('[name="description"]')?.value||'';
 if(entered.trim())return entered;
 const shown=(row.querySelector('[name="procedure"]')?.value||'').trim();
 const code=(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase();
 if(!shown||!code)return '';
 return shown.toUpperCase().startsWith(`${code}:`)?shown.slice(code.length+1).trim():'';
}
// The codes a line points at are still the field the line submits; the letters on the chips beside
// it are how they are chosen, never a second copy of them.
function chargeDiagnosisCodesField(l){return `<input type="hidden" name="diagnoses" value="${esc((l.diagnosis_codes||[]).join(', '))}" maxlength="1200">`;}
// A line's diagnoses are chosen from the letters above the table: the chips fill this field, and
// the field stays the one the line submits, saves and sends.
// The letters of the encounter’s diagnoses, chosen here and nowhere else, the sentence saying what
// the line still needs, and the field the line submits: the chips fill it, so a line can never
// carry a code this encounter never recorded.
function chargeDiagnosisCell(l){return chargeDiagnosisCodesField(l)+'<div class="charge-dx-chips-slot" data-charge-diagnoses></div>'+chargeNoteCell()+chargeProblemCell();}
// The encounter's diagnoses, entered and saved in the same words and the same boxes as the encounter's
// Diagnoses screen: this holds that screen's own host and lets its own code draw it, so there is
// one diagnosis editor in this application rather than two that could drift. It sits directly
// above the charge lines, because every charge line answers to one of these.
// It is the charge form's neighbour, not part of the form: an editor inside an editor cannot be
// submitted, and the diagnoses save finds its own form by id.
// Named for what it holds and nothing else: the letters on the charge lines below are these
// diagnoses, so one plain word says where each belongs without repeating the encounter in both.
// On the one-page visit the codes & charges block carries its own stable diagnoses host
// (#encounter-diagnoses, drawn and kept by the revenue block), so the table lays down nothing and
// there is never a second #visit-diagnoses; elsewhere the table still brings its own.
function encounterDiagnosesHostExists(){return typeof document!=='undefined'&&typeof document.getElementById==='function'&&Boolean(document.getElementById('encounter-diagnoses'));}
function chargeDiagnosisSectionMarkup(){
 if(encounterDiagnosesHostExists())return '';
 return `<section class="charge-visit-diagnoses" data-charge-diagnosis-editor><h3>Diagnoses</h3><div id="visit-diagnoses"><p class="muted">Loading…</p></div></section>`;
}
// Placing the section is not drawing it. The diagnoses code fills its own host and saves on its
// own, exactly as it does on the encounter's Diagnoses screen; this only asks it to — into the stable
// block host when the page carries one, otherwise into the host laid down with this charge table.
function openChargeDiagnosisSection(){
 if(typeof renderVisitDiagnoses!=='function'||typeof activeVisit==='undefined'||!activeVisit)return;
 if(encounterDiagnosesHostExists()||billingEditorHost()?.querySelector?.('[data-charge-diagnosis-editor]'))void renderVisitDiagnoses();
}
// The amount an edit leaves behind, in cents, or nothing at all while it is not yet an amount.
// The amount each line was saved at, remembered on the row, survives while it is edited.
function seedChargeRowAmounts(form){for(const row of chargeLiveRows(form))chargeRowMemory(row).amountCents=chargeRowAmountCents(row);}
function chargeRowAmountCents(row){
 const text=String(row.querySelector?.('[name="amount"]')?.value||'').replace(/[$\s]/g,'');
 if(!text)return null;
 try{return cents(text);}catch{return null;}
}
function chargeRowExtras(l,compact){
 if(!compact)return '';
 const dated=l.service_from||l.service_to;
 return `<details class="charge-more charge-line-dates"${dated?' open':''}><summary>${dated?'Dates for this line':'Different dates for this line'}</summary><label>From<input type="date" name="service_from" value="${esc(l.service_from||'')}"></label><label>To<input type="date" name="service_to" value="${esc(l.service_to||'')}"></label></details><details class="charge-more"><summary>Code list this came from</summary>${typeof terminologyLookupButton==='function'?terminologyLookupButton('procedure'):''}${typeof terminologySnapshotMarkup==='function'?terminologySnapshotMarkup(l.catalog_snapshot):''}</details>`;
}
// The table holds the columns; anything a line carries beyond them rides on the row element
// between a save and the next one, so nothing recorded is dropped by a re-render.
function chargeRowData(row){return {
 units:Math.trunc(Number(row.querySelector('[name="units"]')?.value))||1,
 modifiers:String(row.querySelector('[name="modifiers"]')?.value||''),
 amount_cents:chargeRowAmount(row),
 diagnosis_codes:diagnosisCodeList(String(row.querySelector('[name="diagnoses"]')?.value||'').split(',')),
 ...(chargeRowMemory(row).catalogReleaseId?{catalog_release_id:chargeRowMemory(row).catalogReleaseId}:{}),
 ...chargeDrugMarkup({ndc_code:row.querySelector('[name="ndc_code"]')?.value,ndc_quantity:row.querySelector('[name="ndc_quantity"]')?.value,ndc_unit:row.querySelector('[name="ndc_unit"]')?.value}),
 ...(chargeRowMemory(row).feeScheduleId?{fee_schedule_id:chargeRowMemory(row).feeScheduleId}:{}),
 ...(chargeRowMemory(row).feeEntryKey?{fee_entry_key:chargeRowMemory(row).feeEntryKey}:{}),
 ...(row.querySelector('[name="service_from"]')?.value?{service_from:row.querySelector('[name="service_from"]').value}:{}),
 ...(row.querySelector('[name="service_to"]')?.value?{service_to:row.querySelector('[name="service_to"]').value}:{})};}
// Charges that are final or removed are read as a table here too, with the one step that fits.
// The charge editor can be reached without the encounter billing card loaded, so the service date
// is worded here the same plain way staff see it elsewhere in billing.
function chargeServiceDate(value){return typeof visitBillingDate==='function'?visitBillingDate(value):typeof displayDate==='function'?displayDate(value):String(value||'');}
function chargeTableFinishedMarkup(a){
 const state=a.status==='posted'?'These charges are final':'These charges were removed';
 const correction=billingCan()&&a.status==='posted'&&!a.source_history_id&&a.content.visit_id?'<button type="button" data-edit-charges>Edit charges</button>':'';
 return `<section class="charge-table-finished"><div class="section-head"><div><h3>Charges for this encounter</h3><p class="muted">${esc(chargeServiceDate(a.content.service_date))} · ${state}</p></div></div>${chargeTable(a.content.lines)}<div class="actions"><button type="button" data-visit-charges-overview>Go to visit billing</button>${correction}</div></section>`;
}
function chargeTableAllowed(a){
 // The table is the place charges are worked on: an encounter's draft account, entered by hand.
 if(!a&&(typeof activeVisit==='undefined'||!activeVisit))return false;
 if(a){if(a.status!=='draft'||a.source_history_id||a.diagnosis_snapshot||!a.content.visit_id)return false;}
 return billingCan();
}
// The encounter's billing state, read from the one place that holds it: the encounter billing step's own
// summary. A chart with no billing step loaded, or a table opened for anything but the encounter in
// hand, has no state to speak of and is given no next step.
function chargeTableVisitSummary(visitId){
 if(!visitId||typeof encounterRevenueState==='undefined'||typeof selected==='undefined')return null;
 if(encounterRevenueState.patient!==selected||encounterRevenueState.visit!==visitId)return null;
 return encounterRevenueState.data?.summary||null;
}
// The one line under the charge table, asking the encounter billing card's own code what the next
// step is (see visitBillingChargeStepMarkup in web/visit-billing.js, which loads first).
function chargeTableNextMarkup(visitId,remember){
 if(typeof visitBillingChargeStepMarkup!=='function')return '';
 const summary=chargeTableVisitSummary(visitId);if(!summary)return '';
 const markup=visitBillingChargeStepMarkup(summary,typeof visitBillingStateContext==='function'?visitBillingStateContext():{});
 // Where the line is being written into the table's own markup, the place it goes is not on screen
 // yet, so the answer is remembered by name and matched when the slot is found.
 if(remember&&markup)remember.set(`${visitId}`,markup);
 return markup;
}
// What the line under the table holds right now, kept beside the table itself rather than in the
// billing step's data: the markup last written there, and whose step it is — the card's, or a step
// another screen painted. A refresh needs this because a browser's innerHTML never hands back the
// markup it was given, so the two can never be compared; and a table whose line nobody has drawn
// yet is answered with nothing, which is what puts the line in the first time. A slot written
// straight into the table's markup is remembered here too, by the same name, so it is not put in a
// second time on the next refresh.
const chargeTableNextLines=new WeakMap();
const chargeTableNextWritten=new Map();
function chargeTableNextLine(slot,markup){
 if(markup===undefined)return chargeTableNextLines.get(slot)??chargeTableNextWritten.get(slot);
 chargeTableNextLines.set(slot,markup);
}
// The next step under the table follows the card: put the line in, change it, or take it away
// when the encounter has no charge step left to offer. The table and anything typed into it are not
// touched, so the line never disturbs the person working in the charges. The card's answer is
// worked out from the encounter the table is on, not from a summary handed over, so the footer and the
// card can never be given two different versions of the encounter.
function chargeTableNextRefresh(){
 // The card's answer is asked for first: it works out the next step and remembers it, and only
 // then does it look for the place the line goes, so a table that has nowhere to show it cannot be
 // left believing its line says something it does not.
 const form=$('billing-account-form');if(!form)return;
 const visitId=form.elements.visit_id?.value;
 const markup=chargeTableNextMarkup(visitId);
 const slot=form.querySelector('[data-charge-next]');if(!slot)return;
 // The line carries one step at a time, and what was last written into the slot says who wrote it.
 // A step another screen painted — the claim review panel's send button — is the step being asked
 // there and then, so a card refresh underneath it neither overwrites it nor mistakes it for the
 // card's own answer; that screen clears it when it closes, and the card's step returns.
 const shown=chargeTableNextLine(slot)??chargeTableNextWritten.get(visitId);
 if(shown?.painted)return;
 if(shown&&shown.markup===markup)return;
 chargeTableNextLine(slot,{markup});
 if(markup)slot.innerHTML=markup;else slot.replaceChildren();
}
// One step taken by another screen — the claim review panel opening, say — leaves its own button
// in that one line, so the person working there is not asked to press something twice.
function chargeTableNextPaint(button,label='Nothing has been sent yet.'){
 const form=$('billing-account-form');if(!button||!form)return;
 // The step is the card's own answer painted into the line, not a hand-written button: closing
 // the screen that borrowed the line writes the same markup back and the card's refresh finds it
 // unchanged, instead of mistaking its own step for another screen's and never giving it back.
 const visitId=form.elements.visit_id?.value;
 const painted=chargeTableNextMarkup(visitId)||`<p class="charge-table-next"><span>${esc(label)}</span> ${button}</p>`;
 const slot=form.querySelector('[data-charge-next]');if(!slot)return;
 slot.innerHTML=painted;
 // Whatever the card had to say is put aside while this screen's step holds the line, and the
 // remembered answer is cleared so the very next refresh is written again rather than skipped as
 // unchanged — otherwise closing this screen finds the slot empty and its step never returns.
 chargeTableNextLine(slot,{markup:painted,painted:true});
 chargeTableNextWritten.delete(slot);
}
// One row per line, read left to right the way a paper encounter form is filled in: the procedure,
// its modifiers, how many, the letters of the diagnoses it was for, the amount, then remove.
// Each box is headed with its column, which doubles as the row's only label on a narrow screen;
// the description a code carries rides on the line unseen, and
// what the lines come to is totalled once in the row underneath them.
function chargeLinesMarkup(lines,compact){return `<div class="billing-table-wrap charge-table-wrap"><table class="billing-table charge-table" id="billing-charge-lines"><caption class="sr-only">Procedures on this encounter</caption><thead><tr><th>Procedure</th><th>Modifiers</th><th>Units</th><th>Diagnoses</th><th>Amount</th><th></th></tr></thead><tbody>${lines.map((l,index)=>chargeRow(l,compact,chargeLineKey(l,index))).join('')}</tbody></table><div class="charge-lines-totals" data-charge-line-totals><span>Total charges <b data-charge-total>${money(0)}</b></span><span data-charge-copay>Copay</span><span class="charge-table-hint" data-charge-pays></span></div></div>`;}
// Each line keeps one identity for as long as it is on screen, so what it remembers — the amount
// last typed, the code list chosen, a line waiting to be removed, and whether the practice
// filled it in from an earlier visit — is found again after that row is drawn again.
function chargeLineKey(l,index){return `line-${index + 1}${l?.fromEarlierVisit?` ${chargeProposedFlag}`:''}`;}
// The row's own note slot: one short plain sentence left on a line that still needs something
// looked at — an amount no price list covers, a drug amount carried over from the last visit. It
// sits inside the line, under the letters, where there is room for a sentence.
function chargeNoteCell(){return '<div class="charge-cell-note" data-charge-note-cell></div>';}
// What a line still needs is written under the letters it is about, in the same box, so the row
// never grows a column of its own.
function chargeProblemCell(){return '<p class="charge-cell-problem" data-charge-problem role="status"></p>';}
// What each line comes to, and what the two totals mean, all recomputed from what is on
// the screen. The patient's share uses the copay already recorded on the encounter's coverage.
// The amount on a line is the line's total, as the claim carries it and as practice prices fill
// it in; units only say how many it covers. Under it, the charge for one unit.
function chargeLineTotalCents(row){const amount=chargeRowAmount(row);return amount==null?0:amount;}
function chargeUnitCharges(host){for(const row of host.querySelectorAll?.('.billing-charge-row')||[]){const units=Math.trunc(Number(row.querySelector('[name="units"]')?.value))||0,amount=chargeRowAmount(row);let note=row.querySelector('[data-charge-unit]');if(!note){const cell=row.querySelector('.charge-cell-amount');if(!cell)continue;note=document.createElement('small');note.dataset.chargeUnit='';note.className='charge-unit-note';cell.append(note);}note.textContent=amount!=null&&units>1?`${money(Math.round(amount/units))} per unit`:'';}}
function chargeRowRemoved(row){return typeof row.hasAttribute==='function'&&row.hasAttribute('data-charge-removed');}
// What a row remembers between saves. The amount and the drug detail are read straight back out
// of the row's own fields, so a practice price filled in from outside the typing stream is never
// missed. Only what no field can hold is kept here: the code system a code list chose, the code
// list a line came from, the practice-price link, and a line waiting to be removed.
const chargeRowMemoryCache=new WeakMap();let chargeRemovedRows=new Map();let chargeRemovedExpiry=0;
// A row redrawn from saved lines starts remembering again.
function chargeRowCaptureAll(form){for(const row of chargeLiveRows(form))chargeRowCapture(row);}
// The fee lookup fills an amount and its price link in from another file; this is where the
// table learns that happened and reads the row again.
function chargeRowsPriced(form){if(chargeTableHost(form))chargeRowCaptureAll(form);}
function chargeRowMemory(row){
 if(!row?.dataset)return {};
 if(!chargeRowMemoryCache.has(row)){
  chargeRowMemoryCache.set(row,{catalogReleaseId:row.dataset.catalogReleaseId||'',removed:row.hasAttribute?.('data-charge-removed')===true,...chargeRowRemembered(row)});
 }
 return chargeRowMemoryCache.get(row);
}
function chargeRowRemembered(row){
 const key=row.getAttribute?.('data-charge-key');
 if(!key||!chargeRemovedRows.has(key))return {};
 const held=chargeRemovedRows.get(key),memory=chargeRowMemory(held);
 return {catalogReleaseId:memory.catalogReleaseId,feeScheduleId:memory.feeScheduleId,feeEntryKey:memory.feeEntryKey,removed:true};
}
// The practice-price link is chosen by the fee lookup rather than by a field on the row, so it is
// read in whenever the row is looked at.
function chargeRowCapture(row){
 if(!row?.querySelector)return chargeRowMemory(row);
 const memory=chargeRowMemory(row),host=row.querySelector('[data-fee-line]');
 const code=(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase();
 if(memory.systemCode!==code){memory.system='';memory.systemCode=code;}
 if(host){memory.feeScheduleId=host.dataset.feeSchedule||'';memory.feeEntryKey=host.dataset.feeEntry||'';}
 if(row.dataset.catalogReleaseId)memory.catalogReleaseId=row.dataset.catalogReleaseId;
 return memory;
}
function chargeRowAmount(row){return chargeRowMemory(row).amountCents??chargeRowAmountCents(row);}
function chargeRowTable(form){return form?.querySelector?.('#billing-charge-lines')||null;}
// Read left to right, the columns a claim line is made of, in the order they are filled in.
// Anything a line carries that is not a box on the row travels on the row itself, unseen, so the
// line stays one row high.
function chargeLineTail(l){return chargeLineDescriptionCell(l);}
function chargeTableHost(form){return !!chargeRowTable(form);}
function chargeTableTotals(host){
 const rows=Array.from(host.querySelectorAll?.('.billing-charge-row')||[]).filter(row=>row.isConnected!==false&&!chargeRowRemoved(row));
 const total=rows.reduce((sum,row)=>sum+chargeLineTotalCents(row),0);
 const copay=typeof visitPlanCopayCents==='function'?visitPlanCopayCents():null;
 const pays=Math.min(total,copay??total);
 for(const node of host.querySelectorAll('[data-charge-total]'))node.textContent=money(total);
 if(typeof document!=='undefined'&&document.createElement){chargeUnitCharges(host);for(const row of host.querySelectorAll?.('.billing-charge-row')||[])modifierOptionsRender(row);}
 const copayNode=host.querySelector('[data-charge-copay]'),owesNode=host.querySelector('[data-charge-pays]');
 if(copayNode)copayNode.textContent=copay==null?'No copay recorded for this plan':`Copay ${money(copay)}`;
 if(owesNode)owesNode.textContent=copay==null?'Until the insurer answers, what the patient owes comes from the plan or a review':`Patient pays now ${money(pays)}`;
}
function visitPlanCopayCents(){
 const visit=typeof activeVisit!=='undefined'?activeVisit:null;
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 const coverage=(workspace?.billing?.coverages||[]).find(c=>c.id===(account?.content.coverage_id||(typeof revenueCoverage==='function'?revenueCoverage()?.id:null)));
 return coverage&&coverage.content.copay_cents!=null?Number(coverage.content.copay_cents):null;
}
// Everything a row needs to be sent: the columns, plus what the row carries beyond them.
function chargeRowValue(row){
 chargeRowCapture(row);
 const code=(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase();
 const system=chargeCodeSystem({code});
 return {code_system:system,code,description:chargeLineDescription(row),...chargeRowData(row)};
}
// What a line describes, in the words it was chosen with. A chosen code leaves those words in the
// box a person reads and in the field the line carries; a code typed by hand without the box ever
// being used is described by the box itself, which is all anyone has for it.
// Plain words, on the row itself, for the one thing that stops this line being complete.
function chargeRowProblems(row){
 if(!row?.querySelector)return [];
 const code=(row.querySelector('[name="code"]')?.value||'').trim();
 const description=chargeLineDescription(row).trim();
 const amount=chargeRowAmount(row),units=Math.trunc(Number(row.querySelector('[name="units"]')?.value));
 const diagnoses=(row.querySelector('[name="diagnoses"]')?.value||'').trim();
 const ndc=(row.querySelector('[name="ndc_code"]')?.value||'').trim(),quantity=(row.querySelector('[name="ndc_quantity"]')?.value||'').trim(),unit=(row.querySelector('[name="ndc_unit"]')?.value||'').trim();
 const problems=[];
 if(!code)problems.push('Add the procedure code.');
 if(code&&!description)problems.push('Add what this service was.');
 if(amount==null)problems.push('Add the amount for this line.');
 else{
  if(!(units>=1))problems.push('Add how many units were done.');
  if(!diagnoses)problems.push('Choose the diagnoses this service was for.');
 }
 if(ndc&&!(quantity&&unit))problems.push('For a drug, add its NDC code, the amount given and the unit.');
 return problems;
}
// A line's sentence and the letters it is about are written in the same pass, so a line never shows
// a complaint about its diagnoses beside chips that already answered it.
function renderChargeRowProblems(form){
 if(!chargeTableHost(form))return;
 const busy=!!(form?.dataset.chargeSaving||form?.dataset.chargeConflict||form?.dataset.draftReadOnly||form?.dataset.draftStale);
 for(const row of chargeLiveRows(form)){
  const cell=row.querySelector('[data-charge-problem]');if(!cell)continue;
  const problems=busy?[]:chargeRowProblems(row);
  if(problems.length){cell.textContent=problems.join(' ');row.setAttribute('data-charge-problem','true');}
  else{cell.textContent='';row.removeAttribute('data-charge-problem');}
 }
 renderChargeEncounterDiagnoses(form);
}
function chargeLineCount(form){return Array.from(form?.querySelectorAll?.('.billing-charge-row')||[]).filter(row=>!chargeRowRemoved(row)).length;}
// A removed line waits, taken out of the table, until it has been saved away or undone.
// A new line is added to the table and its code box is focused, so typing can start at once.
function addChargeRow(){
 const form=$('billing-account-form'),body=form?.querySelector('#billing-charge-lines tbody');if(!body)return;
 body.insertAdjacentHTML('beforeend',chargeRow({},form.dataset.compact==='true',chargeLineKey(null,chargeLiveRows(form).length)));
 const row=body.lastElementChild;
 row?.querySelector('[name="code"]')?.focus();
 chargeTableTotals(form);renderChargeRowProblems(form);
 captureBillingChargeDraft();
 scheduleChargeAutosave(form);
}
function removeChargeRow(form,row){
 chargeRowCapture(row);
 row.dataset.chargeRemoved='true';
 const slot=document.createElement('tr');slot.dataset.chargeRemovedSlot='';row.before(slot);
 row.remove();
 const key=row.getAttribute?.('data-charge-key');
 if(key)chargeRemovedRows.set(key,row);
 const undo=document.createElement('span');undo.className='charge-undo';undo.setAttribute('role','status');
 undo.append(`Removed line ${chargeRowLabel(row)}. `);
 const button=document.createElement('button');button.type='button';button.dataset.undoCharge='1';button.textContent='Undo';
 undo.append(button);
 form.querySelector('[data-charge-status]')?.replaceChildren(undo);
 clearTimeout(form.chargeUndoTimer);form.chargeUndoTimer=setTimeout(()=>{closeChargeRemovals();},8000);
}
// Undo puts the removed rows back where they were, live again, and clears the removal state:
// the slot, the Undo offer, and the row's own "waiting to be removed" flag.
function restoreChargeRow(form,slot){
 clearTimeout(form.chargeUndoTimer);
 form.querySelector('[data-charge-status] .charge-undo')?.remove();
 const rows=[...chargeRemovedRows.values()];chargeRemovedRows.clear();
 const body=chargeRowTable(form);
 rows.forEach(row=>{
  const key=row.getAttribute?.('data-charge-key'),insertAt=body?.querySelector(`[data-charge-key="${key}"]`);
  if(insertAt)insertAt.before(row);else if(body)body.append(row);
  const memory=chargeRowMemory(row);memory.removed=false;delete memory.amountCents;
  delete row.dataset.chargeRemoved;
 });
 slot?.remove();
}
// The undo window is short; after it a removed line is gone from the browser as well as the table.
// A save that landed takes the pending removals with it: their edits are on the server now,
// so the row itself, its slot and the Undo offer all go away together.
function closeChargeRemovals(){clearTimeout(chargeRemovedExpiry);for(const row of chargeRemovedRows.values()){row.parentElement?.querySelector('[data-charge-removed-slot]')?.remove();row.remove();}chargeRemovedRows.clear();}
function removeChargeRowTable(form,row){
 removeChargeRow(form,row);
 chargeTableTotals(form);renderChargeRowProblems(form);
 captureBillingChargeDraft();
 // Staff emptying the table is them answering the proposal; it is never offered again here.
 if(!chargeLineCount(form)&&typeof forgetChargeProposal==='function')forgetChargeProposal(form.elements.visit_id?.value);
 scheduleChargeAutosave(form);
}
function undoChargeRemoval(form){
 if(!form)return;
 // The restored row is live again; its removal leaves the pending set so its next save is real.
 clearTimeout(form.chargeUndoTimer);
 restoreChargeRow(form,form.querySelector('[data-charge-removed-slot]'));
 renderChargeEncounterDiagnoses(form);
 chargeTableTotals(form);renderChargeRowProblems(form);
 captureBillingChargeDraft();
 scheduleChargeAutosave(form);
}
function chargeRowLabel(row){const code=(row.querySelector('[name="code"]')?.value||'').trim();return code||'without a code';}
// One quiet line beside the table: saving, saved, or what went wrong with one way to retry.
function setChargeStatus(form,state,message){
 const status=form?.querySelector('[data-charge-status]');if(!status)return;
 if(state==='saving'){status.textContent='Saving…';return;}
 if(state==='saved'){status.textContent='Saved';return;}
 if(state==='quiet'){status.replaceChildren();return;}
 status.replaceChildren();
 status.append(message||'This change could not be saved. Nothing you typed has been lost.');
 if(state==='error'){
  const retry=document.createElement('button');retry.type='button';retry.dataset.retryChargeSave='1';retry.textContent='Try again';
  status.append(retry);
 }
}
function scheduleChargeAutosave(form,delay=700){
 if(!chargeTableHost(form)||form.dataset.autosave==='off'||form.dataset.draftReadOnly||form.dataset.draftStale)return;
 form.chargeSaveDelay=delay;
 if(form.dataset.chargeConflict)return;
 if(form.querySelector('.billing-charge-row:not([data-charge-removed])')===null)return;
 clearTimeout(form.chargeSaveTimer);
 form.chargeSaveTimer=setTimeout(()=>{form.chargeSaveTimer=null;void saveChargeTable(form);},delay);
}
 async function correctChargeTable(form){
 if(!form?.isConnected||form.dataset.patient!==selected||!chargeLineCount(form))return;
 if(form.dataset.chargeSaving||form.dataset.chargeConflict||form.dataset.draftReadOnly||form.dataset.draftStale)return;
 const identity=me,patient=selected,editing=!!form.dataset.id;
 const version=Number(form.dataset.version),body=chargeDraftBody(form);
 form.dataset.chargeSaving='true';delete form.dataset.chargeSavedAt;
 renderChargeRowProblems(form);setChargeStatus(form,'saving');
 let saved;
 try{
  saved=await api(`${billingBase()}/${form.dataset.id}/corrections`,'POST',{request_id:form.dataset.request,...body},version);
 }catch(error){
  if(!form.isConnected||me!==identity||selected!==patient)return;
  delete form.dataset.chargeSaving;
  if(error?.status===409){await reloadChargeTable(form,patient,identity);return;}
  if(chargeLineCount(form))scheduleChargeAutosave(form,3000);
  setChargeStatus(form,'error',`${error?.message||'This change could not be saved.'} Nothing you typed has been lost.`);
  renderChargeRowProblems(form);
  return;
 }
 if(!form.isConnected||me!==identity||selected!==patient)return;
 delete form.dataset.chargeSaving;form.dataset.request=crypto.randomUUID();
 form.dataset.id=saved.id;form.dataset.version=String(saved.version);
 form.dataset.draftKey=billingChargeKey(saved.id,null,null);
 billingSelected=saved.id;
 const html=billingChargeMarkup(form);
 if(html!==null)billingChargeDrafts.delete(form.dataset.draftKey);
 const signature=chargeTableSignature(saved.content);
 if(html!==null)billingChargeBaselines.set(form,signature);
 const lines=Array.isArray(saved.content?.lines)?saved.content.lines:[];
 const rows=chargeLiveRows(form);
 if(lines.length===rows.length)lines.forEach((line,index)=>{if(chargeRowSignature(rows[index])!==chargeLineSignature(line))renderChargeRowReplacement(form,rows[index],line);});
 else renderChargeTableRows(form,lines.length?lines:body.content.lines);
 chargeTableTotals(form);
 renderChargeRowProblems(form);
 setChargeStatus(form,'saved');
 clearTimeout(form.chargeSavedTimer);form.chargeSavedTimer=setTimeout(()=>setChargeStatus(form,'quiet'),4000);
 closeChargeRemovals();
 if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
 chargeSavedFollowUp(form,saved,identity,patient);
}
async function saveChargeTable(form){
 if(!form?.isConnected||form.dataset.patient!==selected||!chargeLineCount(form))return;
 if(form.dataset.chargeSaving||form.dataset.chargeConflict||form.dataset.draftReadOnly||form.dataset.draftStale)return;
 if(form.dataset.mode==='correction')return correctChargeTable(form);
 const identity=me,patient=selected,editing=!!form.dataset.id;
 const version=Number(form.dataset.version),body=chargeDraftBody(form);
 form.dataset.chargeSaving='true';delete form.dataset.chargeSavedAt;
 renderChargeRowProblems(form);setChargeStatus(form,'saving');
 let saved;
 try{
  if(!editing)body.request_id=form.dataset.request,body.source_history_id=form.dataset.source||null;
  saved=await api(`${billingBase()}${editing?'/'+form.dataset.id:''}`,editing?'PUT':'POST',body,editing?version:undefined);
 }catch(error){
  if(!form.isConnected||me!==identity||selected!==patient)return;
  delete form.dataset.chargeSaving;
  if(error?.status===409&&editing){await reloadChargeTable(form,patient,identity);return;}
  if(chargeLineCount(form))scheduleChargeAutosave(form,3000);
  setChargeStatus(form,'error',`${error?.message||'This change could not be saved.'} Nothing you typed has been lost.`);
  renderChargeRowProblems(form);
  return;
 }
 if(!form.isConnected||me!==identity||selected!==patient)return;
 delete form.dataset.chargeSaving;
 form.dataset.id=saved.id;form.dataset.version=String(saved.version);
 form.dataset.draftKey=billingChargeKey(saved.id,null,null);
 billingSelected=saved.id;
 const html=billingChargeMarkup(form);
 if(html!==null)billingChargeDrafts.delete(form.dataset.draftKey);
 const signature=chargeTableSignature(saved.content);
 if(html!==null)billingChargeBaselines.set(form,signature);
 // A line may arrive back changed by the server: an NDC normalised to 11 digits, a code
 // resolved against a code list. Only a row that differs from what was sent is re-rendered,
 // so a cell staff are still typing in is never replaced under them.
 const lines=Array.isArray(saved.content?.lines)?saved.content.lines:[];
 const rows=chargeLiveRows(form);
 if(lines.length===rows.length)lines.forEach((line,index)=>{if(chargeRowSignature(rows[index])!==chargeLineSignature(line))renderChargeRowReplacement(form,rows[index],line);});
 else renderChargeTableRows(form,lines.length?lines:body.content.lines);
 chargeTableTotals(form);
 renderChargeRowProblems(form);
 setChargeStatus(form,'saved');
 clearTimeout(form.chargeSavedTimer);form.chargeSavedTimer=setTimeout(()=>setChargeStatus(form,'quiet'),4000);
 closeChargeRemovals();
 if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
 chargeSavedFollowUp(form,saved,identity,patient);
}
// The shape a stored line is kept in, so a save can tell which rows the server changed.
function chargeLineSignature(l){return JSON.stringify([l?.code_system,l?.code,l?.description,l?.modifiers,l?.units,l?.amount_cents,l?.diagnosis_codes,l?.catalog_release_id||null,l?.ndc_code||null,l?.ndc_quantity||null,l?.ndc_unit||null,l?.fee_schedule_id||null,l?.fee_entry_key||null,l?.service_from||null,l?.service_to||null]);}
// The page's own copy of the charges and the next step follow a save, so the card never asks to
// add charges that were just saved. Refreshed once typing pauses, not on every keystroke.
function chargeSavedFollowUp(form,saved,identity,patient){
 const accounts=typeof workspace!=='undefined'?workspace?.billing?.accounts:null;
 if(Array.isArray(accounts)&&saved?.id){const at=accounts.findIndex(a=>a.id===saved.id);if(at>=0)accounts[at]=saved;else accounts.push(saved);}
 clearTimeout(form.chargeCardTimer);
 form.chargeCardTimer=setTimeout(()=>{if(form.isConnected!==false&&me===identity&&selected===patient&&typeof loadEncounterRevenueStatus==='function'&&typeof encounterChargeAccount==='function'&&encounterChargeAccount()?.id===saved?.id)loadEncounterRevenueStatus(encounterChargeAccount(),true);},1200);
}
function chargeRowSignature(row){return chargeLineSignature(chargeRowValue(row));}
function chargeTableSignature(content){return JSON.stringify((content?.lines||[]).map(chargeLineSignature));}
function chargeLiveRows(form){return Array.from(form.querySelector?.('#billing-charge-lines')?.querySelectorAll?.('.billing-charge-row')||[]).filter(row=>!chargeRowRemoved(row));}
function renderChargeTableRows(form,lines){
 const body=chargeRowTable(form);if(!body)return;
 for(const row of chargeLiveRows(form))chargeRowMemoryCache.delete(row);
 body.innerHTML=lines.map((l,index)=>chargeRow(l,form.dataset.compact==='true',chargeLineKey(l,index))).join('');
 chargeRowCaptureAll(form);
 chargeTableTotals(form);
}
// One row brought in line with what is saved, in place, so the caret and the other rows stay put.
function renderChargeRowReplacement(form,row,line){
 chargeRowMemoryCache.delete(row);
 const holder=document.createElement('tbody');
 holder.innerHTML=chargeRow(line,form.dataset.compact==='true',row.getAttribute?.('data-charge-key')||'');
 const fresh=holder.firstElementChild;if(!fresh)return;
 const active=document.activeElement,focused=active&&row.contains(active);
 row.replaceWith(fresh);
 if(focused&&typeof fresh.querySelector==='function'){const name=active.getAttribute?.('name');const again=(name?fresh.querySelector(`[name="${name}"]`):null)||fresh.querySelector('[name="code"]');if(typeof again?.focus==='function')again.focus({preventScroll:true});}
 chargeTableTotals(form);
}
// The claim details an encounter form holds beside its charges, as on a paper encounter form: the
// dates, who rendered, referred and supervised, where it took place, and the few claim boxes a
// payer sometimes asks for. Empty means the practice default; nothing here is sent until posted.
const encounterPlaceOptions=[['','Practice default'],['11','11 · Office'],['10','10 · Telehealth, patient at home'],['02','02 · Telehealth, other place'],['12','12 · Home'],['22','22 · Hospital outpatient'],['19','19 · Off-campus hospital outpatient'],['31','31 · Skilled nursing facility'],['32','32 · Nursing facility']];
const encounterDetailText=['prior_authorization_number','secondary_coverage_id','batch_number','rendering_provider_name','service_location_name','service_location_address','rendering_npi','place_of_service','encounter_mode','referring_provider_name','referring_npi','supervising_provider_name','supervising_npi','claim_codes','additional_claim_info','business_office_note'];
const encounterDetailDates=['current_illness_date','through_date','hospitalization_from','hospitalization_to'];
function encounterClaimDetailsMarkup(d,part){
 d=d||{};const val=k=>esc(d[k]??''),field=(k,label,extra='')=>`<label>${label}<input name="cd_${k}" value="${val(k)}" ${extra}></label>`,dateField=(k,label)=>`<label>${label}<input type="date" name="cd_${k}" value="${val(k)}"></label>`;
 if(part==='head')return `<div class="form-grid">${field('prior_authorization_number','Prior authorization number (box 23)','maxlength="50"')}${dateField('current_illness_date','Date the illness or injury began (box 14)')}${dateField('through_date','Through date (if more than one day)')}${encounterSecondaryMarkup(d)}${field('batch_number','Batch number (for your reports)','maxlength="30"')}<label class="check-row"><input type="checkbox" name="cd_paper_only" ${d.paper_only?'checked':''}> Do not send this claim electronically (print it instead)</label></div>`;
 if(part==='provider')return `<section class="charge-encounter-head" data-encounter-provider><h4>Provider and place</h4><div class="form-grid"><label>Rendering provider<select name="cd_rendering_pick" data-encounter-pick="provider"><option value="">Practice default</option>${encounterOptionsMarkup('providers',d.rendering_npi)}</select></label><input type="hidden" name="cd_rendering_provider_name" value="${val('rendering_provider_name')}">${field('rendering_npi','Rendering provider NPI','inputmode="numeric" maxlength="10" placeholder="Practice default"')}<label>Location<select name="cd_location_pick" data-encounter-pick="facility"><option value="">Billing address</option>${encounterOptionsMarkup('facilities',d.service_location_name)}</select></label><input type="hidden" name="cd_service_location_name" value="${val('service_location_name')}"><input type="hidden" name="cd_service_location_address" value="${val('service_location_address')}"><label>Place of service<select name="cd_place_of_service">${encounterPlaceOptions.map(([code,label])=>`<option value="${code}" ${String(d.place_of_service||'')===code?'selected':''}>${label}</option>`).join('')}</select></label><label>Encounter mode<select name="cd_encounter_mode"><option value="" ${!d.encounter_mode?'selected':''}>In office</option><option value="telehealth" ${d.encounter_mode==='telehealth'?'selected':''}>Telehealth</option></select></label>${field('referring_provider_name','Referring provider','maxlength="120"')}${field('referring_npi','Referring provider NPI','inputmode="numeric" maxlength="10"')}${field('supervising_provider_name','Supervising provider','maxlength="120"')}${field('supervising_npi','Supervising provider NPI','inputmode="numeric" maxlength="10"')}</div></section>`;
 if(part==='actions')return `<div class="encounter-form-actions"><button type="button" data-check-codes>Check codes</button><label class="check-row"><input type="checkbox" name="cd_review_requested" ${d.review_requested?'checked':''}> Hold for review before posting</label><div class="encounter-code-check" data-code-check role="status" aria-live="polite"></div></div>`;
 if(part==='extras')return `<div class="form-grid">${dateField('hospitalization_from','Hospitalized from (box 18)')}${dateField('hospitalization_to','Hospitalized to')}${field('claim_codes','Claim codes (box 10d)','maxlength="19"')}${field('additional_claim_info','Additional claim information (box 19)','maxlength="71"')}</div>`;
 if(part==='notes')return `<label>Business office notes (staff only, never on the claim)<textarea name="cd_business_office_note" maxlength="2000">${val('business_office_note')}</textarea></label>`;
 return '';
}
// The details as the server takes them, or nothing when none were filled in.
function encounterClaimDetailsValue(form){
 if(!form?.elements?.cd_place_of_service&&!form?.elements?.cd_paper_only)return null;
 const out={};let any=false;
 for(const k of encounterDetailText){const v=String(form.elements[`cd_${k}`]?.value||'').trim();if(v){out[k]=v;any=true;}}
 for(const k of encounterDetailDates){const v=form.elements[`cd_${k}`]?.value||'';if(v){out[k]=v;any=true;}}
 if(form.elements.cd_paper_only?.checked){out.paper_only=true;any=true;}
 if(form.elements.cd_review_requested?.checked){out.review_requested=true;any=true;}
 return any?out:null;
}
// The practice's providers and locations for the pick lists, read once per page.
let encounterOptions=null,encounterOptionsLoading=null;
function encounterOptionsLoad(){
 if(encounterOptions||encounterOptionsLoading||typeof api!=='function')return encounterOptionsLoading;
 encounterOptionsLoading=api('/api/v1/billing/encounter-options').then(data=>{encounterOptions={providers:data.providers||[],facilities:data.facilities||[]};encounterOptionsFill();}).catch(()=>{encounterOptions={providers:[],facilities:[]};}).finally(()=>{encounterOptionsLoading=null;});
 return encounterOptionsLoading;
}
function encounterOptionsMarkup(kind,current){
 const items=encounterOptions?.[kind]||[];
 return items.map(item=>{const value=kind==='providers'?item.npi:item.name;return `<option value="${esc(item.id)}" ${current&&value===current?'selected':''}>${esc(item.name)}${kind==='providers'&&item.npi?' · NPI '+esc(item.npi):''}</option>`;}).join('');
}
// The lists arrive after the form is drawn: fill them in where the form is still open.
function encounterOptionsFill(){
 const form=typeof $==='function'?$('billing-account-form'):null;if(!form?.querySelector)return;
 for(const [name,kind,hidden] of [['cd_rendering_pick','providers','cd_rendering_npi'],['cd_location_pick','facilities','cd_service_location_name']]){
  const select=form.elements?.[name];if(!select||select.options.length>1)continue;
  select.insertAdjacentHTML('beforeend',encounterOptionsMarkup(kind,form.elements[hidden]?.value||''));
 }
}
function encounterSecondaryMarkup(d){
 const coverages=(typeof workspace!=='undefined'?workspace?.billing?.coverages:null)||[];
 const others=coverages.filter(c=>c.content?.priority&&c.content.priority!=='primary'&&c.content.status!=='inactive');
 if(!others.length&&!d.secondary_coverage_id)return '';
 return `<label>Secondary insurance<select name="cd_secondary_coverage_id"><option value="">Bill the primary only</option>${others.map(c=>`<option value="${esc(c.id)}" ${d.secondary_coverage_id===c.id?'selected':''}>${esc(typeof payerName==='function'?payerName(c.content.payer_id):'Plan')} · ${esc(c.content.member_id||'')}</option>`).join('')}</select></label>`;
}
// Picking a provider or a location fills the boxes the claim reads; the NPI stays editable.
if(typeof document!=='undefined')document.addEventListener('change',event=>{
 const select=event.target?.closest?.('[data-encounter-pick]');if(!select)return;
 const form=select.form;if(!form)return;
 if(select.dataset.encounterPick==='provider'){const p=(encounterOptions?.providers||[]).find(x=>x.id===select.value);form.elements.cd_rendering_npi.value=p?.npi||'';form.elements.cd_rendering_provider_name.value=p?.name||'';}
 else{const f=(encounterOptions?.facilities||[]).find(x=>x.id===select.value);form.elements.cd_service_location_name.value=f?.name||'';form.elements.cd_service_location_address.value=f?.address||'';}
 if(typeof scheduleChargeAutosave==='function')scheduleChargeAutosave(form);
});
// Check codes: the coding rules a payer applies most often to this kind of encounter, checked
// on the screen before posting. It reads the table as it is and never changes anything.
const encounterEmCodes=/^99(20[2-5]|21[1-5])$/,encounterToxinCodes=/^J058[5-8]$/,encounterChemodenervation=/^646(1[2-7]|4[2-7])$/,encounterGuidance=/^9587[34]$/;
function encounterCodeFindings(form){
 const rows=chargeLiveRows(form).map(row=>({code:(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase(),modifiers:String(row.querySelector('[name="modifiers"]')?.value||'').toUpperCase().split(/[,\s]+/).filter(Boolean),units:Math.trunc(Number(row.querySelector('[name="units"]')?.value))||0,diagnoses:String(row.querySelector('[name="diagnoses"]')?.value||'').trim(),ndc:(row.querySelector('[name="ndc_code"]')?.value||'').trim()})).filter(r=>r.code);
 // Two levels, as other systems grade them: 'fix' stops posting until it is fixed; 'review' is
 // shown before posting and can be posted anyway.
 const out=[],fix=text=>out.push({level:'fix',text}),review=text=>out.push({level:'review',text}),codes=rows.map(r=>r.code);
 const others=rows.filter(r=>!encounterEmCodes.test(r.code));
 for(const r of rows){
  if(!r.diagnoses)fix(`${r.code}: link at least one diagnosis.`);
  if(r.units<1)fix(`${r.code}: enter how many units.`);
  if(r.modifiers.length>4)fix(`${r.code}: a claim line takes at most four modifiers.`);
  if(encounterEmCodes.test(r.code)&&others.length&&!r.modifiers.includes('25'))review(`${r.code}: an office visit billed with a procedure on the same day usually needs modifier 25.`);
  if(encounterToxinCodes.test(r.code)){
   if(!r.ndc)fix(`${r.code}: add the drug's NDC code, quantity and unit.`);
   // A correct wastage claim is two lines: the dose given with no modifier, the amount
   // discarded with JW. Only a drug with neither JZ nor a JW line for it is flagged.
   const same=rows.filter(x=>x.code===r.code),hasJW=same.some(x=>x.modifiers.includes('JW')),hasJZ=same.some(x=>x.modifiers.includes('JZ'));
   if(!hasJW&&!hasJZ&&r===same[0])review(`${r.code}: Medicare needs JZ when no drug was discarded, or a separate JW line for the amount discarded.`);
   if(hasJW&&hasJZ&&r===same[0])fix(`${r.code}: use JZ (nothing discarded) or a JW line (amount discarded), not both.`);
  }
  if(encounterChemodenervation.test(r.code)&&!codes.some(c=>encounterToxinCodes.test(c)))review(`${r.code}: no botulinum toxin line (J0585 to J0588) was entered for this injection.`);
  if(encounterGuidance.test(r.code)&&!codes.some(c=>encounterChemodenervation.test(c)))fix(`${r.code}: guidance is an add-on and is billed with a chemodenervation code.`);
  if(/^6464[2-7]$/.test(r.code)&&r.modifiers.includes('50'))fix(`${r.code}: do not use modifier 50; bill the extra-extremity add-on (64643 or 64645) instead.`);
  if(r.code==='J0587'&&r.units>10)review('J0587 is billed per 100 units: check the units are the dose divided by 100.');
 }
 if(codes.includes('95874')&&codes.includes('95873'))fix('95873 and 95874 are never billed together: keep one guidance code.');
 const seen=new Map();for(const r of rows){const key=r.code+'|'+r.modifiers.slice().sort().join(',');if(seen.has(key)&&!r.modifiers.includes('JW')&&!r.modifiers.includes('59')&&!r.modifiers.includes('XS'))review(`${r.code} is entered twice with the same modifiers: use units, or add 59/XS if they were separate sites.`);seen.set(key,1);}
 const tele=form.elements?.cd_encounter_mode?.value==='telehealth',place=form.elements?.cd_place_of_service?.value||'';
 if(tele&&!['02','10',''].includes(place))review('Telehealth: the place of service is usually 02 or 10.');
 if(tele&&rows.some(r=>encounterEmCodes.test(r.code)&&!r.modifiers.includes('95')))review('Telehealth: many payers want modifier 95 on the visit code.');
 const dx=new Set(rows.flatMap(r=>r.diagnoses.split(/[,\s]+/).filter(Boolean)));if(dx.size>12)fix('A claim carries at most 12 diagnoses.');
 return out;
}
function encounterCodeFindingsMarkup(findings){
 if(!findings.length)return '<p class="code-check-ok">No coding problems found.</p>';
 const fixes=findings.filter(f=>f.level==='fix'),reviews=findings.filter(f=>f.level==='review');
 return `${fixes.length?`<div class="code-check-fix"><b>Fix before posting</b><ul>${fixes.map(f=>`<li>${esc(f.text)}</li>`).join('')}</ul></div>`:''}${reviews.length?`<div class="code-check-review"><b>Check before posting</b><ul>${reviews.map(f=>`<li>${esc(f.text)}</li>`).join('')}</ul></div>`:''}<p class="muted">These are the common payer rules for this kind of encounter. They run again when the charges are posted.</p>`;
}
if(typeof document!=='undefined')document.addEventListener('click',event=>{
 const button=event.target?.closest?.('[data-check-codes]');if(!button)return;event.preventDefault();
 const form=button.closest('form'),host=form?.querySelector('[data-code-check]');if(!host)return;
 const findings=encounterCodeFindings(form);
 host.innerHTML=encounterCodeFindingsMarkup(findings);
 if(typeof flashUpdated==='function')flashUpdated(host);
});
// Modifiers are picked, not typed: the ones that fit the line's code first, in plain words, and
// every other common modifier in one list. A line takes at most four.
const modifierWords={'25':'Separate visit on the same day as a procedure','57':'Visit that decided on surgery','95':'Telehealth video visit','59':'Distinct procedure','XS':'Separate site or organ','XU':'Unusual, separate service','50':'Both sides','RT':'Right side','LT':'Left side','26':'Reading only (professional part)','TC':'Equipment only (technical part)','76':'Repeated by the same clinician','JZ':'No drug discarded','JW':'Drug amount discarded','KX':'Payer requirements met','GA':'Waiver (ABN) on file','GZ':'No waiver (ABN) on file','GY':'Not covered by Medicare'};
function modifierChoicesFor(code){
 code=String(code||'').trim().toUpperCase();
 if(/^99(20[2-5]|21[1-5])$/.test(code))return ['25','95','57','GA'];
 if(/^J058[5-8]$/.test(code))return ['JZ','JW','KX'];
 if(/^646(1[2-7])$/.test(code))return ['50','RT','LT','59','XS'];
 if(/^6464[2-7]$/.test(code))return ['RT','LT','59','XS'];
 if(/^9587[34]$/.test(code))return ['59','XS','26'];
 if(/^J/.test(code))return ['JZ','JW'];
 return ['59','XS','RT','LT','50','76'];
}
// The code a row is on now: the box being typed in while it holds a code, otherwise the code the
// row carries (a pick from the code list, an earlier visit, a draft or a saved line fills that).
function chargeRowCodeNow(row){
 const typed=(row.querySelector('[name="procedure"]')?.value||'').split(':')[0].trim().toUpperCase();
 return /^[A-Z0-9]{4,7}$/.test(typed)?typed:(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase();
}
function modifierOptionsRender(row){
 const host=row?.querySelector?.('[data-modifier-options]'),input=row?.querySelector?.('[name="modifiers"]');if(!host||!input)return;
 const code=chargeRowCodeNow(row),chosen=String(input.value||'').toUpperCase().split(/[,\s]+/).filter(Boolean);
 const fit=modifierChoicesFor(code),key=code+'|'+chosen.join(',');if(host.dataset.key===key)return;host.dataset.key=key;
 const chip=m=>`<button type="button" class="modifier-chip${chosen.includes(m)?' is-on':''}" data-modifier-toggle="${m}" aria-pressed="${chosen.includes(m)}" title="${esc(modifierWords[m]||m)}">${m}<small>${esc(modifierWords[m]||'')}</small></button>`;
 const others=Object.keys(modifierWords).filter(m=>!fit.includes(m));
 host.innerHTML=`${code?fit.map(chip).join(''):'<small class="muted">Enter the code to see its modifiers</small>'}${chosen.filter(m=>!fit.includes(m)).map(chip).join('')}<select data-modifier-more aria-label="More modifiers"><option value="">More modifiers…</option>${others.filter(m=>!chosen.includes(m)).map(m=>`<option value="${m}">${m} · ${esc(modifierWords[m])}</option>`).join('')}</select>`;
}
function modifierToggle(row,m){
 const input=row.querySelector('[name="modifiers"]');if(!input)return;
 let chosen=String(input.value||'').toUpperCase().split(/[,\s]+/).filter(Boolean);
 if(chosen.includes(m))chosen=chosen.filter(x=>x!==m);else{if(chosen.length>=4){notice('A claim line takes at most four modifiers.',true);return;}chosen.push(m);}
 input.value=chosen.join(',');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
 modifierOptionsRender(row);
}
if(typeof document!=='undefined'){
 document.addEventListener('click',event=>{const b=event.target?.closest?.('[data-modifier-toggle]');if(!b)return;event.preventDefault();modifierToggle(b.closest('.billing-charge-row'),b.dataset.modifierToggle);});
 document.addEventListener('change',event=>{const sel=event.target?.closest?.('[data-modifier-more]');if(!sel||!sel.value)return;const value=sel.value;sel.value='';modifierToggle(sel.closest('.billing-charge-row'),value);});
 document.addEventListener('input',event=>{if(['code','procedure'].includes(event.target?.name)&&event.target.closest?.('.billing-charge-row'))modifierOptionsRender(event.target.closest('.billing-charge-row'));});
}
function chargeDraftBody(form){
 const correction=form.dataset.mode==='correction';
 return {content:{
  visit_id:form.elements.visit_id?.value||null,
  coverage_id:form.elements.coverage_id?.value||null,
  service_date:form.elements.service_date?.value||'',
  currency:'USD',
  lines:chargeLiveRows(form).map(chargeRowValue),
  notes:form.elements.notes?.value||'',
  ...(encounterClaimDetailsValue(form)?{claim_details:encounterClaimDetailsValue(form)}:{}),
  ...(typeof feeContextValue==='function'&&feeContextValue(form)?{fee_context:feeContextValue(form)}:{})},reason:correction?'Charge correction':'Edited charges'};
}
// A save was rejected because the saved charges moved elsewhere. Read them again, keep every
// keystroke the room is holding, and let the next edit save against the version just read.
async function reloadChargeTable(form,patient,identity){
 try{
  const data=await api(`${billingBase()}`);
  if(!form.isConnected||me!==identity||selected!==patient)return;
  const account=(data.accounts||data.items||[]).find(a=>a.id===form.dataset.id);
  if(!account){form.dataset.chargeConflict='true';setChargeStatus(form,'error','These charges are no longer open here. Close this table and open them again from the encounter.');return;}
  if(account.status!=='draft'){form.dataset.chargeConflict='true';setChargeStatus(form,'error','These charges are no longer a draft, so they cannot be changed here. Open them from the encounter to review them.');return;}
  form.dataset.version=String(account.version);
  const typing=chargeTyping(form);
  renderChargeTableRows(form,account.content?.lines||[]);
  restoreChargeTyping(form,typing);
  void loadChargeEncounterDiagnoses(form);
  setChargeStatus(form,'error','These charges changed elsewhere, so the table was refreshed. Your typing is still here — the next change saves it.');
 }catch{
  if(!form.isConnected||me!==identity||selected!==patient)return;
  form.dataset.chargeConflict='true';
  setChargeStatus(form,'error','These charges changed elsewhere and could not be read again. Nothing you typed has been lost.');
 }
 renderChargeRowProblems(form);
}
function chargeTyping(form){
 const rows=chargeLiveRows(form);
 return {values:rows.map(row=>Array.from(row.querySelectorAll('input,textarea,select')).map(field=>field.value)),focus:rows.findIndex(row=>row.contains(document.activeElement)),cursor:document.activeElement?.selectionStart??null};
}
function restoreChargeTyping(form,typing){
 const rows=chargeLiveRows(form);
 typing.values.forEach((values,index)=>{const fields=Array.from(rows[index]?.querySelectorAll('input,textarea,select')||[]);fields.forEach((field,column)=>{if(field.type==='checkbox'||field.type==='radio')return;field.value=values[column]??field.value;});});
 const target=rows[typing.focus];
 if(target){const active=target.contains(document.activeElement)?document.activeElement:target.querySelector('[name="code"]');if(typeof active?.focus==='function'){active.focus({preventScroll:true});if(typing.cursor!=null&&/text|search|tel|url|password/.test(active.type||'')){try{active.setSelectionRange(typing.cursor,typing.cursor);}catch{/* a field that cannot place a caret keeps its text */}}}}
 chargeTableTotals(form);
}
function chargeRow(l={},compact=false,key=''){
 return `<tr class="billing-charge-row"${key?` data-charge-key="${key}"`:''} ${!l.code&&l.amount_cents==null&&!(l.diagnosis_codes||[]).length?'data-diagnoses-default="pending"':''} data-catalog-release-id="${esc(l.catalog_release_id||'')}" data-catalog-code="${esc(l.code||'')}" data-catalog-display="${esc(l.description||'')}" data-catalog-system="${esc(l.code_system||chargeCodeSystem(l))}" data-charge-system="${esc(l.code_system||chargeCodeSystem(l))}"${l.amount_cents==null?'':' data-charge-amount="'+l.amount_cents+'"'}${l.fee_schedule_id?` data-fee-schedule="${esc(l.fee_schedule_id)}"`:''}${l.fee_entry_key?` data-fee-entry="${esc(l.fee_entry_key)}"`:''}><td class="charge-cell-code">${chargeCodeCell(l)}${chargeDescriptionCell(l)}${chargeRowExtras(l,compact)}</td><td class="charge-cell-modifiers">${compact?`<label>Modifiers<input name="modifiers" type="text" value="${esc(l.modifiers||'')}" maxlength="100" readonly placeholder="None"></label><div class="modifier-options" data-modifier-options></div>`:chargeMiniField('modifiers','Modifiers',l.modifiers||'',100)+'<div class="modifier-options" data-modifier-options></div>'}</td><td class="charge-cell-units"><label>Units<input name="units" type="number" min="1" max="1000" step="1" value="${l.units===undefined?1:l.units}" required></label></td><td class="charge-cell-diagnoses">${chargeDiagnosisCell(l)}</td><td class="charge-cell-amount">${chargeMiniField('amount','Amount',dollars(l.amount_cents),30,true)}${typeof feeLineMarkup==='function'?feeLineMarkup(l):''}${l.source_fee!==undefined?`<p class="mapping-notice">Source fee: ${esc(l.source_fee)} · Check whether that was the whole line or one unit, then enter the amount for the whole line.</p>`:''}</td><td class="charge-cell-remove"><button type="button" data-remove-charge>Remove</button></td>${chargeLineTail(l)}</tr>`;
}
// The browser can only point at an invalid control that is visible, so the tucked-away visit,
// insurance and fee fields are opened before validation runs whenever one of them fails.
document.addEventListener('submit',event=>{if(event.target?.id==='billing-account-form')openInvalidChargeOptions(event.target);},true);
// Charges filled in from the last visit. Nobody should have to press a button and retype what
// the practice already did: opening the charges step of an encounter that has no charge account yet
// puts the same services from the patient's most recent earlier visit onto the table, at this
// visit's practice prices, with this encounter's diagnoses. The existing autosave makes the draft,
// so nothing has to be pressed. Amounts are never copied from the old visit, and a line the
// price list does not cover is left with an empty amount and a plain note instead of a guess.
const chargeProposalStore='suncharts.chargeProposals';
// What the practice already decided about this encounter: 'blank' means staff asked for an empty
// table, 'lines' means lines were offered here — by hand or from an earlier session. Both mean
// the proposal has been dealt with and is never offered again for this encounter.
const chargeProposalChoices=new Map();
// Both reads and writes are guarded: a browser in private mode still gets the in-memory memory.
function chargeProposalsLoad(){try{const raw=typeof sessionStorage==='undefined'?null:sessionStorage.getItem(chargeProposalStore);return raw?JSON.parse(raw)||{}:{};}catch{return {};}}
function chargeProposalsSave(store){try{if(typeof sessionStorage!=='undefined')sessionStorage.setItem(chargeProposalStore,JSON.stringify(store));}catch{/* The memory is only a convenience. */}}
function chargeProposalChoice(visitId){
 if(!visitId)return '';
 if(chargeProposalChoices.get(visitId))return chargeProposalChoices.get(visitId);
 const stored=chargeProposalsLoad()[`${selected}:${visitId}`];
 const choice=stored==='blank'||stored==='lines'?stored:'';
 if(choice)chargeProposalChoices.set(visitId,choice);
 return choice;
}
function chargeProposalRemember(visitId,choice){
 if(!visitId)return;
 chargeProposalChoices.set(visitId,choice);
 const store=chargeProposalsLoad();store[`${selected}:${visitId}`]=choice;chargeProposalsSave(store);
}
// Opening an encounter that already has charges of its own is staff working on those charges, so the
// visit is never offered a proposal again. A record from the previous system is not an encounter's own
// charges and decides nothing about a proposal.
function chargeProposalTouched(visit){
 if(!visit||visit.status==='signed')return;
 if(typeof encounterChargeAccountFor!=='function')return;
 if(!chargeAccountIsWorkedCharges(encounterChargeAccountFor(visit.id)))return;
 chargeProposalRemember(visit.id,'lines');
}
// An encounter whose charges are already final or already recorded from the previous system is not a
// table staff are working on, and decides nothing about a proposal.
function chargeAccountIsWorkedCharges(a){return !!a&&a.status==='draft'&&!a.source_history_id&&!!a.content.visit_id;}
// The encounter's own charge account, read straight from the chart rather than through whatever the
// billing card happens to be showing, so a step opened for one visit is never judged by another's.
function encounterChargeAccountFor(visitId){return (workspace.billing?.accounts||[]).find(a=>a.status!=='void'&&a.content.visit_id===visitId)||null;}
// Whether charges are on their way onto this encounter's table on their own: true while they are
// being put on it, and while they sit there on a table no one has changed yet. Read-only staff
// and an encounter whose charges exist are answered 'no', so the card never promises a fill-in that
// is not happening.
function encounterChargesProposed(){
 if(typeof chargeProposeCard!=='function')return false;
 if(chargeProposeCard())return true;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null;if(!visit)return false;
 const form=$('billing-account-form');
 return !!form&&form.dataset.proposed==='true'&&form.querySelector('[data-charge-proposal-blank]')!==null&&!form.dataset.id&&chargeProposalChoice(visit.id)==='lines';
}
// Staff emptied the table or asked for a blank one: never bring the lines back.
function forgetChargeProposal(visitId){if(visitId)chargeProposalRemember(visitId,'blank');}
// Charges for an encounter are dated by their own service date, so the earlier visit is found on the
// account rather than on the encounter record.
function chargeAccountDay(a){return String(a?.content?.service_date||a?.created_at||'').slice(0,10);}
function chargeSourceVisitId(a){return a?.content?.visit_id||(workspace.visits||[]).find(v=>v.id===a?.content?.visit_id)?a.content.visit_id:null;}
// The patient's most recent earlier visit that has charge lines, posted or draft. The encounter
// being worked on, its own account, records from the previous system and voided accounts are all
// left out, as is any account with nothing on it.
// Only this patient's chart is ever read. A charge account is the patient's own when the encounter it
// belongs to is an encounter of theirs; a record whose visit cannot be found is not evidence of
// anything, and an encounter belonging to somebody else is never a source for these charges.
function chargeAccountOfPatient(a){
 const visitId=chargeSourceVisitId(a);if(!visitId)return false;
 const visit=(workspace.visits||[]).find(v=>v.id===visitId);
 return !!visit&&visit.patient_id===selected;
}
function chargeEarlierAccount(visitId,serviceDate){
 const day=String(serviceDate||'').slice(0,10);
 return (workspace.billing?.accounts||[])
  .filter(a=>a.status!=='void'&&!a.source_history_id&&chargeSourceVisitId(a)&&chargeSourceVisitId(a)!==visitId&&chargeAccountOfPatient(a)&&(a.content.lines||[]).some(line=>line&&String(line.code||'').trim())&&(!day||chargeAccountDay(a)<day))
  .sort((a,b)=>chargeAccountDay(b).localeCompare(chargeAccountDay(a)))[0]||null;
}
// One line carried over: the service as it was done, its drug detail included. No amount, no
// diagnosis and nothing about an old price list or code list comes across. `fromEarlierVisit`
// rides on the line only while it is being put on the table; no save ever sends it.
function chargeLineProposed(l){
 const line={code_system:chargeCodeSystem(l),code:String(l.code||'').trim(),description:String(l.description||'').trim(),modifiers:String(l.modifiers||'').trim(),units:Number.isInteger(Number(l.units))&&Number(l.units)>=1?Number(l.units):1,diagnosis_codes:[],amount_cents:null,fromEarlierVisit:true};
 const drug=chargeDrugMarkup(l);
 if(drug.ndc_code){line.ndc_code=drug.ndc_code;line.ndc_quantity=drug.ndc_quantity;line.ndc_unit=drug.ndc_unit;}
 return line;
}
function chargeProposeContext(visit){
 if(!visit||visit.status==='signed')return null;
 if(!billingCan('create'))return null;
 if(typeof chargeTableAllowed==='function'&&!chargeTableAllowed(null))return null;
 // The encounter's own charges, read from the chart rather than through whatever the billing card
 // happens to be showing. Staff already working a table decide the proposal once, by emptying it
 // or asking for a blank one; that decision is the only one counted, in either direction.
 if(encounterChargeAccountFor(visit.id))return null;
 if(chargeProposalChoice(visit.id))return null;
 return {visitId:visit.id};
}
function chargeProposeMarkup(context){
 return `<section class="charge-table-proposal" role="status"><p>Filled in from the encounter on ${esc(chargeProposalDate(context.date))}. Change anything you like.</p><button type="button" data-charge-proposal-blank>Start blank</button></section>`;
}
// A line the practice filled in carries its mark in the same slot the table keeps a row's
// identity in, so it survives a redraw of that row and nothing about it is ever sent anywhere.
const chargeProposedFlag='filled-in-earlier-visit';
function chargeRowProposed(row){return (row?.getAttribute?.('data-charge-key')||'').split(/\s+/).includes(chargeProposedFlag);}
// The proposal is offered while the table is being built, before anything is on screen: the
// lines go in as the table's own rows and its usual save path does the rest.
function chargeProposeBeforeRender(visit){
 const context=chargeProposeContext(visit);if(!context)return null;
 const earlier=chargeEarlierAccount(context.visitId,typeof revenueServiceDate==='function'?revenueServiceDate():'');
 if(!earlier)return null;
 context.date=chargeAccountDay(earlier);
 context.lines=(earlier.content.lines||[]).filter(line=>line&&String(line.code||'').trim()).map(chargeLineProposed);
 if(!context.lines.length)return null;
 return context;
}
// The date is said in the same short words staff see everywhere else in billing.
function chargeProposalDate(value){
 if(value&&typeof visitBillingDate==='function')return visitBillingDate(value);
 if(value&&typeof displayDate==='function')return displayDate(value);
 return 'an earlier visit';
}
// The card is only told to stop sending staff to type charges by hand when lines are actually on
// the way; with no earlier visit carrying charges it keeps its usual wording.
function chargeProposeCard(){
 const context=chargeProposeContext(typeof activeVisit!=='undefined'?activeVisit:null);
 if(!context)return null;
 const earlier=chargeEarlierAccount(context.visitId,typeof revenueServiceDate==='function'?revenueServiceDate():'');
 if(!earlier||!(earlier.content.lines||[]).some(line=>line&&String(line.code||'').trim()))return null;
 return context;
}
// The table is on screen: the carried-over lines replace the single blank row the table starts
// with, each row marked as one the practice filled in, and every line asks the practice price
// list for its amount before anything else is said about it.
function chargeProposeAfterRender(form,context){
 if(!form||!context||!chargeProposeCurrent(form,context))return;
 // The lines are only a real offer once they are on screen: that is the moment the encounter is
 // marked as having been offered lines, so a table never reached decides nothing about them.
 chargeProposalRemember(context.visitId,'lines');
 renderChargeProposedRows(form,context);
}
function chargeProposeCurrent(form,context){
 return !!form&&$('billing-account-form')===form&&!!context&&Array.isArray(context.lines)&&context.lines.length>0&&form.dataset.patient===selected&&!form.dataset.id;
}
function renderChargeProposedRows(form,context){
 const body=chargeRowTable(form);if(!body)return;
 form.dataset.proposed='true';
 body.innerHTML=context.lines.map((l,index)=>chargeRow(l,form.dataset.compact==='true',chargeLineKey(l,index))).join('');
 body.insertAdjacentHTML('beforebegin',chargeProposeMarkup(context));
 chargeRowCaptureAll(form);
 chargeTableTotals(form);
 // The services come from the earlier visit; the diagnoses always come from this one, through
 // the same one-time default the table already gives a fresh line.
 void loadChargeEncounterDiagnoses(form);
 // The amounts come from this encounter's practice prices. Where the practice's place of service is
 // already settled the lookup runs now; where it still has to be chosen the price fills itself in
 // the moment the fee details are read, the same way an empty line is priced today.
 // The rows are asked what they need first, so none of them is told to type an amount while its
 // own price is still on the way.
 chargeProposalNotePrices(form);
 chargeProposePriceRows(form);
}
// A filled-in row whose price is typed by hand, or whose practice's place of service cannot be
// settled, will get no answer from the price list. Those rows are still asked, so the row says in
// plain words what it needs instead of being left silent with an empty amount on it.
function chargeProposalNotePrices(form){for(const row of chargeLiveRows(form))if(chargeRowProposed(row))chargePricedByFeeLookup(form,row);}
function chargeProposePriceRows(form){
 const pending=()=>chargeLiveRows(form).filter(row=>chargeRowProposed(row)&&!row.querySelector('[name="amount"]').value);
 if(!pending().length||typeof feeContextValue!=='function')return;
 const settled=feeContextValue(form);
 if(settled){for(const row of pending())void checkFee(form,row,true,settled);return;}
 // The place of service has not been chosen yet. It is asked for once, the same way the fee
 // details box asks, and the prices land on the rows as soon as it is known.
 if(chargeProposeAsking.has(form))return;
 chargeProposeAsking.add(form);
 void (async()=>{
  const context=typeof feeContextQuick==='function'?await feeContextQuick(form):null;
  chargeProposeAsking.delete(form);
  if(!form.isConnected||$('billing-account-form')!==form)return;
  // The practice's place of service could not be settled, so the price list cannot be reached.
  // The rows say what they still need, in the words the fee details already use, rather than being
  // left silent with an empty amount on them.
  if(!context){chargeProposalNotePrices(form);return;}
  for(const row of pending())void checkFee(form,row,true,context);
 })();
}
// Forms the practice prices have already been asked about, so a fill-in asks once per table.
const chargeProposeAsking=new WeakSet();
// One quiet line on the row. What the practice types there is theirs; a re-check of the prices
// only rewrites what this same note said before.
function chargeProposalNote(row,text,price=''){
 const cell=row?.querySelector?.('[data-charge-note-cell]');if(!cell)return;
 const shown=cell.textContent.trim();
 if(shown&&!(cell.dataset.chargePrice===price&&shown===cell.dataset.chargeShown))return;
 if(shown===text&&cell.dataset.chargePrice===price)return;
 if(!text){cell.innerHTML='';delete cell.dataset.chargeShown;delete cell.dataset.chargePrice;row.removeAttribute('data-charge-noted');return;}
 cell.innerHTML=`<p class="muted" data-charge-proposal-note>${esc(text)}</p>`;
 cell.dataset.chargeShown=text;cell.dataset.chargePrice=price;
 row.setAttribute('data-charge-noted','true');
}
// The price list has had its say about a filled-in row. A line it does not cover keeps an empty
// amount and says what it needs; a drug carried over is flagged for the amount given to be
// checked. Both are one plain note on the row, never a wall.
// One look per row: the price list is asked again as the practice's place of service changes, and
// each answer says only what is still true. A row the prices cover goes quiet again.
function chargePricedByFeeLookup(form,row){
 if(!chargeRowProposed(row))return;
 const host=row.querySelector('[data-fee-line]');
 // The row has something to say once the price list has answered about it; before an answer comes
 // back the row stays quiet, because a guess about a price is not a note. The status line is what
 // carries that answer, so the note follows it and nothing else.
 const status=host?.querySelector?.('[data-fee-status]')?.textContent.trim()||'';
 const quantity=(row.querySelector('[name="ndc_quantity"]')?.value||'').trim();
 const drug=chargeIsDrugCode(row.querySelector('[name="code"]')?.value)&&quantity;
 // A line the price list covers is priced by it; one it does not is only at rest once the practice
 // has typed a number for it. Until the price list has answered, a row says nothing about a price.
 const wanted=[];
 if(status&&!host.dataset.feeSchedule&&!row.querySelector('[name="amount"]')?.value)wanted.push('Enter the amount');
 // A drug carried over is flagged for the amount given to be looked at. It is not a row that
// cannot be sent: its own problem line stays quiet, and the row can go as it stands.
 if(drug)wanted.push('Check the amount given');
 if(!wanted.length&&!status)return;
 row.dataset.chargePriced='true';
 chargeProposalNote(row,wanted.join('. '),host.dataset.feeSchedule||'unpriced');
}
// Start blank: the lines go, the offer goes with them, and an empty table is left ready to type in.
function chargeProposalStartBlank(form){
 if(!form)return;
 forgetChargeProposal(form.elements.visit_id?.value);
 delete form.dataset.proposed;
 form.querySelector('[data-charge-proposal-blank]')?.closest('.charge-table-proposal')?.remove();
 const body=chargeRowTable(form);if(!body)return;
 for(const row of chargeLiveRows(form)){chargeRowMemoryCache.delete(row);row.remove();}
 body.insertAdjacentHTML('beforeend',chargeRow({},form.dataset.compact==='true',chargeLineKey(null,0)));
 renderChargeEncounterDiagnoses(form);
 chargeTableTotals(form);renderChargeRowProblems(form);
 captureBillingChargeDraft();
 form.querySelector('[name="code"]')?.focus?.({preventScroll:true});
}
function accountEditor(a,m,encounterContext=false,options={}){
 captureBillingChargeDraft();
 const correcting=!!options.correction;
 if(a&&a.status!=='draft'&&a.content.visit_id&&!a.source_history_id&&!correcting){openBillingEditor(chargeTableFinishedMarkup(a));return;}
 if(a?.diagnosis_snapshot){billingSelected=a.id;openBillingEditor(`<section><h3>Review the linked visit diagnoses before changing charges</h3>${accountDiagnosisSummary(a.diagnosis_snapshot)}<p>This draft contains versioned diagnosis links. Use the link editor to update them, or explicitly clear its selections before changing the service lines. Clearing links retains the codes for manual review.</p><button type="button" data-link-account-diagnoses>Review / clear diagnosis links</button></section>`);return;}
 // The encounter's own charges count as staff having worked on the table; a record from the previous
 // system is not an encounter's charges and decides nothing about a proposal.
 if(a&&!a.source_history_id)chargeProposalTouched(typeof activeVisit!=='undefined'?activeVisit:null);
 if(!encounterContext&&!(typeof chartSection!=='undefined'&&chartSection==='visits'))showChartSection('billing');const source=m?.source_data||{},rows=Array.isArray(source.charge_lines)?source.charge_lines.filter(r=>r&&typeof r==='object'&&!Array.isArray(r)):[source],proposed=m?rows.map(r=>({code_system:r.code_type||'',code:r.code||'',description:r.code_text||'',modifiers:r.modifier||'',units:/^[1-9]\d*$/.test(String(r.units))?Number(r.units):'',source_fee:r.fee,diagnosis_codes:[]})):[{}];
 const sourceBacked=!!(m||a?.source_history_id),encounter=typeof activeVisit!=='undefined'?activeVisit:null,serviceDate=typeof revenueServiceDate==='function'?revenueServiceDate():new Date().toISOString().slice(0,10),coverage=typeof revenueCoverage==='function'?revenueCoverage(serviceDate):null,v=a?.content||{visit_id:encounter?.id||'',coverage_id:coverage?.id||'',service_date:encounter?serviceDate:'',lines:proposed,notes:''};
 // A charge editor opened for an encounter is a live table: the lines, then one box with the encounter,
 // insurance and fee details. Nothing a line needs sits behind a closed box, and every edit
 // saves itself. Reconciling a record from the previous system keeps its one review step.
 const compact=!!v.visit_id,sourceLines=m?' data-charge-lines-source=""':'',chargeVisitBlock=`<div class="form-grid"><label>Visit<select name="visit_id" ${sourceBacked?'':'required'}><option value="">${sourceBacked?'Source kept — no visit found for it':'Choose a patient visit'}</option>${workspace.visits.map(vis=>`<option value="${vis.id}" ${v.visit_id===vis.id?'selected':''}>${esc((workspace.appointments.find(ap=>ap.id===vis.appointment_id)?.title||'Visit')+' · '+date(workspace.appointments.find(ap=>ap.id===vis.appointment_id)?.starts_at||vis.created_at))} · ${esc(human(vis.status))}</option>`).join('')}</select></label>${billingField('service_date','Service date',v.service_date,'date',0,true)}<label>Billing coverage<select name="coverage_id"><option value="">Self-pay / no selected coverage</option>${workspace.billing.coverages.map(c=>`<option value="${c.id}" ${v.coverage_id===c.id?'selected':''}>${esc(human(c.content.priority))} · ${esc(payerName(c.content.payer_id))} · ${esc(c.content.member_id)}</option>`).join('')}</select></label><label>Currency<input value="USD" readonly></label></div>`,chargeNotesBlock=`<label>Notes<textarea name="notes" maxlength="2000">${esc(v.notes)}</textarea></label>`,chargeLinesBlock=`${chargeLinesMarkup(v.lines,compact)}<div class="charge-table-foot"><button type="button" data-add-charge>${compact?'+ Add another charge':'+ Charge line'}</button><p class="charge-table-status" data-charge-status role="status" aria-live="polite"></p></div>${correcting?'':`<div class="charge-table-next-slot" data-charge-next>${chargeTableNextMarkup(v.visit_id,chargeTableNextWritten)}</div>`}`,chargeOptionsBlock=`${chargeVisitBlock}<div data-charge-coverage-order>${billingCoverageOrderMarkup(v.service_date,v.coverage_id,compact)}</div>${typeof feeContextMarkup==='function'?feeContextMarkup(v.fee_context):''}${chargeNotesBlock}`,  chargeFormBody=compact?`<section class="charge-encounter-head" data-visit-charge-options><h4>Insurance and dates</h4>${chargeVisitBlock}<div data-charge-coverage-order>${billingCoverageOrderMarkup(v.service_date,v.coverage_id,compact)}</div>${encounterClaimDetailsMarkup(v.claim_details,'head')}</section>${encounterClaimDetailsMarkup(v.claim_details,'provider')}<h4 class="charge-lines-title">Procedures</h4>${chargeLinesBlock}${encounterClaimDetailsMarkup(v.claim_details,'actions')}<details class="charge-more-options"><summary>Hospital stay, claim codes and box 19</summary>${encounterClaimDetailsMarkup(v.claim_details,'extras')}</details><details class="charge-more-options"><summary>Fees and notes</summary>${typeof feeContextMarkup==='function'?feeContextMarkup(v.fee_context):''}${chargeNotesBlock}${encounterClaimDetailsMarkup(v.claim_details,'notes')}</details>`:`${chargeOptionsBlock}<p class="muted">Enter the amount for the whole line, not for one unit.</p>${chargeLinesBlock}`;
 // Charges for the encounter in hand come from that visit alone; a reconciliation of a record from
 // the previous system, or a chart opened elsewhere, is never filled in from another visit.
 // Charges are only ever filled in for the encounter this table is being opened for, and only from
 // that patient's own chart: a reconciliation of a record from the previous system, or a chart
 // opened elsewhere, is never filled in from another visit.
 const proposalVisit=v.visit_id?(workspace.visits||[]).find(vis=>vis.id===v.visit_id&&vis.patient_id===selected)||null:null;
 const proposal=chargeProposeBeforeRender(!a&&!m?proposalVisit:null);
 if(restoreBillingChargeDraft(a,m?.source_history_id,v.visit_id)){const restored=$('billing-account-form');seedChargeRowAmounts(restored);chargeTableTotals(restored);renderChargeRowProblems(restored);openChargeDiagnosisSection();void loadChargeEncounterDiagnoses(restored);return;}
  openBillingEditor(`${compact&&typeof renderVisitDiagnoses==='function'?chargeDiagnosisSectionMarkup():''}<form id="billing-account-form"${sourceLines} data-compact="${compact}" data-id="${a?.id||''}" data-version="${a?.version||''}" data-request="${crypto.randomUUID()}" data-source="${m?.source_history_id||''}" data-mode="${correcting?'correction':'draft'}"><h3>${a?(correcting?'Correct posted charges':'Edit draft charges'):m?'Reconcile source billing to draft':'Charges for this encounter'}</h3>${sourceNotice(m)}${chargeFormBody}${m?`<label class="review-ack"><input type="checkbox" name="verified" required> I verified the source visit, charges, fee basis, diagnoses and prior payment history. This creates a draft only.</label>${billingField('reason','Reason for this reconciliation','','text',1000,true)}<div class="actions"><button class="primary" type="submit">Create draft charges</button><button type="button" data-cancel-billing>Cancel</button></div>`:correcting?`<div class="actions"><button type="button" class="primary" data-save-charge-correction>Save changes</button><button type="button" data-cancel-billing>Cancel</button></div>`:''}</form>`);
  const form=$('billing-account-form');if(form){form.dataset.patient=selected;form.dataset.draftKey=billingChargeKey(a?.id,m?.source_history_id,v.visit_id);form.dataset.autosave=m||correcting?'off':'on';
  // Filled in from the earlier visit, or the blank line the table always starts with: the rows
  // are decided here, once, after this screen was opened and after any retained edits came back.
  chargeProposeAfterRender(form,proposal);
  if(m){const baseline=billingChargeMarkup(form);if(baseline)billingChargeBaselines.set(form,baseline);}
  else{billingChargeBaselines.set(form,chargeTableSignature(a?.content||{lines:chargeLiveRows(form).map(chargeRowValue)}));seedChargeRowAmounts(form);chargeTableTotals(form);renderChargeRowProblems(form);}
  openChargeDiagnosisSection();void loadChargeEncounterDiagnoses(form);if(typeof loadFeeContext==='function')void loadFeeContext(form);if(compact)void encounterOptionsLoad();}
}
function ledgerEditor(original){
 openBillingEditor(`<form id="billing-ledger-form" data-request="${crypto.randomUUID()}" data-reverses="${original?.id||''}"><h3>${original?'Reverse recorded entry':'Record payment / adjustment'}</h3><p class="muted">This records accounting evidence only. No card, bank or payer transaction is executed.</p>${original?`<p>Reverse ${esc(ledgerKind(original.kind))}: ${money(original.effect_cents)}. The original entry is retained.</p>`:`<div class="form-grid">${selectField('kind','Entry kind',['payment','adjustment_credit','adjustment_debit'],'payment')}${billingField('amount','Amount (USD)','','text',30,true)}${selectField('party','Recorded party',['patient','insurer','other'],'patient')}${selectField('method','Evidence method',['cash','check','external','other','none'],'external')}${billingField('reference','Receipt / EOB reference','','text',200)}</div>`}${billingField('occurred_on','Activity date','','date',0,true)}${billingField('reason','Reason / evidence','','text',1000,true)}<p class="muted">Do not enter payment-card numbers, bank details or credentials. Reversals and credits cannot create an overpayment.</p><div class="actions"><button type="submit" class="primary">${original?'Record reversal':'Record ledger entry'}</button><button type="button" data-cancel-billing>Cancel</button></div></form>`);
}
async function coverageDetail(id){
 showChartSection('insurance');const c=workspace.billing.coverages.find(c=>c.id===id),h=await api(`/api/v1/patients/${selected}/coverages/${id}/history`);
 openBillingEditor(`<h3>${esc(payerName(c.content.payer_id))} · ${esc(human(c.content.priority))}</h3><dl class="billing-dl">${Object.entries(c.content).filter(([k])=>k!=='payer_id').map(([k,v])=>`<dt>${esc(human(k))}</dt><dd>${esc(k==='copay_cents'?(v==null?'Not recorded':money(v)):v??'Not recorded')}</dd>`).join('')}</dl><p class="muted">${c.source_history_id?'Reconciled source coverage':'Native coverage'} · v${c.version}</p>${billingCan()?`<button type="button" data-edit-coverage="${id}">Edit insurance</button>`:''}<h3>Coverage history</h3>${h.items.map(r=>`<details class="amendment"><summary>v${r.version} · ${esc(r.reason)} · ${esc(date(r.created_at))}</summary><pre class="billing-source">${esc(JSON.stringify(r.snapshot.content,null,2))}</pre><p>Recorded by ${esc(r.actor_id)}</p></details>`).join('')}`);
}
async function showBillingQueue(status=billingQueueStatus,after,settings=false){
 if(typeof unregisterAutoRefresh==='function')unregisterAutoRefresh('billing-queue');
 if(!settings&&typeof renderBillingOverview==='function')return renderBillingOverview(status,after);
 const query=new URLSearchParams();if(status)query.set('status',status);if(after)query.set('after',after);
 const [data,payers,payerSources,claimmd]=await Promise.all([api(`/api/v1/billing/worklist?${query}`),api('/api/v1/billing/payers'),me.role==='owner'?api('/api/v1/billing/payer-sources'):{items:[]},(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('claims'))?loadClaimMdConnection().catch(()=>null):null]);billingPayerSources=payerSources.items;billingPayers=payers.items;billingQueueStatus=status;billingQueueCursor=data.next_cursor;showTool('Billing & insurance');
 $('tools').innerHTML=`<section id="billing-tool"><div class="section-head"><div><h2>Billing tools & payer directory</h2><p class="muted">Visit charge accounts, payers and settings · USD</p><button type="button" data-billing-overview>Back to Patient billing</button></div>${me.role==='owner'?'<div class="actions">'+(typeof terminologyCatalogButton==='function'?terminologyCatalogButton():'')+'<button type="button" data-payment-settings>Payment settings</button><button type="button" data-new-payer>+ Payer</button></div>':''}</div><form id="billing-filter" class="billing-filter"><label>Status<select name="status" aria-describedby="billing-filter-status"><option value="">All accounts</option>${['draft','posted','void'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${human(s)}</option>`).join('')}</select></label><span id="billing-filter-status" class="muted">Updates automatically</span></form><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Patient / service date</th><th>Status</th><th>Payer at posting</th><th class="money-cell">Charges</th><th class="money-cell">Open balance</th><th></th></tr></thead><tbody>${data.items.map(a=>`<tr><td><b>${esc(a.patient_name)}</b><small>${esc(a.mrn)} · ${esc(a.service_date)}</small></td><td><span class="pill">${esc(displayStatus(a.status))}</span></td><td>${esc(a.status==='draft'?'Not captured':a.payer_name||'Self-pay')}</td><td class="money-cell">${money(a.total_cents)}</td><td class="money-cell">${a.balance_cents==null?'—':money(a.balance_cents)}</td><td>${typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical')?`<button type="button" data-billing-patient="${a.patient_id}" data-account="${a.id}">Open billing</button>`:''}</td></tr>`).join('')||'<tr><td colspan="6" class="table-empty">No billing accounts in this worklist. Open a patient chart → Visit → Billing & claim to record procedures and charges.</td></tr>'}</tbody></table></div>${data.next_cursor?'<div class="actions"><button type="button" data-billing-next>Next 100 accounts</button></div>':''}<section class="billing-section"><div class="section-head"><h3>Payer directory</h3><span class="pill">${billingPayers.length}</span></div><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Payer</th><th>Claim.MD payer ID</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>${billingPayers.map(p=>`<tr><td>${esc(p.content.name)}</td><td>${esc(p.content.payer_code)}</td><td>${esc(p.content.phone||'—')}</td><td>${p.content.active?'Active':'Inactive'}</td><td><button type="button" data-payer-open="${p.id}">Open</button></td></tr>`).join('')||'<tr><td colspan="5">No native payers configured. A practice owner can add a payer here.</td></tr>'}</tbody></table></div></section>${typeof claimmdPayerDirectoryPanel==='function'&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('claims'))?claimmdPayerDirectoryPanel():''}${billingPayerSources.length?`<details class="amendment"><summary>Imported payer records (${billingPayerSources.length})</summary>${billingPayerSources.map(source=>`<div class="timeline-row"><div><b>${esc(source.source_data.name||source.source_id)}</b><small>${esc(source.source_instance)} · ${source.native_id?'Reconciled':'Needs identity review'}</small></div><button type="button" data-payer-source="${source.source_history_id}">${source.native_id?'View native payer':'Review mapping'}</button></div>`).join('')}</details>`:''}<div id="payer-editor"></div></section>`;
}
function payerEditor(p,m){const v=p?.content||{name:m?.source_data?.name||'',payer_code:'',phone:'',address:'',active:true};$('payer-editor').innerHTML=`<form id="payer-form" data-id="${p?.id||''}" data-version="${p?.version||''}" data-request="${crypto.randomUUID()}" data-source="${m?.source_history_id||''}"><h3>${p?'Edit payer':m?'Reconcile source payer':'Add payer'}</h3>${sourceNotice(m?{...m,policy:'Verify source payer identity, code and contact information.'}:null)}<div class="form-grid">${billingField('name','Payer name',v.name,'text',200,true)}${billingField('payer_code','Claim.MD payer ID',v.payer_code,'text',100)}${billingField('phone','Contact phone',v.phone,'text',50)}<label>Status<select name="active"><option value="true" ${v.active?'selected':''}>Active</option><option value="false" ${!v.active?'selected':''}>Inactive</option></select></label></div><label>Address<textarea name="address" maxlength="1000">${esc(v.address)}</textarea></label>${billingField('reason','Reason for change','','text',1000,true)}<div class="actions"><button type="submit" class="primary">Save payer</button><button type="button" data-cancel-payer>Cancel</button></div></form>`;$('payer-editor').scrollIntoView({block:'nearest'});}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.dataset.newClaim||b.type==='submit'||(!b.closest('#billing-workspace')&&!b.closest('#billing-tool')&&!b.closest('#insurance-workspace')&&!b.closest('#encounter-revenue')&&!b.dataset.mapBilling&&!b.hasAttribute('data-patient-create-claim')&&!b.hasAttribute('data-patient-collect-copay')))return;
 if(b.hasAttribute('data-add-charge')){addChargeRow();return;}
 if(b.hasAttribute('data-charge-proposal-blank')){e.preventDefault();chargeProposalStartBlank(b.closest('#billing-account-form'));return;}
 if(b.hasAttribute('data-remove-charge')){const form=b.closest('#billing-account-form'),row=b.closest('.billing-charge-row');if(form&&row)removeChargeRowTable(form,row);return;}
 if(b.dataset.undoCharge!==undefined){const form=b.closest('#billing-account-form');undoChargeRemoval(form);return;}
 if(b.dataset.retryChargeSave!==undefined){const form=b.closest('#billing-account-form');if(form){delete form.dataset.chargeConflict;setChargeStatus(form,'saving');scheduleChargeAutosave(form,0);}return;}
  if(b.hasAttribute('data-visit-charges-overview')){billingEditorHost()?.replaceChildren();return;}
  if(b.hasAttribute('data-edit-charges')){const a=workspace.billing.accounts.find(a=>a.id===billingSelected);if(a)accountEditor(a,null,typeof chartSection!=='undefined'&&chartSection==='visits',{correction:true});return;}
  if(b.hasAttribute('data-save-charge-correction')){e.preventDefault();run(()=>correctChargeTable(b.closest('#billing-account-form')));return;}
  if(b.hasAttribute('data-cancel-billing')){captureBillingChargeDraft();billingEditorHost()?.replaceChildren();return;}if(b.hasAttribute('data-cancel-payer')){$('payer-editor').replaceChildren();return;}
 const ownsAction=['data-patient-create-claim','data-patient-collect-copay','data-patient-claims','data-billing-overview','data-billing-next','data-new-payer','data-payer-source','data-payer-edit','data-payer-open','data-billing-patient','data-new-coverage','data-coverage-open','data-edit-coverage','data-new-billing','data-bill-open','data-edit-bill','data-build-patient-invoice','data-patient-invoices','data-print-patient-invoice','data-patient-invoice','data-new-ledger','data-reverse-entry','data-bill-history','data-map-billing'].some(name=>b.hasAttribute(name));
 if(!ownsAction)return;
 run(async()=>{
 if(b.hasAttribute('data-patient-create-claim')){await beginPatientClaim();return;}
 if(b.hasAttribute('data-patient-collect-copay')){beginPatientPayment();return;}
 if(b.hasAttribute('data-patient-claims')){await showClaimsWorkspace();return;}
 if(b.hasAttribute('data-billing-overview')){await showBillingQueue();return;}if(b.hasAttribute('data-billing-next')){await showBillingQueue(billingQueueStatus,billingQueueCursor,true);return;}
 if(b.hasAttribute('data-new-payer')){payerEditor();return;}if(b.dataset.payerSource){const m=billingPayerSources.find(m=>m.source_history_id===b.dataset.payerSource);if(m.native_id)payerEditor(billingPayers.find(p=>p.id===m.native_id));else payerEditor(null,m);return;}if(b.dataset.payerEdit){payerEditor(billingPayers.find(p=>p.id===b.dataset.payerEdit));return;}
 if(b.dataset.payerOpen){const p=billingPayers.find(p=>p.id===b.dataset.payerOpen),h=await api(`/api/v1/billing/payers/${p.id}/history`);$('payer-editor').innerHTML=`<h3>${esc(p.content.name)}</h3><p class="note-text">${esc(p.content.address)}</p>${me.role==='owner'?`<button type="button" data-payer-edit="${p.id}">Edit payer</button>`:''}<h3>Payer history</h3>${h.items.map(r=>`<details class="amendment"><summary>v${r.version} · ${esc(r.reason)} · ${esc(date(r.created_at))}</summary><pre class="billing-source">${esc(JSON.stringify(r.snapshot.content,null,2))}</pre></details>`).join('')}`;return;}
 if(b.dataset.billingPatient){const identity=me;await showClinical();if(me!==identity)return;await selectPatient(b.dataset.billingPatient,null);if(me!==identity||selected!==b.dataset.billingPatient)return;await openEncounterBillingAccount(b.dataset.account);return;}
 if(b.hasAttribute('data-new-coverage')){coverageEditor();return;}if(b.dataset.coverageOpen){await coverageDetail(b.dataset.coverageOpen);return;}if(b.dataset.editCoverage){coverageEditor(workspace.billing.coverages.find(c=>c.id===b.dataset.editCoverage));return;}
 if(b.hasAttribute('data-new-billing')){if(typeof openEncounterCharges==='function'&&typeof activeVisit!=='undefined'&&activeVisit)openEncounterCharges();else accountEditor();return;}if(b.dataset.billOpen){captureBillingChargeDraft();await openEncounterBillingAccount(b.dataset.billOpen);billingEditorHost()?.replaceChildren();return;}if(b.hasAttribute('data-edit-bill')){accountEditor(workspace.billing.accounts.find(a=>a.id===billingSelected));return;}
 if(b.hasAttribute('data-build-patient-invoice')){patientInvoiceEditor();return;}
 if(b.hasAttribute('data-patient-invoices')){await showPatientInvoices();return;}
 if(b.hasAttribute('data-print-patient-invoice')){$('patient-invoice-frame').contentWindow.focus();$('patient-invoice-frame').contentWindow.print();return;}
 if(b.dataset.patientInvoice){const data=await api(`${billingBase()}/${billingSelected}/invoices`);showPatientInvoice(data.items.find(i=>i.id===b.dataset.patientInvoice));return;}
 if(b.hasAttribute('data-new-ledger')){ledgerEditor();return;}if(b.dataset.reverseEntry){ledgerEditor(workspace.billing.entries.find(e=>e.id===b.dataset.reverseEntry));return;}
 if(b.hasAttribute('data-bill-history')){const h=await api(`${billingBase()}/${billingSelected}/history`);$('bill-history').innerHTML=h.items.map(r=>`<details class="amendment"><summary>v${r.version} · ${esc(r.snapshot.status)} · ${esc(r.reason)}</summary><p>${esc(date(r.created_at))} · ${esc(r.actor_id)}</p>${chargeTable(r.snapshot.content.lines)}</details>`).join('');return;}
 if(b.dataset.mapBilling){const m=await api(`/api/v1/patients/${selected}/history/${b.dataset.mapBilling}/billing-mapping`);showChartSection('billing');if(m.kind==='insurance'){if(m.native_id)await coverageDetail(m.native_id);else coverageEditor(null,m);}else if(m.kind==='billing'){if(m.native_id)showBillingAccount(m.native_id);else accountEditor(null,m);}else openBillingEditor(`<h3>Historical financial activity</h3>${sourceNotice(m)}<p>Reconcile receipts, payments, adjustments and remaining balances against the original ledger before recording any native activity. No ledger entry is created from this source automatically.</p>`);}
 });});
 document.addEventListener('submit',e=>{const f=e.target;if(!['payer-form','coverage-payer-form','coverage-form','billing-account-form','billing-account-action','billing-ledger-form','billing-filter','patient-invoice-form'].includes(f.id))return;e.preventDefault();const submitter=e.submitter;const returnSection=typeof chartSection!=='undefined'?chartSection:'billing';run(async()=>{const data=Object.fromEntries(new FormData(f));if(submitter&&submitter.name&&!(submitter.name in data))data[submitter.name]=submitter.value;
 if(f.id==='patient-invoice-form'){const invoice=await api(`${billingBase()}/${f.dataset.account}/invoices`,'POST',{request_id:f.dataset.request,responsibility_cents:cents(data.responsibility),reason:data.reason},Number(f.dataset.version));showPatientInvoice(invoice);return;}
 if(f.id==='billing-filter'){await showBillingQueue(data.status,undefined,true);return;}
 if(f.id==='coverage-payer-form'){const payer=await api('/api/v1/billing/payers','POST',{request_id:f.dataset.request,source_history_id:null,content:{name:data.name,payer_code:data.payer_code,phone:data.phone,address:data.address,active:true},reason:'Created while recording patient coverage'});billingPayers.push(payer);billingPayers.sort((a,b)=>a.content.name.localeCompare(b.content.name));coveragePayerSelected(payer);$('coverage-payer-setup').innerHTML='<div class="mapping-notice"><b>Insurance company added and chosen</b><p>Finish the coverage details, then save the coverage.</p></div>';notice('Insurance company added and chosen for this coverage.');return;}
 if(f.id==='payer-form'){const reason=data.reason;delete data.reason;data.active=data.active==='true';const body={content:data,reason};if(!f.dataset.id){body.request_id=f.dataset.request;body.source_history_id=f.dataset.source||null;}await api(`/api/v1/billing/payers${f.dataset.id?'/'+f.dataset.id:''}`,f.dataset.id?'PUT':'POST',body,f.dataset.id?Number(f.dataset.version):undefined);await showBillingQueue(billingQueueStatus,undefined,true);notice('Insurer saved.');return;}
 if(f.id==='coverage-form'){const reason=data.reason;delete data.reason;if(!data.status)data.status='active';data.subscriber_birth_date=data.subscriber_birth_date||null;data.end_date=data.end_date||null;data.copay_cents=cents(data.copay,true);delete data.copay;const body={content:data,reason};if(!f.dataset.id){body.request_id=f.dataset.request;body.source_history_id=f.dataset.source||null;}await api(`/api/v1/patients/${selected}/coverages${f.dataset.id?'/'+f.dataset.id:''}`,f.dataset.id?'PUT':'POST',body,f.dataset.id?Number(f.dataset.version):undefined);}
  // A record from the previous system still becomes a draft through one reviewed step; the
 // reason and the acknowledgement travel with it. Editing a draft saves itself.
 if(f.id==='billing-account-form'){
  if(f.dataset.patient&&f.dataset.patient!==selected)throw new Error('Patient changed; reopen the charge draft.');
  if(f.dataset.draftStale||f.dataset.draftReadOnly)throw new Error('Review the saved account before using retained charge edits.');
  if(f.dataset.autosave!=='off')throw new Error('These charges save as you edit them; nothing needs to be pressed.');
  const submitted=billingChargeMarkup(f);
  const body={content:{visit_id:data.visit_id||null,coverage_id:data.coverage_id||null,service_date:data.service_date,currency:'USD',lines:chargeLiveRows(f).map(chargeRowValue),notes:data.notes,...(typeof feeContextValue==='function'&&feeContextValue(f)?{fee_context:feeContextValue(f)}:{})},reason:data.reason,request_id:f.dataset.request,source_history_id:f.dataset.source||null};
  const a=await api(billingBase(),'POST',body);
  billingChargeSaved(f,a,submitted);billingSelected=a.id;
 }
 if(f.id==='billing-account-action'){const a=workspace.billing.accounts.find(a=>a.id===(f.dataset.account||billingSelected));if(!data.action)throw new Error('Choose the action to record.');data.local_only=data.local_only==='true';await api(`${billingBase()}/${a.id}/actions`,'POST',data,a.version);}
 if(f.id==='billing-ledger-form'){const a=workspace.billing.accounts.find(a=>a.id===billingSelected);const body=f.dataset.reverses?{request_id:f.dataset.request,kind:'reversal',amount_cents:null,reverses_id:f.dataset.reverses,party:'other',method:'none',reference:'',occurred_on:data.occurred_on,reason:data.reason}:{request_id:f.dataset.request,kind:data.kind,amount_cents:cents(data.amount),reverses_id:null,party:data.party,method:data.method,reference:data.reference,occurred_on:data.occurred_on,reason:data.reason};await api(`${billingBase()}/${a.id}/entries`,'POST',body,a.version);}
 await selectPatient(selected,activeVisit?.id);showChartSection(returnSection==='insurance'?'insurance':returnSection==='visits'?'visits':'billing');if(returnSection==='visits'&&typeof showEncounterSection==='function')showEncounterSection('charges');notice(f.id==='billing-account-form'?'Charges saved.':f.id==='billing-account-action'?(data.action==='void'?'Charges removed.':'Charges posted.'):f.id==='billing-ledger-form'?'Payment or adjustment saved.':f.id==='coverage-payer-form'?'Insurer saved.':'Insurance saved.');});});
// A code that names an injected drug shows its NDC fields inside the row as it is typed; any other code hides them unless they already hold something.
document.addEventListener('input',event=>{
 if(!['code','procedure'].includes(event.target?.name)||!event.target.closest?.('#billing-charge-lines'))return;
 const row=event.target.closest('.billing-charge-row');if(!row)return;
 const typed=String(row.querySelector('[name="procedure"]')?.value||'').split(':')[0],code=event.target.name==='procedure'?typed:row.querySelector('[name="code"]')?.value||typed;
 const drug=row.querySelector('.charge-drug');if(drug){const kept=[...drug.querySelectorAll('input,select')].some(field=>field.value);drug.hidden=!chargeIsDrugCode(code)&&!kept;}
});
document.addEventListener('change',e=>{const select=e.target.closest('#billing-filter select[name="status"]');if(!select)return;run(()=>showBillingQueue(select.value,undefined,true));});

const accountDiagnosisLinkDrafts=new Map(),accountDiagnosisLinkBaselines=new WeakMap(),accountDiagnosisLinkPending=new Set();let accountDiagnosisLinkGeneration=0;
function accountDiagnosisLinkValues(form){return {visit_version:Number(form.dataset.visitVersion),lines:Array.from(form.querySelectorAll('[data-diagnosis-line]'),line=>({line_index:Number(line.dataset.diagnosisLine),diagnosis_ids:Array.from(line.querySelectorAll('[name="diagnosis_id"]:checked'),item=>item.value)})),reason:new FormData(form).get('reason')||''};}
function captureAccountDiagnosisLinkDraft(){const form=$('account-diagnoses-form');if(!form)return;const baseline=accountDiagnosisLinkBaselines.get(form);if(!baseline)return;const values=accountDiagnosisLinkValues(form),key=form.dataset.patient+':'+form.dataset.account;if(JSON.stringify(values)===baseline&&!accountDiagnosisLinkPending.has(key))accountDiagnosisLinkDrafts.delete(key);else accountDiagnosisLinkDrafts.set(key,{patient:form.dataset.patient,account:form.dataset.account,version:Number(form.dataset.version),values});}
function resetAccountDiagnosisLinkDrafts(){accountDiagnosisLinkDrafts.clear();accountDiagnosisLinkPending.clear();accountDiagnosisLinkGeneration++;accountDiagnosisLinkReview=null;}
function accountDiagnosisSummary(snapshot){
 return snapshot?`<section><h4>Visit diagnosis links recorded at posting</h4><p class="muted">Visit v${esc(snapshot.visit_version)}. These saved links do not follow later visit edits.</p>${snapshot.lines.map(line=>`<p>Charge line ${line.line_index+1}: ${line.diagnoses.map(d=>esc(d.code)+' · '+esc(d.display)).join('; ')}</p>`).join('')}</section>`:'';
}
function accountDiagnosisDraftRecovery(a){
 const draft=accountDiagnosisLinkDrafts.get(selected+':'+a.id);if(!draft||a.status==='draft')return '';
 return `<section role="status"><p>Unapplied charge diagnosis edits remain in this tab. They are not part of this finalized account.</p><details><summary>View/copy unapplied charge diagnosis draft</summary><label>Unapplied charge diagnosis draft<textarea readonly>${esc(JSON.stringify(draft.values,null,2))}</textarea></label></details><button type="button" data-discard-account-link-draft="${esc(a.id)}">Discard unapplied charge diagnosis draft</button></section>`;
}
function accountDiagnosisEditorMarkup(a,data,patient){
 const draft=accountDiagnosisLinkDrafts.get(patient+':'+a.id),stale=!!draft&&(draft.version!==a.version||draft.values.visit_version!==data.version);
 return `<form id="account-diagnoses-form" data-patient="${esc(patient)}" data-account="${esc(a.id)}" data-version="${draft?.version??a.version}" data-visit-version="${draft?.values.visit_version??data.version}"><h3>Link visit diagnoses to charge lines</h3><p>The encounter codes you select are added to each line you select. Existing manual and previously added codes are retained. Review the charge table before posting.</p>${draft?'<p role="status">Unsaved selections retained in this tab.</p>':''}${stale?'<p role="status">The saved account or visit changed. Compare the saved links and current charge/diagnosis choices before saving. Unavailable diagnoses and removed lines cannot be linked.</p><button type="button" data-rebase-account-diagnoses>Keep available selections against current versions</button>':''}${accountDiagnosisSummary(a.diagnosis_snapshot)}${a.content.lines.map((line,index)=>{const ids=new Set((draft?.values.lines.find(item=>item.line_index===index)?.diagnosis_ids)||(a.diagnosis_snapshot?.lines.find(item=>item.line_index===index)?.diagnoses||[]).map(d=>d.id));return `<fieldset data-diagnosis-line="${index}"><legend>Charge ${index+1}: ${esc(line.code)} · ${esc(line.description)}</legend><p>Existing codes: ${line.diagnosis_codes.map(esc).join(', ')||'None'}</p><div class="scope-options">${data.diagnoses.map(d=>`<label><input type="checkbox" name="diagnosis_id" value="${esc(d.id)}" ${ids.has(d.id)?'checked':''}>${esc(d.code)} · ${esc(d.display)}</label>`).join('')||'<p>No saved visit diagnoses. Record diagnoses first, then reopen this editor.</p>'}</div></fieldset>`;}).join('')}<p class="muted">No selections clears provenance links only; diagnosis codes remain on charges for explicit manual review. Clear links before changing charge lines or the linked visit. Posted accounts cannot change diagnosis links.</p><label>Reason for this selection<input name="reason" required maxlength="1000" value="${esc(draft?.values.reason||'')}"></label><div class="actions"><button type="submit" ${stale?'disabled':''}>Save charge diagnosis links</button><button type="button" data-link-account-diagnoses>Reload saved versions</button><button type="button" data-cancel-billing>Cancel</button></div></form>`;
}
let accountDiagnosisLinkReview;
async function editAccountDiagnosisLinks(){
 captureAccountDiagnosisLinkDraft();
 const patient=selected,old=workspace.billing.accounts.find(row=>row.id===billingSelected),host=$('billing-editor'),account=me,generation=++accountDiagnosisLinkGeneration;
 if(!old?.content.visit_id||old.status!=='draft'||!billingCan())return;
 if(host.querySelector?.('form:not(#account-diagnoses-form)')&&!await confirmAction('Unsaved entries in the open billing form will be lost.',{title:'Open diagnosis linking?',confirmLabel:'Replace editor',tone:'danger'}))return;
 const [list,data]=await Promise.all([api(`/api/v1/patients/${patient}/billing`),api(`/api/v1/visits/${old.content.visit_id}/diagnoses`)]);
 if(selected!==patient||billingSelected!==old.id||$('billing-editor')!==host||me!==account||generation!==accountDiagnosisLinkGeneration)return;
 captureAccountDiagnosisLinkDraft();const a=list.accounts.find(row=>row.id===old.id);
 if(a&&a.status!=='draft'){openBillingEditor(accountDiagnosisSummary(a.diagnosis_snapshot)+accountDiagnosisDraftRecovery(a));return;}
 if(!a||a.content.visit_id!==old.content.visit_id)throw new Error('Account changed. Reload the patient chart before linking diagnoses.');
 accountDiagnosisLinkReview={a,data,patient};openBillingEditor(accountDiagnosisEditorMarkup(a,data,patient));
 const form=$('account-diagnoses-form');if(form)accountDiagnosisLinkBaselines.set(form,JSON.stringify({visit_version:data.version,lines:a.content.lines.map((_,index)=>({line_index:index,diagnosis_ids:(a.diagnosis_snapshot?.lines.find(l=>l.line_index===index)?.diagnoses||[]).filter(d=>data.diagnoses.some(current=>current.id===d.id)).map(d=>d.id)})),reason:''}));
}
document.addEventListener('input',event=>{if(event.target.closest?.('#account-diagnoses-form'))captureAccountDiagnosisLinkDraft();});
document.addEventListener('change',event=>{if(event.target.closest?.('#account-diagnoses-form'))captureAccountDiagnosisLinkDraft();});
document.addEventListener('click',async event=>{
 const discard=event.target.closest?.('[data-discard-account-link-draft]');if(discard){event.preventDefault();if(!await confirmAction('Unapplied charge diagnosis edits retained in this tab will be removed.',{title:'Discard charge diagnosis edits?',confirmLabel:'Discard edits',tone:'danger'}))return;accountDiagnosisLinkDrafts.delete(selected+':'+discard.dataset.discardAccountLinkDraft);const host=$('billing-editor');if(host)host.replaceChildren();if(workspace.billing.accounts.some(a=>a.id===discard.dataset.discardAccountLinkDraft))showBillingAccount(discard.dataset.discardAccountLinkDraft,false);return;}
 if(event.target.closest?.('[data-link-account-diagnoses]')){event.preventDefault();run(editAccountDiagnosisLinks);return;}
 if(event.target.closest?.('[data-rebase-account-diagnoses]')){event.preventDefault();captureAccountDiagnosisLinkDraft();const review=accountDiagnosisLinkReview,form=$('account-diagnoses-form');if(!review||!form||selected!==review.patient)return;const key=review.patient+':'+review.a.id,draft=accountDiagnosisLinkDrafts.get(key);if(!draft)return;draft.version=review.a.version;draft.values.visit_version=review.data.version;draft.values.lines=accountDiagnosisLinkValues(form).lines;form.dataset.version=String(draft.version);form.dataset.visitVersion=String(draft.values.visit_version);const submit=form.querySelector('[type="submit"]');if(submit)submit.disabled=false;}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='account-diagnoses-form')return;event.preventDefault();
 run(async()=>{
  const patient=form.dataset.patient;if(selected!==patient)throw new Error('Patient changed; reopen the diagnosis editor.');
  const account=me,id=form.dataset.account,key=patient+':'+id,generation=accountDiagnosisLinkGeneration;
  if(accountDiagnosisLinkPending.has(key))throw new Error('A diagnosis link save is already in progress.');
  captureAccountDiagnosisLinkDraft();const body=accountDiagnosisLinkValues(form);accountDiagnosisLinkPending.add(key);
  try{await api(`/api/v1/patients/${patient}/billing/accounts/${id}/diagnoses`,'PUT',body,Number(form.dataset.version));}finally{accountDiagnosisLinkPending.delete(key);}
  if(me!==account||generation!==accountDiagnosisLinkGeneration)return;
  if($('account-diagnoses-form')===form)captureAccountDiagnosisLinkDraft();
  const draft=accountDiagnosisLinkDrafts.get(key);
  if(draft&&JSON.stringify(draft.values)!==JSON.stringify(body)){notice('Charge links saved. Newer edits remain unsaved; reload saved versions to compare before saving again.');return;}
  accountDiagnosisLinkBaselines.set(form,JSON.stringify(body));accountDiagnosisLinkDrafts.delete(key);
  if(selected!==patient)return;
  const section=typeof chartSection==='undefined'?'billing':chartSection;
  billingSelected=id;await selectPatient(patient,activeVisit?.id);showChartSection(section);notice('Charge diagnosis links saved; existing codes kept for review.');
 });
});

const showBillingQueueWithoutClaimMdCard=showBillingQueue;
showBillingQueue=async function(...args){
 await showBillingQueueWithoutClaimMdCard(...args);
 if((typeof renderBillingOverview==='function'&&args[2]!==true)||(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims')))return;
 const heading=$('billing-tool')?.querySelector('.section-head');
 const subtitle=heading?.querySelector('.muted');
 if(subtitle)subtitle.textContent='Patient coverage, charges and connected revenue-cycle workflows';
 if(heading)heading.insertAdjacentHTML('afterend',claimMdConnectionCard());
 registerBillingQueueAutoRefresh();
};
// The worklist keeps itself current: no Refresh button, no popup on failure,
// and a quiet "Updated …" line in its header. The payer directory only needs
// the account rows, so that one request is refreshed in place; the table body
// is left untouched until the data actually changed.
function billingQueueRowsMarkup(items){return items.map(a=>`<tr><td><b>${esc(a.patient_name)}</b><small>${esc(a.mrn)} · ${esc(a.service_date)}</small></td><td><span class="pill">${esc(displayStatus(a.status))}</span></td><td>${esc(a.status==='draft'?'Not captured':a.payer_name||'Self-pay')}</td><td class="money-cell">${money(a.total_cents)}</td><td class="money-cell">${a.balance_cents==null?'—':money(a.balance_cents)}</td><td>${typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical')?`<button type="button" data-billing-patient="${a.patient_id}" data-account="${a.id}">Open billing</button>`:''}</td></tr>`).join('');}
function registerBillingQueueAutoRefresh(){
 if(typeof registerAutoRefresh!=='function')return;
 const host=$('billing-tool');if(!host)return;
 unregisterAutoRefresh('billing-queue');
 registerAutoRefresh('billing-queue',{host,load:async()=>{
  if($('billing-tool')!==host||host.isConnected===false)return autoRefreshStop();
  const query=new URLSearchParams();if(billingQueueStatus)query.set('status',billingQueueStatus);
  const data=await api(`/api/v1/billing/worklist?${query}`);
  if($('billing-tool')!==host||host.isConnected===false)return autoRefreshStop();
  const markup=billingQueueRowsMarkup(data.items);
  const rows=host.querySelector('.billing-table tbody');
  // The screen repaints its own table; returning no markup keeps the shared
  // helper from replacing the whole screen, and an unchanged table is not
  // touched at all.
  if(rows&&rows.innerHTML!==markup)rows.innerHTML=markup;
  return undefined;
 },everyMs:30000});
}

function patientInvoiceEditor(){
 const a=workspace.billing.accounts.find(a=>a.id===billingSelected);if(!a||a.status!=='posted')throw new Error('Open a posted account first.');
 openBillingEditor(`<form id="patient-invoice-form" data-account="${esc(a.id)}" data-version="${a.version}" data-request="${crypto.randomUUID()}"><h3>Review patient invoice</h3><p>Gross service charges: ${money(a.total_cents)}. Enter the total reviewed patient responsibility before recorded copays and patient credits. Insurance responsibility must be excluded.</p><label>Total patient responsibility (USD)<input name="responsibility" required inputmode="decimal" placeholder="Reviewed patient amount before copay"></label><label>Responsibility evidence / reason<input name="reason" required maxlength="1000" placeholder="For example, reviewed plan copay or payer adjudication"></label><label class="review-ack"><input type="checkbox" required> I reviewed patient responsibility and recorded payments. This invoice does not collect payment or send an insurance claim.</label><button type="submit" class="primary">Save patient invoice</button></form>`);
}
async function showPatientInvoices(){
 const data=await api(`${billingBase()}/${billingSelected}/invoices`);
 openBillingEditor(`<h3>Saved patient invoices</h3><p class="muted">Each invoice retains the account balance and reviewed responsibility at issuance. Review current ledger activity before requesting any payment.</p>${data.items.map(i=>`<p><button type="button" data-patient-invoice="${esc(i.id)}">${esc(date(i.created_at))} · ${money(i.snapshot.amount_due_cents)} at issuance</button></p>`).join('')||'<p>No saved patient invoices for this account.</p>'}`);
}
// The sidebar logo is rendered only from the server-approved immutable Connect
// asset. Never accept a logo URL from invoice, receipt, patient or form content.
function patientPrintBranding(practiceName){
 const name=String(practiceName||''),current=document.querySelector?.('.practice-identity strong')?.textContent?.trim();
 if(!name.trim()||name.trim()!==current)return {name,logo:null};
 const raw=document.querySelector?.('.practice-identity-logo img')?.getAttribute?.('src');
 try{
  const url=new URL(raw),local=url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash||!/^\/api\/v1\/managed-ehr\/branding\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname))return {name,logo:null};
  return {name,logo:url.href};
 }catch{return {name,logo:null};}
}
function patientPrintHead(title,branding){
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src ${branding.logo?esc(branding.logo):"'none'"}; base-uri 'none'; form-action 'none'"><title>${esc(title)}</title><link rel="stylesheet" href="/patient-print.css"></head>`;
}
function patientPrintHeader(title,branding){
 return `<header class="document-header">${branding.logo?`<img class="practice-print-logo" src="${esc(branding.logo)}" alt="Current practice logo" referrerpolicy="no-referrer">`:''}<div class="document-identity">${branding.name?`<p class="practice-print-name">${esc(branding.name)}</p>`:''}<h1>${esc(title)}</h1></div></header>`;
}
function patientPrintFooter(){return '<p class="powered-by">Powered by P.Industries · SunCharts Connected EHR</p>';}
function patientInvoiceDocument(invoice){
 const s=invoice.snapshot,branding=patientPrintBranding(invoice.snapshot.practice_name),testLabel=invoice.snapshot.test_activity&&typeof testPaymentLabel==='function'?testPaymentLabel():'',title=(testLabel?testLabel+' - ':'')+'Patient invoice';
 const services=Array.isArray(s.services)?`<h2>Services</h2><p>Service charges include amounts billed to insurance. Your reviewed amount appears below.</p><table><thead><tr><th>Service / code</th><th>Quantity</th><th class="amount">Line total</th></tr></thead><tbody>${s.services.map(line=>`<tr><td>${esc(line.description)}<small>${esc(line.code_system)} ${esc(line.code)}${line.modifiers?' · Modifiers '+esc(line.modifiers):''}</small></td><td>${esc(line.units)}</td><td class="amount">${money(line.line_total_cents)}</td></tr>`).join('')}</tbody></table>`:'<p>Itemized services were not saved with this older invoice. The original invoice totals are shown below.</p>';
 const activity=Array.isArray(s.patient_activity)?`<h2>Patient payment activity at issuance</h2>${s.patient_activity.length?`<table><thead><tr><th>Date / activity</th><th>Method / reference</th><th class="amount">Balance change</th></tr></thead><tbody>${s.patient_activity.map(entry=>`<tr><td>${esc(entry.occurred_on)}<small>${esc(invoiceActivityLabel(entry.kind))}</small></td><td>${esc(invoicePaymentMethod(entry.method))}${entry.reference?`<small>${esc(entry.reference)}</small>`:''}</td><td class="amount">${money(entry.effect_cents)}</td></tr>`).join('')}</tbody></table><p><small>Negative amounts reduce the balance; positive amounts increase it.</small></p>`:'<p>No patient payments or adjustments were recorded when this invoice was issued.</p>'}`:'<p>Individual payment details were not saved with this older invoice.</p>';
 const creditDetail=Number.isFinite(s.patient_payment_cents)&&Number.isFinite(s.patient_adjustment_credit_cents)?`<dt>Net recorded patient payments</dt><dd>${money(s.patient_payment_cents)}</dd><dt>Net patient adjustments / other credits</dt><dd>${money(s.patient_adjustment_credit_cents)}</dd>`:'';
 return `${patientPrintHead(title,branding)}<body class="patient-invoice">${patientPrintHeader(title,branding)}<section class="document-meta"><div><span class="document-label">Bill to</span><p class="patient-print-name">${esc(s.patient.given_name)} ${esc(s.patient.family_name)}</p>${s.patient.mrn?`<small>MRN ${esc(s.patient.mrn)}</small>`:''}</div><div class="document-reference"><span class="document-label">Invoice details</span><small>Invoice ${esc(invoice.id)}<br>Issued ${esc(date(invoice.created_at))}<br>Service ${esc(s.service_date)}</small></div></section><section class="document-total"><span>Amount due at issuance</span><strong>${money(s.amount_due_cents)}</strong></section>${services}<h2>Patient amount</h2><dl><dt>Gross service charges</dt><dd>${money(s.gross_charges_cents)}</dd><dt>Reviewed patient responsibility before credits</dt><dd>${money(s.responsibility_cents)}</dd>${creditDetail}<dt>Total net patient payments and credits</dt><dd>${money(s.patient_credit_cents)}</dd><dt class="total-label">Amount due at issuance</dt><dd class="total-value">${money(s.amount_due_cents)}</dd>${s.credit_balance_cents?`<dt>Patient credit balance at issuance</dt><dd>${money(s.credit_balance_cents)}</dd>`:''}</dl>${activity}<footer>${testLabel?'<p class="copay-mode-label">Includes test payments</p>':''}<p>Amounts reflect the ledger at issuance. Later payments or adjustments are not reflected on this copy. Contact the practice to confirm the current amount before making a payment.</p>${branding.logo?'<small>Practice logo reflects current branding; invoice details remain as issued.</small>':''}${patientPrintFooter()}</footer></body></html>`;
}
function invoiceActivityLabel(kind){return {payment:'Payment received',adjustment_credit:'Adjustment credit',adjustment_debit:'Adjustment / refund debit',reversal:'Reversal'}[kind]||'Recorded activity';}
function invoicePaymentMethod(method){return {cash:'Cash',check:'Check',external:'External payment',card:'Card',none:'—'}[method]||method||'—';}
function showPatientInvoice(invoice){
 if(!invoice)throw new Error('Invoice unavailable; reload saved invoices.');
 openBillingEditor('<div class="section-head"><h3>Patient invoice</h3><button type="button" data-print-patient-invoice>Print / save PDF</button></div><p class="muted">Saved copy of the invoice. Nothing was emailed, charged or submitted to insurance.</p><div id="patient-invoice-preview"></div>');
 const frame=document.createElement('iframe');frame.id='patient-invoice-frame';frame.title='Patient invoice print preview';frame.className='avs-print-frame';frame.setAttribute('sandbox','allow-same-origin allow-modals');frame.srcdoc=patientInvoiceDocument(invoice);$('patient-invoice-preview').append(frame);
}
