// SPDX-License-Identifier: AGPL-3.0-only
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const instances=[],events={};
class Source{constructor(url){this.url=url;this.events={};instances.push(this);}close(){this.closed=true;}addEventListener(name,callback){this.events[name]=callback;}emit(name,data,id){this.events[name]?.({data:JSON.stringify(data),lastEventId:id});}}
const context=vm.createContext({EventSource:Source,me:{role:'owner'},document:{visibilityState:'visible',addEventListener:(name,fn)=>events[name]=fn},window:{addEventListener:(name,fn)=>events[name]=fn},queueMicrotask,console});
vm.runInContext(fs.readFileSync('web/live-events.js','utf8'),context);
const run=code=>vm.runInContext(code,context);
(async()=>{
 run("var status=openWorkspaceEventSource('status'),services=openWorkspaceEventSource('services'),clinical=openWorkspaceEventSource('clinical');var received=[];services.addEventListener('service.change',e=>received.push(e.data));clinical.addEventListener('service.change',()=>{throw Error('Wrong channel')});");
 assert.equal(instances.length,1,'three channels share a single socket');instances[0].onopen();assert.equal(run('clinical.readyState'),1);
 instances[0].emit('service.change',{id:4},'20:4');assert.equal(run('received.length'),1);
 context.document.visibilityState='hidden';events.visibilitychange();assert.ok(instances[0].closed);
 context.document.visibilityState='visible';events.visibilitychange();assert.equal(instances.length,2);assert.match(instances[1].url,/after=20%3A4/,'visible tab resumes both channel cursors');
 instances[0].emit('service.change',{id:99},'99:99');assert.equal(run('received.length'),1,'stale socket cannot deliver');
 instances[1].emit('reset',{cursor:8,notifications:{}},'20:8');instances[1].emit('ready',{cursor:9,notifications:{}},'20:9');
 run("var late=[];var newcomer=openWorkspaceEventSource('services');newcomer.addEventListener('ready',e=>late.push('ready'));newcomer.addEventListener('reset',e=>late.push('reset'));");await Promise.resolve();assert.equal(run('late.join()'),'ready','new binding supersedes cached reset');
 context.me={role:'clinician'};run("var fresh=openWorkspaceEventSource('status')");assert.ok(instances[1].closed);assert.equal(instances.length,3);assert.equal(instances[2].url,'/api/v1/browser/events','new identity never resumes old cursor');assert.equal(run('clinical.readyState'),2);
 instances[1].emit('service.change',{id:100},'100:100');assert.equal(run('received.length'),1,'old identity cannot publish');run('fresh.close()');assert.ok(instances[2].closed);assert.equal(run('workspaceFeedCache.size'),0);
 console.log('PASS one browser stream, visibility reconnect, event isolation, stale sockets, cursor and identity reset');
})().catch(error=>{console.error(error);process.exitCode=1;});
