// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const claimActionLabels={ready:'Release it to send later',void_draft:'Void this claim',record_submission:'It was sent outside SunCharts',record_acceptance:'The payer accepted it',record_rejection:'The payer rejected it'};
const eraStatusLabels={staged:'To review',reconciled:'Matched, ready to post',posted:'Posted',reversed:'Posting undone',rejected:'Rejected'};
function eraStatusLabel(status){return Object.hasOwn(eraStatusLabels,status)?eraStatusLabels[status]:'Status unavailable';}
function eraCurrentBalance(value){return Number.isSafeInteger(value)?value<0?`${money(-value)} patient credit`:`${money(value)} open`:'Unavailable';}
var claimRows=[],eraRows=[],claimCurrent,eraCurrent,claimAccount,claimSource,eraSource,eraNext,claimStatusFilter='action';
let claimStatusFilterIdentity,claimMonitorEraPages=1;
const claimsBase='/api/v1/billing/claims',eraBase='/api/v1/billing/remittances';
const coverageNeedsActionBase='/api/v1/billing/coverage-needs-action';
const claimMonitorStages={action:'Needs action',send:'To send',wait:'In flight',history:'History'};
const claimLegacyViews={fix:'Needs correction','remittance-review':'Remittance to review',posted:'Posted',payments:'All remittances'};
const claimRecordFilters=['draft','ready','submitted','accepted','rejected','adjudicated','void'];
const claimMonitorSelectedRecords=['all',...claimRecordFilters,...Object.keys(claimLegacyViews)];
const claimActionGroups=['fix','delivery','payment','resubmit'];

function claimWorklistLineages(rows){
 const byId=new Map(rows.map(row=>[row.id,row])),links=new Map(),roots=new Map(),families=new Map();
 for(const row of rows){
  const prior=byId.get(row.copied_from_claim_id||row.parent_id);
  if(prior&&prior.id!==row.id&&prior.patient_id===row.patient_id&&prior.account_id===row.account_id&&
     row.coordination_primary_claim_id!==prior.id&&
     (!row.coverage_priority||!prior.coverage_priority||row.coverage_priority===prior.coverage_priority))links.set(row.id,prior);
 }
 for(const row of rows){
  let root=row.id;
  const visited=new Set();
  while(links.has(root)&&!roots.has(root)&&!visited.has(root)){
   visited.add(root);
   root=links.get(root).id;
  }
  // A broken or cyclic link must not hide a claim from the worklist.
  if(visited.has(root))root=row.id;
  else{
   root=roots.get(root)||root;
   for(const id of visited)roots.set(id,root);
  }
  if(!families.has(root))families.set(root,[]);
  families.get(root).push(row);
 }
 const lookup=new Map();
 for(const family of families.values()){
  const attempts=family.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))||String(b.id).localeCompare(String(a.id)));
  const ids=new Set(attempts.map(row=>row.id)),replaced=new Set();
  const open=attempts.filter(row=>row.status!=='void');
  const considered=open.length?open:attempts;
  for(const row of considered){
   let prior=links.get(row.id);
   while(open.length&&prior&&ids.has(prior.id)&&prior.status==='void')prior=links.get(prior.id);
   if(prior&&ids.has(prior.id))replaced.add(prior.id);
  }
  const current=considered.filter(row=>!replaced.has(row.id));
  // Prefer a delivered or unresolved attempt over an unsent sibling draft.
  const active=current.find(row=>['submitted','accepted','adjudicated'].includes(row.status)||
   ['queued','waiting','delivered','recorded_externally'].includes(row.claim_handoff?.outcome)||row.claim_handoff?.delivery_status==='unknown')||current[0]||attempts[0];
  for(const row of attempts)lookup.set(row.id,{active,attempts});
 }
 return lookup;
}
let lastWorklistRows,claimWorklistLookup;
function claimWorklistFamily(claim){
 if(lastWorklistRows!==claimRows){lastWorklistRows=claimRows;claimWorklistLookup=claimWorklistLineages(claimRows);}
 return claimWorklistLookup.get(claim?.id);
}
function claimWorklistAttempts(claim){return claimWorklistFamily(claim)?.attempts.filter(row=>row.id!==claim.id)||[];}
function claimWorklistActive(claim){return claimWorklistFamily(claim)?.active||null;}
function claimWorklistSuperseded(claim){const active=claimWorklistActive(claim);return Boolean(active&&active.id!==claim.id);}

