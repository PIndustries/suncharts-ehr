// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

function claimmdEligibilityButton(coverage){
 return billingWrite()&&coverage.content.status==='active'?`<button type="button" data-claimmd-eligibility="${esc(coverage.id)}">Check eligibility</button>`:'';
}

function claimmdPayerDirectoryPanel(){
 return `<section class="billing-section"><div class="section-head"><div><h3>Claim.MD payer directory</h3><p class="muted">Search the current Claim.MD directory and review eligibility, claims and ERA capabilities.</p></div></div><form id="claimmd-payer-search" class="billing-filter"><label>Payer ID<input name="payerid" maxlength="40"></label><label>Payer name<input name="name" minlength="2" maxlength="120"></label><button type="submit">Search Claim.MD</button></form><div id="claimmd-payer-results"></div></section>`;
}

function claimmdSubscriberParts(value){
 const parts=(value||'').trim().split(/\s+/).filter(Boolean);
 return {given:parts.shift()||'',family:parts.pop()||'',middle:parts.join(' ')};
}

function claimmdEligibilityRows(check){
 const response=check.response_snapshot||{},elig=Array.isArray(response.elig)?response.elig:[];
 return elig.map(item=>{
  const benefits=Array.isArray(item.benefit)?item.benefit:[];
  return `<section class="billing-section"><div class="section-head"><h4>${esc(item.insurance_plan||'Eligibility response')}</h4><span class="pill">${esc(item.eligid||'No response ID')}</span></div><dl class="billing-dl"><dt>Member</dt><dd>${esc(item.ins_name_f||'')} ${esc(item.ins_name_l||'')} · ${esc(item.ins_number||'Not returned')}</dd><dt>Plan period</dt><dd>${esc(item.plan_begin_date||'Not returned')}</dd><dt>Group</dt><dd>${esc(item.group_number||'Not returned')}</dd></dl><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Benefit</th><th>Coverage</th><th>Level / period</th><th>Network</th><th>Amount</th></tr></thead><tbody>${benefits.map(benefit=>`<tr><td>${esc(benefit.benefit_description||benefit.benefit_code||'—')}<small>${esc(benefit.insurance_type_description||'')}</small></td><td>${esc(benefit.benefit_coverage_description||benefit.benefit_coverage_code||'—')}</td><td>${esc([benefit.benefit_level_description,benefit.benefit_period_description].filter(Boolean).join(' · ')||'—')}</td><td>${esc(benefit.inplan_network||'—')}</td><td>${esc(benefit.benefit_amount??benefit.benefit_percent??'—')}</td></tr>`).join('')||'<tr><td colspan="5">No benefit rows were returned.</td></tr>'}</tbody></table></div><details><summary>Original structured response</summary><pre class="billing-source">${esc(JSON.stringify(item,null,2))}</pre></details></section>`;
 }).join('')||'<p>No structured eligibility rows were returned.</p>';
}

function claimmdEligibilityHistory(items){
 return `<h3>Eligibility history</h3>${items.map(check=>`<details class="amendment" ${check.status==='completed'?'open':''}><summary>${esc(human(check.status))} · ${esc(date(check.created_at))}</summary>${check.status==='completed'?claimmdEligibilityRows(check):'<p>The request did not produce a completed structured response.</p>'}<p class="muted">Requested by ${esc(check.actor_id)}</p></details>`).join('')||'<p>No eligibility checks have been recorded for this coverage.</p>'}`;
}

