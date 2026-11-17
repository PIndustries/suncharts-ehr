// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Review and send: the one place a finished charge becomes a claim that is with the insurer.
// The panel sits beside the charge table, lists what still has to be put right in words a
// front-desk person uses, shows the claim form itself, and then posts, prepares and sends in
// one go. Nothing here decides what is allowed: the server's own checks and Claim.MD's answer
// are what stop a send. The server never posts charges on its own, so this panel asks the
// person once and then does the whole chain for them.

// The chain in the order it runs. Each step says, in staff words, what it is doing while it
// runs and what it was when it had to stop.
const visitReviewStages=[
  {key:'check',label:'Read the claim as it stands now',doing:'Reading the claim as it stands now…',done:'Claim read',skip:''},
  {key:'post',label:'Post the charges',doing:'Posting the charges…',done:'Charges posted',skip:'Already posted'},
  {key:'prepare',label:'Fill in the claim',doing:'Filling in the claim from this visit…',done:'Claim filled in',skip:'Already filled in'},
  {key:'ready',label:'Check the claim',doing:'Checking the claim…',done:'Checked',skip:'Already checked'},
  {key:'send',label:'Send to Claim.MD',doing:'Sending to Claim.MD…',done:'Sent to Claim.MD',skip:''},
];
const visitReviewStageTitle={check:'the current claim being read',post:'the charges being posted',prepare:'the claim being filled in',ready:'the claim being checked',send:'the claim being sent'};
const claimsApiBase=typeof claimsBase!=='undefined'?claimsBase:'/api/v1/billing/claims';