function claimCanceledRecovery(claim,recovery=claim?.canceled_claim_recovery){
 if(claim?.status!=='void'||!recovery?.encounter_id||!recovery.account_id||recovery.claim_id!==claim.id||
  recovery.account_id!==claim.account_id||recovery.encounter_id!==(claim.visit_id||claim.snapshot?.account?.content?.visit_id)||
  recovery.version!==claim.version||!Number.isSafeInteger(recovery.version)||recovery.version<1||
  !Number.isSafeInteger(recovery.account_version)||recovery.account_version<1)return null;
 if(typeof billingCan==='function'?!billingCan('create'):typeof billingWrite==='function'&&!billingWrite())return null;
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims','create'))return null;
 return recovery;
}
function claimWorkGroup(c){
 if(c.status==='void')return claimCanceledRecovery(c)?'resubmit':'';
 if(c.worklist_remittance?.id)return 'payment';
 if(claimIsCrossover(c))return '';
 if(c.status==='rejected'||c.payer_denied===true||claimMdNeedsCorrection(c,c))return 'fix';
 const handoff=c.claim_handoff;
 if(handoff?.delivery_status==='unknown')return 'delivery';
 if(['draft','ready'].includes(c.status)){
  if(handoff?.outcome==='blocked')return 'fix';
  if(['queued','waiting','delivered','recorded_externally'].includes(handoff?.outcome))return 'wait';
  return c.worklist_issue?'fix':'send';
 }
 if(['submitted','accepted'].includes(c.status))return 'wait';
 return '';
}
function claimMatchesStatusFilter(c,filter=claimStatusFilter){
 const group=claimWorkGroup(c);
 const superseded=claimWorklistSuperseded(c);
 if(filter==='history')return superseded||!group;
 if(claimRecordFilters.includes(filter))return c.status===filter;
 return !superseded&&(filter==='all'||group===filter||filter==='action'&&claimActionGroups.includes(group));
}
function eraWorkGroup(r){return ['staged','reconciled'].includes(r.status)?'remittance-review':r.status==='posted'?'posted':'';}
function claimMonitorShowsRemittances(){return ['remittance-review','posted','payments'].includes(claimStatusFilter);}
function claimStatusCount(status){
 if(['remittance-review','posted'].includes(status))return eraRows.filter(r=>eraWorkGroup(r)===status).length;
 const coverageCount=status==='action'?claimCoverageMatches(claimViewContext?.coverageQueue).length:0;
 return claimRows.filter(c=>claimMatchesStatusFilter(c,status)&&claimWorklistMatch(c)).length+coverageCount;
}
function claimStatusChipsHtml(){
 return `<nav class="practice-status-strip claims-status-strip" aria-label="Claim queues">${Object.entries(claimMonitorStages).map(([status,label])=>`<button type="button" data-claim-status="${status}" aria-pressed="false">${label} <span></span></button>`).join('')}<select id="billing-all-claims" aria-label="Other billing views"><option value="" disabled>Other views</option><option value="all">All active claims</option><optgroup label="Claim status">${claimRecordFilters.map(status=>`<option value="${status}">${esc(displayStatus(status))}</option>`).join('')}</optgroup><optgroup label="Billing views">${Object.entries(claimLegacyViews).map(([status,label])=>`<option value="${status}">${label}</option>`).join('')}</optgroup></select></nav>`;
}
function claimWorklistEvidence(c,group){
 if(group==='payment')return c.worklist_remittance.at;
 if(group==='fix'&&claimMdNeedsCorrection(c,c))return c.claimmd_position?.correction?.at;
 if(group==='wait'&&c.status!=='accepted'){
  return claimMdOnlyAcknowledged(c,c)?c.claimmd_position?.received_at:c.claim_handoff?.attempt_at;
 }
 if(group==='delivery')return c.claim_handoff?.attempt_at;
 return null;
}
function claimWorklistTime(c,group=claimWorkGroup(c)){
 // The date of service still appears with the encounter. Only status evidence or
 // creation is used to describe how long the current work has been waiting.
 const evidence=claimWorklistEvidence(c,group);
 return [evidence,c.status_at,c.created_at].find(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
}
function claimWorklistAge(c,group,now){
 if(!group)return '—';
 const since=claimWorklistTime(c,group);
 if(!since)return '—';
 const minutes=Math.max(0,Math.floor((now-Date.parse(since))/60000));
 const elapsed=minutes<1?'Just now':minutes<60?`${minutes} min`:minutes<1440?`${Math.floor(minutes/60)} hr`:`${Math.floor(minutes/1440)} ${minutes<2880?'day':'days'}`;
 const source=since===c.created_at&&since!==claimWorklistEvidence(c,group)?'Claim created':'Status recorded';
 return `<time datetime="${esc(since)}" title="${source} ${esc(typeof displayDateTime==='function'?displayDateTime(since):since)}">${elapsed}</time>`;
}
function claimWorklistAction(c,group){
 const readOnly=typeof billingWrite==='function'&&!billingWrite();
 const action=(label,reason,intent=null)=>({label:readOnly?'View claim':label,reason,intent:readOnly?null:intent});
 if(claimWorklistSuperseded(c))return {label:'View history',reason:c.status==='void'?'Claim canceled':'Earlier attempt',intent:{kind:'history'}};
 if(group==='resubmit')return {label:'Resubmit claim',reason:'Canceled before sending',recovery:claimCanceledRecovery(c)};
 if(group==='payment')return {label:'Review payment',reason:'Insurer response needs review',remittance:c.worklist_remittance};
 if(group==='fix'&&claimMdNeedsCorrection(c,c)){
  const correction=c.claimmd_position?.correction,line=correction?.line;
  if(typeof line?.code==='string'&&/^[a-z0-9]{5}$/i.test(line.code)&&Number.isInteger(line.index)&&line.index>=0){
   const fix=/\bmodifier\b/i.test(correction.message||'')?'Fix modifier':'Fix';
   return action(`${fix} ${line.code}`,`Held by Claim.MD · ${line.code}`,{kind:'correction',procedure:line.code,line:line.index});
  }
  return action('Review clearinghouse hold','Held by Claim.MD');
 }
 if(c.payer_denied===true)return action('Review denial','Denied by insurer');
 if(c.status==='rejected')return action('Review return','Claim returned');
 if(group==='delivery')return action('Check delivery','Delivery unconfirmed',{kind:'delivery'});
 if(group==='fix'&&c.worklist_issue){
  const issue=c.worklist_issue;
  if(issue.field==='subscriber_address'&&issue.part==='postal_code'){
   return action('Add ZIP code','Policyholder ZIP code is missing',{kind:'missing',field:issue.field,part:issue.part});
  }
  const input=[...claimMissingFocusFields(claimMissingGroupsFor([issue]))][0];
  return action('Fix claim details',claimMissingPlain(claimMissingIssueText(issue)),input?{kind:'missing',field:input}:null);
 }
 if(group==='fix')return action('Review delivery','Delivery needs review');
 if(group==='send')return action('Review & send',c.status==='ready'?'Ready for review':'Claim draft prepared',{kind:'send'});
 if(group==='wait'){
  let status=claimStatusLabel(c);
  if(claimMdOnlyAcknowledged(c,c))status='Claim.MD received';
  else if(c.status!=='accepted'&&c.claim_handoff?.outcome==='queued')status='Sending to clearinghouse';
  return action('View activity',status);
 }
 if(c.status==='void')return action('Review cancellation','Claim canceled');
 return action('Open claim',claimStatusLabel(c)||'Claim status unavailable');
}
function claimCanceledRecoveryButton(claim,recovery,primary=false){
 return `<button type="button"${primary?' class="primary"':''} data-claim-open="${esc(claim.id)}" data-claim-visit data-claim-intent="resubmit" data-canceled-claim-version="${recovery.version}" data-canceled-account-version="${recovery.account_version}">Resubmit claim</button>`;
}
function claimWorklistButton(c,next){
 if(next.remittance){
  const row=next.remittance.row_index;
  const target=Number.isInteger(row)&&row>=0?` data-era-row="${row}" data-era-claim="${esc(c.id)}"`:'';
  return `<button type="button" data-era-open="${esc(next.remittance.id)}"${target}>${esc(next.label)}</button>`;
 }
 if(next.recovery)return claimCanceledRecoveryButton(c,next.recovery);
 const attributes=next.intent?` data-claim-intent="${next.intent.kind}"${next.intent.procedure?` data-claim-procedure="${esc(next.intent.procedure)}" data-claim-line="${next.intent.line}"`:''}${next.intent.field?` data-claim-field="${esc(next.intent.field)}"`:''}${next.intent.part?` data-claim-part="${esc(next.intent.part)}"`:''}`:'';
 return `<button type="button" data-claim-open="${esc(c.id)}"${c.status==='void'||next.intent?.kind==='history'?'':' data-claim-visit'}${attributes}>${esc(next.label)}</button>`;
}
function claimWorklistResponseReason(c,group){
 if(group!=='fix')return '';
 const summarize=typeof claimProblemWorklistReason==='function'?claimProblemWorklistReason:()=>'';
 if(claimMdNeedsCorrection(c,c))return summarize(c.claimmd_position.correction?.message);
 if(c.payer_denied===true){
  const codes=Array.isArray(c.worklist_denial_codes)?c.worklist_denial_codes.filter(code=>typeof code==='string'&&/^(CO|OA|PI)-[A-Z0-9]{1,5}$/.test(code)).slice(0,3):[];
  return codes.length?`Remittance ${codes.length===1?'adjustment':'adjustments'} ${codes.join(', ')}`:'';
 }
 return c.status==='rejected'?summarize(c.worklist_return_reason)||'No return reason recorded':'';
}
function claimRowMarkup(c,now=Date.now()){
 const group=claimWorklistSuperseded(c)?'':claimWorkGroup(c),posted=c.status==='adjudicated'&&c.remittance_posted===true&&c.paid_cents>0&&!c.payer_denied;
 const tone=posted?'paid':group==='resubmit'?'send':group||'other',next=claimWorklistAction(c,group);
 const encounter=c.visit_id&&typeof encounterRowChip==='function'?encounterRowChip(c):'';
 const summary=[c.payer_name&&esc(c.payer_name),c.service_date&&esc(displayDate(c.service_date))].filter(Boolean).join(' · ');
 const amount=Number.isSafeInteger(c.total_cents)?money(c.total_cents):'—';
 const response=claimWorklistResponseReason(c,claimWorkGroup(c));
 const waiting=group==='wait'&&claimMdOnlyAcknowledged(c,c)&&c.payer_name?`Waiting for ${c.payer_name}`:'';
 const testClaim=c.synthetic_test===true?' <span class="pill claim-test-label">Test claim</span>':'';
 return `<tr role="row" data-claim-list-id="${esc(c.id)}"><td role="cell" class="monitor-record"><b>${esc(c.patient_name)}</b><small class="claim-control">${encounter?`${encounter} · `:''}Claim ${esc(c.control_number||'Not assigned')}${c.frequency&&c.frequency!=='original'?` · ${esc(displayStatus(c.frequency))}`:''}${testClaim}</small>${summary?`<small>${summary}</small>`:''}</td><td role="cell" class="monitor-amount">${esc(amount)}</td><td role="cell" class="monitor-status"><span class="pill claim-status-${tone}">${esc(posted?'Payment posted':next.reason)}</span>${response?`<p class="claim-worklist-response" data-claim-response-reason>${esc(response)}</p>`:''}${waiting?`<small>${esc(waiting)}</small>`:''}</td><td role="cell" class="monitor-age">${claimWorklistAge(c,group,now)}</td><td role="cell" class="monitor-action">${claimWorklistButton(c,next)}</td></tr>`;
}
const claimWorklistSorts={waiting:['Longest waiting',c=>Date.parse(claimWorklistTime(c)||c.service_date||''),1],service_desc:['Newest service date',c=>c.service_date,-1],service_asc:['Oldest service date',c=>c.service_date,1],amount_desc:['Highest amount',c=>c.total_cents,-1],amount_asc:['Lowest amount',c=>c.total_cents,1]};
const claimWorklistFilterFields=['search','payer','service_from','service_through','amount_min','amount_max'];
const claimWorklistDefaultFilters={search:'',payer:'',service_from:'',service_through:'',amount_min:'',amount_max:'',sort:'waiting'};
let claimWorklistFilters={...claimWorklistDefaultFilters};
function claimWorklistMatch(c,filters=claimWorklistFilters){
 if((filters.payer&&c.payer_id!==filters.payer)||
    (filters.service_from&&(!c.service_date||c.service_date<filters.service_from))||
    (filters.service_through&&(!c.service_date||c.service_date>filters.service_through))||
    (filters.amount_min&&(!Number.isSafeInteger(c.total_cents)||c.total_cents<Math.round(Number(filters.amount_min)*100)))||
    (filters.amount_max&&(!Number.isSafeInteger(c.total_cents)||c.total_cents>Math.round(Number(filters.amount_max)*100))))return false;
 if(!filters.search.trim())return true;
 const normalize=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const encounter=typeof encounterNumberLabel==='function'?encounterNumberLabel(c.encounter_number):'';
 const priorControls=claimWorklistSuperseded(c)?[]:claimWorklistAttempts(c).map(row=>row.control_number);
 const searchable=normalize([c.patient_name,c.control_number,c.encounter_number,encounter,...priorControls].filter(Boolean).join(' '));
 const search=normalize(filters.search),compact=searchable.replaceAll(' ','');
 return search.split(' ').filter(Boolean).every(term=>searchable.includes(term)||compact.includes(term));
}
function claimRowsMarkup(claims,now=Date.now(),sort=claimWorklistFilters.sort){
 const [,order,direction]=claimWorklistSorts[sort]||claimWorklistSorts.waiting;
 const missing=value=>value==null||value===''||Number.isNaN(value);
 return claims.map(claim=>({claim,at:order(claim)}))
  .sort((a,b)=>{
   if(a.at===b.at)return 0;
   if(missing(a.at))return missing(b.at)?0:1;
   if(missing(b.at))return -1;
   return (typeof a.at==='number'?a.at-b.at:a.at.localeCompare(b.at))*direction;
  })
  .map(({claim})=>claimRowMarkup(claim,now)).join('');
}
function claimEmptyRow(){return `<tr><td colspan="5" class="table-empty">${claimWorklistFilterFields.some(field=>claimWorklistFilters[field])?'No claims match these filters.':({action:'No claims need staff action.',send:'No claims to send.',fix:'No claims need correction.',wait:'No claims in flight.',history:'No claim history.'})[claimStatusFilter]||'No claims.'}</td></tr>`;}
function coverageWorklistAction(row,queue){
 const payer=row.choices?.length===1?row.choices[0].payer_id:null;
 if(['inactive_payer','payer_id'].includes(row.blocker_code)&&me?.role==='owner')return {label:payer?'Edit payer':'Open payer directory',kind:'payer',payer};
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('clinical'))return null;
 if(!row.visit_id)return {label:'Review charges',kind:'account'};
 if(!row.blocked_reason){
  if(row.state==='apply_coverage'&&queue.can_apply_coverage&&queue.can_prepare_claim)return {label:'Apply insurance',kind:row.state};
  if(row.state==='prepare_claim'&&queue.can_prepare_claim)return {label:'Prepare claim',kind:row.state};
 }
 if(row.blocker_code==='sign_encounter')return {label:'Open visit note',kind:'note'};
 if(row.blocker_code==='existing_claim')return {label:'Review claim',kind:'claim'};
 if(row.blocker_code==='pending_payment')return {label:'Review payments',kind:'payments'};
 if(['review_ledger','invoice_or_plan','snapshot_payer_id'].includes(row.blocker_code))return {label:'Review charges',kind:'account'};
 return {label:'Review encounter',kind:'encounter'};
}
function coverageWorklistStatus(queue){
 if(queue.loading)return 'Checking posted charges…';
 if(queue.failed)return 'Could not check for insurance added after posting. <button type="button" data-refresh-coverage-worklist>Retry</button>';
 return queue.items.length?'':'No posted charges need this review.';
}
function claimCoverageMatches(queue){
 return (queue?.items||[]).filter(row=>(!claimWorklistFilters.payer||row.choices?.some(choice=>(choice.payer_id||choice.id)===claimWorklistFilters.payer))&&claimWorklistMatch(row,{...claimWorklistFilters,payer:''}));
}
function coverageWorklistRows(queue,rows=queue.items){
 const amount=value=>Number.isSafeInteger(value)?money(value):'Unavailable';
 return rows.map(row=>{
  const action=coverageWorklistAction(row,queue),count=row.choices?.length||0;
  const coverage=count===1?row.choices[0].payer_name:count>1?`${count} policies on file`:'';
  const status=row.blocked_reason||(row.state==='prepare_claim'?'Insurance applied. Claim pending.':'Posted as self-pay.');
  const visit=typeof encounterNumberLabel==='function'?encounterNumberLabel(row.encounter_number):'';
  const context=[visit,row.service_date&&displayDate(row.service_date)].filter(Boolean).join(' · ');
  const next=action?`<button type="button" data-coverage-worklist-account="${esc(row.account_id)}">${esc(action.label)}</button>`:'Ask billing staff';
  return `<tr role="row">
   <td role="cell" class="monitor-record"><b>${esc(row.patient_name)}</b><small>${esc(context)}</small></td>
   <td role="cell">${coverage?`<b>${esc(coverage)}</b>`:''}<small>${esc(status)}</small></td>
   <td role="cell"><dl class="coverage-worklist-amounts">
    <div><dt>Posted charges</dt><dd>${amount(row.total_cents)}</dd></div>
    <div><dt>Patient paid</dt><dd>${amount(row.patient_paid_cents)}</dd></div>
    <div><dt>Patient owes now</dt><dd>${amount(row.patient_owes_now_cents)}</dd></div>
   </dl></td>
   <td role="cell" class="monitor-action">${next}</td>
  </tr>`;
 }).join('');
}
function paintClaimWorklistRows(host,markup){
 if(host.claimWorklistMarkup===markup)return;
 const focused=document.activeElement?.closest?.('[data-claim-open],[data-era-open]');
 const selector=focused&&host.contains(focused)?(focused.dataset.claimOpen?'data-claim-open':'data-era-open'):null;
 const selected=selector&&focused.getAttribute(selector);
 host.innerHTML=markup;
 host.claimWorklistMarkup=markup;
 if(selected)Array.from(host.querySelectorAll(`[${selector}]`)).find(button=>button.getAttribute(selector)===selected)?.focus({preventScroll:true});
}
function syncClaimWorklistFilters(host){
 const filters=host.querySelector('[data-claim-worklist-filters]');
 if(!filters||filters.hidden)return;
 const payer=filters.querySelector('[data-claim-filter="payer"]'),labels=new Map();
 for(const p of billingPayers||[])if(p.id&&p.content?.name)labels.set(p.id,p.content.name);
 for(const c of claimRows)if(c.payer_id&&c.payer_name&&!labels.has(c.payer_id))labels.set(c.payer_id,c.payer_name);
 if(claimWorklistFilters.payer&&!labels.has(claimWorklistFilters.payer))labels.set(claimWorklistFilters.payer,'Previously selected payer');
 const choices='<option value="">All payers</option>'+[...labels].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join('');
 if(payer.claimOptions!==choices){payer.innerHTML=choices;payer.claimOptions=choices;}
 for(const field of filters.querySelectorAll('[data-claim-filter]')){
  const value=claimWorklistFilters[field.dataset.claimFilter];
  if(field.value!==value)field.value=value;
 }
 filters.querySelector('[data-clear-claim-filters]').hidden=!claimWorklistFilterFields.some(field=>claimWorklistFilters[field]);
}
function claimWorkspaceMarkup(){
 const host=$('claims-tool');if(!host)return;
 const payments=claimMonitorShowsRemittances(),claimList=host.querySelector('[data-claim-worklist]'),eraList=host.querySelector('[data-era-worklist]');
 if(!claimList||!eraList)return;
 claimList.hidden=payments;
 const filterBar=host.querySelector('[data-claim-worklist-filters]');
 if(filterBar)filterBar.hidden=payments;
 syncClaimWorklistFilters(host);
 eraList.hidden=!payments;
 if(payments)paintClaimWorklistRows(eraList.querySelector('tbody'),eraRowsMarkup());
 else paintClaimWorklistRows(claimList.querySelector('tbody'),claimRowsMarkup(claimRows.filter(c=>claimMatchesStatusFilter(c)&&claimWorklistMatch(c)))||claimEmptyRow());
 const actionView=claimStatusFilter==='action';
 const coverage=host.querySelector('[data-coverage-worklist]'),coverageQueue=claimViewContext?.coverageQueue;
 if(coverage){
  const matches=claimCoverageMatches(coverageQueue);
  coverage.hidden=!actionView||!coverageQueue||!(coverageQueue.loading||coverageQueue.failed||matches.length);
  if(!coverage.hidden){
   const status=coverage.querySelector('[data-coverage-worklist-status]'),table=coverage.querySelector('.billing-table-wrap');
   const statusMarkup=coverageWorklistStatus(coverageQueue);
   status.hidden=!statusMarkup;
   table.hidden=Boolean(statusMarkup);
   const target=statusMarkup?status:table.querySelector('tbody');
   const markup=statusMarkup||coverageWorklistRows(coverageQueue,matches);
   if(target.coverageMarkup!==markup){target.innerHTML=markup;target.coverageMarkup=markup;}
  }
 }
 const heading=claimList.querySelector('[data-claim-list-heading]');
 heading.textContent=actionView?'Claims needing action':claimMonitorStages[claimStatusFilter]||claimLegacyViews[claimStatusFilter]||'Claims';
 for(const button of host.querySelectorAll('.claims-status-strip [data-claim-status]')){
  const status=button.dataset.claimStatus;
  button.setAttribute('aria-pressed',String(claimStatusFilter===status));
  button.querySelector('span').textContent=claimStatusCount(status);
 }
 $('billing-all-claims').value=claimMonitorSelectedRecords.includes(claimStatusFilter)?claimStatusFilter:'';
 host.querySelector('[data-era-more]').hidden=!eraNext;
 host.querySelector('[data-era-next]').disabled=Boolean(claimViewContext?.loadingEraPage);
}
function setClaimMonitorFilter(status){
 claimStatusFilter=Object.hasOwn(claimMonitorStages,status)||claimMonitorSelectedRecords.includes(status)?status:'all';
}
function selectClaimStatusFilter(status){
 if(!claimContextCurrent(claimViewContext)||claimViewContext.kind!=='worklist')return;
 setClaimMonitorFilter(status);
 claimWorkspaceMarkup();
 if(typeof frameBillingMonitorNavigation==='function')frameBillingMonitorNavigation();
}
function setClaimWorklistRefinement(field){
 if(field?.dataset?.claimFilter&&claimContextCurrent(claimViewContext)&&claimViewContext.kind==='worklist'){
  const key=field.dataset.claimFilter;
  if(!Object.hasOwn(claimWorklistDefaultFilters,key)||field.validity?.valid===false)return;
  claimWorklistFilters[key]=field.value;
  claimWorkspaceMarkup();
 }
}
document.addEventListener('change',e=>{if(e.target.id==='billing-all-claims')selectClaimStatusFilter(e.target.value);else if(e.target.dataset?.claimFilter!=='search')setClaimWorklistRefinement(e.target);});
document.addEventListener('input',e=>{if(e.target.dataset?.claimFilter==='search')setClaimWorklistRefinement(e.target);});
document.addEventListener('click',e=>{if(e.target.closest?.('[data-clear-claim-filters]')&&claimContextCurrent(claimViewContext)&&claimViewContext.kind==='worklist'){
 claimWorklistFilters={...claimWorklistDefaultFilters,sort:claimWorklistFilters.sort};
 claimWorkspaceMarkup();
 $('claims-tool')?.querySelector('[data-claim-filter="search"]')?.focus();
}});
function billingClaimShortcuts(){
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims'))return '';
 if(typeof workspaceModuleAllowed==='function'&&!workspaceModuleAllowed('claims'))return '';
 return '<p class="muted"><button type="button" class="text-button" data-billing-claim-queue="send">Claims to send</button> · <button type="button" class="text-button" data-billing-claim-queue="fix">Needs fixing</button></p>';
}
function billingPageMore(){return `<div class="actions"><button type="button" data-billing-connect>Claim connections</button><button type="button" data-billing-tools>Practice billing tools</button>${me.role==='owner'?'<button type="button" data-payment-settings>Practice payment settings</button>':''}</div>`;}
document.addEventListener('click',e=>{const queue=e.target.closest?.('[data-billing-claim-queue]');if(queue){run(async()=>{await showClaimsWorkspace({filter:queue.dataset.billingClaimQueue});});return;}if(e.target.closest?.('[data-billing-connect]'))run(()=>showEdiWorkspace());if(e.target.closest?.('[data-billing-tools]'))run(()=>showBillingQueue('',undefined,true));});
function claimFinalStatus(claim,detail={}){return ['void','rejected'].includes(claim?.status)||detail?.tracking?.remittance_posted===true;}
let claimViewContext=null;
let claimDraftIdentity;
const claimDrafts=new Map();
function clearClaimDrafts(){claimDrafts.clear();claimDraftIdentity=typeof me==='undefined'?undefined:me;}
function claimDraftSession(){if(claimDraftIdentity!==(typeof me==='undefined'?undefined:me))clearClaimDrafts();}
function claimDraftKey(account,record,parent,kind='packet'){return `${kind}:${account.patient_id}:${account.id}:${record?.id||'new'}:${parent?.id||''}`;}
function captureClaimDraft(form=$('claim-editor-form')||$('claimmd-submit-form')||$('claim-quick-fix')){
 claimDraftSession();if(!form?.claimDraftKey||!form.claimViewContext||!claimContextCurrent(form.claimViewContext))return;
 const values=Object.fromEntries(new FormData(form));
 if(JSON.stringify(values)===form.claimBaseline)claimDrafts.delete(form.claimDraftKey);
 else claimDrafts.set(form.claimDraftKey,{values,version:form.claimDraftVersion,request:form.dataset.request});
}
function restoreClaimDraft(form,account,record,parent,kind='packet',version){
 claimDraftSession();if(!form)return;form.claimDraftKey=claimDraftKey(account,record,parent,kind);form.claimDraftVersion=version??record?.version??account.version;form.claimBaseline=JSON.stringify(Object.fromEntries(new FormData(form)));
 const draft=claimDrafts.get(form.claimDraftKey);if(!draft)return;
 const baseline=form.claimBaseline?JSON.parse(form.claimBaseline):{};let restored=false;
 for(const field of Array.from(form.elements||[])){if(!field.name)continue;if(field.type==='checkbox'){const checked=draft.values[field.name]==='on';field.checked=checked;if(checked)restored=true;}else if(field.name in draft.values){const saved=draft.values[field.name];if(saved===''&&baseline[field.name]!==undefined&&baseline[field.name]!=='')continue;if(field.value!==saved)restored=true;field.value=saved;}}
 form.dataset.request=draft.request;const stale=draft.version!==form.claimDraftVersion;form.claimDraftStale=stale;
 if(!restored){claimDrafts.delete(form.claimDraftKey);return;}
 if(stale)form.querySelectorAll?.('button[type="submit"]').forEach(submit=>submit.disabled=true);
 form.insertAdjacentHTML?.('afterbegin',`<section data-claim-draft-notice role="status"><p>${stale?'Saved claim or charge data changed while you were editing. Check the current claim before keeping your edits.':'Your unsaved edits were restored.'}</p>${stale?'<button type="button" data-rebase-claim-draft>Keep my edits</button>':''}<button type="button" data-discard-claim-draft>Discard my edits</button></section>`);
}
document.addEventListener('input',event=>{const form=event.target.closest?.('#claim-editor-form,#claimmd-submit-form');if(form)captureClaimDraft(form);});
document.addEventListener('change',event=>{const form=event.target.closest?.('#claim-editor-form,#claimmd-submit-form');if(form)captureClaimDraft(form);});
function claimWorkspaceHost(context=claimViewContext){return context?.kind==='encounter'?(context.reviewSheet?context.host:$('encounter-claims-detail')):context?.drawerHost||$('claims-detail');}
function claimContextSnapshot(){
 if(!claimViewContext)claimViewContext={kind:'worklist',identity:typeof me==='undefined'?undefined:me,host:$('claims-detail')};
 return claimViewContext;
}
function encounterClaimRoute(){const context=claimViewContext;return context?.kind==='encounter'&&claimContextCurrent(context)?{account:context.account,claim:context.claim||null}:null;}
function claimContextCurrent(context){
 if(!context||context!==claimViewContext||context.identity!==(typeof me==='undefined'?undefined:me))return false;
 if(context.kind!=='encounter')return (!context.host||context.host===$('claims-detail'))&&
  (!context.drawer||context.drawer.open&&context.drawer.isConnected&&!context.drawer.dataset.closing);
 const mounted=context.reviewSheet?context.reviewSheet.open&&context.host.isConnected&&
  !context.reviewSheet.dataset.closing&&context.reviewSheet.contains(context.host):context.host===$('encounter-claims-detail');
 return selected===context.patient&&activeVisit?.id===context.visit&&chartSection==='visits'&&encounterShows('charges')&&mounted&&(workspace.billing?.accounts||[]).some(a=>a.id===context.account&&a.content.visit_id===context.visit);
}
function requireClaimContext(context,claim){
 if(!claimContextCurrent(context))throw new Error('This page changed. Open the claim again from its visit.');
 if(context.kind==='encounter'&&claim&&(claim.patient_id!==context.patient||claim.account_id!==context.account))throw new Error('This claim does not belong to the selected visit.');
}
function mountEncounterClaims(accountId,{inPlace=false,reviewHost=null}={}){
 captureClaimDraft();
 const account=(workspace.billing?.accounts||[]).find(a=>a.id===accountId&&a.content.visit_id===activeVisit?.id);
 if(!account||!selected||!activeVisit)throw new Error('Open the encounter for these charges first.');
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims'))throw new Error('Claim review requires access to insurance claims.');
 if(reviewHost){
  const reviewSheet=reviewHost.closest('dialog[data-signed-claim-details][open]');
  if(!reviewHost.isConnected||!reviewSheet||reviewSheet.dataset.closing)throw new Error('Reopen claim review before continuing.');
  claimViewContext={kind:'encounter',identity:me,patient:selected,visit:activeVisit.id,account:accountId,host:reviewHost,reviewSheet,savedActivityOnly:true};
  return claimViewContext;
 }
 if(!inPlace)setEncounterSection('charges');
 const container=$('encounter-claims');if(!container)throw new Error('Open Billing & claim in this encounter.');
 container.innerHTML='<div id="encounter-claims-detail"></div>';container.hidden=false;
 if(!inPlace&&typeof invoiceTabSet==='function')invoiceTabSet('billing');
 const actions=container.closest?.('[data-step-claim-actions]');
 if(actions)actions.open=true;
 claimViewContext={kind:'encounter',identity:me,patient:selected,visit:activeVisit.id,account:accountId,host:$('encounter-claims-detail')};
 return claimViewContext;
}
async function showEncounterClaim(id,accountId,{savedActivityOnly=false}={}){
 const context=mountEncounterClaims(accountId,{inPlace:savedActivityOnly});
 context.savedActivityOnly=savedActivityOnly;
 await loadClaimMdConnection();if(!claimContextCurrent(context))return;
 await showClaim(id);
 if(typeof registerAutoRefresh==='function')$('encounter-claims')?.querySelector('.section-head')?.querySelector('.auto-refresh-updated')?.remove();
}
async function refreshClaimInContext(id,context=claimContextSnapshot()){
 if(!claimContextCurrent(context))return;
 if(context.kind==='worklist'&&!context.drawer){const next=await showClaimsWorkspace();if(!next||!claimContextCurrent(next))return;}
 await showClaim(id);
 if(context.drawer&&claimContextCurrent(context))void claimsAutoRefreshLoad().catch(()=>{});
 if(context.kind==='encounter'&&claimContextCurrent(context)&&typeof loadEncounterRevenueStatus==='function')void loadEncounterRevenueStatus(encounterChargeAccount(),true);
}
// What the claim is still missing, one short line per place it is fixed. The server names the
// problem in its own terms; staff see the boxes they have to fill in, and one button per place that
// opens it. Nothing here is a message we invent: every line comes from a server issue, and an issue
// we cannot translate is left out of the list rather than shown in developer wording.
// Whether a rule names this problem: the server's own field code, or one of the rule's patterns
// found in the words the server used.
const claimMissingRuleMatches=(rule,source)=>(source.fields||[]).includes(rule.key)||(rule.texts||[]).some(pattern=>(source.texts||[]).some(text=>pattern.test(String(text||''))));
// `key` is the server's own field name when it gives one; `texts` are the words it says instead.
// `input` is the box on this claim's own Edit form, empty when the fix lives on another record.
const claimMissingGroups=[
 {key:'practice',label:'Practice',action:'Open practice settings',attribute:'data-billing-organizations',
  rules:[
   {key:'billing_provider_name',texts:[/billing provider name|billing provider|legal billing name/i],words:'Billing provider name',input:'billing_provider_name'},
   {key:'tax_id',texts:[/tax id|taxpayer|tax identification|\bein\b/i],words:'Practice tax ID (9 digits)',input:'tax_id'},
   {key:'billing_npi',texts:[/\bbilling npi\b|billing provider npi/i],words:'Billing NPI (10 digits)',input:'billing_npi'},
   {key:'rendering_npi',texts:[/rendering npi|rendering provider npi/i],words:'Rendering NPI (10 digits)',input:'rendering_npi'},
   {key:'npi',texts:[/\bnpi\b|taxonomy/i],words:'Provider NPI (10 digits)',input:'billing_npi'},
   {key:'billing_address',texts:[/billing address/i],words:'Billing address',input:'billing_address'}
  ]},
 {key:'patient',label:'Patient',action:'Open patient',attribute:'data-claim-patient',
  rules:[
   {key:'patient_address',texts:[/patient address/i],words:'Patient address',input:'patient_address'},
   {key:'patient_birth_date',texts:[/patient (date of birth|birth date|dob)|date of birth of the patient/i],words:"Patient's date of birth",input:''},
   {key:'patient_given_name',texts:[/patient first name/i],words:'Patient first name',input:''},
   {key:'patient_family_name',texts:[/patient last name|patient family name/i],words:'Patient last name',input:''}
  ]},
 {key:'insurance',label:'Insurance',action:'Open insurance',attribute:'data-claim-insurance',
  rules:[
   {key:'member_id',texts:[/member id|subscriber id|insured id/i],words:'Member ID from the card',input:''},
   {key:'subscriber_name',texts:[/policy holder name|subscriber name/i],words:'Policy holder name',input:''},
   {key:'subscriber_relationship',texts:[/policy holder relationship/i],words:'Confirm how the patient is related to the policy holder',input:''},
   {key:'subscriber_address',texts:[/subscriber address|policy holder.{0,3} address/i],words:"Policy holder's address",input:'subscriber_address'},
   {key:'subscriber_birth_date',texts:[/subscriber (date of birth|birth date|dob)|policy holder.{0,3} (date of birth|birth date)/i],words:"Policy holder's date of birth",input:'subscriber_birth_date'},
   {key:'payer_name',texts:[/payer name|insurer name/i],words:'Insurance company name',input:''},
   {key:'payer_code',texts:[/payer id|insurer id|payer code/i],words:'Insurance company ID',input:''},
   {key:'group_number',texts:[/group number/i],words:'Group number',input:''},
   {key:'plan_name',texts:[/plan name/i],words:'Insurance plan name',input:''}
  ]},
 // The claim keeps its own copy of what was sent, so these are always fixed on the claim form.
 {key:'claim',label:'Claim',action:'Edit claim',attribute:'data-edit-claim',
  rules:[
   {key:'place_of_service',texts:[/place of service/i],words:'Place of service on the claim',input:'place_of_service'},
   {key:'diagnosis_codes',texts:[/diagnosis code|diagnosis pointer|diagnosis reference|missing diagnosis|no diagnosis|diagnosis is required|at least one diagnosis/i],words:'A diagnosis on every charge line',input:'diagnosis_codes'}
  ]}
];
// The detail the claim page last drew. The claim row itself carries no problems, so a fix started
// from the list reads them off the screen the person is looking at.
var claimDetailOnScreen;
function claimDetailCache(claim){return claim&&claimDetailOnScreen&&claimDetailOnScreen.claimId===claim.id?claimDetailOnScreen.detail:null;}
function claimMissingIssueText(issue){
 if(typeof issue==='string')return issue;
 if(issue&&typeof issue==='object')return String(issue.missing??issue.detail??issue.message??issue.issue??'').trim();
 return String(issue??'').trim();
}
// The claim's own data, searched only to work out where a fix belongs - never shown from here.
function claimMissingIssueSources(issue,text){
 const codes=Array.isArray(issue?.codes)?issue.codes:[];
 return {fields:[String(issue?.code??'').trim().toLowerCase(),...codes.map(code=>String(code).trim().toLowerCase())].filter(Boolean),texts:[text,...codes.map(String)]};
}
// Rules are tried practice → patient → insurance → claim, and within a group in the order written,
// so a message naming both a tax ID and an NPI is listed once, under Practice.
function claimMissingPlain(text){return String(text).replace(/\s*\(.*?\)/g,'').replace(/ can only use plain letters.*$/i,' has characters a claim cannot carry').trim();}
function claimMissingGroupsFor(issues){
 const buckets=Object.fromEntries(claimMissingGroups.map(group=>[group.key,{words:[],inputs:new Set(),items:[]}]));
 const seen=new Set();
 for(const issue of issues||[]){
  const text=claimMissingIssueText(issue);
  if(!text)continue;
  const key=text.toLocaleLowerCase();
  if(seen.has(key))continue;
  const source=claimMissingIssueSources(issue,text);
  for(const group of claimMissingGroups){
   const rule=group.rules.find(candidate=>claimMissingRuleMatches(candidate,source));
   if(!rule)continue;
   seen.add(key);
   const bucket=buckets[group.key];
   if(!bucket.words.includes(rule.words)){bucket.words.push(rule.words);bucket.items.push({words:rule.words,input:rule.input||''});}
   if(rule.input)bucket.inputs.add(rule.input);
   break;
  }
  if(!seen.has(key)){seen.add(key);const bucket=buckets.claim;const words=claimMissingPlain(text);if(!bucket.words.includes(words)){bucket.words.push(words);bucket.items.push({words,input:''});}}
 }
 return buckets;
}
// The boxes a named problem belongs in, so the one button focuses the right one.
function claimMissingFocusFields(buckets){
 const fields=new Set();
 for(const bucket of Object.values(buckets||{}))(bucket.inputs||new Set()).forEach(field=>fields.add(field));
 return fields;
}
// Boxes that can be filled in right here, on the claim page, without opening another screen.
// The patient's address is saved to the chart (the clearinghouse reads it from there); every other
// box is saved on this claim. A diagnosis needs the charge lines, so it stays on Edit claim.
const claimQuickFixInputs=['patient_address','subscriber_address','subscriber_birth_date','billing_provider_name','tax_id','billing_npi','rendering_npi','billing_address','place_of_service'];
function claimQuickFixable(claim){return Boolean(claim)&&claim.status==='draft'&&billingWrite()&&!claimIsCrossover(claim);}
function claimMissingGroupMarkup(group,bucket,inline=new Set()){
 const items=(bucket.items||bucket.words.map(words=>({words,input:''}))).filter(item=>!inline.has(item.input));
 if(!items.length)return '';
 return `<li data-missing-group="${group.key}"><b>${esc(group.label)}</b><ul>${items.map(item=>`<li>${esc(item.words)}</li>`).join('')}</ul><button type="button" ${group.attribute}>${esc(group.action)}</button></li>`;
}
function claimOwnPolicy(claim){return claim?.snapshot?.account?.coverage_snapshot?.coverage?.content?.relationship==='self';}
function claimQuickFixMarkup(claim,inputs,canConfirmSelf=false,address){
 if(!inputs.size&&!canConfirmSelf)return '';
 const v=claim.content||{},own=claimOwnPolicy(claim),box=(name,label,value='',extra='')=>`<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
 const parts=[];
 if(canConfirmSelf){
  const formatted=address?[address.line1,address.line2,address.city,[address.state,address.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', '):'';
  parts.push(`<section class="mapping-notice"><p>The policy holder matches the patient’s name and date of birth. Confirm the patient is the policy holder and their address on file is correct for this claim.</p>${formatted?`<p><b>${esc(formatted)}</b></p>`:''}<button type="button" data-confirm-self-policyholder>Confirm and update claim</button></section>`);
 }
 if(inputs.has('patient_address'))parts.push(`<fieldset><legend>Patient address <small>saved to the patient's chart</small></legend><div class="claim-quick-grid">${box('address_line1','Street','','required maxlength="200" autocomplete="off"')}${box('address_line2','Apt, suite (optional)','','maxlength="200" autocomplete="off"')}${box('address_city','City','','required maxlength="100" autocomplete="off"')}${box('address_region','State','','required maxlength="2" pattern="[A-Za-z]{2}" title="Two letters, for example TX" autocomplete="off"')}${box('address_postal_code','ZIP','','required inputmode="numeric" pattern="[0-9]{5}(-?[0-9]{4})?" title="5 or 9 digits" autocomplete="off"')}</div></fieldset>`);
 if(inputs.has('subscriber_address')){
  if(own&&inputs.has('patient_address'))parts.push('<p class="muted">The patient is the policy holder, so the address above is used for the policy holder too.</p>');
  else parts.push(box('subscriber_address',"Policy holder's address (street, city, state, ZIP)",own?v.patient_address:v.subscriber_address,'required maxlength="1000"'));
 }
 if(inputs.has('subscriber_birth_date'))parts.push(box('subscriber_birth_date',"Policy holder's date of birth",v.subscriber_birth_date||(own?claim.snapshot?.patient?.birth_date:'')||'',`type="date" required max="${localIsoDate()}"`));
 for(const [name,label,extra] of [['billing_provider_name','Billing provider name','maxlength="60"'],['tax_id','Practice tax ID (9 digits)','inputmode="numeric" pattern="[0-9]{2}-?[0-9]{7}"'],['billing_npi','Billing NPI (10 digits)','inputmode="numeric" pattern="[0-9]{10}"'],['rendering_npi','Rendering NPI (10 digits)','inputmode="numeric" pattern="[0-9]{10}"'],['billing_address','Billing address','maxlength="1000"'],['place_of_service','Place of service (2 digits, 11 = office)','inputmode="numeric" pattern="[0-9]{2}"']])
  if(inputs.has(name))parts.push(box(name,label,v[name],`required ${extra}`));
 return `<form id="claim-quick-fix" class="claim-quick-fix" data-claim="${esc(claim.id)}" data-claim-version="${esc(claim.version)}" hidden>${parts.join('')}<div class="actions">${inputs.size?'<button type="submit" class="primary">Save and check again</button>':''}<button type="button" data-claim-quick-fix-cancel>Cancel</button></div></form>`;
}
function claimMissingMarkup(buckets,claim,detail={}){
 const fixable=claimQuickFixable(claim),inline=new Set();
 const canConfirmSelf=fixable&&detail.can_confirm_self_policyholder===true&&
  (typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('claims','edit'));
 if(fixable)for(const bucket of Object.values(buckets||{}))for(const item of bucket.items||[])if(claimQuickFixInputs.includes(item.input))inline.add(item.input);
 const lines=claimMissingGroups.map(group=>claimMissingGroupMarkup(group,buckets[group.key],inline)).join('');
 const form=fixable?claimQuickFixMarkup(claim,inline,canConfirmSelf,detail.submission_defaults?.patient_address):'';
 if(!lines&&!form)return '';
 const inlineWords=form?Object.values(buckets||{}).flatMap(bucket=>(bucket.items||[]).filter(item=>inline.has(item.input)).map(item=>item.words)):[];
 const view=inlineWords.length||canConfirmSelf?`<div class="claim-quick-view" data-claim-quick-view>${inlineWords.length?`<ul>${inlineWords.map(words=>`<li>${esc(words)}</li>`).join('')}</ul>`:''}<button type="button" class="primary" data-claim-quick-fix-open>Fix here</button></div>`:'';
 return `<section class="claim-missing" data-claim-missing aria-label="Before this can be sent"><h3>Before this can be sent</h3>${view}${form}${lines?`<ul>${lines}</ul>`:''}</section>`;
}
// Saves the boxes of the "Fix it here" form: the patient's address to the chart, the rest on the
// claim, then reads the claim again (opening a draft fills empty boxes from the chart) and redraws it.
async function saveClaimQuickFix(form){
 const context=claimContextSnapshot(),claim=claimCurrent;
 if(!claim||claim.id!==form.dataset.claim)throw new Error('This claim is no longer open. Open it again.');
 requireClaimContext(context,claim);
 const data=Object.fromEntries(new FormData(form)),controls=[...form.querySelectorAll('button,input')];
 controls.forEach(control=>{control.disabled=true;});
 try{
  const savedClaim=(await api(`${claimsBase}/${claim.id}`)).claim;
  requireClaimContext(context,savedClaim);
  if(savedClaim.id!==claim.id||savedClaim.version!==Number(form.dataset.claimVersion)||savedClaim.status!=='draft')throw new Error('The claim changed. Reopen it to review the current values.');
  if('address_line1' in data){
   const profile=await api(`/api/v1/patients/${claim.patient_id}/demographics`),content={...(profile.content||{})};
   requireClaimContext(context,savedClaim);
   content.address={...(content.address||{}),line1:data.address_line1.trim(),line2:data.address_line2.trim()||null,city:data.address_city.trim(),region:data.address_region.trim().toUpperCase(),postal_code:data.address_postal_code.trim(),country:content.address?.country||'US'};
   await api(`/api/v1/patients/${claim.patient_id}/demographics`,'PUT',{content,reason:'Address added from the claim page'},profile.version);
  }
  const fresh=(await api(`${claimsBase}/${claim.id}`)).claim,content={...fresh.content},changed={};
  requireClaimContext(context,fresh);
  if(fresh.id!==claim.id||fresh.status!=='draft')throw new Error('The claim changed. Reopen it to review the current values.');
  if('address_line1' in data){
   const joined=[data.address_line1,data.address_line2,data.address_city,`${data.address_region.trim().toUpperCase()} ${data.address_postal_code.trim()}`].map(part=>String(part||'').trim()).filter(Boolean).join(', ');
   if(!String(content.patient_address||'').trim())changed.patient_address=joined;
   if(claimOwnPolicy(fresh)&&!String(content.subscriber_address||'').trim())changed.subscriber_address=joined;
  }
  for(const name of claimQuickFixInputs)if(name in data&&String(data[name]).trim()!==String(content[name]??'').trim())changed[name]=name==='subscriber_birth_date'?(data[name]||null):String(data[name]).trim();
  if(Object.keys(changed).length)await api(`${claimsBase}/${claim.id}`,'PUT',{content:{...content,...changed},reason:'Filled in on the claim page'},fresh.version);
  if(form.claimDraftKey)claimDrafts.delete(form.claimDraftKey);
  if(form.claimSheet)await new Promise(resolve=>sheetClose(form.claimSheet,resolve));
  await refreshClaimInContext(claim.id,context);
  if(typeof document!=='undefined'&&document.querySelector)flashUpdated(document.querySelector('[data-claim-primary]')||document.querySelector('[data-claim-missing]'));
  notice('Saved. The claim was checked again.');
 }finally{if(form.isConnected)controls.forEach(control=>{control.disabled=false;});}
}
async function confirmClaimSelfPolicyholder(form){
 const claim=claimCurrent,context=form?.claimViewContext||claimContextSnapshot();
 if(!claimQuickFixable(claim)||form?.dataset.claim!==claim.id||Number(form.dataset.claimVersion)!==claim.version||
  claimDetailCache(claim)?.can_confirm_self_policyholder!==true||
  typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims','edit'))return;
 requireClaimContext(context,claim);
 const result=await api(`${claimsBase}/${encodeURIComponent(claim.id)}/actions`,'POST',{
  action:'confirm_self_policyholder',
  reason:'Confirmed the patient is the policy holder and uses the address on file'
 },claim.version);
 if(!claimContextCurrent(context)||claimCurrent?.id!==claim.id)return;
 if(result?.id!==claim.id||!claimOwnPolicy(result))throw new Error('Reload the claim to check whether the policy holder was updated.');
 const sheet=form.claimSheet;
 if(sheet?.open&&!sheet.dataset.closing)await new Promise(resolve=>sheetClose(sheet,resolve));
 if(!claimContextCurrent(context)||claimCurrent?.id!==claim.id)return;
 notice('Policy holder updated on the claim. Check the updated claim before sending.');
 if(context.kind==='worklist')await showClaim(claim.id);
 else await refreshClaimInContext(claim.id,context);
}
// Staff wording for a list of problems on a screen this brief does not cover (remittances,
// acknowledgments). The claim page has its own grouped list above.
const claimIssues=items=>items.length?`<div class="mapping-notice"><b>What needs fixing</b><ul>${items.map(i=>`<li>${esc(claimMissingIssueText(i))}</li>`).join('')}</ul></div>`:'<p class="claim-clear">No problems found.</p>';
const claimReasonWords={'claim.refilled':'Missing details filled in from the chart and practice settings','claim.created':'Claim prepared','claim.edited':'Claim details changed','claim.released':'Released to send','claim.voided':'Claim cancelled'};
function claimHistoryReason(reason){const text=String(reason||'').trim();if(claimReasonWords[text])return claimReasonWords[text];return /^[a-z_]+\.[a-z_.]+$/.test(text)?text.split('.').pop().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()):text;}
function claimLocalBlueDestination(claim){
 const route=claim?.snapshot?.claim_routing;
 return route?.kind==='bluecard_local'&&route.payer_name&&route.payer_code?`${route.payer_name} · ${route.payer_code}`:'';
}
function claimCoverageAndRouteMarkup(claim){
 const destination=claimLocalBlueDestination(claim);
 if(!destination)return '';
 const coverage=claim.snapshot.account?.coverage_snapshot?.payer?.content?.name||claim.snapshot.claim_routing.home_payer_name;
 return `<dl class="signed-claim-reviewed-facts" data-claim-coverage-and-route><div><dt>Insurance coverage</dt><dd>${esc(coverage)}</dd></div><div><dt>Claim destination</dt><dd>${esc(destination)}</dd></div></dl>`;
}
function claimLocalBlueOptions(claim,detail){
 if(claim?.status!=='rejected'||claim.payer_control_number||detail?.local_blue_route?.eligible!==true)return [];
 const options=detail.local_blue_route.options;
 return Array.isArray(options)?options.filter(option=>option?.payer_id&&option.payer_code&&option.payer_name):[];
}
const claimHistory=h=>`<ol class="claim-history-list">${h.items.map(r=>`<li><b>${esc(claimHistoryReason(r.reason))}</b><small>${esc(date(r.created_at))} · version ${esc(r.version)}</small>${typeof me!=='undefined'&&me?.role==='owner'?`<details class="amendment"><summary>Technical record</summary><pre class="billing-source">${esc(JSON.stringify(r.evidence||r.snapshot,null,2))}</pre></details>`:''}</li>`).join('')}</ol>`;
const claimTransport=t=>{
 if(!t||typeof t!=='object')return `${esc(t||'Clearinghouse status unavailable')}. Downloading a claim does not send it.`;
 const claimmd=t.claimmd_connected,artifact=t.artifact==='generated';
 const retrieval=(t.retrieval_health||[]).find(item=>(t.routes||[]).some(route=>route.provider==='claim_md'&&route.route_key===item.route_key));
 const health=retrieval?(retrieval.paused?'Automatic response checks are paused':retrieval.last_result?`Last response check: ${human(retrieval.last_result)}`:'Responses have not been checked yet'):'Response check status is not available yet';
 if(claimmd)return `The clearinghouse is connected. ${artifact?'A claim file has been prepared for this claim.':'No claim file has been prepared for this claim yet.'} ${health}.`;
 return `No clearinghouse is connected. ${artifact?'A claim file is ready to download and upload to your clearinghouse yourself.':'You can prepare a claim file (837P) and upload it to your clearinghouse yourself.'} Downloading a claim does not send it.`;
};
function claimWorklistFilterMarkup(){
 const sort=Object.entries(claimWorklistSorts).map(([key,[name]])=>`<option value="${key}">${name}</option>`).join('');
 return `<div class="claim-worklist-refinement" data-claim-worklist-filters aria-label="Filter claims">
  <label class="claim-worklist-search">Find a claim<input type="search" data-claim-filter="search" maxlength="120" placeholder="Patient, encounter or claim number" autocomplete="off"></label>
  <label>Payer<select data-claim-filter="payer"><option value="">All payers</option></select></label>
  <label>Sort by<select data-claim-filter="sort">${sort}</select></label>
  <details class="claim-worklist-more"><summary>More filters</summary><div class="claim-worklist-ranges">
   <label>Service from<input type="date" data-claim-filter="service_from"></label>
   <label>Service through<input type="date" data-claim-filter="service_through"></label>
   <label>Minimum amount<input type="number" data-claim-filter="amount_min" min="0" max="100000000" step="0.01" inputmode="decimal"></label>
   <label>Maximum amount<input type="number" data-claim-filter="amount_max" min="0" max="100000000" step="0.01" inputmode="decimal"></label>
  </div></details>
  <button type="button" class="text-button" data-clear-claim-filters hidden>Clear filters</button>
 </div>`;
}
function claimListMarkup(){return '<h3 class="sr-only" data-claim-list-heading>Needs action</h3><div class="billing-table-wrap"><table class="billing-table claims-monitor-table claim-worklist-table" role="table" aria-label="Claims"><thead><tr><th scope="col">Encounter</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Waiting</th><th scope="col">Next action</th></tr></thead><tbody role="rowgroup" data-claim-rows></tbody></table></div>'; }
function eraListMarkup(){return '<div class="billing-table-wrap"><table class="billing-table claims-monitor-table" role="table" aria-label="Remittances"><thead><tr><th>Insurer</th><th>Trace</th><th>Payment date</th><th>Claims</th><th>Amount</th><th>Status</th></tr></thead><tbody role="rowgroup"></tbody></table></div>';}
function eraRowsMarkup(){
 const remittances=eraRows.filter(r=>claimStatusFilter==='payments'||eraWorkGroup(r)===claimStatusFilter);
 if(!remittances.length){
  const message=({'remittance-review':'No remittances to review',posted:'No posted remittances'})[claimStatusFilter]||'No remittances';
  return `<tr><td colspan="6" class="table-empty">${message}${eraNext?' in the loaded records':''}.</td></tr>`;
 }
 return [...remittances].sort((a,b)=>String(b.payment_date||'').localeCompare(String(a.payment_date||''))).map(r=>{
  return `<tr role="row"><td role="cell" class="monitor-record">${esc(r.payer_name||'—')}</td><td role="cell" class="monitor-action"><button type="button" data-era-open="${esc(r.id)}" aria-label="Open remittance ${esc(r.trace||r.id)}">${esc(r.trace||r.id)}</button></td><td role="cell" class="monitor-date">${esc(displayDate(r.payment_date)||'—')}</td><td role="cell" class="monitor-claim-count">${esc(r.claim_count)}<span class="monitor-mobile-label"> ${r.claim_count===1?'claim':'claims'}</span></td><td role="cell" class="money-cell monitor-amount">${money(r.total_paid_cents)}</td><td role="cell" class="monitor-status">${esc(eraStatusLabel(r.status))}</td></tr>`;
 }).join('');
}
function claimWorklistPage(base,cursor){return cursor?`${base}?after=${encodeURIComponent(cursor)}`:base;}
async function loadClaimWorklist(context,base=claimsBase){
 const list=await api(base);
 while(list.next_cursor&&claimContextCurrent(context)){
  const page=await api(claimWorklistPage(base,list.next_cursor));
  list.items.push(...page.items);list.next_cursor=page.next_cursor;
 }
 if(claimContextCurrent(context))return list;
}
function coverageNeedsActionAllowed(){return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('billing');}
async function loadCoverageNeedsAction(context){
 if(!coverageNeedsActionAllowed())return null;
 try{return await loadClaimWorklist(context,coverageNeedsActionBase);}
 catch(error){return error.status===403?null:{items:[],failed:true};}
}
async function refreshCoverageWorklist(){
 const context=claimViewContext;
 if(context?.kind!=='worklist'||!claimContextCurrent(context)||!context.coverageQueue?.failed)return;
 const queue=await loadCoverageNeedsAction(context);
 if(!claimContextCurrent(context))return;
 context.coverageQueue=queue;
 claimWorkspaceMarkup();
}
async function loadEraWorklist(context){
 const payments=await api(eraBase);
 for(let page=1;page<context.eraPages&&payments.next_cursor&&claimContextCurrent(context);page++){
  const result=await api(claimWorklistPage(eraBase,payments.next_cursor));
  payments.items.push(...result.items);
  payments.next_cursor=result.next_cursor;
 }
 return payments;
}
async function showMoreMonitorRemittances(){
 const context=claimViewContext,cursor=eraNext;
 if(!cursor||!claimContextCurrent(context)||context.kind!=='worklist'||context.loadingEraPage)return;
 context.loadingEraPage=true;
 context.eraRevision++;
 const button=$('claims-tool').querySelector('[data-era-next]');
 button.disabled=true;
 try{
  const page=await api(claimWorklistPage(eraBase,cursor));
  if(!claimContextCurrent(context))return;
  eraRows=[...eraRows,...page.items];
  eraNext=page.next_cursor;
  claimMonitorEraPages=++context.eraPages;
 }finally{
  context.loadingEraPage=false;
  if(claimContextCurrent(context))claimWorkspaceMarkup();
 }
}
async function claimsAutoRefreshLoad(){
 const context=claimViewContext,host=$('claims-tool');
 if(context?.kind!=='worklist'||!claimContextCurrent(context)||!host||$('tools')?.hidden)return autoRefreshStop();
 const eraRevision=context.eraRevision;
 const loadingCoverage=context.coverageQueue?.loading;
 const [claims,remittances,coverage]=await Promise.all([loadClaimWorklist(context),context.loadingEraPage?null:loadEraWorklist(context),loadingCoverage?null:loadCoverageNeedsAction(context)]);
 if(!claims||!claimContextCurrent(context)||$('claims-tool')!==host||$('tools')?.hidden)return;
 claimRows=claims.items;
 if(!loadingCoverage)context.coverageQueue=coverage;
 if(remittances&&eraRevision===context.eraRevision){
  eraRows=remittances.items;
  eraNext=remittances.next_cursor;
 }
 claimWorkspaceMarkup();
}
function registerClaimsAutoRefresh(){
 if(typeof registerAutoRefresh!=='function')return;
 const host=$('claims-tool');if(!host)return;
 unregisterAutoRefresh('claims-workspace');
 const handle=registerAutoRefresh('claims-workspace',{host,load:claimsAutoRefreshLoad,everyMs:30000});
 // The claims workspace already has a header above the list; the quiet update
 // line belongs there rather than in a new strip of its own.
 const outer=$('claims-tool')?.querySelector(':scope > .section-head');
 if(handle?.status&&outer&&handle.status.parentElement!==outer)outer.appendChild(handle.status);
 const temporary=$('claims-tool')?.querySelector(':scope > .auto-refresh-head');
 if(temporary&&!temporary.children.length)temporary.remove();
}
async function showClaimsWorkspace({filter}={}){
 captureClaimDraft();
 const previousDrawer=claimViewContext?.drawer;
 if(previousDrawer?.open){previousDrawer.close();previousDrawer.remove();}
 const identity=typeof me==='undefined'?undefined:me;
 if(claimStatusFilterIdentity!==identity){claimStatusFilter='action';claimStatusFilterIdentity=identity;claimMonitorEraPages=1;claimWorklistFilters={...claimWorklistDefaultFilters};}
 const context={kind:'worklist',identity,eraPages:claimMonitorEraPages,eraRevision:0};claimViewContext=context;
 if(filter!==undefined)setClaimMonitorFilter(filter);
 if(typeof loadClaimmdProviderDefaults==='function')await loadClaimmdProviderDefaults();if(!claimContextCurrent(context))return;
 const coverageRequest=loadCoverageNeedsAction(context);
 const [c,r,p,s]=await Promise.all([loadClaimWorklist(context),loadEraWorklist(context),api('/api/v1/billing/payers'),billingWrite()?api('/api/v1/billing/remittance-sources'):{items:[]},loadClaimMdConnection(()=>claimContextCurrent(context))]);
 if(!c||!claimContextCurrent(context))return;
 context.coverageQueue=coverageNeedsActionAllowed()?{items:[],loading:true}:null;
 claimRows=c.items;eraRows=r.items;billingPayers=p.items;eraNext=r.next_cursor;showTool('Claims & remittances');
 $('tools').innerHTML=`<section id="claims-tool"><div class="section-head"><h2>Claims worklist</h2></div>
 ${claimStatusChipsHtml()}${claimWorklistFilterMarkup()}
 <section class="billing-section" data-coverage-worklist hidden>
  <div class="section-head"><h3>Insurance added after posting</h3></div>
  <p class="muted" data-coverage-worklist-status role="status" hidden></p>
  <div class="billing-table-wrap" hidden><table class="billing-table claim-worklist-table" aria-label="Insurance added after posting">
   <thead><tr><th scope="col">Encounter</th><th scope="col">Insurance</th><th scope="col">Amounts</th><th scope="col">Next action</th></tr></thead><tbody role="rowgroup"></tbody>
  </table></div>
 </section>
 <section class="billing-section" data-claim-worklist>${claimListMarkup()}</section>
 <section class="billing-section" data-era-worklist>${eraListMarkup()}</section>
 <div class="actions" data-era-more hidden><span class="muted">Remittance counts reflect loaded records.</span><button type="button" data-era-next>Load more remittances</button></div>
 <details id="claim-monitor-management" class="amendment"><summary>Billing tools${claimMdConnectionState?.connected?'':' · Clearinghouse not connected'}</summary>${billingPageMore()}
 ${s.items.length?`<details class="amendment"><summary>Insurance payments imported from another system (${s.items.length})</summary>${s.items.map(v=>`<div class="timeline-row"><div><b>${esc(v.source_id)}</b><small>${esc(v.source_instance)}</small></div><button type="button" data-era-source="${v.source_history_id}">${v.native_id?'View payment':'Review and import'}</button></div>`).join('')}</details>`:''}<span id="claim-monitor-tools-anchor" hidden></span></details><div id="claims-detail"></div></section>`;
 context.host=$('claims-detail');
 window.eraSources=s.items;
 claimWorkspaceMarkup();
 void coverageRequest.then(queue=>{
  if(!claimContextCurrent(context))return;
  context.coverageQueue=queue;
  claimWorkspaceMarkup();
 });
 const management='claim-monitor-tools-anchor';
 await showEraAutomation(management,'beforebegin');
 if(!claimContextCurrent(context))return;await showRecoupments(management);
 if(!claimContextCurrent(context))return;await showEraBatches(management);
 if(!claimContextCurrent(context))return;
 await decorateClaimsWorkspace(context);
 if(claimContextCurrent(context))registerClaimsAutoRefresh();
 return context;
}
function claimPane(html,{quiet=false,request=null}={}){const context=claimContextSnapshot();requireClaimContext(context);context.detailRequest=request;const host=claimWorkspaceHost(context);if(!host)return;host.innerHTML=html;if(!quiet)host.scrollIntoView({block:'start'});}
function claimHasRecordedSubmission(detail={}){return detail.tracking?.external_submission_recorded===true||(detail.tracking?.submissions||[]).some(item=>item.status==='delivered');}
function claimHasPreparedSubmission(detail={}){return (detail.tracking?.submissions||[]).some(item=>item.status==='prepared');}
// Claim rows use the same state names as the encounter billing card.
// Claim rows carry the Claim.MD position the list endpoint read for them, so a claim the
// clearinghouse holds for correction is named as such in the list and not only once opened.
function claimStatusLabel(claim){
 if(!claimRecordFilters.includes(claim.status))return 'Claim status unavailable';
 if(typeof visitBillingClaimState==='function')return visitBillingClaimState(claim);
 if(claimMdNeedsCorrection(claim,claim))return claimMdCorrectionWord;
 if(claimIsCrossover(claim)&&claim.status==='submitted')return 'Crossover response received';
 if(claimMdOnlyAcknowledged(claim,claim))return 'Received by the clearinghouse';
 return displayStatus(claim.status);
}
function claimIsCrossover(claim){return Boolean(claim?.crossover_tracking_only===true||claim?.snapshot?.coordination_of_benefits?.crossover);}
// 'Paid' needs a posted insurance payment. A return and a payer denial have separate evidence.
const claimPlainWords={draft:'Not sent yet',ready:'Not sent yet',submitted:'Sent',accepted:'Accepted',rejected:'Rejected',void:'Voided',denied:'Denied',paid:'Paid'};
// Claim.MD's two positions a claim row's own status cannot say, in the one word each screen uses.
// A claim the clearinghouse holds for correction is worked on, not waited on; a claim it has only
// acknowledged has not reached the payer at all, and saying "the insurer has it" would be untrue.
const claimMdCorrectionWord='Needs correcting';
function claimMdNeedsCorrection(claim,detail={}){return ['submitted','accepted'].includes(claim?.status)&&detail?.claimmd_position?.needs_correction===true;}
function claimMdOnlyAcknowledged(claim,detail={}){
 if(detail?.claimmd_position?.acknowledged===true)return true;
 if(detail?.claimmd_position?.acknowledged===false)return false;
 // Without the server's position the claim's own provider messages answer the question:
 // Claim.MD acknowledged the upload and nothing has been heard from the payer since.
 const reports=detail?.tracking?.reports||[],latest=reports[reports.length-1]?.evidence;
 return String(claim?.status||'')==='submitted'&&latest?.message?.status==='A'&&['CLMMD',undefined,'',null].includes(latest?.senderid)&&!claim?.payer_control_number;
}
function claimPlainStatus(claim,detail={}){
 if(!claim)return '';
 if(claimIsCrossover(claim))return 'Secondary payer answered';
 const status=String(claim.status||'').trim().toLowerCase();
 if(status==='rejected'&&typeof visitBillingReturnTitle==='function')return visitBillingReturnTitle(claim);
 // The claim row lags the clearinghouse answer by however long the last check took. A file the
 // insurer has received means the claim is out, whatever the row still says, so the one word on the
 // page tells the truth about where the claim is rather than about which column was last written.
 if(['draft','ready'].includes(status)&&claimHasRecordedSubmission(detail))return claimPlainWords.submitted;
 if(status==='adjudicated'){
  const tracking=detail.tracking||{};
  if(tracking.payer_denied===true)return 'Payer denial';
  if(tracking.remittance_posted===true)return tracking.paid_cents>0?'Payment posted':'Payer response posted';
  return 'Payer response recorded';
 }
 if(claimMdNeedsCorrection(claim,detail))return claimMdCorrectionWord;
 return claimPlainWords[status]||displayStatus(claim.status)||'Status unavailable';
}
// What the claim was billed for, and what the payer and the patient have put against it. The
// balance in the snapshot is the one taken when the claim was prepared, so it is shown as that.
function claimMoneySummaryMarkup(claim,detail={}){
 const account=claim?.snapshot?.account||{},financial=claim?.snapshot?.financial_summary||{};
 const payerPaid=detail?.tracking?.paid_cents??financial.insurance_paid_cents??null;
 const cell=(label,amount,note)=>`<div class="claim-money-cell"><span>${esc(label)}</span><b>${amount}</b>${note?`<small>${esc(note)}</small>`:''}</div>`;
 return `<div class="claim-money" data-claim-money>${cell('Billed',money(account.total_cents??0),'')}
 <div class="claim-money-cell"><span>Insurer paid</span><b>${payerPaid===null?'Not recorded yet':money(payerPaid)}</b></div>
 ${cell('Patient paid',money(financial.patient_payments_cents||0),'')}
 ${cell('Balance when prepared',money(financial.open_balance_cents??account.total_cents??0),'Check the account before billing the patient.')}
 <div class="claim-money-cell"><span>Insurance company</span><b>${esc(account.coverage_snapshot?.payer?.content?.name||'Not recorded')}</b><small>${esc(human(claim?.frequency||''))}</small></div></div>`;
}
// The CMS-1500 is the paper form for the payer being billed. A claim built on a secondary plan has
// no form of its own to print - the primary result travels with it - so the link is not offered and
// the reason is said instead.
function claimCms1500Markup(claim){
 if(claim.snapshot?.coordination_of_benefits)return '<p class="muted">A CMS-1500 preview is not available for a secondary claim. The primary payer result goes with it.</p>';
 return `<b>Want to see the form?</b><p class="muted">Previewing or printing does not send anything.</p><a class="button" href="${claimsBase}/${esc(claim.id)}/cms1500" target="_blank" rel="noopener">Preview claim (CMS-1500) ↗</a>`;
}
function claimRecordedOutsideMarkup(claim){
 return `<details class="amendment claim-advanced"><summary>${claim.status==='draft'?'Other options for this claim':'Record something done outside SunCharts'}</summary><form id="claim-action"><h3>${claim.status==='draft'?'Void this claim, or release it without opening the send form':'Record activity outside SunCharts'}</h3><div class="form-grid"><label>Action<select name="action">${(claim.status==='draft'?['ready','void_draft']:claim.status==='ready'?['record_submission','void_draft']:claim.status==='submitted'?['record_acceptance','record_rejection']:['record_rejection']).map(v=>`<option value="${v}">${esc(claimActionLabels[v]||human(v))}</option>`).join('')}</select></label>${claim.status==='draft'?'':`${billingField('reference','Reference number','','text',200)}${billingField('event_date','Date it happened','','date')}${billingField('payer_control_number','Payer claim number',claim.payer_control_number,'text',100)}`}${billingField('reason','Reason (saved in the claim history)','','text',1000,true)}</div><p class="muted">${claim.status==='draft'?'Releasing a claim does not send it. Most of the time, use the button at the top of this page instead.':claim.status==='ready'?'Use this only if the claim was already sent outside SunCharts, or to void it. To send it from here, use the button at the top of this page.':'Record an acceptance or rejection you received outside SunCharts. This does not send a claim or record an insurance payment.'}</p><button class="primary" type="submit">${claim.status==='draft'?'Save':'Record activity'}</button></form></details>`;
}
// The secondary-crossover panel: the secondary payer answered on its own, so there is nothing to
// send from here and one button that opens the payment to review.
function claimCrossoverMarkup(claim){
 const source=claim.snapshot.coordination_of_benefits.crossover;
 return `<section class="claim-primary" data-claim-primary aria-label="Crossover tracking"><div class="claim-primary-action"><p>The primary payer forwarded this claim to the secondary payer, and the secondary payment is linked to the same visit. SunCharts did not send another claim, and a denial or a missing patient share does not change what the patient owes.</p><button type="button" class="primary" data-era-open="${esc(source.remittance_id)}">Review secondary payment</button></div></section>`;
}
// One sentence, and the one button that is the next step. Anything else a person might want is in
// More details, never a second button competing with this one.
function claimPrimaryActionMarkup(claim,detail={},options={}){
 if(claimIsCrossover(claim))return claimCrossoverMarkup(claim);
 const canWrite=billingWrite(),connection=typeof claimMdConnectionState==='undefined'?undefined:claimMdConnectionState;
 const blockers=Array.isArray(detail?.preflight_issues)?detail.preflight_issues.filter(Boolean):[];
 const secondaryPlan=claim.snapshot?.account?.coverage_snapshot?.coverage?.content?.priority;
 let words='',button='',holdResponse='';
 // A claim file the clearinghouse has already received is out the door whatever the claim row still
 // says, so the next step cannot be to send it again. A file merely prepared is not proof it went.
 const received=claimHasRecordedSubmission(detail);
 if(claim.status==='void'){
  const recovery=claimCanceledRecovery(claim,detail.canceled_claim_recovery);
  words=recovery?'Canceled before sending. Resubmitting opens a new draft from the current posted charges for review.':'This claim was canceled. View its history for prior activity.';
  if(recovery)button=claimCanceledRecoveryButton(claim,recovery,true);
 }
 else if(claimMdNeedsCorrection(claim,detail)){
  words='Claim.MD is holding this claim for correction.';
  const message=detail.claimmd_position.correction?.message;
  if(typeof message==='string'&&message.trim())holdResponse=`<div class="mapping-notice"><b>Claim.MD response</b><p>${esc(message)}</p></div>`;
  const line=detail.claimmd_position.correction?.line;
  button=claimViewContext?.drawer&&canWrite&&line?.code&&Number.isInteger(line.index)?
   `<button type="button" class="primary" data-worklist-held-fix="${esc(line.index)}" data-procedure="${esc(line.code)}">Fix ${esc(line.code)}</button>`:
   '<button type="button" class="primary" data-claimmd-review-response>Review status and responses</button>';
 }
 else if(['submitted','accepted','adjudicated'].includes(claim.status))words=claimHasRecordedSubmission(detail)?'This claim has been sent. The answer shows on this page while the claim is open.':claimHasPreparedSubmission(detail)?'A claim file is prepared but not confirmed as received. Open it to check its delivery before preparing another.':'This claim has been sent. Nothing to do until the insurer answers.';
 // The plain-words box at the top already carries the button that opens the claim with the problem
 // field focused. Repeating it here would put two primary buttons on one screen for one action.
 else if(claim.status==='rejected'){
  const blockedRoute=claimLocalBlueDestination(claim)&&!claimLocalBlueOptions(claim,detail).length;
  words=blockedRoute?'Review the payer response and current delivery before correcting this BlueCard claim.':claimCameBack(claim)?'The return reason is above.':'Review the return before resubmitting.';
  if(!blockedRoute&&!claimCameBack(claim)&&canWrite)button='<button type="button" class="primary" data-claim-fix-resend>Fix and resend</button>';
 }
 else if(!canWrite)words='Billing staff check these details and send the claim.';
 else if(claim.status==='ready'&&received)words='This claim has been sent. The answer shows on this page while the claim is open.';
 else if(claim.status==='ready'&&claimHasPreparedSubmission(detail))words='A claim file is prepared but not confirmed as received. Open it to check its delivery before preparing another.';
 else if(claim.status==='ready'&&!blockers.length&&connection?.connected!==false)words='Review the claim and the details on file before sending.',button=`<button type="button" class="primary" data-claimmd-submit="${esc(claim.id)}">Review &amp; send</button>`;
 else if(claim.status==='ready'&&connection?.connected===false)words='Ask the practice owner to check Claim connections. You can also prepare a claim file.',button=`<button type="button" class="primary" data-edi-claim="${esc(claim.id)}">Prepare claim file (837P)</button>`;
 else if(claim.status==='draft'&&!blockers.length)words='Review the claim and the details on file before sending.',button=`<button type="button" class="primary" data-claim-release="${esc(claim.id)}">Review &amp; send</button>`;
 else{
  // Count what the list below shows (two server messages about one box are one line there), and
  // when the boxes can be filled in right on this page, point there instead of opening the editor.
  const listed=claimMissingGroupsFor(blockers),count=Object.values(listed).reduce((n,bucket)=>n+bucket.words.length,0)||blockers.length;
  const inline=claimQuickFixable(claim)&&Object.values(listed).some(bucket=>(bucket.items||[]).some(item=>claimQuickFixInputs.includes(item.input)));
  words=count?`${count===1?'1 thing needs':`${count} things need`} fixing before this can be sent. ${inline?'Use Fix here below to fill them in without leaving this page.':'They are listed below.'}`:'This claim is being prepared.';
  button=inline?'':'<button type="button" class="primary" data-edit-claim>Edit claim</button>';
 }
 const cms=claimCms1500Markup(claim);
 const secondary=canWrite&&claim.status==='adjudicated'&&secondaryPlan==='primary'?'<button type="button" data-secondary-claim>Bill secondary insurance</button>':'';
 const correction=canWrite&&!claimIsCrossover(claim)&&claim.status==='adjudicated'&&claim.payer_control_number?'<button type="button" data-replacement-claim>Correct or void this claim</button>':'';
 const download=!claimIsCrossover(claim)&&!['draft','void'].includes(claim.status)?`${claimPacketDownload(claim)}`:'';
 const existing=(detail?.tracking?.submissions||[]).filter(item=>['prepared','delivered'].includes(item.status)&&item.id).at(-1);
 const openFile=existing&&claim.status!=='void'?`<button type="button" data-claim-existing-submission="${esc(existing.id)}">Open the claim file already prepared</button>`:'';
 const extras=[secondary,correction,openFile].filter(Boolean).join('');
 return `<section class="claim-primary" data-claim-primary aria-label="Next step"><div class="claim-primary-action"><p>${esc(words)}</p>${holdResponse}<div class="claim-primary-buttons">${button}</div>${options.connectionNotice||''}</div><div class="claim-primary-side">${cms}</div>${extras?`<div class="claim-primary-extra">${extras}</div>`:''}${download?`<p class="claim-primary-download">${download}</p>`:''}${claim.parent_id?`<p class="claim-primary-parent"><button type="button" data-claim-open="${claim.parent_id}">Open the claim this one corrects</button></p>`:''}${options.secondaryEvidence||''}</section>`;
}
// Everything that is not the next step, under one collapsed heading. The panels themselves are the
// ones already on the screen; only where they sit changes. The claim's own status and version stay
// outside so a refresh can still update them in place.
function claimMoreDetailsMarkup(claim,detail={},history={items:[]},sections={}){
 const rows=[
  ['What happened',sections.timeline],
  ['Claim progress',sections.lifecycle],
  ['Clearinghouse activity',sections.activity],
  ['The insurer and clearinghouse wording',sections.responseWords],
  [claim.status==='draft'?'Other options for this claim':'Record something done outside SunCharts',sections.recordOutside],
  ['Provider, insurance and diagnosis details',sections.providerDetails],
  ['The insurance on this claim',sections.coverageRecord],
  ['Claim history',sections.history],
 ].filter(([,body])=>String(body||'').trim());
 return `<details class="claim-more" data-claim-more-details><summary>More details${rows.length?` <span class="pill">${rows.length}</span>`:''}</summary>${rows.map(([label,body])=>`<section class="claim-more-item"><h3>${esc(label)}</h3>${body}</section>`).join('')}</details>`;
}
// The insurer's or clearinghouse's own words, kept for the people who need to quote them, but under
// More details rather than on the front of the screen.
function claimRawResponseMarkup(detail={}){
 const words=claimResponseWords(detail);
 return words?`<p class="claim-response-words">${esc(words)}</p>`:'<p class="muted">No wording from the insurer or the clearinghouse yet.</p>';
}
// Provider, insurance and diagnosis values, named the way staff see them. Codes and identifiers
// stay; the developer names, the stored address objects and the internal flags do not.
const claimDetailLabels={billing_provider_name:'Billing provider name',billing_npi:'Billing NPI',rendering_npi:'Rendering NPI',tax_id:'Tax ID',tax_id_type:'Tax ID type',billing_address:'Billing address',patient_address:'Patient address',subscriber_address:'Policy holder address',subscriber_birth_date:'Policy holder date of birth',place_of_service:'Place of service',diagnosis_codes:'Diagnosis codes',line_diagnosis_pointers:'Diagnosis pointers per line',external_control_number:'Claim number from a previous system',notes:'Notes',synthetic_test:'Test claim'};
const claimTaxIdTypeWords={'E':'Employer identification number','S':'Social security number','':''};
function claimProviderDetailsMarkup(claim){
 const content=claim?.content||{};
 const rows=Object.entries(claimDetailLabels).map(([key,label])=>{
  if(!(key in content))return '';
  const value=content[key];
  let shown;
  if(key==='tax_id_type')shown=claimTaxIdTypeWords[value]??String(value??'');
  else if(key==='synthetic_test')shown=value===true?'Yes — a made-up test claim':'No';
  else if(key==='line_diagnosis_pointers')shown=Array.isArray(value)?value.map((pointers,index)=>`Line ${index+1}: ${(pointers||[]).join(', ')||'none'}`).join(' · '):'';
  else if(Array.isArray(value))shown=value.join(', ');
  else if(value&&typeof value==='object')shown=JSON.stringify(value);
  else shown=value===null||value===undefined?'':String(value);
  return `<dt>${esc(label)}</dt><dd>${esc(shown||'Not recorded')}</dd>`;
 }).join('');
 return `<dl class="billing-dl claim-detail-dl">${rows}</dl>`;
}
// The insurance the claim was prepared with. Kept whole because it is the record of what was sent,
// but only ever under More details.
function claimCoverageRecordMarkup(claim){
 const coverage=claim?.snapshot?.account?.coverage_snapshot;
 return coverage?`<details class="amendment claim-coverage-record"><summary>As it was recorded when this claim was prepared</summary><pre class="billing-source">${esc(JSON.stringify(coverage,null,2))}</pre></details>`:'';
}
// The claim record as a file, for the rare case a payer or another system asks for it. The wording
// stays free of the file format: what is downloaded is the claim.
function claimPacketDownload(claim){return `<a class="button" href="${claimsBase}/${esc(claim.id)}/packet" download>Download the claim file</a>`;}
// One line, and only when the missing connection is the thing stopping the claim going out.
// Everywhere else on this screen it goes unsaid: the Claim connections screen is the place for it.
function claimConnectionNotice(claim,detail={}){
 if(!billingWrite()||claimIsCrossover(claim))return '';
 if(String(claim?.status||'').toLowerCase()!=='ready')return '';
 if(Array.isArray(detail?.preflight_issues)&&detail.preflight_issues.length)return '';
 if(typeof claimMdConnectionState==='undefined'||claimMdConnectionState?.connected!==false)return '';
 return '<p class="claim-connection-note" data-claim-connection-note>The clearinghouse is not connected, so this claim cannot be sent from here. A claim file can still be prepared and uploaded yourself.</p>';
}
// A claim that came back is worked on from the plain-words box at the top of the screen, so the
// next-step area has one button and never a second instruction competing with it.
function claimCameBack(claim){return typeof claimProblemReport==='function'&&Boolean(claimProblemReport(claim));}
// One step from a checked draft to the send form. Marking the claim ready is recorded the
// same way as the manual action and sends nothing; the person still presses Send.
async function releaseClaimToSend(id){
 const context=claimContextSnapshot(),claim=claimCurrent;
 if(!claim||claim.id!==id||claim.status!=='draft')throw new Error('Open the claim again before continuing.');
 requireClaimContext(context,claim);captureClaimDraft();
 await openClaimMdSubmissionReview(id,{releaseDraft:true,expectedVersion:claim.version});
}
// The claim on screen has moved on or was never loaded: read it again rather than telling staff to
// start over. Silent when the screen has since been closed or somebody else took it over.
async function refreshClaimForFix(id,context,identity){
  if(!id)return null;
  const detail=await api(`${claimsBase}/${id}`);
  if(!claimContextCurrent(context)||identity!==(typeof me==='undefined'?undefined:me))return null;
  if(!detail?.claim||detail.claim.id!==id){notice('The claim that loaded is not the one you opened. Open it again.');return null;}
  requireClaimContext(context,detail.claim);claimCurrent=detail.claim;context.claim=detail.claim.id;
  return detail.claim;
}
async function beginLocalBlueClaimFix(claimId){
  const context=claimContextSnapshot(),identity=me;
  const detail=await api(`${claimsBase}/${encodeURIComponent(claimId)}`);
  if(!claimContextCurrent(context)||context.claim!==claimId||identity!==me)return;
  const claim=detail?.claim;
  if(claim?.id!==claimId)throw new Error('Reopen the returned claim to review its routing.');
  requireClaimContext(context,claim);
  const options=claimLocalBlueOptions(claim,detail);
  if(!options.length)throw new Error('Local Blue routing is unavailable for this claim. Reopen the claim to see its current status.');
  const fresh=await api(`/api/v1/patients/${claim.patient_id}/billing`);
  if(!claimContextCurrent(context)||context.claim!==claimId||identity!==me)return;
  const account=fresh.accounts.find(row=>row.id===claim.account_id&&row.status==='posted');
  if(!account)throw new Error('The posted charges are no longer available. Reopen the claim and check the encounter.');
  claimEditor({...account,patient_id:claim.patient_id},null,null,claim,null,options);
  return true;
}
// "Fix and resend": open the claim for editing with the problem field focused, and say in plain
// words how this corrected claim goes back out. Nothing is refused here — a claim whose answer we
// cannot read is still opened, with a line about what we could not work out, so staff are never
// stuck behind our own guess at the payer's meaning.
async function beginClaimFix(claimId,field){
  const context=claimContextSnapshot(),identity=typeof me==='undefined'?undefined:me;
  // A crossover claim was not sent from here and has no corrected claim to prepare; the row still
  // opens, and the line says why there is nothing to fix on it.
  if(claimId&&(claimCurrent?.id===claimId?claimCurrent:await refreshClaimForFix(claimId,context,identity))&&claimIsCrossover(claimCurrent)){
    notice('This claim was forwarded by the primary payer, so nothing was sent from here and there is no corrected claim to prepare. Open the secondary payment below and review it before it posts.');
    return;
  }
  // Nothing here refuses a fix. A claim that has moved on is simply re-read, and a problem we
  // cannot read is opened anyway with a line saying so, so staff are never stuck behind us.
  const claim=claimCurrent&&(!claimId||claimCurrent.id===claimId)?claimCurrent:await refreshClaimForFix(claimId,context,identity);
  if(!claim)return;
  requireClaimContext(context,claim);captureClaimDraft();
  if(claimLocalBlueDestination(claim)){
   const detail=claimDetailCache(claim);
   if(claimLocalBlueOptions(claim,detail).length)return beginLocalBlueClaimFix(claim.id);
   notice('Review the payer response and the existing BlueCard delivery before creating a follow-up.');return;
  }
  const account=claim.snapshot?.account;
  if(!account){notice('The charges for this claim could not be found. Refresh the claim and try again.');return;}
  const plan=claimFixPlan(claim,field);
  const withMissing=claimFixMissingPlan(plan);
  if(plan.open==='insurance'){
    // The number that came back wrong is the one the insurance in the chart carries, so that is
    // the record opened. The claim keeps its frozen copy and is re-prepared once the plan is right.
    await claimFixInsurance(claim,plan);
    return;
  }
  if(['draft','ready'].includes(claim.status)){
    // Still a draft on our side, so nothing ever reached the payer: this same claim is edited and
    // sent again, with its frequency code already the one for a first claim.
    claimEditor({...account,patient_id:claim.patient_id},claim);
    claimFixFocus(withMissing);
    return;
  }
  // The claim is already on file with somebody, so the corrected claim has to be a new claim
  // linked to this one. Preparing it can be refused for a reason of the server's own — that
  // answer is shown as a warning and the current claim is opened as it stands, never a dead end.
  try{
    const fresh=await api(`/api/v1/patients/${claim.patient_id}/billing`);
    if(!claimContextCurrent(context)||claimCurrent?.id!==claim.id||identity!==(typeof me==='undefined'?undefined:me))return;
    const linked=claim.snapshot?.coordination_of_benefits
      ?{...account,patient_id:claim.patient_id,coverage_snapshot:claim.snapshot.account.coverage_snapshot,content:{...account.content,coverage_id:claim.snapshot.account.content.coverage_id}}
      :{...account,patient_id:claim.patient_id};
    claimEditor({...fresh.accounts.find(a=>a.id===claim.account_id)||linked,patient_id:claim.patient_id},null,null,claim);
    claimFixFocus(withMissing);
  }catch(error){
    const reason=String(error?.message||'').trim();
    claimEditor({...account,patient_id:claim.patient_id},claim);
    claimFixFocus(withMissing,`We could not start the linked corrected claim (${reason||'the practice’s billing data did not answer'}). This claim is opened as it stands — fix what you can here, or ask the practice owner to look at the message.`);
  }
}
// When the claim is missing several things, the boxes named by that list are the ones worth
// focusing: the first of them takes focus, and the form's own notice already lists the rest.
function claimFixMissingPlan(plan){
 if(plan?.focus||plan?.open)return plan;
 const buckets=claimMissingGroupsFor(claimDetailCache(claimCurrent)?.preflight_issues);
 const fields=Array.from(claimMissingFocusFields(buckets));
 if(!fields.length)return plan;
 return {...plan,focus:fields[0],diagnosis:fields.includes('diagnosis_codes')};
}
// Where the fix happens, and what gets focused once the claim editor is open.
// A diagnosis problem is put right on the tick boxes under the charge lines; the claim's own status
// problems focus the box the missing item names.
function claimFixBox(form,plan){
  if(plan?.diagnosis)return form.querySelector?.('[data-diagnosis-line] input[type="checkbox"]');
  return plan?.focus?form.querySelector?.(`[name="${plan.focus}"]`):null;
}
function claimFixFocus(plan,warning=''){
  const host=$('claim-editor')||claimWorkspaceHost();const form=host?.querySelector?.('#claim-editor-form');
  if(!form)return;
  const lines=[plan?.resend?.words,plan?.notice,warning].filter(Boolean);
  if(lines.length)form.insertAdjacentHTML?.('afterbegin',`<section class="mapping-notice" data-claim-fix-notice role="status">${lines.map(line=>`<p>${esc(line)}</p>`).join('')}</section>`);
  const box=claimFixBox(form,plan);
  if(box?.focus){box.focus({preventScroll:true});box.scrollIntoView?.({block:'center'});return;}
  form.querySelector?.('#claim-editor-heading')?.focus?.({preventScroll:true});
}

