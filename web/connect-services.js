// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const connectServicesApi='/api/v1/connect/services';
let connectionStatusSnapshot;
const connectionStates={connected:'Connected',authorized:'Access authorized',needs_attention:'Needs attention',reconnecting:'Reconnecting',offline:'Offline',not_connected:'Not connected'};
function connectStatusCard(data){
 if(!data)return '<section class="connection-summary" data-connect-summary><h3>Connection to my.suncharts.app</h3><p>Status unavailable. Refresh to check this installation.</p><button type="button" data-connect-refresh>Refresh connection status</button></section>';
 const service=data.services||{},state=connectionStates[data.status]||'Status unavailable',activeServices=service.enabled&&service.verified&&!service.revoked&&service.fresh&&service.availability==='available';
 return `<section class="connection-summary" data-connect-summary aria-label="SunCharts connection status"><div class="section-head"><div><h3>${esc(data.origin||'my.suncharts.app')}</h3><p><b>${esc(state)}</b></p></div><button type="button" data-connect-refresh>Refresh connection status</button></div><div class="form-grid"><div><b>Clinical access</b><small>${data.practice_authorized?'An active SunCharts authorization exists for this practice.':'No active SunCharts authorization for this practice.'}</small><small>${data.your_account_authorized?'Your account is authorized.':'Your account has not authorized SunCharts.'}</small></div><div><b>Managed services</b><small>${service.revoked?'Disconnected locally':!service.configured?'Not configured':!service.enabled?'Paused':service.availability==='available'&&service.fresh?'Connection verified':'Verification needed'}</small><small>${service.last_checked_at?'Last checked '+esc(date(service.last_checked_at)):'No live service check yet.'}</small>${service.last_verified_at?`<small>Last verified ${esc(date(service.last_verified_at))}</small>`:''}${service.configured?`<small>Managed email: ${activeServices&&service.reminders_available?'Available':'Unavailable'} · Support: ${activeServices&&service.support_available?'Available':'Unavailable'}</small>`:''}</div></div>${data.transport?.configured?`<p class="muted">Outbound connection · ${esc(connectionStates[data.transport.state]||data.transport.state)}${data.transport.last_seen_at?' · Last contact '+esc(date(data.transport.last_seen_at)):''}. Your EHR opens the connection; no inbound firewall port is required.</p>`:''}${data.origin&&data.origin!=='https://my.suncharts.app'?'<p class="notice">Local synthetic Connect service. This is not the production SunCharts connection.</p>':''}<p class="muted">Connect your practice to use SunCharts tools, managed appointment email and support. Review access and service availability here.</p><div class="actions">${me.role!=='read_only'?'<button type="button" data-connect-services>Managed email & support</button>':''}<a class="button" href="https://my.suncharts.app/clinic/native-ehr" target="_blank" rel="noopener noreferrer">Open SunCharts ↗</a></div></section>`;
}
let connectionEventSource, connectionEventIdentity, connectionStatusGeneration=0;
function applyConnectionStatus(data,identity){
 if(me!==identity)return null;
 connectionStatusSnapshot=data;
 for(const card of document.querySelectorAll?.('[data-connect-summary]')||[])card.outerHTML=connectStatusCard(data);
 const badge=$('shell-connect-status'),label=$('shell-connect-label');
 if(badge&&label){badge.setAttribute('data-state',data.status);const text='SunCharts: '+(connectionStates[data.status]||'Status unavailable');if(label.textContent!==text)label.textContent=text;badge.title='Connection to my.suncharts.app'+(data.transport?.configured?' · Outbound secure connection · '+(data.transport.last_seen_at?'Last contact '+date(data.transport.last_seen_at):'Waiting for connection'):(data.services?.last_verified_at?' · Last verified '+date(data.services.last_verified_at):' · Open connection details'));}
 return data;
}
function clearConnectionStatusSession(){
 connectionEventSource?.close();connectionEventSource=undefined;connectionEventIdentity=undefined;connectionStatusSnapshot=undefined;connectionStatusGeneration++;
}
function startConnectionStatusEvents(identity){
 if(typeof EventSource==='undefined'||me!==identity)return;
 if(connectionEventSource&&connectionEventIdentity===identity)return;
 clearConnectionStatusSession();connectionEventIdentity=identity;
 const source=new EventSource('/api/v1/connect/status/events');connectionEventSource=source;
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
 $('tools').innerHTML=`<section id="connect-services-workspace"><div class="section-head"><div><h2>SunCharts Connect</h2><p class="muted">Managed email and practice support</p></div><div class="actions">${supportRole()?'<button type="button" data-support-tickets>Support tickets</button>':''}<button type="button" data-connect-apps>Connected apps</button></div></div>${connectStatusCard(connection)}${connectServiceSummary(data)}${me.role==='owner'?`<section class="billing-section">${connectOnboardingCard(onboarding,connection)}${s?`<div class="billing-section"><h3>Connection status</h3>${s.revoked?'<p class="notice">Services are disconnected locally. Revoke this installation in my.suncharts.app to invalidate its service token there, too.</p>':''}<p>${s.enabled?'Enabled':'Disabled'} · ${s.verified?'Verified':'Not verified'}${s.last_test_result?` · ${esc(scheduleLabel(s.last_test_result))}`:''}</p><div class="actions"><button type="button" data-connect-test>Test service connection</button><button type="button" data-connect-activate="${!s.enabled}" ${!s.verified&&!s.enabled?'disabled':''}>${s.enabled?'Pause services':'Enable services'}</button><button type="button" data-connect-disconnect>Disconnect services locally</button></div></div>`:''}</section><section class="billing-section"><h3>Appointment email</h3><p>Use SunCharts managed email, or choose your practice’s own Resend account for a branded sender.</p><button type="button" data-reminder-settings>Reminder settings</button></section>`:'<p>An owner manages this practice’s service connection. You can access support when the service is enabled for this installation.</p>'}</section>`;
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
function clearSupportSession(){supportNavigationGeneration++;supportRequestGeneration++;supportLiveGeneration++;supportDrafts.clear();}
function supportHasDrafts(){rememberSupportForm($('support-create-form'));rememberSupportForm($('support-reply-form'));return supportDrafts.size>0;}
function supportProviderLabel(ticket){const provider=ticket?.support_provider;return provider&&typeof provider==='object'?(typeof provider.display_name==='string'&&provider.display_name.trim()?'Support provider: '+provider.display_name.trim().slice(0,200):'Assigned support provider'):'SunCharts support';}
function supportMessageAuthor(message){const provider=message.support_provider;if(message.actor_kind==='partner'||provider){const name=typeof message.author_label==='string'&&message.author_label.trim()?message.author_label.trim():typeof provider?.display_name==='string'&&provider.display_name.trim()?provider.display_name.trim():'Support provider';return name==='Support provider'?name:name.slice(0,200)+' · Support provider';}if(message.actor_kind==='platform'||message.author==='support')return typeof message.author_label==='string'&&message.author_label.trim()?message.author_label.trim().slice(0,200):'SunCharts support';return message.actor_kind==='installation'?'Practice':message.author_kind||message.author_role||'Practice';}
function supportTicketRows(data){return (data.items||[]).map(t=>`<tr><td>${esc(t.subject)}<small>${esc(supportProviderLabel(t))}</small></td><td>${esc(scheduleLabel(t.status))}</td><td>${esc(date(t.updated_at||t.created_at))}</td><td><button type="button" data-support-ticket="${esc(t.id)}">Open request</button></td></tr>`).join('')||'<tr><td colspan="4">No support requests for this installation.</td></tr>';}
function supportMessageRows(data){const t=data.ticket||data;return `${(data.messages_has_more||t.messages_has_more)?'<p class="notice">Showing the latest 200 messages. Earlier conversation history is retained in SunCharts.</p>':''}${(data.messages||t.messages||[]).map(m=>`<article class="billing-section" data-support-message="${esc(m.id||'')}"><b>${esc(supportMessageAuthor(m))}</b><small> · ${esc(date(m.created_at))}</small><p class="support-message-body">${esc(m.message||m.body||'')}</p></article>`).join('')||'<p class="muted">No conversation messages returned.</p>'}`;}
function supportReplyForm(t){
 const draft=supportDrafts.get(t.id),closed=t.status==='closed';
 if(closed&&!draft?.message)return '<p>This request is closed. Start a new request if you need further help.</p>';
 return `<form id="support-reply-form" class="billing-section" data-ticket="${esc(t.id)}" data-request="${esc(draft?.request_id||crypto.randomUUID())}" data-closed="${closed}">${closed?'<p class="notice" data-support-draft-notice>This request closed while you were writing. Your unsent reply is retained below for copying.</p>':''}<label>${closed?'Unsent reply':'Reply'}<textarea name="message" required maxlength="4000" rows="4" ${closed?'readonly':''}>${esc(draft?.message||'')}</textarea></label>${closed?`<button type="button" data-support-discard-draft="${esc(t.id)}">Discard unsent reply</button>`:`<label class="review-ack"><input name="reviewed" type="checkbox" required ${draft?.reviewed==='on'?'checked':''}> I removed patient information and credentials.</label><button type="submit">Send reply</button>`}</form>`;
}
async function showSupportTickets(){
 captureSupportDrafts();const generation=++supportRequestGeneration,navigation=supportNavigationGeneration,identity=me;
 const data=await api(`${connectServicesApi}/tickets`);
 if(me!==identity||generation!==supportRequestGeneration||navigation!==supportNavigationGeneration)return;
 const draft=supportDrafts.get('new');showTool('Support tickets');
 $('tools').innerHTML=`<section id="support-tickets-workspace"><div class="section-head"><div><h2>Practice support</h2><p class="muted">SunCharts Connect support requests</p></div><button type="button" data-connect-services>Connect services</button></div><p class="mapping-notice">For installation, account and service issues. Keep patient names, chart details, credentials and other sensitive information out of support messages. No clinical records or attachments are added automatically.</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Request</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody class="support-ticket-rows">${supportTicketRows(data)}</tbody></table></div><p data-support-list-limit ${data.has_more?'':'hidden'}>Showing the 100 most recently updated requests. Older requests remain in the SunCharts support queue.</p><form id="support-create-form" class="billing-section" data-request="${esc(draft?.request_id||crypto.randomUUID())}"><h3>New support request</h3><label>Subject<input name="subject" value="${esc(draft?.subject||'')}" required maxlength="160" autocomplete="off"></label><label>Describe the issue<textarea name="message" required maxlength="4000" rows="5">${esc(draft?.message||'')}</textarea></label><label class="review-ack"><input name="reviewed" type="checkbox" required ${draft?.reviewed==='on'?'checked':''}> I reviewed this message and removed patient information and credentials.</label><button type="submit">Send support request</button></form></section>`;
 void refreshSupportViews({resource_id:''}).catch(()=>{});
}
async function showSupportTicket(id){
 captureSupportDrafts();const generation=++supportRequestGeneration,navigation=supportNavigationGeneration,identity=me;
 const data=await api(`${connectServicesApi}/tickets/${id}`),t=data.ticket||data;
 if(me!==identity||generation!==supportRequestGeneration||navigation!==supportNavigationGeneration)return;
 showTool('Support tickets');
 $('tools').innerHTML=`<section id="support-ticket-detail" data-ticket="${esc(id)}"><div class="section-head"><div><h2 data-support-subject>${esc(t.subject)}</h2><p data-support-status>${esc(scheduleLabel(t.status))}</p><p data-support-provider>${esc(supportProviderLabel(t))}</p></div><button type="button" data-support-tickets>All requests</button></div><div class="support-messages">${supportMessageRows(data)}</div><div class="support-reply-area">${supportReplyForm(t)}</div></section>`;
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
  detail.querySelector('.support-messages').innerHTML=supportMessageRows(data);
  const form=$('support-reply-form'),area=detail.querySelector('.support-reply-area');
  if(t.status==='closed'){
   if(form&&String(form.elements.message.value).trim()){
    form.dataset.closed='true';form.elements.message.readOnly=true;
    form.querySelector('button[type=submit]')?.remove();
    form.querySelector('.review-ack')?.remove();
    if(!form.querySelector('[data-support-draft-notice]'))form.insertAdjacentHTML('afterbegin',`<p class="notice" data-support-draft-notice>This request closed while you were writing. Your unsent reply is retained below for copying.</p><button type="button" data-support-discard-draft="${esc(id)}">Discard unsent reply</button>`);
    rememberSupportForm(form);
   }else area.innerHTML=supportReplyForm(t);
  }else if(!form||form.dataset.closed==='true')area.innerHTML=supportReplyForm(t);
  if(typeof markConnectTicketRead==='function'&&document.visibilityState!=='hidden')void markConnectTicketRead(id,(data.messages||t.messages||[]).map(message=>message.id));
 }else if(list){
  const data=await api(`${connectServicesApi}/tickets`);
  if(me!==identity||navigation!==supportNavigationGeneration||generation!==supportLiveGeneration||$('support-tickets-workspace')!==list||!list.isConnected)return;
  // Only the worklist changes: a new request being drafted keeps its DOM and request ID.
  list.querySelector('.support-ticket-rows').innerHTML=supportTicketRows(data);
  const limit=list.querySelector('[data-support-list-limit]');if(limit)limit.hidden=!data.has_more;
 }
}
function resetSupportInstallation(){
 captureSupportDrafts();const root=$('support-ticket-detail')||$('support-tickets-workspace');if(!root)return;
 const draft=$('support-reply-form')||$('support-create-form'),value=draft?String(supportFormValues(draft).message||''):'';
 root.innerHTML=`<p class="notice">The SunCharts connection changed. Reopen support to load its current requests.</p>${value?`<div data-support-retained><label>Retained unsent support message<textarea rows="4" readonly>${esc(value)}</textarea></label><button type="button" data-support-discard-draft="${esc(draft?supportDraftKey(draft):'new')}">Discard unsent message</button></div>`:''}<button type="button" data-support-tickets>Open support requests</button>`;
}
document.addEventListener('input',event=>{const form=event.target.closest?.('#support-create-form,#support-reply-form');if(form)rememberSupportForm(form);});
document.addEventListener('change',event=>{const form=event.target.closest?.('#support-create-form,#support-reply-form');if(form)rememberSupportForm(form);});
document.addEventListener('submit',e=>{
 const f=e.target;if(!['support-create-form','support-reply-form'].includes(f.id))return;
 e.preventDefault();e.stopImmediatePropagation();run(async()=>{
  const d=Object.fromEntries(new FormData(f)),identity=me,navigation=supportNavigationGeneration;
  if(f.dataset.closed==='true')throw new Error('This request is closed. Your unsent reply remains available for copying.');
  if(d.reviewed!=='on')throw new Error('Review the message before sending it.');
  const body={request_id:f.dataset.request,message:d.message};
  if(f.id==='support-create-form'){body.subject=d.subject;const result=await api(`${connectServicesApi}/tickets`,'POST',body);if(me!==identity)return;supportSubmissionSaved(f,d);if(navigation===supportNavigationGeneration&&f.isConnected!==false)await showSupportTicket((result.ticket||result).id);notice('Support request recorded.');}
  else{await api(`${connectServicesApi}/tickets/${f.dataset.ticket}/replies`,'POST',body);if(me!==identity)return;supportSubmissionSaved(f,d);if(navigation===supportNavigationGeneration&&f.isConnected!==false)await showSupportTicket(f.dataset.ticket);notice('Reply recorded.');}
 });
},true);
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||!['data-connect-overview','data-connect-refresh','data-connect-services','data-connect-apps','data-connect-test','data-connect-activate','data-connect-disconnect','data-support-tickets','data-support-ticket','data-support-discard-draft'].some(a=>b.hasAttribute(a)))return;
 e.preventDefault();e.stopImmediatePropagation();run(async()=>{
  if(b.hasAttribute('data-support-discard-draft')){supportDrafts.delete(b.dataset.supportDiscardDraft);const form=b.closest('#support-reply-form');if(form)form.outerHTML='<p>This request is closed. Start a new request if you need further help.</p>';b.closest('[data-support-retained]')?.remove();return;}
  if(b.hasAttribute('data-connect-overview')){await showApps();return;}
  if(b.hasAttribute('data-connect-refresh')){await refreshConnectionBadge(true);await showApps();notice('Connection status checked against SunCharts.');return;}
  if(b.hasAttribute('data-connect-services')){await showConnectServices();return;}
  if(b.hasAttribute('data-connect-apps')){await showApps();return;}
  if(b.hasAttribute('data-support-tickets')){await showSupportTickets();return;}
  if(b.dataset.supportTicket){await showSupportTicket(b.dataset.supportTicket);return;}
  if(b.hasAttribute('data-connect-test')){const result=await api(`${connectServicesApi}/settings/test`,'POST',{},connectServicesSettings.version);await showConnectServices();notice(result.authenticated?'SunCharts service identity verified. Review availability, then enable services.':'Service connection could not be verified.',!result.authenticated);return;}
  if(b.hasAttribute('data-connect-disconnect')){await api(`${connectServicesApi}/settings`,'DELETE',{},connectServicesSettings.version);await showConnectServices();notice('Services disconnected locally. Revoke the installation in my.suncharts.app to invalidate the token remotely.');return;}
  else await api(`${connectServicesApi}/settings/activation`,'POST',{enabled:b.dataset.connectActivate==='true'},connectServicesSettings.version);
  await showConnectServices();notice('Service connection updated.');
 });
},true);
