// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

let claimmdProviderDefaults={providers:[],facilities:[]};
async function loadClaimmdProviderDefaults(){const identity=me,data=await api('/api/v1/billing/claimmd/provider-defaults');if(me!==identity)throw new Error('Session changed; reload the provider directory.');claimmdProviderDefaults=data;return data;}
const claimmdEligibilityContexts=new WeakMap();
let claimmdEligibilityGeneration=0;
function claimmdClaimProviderDefaults(){
 const provider=claimmdProviderDefaults.providers?.find(item=>item.id===claimmdProviderDefaults.default_provider_id)||(claimmdProviderDefaults.providers?.length===1?claimmdProviderDefaults.providers[0]:null);
 const facility=claimmdProviderDefaults.facilities?.find(item=>item.id===claimmdProviderDefaults.default_facility_id)||(claimmdProviderDefaults.facilities?.length===1?claimmdProviderDefaults.facilities[0]:null);
 return {billing_provider_name:facility?.name||provider?.display_name||'',billing_npi:provider?.npi||'',rendering_npi:provider?.npi||'',billing_address:facility?.address||'',tax_id:''};
}

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

function claimmdBenefitValue(benefit){
 const decimal=value=>typeof value==='number'||typeof value==='string'&&/^\d+(?:\.\d{1,2})?$/.test(value)?Number(value):NaN;
 const amount=decimal(benefit.benefit_amount),percent=decimal(benefit.benefit_percent);
 const values=[];
 if(Number.isFinite(amount)&&amount>=0)values.push(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount));
 if(Number.isFinite(percent)&&percent>=0&&percent<=100)values.push(`${percent}%`);
 return values.join(' · ')||'Not returned';
}
function claimmdBenefitContext(benefit){
 const network={Y:'In network',N:'Out of network',W:'Network not applicable'}[benefit.inplan_network]||'Network not specified';
 return [benefit.benefit_description||benefit.benefit_code,network,benefit.benefit_level_description||benefit.benefit_level_code,benefit.benefit_period_description||benefit.benefit_period_code,benefit.benefit_notes].filter(Boolean).join(' · ');
}
function claimmdBenefitSummary(check){
 if(check?.status!=='completed')return '';
 const plans=Array.isArray(check.response_snapshot?.elig)?check.response_snapshot.elig:[];
 const categories=[['B','Copay'],['A','Coinsurance'],['C','Deductible'],['G','Out-of-pocket limit']];
 const rows=plans.flatMap(plan=>(Array.isArray(plan.benefit)?plan.benefit:plan.benefit&&typeof plan.benefit==='object'?[plan.benefit]:[]).map(benefit=>({benefit,plan:plan.insurance_plan})));
 return `<div class="eligibility-benefits"><h4>Returned patient benefits</h4>${categories.map(([code,label])=>{const found=rows.filter(row=>row.benefit.benefit_coverage_code===code);return `<div><b>${label}</b>${found.length?found.map(({benefit,plan})=>`<p><strong>${esc(claimmdBenefitValue(benefit))}</strong><small>${esc([plan,claimmdBenefitContext(benefit)].filter(Boolean).join(' · '))}</small></p>`).join(''):'<p class="muted">Not returned</p>'}</div>`;}).join('')}<p class="muted">Use the benefit for this visit’s service, network and coverage level. These returned benefits do not change the recorded copay or confirm payment.</p></div>`;
}
function claimmdPayerEligibilityMessages(item){
 const errors=Array.isArray(item.error)?item.error:item.error?[item.error]:[];
 if(!errors.length)return '';
 return `<div class="notice"><b>Payer response requires review</b>${errors.slice(0,10).map(error=>{const message=typeof error==='string'?error:error.error_message||error.error_mesg||error.message||'Payer returned an eligibility message; review the saved response.';const code=typeof error==='object'&&/^\d{1,6}$/.test(String(error.error_code||''))?error.error_code:'';return `<p>${code?'Code '+esc(code)+' · ':''}${esc(String(message).slice(0,1000))}</p>`;}).join('')}<p>Review the returned benefits and service date. This message alone does not establish the patient’s coverage.</p></div>`;
}
function claimmdEligibilityRows(check){
 const response=check.response_snapshot||{},elig=Array.isArray(response.elig)?response.elig:[];
 return claimmdBenefitSummary(check)+elig.map(item=>{
  const benefits=Array.isArray(item.benefit)?item.benefit:item.benefit&&typeof item.benefit==='object'?[item.benefit]:[];
  return `<section class="billing-section"><div class="section-head"><h4>${esc(item.insurance_plan||'Eligibility response')}</h4><span class="pill">${esc(item.eligid||'No response ID')}</span></div>${claimmdPayerEligibilityMessages(item)}<dl class="billing-dl"><dt>Member</dt><dd>${esc(item.ins_name_f||'')} ${esc(item.ins_name_l||'')} · ${esc(item.ins_number||'Not returned')}</dd><dt>Plan period</dt><dd>${esc(item.plan_begin_date||'Not returned')} – ${esc(item.plan_end_date||'Not returned')}</dd><dt>Group</dt><dd>${esc(item.group_number||'Not returned')}</dd></dl><details><summary>All returned benefits (${benefits.length})</summary><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Benefit</th><th>Coverage</th><th>Service / network / period</th><th>Amount</th></tr></thead><tbody>${benefits.map(benefit=>`<tr><td>${esc(benefit.benefit_description||benefit.benefit_code||'—')}<small>${esc(benefit.insurance_type_description||'')}</small></td><td>${esc(benefit.benefit_coverage_description||benefit.benefit_coverage_code||'—')}</td><td>${esc(claimmdBenefitContext(benefit))}</td><td>${esc(claimmdBenefitValue(benefit))}</td></tr>`).join('')||'<tr><td colspan="4">No benefit rows were returned.</td></tr>'}</tbody></table></div></details><details><summary>Original structured response</summary><pre class="billing-source">${esc(JSON.stringify(item,null,2))}</pre></details></section>`;
 }).join('')||'<p>No structured eligibility rows were returned.</p>';
}
function claimmdEligibilityFailure(check){
 const failure=check.response_snapshot?.failure,codes=Array.isArray(failure?.provider_codes)?failure.provider_codes.filter(code=>/^\d{1,6}$/.test(String(code))):[];
 if(!failure)return '<p class="notice error">The request failed. This older check did not retain a diagnostic code, so its cause cannot be determined here. Review the saved provider, tax identity and Claim.MD connection before retrying.</p>';
 let action='Review the selected provider and billing organization, subscriber details and payer requirements. If these are correct, provide the saved diagnostic code and check time to Claim.MD support.';
 if(failure.kind==='transport_unavailable')action='Claim.MD could not be reached. Retry later; this does not establish whether coverage is active.';
 else if(failure.kind==='configuration_unavailable')action='Ask the practice owner to review the Claim.MD connection in Claim connections.';
 else if(failure.kind==='response_invalid')action='Claim.MD returned an unsupported response. Ask support to review this check; coverage remains unknown.';
 else if(failure.http_status===401)action='Claim.MD denied authentication. Ask the practice owner to test and review the saved Claim.MD connection.';
 else if(failure.http_status===403||failure.http_status===429)action='Claim.MD restricted the request. This can be a temporary API rate limit or access restriction. Wait at least one minute; if it persists, ask the owner to review the connection.';
 else if(failure.http_status>=500)action='Claim.MD reported a service error. Retry later; coverage remains unknown.';
 return `<div class="notice error"><b>Eligibility request failed${failure.kind==='provider_rejected'?' — Claim.MD rejected the request':''}</b><p>${esc(action)}</p><p>${failure.http_status?'HTTP '+esc(failure.http_status)+' · ':''}${codes.length?'Claim.MD code '+codes.map(esc).join(', '):'No diagnostic code returned'}</p><p>No completed benefits were returned. This does not mean the patient is uninsured.</p></div>`;
}
function claimmdEligibilityHistory(items){
 return `<h3>Eligibility history</h3>${items.map(check=>`<details class="amendment" ${check.status==='completed'?'open':''}><summary>${esc(check.status==='completed'?'Response received':human(check.status))} · ${esc(date(check.completed_at||check.created_at))}${check.request_snapshot?.request?.service_date?' · Service '+esc(check.request_snapshot.request.service_date):''}</summary>${check.status==='completed'?claimmdEligibilityRows(check):(check.status==='pending'?'<p>Awaiting the eligibility response.</p>':claimmdEligibilityFailure(check))}<p class="muted">Requested by ${esc(check.actor_id)}</p></details>`).join('')||'<p>No eligibility checks have been recorded for this coverage.</p>'}`;
}