// the insurance in the chart is opened there — with the claim's own number kept, so the way back is
// one click — rather than pretended away on this form.
async function claimFixInsurance(claim,plan,warning=''){
  const lines=[plan?.resend?.words,plan?.notice,warning].filter(Boolean);
  if(lines.length)notice(lines.join(' '));
  const patient=claim?.patient_id;
  if(!patient||typeof showChartSection!=='function')return;
  if(selected!==patient&&typeof selectPatient==='function'){
    const claimId=claim.id,identity=typeof me==='undefined'?undefined:me;
    await selectPatient(patient,true,()=>me===identity&&claimCurrent?.id===claimId);
    if((typeof me==='undefined'?undefined:me)!==identity||claimCurrent?.id!==claimId)return;
  }
  showChartSection('insurance');
  const box=document.querySelector?.('#coverage-form [name="member_id"]')||document.querySelector?.('#coverage-form [name="subscriber_name"]');
  box?.focus?.({preventScroll:true});
  if(typeof claim?.id!=='undefined')notice(`When the insurance is saved, open claim ${String(claim.control_number||'').trim()||'this claim'} again and use Fix and resend.`);
}
// "Open patient" and "Open insurance" from the claim page: the chart section that holds the record,
// opened for the patient on this claim. A claim page is reached from the claims list, where no
// patient is selected yet, so the chart is loaded first when it has to be.
async function openClaimPatientRecord(patientId,section){
 if(!patientId)return;
 const context=claimContextSnapshot(),identity=typeof me==='undefined'?undefined:me;
 if(selected!==patientId&&typeof selectPatient==='function'){
  await selectPatient(patientId,true,()=>(typeof me==='undefined'?undefined:me)===identity&&claimContextCurrent(context));
  if((typeof me==='undefined'?undefined:me)!==identity||!claimContextCurrent(context))return;
 }
 if(typeof showChartSection==='function')showChartSection(section==='profile'?'profile':'insurance');
}
async function reviewExistingClaimSubmission(id){
 const context=claimContextSnapshot(),claim=claimCurrent,identity=me,patient=selected,visit=typeof activeVisit==='undefined'?null:activeVisit?.id;
 requireClaimContext(context,claim);captureClaimDraft();
 const current=()=>me===identity&&selected===patient&&(typeof activeVisit==='undefined'?null:activeVisit?.id)===visit;
 const opened=await showEdiWorkspace(undefined,current);if(!opened||!current())return;const host=$('edi-detail');
 await showEdiSubmission(id,detail=>{if(!current()||$('edi-detail')!==host)return false;if(detail.submission?.id!==id||detail.submission.claim_id!==claim.id||detail.claim?.id!==claim.id||detail.claim.patient_id!==claim.patient_id)throw new Error('This claim file does not belong to the selected claim.');return true;});
}
function updateClaimStatusSurfaces(claim,context=claimContextSnapshot(),detail={}){
 if(!claimContextCurrent(context)||claim.id!==claimCurrent?.id)return;
 requireClaimContext(context,claim);const host=claimWorkspaceHost(context);if(!host)return;
 // The claim page as it stands, with the next step and the status word replaced where they sit. The
 // panels inside More details keep whatever the person has opened and typed into.
 const sections=[['data-claim-primary',claimPrimaryActionMarkup(claim,detail,{connectionNotice:claimConnectionNotice(claim,detail),secondaryEvidence:secondaryEvidenceMarkup(claim)})],['data-claim-current-status',`<span class="status-badge claim-status-word" data-claim-current-status>${esc(claimPlainStatus(claim,detail))}</span>`],['data-claim-current-version',`<small class="claim-control" data-claim-current-version>${esc(claim.control_number)} · v${claim.version}</small>`]];
 // Each section is swapped where it stands. The page is never written back as a whole: doing that
 // rebuilt every form on it and threw away what was being typed.
 if(typeof HTMLElement!=='undefined'&&host instanceof HTMLElement){
  for(const [attribute,markup] of sections){const node=host.querySelector(`[${attribute}]`);if(node&&node.outerHTML!==markup)node.outerHTML=markup;}
  return;
 }
 const page=host.innerHTML,next=sections.reduce((html,[attribute,markup])=>replaceMarkupSection(html,attribute,markup),page);
 if(next!==page)host.innerHTML=next;
}
// Swaps one labelled section of the drawn page for its new markup, matching on the opening tag so
// the section's own nesting is respected. Returns the page untouched when that section is not on it,
// which is how a refresh stays quiet about a panel the page never drew.
// Swaps one labelled section of the drawn page for its new markup. The attribute is looked for
// inside the opening tag only, and the section's own nesting is walked so a nested element of the
// same kind cannot end the swap early. The page comes back untouched when that section is not on it,
// which is how a refresh stays quiet about a panel the page never drew.
// Swaps one labelled section of the drawn page for its new markup. The attribute is looked for
// inside the opening tag only, and the element is closed by its own end tag or by its own short
// `/>` - whichever comes first, since an empty element such as `<small data-x></small>` has both.
// The nesting of that element's own kind is walked so a nested one cannot end the swap early. The
// page comes back untouched when the section is not on it, which keeps a refresh quiet about a panel
// the page never drew.
function replaceMarkupSection(page,attribute,markup){
 const wants=new RegExp(`\\s${attribute}(?:\\s|=|/?>|$)`,'i');
 let at=-1,name='',selfClosed=false;
 for(const tag of page.matchAll(/<([a-z0-9]+)((?:\s+[^<>]+)*?)(\/?)>/gi)){
  if(wants.test(tag[2])){at=tag.index;name=tag[1];selfClosed=tag[3]==='/';break;}
 }
 if(at<0)return page;
 if(selfClosed)return page.slice(0,at)+markup+page.slice(at+/<[^>]*>/.exec(page.slice(at))[0].length);
 let depth=0,end=page.length,m;
 const scan=new RegExp(`<${name}\\b[^<>]*>|</${name}\\s*>`,'gi');
 scan.lastIndex=at;
 while((m=scan.exec(page))!==null){
  if(m[0][1]==='/'){if(--depth===0){end=scan.lastIndex;break;}}
  else if(!/\/>$/.test(m[0]))depth++;
 }
 return page.slice(0,at)+markup+page.slice(end);
}
async function claimDetailAutoRefreshLoad(){
 const context=claimContextSnapshot();if(!claimContextCurrent(context))return autoRefreshStop();
 const id=context.claim,request=context.detailRequest;if(!id||claimCurrent?.id!==id||request&&(request.kind!=='claim'||request.id!==id))return autoRefreshStop();
 const d=await api(`${claimsBase}/${encodeURIComponent(id)}`);
 if(!claimContextCurrent(context)||context.detailRequest!==request||context.claim!==id||claimCurrent?.id!==id)return;
 if(d?.claim?.id!==id)throw new Error('Claim status response did not match this claim.');
 if(d.claim.version<claimCurrent.version)return;
 requireClaimContext(context,d.claim);claimCurrent=d.claim;claimDetailOnScreen={claimId:id,detail:d};
 updateClaimStatusSurfaces(d.claim,context,d);
 return claimFinalStatus(d.claim,d)?autoRefreshStop():undefined;
}
function registerClaimDetailAutoRefresh(){
 if(typeof registerAutoRefresh!=='function')return;
 const host=claimWorkspaceHost();if(!host)return;
 unregisterAutoRefresh('claim-status');
 registerAutoRefresh('claim-status',{host,load:claimDetailAutoRefreshLoad,everyMs:30000});
}
// Fills the timeline container once the claim screen is on screen. It never throws:
// a provider that will not answer leaves the rest of the claim screen working.
async function insertClaimStatusTimeline(context,claim,detail,history){
 // Resolved at call time, and through globalThis: the file order in index.html gives
 // this file a top-level function, while a test may install the builder afterwards.
 const build=globalThis.claimTimelineSection;if(typeof build!=='function')return;
 const host=claimWorkspaceHost(context);
 // The "Why it came back" box is rendered inside the claim pane markup, so look for it
 // there and sit the timeline directly under it. The lifecycle panel is inserted later
 // and separately, so its own anchor stays the fallback.
  const pane=host?.querySelector?.('.billing-account-detail');
  const box=pane?.querySelector?.('[data-claim-problem-box]');
  // "What happened" belongs under More details; the rejection box and the lifecycle panel are the
  // anchors we fall back to when the screen is drawn without it.
  const anchor=box||host?.querySelector?.('[data-claim-more-details]')||host?.querySelector?.('.claim-lifecycle')||pane?.querySelector?.('.section-head');
  if(!anchor?.insertAdjacentHTML)return;
  // Directly under the rejection box when there is one; inside More details, before everything
  // else, otherwise.
  anchor.insertAdjacentHTML(box?'afterend':'beforebegin','<div class="claim-status-timeline-host" data-claim-timeline><p class="muted">Reading what happened to this claim…</p></div>');
 const slot=host.querySelector('[data-claim-timeline]'),identity=typeof me==='undefined'?undefined:me;
 let html='<p class="muted">What happened to this claim is not available right now. The claim details below are unaffected.</p>';
 try{const built=await build(claim,detail,history,{syncClearinghouse:claim.status!=='void'&&!context.savedActivityOnly});if(built)html=built;}catch{}
 // Another claim may have opened while the provider was answering; never write a
 // stale timeline into the container of the claim now on screen.
 if(claim!==claimCurrent||(typeof me!=='undefined'&&me!==identity)||!slot?.isConnected)return;
 slot.innerHTML=html;
}
// The insurer's or clearinghouse's own wording for a claim that came back, newest answer first.
function claimResponseWords(detail={}){
  const reports=(detail.tracking?.reports||[]).map(report=>String(report?.evidence?.message?.message||'').trim()).filter(Boolean).reverse();
  // Answers arrive three ways: the clearinghouse feed, the payer's own status report, and what staff
  // typed when they recorded the answer by hand. All three are the message the practice received.
  const feed=(detail.responses?.feed||[]).map(entry=>String(entry?.message||'').trim());
  const revisions=(detail.responses?.revisions||[]).map(item=>String(item?.message||item?.reason||'').trim());
  const recorded=(detail.history?.items||[]).filter(item=>item?.evidence?.action==='record_rejection'||String(item?.reason||'').toLowerCase().includes('reject')).map(item=>String(item.reason||'').trim());
  return [...new Set([...reports,...feed,...revisions,...recorded].filter(Boolean))].join(' ');
}
// The one status word, the claim's headline line. The claim number and version stay in their own
// marked nodes so an automatic refresh can update them without touching the rest of the screen.
function claimScreenHeadMarkup(claim,account,patient,detail={}){
 return `<div class="section-head claim-screen-head"><div><h2>Claim review</h2><p class="claim-screen-who"><b>${esc(patient.given_name)} ${esc(patient.family_name)}</b> · Service ${esc(displayDate(account.content.service_date))} · ${esc(account.coverage_snapshot?.payer?.content?.name||'No insurer recorded')} · ${money(account.total_cents)}</p><small class="claim-control" data-claim-current-version>${esc(claim.control_number)} · v${claim.version}</small></div><div class="support-help-group"><span class="status-badge claim-status-word" data-claim-current-status>${esc(claimPlainStatus(claim,detail))}</span>
${typeof supportHelpButton==='function'?supportHelpButton('claim',`data-support-claim="${esc(claim.id)}" data-support-claim-label="${esc(claim.control_number)}" data-support-patient="${esc(claim.patient_id)}" data-support-patient-label="${esc(patient.family_name)}, ${esc(patient.given_name)} · MRN ${esc(patient.mrn)}"`):''}</div></div>`;
}
// Where the Claim.MD panels put themselves: inside More details when it is open, and where they
// have always gone otherwise. A stub screen with no panels simply puts them on the claim pane.
function claimPanelAnchor(host){
 const more=host?.querySelector?.('[data-claim-more-details]');
 if(more?.insertAdjacentHTML&&host?.querySelector?.('[data-claim-more="claim-progress"] .claim-lifecycle, [data-claim-more="claim-progress"] .claimmd-claim-activity'))return more;
 return host?.querySelector?.('.billing-account-detail')||host;
}
function claimScreenMarkup(claim,detail,history){
 const account=claim.snapshot.account,patient=claim.snapshot.patient;
 const readOnly=claimViewContext?.historyOnly===true;
 const active=typeof claimWorklistActive==='function'?claimWorklistActive(claim):null;
 const earlier=typeof claimWorklistAttempts==='function'?claimWorklistAttempts(claim):[];
 const earlierMarkup=earlier.length?`<ul class="claim-history-list">${earlier.filter(row=>row.id!==active?.id).map(row=>`<li><button type="button" data-claim-open="${esc(row.id)}" data-claim-intent="history">${esc(row.control_number||'Open attempt')} · ${esc(displayStatus(row.status))}</button></li>`).join('')}</ul>`:'';
 const missing=claimMissingGroupsFor(claimIsCrossover(claim)?[]:detail.preflight_issues);
 const recordOutside=!readOnly&&billingWrite()&&!claimIsCrossover(claim)&&['draft','ready','submitted','accepted'].includes(claim.status)?claimRecordedOutsideMarkup(claim):'';
 const withdraw=!readOnly&&billingWrite()&&claimIsCrossover(claim)&&['submitted','accepted','rejected'].includes(claim.status)?`<form id="claim-action"><h3>Remove a wrong crossover link</h3><input type="hidden" name="action" value="withdraw_crossover"><p>You can remove this link only while the secondary payment is not posted. The payment can be linked again later.</p>${billingField('reason','Reason for removing this link','','text',1000,true)}<button type="submit">Remove crossover link</button></form>`:'';
 const sections={recordOutside,providerDetails:claimProviderDetailsMarkup(claim),coverageRecord:claimCoverageRecordMarkup(claim),history:earlierMarkup+claimCoverageAndRouteMarkup(claim)+claimHistory(history),responseWords:claimRawResponseMarkup(detail),secondaryEvidence:secondaryEvidenceMarkup(claim)};
 const lines=chargeTable(account.content.lines.map((line,index)=>({...line,diagnosis_codes:(claim.content?.line_diagnosis_pointers?.[index]||[]).map(pointer=>claim.content?.diagnosis_codes?.[pointer-1]).filter(Boolean)})));
 const editClaim=!readOnly&&billingWrite()&&claim.status==='draft'?'<button type="button" data-edit-claim>Edit claim details</button>':'';
 const inVisit=claimViewContext?.kind==='encounter';
 const charges=inVisit?'':`${claimMoneySummaryMarkup(claim,detail)}<div class="claim-lines" data-claim-lines>${lines}</div>`;
 const blueOptions=claimLocalBlueOptions(claim,detail);
 const routeBlocked=claim.status==='rejected'&&claimLocalBlueDestination(claim)&&!blueOptions.length;
 const problemMarkup=typeof claimProblemReport==='function'?claimProblemBoxMarkup(claimProblemReport(claim,detail),claimResponseWords(detail),claim.id,blueOptions.length>0):'';
 return `<section class="billing-account-detail">${claimScreenHeadMarkup(claim,account,patient,detail)}
 ${claimCoverageAndRouteMarkup(claim)}
 ${readOnly?`<p class="mapping-notice">Earlier attempt · review only</p>${active&&active.id!==claim.id?`<button type="button" class="primary" data-claim-open="${esc(active.id)}">View current attempt</button>`:''}`:routeBlocked?`<section class="mapping-notice"><h3>BlueCard follow-up needs review</h3>${claimRawResponseMarkup(detail)}</section>`:problemMarkup}
 ${readOnly?'':claimPrimaryActionMarkup(claim,detail,{connectionNotice:claimConnectionNotice(claim,detail),secondaryEvidence:sections.secondaryEvidence,recordOutside})}
 ${readOnly?'':claimIsCrossover(claim)?'<p class="muted">Nothing is sent or downloaded for a crossover claim. The secondary payment stays with the original visit.</p>':['void','voided'].includes(claim.status)?'':claimMissingMarkup(missing,claim,detail)}
 ${claim.status==='void'&&charges?`<details class="amendment" data-inline><summary>Original claim charges</summary>${charges}</details>`:charges}
 ${withdraw}
 ${claimMoreDetailsMarkup(claim,detail,history,sections)}
 ${inVisit||readOnly?'':`<div class="actions"><button type="button" data-claim-account="${esc(claim.account_id)}" data-patient="${esc(claim.patient_id)}">Open encounter</button>${editClaim}</div>`}
 <div id="claim-editor"></div></section>`;
}
async function showClaim(id,{historyOnly=false,loadActivity=true}={}){
 const context=claimContextSnapshot(),identity=typeof me==='undefined'?undefined:me;
 const request={kind:'claim',id};context.detailRequest=request;
 const current=()=>context.detailRequest===request&&claimContextCurrent(context)&&identity===(typeof me==='undefined'?undefined:me);
 const [d,h]=await Promise.all([api(`${claimsBase}/${id}`),api(`${claimsBase}/${id}/history`)]);if(!current())return;
 if(d.claim?.id!==id)throw new Error('The claim response does not match the selected claim.');
 requireClaimContext(context,d.claim);claimCurrent=d.claim;context.claim=d.claim.id;
 const active=typeof claimWorklistActive==='function'&&context.kind==='worklist'?claimWorklistActive(d.claim):null;
 context.historyOnly=historyOnly||!!(active&&active.id!==id);
 claimPane(claimScreenMarkup(d.claim,d,h),{request,quiet:context.savedActivityOnly});claimDetailOnScreen={claimId:d.claim.id,detail:d};
  // The Claim.MD panels and the "what happened" timeline are filled in after the screen is drawn,
  // and sit inside More details. Each is left alone when its own script is not loaded.
  const claim=d.claim;
  const lifecycle=!context.historyOnly&&claim.status!=='void'&&typeof claimMdClaimLifecycle==='function'?claimMdClaimLifecycle(claim,d,h,{responsesOpen:context.savedActivityOnly?false:undefined}):'';
  if(lifecycle){const anchor=claimPanelAnchor(claimWorkspaceHost(context));if(anchor?.insertAdjacentHTML)anchor.insertAdjacentHTML('beforeend',`<section class="claim-more-item" data-claim-more="claim-progress"><h3>Claim progress</h3>${lifecycle}</section>`);}
  // "What happened" gets its own container, placed after the rejection box above the
  // lifecycle panel, so the other panels can be replaced without touching it.
  insertClaimStatusTimeline(context,claim,d,h);
  const action=$('claim-action');if(action){action.claimViewContext=context;action.claimRecord=claim;}
  if(!context.historyOnly&&typeof startClaimMdTracking==='function')startClaimMdTracking(claim.id);
  if(loadActivity&&!context.historyOnly&&typeof showClaimMdClaimActivity==='function')await showClaimMdClaimActivity(claim);
  if(!current())return;
  if(!context.savedActivityOnly)claimProgressToHead(claimWorkspaceHost(context));
  if(claimContextCurrent(context)&&context?.kind!=='encounter')claimDetailTabs(claimWorkspaceHost(context));
  if(typeof registerAutoRefresh==='function'){if(!context.historyOnly&&['submitted','accepted','adjudicated'].includes(claim.status)&&claimContextCurrent(context)&&context.kind==='worklist')registerClaimDetailAutoRefresh();else unregisterAutoRefresh('claim-status');}
 return d;
}
async function openWorklistClaim(id,intent={},launcher){
 const context=claimContextSnapshot();requireClaimContext(context);
 if(context.kind!=='worklist')return showClaim(id,intent);
 if(!context.drawer){
  const host=document.createElement('div');host.className='worklist-claim-detail';host.setAttribute('data-worklist-claim-detail','');
  const dialog=sheetOpen('Claim',host,{className:'chart-record-sheet signed-claim-dialog',label:true});
  dialog.dataset.worklistClaimDialog='';context.drawer=dialog;context.drawerHost=host;
  dialog.canCloseSheet=()=>{
   if(host.querySelector('#claimmd-submit-form')?.claimSubmitting)return false;
   if(context.heldEditor?.dirty()){void context.heldEditor.close().then(saved=>{if(saved)sheetClose(dialog);});return false;}
   const quickFix=host.querySelector('#claim-quick-fix');
   if(quickFix?.claimInlineDirty?.()&&quickFix.checkValidity()){
    void quickFix.claimInlineSave().then(saved=>{if(saved)sheetClose(dialog);});return false;
   }
   captureClaimDraft();return true;
  };
  dialog.addEventListener('close',()=>{
   context.drawer=null;context.drawerHost=null;context.heldEditor=null;context.historyOnly=false;context.detailRequest=null;
   if(claimContextCurrent(context)){launcher?.focus({preventScroll:true});void claimsAutoRefreshLoad().catch(()=>{});}
  },{once:true});
  dialog.addEventListener('click',event=>{
   const held=event.target.closest('[data-worklist-held-fix]');
   if(!held||context.historyOnly||!claimContextCurrent(context))return;
   event.preventDefault();void openWorklistHeldFix(context,{index:Number(held.dataset.worklistHeldFix),code:held.dataset.procedure});
  });
 }
 if(context.heldEditor?.dirty()&&!await context.heldEditor.close())return;
 const quickFix=context.drawerHost.querySelector('#claim-quick-fix');
 if(quickFix?.claimInlineDirty?.()&&quickFix.checkValidity()&&!await quickFix.claimInlineSave())return;
 context.heldEditor=null;
 captureClaimDraft();
 const direct=['send','missing','correction'].includes(intent.kind);
 const detail=await showClaim(id,{historyOnly:intent.kind==='history',loadActivity:!direct});
 if(!detail||!claimContextCurrent(context)||context.claim!==id||context.historyOnly)return;
 if(intent.kind==='correction')await openWorklistHeldFix(context,{index:intent.line,code:intent.procedure});
 if(intent.kind==='send'&&billingWrite())await openClaimMdSubmissionReview(id,{releaseDraft:true,expectedVersion:detail.claim.version});
 if(intent.kind==='missing'&&billingWrite()){
  if(context.drawerHost.querySelector('#claim-quick-fix'))openClaimQuickFix();
  else if(detail.submission_issues?.length&&!detail.preflight_issues?.length)await openClaimMdSubmissionReview(id,{releaseDraft:true,expectedVersion:detail.claim.version});
 }
}
async function openWorklistHeldFix(context,line){
 const detail=claimDetailCache(claimCurrent),savedLine=detail?.claimmd_position?.correction?.line;
 if(!context.drawer||line.index!==savedLine?.index||line.code!==savedLine?.code||typeof mountVisitSignedHeldEditor!=='function')return;
 const claimId=context.claim,host=context.drawerHost;
 if(!context.heldEditor)context.heldEditor=mountVisitSignedHeldEditor(context.drawer,host,{
  claimId,current:()=>claimContextCurrent(context)&&context.claim===claimId,
  ctx:{canWrite:billingWrite(),claimsAllowed:true},panels:[host.querySelector('.billing-account-detail')]
 });
 await context.heldEditor.open(line);
}
function claimChargeDiagnosisDefaults(account){
 const diagnosisCodes=[],pointers=(account.content.lines||[]).map(line=>{
  const saved=(Array.isArray(line.diagnosis_codes)?line.diagnosis_codes:[]).filter(code=>typeof code==='string'&&code.trim()),codes=typeof diagnosisCodeList==='function'?diagnosisCodeList(saved.flatMap(code=>code.split(','))):[...new Set(saved.map(code=>code.trim()))];
  return codes.map(code=>{let index=diagnosisCodes.indexOf(code);if(index<0){index=diagnosisCodes.length;diagnosisCodes.push(code);}return index+1;});
 });
 return {diagnosis_codes:diagnosisCodes,line_diagnosis_pointers:pointers};
}
// Secondary plans offered for this claim, and the picker that replaces the old dropdown.
// Staff type the insurer's name and the matching plans narrow as they type. The hidden
// coverage_id keeps the value the secondary claim is built from; the box shows the name.
// The step is drawn from records that each carry the plan and the insurer it belongs to, so the
// rows are named once here and read back by the form's own save path — no reaching into the
// insurance screen's records, and no guessing at a plan from a name typed by hand.
let secondaryCoverageRows=[];
// The insurer a plan belongs to, taken from the record the step was drawn with.
function secondaryPayerName(choice){
 const payer=choice?.payer;
 return (payer&&(payer.content?.name||payer.name))||'Recorded insurer';
}
function secondaryCoverageRowsFor(choices){
 return (choices||[]).map(choice=>({
  id:choice.coverage.id,
  name:secondaryPayerName(choice),
  detail:`${human(choice.coverage.content.priority)} · Member ${choice.coverage.content.member_id}`,
 }));
}
function typeaheadCoverageOptions(){return secondaryCoverageRows;}
function coveragePickerMarkup(choices){
 typeaheadProvide('typeaheadCoverageOptions',typeaheadCoverageOptions);
 const context=claimContextSnapshot();
 context.secondaryChoices=choices;
 secondaryCoverageRows=secondaryCoverageRowsFor(choices);
 return `<label>Secondary insurance<input type="text" id="secondary-coverage-name" name="coverage_name" maxlength="200" required autocomplete="off" spellcheck="false" placeholder="Start typing a name" data-typeahead-coverage>${typeaheadMarkup('coverage','secondary-coverage-name')}</label>`;
}
// Reads back the plan the name box stands for: the id the picker filled in, or the one plan
// whose name matches exactly what staff typed.
function secondaryChosenCoverageId(form,values){
 if(values.coverage_id)return values.coverage_id;
 const typed=String(values.coverage_name||'').trim().toLowerCase();
 if(!typed)return '';
 const exact=secondaryCoverageRows.filter(choice=>choice.name.trim().toLowerCase()===typed);
 return exact.length===1?exact[0].id:'';
}
function secondaryEvidenceMarkup(claim){
 const e=claim.snapshot?.coordination_of_benefits;if(!e)return '';
 return `<section class="mapping-notice"><h3>Secondary claim · same visit charges</h3><p>Primary: ${esc(e.primary_coverage?.payer?.content?.name||'Recorded primary payer')} · Paid ${money(e.adjudication.paid_cents)} · Patient responsibility reported ${money(e.adjudication.patient_responsibility_cents)} · Paid on ${esc(e.payment_date)}</p><p>Primary claim ${esc(e.adjudication.payer_control_number)} · Trace number ${esc(e.trace)}</p><p>${e.crossover?'Link confirmed':'Crossover and timing confirmed'}: ${esc(e.crossover_reference)}</p>${e.crossover?`<p>Secondary response ${esc(e.crossover.payment_date)} · Trace ${esc(e.crossover.trace)} · Payee NPI ${esc(e.crossover.payee_npi)} · Paid ${money(e.crossover.claim.paid_cents)}</p>`:''}<details><summary>Primary payment and adjustments</summary><pre class="billing-source">${esc(JSON.stringify(e.adjudication,null,2))}</pre></details><p class="muted">No new charges were created. ${e.crossover?'The secondary payment (835) is linked here to review and post, and no claim was sent.':'The secondary payer gets the original charges and the primary payer result.'}</p></section>`;
}
async function reviewSecondaryClaim(){
 const context=claimContextSnapshot(),primary=claimCurrent;requireClaimContext(context,primary);captureClaimDraft();
 const data=await api(`${claimsBase}/${primary.id}/secondary-review`);if(!claimContextCurrent(context)||claimCurrent?.id!==primary.id)return;requireClaimContext(context,data.primary_claim);
 const existing=data.existing_secondary_claims||[],choices=(data.coverages||[]).filter(item=>!existing.some(c=>c.payer_id===item.payer.id)),adjudication=data.primary_adjudication,row=adjudication?.claim;
 const crossover=crossoverReviewMarkup(data,choices);
 const html=`<section><h3>Bill secondary insurance</h3><p>This bills the same ${money(data.account.total_cents)} in visit charges. Check the primary EOB/ERA first to see whether the primary payer already forwarded the claim.</p>${existing.map(c=>`<p>Existing secondary claim ${esc(c.control_number)} · ${esc(c.status)} <button type="button" data-claim-open="${esc(c.id)}">Review existing secondary claim</button></p>`).join('')}${claimIssues(data.blockers||[])}${row?`<p>Primary paid ${money(row.paid_cents)} · Patient responsibility reported ${money(row.patient_responsibility_cents)} · ${esc(adjudication.payment_date)} · Trace ${esc(adjudication.trace)}</p><details><summary>Review primary services and adjustments</summary><pre class="billing-source">${esc(JSON.stringify(row,null,2))}</pre></details>`:''}${crossover}${!(data.blockers||[]).length&&choices.length&&row?`<form id="secondary-claim-review">${coveragePickerMarkup(choices)}<p class="muted">Enter the units the primary payer paid for each service, from the EOB.</p>${row.services.map((line,i)=>`<label>Primary line ${i+1}: ${esc(line.code)} · Paid ${money(line.paid_cents)} · Paid units<input name="paid_units_${i}" type="number" required min="1" max="1000" step="1"></label>`).join('')}<label class="review-ack"><input name="not_forwarded" type="checkbox" required> I reviewed the EOB/ERA and the primary payer has not forwarded this claim to the secondary payer.</label><label class="review-ack"><input name="timing_reviewed" type="checkbox" required> I confirmed when the secondary payer accepts this claim, including any waiting period (Medicare and Blue plan crossover may have one).</label><label>How you confirmed this (EOB date, call reference or portal)<input name="crossover_reference" required maxlength="1000"></label><button type="submit" class="primary">Continue</button></form>`:!choices.length?'<p>No other active secondary insurance is on file for this encounter date. Add it under Insurance, or open the existing secondary claim above.</p>':''}</section>`;
 const host=$('claim-editor');if(!host)return;host.innerHTML=html;
 typeaheadInit(host);
 const form=$('secondary-claim-review');if(form){form.claimViewContext=context;form.secondaryReview=data;form.secondaryChoices=choices;form.primaryClaimId=primary.id;}
 const crossoverForm=$('crossover-claim-review');if(crossoverForm){crossoverForm.claimViewContext=context;crossoverForm.secondaryReview=data;crossoverForm.secondaryChoices=choices;crossoverForm.primaryClaimId=primary.id;}
 host.scrollIntoView({block:'start'});
}

