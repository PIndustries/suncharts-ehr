// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const claimActionLabels={ready:'Release it to send later',void_draft:'Void this claim',record_submission:'It was sent outside SunCharts',record_acceptance:'The payer accepted it',record_rejection:'The payer rejected it'};
const eraStatusLabels={staged:'To review',reconciled:'Matched, ready to post',posted:'Posted',reversed:'Posting undone',rejected:'Rejected'};
function eraStatusLabel(status){return eraStatusLabels[status]||human(status);}
function eraCurrentBalance(value){return Number.isSafeInteger(value)?value<0?`${money(-value)} patient credit`:`${money(value)} open`:'Unavailable';}
var claimRows=[],eraRows=[],claimCurrent,eraCurrent,claimAccount,claimSource,eraSource,claimNext,eraNext,claimStatusCounts={},claimStatusFilter='all';
const claimsBase='/api/v1/billing/claims',eraBase='/api/v1/billing/remittances';
// Chips follow the statuses the database can hold: draft, ready, submitted, accepted,
// rejected, adjudicated, void. A payer denial arrives as rejected and a payment as an
// insurance payment, so 'Paid' and 'Denied' are not claim statuses here.
var claimStatusChips=['draft','ready','submitted','accepted','rejected','adjudicated','void'];
function claimChipStatus(claim){return claimStatusChips.includes(claim.status)?claim.status:'other';}
function claimMatchesStatusFilter(claim){return claimStatusFilter==='all'||claimChipStatus(claim)===claimStatusFilter;}
function claimStatusChipLabel(status){return status==='all'?'All':displayStatus(status);}
function claimStatusCount(status){
 const counted=status==='all'?claimRows.length:claimRows.filter(claim=>claimChipStatus(claim)===status).length;
 return Math.max(counted,Number(claimStatusCounts[status])||0);
}
function claimStatusChipsHtml(){return `<nav class="practice-status-strip claims-status-strip" aria-label="Filter claims by status">${['all',...claimStatusChips].map(status=>`<button type="button" data-claim-status="${status}" aria-pressed="${claimStatusFilter===status}">${esc(claimStatusChipLabel(status))}<span>${claimStatusCount(status)}</span></button>`).join('')}</nav>`;}
function claimRowMarkup(claim){return `<tr><td><b>${esc(claim.patient_name)}</b><small class="claim-control">Claim ${esc(claim.control_number)}</small></td><td>${esc(claim.payer_name)}<small>${esc(displayStatus(claim.frequency))}</small></td><td><span class="pill">${esc(claimStatusLabel(claim))}</span></td><td class="money-cell">${money(claim.total_cents)}</td><td><button type="button" data-claim-open="${claim.id}">Open claim</button></td></tr>`;}
function claimRowsMarkup(claims){return claims.map(claimRowMarkup).join('');}
function claimEmptyRow(claims){return `<tr><td colspan="5" class="table-empty">${claims.length?'No claims here with this status. Choose All to see every claim.':'No claims yet. A claim is prepared for you when a visit’s charges are posted.'}</td></tr>`;}
function claimFinalStatus(claim,detail={}){return ['void','rejected'].includes(claim?.status)||detail?.tracking?.remittance_posted===true;}
function claimWorkspaceMarkup(){
 const rows=$('claims-tool')?.querySelector('[data-claim-rows]');if(!rows)return;
 const shown=claimRows.filter(claimMatchesStatusFilter).map(claimRowMarkup).join('')||claimEmptyRow(claimRows);
 if(rows.innerHTML!==shown)rows.innerHTML=shown;
 const counts=claimStatusChipsHtml();
 const strip=$('claims-tool')?.querySelector('.claims-status-strip');if(strip&&strip.outerHTML!==counts)strip.outerHTML=counts;
}
function selectClaimStatusFilter(status){
 claimStatusFilter=claimStatusChips.includes(status)?status:'all';
 claimWorkspaceMarkup();
}
let claimViewContext=null;
let claimDraftIdentity;
const claimDrafts=new Map();
function clearClaimDrafts(){claimDrafts.clear();claimDraftIdentity=typeof me==='undefined'?undefined:me;}
function claimDraftSession(){if(claimDraftIdentity!==(typeof me==='undefined'?undefined:me))clearClaimDrafts();}
function claimDraftKey(account,record,parent,kind='packet'){return `${kind}:${account.patient_id}:${account.id}:${record?.id||'new'}:${parent?.id||''}`;}
function captureClaimDraft(form=$('claim-editor-form')||$('claimmd-submit-form')){
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
function claimWorkspaceHost(context=claimViewContext){return context?.kind==='encounter'?$('encounter-claims-detail'):$('claims-detail');}
function claimContextSnapshot(){
 if(!claimViewContext)claimViewContext={kind:'worklist',identity:typeof me==='undefined'?undefined:me,host:$('claims-detail')};
 return claimViewContext;
}
function encounterClaimRoute(){const context=claimViewContext;return context?.kind==='encounter'&&claimContextCurrent(context)?{account:context.account,claim:context.claim||null}:null;}
function claimContextCurrent(context){
 if(!context||context!==claimViewContext||context.identity!==(typeof me==='undefined'?undefined:me))return false;
 if(context.kind!=='encounter')return !context.host||context.host===$('claims-detail');
 return selected===context.patient&&activeVisit?.id===context.visit&&chartSection==='visits'&&encounterSection==='charges'&&context.host===$('encounter-claims-detail')&&(workspace.billing?.accounts||[]).some(a=>a.id===context.account&&a.content.visit_id===context.visit);
}
function requireClaimContext(context,claim){
 if(!claimContextCurrent(context))throw new Error('This page changed. Open the claim again from its visit.');
 if(context.kind==='encounter'&&claim&&(claim.patient_id!==context.patient||claim.account_id!==context.account))throw new Error('This claim does not belong to the selected visit.');
}
function mountEncounterClaims(accountId){
 captureClaimDraft();
 const account=(workspace.billing?.accounts||[]).find(a=>a.id===accountId&&a.content.visit_id===activeVisit?.id);
 if(!account||!selected||!activeVisit)throw new Error('Open the visit for these charges first.');
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('claims'))throw new Error('Claim review requires access to insurance claims.');
 setEncounterSection('charges');
 const container=$('encounter-claims');if(!container)throw new Error('Open Billing & claim in this visit.');
 container.innerHTML='<div class="section-head"><h3>Insurance claim for this visit</h3><button type="button" data-close-encounter-claim>Back to visit billing</button></div><div id="encounter-claims-detail"></div>';container.hidden=false;
 claimViewContext={kind:'encounter',identity:me,patient:selected,visit:activeVisit.id,account:accountId,host:$('encounter-claims-detail')};
 return claimViewContext;
}
async function showEncounterClaim(id,accountId){
 const context=mountEncounterClaims(accountId);
 await loadClaimMdConnection();if(!claimContextCurrent(context))return;
 await showClaim(id);
 if(typeof registerAutoRefresh==='function')$('encounter-claims')?.querySelector('.section-head')?.querySelector('.auto-refresh-updated')?.remove();
}
async function refreshClaimInContext(id,context=claimContextSnapshot()){
 if(!claimContextCurrent(context))return;
 if(context.kind==='worklist'){const next=await showClaimsWorkspace();if(!next||!claimContextCurrent(next))return;}
 await showClaim(id);
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
 const buckets=Object.fromEntries(claimMissingGroups.map(group=>[group.key,{words:[],inputs:new Set()}]));
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
   if(!bucket.words.includes(rule.words))bucket.words.push(rule.words);
   if(rule.input)bucket.inputs.add(rule.input);
   break;
  }
  if(!seen.has(key)){seen.add(key);const bucket=buckets.claim;const words=claimMissingPlain(text);if(!bucket.words.includes(words))bucket.words.push(words);}
 }
 return buckets;
}
// The boxes a named problem belongs in, so the one button focuses the right one.
function claimMissingFocusFields(buckets){
 const fields=new Set();
 for(const bucket of Object.values(buckets||{}))(bucket.inputs||new Set()).forEach(field=>fields.add(field));
 return fields;
}
function claimMissingGroupMarkup(group,bucket){
 if(!bucket.words.length)return '';
 return `<li data-missing-group="${group.key}"><b>${esc(group.label)}</b><ul>${bucket.words.map(words=>`<li>${esc(words)}</li>`).join('')}</ul><button type="button" ${group.attribute}>${esc(group.action)}</button></li>`;
}
function claimMissingMarkup(buckets){
 const lines=claimMissingGroups.map(group=>claimMissingGroupMarkup(group,buckets[group.key])).join('');
 if(!lines)return '';
 return `<section class="claim-missing" data-claim-missing aria-label="Before this can be sent"><h3>Before this can be sent</h3><p class="muted">Each item says where it is fixed. Fix these and the claim can go out.</p><ul>${lines}</ul></section>`;
}
// Staff wording for a list of problems on a screen this brief does not cover (remittances,
// acknowledgments). The claim page has its own grouped list above.
const claimIssues=items=>items.length?`<div class="mapping-notice"><b>What needs fixing</b><ul>${items.map(i=>`<li>${esc(claimMissingIssueText(i))}</li>`).join('')}</ul></div>`:'<p class="claim-clear">No problems found.</p>';
const claimHistory=h=>h.items.map(r=>`<details class="amendment"><summary>v${r.version} · ${esc(r.reason)} · ${esc(date(r.created_at))}</summary><p>Recorded by ${esc(r.actor_id)}</p><pre class="billing-source">${esc(JSON.stringify(r.evidence||r.snapshot,null,2))}</pre></details>`).join('');
const claimTransport=t=>{
 if(!t||typeof t!=='object')return `${esc(t||'Clearinghouse status unavailable')}. Downloading a claim does not send it.`;
 const claimmd=t.claimmd_connected,artifact=t.artifact==='generated';
 const retrieval=(t.retrieval_health||[]).find(item=>(t.routes||[]).some(route=>route.provider==='claim_md'&&route.route_key===item.route_key));
 const health=retrieval?(retrieval.paused?'Automatic response checks are paused':retrieval.last_result?`Last response check: ${human(retrieval.last_result)}`:'Responses have not been checked yet'):'Response check status is not available yet';
 if(claimmd)return `Claim.MD is connected. ${artifact?'A claim file has been prepared for this claim.':'No claim file has been prepared for this claim yet.'} ${health}.`;
 return `No clearinghouse is connected. ${artifact?'A claim file is ready to download and upload to your clearinghouse yourself.':'You can prepare a claim file (837P) and upload it to your clearinghouse yourself.'} Downloading a claim does not send it.`;
};
function claimListMarkup(claims,nextCursor){const shown=claims.filter(claimMatchesStatusFilter);return `<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Patient</th><th>Payer</th><th>Status</th><th class="money-cell">Billed</th><th></th></tr></thead><tbody data-claim-rows>${claimRowsMarkup(shown)||claimEmptyRow(claims)}</tbody></table></div><p class="muted claim-filter-note">The counts cover all your claims, not only the ones on this page.</p>${nextCursor?'<button type="button" data-claims-next>Show more claims</button>':''}`;}
async function claimsAutoRefreshLoad(){
 const context=claimViewContext?claimContextSnapshot():null;
 if(context){
  if(context.kind==='encounter')return autoRefreshStop();
  await showClaimsWorkspace(context.claim,eraCurrent?.id);
  return claimContextCurrent(context)?undefined:autoRefreshStop();
 }
 await showClaimsWorkspace();
 return undefined;
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
async function showClaimsWorkspace(afterClaim,afterEra){
 captureClaimDraft();
 const context={kind:'worklist',identity:typeof me==='undefined'?undefined:me};claimViewContext=context;
 if(!afterClaim)claimStatusFilter='all';
 if(typeof loadClaimmdProviderDefaults==='function')await loadClaimmdProviderDefaults();if(!claimContextCurrent(context))return;
 const [c,r,p,s,counts,claimmd]=await Promise.all([api(`${claimsBase}${afterClaim?'?after='+afterClaim:''}`),api(`${eraBase}${afterEra?'?after='+afterEra:''}`),api('/api/v1/billing/payers'),billingWrite()?api('/api/v1/billing/remittance-sources'):{items:[]},api(`${claimsBase}/status-counts`).catch(()=>({})),loadClaimMdConnection()]);
 if(!claimContextCurrent(context))return;
 claimRows=c.items;eraRows=r.items;billingPayers=p.items;claimNext=c.next_cursor;eraNext=r.next_cursor;claimStatusCounts=counts&&typeof counts==='object'&&counts.counts&&typeof counts.counts==='object'?counts.counts:{};showTool('Claims & remittances');
 $('tools').innerHTML=`<section id="claims-tool"><div class="section-head"><div><h2>Claims and insurance payments</h2><p class="muted">Send claims, see payer responses and post insurance payments.</p></div></div><div class="billing-totals"><span>Claims <b>${c.items.length}</b></span><span>Payments to review <b>${r.items.filter(x=>['staged','reconciled'].includes(x.status)).length}</b></span><span>Payments posted <b>${r.items.filter(x=>x.status==='posted').length}</b></span></div>
 <section class="billing-section"><div class="section-head"><div><h3>Claims</h3><p class="muted">Open a claim to check it, send it or see the payer response.</p></div></div>${claimStatusChipsHtml()}${claimListMarkup(c.items,claimNext)}</section>
 <section class="billing-section"><div class="section-head"><div><h3>Insurance payments</h3><p class="muted">Payments from Claim.MD appear here to review before they post to patient accounts.</p></div></div><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Payer / trace number</th><th>Payment date</th><th>Claims</th><th>Status</th><th class="money-cell">Payment</th><th></th></tr></thead><tbody>${r.items.map(v=>`<tr><td><b>${esc(v.payer_name)}</b><small>${esc(v.trace)}</small></td><td>${esc(displayDate(v.payment_date))}</td><td>${v.claim_count}</td><td><span class="pill">${esc(eraStatusLabel(v.status))}</span></td><td class="money-cell">${money(v.total_paid_cents)}</td><td><button type="button" data-era-open="${v.id}">Review payment</button></td></tr>`).join('')||'<tr><td colspan="6" class="table-empty">No insurance payments yet.</td></tr>'}</tbody></table></div>${eraNext?'<button type="button" data-era-next>Show more payments</button>':''}</section>
 ${s.items.length?`<details class="amendment"><summary>Insurance payments imported from another system (${s.items.length})</summary>${s.items.map(v=>`<div class="timeline-row"><div><b>${esc(v.source_id)}</b><small>${esc(v.source_instance)}</small></div><button type="button" data-era-source="${v.source_history_id}">${v.native_id?'View payment':'Review and import'}</button></div>`).join('')}</details>`:''}<div id="claims-detail"></div></section>`;
  context.host=$('claims-detail');
  await showEraAutomation('claims-detail','beforebegin');
 if(!claimContextCurrent(context))return;await showRecoupments();
 if(!claimContextCurrent(context))return;await showEraBatches();
 if(!claimContextCurrent(context))return;window.eraSources=s.items;
 await decorateClaimsWorkspace(context);
 if(claimContextCurrent(context))registerClaimsAutoRefresh();
 return context;
}
function claimPane(html,{quiet=false}={}){const context=claimContextSnapshot();requireClaimContext(context);const host=claimWorkspaceHost(context);if(!host)return;host.innerHTML=html;if(!quiet)host.scrollIntoView({block:'start'});}
function claimHasRecordedSubmission(detail={}){return detail.tracking?.external_submission_recorded===true||(detail.tracking?.submissions||[]).some(item=>item.status==='delivered');}
function claimHasPreparedSubmission(detail={}){return (detail.tracking?.submissions||[]).some(item=>item.status==='prepared');}
// Claim rows use the same state names as the visit billing card.
function claimStatusLabel(claim){return typeof visitBillingClaimState==='function'?visitBillingClaimState(claim):claimIsCrossover(claim)&&claim.status==='submitted'?'Crossover response received':displayStatus(claim.status);}
function claimIsCrossover(claim){return Boolean(claim?.crossover_tracking_only===true||claim?.snapshot?.coordination_of_benefits?.crossover);}
// The one word on the claim page. The database holds more statuses than staff work with, so several
// of them share a word: 'Paid' needs the posted insurance payment, and 'Denied' arrives as a
// rejection, which is why neither is a claim status of its own.
const claimPlainWords={draft:'Not sent yet',ready:'Not sent yet',submitted:'Sent',accepted:'Accepted',rejected:'Rejected',void:'Voided',denied:'Denied',paid:'Paid'};
function claimPlainStatus(claim,detail={}){
 if(!claim)return '';
 if(claimIsCrossover(claim))return 'Secondary payer answered';
 const status=String(claim.status||'').trim().toLowerCase();
 // The claim row lags the clearinghouse answer by however long the last check took. A file the
 // insurer has received means the claim is out, whatever the row still says, so the one word on the
 // page tells the truth about where the claim is rather than about which column was last written.
 if(['draft','ready'].includes(status)&&claimHasRecordedSubmission(detail))return claimPlainWords.submitted;
 if(status==='adjudicated')return detail?.tracking?.remittance_posted===true?'Paid':'Accepted';
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
 const canWrite=billingWrite(),connected=typeof claimMdConnectionState!=='undefined'&&claimMdConnectionState?.connected===true;
 const blockers=Array.isArray(detail?.preflight_issues)?detail.preflight_issues.filter(Boolean):[];
 const secondaryPlan=claim.snapshot?.account?.coverage_snapshot?.coverage?.content?.priority;
 let words='',button='';
 // A claim file the clearinghouse has already received is out the door whatever the claim row still
 // says, so the next step cannot be to send it again. A file merely prepared is not proof it went.
 const received=claimHasRecordedSubmission(detail);
 if(claim.status==='void')words='This claim is voided. Nothing more goes to the insurer from it.';
 else if(['submitted','accepted','adjudicated'].includes(claim.status))words=claimHasRecordedSubmission(detail)?'This claim has been sent. The answer shows on this page while the claim is open.':claimHasPreparedSubmission(detail)?'A claim file is prepared but not confirmed as received. Open it to check its delivery before preparing another.':'This claim has been sent. Nothing to do until the insurer answers.';
 // The plain-words box at the top already carries the button that opens the claim with the problem
 // field focused. Repeating it here would put two primary buttons on one screen for one action.
 else if(claim.status==='rejected')words=claimCameBack(claim)?'The insurer answer and the button to fix it are at the top of this page.':'The insurer answer is at the top of this page.',button=claimCameBack(claim)?'':'<button type="button" class="primary" data-claim-fix-resend>Fix and resend</button>';
 else if(!canWrite)words='Billing staff check these details and send the claim.';
 else if(claim.status==='ready'&&received)words='This claim has been sent. The answer shows on this page while the claim is open.';
 else if(claim.status==='ready'&&claimHasPreparedSubmission(detail))words='A claim file is prepared but not confirmed as received. Open it to check its delivery before preparing another.';
 else if(claim.status==='ready'&&!blockers.length&&connected)words=`Everything checks out. Send it to ${claim.snapshot?.account?.coverage_snapshot?.payer?.content?.name||'the insurer'} and the answer will show here.`,button=`<button type="button" class="primary" data-claimmd-submit="${esc(claim.id)}">Send claim</button>`;
 else if(claim.status==='ready'&&!connected)words='No claim connection is set up, so it cannot go out from here. Ask the practice owner to check Claim connections, or prepare a claim file to upload to your insurer yourself.',button=`<button type="button" class="primary" data-edi-claim="${esc(claim.id)}">Prepare claim file (837P)</button>`;
 else if(claim.status==='draft'&&!blockers.length)words='Check the service lines, diagnoses and insurance below. The next step asks you to confirm before anything is sent.',button=`<button type="button" class="primary" data-claim-release="${esc(claim.id)}">Send claim</button>`;
 else words=blockers.length?`${blockers.length===1?'1 thing needs':`${blockers.length} things need`} fixing before this can be sent. They are listed below.`:'This claim is being prepared.',button='<button type="button" class="primary" data-edit-claim>Edit claim</button>';
 const cms=claimCms1500Markup(claim);
 const secondary=canWrite&&claim.status==='adjudicated'&&secondaryPlan==='primary'?'<button type="button" data-secondary-claim>Bill secondary insurance</button>':'';
 const correction=canWrite&&!claimIsCrossover(claim)&&claim.status==='adjudicated'&&claim.payer_control_number?'<button type="button" data-replacement-claim>Correct or void this claim</button>':'';
 const download=!claimIsCrossover(claim)&&!['draft','void'].includes(claim.status)?`${claimPacketDownload(claim)}`:'';
 const existing=(detail?.tracking?.submissions||[]).filter(item=>['prepared','delivered'].includes(item.status)&&item.id).at(-1);
 const openFile=existing?`<button type="button" data-claim-existing-submission="${esc(existing.id)}">Open the claim file already prepared</button>`:'';
 const extras=[secondary,correction,openFile].filter(Boolean).join('');
 return `<section class="claim-primary" data-claim-primary aria-label="Next step"><div class="claim-primary-action"><p>${esc(words)}</p><div class="claim-primary-buttons">${button}</div>${options.connectionNotice||''}</div><div class="claim-primary-side">${cms}</div>${extras?`<div class="claim-primary-extra">${extras}</div>`:''}${download?`<p class="claim-primary-download">${download}</p>`:''}${claim.parent_id?`<p class="claim-primary-parent"><button type="button" data-claim-open="${claim.parent_id}">Open the claim this one corrects</button></p>`:''}${options.secondaryEvidence||''}</section>`;
}
// Everything that is not the next step, under one collapsed heading. The panels themselves are the
// ones already on the screen; only where they sit changes. The claim's own status and version stay
// outside so a refresh can still update them in place.
function claimMoreDetailsMarkup(claim,detail={},history={items:[]},sections={}){
 const rows=[
  ['What happened',sections.timeline],
  ['Claim progress',sections.lifecycle],
  ['Claim.MD activity',sections.activity],
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
 if(typeof claimMdConnectionState!=='undefined'&&claimMdConnectionState?.connected===true)return '';
 return '<p class="claim-connection-note" data-claim-connection-note>Claim.MD is not connected, so this claim cannot be sent from here. A claim file can still be prepared and uploaded yourself.</p>';
}
// A claim that came back is worked on from the plain-words box at the top of the screen, so the
// next-step area has one button and never a second instruction competing with it.
function claimCameBack(claim){return typeof claimProblemReport==='function'&&Boolean(claimProblemReport(claim));}
// One step from a checked draft to the send form. Marking the claim ready is recorded the
// same way as the manual action and sends nothing; the person still presses Send.
async function releaseClaimToSend(id){
 const context=claimContextSnapshot(),claim=claimCurrent,identity=typeof me==='undefined'?undefined:me;
 if(!claim||claim.id!==id||claim.status!=='draft')throw new Error('Open the claim again before continuing.');
 requireClaimContext(context,claim);captureClaimDraft();
 await api(`${claimsBase}/${id}/actions`,'POST',{action:'ready',reason:'Claim details reviewed before sending',reference:'',event_date:null,payer_control_number:''},claim.version);
 if(!claimContextCurrent(context)||identity!==(typeof me==='undefined'?undefined:me))return;
 if(typeof loadClaimMdConnection==='function'&&!claimMdConnectionState?.connected)await loadClaimMdConnection();
 const detail=await api(`${claimsBase}/${id}`);if(!claimContextCurrent(context)||identity!==(typeof me==='undefined'?undefined:me))return;
 requireClaimContext(context,detail.claim);claimCurrent=detail.claim;
 if(detail.claim.status==='ready'&&typeof claimMdSubmitEditor==='function'&&typeof claimMdConnectionState!=='undefined'&&claimMdConnectionState?.connected&&!claimHasRecordedSubmission(detail)&&!claimHasPreparedSubmission(detail)){claimMdSubmitEditor(detail);return;}
 await refreshClaimInContext(id,context);
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
 const page=host.innerHTML;
 const withPrimary=replaceMarkupSection(page,'data-claim-primary',claimPrimaryActionMarkup(claim,detail,{connectionNotice:claimConnectionNotice(claim,detail),secondaryEvidence:secondaryEvidenceMarkup(claim)}));
 const withStatus=replaceMarkupSection(withPrimary,'data-claim-current-status',`<span class="status-badge claim-status-word" data-claim-current-status>${esc(claimPlainStatus(claim,detail))}</span>`);
 const withVersion=replaceMarkupSection(withStatus,'data-claim-current-version',`<small class="claim-control" data-claim-current-version>${esc(claim.control_number)} · v${claim.version}</small>`);
 if(withVersion!==page)host.innerHTML=withVersion;
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
function claimStatusPaneMarkup(pane){return pane?.querySelector?.('.billing-account-detail')?.outerHTML??null;}
async function claimDetailAutoRefreshLoad(){
 const context=claimContextSnapshot();if(!claimContextCurrent(context))return autoRefreshStop();
 const id=context.claim;if(!id||claimCurrent?.id!==id)return autoRefreshStop();
 const [d,h]=await Promise.all([api(`${claimsBase}/${id}`),api(`${claimsBase}/${id}/history`)]);
 requireClaimContext(context,d.claim);claimCurrent=d.claim;
 const pane=claimWorkspaceHost(context),markup=claimStatusPaneMarkup(pane);
 const edit=$('claim-editor');
 if(markup)if(edit&&pane===edit)edit.innerHTML=markup;else claimPane(markup,{quiet:true});
 if(typeof startClaimMdTracking==='function')startClaimMdTracking(id);
 if(typeof showClaimMdClaimActivity==='function'&&pane)await showClaimMdClaimActivity(d.claim);
 if(!claimContextCurrent(context))return autoRefreshStop();
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
 try{const built=await build(claim,detail,history,{});if(built)html=built;}catch{}
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
function claimScreenHeadMarkup(claim,account,patient){
 return `<div class="section-head claim-screen-head"><div><h2>Claim review</h2><p class="claim-screen-who"><b>${esc(patient.given_name)} ${esc(patient.family_name)}</b> · Service ${esc(displayDate(account.content.service_date))} · ${esc(account.coverage_snapshot?.payer?.content?.name||'No insurer recorded')} · ${money(account.total_cents)}</p><small class="claim-control" data-claim-current-version>${esc(claim.control_number)} · v${claim.version}</small></div><div class="support-help-group"><span class="status-badge claim-status-word" data-claim-current-status>${esc(claimPlainStatus(claim))}</span>${typeof supportHelpButton==='function'?supportHelpButton('claim',`data-support-claim="${esc(claim.id)}" data-support-claim-label="${esc(claim.control_number)}" data-support-patient="${esc(claim.patient_id)}" data-support-patient-label="${esc(patient.family_name)}, ${esc(patient.given_name)} · MRN ${esc(patient.mrn)}"`):''}</div></div>`;
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
 const missing=claimMissingGroupsFor(claimIsCrossover(claim)?[]:detail.preflight_issues);
 const recordOutside=billingWrite()&&!claimIsCrossover(claim)&&['draft','ready','submitted','accepted'].includes(claim.status)?claimRecordedOutsideMarkup(claim):'';
 const withdraw=billingWrite()&&claimIsCrossover(claim)&&['submitted','accepted','rejected'].includes(claim.status)?`<form id="claim-action"><h3>Remove a wrong crossover link</h3><input type="hidden" name="action" value="withdraw_crossover"><p>You can remove this link only while the secondary payment is not posted. The payment can be linked again later.</p>${billingField('reason','Reason for removing this link','','text',1000,true)}<button type="submit">Remove crossover link</button></form>`:'';
 const sections={recordOutside,providerDetails:claimProviderDetailsMarkup(claim),coverageRecord:claimCoverageRecordMarkup(claim),history:claimHistory(history),responseWords:claimRawResponseMarkup(detail),secondaryEvidence:secondaryEvidenceMarkup(claim)};
 const lines=chargeTable(account.content.lines.map((line,index)=>({...line,diagnosis_codes:(claim.content?.line_diagnosis_pointers?.[index]||[]).map(pointer=>claim.content?.diagnosis_codes?.[pointer-1]).filter(Boolean)})));
 const editClaim=billingWrite()&&claim.status==='draft'?'<button type="button" data-edit-claim>Edit claim details</button>':'';
 return `<section class="billing-account-detail">${claimScreenHeadMarkup(claim,account,patient)}
 ${typeof claimProblemReport==='function'?claimProblemBoxMarkup(claimProblemReport(claim,detail),claimResponseWords(detail),claim.id):''}
 ${claimPrimaryActionMarkup(claim,detail,{connectionNotice:claimConnectionNotice(claim,detail),secondaryEvidence:sections.secondaryEvidence,recordOutside})}
 ${claimIsCrossover(claim)?'<p class="muted">Nothing is sent or downloaded for a crossover claim. The secondary payment stays with the original visit.</p>':claimMissingMarkup(missing)}
 ${claimMoneySummaryMarkup(claim,detail)}
 <div class="claim-lines" data-claim-lines>${lines}</div>
 ${withdraw}
 ${claimMoreDetailsMarkup(claim,detail,history,sections)}
 <div class="actions"><button type="button" data-claim-account="${esc(claim.account_id)}" data-patient="${esc(claim.patient_id)}">Visit billing</button>${editClaim}<button type="button" data-claim-patient="${esc(claim.patient_id)}">Open patient</button><button type="button" data-claim-insurance="${esc(claim.patient_id)}">Open insurance</button></div>
 <div id="claim-editor"></div></section>`;
}
async function showClaim(id){
 const context=claimContextSnapshot(),identity=typeof me==='undefined'?undefined:me;
 const [d,h]=await Promise.all([api(`${claimsBase}/${id}`),api(`${claimsBase}/${id}/history`)]);if(!claimContextCurrent(context)||identity!==(typeof me==='undefined'?undefined:me))return;requireClaimContext(context,d.claim);claimCurrent=d.claim;context.claim=d.claim.id;
 claimPane(claimScreenMarkup(d.claim,d,h));claimDetailOnScreen={claimId:d.claim.id,detail:d};
  // The Claim.MD panels and the "what happened" timeline are filled in after the screen is drawn,
  // and sit inside More details. Each is left alone when its own script is not loaded.
  const claim=d.claim;
  const lifecycle=typeof claimMdClaimLifecycle==='function'?claimMdClaimLifecycle(claim,d,h):'';
  if(lifecycle){const anchor=claimPanelAnchor(claimWorkspaceHost(context));if(anchor?.insertAdjacentHTML)anchor.insertAdjacentHTML('beforeend',`<section class="claim-more-item" data-claim-more="claim-progress"><h3>Claim progress</h3>${lifecycle}</section>`);}
  // "What happened" gets its own container, placed after the rejection box above the
  // lifecycle panel, so the other panels can be replaced without touching it.
  insertClaimStatusTimeline(context,claim,d,h);
  const action=$('claim-action');if(action){action.claimViewContext=context;action.claimRecord=claim;}
  if(typeof startClaimMdTracking==='function')startClaimMdTracking(claim.id);
  if(typeof showClaimMdClaimActivity==='function')await showClaimMdClaimActivity(claim);
  if(typeof registerAutoRefresh==='function'){if(['submitted','accepted','adjudicated'].includes(claim.status)&&claimContextCurrent(context)&&context.kind==='worklist')registerClaimDetailAutoRefresh();else unregisterAutoRefresh('claim-status');}
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
 const html=`<section><h3>Bill secondary insurance</h3><p>This bills the same ${money(data.account.total_cents)} in visit charges. Check the primary EOB/ERA first to see whether the primary payer already forwarded the claim.</p>${existing.map(c=>`<p>Existing secondary claim ${esc(c.control_number)} · ${esc(c.status)} <button type="button" data-claim-open="${esc(c.id)}">Review existing secondary claim</button></p>`).join('')}${claimIssues(data.blockers||[])}${row?`<p>Primary paid ${money(row.paid_cents)} · Patient responsibility reported ${money(row.patient_responsibility_cents)} · ${esc(adjudication.payment_date)} · Trace ${esc(adjudication.trace)}</p><details><summary>Review primary services and adjustments</summary><pre class="billing-source">${esc(JSON.stringify(row,null,2))}</pre></details>`:''}${crossover}${!(data.blockers||[]).length&&choices.length&&row?`<form id="secondary-claim-review">${coveragePickerMarkup(choices)}<p class="muted">Enter the units the primary payer paid for each service, from the EOB.</p>${row.services.map((line,i)=>`<label>Primary line ${i+1}: ${esc(line.code)} · Paid ${money(line.paid_cents)} · Paid units<input name="paid_units_${i}" type="number" required min="1" max="1000" step="1"></label>`).join('')}<label class="review-ack"><input name="not_forwarded" type="checkbox" required> I reviewed the EOB/ERA and the primary payer has not forwarded this claim to the secondary payer.</label><label class="review-ack"><input name="timing_reviewed" type="checkbox" required> I confirmed when the secondary payer accepts this claim, including any waiting period (Medicare and Blue plan crossover may have one).</label><label>How you confirmed this (EOB date, call reference or portal)<input name="crossover_reference" required maxlength="1000"></label><button type="submit" class="primary">Continue</button></form>`:!choices.length?'<p>No other active secondary insurance is on file for this visit date. Add it under Insurance, or open the existing secondary claim above.</p>':''}</section>`;
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
function claimLineDiagnosisMarkup(account,content){
 const codes=claimDiagnosisChoices(content);
 const pointers=Array.isArray(content.line_diagnosis_pointers)?content.line_diagnosis_pointers:[];
 if(!codes.length)return '<p class="muted claim-line-diagnosis-empty">Fill in the diagnosis codes above first, then tick which ones apply to each charge line.</p>';
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
function claimEditor(b,c=null,source=null,parent=null,coordination=null){
 captureClaimDraft();b={...b,patient_id:b.patient_id||c?.patient_id||parent?.patient_id};
 const context=claimContextSnapshot();requireClaimContext(context,c||parent||{patient_id:b.patient_id,account_id:b.id});
 claimAccount=b;claimSource=source;const defaults=typeof claimmdClaimProviderDefaults==='function'?claimmdClaimProviderDefaults():{},coverage=b.coverage_snapshot?.coverage?.content||{},patientAddress=source?'':claimPatientAddressDefault(b),diagnoses=source?{diagnosis_codes:[],line_diagnosis_pointers:b.content.lines.map(()=>[])}:claimChargeDiagnosisDefaults(b);const v=c?.content||(coordination?{...parent.content,subscriber_address:coverage.relationship==='self'?parent.content.patient_address:'',subscriber_birth_date:coverage.subscriber_birth_date||'',external_control_number:''}:parent?.content)||{billing_provider_name:defaults.billing_provider_name||'',billing_npi:defaults.billing_npi||'',tax_id:'',billing_address:defaults.billing_address||'',rendering_npi:defaults.rendering_npi||'',patient_address:patientAddress,subscriber_address:coverage.relationship==='self'?patientAddress:'',subscriber_birth_date:coverage.subscriber_birth_date||'',place_of_service:'',...diagnoses,external_control_number:'',notes:'',synthetic_test:false};
 const html=`<form id="claim-editor-form" data-request="${crypto.randomUUID()}" data-edit="${c?.id||''}" data-parent="${parent?.id||''}"><h3>${c?'Edit draft claim':source?'Create a claim from an imported record':coordination?'Create secondary claim':parent?'Create corrected claim':'Create claim'}</h3>${sourceNotice(source)}<p>${money(b.total_cents)} in charges · Service ${esc(displayDate(b.content.service_date))}</p><div class="form-grid">${parent&&!coordination?selectField('frequency','Claim frequency',parent.payer_control_number?['replacement','void_request']:['original'],parent.payer_control_number?'replacement':'original'):'<input type="hidden" name="frequency" value="original">'}${billingField('billing_provider_name','Billing provider name',v.billing_provider_name)}${billingField('billing_npi','Billing NPI',v.billing_npi,'text',10)}${billingField('rendering_npi','Rendering NPI',v.rendering_npi,'text',10)}${billingField('tax_id','Tax ID / EIN (9 digits)',v.tax_id,'text',9)}${billingField('billing_address','Billing address',v.billing_address,'text',1000)}${billingField('patient_address','Patient address',v.patient_address,'text',1000)}${billingField('subscriber_address','Subscriber address',v.subscriber_address,'text',1000)}${billingField('subscriber_birth_date','Subscriber date of birth',v.subscriber_birth_date||'','date')}${billingField('place_of_service','Place of service code (2 digits, 11 = office)',v.place_of_service,'text',2)}${billingField('diagnosis_codes','ICD-10 diagnosis codes (comma-separated)',v.diagnosis_codes.join(', '),'text',250)}${billingField('external_control_number','Claim number from a previous system',v.external_control_number,'text',100)}</div>${claimLineDiagnosisMarkup(b,v)}<label>Notes<textarea name="notes" maxlength="2000">${esc(v.notes)}</textarea></label>${billingField('reason','Reason (saved in the claim history)','','text',1000,true)}${source?'<label class="review-ack"><input type="checkbox" required> I checked that the patient, payer, charges and claim number match the imported record.</label>':''}<button type="submit" class="primary">Save draft claim</button></form>`;
 if($('claim-editor'))$('claim-editor').innerHTML=html;else claimPane(html);
 const editorHost=$('claim-editor')||claimWorkspaceHost(context);
 if(editorHost){editorHost.scrollIntoView({block:'start'});const editorHeading=editorHost.querySelector('#claim-editor-form h3');if(editorHeading){editorHeading.tabIndex=-1;editorHeading.focus({preventScroll:true});editorHeading.id='claim-editor-heading';}}
 const form=document.querySelector('#claim-editor-form');
 if(form){form.claimViewContext=context;form.claimAccount=b;form.claimRecord=c;form.claimSource=source;form.claimParent=parent;form.claimCoordination=coordination;}
 form?.querySelector('.form-grid')?.insertAdjacentHTML('beforebegin',`<label class="review-ack"><input name="synthetic_test" type="checkbox" ${v.synthetic_test?'checked':''}><span><b>Test claim</b><small>Tick only for a made-up patient and insurance. The claim gets an SCTEST control number, and a live clearinghouse account may still charge for it.</small></span></label>`);
 restoreClaimDraft(form,b,c,parent,coordination?'secondary:'+coordination.coverage_id:source?'source:'+source.source_history_id:'packet',coordination?JSON.stringify([b.version,coordination]):undefined);
}
async function beginClaim(accountId,source){
 const patient=selected,identity=me,account=workspace.billing.accounts.find(b=>b.id===accountId);
 if(!account)throw new Error('These charges are no longer available.');
 if(chartSection==='visits'&&activeVisit&&account.content.visit_id===activeVisit.id){const context=mountEncounterClaims(accountId);if(typeof loadClaimmdProviderDefaults==='function')await loadClaimmdProviderDefaults();if(!claimContextCurrent(context))return;claimEditor({...account,patient_id:patient},null,source);return;}
 await showClaimsWorkspace();if(selected!==patient||me!==identity)return;claimEditor({...account,patient_id:patient},null,source);
}
function eraImportEditor(source=null){
 eraSource=source;const raw=source?.source_data;const html=`<form id="era-import" data-request="${crypto.randomUUID()}"><button type="button" class="batch-panel" data-batch-from-era>Open as an 835 file with several payments</button><h2>${source?.remote_report_id?'Review ERA from the clearinghouse':source?'Review imported insurance payment':'Import an insurance payment (ERA/835)'}</h2>${sourceNotice(source?{...source,policy:'Check the payer and that this is the right document. Importing does not post anything.'}:null)}${raw?.settlement_mapping?`<details class="amendment"><summary>Provider adjustments and reversals in the imported record</summary><pre class="billing-source">${esc(JSON.stringify({settlement:raw.settlement_mapping,source_ar_references:raw.source_ar_references||[]},null,2))}</pre></details>`:''}${raw?.provider?`<div class="mapping-notice"><b>${esc(raw.provider)} ERA ${esc(raw.provider_report_id||'')}</b><p>Payer in the imported record: ${esc(raw.source_payer_id||'')}. Importing does not post a payment.</p></div>`:''}<div class="form-grid">${payerPickerMarkup('payer','Insurance company',{value:raw?.source_payer_id||''})}${selectField('format','File format',['x12_835','normalized'],raw?.format||'x12_835')}<label>Choose file<input id="era-file" type="file" accept=".835,.txt,.json"></label></div><label>835 text (or JSON)<textarea name="document_text" rows="12" maxlength="1048576" required>${esc(raw?.original_text|| (raw?.document?JSON.stringify(raw.document,null,2):''))}</textarea></label><p class="muted">One payment per file, up to 1 MB, 1,000 claim rows and 1,000 provider adjustments (PLB), in US dollars.</p><details class="amendment"><summary>JSON format example</summary><pre class="billing-source">${esc(JSON.stringify({payer_code:'YOUR-PAYER-CODE',trace:'UNIQUE-TRACE',payment_date:'2026-10-23',total_paid_cents:8000,currency:'USD',claims:[{control_number:'SC… or claim number from a previous system',payer_control_number:'PAYER-CLAIM-ID',status:'1',patient_name:'Sample Patient',charged_cents:12550,paid_cents:8000,patient_responsibility_cents:2000,adjustments:[{group:'CO',reason_code:'45',amount_cents:2550,service_index:null},{group:'PR',reason_code:'1',amount_cents:2000,service_index:null}],services:[]}]},null,2))}</pre></details>${billingField('reason','Reason (saved in the history)','','text',1000,true)}<button class="primary" type="submit">Import for review</button></form>`;claimPane(html);typeaheadInit(claimWorkspaceHost()||document);}
async function showEra(id){
 const context=claimContextSnapshot(),identity=typeof me==='undefined'?undefined:me;
 const [d,h]=await Promise.all([api(`${eraBase}/${id}`),api(`${eraBase}/${id}/history`)]);if(!claimContextCurrent(context)||identity!==(typeof me==='undefined'?undefined:me))return;eraCurrent=d.remittance;const r=eraCurrent,doc=r.document,editable=billingWrite()&&['staged','reconciled'].includes(r.status),suggested=Boolean(d.automation)&&r.version===2;
 claimPane(`<section class="billing-account-detail"><div class="section-head"><div><h2>Insurance payment (ERA)</h2><p>${esc(r.trace)} · ${esc(payerName(r.payer_id))} · ${esc(doc.payment_date)}</p><small>v${r.version} · ${esc(doc.payer_code)}</small></div><span class="status-badge">${esc(eraStatusLabel(r.status))}</span></div><div class="billing-totals"><span>Payment total <b>${money(doc.total_paid_cents)}</b></span><span>Claim payments <b>${money(doc.claims.reduce((sum,c)=>sum+c.paid_cents,0))}</b></span><span>Provider adjustments (PLB) <b>${money((doc.provider_adjustments||[]).reduce((sum,p)=>sum+p.amount_cents,0))}</b></span><span>Claims <b>${doc.claims.length}</b></span><span>Currency <b>${esc(doc.currency)}</b></span></div>${['staged','reconciled'].includes(r.status)?claimIssues(d.issues):`<div class="mapping-notice"><b>${r.status==='reversed'?'Posting undone':r.status==='posted'?'Payment posted':'Payment file rejected'}</b><p>${r.status==='reversed'?'The posting was undone. The original amounts are kept below for reference.':r.status==='posted'?'The payment and the selected contractual write-offs (CO) were posted together.':'This payment file was rejected and nothing was posted.'}</p></div>`}${suggested?'<p class="mapping-notice">These matches were suggested automatically. Check each claim and its balance before saving.</p>':''}${doc.supplemental?.length?`<details class="amendment"><summary>Other amounts from the payer (${doc.supplemental.length})</summary><p>These amounts are for information only. They do not add payments or patient charges.</p><pre class="billing-source">${esc(JSON.stringify(doc.supplemental,null,2))}</pre></details>`:''}<form id="era-matches">${doc.claims.map((row,i)=>{const m=r.matches.find(m=>m.row_index===i);return `<fieldset class="era-row" data-row="${i}"><legend>Claim ${i+1} · ${esc(row.control_number)}</legend><p>${esc(row.patient_name)} · Payer claim ${esc(row.payer_control_number)} · Claim status code ${esc(row.status)}</p><div class="billing-totals"><span>Charges <b>${money(row.charged_cents)}</b></span><span>Paid <b>${money(row.paid_cents)}</b></span><span>Patient responsibility (PR) <b>${money(row.patient_responsibility_cents)}</b></span></div>${editable?`<label>SunCharts claim<select name="claim_id"><option value="">Choose the matching claim</option>${claimRows.filter(c=>c.payer_id===r.payer_id&&['adjudicated','submitted','accepted'].includes(c.status)).map(c=>`<option value="${c.id}" ${m?.claim_id===c.id?'selected':''}>${esc(c.patient_name)} · ${esc(c.control_number)} · ${money(c.total_cents)}</option>`).join('')}${m&&!claimRows.some(c=>c.id===m.claim_id)?`<option value="${m.claim_id}" selected>Matched claim ${esc(m.claim_id)}</option>`:''}</select></label><label>Or paste the claim ID<input name="claim_lookup" placeholder="For a claim that is not in the list"></label><button type="button" data-era-inspect="${i}">Check claim and balance</button>`:`<p>Matched claim: ${m?`<button type="button" data-claim-open="${m.claim_id}">${esc(m.claim_id.slice(0,8))}</button>`:'None'}</p>`}${editable&&row.status!=='22'?`<details class="amendment" ${m?.correction_of_remittance_id?'open':''}><summary>This corrects an earlier reversal</summary><div class="form-grid"><label>ID of the payment with the reversal<input name="correction_of_remittance_id" value="${esc(m?.correction_of_remittance_id||'')}"></label><label>Claim row in that payment<input name="correction_of_row" type="number" min="1" max="1000" value="${m?.correction_of_row_index===undefined?'':m.correction_of_row_index+1}"></label></div><p class="muted">If the reversal is in this same payment, use ${esc(r.id)} and its claim row.</p></details>`:''}${editable&&row.status==='22'?`<div class="form-grid"><label>ID of the original posted payment<input name="reverses_remittance_id" value="${esc(m?.reverses_remittance_id||'')}" required></label><label>Claim row in that payment<input name="reverses_row" type="number" min="1" max="1000" value="${m?.reverses_row_index===undefined?'':m.reverses_row_index+1}" required></label></div><p class="mapping-notice">A reversal (claim status 22) must match the original posted claim and adjustments exactly.</p>`:''}<div class="era-match-evidence">${m?`${suggested?'Suggested - check the claim':'Checked'} · claim v${m.claim_version} · account v${m.account_version}`:'No claim matched yet'}</div><h4>Adjustments</h4>${row.adjustments.map((a,j)=>`<label class="review-ack">${editable&&row.status!=='22'&&a.group==='CO'?`<input type="checkbox" name="writeoff" value="${j}" ${m?.writeoff_adjustments.includes(j)?'checked':''}>`:'<span class="pill">'+esc(a.group)+'</span>'}<span>${esc(a.group)} · ${esc(a.reason_code)} · ${money(a.amount_cents)}${a.service_index===null?'':` · Service ${a.service_index+1}`}<small>${a.group==='CO'?(editable?'Tick to write off this contractual amount.':m?.writeoff_adjustments.includes(j)?'Written off.':'Not written off.'):'Shown for reference. Not written off.'}</small></span></label>`).join('')||'<p>No adjustments.</p>'}${row.services.length?`<details><summary>Service lines (${row.services.length})</summary><pre class="billing-source">${esc(JSON.stringify(row.services,null,2))}</pre></details>`:''}</fieldset>`;}).join('')}${editable?`${billingField('reason','Reason (saved in the history)','','text',1000,true)}<button class="primary" type="submit">Save matches</button>`:''}</form>
 ${billingWrite()&&!d.batch_id&&['staged','reconciled','posted'].includes(r.status)?`<form id="era-action"><h3>${r.status==='posted'?'Undo posting':'Post or reject this payment'}</h3><label>Action<select name="action">${r.status==='posted'?'<option value="reverse">Undo everything posted from this payment</option>':`${d.ready_to_post?'<option value="post">Post payment and selected write-offs</option>':''}<option value="reject">Reject this payment file</option>`}</select></label>${billingField('reason','Reason (saved in the history)','','text',1000,true)}<label class="review-ack"><input type="checkbox" required> I checked the claim matches, payment, write-offs and account balances.</label><p class="muted">Patient responsibility (PR) is never written off automatically.</p><button type="submit" class="primary">Confirm</button></form>`:''}${d.postings.length?`<h3>What was posted</h3><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Claim / account</th><th>Patient responsibility</th><th>Write-off (CO)</th><th>Current account balance</th></tr></thead><tbody>${d.postings.map(p=>`<tr><td>${esc(p.claim_id.slice(0,8))}<small>Account ${esc(p.account_id.slice(0,8))}</small></td><td>${money(p.patient_responsibility_cents)}</td><td>${money(p.writeoff_cents)}</td><td>${esc(eraCurrentBalance(p.current_account_balance_cents))}</td></tr>`).join('')}</tbody></table></div>`:''}<details class="amendment"><summary>Original payment file · ID ${esc(r.document_hash.slice(0,16))}</summary><pre class="billing-source">${esc(r.original_text||JSON.stringify(doc,null,2))}</pre></details><h3>Payment history</h3>${claimHistory(h)}</section>`);
 if(d.batch_id)$('claims-detail').insertAdjacentHTML('afterbegin',`<div class="batch-panel mapping-notice"><b>This payment is part of a larger 835 file</b><p>Save the matches here, then post or undo the whole file from the file page.</p><button type="button" data-batch-open="${d.batch_id}">Open the whole file</button></div>`);
 await showProviderSettlement(id);
 const fields=$('era-matches').querySelectorAll('.era-row');for(const field of fields){const m=r.matches.find(m=>m.row_index===Number(field.dataset.row));if(m&&!suggested)field.reviewedMatch={...m};}
}
async function inspectEraMatch(index){
 const field=$('era-matches').querySelector(`[data-row="${index}"]`),id=field.querySelector('[name=claim_lookup]').value.trim()||field.querySelector('[name=claim_id]').value;if(!id)throw new Error('Select a claim first.');
 const d=await api(`${claimsBase}/${encodeURIComponent(id)}`),c=d.claim,b=await api(`/api/v1/patients/${c.patient_id}/billing`),a=b.accounts.find(a=>a.id===c.account_id);if(!a)throw new Error('The charges for this claim could not be found.');const balance=a.total_cents+b.entries.filter(e=>e.account_id===a.id).reduce((sum,e)=>sum+e.effect_cents,0);
 field.reviewedMatch={row_index:index,claim_id:c.id,claim_version:c.version,account_version:a.version,writeoff_adjustments:[]};field.querySelector('.era-match-evidence').innerHTML=`<b>${esc(c.snapshot.patient.given_name)} ${esc(c.snapshot.patient.family_name)}</b><p class="claim-control">${esc(c.control_number)} · ${esc(c.status)}</p><p>Claim v${c.version} · Account v${a.version} · Current open balance <b>${money(balance)}</b></p>${c.snapshot.coordination_of_benefits?`<div class="mapping-notice"><b>Primary credits already on this account: ${money((c.snapshot.coordination_of_benefits.primary_credits||[]).reduce((n,a)=>n+a.amount_cents,0))}</b><p>The primary payer write-offs are already on this account. Do not write them off again.</p><pre>${esc(JSON.stringify(c.snapshot.coordination_of_benefits.primary_credits||[],null,2))}</pre></div>`:''}`;
 const history=await api(`${claimsBase}/${c.id}/era-history`);field.chainHistory=history.items;field.querySelector('.era-match-evidence').insertAdjacentHTML('beforeend',`<details class="amendment"><summary>Earlier posted payments for this claim (${history.items.length})</summary>${history.active_head?`<p><b>Current posting</b> · ${esc(history.active_head.remittance_id)} · Row ${history.active_head.row_index+1} · Claim v${history.active_head.claim_version}</p>`:''}${history.items.map((h,i)=>`<p>${esc(h.trace)} · Row ${h.row_index+1} · ${esc(h.status)} · ${h.claim.status==='22'?'Reversal':'Payment'} · ${money(h.claim.paid_cents)}<small>${esc(h.remittance_id)}</small><button type="button" data-chain-select="${i}" data-chain-row="${index}">Use this payment</button></p>`).join('')||'<p>No posting history for this claim.</p>'}</details>`);

}
document.addEventListener('change',e=>{if(e.target.id==='era-file')run(async()=>{const f=e.target.files[0];if(!f)return;if(f.size>1048576)throw new Error('File is larger than 1 MB.');$('era-import').elements.document_text.value=await f.text();});if(e.target.name==='claim_id'||e.target.name==='claim_lookup'){const row=e.target.closest('.era-row');if(row){row.reviewedMatch=null;row.querySelector('.era-match-evidence').textContent='Use Check claim and balance before saving.';}}});
document.addEventListener('click',e=>{const chip=e.target.closest?.('#claims-tool [data-claim-status]');if(chip){e.preventDefault();selectClaimStatusFilter(chip.dataset.claimStatus);return;}
 const b=e.target.closest('button');if(!b||b.hasAttribute('data-chain-select')||b.closest('.batch-panel')||b.closest('.settlement-panel')||b.closest('.era-automation-panel')||b.dataset.ediClaim||b.type==='submit'||(!b.closest('#claims-tool')&&!b.closest('#encounter-claims')&&!b.dataset.newClaim&&!b.dataset.mapClaim))return;const owned=['newClaim','mapClaim','sourceClaimAccount','claimAccount','claimOpen','claimRelease','claimExistingSubmission','eraOpen','eraSource','eraInspect'].some(key=>b.dataset[key]!==undefined)||['data-claims-next','data-era-next','data-edit-claim','data-secondary-claim','data-replacement-claim','data-new-era','data-close-encounter-claim','data-rebase-claim-draft','data-discard-claim-draft','data-claim-fix-resend'].some(name=>b.hasAttribute(name));if(!owned)return;run(async()=>{
 if(b.hasAttribute('data-rebase-claim-draft')){const form=$('claim-editor-form')||$('claimmd-submit-form');requireClaimContext(form.claimViewContext);form.claimDraftStale=false;form.querySelectorAll('button[type="submit"]').forEach(submit=>submit.disabled=false);form.querySelectorAll('[data-claim-draft-notice]').forEach(n=>n.remove());captureClaimDraft(form);return;}
 if(b.hasAttribute('data-discard-claim-draft')){const form=$('claim-editor-form')||$('claimmd-submit-form');requireClaimContext(form.claimViewContext);claimDrafts.delete(form.claimDraftKey);const account=form.claimAccount,record=form.claimRecord,source=form.claimSource,parent=form.claimParent;form.claimDraftKey=null;if(form.id==='claimmd-submit-form')claimMdSubmitEditor(form.claimMdDetail);else claimEditor(account,record,source,parent);return;}
 if(b.hasAttribute('data-close-encounter-claim')){const context=claimContextSnapshot();requireClaimContext(context);captureClaimDraft();$('encounter-claims').replaceChildren();$('encounter-claims').hidden=true;claimViewContext=null;return;}
 if(b.dataset.newClaim){await beginClaim(b.dataset.newClaim);return;}
 if(b.dataset.mapClaim){const m=await api(`/api/v1/patients/${selected}/history/${b.dataset.mapClaim}/claim-mapping`);if(m.native_id){await showClaimsWorkspace();await showClaim(m.native_id);return;}const candidates=workspace.billing.accounts.filter(a=>a.status==='posted'&&a.coverage_snapshot),patient=selected;await showClaimsWorkspace();claimSource=m;claimPane(`<h2>Create a claim from an imported record</h2>${sourceNotice(m)}<p>Choose the posted charges this claim belongs to.</p>${candidates.map(a=>`<button type="button" data-source-claim-account="${a.id}" data-patient="${patient}">${esc(a.content.service_date)} · ${money(a.total_cents)} · ${a.id.slice(0,8)}</button>`).join('')||'<p>No posted charges with insurance for this patient. Post the charges in the patient chart first.</p>'}`);window.claimSourceAccounts=candidates;return;}
 if(b.dataset.sourceClaimAccount){claimEditor({...window.claimSourceAccounts.find(a=>a.id===b.dataset.sourceClaimAccount),patient_id:b.dataset.patient},null,claimSource);return;}
 if(b.hasAttribute('data-claims-next')){await showClaimsWorkspace(claimNext);return;}if(b.hasAttribute('data-era-next')){await showClaimsWorkspace(null,eraNext);return;}
 if(b.dataset.claimAccount){const context=claimContextSnapshot();requireClaimContext(context,claimCurrent);billingSelected=b.dataset.claimAccount;if(context.kind==='encounter'){captureClaimDraft();$('encounter-claims').replaceChildren();$('encounter-claims').hidden=true;claimViewContext=null;showBillingAccount(b.dataset.claimAccount,false,true);$('encounter-billing-detail')?.scrollIntoView({block:'start'});return;}await showClinical();await selectPatient(b.dataset.patient);showBillingAccount(b.dataset.claimAccount);return;}
 if(b.dataset.claimExistingSubmission){await reviewExistingClaimSubmission(b.dataset.claimExistingSubmission);return;}
 if(b.dataset.claimRelease){await releaseClaimToSend(b.dataset.claimRelease);return;}
 if(b.dataset.claimOpen){await showClaim(b.dataset.claimOpen);return;}if(b.hasAttribute('data-edit-claim')){claimEditor(claimCurrent.snapshot.account,claimCurrent);return;}
  if(b.hasAttribute('data-claim-fix-resend')){await beginClaimFix(b.dataset.claimFixClaim||claimCurrent?.id||'',b.dataset.claimFixField||'');return;}
 if(b.dataset.claimPatient){await openClaimPatientRecord(b.dataset.claimPatient,'profile');return;}
 if(b.dataset.claimInsurance){await openClaimPatientRecord(b.dataset.claimInsurance,'insurance');return;}
 if(b.hasAttribute('data-secondary-claim')){await reviewSecondaryClaim();return;}
 if(b.hasAttribute('data-replacement-claim')){const context=claimContextSnapshot(),c=claimCurrent;requireClaimContext(context,c);const b=await api(`/api/v1/patients/${c.patient_id}/billing`);if(!claimContextCurrent(context))return;const account=b.accounts.find(a=>a.id===c.account_id);claimEditor({...account,patient_id:c.patient_id,...(c.snapshot.coordination_of_benefits?{coverage_snapshot:c.snapshot.account.coverage_snapshot,content:{...account.content,coverage_id:c.snapshot.account.content.coverage_id}}:{})},null,null,c);return;}
 if(b.hasAttribute('data-new-era')){eraImportEditor();return;}if(b.dataset.eraOpen){await showEra(b.dataset.eraOpen);return;}if(b.dataset.eraSource){const s=window.eraSources.find(s=>s.source_history_id===b.dataset.eraSource);if(s.batch_id)await showEraBatch(s.batch_id);else if(s.native_id)await showEra(s.native_id);else eraImportEditor(s);return;}if(b.dataset.eraInspect!==undefined)await inspectEraMatch(Number(b.dataset.eraInspect));
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
 const content={};for(const key of ['billing_provider_name','billing_npi','tax_id','billing_address','rendering_npi','patient_address','subscriber_address','place_of_service','external_control_number','notes'])content[key]=data[key];content.tax_id_type=form.claimRecord?.content?.tax_id_type||'';
 content.synthetic_test=data.synthetic_test==='on';content.subscriber_birth_date=data.subscriber_birth_date||null;content.diagnosis_codes=data.diagnosis_codes.split(',').map(s=>s.trim()).filter(Boolean);content.line_diagnosis_pointers=readTicked?claimLineDiagnosisValues(form,claimDiagnosisChoices(content),account.content.lines.length):(record?.content?.line_diagnosis_pointers||[]);
 const unlock=lockClaimForm(form);
 try{
  const claim=form.dataset.edit?await api(`${claimsBase}/${form.dataset.edit}`,'PUT',{content,reason:data.reason},record.version):await api(`/api/v1/patients/${account.patient_id}/billing/accounts/${account.id}/claims`,'POST',{request_id:form.dataset.request,source_history_id:source?.source_history_id||null,parent_id:form.dataset.parent||null,frequency:data.frequency,content,reason:data.reason,...(form.claimCoordination?{coordination:form.claimCoordination}:{})},account.version);
  if(form.claimDraftKey&&context.identity===(typeof me==='undefined'?undefined:me))claimDrafts.delete(form.claimDraftKey);await refreshClaimInContext(claim.id,context);
 }finally{unlock();}
}
document.addEventListener('submit',e=>{const f=e.target;if(!['claim-editor-form','claim-action','era-import','era-matches','era-action'].includes(f.id))return;e.preventDefault();run(async()=>{const d=Object.fromEntries(new FormData(f));
 if(f.id==='claim-editor-form')await saveClaimEditorForm(f,d);
 if(f.id==='claim-action'){const context=f.claimViewContext||claimContextSnapshot(),claim=f.claimRecord||claimCurrent;requireClaimContext(context,claim);d.event_date=d.event_date||null;await api(`${claimsBase}/${claim.id}/actions`,'POST',d,claim.version);await refreshClaimInContext(claim.id,context);}
 if(f.id==='era-import'){const body={request_id:f.dataset.request,payer_id:d.payer_id,format:d.format,source_history_id:eraSource?.source_history_id||null,remote_report_id:eraSource?.remote_report_id||null,reason:d.reason,document:d.format==='normalized'?JSON.parse(d.document_text):null,original_text:d.format==='x12_835'?d.document_text:null};const r=await api(eraBase,'POST',body);await showClaimsWorkspace();await showEra(r.id);}
 if(f.id==='era-matches'){const matches=Array.from(f.querySelectorAll('.era-row')).map(row=>{if(!row.reviewedMatch)throw new Error('Use Check claim and balance on every row first.');return {...row.reviewedMatch,correction_of_remittance_id:row.querySelector('[name=correction_of_remittance_id]')?.value.trim()||null,correction_of_row_index:row.querySelector('[name=correction_of_remittance_id]')?.value.trim()?Number(row.querySelector('[name=correction_of_row]').value)-1:null,reverses_remittance_id:row.querySelector('[name=reverses_remittance_id]')?.value.trim()||null,reverses_row_index:row.querySelector('[name=reverses_row]')?Number(row.querySelector('[name=reverses_row]').value)-1:null,writeoff_adjustments:Array.from(row.querySelectorAll('[name=writeoff]:checked')).map(c=>Number(c.value))};});await api(`${eraBase}/${eraCurrent.id}/matches`,'PUT',{matches,reason:d.reason},eraCurrent.version);const id=eraCurrent.id;await showClaimsWorkspace();await showEra(id);}
 if(f.id==='era-action'){await api(`${eraBase}/${eraCurrent.id}/actions`,'POST',{action:d.action,reason:d.reason},eraCurrent.version);const id=eraCurrent.id;await showClaimsWorkspace();await showEra(id);}
 notice('Saved.');});});

document.addEventListener('click',e=>{const b=e.target.closest('[data-chain-select]');if(!b)return;const field=$('era-matches').querySelector(`[data-row="${b.dataset.chainRow}"]`),source=field.chainHistory[Number(b.dataset.chainSelect)],reversal=field.querySelector('[name=reverses_remittance_id]');if(reversal){reversal.value=source.remittance_id;field.querySelector('[name=reverses_row]').value=source.row_index+1;}else{field.querySelector('[name=correction_of_remittance_id]').value=source.remittance_id;field.querySelector('[name=correction_of_row]').value=source.row_index+1;}notice('Payment selected. Check it is the right one before saving.');});

async function decorateClaimsWorkspace(context){
 if(!claimContextCurrent(context))return;
 const heading=$('claims-tool')?.querySelector('.section-head');
 const subtitle=heading?.querySelector('.muted');
 if(subtitle)subtitle.textContent='Send claims, see payer responses and post insurance payments.';
 if(heading)heading.insertAdjacentHTML('afterend',claimMdConnectionCard());
 const setting=claimMdConnectionState?.active?.id;
 if(setting&&typeof claimmdAccountUploads==='function'){
  const account=await claimmdAccountUploads(setting,{refresh:true});
  if(!claimContextCurrent(context))return;const firstSection=$('claims-tool')?.querySelector('.billing-section');
  const uploadsBlock=`<details class="amendment claim-advanced"><summary>Files received by Claim.MD (${account.uploads.length})</summary>${account.html}</details>`,detailHost=$('claims-detail');if(detailHost?.insertAdjacentHTML)detailHost.insertAdjacentHTML('beforebegin',uploadsBlock);else if(firstSection)firstSection.insertAdjacentHTML('beforebegin',uploadsBlock);
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
