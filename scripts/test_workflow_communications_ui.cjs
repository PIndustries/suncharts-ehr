// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/workflow-communications.js','utf8');
const integration='10000000-0000-4000-8000-000000000001',draft='20000000-0000-4000-8000-000000000002';
function harness(provider='ringcentral'){
 const calls=[],pending=[],host={hidden:false,children:[],replaceChildren(...children){this.children=children;},contains(child){return this.children.includes(child);}},account={id:'synthetic-clinician',role:'clinician'};
 const context=vm.createContext({console,Promise,Error,me:account,outboundState:{provider:'unrelated',integrations:[],items:[],detail:null},$:id=>id==='tools'?host:null,document:{createElement:()=>({})},showTool:title=>calls.push({title}),api:(path,method='GET')=>{calls.push({path,method});return new Promise((resolve,reject)=>pending.push({path,resolve,reject}));},renderOutboundWorkspace:()=>{calls.push({render:true});host.replaceChildren({rendered:true});}});
 vm.runInContext(source,context);
 const start=()=>vm.runInContext(`openWorkflowCommunicationDraft('${provider}','${integration}','${draft}')`,context);
 const finish=(items=[])=>{pending.find(item=>item.path.endsWith(`/${draft}`)).resolve(provider==='ringcentral'?{draft:{id:draft,kind:'sms',status:'draft'},payload:{text:'Synthetic reviewed message'}}:{id:draft,subject:'Synthetic email',status:'draft'});pending.find(item=>!item.path.endsWith(`/${draft}`)).resolve({items});};
 return {calls,pending,host,context,start,finish};
}
(async()=>{
 for(const provider of ['ringcentral','gmail']){
  const h=harness(provider),request=h.start();h.finish();assert.equal(await request,true);
  const state=h.context.outboundState;
  assert.equal(state.provider,provider);assert.equal(state.integrations.length,1);assert.equal(state.integrations[0].id,integration);assert.equal(state.items[0].id,draft,'an older selected draft remains visible even beyond the recent queue page');
  assert.equal(provider==='ringcentral'?state.detail.draft.id:state.detail.id,draft);
  assert.equal(h.calls.filter(call=>call.path).length,2);assert.ok(h.calls.filter(call=>call.path).every(call=>call.method==='GET'&&call.path.includes(integration)),'handoff reads only its bound integration');
  assert.equal(h.calls.filter(call=>call.render).length,1);assert.ok(!h.calls.some(call=>call.path==='/api/v1/integrations'),'clinical review does not need owner settings access');
 }
 for(const invalidate of [h=>h.context.me={id:'another-account',role:'owner'},h=>h.host.hidden=true,h=>h.host.replaceChildren({otherWorkspace:true})]){
  const h=harness(),request=h.start();invalidate(h);h.finish();assert.equal(await request,false);assert.equal(h.context.outboundState.provider,'unrelated');assert.ok(!h.calls.some(call=>call.render),'stale results never replace a different account or view');
 }
 {const h=harness(),first=h.start(),second=h.start();h.pending[0].resolve({draft:{id:draft}});h.pending[1].resolve({items:[]});assert.equal(await first,false,'a newer open invalidates the older loading marker');h.pending[2].resolve({draft:{id:draft}});h.pending[3].resolve({items:[]});assert.equal(await second,true);assert.equal(h.calls.filter(call=>call.render).length,1);}
 {const h=harness(),request=h.start();h.pending[0].resolve({draft:{id:'wrong-draft'}});h.pending[1].resolve({items:[]});await assert.rejects(request,/could not be verified/);assert.equal(h.context.outboundState.provider,'unrelated');assert.ok(!h.calls.some(call=>call.render));}
 {const h=harness(),request=h.start();h.pending[0].reject(new Error('Access denied'));h.pending[1].resolve({items:[]});await assert.rejects(request,/Access denied/);assert.match(h.host.children[0].textContent,/check your access/);assert.equal(h.context.outboundState.provider,'unrelated');}
 {const h=harness();await assert.rejects(vm.runInContext(`openWorkflowCommunicationDraft('ringcentral','../../other','${draft}')`,h.context),/invalid/);assert.equal(h.calls.length,0);h.context.me={role:'patient'};await assert.rejects(h.start(),/permitted staff/);assert.equal(h.calls.length,0);}
 {const handlers={},opened=[],context=vm.createContext({console,me:{role:'owner'},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},esc:value=>String(value??''),human:value=>String(value??''),date:value=>String(value??''),run:fn=>fn(),openWorkflowCommunicationDraft:(...args)=>opened.push(args)});
  vm.runInContext(fs.readFileSync('web/workflow-studio.js','utf8'),context);
  for(const provider of ['ringcentral','gmail']){
   context.dispatch={id:'dispatch-1',kind:'communication_send',status:'downstream_review',version:2,input:{provider,integration_id:integration},downstream_kind:`${provider}_draft`,downstream_id:draft};
   vm.runInContext("studioSelectedDispatch={dispatch};studioView='runs'",context);
   assert.match(vm.runInContext('studioDispatchDetail()',context),new RegExp(`Open ${provider==='ringcentral'?'RingCentral':'Gmail'} draft`));
   const button={dataset:{studioCommunicationDraft:'dispatch-1'},hasAttribute:()=>false};handlers.click[0]({target:{closest:()=>button}});
   assert.deepEqual(opened.at(-1),[provider,integration,draft],'Monitor opens the selected dispatch exact provider/integration/draft');
  }
  const count=opened.length,button={dataset:{studioCommunicationDraft:'stale-dispatch'},hasAttribute:()=>false};handlers.click[0]({target:{closest:()=>button}});assert.equal(opened.length,count,'stale dispatch buttons cannot open another selected result');
  vm.runInContext("studioSelectedDispatch.dispatch.input.provider='ringcentral'",context);assert.doesNotMatch(vm.runInContext('studioDispatchDetail()',context),/data-studio-communication-draft/,'a mismatched provider binding offers no handoff');
 }
 console.log('PASS workflow communication handoff: exact integration/draft, GET-only, staff access, older draft visibility and account/view race guards');
})().catch(error=>{console.error(error);process.exitCode=1;});