function claimPatientAddressDefault(account){
 if(typeof workspace==='undefined'||typeof selected==='undefined'||!account.patient_id||selected!==account.patient_id||workspace.patient?.id!==account.patient_id||workspace.demographics?.patient_id!==account.patient_id)return '';
 const address=workspace.demographics.content?.address;
 if(!address||typeof address!=='object'||Array.isArray(address))return '';
 const parts=['line1','line2','city','region','postal_code','country'].map(key=>address[key]);
 if(parts.some(value=>value!=null&&typeof value!=='string'))return '';
 return parts.filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()).join(', ');
}
// The diagnoses that apply to each charge line, as ticks against this claim's own diagnosis codes -
// the boxes replace the hand-typed pointer numbers, and the form still submits the same pointer
// positions the server expects. Up to four per line, in the order the codes are listed.
const claimLineDiagnosisLimit=4;
// Positions are counted against the list the claim itself carries, so the numbers written down can
// only ever point at what the form showed.
function claimDiagnosisChoices(content){
 return (Array.isArray(content?.diagnosis_codes)?content.diagnosis_codes:[]).map(code=>String(code??'').trim()).filter(Boolean).slice(0,12);
}
// The codes the boxes offer for a fresh claim: the ones recorded against the charges, cleaned the
// same way the rest of billing cleans a typed list.
function claimChargeDiagnosisCodes(lines){
 const typed=(lines||[]).flatMap(line=>Array.isArray(line?.diagnosis_codes)?line.diagnosis_codes:[]).map(code=>String(code??''));
 return typeof diagnosisCodeList==='function'?diagnosisCodeList(typed).slice(0,12):typed.map(code=>code.trim()).filter(Boolean).slice(0,12);
}
// The codes one line points at. A pointer outside the list is dropped rather than guessed at, so a
// stale claim still shows its other lines correctly.
function claimLineCheckedCodes(codes,pointers){
 return (Array.isArray(pointers)?pointers:[]).map(pointer=>codes[pointer-1]).filter(Boolean);
}
// The claim's diagnoses are picked, never typed as a list: each one is a chip that can be removed,
// and a search box finds the next one by code or name. The chosen codes travel in one hidden
// field, in order, so the first is still the primary diagnosis.
// Where the service was given is chosen from the standard list, not typed as a two-digit code.
// A code already on the claim that is not in the list stays selectable, so nothing is lost.
const CLAIM_PLACES_OF_SERVICE=[['11','Office'],['02','Telehealth, patient not at home'],['10','Telehealth, patient at home'],['12','Patient’s home'],['19','Hospital outpatient, off campus'],['21','Hospital inpatient'],['22','Hospital outpatient, on campus'],['23','Emergency room'],['24','Ambulatory surgical center'],['31','Skilled nursing facility'],['32','Nursing facility'],['49','Independent clinic'],['81','Independent laboratory'],['99','Other place of service']];
function claimPlaceOfServiceField(value){
 const current=String(value||'').trim()||'11',rows=CLAIM_PLACES_OF_SERVICE.some(([code])=>code===current)?CLAIM_PLACES_OF_SERVICE:[[current,'Code on this claim'],...CLAIM_PLACES_OF_SERVICE];
 return selectField('place_of_service','Place of service',rows.map(([code])=>code),current,rows.map(([code,label])=>`${code} · ${label}`));
}
const claimDiagnosisPickerLimit=12;
function claimDiagnosisPickerChips(codes){
 return codes.length?codes.map((code,index)=>`<li><b>${esc(code)}</b>${index===0?'<small>primary</small>':''}<button type="button" data-claim-dx-remove="${esc(code)}" aria-label="Remove ${esc(code)}">×</button></li>`).join(''):'<li class="muted claim-dx-none">No diagnosis yet. Search below to add one.</li>';
}
function claimDiagnosisPickerMarkup(codes){
 const list=(Array.isArray(codes)?codes:[]).map(code=>String(code??'').trim()).filter(Boolean).slice(0,claimDiagnosisPickerLimit);
 return `<div class="claim-dx-picker" data-claim-dx><span class="claim-dx-label" id="claim-dx-label">Diagnoses (ICD-10)</span><ul class="claim-dx-chips" aria-labelledby="claim-dx-label" data-claim-dx-chips>${claimDiagnosisPickerChips(list)}</ul><input type="hidden" name="diagnosis_codes" value="${esc(list.join(', '))}"><div class="claim-dx-add"><label class="sr-only" for="claim-dx-search">Search a diagnosis to add</label><input type="search" id="claim-dx-search" placeholder="Search a diagnosis by code or name" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="claim-dx-results" data-claim-dx-search><ul id="claim-dx-results" class="claim-dx-results" role="listbox" hidden></ul><p class="muted claim-dx-status" role="status" data-claim-dx-status></p></div></div>`;
}
function claimDiagnosisPickerCodes(form){return String(form?.elements?.diagnosis_codes?.value||'').split(',').map(code=>code.trim()).filter(Boolean);}
// The chosen list changed: redraw the chips and the per-line ticks, keeping every tick whose
// diagnosis is still on the claim.
function claimDiagnosisPickerSet(form,codes){
 const ticked=Array.from(form.querySelectorAll('[data-diagnosis-line]')).map(row=>Array.from(row.querySelectorAll('input:checked')).map(box=>box.value));
 form.elements.diagnosis_codes.value=codes.join(', ');
 const chips=form.querySelector('[data-claim-dx-chips]');if(chips)chips.innerHTML=claimDiagnosisPickerChips(codes);
 const account=form.claimAccount||claimAccount,old=form.querySelector('.claim-line-diagnosis,.claim-line-diagnosis-empty');
 if(account&&old){const holder=document.createElement('div');holder.innerHTML=claimLineDiagnosisMarkup(account,{diagnosis_codes:codes,line_diagnosis_pointers:ticked.map(row=>row.map(code=>codes.indexOf(code)+1).filter(Boolean))});if(holder.firstElementChild)old.replaceWith(holder.firstElementChild);}
 if(typeof captureClaimDraft==='function')captureClaimDraft(form);
}
let claimDiagnosisSearchTimer=null,claimDiagnosisSearchRun=0;
function claimDiagnosisSearchClose(form){const list=form.querySelector('#claim-dx-results'),box=form.querySelector('[data-claim-dx-search]');if(list){list.hidden=true;list.innerHTML='';}box?.setAttribute('aria-expanded','false');}
async function claimDiagnosisSearch(form,query){
 const run=++claimDiagnosisSearchRun,list=form.querySelector('#claim-dx-results'),status=form.querySelector('[data-claim-dx-status]'),box=form.querySelector('[data-claim-dx-search]');if(!list)return;
 const serviceDate=(form.claimAccount||claimAccount)?.content?.service_date,params={system:'ICD-10-CM',q:query,billable:'true',active:'true',limit:'12'};if(/^\d{4}-\d{2}-\d{2}$/.test(serviceDate||''))params.service_date=serviceDate;
 let result=null;try{result=await api(`/api/v1/terminology/codes?${new URLSearchParams(params)}`);}catch{}
 if(run!==claimDiagnosisSearchRun||!form.isConnected)return;
 const chosen=new Set(claimDiagnosisPickerCodes(form)),items=(result?.items||[]).filter(item=>item?.code&&!chosen.has(item.code));
 list.innerHTML=items.map(item=>`<li role="option"><button type="button" data-claim-dx-add="${esc(item.code)}"><b>${esc(item.code)}</b> ${esc(item.display||item.description||'')}</button></li>`).join('');
 list.hidden=!items.length;box?.setAttribute('aria-expanded',String(items.length>0));
 if(status)status.textContent=!result?'The code list could not be searched. Try again.':items.length?'':'No diagnosis matches.';
}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('input',event=>{const box=event.target;if(!box?.hasAttribute?.('data-claim-dx-search'))return;const form=box.closest('form'),query=String(box.value||'').trim();clearTimeout(claimDiagnosisSearchTimer);if(query.length<2){claimDiagnosisSearchRun++;claimDiagnosisSearchClose(form);const status=form.querySelector('[data-claim-dx-status]');if(status)status.textContent='';return;}claimDiagnosisSearchTimer=setTimeout(()=>void claimDiagnosisSearch(form,query),200);});
 document.addEventListener('click',event=>{
  const add=event.target?.closest?.('[data-claim-dx-add]'),remove=event.target?.closest?.('[data-claim-dx-remove]'),target=add||remove;if(!target?.dataset)return;
  const form=target.closest('form');if(!form?.elements?.diagnosis_codes)return;event.preventDefault();
  const codes=claimDiagnosisPickerCodes(form);
  if(add){const code=add.dataset.claimDxAdd,status=form.querySelector('[data-claim-dx-status]');if(codes.length>=claimDiagnosisPickerLimit){if(status)status.textContent=`A claim holds up to ${claimDiagnosisPickerLimit} diagnoses. Remove one first.`;return;}if(!codes.includes(code))codes.push(code);claimDiagnosisPickerSet(form,codes);const box=form.querySelector('[data-claim-dx-search]');if(box){box.value='';box.focus?.();}claimDiagnosisSearchClose(form);return;}
  claimDiagnosisPickerSet(form,codes.filter(code=>code!==remove.dataset.claimDxRemove));
 });
 document.addEventListener('keydown',event=>{const box=event.target;if(!box?.hasAttribute?.('data-claim-dx-search'))return;if(event.key==='Enter'){event.preventDefault();box.closest('form')?.querySelector('[data-claim-dx-add]')?.click();}else if(event.key==='Escape'){const form=box.closest('form');if(form&&!form.querySelector('#claim-dx-results')?.hidden){event.stopPropagation();claimDiagnosisSearchClose(form);}}});
}
function claimLineDiagnosisMarkup(account,content){
 const codes=claimDiagnosisChoices(content);
 const pointers=Array.isArray(content.line_diagnosis_pointers)?content.line_diagnosis_pointers:[];
 if(!codes.length)return '<p class="muted claim-line-diagnosis-empty">Add a diagnosis above first, then tick which ones apply to each charge line.</p>';
 return `<fieldset class="claim-line-diagnosis"><legend>Which diagnoses apply to each line</legend><p class="muted">Tick up to ${claimLineDiagnosisLimit} for each charge line. The first one ticked is the main reason for that line.</p>${account.content.lines.map((line,index)=>{
  const checked=new Set(claimLineCheckedCodes(codes,pointers[index]));
  return `<div class="claim-line-diagnosis-row" data-diagnosis-line="${index}"><b>Line ${index+1}: ${esc(line.code)}</b><div class="scope-options">${codes.map(code=>`<label><input type="checkbox" name="diagnosis_line_${index}" value="${esc(code)}" ${checked.has(code)?'checked':''}>${esc(code)}</label>`).join('')}</div></div>`;
 }).join('')}</fieldset>`;
}
// Reads the ticks back into pointer positions, numbered against the codes the claim carries and
// never more than four to a line.
function claimLineDiagnosisValues(form,pointed,lineCount){
 return Array.from({length:lineCount},(_,index)=>{
  const ticked=Array.from(form?.querySelectorAll?.(`[name="diagnosis_line_${index}"]:checked`)||[]).map(box=>String(box.value));
  return pointed.map((code,position)=>position+1).filter(position=>ticked.includes(pointed[position-1])).slice(0,claimLineDiagnosisLimit);
 });
}
function claimLocalBlueReviewMarkup(options,account,parent){
 const choices=options.map(option=>`<option value="${esc(option.payer_id)}">${esc(option.payer_name)} · ${esc(option.payer_code)}</option>`).join('');
 const route=options[0],home=account.coverage_snapshot?.payer?.content?.name||'Insurance on file';
 const destination=options.length===1?`<p><b>Claim destination</b> ${esc(route.payer_name)} · ${esc(route.payer_code)}</p><input type="hidden" name="local_blue_payer_id" value="${esc(route.payer_id)}">`:
  `<label>Claim destination<select name="local_blue_payer_id" required><option value="">Choose the local Blue plan</option>${choices}</select></label>`;
 const keepsRoute=Boolean(route.retains_existing_route);
 return `<fieldset class="mapping-notice" data-claim-local-blue-review><legend>Local Blue routing</legend><p><b>Insurance coverage</b> ${esc(home)}</p>${destination}
 <p>${parent.content?.synthetic_test?'The previous claim was marked Test. ':''}${keepsRoute?'The correction keeps this destination and uses the posted charges.':'The new claim uses the posted charges and the insurance on file.'} Claim.MD or the payer may return it if billing enrollment is pending.</p>
 <label class="review-ack"><input type="checkbox" name="local_blue_route_reviewed" required> I checked the card's local Blue instructions and reviewed the billing NPI and tax ID for this claim.</label></fieldset>`;
}
function claimEditor(b,c=null,source=null,parent=null,coordination=null,localBlueOptions=[]){
 captureClaimDraft();b={...b,patient_id:b.patient_id||c?.patient_id||parent?.patient_id};
 const context=claimContextSnapshot();requireClaimContext(context,c||parent||{patient_id:b.patient_id,account_id:b.id});
 const visitId=b.content.visit_id;
 const assignedVisit=!visitId?null:(typeof activeVisit!=='undefined'&&activeVisit?.id===visitId?activeVisit:null)||
  (typeof workspace!=='undefined'?workspace?.visits?.find(visit=>visit.id===visitId):null)||{id:visitId};
 claimAccount=b;claimSource=source;const defaults=typeof claimmdClaimProviderDefaults==='function'?claimmdClaimProviderDefaults(assignedVisit,b.content.claim_details):{},coverage=b.coverage_snapshot?.coverage?.content||{},patientAddress=source?'':claimPatientAddressDefault(b),diagnoses=source?{diagnosis_codes:[],line_diagnosis_pointers:b.content.lines.map(()=>[])}:claimChargeDiagnosisDefaults(b);const v=c?.content||(coordination?{...parent.content,subscriber_address:coverage.relationship==='self'?parent.content.patient_address:'',subscriber_birth_date:coverage.subscriber_birth_date||'',external_control_number:''}:parent?.content)||{billing_provider_name:defaults.billing_provider_name||'',billing_npi:defaults.billing_npi||'',tax_id:'',billing_address:defaults.billing_address||'',rendering_npi:defaults.rendering_npi||'',patient_address:patientAddress,subscriber_address:coverage.relationship==='self'?patientAddress:'',subscriber_birth_date:coverage.subscriber_birth_date||'',place_of_service:'',...diagnoses,external_control_number:'',notes:'',synthetic_test:false};
 const localBlue=localBlueOptions.length>0,liveRoute=localBlue||Boolean(claimLocalBlueDestination(c));
 const continueToReview=localBlue||!!context.drawer&&parent?.status==='rejected'&&!coordination&&!source;
 const blueCard=localBlue?claimLocalBlueReviewMarkup(localBlueOptions,b,parent):claimCoverageAndRouteMarkup(c);
 const previousClaimNumber=liveRoute?'<input type="hidden" name="external_control_number" value="">':
  billingField('external_control_number','Claim number from a previous system',v.external_control_number,'text',100);
 const frequency=parent&&!coordination&&!localBlue?selectField('frequency','Claim frequency',parent.payer_control_number?['replacement','void_request']:['original'],parent.payer_control_number?'replacement':'original'):'<input type="hidden" name="frequency" value="original">';
 const billing=billingField('billing_provider_name','Billing provider name',v.billing_provider_name)+billingField('billing_npi','Billing NPI',v.billing_npi,'text',10)+billingField('tax_id','Tax ID / EIN (9 digits)',v.tax_id,'text',9);
 const patient=billingField('rendering_npi','Rendering NPI',v.rendering_npi,'text',10)+billingField('billing_address','Billing address',v.billing_address,'text',1000)+billingField('patient_address','Patient address',v.patient_address,'text',1000)+billingField('subscriber_address','Subscriber address',v.subscriber_address,'text',1000)+billingField('subscriber_birth_date','Subscriber date of birth',v.subscriber_birth_date||'','date')+claimPlaceOfServiceField(v.place_of_service)+claimDiagnosisPickerMarkup(v.diagnosis_codes)+previousClaimNumber;
 const other=claimLineDiagnosisMarkup(b,v)+`<label>Notes<textarea name="notes" maxlength="2000">${esc(v.notes)}</textarea></label>`;
 const fields=localBlue?`<div class="form-grid">${frequency}${billing}</div><details data-inline><summary>Other claim details</summary><div class="form-grid">${patient}</div>${other}</details>`:`<div class="form-grid">${frequency}${billing}${patient}</div>${other}`;
 const html=`<form id="claim-editor-form" data-request="${crypto.randomUUID()}" data-edit="${c?.id||''}" data-parent="${parent?.id||''}"><h3>${localBlue?'Review local Blue routing':c?'Edit draft claim':source?'Create a claim from an imported record':coordination?'Create secondary claim':parent?'Create corrected claim':'Create claim'}</h3>${sourceNotice(source)}<p>${money(b.total_cents)} in charges · Service ${esc(displayDate(b.content.service_date))}</p>${blueCard}${fields}${billingField('reason','Reason (saved in the claim history)','','text',1000,true)}${source?'<label class="review-ack"><input type="checkbox" required> I checked that the patient, payer, charges and claim number match the imported record.</label>':''}<button type="submit" class="primary">${continueToReview?'Continue to review':'Save draft claim'}</button></form>`;
 const nestedEditor=context.drawer?null:context.reviewSheet?context.host?.querySelector('#claim-editor'):$('claim-editor');
 if(nestedEditor)nestedEditor.innerHTML=html;else claimPane(html);
 const editorHost=nestedEditor||claimWorkspaceHost(context);
 if(editorHost){editorHost.scrollIntoView({block:'start'});const editorHeading=editorHost.querySelector('#claim-editor-form h3');if(editorHeading){editorHeading.tabIndex=-1;editorHeading.focus({preventScroll:true});editorHeading.id='claim-editor-heading';}}
 const form=editorHost?.querySelector('#claim-editor-form')||document.querySelector('#claim-editor-form');
 if(form){form.claimViewContext=context;form.claimAccount=b;form.claimRecord=c;form.claimSource=source;form.claimParent=parent;form.claimCoordination=coordination;form.claimLocalBlueOptions=localBlueOptions;form.claimContinueToReview=continueToReview;}
 if(!liveRoute)form?.querySelector('.form-grid')?.insertAdjacentHTML('beforebegin',`<label class="review-ack"><input name="synthetic_test" type="checkbox" ${v.synthetic_test?'checked':''}><span><b>Test claim</b><small>Tick only for a made-up patient and insurance. The claim gets an SCTEST control number, and a live clearinghouse account may still charge for it.</small></span></label>`);
 restoreClaimDraft(form,b,c,parent,localBlue?'bluecard-local':coordination?'secondary:'+coordination.coverage_id:source?'source:'+source.source_history_id:'packet',coordination?JSON.stringify([b.version,coordination]):undefined);
}
async function beginClaim(accountId,source){
 const patient=selected,identity=me,account=workspace.billing.accounts.find(b=>b.id===accountId);
 if(!account)throw new Error('These charges are no longer available.');
 if(chartSection==='visits'&&activeVisit&&account.content.visit_id===activeVisit.id){const context=mountEncounterClaims(accountId);if(typeof loadClaimmdProviderDefaults==='function')await loadClaimmdProviderDefaults();if(!claimContextCurrent(context))return;claimEditor({...account,patient_id:patient},null,source);return;}
 await showClaimsWorkspace();if(selected!==patient||me!==identity)return;claimEditor({...account,patient_id:patient},null,source);
}
function eraImportEditor(source=null){
 eraSource=source;const raw=source?.source_data;const html=`<form id="era-import" data-request="${crypto.randomUUID()}"><button type="button" class="batch-panel" data-batch-from-era>Open as an 835 file with several payments</button><h2>${source?.remote_report_id?'Review ERA from the clearinghouse':source?'Review imported insurance payment':'Import an insurance payment (ERA/835)'}</h2>${sourceNotice(source?{...source,policy:'Check the payer and that this is the right document. Importing does not post anything.'}:null)}${raw?.settlement_mapping?`<details class="amendment"><summary>Provider adjustments and reversals in the imported record</summary><pre class="billing-source">${esc(JSON.stringify({settlement:raw.settlement_mapping,source_ar_references:raw.source_ar_references||[]},null,2))}</pre></details>`:''}${raw?.provider?`<div class="mapping-notice"><b>${esc(raw.provider)} ERA ${esc(raw.provider_report_id||'')}</b><p>Payer in the imported record: ${esc(raw.source_payer_id||'')}. Importing does not post a payment.</p></div>`:''}<div class="form-grid">${payerPickerMarkup('payer','Insurance company',{value:raw?.source_payer_id||''})}${selectField('format','File format',['x12_835','normalized'],raw?.format||'x12_835')}<label>Choose file<input id="era-file" type="file" accept=".835,.txt,.json"></label></div><label>835 text (or JSON)<textarea name="document_text" rows="12" maxlength="1048576" required>${esc(raw?.original_text|| (raw?.document?JSON.stringify(raw.document,null,2):''))}</textarea></label><p class="muted">One payment per file, up to 1 MB, 1,000 claim rows and 1,000 provider adjustments (PLB), in US dollars.</p><details class="amendment"><summary>JSON format example</summary><pre class="billing-source">${esc(JSON.stringify({payer_code:'YOUR-PAYER-CODE',trace:'UNIQUE-TRACE',payment_date:'2026-10-23',total_paid_cents:8000,currency:'USD',claims:[{control_number:'SC… or claim number from a previous system',payer_control_number:'PAYER-CLAIM-ID',status:'1',patient_name:'Sample Patient',charged_cents:12550,paid_cents:8000,patient_responsibility_cents:2000,adjustments:[{group:'CO',reason_code:'45',amount_cents:2550,service_index:null},{group:'PR',reason_code:'1',amount_cents:2000,service_index:null}],services:[]}]},null,2))}</pre></details>${billingField('reason','Reason (saved in the history)','','text',1000,true)}<button class="primary" type="submit">Import for review</button></form>`;claimPane(html);typeaheadInit(claimWorkspaceHost()||document);}
