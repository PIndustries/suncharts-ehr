// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let claimMdConnectionState;
async function loadClaimMdConnection(guard){
 const state=await api('/api/v1/billing/claimmd/status');
 if(!guard||guard())claimMdConnectionState=state;
 return state;
}
function claimMdConnectionCard(state=claimMdConnectionState){
 if(state===undefined)return '<p class="muted" role="status">Checking clearinghouse connection…</p>';
 if(!state?.configured)return `<section class="mapping-notice"><div class="section-head"><div><b>No clearinghouse is connected</b><p>Connect your clearinghouse account to check eligibility, send claims and receive insurance payments here.</p></div>${me?.role==='owner'?'<button type="button" class="primary" data-provider-new>Connect a clearinghouse</button>':''}</div></section>`;
 if(!state.connected)return '<section class="mapping-notice"><b>The clearinghouse is not working yet</b><p>The saved clearinghouse account key was not accepted or the connection is turned off. Ask the practice owner to check the clearinghouse connection.</p></section>';
 const active=state.active||{};
 return `<section class="connection-summary" aria-label="Clearinghouse connection"><div class="section-head"><div><h3>Clearinghouse</h3><p><b>Connected</b> · ${esc(active.usage==='P'?'Live account':'Test account')}</p></div><div class="actions"><button type="button" data-claimmd-operations="${esc(active.id)}">Clearinghouse activity</button></div></div><p class="muted">Eligibility checks, claims, payer responses and insurance payments go through this account.</p></section>`;
}

function claimMdWorkflowOverview(state=claimMdConnectionState,submissions=[],claims=[],remittances=[]){
 const connected=!!state?.connected,ready=claims.filter(item=>item.status==='ready').length,needsAttention=claims.filter(item=>['rejected','denied','returned'].includes(String(item.status).toLowerCase())).length,inFlight=submissions.filter(item=>!['accepted','paid','rejected','void'].includes(String(item.status).toLowerCase())).length,eraReview=remittances.filter(item=>['staged','reconciled'].includes(item.status)).length;
 return `<section class="billing-section claimmd-journey"><div class="section-head"><div><p class="eyebrow">INSURANCE CLAIMS</p><h2>${connected?'Claims at a glance':'Connect a clearinghouse'}</h2><p class="muted">Pick a step to see what needs work.</p></div><span class="status-badge">${connected?'Connected':'Not connected'}</span></div><div class="studio-path-preview"><button data-claimmd-journey="coverage"><span>1</span><b>Check insurance</b><small>Find the payer and check eligibility</small></button><button data-claimmd-journey="claims"><span>2</span><b>Prepare claims</b><small>${ready} ready to send · ${needsAttention} to fix</small></button><button data-claimmd-journey="transmissions"><span>3</span><b>Send and track</b><small>${inFlight} waiting for a response</small></button><button data-claimmd-journey="remittances"><span>4</span><b>Insurance payments</b><small>${eraReview} to review</small></button></div></section>`;
}

