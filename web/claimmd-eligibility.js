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

// ---- Reading the insurer's answer -------------------------------------------------
const claimmdNotReported='Not reported by the insurer';
const claimmdServiceNames={30:'Health plan coverage',98:'Office visit',96:'Specialist visit',UC:'Urgent care',86:'Emergency care',33:'Chiropractic',35:'Dental care',47:'Hospital',48:'Hospital inpatient',50:'Hospital outpatient',88:'Pharmacy',AL:'Vision',MH:'Mental health',1:'Medical care',BZ:'Primary care visit',BY:'Sick visit',A0:'Primary care visit in the office'};
const claimmdCoverageNames={1:'Active coverage',2:'Active coverage',3:'Active coverage',4:'Active coverage',5:'Active coverage',6:'Not active',7:'Not active',8:'Not active',A:'Coinsurance',B:'Copay',C:'Deductible',D:'Benefit description',E:'Exclusions',F:'Limitations',G:'Out-of-pocket limit',I:'Not covered',J:'Cost containment',L:'Primary care provider',R:'Other payer',U:'Contact the insurer',Y:'Spend down',CB:'Coverage basis',MC:'Managed care coordinator'};
const claimmdPeriodNames={6:'per hour',7:'per day',21:'per year',22:'service year',23:'calendar year',24:'so far this year',25:'contract period',26:'per episode',27:'per visit',29:'remaining',32:'lifetime',33:'lifetime remaining',34:'per month'};
function claimmdNumber(value){return typeof value==='number'||typeof value==='string'&&/^\d+(?:\.\d{1,2})?$/.test(value)?Number(value):NaN;}
function claimmdDollars(value){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);}
function claimmdDay(value){
 const match=/^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(value||'').trim());if(!match)return '';
 const day=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
 return Number.isFinite(day.getTime())?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(day):'';
}
function claimmdBenefitValue(benefit){
 const amount=claimmdNumber(benefit.benefit_amount),percent=claimmdNumber(benefit.benefit_percent),values=[];
 if(Number.isFinite(amount)&&amount>=0)values.push(claimmdDollars(amount));
 if(Number.isFinite(percent)&&percent>=0&&percent<=100)values.push(`${percent}%`);
 return values.join(' · ');
}
function claimmdCheckDate(check){return check?.request_snapshot?.request?.service_date||check?.request_snapshot?.service_date||'';}
function claimmdPlans(check){return Array.isArray(check?.response_snapshot?.elig)?check.response_snapshot.elig.filter(row=>row&&typeof row==='object'):[];}
function claimmdBenefits(check){return claimmdPlans(check).flatMap(plan=>Array.isArray(plan.benefit)?plan.benefit:plan.benefit&&typeof plan.benefit==='object'?[plan.benefit]:[]).filter(benefit=>benefit&&typeof benefit==='object');}
function claimmdNetwork(benefit){return {Y:'in',N:'out',W:'both'}[benefit.inplan_network]||'any';}
// The first benefit of one kind for the most specific service the insurer reported,
// for one person rather than the family.
function claimmdPick(benefits,coverageCode,services,networks,accept=()=>true){
 for(const service of services)for(const network of networks){
  const found=benefits.find(benefit=>String(benefit.benefit_coverage_code)===coverageCode&&(service===null||String(benefit.benefit_code)===service)&&claimmdNetwork(benefit)===network&&benefit.benefit_level_code!=='FAM'&&accept(benefit));
  if(found)return found;
 }
 return null;
}
function claimmdOwes(benefits,networks){
 const amount=benefit=>Number.isFinite(claimmdNumber(benefit.benefit_amount)),percent=benefit=>{const value=claimmdNumber(benefit.benefit_percent);return Number.isFinite(value)&&value<=100;};
 const left=benefit=>String(benefit.benefit_period_code)==='29',total=benefit=>!['29','24'].includes(String(benefit.benefit_period_code));
 const visit=['98','96','30'],plan=['30',null];
 const pair=code=>({total:claimmdPick(benefits,code,plan,networks,benefit=>amount(benefit)&&total(benefit)),left:claimmdPick(benefits,code,plan,networks,benefit=>amount(benefit)&&left(benefit))});
 return {copay:claimmdPick(benefits,'B',visit,networks,amount),coinsurance:claimmdPick(benefits,'A',visit,networks,percent),deductible:pair('C'),limit:pair('G')};
}
function claimmdSame(a,b,pattern){const clean=value=>String(value||'').toLowerCase().replace(pattern,'');return !clean(a)||!clean(b)||clean(a)===clean(b);}
// Everything the summary shows, worked out once from a completed check.
function claimmdEligibilitySummary(check){
 const plans=claimmdPlans(check),benefits=claimmdBenefits(check),code=benefit=>String(benefit.benefit_coverage_code||'');
 const active=benefits.filter(benefit=>['1','2','3','4','5'].includes(code(benefit))),inactive=benefits.filter(benefit=>['6','7','8'].includes(code(benefit)));
 const errors=plans.flatMap(plan=>Array.isArray(plan.error)?plan.error:plan.error?[plan.error]:[]);
 const status=active.length?'active':inactive.length?'inactive':'unknown',lead=active[0]||inactive[0]||benefits[0]||{},member=plans.find(plan=>plan.ins_name_l||plan.ins_name_f||plan.ins_number)||plans[0]||{};
 const first=name=>lead[name]||benefits.find(benefit=>benefit[name])?.[name]||plans.find(plan=>plan[name])?.[name]||'';
 const period=/^(\d{8})(?:-(\d{8}))?$/.exec(String(plans.find(plan=>plan.plan_begin_date)?.plan_begin_date||'')),ends=period?.[2]||plans.find(plan=>/^\d{8}$/.test(String(plan.plan_end_date||'')))?.plan_end_date;
 const request=check?.request_snapshot?.request||{},differs=[];
 if(!claimmdSame(member.ins_name_f,request.insured_given_name,/[^a-z]/g)||!claimmdSame(member.ins_name_l,request.insured_family_name,/[^a-z]/g))differs.push('name');
 if(!claimmdSame(member.ins_dob,request.insured_birth_date,/\D/g))differs.push('date of birth');
 if(!claimmdSame(member.ins_number,check?.request_snapshot?.member_id,/[^a-z0-9]/g))differs.push('member ID');
 return {status,plans,benefits,errors,plan:first('insurance_plan'),type:first('insurance_type_description'),group:plans.find(plan=>plan.group_number)?.group_number||'',dates:period?[claimmdDay(period[1]),ends?claimmdDay(ends):''].filter(Boolean).join(' – '):'',memberName:[member.ins_name_f,member.ins_name_l].filter(Boolean).join(' '),differs,
  inNetwork:claimmdOwes(benefits,['in','both','any']),outOfNetwork:claimmdOwes(benefits,['out','both'])};
}
function claimmdCopayLabel(benefit){return {98:'Office visit copay',96:'Specialist visit copay'}[benefit?.benefit_code]||'Copay';}
function claimmdOwesRows(owes){
 const money=benefit=>benefit?claimmdDollars(claimmdNumber(benefit.benefit_amount)):'',pair=({total,left})=>left&&total?`${money(left)} left of ${money(total)}`:left?`${money(left)} left`:total?money(total):claimmdNotReported;
 return `<dt>${esc(claimmdCopayLabel(owes.copay))}</dt><dd>${esc(money(owes.copay)||claimmdNotReported)}</dd><dt>Coinsurance</dt><dd>${esc(owes.coinsurance?`${claimmdNumber(owes.coinsurance.benefit_percent)}%`:claimmdNotReported)}</dd><dt>Deductible</dt><dd>${esc(pair(owes.deductible))}</dd><dt>Out-of-pocket limit</dt><dd>${esc(pair(owes.limit))}</dd>`;
}
function claimmdBenefitLine(benefit){
 const what=benefit.benefit_coverage_description||claimmdCoverageNames[benefit.benefit_coverage_code]||'Benefit',value=claimmdBenefitValue(benefit);
 const level={IND:'Individual',FAM:'Family'}[benefit.benefit_level_code]||benefit.benefit_level_description||'',period=benefit.benefit_period_description||claimmdPeriodNames[benefit.benefit_period_code]||'';
 const detail=[level,period].filter(Boolean).join(' · ');
 return `<li><b>${esc(what)}</b>${value?' '+esc(value):''}${detail?` <small>${esc(detail)}</small>`:''}${benefit.benefit_notes?`<small>${esc(String(benefit.benefit_notes).slice(0,1000))}</small>`:''}</li>`;
}
function claimmdAllBenefits(benefits){
 if(!benefits.length)return '';
 const services=new Map();
 for(const benefit of benefits){const name=benefit.benefit_description||claimmdServiceNames[benefit.benefit_code]||'Other benefits';if(!services.has(name))services.set(name,new Map());const group=services.get(name),network={in:'In network',out:'Out of network',both:'In and out of network',any:'Any network'}[claimmdNetwork(benefit)];if(!group.has(network))group.set(network,[]);group.get(network).push(benefit);}
 const order=['In network','In and out of network','Any network','Out of network'];
 return `<details class="eligibility-more"><summary>See all benefits</summary>${Array.from(services,([name,group])=>`<section><h5>${esc(name)}</h5>${order.filter(network=>group.has(network)).map(network=>`<p class="muted">${network}</p><ul>${group.get(network).map(claimmdBenefitLine).join('')}</ul>`).join('')}</section>`).join('')}</details>`;
}
// What an insurer's own refusal means for the front desk. Codes are the standard
// eligibility reject reasons; anything else falls back to the insurer's wording.
function claimmdPayerProblem(errors){
 const codes=errors.map(error=>String(error?.error_code||'')),text=errors.map(error=>typeof error==='string'?error:error?.error_message||error?.error_mesg||error?.message||'').join(' ').toLowerCase();
 const any=list=>codes.some(code=>list.includes(code)),says=words=>words.some(word=>text.includes(word));
 if(any(['58','60','61','64','65','66','67','68','71','72','73','74','75','76','77','78'])||says(['not found','subscriber','member','insured','birth']))return 'member';
 if(any(['41','43','44','45','46','47','48','50','51','79','97'])||says(['provider','npi','not authorized']))return 'provider';
 if(any(['42','80'])||says(['unable to respond','unavailable','timeout','try again']))return 'retry';
 return 'other';
}
const claimmdEligibilityOwner=()=>me?.role==='owner';
function claimmdStaffName(check){return check?.request_snapshot?.automatic?'':check?.actor_name||'a staff member';}
function claimmdCheckedLine(check){
 const when=date(check.completed_at||check.created_at);
 return check?.request_snapshot?.automatic?`Checked automatically ${when}`:`Checked ${when} by ${claimmdStaffName(check)}`;
}
function claimmdStatusLabel(check){
 if(check.status==='pending')return 'Waiting for the insurer';
 if(check.status!=='completed')return 'Could not confirm';
 return {active:'Active',inactive:'Not active',unknown:'Could not confirm'}[claimmdEligibilitySummary(check).status];
}
function claimmdTechnicalDetails(value){return claimmdEligibilityOwner()?`<details class="eligibility-technical"><summary>Technical details</summary><pre class="billing-source">${esc(JSON.stringify(value,null,2))}</pre></details>`:'';}
// The summary of one completed check: status, plan, and what the patient pays.
function claimmdEligibilityResult(check,coverage,options={}){
 const summary=claimmdEligibilitySummary(check),serviceDate=claimmdCheckDate(check),label=claimmdStatusLabel(check),recorded=coverage?.content?.copay_cents;
 const fact=(name,value)=>value?`<dt>${name}</dt><dd>${esc(value)}</dd>`:'';
 const copay=summary.inNetwork.copay,cents=copay?Math.round(claimmdNumber(copay.benefit_amount)*100):null,ui=coverage?claimmdEligibilityUiFor(coverage.id):{};
 const canSave=options.actions!==false&&coverage&&cents!=null&&cents!==recorded&&typeof billingCan==='function'&&billingCan('edit')&&coverage.content.status==='active';
 const problem=summary.status==='unknown'&&summary.errors.length?claimmdPayerProblem(summary.errors):'';
 const said=summary.errors.map(error=>typeof error==='string'?error:error?.error_message||error?.error_mesg||error?.message||'').filter(Boolean)[0];
 const explain=problem==='member'?'The insurer could not find this member. Check the member ID, name and date of birth on the coverage.':problem==='provider'?`The insurer does not recognise ${claimmdProviderLabel(check)} for eligibility checks yet.`:problem==='retry'?'The insurer\'s system could not answer right now. Try again in a few minutes.':problem?`The insurer did not confirm coverage${said?': “'+String(said).slice(0,300)+'”':'.'}`:summary.status==='unknown'?'The insurer answered but did not say whether the plan is active.':'';
 const next=options.actions===false||!problem?'':problem==='member'&&typeof billingCan==='function'&&billingCan()?`<button type="button" data-edit-coverage="${esc(coverage.id)}">Edit coverage</button>`:problem==='provider'?claimmdEnrollAction(check,coverage):problem==='retry'?claimmdTryAgain(coverage,options):'';
 const other=options.serviceDate&&serviceDate&&serviceDate!==options.serviceDate?`<p class="eligibility-caution">This answer is for ${esc(claimmdDay(serviceDate))}. The visit is on ${esc(claimmdDay(options.serviceDate))}.</p>`:'';
 return `<div class="eligibility-result"><p class="eligibility-status"><span class="eligibility-pill ${summary.status}">${label}</span> <span>${serviceDate?'on '+esc(claimmdDay(serviceDate))+' · ':''}${esc(claimmdCheckedLine(check))}</span></p>${other}${explain?`<p>${esc(explain)}</p>${next}`:''}${summary.status==='inactive'?'<p>The insurer reports this plan is not active on this date. Ask the patient for their current insurance card.</p>':''}`
  +`<dl class="billing-dl eligibility-facts">${fact('Plan',summary.plan)}${fact('Insurance type',summary.type)}${fact('Group number',summary.group)}${fact('Coverage dates',summary.dates)}${fact('Member name from the insurer',summary.memberName)}</dl>${summary.differs.length?`<p class="eligibility-caution">The insurer has a different ${esc(summary.differs.join(' and '))} on file.</p>`:''}`
  +(summary.status==='active'?`<div class="eligibility-owes"><h4>What the patient pays at a visit</h4><dl class="billing-dl">${claimmdOwesRows(summary.inNetwork)}</dl>${canSave?`<button type="button" class="primary" data-eligibility-copay="${esc(coverage.id)}" data-cents="${cents}" data-check-date="${esc(serviceDate)}">Save ${esc(claimmdDollars(cents/100))} as this plan's copay</button>`:''}${ui.copaySaved!=null&&ui.copaySaved===recorded?`<p class="eligibility-saved" role="status">Saved. This plan's copay is now ${esc(claimmdDollars(recorded/100))}.</p>`:''}<details class="eligibility-more"><summary>Out of network</summary><dl class="billing-dl">${claimmdOwesRows(summary.outOfNetwork)}</dl></details><p class="muted">This is what the insurer reported. It is not a promise to pay.</p></div>`:'')
  +claimmdAllBenefits(summary.benefits)+claimmdTechnicalDetails(check.response_snapshot)+'</div>';
}
function claimmdEligibilityRows(check){return check?.status==='completed'?claimmdEligibilityResult(check,null,{actions:false}):'';}