async function showEra(id,{claimId,rowIndex}={}){
 const context=claimContextSnapshot(),identity=typeof me==='undefined'?undefined:me;
 const request={kind:'era',id};context.detailRequest=request;
 const current=()=>context.detailRequest===request&&claimContextCurrent(context)&&identity===(typeof me==='undefined'?undefined:me);
 const [d,h]=await Promise.all([api(`${eraBase}/${id}`),api(`${eraBase}/${id}/history`)]);if(!current())return;
 if(d.remittance?.id!==id)throw new Error('The payment response does not match the selected remittance.');
 if(claimId&&!d.remittance.matches?.some(match=>match.claim_id===claimId&&match.row_index===rowIndex))throw new Error('The payment match changed. Refresh the Claims worklist.');
 eraCurrent=d.remittance;const r=eraCurrent,doc=r.document,editable=billingWrite()&&['staged','reconciled'].includes(r.status),suggested=Boolean(d.automation)&&r.version===2;
 claimPane(`<section class="billing-account-detail"><div class="section-head"><div><h2>Insurance payment (ERA)</h2><p>${esc(r.trace)} · ${esc(payerName(r.payer_id))} · ${esc(doc.payment_date)}</p><small>v${r.version} · ${esc(doc.payer_code)}</small></div><span class="status-badge">${esc(eraStatusLabel(r.status))}</span></div><div class="billing-totals"><span>Payment total <b>${money(doc.total_paid_cents)}</b></span><span>Claim payments <b>${money(doc.claims.reduce((sum,c)=>sum+c.paid_cents,0))}</b></span><span>Provider adjustments (PLB) <b>${money((doc.provider_adjustments||[]).reduce((sum,p)=>sum+p.amount_cents,0))}</b></span><span>Claims <b>${doc.claims.length}</b></span><span>Currency <b>${esc(doc.currency)}</b></span></div>${['staged','reconciled'].includes(r.status)?claimIssues(d.issues):`<div class="mapping-notice"><b>${({reversed:'Posting undone',posted:'Payment posted',rejected:'Payment file rejected'})[r.status]||'Payment status unavailable'}</b><p>${r.status==='reversed'?'The posting was undone. The original amounts are kept below for reference.':r.status==='posted'?'The payment and the selected contractual write-offs (CO) were posted together.':r.status==='rejected'?'This payment file was rejected and nothing was posted.':'Open the payment history to review its recorded activity.'}</p></div>`}${suggested?'<p class="mapping-notice">These matches were suggested automatically. Check each claim and its balance before saving.</p>':''}${doc.supplemental?.length?`<details class="amendment"><summary>Other amounts from the payer (${doc.supplemental.length})</summary><p>These amounts are for information only. They do not add payments or patient charges.</p><pre class="billing-source">${esc(JSON.stringify(doc.supplemental,null,2))}</pre></details>`:''}<form id="era-matches">${doc.claims.map((row,i)=>{const m=r.matches.find(m=>m.row_index===i);return `<fieldset class="era-row" data-row="${i}"><legend>Claim ${i+1} · ${esc(row.control_number)}</legend><p>${esc(row.patient_name)} · Payer claim ${esc(row.payer_control_number)} · Claim status code ${esc(row.status)}</p><div class="billing-totals"><span>Charges <b>${money(row.charged_cents)}</b></span><span>Paid <b>${money(row.paid_cents)}</b></span><span>Patient responsibility (PR) <b>${money(row.patient_responsibility_cents)}</b></span></div>${editable?`<label>SunCharts claim<select name="claim_id"><option value="">Choose the matching claim</option>${claimRows.filter(c=>c.payer_id===r.payer_id&&['adjudicated','submitted','accepted'].includes(c.status)).map(c=>`<option value="${c.id}" ${m?.claim_id===c.id?'selected':''}>${esc(c.patient_name)} · ${esc(c.control_number)} · ${money(c.total_cents)}</option>`).join('')}${m&&!claimRows.some(c=>c.id===m.claim_id)?`<option value="${m.claim_id}" selected>Matched claim ${esc(m.claim_id)}</option>`:''}</select></label><label>Or paste the claim ID<input name="claim_lookup" placeholder="For a claim that is not in the list"></label><button type="button" data-era-inspect="${i}">Check claim and balance</button>`:`<p>Matched claim: ${m?`<button type="button" data-claim-open="${m.claim_id}">${esc(m.claim_id.slice(0,8))}</button>`:'None'}</p>`}${editable&&row.status!=='22'?`<details class="amendment" ${m?.correction_of_remittance_id?'open':''}><summary>This corrects an earlier reversal</summary><div class="form-grid"><label>ID of the payment with the reversal<input name="correction_of_remittance_id" value="${esc(m?.correction_of_remittance_id||'')}"></label><label>Claim row in that payment<input name="correction_of_row" type="number" min="1" max="1000" value="${m?.correction_of_row_index===undefined?'':m.correction_of_row_index+1}"></label></div><p class="muted">If the reversal is in this same payment, use ${esc(r.id)} and its claim row.</p></details>`:''}${editable&&row.status==='22'?`<div class="form-grid"><label>ID of the original posted payment<input name="reverses_remittance_id" value="${esc(m?.reverses_remittance_id||'')}" required></label><label>Claim row in that payment<input name="reverses_row" type="number" min="1" max="1000" value="${m?.reverses_row_index===undefined?'':m.reverses_row_index+1}" required></label></div><p class="mapping-notice">A reversal (claim status 22) must match the original posted claim and adjustments exactly.</p>`:''}<div class="era-match-evidence">${m?`${suggested?'Suggested - check the claim':'Checked'} · claim v${m.claim_version} · account v${m.account_version}`:'No claim matched yet'}</div><h4>Adjustments</h4>${row.adjustments.map((a,j)=>`<label class="review-ack">${editable&&row.status!=='22'&&a.group==='CO'?`<input type="checkbox" name="writeoff" value="${j}" ${m?.writeoff_adjustments.includes(j)?'checked':''}>`:'<span class="pill">'+esc(a.group)+'</span>'}<span>${esc(a.group)} · ${esc(a.reason_code)} · ${money(a.amount_cents)}${a.service_index===null?'':` · Service ${a.service_index+1}`}<small>${a.group==='CO'?(editable?'Tick to write off this contractual amount.':m?.writeoff_adjustments.includes(j)?'Written off.':'Not written off.'):'Shown for reference. Not written off.'}</small></span></label>`).join('')||'<p>No adjustments.</p>'}${row.services.length?`<details><summary>Service lines (${row.services.length})</summary><pre class="billing-source">${esc(JSON.stringify(row.services,null,2))}</pre></details>`:''}</fieldset>`;}).join('')}${editable?`${billingField('reason','Reason (saved in the history)','','text',1000,true)}<button class="primary" type="submit">Save matches</button>`:''}</form>
 ${billingWrite()&&!d.batch_id&&['staged','reconciled','posted'].includes(r.status)?`<form id="era-action"><h3>${r.status==='posted'?'Undo posting':'Post or reject this payment'}</h3><label>Action<select name="action">${r.status==='posted'?'<option value="reverse">Undo everything posted from this payment</option>':`${d.ready_to_post?'<option value="post">Post payment and selected write-offs</option>':''}<option value="reject">Reject this payment file</option>`}</select></label>${billingField('reason','Reason (saved in the history)','','text',1000,true)}<label class="review-ack"><input type="checkbox" required> I checked the claim matches, payment, write-offs and account balances.</label><p class="muted">Patient responsibility (PR) is never written off automatically.</p><button type="submit" class="primary">Confirm</button></form>`:''}${d.postings.length?`<h3>What was posted</h3><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Claim / account</th><th>Patient responsibility</th><th>Write-off (CO)</th><th>Current account balance</th></tr></thead><tbody>${d.postings.map(p=>`<tr><td>${esc(p.claim_id.slice(0,8))}<small>Account ${esc(p.account_id.slice(0,8))}</small></td><td>${money(p.patient_responsibility_cents)}</td><td>${money(p.writeoff_cents)}</td><td>${esc(eraCurrentBalance(p.current_account_balance_cents))}</td></tr>`).join('')}</tbody></table></div>`:''}<details class="amendment"><summary>Original payment file · ID ${esc(r.document_hash.slice(0,16))}</summary><pre class="billing-source">${esc(r.original_text||JSON.stringify(doc,null,2))}</pre></details><h3>Payment history</h3>${claimHistory(h)}</section>`,{request});
 if(d.batch_id)$('claims-detail').insertAdjacentHTML('afterbegin',`<div class="batch-panel mapping-notice"><b>This payment is part of a larger 835 file</b><p>Save the matches here, then post or undo the whole file from the file page.</p><button type="button" data-batch-open="${d.batch_id}">Open the whole file</button></div>`);
 const form=$('era-matches');
 for(const editor of [form,$('era-action')])if(editor){editor.remittance=r;editor.viewCurrent=()=>current()&&$(editor.id)===editor;}
 if(claimId){
  const row=form?.querySelector(`[data-row="${rowIndex}"]`);
  if(row){row.classList.add('claim-worklist-payment-row');row.tabIndex=-1;row.focus({preventScroll:true});row.scrollIntoView({block:'start'});}
 }
 const fields=form.querySelectorAll('.era-row');for(const field of fields){const m=r.matches.find(m=>m.row_index===Number(field.dataset.row));if(m&&!suggested)field.reviewedMatch={...m};}
 await showProviderSettlement(id,current);
}
async function refreshSavedEra(form){
 if(!form.viewCurrent())return false;
 const context=await showClaimsWorkspace();if(!context||!claimContextCurrent(context)||context.detailRequest)return false;
 await showEra(form.remittance.id);return claimContextCurrent(context)&&context.detailRequest?.kind==='era'&&context.detailRequest.id===form.remittance.id;
}
async function inspectEraMatch(index){
 const form=$('era-matches'),field=form.querySelector(`[data-row="${index}"]`);
 const selection=()=>field.querySelector('[name=claim_lookup]').value.trim()||field.querySelector('[name=claim_id]').value;
 const id=selection(),request={};field.matchRequest=request;field.reviewedMatch=null;field.chainHistory=[];
 const current=()=>form.viewCurrent()&&field.matchRequest===request&&selection()===id;
 if(!id)throw new Error('Select a claim first.');
 const d=await api(`${claimsBase}/${encodeURIComponent(id)}`);if(!current())return;
 const c=d.claim;if(c.id!==id)throw new Error('The response does not match the selected claim.');
 const b=await api(`/api/v1/patients/${c.patient_id}/billing`);if(!current())return;
 const a=b.accounts.find(a=>a.id===c.account_id);if(!a)throw new Error('The charges for this claim could not be found.');const balance=a.total_cents+b.entries.filter(e=>e.account_id===a.id).reduce((sum,e)=>sum+e.effect_cents,0);
 field.reviewedMatch={row_index:index,claim_id:c.id,claim_version:c.version,account_version:a.version,writeoff_adjustments:[]};field.querySelector('.era-match-evidence').innerHTML=`<b>${esc(c.snapshot.patient.given_name)} ${esc(c.snapshot.patient.family_name)}</b><p class="claim-control">${esc(c.control_number)} · ${esc(c.status)}</p><p>Claim v${c.version} · Account v${a.version} · Current open balance <b>${money(balance)}</b></p>${c.snapshot.coordination_of_benefits?`<div class="mapping-notice"><b>Primary credits already on this account: ${money((c.snapshot.coordination_of_benefits.primary_credits||[]).reduce((n,a)=>n+a.amount_cents,0))}</b><p>The primary payer write-offs are already on this account. Do not write them off again.</p><pre>${esc(JSON.stringify(c.snapshot.coordination_of_benefits.primary_credits||[],null,2))}</pre></div>`:''}`;
 const history=await api(`${claimsBase}/${c.id}/era-history`);if(!current())return;field.chainHistory=history.items;field.querySelector('.era-match-evidence').insertAdjacentHTML('beforeend',`<details class="amendment"><summary>Earlier posted payments for this claim (${history.items.length})</summary>${history.active_head?`<p><b>Current posting</b> · ${esc(history.active_head.remittance_id)} · Row ${history.active_head.row_index+1} · Claim v${history.active_head.claim_version}</p>`:''}${history.items.map((h,i)=>`<p>${esc(h.trace)} · Row ${h.row_index+1} · ${esc(h.status)} · ${h.claim.status==='22'?'Reversal':'Payment'} · ${money(h.claim.paid_cents)}<small>${esc(h.remittance_id)}</small><button type="button" data-chain-select="${i}" data-chain-row="${index}">Use this payment</button></p>`).join('')||'<p>No posting history for this claim.</p>'}</details>`);

}
document.addEventListener('change',e=>{if(e.target.id==='era-file')run(async()=>{const f=e.target.files[0];if(!f)return;if(f.size>1048576)throw new Error('File is larger than 1 MB.');$('era-import').elements.document_text.value=await f.text();});if(e.target.name==='claim_id'||e.target.name==='claim_lookup'){const row=e.target.closest('.era-row');if(row){row.matchRequest=null;row.chainHistory=[];row.reviewedMatch=null;row.querySelector('.era-match-evidence').textContent='Use Check claim and balance before saving.';}}});
document.addEventListener('click',e=>{const chip=e.target.closest?.('#claims-tool [data-claim-status],#claims-tool [data-view-waiting-claims]');if(chip){e.preventDefault();selectClaimStatusFilter(chip.dataset.claimStatus||'wait');return;}
 const coverage=e.target.closest?.('#claims-tool [data-coverage-worklist-account], #claims-tool [data-refresh-coverage-worklist]');
 if(coverage){run(()=>coverage.dataset.coverageWorklistAccount?openCoverageWorklistAccount(coverage.dataset.coverageWorklistAccount):refreshCoverageWorklist());return;}
 const b=e.target.closest('button');if(!b||b.hasAttribute('data-chain-select')||b.closest('.batch-panel')||b.closest('.settlement-panel')||b.closest('.era-automation-panel')||b.dataset.ediClaim||b.type==='submit'||(!b.closest('#claims-tool')&&!b.closest('#encounter-claims')&&!b.closest('[data-signed-local-blue-host]')&&!b.closest('[data-worklist-claim-dialog]')&&!b.dataset.claimReviewReturn&&!b.dataset.newClaim&&!b.dataset.mapClaim))return;const owned=['newClaim','mapClaim','sourceClaimAccount','claimAccount','claimOpen','claimReviewReturn','claimRelease','claimExistingSubmission','eraOpen','eraSource','eraInspect'].some(key=>b.dataset[key]!==undefined)||['data-era-next','data-edit-claim','data-secondary-claim','data-replacement-claim','data-new-era','data-close-encounter-claim','data-rebase-claim-draft','data-discard-claim-draft','data-claim-fix-resend'].some(name=>b.hasAttribute(name));if(!owned)return;run(async()=>{
 if(b.hasAttribute('data-rebase-claim-draft')){const form=$('claim-editor-form')||$('claimmd-submit-form');requireClaimContext(form.claimViewContext);form.claimDraftStale=false;form.querySelectorAll('button[type="submit"]').forEach(submit=>submit.disabled=false);form.querySelectorAll('[data-claim-draft-notice]').forEach(n=>n.remove());captureClaimDraft(form);return;}
 if(b.hasAttribute('data-discard-claim-draft')){const form=$('claim-editor-form')||$('claimmd-submit-form');requireClaimContext(form.claimViewContext);claimDrafts.delete(form.claimDraftKey);const account=form.claimAccount,record=form.claimRecord,source=form.claimSource,parent=form.claimParent;form.claimDraftKey=null;if(form.id==='claimmd-submit-form')claimMdSubmitEditor(form.claimMdDetail,form.claimAfterQueue,form.claimReviewCurrent);else claimEditor(account,record,source,parent,form.claimCoordination,form.claimLocalBlueOptions);return;}
 if(b.hasAttribute('data-close-encounter-claim')){const context=claimContextSnapshot();requireClaimContext(context);captureClaimDraft();$('encounter-claims').replaceChildren();$('encounter-claims').hidden=true;claimViewContext=null;return;}
 if(b.dataset.newClaim){await beginClaim(b.dataset.newClaim);return;}
 if(b.dataset.mapClaim){const m=await api(`/api/v1/patients/${selected}/history/${b.dataset.mapClaim}/claim-mapping`);if(m.native_id){await showClaimsWorkspace();await showClaim(m.native_id);return;}const candidates=workspace.billing.accounts.filter(a=>a.status==='posted'&&a.coverage_snapshot),patient=selected;await showClaimsWorkspace();claimSource=m;claimPane(`<h2>Create a claim from an imported record</h2>${sourceNotice(m)}<p>Choose the posted charges this claim belongs to.</p>${candidates.map(a=>`<button type="button" data-source-claim-account="${a.id}" data-patient="${patient}">${esc(a.content.service_date)} · ${money(a.total_cents)} · ${a.id.slice(0,8)}</button>`).join('')||'<p>No posted charges with insurance for this patient. Post the charges in the patient chart first.</p>'}`);window.claimSourceAccounts=candidates;return;}
 if(b.dataset.sourceClaimAccount){claimEditor({...window.claimSourceAccounts.find(a=>a.id===b.dataset.sourceClaimAccount),patient_id:b.dataset.patient},null,claimSource);return;}
 if(b.hasAttribute('data-era-next')){await showMoreMonitorRemittances();return;}
 if(b.dataset.claimAccount){const context=claimContextSnapshot();requireClaimContext(context,claimCurrent);if(context.kind!=='encounter'&&claimCurrent&&await openClaimOnVisit(claimCurrent.id,claimCurrent.status==='void'?{kind:'encounter'}:undefined))return;billingSelected=b.dataset.claimAccount;if(context.kind==='encounter'){captureClaimDraft();$('encounter-claims').replaceChildren();$('encounter-claims').hidden=true;claimViewContext=null;if(typeof openVisitChargesDetail==='function')openVisitChargesDetail(b.dataset.claimAccount);else showBillingAccount(b.dataset.claimAccount,false,true);return;}await showClinical();await selectPatient(b.dataset.patient);showBillingAccount(b.dataset.claimAccount);return;}
 if(b.dataset.claimReviewReturn){captureClaimDraft();await showClaim(b.dataset.claimReviewReturn);return;}
 if(b.dataset.claimExistingSubmission){await reviewExistingClaimSubmission(b.dataset.claimExistingSubmission);return;}
 if(b.dataset.claimRelease){await releaseClaimToSend(b.dataset.claimRelease);return;}
 if(b.dataset.claimOpen){const intent=claimWorklistIntent(b.dataset);if(intent?.kind==='resubmit'&&claimViewContext?.kind!=='encounter'&&await openClaimOnVisit(b.dataset.claimOpen,intent))return;if(claimViewContext?.kind==='worklist'&&(b.closest('[data-claim-worklist]')||claimViewContext.drawer))await openWorklistClaim(b.dataset.claimOpen,intent,b);else await showClaim(b.dataset.claimOpen,{historyOnly:intent?.kind==='history'});return;}if(b.hasAttribute('data-edit-claim')){claimEditor(claimCurrent.snapshot.account,claimCurrent);return;}
  if(b.hasAttribute('data-claim-fix-resend')){
   const id=b.dataset.claimFixClaim||claimCurrent?.id||'';
   if(b.hasAttribute('data-claim-local-blue'))await beginLocalBlueClaimFix(id);
   else await beginClaimFix(id,b.dataset.claimFixField||'');
   return;
  }
 if(b.dataset.claimPatient){await openClaimPatientRecord(b.dataset.claimPatient,'profile');return;}
 if(b.dataset.claimInsurance){await openClaimPatientRecord(b.dataset.claimInsurance,'insurance');return;}
 if(b.hasAttribute('data-secondary-claim')){await reviewSecondaryClaim();return;}
 if(b.hasAttribute('data-replacement-claim')){const context=claimContextSnapshot(),c=claimCurrent;requireClaimContext(context,c);const b=await api(`/api/v1/patients/${c.patient_id}/billing`);if(!claimContextCurrent(context))return;const account=b.accounts.find(a=>a.id===c.account_id);claimEditor({...account,patient_id:c.patient_id,...(c.snapshot.coordination_of_benefits?{coverage_snapshot:c.snapshot.account.coverage_snapshot,content:{...account.content,coverage_id:c.snapshot.account.content.coverage_id}}:{})},null,null,c);return;}
 if(b.hasAttribute('data-new-era')){eraImportEditor();return;}if(b.dataset.eraOpen){await showEra(b.dataset.eraOpen,b.dataset.eraClaim?{claimId:b.dataset.eraClaim,rowIndex:Number(b.dataset.eraRow)}:undefined);return;}if(b.dataset.eraSource){const s=window.eraSources.find(s=>s.source_history_id===b.dataset.eraSource);if(s.batch_id)await showEraBatch(s.batch_id);else if(s.native_id)await showEra(s.native_id);else eraImportEditor(s);return;}if(b.dataset.eraInspect!==undefined)await inspectEraMatch(Number(b.dataset.eraInspect));
 });});