function visitReviewButton(label,attributes=''){return `<button type="button"${attributes?` ${attributes}`:''}>${esc(label)}</button>`;}
function visitReviewLink(label,href){return `<a class="button" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;}
// Only what the CMS-1500 form actually holds, cut short so a long value can never widen the panel.
function visitReviewFormValue(value,max=34){
  const text=value==null?'':typeof value==='number'?money(value):String(value).trim();
  if(!text)return '';
  return text.length>max?`${text.slice(0,Math.max(1,max-1))}…`:text;
}

// One plain sentence, the group it is put right in, and whether the server or Claim.MD would
// refuse the claim until it is fixed.
function visitReviewCheck(key,options={}){
  return {key,group:options.group||'claim',level:options.blocking?'must':'note',text:options.text||'A detail needs a look.',
    action:options.action||'',attribute:options.attribute||'',fix:options.fix||''};
}
function visitReviewAccount(){return typeof encounterChargeAccount==='function'?encounterChargeAccount():null;}
function visitReviewChargesReady(s){
 // The claim table is known only while this visit's draft account is what the chart holds;
 // once the charges are frozen the claim carries its own copy.
 const account=visitReviewAccount();
 if(s.account?.status!=='draft')return {known:false,lines:[]};
 if(!account||account.id!==s.account.id)return {known:false,lines:[]};
 if(typeof activeVisit!=='undefined'&&activeVisit&&account.content?.visit_id&&account.content.visit_id!==activeVisit.id)return {known:false,lines:[]};
 return {known:true,lines:Array.isArray(account.content?.lines)?account.content.lines:[]};
}
function visitReviewPayer(s){
 const account=visitReviewAccount(),frozen=s.account?.status!=='draft',coverage=typeof revenueCoverage==='function'?revenueCoverage(s.account?.service_date):null;
 if(frozen)return {known:true,payer:account?.coverage_snapshot?.payer?.content||{},coverage:account?.coverage_snapshot?.coverage?.content||{}};
 if(!coverage)return {known:false,payer:null,coverage:null};
 return {known:true,payer:(typeof billingPayers!=='undefined'?billingPayers:[]).find(p=>p.id===coverage.content.payer_id)?.content||{},coverage:coverage.content};
}
function visitReviewLineProblems(s,ctx={}){
 const out=[],charges=visitReviewChargesReady(s);
 if(!charges.known)return out;
 charges.lines.forEach((line,index)=>{
  if(!(Array.isArray(line.diagnosis_codes)?line.diagnosis_codes:[]).filter(code=>String(code||'').trim()).length){
   out.push(visitReviewCheck(`line-${index}-diagnosis`,{group:'claim',blocking:true,
    text:`Line ${index+1} (${line.code||'charge without a code yet'}) has no diagnosis saying what it was for.`,
    action:'Fix the diagnosis on this line',attribute:`data-visit-review-fix="line" data-review-line="${index}"`}));
  }
  if(/^J\d{4}$/i.test(String(line.code||'').trim())&&!String(line.ndc_code||'').trim()){
   out.push(visitReviewCheck(`line-${index}-ndc`,{group:'claim',blocking:false,
    text:`Line ${index+1} (${String(line.code).toUpperCase()}) is a drug with no NDC code on it. Some insurers send this back.`,
    action:'Add the drug detail',attribute:`data-visit-review-fix="line" data-review-line="${index}"`}));
  }
 });
 return out;
}
function visitReviewPractice(s,ctx={}){
  const claim=s.claim||{},out=[];
  const missing=new Set((claim.issues||[]).map(issue=>String(issue?.code||'').trim().toLowerCase()));
  const defaults=typeof claimmdClaimProviderDefaults==='function'?claimmdClaimProviderDefaults():{};
  const known=ctx.claimDetails!==false&&(Object.keys(defaults).length>0||Object.keys(claim.content||{}).length>0);
  if(!known)return out;
  const content=claim.content||{};
  const name=String(content.billing_provider_name??defaults.billing_provider_name??'').trim();
  if(!name)out.push(visitReviewCheck('practice-name',{group:'practice',blocking:true,text:'The practice has no billing provider name.',action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  const address=String(content.billing_address??defaults.billing_address??'').trim();
  if(!address)out.push(visitReviewCheck('practice-address',{group:'practice',blocking:true,text:'The claim has no billing address for the practice.',action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  const taxId=String(content.tax_id??'').trim();
  if(taxId&&(!/^\d{9}$/.test(taxId)||missing.has('tax_id')))out.push(visitReviewCheck('practice-tax',{group:'practice',blocking:true,text:`The tax ID on the claim (“${visitReviewFormValue(taxId,12)}”) is not nine digits.`,action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  else if(!taxId&&Object.keys(content).length)out.push(visitReviewCheck('practice-tax',{group:'practice',blocking:true,text:'The claim has no tax ID for the practice.',action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  for(const [field,label,fromDefault] of [['billing_npi','billing NPI','billing_npi'],['rendering_npi','rendering NPI','rendering_npi']]){
    // The NPI the claim will actually carry is the claim's own, or the practice's setup where
    // the claim has none yet; an invalid one on either side still has to be put right.
    const npi=String(content[field]??defaults[fromDefault]??'').trim();
    if(!npi)out.push(visitReviewCheck(`practice-${field}`,{group:'practice',blocking:true,text:`The claim has no ${label}.`,action:'Open practice billing setup',attribute:'data-billing-organizations'}));
    else if(!/^\d{10}$/.test(npi)||missing.has('npi'))out.push(visitReviewCheck(`practice-${field}`,{group:'practice',blocking:true,text:`The ${label} on the claim (“${visitReviewFormValue(npi,12)}”) is not a valid 10-digit NPI.`,action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  }
  if(missing.has('taxonomy_code')||missing.has('billing_taxonomy'))out.push(visitReviewCheck('practice-taxonomy',{group:'practice',blocking:false,text:'The provider has no specialty (taxonomy) code, so the insurer may ask for it later.',action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  return out;
}
function visitReviewPatient(s,ctx={}){
  const out=[],claim=s.claim||{},content=claim.content||{};
  if(claim.id&&typeof claimPatientAddressDefault==='function'&&!visitReviewFormValue(claimPatientAddressDefault(claim.snapshot?.account||{}),2)){
    out.push(visitReviewCheck('patient-address',{group:'patient',blocking:true,text:'The patient has no address for the claim.',action:'Edit patient details',attribute:'data-chart-section="profile"'}));
  }
  const patient=claim.snapshot?.patient;
  if(patient&&!String(patient.given_name||'').trim())out.push(visitReviewCheck('patient-name',{group:'patient',blocking:true,text:'The patient has no first name for the claim.',action:'Edit patient details',attribute:'data-chart-section="profile"'}));
  if(patient&&!String(patient.family_name||'').trim())out.push(visitReviewCheck('patient-family',{group:'patient',blocking:true,text:'The patient has no last name for the claim.',action:'Edit patient details',attribute:'data-chart-section="profile"'}));
  return out;
}
function visitReviewInsurance(s,ctx={}){
  const out=[],claim=s.claim||{},content=claim.content||{};
  const missing=new Set((s.claim?.issues||[]).map(issue=>String(issue?.code||'').trim().toLowerCase()));
  for(const [field,label] of [['subscriber_address',"the policy holder's address"],['subscriber_birth_date',"the policy holder's date of birth"]]){
    if(claim.id&&!visitReviewFormValue(content[field],2))out.push(visitReviewCheck(`insurance-${field}`,{group:'insurance',blocking:true,text:`${label[0].toUpperCase()}${label.slice(1)} is missing from the claim.`,action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  }
  const payer=visitReviewPayer(s);
  if(!payer.known)return out;
  if(!String(payer.payer?.payer_code||'').trim())out.push(visitReviewCheck('payer-code',{group:'insurance',blocking:true,text:`${s.insurance.insurer||'This insurer'} has no insurer ID here, so the claim cannot be sent electronically.`,action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  if(!String(payer.payer?.name||'').trim())out.push(visitReviewCheck('payer-name',{group:'insurance',blocking:true,text:'The insurer has no name on this coverage.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  if(!String(payer.coverage?.member_id||'').trim())out.push(visitReviewCheck('member-id',{group:'insurance',blocking:true,text:'The member ID on this coverage is blank.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  else if(!/[!-~]{2,}/.test(String(payer.coverage.member_id)))out.push(visitReviewCheck('member-id',{group:'insurance',blocking:true,text:'The member ID on this coverage cannot be used on a claim.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  if(missing.has('group_number')||missing.has('plan_name'))out.push(visitReviewCheck('coverage-text',{group:'insurance',blocking:false,text:'The plan details on this coverage contain characters a claim file cannot hold.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  return out;
}
function visitReviewClaimDetailChecks(s,ctx={}){
  const out=[],claim=s.claim||{},content=claim.content||{};
  const missing=new Set((s.claim?.issues||[]).map(issue=>String(issue?.code||'').trim().toLowerCase()));
  const pos=String(content.place_of_service??'').trim();
  if(claim.id&&(!/^\d{2}$/.test(pos)||missing.has('place_of_service')))out.push(visitReviewCheck('place-of-service',{group:'claim',blocking:true,text:'The claim needs a two-digit place of service (11 = office).',action:'Fix claim details',attribute:`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id||'')}"`}));
  const codes=Array.isArray(content.diagnosis_codes)?content.diagnosis_codes.filter(code=>String(code||'').trim()):[];
  if(claim.id&&(!codes.length||codes.some(code=>!/^[A-Za-z0-9.]+$/.test(String(code).trim()))||missing.has('diagnosis_codes')))out.push(visitReviewCheck('diagnoses',{group:'claim',blocking:true,text:'The claim needs its diagnosis codes.',action:'Fix claim details',attribute:`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id||'')}"`}));
  if(missing.has('secondary'))out.push(visitReviewCheck('secondary',{group:'claim',blocking:true,text:'This is a secondary claim and the primary insurer’s answer is not on it yet. Open the primary claim and use Review secondary billing.',action:'Open the primary claim',attribute:`data-revenue-claim="${esc(claim.parent_id||claim.id||'')}"`}));
  if(missing.has('tertiary'))out.push(visitReviewCheck('tertiary',{group:'claim',blocking:true,text:'A third insurer cannot be billed electronically from here.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  return out;
}
function visitReviewNote(s,ctx={}){
  const visit=s.visit||{},unsigned=typeof encounterRevenueVisitUnsigned==='function'&&encounterChargeAccount()?encounterRevenueVisitUnsigned(encounterChargeAccount()):(!!visit.id&&visit.status!=='signed');
  if(!unsigned)return [];
  const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
  const stillDraft=!account||account.status==='draft';
  return [visitReviewCheck('note-unsigned',{group:'visit',blocking:false,
    text:'The visit note is not signed yet. The claim itself does not need the signature; posting the charges does.',
    action:ctx.canSign?'Sign the note':'Ask the clinician to sign the note',
    attribute:ctx.canSign?'data-visit-review-fix="note"':'data-revenue-documentation'}),
    ...(stillDraft?[visitReviewCheck('post-needs-signature',{group:'visit',blocking:false,text:'Until the note is signed this practice cannot post the charges, and posting makes them final. You can still send what is ready.'}),visitReviewCheck('sign-the-note',{group:'visit',blocking:false,text:'Sign it from the visit note, then come back and press the same button.',action:ctx.canSign?'Sign the note':'Ask the clinician to sign the note',attribute:ctx.canSign?'data-visit-review-fix="note"':'data-revenue-documentation'})]:[visitReviewCheck('post-done',{group:'visit',blocking:false,text:'The charges are already posted, so the unsigned note no longer holds anything up here.'})])];
}
function visitReviewServer(s){
  const claim=s.claim||{};
  if(s.state==='fix_claim'&&Array.isArray(claim.issues))return claim.issues.map(issue=>String(issue?.missing??issue?.detail??'').trim()).filter(Boolean);
  return typeof claim.preflight_issues==='undefined'?null:(Array.isArray(claim.preflight_issues)?claim.preflight_issues:[]).map(issue=>String(issue||'').trim()).filter(Boolean);
}
function visitReviewServerChecks(s){
  const claim=s.claim||{};
  const groups=visitBillingMissingGroupsFor(claim.issues||[]);
  const attributeFor={practice:'data-billing-organizations',patient:'data-chart-section="profile"',insurance:'data-chart-section="insurance"'};
  const labelFor={practice:'Open practice billing setup',patient:'Edit patient details',insurance:'Edit insurance'};
  const out=[];
  for(const group of visitBillingMissingGroups){
    for(const text of groups[group.key]||[])out.push(visitReviewCheck(`server-${group.key}-${text}`,{group:group.key,blocking:true,
      text:`The claim is missing ${text}.`,action:labelFor[group.key],attribute:attributeFor[group.key]}));
  }
  for(const text of groups.claim||[])out.push(visitReviewCheck(`server-claim-${text}`,{group:'claim',blocking:true,text:`The claim is missing ${text}.`,action:'Fix claim details',attribute:`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id||'')}"`}));
  for(const text of visitReviewServer(s)||[])if(!out.some(check=>check.text.includes(text.toLocaleLowerCase())))out.push(visitReviewCheck(`server-raw-${text}`,{group:'claim',blocking:true,text:text,action:'Fix claim details',attribute:`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id||'')}"`}));
  return out;
}
// The whole list: everything worth a look, then everything that must be put right first.
function visitReviewChecks(s,ctx={}){
  if(!s)return [];
  const out=[];
  if(!ctx.claimsAllowed)out.push(visitReviewCheck('claims-not-allowed',{group:'claim',blocking:true,text:'This sign-in cannot see insurance claims, so nothing can be sent from here.',action:'',fix:'blocked'}));
  else if(s.claim?.secondary||s.claim?.crossover)out.push(visitReviewCheck('secondary-claim',{group:'claim',blocking:true,text:'This claim comes from another insurer’s answer. It is worked on from the primary claim.',action:'Open the primary claim',attribute:`data-revenue-claim="${esc(s.claim.id||'')}"`,fix:'blocked'}));
  else if(!s.insurance.insured)out.push(visitReviewCheck('self-pay',{group:'claim',blocking:false,text:'There is no insurance on this visit, so nothing is sent to Claim.MD. The patient is billed instead.'}));
  else if(!s.insurance.electronic)out.push(visitReviewCheck('no-payer-id',{group:'insurance',blocking:true,text:`${visitBillingInsurer(s)} has no insurer ID here, so no claim can be sent electronically. Add it, or record the visit as billed outside SunCharts.`,action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  else if(!s.account)out.push(visitReviewCheck('no-charges',{group:'charges',blocking:true,text:'No charges have been added to this visit yet.',action:'Add charges',attribute:'data-encounter-charges'}));
  else{
    out.push(...visitReviewNote(s,ctx));
    out.push(...visitReviewLineProblems(s,ctx));
    out.push(...visitReviewPractice(s,ctx));
    out.push(...visitReviewPatient(s,ctx));
    out.push(...visitReviewInsurance(s,ctx));
    out.push(...visitReviewClaimDetailChecks(s,ctx));
    out.push(...visitReviewServerChecks(s));
    if(s.claim?.status==='ready'&&!out.length)out.push(visitReviewCheck('all-clear',{group:'claim',blocking:false,text:'Nothing to check. The claim is ready and nothing has been sent yet.'}));
  }
  const seen=new Set();
  return out.filter(check=>{const key=`${check.level}|${check.text}`;if(seen.has(key))return false;seen.add(key);return true;})
    .sort((a,b)=>(a.level===b.level?0:a.level==='must'?-1:1));
}
function visitReviewMustFix(checks){return checks.filter(check=>check.level==='must');}

function visitReviewSummaryMarkup(s){
  if(!s)return '';
  const who=s.insurance.insured?`Insurance — ${esc(visitBillingInsurer(s))}`:'No insurance — the patient is billed';
  const copay=s.insurance.insured?(s.patient.copay_cents==null?'No copay recorded on this plan.':`The patient is expected to pay ${money(s.patient.copay_cents)} at this visit.`):'No insurance, so the patient is billed for the whole visit.';
  const row=(label,value)=>`<div class="visit-billing-review-summary-row"><span>${label}</span><b>${value}</b></div>`;
  return `<h4>What goes out</h4>${row('This visit’s charges',s.charges_cents==null?'Nothing added yet':money(s.charges_cents))}${row('Who is billed',who)}${row('Expected patient copay',esc(copay))}`;
}
// The claim form the practice would file, filled from what the claim will actually carry.
function visitReviewFormMarkup(s){
  const claim=s?.claim;
  if(!claim)return '<h4>The claim form</h4><p class="muted">The claim form appears here as soon as the claim is filled in from this visit. Nothing is sent before you choose Send to Claim.MD.</p>';
  const content=claim.content||{},account=claim.snapshot?.account||{},patient=claim.snapshot?.patient||{},coverage=account.coverage_snapshot?.coverage?.content||{},payer=account.coverage_snapshot?.payer?.content||{};
  const field=(number,label,value)=>`<div class="visit-billing-review-field"><span>${number} · ${esc(label)}</span><b>${esc(visitReviewFormValue(value))||'—'}</b></div>`;
  const line=(line,pointers)=>`<tr><td>${esc(visitReviewFormValue(`${line.code_system||''} ${line.code||''}`.trim(),13))}</td><td>${esc(visitReviewFormValue(line.description,28))}</td><td class="money-cell">${Number(line.units||0)||0}</td><td class="money-cell">${money(line.amount_cents||0)}</td><td>${(pointers||[]).map(n=>esc(visitReviewFormValue((content.diagnosis_codes||[])[n-1]||'',8))).filter(Boolean).join(' ')||'—'}</td></tr>`;
  const lines=(account.content?.lines||[]).map((line,index)=>line(line,(content.line_diagnosis_pointers||[])[index]||[])).join('');
  const linesTable=lines?`<div class="billing-table-wrap"><table class="billing-table visit-billing-review-lines"><thead><tr><th>Code</th><th>Description</th><th class="money-cell">Units</th><th class="money-cell">Charge</th><th>Diagnoses</th></tr></thead><tbody>${lines}</tbody></table></div>`:'<p class="muted">No charge lines on this claim yet.</p>';
  return `<h4>The claim form</h4><p class="muted">A CMS-1500 view of exactly what this claim carries. Looking at it sends nothing.</p>${visitReviewLink('Open the claim form (CMS-1500)',`${claimsApiBase}/${claim.id}/cms1500`)}<div class="visit-billing-review-fields">${field('1','Insurer',payer.name)}${field('1a','Member ID',coverage.member_id)}${field('2','Patient',`${patient.family_name||''}, ${patient.given_name||''}`.replace(/^,\s*|\s*,$/g,''))}${field('4','Policy holder',`${(coverage.relationship||'').toLowerCase()==='self'?'Same as the patient':(patient.family_name||'')+' '+(patient.given_name||'')}`)}${field('5','Patient address',content.patient_address)}${field('7','Policy holder address',content.subscriber_address)}${field('8','Billing provider',content.billing_provider_name)}${field('9','Billing NPI',content.billing_npi)}${field('10','Rendering NPI',content.rendering_npi)}${field('16','Tax ID',content.tax_id)}${field('20','Service date',account.content?.service_date)}${field('22','Place of service',content.place_of_service)}${field('21','Diagnoses',(content.diagnosis_codes||[]).join(', '))}${field('24J','Provider specialty',content.billing_taxonomy)}</div>${linesTable}`}
function visitReviewProgressMarkup(progress){
  if(!progress||!progress.steps)return '';
  const state=step=>step.status==='failed'?`<span class="visit-billing-review-step-state">Stopped: ${esc(step.reason||'it did not go through')}</span>`:step.status==='done'?`<span class="visit-billing-review-step-state">${esc(step.skipped?visitReviewStages.find(stage=>stage.key===step.key).skip:visitReviewStages.find(stage=>stage.key===step.key).done)}</span>`:`<span class="visit-billing-review-step-state">${esc(visitReviewStages.find(stage=>stage.key===step.key).doing)}</span>`;
  return `<ol class="visit-billing-review-progress" aria-label="What has happened so far">${progress.steps.map(step=>`<li class="visit-billing-review-step is-${esc(step.status)}" data-review-stage="${esc(step.key)}"><b>${esc(visitReviewStages.find(stage=>stage.key===step.key).label)}</b>${state(step)}</li>`).join('')}</ol>${progress.step?`<p class="muted" role="status">${esc(progress.step)}</p>`:''}`;
}
function visitReviewSentMarkup(s){
  const status=visitBillingStatus(s,visitBillingContext()),insurer=visitBillingInsurer(s);
  const check=s.claim?.id?visitReviewButton('Check status',`data-revenue-claim="${esc(s.claim.id)}"`):'';
  return `<p role="status">The claim is on its way to ${esc(insurer)}.</p><p>${esc(status.headline)}${status.detail?` — ${esc(status.detail)}`:''}</p><div class="actions">${check}</div>`;
}
function visitReviewBlockMarkup(s,ctx,checks){
  const must=visitReviewMustFix(checks),blocked=must.length>0;
  if(ctx.error)return `<p class="visit-billing-review-stalled" role="alert" data-review-stalled><b>Nothing more was sent.</b> ${esc(ctx.error)} The steps above show exactly how far it got, and nothing already done is undone. <button type="button" class="primary" data-visit-review-send>Try again</button></p>`;
  if(ctx.sent)return visitReviewSentMarkup(s);
  if(blocked)return `<p role="status" data-review-blocked><b>${must.length===1?'One thing must be put right first.':`${must.length} things must be put right first.`}</b> Use the button beside each one. Until then the send button stays closed.</p>`;
  const post=s.account?.status==='draft';
  return `<div class="actions">${visitReviewButton(ctx.askNote?'Send anyway — the note is not signed yet':post?'Post charges, then send to Claim.MD':'Send to Claim.MD','class="primary" data-visit-review-send')}${ctx.askNote?`<p class="muted" role="status">The visit note is still not signed. Sending does not need the signature, but the charges become final when they are posted.</p>`:post?'<p class="muted">This posts the charges — they become final — fills the claim in, then sends it. Nothing has been sent until you press it.</p>':'<p class="muted">Nothing has been sent yet. Sending tells Claim.MD to deliver this claim to the insurer.</p>'}</div>`;
}
function visitReviewPanelBody(s,ctx={}){
  const checks=visitReviewChecks(s,ctx),must=visitReviewMustFix(checks);
  const groups=[['must','Must fix'],['note','Worth a look']];
  const item=check=>`<li class="visit-billing-review-check" data-check="${esc(check.key)}" data-check-level="${check.level}" data-check-group="${esc(check.group)}"><span>${esc(check.text)}</span>${check.action?visitReviewButton(check.action,`${check.attribute}${check.fix?` data-review-fix="${check.fix}"`:''}`):''}</li>`;
  const list=groups.filter(([level])=>checks.some(check=>check.level===level)).map(([level,label])=>`<div class="visit-billing-review-group" data-review-level="${level}"><h4>${label}</h4><ul>${checks.filter(check=>check.level===level).map(item).join('')}</ul></div>`).join('');
  // The unsigned note is answered right here: sign it, or send anyway once.
  const noteAsk=checks.some(check=>check.key==='note-unsigned')&&!ctx.allowUnsigned?`<div class="visit-billing-review-note" data-review-note-ask><p class="muted">Signing the note is what posting the charges waits for, not the claim itself.</p><div class="actions">${ctx.canSign?visitReviewButton('Sign the note','data-visit-review-fix="note"'):''}<label class="review-ack"><input type="checkbox" data-note-sign-ack> Send anyway — the note is not signed yet.</label></div></div>`:'';
  return `<div class="visit-billing-review-top"><div><h3>Check before it goes out</h3><p class="muted">Everything a claim needs, in plain words. Only what the insurer or our system actually refuses will stop a send.</p></div><div class="actions">${visitReviewButton('Check again','data-visit-review-refresh="again"')}</div></div>${visitReviewProgressMarkup(ctx.progress)}${noteAsk}${visitReviewBlockMarkup(s,ctx,checks)}${list||'<p class="visit-billing-review-clear" role="status">Nothing to fix. The claim is ready and nothing has been sent yet.</p>'}`;
}
function visitReviewPanelMarkup(s,ctx={}){
  return `<section class="visit-billing-review" data-visit-review-panel><div class="section-head"><div><h2>Check the claim before it goes out</h2><p class="muted">The charges, the form and one button that does the rest.</p></div><div class="actions">${visitReviewButton('Close','data-visit-review-close')}</div></div><div id="visit-billing-review-body">${visitReviewPanelBody(s,ctx)}</div><section class="visit-billing-review-money"><h4>What this visit comes to</h4>${visitReviewSummaryMarkup(s)}</section>${visitReviewFormMarkup(s)}</section>`;
}

// Opening and re-drawing the panel. The card's own status line is left as the server's summary
// says it; the panel is the only thing re-drawn, so a background refresh can never wipe a
// message out from under the person using it.
function visitReviewHost(){return $('visit-billing-review');}
function visitReviewPaint(ctx={}){
  const host=visitReviewHost();if(!host||host.hidden)return;
  const summary=encounterRevenueState.data?.summary;if(!summary)return;
  const review=encounterRevenueState.review;
  const carried=review&&review!==ctx?{progress:review.progress,error:review.stopped?review.error:null,sent:review.sent,askNote:review.askNote}:{};
  host.innerHTML=visitReviewPanelMarkup(summary,visitReviewContext({...carried,...ctx}));
}
function visitReviewOpen(ctx={}){
  const host=visitReviewHost();if(!host)return;
  encounterRevenueState.review=null;
  const summary=encounterRevenueState.data?.summary;
  host.hidden=false;host.innerHTML=summary?visitReviewPanelMarkup(summary,visitReviewContext(ctx)):'<p class="muted">Loading the review…</p>';
  const heading=host.querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
  host.scrollIntoView?.({block:'start'});
}
function visitReviewContext(extra={}){
  const visit=typeof activeVisit!=='undefined'?activeVisit:null;
  const maySign=typeof canSignNote==='function'?canSignNote()===true:['owner','clinician'].includes(me?.role);
  const mayDraft=typeof canDraftNote==='function'?canDraftNote(visit)===true:true;
  return {canSign:!!(visit&&visit.status!=='signed'&&maySign&&mayDraft),...visitBillingStateContext(),...extra};
}
function visitReviewClose(){
  const host=visitReviewHost();if(!host)return;
  host.hidden=true;host.replaceChildren();
  if(typeof captureClaimDraft==='function')captureClaimDraft();
  const claimHost=$('encounter-claims');
  if(claimHost&&claimHost.hidden===false&&typeof claimViewContext!=='undefined'&&claimViewContext?.kind==='encounter'){claimHost.replaceChildren();claimHost.hidden=true;claimViewContext=null;}
}
// The card's one main button: review first, then send from the same place.
// The card offers the review button only where it is the truth about this chart: the claim
// steps run on the visit's own data, so a card out of step with it keeps its own button.
function visitBillingCardCurrent(s){
 // The review button belongs to the card of the visit this screen is actually showing: the
 // same visit, the same charge account, and a step whose card was just drawn from this
 // summary. A card drawn from a copy elsewhere keeps its own button instead.
 if(typeof encounterRevenueState==='undefined'||!s?.account)return false;
 const summary=encounterRevenueState.data?.summary;
 if(!summary||summary.state!==s.state||summary.account?.id!==s.account?.id)return false;
 if(summary.visit&&s.visit&&summary.visit.id!==s.visit.id)return false;
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 if(account&&account.id!==s.account.id)return false;
 // The card must be the one on screen: either the very summary the step rendered, or the
 // step showing this visit's charges with the same state.
 if(encounterRevenueState.reviewCard===summary)return true;
 return typeof encounterRevenueState.reviewCard==='undefined';
}
function visitBillingReviewButton(s,ctx={}){
  if(!ctx.canWrite||!ctx.claimsAllowed||!s.insurance?.insured||!s.account||ctx.delegated||ctx.noReview)return '';
  if(!['post_charges','prepare_claim','claim_cancelled','fix_claim','send_claim'].includes(s.state))return '';
  if(['submitted','accepted','adjudicated','void'].includes(s.claim?.status))return '';
  if(!visitBillingCardCurrent(s))return '';
  return `<button type="button" class="primary" data-visit-review-open="account">Review and send to Claim.MD</button>`;
}
// After a claim is with the insurer the card says so and gives the one way to look at it.
function visitBillingSentLine(s,ctx={}){
  if(!s.claim?.id||!['submitted','accepted','adjudicated'].includes(s.claim.status)||!ctx.claimsAllowed)return '';
  const status=visitBillingStatus(s,ctx);
  return `<p class="visit-billing-sent" data-visit-billing-sent><b>${esc(status.headline)}</b> ${esc(status.detail)} ${visitReviewButton('Check status',`data-revenue-claim="${esc(s.claim.id)}"`)}</p>`;
}

// The chain: post what is still a draft, fill the claim in, check it, send it. It stops at the
// step that fails and says which one, in the words the server or Claim.MD gave.
function visitReviewStageSteps(needPost,needPrepare){
 return visitReviewStages.map(stage=>({key:stage.key,status:'waiting',skipped:false,reason:''}))
   .filter(step=>step.key==='check'?!needPrepare:(step.key==='post'?needPost:true)&&(step.key==='prepare'?needPrepare:true));
}
function visitReviewStepFailure(step,reason){
  return `We could not finish ${visitReviewStageTitle[step.key]}. ${reason}`.replace(/\s+/g,' ').trim();
}
async function visitReviewRun(claimId,options={}){
 const patient=selected,identity=me,visitId=typeof activeVisit!=='undefined'?activeVisit?.id:null;
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 if(!account)throw new Error('Open the visit for these charges first.');
 const current=()=>selected===patient&&me===identity&&(typeof activeVisit==='undefined'?true:activeVisit?.id===visitId);
 const state=encounterRevenueState,previous=state.review;
 const needPost=options.needPost!==false&&account.status==='draft';
 const needPrepare=options.needPrepare!==false;
 const progress={steps:visitReviewStageSteps(needPost,needPrepare),step:''};
 const review=state.review={claimId:claimId||null,busy:true,stopped:false,error:null,sent:false,progress};
 const paint=extra=>{if(current()&&state.review===review)visitReviewPaint({...extra,progress,error:review.stopped?review.error:null,sent:review.sent});};
 const advance=async(key,work)=>{
  const step=progress.steps.find(candidate=>candidate.key===key);if(!step)return true;
  progress.step=visitReviewStages.find(stage=>stage.key===key).doing;paint();
  try{const skipped=await work(step);step.skipped=skipped===true;step.status='done';progress.step='';return true;}
  catch(error){step.status='failed';step.reason=String(error?.message||'').trim()||'it did not go through';review.error=visitReviewStepFailure(step,step.reason);review.stopped=true;return false;}
 };
   try{
    let claim={id:claimId||null,version:null};
    if(!needPost&&!needPrepare){
     // With nothing left to post or fill in, the claim is re-read from the server before
     // anything is released: the person may have the charge table open with edits in it, and
     // a claim that moved on since the button was pressed is never sent on a stale copy.
     const ok=await advance('check',async()=>{
      if(!claim.id)throw new Error('The claim for this visit could not be found. Refresh the visit and try again.');
      const found=await api(`${claimsApiBase}/${claim.id}`);
      if(!current())throw new Error('This page changed. Open the visit again.');
      if(found?.claim?.id!==claim.id)throw new Error('The claim that loaded is not the one you opened. Try again.');
      if(['submitted','accepted','adjudicated','void'].includes(found.claim.status))throw new Error('This claim is already with the insurer. Its status shows on the visit.');
      return true;
     });
     if(!ok){review.busy=false;paint();return false;}
    }
    if(needPost){
     const ok=await advance('post',async()=>{
      if(options.confirmPost&&typeof confirmAction==='function'&&!await confirmAction(`Charges of ${money(account.total_cents)} become final and the claim goes to ${visitBillingInsurer(state.data?.summary||{})}.`,{title:'Post these charges?',confirmLabel:'Post charges'}))throw new Error('Cancelled before anything was sent.');
      if(!current())throw new Error('This page changed. Open the visit again.');
      await api(`${billingBase()}/${account.id}/actions`,'POST',{action:'post',reason:'Charges posted',local_only:false},account.version);
      if(options.afterPost)await options.afterPost();
     });
     if(!ok){review.busy=false;paint();return false;}
    }
    if(needPrepare){
     const ok=await advance('prepare',async()=>{
      // The chain calls the server's own prepare endpoint, the same one the card's Prepare
      // claim button uses, rather than the card's function: that one redraws the whole billing
      // card, and this panel must not wipe what the person is working on beside it.
      const fresh=typeof encounterChargeAccount==='function'?encounterChargeAccount():account;
      if(fresh.status!=='posted')throw new Error('The charges are not final yet, so the claim could not be filled in.');
      const prepared=await api(`/api/v1/patients/${encodeURIComponent(selected)}/billing/accounts/${encodeURIComponent(fresh.id)}/claims/prepare`,'POST',{});
      if(!current())throw new Error('This page changed. Open the visit again.');
      // The server names the claim it filled in for this visit. The chain only ever carries on
      // that one, never a copy left on a screen that may have moved on; the detail read below
      // still brings the claim, and its version, back from the server.
      if(prepared?.outcome==='prepared'||prepared?.outcome==='exists'){
       if(!prepared.claim_id)throw new Error('The claim for this visit could not be found. Refresh the visit and try again.');
       if(claim.id&&prepared.claim_id!==claim.id)throw new Error('This claim does not belong to the visit you are on. Refresh and try again.');
       claim={id:prepared.claim_id,version:null};
       return false;
      }
      if(prepared?.outcome==='delegated')throw new Error('A support session does not prepare claims. A member of the practice sends this one.');
      if(prepared?.outcome==='cancelled')throw new Error('The claim filled in here was cancelled. Prepare a new claim from this visit first.');
      if(prepared?.outcome==='not_needed')return true;
      throw new Error('The claim could not be filled in from this visit. Refresh the visit and try again.');
     });
     if(!ok){review.busy=false;paint();return false;}
    }
    if(!claim.id)throw new Error('The claim for this visit could not be found. Refresh the visit and try again.');
    if(claimId&&claim.id!==claimId)throw new Error('This claim does not belong to the visit you are on. Refresh and try again.');
  if(!current()){review.busy=false;return false;}
  if(typeof loadClaimMdConnection==='function')await loadClaimMdConnection();
  if(!current()){review.busy=false;return false;}
  if(!options.allowUnsigned&&typeof encounterRevenueVisitUnsigned==='function'&&encounterRevenueVisitUnsigned(account)){review.busy=false;review.askNote=true;paint({askNote:true});return false;}
  if(!(typeof claimMdConnectionState!=='undefined'&&claimMdConnectionState?.connected))throw new Error('Claim.MD is not connected, so nothing can be sent. Ask the practice owner to check the Claim.MD connection.');
   const stopHere=(key,reason)=>{
    // The chain stops at this step: nothing further is sent, the step shows as stopped with
    // the reason, and the button comes back as Try again.
    const stop=progress.steps.find(candidate=>candidate.key===key);
    if(stop){stop.status='failed';stop.reason=reason;}
    review.error=visitReviewStepFailure(stop||{key},reason);
    review.stopped=true;review.busy=false;paint();return false;
   };
   const detail=await api(`${claimsApiBase}/${claim.id}`);
   if(!current()){review.busy=false;return false;}
   if(detail?.claim?.id!==claim.id)throw new Error('The claim that loaded is not the one you opened. Try again.');
   claim.version=detail.claim.version;
   const already=(typeof claimHasRecordedSubmission==='function'&&claimHasRecordedSubmission(detail))||(typeof claimHasPreparedSubmission==='function'&&claimHasPreparedSubmission(detail));
   if(already)return stopHere('ready','This claim already has a claim file with Claim.MD. Open the claim to check whether it was sent before sending again.');
   // The server's own refusals stop the chain here, before anything is released or sent.
   const refused=(Array.isArray(detail.preflight_issues)?detail.preflight_issues:[]).map(issue=>String(issue||'').trim()).filter(Boolean);
   if(refused.length)return stopHere('ready',`The claim is missing what the insurer needs: ${refused.join('; ')}.`);
   const okReady=await advance('ready',async()=>{
   if(detail.claim.status==='ready')return true;
   if(detail.claim.status!=='draft')throw new Error('This claim is no longer a draft, so it cannot be checked and released here. Open the claim to see what to do.');
   await api(`${claimsApiBase}/${claim.id}/actions`,'POST',{action:'ready',reason:'Claim details reviewed before sending',reference:'',event_date:null,payer_control_number:''},detail.claim.version);
  });
  if(!okReady){review.busy=false;paint();return false;}
  const sent=await api(`${claimsApiBase}/${claim.id}/837p`,'POST',{request_id:crypto.randomUUID(),details:{},acknowledged:options.acknowledged===true},claim.version);
  const route=(detail.transport?.routes||[]).find(candidate=>candidate.provider==='claim_md')||{};
  const delivered=await api(`/api/v1/billing/submissions/${sent.id}/delivery`,'POST',{request_id:crypto.randomUUID(),route_key:route.route_key||'',reason:'Sent from the visit'},sent.version);
  const okSend=await advance('send',async()=>{if(delivered?.submission?.id&&delivered.submission.id!==sent.id)throw new Error('The claim file that went out is not the one prepared here. Open the claim to check its status.');});
  review.busy=false;
  if(!okSend){paint();return false;}
  if(!current())return false;
  review.stopped=false;review.error=null;review.sent=true;
  if(!options.quietRefresh){
   if(options.afterSend)await options.afterSend();else void loadEncounterRevenueStatus(typeof encounterChargeAccount==='function'?encounterChargeAccount():account,true);
  }
  if(!current())return true;
  paint({sent:true});
  if(typeof notice==='function')notice('Claim sent to Claim.MD. Its status updates on this visit.');
  return true;
 }finally{
  review.busy=false;
  if(state.review===review&&previous)state.review=previous;
 }
}


// One-click fixes inside the panel: each opens the thing itself, where it already lives.
function visitReviewOpenChargeTable(){
  if(typeof openEncounterCharges==='function')openEncounterCharges();
  const details=$('encounter-charge-details');if(details)details.open=true;
  $('encounter-billing-detail')?.scrollIntoView?.({behavior:'smooth',block:'start'});
}
function visitReviewFixLine(index){
  visitReviewOpenChargeTable();
  const row=(typeof $==='function'?$('billing-charge-lines'):null)?.querySelectorAll?.('.billing-charge-row')?.[index];
  if(!row)return;
  row.scrollIntoView?.({behavior:'smooth',block:'center'});
  const box=row.querySelector(['diagnosis','diagnoses'].map(name=>`[name="${name}"]`).join(','))||row.querySelector('[name="ndc_code"]');
  box?.focus?.({preventScroll:true});
  if(!row.querySelector('[data-review-line-warning]'))row.insertAdjacentHTML?.('beforeend','<p data-review-line-warning role="status">This is the line the review stopped on.</p>');
}
function visitReviewOpenClaimEditor(claimId){
  if(typeof showEncounterClaim!=='function'||!claimId)return;
  const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;if(!account)return;
  void (async()=>{
    await showEncounterClaim(claimId,account.id);
    if(typeof claimCurrent!=='undefined'&&claimCurrent?.id===claimId&&typeof claimEditor==='function'&&claimCurrent.status==='draft')claimEditor(claimCurrent.snapshot.account,claimCurrent);
  })().catch(()=>{});
}
// Sending with an unsigned note is a deliberate choice, ticked once inside the panel and
// recorded in the audit trail the server already keeps for the post.
function visitReviewSendContext(s,account){
  const unsigned=typeof encounterRevenueVisitUnsigned==='function'&&account&&encounterRevenueVisitUnsigned(account);
  const panel=visitReviewHost();
  const acknowledged=!!(unsigned&&panel?.querySelector?.('[data-note-sign-ack]')?.checked);
  if(unsigned&&!acknowledged){visitReviewPaint({askNote:true});return null;}
  return {needPost:account?.status==='draft',needPrepare:!s?.claim?.id||s.claim.status==='draft',allowUnsigned:unsigned,acknowledged,confirmPost:account?.status==='draft'};
}
document.addEventListener('click',event=>{
  const button=event.target.closest?.('button');if(!button)return;
  if(button.hasAttribute('data-visit-review-open')){event.preventDefault();visitReviewOpen();return;}
  if(button.hasAttribute('data-visit-review-close')){event.preventDefault();visitReviewClose();return;}
  if(button.hasAttribute('data-visit-review-refresh')){event.preventDefault();run(async()=>{await loadEncounterRevenueStatus(typeof encounterChargeAccount==='function'?encounterChargeAccount():null,true);visitReviewPaint();});return;}
  if(button.hasAttribute('data-visit-review-send')){
    event.preventDefault();
    const s=encounterRevenueState.data?.summary;
    if(visitReviewMustFix(visitReviewChecks(s,visitReviewContext())).length){visitReviewPaint();return;}
    const options=visitReviewSendContext(s,typeof encounterChargeAccount==='function'?encounterChargeAccount():null);
    if(!options)return;
    run(()=>visitReviewRun(s?.claim?.id||null,options));
    return;
  }
  if(button.dataset.visitReviewFix==='note'){event.preventDefault();if(typeof setEncounterSection==='function')setEncounterSection('documentation');$('note-form')?.querySelector?.('[data-action="sign"]')?.focus?.({preventScroll:true});return;}
  if(button.dataset.visitReviewFix==='line'){event.preventDefault();visitReviewFixLine(Number(button.dataset.reviewLine)||0);return;}
  if(button.dataset.visitReviewFix==='claim'){event.preventDefault();visitReviewOpenClaimEditor(button.dataset.visitClaimFix||encounterRevenueState.data?.summary?.claim?.id||'');return;}
});
