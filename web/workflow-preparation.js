// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const studioPreparationKinds=new Set(['availability_query','slot_hold','appointment_reschedule','appointment_cancel','intake_request','communication_send']);
let studioPreparationSources=new WeakMap(),studioPreparationLoads=new WeakMap();
function clearStudioPreparation(){studioPreparationSources=new WeakMap();studioPreparationLoads=new WeakMap();}
function studioPreparationContext(instance,key){
 const item=studioRuns.find(value=>value.id===instance),step=item?.steps?.find(value=>value.step_key===key),definition=item?.definition?.steps?.find(value=>value.key===key);
 if(!item||!step||!definition||!studioPreparationKinds.has(step.kind)||definition.kind!==step.kind)throw new Error('This saved run action is unavailable. Refresh the journey.');
 return {item,step,definition};
}
function studioPreparationBlocker(item,step){
 if(item.status!=='active')return 'This journey is not active.';
 if(!['ready','in_progress'].includes(step.state||step.status))return 'Waiting for this step’s prerequisites or current review.';
 if(!step.manual_approval)return 'This saved revision has no required dispatch approval. Update the workflow for future runs; this action cannot be prepared here.';
 if(!pathwayCanWork(step))return 'This step is assigned to another team or your role cannot prepare actions.';
 if(!item.patient_id&&step.kind!=='communication_send')return 'Link a patient to this journey before preparing this action.';
 if(step.kind==='communication_send'&&me?.role!=='owner')return 'A practice owner must choose the communication connection. The connection catalog is not available to other staff roles.';
 const permission=step.kind==='communication_send'?['communications','create']:step.kind==='availability_query'?['scheduling','view']:step.kind==='appointment_reschedule'?['scheduling','edit']:step.kind==='appointment_cancel'?['scheduling','delete']:['scheduling','create'];
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed(...permission))return 'Your assigned access policy does not permit this native action.';
 return '';
}
function studioRunPreparation(){
 const item=studioRuns.find(value=>value.id===studioSelectedRun);if(!item)return '';
 const steps=(item.steps||[]).filter(step=>studioPreparationKinds.has(step.kind));if(!steps.length)return '';
 return `<section class="studio-summary-card"><h3>Prepare native actions</h3><p class="muted">Use this run’s saved steps and linked records. Preparing creates a review item; approval is separate.</p>${steps.map(step=>{const blocker=studioPreparationBlocker(item,step);return `<article class="integration-access-row"><div><b>${esc(step.title||step.step_key)}</b><small>${esc(studioKinds[step.kind])} · ${esc(human(step.state||step.status))}</small>${blocker?`<p>${esc(blocker)}</p>`:''}<button type="button" data-studio-native-prepare="${esc(step.step_key)}" data-instance="${esc(item.id)}" ${blocker?'disabled':''}>Prepare for review</button><div data-studio-preparation-host></div></div></article>`;}).join('')}</section>`;
}
function studioPreparationAppointmentIds(item){
 if(item.appointment_id)return [item.appointment_id];
 return [...new Set(studioDispatches.filter(value=>value.pathway_instance_id===item.id&&value.kind==='appointment_booking'&&value.status==='completed'&&value.result?.appointment_id).map(value=>value.result.appointment_id))];
}
function studioPreparationForms(item){return (item.definition?.steps||[]).filter(node=>node.kind==='patient_form'&&node.form_fields?.length).filter(node=>{const step=item.steps.find(value=>value.step_key===node.key);return step&&['ready','in_progress'].includes(step.state||step.status)&&pathwayCanWork(step);});}
async function studioLoadPreparationSources(item,step){
 const sources={providers:[],services:[],connections:[],forms:[],appointment:null};
 const reads=[];
 if(['availability_query','appointment_reschedule'].includes(step.kind))reads.push(api('/api/v1/schedule/providers').then(value=>{sources.providers=value.items||[];if(!sources.providers.length)throw new Error('No scheduling providers are available. Configure an active provider first.');}));
 if(step.kind==='slot_hold')reads.push(api('/api/v1/scheduling/services').then(value=>{sources.services=(value.items||[]).filter(service=>Number.isInteger(service.duration_minutes)&&service.duration_minutes>0);if(!sources.services.length)throw new Error('No enabled scheduling services are available. A hold needs a saved service with a provider and duration.');}));
 if(['appointment_reschedule','appointment_cancel','intake_request'].includes(step.kind)){
  const ids=studioPreparationAppointmentIds(item);if(ids.length!==1)throw new Error(ids.length?'This run has multiple booking results. Link one appointment before preparing this action.':'Link an appointment or complete this journey’s booking step first.');
  reads.push(api(`/api/v1/appointments/${encodeURIComponent(ids[0])}`).then(value=>{if(value.patient_id!==item.patient_id)throw new Error('The linked appointment does not belong to this journey’s patient.');if(!Number.isInteger(value.version)||value.version<1)throw new Error('The appointment version is unavailable. Refresh the run.');const allowed=step.kind==='intake_request'?['booked','checked_in']:['booked'];if(!allowed.includes(value.status))throw new Error(`The linked appointment is ${human(value.status)} and cannot be used for this action.`);sources.appointment=value;}));
 }
 if(step.kind==='intake_request'){sources.forms=studioPreparationForms(item);if(!sources.forms.length)throw new Error('No ready patient form with saved fields is available in this run’s revision. Configure and use a patient form step; a default intake template will not be substituted.');}
 if(step.kind==='communication_send'){
  if(me?.role!=='owner')throw new Error('A practice owner must choose the communication connection.');
  reads.push(api('/api/v1/integrations').then(value=>{sources.connections=(value.items||[]).filter(connection=>['gmail','ringcentral'].includes(connection.provider)&&connection.enabled&&connection.status==='connected'&&connection.credential_stored).map(({id,provider,label,capabilities})=>({id,provider,label,capabilities}));if(!sources.connections.length)throw new Error('No enabled, connected Gmail or RingCentral connection is available. An owner must configure and authorize one in Integrations.');}));
 }
 await Promise.all(reads);return sources;
}
const studioPrepValue=(value='')=>esc(value??'');
function studioPrepLocalTime(value){if(!value)return '';const time=new Date(value);if(!Number.isFinite(time.getTime()))return '';return new Date(time.getTime()-time.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function studioPreparationTiming(appointment,withEnd=true){return `<div class="form-grid"><label>Start (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)})<input name="starts_at" type="datetime-local" value="${studioPrepLocalTime(appointment?.starts_at)}" required></label>${withEnd?`<label>End<input name="ends_at" type="datetime-local" value="${studioPrepLocalTime(appointment?.ends_at)}" required></label>`:''}</div>`;}
function studioPreparationCommunication(connection,kind='sms'){
 if(!connection)return '<p>Choose a saved connection.</p>';
 if(connection.provider==='gmail')return '<label>To (comma separated)<input name="to" required></label><label>Cc (optional)<input name="cc"></label><label>Subject<input name="subject" required maxlength="500"></label><label>Message<textarea name="body_text" required maxlength="65536"></textarea></label><label>Attachments (optional)<input name="attachments" type="file" multiple></label><p class="muted">Gmail must also authorize sending. Approval here creates a local draft; its recipients, content and separate send action are reviewed in Gmail drafts.</p>';
 const kinds=[['sms','SMS'],['ringout','Phone call (RingOut)'],['fax','PDF fax']].filter(([value])=>(connection.capabilities||[]).includes(value==='ringout'?'voice':value));
 if(!kinds.length)return '<p class="notice error">This connection has no SMS, voice or fax capability enabled.</p>';
 if(!kinds.some(([value])=>value===kind))kind=kinds[0][0];
 return `<label>Communication type<select name="ring_kind" data-studio-preparation-ring>${kinds.map(([value,label])=>`<option value="${value}" ${kind===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Recipient phone<input name="recipient" type="tel" required placeholder="+15551234567" pattern="\\+[0-9]{8,15}"></label>${kind==='fax'?'<label>Reviewed PDF<input name="document" type="file" accept="application/pdf" required></label><label>Cover page note<textarea name="cover_page_text" maxlength="1024"></textarea></label>':`<label>${kind==='sms'?'Practice SMS number':'Call-from number (optional)'}<input name="sender" type="tel" ${kind==='sms'?'required':''} placeholder="+15557654321" pattern="\\+[0-9]{8,15}"></label>${kind==='sms'?'<label>Message<textarea name="text" required maxlength="1000"></textarea></label>':'<p class="muted">RingOut uses the configured phone endpoint. This is not browser calling.</p>'}`}<p class="muted">Approval here creates a RingCentral draft. Recipient review and sending remain separate; provider acceptance does not prove delivery.</p>`;
}
function studioPreparationForm(item,step,sources){
 const appointment=sources.appointment;let body='';
 if(['availability_query','appointment_reschedule'].includes(step.kind))body+=`<label>Provider<select name="clinician_id" required><option value="">Choose a provider</option>${sources.providers.map(provider=>`<option value="${esc(provider.id)}" ${provider.id===appointment?.clinician_id?'selected':''}>${esc(provider.label)}</option>`).join('')}</select></label>${studioPreparationTiming(appointment)}<div class="form-grid"><label>Facility<input name="facility" maxlength="200" value="${studioPrepValue(appointment?.facility)}"></label><label>Room<input name="room" maxlength="100" value="${studioPrepValue(appointment?.room)}"></label></div>`;
 if(step.kind==='availability_query')body+='<p>Approval checks this exact time range for conflicts. A successful check does not hold or book it.</p>';
 if(step.kind==='slot_hold')body+=`<label>Saved scheduling service<select name="service_id" required>${sources.services.map(service=>`<option value="${esc(service.id)}">${esc(service.name)} · ${esc(service.provider_name)} · ${service.duration_minutes} minutes${service.facility?' · '+esc(service.facility):''}${service.room?' · '+esc(service.room):''}</option>`).join('')}</select></label>${studioPreparationTiming(null,false)}<p>The saved service supplies the provider, duration and location. Approval checks availability and creates a hold lasting 10 minutes; it does not book an appointment.</p>`;
 if(step.kind==='appointment_reschedule')body+=`<label>Visit title<input name="title" maxlength="200" value="${studioPrepValue(appointment.title)}" required></label><label>Category<input name="category" maxlength="100" value="${studioPrepValue(appointment.category)}" required></label><label>Appointment notes<textarea name="notes" maxlength="2000">${studioPrepValue(appointment.notes)}</textarea></label><p>Approval updates this appointment only if its saved version and booked status still match, then checks scheduling conflicts.</p>`;
 if(step.kind==='appointment_cancel')body+='<p>Approval cancels this linked appointment if it is still booked at the reviewed version. It does not cancel other appointments.</p>';
 if(step.kind==='intake_request')body+=`<label>Saved patient form<select name="form_step_key" required>${sources.forms.map(node=>`<option value="${esc(node.key)}">${esc(node.title)} · ${node.form_fields.length} fields</option>`).join('')}</select></label><details><summary>Forms in this saved revision</summary>${sources.forms.map(node=>`<h5>${esc(node.title)}</h5><ul>${node.form_fields.map(field=>`<li>${esc(field.label)}${field.required?' · required':''}${field.chart_target?' · reviewed chart handoff':''}</li>`).join('')}</ul>`).join('')}</details><p>Approval issues the selected immutable workflow form. Its link is shown once and is not sent automatically. Patient submission, staff review and chart handoff remain separate.</p>`;
 if(step.kind==='communication_send')body+=`<label>Saved connection<select name="integration_id" data-studio-preparation-connection required>${sources.connections.map(connection=>`<option value="${esc(connection.id)}">${esc(connection.label)} · ${connection.provider==='gmail'?'Gmail':'RingCentral'}</option>`).join('')}</select></label><div data-studio-preparation-message>${studioPreparationCommunication(sources.connections[0])}</div><p class="muted">Files and content together must fit the workflow’s 256 KiB request limit. Larger documents require the native communications workspace; no attachment is silently omitted.</p>`;
 return `<form class="studio-native-preparation" data-instance="${esc(item.id)}" data-step="${esc(step.step_key)}" data-version="${step.version}" data-request="${esc(crypto.randomUUID())}"><h4>${esc(studioKinds[step.kind])}</h4><p>Patient: <b>${esc(typeof journeyPatientLabel==='function'?journeyPatientLabel(item):item.patient_id||'No patient linked')}</b> · saved workflow revision ${item.definition_version}</p>${appointment?`<p><b>Linked appointment:</b> ${esc(appointment.title)} · ${esc(date(appointment.starts_at))} · ${esc(human(appointment.status))} · version ${appointment.version}</p>`:''}${body}<label class="review-ack"><input name="reviewed" type="checkbox" required> I reviewed these details${step.kind==='communication_send'?' and the recipients':''}. Create an approval item only.</label><label>Reason<input name="reason" maxlength="1000" required></label><div class="actions"><button type="submit" class="primary">Prepare approval</button><button type="button" data-studio-preparation-close>Close preparation</button></div><p data-studio-preparation-status role="status"></p></form>`;
}
async function studioOpenPreparation(button){
 const {item,step}=studioPreparationContext(button.dataset.instance,button.dataset.studioNativePrepare),blocker=studioPreparationBlocker(item,step);if(blocker)throw new Error(blocker);
 const host=button.parentElement.querySelector('[data-studio-preparation-host]');if(!host||host.querySelector('.studio-native-preparation'))return;
 const account=me,session=studioSessionGeneration,tools=$('tools'),token={};studioPreparationLoads.set(host,token);host.innerHTML='<p role="status">Loading native choices…</p>';
 const current=()=>me===account&&studioSessionGeneration===session&&studioView==='runs'&&studioSelectedRun===item.id&&$('tools')===tools&&host.isConnected!==false&&studioPreparationLoads.get(host)===token;
 try{const sources=await studioLoadPreparationSources(item,step);if(!current())return;const latest=studioPreparationContext(item.id,step.step_key);if(latest.step.version!==step.version)throw new Error('This step changed while loading. Refresh the journey.');host.innerHTML=studioPreparationForm(item,step,sources);const form=host.querySelector('form');if(form)studioPreparationSources.set(form,{...sources,account,session,instance:item.id,step:step.step_key,version:step.version,kind:step.kind,busy:false});}
 catch(error){if(current())host.innerHTML=`<p class="notice error">${esc(error.message)}</p><button type="button" data-studio-preparation-close>Close</button>`;}
}
function studioPreparationSignature(form){return JSON.stringify([...new FormData(form)].map(([key,value])=>[key,typeof value==='string'?value:{name:value.name,size:value.size,lastModified:value.lastModified}]));}
function studioPreparationRequired(data,key,label,max=1000){const value=String(data.get(key)||'').trim();if(!value||value.length>max)throw new Error(`${label} is required and must be ${max} characters or less.`);return value;}
async function studioPreparationFile(file){if(typeof outboundFile!=='function')throw new Error('The native file reader is unavailable. Reload before adding a document.');if(!file?.size||file.size>180000)throw new Error('Choose a nonempty file under 180 KB. Larger documents must use the native communications workspace.');return outboundFile(file);}
async function studioPreparationInput(form,state,item,step,data){
 const value=key=>String(data.get(key)||'').trim(),input={},appointment=state.appointment;
 if(['availability_query','slot_hold','appointment_reschedule'].includes(step.kind)){
  if(typeof scheduleInstant!=='function')throw new Error('The scheduling time converter is unavailable. Reload the workspace.');
  input.starts_at=scheduleInstant(value('starts_at'));
  if(step.kind==='slot_hold'){const service=state.services.find(row=>row.id===value('service_id'));if(!service)throw new Error('Choose one of the loaded scheduling services.');input.service_id=service.id;input.patient_id=item.patient_id;input.ends_at=new Date(new Date(input.starts_at).getTime()+service.duration_minutes*60000).toISOString();}
  else{const provider=state.providers.find(row=>row.id===value('clinician_id'));if(!provider)throw new Error('Choose one of the loaded providers.');input.clinician_id=provider.id;input.ends_at=scheduleInstant(value('ends_at'));input.facility=value('facility');input.room=value('room');if(step.kind==='availability_query')input.patient_id=item.patient_id;}
  if(!Number.isFinite(Date.parse(input.starts_at))||!Number.isFinite(Date.parse(input.ends_at))||Date.parse(input.ends_at)<=Date.parse(input.starts_at))throw new Error('Choose a valid start and a later end time.');
 }
 if(['appointment_reschedule','appointment_cancel','intake_request'].includes(step.kind)){
  if(!appointment||appointment.patient_id!==item.patient_id||!studioPreparationAppointmentIds(item).includes(appointment.id))throw new Error('The linked appointment changed. Reopen preparation.');
  input.appointment_id=appointment.id;if(step.kind!=='intake_request')input.expected_version=appointment.version;
 }
 if(step.kind==='appointment_reschedule')Object.assign(input,{title:studioPreparationRequired(data,'title','Visit title',200),category:studioPreparationRequired(data,'category','Category',100),notes:value('notes')});
 if(step.kind==='intake_request'){const node=state.forms.find(row=>row.key===value('form_step_key'));if(!node||!studioPreparationForms(item).some(row=>row.key===node.key))throw new Error('Choose a ready patient form from this saved workflow revision.');input.form_step_key=node.key;}
 if(step.kind==='communication_send'){
  if(me?.role!=='owner')throw new Error('A practice owner must choose this connection.');
  const connection=state.connections.find(row=>row.id===value('integration_id'));if(!connection)throw new Error('Choose one of the loaded, connected providers.');Object.assign(input,{provider:connection.provider,integration_id:connection.id});
  if(connection.provider==='gmail'){
   const addresses=key=>value(key).split(',').map(address=>address.trim()).filter(Boolean);input.to=addresses('to');input.cc=addresses('cc');if(!input.to.length||[...input.to,...input.cc].some(address=>!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address)))throw new Error('Enter valid recipient email addresses separated by commas.');
   input.subject=studioPreparationRequired(data,'subject','Subject',500);input.body_text=studioPreparationRequired(data,'body_text','Message',65536);const files=[...(form.elements.attachments?.files||[])];if(files.length>10)throw new Error('A draft can contain at most 10 attachments.');input.attachments=[];for(const file of files)input.attachments.push({filename:file.name,mime_type:file.type||'application/octet-stream',content_base64:await studioPreparationFile(file)});
  }else{
   const kind=value('ring_kind'),capability=kind==='ringout'?'voice':kind;if(!['sms','ringout','fax'].includes(kind)||!connection.capabilities?.includes(capability))throw new Error('This connection does not permit that RingCentral action.');
   const recipient=value('recipient'),sender=value('sender');if(!/^\+[0-9]{8,15}$/.test(recipient))throw new Error('Use an international recipient phone number beginning with +.');const payload={kind,recipient};
   if(kind==='sms'){if(!/^\+[0-9]{8,15}$/.test(sender))throw new Error('Use the authorized practice SMS number beginning with +.');Object.assign(payload,{sender,text:studioPreparationRequired(data,'text','Message',1000)});}
   if(kind==='ringout'&&sender){if(!/^\+[0-9]{8,15}$/.test(sender))throw new Error('Use an international call-from number beginning with +.');payload.sender=sender;}
   if(kind==='fax'){const file=form.elements.document?.files?.[0];if(!file||file.type!=='application/pdf'||!/^[A-Za-z0-9._-]+\.pdf$/.test(file.name)||file.name.length>200)throw new Error('Choose a PDF with a filename containing only letters, numbers, dots, underscores or hyphens.');Object.assign(payload,{filename:file.name,content_type:'application/pdf',document_base64:await studioPreparationFile(file),cover_page_text:value('cover_page_text')});}
   input.ringcentral=payload;
  }
 }
 return input;
}
async function studioSubmitPreparation(form){
 const state=studioPreparationSources.get(form);if(!state||state.busy)throw new Error('Reopen this action before preparing it.');
 const {item,step}=studioPreparationContext(state.instance,state.step),blocker=studioPreparationBlocker(item,step);if(blocker)throw new Error(blocker);if(state.account!==me||state.session!==studioSessionGeneration||state.version!==step.version||state.kind!==step.kind)throw new Error('This run or session changed. Reopen preparation.');
 const data=new FormData(form);if(data.get('reviewed')!=='on')throw new Error('Review the details and check the acknowledgment.');const reason=studioPreparationRequired(data,'reason','Reason'),signature=studioPreparationSignature(form),tools=$('tools'),status=form.querySelector('[data-studio-preparation-status]'),button=form.querySelector('button[type="submit"]');
 const current=()=>state.account===me&&state.session===studioSessionGeneration&&studioView==='runs'&&studioSelectedRun===item.id&&$('tools')===tools&&form.isConnected!==false&&studioPreparationSources.get(form)===state;
 state.busy=true;if(button)button.disabled=true;
 try{
  const input=await studioPreparationInput(form,state,item,step,data);if(!current())return;if(signature!==studioPreparationSignature(form))throw new Error('The form changed while reading its content. Review the current details and prepare again.');
  if(new TextEncoder().encode(JSON.stringify(input)).length>262144)throw new Error('This action exceeds the workflow’s 256 KiB limit. Reduce its content or use the native communications workspace for larger documents.');
  const payload=JSON.stringify({input,reason});if(state.submittedInput&&state.submittedInput!==payload)throw new Error('A previous preparation may already exist. Refresh the run and review its queue before preparing changed content.');state.submittedInput=payload;
  const prepared=await api(`/api/v1/care-pathways/instances/${encodeURIComponent(item.id)}/steps/${encodeURIComponent(step.step_key)}/dispatch`,'POST',{request_id:form.dataset.request,input,reason});
  if(!current())return;if(signature!==studioPreparationSignature(form)){if(status)status.textContent='An approval item was prepared from the earlier reviewed details. Refresh the journey to open it; these newer edits were not submitted.';return;}
  await studioOpenRunDispatch(prepared.id,item.id);notice('Action prepared. Review its exact details before approval.');
 }catch(error){if(current()){if(status)status.textContent=error.message;else throw error;}}
 finally{state.busy=false;if(current()&&button)button.disabled=false;}
}
function studioPreparedInputReview(item){
 if(!studioPreparationKinds.has(item.kind)||!item.input)return '';const input=item.input,rows=[],add=(label,value)=>{if(value!==undefined&&value!==null&&value!=='')rows.push(`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`);};
 const run=studioRuns.find(value=>value.id===item.pathway_instance_id);add('Patient',run&&typeof journeyPatientLabel==='function'?journeyPatientLabel(run):run?.patient_id||'No patient linked');
 add('Provider record',input.clinician_id);add('Service record',input.service_id);add('Appointment record',input.appointment_id);add('Reviewed appointment version',input.expected_version);add('Visit',input.title);add('Category',input.category);add('Start',input.starts_at?date(input.starts_at):'');add('End',input.ends_at?date(input.ends_at):'');add('Location',[input.facility,input.room].filter(Boolean).join(' · '));add('Appointment notes',input.notes);
 if(input.form_step_key){const form=run?.definition?.steps?.find(step=>step.key===input.form_step_key);add('Saved patient form',form?.title||input.form_step_key);add('Saved revision',run?.definition_version);add('Fields',(form?.form_fields||[]).map(field=>field.label).join(' · '));}
 let content='';if(item.kind==='communication_send'){add('Provider',input.provider==='gmail'?'Gmail':'RingCentral');add('Connection record',input.integration_id);if(input.provider==='gmail'){add('To',(input.to||[]).join(', '));add('Cc',(input.cc||[]).join(', '));add('Subject',input.subject);add('Attachments',(input.attachments||[]).map(file=>file.filename).join(' · '));content=input.body_text;}else{const payload=input.ringcentral||{};add('Action',human(payload.kind));add('Recipient',payload.recipient);add('From',payload.sender);add('PDF',payload.filename);content=payload.text||payload.cover_page_text||'';}}
 return `<section class="journey-booking-review"><h4>Prepared details</h4><dl>${rows.join('')}</dl>${content?`<pre>${esc(content)}</pre>`:''}<p class="muted">${item.kind==='communication_send'?'Approval creates a provider draft only. Its content review and send gate remain separate.':item.kind==='intake_request'?'Approval issues the selected saved form. Copy its one-time link after approval; submission and staff review remain separate.':'Approval rechecks the linked records and scheduling rules. Preparation alone does not change the schedule.'}</p></section>`;
}
function studioShowPreparedSecret(response){
 const path=response?.one_time?.intake_url;if(typeof path!=='string'||!/^\/intake#token=[A-Za-z0-9_-]+$/.test(path))return;
 const host=$('tools')?.querySelector?.('.studio-runtime-detail');if(!host)return;
 const section=document.createElement('section');section.className='studio-dispatch-secret';section.innerHTML=`<h4>Copy the issued intake link now</h4><p>This secure link is shown once. It has not been sent. Patient submission, staff review and chart handoff remain separate.</p><label>Secure intake link<input readonly data-studio-issued-link value="${esc(location.origin+path)}"></label><div class="actions"><button type="button" data-studio-copy-issued>Copy link</button><button type="button" data-studio-dismiss-issued>Done with link</button></div>`;host.prepend(section);
}
document.addEventListener('click',event=>{const button=event.target.closest?.('button');if(!button)return;if(button.dataset.studioNativePrepare){run(()=>studioOpenPreparation(button));return;}if(button.hasAttribute('data-studio-preparation-close')){const host=button.closest('[data-studio-preparation-host]');if(host){studioPreparationLoads.delete(host);host.innerHTML='';}return;}if(button.hasAttribute('data-studio-copy-issued')){const field=button.closest('.studio-dispatch-secret')?.querySelector('[data-studio-issued-link]');if(field)run(async()=>{await navigator.clipboard.writeText(field.value);notice('Secure intake link copied.');});return;}if(button.hasAttribute('data-studio-dismiss-issued'))button.closest('.studio-dispatch-secret')?.remove();});
document.addEventListener('change',event=>{const target=event.target,form=target.closest?.('.studio-native-preparation'),state=form&&studioPreparationSources.get(form);if(!state)return;if(target.hasAttribute('data-studio-preparation-connection')||target.hasAttribute('data-studio-preparation-ring')){const connection=state.connections.find(row=>row.id===form.elements.integration_id.value),host=form.querySelector('[data-studio-preparation-message]');if(host)host.innerHTML=studioPreparationCommunication(connection,target.hasAttribute('data-studio-preparation-ring')?target.value:undefined);}});
document.addEventListener('submit',event=>{if(event.target.classList?.contains('studio-native-preparation')){event.preventDefault();run(()=>studioSubmitPreparation(event.target));}});