function lockClaimForm(form){
 const fields=Array.from(form.querySelectorAll?.('input,select,textarea')||[]).map(field=>[field,field.disabled]);fields.forEach(([field])=>field.disabled=true);return ()=>fields.forEach(([field,disabled])=>field.disabled=disabled);
}
async function saveClaimEditorForm(form,data){
 // The diagnosis ticks are read off the form element itself, the way every other field is read. A
 // caller that hands the values over without the boxes falls back to what the claim already holds,
 // so a saved draft is never silently emptied of its diagnosis pointers.
 const readTicked=typeof form?.querySelectorAll==='function';
 if(form.claimDraftStale)throw new Error('The claim changed since you started. See the notice at the top of this form first.');
 const context=form.claimViewContext||claimContextSnapshot(),account=form.claimAccount||claimAccount,record=form.claimRecord||claimCurrent,source=form.claimSource||claimSource;
 requireClaimContext(context,{patient_id:account.patient_id,account_id:account.id});captureClaimDraft(form);
 const localBlue=form.claimLocalBlueOptions?.length>0;
 if(localBlue&&(!form.claimLocalBlueOptions.some(option=>option.payer_id===data.local_blue_payer_id)||data.local_blue_route_reviewed!=='on'))
  throw new Error('Confirm the local Blue routing and billing details before saving.');
 const routeRequest=localBlue?{local_blue_payer_id:data.local_blue_payer_id,local_blue_route_reviewed:true}:{};
 const content={};for(const key of ['billing_provider_name','billing_npi','tax_id','billing_address','rendering_npi','patient_address','subscriber_address','place_of_service','external_control_number','notes'])content[key]=data[key];content.tax_id_type=(form.claimRecord||(localBlue?form.claimParent:null))?.content?.tax_id_type||'';
 content.synthetic_test=!localBlue&&!claimLocalBlueDestination(form.claimRecord)&&data.synthetic_test==='on';content.subscriber_birth_date=data.subscriber_birth_date||null;content.diagnosis_codes=data.diagnosis_codes.split(',').map(s=>s.trim()).filter(Boolean);content.line_diagnosis_pointers=readTicked?claimLineDiagnosisValues(form,claimDiagnosisChoices(content),account.content.lines.length):(record?.content?.line_diagnosis_pointers||[]);
 if(localBlue||claimLocalBlueDestination(form.claimRecord))content.external_control_number='';
 const unlock=lockClaimForm(form);
 try{
  const claim=form.dataset.edit?await api(`${claimsBase}/${form.dataset.edit}`,'PUT',{content,reason:data.reason},record.version):await api(`/api/v1/patients/${account.patient_id}/billing/accounts/${account.id}/claims`,'POST',{request_id:form.dataset.request,source_history_id:source?.source_history_id||null,parent_id:form.dataset.parent||null,frequency:localBlue?'original':data.frequency,content,reason:data.reason,...routeRequest,...(form.claimCoordination?{coordination:form.claimCoordination}:{})},account.version);
  if(form.claimDraftKey&&context.identity===(typeof me==='undefined'?undefined:me))claimDrafts.delete(form.claimDraftKey);
  if(form.claimContinueToReview&&claimContextCurrent(context)&&typeof openClaimMdSubmissionReview==='function'){
   try{
    await openClaimMdSubmissionReview(claim.id,{releaseDraft:true,expectedVersion:claim.version});
    return;
   }catch(error){
    if(claimContextCurrent(context))await refreshClaimInContext(claim.id,context);
    throw error;
   }
  }
  await refreshClaimInContext(claim.id,context);
 }finally{unlock();}
}
document.addEventListener('submit',e=>{const f=e.target;if(!['claim-editor-form','claim-action','era-import','era-matches','era-action'].includes(f.id))return;e.preventDefault();run(async()=>{const d=Object.fromEntries(new FormData(f));
 if(f.id==='claim-editor-form')await saveClaimEditorForm(f,d);
 if(f.id==='claim-action'){const context=f.claimViewContext||claimContextSnapshot(),claim=f.claimRecord||claimCurrent;requireClaimContext(context,claim);d.event_date=d.event_date||null;await api(`${claimsBase}/${claim.id}/actions`,'POST',d,claim.version);await refreshClaimInContext(claim.id,context);}
 if(f.id==='era-import'){const body={request_id:f.dataset.request,payer_id:d.payer_id,format:d.format,source_history_id:eraSource?.source_history_id||null,remote_report_id:eraSource?.remote_report_id||null,reason:d.reason,document:d.format==='normalized'?JSON.parse(d.document_text):null,original_text:d.format==='x12_835'?d.document_text:null};const r=await api(eraBase,'POST',body);await showClaimsWorkspace();await showEra(r.id);}
 if(f.id==='era-matches'||f.id==='era-action'){if(!f.viewCurrent?.()||!f.remittance)throw new Error('Open the payment again before saving.');}
 if(f.id==='era-matches'){const r=f.remittance,matches=Array.from(f.querySelectorAll('.era-row')).map(row=>{if(!row.reviewedMatch)throw new Error('Use Check claim and balance on every row first.');return {...row.reviewedMatch,correction_of_remittance_id:row.querySelector('[name=correction_of_remittance_id]')?.value.trim()||null,correction_of_row_index:row.querySelector('[name=correction_of_remittance_id]')?.value.trim()?Number(row.querySelector('[name=correction_of_row]').value)-1:null,reverses_remittance_id:row.querySelector('[name=reverses_remittance_id]')?.value.trim()||null,reverses_row_index:row.querySelector('[name=reverses_row]')?Number(row.querySelector('[name=reverses_row]').value)-1:null,writeoff_adjustments:Array.from(row.querySelectorAll('[name=writeoff]:checked')).map(c=>Number(c.value))};});await api(`${eraBase}/${r.id}/matches`,'PUT',{matches,reason:d.reason},r.version);if(!await refreshSavedEra(f))return;}
 if(f.id==='era-action'){const r=f.remittance;await api(`${eraBase}/${r.id}/actions`,'POST',{action:d.action,reason:d.reason},r.version);if(!await refreshSavedEra(f))return;}
 notice('Saved.');});});