// ---- When a check could not be completed --------------------------------------------
function claimmdProviderLabel(check){
 const id=check?.request_snapshot?.request?.provider_id;
 return check?.request_snapshot?.provider_name||claimmdProviderDefaults.providers?.find(provider=>provider.id===id)?.display_name||'this provider';
}
function claimmdFailureKind(check){
 const failure=check?.response_snapshot?.failure;if(!failure)return 'other';
 const hints=Array.isArray(failure.provider_hints)?failure.provider_hints:[],has=(...words)=>words.some(word=>hints.includes(word)),status=Number(failure.http_status)||0;
 if(has('eligibility')&&has('provider')||has('enroll','not enabled'))return 'enroll';
 if(has('member','subscriber','name','birth','insured'))return 'member';
 if(has('payer'))return 'payer';
 if(['transport_unavailable','response_invalid'].includes(failure.kind)||status>=500||status===429||has('timeout','unavailable'))return 'retry';
 if(failure.kind==='configuration_unavailable'||status===401||status===403||has('key','account','not authorized'))return 'connection';
 return 'other';
}
function claimmdTryAgain(coverage,options={}){return options.actions!==false&&claimmdEligibilityCanRequest(coverage)?`<button type="button" data-claimmd-eligibility="${esc(coverage.id)}">Try again</button>`:'';}
function claimmdEnrollAction(check,coverage){
 if(!claimmdEligibilityOwner())return '<p>Ask the practice owner to set this up under Claim connections.</p>';
 const result=claimmdEligibilityUiFor(coverage.id).enrollment;
 const hints=result?.failure?.provider_hints||[],canSupport=typeof supportHelpAvailable==='function'&&supportHelpAvailable(),support=canSupport?`<button type="button" data-eligibility-support="${esc(check.id)}" data-coverage="${esc(coverage.id)}">Send this to support</button>`:'';
 const outcome=!result||result.check!==check.id?'':result.status==='started'?`<p role="status">Claim.MD's setup form opened in a new tab. Finish it there. The insurer can take a few days to turn eligibility on. <a href="${esc(result.external_url)}" target="_blank" rel="noopener noreferrer">Open the form again</a></p>`:result.status==='refused'&&(hints.includes('already')||hints.includes('duplicate'))?'<p role="status">Claim.MD says this is already set up or already requested. The insurer can take a few days to turn it on. Try the check again later.</p>':`<p role="status">Claim.MD did not open a setup form for this insurer. Sign in to Claim.MD and open Provider Enrollment${canSupport?', or send this to support':''}.</p>${support}`;
 return `<button type="button" class="primary" data-eligibility-enroll="${esc(check.id)}" data-coverage="${esc(coverage.id)}">Set up eligibility with Claim.MD</button>${outcome}`;
}
function claimmdEligibilityFailure(check,coverage,options={}){
 const kind=claimmdFailureKind(check),failure=check?.response_snapshot?.failure,owner=claimmdEligibilityOwner(),insurer=typeof payerName==='function'&&coverage?payerName(coverage.content.payer_id):'the insurer',actions=options.actions!==false&&coverage;
 const canSupport=actions&&typeof supportHelpAvailable==='function'&&supportHelpAvailable();
 const edit=actions&&typeof billingCan==='function'&&billingCan()?`<button type="button" data-edit-coverage="${esc(coverage.id)}">Edit coverage</button>`:'';
 const [text,action]={
  enroll:[`Claim.MD has not turned on eligibility checks for ${claimmdProviderLabel(check)} with ${insurer} yet.`,actions?claimmdEnrollAction(check,coverage):''],
  member:['The insurer could not find this member. Check the member ID, name and date of birth on the coverage.',edit],
  payer:[`Claim.MD did not recognise the payer ID for ${insurer}. Check the payer ID for this insurance company.`,actions?claimmdPayerAction(coverage):''],
  retry:['The insurer\'s system did not answer. Try again in a few minutes.',actions?claimmdTryAgain(coverage,options):''],
  connection:['Claim.MD is not connected.',actions?(owner?'<button type="button" data-eligibility-connections>Open Claim connections</button>':'<p>Ask the practice owner to check Claim connections.</p>'):''],
  other:canSupport?['Claim.MD refused the request and gave no reason we can show. Send this to support.',`<button type="button" data-eligibility-support="${esc(check.id)}" data-coverage="${esc(coverage.id)}">Send this to support</button>`]:['Claim.MD refused the request and gave no reason we can show. Contact SunCharts support and tell them when this check was tried.','']
 }[kind];
 return `<div class="eligibility-failure" data-failure="${kind}"><p class="eligibility-status"><span class="eligibility-pill unknown">Could not confirm</span> <span>${esc(claimmdCheckedLine(check).replace(/^Checked/,'Tried'))}</span></p><p>${esc(text)}</p>${action}<p class="muted">This does not mean the patient is uninsured.</p>${failure?claimmdTechnicalDetails({kind:failure.kind,status:failure.http_status,codes:failure.provider_codes||[],words:failure.provider_hints||[]}):''}</div>`;
}
function claimmdPayerAction(coverage){
 return claimmdEligibilityOwner()?`<button type="button" data-eligibility-payer="${esc(coverage.content.payer_id)}">Add the payer ID</button>`:'<p>Ask the practice owner to add it in the payer directory under Billing tools.</p>';
}