async function openClaimmdEligibility(coverage,options={}){
 const opening=++claimmdEligibilityGeneration;
 const patientId=selected,identity=me,editor=typeof billingEditorHost==='function'?billingEditorHost():$('billing-editor'),patient=workspace.patient,serviceDate=options.serviceDate||new Date().toISOString().slice(0,10);
 let editorAnchor=editor?.firstElementChild;
 const visitId=typeof activeVisit==='undefined'?null:activeVisit?.id,section=typeof chartSection==='undefined'?null:chartSection;
 const current=()=>opening===claimmdEligibilityGeneration&&editor?.firstElementChild===editorAnchor&&selected===patientId&&me===identity&&(typeof activeVisit==='undefined'||activeVisit?.id===visitId)&&(typeof chartSection==='undefined'||chartSection===section)&&(typeof billingEditorHost==='function'?billingEditorHost():$('billing-editor'))===editor&&(!options.isCurrent||options.isCurrent());
 if(!current())return;
 const history=options.history||await api(`/api/v1/patients/${patientId}/coverages/${coverage.id}/claimmd-eligibility`);if(!current())return;
 const subscriber=claimmdSubscriberParts(coverage.content.subscriber_name),canRequest=!options.readOnly&&billingWrite()&&coverage.content.status==='active'&&(typeof billingCan!=='function'||billingCan('create'));
 const directory=canRequest?await loadClaimmdProviderDefaults():{providers:[],billing_organizations:[]};if(!current())return;
 const providers=directory.providers||[],organizations=directory.billing_organizations||[];
 const preferredProvider=providers.find(row=>row.id===(typeof activeVisit==='undefined'?null:activeVisit?.clinician_id))?.id||directory.default_provider_id||'';
 const providerOptions=providers.map(row=>`<option value="${esc(row.id)}" ${row.id===preferredProvider?'selected':''}>${esc(row.display_name)} · NPI ${esc(row.npi)}</option>`).join('');
 const orgOptions=organizations.map(row=>`<option value="${esc(row.id)}">${esc(row.name)} · ${esc(row.tax_id_type==='E'?'EIN':'SSN')} ending ${esc(row.tax_id_last4)}</option>`).join('');
 const identityFields=`<label>Provider<select name="provider_id" required><option value="">Select a practice provider</option>${providerOptions}</select></label><label>Billing organization and tax ID<select name="billing_organization_id" required><option value="">Select a billing organization</option>${orgOptions}</select></label><p class="muted">Use the provider and billing organization the payer has on file for the practice.</p>${!providers.length||!organizations.length?`<div class="notice error"><p>Before checking eligibility, the practice needs ${[!organizations.length?'a billing organization with its tax ID':'',!providers.length?'a provider with an NPI':''].filter(Boolean).join(' and ')}.${me?.role==='owner'?'':' Ask the practice owner to add this in Practice administration.'}</p>${me?.role==='owner'?`${!organizations.length?'<button type="button" class="primary" data-billing-organizations>Add billing organization</button> ':''}${!providers.length?'<button type="button" class="primary" data-practice-providers>Add provider</button>':''}`:''}</div>`:me?.role==='owner'?'<button type="button" data-billing-organizations>Billing organizations</button> <button type="button" data-practice-providers>Providers</button>':''}`;
 openBillingEditor(`<section><div class="section-head"><div><h3>${canRequest?'Check Claim.MD eligibility':'Review Claim.MD eligibility'}</h3><p class="muted">${esc(payerName(coverage.content.payer_id))} · member ${esc(coverage.content.member_id)}</p></div><button type="button" data-cancel-billing>Close</button></div><p>Submit a structured real-time eligibility request. A completed response is evidence returned by the payer; it is not a payment guarantee and does not change the coverage record.</p>${canRequest?`<form id="claimmd-eligibility-form" data-coverage="${esc(coverage.id)}" data-request="${crypto.randomUUID()}"><div class="form-grid">${billingField('insured_given_name','Subscriber given name',coverage.content.relationship==='self'?patient.given_name:subscriber.given,'text',100,true)}${billingField('insured_middle_name','Subscriber middle name',subscriber.middle,'text',100)}${billingField('insured_family_name','Subscriber family name',coverage.content.relationship==='self'?patient.family_name:subscriber.family,'text',100,true)}${billingField('insured_birth_date','Subscriber birth date',coverage.content.relationship==='self'?patient.birth_date:(coverage.content.subscriber_birth_date||''),'date')}${selectField('insured_sex','Subscriber administrative sex',['','F','M'],'')}${selectField('patient_sex','Patient administrative sex',['','F','M'],'')}${billingField('service_date','Service date',serviceDate,'date',0,true)}${billingField('service_codes','Benefit type codes (comma-separated)','30','text',200)}${billingField('procedure_code','CPT code instead of benefit types','','text',10)}${identityFields}${billingField('provider_name','Provider last name / organization name (if required by payer)','','text',200)}${billingField('provider_taxonomy','Provider taxonomy','','text',10)}</div><p class="muted">Use either benefit type codes or a CPT code, not both. Benefit type 30 requests general health-plan coverage.</p><button class="primary" type="submit" ${!providers.length||!organizations.length?'disabled':''}>Request eligibility</button></form>`:''}<div id="claimmd-eligibility-history">${claimmdEligibilityHistory(history.items)}</div></section>`);
 editorAnchor=editor?.firstElementChild;
 if(canRequest){const form=$('claimmd-eligibility-form');if(form)claimmdEligibilityContexts.set(form,{patientId,identity,coverageId:coverage.id,directory,current});}
}