function claimMdTrackingHeadline(evidence={}){
 // The message-level status wins over the claim-level one.
 const sender=evidence.sender_name||'',isClaimMd=evidence.senderid==='CLMMD',claimLevel=String(evidence.status||'').toUpperCase(),messageLevel=String(evidence.message?.status||'').toUpperCase(),level=messageLevel||claimLevel;
 if(level==='R'||claimLevel==='R')return{headline:isClaimMd?'The clearinghouse returned this claim':sender?`${sender} returned this claim`:'The claim submission was returned'};
 if(level==='W')return{headline:isClaimMd?'Warning from Claim.MD':sender?`Warning from ${sender}`:'Claim status warning'};
 if(level==='A'||claimLevel==='A'){if(isClaimMd)return{headline:'The clearinghouse received this claim'};if(evidence.sender_icn)return{headline:`${sender||'The payer'} accepted this claim`,extra:`Payer claim number ${evidence.sender_icn}`};}
 return{headline:`Update from ${sender||'the payer'}`};
}
function claimMdTrackingSummary(tracking={},claimId=''){
 const reports=tracking.reports||[],latest=reports[reports.length-1],evidence=latest?.evidence,headline=claimMdTrackingHeadline(evidence||{});
 const connection=(tracking.connections||[]).map(item=>`<p class="muted">${item.paused?'Automatic status checks are paused':'Status is checked automatically'} · Last checked ${esc(item.last_poll_at?date(item.last_poll_at):'Not yet')} · Last worked ${esc(item.last_success_at?date(item.last_success_at):'Not yet')}${item.last_result&&item.last_result!=='page_persisted'?` · ${esc(human(item.last_result))}`:''}${item.next_poll_at&&!item.paused?' · Next check '+esc(date(item.next_poll_at)):''}</p>`).join('');
 const checkNow=claimId&&(tracking.connections||[]).length&&(tracking.submissions||[]).some(item=>item.status==='delivered')?`<p><button type="button" data-claimmd-check="${esc(claimId)}">Check with the clearinghouse now</button> <span class="muted" data-claimmd-check-result role="status"></span></p>`:'';
 const response=evidence?`<div class="mapping-notice"><b>${esc(headline.headline)}</b>${headline.extra?`<p>${esc(headline.extra)}</p>`:''}<p>${esc(evidence.message?.message||'A status update was received.')}</p><small>Received ${esc(date(latest.received_at))}${evidence.response_time?' · Clearinghouse time '+esc(evidence.response_time):''}</small></div>`:'<p class="muted">No response for this claim yet.</p>';
 const earlier=reports.length>1?`<details class="amendment"><summary>Earlier updates (${reports.length-1})</summary><ul>${reports.slice(0,-1).reverse().map(item=>{const head=claimMdTrackingHeadline(item.evidence||{});return `<li><small>${esc(date(item.received_at))}</small> <b>${esc(head.headline)}</b>${head.extra?`<p>${esc(head.extra)}</p>`:''}<p>${esc(item.evidence?.message?.message||'A status update was received.')}</p></li>`;}).join('')}</ul></details>`:'';
 return `${connection||'<p class="muted">Status is not being checked automatically for this claim.</p>'}${checkNow}${response}${earlier}<p class="muted">These messages do not post insurance payments or change the patient balance.</p>`;
}
function claimMdClaimLifecycle(claim,detail={},history={items:[]},{responsesOpen}={}){
 if(claim.snapshot?.coordination_of_benefits?.crossover){const source=claim.snapshot.coordination_of_benefits.crossover;return `<section class="claim-lifecycle" aria-label="Crossover lifecycle"><h3>Secondary insurance (crossover)</h3><p>The primary payer forwarded this claim to the secondary payer. The secondary payment (835) dated ${esc(source.payment_date)} is linked here, so no duplicate claim was sent.</p><p>${detail.tracking?.remittance_posted?'The secondary payment is posted. Check the account balance and any patient share.':'The secondary payment is not posted yet. Review it before posting.'}</p><p class="muted">A denial or a missing patient responsibility (PR) amount does not change what the patient owes.</p></section>`;}

 const status=String(claim.status||'draft').toLowerCase(),connected=!!claimMdConnectionState?.connected,tracking=detail.tracking||{};
 const needsCorrection=typeof claimMdNeedsCorrection==='function'&&claimMdNeedsCorrection(claim,detail);
 const hasCoverage=!!claim.snapshot?.account?.coverage_snapshot,eligibility=tracking.eligibility;
 const submissions=tracking.submissions||[],reports=tracking.reports||[];
 const delivered=submissions.some(item=>item.status==='delivered'),externalSubmitted=tracking.external_submission_recorded===true||(history.items||[]).some(item=>item.evidence?.action==='record_submission');
 const prepared=['ready','submitted','accepted','rejected','adjudicated'].includes(status)&&!detail.preflight_issues?.length;
 const remittancePosted=tracking.remittance_posted===true;
 const paymentPosted=remittancePosted&&tracking.paid_cents>0&&!tracking.payer_denied;
 const postingLabel=paymentPosted?'Payment posted':tracking.payer_denied?'Payer denial recorded':'Payer response posted';
 // The same count the claim page shows: two messages about one box are one thing to fix.
 const fixCount=(()=>{const issues=detail.preflight_issues||[];if(!issues.length)return 0;if(typeof claimMissingGroupsFor==='function'){const n=Object.values(claimMissingGroupsFor(issues)).reduce((sum,bucket)=>sum+bucket.words.length,0);if(n)return n;}return issues.length;})();
 const stages=[
  {label:'Insurance on claim',todo:'Add insurance',done:hasCoverage,detail:hasCoverage?'Insurance is on this claim. Eligibility is checked separately.':'Add insurance for this encounter date.'},
  {label:'Eligibility checked',todo:'Check eligibility',done:eligibility?.status==='completed',detail:eligibility?`${eligibility.status==='completed'?'Eligibility response received':human(eligibility.status)} for ${eligibility.service_date}. Eligibility does not guarantee payment.`:'Eligibility has not been checked for this insurance and visit date.'},
  {label:'Claim ready',todo:'Finish the claim',done:prepared,detail:fixCount?`${fixCount} thing${fixCount===1?'':'s'} to fix before sending.`:prepared?'Claim is ready.':'Check the codes, provider, subscriber and charges.'},
  {label:'Sent to clearinghouse',todo:'Send to the clearinghouse',done:needsCorrection||delivered||externalSubmitted,detail:needsCorrection?'Claim.MD received the claim.':delivered?(status==='submitted'?'The clearinghouse received the claim. The payer still has to accept it.':'The clearinghouse received the claim.'):externalSubmitted?'Staff recorded that this claim was sent outside SunCharts.':submissions.length?'Claim file prepared. Not confirmed as received yet.':connected?'Not sent yet.':'Connect a clearinghouse in Claim connections to send this claim.'},
  needsCorrection
   ?{label:'Clearinghouse correction',todo:'Needs correcting',done:false,detail:'Claim.MD is holding the claim for correction.'}
   :{label:status==='rejected'?'Claim returned':'Payer response',todo:'Waiting for the payer',done:['accepted','rejected','adjudicated'].includes(status)||remittancePosted,detail:status==='rejected'?'The return reason is shown below.':status==='accepted'?'The payer accepted the claim.':delivered&&reports.length?'The clearinghouse received the claim. Waiting for the payer.':'Waiting for a response to this claim.'},
  {label:remittancePosted?postingLabel:'Insurance payment',todo:'Review the remittance',done:remittancePosted,detail:remittancePosted?'Review the posted response and the current balance.':'No insurance payment posted yet.'}
 ];
 const current=needsCorrection?4:!hasCoverage?0:!prepared?2:!delivered&&!externalSubmitted?3:['rejected','void'].includes(status)?-1:!reports.length?4:status==='submitted'?4:tracking.remittance_posted?-1:5;
 const next=needsCorrection?'Review the Claim.MD response.':status==='draft'?(detail.preflight_issues?.length?'Fill in what is listed under Before this can be sent, then send.':'Check the details, then continue to send.'):status==='ready'&&submissions.some(item=>item.status==='prepared')?'A claim file is already prepared. Open it to send it or to check its delivery.':status==='ready'&&!delivered&&!externalSubmitted?(connected?'Send this claim to the clearinghouse.':'Connect a clearinghouse in Claim connections to send this claim.'):status==='rejected'?'Read the reason below, then fix and resend the claim.':status==='accepted'&&!remittancePosted?'Waiting for the insurer’s remittance.':remittancePosted?'Check the posted response, adjustments and the patient balance.':reports.length?'Read the response on this page. Review the remittance when it arrives.':'Waiting for the clearinghouse or payer.';
 // A thin bar of six steps beside the claim's name; each step's words show on hover or focus,
 // and one line says where the claim is and what to do. Status checks fold away unless the
 // insurer or clearinghouse has answered.
 const at=current,now=stages[at]||{label:typeof claimPlainWords!=='undefined'&&claimPlainWords[status]||human(status)},answered=reports.length>0;
 const barHtml=`<ol class="claim-progress-bar">${stages.map((stage,index)=>`<li class="${stage.done?'is-complete':index===at?'is-current':index<at?'is-missed':'is-upcoming'}" tabindex="0" aria-label="${esc(stage.done?'Done':index===at?'Now':index<at?'Not done':'Later')}: ${esc(stage.label)}. ${esc(stage.detail)}"><span class="claim-progress-fill"></span><span class="claim-progress-tip"><b>${stage.done?`✓ Done · ${esc(stage.label)}`:`${index===at?'Now':index<at?'Not done':'Later'} · ${esc(stage.todo)}`}</b><small>${esc(stage.detail)}</small></span></li>`).join('')}</ol>`;
 if(typeof patientBannerClaimSet==='function')patientBannerClaimSet(claim,barHtml,stages[at]?`${stages.filter(stage=>stage.done).length} of ${stages.length} done · Now: ${stages[at].todo}`:now.label);
 const connection=claimMdConnectionState?.active?.id?`<button type="button" data-claimmd-operations="${esc(claimMdConnectionState.active.id)}">Open clearinghouse activity</button>`:
  claimMdConnectionState?.connected===false&&!delivered&&!externalSubmitted?'<span class="pill">Clearinghouse not connected</span>':'';
 return `<section class="claim-lifecycle claim-progress-compact" aria-label="Claim progress">${barHtml}<p class="claim-progress-now"><b>${esc(now.todo?`Now: ${now.todo}`:now.label)}</b> · ${esc(next)}</p><details class="claim-progress-more"${(responsesOpen??(answered||needsCorrection))?' open':''}><summary>Status checks and responses</summary>${claimMdTrackingSummary(tracking,claim.id)}<p class="muted">A response that could not be matched to a claim automatically is listed under Clearinghouse activity.</p>${connection}</details></section>`;
}
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-claimmd-review-response]');if(!button)return;
 const responses=button.closest('.billing-account-detail')?.querySelector('.claim-progress-more');if(!responses)return;
 event.preventDefault();
 const more=responses.closest('[data-claim-more-details]');if(more)more.open=true;
 responses.open=true;
 const summary=responses.querySelector('summary');summary?.focus({preventScroll:true});summary?.scrollIntoView({block:'nearest'});
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-claimmd-check]');if(!button)return;
 event.preventDefault();
 const id=button.dataset.claimmdCheck,result=button.parentElement.querySelector('[data-claimmd-check-result]');
 const pane=button.closest('.billing-account-detail'),context=pane?claimContextSnapshot():null;
 button.disabled=true;if(result)result.textContent='Checking…';
 try{
  const out=await api(`${claimsBase}/${id}/claimmd-status/check`,'POST',{});
  const detail=await api(`${claimsBase}/${id}`);
  const n=Number(out.new_messages)||0,words=n===0?'No new messages from the clearinghouse.':`${n} new message${n===1?'':'s'} from the clearinghouse.`;
  const node=pane?.querySelector('.claim-lifecycle');
  if(node&&pane.isConnected&&claimContextCurrent(context)&&detail.claim?.id===id&&claimCurrent?.id===id){
   node.outerHTML=claimMdClaimLifecycle(detail.claim,detail,undefined,{responsesOpen:context?.savedActivityOnly?true:undefined});
   updateClaimStatusSurfaces(detail.claim,context,detail);
   const fresh=pane.querySelector('.claim-lifecycle [data-claimmd-check-result]');if(fresh)fresh.textContent=words;
  }else if(button.closest('.claim-screen')&&typeof loadEncounterRevenueStatus==='function')await loadEncounterRevenueStatus(encounterChargeAccount(),true);
  else if(result)result.textContent=words;
 }catch(error){if(result)result.textContent=error.message||'The clearinghouse could not be checked. Try again in a minute.';}
 finally{button.disabled=false;}
});
let claimMdTrackingTimer;
function startClaimMdTracking(id){
 if(typeof clearTimeout==='function')clearTimeout(claimMdTrackingTimer);
 const identity=me,patient=selected,context=typeof claimContextSnapshot==='function'?claimContextSnapshot():null;
 const current=()=>me===identity&&selected===patient&&claimCurrent?.id===id&&(!context||claimContextCurrent(context))&&(typeof claimWorkspaceHost==='function'?claimWorkspaceHost(context):document.querySelector('#claims-detail'))?.querySelector('.claim-lifecycle');
 const tick=async()=>{if(!current())return;try{const detail=await api(`${claimsBase}/${id}`);if(!current())return;if(detail.claim?.id!==id)throw new Error('Claim status response did not match this claim.');if(context)requireClaimContext(context,detail.claim);const node=current();node.outerHTML=claimMdClaimLifecycle(detail.claim,detail,undefined,{responsesOpen:context?.savedActivityOnly?node.querySelector('.claim-progress-more')?.open===true:undefined});if(typeof updateClaimStatusSurfaces==='function')updateClaimStatusSurfaces(detail.claim,context,detail);}catch{const node=current();if(node&&!node.querySelector('[data-tracking-error]'))node.insertAdjacentHTML('beforeend','<p data-tracking-error role="status">Status refresh failed. This shows the last status received and will retry automatically.</p>');}if(current())claimMdTrackingTimer=setTimeout(tick,20000);};
 if(typeof setTimeout==='function')claimMdTrackingTimer=setTimeout(tick,20000);
}

