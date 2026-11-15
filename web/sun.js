// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Sun's browser controls never execute model-generated code or clinical actions.
const sunNavigation = Object.freeze({home:'nav-practice',schedule:'nav-schedule',patients:'nav-clinical','work queue':'nav-followup',messages:'nav-portal',referrals:'nav-referrals','patient billing':'nav-billing','insurance claims':'nav-claims','workflow studio':'nav-workflows',integrations:'nav-apps','practice administration':'nav-admin','sun review':'nav-ai-review'});
let sunRecognition=null,sunGeneration=0,sunConnections=[],sunBusy=false,sunListening=false,sunVoiceAvailable=false,sunDirtyPage=false,sunPrivacyReview=null,sunPreviewRevision=0,sunAnswerContext=null,sunContextObserver=null;
function sunLocalIntent(text){
 const value=String(text||'').toLowerCase().trim().replace(/\s+/g,' ').replace(/^(?:sun[, ]+)?(?:please )?(?:(?:can|could) you (?:tell me |show me )?)?/,'').replace(/[.!?]+$/,'');
 const records='(?:total )?patient(?: record)?s',scope='(?:the |our |this )?(?:practice|clinic|ehr|system|database)';
 const patterns=[
  /^(?:(?:what is|what's|show(?: me)?) (?:the |our )?)?(?:total )?patient(?: record)? count$/,
  new RegExp(`^(?:what is|what's) (?:the |our )?(?:total )?number of ${records}(?: (?:we have|in ${scope}))?$`),
  new RegExp(`^count (?:all |the )?${records}$`),
  new RegExp(`^how many ${records}(?: (?:(?:do we(?: currently)?|does (?:this|our) (?:practice|clinic|ehr|system)) have(?: in ${scope})?|are there(?: in ${scope})?|are (?:registered|in ${scope})))(?: (?:in total|right now|currently))?$`),
  new RegExp(`^how many ${records}$`)
 ];
 return patterns.some(pattern=>pattern.test(value))?'patients.count':null;
}
function sunContextFacts(value){
 if(value?.source!=='native_local_database'||!Number.isFinite(Date.parse(value.observed_at))||typeof value.practice_timezone!=='string'||!['practice_booking_settings','UTC_default'].includes(value.timezone_source)||!Array.isArray(value.capabilities)||!value.facts||typeof value.facts!=='object')throw new Error('The EHR returned an incomplete local facts snapshot. Refresh and try again.');
 const tools=['patients.count','appointments.today.count','workflows.count'],capabilities=value.capabilities.filter(tool=>tools.includes(tool)),facts={};
 const count=number=>{if(!Number.isSafeInteger(number)||number<0)throw new Error('The EHR returned an invalid aggregate count. Refresh and try again.');return number;};
 const statuses=(data,keys)=>Object.fromEntries(keys.map(key=>[key,count(data?.[key])]));
 if(capabilities.includes('patients.count')&&value.facts.patients){const item=value.facts.patients;if(item.scope!=='all_local_patient_records')throw new Error('The patient count scope could not be verified.');facts.patients={total:count(item.total),scope:item.scope,definition:String(item.definition||'All local patient records')};}
 if(capabilities.includes('appointments.today.count')&&value.facts.appointments){const item=value.facts.appointments;if(item.scope!=='appointments_starting_on_local_date'||!/^\d{4}-\d{2}-\d{2}$/.test(item.date))throw new Error('The appointment count scope could not be verified.');facts.appointments={date:item.date,total:count(item.total),by_status:statuses(item.by_status,['booked','checked_in','in_progress','completed','cancelled','no_show','other']),scope:item.scope,definition:String(item.definition||'Appointments starting on the practice-local date')};}
 if(capabilities.includes('workflows.count')&&value.facts.workflows){const item=value.facts.workflows;if(item.scope!=='all_local_workflow_instances')throw new Error('The workflow count scope could not be verified.');facts.workflows={total:count(item.total),by_status:statuses(item.by_status,['active','completed','cancelled','other']),awaiting_approval_steps:count(item.awaiting_approval_steps),ready_steps:count(item.ready_steps),scope:item.scope,definition:String(item.definition||'All local workflow instances')};}
 const unavailable=(Array.isArray(value.unavailable)?value.unavailable:[]).filter(item=>tools.includes(item?.tool)).map(item=>({tool:item.tool,reason:String(item.reason||'Unavailable for this request')}));
 for(const [tool,key] of [['patients.count','patients'],['appointments.today.count','appointments'],['workflows.count','workflows']])if(!facts[key]&&!unavailable.some(item=>item.tool===tool))unavailable.push({tool,reason:'Not available in this authenticated snapshot'});
 return {observed_at:value.observed_at,practice_timezone:value.practice_timezone,timezone_source:value.timezone_source,source:value.source,facts,capabilities:capabilities.filter(tool=>({'patients.count':facts.patients,'appointments.today.count':facts.appointments,'workflows.count':facts.workflows})[tool]),unavailable};
}
function sunClearStaleAnswer(){if(sunAnswerContext&&(sunAnswerContext.account!==me||sunAnswerContext.generation!==sunGeneration||sunAnswerContext.signature!==sunRequestSignature())){if($('sun-answer'))$('sun-answer').hidden=true;sunAnswerContext=null;window.speechSynthesis?.cancel();}}
function sunWatchContext(){
 if(sunContextObserver||typeof MutationObserver!=='function')return;sunContextObserver=new MutationObserver(sunClearStaleAnswer);
 for(const id of ['page-title','chart'])if($(id))sunContextObserver.observe($(id),{childList:true,subtree:true,characterData:true});
}
function sunCapturePresentationAnswer(targetView){
 const host=$('sun-answer'),panel=$('sun-panel');
 if(!sunAnswerContext||!host||host.hidden||panel?.hidden||sunAnswerContext.account!==me||sunAnswerContext.generation!==sunGeneration||sunAnswerContext.signature!==sunRequestSignature()||typeof sunPanelView==='undefined'||sunPanelView===targetView)return null;
 const signature=JSON.parse(sunRequestSignature());delete signature.workspace;
 return {host,panel,account:me,generation:sunGeneration,revision:sunPreviewRevision,signature:JSON.stringify(signature),targetView,originatingWorkspace:sunAnswerContext.originatingWorkspace||$('page-title')?.textContent||'SunCharts EHR'};
}
function sunRestorePresentationAnswer(token){
 if(!token||token.account!==me||token.generation!==sunGeneration||token.revision!==sunPreviewRevision||sunBusy||sunPrivacyReview||token.panel!==$('sun-panel')||token.host!==$('sun-answer')||token.panel.hidden||typeof sunPanelView==='undefined'||sunPanelView!==token.targetView)return;
 const signature=JSON.parse(sunRequestSignature());delete signature.workspace;if(JSON.stringify(signature)!==token.signature)return;
 let origin=$('sun-answer-origin');if(!origin){origin=document.createElement('p');origin.id='sun-answer-origin';origin.className='sun-answer-origin';token.host.append(origin);}
 origin.textContent=`Answered from ${token.originatingWorkspace}. This response has not been refreshed.`;
 token.host.hidden=false;sunAnswerContext={account:me,generation:sunGeneration,signature:sunRequestSignature(),originatingWorkspace:token.originatingWorkspace};
 if(typeof updateSunOrb==='function')updateSunOrb();
}
function sunRenderLocalAnswer(context,signature){
 const host=$('sun-answer'),patients=context.facts.patients;if(!host)return;
 const message=patients?`${patients.total.toLocaleString()} patient record${patients.total===1?'':'s'} in this practice.`:'Patient count is unavailable for your current access.';
 host.replaceChildren();host.dataset.origin='local';host.classList?.add('sun-local-answer');
 function line(text,className){const node=document.createElement('p');node.textContent=text;if(className)node.className=className;host.append(node);return node;}
 line(message,'sun-local-result');line('Source: SunCharts EHR · local patient records','muted');line(`As of ${new Date(context.observed_at).toLocaleString()} · practice timezone ${context.practice_timezone}${context.timezone_source==='UTC_default'?' (UTC fallback)':''}`,'muted');
 line(patients?'Counts all local patient records. This is not an active-patient, date-filtered, or assigned-clinician count.':context.unavailable.find(item=>item.tool==='patients.count')?.reason||'The patient-count tool was not available.','muted');
 const controls=document.createElement('div');controls.className='sun-local-actions';
 const open=document.createElement('button');open.type='button';open.textContent='Open patients';open.onclick=()=>void sunNavigate('open patients');
 const refresh=document.createElement('button');refresh.type='button';refresh.textContent='Refresh';refresh.onclick=()=>{if(sunAnswerContext?.signature===sunRequestSignature())void sunSend();else sunStatus('The question or workspace changed. Ask Sun again for a current answer.');};controls.append(open,refresh);host.append(controls);
 host.hidden=false;sunCollapseSettings();sunAnswerContext={signature,generation:sunGeneration,account:me};sunStatus(patients?'Answer ready · Local EHR data. No AI provider was contacted.':'Local patient-count tool unavailable. No AI provider was contacted.');sunSpeak(message);
}
function sunCollapseSettings(){if($('sun-settings'))$('sun-settings').open=false;if($('sun-conversation'))$('sun-conversation').scrollTop=0;}
function sunPrivacyPipeline(){return `<section class="sun-privacy-pipeline" aria-label="AI privacy and review steps"><h4>Privacy and review pipeline</h4><ol><li><b>Local context</b><span>Only the selected source and instruction</span></li><li><b>Replace identifiers</b><span>Known identifiers become local placeholders</span></li><li><b>AI provider</b><span>Routine questions continue automatically with the transformed text</span></li><li><b>Local restoration</b><span>Recognized placeholders are restored inside this EHR</span></li><li><b>Draft review</b><span>Review the result before any clinical use</span></li></ol><p class="muted">Workflow changes and actions that can affect records, billing or external systems still require an explicit review. Identifier replacement reduces disclosure but does not guarantee anonymity.</p></section>`;}
function sunPrivacyValid(preview){return !!(preview?.id&&preview.requires_approval===true&&typeof preview.instruction==='string'&&typeof preview.source_text==='string'&&Date.parse(preview.expires_at)>Date.now());}
function sunPrivacyPreviewMarkup(preview){
 if(!sunPrivacyValid(preview))return '<p class="notice warning">The privacy preview is missing or expired. Prepare a new preview before approving.</p>';
 return `<section class="sun-privacy-preview"><p class="eyebrow">EXACT OUTGOING TEXT · REVIEW REQUIRED</p><dl class="outbound-review-summary"><div><dt>Provider</dt><dd>${esc(preview.provider)} · ${esc(preview.model)}</dd></div><div><dt>Replacement</dt><dd>${Number(preview.redaction_count||0)} identifier replacement${Number(preview.redaction_count||0)===1?'':'s'}${preview.identifier_types?.length?` · ${esc(preview.identifier_types.join(', '))}`:''}</dd></div><div><dt>Local context</dt><dd>${preview.patient_id?`Patient ${esc(preview.patient_id)} · known identifiers used locally`:'No patient identity context selected'}</dd></div><div><dt>Expires</dt><dd>${esc(new Date(preview.expires_at).toLocaleTimeString())}</dd></div></dl><h4>Instruction sent to the provider</h4><pre>${esc(preview.instruction)}</pre><h4>Source text sent to the provider</h4><pre>${esc(preview.source_text)}</pre>${(preview.warnings||[]).map(warning=>`<p class="notice warning">${esc(warning)}</p>`).join('')}<p class="muted">Check for identifying details that were missed. Edit the source and prepare a new preview if anything should be removed. No provider request has been made.</p></section>`;
}
function sunInvalidatePrivacyReview(){sunPreviewRevision++;sunPrivacyReview=null;sunAnswerContext=null;if(typeof sunClearWorkflowProposal==='function')sunClearWorkflowProposal();window.speechSynthesis?.cancel();if($('sun-answer'))$('sun-answer').hidden=true;const host=$('sun-privacy-preview');if(host){host.innerHTML='';host.hidden=true;}if($('sun-privacy-approved'))$('sun-privacy-approved').checked=false;}
function sunRequestSignature(){return JSON.stringify({text:$('sun-text')?.value.trim(),provider:$('sun-provider')?.value,mode:$('sun-mode')?.value,workspace:$('page-title')?.textContent||'SunCharts EHR',patient:$('sun-patient-context')?.checked?$('sun-patient-context').dataset.patientId:null,currentPatient:typeof selected==='string'?selected:null});}
function sunRefreshPatientContext(){
 const host=$('sun-patient-context-area');if(!host)return;
 const patient=typeof selected==='string'&&typeof workspace!=='undefined'&&workspace?.patient?.id===selected?workspace.patient:null,id=patient?.id||'';
 if(host.dataset.patientId===id)return;sunInvalidatePrivacyReview();host.dataset.patientId=id;
 const name=patient?[patient.given_name,patient.family_name].filter(Boolean).join(' ')||id:'';
 host.innerHTML=patient?`<label class="review-ack" id="sun-patient-context-label" for="sun-patient-context"><input type="checkbox" id="sun-patient-context" data-patient-id="${esc(id)}"> Use ${esc(name)}’s known identifiers for local replacement. No chart text is added.</label>`:'';
 if($('sun-patient-context'))$('sun-patient-context').onchange=sunInvalidatePrivacyReview;
 host.hidden=$('sun-mode')?.value!=='ask';
}
function sunNavigationTarget(text){const value=text.toLowerCase().trim().replace(/[.!?]+$/,'').replace(/^(?:sun[, ]+)?(?:please )?(?:open|show|go to|navigate to) (?:the )?/,'');return Object.hasOwn(sunNavigation,value)?sunNavigation[value]:null;}
function sunStatus(text){const node=$('sun-status');if(node)node.textContent=text;if(typeof updateSunOrb==='function')updateSunOrb();}
function sunSpeak(text){
 if(!$('sun-speak')?.checked||!window.speechSynthesis||$('sun-panel')?.hidden||document.hidden)return;
 const voice=window.speechSynthesis.getVoices().find(v=>v.localService&&v.lang.startsWith('en'));
 if(!voice){sunStatus('No on-device English voice is available. The reply remains on screen.');return;}
 const utterance=new SpeechSynthesisUtterance(text.slice(0,4000));utterance.voice=voice;
 utterance.onstart=utterance.onend=utterance.onerror=()=>{if(typeof updateSunOrb==='function')updateSunOrb();};
 window.speechSynthesis.cancel();window.speechSynthesis.speak(utterance);
}
function stopSunListening(){const recognition=sunRecognition;sunRecognition=null;sunListening=false;recognition?.abort();const button=$('sun-mic');if(button){button.textContent='Start microphone';button.setAttribute('aria-pressed','false');}if($('sun-interim'))$('sun-interim').textContent='';}
function clearSunSession(){sunGeneration++;sunInvalidatePrivacyReview();sunContextObserver?.disconnect();sunContextObserver=null;stopSunListening();window.speechSynthesis?.cancel();sunConnections=[];sunBusy=false;sunDirtyPage=false;if(typeof clearAiPrivacyReview==='function')clearAiPrivacyReview();if(typeof clearStudioPrivacyReview==='function')clearStudioPrivacyReview();if(typeof clearSunOrb==='function')clearSunOrb();$('sun-panel')?.remove();$('sun-open')?.remove();}
async function sunCheckVoice(){
 const generation=sunGeneration,panel=$('sun-panel'),account=me;const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
 const current=()=>generation===sunGeneration&&account===me&&panel===$('sun-panel')&&!panel?.hidden;
 let state='unsupported';
 try{
  if(Recognition&&typeof Recognition.available==='function'&&('processLocally' in new Recognition()))state=await Recognition.available({langs:['en-US'],processLocally:true});
 }catch{state='unsupported';}
 if(!current())return;
 sunVoiceAvailable=state==='available';
 const note=sunVoiceAvailable?'On-device speech available. Audio stays on this device.':state==='downloadable'?'Install the browser’s English speech pack to enable on-device dictation.':state==='downloading'?'The on-device English speech pack is downloading. Check voice readiness again when it finishes.':'This browser does not support verified on-device transcription. Use text or your operating system’s dictation. No cloud speech fallback is enabled.';
 if($('sun-install-voice')){$('sun-install-voice').hidden=!['downloadable','downloading'].includes(state);$('sun-install-voice').disabled=false;$('sun-install-voice').textContent=state==='downloading'?'Check speech download':'Install on-device English speech';$('sun-install-voice').dataset.speechState=state;}
 if($('sun-voice-note'))$('sun-voice-note').textContent=note;
 if($('sun-mic')){$('sun-mic').disabled=false;$('sun-mic').textContent=sunListening?'Stop microphone':sunVoiceAvailable?'Start microphone':state==='downloadable'?'Set up microphone':state==='downloading'?'Check speech download':'Voice options';$('sun-mic').title=note;$('sun-mic').setAttribute('aria-describedby','sun-voice-note');}
}
function sunShowVoiceSetup(){
 const settings=$('sun-settings');if(settings)settings.open=true;
 sunStatus($('sun-voice-note')?.textContent||'Voice is not available in this browser. You can still type.');
 const install=$('sun-install-voice');if(install&&!install.hidden)install.focus();
}
async function sunInstallVoice(){
 const generation=sunGeneration,panel=$('sun-panel'),account=me,button=$('sun-install-voice');
 const current=()=>generation===sunGeneration&&account===me&&panel===$('sun-panel')&&!panel?.hidden;
 const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(button?.dataset.speechState==='downloading'){await sunCheckVoice();if(current())sunShowVoiceSetup();return;}
 if(typeof Recognition?.install!=='function'){sunShowVoiceSetup();return;}
 if(button)button.disabled=true;
 sunStatus('Installing the browser’s on-device English speech pack…');
 try{
  const installed=await Recognition.install({langs:['en-US'],processLocally:true});
  if(!current())return;
  await sunCheckVoice();if(!current())return;
  sunStatus(sunVoiceAvailable?'On-device speech is ready. Select Start microphone to grant access and begin.':installed===false?'The browser could not install its speech pack. Try again, or use your operating system’s dictation.':$('sun-voice-note')?.textContent||'Speech pack is not ready yet.');
 }catch{if(current())sunStatus('The browser could not install its speech pack. Try again, or use your operating system’s dictation.');}
 finally{if(current()&&button===$('sun-install-voice'))button.disabled=false;}
}
async function sunStartListening(){
 if(sunListening){stopSunListening();sunStatus('Microphone stopped.');return;}
 const generation=sunGeneration,panel=$('sun-panel'),account=me;
 await sunCheckVoice();if(generation!==sunGeneration||account!==me||!me||panel!==$('sun-panel')||panel?.hidden||document.hidden)return;
 if(!sunVoiceAvailable){sunShowVoiceSetup();return;}
 const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition,recognition=new Recognition();
 recognition.processLocally=true;recognition.lang='en-US';recognition.interimResults=true;recognition.continuous=true;
 sunRecognition=recognition;sunListening=true;
 recognition.onresult=event=>{
  if(generation!==sunGeneration||sunRecognition!==recognition||!sunListening||panel.hidden)return;
  let interim='';
  for(let i=event.resultIndex;i<event.results.length;i++){
   const text=event.results[i][0].transcript.trim();
   if(event.results[i].isFinal){
    if($('sun-mode')?.value==='navigate'){void sunNavigate(text);}
    else if($('sun-text')){$('sun-text').value=[$('sun-text').value,text].filter(Boolean).join(' ');sunInvalidatePrivacyReview();}
   }else interim+=text+' ';
  }
  if($('sun-interim'))$('sun-interim').textContent=interim;
 };
 recognition.onerror=event=>{if(generation!==sunGeneration||sunRecognition!==recognition)return;stopSunListening();sunStatus(event.error==='not-allowed'?'Microphone permission was not granted. You can still type.':'On-device speech stopped. Your transcript is preserved; try again when ready.');};
 recognition.onend=()=>{if(generation===sunGeneration&&sunRecognition===recognition){sunListening=false;sunRecognition=null;if($('sun-mic')){$('sun-mic').textContent='Start microphone';$('sun-mic').setAttribute('aria-pressed','false');}}};
 try{recognition.start();$('sun-mic').textContent='Stop microphone';$('sun-mic').setAttribute('aria-pressed','true');sunStatus('Listening on this device. Stop the microphone when finished.');}catch{stopSunListening();sunStatus('Unable to start on-device speech. Text commands are still available.');}
}
async function sunNavigate(text){
 const generation=sunGeneration;
 const id=sunNavigationTarget(text),button=id&&$(id);
 if(!button||button.hidden||button.disabled||button.dataset.workspaceHidden==='true'){sunStatus('Try “open schedule”, “open patients”, or “open workflow studio”. Sun cannot perform clinical or payment actions by voice here.');return;}
 const inStudio=String($('tools')?.className||'').split(/\s+/).includes('workflow-studio')&&!$('tools')?.hidden;
 if(sunDirtyPage||(inStudio&&((typeof studioDirty!=='undefined'&&studioDirty)||(typeof studioWorkspaceDirty!=='undefined'&&studioWorkspaceDirty)))){stopSunListening();if(!(await confirmAction('Leave this page? Unsaved form changes may be lost.',{title:'Navigate with Sun',confirmLabel:'Leave page'})))return;}
 if(generation!==sunGeneration||!me||button!==$(id)||button.hidden||button.disabled||button.dataset.workspaceHidden==='true')return;
 sunDirtyPage=false;button.click();sunStatus(`Opening ${text.replace(/^(?:sun[, ]+)?(?:please )?(?:open|show|go to|navigate to) /i,'').trim()}.`);
 if(typeof CustomEvent==='function')document.dispatchEvent(new CustomEvent('suncharts:sun-navigation',{detail:{target:id}}));
 sunSpeak('Opening the requested workspace.');
}
async function sunSend(){
 const text=$('sun-text')?.value.trim();if(!text||sunBusy)return;
 if($('sun-mode').value==='navigate'){await sunNavigate(text);return;}
 if($('sun-mode').value==='dictate'){sunStatus('Dictation is ready to review and copy. It has not been saved into a clinical record.');return;}
 if($('sun-mode').value==='design'){if(typeof sunPrepareWorkflow==='function')await sunPrepareWorkflow();else sunStatus('Workflow design is not available in this view.');return;}
 stopSunListening();sunInvalidatePrivacyReview();
 const operation={},account=me,generation=sunGeneration,revision=sunPreviewRevision,signature=sunRequestSignature(),panel=$('sun-panel');
 const current=()=>account===me&&generation===sunGeneration&&revision===sunPreviewRevision&&signature===sunRequestSignature()&&$('sun-panel')===panel&&!panel.hidden;
 let contextLoaded=false;sunBusy=operation;$('sun-send').disabled=true;sunStatus('Checking permitted local EHR facts…');
 try{
  const response=await api('/api/v1/sun/context');if(!current())return;
  const context=sunContextFacts(response);contextLoaded=true;
  if(sunLocalIntent(text)==='patients.count'){sunRenderLocalAnswer(context,signature);return;}
  const connection=sunConnections.find(item=>item.id===$('sun-provider').value);
  if(!connection){if($('sun-settings'))$('sun-settings').open=true;sunStatus('Choose an AI connection in Settings for this question. If none are listed, enable one in Integrations. Patient-record counts can be answered locally.');return;}
  const patient=$('sun-patient-context'),patientId=patient?.checked?patient.dataset.patientId:null;
  if(patientId&&(typeof selected!=='string'||selected!==patientId)){sunStatus('The open patient changed. Reopen Sun and review the patient context before preparing a preview.');return;}
  const body={integration_id:connection.id,purpose:'draft_response',instruction:'You are Sun, the assistant inside SunCharts EHR. Answer the staff message using the supplied local_facts snapshot and explicitly supplied text. local_facts contains only permitted aggregate facts from this authenticated EHR, observed_at a stated time; it is not a live query at answer time. State the snapshot time and relevant count scope when using these facts. The patient total means all local patient records, not active patients or counts filtered by date, diagnosis, age, clinician, or another clinic. Do not use that total to answer a filtered question. If a requested tool, filter, domain, or fact is absent or unavailable, explain that limitation; never infer a zero count. Individual records and charts are not included automatically. Do not claim to have read any other records or performed any action. Return a concise response for staff review.',source_text:JSON.stringify({workspace:$('page-title')?.textContent||'SunCharts EHR',staff_message:text,local_facts:context}),...(patientId?{patient_id:patientId}:{})};
  sunStatus('Preparing the exact outgoing text, including permitted aggregate facts. No AI provider has been contacted.');
  const preview=await api('/api/v1/ai/privacy/preview','POST',body);
  if(!current())return;
  if(!sunPrivacyValid(preview))throw new Error('A valid privacy preview was not returned. Prepare it again before sending.');
  sunPrivacyReview={body,preview,signature,generation,account,automatic:true};
  const host=$('sun-privacy-preview');host.innerHTML='';host.hidden=true;
  sunCollapseSettings();sunStatus(`Asking ${preview.provider} · ${preview.model}. Identifiers were transformed locally; no record or external action will be changed.`);
  if(sunBusy===operation)sunBusy=false;
  await sunExecute({automatic:true});
 }catch(error){if(current())sunStatus(contextLoaded?error.message:`Could not load local EHR facts. Nothing was sent to an AI provider. ${error.message}`);}finally{if(sunBusy===operation){sunBusy=false;if(generation===sunGeneration&&$('sun-panel')===panel&&$('sun-send'))$('sun-send').disabled=false;if(typeof updateSunOrb==='function')updateSunOrb();}}
}
async function sunExecute({automatic=false}={}){
 const review=sunPrivacyReview;if(sunBusy)return;
 if(!review||review.account!==me||review.generation!==sunGeneration||review.signature!==sunRequestSignature()||!sunPrivacyValid(review.preview)||$('sun-panel')?.hidden){sunInvalidatePrivacyReview();sunStatus('The request changed or its preview expired. Prepare and review a new preview.');return;}
 if(!automatic&&!review.automatic&&!$('sun-privacy-approved')?.checked){sunStatus('Review the outgoing instruction and source, then check the approval box.');return;}
 if(review.body.purpose==='workflow_design'&&(typeof sunWorkflowBaseCurrent!=='function'||!sunWorkflowBaseCurrent(review.workflowBase))){sunInvalidatePrivacyReview();sunStatus('The Studio draft changed. Ask Sun again using the current draft.');return;}
 stopSunListening();const operation={},generation=sunGeneration,revision=sunPreviewRevision,panel=$('sun-panel');sunBusy=operation;sunPrivacyReview=null;
 const current=()=>generation===sunGeneration&&review.account===me&&$('sun-panel')===panel&&!panel.hidden&&revision===sunPreviewRevision&&review.signature===sunRequestSignature();
 if($('sun-execute'))$('sun-execute').disabled=true;$('sun-send').disabled=true;sunStatus(`Running the ${automatic||review.automatic?'protected':'reviewed'} request with ${review.preview.provider} · ${review.preview.model}.`);
 try{
  const draft=await api('/api/v1/ai/drafts','POST',{...review.body,request_id:crypto.randomUUID(),privacy_preview_id:review.preview.id,privacy_approved:true});
  if(!current())return;
  if(review.body.purpose==='workflow_design'){await sunReceiveWorkflowDraft(draft,review,current);return;}
  sunInvalidatePrivacyReview();
  if(draft.status==='failed'){sunStatus(`Sun could not finish: ${draft.failure_code||'provider unavailable'}. Review the draft before retrying.`);return;}
  $('sun-answer').textContent=draft.content||'The result is available in Sun review.';$('sun-answer').dataset.origin='provider';$('sun-answer').classList?.remove('sun-local-answer');$('sun-answer').hidden=false;sunCollapseSettings();sunAnswerContext={signature:review.signature,generation,account:me};
  sunStatus(`Draft ready for review · ${draft.provider||review.preview.provider} · ${draft.model}. Recognized placeholders were restored locally. No records or actions were changed.`);sunSpeak(draft.content||'Your draft is ready for review.');
 }catch(error){if(current()){sunInvalidatePrivacyReview();sunStatus(`${error.message} Prepare a new privacy preview before retrying.`);}}finally{if(sunBusy===operation){sunBusy=false;if(generation===sunGeneration&&$('sun-panel')===panel&&$('sun-send'))$('sun-send').disabled=false;if(typeof updateSunOrb==='function')updateSunOrb();}}
}
function sunRefreshConnectionChoices(preserve){
 const select=$('sun-provider');if(!select)return;const purpose=$('sun-mode')?.value==='design'?'workflow_design':'draft_response',connections=sunConnections.filter(item=>item.capabilities?.includes(purpose)),selection=select.value;
 select.innerHTML=connections.length?`${preserve?'<option value="">Choose a provider</option>':''}${connections.map(item=>{const label=String(item.label||item.provider),provider=label.toLowerCase().includes(String(item.provider).toLowerCase())?'':` · ${item.provider}`;return `<option value="${esc(item.id)}">${esc(label+provider)} · ${esc(item.model)}</option>`;}).join('')}`:`<option value="">No enabled ${purpose==='workflow_design'?'workflow-design':'response'} provider</option>`;
 if(preserve||connections.some(item=>item.id===selection))select.value=selection;
}
async function openSun(){
 if($('sun-panel')){$('sun-panel').hidden=false;sunWatchContext();sunRefreshPatientContext();if(typeof mountSunWorkspace==='function')mountSunWorkspace();$('sun-text').focus();return;}
 const panel=document.createElement('aside');panel.id='sun-panel';panel.className='sun-panel';panel.setAttribute('aria-label','Sun assistant');
 panel.innerHTML=`<header><div><p class="eyebrow">SUNCHARTS EHR</p><h2>Sun</h2></div><button type="button" id="sun-close" aria-label="Close Sun">✕</button></header><p class="sun-intro">Ask about your practice, navigate the EHR, or dictate text.</p><label for="sun-mode">Mode<select id="sun-mode" aria-label="Mode"><option value="ask">Ask Sun</option>${typeof sunWorkflowCanDesign==='function'&&sunWorkflowCanDesign()?'<option value="design">Design workflow</option>':''}<option value="navigate">Navigate the EHR</option><option value="dictate">Dictate text</option></select></label><label id="sun-provider-label" for="sun-provider">AI connection<select id="sun-provider" aria-label="AI connection"><option value="">Loading connections…</option></select></label><p id="sun-context" class="muted">Sun can read permitted practice counts. Broader questions use a reviewed AI request; patient records are not added automatically.</p><div id="sun-patient-context-area"></div><label for="sun-text">Message or transcript<textarea id="sun-text" aria-label="Message or transcript" rows="5" maxlength="16000" placeholder="Ask Sun, or choose Navigate and say “open schedule”."></textarea></label><div id="sun-examples" class="sun-examples" aria-label="Try Sun"><button type="button" data-sun-example="count">How many patient records?</button><button type="button" data-sun-example="workload">Summarize today’s workload</button><button type="button" data-sun-example="navigate">Open schedule</button></div><p id="sun-interim" aria-live="polite"></p><div class="sun-controls"><button type="button" id="sun-mic" aria-pressed="false" disabled>Start microphone</button><button type="button" id="sun-send" class="primary">Ask Sun</button></div><div id="sun-privacy-guide"><details><summary>How AI requests protect identifiers and require review</summary>${sunPrivacyPipeline()}</details></div><div id="sun-privacy-preview" hidden></div><p id="sun-voice-note" class="muted">Checking on-device speech…</p><button type="button" id="sun-install-voice" hidden>Install on-device English speech</button><label class="sun-spoken" for="sun-speak"><input type="checkbox" id="sun-speak"> Speak replies using an on-device voice</label><p id="sun-status" role="status" aria-live="polite">Ready.</p><div id="sun-answer" class="sun-answer" hidden></div><button type="button" id="sun-review">Open Sun review</button><button type="button" id="sun-workflows">Open Workflow Studio</button>`;
 document.body.append(panel);sunWatchContext();sunRefreshPatientContext();if(typeof mountSunWorkspace==='function')mountSunWorkspace();$('sun-text').focus();const generation=sunGeneration,account=me,initialRevision=sunPreviewRevision;
 $('sun-close').onclick=()=>{if(typeof collapseSunWorkspace==='function'&&collapseSunWorkspace()===false)return;sunInvalidatePrivacyReview();stopSunListening();window.speechSynthesis?.cancel();panel.hidden=true;if(typeof updateSunOrb==='function')updateSunOrb();$('sun-open')?.focus();};
 $('sun-mode').onchange=()=>{sunInvalidatePrivacyReview();stopSunListening();const mode=$('sun-mode').value,ai=['ask','design'].includes(mode);$('sun-provider-label').hidden=!ai;$('sun-privacy-guide').hidden=!ai;$('sun-examples').hidden=mode!=='ask';if($('sun-patient-context-area'))$('sun-patient-context-area').hidden=mode!=='ask';$('sun-context').textContent=mode==='design'?'Design the open Studio draft. Sun includes workflow configuration and the native node catalog, without patient records or runs. Review proposed changes before applying; saving and publishing remain separate.':mode==='ask'?'Sun can read permitted practice counts. Broader questions use a reviewed AI request; patient records are not added automatically.':mode==='navigate'?'Say “open” followed by a workspace name. Only navigation is available; no clinical actions are executed.':'Dictation stays in this transcript until you review and use it.';$('sun-send').textContent=mode==='design'?'Propose workflow changes':mode==='ask'?'Ask Sun':mode==='navigate'?'Navigate':'Review transcript';sunRefreshConnectionChoices(false);};
 $('sun-text').oninput=sunInvalidatePrivacyReview;$('sun-provider').onchange=sunInvalidatePrivacyReview;if($('sun-patient-context'))$('sun-patient-context').onchange=sunInvalidatePrivacyReview;
 panel.querySelectorAll('[data-sun-example]').forEach(button=>{button.onclick=()=>{const kind=button.dataset.sunExample;$('sun-mode').value=kind==='navigate'?'navigate':'ask';$('sun-mode').onchange();$('sun-text').value=kind==='count'?'How many patient records are there?':kind==='workload'?'Summarize today’s workload using available practice counts.':'open schedule';sunInvalidatePrivacyReview();$('sun-text').focus();};});
 $('sun-mic').onclick=()=>void sunStartListening();$('sun-send').onclick=()=>void sunSend();
 $('sun-text').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();void sunSend();}};
 $('sun-speak').onchange=()=>{if(!$('sun-speak').checked)window.speechSynthesis?.cancel();};
 $('sun-review').onclick=()=>{stopSunListening();void sunNavigate('open sun review');};
 $('sun-workflows').onclick=()=>{stopSunListening();void sunNavigate('open workflow studio');};
 $('sun-install-voice').onclick=()=>void sunInstallVoice();
 void sunCheckVoice();
 const current=()=>generation===sunGeneration&&account===me&&$('sun-panel')===panel;
 try{const result=await api('/api/v1/ai/connections');if(!current())return;sunConnections=result.items||[];sunRefreshConnectionChoices(!!(sunBusy||sunAnswerContext||sunPrivacyReview));}catch(error){if(!current())return;$('sun-provider').innerHTML='<option value="">AI connections unavailable</option>';if(initialRevision===sunPreviewRevision&&!sunBusy&&!sunAnswerContext)sunStatus(`AI connections could not load. Local patient counts are still available. ${error.message}`);}

}
function initSun(){
 if(!me||me.role==='patient')return;
 if(typeof initSunOrb==='function'){initSunOrb();return;}
 if($('sun-open'))return;
 const host=document.querySelector('.shell-topbar-actions');if(!host)return;
 const button=document.createElement('button');button.id='sun-open';button.type='button';button.className='sun-open';button.textContent='✳ Sun';button.setAttribute('aria-controls','sun-panel');button.onclick=()=>void openSun();host.prepend(button);
}
document.addEventListener('input',event=>{if(me&&event.target.closest?.('#app')&&event.target.closest('form')&&!event.target.closest('#sun-panel'))sunDirtyPage=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&sunListening){stopSunListening();sunStatus('Microphone stopped.');}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopSunListening();window.speechSynthesis?.cancel();}});