function claimmdPayerRows(items,selectable=false){
 return `<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Payer</th><th>ID / type</th><th>Eligibility</th><th>Professional / institutional</th><th>ERA</th>${selectable?'<th></th>':''}</tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.payer_name||'Unnamed payer')}</b><small>${esc(item.payer_state||'')}</small></td><td>${esc(item.payerid||'—')}<small>${esc(item.payer_type||'')}</small></td><td>${esc(item.eligibility||'no')}</td><td>${esc(item['1500_claims']||'no')} / ${esc(item.ub_claims||'no')}</td><td>${esc(item.era||'no')}</td>${selectable?`<td><button type="button" data-claimmd-payer-select="${esc(item.payerid||'')}" data-payer-name="${esc(item.payer_name||'')}">Use payer</button></td>`:''}</tr>`).join('')||`<tr><td colspan="${selectable?6:5}">No matching payers returned.</td></tr>`}</tbody></table></div>`;
}

function claimmdCoveragePayerSearch(){return `<section class="billing-section"><h4>Find payer in Claim.MD</h4><form id="coverage-claimmd-payer-search" class="billing-filter"><label>Payer name<input name="name" minlength="2" maxlength="120" required></label><button type="submit">Search</button></form><div id="coverage-claimmd-payer-results"></div></section>`;}

document.addEventListener('click',event=>{
 const payer=event.target.closest('button[data-claimmd-payer-select]');
 if(payer){event.preventDefault();const native=(billingPayers||[]).find(item=>item.content.payer_code===payer.dataset.claimmdPayerSelect);if(native){const select=document.querySelector('#coverage-form select[name="payer_id"]');if(select){select.value=native.id;select.dispatchEvent(new Event('change',{bubbles:true}));}notice('Existing native payer selected.');return;}const form=document.querySelector('#coverage-payer-form');if(form){form.elements.name.value=payer.dataset.payerName;form.elements.payer_code.value=payer.dataset.claimmdPayerSelect;notice('Payer details copied. Review and add the payer to use it.');}return;}
 const button=event.target.closest('button[data-claimmd-eligibility]');
 if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{const coverage=workspace.billing.coverages.find(item=>item.id===button.dataset.claimmdEligibility);if(!coverage)throw new Error('Coverage is no longer available.');await openClaimmdEligibility(coverage,{serviceDate:typeof revenueServiceDate==='function'?revenueServiceDate():undefined});});
},true);

document.addEventListener('submit',event=>{
 const form=event.target;if(!['claimmd-eligibility-form','claimmd-payer-search','coverage-claimmd-payer-search'].includes(form.id))return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  const data=Object.fromEntries(new FormData(form));
  if(form.id==='claimmd-payer-search'||form.id==='coverage-claimmd-payer-search'){
   const payerid=(data.payerid||'').trim(),name=(data.name||'').trim();
   const query=new URLSearchParams();if(payerid)query.set('payerid',payerid);if(name)query.set('name',name);
   const result=await api(`/api/v1/billing/claimmd/payers?${query}`);$(form.id==='claimmd-payer-search'?'claimmd-payer-results':'coverage-claimmd-payer-results').innerHTML=claimmdPayerRows(result.items,form.id==='coverage-claimmd-payer-search');notice('Claim.MD payer directory refreshed.');return;
  }
  const context=claimmdEligibilityContexts.get(form);
  if(!context||!context.current()||$('claimmd-eligibility-form')!==form)throw new Error('Eligibility context changed; reopen the request for this encounter.');
  const provider=context.directory.providers.find(row=>row.id===data.provider_id),organization=context.directory.billing_organizations.find(row=>row.id===data.billing_organization_id);
  if(!provider||!organization)throw new Error('Select a practice provider and billing organization.');
  const serviceCodes=data.service_codes.split(',').map(value=>value.trim()).filter(Boolean);
  const body={request_id:form.dataset.request,service_date:data.service_date,service_codes:serviceCodes,procedure_code:data.procedure_code.trim()||null,insured_given_name:data.insured_given_name.trim(),insured_middle_name:data.insured_middle_name.trim()||null,insured_family_name:data.insured_family_name.trim(),insured_birth_date:data.insured_birth_date||null,insured_sex:data.insured_sex||null,patient_sex:data.patient_sex||null,provider_id:provider.id,provider_version:provider.version,billing_organization_id:organization.id,billing_organization_version:organization.version,provider_name:data.provider_name?.trim()||null,provider_taxonomy:data.provider_taxonomy.trim()||null};
  const {patientId,identity,coverageId}=context;
  let result,requestError;try{result=await api(`/api/v1/patients/${patientId}/coverages/${coverageId}/claimmd-eligibility`,'POST',body);}catch(error){requestError=error;}
  const history=await api(`/api/v1/patients/${patientId}/coverages/${coverageId}/claimmd-eligibility`);
  if(selected!==patientId||me!==identity||!context.current())return;
  if(typeof updateInsuranceEligibility==='function')updateInsuranceEligibility(coverageId,history);
  if($('claimmd-eligibility-form')!==form)return;
  $('claimmd-eligibility-history').innerHTML=claimmdEligibilityHistory(history.items);if(result||history.items?.some(check=>check.request_snapshot?.request?.request_id===body.request_id&&['failed','completed'].includes(check.status)))form.dataset.request=crypto.randomUUID();if(requestError)throw requestError;notice(`Eligibility response ${result.status}.`);
 });
},true);
