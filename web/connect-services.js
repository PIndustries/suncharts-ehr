// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const connectServicesApi='/api/v1/connect/services';
let connectionStatusSnapshot;
const connectionStates={connected:'Connected',authorized:'Access authorized',needs_attention:'Needs attention',reconnecting:'Reconnecting',offline:'Offline',not_connected:'Not connected'};
function connectStatusCard(data){
 if(!data)return '<section class="connection-summary" data-connect-summary><h3>SunCharts connection</h3><p>Status unavailable. Refresh to check this installation.</p><button type="button" data-connect-refresh>Refresh connection status</button></section>';
 const service=data.services||{},state=connectionStates[data.status]||'Status unavailable',activeServices=service.enabled&&service.verified&&!service.revoked&&service.fresh&&service.availability==='available';
 return `<section class="connection-summary" data-connect-summary aria-label="SunCharts connection status"><div class="section-head"><div><h3>${esc(data.origin||'connect.suncharts.app')}</h3><p><b>${esc(state)}</b></p></div><button type="button" data-connect-refresh>Refresh connection status</button></div><div class="form-grid"><div><b>Clinical access</b><small>${data.practice_authorized?'An active SunCharts authorization exists for this practice.':'No active SunCharts authorization for this practice.'}</small><small>${data.your_account_authorized?'Your account is authorized.':'Your account has not authorized SunCharts.'}</small></div><div><b>Managed services</b><small>${service.revoked?'Disconnected locally':!service.configured?'Not configured':!service.enabled?'Paused':service.availability==='available'&&service.fresh?'Connection verified':'Verification needed'}</small><small>${service.last_checked_at?'Last checked '+esc(date(service.last_checked_at)):'No live service check yet.'}</small>${service.last_verified_at?`<small>Last verified ${esc(date(service.last_verified_at))}</small>`:''}${service.configured?`<small>Managed email: ${activeServices&&service.reminders_available?'Available':'Unavailable'} · Support: ${activeServices&&service.support_available?'Available':'Unavailable'}</small>`:''}</div></div>${data.transport?.configured?`<p class="muted">Outbound connection · ${esc(connectionStates[data.transport.state]||data.transport.state)}${data.transport.last_seen_at?' · Last contact '+esc(date(data.transport.last_seen_at)):''}. Your EHR opens the connection; no inbound firewall port is required.</p>`:''}${data.origin&&!['https://connect.suncharts.app','https://my.suncharts.app'].includes(data.origin)?'<p class="notice">Local synthetic Connect service. This is not the production SunCharts connection.</p>':''}<p class="muted">Connect your practice to use SunCharts tools, managed appointment email and support. Review access and service availability here.</p><div class="actions">${me.role!=='read_only'?'<button type="button" data-connect-services>Managed email & support</button>':''}<a class="button" href="https://connect.suncharts.app/clinic/native-ehr" target="_blank" rel="noopener noreferrer">Open SunCharts ↗</a></div></section>`;
}
let connectionEventSource, connectionEventIdentity, connectionStatusGeneration=0;
function applyConnectionStatus(data,identity){
 if(me!==identity)return null;
 connectionStatusSnapshot=data;
 for(const card of document.querySelectorAll?.('[data-connect-summary]')||[])card.outerHTML=connectStatusCard(data);
 const badge=$('shell-connect-status'),label=$('shell-connect-label');
 if(badge&&label){badge.setAttribute('data-state',data.status);const text='SunCharts: '+(connectionStates[data.status]||'Status unavailable');if(label.textContent!==text)label.textContent=text;badge.title='Connection to '+(data.origin||'SunCharts Connect')+(data.transport?.configured?' · Outbound secure connection · '+(data.transport.last_seen_at?'Last contact '+date(data.transport.last_seen_at):'Waiting for connection'):(data.services?.last_verified_at?' · Last verified '+date(data.services.last_verified_at):' · Open connection details'));}
 return data;
}
function clearConnectionStatusSession(){
 connectionEventSource?.close();connectionEventSource=undefined;connectionEventIdentity=undefined;connectionStatusSnapshot=undefined;connectionStatusGeneration++;
}
function startConnectionStatusEvents(identity){
 if(typeof EventSource==='undefined'||me!==identity)return;
 if(connectionEventSource&&connectionEventIdentity===identity)return;
 clearConnectionStatusSession();connectionEventIdentity=identity;
 const source=typeof openWorkspaceEventSource==='function'?openWorkspaceEventSource('status'):new EventSource('/api/v1/connect/status/events');connectionEventSource=source;
 source.addEventListener('connection',event=>{
  if(me!==identity||connectionEventSource!==source)return;
  try{const data=JSON.parse(event.data);if(data&&typeof data.status==='string'){connectionStatusGeneration++;applyConnectionStatus(data,identity);}}catch{/* Ignore malformed health events; the next HTTP refresh remains authoritative. */}
 });
 source.onerror=()=>{
  if(me!==identity||connectionEventSource!==source){source.close();return;}
  // Loss of the browser health feed is not proof of an EHR/cloud disconnect.
  const badge=$('shell-connect-status'),label=$('shell-connect-label');
  if(badge&&label){badge.setAttribute('data-state','unknown');label.textContent='SunCharts: Checking connection';}
  for(const card of document.querySelectorAll?.('[data-connect-summary]')||[])card.outerHTML=connectStatusCard(null);
 };
}
async function refreshConnectionBadge(live=false){
 const identity=me;if(!identity)return null;
 const generation=connectionStatusGeneration;
 try{
  const data=await api(`/api/v1/connect/status${live?'/refresh':''}`,live?'POST':'GET',live?{}:undefined);
  if(me!==identity)return null;
  if(generation!==connectionStatusGeneration)return connectionStatusSnapshot;
  startConnectionStatusEvents(identity);
  return applyConnectionStatus(data,identity);
 }catch(error){
  if(me===identity){const badge=$('shell-connect-status'),label=$('shell-connect-label');if(badge&&label){badge.setAttribute('data-state','unknown');label.textContent='SunCharts: Status unavailable';}}
  if(me===identity)for(const card of document.querySelectorAll?.('[data-connect-summary]')||[])card.outerHTML=connectStatusCard(null);
  if(live)throw error;return null;
 }
}
document.addEventListener('DOMContentLoaded',()=>{if(typeof me!=='undefined'&&me)void refreshConnectionBadge();});
setInterval(()=>{if(typeof me!=='undefined'&&me)void refreshConnectionBadge();},60000);