function canPrepareClaimMdSubmission(){
 return (typeof billingWrite!=='function'||billingWrite())&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('claims','view')&&workspaceResourceAllowed('claims','create'));
}
function claimMdDeliveryAttempt(detail,hint){
 const rows=detail?.tracking?.submissions||[];
 const artifact=hint?.submission_id?rows.find(row=>row.id===hint.submission_id):
  [...rows].reverse().find(row=>row.delivery_job&&row.delivery_job.claim_md!==false&&row.delivery_job.status!=='cancelled');
 const job=artifact?.delivery_job;
 if(!job?.id||job.claim_md===false||job.submission_id!==artifact.id||hint?.job_id&&hint.job_id!==job.id||
    hint?.route_key&&hint.route_key!==job.route_key)return hint||null;
 const outcome=job.status==='delivered'&&job.receipt_reference?'delivered':
  ['queued','leased','retry'].includes(job.status)?'queued':
  job.status==='cancelled'||job.status==='blocked'?'blocked':'waiting';
 return {outcome,claim_id:detail.claim.id,submission_id:artifact.id,job_id:job.id,route_key:job.route_key,
  delivery_status:job.status,queued_at:job.created_at,receipt_reference:job.receipt_reference,received_at:job.confirmed_at};
}
function claimMdPublishSubmissionStatus(form,evidence,current){
 form.claimSubmissionClosed=true;
 if(!current())return;
 if(form.claimAfterQueue){form.claimAfterQueue(evidence);return;}
 if(typeof form.querySelector!=='function')return;
 const claim=form.claimRecord||claimCurrent;
 const active=()=>form.isConnected!==false&&current();
 let timer,checking=false,remaining=5,attempt=evidence;
 const render=(detail=null)=>{
  const received=attempt.outcome==='delivered'&&attempt.receipt_reference;
  const title=received?'Claim.MD received':attempt.outcome==='queued'?'Queued for Claim.MD':attempt.outcome==='blocked'?'Delivery needs review':'Delivery unconfirmed';
  const payer=detail?.claim?.status==='accepted'?'Accepted by the payer':
   detail?.claim?.status==='adjudicated'?'Payer response recorded':
   detail?.claim?.status==='rejected'||detail?.claimmd_position?.needs_correction?'Review the response in claim activity':'Waiting for payer response';
  const message=received?'Receipt '+attempt.receipt_reference:
   attempt.outcome==='queued'?'SunCharts is checking for the clearinghouse receipt.':'Check this attempt for a saved receipt.';
  form.innerHTML=`<h3>${esc(title)}</h3><p role="status">${esc(message)}</p>${received?`<dl class="signed-claim-stage-facts"><div><dt>Payer status</dt><dd>${esc(payer)}</dd></div></dl>`:'<button type="button" class="primary" data-claimmd-attempt-check>Check delivery</button>'}
   <button type="button" data-claim-review-return="${esc(claim.id)}">View claim activity</button>`;
  form.querySelector('[data-claimmd-attempt-check]')?.addEventListener('click',()=>void read());
 };
 const read=async()=>{
  if(!active()||checking)return;
  if(typeof clearTimeout==='function')clearTimeout(timer);
  checking=true;
  const button=form.querySelector('[data-claimmd-attempt-check]');if(button)button.disabled=true;
  try{
   const fresh=await api(claimsBase+'/'+encodeURIComponent(claim.id));
   if(!active()||fresh?.claim?.id!==claim.id||fresh.claim.patient_id!==claim.patient_id||fresh.claim.account_id!==claim.account_id)return;
   attempt=claimMdDeliveryAttempt(fresh,attempt);
   render(fresh);
  }catch(error){
   const message=active()&&form.querySelector('[role="status"]');
   if(message)message.textContent=error.message||'The delivery could not be checked.';
  }finally{
   checking=false;
   if(button)button.disabled=false;
   if(active()&&attempt.outcome==='queued'&&remaining-- > 0&&typeof setTimeout==='function')timer=setTimeout(read,1800);
  }
 };
 render();
 if(['queued','delivered'].includes(attempt.outcome)&&typeof setTimeout==='function')timer=setTimeout(read,1000);
}
async function openClaimMdSubmissionReview(id,{accountId,current=()=>true,releaseDraft=false,afterQueue,reviewHost=null,expectedVersion=null}={}){
 if(!canPrepareClaimMdSubmission())throw new Error('Ask billing staff with permission to send this claim.');
 if(!current())return false;
 const context=accountId?mountEncounterClaims(accountId,{reviewHost}):claimContextSnapshot(),identity=me;
 const active=()=>current()&&me===identity&&claimContextCurrent(context);
 requireClaimContext(context);
 if(context.historyOnly)return false;
 if(!claimMdConnectionState?.connected)await loadClaimMdConnection(active);
 if(!active())return false;
 if(!claimMdConnectionState?.connected)throw new Error('Connect a clearinghouse before sending claims.');
 const url=`${claimsBase}/${encodeURIComponent(id)}`;
 const read=async()=>{
  const detail=await api(url);if(!active())return null;
  if(detail?.claim?.id!==id)throw new Error('The claim that loaded is not the one you opened. Try again.');
  requireClaimContext(context,detail.claim);
  if(expectedVersion!==null&&detail.claim.version!==expectedVersion)throw new Error('The claim changed. Reopen it to review the current claim.');
  return detail;
 };
 let detail=await read();if(!detail)return false;
 const alreadyPrepared=()=>claimHasRecordedSubmission(detail)||claimHasPreparedSubmission(detail);
 const issues=()=>Array.isArray(detail.preflight_issues)?detail.preflight_issues.filter(Boolean):[];
 if(releaseDraft&&detail.claim.status==='draft'&&!alreadyPrepared()&&!issues().length){
  if(typeof workspaceResourceAllowed==='function'&&(!workspaceResourceAllowed('claims','edit')||!workspaceResourceAllowed('claims','delete')))throw new Error('Ask billing staff with permission to release this claim.');
  const released=await api(`${url}/actions`,'POST',{action:'ready',reason:'Claim details reviewed before sending',reference:'',event_date:null,payer_control_number:''},detail.claim.version);
  if(!active())return false;
  if(expectedVersion!==null){
   requireClaimContext(context,released);
   if(released?.id!==id||released.status!=='ready'||released.version!==expectedVersion+1)throw new Error('The claim changed. Reopen it to review the current claim.');
   expectedVersion=released.version;
  }
  detail=await read();if(!detail)return false;
 }
 if(detail.claim.status!=='ready'||alreadyPrepared()||issues().length){
  await showClaim(id);
  if(active())notice(issues().length?'Review the problems listed on the claim before sending.':`This claim is ${human(detail.claim.status)} and may already have been sent. Check its status before sending again.`);
  return false;
 }
 if(!canPrepareClaimMdSubmission())throw new Error('Ask billing staff with permission to send this claim.');
 claimCurrent=detail.claim;context.claim=id;
 claimMdSubmitEditor(detail,afterQueue,active);
 return true;
}
const claimMdReviewAttestations=['signature_on_file','benefits_assigned','release_authorized','routine_professional_reviewed'];
function claimMdReviewAttestation(synthetic=false,{implicit=false}={}){
 const sentence='I confirm the provider signature is on file, the assignment of benefits and release of information are on file, and I reviewed the codes, addresses and consents for this routine professional claim.';
 const test='I checked that the patient, insurance and claim details are all made up, and I accept any clearinghouse charge for this test.';
 return implicit?'<p id="signed-claim-attestation" class="signed-claim-attestation">By selecting Send claim to Claim.MD, '+esc(sentence)+(synthetic?' '+esc(test):'')+'</p>':
  `<label class="review-ack"><input name="claim_review_confirmed" type="checkbox" required> ${esc(sentence)}</label>${synthetic?`<label class="review-ack"><input name="synthetic_test_reviewed" type="checkbox" required> ${esc(test)}</label>`:''}`;
}
function claimMdReviewFacts(claim,account,defaults,{includeSummary=true}={}){
 const content=claim.content||{},coverage=account.coverage_snapshot?.coverage?.content||{};
 const format=address=>[address?.line1,address?.line2,address?.city,[address?.state,address?.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
 const address=(field)=>defaults[field]!==undefined?format(defaults[field]):content[field];
 const patientAddress=address('patient_address'),subscriberAddress=address('subscriber_address');
 const destination=typeof claimLocalBlueDestination==='function'?claimLocalBlueDestination(claim):'';
 const fact=(label,value)=>value?`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`:'';
 const lines=account.content?.lines||[];
 const procedure=lines.map(line=>[line.code,line.modifiers].filter(Boolean).join('-')).filter(Boolean).join(', ');
 return `<dl class="signed-claim-reviewed-facts">
  ${includeSummary?fact(destination?'Insurance coverage':'Payer',account.coverage_snapshot?.payer?.content?.name)+fact('Claim destination',destination)+fact('Service date',account.content?.service_date)+fact('Billed',Number.isSafeInteger(account.total_cents)?money(account.total_cents):''):''}
  ${fact('Diagnoses',(content.diagnosis_codes||[]).join(', '))}${fact('Procedures',procedure)}${fact('Member ID',coverage.member_id)}
  ${fact('Patient address',patientAddress)}${subscriberAddress!==patientAddress?fact('Policy holder address',subscriberAddress):''}
  ${fact('Billing provider',content.billing_provider_name)}${fact('Billing NPI',content.billing_npi)}${fact('Billing address',address('billing_address'))}
  ${fact('Rendering provider',[defaults.rendering_given_name,defaults.rendering_family_name].filter(Boolean).join(' '))}
 </dl>`;
}
function claimMdSubmitEditor(detail,afterQueue,active){
 const claim=detail.claim,defaults=detail.submission_defaults||{},context=typeof claimContextSnapshot==='function'?claimContextSnapshot():null;
 if(context)requireClaimContext(context,claim);
 const patient=claim.snapshot.patient,account=claim.snapshot.account;
 const synthetic=claim.content.synthetic_test===true,live=claimMdConnectionState?.active?.usage==='P';
 const hidden=(name,value)=>`<input type="hidden" name="${esc(name)}" value="${esc(value||'')}">`;
 const issues=Array.isArray(detail.submission_issues)?detail.submission_issues:[];
 const invalid=(name,part='')=>issues.some(issue=>issue.field===name&&(!issue.part||!part||issue.part===part));
 const references=defaults.source_references||{};
 const address=(prefix,label,source,optional=false)=>{
  const value=defaults[prefix+'_address']||{};
  const fields=[['line1','Street address',55],['line2','Address line 2',55],['city','City',30],['state','State (2 letters)',2],['postal_code','ZIP code',9]];
  const addressField=prefix+'_address';
  const editors=fields.filter(([key])=>optional||invalid(addressField,key)||key!=='line2'&&!value[key]);
  const completed=fields.filter(field=>!editors.includes(field)).map(([key])=>hidden(prefix+'_'+key,value[key])).join('');
  const inputs=editors.map(([key,name,length])=>ediField(prefix+'_'+key,name,value[key]||'',length,!optional&&key!=='line2')).join('');
  const reference=prefix==='billing'?references.billing_address:undefined;
  return {completed,markup:editors.length?`<fieldset class="edi-address"><legend>${label}</legend>${reference?`<p>Address on file: ${esc(reference)}</p>`:''}${source?`<p class="muted">${esc(source)}</p>`:''}<div class="form-grid">${inputs}</div></fieldset>`:''};
 };
 const addresses=[
  address('billing','Billing provider address','From Practice administration → Facilities.'),
  address('subscriber','Policy holder address','From the patient’s insurance.'),
  address('patient','Patient address','From the patient’s contact details.')
 ];
 const payerAddress=address('payer','Insurer address (optional)','Fill in only when the insurer asks for it.',true);
 const field=(name,label,key,size,source)=>{
  const value=defaults[name];
  return value&&!invalid(key)?{hidden:hidden(name,value),markup:''}:{hidden:'',markup:`<div>${ediField(name,label,value||'',size,true)}<p class="muted">${esc(source)}</p></div>`};
 };
 const fields=[
  field('subscriber_given_name','Policy holder first name','subscriber_name',35,'From the patient’s insurance.'),
  field('subscriber_family_name','Policy holder last name','subscriber_name',35,'From the patient’s insurance.'),
  field('rendering_given_name','Rendering provider first name','rendering_provider_name',35,'From Practice administration → Providers.'),
  field('rendering_family_name','Rendering provider last name','rendering_provider_name',35,'From Practice administration → Providers.'),
  field('billing_taxonomy','Billing provider taxonomy code','billing_taxonomy',10,'From Practice administration → Providers.')
 ];
 const missing=fields.some(item=>item.markup)||addresses.some(item=>item.markup);
 const demographics=hidden('patient_sex',defaults.patient_sex||'U')+hidden('subscriber_sex',defaults.subscriber_sex||'U');
 const filing=hidden('filing_indicator',defaults.filing_indicator||'CI');
 const testNote=synthetic?`<p class="mapping-notice"><b>Test claim${live?' on a live clearinghouse account':''}</b></p>`:'';
 const primary=`<button class="primary" type="submit" name="claimmd_action" value="queue">Send ${synthetic?'test ':''}claim to Claim.MD</button>`;
 const back=context?.kind==='encounter'&&context.reviewSheet?'':`<button type="button" data-claim-review-return="${esc(claim.id)}">Back to claim</button>`;
 const advanced=context?.reviewSheet&&context.kind==='encounter'?'':`<details data-inline><summary>Claim file options</summary><div class="form-grid">${selectField('patient_sex','Patient sex',['U','F','M'],defaults.patient_sex||'U')}${selectField('subscriber_sex','Policy holder sex',['U','F','M'],defaults.subscriber_sex||'U')}${selectField('filing_indicator','Insurance type (claim filing code)',['CI','MB','MC','MA','CH','VA','TV','WC','ZZ'],defaults.filing_indicator||'CI')}</div>${references.payer_address?`<p>Insurer address on file: ${esc(references.payer_address)}</p>`:''}${payerAddress.markup}<button type="submit" name="claimmd_action" value="prepare">Save claim file without sending</button></details>`;
 claimPane(`<form id="claimmd-submit-form" data-request="${crypto.randomUUID()}"><h3 tabindex="-1" data-claimmd-review-heading>Review &amp; send</h3><p>${esc(patient.given_name)} ${esc(patient.family_name)} · ${esc(claim.control_number)}</p>
  ${claimMdReviewFacts(claim,account,defaults)}${fields.map(item=>item.hidden).join('')}${addresses.map(item=>item.completed).join('')}${advanced?'':demographics+filing}
  ${missing?`<section><h4>Complete before sending</h4><div class="form-grid">${fields.map(item=>item.markup).join('')}</div>${addresses.map(item=>item.markup).join('')}</section>`:''}
  ${advanced||['line1','line2','city','state','postal_code'].map(key=>hidden('payer_'+key,defaults.payer_address?.[key])).join('')}
  ${testNote}${claimMdReviewAttestation(synthetic)}${hidden('reason','Reviewed claim for electronic submission')}<div class="actions">${back}${primary}</div></form>`);
 const form=$('claimmd-submit-form');
 if(form){
  form.claimViewContext=context;form.claimRecord=claim;form.claimIdentity=me;form.claimMdDetail=detail;
  form.claimAccount={...account,patient_id:claim.patient_id};form.claimMdConnection=claimMdConnectionState?.active;
  form.claimAfterQueue=afterQueue;form.claimReviewCurrent=active;
  if(typeof restoreClaimDraft==='function')restoreClaimDraft(form,form.claimAccount,claim,null,'837p',`${claim.version}:${claimMdConnectionState?.active?.id}:${claimMdConnectionState?.active?.partner_version}`);
  form.querySelector?.('[data-claimmd-review-heading]')?.focus({preventScroll:true});
 }
}
async function submitClaimMdForm(form,submitter){
 if(form.claimSubmitting||form.claimSubmissionClosed)return;
 if(!canPrepareClaimMdSubmission())throw new Error('Ask billing staff with permission to send this claim.');
 if(form.claimDraftStale)throw new Error('The claim changed since you started. See the notice at the top of this form first.');if(typeof captureClaimDraft==='function')captureClaimDraft(form);
 const context=form.claimViewContext||(typeof claimContextSnapshot==='function'?claimContextSnapshot():null),claim=form.claimRecord||claimCurrent,identity=form.claimIdentity||me;if(identity!==me)throw new Error('You are signed in as a different user. Open the claim again.');if(context)requireClaimContext(context,claim);
 const values=Object.fromEntries(new FormData(form)),details={};
 for(const prefix of ['billing','subscriber','patient','payer']){details[prefix+'_address']={};for(const key of ['line1','line2','city','state','postal_code'])details[prefix+'_address'][key]=values[prefix+'_'+key]||'';}
 for(const key of ['subscriber_given_name','subscriber_family_name','patient_sex','subscriber_sex','rendering_given_name','rendering_family_name','billing_taxonomy','filing_indicator'])details[key]=values[key];
 if(values.claim_review_confirmed!=='on')throw new Error('Confirm the claim review before continuing.');
 for(const key of claimMdReviewAttestations)details[key]=true;
 details.synthetic_test_reviewed=values.synthetic_test_reviewed==='on';
 const active=claimMdConnectionState?.active,reviewed=form.claimMdConnection||active;
 if(context?.kind==='encounter'&&typeof visitReviewStageUnsigned==='function'&&visitReviewStageUnsigned())throw new Error('Sign the encounter note before sending the claim.');
 if(!claimMdConnectionState?.connected||!active?.partner_id||!Number.isInteger(active.partner_version)||!active.route_key||active.id!==reviewed.id||active.partner_id!==reviewed.partner_id||active.partner_version!==reviewed.partner_version||active.route_key!==reviewed.route_key)throw new Error('The clearinghouse connection changed. Open the claim again to review it.');
 const current=()=>identity===me&&(!context||claimContextCurrent(context))&&(!form.claimReviewCurrent||form.claimReviewCurrent())&&form.isConnected!==false;
 if(!current())return;
 const unlock=typeof lockClaimForm==='function'?lockClaimForm(form):()=>{};form.claimSubmitting=true;try{
 const submission=await api(`${claimsBase}/${encodeURIComponent(claim.id)}/837p`,'POST',{request_id:form.dataset.request,partner_id:active.partner_id,partner_version:active.partner_version,details,reason:values.reason},claim.version);
 if(!current())return;
 if(!submission?.id||!Number.isInteger(submission.version)||submission.claim_id!==claim.id||submission.claim_version!==claim.version||submission.partner_id!==active.partner_id||submission.partner_version!==active.partner_version)throw new Error('The prepared claim file does not match this review. Open the claim to check its status.');
 const action=submitter?.value==='queue'?'queue':'prepare';
 if(action==='queue'){
  if(!canPrepareClaimMdSubmission())throw new Error('Ask billing staff with permission to send this claim.');
  form.claimDeliveryRequest??=crypto.randomUUID();
  let job;
  const attempt={outcome:'unconfirmed',claim_id:claim.id,submission_id:submission.id,route_key:active.route_key};
  try{
   job=await api('/api/v1/billing/submissions/'+encodeURIComponent(submission.id)+'/delivery','POST',{request_id:form.claimDeliveryRequest,route_key:active.route_key,reason:values.reason},submission.version);
  }catch(error){
   if(current())notice('Check delivery to see whether this claim was queued.',true);
   claimMdPublishSubmissionStatus(form,attempt,current);
   return;
  }
  if(!job?.id||job.submission_id!==submission.id||job.route_key!==active.route_key){
   claimMdPublishSubmissionStatus(form,attempt,current);
   return;
  }
  const confirmed=job.status==='delivered'&&job.receipt_reference;
  claimMdPublishSubmissionStatus(form,{...attempt,job_id:job.id,delivery_status:job.status,
   outcome:confirmed?'delivered':['queued','leased','retry'].includes(job.status)?'queued':
    ['cancelled','blocked'].includes(job.status)?'blocked':'waiting',
   queued_at:job.created_at,receipt_reference:confirmed?job.receipt_reference:null},current);
  if(current())notice(confirmed?'Claim.MD received this claim.':
   ['queued','leased','retry'].includes(job.status)?'Queued for Claim.MD.':'Check delivery for this attempt.');
 }else notice('Claim file saved. Nothing was sent to the clearinghouse.');
 if(identity===me&&form.claimDraftKey&&typeof claimDrafts!=='undefined')claimDrafts.delete(form.claimDraftKey);
 if(action==='prepare'&&current()){if(typeof refreshClaimInContext==='function')await refreshClaimInContext(claim.id,context);else await showClaim(claim.id);}
 }finally{form.claimSubmitting=false;unlock();}
}

async function openEncounterClaimMdSubmit(id,accountId){
 const opened=await openClaimMdSubmissionReview(id,{accountId});
 if(opened&&typeof billingPartSet==='function')billingPartSet('claim',false);
 return opened;
}

document.addEventListener('click',event=>{const journey=event.target.closest('[data-claimmd-journey]');if(journey){event.preventDefault();event.stopImmediatePropagation();run(async()=>{if(journey.dataset.claimmdJourney==='coverage'){await showBillingQueue();document.querySelector('#claimmd-payer-search')?.scrollIntoView({block:'start'});return}if(journey.dataset.claimmdJourney==='remittances'){await showClaimsWorkspace({filter:'remittance-review'});return}if(journey.dataset.claimmdJourney==='claims'){await showClaimsWorkspace();return}document.querySelector('#edi-submission-queue')?.scrollIntoView({block:'start'});});return}const button=event.target.closest('[data-claimmd-submit]');if(!button)return;event.preventDefault();run(()=>openClaimMdSubmissionReview(button.dataset.claimmdSubmit));});

document.addEventListener('submit',event=>{const form=event.target;if(form.id!=='claimmd-submit-form')return;event.preventDefault();run(()=>submitClaimMdForm(form,event.submitter));});
