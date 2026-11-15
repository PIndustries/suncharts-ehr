// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Only a server-validated definition may become an unsaved Studio draft.
let sunWorkflowProposal=null;
const sunWorkflowCopy=value=>JSON.parse(JSON.stringify(value));
function sunWorkflowCanonical(value){return JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);}
function sunWorkflowCanDesign(){return me?.role==='owner';}
function sunWorkflowActive(){return !!(sunWorkflowCanDesign()&&typeof studioDraft!=='undefined'&&studioDraft&&typeof studioCanManage==='function'&&studioCanManage()&&$('tools')&&!$('tools').hidden&&String($('tools').className).split(/\s+/).includes('workflow-studio'));}
function sunClearWorkflowProposal(){sunWorkflowProposal=null;}
function sunWorkflowPayload(){
 const raw=studioDefinitionPayload(),pick=(item,keys)=>Object.fromEntries(keys.filter(key=>item[key]!==undefined).map(key=>[key,sunWorkflowCopy(item[key])]));
 return {name:studioDraft.name,description:studioDraft.description||'',trigger_type:studioDraft.trigger_type,definition:{
  columns:raw.columns.map(column=>pick(column,['key','title','description','hidden'])),
  steps:raw.steps.map(step=>({...pick(step,['key','title','kind','phase','required','manual_approval','assigned_role','escalation_role','due_after_minutes','depends_on','editor_position','native']),condition:step.condition?pick(step.condition,['field','operator','value']):null,form_fields:(step.form_fields||[]).map(field=>pick(field,['key','label','field_type','required','options','chart_target'])),...(step.ai?{ai:pick(step.ai,['integration_id','instruction','source_field','privacy'])}:{})}))
 }};
}
function sunWorkflowCapture(){
 if(!sunWorkflowActive())throw new Error('Open Workflow Studio and choose a workflow, then use Design with Sun. Your existing draft will remain unchanged.');
 const payload=sunWorkflowPayload();return {account:me,generation:sunGeneration,draft:studioDraft,id:studioDraft.id||null,version:studioDraft.version??null,payload,signature:sunWorkflowCanonical(payload)};
}
function sunWorkflowBaseCurrent(base){return !!(base&&base.account===me&&base.generation===sunGeneration&&sunWorkflowActive()&&base.draft===studioDraft&&base.id===(studioDraft.id||null)&&base.version===(studioDraft.version??null)&&base.signature===sunWorkflowCanonical(sunWorkflowPayload()));}
function sunWorkflowCatalog(){
 return {
  node_kinds:Object.entries(studioKinds).map(([kind,label])=>({kind,label})),triggers:Object.keys(studioTriggers),
  form_field_types:['short_text','long_text','date','choice','checkbox','number'],form_node_kinds:['patient_form','clinical_template'],
  roles:['owner','clinician','nurse','medical_assistant','front_desk'],condition_operators:['equals','not_equals','present','absent'],
  limits:{steps:100,columns:12,fields_per_form:30,choices_per_field:20,dependencies_per_node:20},
  column_schema:{key:'unique slug',title:'label',description:'text',hidden:'boolean; at least one column remains visible'},
  node_schema:{key:'unique slug',title:'label',kind:'one catalog kind',phase:'existing column key',required:'boolean',manual_approval:'true except staff_task and patient_form may be false',assigned_role:'role or null',escalation_role:'role or null',due_after_minutes:'1..525600 or null',depends_on:'existing node keys; no cycles',condition:'null or {field:JSON pointer,operator:catalog operator,value:JSON}',form_fields:'[{key,label,field_type,required,options:[],chart_target?: supported reviewed demographics target}]',native:'optional {resource}; completion is checked against a saved native record for this patient and visit',ai:'AI nodes only: {integration_id,instruction,source_field,privacy}',editor_position:'optional {x,y}; preserve existing positions'},
  native_resources:typeof journeyNativeResources==='object'?Object.keys(journeyNativeResources):['appointment_booked','check_in','signed_visit','functional_status','neurotoxin','baclofen_pump_refill','stretching_program','care_coordination','eligibility','payment','order','referral','intake_reviewed','follow_up','claim_review','claim_submitted','claim_accepted'],
  chart_targets:['demographics.preferred_name','demographics.pronouns','demographics.language','demographics.administrative_gender','demographics.phone','demographics.email'],
  ai_privacy:{mode:'pseudonymize',preview_required:true,restore_locally:true,retain_clinical_codes:true},
  ai_connections:sunConnections.filter(item=>item.enabled!==false).map(item=>({id:item.id,provider:item.provider,model:item.model,capabilities:(item.capabilities||[]).filter(purpose=>['draft_response','structured_extraction'].includes(purpose))})),
  mapping_support:['Run conditions reference explicit JSON pointers.','AI source_field maps one text field from run context.','Form fields define native intake or clinical-template fields.'],
  unsupported:['No arbitrary JavaScript, SQL, HTTP endpoints or tool calls.','No arbitrary provider/action payload mappings. Chart targets are limited to the listed demographics fields and require an explicit staff review and apply action.','No new node kinds or external integrations.','Native action nodes still use existing runtime permissions, preparation and approval; a proposed node does not configure a provider or perform an action.','Payment request nodes coordinate work; they do not charge a card.','Communication nodes create reviewed drafts; they do not immediately send or place calls.','Reviewed, patient-linked inbound call, SMS, fax and email events can start a published matching workflow. Provider accounts must already be configured.']
 };
}
async function sunPrepareWorkflow(){
 const text=$('sun-text')?.value.trim();if(!text||sunBusy)return;
 let base;try{base=sunWorkflowCapture();}catch(error){sunStatus(error.message);return;}
 const connection=sunConnections.find(item=>item.id===$('sun-provider')?.value&&item.capabilities?.includes('workflow_design'));
 if(!connection){if($('sun-settings'))$('sun-settings').open=true;sunStatus('Choose a connection enabled for Workflow design. An owner can enable that purpose in Integrations.');return;}
 stopSunListening();sunInvalidatePrivacyReview();
 const operation={},account=me,generation=sunGeneration,revision=sunPreviewRevision,signature=sunRequestSignature(),panel=$('sun-panel');
 const current=()=>account===me&&generation===sunGeneration&&revision===sunPreviewRevision&&signature===sunRequestSignature()&&$('sun-panel')===panel&&!panel.hidden;
 const body={integration_id:connection.id,purpose:'workflow_design',instruction:'Design a SunCharts workflow from the staff request and current_definition. Return ONLY a JSON object with exactly name, description, trigger_type, definition. definition has exactly columns and steps using native_catalog. Preserve all existing content, node keys, settings, forms, dependencies and positions unless the request calls for a change. Never include code, scripts, unsupported mappings, tool calls or new node kinds. Do not claim to save, publish or execute anything. Human approval and both AI privacy reviews cannot be disabled. Use only listed enabled connection IDs for AI nodes. Unsupported requests must not be represented as executable configuration. This proposal will be schema-validated, reviewed by a person, and applied only to an unsaved draft.',source_text:JSON.stringify({staff_request:text,current_definition:base.payload,native_catalog:sunWorkflowCatalog()})};
 if(new TextEncoder().encode(body.source_text).length>65536){sunStatus('This workflow is too large for one Sun design request. Continue editing it in Workflow Studio. Nothing was sent to a provider.');return;}
 sunBusy=operation;$('sun-send').disabled=true;sunStatus('Preparing a workflow-design preview. Only the draft definition and native node catalog are included; no patient records or workflow runs are added.');
 try{
  const preview=await api('/api/v1/ai/privacy/preview','POST',body);if(!current())return;
  if(!sunWorkflowBaseCurrent(base))throw new Error('The Studio draft changed. Ask Sun again using the current draft.');
  if(!sunPrivacyValid(preview))throw new Error('A valid outgoing preview was not returned. Prepare it again.');
  sunPrivacyReview={body,preview,signature,generation,account,workflowBase:base};const host=$('sun-privacy-preview');host.hidden=false;
  host.innerHTML=`${sunPrivacyPreviewMarkup(preview)}<label class="review-ack" for="sun-privacy-approved"><input type="checkbox" id="sun-privacy-approved"> I reviewed the exact outgoing workflow definition and request.</label><button type="button" class="primary" id="sun-execute">Approve preview and propose changes</button>`;
  $('sun-execute').onclick=()=>void sunExecute();sunCollapseSettings();sunStatus('Review the outgoing definition and request. Approval asks the provider for a proposal; it does not edit Studio.');
 }catch(error){if(current())sunStatus(error.message);}finally{if(sunBusy===operation){sunBusy=false;if(generation===sunGeneration&&$('sun-panel')===panel&&$('sun-send'))$('sun-send').disabled=false;if(typeof updateSunOrb==='function')updateSunOrb();}}
}
function sunWorkflowValidated(response,draftId){
 if(response?.valid!==true||response.draft_id!==draftId||response.application!=='unsaved_studio_draft_only'||!response.proposal||!['name','description','trigger_type'].every(key=>typeof response.proposal[key]==='string')||!Array.isArray(response.proposal.definition?.steps)||!Array.isArray(response.proposal.definition?.columns)||!Array.isArray(response.warnings))throw new Error('The server did not return a validated workflow proposal. Nothing was applied.');
 return {proposal:sunWorkflowCopy({name:response.proposal.name,description:response.proposal.description,trigger_type:response.proposal.trigger_type,definition:response.proposal.definition}),warnings:response.warnings.map(String)};
}
async function sunReceiveWorkflowDraft(draft,review,current){
 if(draft.status!=='draft'){sunInvalidatePrivacyReview();sunStatus(`Sun could not prepare a workflow proposal: ${draft.failure_code||'provider result unavailable'}. Nothing changed in Studio.`);return;}
 if(!sunWorkflowBaseCurrent(review.workflowBase)){sunInvalidatePrivacyReview();sunStatus('The Studio draft changed while Sun was working. Nothing was applied. Ask again from the current draft.');return;}
 sunStatus('Checking the proposed nodes, forms and dependencies against the native workflow schema…');
 const response=await api('/api/v1/sun/workflow-proposals/validate','POST',{draft_id:draft.id});if(!current())return;
 const validated=sunWorkflowValidated(response,draft.id);
 if(!sunWorkflowBaseCurrent(review.workflowBase)){sunInvalidatePrivacyReview();sunStatus('The Studio draft changed. Nothing was applied. Ask again from the current draft.');return;}
 sunInvalidatePrivacyReview();sunWorkflowProposal={...validated,draftId:draft.id,base:review.workflowBase,signature:review.signature,generation:sunGeneration,account:me,panel:$('sun-panel'),revision:sunPreviewRevision};sunRenderWorkflowProposal();
}
function sunWorkflowDiff(before,after){
 const changes=[],show=value=>value==null?'None':typeof value==='boolean'?(value?'Yes':'No'):typeof value==='object'?JSON.stringify(value):String(value);
 const add=(area,action,label,oldValue,newValue)=>changes.push({area,action,label,before:show(oldValue),after:show(newValue)});
 const compare=(area,label,a,b,fields)=>{for(const [key,title] of fields)if(sunWorkflowCanonical(a?.[key]??null)!==sunWorkflowCanonical(b?.[key]??null))add(area,'Change',`${label} · ${title}`,a?.[key],b?.[key]);};
 compare('Workflow','Workflow',before,after,[['name','Name'],['description','Description'],['trigger_type','Trigger']]);
 for(const [collection,area,fields] of [['columns','Stages',[['title','Title'],['description','Description'],['hidden','Hidden']]],['steps','Nodes',[['title','Title'],['kind','Node type'],['phase','Stage'],['required','Required'],['manual_approval','Human approval'],['assigned_role','Assigned role'],['escalation_role','Escalation role'],['due_after_minutes','Due after minutes'],['condition','Run condition'],['ai','AI source mapping and instruction'],['editor_position','Canvas position'],['native','Required native record']]]]){
  const oldItems=new Map((before.definition[collection]||[]).map(item=>[item.key,item])),newItems=new Map((after.definition[collection]||[]).map(item=>[item.key,item]));
  for(const [key,item] of oldItems)if(!newItems.has(key))add(area,'Remove',`${item.title} (${key})`,item,null);
  for(const [key,item] of newItems){if(!oldItems.has(key))add(area,'Add',`${item.title} (${key})`,null,collection==='steps'?Object.fromEntries(fields.map(([field])=>[field,item[field]??null])):item);else compare(area,`${item.title} (${key})`,oldItems.get(key),item,fields);}
  if(sunWorkflowCanonical([...oldItems.keys()].filter(key=>newItems.has(key)))!==sunWorkflowCanonical([...newItems.keys()].filter(key=>oldItems.has(key))))add(area,'Reorder',area,[...oldItems.keys()],[...newItems.keys()]);
 }
 const forms=value=>new Map(value.definition.steps.flatMap(step=>(step.form_fields||[]).map(field=>[`${step.key}/${field.key}`,{...field,node:step.title}]))),oldForms=forms(before),newForms=forms(after);
 for(const [key,field] of oldForms)if(!newForms.has(key))add('Forms','Remove',`${field.node} · ${field.label} (${key})`,field,null);
 for(const [key,field] of newForms){if(!oldForms.has(key))add('Forms','Add',`${field.node} · ${field.label} (${key})`,null,field);else compare('Forms',`${field.node} · ${field.label} (${key})`,oldForms.get(key),field,[['label','Label'],['field_type','Field type'],['required','Required'],['options','Choices'],['chart_target','Reviewed chart destination']]);}
 for(const step of after.definition.steps){const previous=before.definition.steps.find(item=>item.key===step.key);if(!previous)continue;const oldOrder=(previous.form_fields||[]).map(field=>field.key),newOrder=(step.form_fields||[]).map(field=>field.key);if(sunWorkflowCanonical(oldOrder)!==sunWorkflowCanonical(newOrder))add('Forms','Reorder',`${step.title} · field order`,oldOrder,newOrder);}
 const edges=value=>new Set(value.definition.steps.flatMap(step=>(step.depends_on||[]).map(from=>`${from} → ${step.key}`))),oldEdges=edges(before),newEdges=edges(after);
 for(const edge of oldEdges)if(!newEdges.has(edge))add('Connections','Remove',edge,edge,null);
 for(const edge of newEdges)if(!oldEdges.has(edge))add('Connections','Add',edge,null,edge);
 return changes;
}
function sunRenderWorkflowProposal(){
 const state=sunWorkflowProposal,host=$('sun-answer');if(!state||!host)return;
 const changes=sunWorkflowDiff(state.base.payload,state.proposal),groups=['Workflow','Stages','Nodes','Forms','Connections'];
 host.dataset.origin='provider';host.classList?.remove('sun-local-answer');host.classList?.add('sun-workflow-proposal');
 host.innerHTML=`<h3>Review workflow changes</h3><p>${changes.length?`${changes.length} proposed change${changes.length===1?'':'s'} to ${esc(state.base.payload.name)}.`:'The proposed definition matches the current draft.'} Nothing has changed in Studio.</p>${state.warnings.map(warning=>`<p class="notice warning">${esc(warning)}</p>`).join('')}<p class="muted">Source mappings cover run conditions and AI source fields. Only listed native completion checks and reviewed demographics destinations are supported. No arbitrary chart writes.</p>${groups.map(area=>{const items=changes.filter(change=>change.area===area);return items.length?`<details open><summary>${area} · ${items.length}</summary>${items.map(change=>`<article class="sun-workflow-change"><b>${esc(change.action)}: ${esc(change.label)}</b><dl><div><dt>Before</dt><dd>${esc(change.before)}</dd></div><div><dt>After</dt><dd>${esc(change.after)}</dd></div></dl></article>`).join('')}</details>`:'';}).join('')}<details><summary>Complete proposed definition</summary><pre>${esc(JSON.stringify(state.proposal,null,2))}</pre></details>${changes.length?'<label class="review-ack" for="sun-workflow-approved"><input id="sun-workflow-approved" type="checkbox"> I reviewed these changes and want them applied to this unsaved Studio draft.</label><button type="button" id="sun-workflow-apply" class="primary">Approve changes to draft</button>':''}<p class="muted">Save, validate and publish separately in Workflow Studio. Existing live workflows and patient records are unaffected.</p>`;
 host.hidden=false;sunCollapseSettings();sunAnswerContext={signature:state.signature,generation:sunGeneration,account:me};if($('sun-workflow-apply'))$('sun-workflow-apply').onclick=()=>void sunApplyWorkflowProposal();sunStatus('Workflow proposal ready. Review the changes before applying them to the unsaved Studio draft.');
}
async function sunApplyWorkflowProposal(){
 const state=sunWorkflowProposal;if(!state||sunBusy)return;
 const current=()=>sunWorkflowProposal===state&&state.account===me&&state.generation===sunGeneration&&state.revision===sunPreviewRevision&&state.panel===$('sun-panel')&&!state.panel.hidden&&state.signature===sunRequestSignature()&&sunWorkflowBaseCurrent(state.base);
 if(!current()){sunClearWorkflowProposal();sunStatus('The Studio draft or Sun request changed. Ask again to review a proposal for the current draft.');return;}
 if(!$('sun-workflow-approved')?.checked){sunStatus('Review the proposed changes and check the approval box first.');return;}
 const operation={};sunBusy=operation;$('sun-workflow-apply').disabled=true;sunStatus('Rechecking the saved revision and validated proposal before updating this draft…');
 try{
  if(state.base.id){const saved=await api(`/api/v1/care-pathways/definitions/${encodeURIComponent(state.base.id)}`);if(!current())return;if(saved.id!==state.base.id||saved.version!==state.base.version)throw new Error('The saved workflow revision changed. Reload and review a new proposal before applying.');}
  const response=await api('/api/v1/sun/workflow-proposals/validate','POST',{draft_id:state.draftId});if(!current())return;
  const checked=sunWorkflowValidated(response,state.draftId);if(sunWorkflowCanonical(checked.proposal)!==sunWorkflowCanonical(state.proposal))throw new Error('The validated proposal changed. Prepare and review a new proposal.');
  const selectedStep=studioDraft._selectedStep;Object.assign(studioDraft,sunWorkflowCopy(state.proposal));studioDraft._selectedStep=studioDraft.definition.steps.some(step=>step.key===selectedStep)?selectedStep:studioDraft.definition.steps[0]?.key||null;
  studioView='builder';studioInputChanged();studioRender();sunClearWorkflowProposal();$('sun-answer').textContent='Changes applied to the unsaved Studio draft. Review the canvas, then use Save draft. Validate and publish are separate actions.';$('sun-answer').hidden=false;sunStatus('Unsaved draft updated. Nothing was saved, published, or executed.');
 }catch(error){if(current())sunStatus(error.message);}finally{if(sunBusy===operation){sunBusy=false;if($('sun-workflow-apply'))$('sun-workflow-apply').disabled=false;if(typeof updateSunOrb==='function')updateSunOrb();}}
}
async function sunOpenWorkflowDesigner(){
 if(!sunWorkflowActive()){sunStatus('Open Workflow Studio and choose a draft first.');return;}
 const account=me,generation=sunGeneration,draft=studioDraft;await openSun();if(account!==me||generation!==sunGeneration||draft!==studioDraft||!sunWorkflowActive()||!$('sun-panel')||$('sun-panel').hidden)return;$('sun-mode').value='design';$('sun-mode').onchange();if($('sun-settings'))$('sun-settings').open=true;$('sun-text').placeholder='Describe the workflow, form fields, connections, or source mappings you want to change.';$('sun-text').focus();
}
