// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const resource='11111111-1111-4111-8111-111111111111';
function fixture(){
 const streams=[],emitted=[],calls=[],listeners={},timers=new Map();let timerId=0;
 const c={console,JSON,Map,Set,Object,Number,TypeError,me:{role:'owner',tenant_id:'synthetic-tenant'},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},document:{visibilityState:'visible',activeElement:null,addEventListener:(name,fn)=>{(listeners[name]??=[]).push(fn);},dispatchEvent:event=>emitted.push(event)},EventSource:class{constructor(url){this.url=url;this.handlers={};this.readyState=0;streams.push(this);}addEventListener(name,fn){this.handlers[name]=fn;}close(){this.closed=true;this.readyState=2;}emit(name,value){this.handlers[name]?.({data:JSON.stringify(value)});}},api:async path=>{calls.push(path);return {items:[],next_cursor:10};}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('web/sun-events.js','utf8'),c);
 const run=code=>vm.runInContext(code,c);
 async function flush(){const batch=Array.from(timers.values());timers.clear();for(const fn of batch)fn();await new Promise(resolve=>setImmediate(resolve));}
 return {c,streams,emitted,calls,listeners,timers,run,flush};
}
const change=(id,action='ai.draft.received')=>({id,action,resource_id:resource,content:'must not forward',created_at:'today'});
(async()=>{
 let f=fixture(),refreshes=[];f.c.refreshes=refreshes;f.c.dirty=false;f.c.active=true;
 f.run("registerSunRefreshHook('review',{topics:['ai'],active:()=>active,dirty:()=>dirty,refresh:async(changes,{isCurrent})=>{if(isCurrent())refreshes.push(changes)}})");
 await f.run('startSunEvents(me)');assert.equal(f.calls[0],'/api/v1/events?latest=true');assert.equal(f.streams[0].url,'/api/v1/events/stream?after=10');
 const source=f.streams[0];source.onopen();await f.flush();assert.equal(refreshes.length,1,'initial baseline reconciles safe active view');
 source.emit('ai.change',change(11));source.emit('ai.change',change(11));source.emit('workflow.change',change(12));source.emit('ai.change',change(90,'ai.draft.unrecognized'));source.emit('ai.change',{...change(91),resource_id:'bad'});
 await f.flush();const notices=f.emitted.filter(event=>event.type==='suncharts:change');assert.equal(notices.length,1,'duplicates, wrong event type and malformed notices rejected');assert.deepEqual(Object.keys(notices[0].detail).sort(),['action','id','resource_id','topic']);assert.equal(f.run('sunEventsCursor'),11);assert.equal(refreshes.length,2);
 f.c.dirty=true;source.emit('ai.change',change(12));source.emit('ai.change',change(13));await f.flush();assert.equal(refreshes.length,2,'dirty draft remains untouched');
 f.c.dirty=false;f.c.document.activeElement={closest:()=>({})};f.run('flushSunRefreshHooks()');await f.flush();assert.equal(refreshes.length,2,'focused form remains untouched');
 f.c.document.activeElement=null;f.run('flushSunRefreshHooks()');await f.flush();assert.equal(refreshes.length,3);assert.equal(refreshes.at(-1).length,1,'same-resource changes are coalesced');assert.equal(refreshes.at(-1)[0].id,13);
 f.c.document.visibilityState='hidden';source.emit('ai.change',change(14));await f.flush();assert.equal(refreshes.length,3);f.c.document.visibilityState='visible';for(const handler of f.listeners.visibilitychange)handler();await f.flush();assert.equal(refreshes.length,4);
 source.onerror();assert.equal(f.emitted.at(-1).detail.state,'reconnecting');source.onopen();source.emit('ai.change',change(14));await f.flush();assert.equal(f.emitted.filter(event=>event.type==='suncharts:change').length,4,'native reconnect replay is deduplicated');
 f.run('clearSunEventsSession()');assert.equal(source.closed,true);source.emit('ai.change',change(15));assert.equal(f.run('sunEventsCursor'),0);assert.equal(f.timers.size,0,'logout cancels queued callbacks');
 f.c.me={role:'patient'};await f.run('startSunEvents(me)');assert.equal(f.streams.length,1,'patients never subscribe');
 // A slow baseline cannot start a stream for the previous staff identity.
 f=fixture();let resolve;f.c.api=()=>new Promise(r=>resolve=r);const old=f.run('startSunEvents(me)');f.run('clearSunEventsSession()');f.c.me={role:'nurse'};resolve({items:[],next_cursor:80});await old;assert.equal(f.streams.length,0);
 // In-flight refreshes must be discarded if editing or account changes start.
 f=fixture();let context;f.c.capture=ctx=>{context=ctx;return new Promise(r=>resolve=r);};f.run("registerSunRefreshHook('workflow',{topics:['workflow'],active:()=>true,dirty:()=>false,refresh:async(changes,ctx)=>capture(ctx)})");await f.run('startSunEvents(me)');f.streams[0].onopen();await f.flush();assert.equal(context.isCurrent(),true);f.c.document.activeElement={closest:()=>({})};assert.equal(context.isCurrent(),false);resolve();await new Promise(r=>setImmediate(r));assert.equal(f.run("sunRefreshHooks.get('workflow').needsRefresh"),true,'deferred response remains refreshable');f.run('clearSunEventsSession()');assert.equal(context.isCurrent(),false);
 // Browsers lacking EventSource still process validated reference pages.
 f=fixture();f.c.EventSource=undefined;let count=0;f.c.api=async path=>{f.calls.push(path);return ++count===1?{items:[],next_cursor:10}:{items:[change(11)],next_cursor:11};};await f.run('startSunEvents(me)');await new Promise(r=>setImmediate(r));assert.equal(f.run('sunEventsCursor'),11);assert.equal(f.emitted.filter(event=>event.type==='suncharts:change').length,1);f.run('clearSunEventsSession()');assert.equal(f.timers.size,0);
 console.log('PASS Sun event UI: bounded reference notices, baseline/replay, dedup, reconnect, dirty/focused/hidden view protection, session isolation and polling fallback');
})().catch(error=>{console.error(error);process.exitCode=1;});