// ---- The card on a coverage -----------------------------------------------------------
// What is happening on screen for each coverage of the open chart: a running check, a
// question that needs one answer, or the result of a button the person just used.
let claimmdEligibilityUi={patient:null,identity:null,items:new Map()};
const claimmdEligibilityAutoTried=new Set();
let claimmdEligibilityPanel=null;
function claimmdEligibilityUiFor(coverageId){
 if(claimmdEligibilityUi.patient!==selected||claimmdEligibilityUi.identity!==me)claimmdEligibilityUi={patient:selected,identity:me,items:new Map()};
 if(!claimmdEligibilityUi.items.has(coverageId))claimmdEligibilityUi.items.set(coverageId,{});
 return claimmdEligibilityUi.items.get(coverageId);
}
function claimmdEligibilityCanRequest(coverage){return !!coverage&&billingWrite()&&coverage.content.status==='active'&&(typeof billingCan!=='function'||billingCan('create'));}
function claimmdNeedPrompt(coverage,ui){
 const need=ui.needs[0],owner=claimmdEligibilityOwner(),insurer=ui.insurer||'this insurance company',form=(body,button)=>`<form class="eligibility-need" data-eligibility-need="${esc(need.kind)}" data-coverage="${esc(coverage.id)}">${body}<button type="submit" class="primary">${button}</button></form>`;
 const ask=text=>`<div class="eligibility-need"><p>${text}</p>`;
 if(need.kind==='billing_organization')return form(`<label>Which billing organization should ${esc(insurer)} see?<select name="billing_organization_id" required>${(need.choices||[]).map(row=>`<option value="${esc(row.id)}">${esc(row.name)} · ${row.tax_id_type==='E'?'EIN':'SSN'} ending ${esc(row.tax_id_last4)}</option>`).join('')}</select></label>`,'Use this and check');
 if(need.kind==='provider')return form(`<label>Which provider is this check for?<select name="provider_id" required>${(need.choices||[]).map(row=>`<option value="${esc(row.id)}">${esc(row.display_name)}</option>`).join('')}</select></label>`,'Use this and check');
 if(need.kind==='subscriber_birth_date')return form('<label>What is the policy holder\'s date of birth?<input type="date" name="subscriber_birth_date" required></label>','Save and check');
 if(need.kind==='subscriber_name')return form('<label>Policy holder\'s first name<input name="given" maxlength="90" required autocomplete="off"></label><label>Policy holder\'s last name<input name="family" maxlength="90" required autocomplete="off"></label>','Save and check');
 if(need.kind==='member_id')return `${ask('This coverage has no member ID.')}${typeof billingCan==='function'&&billingCan()?`<button type="button" data-edit-coverage="${esc(coverage.id)}">Edit coverage</button>`:''}</div>`;
 if(need.kind==='payer_id')return `${ask('This insurance company has no payer ID yet.')}${claimmdPayerAction(coverage)}</div>`;
 if(need.kind==='provider_npi')return `${ask('No provider has an NPI on file yet.')}${owner?'<button type="button" data-practice-providers>Add an NPI</button>':'<p>Ask the practice owner to add one in Practice administration.</p>'}</div>`;
 if(need.kind==='billing_organization_missing')return `${ask('The practice has no billing organization with a tax ID yet.')}${owner?'<button type="button" data-billing-organizations>Add a billing organization</button>':'<p>Ask the practice owner to add one in Practice administration.</p>'}</div>`;
 if(need.kind==='claim_connection')return `${ask('Claim.MD is not connected.')}${owner?'<button type="button" data-eligibility-connections>Open Claim connections</button>':'<p>Ask the practice owner to check Claim connections.</p>'}</div>`;
 return `${ask('One more detail is needed before this can be checked.')}</div>`;
}
function claimmdHistoryLine(check,coverage){
 const serviceDate=claimmdCheckDate(check),who=check?.request_snapshot?.automatic?'automatically':claimmdStaffName(check);
 return `<details class="eligibility-past"><summary>${esc(date(check.completed_at||check.created_at))} · ${esc(claimmdStatusLabel(check))} · ${esc(who)}${serviceDate?' · for '+esc(claimmdDay(serviceDate)):''}</summary>${check.status==='completed'?claimmdEligibilityResult(check,coverage,{actions:false}):check.status==='pending'?'<p>The insurer has not answered yet.</p>':claimmdEligibilityFailure(check,coverage,{actions:false})}</details>`;
}
function claimmdEligibilityCard(coverage,items,options={}){
 const ui=claimmdEligibilityUiFor(coverage.id),list=[...(items||[])].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),latest=list[0],answer=list.find(check=>check.status==='completed');
 const can=!options.readOnly&&claimmdEligibilityCanRequest(coverage),insurer=typeof payerName==='function'?payerName(coverage.content.payer_id):'the insurer',parts=[];
 const asking=can&&!ui.running&&ui.needs?.length&&!ui.quiet;
 if(ui.running)parts.push(`<p class="eligibility-running" role="status">Checking with ${esc(insurer)}…</p>`);
 if(asking)parts.push(claimmdNeedPrompt(coverage,ui));
 if(ui.problem&&!ui.running)parts.push(`<p class="eligibility-problem" role="alert">${esc(ui.problem)}</p>`);
 if(!ui.running&&!asking){
  if(latest?.status==='failed')parts.push(claimmdEligibilityFailure(latest,coverage,{actions:!options.readOnly}));
  else if(latest?.status==='pending')parts.push('<p>Waiting for the insurer\'s answer. Refresh in a moment.</p>');
 }
 if(answer)parts.push((answer!==latest?'<p class="muted">Last answer from the insurer</p>':'')+claimmdEligibilityResult(answer,coverage,{serviceDate:options.serviceDate,actions:!options.readOnly}));
 if(!latest&&!ui.running&&!asking)parts.push('<p class="muted">Not checked with the insurer yet.</p>');
 if(can&&!ui.running&&options.button)parts.push(`<div class="actions"><button type="button" data-claimmd-eligibility="${esc(coverage.id)}">${latest?'Check again':'Check eligibility'}</button></div>`);
 const shown=new Set([answer,!ui.running&&!asking&&latest?.status!=='completed'?latest:null]),rest=list.filter(check=>!shown.has(check)),answers=rest.filter(check=>check.status!=='failed'),attempts=rest.filter(check=>check.status==='failed');
 if(rest.length)parts.push(`<details class="eligibility-history"><summary>Past checks (${rest.length})</summary>${answers.map(check=>claimmdHistoryLine(check,coverage)).join('')}${attempts.length?`<details class="eligibility-attempts"><summary>Earlier attempts (${attempts.length})</summary>${attempts.map(check=>claimmdHistoryLine(check,coverage)).join('')}</details>`:''}</details>`);
 if(can&&claimmdEligibilityOwner()&&!options.form)parts.push(`<details class="eligibility-more eligibility-options"><summary>More options</summary><p class="muted">Check a different date, service or provider.</p><button type="button" data-eligibility-advanced="${esc(coverage.id)}">Open the full request form</button></details>`);
 return `<div class="eligibility-card">${parts.join('')}</div>`;
}
function claimmdEligibilityHistory(items,coverage){
 if(coverage)return claimmdEligibilityCard(coverage,items,{readOnly:true,form:true});
 return (items||[]).map(check=>claimmdHistoryLine(check,null)).join('')||'<p class="muted">Not checked with the insurer yet.</p>';
}
function claimmdEligibilityRepaint(coverageId){
 if(typeof refreshInsuranceEligibility==='function')refreshInsuranceEligibility(coverageId);
 const panel=claimmdEligibilityPanel,host=$('claimmd-eligibility-panel');
 if(!panel||panel.coverage.id!==coverageId||!host||!panel.current())return;
 host.innerHTML=claimmdEligibilityCard(panel.coverage,panel.items,panel.options);
}
function claimmdEligibilityStore(coverageId,history){
 if(typeof updateInsuranceEligibility==='function')updateInsuranceEligibility(coverageId,history);
 if(claimmdEligibilityPanel?.coverage.id===coverageId)claimmdEligibilityPanel.items=history.items||[];
 claimmdEligibilityRepaint(coverageId);
 // The patient banner shows the latest answer too, including an attempt that did not get one.
 if(typeof patientBannerChanged==='function')patientBannerChanged();
}
// Where the person is working decides which visit a check is for.
function claimmdEligibilityContext(){
 const section=typeof chartSection==='undefined'?null:chartSection,appointment=section==='insurance'&&typeof revenueAppointment==='function'?revenueAppointment():null,visit=section==='visits'&&typeof activeVisit!=='undefined'?activeVisit:null;
 return {appointmentId:appointment?.id||undefined,visitId:visit?.id||undefined,serviceDate:typeof revenueServiceDate==='function'?revenueServiceDate():undefined};
}
// One click: the server works out the request. `answers` carries the reply to a question.
async function claimmdEligibilityCheck(coverage,options={}){
 const patientId=selected,identity=me,ui=claimmdEligibilityUiFor(coverage.id);
 if(ui.running)return;
 const context={...claimmdEligibilityContext(),...options.context},base=`/api/v1/patients/${patientId}/coverages/${coverage.id}/claimmd-eligibility`;
 ui.running=true;ui.problem='';ui.quiet=false;ui.requestId=ui.requestId||crypto.randomUUID();claimmdEligibilityRepaint(coverage.id);
 const body={request_id:ui.requestId,automatic:!!options.automatic,...ui.answers};
 if(context.appointmentId)body.appointment_id=context.appointmentId;
 if(context.visitId&&!context.appointmentId)body.visit_id=context.visitId;
 if(context.serviceDate)body.service_date=context.serviceDate;
 let reply,failure,history;
 try{reply=await api(`${base}/check`,'POST',body);}catch(error){failure=error;}
 if(selected!==patientId||me!==identity)return;
 // A reply from the server settles this click. Without one the same request ID is kept,
 // so trying again can never ask the insurer twice.
 if(reply||failure?.status)ui.requestId=null;
 if(reply?.outcome==='needs'){ui.needs=reply.needs;ui.insurer=reply.insurer;ui.quiet=!!options.automatic;}
 else if(reply){ui.needs=null;if(reply.outcome==='checked')ui.answers=null;}
 if(failure&&!options.automatic)ui.problem=failure.message;
 try{history=await api(base);}catch{history=null;}
 if(selected!==patientId||me!==identity)return;
 ui.running=false;
 if(history)claimmdEligibilityStore(coverage.id,history);else claimmdEligibilityRepaint(coverage.id);
 return reply;
}
// Runs by itself when the insurance step of an appointment is opened, at most once
// per coverage for as long as this page stays open.
function claimmdEligibilityAuto(coverage,items,context={}){
 const key=`${me?.user_id||''}:${selected}:${coverage.id}`,payer=(typeof billingPayers==='undefined'?[]:billingPayers).find(row=>row.id===coverage.content.payer_id);
 if(claimmdEligibilityAutoTried.has(key)||!context.appointmentId||!claimmdEligibilityCanRequest(coverage)||!payer?.content?.payer_code)return false;
 const now=Date.now(),day=86400000,since=new Date(now-30*day).toISOString().slice(0,10),list=items||[];
 if(list.some(check=>check.status==='completed'&&claimmdCheckDate(check)>=since)||list.some(check=>check.status==='failed'&&now-new Date(check.created_at).getTime()<day/2)||list.some(check=>check.status==='pending'))return false;
 claimmdEligibilityAutoTried.add(key);
 void claimmdEligibilityCheck(coverage,{automatic:true,context});
 return true;
}
async function claimmdSaveCoverage(coverage,changes,reason){
 await api(`/api/v1/patients/${selected}/coverages/${coverage.id}`,'PUT',{content:{...coverage.content,...changes},reason},coverage.version);
 const section=typeof chartSection==='undefined'?'insurance':chartSection;
 await selectPatient(selected,typeof activeVisit==='undefined'?undefined:activeVisit?.id);
 if(typeof showChartSection==='function')showChartSection(section==='visits'?'visits':'insurance');
 return workspace.billing.coverages.find(item=>item.id===coverage.id)||coverage;
}
function claimmdSupportDraft(check,coverage){
 const failure=check.response_snapshot?.failure||{},codes=(failure.provider_codes||[]).filter(code=>/^\d{1,6}$/.test(String(code))),hints=(failure.provider_hints||[]).filter(hint=>/^[a-z ]{1,20}$/.test(String(hint)));
 return {subject:'Eligibility check was refused',message:[`An eligibility check with ${payerName(coverage.content.payer_id)} was refused by Claim.MD.`,`Checked: ${new Date(check.created_at).toISOString()}`,`Service date: ${claimmdCheckDate(check)||'not recorded'}`,`Claim.MD code: ${codes.join(', ')||'none'}`,`Words in Claim.MD's reply: ${hints.join(', ')||'none'}`,`Check reference: ${check.id}`].join('\n')};
}