document.addEventListener('click',e=>{const b=e.target.closest('[data-chain-select]');if(!b)return;const field=$('era-matches').querySelector(`[data-row="${b.dataset.chainRow}"]`),source=field.chainHistory[Number(b.dataset.chainSelect)],reversal=field.querySelector('[name=reverses_remittance_id]');if(reversal){reversal.value=source.remittance_id;field.querySelector('[name=reverses_row]').value=source.row_index+1;}else{field.querySelector('[name=correction_of_remittance_id]').value=source.remittance_id;field.querySelector('[name=correction_of_row]').value=source.row_index+1;}notice('Payment selected. Check it is the right one before saving.');});

async function decorateClaimsWorkspace(context){
 if(!claimContextCurrent(context))return;
 const management=$('claim-monitor-tools-anchor');
 if(management&&!claimMdConnectionState?.connected)management.insertAdjacentHTML('beforebegin',claimMdConnectionCard());
 const setting=claimMdConnectionState?.active?.id;
 if(setting&&typeof claimmdAccountUploads==='function'){
  const account=await claimmdAccountUploads(setting,{refresh:true});
  if(!claimContextCurrent(context))return;
  const uploadsBlock=`<details class="amendment claim-advanced"><summary>Files received by the clearinghouse (${account.uploads.length})</summary>${account.html}</details>`;
  management?.insertAdjacentHTML('beforebegin',uploadsBlock);
 }
};