let connectServicesSettings;
const supportRole=()=>['owner','clinician','front_desk'].includes(me.role);
function connectServiceSummary(data){
 const s=data.setting,services=s?.services||{};
 return `<div class="mapping-notice"><b>${s?.enabled&&s?.verified?'SunCharts Connect services enabled':'SunCharts Connect services not active'}</b><p>Managed email: ${services.reminders?.available?'Available':'Not verified'} · Support tickets: ${services.support?.available?'Available':'Not verified'}</p><p class="muted">Service availability is verified separately from clinical OAuth access. Your own Resend account remains available for independent, white-label email.</p></div>`;
}
async function showConnectServices(){
 const onboarding=me.role==='owner'?await api('/api/v1/connect/onboarding'):null;
 const [data,connection]=await Promise.all([api(`${connectServicesApi}/settings`),refreshConnectionBadge()]);connectServicesSettings=data.setting;const s=data.setting;
 showTool('Connect services');
 $('tools').innerHTML=`<section id="connect-services-workspace"><div class="section-head"><div><h2>SunCharts Connect</h2><p class="muted">Managed email and practice support</p></div><div class="actions">${supportRole()?'<button type="button" data-support-tickets>Support tickets</button>':''}<button type="button" data-connect-apps>Integrations</button></div></div>${connectStatusCard(connection)}${connectServiceSummary(data)}${me.role==='owner'?`<section class="billing-section">${connectOnboardingCard(onboarding,connection)}${s?`<div class="billing-section"><h3>Connection status</h3>${s.revoked?'<p class="notice">Services are disconnected locally. Revoke this installation in connect.suncharts.app to invalidate its service token there, too.</p>':''}<p>${s.enabled?'Enabled':'Disabled'} · ${s.verified?'Verified':'Not verified'}${s.last_test_result?` · ${esc(scheduleLabel(s.last_test_result))}`:''}</p><div class="actions"><button type="button" data-connect-test>Test service connection</button><button type="button" data-connect-activate="${!s.enabled}" ${!s.verified&&!s.enabled?'disabled':''}>${s.enabled?'Pause services':'Enable services'}</button><button type="button" data-connect-disconnect>Disconnect services locally</button></div></div>`:''}</section><section class="billing-section"><h3>Appointment email</h3><p>Use SunCharts managed email, or choose your practice’s own Resend account for a branded sender.</p><button type="button" data-reminder-settings>Reminder settings</button></section>`:'<p>An owner manages this practice’s service connection. You can access support when the service is enabled for this installation.</p>'}</section>`;
}
let supportNavigationGeneration=0,supportRequestGeneration=0,supportLiveGeneration=0;
const supportDrafts=new Map(),supportSubmittedBaselines=new WeakMap();
function supportFormValues(form){return form?Object.fromEntries(new FormData(form)):{};}
function supportDraftKey(form){return form.id==='support-create-form'?'new':form.dataset.ticket;}
function supportFormSignature(values){return JSON.stringify([values.subject||'',values.message||'',values.reviewed==='on']);}
function rememberSupportForm(form){
 if(!form)return;
 const key=supportDraftKey(form),values=supportFormValues(form),signature=supportFormSignature(values);
 if(!String(values.subject||'').trim()&&!String(values.message||'').trim()||supportSubmittedBaselines.get(form)===signature){supportDrafts.delete(key);return;}
 supportDrafts.set(key,{...values,request_id:form.dataset.request,closed:form.dataset.closed==='true'});
}
function supportSubmissionSaved(form,values){
 const key=supportDraftKey(form),signature=supportFormSignature(values),request=form.dataset.request;
 supportSubmittedBaselines.set(form,signature);
 if(form.isConnected!==false)rememberSupportForm(form);
 else{const retained=supportDrafts.get(key);if(retained?.request_id===request&&supportFormSignature(retained)===signature)supportDrafts.delete(key);}
 const next=crypto.randomUUID();form.dataset.request=next;const retained=supportDrafts.get(key);if(retained?.request_id===request)retained.request_id=next;
}
function captureSupportDrafts(){
 supportNavigationGeneration++;supportLiveGeneration++;
 rememberSupportForm($('support-create-form'));rememberSupportForm($('support-reply-form'));
}
function clearSupportSession(){supportNavigationGeneration++;supportRequestGeneration++;supportLiveGeneration++;supportDrafts.clear();supportExtras.clear();}
function supportHasDrafts(){rememberSupportForm($('support-create-form'));rememberSupportForm($('support-reply-form'));return supportDrafts.size>0||Array.from(supportExtras.values()).some(extras=>extras.files.length>0);}
// Patients, visits, claims and files attached to a support message. They stay in memory with the unsent draft.
const supportFileLimit=5,supportFileMaxBytes=10*1024*1024,supportLinkLimit=10;
const supportFileTypes={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','application/pdf':'pdf','text/plain':'txt','text/csv':'csv'};
const supportFileExtensions={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',csv:'text/csv'};
const supportExtras=new Map();
const supportUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function supportExtrasFor(key){
 let extras=supportExtras.get(key);
 if(!extras){extras={links:[],files:[],suggested:[],picker:null,problem:'',unavailable:false,plain:false,attempt:null,pasted:0};supportExtras.set(key,extras);}
 return extras;
}
function supportExtrasHost(key){const host=$(key==='new'?'support-create-extras':'support-reply-extras');return host&&host.dataset?.supportExtras===key?host:null;}
function renderSupportExtras(key,host=supportExtrasHost(key)){if(host)host.innerHTML=supportExtrasBody(key);}
function supportFileSize(bytes){return bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':bytes>=1024?Math.round(bytes/1024)+' KB':bytes+' bytes';}
function supportLinkText(link){return link.kind==='patient'?'Patient · '+supportLabel(link.label):supportLabel(link.label);}
function supportAddLink(extras,link,auto=false){
 if(!link||!['patient','visit','claim'].includes(link.kind)||!supportUuid(link.id)||extras.links.some(item=>item.kind===link.kind&&item.id===link.id))return;
 if(extras.links.length>=supportLinkLimit){extras.problem='Up to 10 patients, visits or claims per message.';return;}
 extras.links.push({kind:link.kind,id:link.id,label:link.label,auto});
}
// What is on screen right now: the open chart, the visit being worked on, and any open claim.
function supportCurrentContext(){
 const links=[],add=link=>{if(supportUuid(link.id)&&!links.some(item=>item.kind===link.kind&&item.id===link.id))links.push(link);};
 const chart=typeof selected!=='undefined'&&selected&&typeof workspace!=='undefined'&&workspace?.patient&&$('clinical-workspace')?.hidden===false;
 if(chart){
  const p=workspace.patient;add({kind:'patient',id:selected,label:`${p.family_name}, ${p.given_name} · MRN ${p.mrn}`});
  if(typeof chartSection!=='undefined'&&chartSection==='visits'&&typeof activeVisit!=='undefined'&&activeVisit)add({kind:'visit',id:activeVisit.id,label:'Visit '+(typeof encounterDateLabel==='function'?encounterDateLabel(activeVisit):'')});
 }
 const claim=document.querySelector?.('[data-support-claim]');
 if(claim&&!claim.closest?.('[hidden]')){
  if(!chart&&claim.dataset.supportPatient)add({kind:'patient',id:claim.dataset.supportPatient,label:claim.dataset.supportPatientLabel||'Patient on this claim'});
  add({kind:'claim',id:claim.dataset.supportClaim,label:'Claim '+(claim.dataset.supportClaimLabel||'')});
 }
 return links;
}
// A new request takes what is open with it. Chips the person added by hand always stay.
async function openSupportFromHere(){
 const context=supportCurrentContext();
 if(context.length){
  const extras=supportExtrasFor('new');extras.links=extras.links.filter(link=>!link.auto);extras.problem='';
  for(const link of context)supportAddLink(extras,link,true);
 }
 await showSupportTickets();
 const form=$('support-create-form');form?.scrollIntoView?.({block:'center'});form?.elements?.subject?.focus?.();
}
// A reply belongs to an existing conversation, so what is open is offered, not attached.
function supportSuggestContext(ticket){const context=supportCurrentContext();if(context.length)supportExtrasFor(ticket).suggested=context;}
function supportHelpAvailable(){return typeof me!=='undefined'&&me&&supportRole()&&connectionStatusSnapshot?.services?.support_available!==false;}
function supportHelpButton(subject,attributes=''){return supportHelpAvailable()?`<button type="button" class="quiet support-help" data-support-help ${attributes}>Get help with this ${subject}</button>`:'';}
function supportPickerResults(picker){
 const q=picker.query.trim().toLowerCase();
 if(q.length<2)return '<p class="muted">Type at least 2 letters of the name or record number.</p>';
 const found=picker.patients.filter(p=>`${p.given_name} ${p.family_name}, ${p.given_name} ${p.mrn}`.toLowerCase().includes(q)).slice(0,8);
 return found.map(p=>`<button type="button" class="support-picker-row" data-support-pick-patient="${esc(p.id)}">${esc(p.family_name)}, ${esc(p.given_name)}<small>MRN ${esc(p.mrn)} · Born ${esc(p.birth_date)}</small></button>`).join('')||`<p class="muted">No patient matches yet.${picker.cursor?' Load more patients to keep looking.':''}</p>`;
}
function supportPickerMarkup(extras){
 const picker=extras.picker,attached=(kind,id)=>extras.links.some(link=>link.kind===kind&&link.id===id);
 if(picker.patient){
  const row=(kind,item)=>`<div class="support-picker-row"><span>${esc(item.label)}${item.detail?`<small>${esc(item.detail)}</small>`:''}</span>${attached(kind,item.id)?'<span class="muted">Attached</span>':`<button type="button" data-support-pick="${kind}:${esc(item.id)}">Attach ${kind}</button>`}</div>`;
  return `<div class="support-picker"><b>${esc(picker.patient.label)}</b><p class="muted">This patient is attached. Add one of their visits or claims if it helps.</p><div class="support-picker-list">${picker.visits.map(item=>row('visit',item)).join('')}${picker.claims.map(item=>row('claim',item)).join('')||(picker.visits.length?'':'<p class="muted">No visits or claims to add for this patient.</p>')}</div><div class="actions"><button type="button" data-support-picker-back>Find another patient</button><button type="button" data-support-picker-close>Done</button></div></div>`;
 }
 return `<div class="support-picker"><label>Find a patient<input type="search" data-support-search placeholder="Name or record number" autocomplete="off" value="${esc(picker.query)}"></label><div class="support-picker-list" data-support-results>${supportPickerResults(picker)}</div><div class="actions">${picker.cursor?'<button type="button" data-support-picker-more>Load more patients</button>':''}<button type="button" data-support-picker-close>Close</button></div></div>`;
}
function supportExtrasBody(key){
 const extras=supportExtrasFor(key);
 const chips=extras.links.map((link,i)=>`<span class="pill support-chip">${esc(supportLinkText(link))}<button type="button" class="support-chip-remove" data-support-link-remove="${i}" aria-label="Remove ${esc(supportLinkText(link))}">×</button></span>`).join('');
 const suggested=extras.suggested.map((link,i)=>extras.links.some(item=>item.kind===link.kind&&item.id===link.id)?'':`<button type="button" class="pill support-chip support-chip-suggested" data-support-link-suggested="${i}">Attach ${esc(supportLinkText(link))}</button>`).join('');
 const tiles=extras.files.map((file,i)=>`<span class="support-file${file.failed?' support-file-failed':''}">${file.preview?`<img src="${esc(file.preview)}" alt="">`:''}<span class="support-file-name">${esc(file.name)}<small>${esc(supportFileSize(file.size))}${file.failed?' · Not sent yet':''}</small></span><button type="button" class="support-chip-remove" data-support-file-remove="${i}" aria-label="Remove ${esc(file.name)}">×</button></span>`).join('');
 return `<div class="support-about"><b>About</b>${chips||(suggested?'':'<span class="muted">No patient, visit or claim attached</span>')}${suggested}<button type="button" class="text-button" data-support-link-add aria-expanded="${Boolean(extras.picker)}">Add patient, visit or claim</button></div>${extras.links.length?'<small class="muted">Support sees the record number, visit date or claim number, not the patient’s name.</small>':''}${extras.picker?supportPickerMarkup(extras):''}<div class="support-files">${tiles}<button type="button" data-support-file-add>Add files</button><input type="file" data-support-file-input multiple hidden accept="${Object.keys(supportFileTypes).join(',')}"></div><small class="muted">Drop files here or paste a screenshot - up to 5 images or documents, 10 MB each.</small>${extras.unavailable?'<div class="notice error" role="alert" data-support-unavailable><span>Support cannot receive attached patients, visits, claims or files yet. Your message has not been sent.</span><button type="button" data-support-send-plain>Send without attachments</button></div>':''}${extras.problem?`<p class="notice error" role="alert" data-support-problem>${esc(extras.problem)}</p>`:''}`;
}
function supportExtrasMarkup(key){return `<div class="support-extras" id="${key==='new'?'support-create-extras':'support-reply-extras'}" data-support-extras="${esc(key)}">${supportExtrasBody(key)}</div>`;}
function supportFileName(file,type,pasted,extras){
 let name=String(file.name||'').trim();
 if(pasted&&(!name||/^image\.[a-z]+$/i.test(name)))name=`Pasted image ${++extras.pasted}.${supportFileTypes[type]}`;
 if(!name)name='File.'+supportFileTypes[type];
 const chars=Array.from(name);if(chars.length<=200)return name;
 const dot=name.lastIndexOf('.'),extension=dot>0?Array.from(name.slice(dot)).slice(0,20):[];
 return chars.slice(0,200-extension.length).join('')+extension.join('');
}
// A small picture for the tile. The full image stays in memory until it is sent.
async function supportFilePreview(file){
 if(typeof createImageBitmap!=='function'||!document.createElement)return '';
 const bitmap=await createImageBitmap(file),scale=Math.min(1,96/Math.max(bitmap.width,bitmap.height,1)),canvas=document.createElement('canvas');
 canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
 canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();
 return canvas.toDataURL('image/png');
}
function supportAddFiles(key,list,pasted=false){
 const extras=supportExtrasFor(key);extras.problem='';
 for(const file of Array.from(list||[])){
  if(!file)continue;
  const extension=String(file.name||'').toLowerCase().split('.').pop(),type=supportFileTypes[file.type]?file.type:supportFileExtensions[extension];
  if(extras.files.length>=supportFileLimit){extras.problem='Up to 5 files per message.';break;}
  if(!type){extras.problem='That type of file can\'t be attached. Use an image, PDF, text or CSV file.';continue;}
  if(file.size>supportFileMaxBytes){extras.problem='That file is larger than 10 MB.';continue;}
  if(!file.size){extras.problem='That file is empty.';continue;}
  const item={request_id:crypto.randomUUID(),file,type,size:file.size,name:supportFileName(file,type,pasted,extras),uploaded:null,failed:false,preview:''};
  extras.files.push(item);
  if(type.startsWith('image/'))supportFilePreview(file).then(preview=>{if(preview&&supportExtras.get(key)===extras&&extras.files.includes(item)){item.preview=preview;renderSupportExtras(key);}},()=>{});
 }
 renderSupportExtras(key);
}
async function supportUploadFile(item){
 const identity=me,headers={'Content-Type':item.type,'X-Filename':encodeURIComponent(item.name)};
 if(me?.tenant_id&&me?.user_id)headers['X-SunCharts-Staff-Context']=`${me.tenant_id}:${me.user_id}`;
 let response;
 try{response=await fetch(`${connectServicesApi}/support-files?request_id=${encodeURIComponent(item.request_id)}`,{method:'POST',headers,body:item.file,credentials:'same-origin',cache:'no-store'});}
 catch{throw new Error(`${item.name} could not be uploaded. Your message is still here - check the connection and send again.`);}
 const data=await response.json().catch(()=>({}));
 if(me!==identity)throw new Error('Staff account changed. Sign in again to continue.');
 if(response.status===401){if(typeof signInScreen==='function')signInScreen();throw new Error('Please sign in to continue.');}
 if(!response.ok||!supportUuid(data.id)){const error=new Error(response.status===413?'That file is larger than 10 MB.':data.message||`${item.name} could not be uploaded. Your message is still here.`);error.status=response.status;error.code=data.error;throw error;}
 return data;
}
function supportNewRequest(form,key){const next=crypto.randomUUID();form.dataset.request=next;const retained=supportDrafts.get(key);if(retained)retained.request_id=next;return next;}
async function sendSupportForm(f){
 const d=Object.fromEntries(new FormData(f)),identity=me,navigation=supportNavigationGeneration,key=supportDraftKey(f),extras=supportExtrasFor(key),create=f.id==='support-create-form';
 if(f.dataset.closed==='true')throw new Error('This request is closed. Your unsent reply remains available for copying.');
 const body={request_id:f.dataset.request,message:d.message};if(create)body.subject=d.subject;
 extras.problem='';let result;
 try{
  if(!extras.plain){
   // Each file keeps its own request ID, so sending again never stores it twice.
   for(const item of extras.files){if(item.uploaded)continue;try{item.uploaded=await supportUploadFile(item);item.failed=false;}catch(error){item.failed=true;throw error;}}
   if(extras.links.length)body.links=extras.links.map(({kind,id})=>({kind,id}));
   if(extras.files.length)body.attachments=extras.files.map(item=>item.uploaded.id);
  }
  // Sending the same message again repeats one request; a changed message is a new one.
  const signature=JSON.stringify([body.subject||'',body.message,body.links||[],body.attachments||[]]);
  if(extras.attempt&&extras.attempt.request_id===body.request_id&&extras.attempt.signature!==signature)body.request_id=supportNewRequest(f,key);
  extras.attempt={request_id:body.request_id,signature};
  result=await api(create?`${connectServicesApi}/tickets`:`${connectServicesApi}/tickets/${f.dataset.ticket}/replies`,'POST',body);
 }catch(error){
  if(me!==identity)throw error;
  if(error.code==='support_attachments_unavailable'){extras.unavailable=true;renderSupportExtras(key);notice('Your message has not been sent yet. Choose Send without attachments to send it.',true);return;}
  renderSupportExtras(key);throw error;
 }
 if(me!==identity)return;
 if(supportExtras.get(key)===extras)supportExtras.delete(key);
 supportSubmissionSaved(f,d);
 if(navigation===supportNavigationGeneration&&f.isConnected!==false)await showSupportTicket(create?(result.ticket||result).id:f.dataset.ticket);
 notice(create?'Support request recorded.':'Reply recorded.');
}
function supportOpenLink(kind,id){
 if(!supportUuid(id))return;
 // The address opens the record the same way a bookmark does.
 if(kind==='patient')location.hash='#/patients/'+id+'/overview';
 else if(kind==='claim')location.hash='#/claims/'+id;
 else if(kind==='visit')api('/api/v1/visits/'+id).then(visit=>{if(supportUuid(visit.patient_id))location.hash='#/patients/'+visit.patient_id+'/encounter/'+id;else notice('This visit could not be opened.',true);},()=>notice('This visit could not be opened.',true));
}
function supportMessageExtras(message){
 const links=(Array.isArray(message.links)?message.links:[]).filter(link=>link&&['patient','visit','claim'].includes(link.kind)&&supportUuid(link.id)).slice(0,supportLinkLimit);
 const files=(Array.isArray(message.attachments)?message.attachments:[]).filter(file=>file&&supportUuid(file.id)).slice(0,supportFileLimit);
 if(!links.length&&!files.length)return '';
 const file=item=>{const url=`${connectServicesApi}/support-files/${item.id}`,name=supportLabel(item.filename)||'Attached file',size=Number.isFinite(item.size)?supportFileSize(item.size):'';
  return String(item.content_type).startsWith('image/')?`<a class="support-file support-file-image" href="${url}" target="_blank" rel="noopener noreferrer" title="Open ${esc(name)} full size"><img src="${url}" alt="${esc(name)}" loading="lazy"><span class="support-file-name">${esc(name)}<small>${esc(size)}</small></span></a>`:`<a class="support-file" href="${url}" download="${esc(name)}"><span class="support-file-name">${esc(name)}<small>${esc(size)}${size?' · ':''}Download</small></span></a>`;};
 return `<div class="support-message-extras">${links.length?`<div class="support-about">${links.map(link=>`<button type="button" class="pill support-chip" data-support-link-open="${link.kind}:${esc(link.id)}" title="Open this ${link.kind}">${esc(supportLinkText(link))}</button>`).join('')}</div>`:''}${files.length?`<div class="support-files">${files.map(file).join('')}</div>`:''}</div>`;
}
function supportExtrasClick(event,b){
 const handled=()=>{event.preventDefault();event.stopImmediatePropagation();return true;};
 if(b.dataset.supportLinkOpen){const [kind,id]=b.dataset.supportLinkOpen.split(':');supportOpenLink(kind,id);return handled();}
 if(b.hasAttribute('data-support-help')){run(()=>openSupportFromHere());return handled();}
 const host=b.closest('[data-support-extras]');
 if(!host||!['data-support-link-remove','data-support-link-suggested','data-support-link-add','data-support-picker-more','data-support-pick-patient','data-support-pick','data-support-picker-back','data-support-picker-close','data-support-file-add','data-support-file-remove','data-support-send-plain'].some(name=>b.hasAttribute(name)))return false;
 const key=host.dataset.supportExtras,extras=supportExtrasFor(key),picker=extras.picker,render=()=>renderSupportExtras(key,host.isConnected===false?undefined:host);
 if(b.hasAttribute('data-support-file-add')){host.querySelector('[data-support-file-input]')?.click();return handled();}
 extras.problem='';
 if(b.hasAttribute('data-support-send-plain')){
  const form=b.closest('form');if(!form||form.reportValidity&&!form.reportValidity())return handled();
  // Nothing was stored for the refused message, so the plain one goes out as a new request.
  run(async()=>{extras.plain=true;extras.attempt=null;supportNewRequest(form,key);try{await sendSupportForm(form);}finally{extras.plain=false;}});return handled();
 }
 if(b.hasAttribute('data-support-link-remove'))extras.links.splice(Number(b.dataset.supportLinkRemove),1);
 else if(b.hasAttribute('data-support-file-remove'))extras.files.splice(Number(b.dataset.supportFileRemove),1);
 else if(b.hasAttribute('data-support-link-suggested'))supportAddLink(extras,extras.suggested[Number(b.dataset.supportLinkSuggested)]);
 else if(b.hasAttribute('data-support-picker-close'))extras.picker=null;
 else if(b.hasAttribute('data-support-picker-back')&&picker)picker.patient=null;
 else if(b.hasAttribute('data-support-link-add')){
  if(picker)extras.picker=null;
  else{const next=extras.picker={query:'',patients:[],cursor:null,patient:null,visits:[],claims:[]};run(async()=>{const page=await api('/api/v1/patients');next.patients=page.items||[];next.cursor=page.next_cursor||null;render();});}
 }else if(b.hasAttribute('data-support-picker-more')&&picker?.cursor){
  run(async()=>{const page=await api('/api/v1/patients?after='+encodeURIComponent(picker.cursor));picker.patients.push(...(page.items||[]));picker.cursor=page.next_cursor||null;render();});
 }else if(b.dataset.supportPickPatient&&picker){
  const p=picker.patients.find(item=>item.id===b.dataset.supportPickPatient);
  if(p){
   const label=`${p.family_name}, ${p.given_name} · MRN ${p.mrn}`;supportAddLink(extras,{kind:'patient',id:p.id,label});
   picker.patient={id:p.id,label};picker.visits=[];picker.claims=[];
   // Either list may be outside this person's access; the patient is attached regardless.
   run(async()=>{const [chart,claims]=await Promise.all([api(`/api/v1/patients/${p.id}/workspace`).catch(()=>null),api(`/api/v1/billing/claims?patient_id=${p.id}`).catch(()=>null)]);
    if(extras.picker!==picker||picker.patient?.id!==p.id)return;
    picker.visits=(chart?.visits||[]).map(visit=>{const when=(chart.appointments||[]).find(a=>a.id===visit.appointment_id)?.starts_at||visit.signed_at;return {id:visit.id,label:'Visit '+(when?date(when):'date not recorded'),detail:visit.status==='signed'?'Signed':'In progress'};}).slice(0,20);
    picker.claims=(claims?.items||[]).map(claim=>({id:claim.id,label:'Claim '+claim.control_number,detail:scheduleLabel(claim.status)})).slice(0,20);render();});
  }
 }else if(b.dataset.supportPick&&picker?.patient){
  const [kind,id]=b.dataset.supportPick.split(':'),item=(kind==='visit'?picker.visits:kind==='claim'?picker.claims:[]).find(row=>row.id===id);
  if(item)supportAddLink(extras,{kind,id,label:item.label});
 }
 render();return handled();
}
document.addEventListener('input',event=>{
 const input=event.target;if(!input?.hasAttribute?.('data-support-search'))return;
 const host=input.closest('[data-support-extras]'),picker=host&&supportExtras.get(host.dataset.supportExtras)?.picker;if(!picker)return;
 picker.query=String(input.value||'');const results=host.querySelector('[data-support-results]');if(results)results.innerHTML=supportPickerResults(picker);
},true);
document.addEventListener('change',event=>{
 const input=event.target;if(!input?.hasAttribute?.('data-support-file-input'))return;
 const host=input.closest('[data-support-extras]');if(!host)return;
 const files=Array.from(input.files||[]);input.value='';supportAddFiles(host.dataset.supportExtras,files);
},true);
const supportOpenForm=target=>{const form=target?.closest?.('#support-create-form,#support-reply-form');return form&&form.dataset.closed!=='true'&&form.querySelector?.('[data-support-extras]')?form:null;};
document.addEventListener('paste',event=>{
 const form=supportOpenForm(event.target),clipboard=event.clipboardData;if(!form||!clipboard)return;
 // Copied text that also carries a picture (a spreadsheet cell, for example) pastes as text.
 if(String(clipboard.getData?.('text/plain')||'').trim())return;
 let files=Array.from(clipboard.files||[]);if(!files.length)files=Array.from(clipboard.items||[]).filter(item=>item.kind==='file').map(item=>item.getAsFile());
 files=files.filter(file=>file&&String(file.type).startsWith('image/'));if(!files.length)return;
 event.preventDefault();supportAddFiles(supportDraftKey(form),files,true);
},true);
const supportDragHasFiles=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
document.addEventListener('dragover',event=>{const form=supportOpenForm(event.target);if(!form||!supportDragHasFiles(event))return;event.preventDefault();form.classList?.add('support-drop');},true);
document.addEventListener('dragleave',event=>{const form=event.target?.closest?.('.support-drop');if(form&&!form.contains?.(event.relatedTarget))form.classList.remove('support-drop');},true);
document.addEventListener('drop',event=>{
 const form=supportOpenForm(event.target);if(!form||!supportDragHasFiles(event))return;
 event.preventDefault();form.classList?.remove('support-drop');supportAddFiles(supportDraftKey(form),event.dataTransfer.files);
},true);
function supportLabel(value){return typeof value==='string'?value.trim().slice(0,200):'';}
function supportProviderLabel(ticket){const provider=ticket?.support_provider;return provider&&typeof provider==='object'?'Assigned partner: '+(supportLabel(provider.display_name)||'Partner support'):'SunCharts support';}
function supportRoutingSummary(data){
 const ticket=data.ticket||data,shared=data.shared_support===true||ticket.shared_support===true,provider=ticket.support_provider||data.support_provider;
 if(!shared)return 'Follow your support requests and replies here.';
 if(provider)return `Sent to ${supportLabel(provider.display_name)||'your assigned partner'}. Your practice, this partner and SunCharts staff work in the same conversation.`;
 return 'SunCharts staff handle these requests. Your practice can reply and follow updates here.';
}
function supportMessageRole(message){
 if(['installation','partner','platform'].includes(message.actor_kind))return message.actor_kind;
 // Legacy replies identify support staff, but provider metadata alone is never an author identity.
 if(!message.actor_kind&&message.author==='support')return 'platform';
 if(!message.actor_kind&&message.author==='installation')return 'installation';
 return 'unknown';
}
function supportMessageAuthor(message){
 const role=supportMessageRole(message);
 if(role==='partner')return supportLabel(message.author_label)||supportLabel(message.support_provider?.display_name)||'Partner team';
 if(role==='platform')return supportLabel(message.author_label)||'SunCharts support';
 return role==='installation'?'Practice':'Support participant';
}
function supportMessageHeader(message){
 const role=supportMessageRole(message),badge={installation:'Practice',partner:'Partner',platform:'SunCharts',unknown:'Participant'}[role],name=supportMessageAuthor(message),partner=role==='partner'?supportLabel(message.support_provider?.display_name):'';
 return `<header class="support-message-header"><span class="support-role support-role-${role}">${badge}</span>${name!==badge?`<b>${esc(name)}</b>`:''}${partner&&partner!==name?`<span class="support-partner-name">${esc(partner)}</span>`:''}<time>${esc(date(message.created_at))}</time></header>`;
}
function supportTicketRows(data){return (data.items||[]).map(t=>`<tr><td>${esc(t.subject)}<small>${esc(supportProviderLabel(t))}</small></td><td>${esc(scheduleLabel(t.status))}</td><td>${esc(date(t.updated_at||t.created_at))}</td><td><button type="button" data-support-ticket="${esc(t.id)}">Open request</button></td></tr>`).join('')||'<tr><td colspan="4">No support requests for this installation.</td></tr>';}
function supportMessageRows(data){const t=data.ticket||data;return `${(data.messages_has_more||t.messages_has_more)?'<p class="notice">Showing the latest 200 messages. Earlier conversation history is retained in SunCharts.</p>':''}${(data.messages||t.messages||[]).map(m=>`<article class="billing-section" data-support-message="${esc(m.id||'')}">${supportMessageHeader(m)}<p class="support-message-body">${esc(m.message||m.body||'')}</p>${supportMessageExtras(m)}</article>`).join('')||'<p class="muted">No conversation messages returned.</p>'}`;}
function supportReplyForm(t){
 const draft=supportDrafts.get(t.id),closed=t.status==='closed';
 if(closed&&!draft?.message)return '<p>This request is closed. Start a new request if you need further help.</p>';
 return `<form id="support-reply-form" class="billing-section" data-ticket="${esc(t.id)}" data-request="${esc(draft?.request_id||crypto.randomUUID())}" data-closed="${closed}">${closed?'<p class="notice" data-support-draft-notice>This request closed while you were writing. Your unsent reply is retained below for copying.</p>':''}<label>${closed?'Unsent reply':'Reply'}<textarea name="message" required maxlength="4000" rows="4" ${closed?'readonly':''}>${esc(draft?.message||'')}</textarea></label>${closed?'':supportExtrasMarkup(t.id)}${closed?`<button type="button" data-support-discard-draft="${esc(t.id)}">Discard unsent reply</button>`:`<button type="submit">Send reply</button>`}</form>`;
}
async function showSupportTickets(){
 captureSupportDrafts();const generation=++supportRequestGeneration,navigation=supportNavigationGeneration,identity=me;
 const data=await api(`${connectServicesApi}/tickets`);
 if(me!==identity||generation!==supportRequestGeneration||navigation!==supportNavigationGeneration)return;
 const draft=supportDrafts.get('new');showTool('Support tickets');
 $('tools').innerHTML=`<section id="support-tickets-workspace"><div class="section-head"><div><h2>Practice support</h2><p class="muted" data-support-routing>${esc(supportRoutingSummary(data))}</p></div><button type="button" data-connect-services>Connect services</button></div><p class="mapping-notice">Keep patient names and passwords out of your message. Attach the patient, visit or claim instead, and add a screenshot or document if it helps.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Request</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody class="support-ticket-rows">${supportTicketRows(data)}</tbody></table></div><p data-support-list-limit ${data.has_more?'':'hidden'}>Showing the 100 most recently updated requests. Older requests remain in the SunCharts support queue.</p><form id="support-create-form" class="billing-section" data-request="${esc(draft?.request_id||crypto.randomUUID())}"><h3>New support request</h3><label>Subject<input name="subject" value="${esc(draft?.subject||'')}" required maxlength="160" autocomplete="off"></label><label>Describe the issue<textarea name="message" required maxlength="4000" rows="5">${esc(draft?.message||'')}</textarea></label>${supportExtrasMarkup('new')}<button type="submit">Send support request</button></form></section>`;
 void refreshSupportViews({resource_id:''}).catch(()=>{});
}
async function showSupportTicket(id){
 captureSupportDrafts();const generation=++supportRequestGeneration,navigation=supportNavigationGeneration,identity=me;
 const data=await api(`${connectServicesApi}/tickets/${id}`),t=data.ticket||data;
 if(me!==identity||generation!==supportRequestGeneration||navigation!==supportNavigationGeneration)return;
 showTool('Support tickets');
 $('tools').innerHTML=`<section id="support-ticket-detail" data-ticket="${esc(id)}"><div class="section-head"><div><h2 data-support-subject>${esc(t.subject)}</h2><p data-support-status>${esc(scheduleLabel(t.status))}</p><p data-support-provider>${esc(supportProviderLabel(t))}</p><p class="muted" data-support-routing>${esc(supportRoutingSummary(data))}</p></div><button type="button" data-support-tickets>All requests</button></div><div class="support-messages">${supportMessageRows(data)}</div><div class="support-reply-area">${supportReplyForm(t)}</div></section>`;
 if(typeof refreshSupportViews==='function')void refreshSupportViews({resource_id:id}).catch(()=>{});
 if(typeof markConnectTicketRead==='function'&&document.visibilityState!=='hidden')void markConnectTicketRead(id,(data.messages||t.messages||[]).map(message=>message.id));
}
async function refreshSupportViews(change){
 const identity=me,navigation=supportNavigationGeneration,generation=++supportLiveGeneration;
 const detail=$('support-ticket-detail'),list=$('support-tickets-workspace');
 if(detail&&detail.dataset.ticket===change.resource_id){
  const id=detail.dataset.ticket,data=await api(`${connectServicesApi}/tickets/${id}`),t=data.ticket||data;
  if(me!==identity||navigation!==supportNavigationGeneration||generation!==supportLiveGeneration||$('support-ticket-detail')!==detail||!detail.isConnected)return;
  rememberSupportForm($('support-reply-form'));
  detail.querySelector('[data-support-subject]').textContent=t.subject;
  detail.querySelector('[data-support-status]').textContent=scheduleLabel(t.status);
  const providerLabel=detail.querySelector('[data-support-provider]');if(providerLabel)providerLabel.textContent=supportProviderLabel(t);
  const routing=detail.querySelector('[data-support-routing]');if(routing)routing.textContent=supportRoutingSummary(data);
  detail.querySelector('.support-messages').innerHTML=supportMessageRows(data);
  const form=$('support-reply-form'),area=detail.querySelector('.support-reply-area');
  if(t.status==='closed'){
   if(form&&String(form.elements.message.value).trim()){
    form.dataset.closed='true';form.elements.message.readOnly=true;
    form.querySelector('button[type=submit]')?.remove();
    form.querySelector('.review-ack')?.remove();form.querySelector('[data-support-extras]')?.remove();
    if(!form.querySelector('[data-support-draft-notice]'))form.insertAdjacentHTML('afterbegin',`<p class="notice" data-support-draft-notice>This request closed while you were writing. Your unsent reply is retained below for copying.</p><button type="button" data-support-discard-draft="${esc(id)}">Discard unsent reply</button>`);
    rememberSupportForm(form);
   }else area.innerHTML=supportReplyForm(t);
  }else if(!form||form.dataset.closed==='true')area.innerHTML=supportReplyForm(t);
  if(typeof markConnectTicketRead==='function'&&document.visibilityState!=='hidden')void markConnectTicketRead(id,(data.messages||t.messages||[]).map(message=>message.id));
 }else if(list){
  const data=await api(`${connectServicesApi}/tickets`);
  if(me!==identity||navigation!==supportNavigationGeneration||generation!==supportLiveGeneration||$('support-tickets-workspace')!==list||!list.isConnected)return;
  // Update routing and worklist only; the request draft keeps its DOM and request ID.
  const routing=list.querySelector('[data-support-routing]');if(routing)routing.textContent=supportRoutingSummary(data);
  list.querySelector('.support-ticket-rows').innerHTML=supportTicketRows(data);
  const limit=list.querySelector('[data-support-list-limit]');if(limit)limit.hidden=!data.has_more;
 }
}
function resetSupportInstallation(){
 captureSupportDrafts();
 // Files already uploaded went to the previous connection; they upload again with the next send.
 for(const extras of supportExtras.values()){extras.attempt=null;extras.unavailable=false;for(const item of extras.files){item.uploaded=null;item.request_id=crypto.randomUUID();}}const root=$('support-ticket-detail')||$('support-tickets-workspace');if(!root)return;
 const draft=$('support-reply-form')||$('support-create-form'),value=draft?String(supportFormValues(draft).message||''):'';
 root.innerHTML=`<p class="notice">The SunCharts connection changed. Reopen support to load its current requests.</p>${value?`<div data-support-retained><label>Retained unsent support message<textarea rows="4" readonly>${esc(value)}</textarea></label><button type="button" data-support-discard-draft="${esc(draft?supportDraftKey(draft):'new')}">Discard unsent message</button></div>`:''}<button type="button" data-support-tickets>Open support requests</button>`;
}
document.addEventListener('input',event=>{const form=event.target.closest?.('#support-create-form,#support-reply-form');if(form)rememberSupportForm(form);});
document.addEventListener('change',event=>{const form=event.target.closest?.('#support-create-form,#support-reply-form');if(form)rememberSupportForm(form);});
document.addEventListener('submit',e=>{
 const f=e.target;if(!['support-create-form','support-reply-form'].includes(f.id))return;
 e.preventDefault();e.stopImmediatePropagation();run(()=>sendSupportForm(f));
},true);
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||supportExtrasClick(e,b))return;
 if(!['data-connect-overview','data-connect-refresh','data-connect-services','data-connect-apps','data-connect-test','data-connect-activate','data-connect-disconnect','data-support-tickets','data-support-ticket','data-support-discard-draft'].some(a=>b.hasAttribute(a)))return;
 e.preventDefault();e.stopImmediatePropagation();run(async()=>{
  if(b.hasAttribute('data-support-discard-draft')){supportDrafts.delete(b.dataset.supportDiscardDraft);supportExtras.delete(b.dataset.supportDiscardDraft);const form=b.closest('#support-reply-form');if(form)form.outerHTML='<p>This request is closed. Start a new request if you need further help.</p>';b.closest('[data-support-retained]')?.remove();return;}
  if(b.hasAttribute('data-connect-overview')){await showApps();return;}
  if(b.hasAttribute('data-connect-refresh')){await refreshConnectionBadge(true);await showApps();notice('Connection status checked against SunCharts.');return;}
  if(b.hasAttribute('data-connect-services')){await showConnectServices();return;}
  if(b.hasAttribute('data-connect-apps')){await showApps();return;}
  if(b.hasAttribute('data-support-tickets')){await showSupportTickets();return;}
  if(b.dataset.supportTicket){await showSupportTicket(b.dataset.supportTicket);return;}
  if(b.hasAttribute('data-connect-test')){const result=await api(`${connectServicesApi}/settings/test`,'POST',{},connectServicesSettings.version);await showConnectServices();notice(result.authenticated?'SunCharts service identity verified. Review availability, then enable services.':'Service connection could not be verified.',!result.authenticated);return;}
  if(b.hasAttribute('data-connect-disconnect')){await api(`${connectServicesApi}/settings`,'DELETE',{},connectServicesSettings.version);await showConnectServices();notice('Services disconnected locally. Revoke the installation in connect.suncharts.app to invalidate the token remotely.');return;}
  else await api(`${connectServicesApi}/settings/activation`,'POST',{enabled:b.dataset.connectActivate==='true'},connectServicesSettings.version);
  await showConnectServices();notice('Service connection updated.');
 });
},true);