async function openClaimmdEligibility(coverage,options={}){
 const opening=++claimmdEligibilityGeneration;
 const patientId=selected,identity=me,editor=typeof billingEditorHost==='function'?billingEditorHost():$('billing-editor');
 let editorAnchor=editor?.firstElementChild;
 const visitId=typeof activeVisit==='undefined'?null:activeVisit?.id,section=typeof chartSection==='undefined'?null:chartSection;
 const current=()=>opening===claimmdEligibilityGeneration&&editor?.firstElementChild===editorAnchor&&selected===patientId&&me===identity&&(typeof activeVisit==='undefined'||activeVisit?.id===visitId)&&(typeof chartSection==='undefined'||chartSection===section)&&(typeof billingEditorHost==='function'?billingEditorHost():$('billing-editor'))===editor&&(!options.isCurrent||options.isCurrent());
 if(!current())return;
 const history=options.history||await api(`/api/v1/patients/${patientId}/coverages/${coverage.id}/claimmd-eligibility`);if(!current())return;
 const cardOptions={serviceDate:options.serviceDate,readOnly:!!options.readOnly,button:true};
 claimmdEligibilityPanel={coverage,items:history.items||[],options:cardOptions,current};
 openBillingEditor(`<section><div class="section-head"><div><h3>Insurance eligibility</h3><p class="muted">${esc(payerName(coverage.content.payer_id))} · member ${esc(coverage.content.member_id)}</p></div><button type="button" data-cancel-billing>Close</button></div><div id="claimmd-eligibility-panel">${claimmdEligibilityCard(coverage,history.items||[],cardOptions)}</div></section>`);
 editorAnchor=editor?.firstElementChild;
 // Opened to check a coverage that has never been checked: do it, don't ask.
 if(!options.readOnly&&!(history.items||[]).length&&claimmdEligibilityCanRequest(coverage))await claimmdEligibilityCheck(coverage,{context:{serviceDate:options.serviceDate}});
}
// The full request form, for the rare check the one-click request cannot express.
async function openClaimmdEligibilityForm(coverage,options={}){
 const opening=++claimmdEligibilityGeneration;
 const patientId=selected,identity=me,editor=typeof billingEditorHost==='function'?billingEditorHost():$('billing-editor'),patient=workspace.patient,serviceDate=options.serviceDate||new Date().toISOString().slice(0,10);
 let editorAnchor=editor?.firstElementChild;
 const visitId=typeof activeVisit==='undefined'?null:activeVisit?.id,section=typeof chartSection==='undefined'?null:chartSection;
 const current=()=>opening===claimmdEligibilityGeneration&&editor?.firstElementChild===editorAnchor&&selected===patientId&&me===identity&&(typeof activeVisit==='undefined'||activeVisit?.id===visitId)&&(typeof chartSection==='undefined'||chartSection===section)&&(typeof billingEditorHost==='function'?billingEditorHost():$('billing-editor'))===editor&&(!options.isCurrent||options.isCurrent());
 if(!current())return;
 if(!claimmdEligibilityOwner()||!claimmdEligibilityCanRequest(coverage))throw new Error('Only the practice owner can open the full request form.');
 const history=options.history||await api(`/api/v1/patients/${patientId}/coverages/${coverage.id}/claimmd-eligibility`);if(!current())return;
 const subscriber=claimmdSubscriberParts(coverage.content.subscriber_name);
 const directory=await loadClaimmdProviderDefaults();if(!current())return;
 const providers=directory.providers||[],organizations=directory.billing_organizations||[];
 const preferredProvider=providers.find(row=>row.id===(typeof activeVisit==='undefined'?null:activeVisit?.clinician_id))?.id||directory.default_provider_id||'';
 const providerOptions=providers.map(row=>`<option value="${esc(row.id)}" ${row.id===preferredProvider?'selected':''}>${esc(row.display_name)} · NPI ${esc(row.npi)}</option>`).join('');
 const orgOptions=organizations.map(row=>`<option value="${esc(row.id)}" ${organizations.length===1?'selected':''}>${esc(row.name)} · ${esc(row.tax_id_type==='E'?'EIN':'SSN')} ending ${esc(row.tax_id_last4)}</option>`).join('');
 const identityFields=`<label>Provider<select name="provider_id" required><option value="">Select a practice provider</option>${providerOptions}</select></label><label>Billing organization and tax ID<select name="billing_organization_id" required><option value="">Select a billing organization</option>${orgOptions}</select></label><p class="muted">Use the provider and billing organization the insurer has on file for the practice.</p>${!providers.length||!organizations.length?`<div class="notice error"><p>Before checking eligibility, the practice needs ${[!organizations.length?'a billing organization with its tax ID':'',!providers.length?'a provider with an NPI':''].filter(Boolean).join(' and ')}.</p>${!organizations.length?'<button type="button" class="primary" data-billing-organizations>Add billing organization</button> ':''}${!providers.length?'<button type="button" class="primary" data-practice-providers>Add provider</button>':''}</div>`:'<button type="button" data-billing-organizations>Billing organizations</button> <button type="button" data-practice-providers>Providers</button>'}`;
 openBillingEditor(`<section><div class="section-head"><div><h3>Eligibility request · more options</h3><p class="muted">${esc(payerName(coverage.content.payer_id))} · member ${esc(coverage.content.member_id)}</p></div><button type="button" data-cancel-billing>Close</button></div><p>Change any detail of the request before it is sent. The answer does not change the coverage record.</p><form id="claimmd-eligibility-form" data-coverage="${esc(coverage.id)}" data-request="${crypto.randomUUID()}"><div class="form-grid">${billingField('insured_given_name','Policy holder first name',coverage.content.relationship==='self'?patient.given_name:subscriber.given,'text',100,true)}${billingField('insured_middle_name','Policy holder middle name',subscriber.middle,'text',100)}${billingField('insured_family_name','Policy holder last name',coverage.content.relationship==='self'?patient.family_name:subscriber.family,'text',100,true)}${billingField('insured_birth_date','Policy holder date of birth',coverage.content.relationship==='self'?patient.birth_date:(coverage.content.subscriber_birth_date||''),'date')}${selectField('insured_sex','Policy holder sex',['','F','M'],'')}${selectField('patient_sex','Patient sex',['','F','M'],'')}${billingField('service_date','Service date',serviceDate,'date',0,true)}${billingField('service_codes','Benefit types','30','text',200)}${billingField('procedure_code','Procedure code (instead of benefit types)','','text',10)}${identityFields}${billingField('provider_name','Provider last name or organization name (only if the insurer asks for it)','','text',200)}${billingField('provider_taxonomy','Provider taxonomy','','text',10)}</div><p class="muted">Benefit types are the insurer's service codes, separated by commas: 30 is general health plan coverage, 98 is an office visit. Use benefit types or a procedure code, not both.</p><button class="primary" type="submit" ${!providers.length||!organizations.length?'disabled':''}>Check eligibility</button></form><div id="claimmd-eligibility-history">${claimmdEligibilityHistory(history.items,coverage)}</div></section>`);
 editorAnchor=editor?.firstElementChild;
 const form=$('claimmd-eligibility-form');if(form)claimmdEligibilityContexts.set(form,{patientId,identity,coverageId:coverage.id,coverage,directory,current});
}