document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='secondary-claim-review')return;event.preventDefault();
 run(async()=>{const context=form.claimViewContext,data=form.secondaryReview;requireClaimContext(context,data.primary_claim);if(claimCurrent?.id!==form.primaryClaimId)throw new Error('The selected primary claim changed.');
  const values=Object.fromEntries(new FormData(form)),coverage=form.secondaryChoices.find(c=>c.coverage.id===secondaryChosenCoverageId(form,values)),e=data.primary_adjudication;if(!coverage||values.not_forwarded!=='on'||values.timing_reviewed!=='on')throw new Error('Choose the secondary insurance and tick both boxes first.');
  const paidUnits=e.claim.services.map((_,i)=>Number(values['paid_units_'+i]));if(paidUnits.some(n=>!Number.isInteger(n)||n<1||n>1000))throw new Error('Enter the paid units for every service.');
  const coordination={coverage_id:coverage.coverage.id,coverage_version:coverage.coverage.version,primary_claim_version:data.primary_claim.version,remittance_id:e.remittance_id,remittance_version:e.remittance_version,row_index:e.row_index,not_forwarded_confirmed:true,payer_timing_reviewed:true,crossover_reference:values.crossover_reference,paid_units:paidUnits};
  claimEditor({...data.account,content:{...data.account.content,coverage_id:coverage.coverage.id},coverage_snapshot:coverage},null,null,data.primary_claim,coordination);
 });
});

function crossoverReviewMarkup(data,choices){
 if(data.primary_adjudication?.claim?.status!=='19'||!choices.length)return '';
 const candidates=(data.crossover_candidates||[]).filter(c=>choices.some(coverage=>coverage.coverage.id===c.coverage_id));
 if(!candidates.length)return '<section class="mapping-notice"><h3>Waiting for the secondary payer</h3><p>The primary payer says it forwarded this claim, but no secondary payment (835) matching this insurance, claim number, billing NPI, service date and services has arrived yet. Refresh this page once it arrives or you import it, and do not send another claim or add charges in the meantime.</p></section>';
 return `<form id="crossover-claim-review" data-request="${crypto.randomUUID()}"><h3>Link the secondary payer response</h3><p>This links the secondary payment to the charges for the same visit. It does not send a claim or post a payment.</p><label>Secondary response<select name="candidate" required><option value="">Choose the secondary response</option>${candidates.map((c,i)=>`<option value="${i}">${esc(c.payer_name)} · ${esc(c.payment_date)} · Trace ${esc(c.trace)} · Row ${c.row_index+1} · Paid ${money(c.claim.paid_cents)}</option>`).join('')}</select></label>${candidates.map(c=>`<details><summary>${esc(c.payer_name)} · ${esc(c.trace)} · Row ${c.row_index+1}</summary><p>Billing NPI ${esc(c.payee_npi)} · Payer claim ${esc(c.claim.payer_control_number)} · Response status ${esc(c.claim.status)}</p><pre class="billing-source">${esc(JSON.stringify(c.claim,null,2))}</pre></details>`).join('')}<label class="review-ack"><input type="checkbox" name="linkage_confirmed" required> I confirmed that this response is for this patient, this secondary policy and these services.</label>${billingField('linkage_reference','How you confirmed this (EOB date or reference)','','text',1000,true)}${billingField('reason','Reason (saved in the claim history)','','text',1000,true)}<button type="submit" class="primary">Link secondary response</button></form>`;
}
async function createCrossoverTracking(form,values){
 const context=form.claimViewContext,data=form.secondaryReview;requireClaimContext(context,data.primary_claim);
 if(claimCurrent?.id!==form.primaryClaimId)throw new Error('The selected primary claim changed.');
 const choices=form.secondaryChoices,candidates=(data.crossover_candidates||[]).filter(c=>choices.some(coverage=>coverage.coverage.id===c.coverage_id)),index=Number(values.candidate),candidate=values.candidate!==''&&Number.isInteger(index)?candidates[index]:null;
 if(!candidate||values.linkage_confirmed!=='on'||!values.linkage_reference?.trim()||!values.reason?.trim())throw new Error('Choose the response, tick the box and fill in both fields first.');
 if(form.crossoverSaving)return;form.crossoverSaving=true;const unlock=lockClaimForm(form),e=data.primary_adjudication;
 try{
  const crossover={coverage_id:candidate.coverage_id,coverage_version:candidate.coverage_version,primary_claim_version:data.primary_claim.version,primary_remittance_id:e.remittance_id,primary_remittance_version:e.remittance_version,primary_row_index:e.row_index,secondary_remittance_id:candidate.remittance_id,secondary_remittance_version:candidate.remittance_version,secondary_row_index:candidate.row_index,linkage_confirmed:true,linkage_reference:values.linkage_reference};
  const claim=await api(`/api/v1/patients/${data.account.patient_id}/billing/accounts/${data.account.id}/claims`,'POST',{request_id:form.dataset.request,frequency:'original',parent_id:data.primary_claim.id,crossover,content:data.primary_claim.content,reason:values.reason},data.account.version);
  await refreshClaimInContext(claim.id,context);
 }finally{form.crossoverSaving=false;unlock();}
}
document.addEventListener('submit',event=>{const form=event.target;if(form.id!=='crossover-claim-review')return;event.preventDefault();run(()=>createCrossoverTracking(form,Object.fromEntries(new FormData(form))));});
// The claim page's "Fix it here" form (registered last so the claim editor's own submit handler stays first).
document.addEventListener('submit',event=>{const form=event.target;if(form.id!=='claim-quick-fix')return;event.preventDefault();run(()=>form.claimInlineSave?form.claimInlineSave():saveClaimQuickFix(form));});
function claimWorklistIntent(dataset){
 if(dataset.claimIntent==='send'||dataset.claimIntent==='history')return {kind:dataset.claimIntent};
 if(dataset.claimIntent==='correction')return {kind:'correction',procedure:dataset.claimProcedure,line:Number(dataset.claimLine)};
 if(dataset.claimIntent==='missing')return {kind:'missing',field:dataset.claimField,part:dataset.claimPart};
 if(dataset.claimIntent==='delivery')return {kind:'delivery'};
 if(dataset.claimIntent==='resubmit')return {kind:'resubmit',version:Number(dataset.canceledClaimVersion),accountVersion:Number(dataset.canceledAccountVersion)};
}
async function openCoverageWorklistAccount(accountId){
 const context=claimViewContext,queue=context?.coverageQueue;
 if(context?.kind!=='worklist'||!claimContextCurrent(context)||claimStatusFilter!=='action'||$('tools')?.hidden||!queue)return;
 const row=queue.items.find(item=>item.account_id===accountId),action=row&&coverageWorklistAction(row,queue);
 if(!action)return;
 if(action.kind==='payer'){
  const identity=me;
  await showBillingQueue('',undefined,true);
  if(me!==identity||!$('billing-tool')||$('tools').hidden)return;
  if(!action.payer){$('billing-tool').querySelector('[data-payer-open]')?.closest('section')?.scrollIntoView({block:'start'});return;}
  const payer=billingPayers.find(item=>item.id===action.payer);
  if(!payer)throw new Error('This insurer is no longer in the payer directory.');
  payerEditor(payer);
  return;
 }
 const request={kind:'visit-coverage',id:accountId};context.detailRequest=request;
 const current=()=>claimContextCurrent(context)&&context.detailRequest===request;
 const oldChart=workspace;
 await selectPatient(row.patient_id,row.visit_id||null,current,{section:row.visit_id?'visits':'billing',tabSelection:true});
 if(!current()||workspace===oldChart)return;
 const visit=activeVisit?.id||null;
 const account=workspace?.billing?.accounts?.find(a=>a.id===accountId);
 if(selected!==row.patient_id||visit!==(row.visit_id||null)||!account||account.status!=='posted'||(account.content.visit_id||null)!==visit)
  throw new Error('The posted charges changed. Open the worklist again for the current action.');
 if(action.kind==='account'){await openEncounterBillingAccount(account.id);return;}
 if(action.kind==='note'){setEncounterSection('documentation');return;}
 setEncounterSection('charges');
 if(action.kind==='apply_coverage'||action.kind==='prepare_claim'){
  if(Number.isSafeInteger(row.account_version)&&account.version!==row.account_version)
   throw new Error('The posted charges changed. Open the worklist again for the current action.');
  await openEncounterCoverageWorklistAction(account.id,action.kind,row.account_version);
 }
 if(action.kind==='payments')invoiceTabSet('payments');
 if(action.kind==='claim')invoiceTabSet('billing');
}
// Open the encounter's claim dialog if the selected worklist claim is still current for that visit.
// Older and imported claims open directly in the claims workspace.
async function openClaimOnVisit(claimId,intent){
 const context=claimContextSnapshot(),identity=context.identity;
 const request={kind:'visit-claim',id:claimId};context.detailRequest=request;
 const detail=await api(`${claimsBase}/${encodeURIComponent(claimId)}`),claim=detail.claim,visitId=claim?.snapshot?.account?.content?.visit_id;
 if(!claimContextCurrent(context)||context.detailRequest!==request)return true;
 if(claim?.id!==claimId)throw new Error('The claim response does not match the selected claim.');
 const resubmit=intent?.kind==='resubmit',recovery=resubmit?claimCanceledRecovery(claim,detail.canceled_claim_recovery):null;
 if(resubmit&&(!recovery||recovery.version!==intent.version||recovery.account_version!==intent.accountVersion||
  recovery.encounter_id!==visitId))throw new Error('The claim or posted charges changed. Refresh the worklist and review the current claim.');
 if(!visitId||typeof selectPatient!=='function'||typeof showClinical!=='function')return false;
 captureClaimDraft();await showClinical();if(me!==identity)return true;
 await selectPatient(claim.patient_id,visitId);if(me!==identity||selected!==claim.patient_id||activeVisit?.id!==visitId)return true;
 if(recovery){await visitResubmitFromWorklist(recovery);return true;}
 setEncounterSection('charges');
 if(intent?.kind==='encounter')return true;
 if(typeof visitOpenCurrentEncounterClaim==='function'&&$('visit-page-host')){
  if(await visitOpenCurrentEncounterClaim(claim.id,claim.account_id,intent))return true;
  if(await showClaimsWorkspace())await showClaim(claim.id);
 }else{
  await showEncounterClaim(claim.id,claim.account_id);
  $('encounter-claims')?.scrollIntoView({block:'start'});
 }
 return true;
}
// The claim's Fix here opens the boxes in a window over the page (a sheet), so nothing on the page
// jumps. Cancel or Esc closes it and the boxes go back where they were; a save closes it and the
// claim, checked again, is highlighted where it changed.
function sheetOpen(title,node,{className='',label=false}={}){
 const dialog=document.createElement('dialog');dialog.className=className?'sheet-dialog '+className:'sheet-dialog';
 if(label)dialog.setAttribute('aria-label',title);
 dialog.innerHTML=`<header class="sheet-head"><h3>${esc(title)}</h3><button type="button" class="sheet-close" data-sheet-close aria-label="Close">×</button></header><div class="sheet-body"></div>`;
 dialog.querySelector('.sheet-body').append(node);document.body.append(dialog);
 dialog.addEventListener('cancel',event=>{event.preventDefault();sheetClose(dialog);});
 dialog.addEventListener('click',event=>{if(event.target===dialog||event.target.closest('[data-sheet-close]'))sheetClose(dialog);});
 dialog.showModal();return dialog;
}
function sheetClose(dialog,after){
 if(!dialog||dialog.dataset.closing||dialog.canCloseSheet?.()===false)return;dialog.dataset.closing='1';dialog.classList.add('closing');
 const done=()=>{dialog.close();after?.();dialog.remove();};
 if(matchMedia('(prefers-reduced-motion: reduce)').matches)done();else setTimeout(done,180);
}
// Extra detail on an encounter (history, how this works, claim boxes, status checks) opens over the
// page in a sheet instead of unfolding in place, so the page under it never moves and staff keep
// their place. The detail's own nodes move into the sheet and back on close, so fields inside still
// belong to their form and keep what was typed. A <details data-inline> stays inline.
const detailsMenuSelector='details[data-menu],details.frame-add-menu,details.chart-list-more,details.patient-banner-more';
const detailsSheets=new WeakMap();
function detailsSheetTitle(details,summary){
 const clean=value=>(value||'').replace(/[▾▸▿▹▼▶]/g,'').replace(/\s+/g,' ').trim();
 const title=clean(summary?.textContent);
 if(title&&title.toLowerCase()!=='more')return title;
 for(let section=details.parentElement;section;section=section.parentElement){
  const heading=[...section.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(node=>!details.contains(node)&&!node.closest('dialog'));
  if(heading&&clean(heading.textContent))return clean(heading.textContent)+' — more';
 }
 return 'Additional details';
}
function detailsSheetOpen(details){
 if(details.matches(detailsMenuSelector)||!details.isConnected)return null;
 const current=detailsSheets.get(details);if(current)return current;
 const summary=details.querySelector(':scope>summary');
 const moved=[...details.childNodes].filter(node=>node!==summary);
 const contentSelector='input,select,textarea,button,a[href],img,svg,canvas,video,audio,iframe,object';
 const hasContent=nodes=>nodes.some(node=>node.textContent.trim()||(node.nodeType===1&&(node.matches(contentSelector)||node.querySelector(contentSelector))));
 if(!hasContent(moved))return null;
 const dialog=document.createElement('dialog');dialog.className='sheet-dialog';
 dialog.innerHTML='<header class="sheet-head"><h3></h3><button type="button" class="sheet-close" data-sheet-close aria-label="Close">×</button></header><div class="sheet-body"></div>';
 dialog.querySelector('h3').textContent=detailsSheetTitle(details,summary);
 const marker=document.createComment('details-sheet'),body=dialog.querySelector('.sheet-body');
 details.append(marker);
 for(const node of moved)body.append(node);
 details.after(dialog);detailsSheets.set(details,dialog);
 const homeCurrent=()=>details.isConnected&&marker.parentNode===details&&summary?.parentNode===details;
 let restored=false;
 const restore=()=>{
  if(restored)return;restored=true;watch.disconnect();detailsSheets.delete(details);
  if(homeCurrent()){
   for(const node of moved)if(node.parentNode===body)details.insertBefore(node,marker);
   if(dialog.isConnected)summary?.focus?.({preventScroll:true});
  }
  marker.remove();dialog.remove();
 };
 const watch=new MutationObserver(()=>{
  if(!homeCurrent()||!dialog.isConnected||!hasContent([...body.childNodes])){
   if(dialog.open)dialog.close();restore();
  }
 });
 watch.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
 dialog.addEventListener('close',restore,{once:true});
 dialog.addEventListener('cancel',event=>{event.preventDefault();sheetClose(dialog);});
 dialog.addEventListener('click',event=>{if(event.target===dialog||event.target.closest('[data-sheet-close]'))sheetClose(dialog);});
 dialog.showModal();return dialog;
}
if(typeof document!=='undefined'&&document.addEventListener){
 // Capture before action handlers that may stop propagation or redraw the page.
 document.addEventListener('click',event=>{
  const inside=event.target?.closest?.(detailsMenuSelector);
  const action=event.target?.closest?.('button,a');
  for(const menu of document.querySelectorAll(detailsMenuSelector)){
   if(menu.open&&(!menu.contains(event.target)||(action&&menu.contains(action))))menu.open=false;
  }
  if(inside&&!inside.hasAttribute('data-menu'))inside.setAttribute('data-menu','');
 },true);
 document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  for(const menu of document.querySelectorAll(detailsMenuSelector))if(menu.open){
   menu.open=false;menu.querySelector(':scope>summary')?.focus?.({preventScroll:true});event.preventDefault();
  }
 },true);
 document.addEventListener('click',event=>{
  const summary=event.target?.closest?.('summary');const details=summary?.parentElement;
  if(!details||details.tagName!=='DETAILS'||details.open||details.matches(detailsMenuSelector)||details.hasAttribute('data-inline')||!details.closest?.('#visit-page-host'))return;
  event.preventDefault();detailsSheetOpen(details);
 });
}
// Editing a signed note opens over the page. The form goes back where it was on close, and the
// sheet closes by itself once the note is redrawn after a save.
function noteEditSheetOpen(){
 const form=$('amendment-form'),editor=$('visit-editor');if(!form||form.closest('dialog'))return;
 const marker=document.createComment('amendment-form');form.before(marker);
 const launcher=editor?.querySelector('[data-action="focus-amendment"]');form.hidden=false;
 const dialog=sheetOpen('Add correction',form,{label:true});form.classList.add('in-sheet');
 const back=()=>{
  form.classList.remove('in-sheet');
  if(marker.isConnected){
   form.hidden=true;marker.replaceWith(form);
   launcher?.focus({preventScroll:true});
  }
  watch?.disconnect();
 };
 const watch=editor&&typeof MutationObserver!=='undefined'?new MutationObserver(()=>{if(!marker.isConnected){watch.disconnect();if(dialog.open)dialog.close();dialog.remove();}}):null;
 watch?.observe(editor,{childList:true,subtree:true});
 dialog.addEventListener('close',back);
 form.querySelector('[name="text"]')?.focus();
}
// Briefly marks what just changed so the eye finds it.
function flashUpdated(node){if(!node?.classList)return;node.classList.remove('just-updated');void node.offsetWidth;node.classList.add('just-updated');setTimeout(()=>node.classList.remove('just-updated'),1600);}
function openClaimQuickFix(){
 const form=$('claim-quick-fix');if(!form)return false;
 const context=claimContextSnapshot();
 if(context.drawer){
  form.hidden=false;form.claimViewContext=context;
  if(!form.claimInlineSave){
   const status=document.createElement('p');status.className='muted';status.setAttribute('role','status');form.append(status);
   let timer,work;
   form.claimInlineDirty=()=>!form.hidden&&JSON.stringify(Object.fromEntries(new FormData(form)))!==form.claimBaseline;
   form.claimInlineSave=()=>{
    clearTimeout(timer);
    if(work)return work;
    if(!form.isConnected||!claimInlineFormCurrent(form,context)||!form.checkValidity()||!form.claimInlineDirty())return Promise.resolve(true);
    status.textContent='Saving…';
    work=saveClaimQuickFix(form).then(()=>true).catch(error=>{if(form.isConnected)status.textContent=error.message||'The change could not be saved. Try again.';return false;}).finally(()=>work=null);
    return work;
   };
   form.addEventListener('input',event=>{
    if(event.isComposing)return;
    captureClaimDraft(form);clearTimeout(timer);
    if(form.checkValidity())timer=setTimeout(()=>void form.claimInlineSave(),600);
   });
   restoreClaimDraft(form,claimCurrent.snapshot.account,claimCurrent,null,'quick-fix');
  }
  (form.querySelector('[data-confirm-self-policyholder]')||form.querySelector('input:not([type=hidden])'))?.focus();
  return true;
 }
 const home=form.parentNode,marker=document.createComment('claim-quick-fix');home.insertBefore(marker,form);
 form.hidden=false;form.claimViewContext=claimViewContext;
 const dialog=sheetOpen('Fill in what the claim needs',form);form.claimSheet=dialog;
 const putBack=()=>{if(marker.parentNode){form.hidden=true;form.reset();marker.parentNode.insertBefore(form,marker);marker.remove();}else form.remove();};
 dialog.addEventListener('close',putBack,{once:true});
 (form.querySelector('[data-confirm-self-policyholder]')||form.querySelector('input:not([type=hidden])'))?.focus();
 return true;
}
function claimInlineFormCurrent(form,context){return claimContextCurrent(context)&&claimCurrent?.id===form.dataset.claim;}
document.addEventListener('click',event=>{
 const confirm=event.target.closest?.('[data-confirm-self-policyholder]');
 if(confirm){event.preventDefault();run(()=>confirmClaimSelfPolicyholder(confirm.closest('form')));return;}
 const open=event.target.closest?.('[data-claim-quick-fix-open]'),cancel=event.target.closest?.('[data-claim-quick-fix-cancel]');
 if(open){event.preventDefault();openClaimQuickFix();return;}
 if(cancel){event.preventDefault();const form=$('claim-quick-fix');if(form?.claimInlineSave){captureClaimDraft(form);form.hidden=true;return;}sheetClose(form?.claimSheet||form?.closest('dialog'));}
});
// The claim's details as tabs rather than one long drop-down: Progress, Claim details, Insurance,
// History and the rest, one shown at a time. The tab last used is remembered.
const claimTabNames={'Claim progress':'Progress','Clearinghouse activity':'Clearinghouse','The insurer and clearinghouse wording':'Responses','Other options for this claim':'More','Record something done outside SunCharts':'Done outside SunCharts','Provider, insurance and diagnosis details':'Claim details','The insurance on this claim':'Insurance','Claim history':'History','What happened':'What happened'};
const claimTabOrder=['Progress','Responses','Claim details','Insurance','History','Clearinghouse','What happened','Done outside SunCharts','More'];
// The progress bar sits under the claim's name, not in a box of its own further down.
function claimProgressToHead(host){
 const head=host?.querySelector?.('.claim-screen-head'),bar=host?.querySelector?.('.claim-lifecycle');if(!head||!bar||bar.previousElementSibling===head)return;
 const item=bar.closest?.('.claim-more-item');head.after(bar);
 if(item&&!item.querySelector('*:not(h3)'))item.remove();
}
function claimDetailTabs(host){
 const detail=host?.querySelector?.('.billing-account-detail');if(!detail||typeof document==='undefined'||!document.createElement)return;
 const items=[...detail.querySelectorAll('.claim-more-item')].filter(item=>!item.closest('.claim-tabs-panels'));
 if(!items.length)return;
 let box=detail.querySelector('.claim-tabs');
 if(!box){box=document.createElement('section');box.className='claim-tabs';box.innerHTML='<nav class="invoice-tabs claim-tab-bar" role="tablist" aria-label="Claim details"></nav><div class="claim-tabs-panels"></div>';const more=detail.querySelector('[data-claim-more-details]');(more||items[0]).before(box);more?.remove();}
 const bar=box.querySelector('.claim-tab-bar'),panels=box.querySelector('.claim-tabs-panels');
 for(const item of items){
  const heading=item.querySelector(':scope>h3'),label=(heading?.textContent||'').trim(),name=claimTabNames[label]||label;
  heading?.remove();item.dataset.claimTab=name;item.setAttribute('role','tabpanel');
  item.querySelectorAll('details.claim-advanced').forEach(d=>{d.open=true;d.classList.add('claim-advanced-open');});
  panels.append(item);
 }
 // One order on every claim: where it stands first, the rarely needed last.
 const rank=name=>{const at=claimTabOrder.indexOf(name);return at<0?claimTabOrder.length:at;};
 for(const item of [...panels.children].sort((a,b)=>rank(a.dataset.claimTab)-rank(b.dataset.claimTab)))panels.append(item);
 bar.replaceChildren();
 for(const item of panels.children)bar.insertAdjacentHTML('beforeend',`<button type="button" role="tab" data-claim-tab-key="${esc(item.dataset.claimTab)}">${esc(item.dataset.claimTab)}</button>`);
 let remembered='';try{remembered=localStorage.getItem('suncharts.claimTab')||'';}catch{}
 const names=[...panels.children].map(item=>item.dataset.claimTab);
 claimTabSet(box,names.includes(remembered)?remembered:names.includes('Progress')?'Progress':names[0],false);
}
function claimTabSet(box,name,remember=true){
 for(const item of box.querySelectorAll('.claim-tabs-panels>[data-claim-tab]'))item.hidden=item.dataset.claimTab!==name;
 for(const button of box.querySelectorAll('[data-claim-tab-key]')){const on=button.dataset.claimTabKey===name;button.classList.toggle('active',on);button.setAttribute('aria-selected',String(on));}
 if(remember)try{localStorage.setItem('suncharts.claimTab',name);}catch{}
}
document.addEventListener('click',event=>{const tab=event.target?.closest?.('[data-claim-tab-key]');if(!tab)return;event.preventDefault();claimTabSet(tab.closest('.claim-tabs'),tab.dataset.claimTabKey);});