async function openClaimmdEligibility(coverage){
 const history=await api(`/api/v1/patients/${selected}/coverages/${coverage.id}/claimmd-eligibility`),subscriber=claimmdSubscriberParts(coverage.content.subscriber_name),patient=workspace.patient;
 openBillingEditor(`<section><div class="section-head"><div><h3>Check Claim.MD eligibility</h3><p class="muted">${esc(payerName(coverage.content.payer_id))} · member ${esc(coverage.content.member_id)}</p></div><button type="button" data-cancel-billing>Close</button></div><p>Submit a structured real-time eligibility request. A completed response is evidence returned by the payer; it is not a payment guarantee and does not change the coverage record.</p><form id="claimmd-eligibility-form" data-coverage="${esc(coverage.id)}" data-request="${crypto.randomUUID()}"><div class="form-grid">${billingField('insured_given_name','Subscriber given name',coverage.content.relationship==='self'?patient.given_name:subscriber.given,'text',100,true)}${billingField('insured_middle_name','Subscriber middle name',subscriber.middle,'text',100)}${billingField('insured_family_name','Subscriber family name',coverage.content.relationship==='self'?patient.family_name:subscriber.family,'text',100,true)}${billingField('insured_birth_date','Subscriber birth date',coverage.content.relationship==='self'?patient.birth_date:(coverage.content.subscriber_birth_date||''),'date')}${selectField('insured_sex','Subscriber administrative sex',['','F','M'],'')}${selectField('patient_sex','Patient administrative sex',['','F','M'],'')}${billingField('service_date','Service date',new Date().toISOString().slice(0,10),'date',0,true)}${billingField('service_codes','Benefit type codes (comma-separated)','30','text',200)}${billingField('procedure_code','CPT code instead of benefit types','','text',10)}${billingField('provider_npi','Provider NPI','','text',10,true)}${billingField('provider_taxid','Provider tax ID','','text',20,true)}${selectField('provider_taxid_type','Tax ID type',['E','S'],'E')}${billingField('provider_name','Provider organization / last name','','text',200)}${billingField('provider_taxonomy','Provider taxonomy','','text',10)}</div><p class="muted">Use either benefit type codes or a CPT code, not both. Benefit type 30 requests general health-plan coverage.</p><button class="primary" type="submit">Request eligibility</button></form><div id="claimmd-eligibility-history">${claimmdEligibilityHistory(history.items)}</div></section>`);
}

function claimmdPayerRows(items){
 return `<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Payer</th><th>ID / type</th><th>Eligibility</th><th>Professional / institutional</th><th>ERA</th></tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.payer_name||'Unnamed payer')}</b><small>${esc(item.payer_state||'')}</small></td><td>${esc(item.payerid||'—')}<small>${esc(item.payer_type||'')}</small></td><td>${esc(item.eligibility||'no')}</td><td>${esc(item['1500_claims']||'no')} / ${esc(item.ub_claims||'no')}</td><td>${esc(item.era||'no')}</td></tr>`).join('')||'<tr><td colspan="5">No matching payers returned.</td></tr>'}</tbody></table></div>`;
}

document.addEventListener('click',event=>{
 const button=event.target.closest('button[data-claimmd-eligibility]');
 if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{const coverage=workspace.billing.coverages.find(item=>item.id===button.dataset.claimmdEligibility);if(!coverage)throw new Error('Coverage is no longer available.');await openClaimmdEligibility(coverage);});
},true);

document.addEventListener('submit',event=>{
 const form=event.target;if(!['claimmd-eligibility-form','claimmd-payer-search'].includes(form.id))return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  const data=Object.fromEntries(new FormData(form));
  if(form.id==='claimmd-payer-search'){
   const query=new URLSearchParams();if(data.payerid.trim())query.set('payerid',data.payerid.trim());if(data.name.trim())query.set('name',data.name.trim());
   const result=await api(`/api/v1/billing/claimmd/payers?${query}`);$('claimmd-payer-results').innerHTML=claimmdPayerRows(result.items);notice('Claim.MD payer directory refreshed.');return;
  }
  const serviceCodes=data.service_codes.split(',').map(value=>value.trim()).filter(Boolean);
  const body={request_id:form.dataset.request,service_date:data.service_date,service_codes:serviceCodes,procedure_code:data.procedure_code.trim()||null,insured_given_name:data.insured_given_name.trim(),insured_middle_name:data.insured_middle_name.trim()||null,insured_family_name:data.insured_family_name.trim(),insured_birth_date:data.insured_birth_date||null,insured_sex:data.insured_sex||null,patient_sex:data.patient_sex||null,provider_npi:data.provider_npi.trim(),provider_taxid:data.provider_taxid.trim(),provider_taxid_type:data.provider_taxid_type,provider_name:data.provider_name.trim()||null,provider_taxonomy:data.provider_taxonomy.trim()||null};
  const result=await api(`/api/v1/patients/${selected}/coverages/${form.dataset.coverage}/claimmd-eligibility`,'POST',body);
  const history=await api(`/api/v1/patients/${selected}/coverages/${form.dataset.coverage}/claimmd-eligibility`);$('claimmd-eligibility-history').innerHTML=claimmdEligibilityHistory(history.items);form.dataset.request=crypto.randomUUID();notice(`Eligibility response ${result.status}.`);
 });
},true);
