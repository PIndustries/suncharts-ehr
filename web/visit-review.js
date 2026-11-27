// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Review encounter charges and claim details before opening Claim.MD submission.

// The chain in the order it runs. Each step says, in staff words, what it is doing while it
// runs and what it was when it had to stop.
const visitReviewStages=[
  {key:'check',label:'Read the claim as it stands now',doing:'Reading the claim as it stands now…',done:'Claim read',skip:''},
  {key:'post',label:'Post the charges',doing:'Posting the charges…',done:'Charges posted',skip:'Already posted'},
  {key:'prepare',label:'Fill in the claim',doing:'Filling in the claim from this encounter…',done:'Claim filled in',skip:'Already filled in'},
  {key:'ready',label:'Check the claim',doing:'Checking the claim…',done:'Checked',skip:'Already checked'},
  {key:'send',label:'Open Claim.MD submission',doing:'Opening Claim.MD submission…',done:'Claim.MD submission open for review',skip:''},
];
const visitReviewStageTitle={check:'the current claim being read',post:'the charges being posted',prepare:'the claim being filled in',ready:'the claim being checked',send:'opening the Claim.MD submission'};
// The claims endpoint, read where it is used: web/claims.js owns `claimsBase`, and a screen may
// carry the same base under its own name.
function visitReviewClaimsBase(){return typeof claimsBase!=='undefined'?claimsBase:typeof claimsApiBase!=='undefined'?claimsApiBase:'/api/v1/billing/claims';}

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
function visitReviewAccount(){
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,form=$('billing-account-form');
 if(!visit||visit.status==='signed'||visit.signed_at||account?.status==='posted'||!form?.elements?.visit_id||typeof chargeLiveRows!=='function'||typeof chargeRowValue!=='function')return account;
 if(form.dataset.patient&&form.dataset.patient!==selected)return account;
 if(form.elements?.visit_id?.value&&form.elements.visit_id.value!==visit.id)return account;
 return {...account,status:'draft',content:{...account?.content,visit_id:visit.id,service_date:form.elements?.service_date?.value||account?.content?.service_date,...(form.elements.coverage_id?{coverage_id:form.elements.coverage_id.value||null}:{}),lines:chargeLiveRows(form).map(chargeRowValue)}};
}
function visitReviewPreviewSummary(s){
 const visit=typeof activeVisit!=='undefined'?activeVisit:null;
 if(s.claim?.id||!visit||visit.status==='signed'||visit.signed_at||visitReviewAccount()?.status==='posted')return s;
 const account=visitReviewAccount(),payer=visitReviewPayer(s);
 const coverageKnown=payer.known||(typeof revenueCoverage==='function'&&typeof workspace!=='undefined'&&Array.isArray(workspace?.billing?.coverages));
 return {...s,state:'sign_visit',claim:null,account:account||s.account,
  ...(account?{charges_cents:(account.content?.lines||[]).reduce((sum,line)=>sum+Number(line.amount_cents||0),0)}:{}),
  insurance:coverageKnown?{...s.insurance,insured:payer.known,electronic:payer.payer?!!String(payer.payer.payer_code||'').trim():s.insurance?.electronic,insurer:payer.payer?.name||s.insurance?.insurer}:s.insurance};
}
function visitReviewChargesReady(s){
 // The claim table is known only while this encounter's draft account is what the chart holds;
 // once the charges are frozen the claim carries its own copy.
 const account=visitReviewAccount();
 if(s.account?.status!=='draft')return {known:false,lines:[]};
 if(!account||account.id!==s.account.id)return {known:false,lines:[]};
 if(typeof activeVisit!=='undefined'&&activeVisit&&account.content?.visit_id&&account.content.visit_id!==activeVisit.id)return {known:false,lines:[]};
 return {known:true,lines:Array.isArray(account.content?.lines)?account.content.lines:[]};
}
function visitReviewPayer(s){
 const account=visitReviewAccount(),frozen=!!s.account&&s.account.status!=='draft';
 if(frozen){
  const snapshot=account?.coverage_snapshot||s.claim?.snapshot?.account?.coverage_snapshot;
  return {known:!!snapshot?.coverage,payer:snapshot?.payer?.content||null,coverage:snapshot?.coverage?.content||null};
 }
 const coverages=typeof workspace==='undefined'?null:workspace?.billing?.coverages;
 const content=account?.content;
 const coverage=content&&Object.hasOwn(content,'coverage_id')&&Array.isArray(coverages)
  ?coverages.find(row=>row.id===content.coverage_id)
  :s.insurance?.coverage_id&&Array.isArray(coverages)?coverages.find(row=>row.id===s.insurance.coverage_id)
  :typeof revenueCoverage==='function'?revenueCoverage(content?.service_date||s.account?.service_date||s.visit?.service_date||String(s.visit?.starts_at||s.visit?.created_at||'').slice(0,10)):null;
 if(!coverage)return {known:false,payer:null,coverage:null};
 return {known:true,payer:(typeof billingPayers!=='undefined'?billingPayers:[]).find(p=>p.id===coverage.content.payer_id)?.content||null,coverage:coverage.content};
}
function visitReviewLineProblems(s,ctx={}){
 const out=[],charges=visitReviewChargesReady(s);
 if(!charges.known)return out;
 charges.lines.forEach((line,index)=>{
  if(!(Array.isArray(line.diagnosis_codes)?line.diagnosis_codes:[]).filter(code=>String(code||'').trim()).length){
   out.push(visitReviewCheck(`line-${index}-diagnosis`,{group:'claim',blocking:true,
    text:`Line ${index+1} (${line.code||'charge without a code yet'}) has no diagnosis saying what it was for.`,
    action:'Fix the diagnosis on this line',attribute:`data-visit-review-fix="line" data-review-line="${index}" data-review-field="diagnoses"`}));
  }
  if(/^J\d{4}$/i.test(String(line.code||'').trim())&&!String(line.ndc_code||'').trim()){
   out.push(visitReviewCheck(`line-${index}-ndc`,{group:'claim',blocking:false,
    text:`Line ${index+1} (${String(line.code).toUpperCase()}) is a drug with no NDC code on it. Some insurers send this back.`,
    action:'Add the drug detail',attribute:`data-visit-review-fix="line" data-review-line="${index}" data-review-field="ndc_code"`}));
  }
 });
 return out;
}
// A claim the summary named but did not carry the form of has not been read yet. Checks that judge
// what is written on the claim stay silent then: data we did not load is never reported missing.
function visitReviewClaimLoaded(claim){
  return !claim?.id||(!!claim.content&&typeof claim.content==='object'&&!Array.isArray(claim.content));
}
function visitReviewProviderDefaults(s){
 if(s.claim?.id||typeof claimmdClaimProviderDefaults!=='function')return {};
 const active=typeof activeVisit==='undefined'?null:activeVisit;
 const visit=s.visit?.id?{...(active?.id===s.visit.id?active:{}),...s.visit}:active;
 const account=visitReviewAccount()||s.account;
 return claimmdClaimProviderDefaults(visit,account?.content?.claim_details,s.practice_directory??null);
}
function visitReviewPractice(s,ctx={}){
  const claim=s.claim||{},out=[];
  if(!visitReviewClaimLoaded(claim))return out;
  if(!claim.id&&s.practice_directory===null)return [visitReviewCheck('practice-directory-unavailable',{group:'claim',
    text:'Practice billing setup could not be checked.',action:'Check again',attribute:'data-visit-review-refresh'})];
  const missing=new Set((claim.issues||[]).map(issue=>String(issue?.code||'').trim().toLowerCase()));
  const defaults=visitReviewProviderDefaults(s);
  const known=ctx.claimDetails!==false&&(Object.keys(defaults).length>0||Object.keys(claim.content||{}).length>0);
  if(!known)return out;
  const content=claim.content||{};
  const name=String(content.billing_provider_name??defaults.billing_provider_name??'').trim();
  if(!name)out.push(visitReviewCheck('practice-name',{group:'practice',blocking:true,text:'The practice has no billing provider name.',action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  const address=String(content.billing_address??defaults.billing_address??'').trim();
  if(!address)out.push(visitReviewCheck('practice-address',{group:'practice',blocking:true,text:'The claim has no billing address for the practice.',action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  const taxId=String(content.tax_id??'').trim();
  const groups=s.practice_directory?.billing_organizations||[];
  const chooseBilling=groups.length>1&&!String(content.billing_npi||'').trim();
  const editBilling=chooseBilling&&claim.status==='draft'&&claim.id?{action:'Edit billing details',attribute:`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id)}" data-signed-focus="billing_provider_name"`}:{};
  if(taxId&&(!/^\d{9}$/.test(taxId)||missing.has('tax_id')))out.push(visitReviewCheck('practice-tax',{group:'practice',blocking:true,text:`The tax ID on the claim (“${visitReviewFormValue(taxId,12)}”) is not nine digits.`,action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  else if(!taxId&&Object.keys(content).length)out.push(visitReviewCheck('practice-tax',{group:'practice',blocking:true,text:'The claim has no tax ID for the practice.',action:'Open practice billing setup',attribute:'data-billing-organizations',...editBilling}));
  for(const [field,label,fromDefault] of [['billing_npi','billing NPI','billing_npi'],['rendering_npi','rendering NPI','rendering_npi']]){
    // The NPI the claim will actually carry is the claim's own, or the practice's setup where
    // the claim has none yet; an invalid one on either side still has to be put right.
    const npi=String(content[field]??defaults[fromDefault]??'').trim();
    const destination=field==='rendering_npi'?{action:'Open provider directory',attribute:'data-practice-providers'}:
      {action:'Open practice billing setup',attribute:'data-billing-organizations'};
    // When one billing organization uses the rendering clinician's NPI, entering that NPI resolves both fields.
    if(!claim.id&&field==='billing_npi'&&!npi&&!defaults.rendering_npi&&groups.length===1&&!String(groups[0].npi||'').trim())continue;
    if(field==='billing_npi'&&chooseBilling)out.push(visitReviewCheck('practice-billing_npi',{group:'practice',blocking:true,text:'Confirm which organization bills this claim.',...editBilling}));
    else if(!npi)out.push(visitReviewCheck(`practice-${field}`,{group:'practice',blocking:true,text:`The claim has no ${label}.`,...destination}));
    else if(!/^\d{10}$/.test(npi)||(missing.has('npi')&&(!chooseBilling||!visitReviewNpiCheckDigit(npi))))out.push(visitReviewCheck(`practice-${field}`,{group:'practice',blocking:true,text:`The ${label} on the claim (“${visitReviewFormValue(npi,12)}”) is not a valid 10-digit NPI.`,...destination}));
  }
  if(missing.has('taxonomy_code')||missing.has('billing_taxonomy'))out.push(visitReviewCheck('practice-taxonomy',{group:'practice',blocking:false,text:'The provider has no specialty (taxonomy) code, so the insurer may ask for it later.',action:'Open practice billing setup',attribute:'data-billing-organizations'}));
  return out;
}
function visitReviewNpiCheckDigit(npi){
 const digits=Array.from(`80840${npi}`,Number).reverse();
 const sum=digits.reduce((total,digit,index)=>{
  const value=index%2?digit*2:digit;
  return total+(value>9?value-9:value);
 },0);
 return sum%10===0;
}
function visitReviewPatient(s,ctx={}){
  const out=[],claim=s.claim||{},content=claim.content||{};
  if(claim.id&&visitReviewClaimLoaded(claim)&&!String(content.patient_address||'').trim()){
    out.push(visitReviewCheck('patient-address',{group:'patient',blocking:true,text:'The patient’s address is missing from the claim.',action:'Edit patient address',attribute:'data-chart-section="profile"'}));
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
    if(claim.id&&visitReviewClaimLoaded(claim)&&!visitReviewFormValue(content[field],2))out.push(visitReviewCheck(`insurance-${field}`,{group:'insurance',blocking:true,text:`${label[0].toUpperCase()}${label.slice(1)} is missing from the claim.`,action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  }
  const payer=visitReviewPayer(s);
  if(!payer.known)return out;
  if(payer.payer&&s.insurance.electronic!==false&&!String(payer.payer.payer_code||'').trim())out.push(visitReviewCheck('payer-code',{group:'insurance',blocking:true,text:`${s.insurance.insurer||'This insurer'} has no insurer ID here, so the claim cannot be sent electronically.`,action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  if(payer.payer&&!String(payer.payer.name||'').trim())out.push(visitReviewCheck('payer-name',{group:'insurance',blocking:true,text:'The insurer has no name on this coverage.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  if(!claim.id&&payer.coverage&&typeof claimmdSubscriberBirthMissing==='function'){
   const patient=typeof workspace!=='undefined'&&workspace?.patient?.id===selected?workspace.patient:null;
   if(claimmdSubscriberBirthMissing(payer.coverage,patient,{claim:true}))out.push(visitReviewCheck('insurance-subscriber_birth_date',{group:'insurance',blocking:true,text:"The policy holder's date of birth is missing.",action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  }
  if(!String(payer.coverage?.member_id||'').trim())out.push(visitReviewCheck('member-id',{group:'insurance',blocking:true,text:'The member ID on this coverage is blank.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  else if(!/[!-~]{2,}/.test(String(payer.coverage.member_id)))out.push(visitReviewCheck('member-id',{group:'insurance',blocking:true,text:'The member ID on this coverage cannot be used on a claim.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  if(missing.has('group_number')||missing.has('plan_name'))out.push(visitReviewCheck('coverage-text',{group:'insurance',blocking:false,text:'The plan details on this coverage contain characters a claim file cannot hold.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  return out;
}
function visitReviewClaimDetailChecks(s,ctx={}){
  const out=[],claim=s.claim||{},content=claim.content||{};
  const missing=new Set((s.claim?.issues||[]).map(issue=>String(issue?.code||'').trim().toLowerCase()));
  const pos=String(content.place_of_service??'').trim(),loaded=visitReviewClaimLoaded(claim);
  if(claim.id&&loaded&&(!/^\d{2}$/.test(pos)||missing.has('place_of_service')))out.push(visitReviewCheck('place-of-service',{group:'claim',blocking:true,text:'The claim needs a two-digit place of service (11 = office).',action:'Fix claim details',attribute:`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id||'')}"`}));
  const codes=Array.isArray(content.diagnosis_codes)?content.diagnosis_codes.filter(code=>String(code||'').trim()):[];
  if(claim.id&&loaded&&(!codes.length||codes.some(code=>!/^[A-Za-z0-9.]+$/.test(String(code).trim()))||missing.has('diagnosis_codes')))out.push(visitReviewCheck('diagnoses',{group:'claim',blocking:true,text:'The claim needs its diagnosis codes.',action:'Fix claim details',attribute:`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id||'')}"`}));
  if(missing.has('secondary'))out.push(visitReviewCheck('secondary',{group:'claim',blocking:true,text:'This is a secondary claim and the primary insurer’s answer is not on it yet. Open the primary claim and use Review secondary billing.',action:'Open the primary claim',attribute:`data-revenue-claim="${esc(claim.parent_id||claim.id||'')}"`}));
  if(missing.has('tertiary'))out.push(visitReviewCheck('tertiary',{group:'claim',blocking:true,text:'A third insurer cannot be billed electronically from here.',action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
  return out;
}
function visitReviewNote(s,ctx={}){
  const unsigned=visitReviewVisitUnsigned(s);
  if(!unsigned)return [];
  return [visitReviewCheck('note-unsigned',{group:'visit',blocking:!visitReviewUnsignedAllowed(ctx),
    text:'Sign the note to build the claim. Problems to fix before sending:',
    action:ctx.canSign?'Sign the note':'Ask the clinician to sign the note',
    attribute:ctx.canSign?'data-visit-review-fix="note"':'data-revenue-documentation'})];
}
function visitReviewServer(s){
  const claim=s.claim||{};
  if(s.state==='fix_claim'&&Array.isArray(claim.issues))return claim.issues.map(issue=>String(issue?.missing??issue?.detail??'').trim()).filter(Boolean);
  return typeof claim.preflight_issues==='undefined'?null:(Array.isArray(claim.preflight_issues)?claim.preflight_issues:[]).map(issue=>String(issue||'').trim()).filter(Boolean);
}
// Server issue codes share keys with the local checks; wording never defines identity.
const visitReviewIssueKeys={diagnosis_codes:'diagnoses',place_of_service:'place-of-service',billing_provider_name:'practice-name',billing_organization_name:'practice-name',billing_address:'practice-address',billing_organization_address:'practice-address',tax_id:'practice-tax',billing_organization_tax_id:'practice-tax',billing_npi:'practice-billing_npi',rendering_npi:'practice-rendering_npi',rendering_provider_name:'practice-rendering-name',patient_address:'patient-address',patient_given_name:'patient-name',patient_family_name:'patient-family',subscriber_address:'insurance-subscriber_address',subscriber_birth_date:'insurance-subscriber_birth_date',subscriber_name:'insurance-subscriber_name',subscriber_relationship:'insurance-subscriber_relationship',payer_code:'payer-code',payer_name:'payer-name',member_id:'member-id',taxonomy_code:'practice-taxonomy',billing_taxonomy:'practice-taxonomy',secondary:'secondary',tertiary:'tertiary'};
const visitReviewPreflightFields=[
 [/^patient address/i,'patient_address'],[/^patient first name/i,'patient_given_name'],[/^patient last name/i,'patient_family_name'],
 [/^subscriber address/i,'subscriber_address'],[/^(subscriber|policy holder) (birth|date of birth)/i,'subscriber_birth_date'],[/^policy holder relationship/i,'subscriber_relationship'],
 [/^billing address/i,'billing_address'],[/^billing provider name/i,'billing_provider_name'],[/^tax id/i,'tax_id'],[/^billing and rendering npis/i,'npi'],
 [/^(insurer|payer) name/i,'payer_name'],[/^(insurer|payer|claim\.md payer) id/i,'payer_code'],[/^member id/i,'member_id'],[/place of service/i,'place_of_service'],
 [/^(supply 1 to 12 reviewed icd|diagnos)/i,'diagnosis_codes']
];
function visitReviewServerChecks(s){
 const claim=s.claim||{},out=[];
 const native=Array.isArray(claim.preflight_issues);
 const issues=native?[...(claim.submission_issues||[]),...claim.preflight_issues]:claim.issues||[];
 issues.forEach((issue,index)=>{
  const text=typeof issue==='string'?issue:String(issue?.message??issue?.missing??issue?.detail??'').trim();if(!text)return;
  const code=String(issue?.field||issue?.code||issue?.key||visitReviewPreflightFields.find(([pattern])=>pattern.test(text))?.[1]||'').trim().toLowerCase();
  if(native&&code==='npi'){
   for(const [field,label,attribute] of [['billing_npi','Billing NPI','data-billing-organizations'],['rendering_npi','Rendering NPI','data-practice-providers']]){
    const npi=String(claim.content?.[field]||'').trim();
    if(!/^\d{10}$/.test(npi)||!visitReviewNpiCheckDigit(npi))out.push(visitReviewCheck(`practice-${field}`,{group:'practice',blocking:true,text:`${label} needs a valid 10-digit number.`,action:`Edit ${label.toLowerCase()}`,attribute}));
   }
   return;
  }
  const group=visitBillingMissingGroups.find(g=>g.fields.includes(code))||visitBillingMissingGroups.find(g=>g.keywords.test(text));
  const key=visitReviewIssueKeys[code]||`server-${code||index}`;
  const area=key.startsWith('practice-')?'practice':key.startsWith('patient-')?'patient':key.startsWith('insurance-')?'insurance':group?.key||'claim';
  out.push(visitReviewCheck(key,{group:area,blocking:true,
   text:code==='diagnosis_codes'?'The claim needs its diagnosis codes.':native?text:`The claim is missing ${text}.`,
   action:group?.action||'Fix claim details',attribute:group?.attribute||`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id||'')}"`}));
 });
 return out;
}
function visitReviewPendingCharges(s){
 const account=visitReviewAccount();
 if(s&&account&&(account.id===s.account?.id)&&(!account.content?.visit_id||typeof activeVisit==='undefined'||account.content.visit_id===activeVisit?.id))return (account.content?.lines||[]).some(line=>line.amount_cents==null)?'Add the amount for this line before sending.':'';
 const form=$('billing-account-form');if(!form||typeof chargeTableWaiting!=='function')return '';
 return chargeTableWaiting(form)||(form.dataset.chargeSaving?'Wait for the charge changes to finish saving.':'');
}
// The whole list: everything worth a look, then everything that must be put right first.
function visitReviewChecks(s,ctx={}){
  if(!s)return [];
  s=visitReviewPreviewSummary(s);
  const out=[];
  if(visitReviewPendingCharges(s))out.push(visitReviewCheck('pending-amount',{group:'charges',blocking:true,text:'Add the amount for this line before sending.',action:'Add amount',attribute:'data-visit-review-fix="amount"'}));
  if(!ctx.claimsAllowed)out.push(visitReviewCheck('claims-not-allowed',{group:'claim',blocking:true,text:'This sign-in cannot see insurance claims, so nothing can be sent from here.',action:'',fix:'blocked'}));
  else if(s.claim?.secondary||s.claim?.crossover)out.push(visitReviewCheck('secondary-claim',{group:'claim',blocking:true,text:'This claim comes from another insurer’s answer. It is worked on from the primary claim.',action:'Open the primary claim',attribute:`data-revenue-claim="${esc(s.claim.id||'')}"`,fix:'blocked'}));
  else if(!s.insurance.insured)out.push(visitReviewCheck('self-pay',{group:'claim',blocking:false,text:'There is no insurance on this encounter, so nothing is sent to the clearinghouse. The patient is billed instead.'}));
  else{
    if(s.insurance.electronic===false)out.push(visitReviewCheck('payer-code',{group:'insurance',blocking:true,text:`${visitBillingInsurer(s)} has no insurer ID here, so no claim can be sent electronically. Add it, or record the encounter as billed outside SunCharts.`,action:'Edit insurance',attribute:'data-chart-section="insurance"'}));
    if(!s.account)out.push(visitReviewCheck('no-charges',{group:'charges',blocking:true,text:'No charges have been added to this encounter yet.',action:'Add charges',attribute:'data-encounter-charges'}));
    out.push(...visitReviewNote(s,ctx));
    out.push(...visitReviewLineProblems(s,ctx));
    if(!Array.isArray(s.claim?.preflight_issues)){
      out.push(...visitReviewPractice(s,ctx));
      out.push(...visitReviewPatient(s,ctx));
      out.push(...visitReviewInsurance(s,ctx));
      out.push(...visitReviewClaimDetailChecks(s,ctx));
    }
    out.push(...visitReviewServerChecks(s));
    if(s.claim?.status==='ready'&&!out.length)out.push(visitReviewCheck('all-clear',{group:'claim',blocking:false,text:'Nothing to check. The claim is ready and nothing has been sent yet.'}));
  }
  const unique=new Map();
  for(const check of out){
   const previous=unique.get(check.key);
   if(!previous)unique.set(check.key,check);
   else if(check.level==='must')previous.level='must';
  }
  return [...unique.values()].sort((a,b)=>(a.level===b.level?0:a.level==='must'?-1:1));
}
function visitReviewMustFix(checks){return checks.filter(check=>check.level==='must');}

function visitReviewFormMarkup(s){
  const claim=s?.claim;
  if(!claim)return '<h4>The claim form</h4><p class="muted">The claim form appears here as soon as the claim is filled in from this encounter. Review and submit the claim on the Claim.MD form.</p>';
  const content=claim.content||{},account=claim.snapshot?.account||{},patient=claim.snapshot?.patient||{},coverage=account.coverage_snapshot?.coverage?.content||{},payer=account.coverage_snapshot?.payer?.content||{};
  const field=(number,label,value)=>`<div class="visit-billing-review-field"><span>${number} · ${esc(label)}</span><b>${esc(visitReviewFormValue(value))||'—'}</b></div>`;
  const reviewLine=(charge,pointers)=>`<tr><td>${esc(visitReviewFormValue(`${charge.code_system||''} ${charge.code||''}`.trim(),13))}</td><td>${esc(visitReviewFormValue(charge.description,28))}</td><td class="money-cell">${Number(charge.units||0)||0}</td><td class="money-cell">${money(charge.amount_cents||0)}</td><td>${(pointers||[]).map(n=>esc(visitReviewFormValue((content.diagnosis_codes||[])[n-1]||'',8))).filter(Boolean).join(' ')||'—'}</td></tr>`;
  const lines=(account.content?.lines||[]).map((charge,index)=>reviewLine(charge,(content.line_diagnosis_pointers||[])[index]||[])).join('');
  const linesTable=lines?`<div class="billing-table-wrap"><table class="billing-table visit-billing-review-lines"><thead><tr><th>Code</th><th>Description</th><th class="money-cell">Units</th><th class="money-cell">Charge</th><th>Diagnoses</th></tr></thead><tbody>${lines}</tbody></table></div>`:'<p class="muted">No charge lines on this claim yet.</p>';
  return `<h4>The claim form</h4><p class="muted">A CMS-1500 view of exactly what this claim carries. Looking at it sends nothing.</p>${visitReviewLink('Open the claim form (CMS-1500)',`${visitReviewClaimsBase()}/${claim.id}/cms1500`)}<div class="visit-billing-review-fields">${field('1','Insurer',payer.name)}${field('1a','Member ID',coverage.member_id)}${field('2','Patient',`${patient.family_name||''}, ${patient.given_name||''}`.replace(/^,\s*|\s*,$/g,''))}${field('4','Policy holder',`${(coverage.relationship||'').toLowerCase()==='self'?'Same as the patient':(patient.family_name||'')+' '+(patient.given_name||'')}`)}${field('5','Patient address',content.patient_address)}${field('7','Policy holder address',content.subscriber_address)}${field('8','Billing provider',content.billing_provider_name)}${field('9','Billing NPI',content.billing_npi)}${field('10','Rendering NPI',content.rendering_npi)}${field('16','Tax ID',content.tax_id)}${field('20','Service date',account.content?.service_date)}${field('22','Place of service',content.place_of_service)}${field('21','Diagnoses',(content.diagnosis_codes||[]).join(', '))}${field('24J','Provider specialty',content.billing_taxonomy)}</div>${linesTable}`}
function visitReviewProgressMarkup(progress){
  if(!progress||!progress.steps)return '';
  const state=step=>step.status==='failed'?`<span class="visit-billing-review-step-state">Stopped: ${esc(step.reason||'it did not go through')}</span>`:step.status==='done'?`<span class="visit-billing-review-step-state">${esc(step.skipped?visitReviewStages.find(stage=>stage.key===step.key).skip:visitReviewStages.find(stage=>stage.key===step.key).done)}</span>`:`<span class="visit-billing-review-step-state">${esc(visitReviewStages.find(stage=>stage.key===step.key).doing)}</span>`;
  return `<ol class="visit-billing-review-progress" aria-label="What has happened so far">${progress.steps.map(step=>`<li class="visit-billing-review-step is-${esc(step.status)}" data-review-stage="${esc(step.key)}"><b>${esc(visitReviewStages.find(stage=>stage.key===step.key).label)}</b>${state(step)}</li>`).join('')}</ol>${progress.step?`<p class="muted" role="status">${esc(progress.step)}</p>`:''}`;
}
// Each check keeps its existing fix action, beside the data it describes.
function visitClaimCheckCard(check){
 if(['practice','visit'].includes(check.group)||/place.of.service/i.test(check.key+' '+check.text))return 'visit';
 if(['patient','insurance'].includes(check.group))return 'insurance';
 if(/^server-/.test(check.key)){
  const group=visitBillingMissingGroups.find(group=>group.keywords.test(check.text))?.key;
  if(group)return group==='practice'?'visit':'insurance';
 }
 if(/diagnos/i.test(check.key+' '+check.text)&&!/^line-/.test(check.key)&&!/every charge|Line \d/i.test(check.text))return 'diagnoses';
 return 'services';
}
function visitClaimFooter(s,ctx,checks){
 if(checks.some(check=>check.key==='note-unsigned'&&check.level==='must')&&!ctx.error&&!ctx.progress)return '';
 const blocking=visitReviewMustFix(checks).length,busy=encounterRevenueState.review?.busy===true;
 const handoff=visitHandoffEvidence(s);
 if(handoff){
  const mode=visitHandoffMode(s,visitReviewAccount());
  const action=mode==='queue'&&visitHandoffCanResume(handoff)?visitReviewButton('Resume claim submission','class="primary" data-visit-handoff-resume'):
    visitReviewButton('Refresh claim status','data-refresh-revenue');
  return `<footer id="claim-screen-footer" class="claim-screen-footer" tabindex="-1"><div data-claim-handoff-status role="status"><strong>${esc(visitHandoffStatus(handoff))}</strong><p>${esc(visitHandoffDetail(handoff))}</p></div><div class="actions">${action}</div></footer>`;
 }
 const sent=ctx.sent||['submitted','accepted','rejected','adjudicated'].includes(s.claim?.status);
 const status=visitBillingStatus(s,ctx);
 const line=ctx.error?ctx.error:ctx.progress?.step?ctx.progress.step:sent?(s.claimmd?.message||(['waiting_insurer','claimmd_received','send_claim','post_charges'].includes(s.state)?'Sent · waiting on the insurer':status.headline)):blocking?`${blocking} thing${blocking===1?'':'s'} to fix before sending`:s.state==='send_claim'?'Ready to send to the clearinghouse':status.headline;
 let action='';
 if(!sent&&ctx.canWrite&&ctx.claimsAllowed&&s.insurance?.electronic&&!s.claim?.secondary&&!s.claim?.crossover){
  if(s.state==='sign_visit')action=visitReviewButton('Send claim','class="primary" data-visit-review-send disabled');
  if(s.state==='send_claim')action=visitReviewButton('Send claim',`class="primary" data-visit-review-send${busy||blocking?' disabled':''}`);
  if(s.state==='post_charges')action=visitReviewButton('Send claim',`class="primary" data-visit-review-send${busy||blocking?' disabled':''}`);
  if(s.state==='claim_cancelled'&&ctx.canCreate&&!ctx.delegated)action=visitReviewButton('Send the claim again',`class="primary" data-claim-screen-resend${busy?' disabled':''}`);
 }
 return `<footer id="claim-screen-footer" class="claim-screen-footer" tabindex="-1"><div><p role="${ctx.error?'alert':'status'}"${blocking?' data-review-blocked':''}${ctx.error?' data-review-stalled':''}>${ctx.error?'<b>Nothing more was sent.</b> ':''}${esc(line)}</p>${visitReviewProgressMarkup(ctx.progress)}</div><div class="actions">${blocking?visitReviewButton(`${blocking} thing${blocking===1?'':'s'} to fix`,'data-claim-problems'):''}${action}</div></footer>`;
}
function visitReviewPanelBody(s,ctx={}){return visitReviewPanelMarkup(s,ctx);}
// The claim owns its scrolling; reserve the measured footer height even when it wraps.
function visitClaimLayout(){
 const screen=$('visit-billing-review'),footer=$('claim-screen-footer');
 if(!screen?.getBoundingClientRect||!footer?.getBoundingClientRect||!screen.getClientRects().length)return;
 const height=footer.getBoundingClientRect().height;
 screen.style.setProperty('--claim-footer-height',height+'px');
 screen.style.setProperty('--claim-area-height',Math.max(height+80,window.innerHeight-screen.getBoundingClientRect().top-16)+'px');
 if(typeof ResizeObserver==='function'&&!footer.claimLayoutObserver){
  footer.claimLayoutObserver=new ResizeObserver(()=>visitClaimLayout());footer.claimLayoutObserver.observe(footer);
 }
}
function visitClaimRenderingProvider(content,details){
 const npi=content.rendering_npi||details.rendering_npi||'';
 const directory=typeof claimmdProviderDefaults!=='undefined'?claimmdProviderDefaults.providers||[]:[];
 const provider=directory.find(row=>npi&&row.npi===npi);
 const name=content.rendering_provider_name||details.rendering_provider_name||provider?.display_name||'Provider name not recorded';
 return `${esc(name)}${npi?` <span class="muted">NPI ${esc(npi)}</span>`:''}`;
}
// A draft claim contains just the checks that still need attention. Reuse each check's
// actual fix target so two missing practice fields take staff to billing setup once.
function visitDraftClaimIssues(checks,ctx){
 const groups=new Map();
 for(const check of checks){
  if(['note-unsigned','all-clear','self-pay'].includes(check.key))continue;
  const target=check.attribute||check.group;
  if(!groups.has(target))groups.set(target,[]);
  groups.get(target).push(check);
 }
 const items=[...groups.values()].map(group=>{
  const first=group[0],practice=['data-billing-organizations','data-practice-providers'].includes(first.attribute),blocking=group.some(check=>check.level==='must');
  const mayFix=ctx.claimsAllowed&&ctx.canWrite&&(!practice||typeof me!=='undefined'&&me?.role==='owner');
  const issues=group.map(check=>{
   const text=check.key==='practice-tax'?'The practice tax ID is missing or invalid.':check.text;
   return `<span data-check="${esc(check.key)}" data-check-level="${esc(check.level)}">${esc(text)}</span>`;
  }).join(' ');
  const action=mayFix&&first.action&&first.attribute?visitReviewButton(first.action,`class="text-button" ${first.attribute}`):'';
  return `<li data-draft-claim-fix-group><strong>${blocking?'Fix before sending':'Review'}</strong> ${issues} ${action}</li>`;
 }).join('');
 return items?`<ul data-draft-claim-issues aria-label="Claim items to review">${items}</ul>`:'';
}
function visitSignedClaimIssueAction(check,s,ctx) {
 if(!ctx.canWrite||!ctx.claimsAllowed)return '';
 const owner=typeof me!=='undefined'&&me?.role==='owner';
 const groups=s.practice_directory?.billing_organizations||[],org=groups.length===1?groups[0]:null;
 if(['no-charges','no-services'].includes(check.key)&&!s.account&&ctx.canCreate===false)return '';
 if(['no-charges','no-services'].includes(check.key))return visitReviewButton('Add procedures','class="primary" data-encounter-codes-anchor data-signed-claim-codes="procedures"');
 if(check.key==='practice-rendering_npi'&&!s.claim?.id){
  const assigned=s.visit?.clinician_id||(typeof activeVisit!=='undefined'?activeVisit:null)?.clinician_id;
  return visitReviewButton('Choose rendering provider','data-signed-claim-codes="rendering"')+(owner&&assigned?visitReviewButton('Edit provider profile',`data-claim-provider-profile="${esc(assigned)}"`):'');
 }
 if(check.key==='practice-billing_npi'&&!s.claim?.id)return owner?visitReviewButton('Edit billing organization',org?.id?`data-claim-billing-org="${esc(org.id)}"`:'data-billing-organizations'):'';
 const claim=s.claim,draft=claim?.id&&claim.status==='draft';
 if(check.key==='insurance-subscriber_relationship'&&claim?.can_confirm_self_policyholder)return visitReviewButton('Confirm policy holder','data-signed-confirm-policyholder');
 if(check.key==='patient-address')return visitReviewButton('Edit patient address','data-chart-section="profile"');
 if(['practice-taxonomy','practice-rendering-name'].includes(check.key))return owner?visitReviewButton('Edit provider profile','data-practice-providers'):'';
 const fields={'insurance-subscriber_address':'subscriber_address','insurance-subscriber_birth_date':'subscriber_birth_date','practice-address':'billing_address','practice-name':'billing_provider_name','practice-tax':'tax_id','place-of-service':'place_of_service'};
 if(draft&&fields[check.key]){
  const labels={'insurance-subscriber_address':'Edit policy holder address','insurance-subscriber_birth_date':'Edit policy holder birth date','practice-address':'Edit billing address','practice-name':'Edit billing provider','practice-tax':'Edit tax ID','place-of-service':'Edit place of service'};
  return visitReviewButton(labels[check.key],`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id)}" data-signed-focus="${fields[check.key]}"`);
 }
 if(check.attribute==='data-billing-organizations'||check.attribute==='data-practice-providers'){
  if(s.claim?.status==='draft'&&['practice-billing_npi','practice-rendering_npi'].includes(check.key))return visitReviewButton('Edit claim NPI',`data-visit-review-fix="claim" data-visit-claim-fix="${esc(s.claim.id)}" data-signed-focus="${check.key.slice(9)}"`);
  if(!owner)return '';
 }
 if(check.attribute==='data-chart-section="insurance"'){
  const coverages=typeof workspace!=='undefined'?workspace?.billing?.coverages||[]:[];
  const account=s.claim?.snapshot?.account||visitReviewAccount()||s.account;
  const id=account?.coverage_snapshot?.coverage?.id||account?.content?.coverage_id||s.insurance?.coverage_id;
  if(id&&coverages.some(row=>row.id===id)){
   const focus={'member-id':'member_id','insurance-subscriber_birth_date':'subscriber_birth_date','insurance-subscriber_name':'subscriber_name','insurance-subscriber_relationship':'relationship','payer-code':'payer','payer-name':'payer'};
   return visitReviewButton('Edit insurance',`data-signed-coverage="${esc(id)}" data-signed-focus="${focus[check.key]||'plan_name'}"`);
  }
 }
 return check.action&&check.attribute?visitReviewButton(check.action,check.attribute):'';
}
function visitSignedClaimChecks(s,ctx,sent){
 if(sent)return [];
 const checks=visitReviewChecks(s,ctx).filter(row=>!['all-clear','self-pay'].includes(row.key));
 const account=s.claim?.snapshot?.account||visitReviewAccount()||s.account;
 if(!s.claim?.id&&Array.isArray(account?.content?.lines)&&!account.content.lines.some(row=>String(row.code||'').trim())&&!checks.some(row=>row.key==='no-charges')){
  checks.unshift(visitReviewCheck('no-services',{group:'charges',blocking:true,text:'Add a procedure to prepare this claim.'}));
 }
 const defaults=visitReviewProviderDefaults(s);
 return checks.map(check=>{
  if(check.key==='practice-rendering_npi'&&defaults.rendering_provider_name&&!defaults.rendering_npi)return {...check,text:`Rendering NPI missing for ${defaults.rendering_provider_name}.`};
  if(check.key==='practice-billing_npi'&&defaults.billing_organization_name&&!defaults.billing_npi)return {...check,text:`Billing NPI missing for ${defaults.billing_organization_name}.`};
  return check;
 });
}
function visitEncounterClaimStatus(s,ctx,sent){
 let label='Claim details';
 const handoff=visitHandoffEvidence(s),checks=visitSignedClaimChecks(s,ctx,sent);
 const blocking=visitReviewMustFix(checks),missing=blocking.find(row=>['no-charges','no-services'].includes(row.key))||blocking[0];
 const unsigned=visitReviewVisitUnsigned(s);
 // Procedure and diagnosis entry have one launcher in Visit. Keep coding fixes inside Claim details.
 const codeIssue=missing&&(missing.group==='charges'||missing.attribute==='data-encounter-charges'||missing.key.startsWith('line-'));
 const status=visitBillingStatus(s,ctx);
 const ready=visitSignedClaimReady(s,ctx,sent,blocking);
 let line=status.headline,hint='',action='',feedback='';
 if(handoff){
  line=visitHandoffStatus(handoff);hint=visitHandoffDetail(handoff);
  if(visitHandoffCanResume(handoff)&&missing)action=codeIssue?'':visitSignedClaimIssueAction(missing,s,ctx);
  else if(visitHandoffCanResume(handoff)&&visitHandoffMode(s,visitReviewAccount())==='queue')action=visitReviewButton('Resume claim submission','class="primary" data-visit-handoff-resume');
 }else if(ctx.error||ctx.progress?.step){
  line=ctx.error||ctx.progress.step;
  feedback=visitReviewProgressMarkup(ctx.progress);
 }else if(!ctx.claimsAllowed){line='Claims access is required for this encounter.';}
 else if(s.state==='claim_cancelled'&&ctx.canCreate&&!ctx.delegated){
  line='Claim cancelled';action=visitReviewButton('Send the claim again','class="primary" data-claim-screen-resend');
 }else if(sent){
  hint=status.detail;
  if(s.state==='post_response')hint='Review the payment in the Payment section.';
  if(s.state==='claim_rejected')label='Review returned claim';
  if(s.state==='denied')label='Review payer decision';
 }else if(unsigned){
  line='Needs clinician signature';
 }else if(missing){
  line=['no-charges','no-services'].includes(missing.key)?'Add procedures to prepare the claim':missing.text;
  action=codeIssue?'':visitSignedClaimIssueAction(missing,s,ctx);
 }else if(ready){
  line=ready.title;hint=ready.next;label=ready.action==='Review and send'?'Review claim':'Claim details';
 }else if(status.action&&!status.action.includes('data-visit-review-open'))action=status.action;
 const details=visitReviewButton(label,`${!action&&ctx.claimsAllowed?'class="primary" ':''}data-open-signed-claim-details aria-haspopup="dialog"`);
 return `<div data-encounter-claim-summary ${unsigned?'':'data-signed-claim-summary'}><div id="claim-screen-footer" class="signed-claim-summary" tabindex="-1"><div ${handoff?'data-claim-handoff-status ':''}role="${ctx.error?'alert':'status'}"><strong>${esc(line)}</strong>${hint?`<p class="muted signed-claim-hint">${esc(hint)}</p>`:''}${feedback}</div><div class="actions">${action}${ctx.claimsAllowed&&!unsigned?details:''}</div></div></div>`;
}
// Summarize the recorded clearinghouse and payer evidence separately. A rejected claim can
// have a clearinghouse receipt without ever having a payer receipt.
function visitSignedClaimStage(s,detail){
 const claim=detail?.claim||s.claim||{},tracking=detail?.tracking||{};
 const position=detail?.claimmd_position||claim.claimmd_position||s.claimmd||{};
 const reports=(tracking.reports||[]).map(row=>row.evidence||{});
 const received=reports.some(row=>row.senderid==='CLMMD'&&String(row.message?.status||row.status).toUpperCase()==='A');
 const payerAccepted=claim.payer_acceptance_recorded||claim.status==='accepted'||claim.status==='adjudicated'||(typeof claimResendPlan==='function'
  ?claimResendPlan(claim).kind==='replacement':!!claim.payer_control_number);
 const rejection=[...reports].reverse().find(row=>[row.message?.status,row.status].some(value=>String(value).toUpperCase()==='R'));
 const feed=detail?.responses?.feed?.[0];
 const sender=String(rejection?.senderid||feed?.sender||'').toUpperCase();
 const savedReason=detail?.responses?.revisions?.find(row=>['record_rejection','record_denial'].includes(row.action))?.reason;
 const responseReason=rejection?.message?.message||feed?.message||savedReason;
 const held=position.needs_correction||s.state==='claimmd_correction';
 const rejected=claim.status==='rejected',denied=claim.status==='adjudicated'&&(tracking.payer_denied===true||s.claim?.answer?.denied===true);
 const delivered=tracking.submissions?.some(row=>row.status==='delivered');
 const prepared=tracking.submissions?.some(row=>row.status==='prepared');
 const handoff=visitHandoffEvidence(s);
 const returnedBeforeAcceptance=rejected&&!payerAccepted;
 const delivery=held?'Held by the clearinghouse':returnedBeforeAcceptance&&sender==='CLMMD'?'Returned by the clearinghouse':
  received||position.acknowledged||delivered?'Received by the clearinghouse':
  tracking.external_submission_recorded?'Recorded as sent outside SunCharts':
  handoff?visitHandoffStatus(handoff):prepared?'File prepared · receipt unconfirmed':
  ['submitted','accepted','adjudicated','rejected'].includes(claim.status)?'Delivery receipt unconfirmed':
  claim.status==='void'?'Voided':claim.id?'Awaiting submission':'Claim not created';
 const payer=denied?'Denied by the payer':returnedBeforeAcceptance?'No payer acceptance on file':
  claim.status==='adjudicated'?tracking.remittance_posted?(tracking.paid_cents>0?'Payment posted':'Payer response posted'):'Payer response received':
  payerAccepted?'Acceptance recorded':held?'No payer acceptance on file':
  claim.status==='submitted'?'Waiting for a response':'No payer response recorded';
 if(held)return {tone:'warning',title:'Clearinghouse correction needed',reason:position.correction?.message||position.message||s.claimmd?.message||'',delivery,payer,next:'Review the clearinghouse response before resubmitting.'};
 if(rejected){
  const title=typeof visitBillingReturnTitle==='function'?visitBillingReturnTitle(claim):returnedBeforeAcceptance?'Returned before payer acceptance':'Claim returned after payer acceptance';
  return {tone:'warning',title,reason:responseReason||'',delivery,payer,next:'Review the response and correct the claim before resubmitting.'};
 }
 if(denied)return {tone:'warning',title:'Payer denial',reason:responseReason||'',delivery,payer,next:s.state==='denied'?'Review the payer’s response before choosing how to resolve the balance.':'See Payment for the current balance.'};
 if(claim.status==='submitted'&&!payerAccepted&&(received||position.acknowledged)){
  return {tone:'neutral',title:'Received by the clearinghouse',reason:'',delivery,payer,next:'Waiting for payer acceptance.'};
 }
 const status=visitBillingStatus(s);
 return {tone:'neutral',title:status.headline,reason:'',delivery,payer,next:status.detail};
}
function visitSignedClaimReady(s,ctx,sent,blocking){
 const claim=s.claim;
 if(sent||!claim?.id||!['draft','ready'].includes(claim.status)||s.state!=='send_claim'||visitHandoffEvidence(s)||
  (blocking||visitReviewMustFix(visitSignedClaimChecks(s,ctx,false))).length)return null;
 const account=claim.snapshot?.account||visitReviewAccount();
 const details=account?.content?.claim_details||{};
 const options=(title,next)=>({title,next,action:ctx.canWrite?'Review billing options':'',attribute:'data-signed-claim-review="options"',options:true});
 const unsent='This claim has not been sent.';
 if(claim.file_prepared)return options('Claim file on record','Review the existing file for delivery status.');
 if(details.paper_only)return options('Paper claim',unsent);
 if(details.review_requested)return options('On hold for review',unsent);
 const mode=ctx.canWrite&&ctx.claimsAllowed?visitHandoffMode(s,account):null;
 if(mode==='prepare')return {title:'Ready for billing review',next:unsent,action:'Prepare claim',attribute:`data-visit-review-send="${esc(claim.id)}"`};
 if(mode==='queue')return {title:'Ready to send',next:unsent,action:'Review and send',attribute:`data-visit-review-send="${esc(claim.id)}"`};
 return options('Ready for billing review','Billing staff can review and send this claim. It has not been sent.');
}
function visitSignedClaimAuthorization(s,ctx,sent,checking){
 const claim=s.claim;
 if(!claim?.id)return '';
 const number=String(claim.content?.encounter?.prior_authorization_number||'').trim();
 const editable=!sent&&claim.status==='draft'&&visitReviewClaimLoaded(claim)&&!claim.file_prepared&&!visitHandoffEvidence(s)&&ctx.canWrite&&
  (typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('claims','edit'));
 const title='Prior authorization <span class="signed-claim-box-number">(Box 23)</span>';
 return editable?`<div data-signed-claim-auth-field><dt><label for="signed-claim-auth">${title}</label></dt><dd data-signed-claim-authorization><input id="signed-claim-auth" name="prior_authorization_number" data-signed-claim-auth maxlength="50" autocomplete="off" aria-describedby="signed-claim-auth-status" value="${esc(number)}" placeholder="If required"${checking?' disabled':''}><p class="muted" data-signed-claim-auth-status id="signed-claim-auth-status" role="status"></p><div class="actions" data-signed-claim-auth-recovery hidden><button type="button" data-signed-claim-auth-retry>Retry saving</button><button type="button" data-signed-claim-auth-discard>Discard unsaved change</button></div></dd></div>`:
  `<div data-signed-claim-auth-field><dt>${title}</dt><dd data-signed-claim-authorization>${esc(number||'Not entered')}</dd></div>`;
}
function visitSignedClaimOverview(s,ctx,sent,detail,ready=null,checking=false){
 const claim=detail?.claim||s.claim||{},account=claim.snapshot?.account||visitReviewAccount()||s.account||{};
 const patient=claim.snapshot?.patient||(typeof workspace==='undefined'?null:workspace?.patient)||{};
 const name=[patient.given_name,patient.family_name].filter(Boolean).join(' ');
 const insurer=account.coverage_snapshot?.payer?.content?.name||visitBillingInsurer(s);
 const dateValue=visitBillingDate(account.content?.service_date||s.account?.service_date||String(s.visit?.starts_at||'').slice(0,10));
 const total=account.total_cents??s.charges_cents;
 const info=(label,value)=>value!=null&&value!==''?`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`:'';
 const handoff=!sent&&visitHandoffEvidence(s);
 const blocking=!sent&&!ready&&visitReviewMustFix(visitSignedClaimChecks(s,ctx,false)).length;
 const stage=checking?{tone:'neutral',title:'Checking claim details…',next:''}:ready?{tone:'neutral',title:ready.title,next:ready.next}:
  blocking&&claim.id&&!handoff?{tone:'warning',title:'Needs information',next:'Review the highlighted fields before sending.'}:
  handoff?{tone:'neutral',title:visitHandoffStatus(handoff),next:visitHandoffDetail(handoff)}:visitSignedClaimStage(s,detail);
 const reviewType=stage.tone==='warning'?'response':'delivery';
 const review=sent&&claim.id&&ctx.claimsAllowed?visitReviewButton(reviewType==='response'?'Review response':'View delivery history',`class="primary" data-signed-claim-review="${reviewType}"`):'';
 const authorization=visitSignedClaimAuthorization({...s,claim},ctx,sent,checking);
 const readyActions=claim.id&&!sent&&!checking&&ctx.claimsAllowed?`<div class="actions signed-claim-ready-actions">${ready?.action?visitReviewButton(ready.action,`class="primary" data-signed-claim-continue ${ready.attribute}`):''}${visitReviewButton('Preview claim form',`data-encounter-claim-form="${esc(claim.id)}"`)}</div>`:'';
 return `<div class="signed-claim-identity">${name?`<p class="signed-claim-person">${esc(name)}</p>`:''}${claim.control_number?`<p class="muted">Claim ${esc(claim.control_number)}</p>`:''}</div>
 <dl class="signed-claim-meta">${info('Payer',insurer)}${info('Service date',dateValue)}${info('Billed',Number.isSafeInteger(total)?money(total):null)}${authorization}</dl>
 <section class="signed-claim-stage" data-tone="${stage.tone}" aria-label="Claim status">
 <h4>${esc(stage.title)}</h4>${stage.reason?`<p class="signed-claim-reason">${esc(stage.reason)}</p>`:''}
 ${sent?`<dl class="signed-claim-stage-facts">${info('Clearinghouse',stage.delivery)}${info('Payer response',stage.payer)}</dl>`:''}
 ${stage.next?`<p class="signed-claim-next">${esc(stage.next)}</p>`:''}${readyActions||review}
 </section>`;
}
function visitSignedClaimDetailBody(s,ctx,sent,ready=visitSignedClaimReady(s,ctx,sent),checking=false){
 const visit=typeof activeVisit==='undefined'?s.visit:activeVisit;
 const claim=s.claim,account=claim?.snapshot?.account||visitReviewAccount()||s.account||{},content=claim?.content||{},defaults=visitReviewProviderDefaults(s);
 const coverage=account.coverage_snapshot?.coverage?.content||visitReviewPayer(s).coverage||{};
 const lines=account.content?.lines||[],diagnoses=content.diagnosis_codes||[...new Set(lines.flatMap(row=>row.diagnosis_codes||[]))];
 const remaining=new Set(visitSignedClaimChecks(s,ctx,sent));
 const mayEdit=!sent&&ctx.canWrite&&ctx.claimsAllowed;
 const button=(label,attrs)=>mayEdit?visitReviewButton(label,attrs):'';
 const issues=predicate=>[...remaining].filter(predicate).map(check=>{
  remaining.delete(check);
  const action=visitSignedClaimIssueAction(check,s,ctx);
  const ownerOnly=check.attribute==='data-billing-organizations'||check.attribute==='data-practice-providers';
   return `<p class="signed-claim-issue" data-check="${esc(check.key)}" data-check-level="${check.level}"><span data-claim-warning>${esc(check.key==='practice-tax'?'The practice tax ID is missing or invalid.':check.text)}</span> ${action||(!action&&ownerOnly&&!sent?'Ask a practice owner to update this field.':'')}</p>`;
 }).join('');
 const field=(label,value,problems='',action='')=>`<div class="signed-claim-field"><dt>${esc(label)}</dt><dd>${esc(value||(problems?'':'Not recorded'))}${problems}${action?'<div>'+action+'</div>':''}</dd></div>`;
 const match=(...keys)=>check=>keys.includes(check.key);
 const org=defaults.billing_organization_name||content.billing_provider_name||account.content?.claim_details?.billing_provider_name;
 const rendering=content.rendering_provider_name||account.content?.claim_details?.rendering_provider_name||defaults.rendering_provider_name
  ||s.practice_directory?.providers?.find(row=>row.id===(s.visit?.clinician_id||visit?.clinician_id))?.display_name||s.visit?.clinician_name;
 const renderNpi=content.rendering_npi||account.content?.claim_details?.rendering_npi||defaults.rendering_npi;
 const billingNpi=content.billing_npi||defaults.billing_npi;
 const editClaim=mayEdit&&(!claim?.id||claim.status==='draft')?button('Edit claim details',claim?.id?`data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id)}"`:'data-details-edit'):'';
 const services=lines.length?lines.map((line,index)=>{
  const assigned=content.line_diagnosis_pointers?.[index]?.map(n=>diagnoses[n-1]).filter(Boolean)||line.diagnosis_codes||[];
  return `<li><b>${esc(line.code||'Procedure')}</b> ${esc(line.description||'')} · ${esc(line.units||1)} unit${Number(line.units||1)===1?'':'s'} · ${money(line.amount_cents||0)}${assigned.length?' · '+esc(assigned.join(', ')):''}${issues(check=>check.key.startsWith('line-'+index+'-'))}</li>`;
 }).join(''):'';
 const memberIssues=issues(match('member-id'));
 const insurerIssues=issues(check=>check.group==='insurance'&&!check.key.includes('subscriber'));
 const subscriberAddressIssues=issues(match('insurance-subscriber_address'));
 const subscriberIssues=issues(check=>check.group==='insurance');
 const patientIssues=issues(check=>check.group==='patient');
 const placeIssues=issues(match('place-of-service')),orgIssues=issues(match('practice-tax','practice-name')),billingAddressIssues=issues(match('practice-address'));
 const codingChecks=issues(check=>check.key==='diagnoses'||check.group==='charges');
 const renderIssues=issues(match('practice-rendering_npi')),providerIssues=issues(match('practice-rendering-name','practice-taxonomy')),billingIssues=issues(match('practice-billing_npi'));
 const groups=s.practice_directory?.billing_organizations||[];
 const usesRendering=!claim?.id&&groups.length===1&&!String(groups[0].npi||'').trim();
 const editableCoverage=mayEdit&&!insurerIssues&&!memberIssues&&!subscriberIssues&&!subscriberAddressIssues?button('Edit insurance','data-chart-section="insurance"'):'';
 const coding=mayEdit&&!codingChecks?button('Edit codes','data-encounter-codes-anchor'):'';
 const rest=visitReviewVisitUnsigned(s)?visitDraftClaimIssues([...remaining],ctx):issues(()=>true),denial=visitBillingDenialActions(s,ctx);
 const form=ctx.claimsAllowed&&(sent||!claim?.id)?visitReviewButton('Preview claim form','data-encounter-claim-form'):'';
 const options=ready&&!ready.options?visitReviewButton('More claim actions','data-signed-claim-review="options"'):'';
 const cached=typeof claimDetailCache==='function'?claimDetailCache(claim):null;
 return `<div data-signed-claim-overview>${visitSignedClaimOverview(s,ctx,sent,sent?cached:null,ready,checking)}</div>
 <details class="signed-claim-disclosure" data-inline data-signed-claim-information${sent||ready||checking?'':' open'}><summary>Claim information</summary>
 <dl class="signed-claim-fields">${insurerIssues||editableCoverage?field('Insurance',visitBillingInsurer(s),insurerIssues,editableCoverage):''}${field('Member ID',coverage.member_id,memberIssues)}${subscriberIssues?field('Policy holder',coverage.subscriber_name,subscriberIssues):''}${subscriberAddressIssues?field('Policy holder address',content.subscriber_address,subscriberAddressIssues):''}${patientIssues?field('Patient address',content.patient_address,patientIssues):''}${field('Rendering provider',rendering,providerIssues)}${field('Rendering NPI',renderNpi,renderIssues)}${field('Billing organization',org,orgIssues)}${billingAddressIssues?field('Billing address',content.billing_address,billingAddressIssues):''}${field('Billing NPI',usesRendering?(billingNpi?billingNpi+' · Uses the rendering clinician’s NPI':'Uses the rendering clinician’s NPI'):billingNpi,billingIssues)}${field('Place of service',content.place_of_service||account.content?.claim_details?.place_of_service||defaults.place_of_service,placeIssues,editClaim)}</dl>
 <section><h4>Diagnoses &amp; procedures</h4>${diagnoses.length?`<p>${esc(diagnoses.join(', '))}</p>`:''}${services?`<ul>${services}</ul>`:''}${codingChecks}${coding}</section>${rest}${options}</details>
 <details class="signed-claim-disclosure" data-inline data-signed-claim-activity${ready?' hidden':''}><summary>${sent?'Claim history and activity':'Claim options'}</summary><p class="muted" data-signed-claim-activity-status role="status" hidden></p><div data-claim-secondary-host></div></details>
 ${denial||form?`<details class="signed-claim-disclosure" data-inline data-signed-claim-other><summary>${denial?'Other claim actions':'Claim form'}</summary><div class="actions">${denial}${form}</div></details>`:''}`;
}
function visitOpenSignedClaimDetails(button){
 const stored=encounterRevenueState.data?.summary,ctx=visitReviewContext(),person=selected,visit=typeof activeVisit==='undefined'?null:activeVisit?.id,identity=me;
 if(!stored||!ctx.claimsAllowed||stored.visit?.id!==visit||stored.patient_id!==person)return;
 const existing=document.querySelector('dialog[data-signed-claim-details][open]:not([data-closing])');
 if(existing?.dataset.signedClaimDetails===String(stored.claim?.id||''))return existing;
 let s=visitReviewPreviewSummary(stored);
 const node=document.createElement('div');
 const sent=['submitted','accepted','rejected','adjudicated'].includes(s.claim?.status)||encounterRevenueState.review?.sent===true;
 const checking=!sent&&['draft','ready'].includes(s.claim?.status)&&!visitHandoffEvidence(s);
 node.innerHTML=visitSignedClaimDetailBody(s,ctx,sent,undefined,checking);
 const dialog=sheetOpen('Claim details',node,{className:'chart-record-sheet signed-claim-dialog',label:true});
 dialog.dataset.signedClaimDetails=stored.claim?.id||'';
 if(!ctx.canWrite)dialog.setAttribute('data-signed-claim-read-only','');
 if(typeof encounterClaimOptionsMount==='function')encounterClaimOptionsMount(dialog);
 const claimId=s.claim?.id,accountId=s.account?.id||s.claim?.snapshot?.account?.id||visitReviewAccount()?.id;
 const current=()=>dialog.isConnected&&dialog.open&&!dialog.dataset.closing&&person===selected&&visit===activeVisit?.id&&identity===me&&encounterRevenueState.data?.summary?.claim?.id===claimId;
 const matched=claim=>current()&&claim?.id===claimId&&claim.patient_id===person&&claim.account_id===accountId;
 const overview=node.querySelector('[data-signed-claim-overview]');
 const information=node.querySelector('[data-signed-claim-information]');
 const auth=overview.querySelector('[data-signed-claim-auth-field]');
 const input=auth?.querySelector('[data-signed-claim-auth]');
 const authStatus=auth?.querySelector('[data-signed-claim-auth-status]');
 const recovery=auth?.querySelector('[data-signed-claim-auth-recovery]');
 const retry=auth?.querySelector('[data-signed-claim-auth-retry]');
 let authWork,authTimer,savedDetail,actionPending=false,replaying=false;
 const dirty=()=>input&&input.value.trim()!==input.defaultValue.trim();
 const showReviewError=message=>{
  let status=overview.querySelector('[data-signed-claim-review-error]');
  if(!status){
   status=document.createElement('p');status.className='signed-claim-issue';status.dataset.signedClaimReviewError='';status.setAttribute('role','alert');
   overview.querySelector('.signed-claim-stage').append(status);
  }
  status.textContent=message;
 };
 const repaint=()=>{
  const oldFocus=document.activeElement,wasEditing=oldFocus===input;
  const template=document.createElement('template');
  const ready=visitSignedClaimReady(s,ctx,false);
  template.innerHTML=visitSignedClaimDetailBody(s,ctx,false,ready);
  const next=template.content.querySelector('[data-signed-claim-overview]');
  if(input&&next.querySelector('[data-signed-claim-auth]')){
   input.disabled=false;
   next.querySelector('[data-signed-claim-auth-field]').replaceWith(auth);
  }
  overview.replaceChildren(...next.childNodes);
  information.replaceChildren(...template.content.querySelector('[data-signed-claim-information]').childNodes);
  if(visitReviewMustFix(visitSignedClaimChecks(s,ctx,false)).length)information.open=true;
  if(wasEditing&&input.isConnected)input.focus({preventScroll:true});
  activity.hidden=!!ready;
 };
 const loadSavedClaim=async()=>{
  const detail=await api(`${visitReviewClaimsBase()}/${encodeURIComponent(claimId)}`);
  if(!matched(detail?.claim)||detail.claim.status!==s.claim.status||detail.claim.version<s.claim.version)throw new Error('The claim changed. Reopen Claim details to review the current claim.');
  savedDetail=detail;
  const claim={...s.claim,...detail.claim,can_confirm_self_policyholder:detail.can_confirm_self_policyholder===true,preflight_issues:detail.preflight_issues,
   submission_issues:visitHandoffMode(s,detail.claim.snapshot?.account)==='queue'&&!claimHasPreparedSubmission(detail)?detail.submission_issues:[]};
  if(claimHasRecordedSubmission(detail)||claimHasPreparedSubmission(detail))claim.file_prepared=true;
  const state=s.state==='fix_claim'&&Array.isArray(detail.preflight_issues)&&!detail.preflight_issues.length?'send_claim':s.state;
  if(input&&!dirty()&&!authWork){input.value=String(claim.content?.encounter?.prior_authorization_number||'').trim();input.defaultValue=input.value;}
  s={...s,state,claim};
  repaint();
  return claim;
 };
 const flushAuthorization=()=>{
  clearTimeout(authTimer);
  if(authWork)return authWork;
  if(!dirty())return Promise.resolve(true);
  authStatus.textContent='Saving…';recovery.hidden=true;
  authWork=(async()=>{
   try{
    while(current()&&dirty()){
     const value=input.value,expected=input.defaultValue.trim();
     const saved=await chargePriorAuthorizationSave(claimId,value,matched,expected);
     if(!matched(saved))return false;
     const number=String(saved.content?.encounter?.prior_authorization_number||'').trim();
     if(input.value===value)input.value=number;
     input.defaultValue=number;
     s={...s,claim:{...s.claim,...saved}};
    }
    if(!current())return false;
    authStatus.textContent='Saved';
    return true;
   }catch(error){
    if(current()){authStatus.textContent='Could not save. '+visitClaimErrorText(error);recovery.hidden=false;}
    return false;
   }
  })().finally(()=>authWork=null);
  return authWork;
 };
 input?.addEventListener('input',()=>{
  if(!current())return;
  clearTimeout(authTimer);
  if(!authWork)authStatus.textContent=dirty()?'Unsaved changes':'';
  if(dirty())authTimer=setTimeout(()=>void flushAuthorization(),450);
 });
 const finishClose=async()=>{
  if(await flushAuthorization()&&current()){
   sheetClose(dialog);
   void loadEncounterRevenueStatus(encounterChargeAccount(),true);
  }else if(current()){input?.focus();}
 };
 dialog.addEventListener('cancel',event=>{
  if(!dirty()&&!authWork)return;
  event.preventDefault();event.stopImmediatePropagation();void finishClose();
 },true);
 if(sent&&claimId){
  // The visit summary includes the claim ID. Read the matched, existing claim for its saved
  // response, without opening the claim editor or checking with the clearinghouse.
  void api(`${visitReviewClaimsBase()}/${encodeURIComponent(claimId)}`).then(detail=>{
   if(current()&&detail?.claim?.id===claimId&&detail.claim.patient_id===person&&detail.claim.account_id===accountId){
    const focused=overview.contains(document.activeElement);
    overview.innerHTML=visitSignedClaimOverview(s,ctx,sent,detail);
    if(focused)overview.querySelector('[data-signed-claim-review]')?.focus({preventScroll:true});
   }
  }).catch(()=>{
   if(current())overview.querySelector('.signed-claim-stage')?.insertAdjacentHTML('beforeend','<p class="muted">Saved responses could not be loaded. Open claim history and activity to try again.</p>');
  });
 }
 const activity=dialog.querySelector('[data-signed-claim-activity]');
 const activityStatus=activity.querySelector('[data-signed-claim-activity-status]');
 let activityLoad;
 const loadActivity=async()=>{
  if(activity.hidden||!current()||!claimId||!accountId)return false;
  if(activity.querySelector('#encounter-claims-detail .billing-account-detail')&&encounterClaimRoute()?.claim===claimId)return true;
  if(!activityLoad){
   activityStatus.hidden=false;
   activityStatus.textContent='Loading claim history…';
   activityLoad=showEncounterClaim(claimId,accountId,{savedActivityOnly:true}).then(()=>{
    activityStatus.hidden=true;
    return true;
   }).catch(()=>{
    activityStatus.textContent='Claim history could not be loaded. Reopen claim history to try again.';
    return false;
   }).finally(()=>activityLoad=null);
  }
  return activityLoad;
 };
 activity.addEventListener('toggle',()=>{if(activity.open)void loadActivity();});
 if(checking)void loadSavedClaim().catch(error=>{
  if(!current())return;
  repaint();
  showReviewError(visitClaimErrorText(error));
 });
 const restore=()=>{if(typeof encounterClaimOptionsRestore==='function')encounterClaimOptionsRestore(dialog);};
 dialog.addEventListener('close',()=>{
  clearTimeout(authTimer);
  restore();
  if(dialog.dataset.handoff||person!==selected||visit!==activeVisit?.id||identity!==me)return;
  const launcher=button?.isConnected?button:$('visit-page-host')?.querySelector('[data-encounter-claim-status] [data-open-signed-claim-details]');
  launcher?.focus({preventScroll:true});
 },{once:true});
 // A native editor owns its own form and drafts. Return the original ancillary controls to their
 // owner before routing into that editor, including during a background refresh of claim details.
 dialog.addEventListener('click',event=>{
  const action=event.target.closest('button');
  if(person!==selected||visit!==activeVisit?.id||identity!==me){event.preventDefault();event.stopPropagation();restore();dialog.close();dialog.remove();return;}
  const close=event.target===dialog||action?.hasAttribute('data-sheet-close');
  if(close&&(dirty()||authWork)){event.preventDefault();event.stopImmediatePropagation();void finishClose();return;}
  if(retry&&action===retry){event.preventDefault();event.stopImmediatePropagation();void flushAuthorization();return;}
  if(action?.hasAttribute('data-signed-claim-auth-discard')){
   event.preventDefault();event.stopImmediatePropagation();
   clearTimeout(authTimer);input.value=input.defaultValue;authStatus.textContent='';recovery.hidden=true;
   void loadSavedClaim().catch(error=>{if(current())showReviewError(visitClaimErrorText(error));});
   return;
  }
  if(action?.matches('[data-signed-claim-continue],[data-encounter-claim-form]')&&
   (!current()||encounterRevenueState.data?.summary?.claim?.status!==s.claim?.status)){
   event.preventDefault();event.stopPropagation();sheetClose(dialog);
   notice('The claim changed. Reopen Claim details to review the current claim.',true);return;
  }
  const send=action?.matches('[data-signed-claim-continue]:not([data-signed-claim-review])');
  const preview=action?.hasAttribute('data-encounter-claim-form');
  const policyHolder=action?.hasAttribute('data-signed-confirm-policyholder');
  if(action&&!close&&!replaying&&(actionPending||dirty()||authWork||send||policyHolder)){
   event.preventDefault();event.stopImmediatePropagation();
   if(actionPending)return;
   actionPending=true;action.disabled=true;
   void (async()=>{
    if(!await flushAuthorization()||!current()){if(current())input?.focus();return;}
    if(policyHolder){
     const claim=await loadSavedClaim();
     if(!claim.can_confirm_self_policyholder)return;
     const address=savedDetail.submission_defaults?.patient_address||{};
     const formatted=[address.line1,address.line2,address.city,[address.state,address.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
     if(await confirmAction('Confirm the patient is the policy holder and this address on file is correct for the claim.',{title:'Confirm policy holder?',eyebrow:formatted,confirmLabel:'Confirm and update claim',cancelLabel:'Cancel'})!==true||!current())return;
     await api(`${visitReviewClaimsBase()}/${encodeURIComponent(claimId)}/actions`,'POST',{action:'confirm_self_policyholder',reason:'Confirmed the patient is the policy holder and their chart address is correct for this claim.',reference:'',event_date:null,payer_control_number:''},claim.version);
     if(current())await loadSavedClaim();
     return;
    }
    let next=action;
    if(send){
     const claim=await loadSavedClaim();
     next=dialog.querySelector('[data-signed-claim-continue]:not([data-signed-claim-review])');
     if(!next){information.querySelector('[data-check-level="must"] button, summary')?.focus();return;}
     next.dataset.reviewedClaimVersion=String(claim.version);
    }
    if(preview&&claimId)action.dataset.encounterClaimForm=claimId;
    if(!next.isConnected||!current())return;
    replaying=true;next.disabled=false;
    try{next.click();}finally{replaying=false;}
   })().catch(error=>{if(current())showReviewError(visitClaimErrorText(error));}).finally(()=>{
    action.disabled=false;actionPending=false;
   });
   return;
  }
  if(action?.hasAttribute('data-signed-claim-review')){
   event.preventDefault();event.stopPropagation();
   if(!current()||!claimId||!accountId)return;
   activity.hidden=false;activity.open=true;action.disabled=true;
   void loadActivity().then(loaded=>{
    if(!loaded||!current())return;
    const target=(action.dataset.signedClaimReview==='response'&&activity.querySelector('[data-claim-problem-box],.claim-progress-more > summary'))||activity.querySelector('[data-claim-timeline]')||activity.querySelector(':scope > summary');
    if(target){if(target.tabIndex<0)target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'nearest'});}
   }).finally(()=>action.disabled=false);
   return;
  }
  if(!action||action.closest('[data-claim-secondary-host]')||close)return;
  if(!current()){event.preventDefault();event.stopPropagation();sheetClose(dialog);notice('The claim changed. Reopen Claim details to review the current claim.',true);return;}
  dialog.dataset.handoff='1';restore();
  if(dialog.open)dialog.close();
  dialog.remove();
 },true);
 return dialog;
}

// A worklist result must open the exact claim. Older claims for this visit remain available
// in the claims workspace when the encounter is now showing a different claim.
async function visitOpenCurrentEncounterClaim(claimId,accountId){
 const visit=activeVisit?.id,person=selected,identity=me;
 if(!$('visit-page-host')||!visit||!person||typeof encounterStepsSync!=='function')return false;
 const account=encounterChargeAccount();
 if(account?.id!==accountId)return false;
 const scoped=s=>s?.visit?.id===visit&&s.patient_id===person&&s.account?.id===accountId;
 let data=encounterRevenueState.data;
 if(!scoped(data?.summary)||data.stale||data.error){await loadEncounterRevenueStatus(account,true);data=encounterRevenueState.data;}
 if(activeVisit?.id!==visit||selected!==person||me!==identity)return true;
 if(!scoped(data?.summary)||data.stale||data.error||data.summary.claim?.id!==claimId)return false;
 // Selecting the visit schedules its layout. Mount the claim controls before handing off to them.
 const launcher=()=> $('visit-page-host')?.querySelector('[data-encounter-claim-status] [data-open-signed-claim-details]');
 if(!launcher())encounterStepsSync();
 return !!visitOpenSignedClaimDetails(launcher());
}

function visitReviewPanelMarkup(s,ctx={}){
 s=visitReviewPreviewSummary(s);
 const claim=s.claim,content=claim?.content||{},live=visitReviewAccount();
 const account=claim?.snapshot?.account||live||{};
 const defaults=visitReviewProviderDefaults(s);
 const details={...defaults,...account.content?.claim_details,...content.encounter};
 const lines=account.content?.lines||[],visit=typeof activeVisit!=='undefined'?activeVisit:null;
 const sent=ctx.sent||['submitted','accepted','rejected','adjudicated'].includes(claim?.status),editable=!sent&&ctx.canWrite;
 const selfPay=s.insurance?.insured===false&&!claim?.id;
 const encounter=ctx.encounterSteps===true||$('visit-page-host')?.dataset?.encounterSteps!==undefined;
 if(encounter&&!selfPay&&visit?.id)return visitEncounterClaimStatus(s,ctx,sent);
 const checks=sent?[]:visitReviewChecks(s,ctx).filter(check=>!selfPay||check.group==='charges');
 if(selfPay&&encounter)return checks.map(check=>`<p data-check="${esc(check.key)}" data-check-level="${check.level}">${esc(check.key==='pending-amount'?'Add the amount for this procedure.':check.text)} ${check.action?visitReviewButton(check.action,check.attribute):''}</p>`).join('');
 const card=(key,title,body,action='')=>{
  const problems=checks.filter(check=>check.key!=='note-unsigned'&&visitClaimCheckCard(check)===key);
  const owner=typeof me!=='undefined'&&me?.role==='owner'&&ctx.canWrite;
  const practice=problems.filter(check=>check.attribute==='data-billing-organizations');
  const items=problems.filter(check=>!practice.includes(check)).map(check=>`<li data-check="${esc(check.key)}" data-check-level="${check.level}" data-check-group="${esc(check.group)}"><span>${esc(check.text)}</span>${check.action&&(check.attribute!=='data-practice-providers'||owner)?visitReviewButton(check.action,check.attribute):''}</li>`).join('');
  return `<section class="claim-card${problems.some(c=>c.level==='must')?' has-blocking':''}" data-claim-card="${key}"><div class="section-head"><h3>${title}</h3>${action}</div>${key==='visit'?signature:''}${practice.length?`<div class="claim-practice-problems"><ul class="claim-problems">${practice.map(check=>`<li data-check="${esc(check.key)}" data-check-level="${check.level}" data-check-group="${esc(check.group)}">${esc(check.text)}</li>`).join('')}</ul>${owner?visitReviewButton('Open practice billing setup','data-billing-organizations'):''}</div>`:''}${body}${items?`<ul class="claim-problems"${problems.some(c=>c.level==='must')?' data-review-level="must"':''}>${items}</ul>`:''}</section>`;
 };
 const fact=(label,value)=>`<div><dt>${label}</dt><dd>${esc(value||'Not recorded')}</dd></div>`;
 const facts=`<dl class="claim-facts">${fact('Date of service',visitBillingDate(account.content?.service_date||s.account?.service_date))}${fact('Place of service',content.place_of_service||details.place_of_service)}${fact('Billing organization',content.billing_provider_name||details.billing_provider_name)}<div><dt>Rendering provider</dt><dd>${visitClaimRenderingProvider(content,details)}</dd></div>${content.referring_provider_name||details.referring_provider_name?fact('Referring provider',content.referring_provider_name||details.referring_provider_name):''}</dl>`;
 const payer=visitReviewPayer(s),coverage=claim?.snapshot?.account?.coverage_snapshot?.coverage?.content||payer.coverage||{};
 const coverageId=account.coverage_snapshot?.coverage?.id||account.content?.coverage_id||(!s.account||s.account.status==='draft'?(typeof revenueCoverage==='function'?revenueCoverage(s.account?.service_date)?.id:null):null);
 const eligibility=typeof insuranceEligibilityState!=='undefined'?insuranceEligibilityState?.items?.get(coverageId):null;
 const eligibilityMarkup=eligibility&&typeof insuranceEligibilityMarkup==='function'?insuranceEligibilityMarkup(eligibility,coverageId,account.content?.service_date):'<p class="muted">Eligibility not checked</p>';
 const insurance=s.insurance?.insured===false?`<div class="claim-insurance"><p>Self-pay. No insurance on file.</p><button type="button" data-add-insurance-sheet="${esc(selected)}">+ Add insurance</button></div>`:`<div class="claim-insurance"><p>${esc(visitBillingInsurer(s))} · ${esc(coverage.member_id||'Member ID not recorded')} · ${esc(coverage.priority||claim?.coverage_priority||'Priority not recorded')}${coverage.plan_name?' · '+esc(coverage.plan_name):''}</p>${coverageId?`<div id="insurance-eligibility-${esc(coverageId)}">${eligibilityMarkup}</div>`:eligibilityMarkup}</div>`;
 const evidence=typeof encounterCodesEvidence!=='undefined'&&encounterCodesEvidence.visit===visit?.id?encounterCodesEvidence.evidence:null;
 const diagnoses=content.diagnosis_codes||[...new Set(lines.flatMap(l=>l.diagnosis_codes||[]))];
 const dxRows=diagnoses.slice(0,12).map((code,i)=>`<tr><td>${String.fromCharCode(65+i)}</td><td>${esc(code)}</td><td>${esc(evidence?.diagnoses?.find(d=>d.code===code)?.display||'')}</td></tr>`).join('');
 const dx=`<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Letter</th><th>Code</th><th>Description</th></tr></thead><tbody>${dxRows||'<tr><td colspan="3">No diagnoses recorded</td></tr>'}</tbody></table></div>`;
 const pointerRows=lines.map((line,i)=>{
  const pointers=content.line_diagnosis_pointers?.[i]||(line.diagnosis_codes||[]).map(code=>diagnoses.indexOf(code)+1);
  return `<li>Line ${i+1} · ${esc(line.code)}: ${pointers.map(n=>n>0&&n<=12?String.fromCharCode(64+n):'—').join(', ')||'—'}</li>`;
 }).join('');
 const authorization=typeof chargePriorAuthorizationFinishedMarkup==='function'?chargePriorAuthorizationFinishedMarkup(account,{readOnly:sent||!ctx.canWrite||s.insurance?.insured===false}):'';
 const prior=authorization|| (s.insurance?.insured!==false?'<p class="muted">Prior authorization number: Not recorded</p>':'');
 const services=`<p class="claim-services-summary">${lines.length} service ${lines.length===1?'line':'lines'} · ${money(s.charges_cents||0)}${editable?' · '+visitReviewButton('Edit codes ↑','class="text-button" data-encounter-codes-anchor'):''}</p>${prior}`;

 const due=visitBillingDue(s);
 const patient=s.insurance?.insured!==false&&s.account?.status!=='posted'?(Number.isSafeInteger(s.patient?.copay_cents)?`<p>Plan copay ${money(s.patient.copay_cents)}</p>`:''):`<p>${esc(visitBillingDraftSelfPay(s)?'Patient will owe':s.insurance?.insured===false?'Patient owes now':due.copayOnly?'Copay due now':'Patient owes now')} <b>${money(visitBillingDraftSelfPay(s)?s.charges_cents||0:s.insurance?.insured===false?s.patient?.owes_now_cents||0:due.copayOnly?due.due:s.patient?.owes_now_cents||0)}</b></p>${s.insurance?.insured!==false&&s.patient?.copay_cents!=null?`<p class="muted">Plan copay ${money(s.patient.copay_cents)}</p>`:''}${s.account?.status==='posted'&&ctx.canCreate&&Number(s.patient?.owes_now_cents)>0?visitReviewButton('Start payment plan','class="text-button" data-start-payment-plan'):''}`;
 const unsigned=checks.some(check=>check.key==='note-unsigned'&&check.level==='must');
 const noteAsk=!sent&&checks.some(check=>check.key==='note-unsigned')&&visitReviewUnsignedAllowed(ctx)?'<details data-claim-more-actions><summary>More claim actions</summary><label data-review-note-ask><input type="checkbox" data-note-sign-ack> Send anyway — the note is not signed yet.</label></details>':'';
 const signature=unsigned?'<p data-claim-signature-message data-check="note-unsigned" data-check-level="must">Sign the note to build the claim. Problems to fix before sending:</p>':'';
 const status=sent&&!visitHandoffEvidence(s)?`<section class="claim-card" data-claim-status><h3>${esc(ctx.sent&&!['submitted','accepted','rejected','adjudicated'].includes(claim?.status)?'Sent to the clearinghouse':visitBillingStatus(s,ctx).headline)}</h3><p>${esc(s.claimmd?.message||(ctx.sent?'Waiting for the insurer’s answer.':visitBillingStatus(s,ctx).detail))}</p>${claim?.id?`<p><button type="button" data-claimmd-check="${esc(claim.id)}">Check with the clearinghouse now</button> <span data-claimmd-check-result role="status"></span></p>`:''}</section>`:'';
 if(selfPay)return `<div class="claim-screen-columns"><div class="claim-screen-cards encounter-review-items">${card('services','Service lines',services)}<div data-step-patient-actions>${patient}</div></div></div>`;

 return `<div class="claim-screen-columns"><div class="claim-screen-cards encounter-review-items">${status}${card('visit','Claim checks',`<details><summary>Encounter details</summary>${facts}</details>`+noteAsk,editable?visitReviewButton('Edit claim details',claim?.id?`class="text-button" data-visit-review-fix="claim" data-visit-claim-fix="${esc(claim.id)}"`:'class="text-button" data-details-edit'):'')}${card('insurance','Insurance',insurance,editable&&s.insurance?.insured!==false?visitReviewButton('Edit insurance','class="text-button" data-chart-section="insurance"'):'')}${card('diagnoses','Diagnosis pointers',`<details><summary>Diagnosis pointers</summary>${dx}<ul class="claim-line-pointers">${pointerRows}</ul></details>`)}${card('services','Services & prior authorization',services)}<div data-step-patient-actions>${patient}</div><button type="button" data-encounter-claim-form>View claim form</button></div></div>${visitClaimFooter(s,ctx,checks)}`;
}

function visitReviewHost(){return $('visit-billing-review');}
function visitReviewPaint(ctx={}){
 const host=visitReviewHost();if(!host||host.hidden)return;
 const summary=encounterRevenueState.data?.summary;if(!summary)return;
 const review=encounterRevenueState.review;
 const carried=review?{progress:review.progress,error:review.stopped?review.error:null,sent:review.sent,askNote:review.askNote}:{};
 const acknowledged=host.querySelector?.('[data-note-sign-ack]')?.checked;
 host.innerHTML=visitReviewPanelMarkup(summary,visitReviewContext({...carried,...ctx}));
 if(acknowledged){const box=host.querySelector?.('[data-note-sign-ack]');if(box)box.checked=true;}
}
// Compatibility entry point for the encounter bar and older callers.
function visitReviewOpen(){
 if($('visit-page-host')?.dataset?.encounterSteps!==undefined){
  visitReviewRestore();
  encounterStepOpen('claim');
  const launcher=$('visit-page-host').querySelector?.('[data-encounter-claim-status] [data-open-signed-claim-details]');
  if(launcher)visitOpenSignedClaimDetails(launcher);
  return;
 }
 if(typeof invoiceTabSet==='function')invoiceTabSet('billing',false);
 const page=$('encounter-revenue');
 if(page?.dataset?.codesEditing!==undefined&&typeof encounterCodesEditorClose==='function'){page.codesCloseNow=true;encounterCodesEditorClose();}
 if(typeof billingPartSet==='function')billingPartSet('summary',false);
 visitReviewRestore();
 const screen=$('visit-billing-review');
 if(typeof encounterStepOpen==='function')encounterStepOpen(1);
 else screen?.scrollTo?.({top:screen.scrollHeight,behavior:'smooth'});
 $('claim-screen-footer')?.focus?.({preventScroll:true});
}
function visitReviewContext(extra={}){
  const visit=typeof activeVisit!=='undefined'?activeVisit:null;
  const maySign=typeof canSignNote==='function'?canSignNote()===true:['owner','clinician'].includes(me?.role);
  const mayDraft=typeof canDraftNote==='function'?canDraftNote(visit)===true:true;
  return {canSign:!!(visit&&visit.status!=='signed'&&maySign&&mayDraft),...visitBillingStateContext(),...extra};
}
// Rebuild the claim screen when the encounter billing area is restored.
function visitReviewRestore(){
 const host=visitReviewHost();if(!host)return;
 host.hidden=false;
 visitReviewPaint();
 const s=encounterRevenueState.data?.summary,account=s?.claim?.snapshot?.account||visitReviewAccount();
 const coverageId=account?.coverage_snapshot?.coverage?.id||account?.content?.coverage_id;
 if(host.isConnected&&coverageId&&typeof loadInsuranceEligibility==='function')void loadInsuranceEligibility(coverageId);
}
function visitReviewClose(){
 // The claim screen remains the encounter's billing destination.
 if(typeof billingPartSet==='function')billingPartSet('summary',false);
}
// The encounter shortcuts release a current draft and open the native confirmation form.
function visitClaimErrorText(error){return String(error?.message||'').replace(/\s+/g,' ').trim()||'The claim could not be sent. Try again.';}
async function visitClaimDirectSend(claimId,button){
 if(visitReviewPendingCharges()){focusUnpricedVisitCharge();return false;}
 const patient=selected,identity=me,visitId=activeVisit?.id;
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 if(!account)throw new Error('Open the encounter for these charges first.');
 const current=()=>selected===patient&&me===identity&&activeVisit?.id===visitId;
 const stop=(message,code)=>{const failure=new Error(message);failure.claimSendCode=code;throw failure;};
 if(button){button.disabled=true;button.textContent='Opening Claim.MD…';}
 try{
  if(!claimId)stop('The claim for this encounter could not be found. Refresh the encounter and try again.','refresh');
  if(typeof loadClaimMdConnection==='function')await loadClaimMdConnection(current);
  if(!current())return false;
  if(!(typeof claimMdConnectionState!=='undefined'&&claimMdConnectionState?.connected))stop('No clearinghouse is connected, so nothing can be sent. Ask the practice owner to check the clearinghouse connection.','refresh');
  // The claim is read from the server before anything is released: a screen left open with edits
  // in it never sends on a stale copy. This is the same read the panel's chain makes.
  const base=visitReviewClaimsBase();
  const detail=await api(`${base}/${encodeURIComponent(claimId)}`);
  if(!current())return false;
  if(detail?.claim?.id!==claimId||detail.claim.patient_id!==patient||detail.claim.account_id!==account.id)stop('The claim that loaded is not the one you opened. Refresh the encounter and try again.','refresh');
  if(['submitted','accepted','adjudicated','void'].includes(detail.claim.status))stop('This claim is already with the insurer. Its status shows on the encounter.','refresh');
  const already=(typeof claimHasRecordedSubmission==='function'&&claimHasRecordedSubmission(detail))||(typeof claimHasPreparedSubmission==='function'&&claimHasPreparedSubmission(detail));
  if(already)stop('This claim already has a claim file. Open the claim to check whether it was sent before sending again.','refresh');
  // The server's own refusals stop the send here, before anything is released or sent.
  const refused=(Array.isArray(detail.preflight_issues)?detail.preflight_issues:[]).map(issue=>String(issue||'').trim()).filter(Boolean);
  if(refused.length)stop(`The claim is missing what the insurer needs: ${refused.join('; ')}.`,'refresh');
  if(detail.claim.status==='draft'){
   await api(`${base}/${encodeURIComponent(claimId)}/actions`,'POST',{action:'ready',reason:'Claim details reviewed before sending',reference:'',event_date:null,payer_control_number:''},detail.claim.version);
  }
  if(!current())return false;
  return await openEncounterClaimMdSubmit(claimId,account.id);
 }catch(error){
  // The server's own words stay beside the button; nothing else on the encounter changes.
  if(current()&&button){button.disabled=false;button.textContent=`Send claim to ${visitBillingInsurer(encounterRevenueState.data?.summary||{})}`;}
  throw error;
 }finally{
  if(current()&&button&&button.isConnected!==false&&button.textContent==='Opening Claim.MD…'){button.disabled=false;button.textContent=`Send claim to ${visitBillingInsurer(encounterRevenueState.data?.summary||{})}`;}
 }
}
// The card's one main button: review first, then send from the same place.
// The card offers the review button only where it is the truth about this chart: the claim
// steps run on the encounter's own data, so a card out of step with it keeps its own button.
function visitBillingCardCurrent(s){
 // The card's own buttons belong to the card of the encounter this screen is actually showing: the
 // same visit, the same charge account, and the summary the step currently holds. A card drawn
 // from a copy of another visit, or one the step has moved on from, keeps its own buttons.
 if(typeof encounterRevenueState==='undefined'||!s?.account)return false;
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 if(account&&account.id!==s.account.id)return false;
 // Recognised by what it describes, not by object identity: the review panel, the line under
 // the charge table and the charge editor each hold their own copy of what the card shows.
 const review=encounterRevenueState.reviewCard||encounterRevenueState.data?.summary;
 if(!review||review.account?.id!==s.account?.id)return false;
 if(review.state!==s.state&&!(review.visit?.id&&s.visit?.id&&review.visit.id===s.visit.id))return false;
 if(s.visit?.id&&review.visit?.id&&s.visit.id!==review.visit.id)return false;
 return true;
}
function visitBillingReviewButton(s,ctx={}){
  if(!ctx.canWrite||!ctx.claimsAllowed||!s.insurance?.insured||!s.account||ctx.noReview)return '';
  if(!['post_charges','prepare_claim','claim_cancelled','fix_claim','send_claim'].includes(s.state))return '';
  if(['submitted','accepted','adjudicated','void'].includes(s.claim?.status))return '';
  if(!visitBillingCardCurrent(s))return '';
  return `<button type="button" class="primary" data-visit-review-open="account">Review and send to the clearinghouse</button>`;
}
// After a claim is with the insurer the card says so and gives the one way to look at it.
function visitBillingSentLine(s,ctx={}){
  if(visitHandoffEvidence(s)||!s.claim?.id||!['submitted','accepted','adjudicated'].includes(s.claim.status)||!ctx.claimsAllowed)return '';
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
 if(visitReviewPendingCharges()){focusUnpricedVisitCharge();return false;}
 const patient=selected,identity=me,visitId=typeof activeVisit!=='undefined'?activeVisit?.id:null;
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 if(!account)throw new Error('Open the encounter for these charges first.');
 const current=()=>selected===patient&&me===identity&&(typeof activeVisit==='undefined'?true:activeVisit?.id===visitId);
 const state=encounterRevenueState;
 const needPost=options.needPost!==false&&account.status==='draft';
 const needPrepare=options.needPrepare!==false;
 const progress={steps:visitReviewStageSteps(needPost,needPrepare),step:''};
 const review=state.review={claimId:claimId||null,busy:true,stopped:false,error:null,progress};
 const paint=extra=>{if(current()&&state.review===review)visitReviewPaint({...extra,progress,error:review.stopped?review.error:null});};
 const advance=async(key,work)=>{
  const step=progress.steps.find(candidate=>candidate.key===key);if(!step)return true;
  progress.step=visitReviewStages.find(stage=>stage.key===key).doing;paint();
  try{const skipped=await work(step);step.skipped=skipped===true;step.status='done';progress.step='';return true;}
  catch(error){step.status='failed';step.reason=String(error?.message||'').trim()||'it did not go through';review.error=visitReviewStepFailure(step,step.reason);review.stopped=true;return false;}
 };
   try{
    let claim={id:claimId||null};
    if(!needPost&&!needPrepare){
     // With nothing left to post or fill in, the claim is re-read from the server before
     // anything is released: the person may have the charge table open with edits in it, and
     // a claim that moved on since the button was pressed is never sent on a stale copy.
     const ok=await advance('check',async()=>{
      if(!claim.id)throw new Error('The claim for this encounter could not be found. Refresh the encounter and try again.');
      const found=await api(`${visitReviewClaimsBase()}/${claim.id}`);
      if(!current())throw new Error('This page changed. Open the encounter again.');
      if(found?.claim?.id!==claim.id)throw new Error('The claim that loaded is not the one you opened. Try again.');
      if(['submitted','accepted','adjudicated','void'].includes(found.claim.status))throw new Error('This claim is already with the insurer. Its status shows on the encounter.');
      return true;
     });
     if(!ok){review.busy=false;paint();return false;}
    }
    if(needPost){
     const ok=await advance('post',async()=>{
      if(options.confirmPost&&typeof confirmAction==='function'&&!await confirmAction(`Charges of ${money(account.total_cents)} become final. Review and submit the claim on the Claim.MD form.`,{title:'Post these charges?',confirmLabel:'Post charges'}))throw new Error('Cancelled before anything was sent.');
      if(!current())throw new Error('This page changed. Open the encounter again.');
      const posted=await api(`${billingBase()}/${account.id}/actions`,'POST',{action:'post',reason:'Charges posted',local_only:false},account.version);
      if(!current())throw new Error('This page changed. Open the encounter again.');
      if(posted?.id!==account.id||posted.patient_id!==patient||posted.content?.visit_id!==visitId||posted.status!=='posted')throw new Error('Refresh this encounter to check whether its charges were posted.');
      workspace.billing.accounts=workspace.billing.accounts.map(row=>row.id===account.id?posted:row);
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
      if(!current())throw new Error('This page changed. Open the encounter again.');
      // The server names the claim it filled in for this encounter. The chain only ever carries on
      // that one, never a copy left on a screen that may have moved on; the detail read below
      // still brings the claim, and its version, back from the server.
      if(prepared?.outcome==='prepared'||prepared?.outcome==='exists'){
       if(!prepared.claim_id)throw new Error('The claim for this encounter could not be found. Refresh the encounter and try again.');
       if(claim.id&&prepared.claim_id!==claim.id)throw new Error('This claim does not belong to the encounter you are on. Refresh and try again.');
       claim={id:prepared.claim_id};
       return false;
      }
      if(prepared?.outcome==='cancelled')throw new Error('The claim filled in here was cancelled. Prepare a new claim from this encounter first.');
      if(prepared?.outcome==='not_needed')return true;
      throw new Error('The claim could not be filled in from this encounter. Refresh the encounter and try again.');
     });
     if(!ok){review.busy=false;paint();return false;}
    }
    if(!claim.id)throw new Error('The claim for this encounter could not be found. Refresh the encounter and try again.');
    if(claimId&&claim.id!==claimId)throw new Error('This claim does not belong to the encounter you are on. Refresh and try again.');
  if(!current()){review.busy=false;return false;}
  if(typeof loadClaimMdConnection==='function')await loadClaimMdConnection(current);
  if(!current()){review.busy=false;return false;}
  if(!options.allowUnsigned&&typeof encounterRevenueVisitUnsigned==='function'&&encounterRevenueVisitUnsigned(account)){review.busy=false;review.askNote=true;paint({askNote:true});return false;}
  if(!(typeof claimMdConnectionState!=='undefined'&&claimMdConnectionState?.connected))throw new Error('No clearinghouse is connected, so nothing can be sent. Ask the practice owner to check the clearinghouse connection.');
   const stopHere=(key,reason)=>{
    // The chain stops at this step: nothing further is sent, the step shows as stopped with
    // the reason, and the button comes back as Try again.
    const stop=progress.steps.find(candidate=>candidate.key===key);
    if(stop){stop.status='failed';stop.reason=reason;}
    review.error=visitReviewStepFailure(stop||{key},reason);
    review.stopped=true;review.busy=false;paint();return false;
   };
   const detail=await api(`${visitReviewClaimsBase()}/${claim.id}`);
   if(!current()){review.busy=false;return false;}
   if(detail?.claim?.id!==claim.id||detail.claim.patient_id!==patient||detail.claim.account_id!==account.id)throw new Error('The claim that loaded is not the one you opened. Try again.');
   const already=(typeof claimHasRecordedSubmission==='function'&&claimHasRecordedSubmission(detail))||(typeof claimHasPreparedSubmission==='function'&&claimHasPreparedSubmission(detail));
   if(already)return stopHere('ready','This claim already has a claim file. Open the claim to check whether it was sent before sending again.');
   // The server's own refusals stop the chain here, before anything is released or sent.
   const refused=(Array.isArray(detail.preflight_issues)?detail.preflight_issues:[]).map(issue=>String(issue||'').trim()).filter(Boolean);
   if(refused.length)return stopHere('ready',`The claim is missing what the insurer needs: ${refused.join('; ')}.`);
   const okReady=await advance('ready',async()=>{
   if(detail.claim.status==='ready')return true;
   if(detail.claim.status!=='draft')throw new Error('This claim is no longer a draft, so it cannot be checked and released here. Open the claim to see what to do.');
   await api(`${visitReviewClaimsBase()}/${claim.id}/actions`,'POST',{action:'ready',reason:'Claim details reviewed before sending',reference:'',event_date:null,payer_control_number:''},detail.claim.version);
  });
  if(!okReady){review.busy=false;paint();return false;}
  if(!current())return false;
  const opened=await advance('send',async()=>{
   if(!await openEncounterClaimMdSubmit(claim.id,account.id))throw new Error('Review the current claim before sending.');
  });
  review.busy=false;
  paint();
  return opened&&current();
 }catch(error){
  review.error=visitClaimErrorText(error);review.stopped=true;paint();return false;
 }finally{
  review.busy=false;
  if(current()&&state.review===review)paint();
 }
}


// One-click fixes inside the panel: each opens the thing itself, where it already lives.
function visitReviewOpenChargeTable(){
  if(typeof openEncounterCharges==='function')openEncounterCharges();
  const details=$('encounter-charge-details');if(details)details.open=true;
  if($('billing-charge-lines'))return;
  $('encounter-billing-detail')?.scrollIntoView?.({behavior:'smooth',block:'start'});
}
function visitReviewFixLine(index,field){
  if($('visit-page-host')?.dataset?.encounterSteps!==undefined&&typeof encounterCodesEditorOpen==='function')encounterCodesEditorOpen(0,false,'codes');
  else visitReviewOpenChargeTable();
  const form=$('billing-account-form');
  const rows=form&&typeof chargeLiveRows==='function'?chargeLiveRows(form):$('billing-charge-lines')?.querySelectorAll?.('.billing-charge-row');
  const row=rows?.[index];
  if(!row)return;
  const dx=row.querySelector('[data-charge-diagnoses] button:not(:disabled),[name="diagnoses"]:not([type="hidden"])');
  const box=field==='ndc_code'?row.querySelector('[name="ndc_code"]'):dx||row.querySelector('[name="code"]');
  for(let disclosure=box?.closest?.('details');disclosure;disclosure=disclosure.parentElement?.closest('details'))disclosure.open=true;
  const dialog=row.closest?.('dialog[open]');
  if(dialog)box?.scrollIntoView?.({block:'nearest'});
  else if(typeof encounterContentScroll==='function'&&$('visit-page-host')?.dataset?.encounterSteps!==undefined)encounterContentScroll(row);
  else row.scrollIntoView?.({behavior:'smooth',block:'center'});
  box?.focus?.({preventScroll:true});
}
function visitClaimHighlightInput(field,message){
 if(!field||field.type==='hidden')return;
 if(message){
  const id='signed-claim-field-'+field.name;
  let note=field.form?.querySelector('#'+id);
  if(!note){note=document.createElement('small');note.id=id;note.className='signed-claim-issue';field.insertAdjacentElement('afterend',note);}
  note.textContent=message;
  const ids=new Set((field.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));ids.add(id);field.setAttribute('aria-describedby',[...ids].join(' '));
  field.addEventListener('input',()=>{ids.delete(id);if(ids.size)field.setAttribute('aria-describedby',[...ids].join(' '));else field.removeAttribute('aria-describedby');note.remove();},{once:true});
 }
 field.focus();
}
function visitReviewOpenClaimEditor(claimId,focus='',message=''){
  if(typeof showEncounterClaim!=='function'||!claimId)return;
  const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;if(!account)return;
  void (async()=>{
    await showEncounterClaim(claimId,account.id);
    if(typeof claimCurrent==='undefined'||claimCurrent?.id!==claimId||typeof claimEditor!=='function'||claimCurrent.status!=='draft')return;
    claimEditor(claimCurrent.snapshot.account,claimCurrent);
    if($('visit-page-host')?.dataset?.encounterSteps!==undefined&&$('claim-editor')&&typeof chartOpenEditor==='function')chartOpenEditor('claim-editor','Edit draft claim');
    visitClaimHighlightInput($('claim-editor-form')?.elements?.[focus],message);
  })().catch(error=>{if(typeof notice==='function')notice(error.message,true);});
}
function visitReviewVisitUnsigned(s={}){
 const visit=(typeof activeVisit!=='undefined'?activeVisit:null)||s.visit;
 const account=typeof encounterChargeAccount==='function'?encounterChargeAccount():null;
 return !!((visit&&visit.status!=='signed'&&!visit.signed_at)||(account&&typeof encounterRevenueVisitUnsigned==='function'&&encounterRevenueVisitUnsigned(account)));
}
// An exception requires an already signed encounter and explicit practice-policy permission.
function visitReviewUnsignedAllowed(ctx={}){
 const visit=typeof activeVisit!=='undefined'?activeVisit:null;
 return !!(visit&&(visit.status==='signed'||visit.signed_at)&&ctx.allowUnsigned===true);
}
function visitReviewSendContext(s,account){
  const unsigned=visitReviewVisitUnsigned(s);
  const panel=visitReviewHost();
  const acknowledged=!!(unsigned&&panel?.querySelector?.('[data-note-sign-ack]')?.checked);
  if(unsigned&&(!visitReviewUnsignedAllowed(visitReviewContext())||!acknowledged)){visitReviewPaint({askNote:true});return null;}
  return {needPost:account?.status==='draft',needPrepare:!s?.claim?.id||s.claim.status==='draft',allowUnsigned:unsigned,acknowledged,confirmPost:account?.status==='draft'};
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-signed-claim-codes]');
 if(!button||typeof encounterOpenCodesDialog!=='function'||!visitReviewContext().canWrite)return;
 event.preventDefault();event.stopImmediatePropagation();
 const dialog=button.closest('dialog[data-signed-claim-details]');
 let launcher=button;
 if(dialog){launcher=$('visit-billing-review')?.querySelector('[data-open-signed-claim-details]')||button;dialog.dataset.handoff='1';if(typeof encounterClaimOptionsRestore==='function')encounterClaimOptionsRestore(dialog);dialog.close();dialog.remove();}
 encounterOpenCodesDialog(launcher,button.dataset.signedClaimCodes);
},true);
document.addEventListener('click',event=>{
  const button=event.target.closest?.('button');if(!button)return;
  if(button.hasAttribute('data-open-signed-claim-details')){event.preventDefault();visitOpenSignedClaimDetails(button);return;}
  if(button.dataset.signedCoverage){
   const row=workspace?.billing?.coverages?.find(item=>item.id===button.dataset.signedCoverage);
   if(row&&visitReviewContext().canWrite){event.preventDefault();coverageEditor(row,null,{sheet:true,patient:workspace.patient});const field=$('coverage-form')?.elements?.[button.dataset.signedFocus];visitClaimHighlightInput(field,button.closest('[data-check]')?.querySelector('[data-claim-warning]')?.textContent);}
   return;
  }
  if(button.hasAttribute('data-post-and-send')){event.preventDefault();run(()=>postVisitChargesAndSend());return;}
  if(button.hasAttribute('data-visit-review-open')){
    event.preventDefault();visitReviewOpen();return;
  }
  if(button.dataset.claimPreview){event.preventDefault();encounterRevenueState.claimPreview=button.dataset.claimPreview;visitReviewPaint();return;}
  if(button.hasAttribute('data-claim-screen-resend')){event.preventDefault();run(()=>visitClaimResend(button));return;}
  if(button.hasAttribute('data-visit-review-close')){event.preventDefault();visitReviewClose();return;}
  if(button.hasAttribute('data-visit-review-refresh')){event.preventDefault();run(async()=>{await loadEncounterRevenueStatus(typeof encounterChargeAccount==='function'?encounterChargeAccount():null,true);visitReviewPaint();});return;}
  if(button.hasAttribute('data-visit-handoff-resume')){
    event.preventDefault();run(()=>visitClaimHandoff(false));return;
  }
  if(button.hasAttribute('data-visit-review-send')){
    event.preventDefault();
    const s=encounterRevenueState.data?.summary;
    if(button.disabled||encounterRevenueState.review?.busy)return;
  if($('visit-page-host')?.dataset?.encounterSteps!==undefined&&s?.visit?.id===activeVisit?.id&&activeVisit?.status==='signed'){
     const version=button.dataset.reviewedClaimVersion?Number(button.dataset.reviewedClaimVersion):null;
     run(()=>visitClaimHandoff(false,'queue',button.dataset.visitReviewSend||null,version));return;
    }
    if(!['send_claim','post_charges'].includes(s?.state))return;
    if(visitReviewMustFix(visitReviewChecks(s,visitReviewContext())).length){visitReviewPaint();return;}
    const options=visitReviewSendContext(s,typeof encounterChargeAccount==='function'?encounterChargeAccount():null);
    if(!options)return;
    run(()=>visitReviewRun(s?.claim?.id||null,options));
    return;
  }
  if(button.dataset.visitReviewFix==='note'){event.preventDefault();if(typeof setEncounterSection==='function')setEncounterSection('documentation');$('note-form')?.querySelector?.('[data-action="sign"]')?.focus?.({preventScroll:true});return;}
  if(button.dataset.visitReviewFix==='amount'){event.preventDefault();focusUnpricedVisitCharge();return;}
  if(button.dataset.visitReviewFix==='line'){event.preventDefault();visitReviewFixLine(Number(button.dataset.reviewLine)||0,button.dataset.reviewField);return;}
  if(button.dataset.visitReviewFix==='claim'){event.preventDefault();visitReviewOpenClaimEditor(button.dataset.visitClaimFix||encounterRevenueState.data?.summary?.claim?.id||'',button.dataset.signedFocus||'',button.closest('[data-check]')?.querySelector('[data-claim-warning]')?.textContent);return;}
});

// Signing and delivery belong to one specific reviewed encounter. Only the server creates or
// resumes the claim artifact and job. A timed-out response never authorizes another submission.
let visitHandoffLast=null;
function visitEncounterCanSignAndSubmit(s,account){
 if(visitHandoffMode(s,account)!=='queue'||!account?.id||account.id!==s.account?.id||
  !account.content?.lines?.some(line=>String(line.code||'').trim()))return false;
 const checks=visitReviewChecks(s,visitReviewContext());
 return !visitReviewMustFix(checks).some(check=>check.key!=='note-unsigned');
}
function visitHandoffMode(s,account){
 if(!s?.insurance?.insured||s.viewer?.delegated||me?.delegated||!billingCan()||
   typeof workspaceResourceAllowed==='function'&&(!workspaceResourceAllowed('claims','create')||!workspaceResourceAllowed('claims','edit')))return null;
 const form=$('billing-account-form'),fields=form?.elements,details=account?.content?.claim_details||{};
 if(details.review_requested||details.paper_only||fields?.cd_review_requested?.checked||fields?.cd_paper_only?.checked||!s.insurance.electronic||s.claim?.secondary||s.claim?.crossover)return 'prepare';
 return 'queue';
}
function visitHandoffEvidence(s){
 if(['correct_claim','claimmd_correction','claimmd_received','claim_rejected','denied','post_response','review_response','review_balance','patient_owes','patient_credit','paid_in_full','claim_cancelled'].includes(s?.state))return null;
 const local=visitHandoffLast;
 const server=s?.claim_handoff;
 if(server)return server;
 if(!local||typeof activeVisit==='undefined'||s?.visit?.id!==activeVisit?.id||s?.patient_id!==selected)return null;
 if(local&&local.identity===me&&local.patient===selected&&local.visit===activeVisit?.id&&
   (!s?.claim?.id||!local.result.claim_id||s.claim.id===local.result.claim_id))return local.result;
 return null;
}
function visitHandoffStatus(result){
 const names={queued:'Queued for Claim.MD',delivered:'Delivered to Claim.MD',waiting:'Delivery unconfirmed',needs_review:'Claim needs review',held:'Claim on hold',prepared:'Claim prepared',blocked:'Claim needs attention',recorded_externally:'Submission recorded externally',self_pay:'Self-pay',unconfirmed:'Handoff unconfirmed'};
 return names[result?.outcome]||'Handoff unconfirmed';
}
function visitHandoffDetail(result){
 const why=[result?.reason,...(Array.isArray(result?.issues)?result.issues:[])].filter(value=>typeof value==='string'&&value.trim());
 if(why.length)return [...new Set(why)].join(' ');
 return ({queued:'The delivery worker will send this claim and record the response.',delivered:'Track the clearinghouse and payer responses on this encounter.',
  waiting:'Check the existing delivery before taking further action.',held:'Review the selected hold or paper claim setting.',prepared:'The saved claim is available to review.',
  needs_review:'Review the missing claim details, then resume submission.',blocked:'Review the claim and its delivery history.',
  recorded_externally:'Check the recorded external submission for its delivery status.',self_pay:'Use patient billing for this encounter.',unconfirmed:'Refresh the encounter to check the saved signature and delivery status.'})[result?.outcome]||'Refresh the encounter to check its current claim status.';
}
function visitHandoffCanResume(result){
 return result&&!result.job_id&&['needs_review','prepared','blocked','unconfirmed'].includes(result.outcome);
}
async function visitClaimHandoff(signing=false,requestedMode='queue',reviewClaimId=null,reviewClaimVersion=null){
 const patient=selected,visit=activeVisit?.id,identity=me;
 const current=()=>me===identity&&selected===patient&&activeVisit?.id===visit;
 if(!visit||signing&&!canSignNote()||!signing&&activeVisit.status!=='signed'&&!activeVisit.signed_at)return false;
 const data=encounterRevenueState.data,summary=data?.summary;
 if(data?.stale||data?.error||summary?.visit?.id!==visit||summary.patient_id!==patient)throw new Error('Refresh this encounter before reviewing its claim.');
 await flushVisitNoteCharges();
 if(!current())return false;
 const account=encounterChargeAccount(),accountId=account?.id||null,version=account?.version??null,visitVersion=activeVisit.version;
 const policy=visitHandoffMode(summary,account);
 if(!policy)throw new Error('A billing team member with claim access can submit this encounter.');
 const mode=requestedMode==='queue'&&policy==='queue'?'queue':'prepare';
 const existing=visitHandoffEvidence(summary);
 if(!signing&&existing&&(['waiting','queued','delivered','recorded_externally'].includes(existing.outcome)||existing.job_id&&existing.outcome==='blocked')){
  await loadEncounterRevenueStatus(account,true);
  if(current())notice(visitHandoffStatus(visitHandoffEvidence(encounterRevenueState.data?.summary)||existing));
  return false;
 }
 let confirmations={};
 const queued=mode==='queue';
 const operation=signing?(queued?'Sign & submit claim':'Sign & prepare claim'):(queued?'Submit claim':'Prepare claim');
 const subject=typeof encounterNumberText==='function'?encounterNumberText(activeVisit):'';
 const name=workspace?.patient?.id===patient?[workspace.patient.given_name,workspace.patient.family_name].filter(Boolean).join(' '):'';
 let cover='';
 if(signing&&activeVisit.clinician_id!==identity.user_id){
  const assigned=typeof visitNoteAssignedName==='function'?await visitNoteAssignedName(activeVisit):'';
  if(!current())return false;
  cover=' You will sign as yourself for '+(assigned||'the assigned clinician')+'’s visit. Check the rendering provider.';
 }
 let synthetic=summary.claim?.content?.synthetic_test===true||String(summary.claim?.control_number||'').startsWith('SCTEST');
 let reviewedClaim=null;
 // The summary can omit claim content. Use the actual claim to decide whether a separate
 // synthetic review is appropriate; never infer consent for development-to-live delivery.
 if(reviewClaimId||queued&&summary.claim?.id&&!synthetic){
  if(reviewClaimId&&summary.claim?.id!==reviewClaimId)throw new Error('The claim changed. Reopen Claim details to review the current claim.');
  const detail=await api(visitReviewClaimsBase()+'/'+encodeURIComponent(summary.claim.id));
  if(!current())return false;
  if(detail?.claim?.id!==summary.claim.id)throw new Error('Refresh this encounter to review the current claim.');
  if(reviewClaimId){
   const claim=detail.claim;
   const version=reviewClaimVersion??summary.claim.version;
   const changed=Number.isSafeInteger(version)?claim.version!==version:JSON.stringify(claim.content)!==JSON.stringify(summary.claim.content);
   if(claim.patient_id!==patient||claim.account_id!==accountId||!['draft','ready'].includes(claim.status)||
    !Number.isSafeInteger(claim.version)||changed||claimHasRecordedSubmission(detail)||claimHasPreparedSubmission(detail))throw new Error('The claim changed. Reopen Claim details to review the current claim.');
   if(detail.preflight_issues?.length||queued&&detail.submission_issues?.length)throw new Error('The claim needs updated information. Reopen Claim details to review the highlighted fields.');
   reviewedClaim={id:claim.id,version:claim.version};
  }
  synthetic=detail.claim.content?.synthetic_test===true;
 }
 const reviewing=queued&&!!account&&!existing?.submission_id;
 const description=reviewing?'Confirm the provider signature is on file, benefits are assigned, release of information is authorized, and you reviewed the codes and addresses for this routine professional claim.':
  !account?'No charges are saved for this encounter. Sign the clinical note and leave the claim with billing.':queued?'Queue the previously reviewed claim file for delivery to Claim.MD.':'The claim stays with billing for review.';
 const test=reviewing&&synthetic?' Confirm the patient, coverage and claim details are synthetic and you accept any clearinghouse charge for this test.':'';
 const label=[name,subject,summary.insurance?.insurer,Number.isSafeInteger(account?.total_cents)?money(account.total_cents):''].filter(Boolean).join(' · ');
 if(await confirmAction(description+test+cover,{title:operation+'?',eyebrow:label||'ENCOUNTER CLAIM',confirmLabel:operation,cancelLabel:'Cancel'})!==true)return false;
 const reviewed=encounterChargeAccount();
 if(!current()||activeVisit.version!==visitVersion||(reviewed?.id||null)!==accountId||(reviewed?.version??null)!==version||
   visitHandoffMode(summary,encounterChargeAccount())!==policy)throw new Error('The encounter changed during review. Review its current note and charges before continuing.');
 if(reviewing)confirmations={signature_on_file:true,benefits_assigned:true,release_authorized:true,routine_professional_reviewed:true,synthetic_test_reviewed:synthetic};
 const body={account_id:accountId,account_version:version,mode,confirmations};
 if(reviewedClaim)body.reviewed_claim=reviewedClaim;
 if(signing)body.sign_version=visitVersion;
 let result;
 try{
  result=await api('/api/v1/patients/'+encodeURIComponent(patient)+'/billing/visits/'+encodeURIComponent(visit)+'/claim-handoff','POST',body);
  if(!current())return false;
  if(result?.visit_id!==visit||result.account_id!==accountId||typeof result.signed!=='boolean'||!Number.isSafeInteger(result.visit_version)||
     ['queued','delivered'].includes(result.outcome)&&(!result.signed||!result.submission_id||!result.job_id))
   throw new Error('The server did not confirm the encounter handoff.');
 }catch(error){
  if(!current())return false;
  result={outcome:'unconfirmed',reason:'Refresh the encounter to check its saved signature and delivery. '+visitClaimErrorText(error)};
 }
 visitHandoffLast={patient,visit,identity,result};
 const restore=typeof encounterStepPosition==='function'?encounterStepPosition():null;
 try{
  if(result.signed&&signing&&typeof clearVisitNoteSession==='function')clearVisitNoteSession();
  await selectPatient(patient,visit);
  if(!current())return false;
  await loadEncounterRevenueStatus(encounterChargeAccount(),true);
  if(!current())return false;
  visitReviewRestore();
  if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();
  const evidence=visitHandoffEvidence(encounterRevenueState.data?.summary)||result;
  notice((result.signed&&signing?'Note signed. ':'')+visitHandoffStatus(evidence)+'. '+visitHandoffDetail(evidence),['needs_review','blocked','unconfirmed'].includes(evidence.outcome));
 }finally{if(current())restore?.();}
 return ['prepared','queued','delivered','self_pay'].includes(result.outcome);
}

// Signing has already committed. Every subsequent step commits independently and stops on failure.
async function visitNoteBill(){
 const patient=selected,identity=me,id=activeVisit?.id;
 const current=()=>selected===patient&&me===identity&&activeVisit?.id===id;
 const check=()=>{if(!current())throw new Error('This page changed. Open the encounter again.');};
 const problems=()=>{check();if($('visit-page-host')?.dataset?.encounterSteps!==undefined){visitReviewRestore();if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();}else{setEncounterSection('charges');visitReviewOpen();}};
 const held=await flushVisitNoteCharges({allowUnpriced:true});check();
 let account=encounterChargeAccount();
 if(!account){if(held&&$('visit-page-host')?.dataset?.encounterSteps===undefined)focusUnpricedVisitCharge();else problems();return false;}
 if(account.status==='draft'){
  const posted=await api(`${billingBase()}/${account.id}/actions`,'POST',{action:'post',reason:'Charges posted',local_only:false},account.version);check();
  if(posted?.id!==account.id||posted.status!=='posted')throw new Error('The charges could not be posted.');
  workspace.billing.accounts=workspace.billing.accounts.map(row=>row.id===posted.id?posted:row);account=posted;
 }
 if(held){
  // Priced lines are posted; keep the unfinished rows editable as a local correction draft.
  const form=$('billing-account-form');
  if(form){form.dataset.mode='correction';form.dataset.version=String(account.version);captureBillingChargeDraft();}
  if($('visit-page-host')?.dataset?.encounterSteps!==undefined)problems();else focusUnpricedVisitCharge();return false;
 }
 const prepared=await api(`/api/v1/patients/${encodeURIComponent(patient)}/billing/accounts/${encodeURIComponent(account.id)}/claims/prepare`,'POST',{});check();
 if(!['prepared','exists','not_needed'].includes(prepared?.outcome))throw new Error('The claim could not be prepared. Reload this encounter to check its billing status.');
 await loadEncounterRevenueStatus(account,true);check();
 if(encounterRevenueState.data?.stale||encounterRevenueState.data?.error)throw new Error('The balance could not be checked. Reload this encounter to try again.');
 const summary=encounterRevenueState.data?.summary;
 if(!summary)throw new Error('The balance could not be checked. Reload this encounter to try again.');
 // The stage bar gives claim review its own explicit send action.
 if($('visit-page-host')?.dataset?.encounterSteps!==undefined){problems();return true;}
 if(summary.insurance?.insured===false&&prepared.outcome==='not_needed'){await visitNoteOpenPayment();return true;}
 if(visitReviewMustFix(visitReviewChecks(summary,visitReviewContext())).length){problems();return false;}
 const options=visitReviewSendContext(summary,account);if(!options){problems();return false;}
 const opened=await visitReviewRun(summary.claim?.id||prepared.claim_id,{...options,needPost:false,needPrepare:false,confirmPost:false});check();
 if(!opened)problems();
 return opened;
}

if(typeof document!=='undefined')for(const type of ['input','change'])document.addEventListener(type,event=>{
 if(event.target.closest?.('#billing-account-form,#note-form,#coverage-form')){
  visitReviewPaint();if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();
 }
});