function claimmdPayerRows(items,selectable=false){
 return `<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Payer</th><th>ID / type</th><th>Eligibility</th><th>Professional / institutional</th><th>ERA</th>${selectable?'<th></th>':''}</tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.payer_name||'Unnamed payer')}</b><small>${esc(item.payer_state||'')}</small></td><td>${esc(item.payerid||'—')}<small>${esc(item.payer_type||'')}</small></td><td>${esc(item.eligibility||'no')}</td><td>${esc(item['1500_claims']||'no')} / ${esc(item.ub_claims||'no')}</td><td>${esc(item.era||'no')}</td>${selectable?`<td><button type="button" data-claimmd-payer-select="${esc(item.payerid||'')}" data-payer-name="${esc(item.payer_name||'')}">Use payer</button></td>`:''}</tr>`).join('')||`<tr><td colspan="${selectable?6:5}">No matching payers returned.</td></tr>`}</tbody></table></div>`;
}

function claimmdCoveragePayerSearch(){return `<section class="billing-section"><h4>Find payer in Claim.MD</h4><form id="coverage-claimmd-payer-search" class="billing-filter"><label>Payer name<input name="name" minlength="2" maxlength="120" required></label><button type="submit">Search</button></form><div id="coverage-claimmd-payer-results"></div></section>`;}

document.addEventListener('click',event=>{
 const payer=event.target.closest('button[data-claimmd-payer-select]');
 if(payer){event.preventDefault();const native=(billingPayers||[]).find(item=>item.content.payer_code===payer.dataset.claimmdPayerSelect);if(native){const select=document.querySelector('#coverage-form select[name="payer_id"]');if(select){select.value=native.id;select.dispatchEvent(new Event('change',{bubbles:true}));}notice('Existing native payer selected.');return;}const form=document.querySelector('#coverage-payer-form');if(form){form.elements.name.value=payer.dataset.payerName;form.elements.payer_code.value=payer.dataset.claimmdPayerSelect;notice('Payer details copied. Review and add the payer to use it.');}return;}
 const target=event.target.closest('button');if(!target)return;
 const data=target.dataset||{},coverageFor=id=>{const coverage=workspace?.billing?.coverages?.find(item=>item.id===id);if(!coverage)throw new Error('This coverage is no longer available. Reload the chart.');return coverage;};
 const claim=()=>{event.preventDefault();event.stopImmediatePropagation();};
 if(data.claimmdEligibility){claim();try{const coverage=coverageFor(data.claimmdEligibility),ui=claimmdEligibilityUiFor(coverage.id);ui.answers=null;ui.needs=null;void claimmdEligibilityCheck(coverage);}catch(error){notice(error.message,true);}return;}
 if(data.eligibilityAdvanced){claim();run(()=>openClaimmdEligibilityForm(coverageFor(data.eligibilityAdvanced),{serviceDate:typeof revenueServiceDate==='function'?revenueServiceDate():undefined}));return;}
 if(data.eligibilityCopay){claim();run(async()=>{
  const coverage=coverageFor(data.eligibilityCopay),cents=Number(data.cents),patientId=selected,identity=me;
  if(!Number.isSafeInteger(cents)||cents<0)throw new Error('The insurer did not report a copay amount that can be saved.');
  await claimmdSaveCoverage(coverage,{copay_cents:cents},`From the insurer's eligibility response ${data.checkDate||new Date().toISOString().slice(0,10)}`);
  if(selected!==patientId||me!==identity)return;
  claimmdEligibilityUiFor(coverage.id).copaySaved=cents;claimmdEligibilityRepaint(coverage.id);notice(`Saved ${claimmdDollars(cents/100)} as this plan's copay.`);
 });return;}
 if(data.eligibilityEnroll){claim();run(async()=>{
  const coverage=coverageFor(data.coverage),patientId=selected,identity=me;
  const result=await api(`/api/v1/patients/${patientId}/coverages/${coverage.id}/claimmd-eligibility/enrollment`,'POST',{check_id:data.eligibilityEnroll});
  if(selected!==patientId||me!==identity)return;
  if(result.status==='started'&&/^https:\/\/(www\.)?claim\.md\//.test(String(result.external_url)))window.open(result.external_url,'_blank','noopener,noreferrer');
  claimmdEligibilityUiFor(coverage.id).enrollment={...result,check:data.eligibilityEnroll};claimmdEligibilityRepaint(coverage.id);
  if(result.status==='started')notice('Finish the setup in the Claim.MD tab that just opened.');
 });return;}
 if(data.eligibilitySupport){claim();run(async()=>{
  const coverage=coverageFor(data.coverage),ui=claimmdEligibilityUiFor(coverage.id);
  const history=typeof eligibilityState==='function'?eligibilityState().items.get(coverage.id)?.history?.items:null,check=[...(history||[]),...(claimmdEligibilityPanel?.items||[])].find(item=>item.id===data.eligibilitySupport);
  if(!check)throw new Error('This check is no longer on screen. Reload the chart and try again.');
  if(typeof supportDrafts!=='undefined'&&!supportDrafts.get('new'))supportDrafts.set('new',{...claimmdSupportDraft(check,coverage),request_id:crypto.randomUUID()});
  ui.supportOpened=true;await openSupportFromHere();
 });return;}
 if(target.hasAttribute?.('data-eligibility-connections')){claim();run(()=>showEdiWorkspace());return;}
 if(data.eligibilityPayer){claim();run(async()=>{await showBillingQueue('',undefined,true);const payer=billingPayers.find(item=>item.id===data.eligibilityPayer);if(!payer)throw new Error('This insurance company is no longer in the payer directory.');payerEditor(payer);});return;}
},true);

