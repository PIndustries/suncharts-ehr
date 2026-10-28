// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let connectUpdatesSource,connectUpdatesIdentity,connectUpdatesGeneration=0,connectNotificationsRevision=0;
let connectNotifications={items:[],unread_count:0,has_more:false},connectUpdatesReady=false,connectUpdatesCursor=0,connectNotificationsOpen=false;
const connectPendingRead=new Set();
const connectUpdateUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const connectUpdateStaff=identity=>identity&&['owner','clinician','front_desk'].includes(identity.role);
function validConnectNotifications(value){
 if(!value||!Array.isArray(value.items)||!Number.isSafeInteger(value.unread_count)||value.unread_count<0)return null;
 const items=value.items.slice(0,100).filter(item=>Number.isSafeInteger(item.id)&&item.id>0&&connectUpdateUuid(item.ticket_id)&&connectUpdateUuid(item.message_id)).map(item=>({id:item.id,ticket_id:item.ticket_id,message_id:item.message_id,created_at:item.created_at}));
 return {items,unread_count:value.unread_count,has_more:!!value.has_more};
}
function renderConnectNotifications(){
 const host=$('shell-service-notifications');if(!host)return;
 if(!connectUpdateStaff(me)){host.replaceChildren();return;}
 const count=connectNotifications.unread_count,expanded=connectNotificationsOpen,active=document.activeElement;
 let focusSelector;if(host.contains?.(active)){if(active?.dataset?.connectNotificationOpen)focusSelector=`[data-connect-notification-open="${active.dataset.connectNotificationOpen}"]`;else for(const name of ['data-connect-notifications-toggle','data-connect-notifications-close','data-connect-notifications-read'])if(active?.hasAttribute?.(name))focusSelector=`[${name}]`;}
 host.className='service-notifications';
 host.innerHTML=`<button type="button" class="service-notifications-button" data-connect-notifications-toggle aria-expanded="${expanded}" aria-controls="connect-notifications-panel" aria-label="Support notifications, ${count} unread"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span>Support</span>${count?`<span class="service-notification-count" aria-hidden="true">${count}</span>`:''}<span class="sr-only" aria-live="polite" aria-atomic="true">${count} unread support ${count===1?'reply':'replies'}</span></button><section id="connect-notifications-panel" class="service-notification-panel" role="region" aria-label="Support notifications" ${expanded?'':'hidden'}><div class="section-head"><h3>Support replies</h3><button type="button" data-connect-notifications-close aria-label="Close support notifications">Close</button></div><p data-service-live-status>${connectUpdatesReady?'Live updates connected.':'Connecting live updates…'}</p><ul class="service-notification-list">${connectNotifications.items.map(item=>`<li class="service-notification-item"><button type="button" data-connect-notification-open="${esc(item.ticket_id)}">New support reply<small>${esc(date(item.created_at))}</small></button></li>`).join('')||`<li>${connectUpdatesReady?'No unread support replies.':'Checking for support replies…'}</li>`}</ul>${connectNotifications.has_more?'<p>Additional unread replies are retained. Reading the listed replies will show the next set.</p>':''}${connectNotifications.items.length?'<button type="button" data-connect-notifications-read>Mark listed replies as read</button>':''}</section>`;
 if(focusSelector)(host.querySelector(focusSelector)||host.querySelector('[data-connect-notifications-toggle]'))?.focus();
}
function showConnectReplyToast(ticket){
 const host=$('service-notification-toast');if(!host||!connectUpdateUuid(ticket))return;
 host.hidden=false;host.className='service-notification-toast';
 host.innerHTML=`<p>New SunCharts support reply received.</p><div class="actions"><button type="button" data-connect-notification-open="${esc(ticket)}">Open reply</button><button type="button" data-connect-notification-dismiss>Dismiss</button></div>`;
}
function applyConnectNotifications(snapshot){
 const value=validConnectNotifications(snapshot);if(!value)return;
 connectNotifications=value;connectNotificationsRevision++;renderConnectNotifications();
 const detail=$('support-ticket-detail');
 if(detail&&document.visibilityState!=='hidden')void markConnectTicketRead(detail.dataset.ticket,Array.from(detail.querySelectorAll('[data-support-message]'),node=>node.dataset.supportMessage));
}
function clearConnectUpdatesSession(){
 connectUpdatesGeneration++;connectNotificationsRevision++;connectUpdatesSource?.close();connectUpdatesSource=undefined;connectUpdatesIdentity=undefined;connectUpdatesReady=false;connectUpdatesCursor=0;connectNotificationsOpen=false;connectNotifications={items:[],unread_count:0,has_more:false};connectPendingRead.clear();
 if(typeof clearReminderUpdatesSession==='function')clearReminderUpdatesSession();
 const host=$('shell-service-notifications');host?.replaceChildren();const toast=$('service-notification-toast');if(toast){toast.hidden=true;toast.replaceChildren();}
}
async function refreshConnectNotifications(){
 const identity=me,generation=connectUpdatesGeneration,revision=connectNotificationsRevision;
 const data=await api('/api/v1/connect/services/notifications');
 if(me!==identity||generation!==connectUpdatesGeneration||revision!==connectNotificationsRevision)return;
 applyConnectNotifications(data);
}
async function markConnectNotificationIds(ids){
 const event_ids=[...new Set(ids)].filter(id=>Number.isSafeInteger(id)&&id>0&&!connectPendingRead.has(id)).slice(0,100);if(!event_ids.length||!connectUpdateStaff(me))return;
 const identity=me,generation=connectUpdatesGeneration,revision=connectNotificationsRevision;
 event_ids.forEach(id=>connectPendingRead.add(id));
 try{
  const data=await api('/api/v1/connect/services/notifications/read','POST',{event_ids});
  if(me!==identity||generation!==connectUpdatesGeneration)return;
  if(revision===connectNotificationsRevision)applyConnectNotifications(data);
  else void refreshConnectNotifications().catch(()=>{});
 }finally{if(generation===connectUpdatesGeneration)event_ids.forEach(id=>connectPendingRead.delete(id));}
}
async function markConnectTicketRead(ticket,messageIds=[]){
 if(!connectUpdateUuid(ticket)||!connectUpdateStaff(me))return;
 const rendered=new Set(messageIds.filter(connectUpdateUuid));
 const ids=connectNotifications.items.filter(item=>item.ticket_id===ticket&&rendered.has(item.message_id)).map(item=>item.id);
 if(ids.length)try{await markConnectNotificationIds(ids);}catch{/* The unread state remains until the server confirms acknowledgment. */}
}
async function reconcileConnectServiceViews(change){
 if(typeof refreshSupportViews==='function'&&(!change||change.kind.startsWith('support.'))){
  const id=change?.resource_id||$('support-ticket-detail')?.dataset.ticket||'';
  await refreshSupportViews({resource_id:id});
 }
 if(typeof refreshReminderViews==='function'&&(!change||change.kind==='reminder.updated'))await refreshReminderViews(change||{});
}
function startConnectUpdates(identity){
 if(!connectUpdateStaff(identity)||me!==identity){clearConnectUpdatesSession();return;}
 if(connectUpdatesSource&&connectUpdatesIdentity===identity)return;
 clearConnectUpdatesSession();connectUpdatesIdentity=identity;const generation=connectUpdatesGeneration;
 renderConnectNotifications();
 if(typeof EventSource==='undefined'){void refreshConnectNotifications().catch(()=>{});return;}
 const source=new EventSource('/api/v1/connect/services/events');connectUpdatesSource=source;
 const current=()=>me===identity&&connectUpdatesIdentity===identity&&connectUpdatesSource===source&&connectUpdatesGeneration===generation;
 function baseline(event,reset=false){
  if(!current())return;
  let data;try{data=JSON.parse(event.data);}catch{return;}
  if(!Number.isSafeInteger(data.cursor)||data.cursor<0||!validConnectNotifications(data.notifications))return;
  if(!connectUpdatesReady||reset)connectUpdatesCursor=data.cursor;
  connectUpdatesReady=true;
  if(reset){if(typeof clearReminderUpdatesSession==='function')clearReminderUpdatesSession();if(typeof resetSupportInstallation==='function')resetSupportInstallation();const toast=$('service-notification-toast');if(toast){toast.hidden=true;toast.replaceChildren();}}
  applyConnectNotifications(data.notifications);
  void reconcileConnectServiceViews().catch(()=>{});
 }
 source.addEventListener('ready',event=>baseline(event));
 source.addEventListener('reset',event=>baseline(event,true));
 source.addEventListener('notifications',event=>{if(!current())return;try{applyConnectNotifications(JSON.parse(event.data));}catch{/* Ignore invalid snapshots. */}});
 source.addEventListener('service.change',event=>{
  if(!current()||!connectUpdatesReady)return;
  let change;try{change=JSON.parse(event.data);}catch{return;}
  if(!Number.isSafeInteger(change.id)||change.id<=connectUpdatesCursor||!['support.reply','support.updated','reminder.updated'].includes(change.kind)||!connectUpdateUuid(change.resource_id)||(change.kind==='support.reply'&&!connectUpdateUuid(change.message_id)))return;
  connectUpdatesCursor=change.id;
  if(change.kind==='support.reply')showConnectReplyToast(change.resource_id);
  void reconcileConnectServiceViews(change).catch(()=>{});
 });
 source.onerror=()=>{
  if(!current()){source.close();return;}
  const panel=$('connect-notifications-panel'),status=panel?.querySelector('[data-service-live-status]');if(status)status.textContent='Live updates reconnecting. Unread replies remain saved.';
 };
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button');if(!button)return;
 if(button.hasAttribute('data-connect-notifications-toggle')){event.preventDefault();connectNotificationsOpen=!connectNotificationsOpen;renderConnectNotifications();return;}
 if(button.hasAttribute('data-connect-notifications-close')){event.preventDefault();connectNotificationsOpen=false;renderConnectNotifications();$('shell-service-notifications')?.querySelector('[data-connect-notifications-toggle]')?.focus();return;}
 if(button.hasAttribute('data-connect-notification-dismiss')){event.preventDefault();const toast=$('service-notification-toast');if(toast)toast.hidden=true;return;}
 if(button.hasAttribute('data-connect-notifications-read')){event.preventDefault();run(()=>markConnectNotificationIds(connectNotifications.items.map(item=>item.id)));return;}
 if(button.dataset.connectNotificationOpen){
  event.preventDefault();const ticket=button.dataset.connectNotificationOpen;if(!connectUpdateUuid(ticket))return;
  connectNotificationsOpen=false;renderConnectNotifications();const toast=$('service-notification-toast');if(toast)toast.hidden=true;
  run(()=>showSupportTicket(ticket));
 }
},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&connectNotificationsOpen){connectNotificationsOpen=false;renderConnectNotifications();$('shell-service-notifications')?.querySelector('[data-connect-notifications-toggle]')?.focus();}});

document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')return;const detail=$('support-ticket-detail');if(detail)void markConnectTicketRead(detail.dataset.ticket,Array.from(detail.querySelectorAll('[data-support-message]'),node=>node.dataset.supportMessage));});
