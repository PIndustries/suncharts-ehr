// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Reuse one authenticated stream per tab. Each consumer retains its own
// authorization, cursor validation and dirty-view safeguards.
let workspaceFeed=null,workspaceFeedIdentity=null,workspaceFeedCursor='',workspaceFeedOpen=false;
const workspaceFeedClients=new Set(),workspaceFeedCache=new Map();
const workspaceFeedChannels={status:new Set(['connection']),services:new Set(['ready','reset','notifications','service.change']),clinical:new Set(['clinical.change','workflow.change','ai.change','unavailable'])};
function stopWorkspaceFeed(){workspaceFeed?.close();workspaceFeed=null;workspaceFeedOpen=false;}
function connectWorkspaceFeed(){
 if(workspaceFeed||!workspaceFeedClients.size||!workspaceFeedIdentity||me!==workspaceFeedIdentity||document.visibilityState==='hidden')return;
 const source=new EventSource('/api/v1/browser/events'+(workspaceFeedCursor?'?after='+encodeURIComponent(workspaceFeedCursor):''));workspaceFeed=source;
 const current=()=>source===workspaceFeed&&me===workspaceFeedIdentity;
 source.onopen=()=>{if(!current()){source.close();return;}workspaceFeedOpen=true;for(const client of workspaceFeedClients)client.onopen?.();};
 source.onerror=()=>{if(!current()){source.close();return;}workspaceFeedOpen=false;for(const client of workspaceFeedClients)client.onerror?.();};
 for(const eventName of new Set(Object.values(workspaceFeedChannels).flatMap(set=>[...set])))source.addEventListener(eventName,event=>{
  if(!current())return;
  if(/^\d+:\d+$/.test(event.lastEventId||''))workspaceFeedCursor=event.lastEventId;
  if(['connection','ready','reset','notifications'].includes(eventName)){
   if(eventName==='reset'||eventName==='ready'){workspaceFeedCache.delete('ready');workspaceFeedCache.delete('reset');workspaceFeedCache.delete('notifications');}
   workspaceFeedCache.set(eventName,event);
  }
  for(const client of workspaceFeedClients)if(workspaceFeedChannels[client.channel].has(eventName))client.emit(eventName,event);
 });
}
function openWorkspaceEventSource(channel){
 if(!workspaceFeedChannels[channel]||!me)throw new Error('An authenticated workspace channel is required.');
 if(workspaceFeedIdentity!==me){for(const client of [...workspaceFeedClients])client.close();stopWorkspaceFeed();workspaceFeedCursor='';workspaceFeedCache.clear();workspaceFeedIdentity=me;}
 const handlers=new Map();let closed=false;
 const client={channel,onopen:null,onerror:null,get readyState(){return closed?2:workspaceFeedOpen?1:0;},
  addEventListener(name,callback){if(!workspaceFeedChannels[channel].has(name))return;const callbacks=handlers.get(name)||[];callbacks.push(callback);handlers.set(name,callbacks);const cached=workspaceFeedCache.get(name);if(cached)queueMicrotask(()=>{if(!closed&&me===workspaceFeedIdentity)callback(cached);});},
  emit(name,event){if(!closed)for(const callback of handlers.get(name)||[])callback(event);},
  close(){closed=true;handlers.clear();workspaceFeedClients.delete(client);if(!workspaceFeedClients.size){stopWorkspaceFeed();workspaceFeedIdentity=null;workspaceFeedCursor='';workspaceFeedCache.clear();}}
 };
 workspaceFeedClients.add(client);connectWorkspaceFeed();
 if(workspaceFeedOpen)queueMicrotask(()=>{if(!closed&&workspaceFeedClients.has(client)&&me===workspaceFeedIdentity)client.onopen?.();});
 return client;
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')stopWorkspaceFeed();else connectWorkspaceFeed();});
window.addEventListener('pagehide',stopWorkspaceFeed);
window.addEventListener('pageshow',connectWorkspaceFeed);