document.addEventListener('submit',event=>{
 const form=event.target;
 if(form.dataset?.eligibilityNeed){
  event.preventDefault();event.stopImmediatePropagation();
  run(async()=>{
   let coverage=workspace.billing.coverages.find(item=>item.id===form.dataset.coverage);if(!coverage)throw new Error('This coverage is no longer available. Reload the chart.');
   const values=Object.fromEntries(new FormData(form)),kind=form.dataset.eligibilityNeed,ui=claimmdEligibilityUiFor(coverage.id),patientId=selected,identity=me;
   if(kind==='billing_organization'||kind==='provider')ui.answers={...ui.answers,[kind+'_id']:values[kind+'_id']};
   else if(kind==='subscriber_birth_date')coverage=await claimmdSaveCoverage(coverage,{subscriber_birth_date:values.subscriber_birth_date},'Added the policy holder\'s date of birth to check eligibility');
   else if(kind==='subscriber_name')coverage=await claimmdSaveCoverage(coverage,{subscriber_name:`${values.given.trim()} ${values.family.trim()}`},'Corrected the policy holder\'s name to check eligibility');
   else return;
   if(selected!==patientId||me!==identity)return;
   ui.needs=null;void claimmdEligibilityCheck(coverage);
  });
  return;
 }
 if(!['claimmd-eligibility-form','claimmd-payer-search','coverage-claimmd-payer-search'].includes(form.id))return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  const data=Object.fromEntries(new FormData(form));
  if(form.id==='claimmd-payer-search'||form.id==='coverage-claimmd-payer-search'){
   const payerid=(data.payerid||'').trim(),name=(data.name||'').trim();
   const query=new URLSearchParams();if(payerid)query.set('payerid',payerid);if(name)query.set('name',name);
   const result=await api(`/api/v1/billing/claimmd/payers?${query}`);$(form.id==='claimmd-payer-search'?'claimmd-payer-results':'coverage-claimmd-payer-results').innerHTML=claimmdPayerRows(result.items,form.id==='coverage-claimmd-payer-search');notice('Claim.MD payer directory refreshed.');return;
  }
  const context=claimmdEligibilityContexts.get(form);
  if(!context||!context.current()||$('claimmd-eligibility-form')!==form)throw new Error('The chart changed while this form was open. Close it and open it again.');
  const provider=context.directory.providers.find(row=>row.id===data.provider_id),organization=context.directory.billing_organizations.find(row=>row.id===data.billing_organization_id);
  if(!provider||!organization)throw new Error('Choose a provider and a billing organization.');
  const serviceCodes=data.service_codes.split(',').map(value=>value.trim()).filter(Boolean);
  const body={request_id:form.dataset.request,service_date:data.service_date,service_codes:serviceCodes,procedure_code:data.procedure_code.trim()||null,insured_given_name:data.insured_given_name.trim(),insured_middle_name:data.insured_middle_name.trim()||null,insured_family_name:data.insured_family_name.trim(),insured_birth_date:data.insured_birth_date||null,insured_sex:data.insured_sex||null,patient_sex:data.patient_sex||null,provider_id:provider.id,provider_version:provider.version,billing_organization_id:organization.id,billing_organization_version:organization.version,provider_name:data.provider_name?.trim()||null,provider_taxonomy:data.provider_taxonomy.trim()||null};
  const {patientId,identity,coverageId}=context;
  let result,requestError;try{result=await api(`/api/v1/patients/${patientId}/coverages/${coverageId}/claimmd-eligibility`,'POST',body);}catch(error){requestError=error;}
  const history=await api(`/api/v1/patients/${patientId}/coverages/${coverageId}/claimmd-eligibility`);
  if(selected!==patientId||me!==identity||!context.current())return;
  if(typeof updateInsuranceEligibility==='function')updateInsuranceEligibility(coverageId,history);
  if($('claimmd-eligibility-form')!==form)return;
  $('claimmd-eligibility-history').innerHTML=claimmdEligibilityHistory(history.items,context.coverage);if(result||history.items?.some(check=>check.request_snapshot?.request?.request_id===body.request_id&&['failed','completed'].includes(check.status)))form.dataset.request=crypto.randomUUID();if(requestError)throw requestError;notice('The insurer answered. The result is below.');
 });
},true);
