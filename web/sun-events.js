// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Reference-only status notices. Views fetch authorized records separately and
// must check isCurrent() after awaiting data, before changing their DOM/state.
let sunEventsIdentity,sunEventsSource,sunEventsGeneration=0,sunEventsCursor=0,sunEventsReady=false,sunEventsTimer;
const sunRefreshHooks=new Map();
const sunEventStaff=identity=>identity&&['owner','clinician','nurse','medical_assistant','front_desk','read_only','partner_support'].includes(identity.role);
const sunEventUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const sunEventActions=new Set(['ai.draft.requested','ai.draft.received','ai.draft.failed','ai.draft.reviewed','practice.care_pathways.create','practice.care_pathways.update','practice.care_pathways.action','practice.care_pathways.trigger','practice.care_pathways.instance.action','practice.care_pathways.step.action','practice.workflow_dispatch.created','practice.workflow_dispatch.approved','practice.workflow_dispatch.rejected','practice.workflow_dispatch.confirmed','practice.workflow_dispatch.finished']);
function sunEventTopic(action){return action.startsWith('ai.draft.')?'ai':action.startsWith('practice.care_pathways.')||action.startsWith('practice.workflow_dispatch.')?'workflow':'clinical';}
function sunEventCurrent(identity,generation){return me===identity&&sunEventsIdentity===identity&&sunEventsGeneration===generation&&sunEventStaff(identity);}
function sunEventStatus(state){document.dispatchEvent(new CustomEvent('suncharts:live-status',{detail:{state}}));}
function clearSunEventsSession(){
 sunEventsGeneration++;sunEventsSource?.close();sunEventsSource=undefined;sunEventsIdentity=undefined;sunEventsReady=false;sunEventsCursor=0;clearTimeout(sunEventsTimer);sunEventsTimer=undefined;
 for(const hook of sunRefreshHooks.values()){clearTimeout(hook.timer);hook.timer=undefined;hook.pending.clear();hook.needsRefresh=false;hook.running=false;hook.revision++;}
}
function registerSunRefreshHook(name,{topics,active,dirty,refresh}){
 if(typeof name!=='string'||!Array.isArray(topics)||topics.some(topic=>!['ai','workflow'].includes(topic))||typeof active!=='function'||typeof dirty!=='function'||typeof refresh!=='function')throw new TypeError('A Sun refresh hook requires topics, active, dirty and refresh callbacks.');
 const previous=sunRefreshHooks.get(name);if(previous){clearTimeout(previous.timer);previous.revision++;}
 const hook={topics:new Set(topics),active,dirty,refresh,pending:new Map(),needsRefresh:sunEventsReady,running:false,revision:0,timer:undefined};sunRefreshHooks.set(name,hook);
 if(sunEventsReady)scheduleSunRefresh(hook);
 return ()=>{if(sunRefreshHooks.get(name)===hook){clearTimeout(hook.timer);hook.revision++;sunRefreshHooks.delete(name);}};
}
function sunHookEligible(hook){
 if(!sunEventsReady||!sunEventCurrent(sunEventsIdentity,sunEventsGeneration)||document.visibilityState==='hidden')return false;
 // Editing a focused form is never interrupted, even if a caller's dirty-state
 // detector has not observed the first keystroke yet.
 if(document.activeElement?.closest?.('form'))return false;
 try{return !!hook.active()&&!hook.dirty();}catch{return false;}
}
function scheduleSunRefresh(hook){
 if(hook.timer!==undefined||hook.running||!hook.needsRefresh)return;
 hook.timer=setTimeout(()=>{hook.timer=undefined;void runSunRefresh(hook);},500);
}
async function runSunRefresh(hook){
 if(hook.running||!hook.needsRefresh||!sunHookEligible(hook))return;
 const identity=sunEventsIdentity,generation=sunEventsGeneration,revision=hook.revision;
 const changes=Array.from(hook.pending.values());hook.pending.clear();hook.needsRefresh=false;hook.running=true;
 const isCurrent=()=>sunEventCurrent(identity,generation)&&hook.revision===revision&&sunHookEligible(hook);
 try{await hook.refresh(changes,{isCurrent});}
 catch{if(sunEventCurrent(identity,generation)&&hook.revision===revision){hook.needsRefresh=true;sunEventStatus('refresh-needed');}}
 finally{if(sunEventCurrent(identity,generation)&&hook.revision===revision){hook.running=false;if(!isCurrent())hook.needsRefresh=true;if(hook.needsRefresh&&hook.pending.size)scheduleSunRefresh(hook);}}
}
function flushSunRefreshHooks(){for(const hook of sunRefreshHooks.values())scheduleSunRefresh(hook);}
function reconcileSunViews(){for(const hook of sunRefreshHooks.values()){hook.needsRefresh=true;scheduleSunRefresh(hook);}}
function acceptSunEvent(value,expectedTopic){
 if(!value||!Number.isSafeInteger(value.id)||value.id<=sunEventsCursor||typeof value.action!=='string'||!sunEventUuid(value.resource_id))return;
 const topic=sunEventTopic(value.action);
 if(expectedTopic&&topic!==expectedTopic)return;
 if(topic!=='clinical'&&!sunEventActions.has(value.action))return;
 if(topic==='clinical'&&!/^(patient|appointment|visit|migration)\.[a-z0-9_.]+$/.test(value.action))return;
 sunEventsCursor=value.id;
 if(topic==='clinical')return;
 // Copy only the allowlisted reference fields; do not forward arbitrary server
 // properties, provider content, prompts, or clinical record data into events.
 const change=Object.freeze({id:value.id,action:value.action,resource_id:value.resource_id,topic});
 document.dispatchEvent(new CustomEvent('suncharts:change',{detail:change}));
 for(const hook of sunRefreshHooks.values())if(hook.topics.has(topic)){
  hook.pending.set(`${topic}:${change.resource_id}`,change);
  if(hook.pending.size>100)hook.pending.delete(hook.pending.keys().next().value);
  hook.needsRefresh=true;scheduleSunRefresh(hook);
 }
}
async function pollSunEvents(identity,generation){
 if(!sunEventCurrent(identity,generation))return;
 try{
  const page=await api(`/api/v1/events?after=${sunEventsCursor}`);
  if(!sunEventCurrent(identity,generation))return;
  if(!Array.isArray(page.items)||page.items.length>100||!Number.isSafeInteger(page.next_cursor)||page.next_cursor<sunEventsCursor)throw new Error('Invalid event page');
  for(const change of page.items)acceptSunEvent(change);
  // Advance only through independently validated notices, never an untrusted
  // claimed cursor that could silently skip unseen changes.
  sunEventStatus('connected');
 }catch{if(sunEventCurrent(identity,generation))sunEventStatus('reconnecting');}
 if(sunEventCurrent(identity,generation))sunEventsTimer=setTimeout(()=>void pollSunEvents(identity,generation),3000);
}
async function startSunEvents(identity){
 if(!sunEventStaff(identity)||me!==identity){clearSunEventsSession();return;}
 if(sunEventsIdentity===identity)return;
 clearSunEventsSession();sunEventsIdentity=identity;const generation=sunEventsGeneration;
 async function connect(){
  try{
   const baseline=await api('/api/v1/events?latest=true');
   if(!sunEventCurrent(identity,generation))return;
   if(!Number.isSafeInteger(baseline.next_cursor)||baseline.next_cursor<0)throw new Error('Invalid event cursor');
   sunEventsCursor=baseline.next_cursor;sunEventsReady=true;
   if(typeof EventSource==='undefined'){reconcileSunViews();void pollSunEvents(identity,generation);return;}
   const source=typeof openWorkspaceEventSource==='function'?openWorkspaceEventSource('clinical'):new EventSource(`/api/v1/events/stream?after=${sunEventsCursor}`);sunEventsSource=source;
   const current=()=>sunEventCurrent(identity,generation)&&sunEventsSource===source;
   for(const topic of ['clinical','workflow','ai'])source.addEventListener(`${topic}.change`,event=>{if(!current())return;try{acceptSunEvent(JSON.parse(event.data),topic);}catch{/* Ignore malformed notices. */}});
   source.onopen=()=>{if(!current()){source.close();return;}sunEventStatus('connected');reconcileSunViews();};
   // Native EventSource reconnects with Last-Event-ID; the server resumes after
   // the greater of that cursor and the initial query cursor. Dedup is local too.
   source.onerror=()=>{if(!current()){source.close();return;}sunEventStatus(source.readyState===2?'disconnected':'reconnecting');};
   source.addEventListener('unavailable',()=>{if(current())sunEventStatus('reconnecting');});
  }catch{if(sunEventCurrent(identity,generation)){sunEventStatus('reconnecting');sunEventsTimer=setTimeout(()=>void connect(),3000);}}
 }
 await connect();
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')flushSunRefreshHooks();});
document.addEventListener('focusout',()=>setTimeout(flushSunRefreshHooks,0));
document.addEventListener('input',flushSunRefreshHooks);
