// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const deliverySource=fs.readFileSync('web/delivery.js','utf8');

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={click:[],submit:[]},calls=[],order=[];let statusFailure=false,legacyFailure=false,optionalFailure=false,optionalHang=false;
let workspaceHtml='',providerHtml='',detailHeadingFocus=null;
const nodes={};
const manualSection={hidden:false,insertAdjacentHTML(){},before(){}};
const partnerHeading={textContent:'Manual clearinghouse connections',closest:()=>manualSection};
const emptyRow={textContent:'No claim files yet. Open a ready claim and choose Prepare claim file (837P).'};
const connectionNotice={outerHTML:'',insertAdjacentHTML(){}};
const ediTool={
 inserted:'',
 insertAdjacentHTML(_position,html){this.inserted+=html;},
 querySelectorAll(selector){return selector==='h3'?[partnerHeading]:selector==='.table-empty'?[emptyRow]:[];},
 querySelector(selector){return selector==='.mapping-notice'?connectionNotice:null;},
};
nodes.tools={hidden:false,set innerHTML(value){workspaceHtml=value;if(value.includes('id="edi-tool"')){providerHtml='';nodes['edi-tool']=ediTool;nodes['edi-automation']={prepend(section){providerHtml=section.innerHTML;},insertAdjacentHTML(_position,html){providerHtml+=html;}};nodes['edi-detail']={set innerHTML(html){providerHtml=html;},get innerHTML(){return providerHtml;},querySelector(selector){if(selector!=='h2,h3')return null;return {tabIndex:0,focus(options){detailHeadingFocus=options;}};}};}},get innerHTML(){return workspaceHtml;}};
nodes['provider-settings-form']={providerSetting:null,elements:{account_key:{value:''}}};

const context={
 console,Date,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},me:{role:'owner'},
 esc:escape,human:value=>value,date:value=>value,localTime:()=> '2026-11-05T12:00',
 billingWrite:()=>true,billingField:()=>'',selectField:()=>'',sourceNotice:()=>'',claimHistory:()=>'',
 $:id=>nodes[id],
 document:{
  createElement:()=>({id:'',className:'',innerHTML:'',textContent:'',append(){}}),
  addEventListener:(kind,handler)=>{(handlers[kind]||=[]).push(handler);},
 },
 api:async path=>{
  calls.push(path);
  if(path==='/api/v1/billing/claimmd/status'){if(statusFailure)throw new Error('synthetic status outage');return {provider:'claim_md',configured:false,connected:false,connections:[]};}
  if(['/api/v1/billing/clearinghouses','/api/v1/billing/submissions','/api/v1/billing/clearinghouse-sources'].includes(path)&&legacyFailure)throw new Error('synthetic legacy outage');
  if(path==='/api/v1/billing/clearinghouses')return {items:[]};
  if(path==='/api/v1/billing/submissions')return {items:[],next_cursor:null};
  if(path==='/api/v1/billing/clearinghouse-sources')return {items:[]};
  if(path==='/api/v1/billing/claims')return {items:[]};
  if(path==='/api/v1/billing/remittances')return {items:[]};
  if(path==='/api/v1/billing/provider-settings')return {items:[],credential_storage_ready:true};
  throw new Error(`Unexpected API ${path}`);
 },
 showTool:title=>{order.push(`show:${title}`);},
 showDeliveryPanels:async()=>{order.push('delivery');if(optionalHang)return new Promise(()=>{});if(optionalFailure)throw new Error('synthetic delivery outage');},
 showClaimMdExtended:async()=>{order.push('extended');if(optionalFailure)throw new Error('synthetic extended outage');},
 run:action=>{context.pending=action();},notice:()=>{},scheduleInstant:value=>value,
 FormData:class{constructor(form){return Object.entries(form.values||{})[Symbol.iterator]();}},
};
vm.createContext(context);
for(const file of ['web/claimmd-native.js','web/provider-settings.js','web/clearinghouse.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});

(async()=>{
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 assert.match(deliverySource,/\$\('edi-automation'\)\.insertAdjacentHTML\('beforeend'/);
 assert.doesNotMatch(deliverySource,/\$\('edi-automation'\)\.innerHTML=/);
 await vm.runInContext('showEdiWorkspace()',context);
 await settle();
 assert.equal(order[0],'show:Claim lifecycle','workspace must become visible before any API work');
 assert.match(ediTool.inserted,/INSURANCE CLAIMS/);
 assert.match(ediTool.inserted,/Check insurance/);
 assert.match(connectionNotice.outerHTML,/Claim\.MD is not connected/);
 assert.match(connectionNotice.outerHTML,/data-provider-new/);
 assert.match(connectionNotice.outerHTML,/Connect your Claim\.MD account to check eligibility, send claims/);
 assert.match(providerHtml,/Claim\.MD is not connected/);
 assert(order.indexOf('delivery')>0,'legacy delivery panels load after native settings');
 assert(calls.indexOf('/api/v1/billing/provider-settings')<calls.indexOf('/api/v1/billing/delivery/routes')||!calls.includes('/api/v1/billing/delivery/routes'));
 console.log('PASS Clearinghouse renders native Claim.MD zero state before optional legacy panels');

 statusFailure=true;connectionNotice.outerHTML='';await vm.runInContext('showEdiWorkspace()',context);await settle();
 assert.match(connectionNotice.outerHTML,/data-provider-new/);
 assert.match(providerHtml,/Claim\.MD is not connected/);
 console.log('PASS Claim.MD status refresh failure cannot blank or block AccountKey setup');

 statusFailure=false;legacyFailure=true;optionalFailure=true;connectionNotice.outerHTML='';await vm.runInContext('showEdiWorkspace()',context);await settle();
 assert.match(workspaceHtml,/manual clearinghouse history is temporarily unavailable/);
 assert.match(connectionNotice.outerHTML,/data-provider-new/);
 assert.match(providerHtml,/Claim\.MD is not connected/);
 assert.match(providerHtml,/Delivery and acknowledgment details are temporarily unavailable/);
 assert.match(providerHtml,/More Claim\.MD activity is temporarily unavailable/);
 console.log('PASS legacy and optional API outages preserve native Claim.MD setup with section warnings');

 legacyFailure=false;optionalFailure=false;optionalHang=true;connectionNotice.outerHTML='';
 const load=vm.runInContext('showEdiWorkspace()',context);
 await Promise.race([load,new Promise((_,reject)=>setTimeout(()=>reject(new Error('core workspace remained blocked on optional provider history')),100))]);
 assert.match(workspaceHtml,/<h2>Claim connections<\/h2>/);
 assert.match(connectionNotice.outerHTML,/data-provider-new/);
 assert.match(providerHtml,/Loading delivery, acknowledgment and account activity/);
 console.log('PASS a hung optional provider panel cannot block or blank the populated Clearinghouse workspace');
 optionalHang=false;

 const button={dataset:{},hasAttribute:name=>name==='data-provider-new',closest:selector=>selector==='button'?button:null};
 const event={target:{closest:selector=>selector==='button'?button:null},preventDefault(){},stopImmediatePropagation(){}};
 for(const handler of handlers.click)handler(event);
 await context.pending;
 assert.match(providerHtml,/name="account_key"/);
 assert.match(providerHtml,/No sender, receiver or trading-partner form/);
 assert.doesNotMatch(providerHtml,/Create trading partner/);
 assert.equal(detailHeadingFocus?.preventScroll,true);
 assert.doesNotMatch(fs.readFileSync('web/clearinghouse.js','utf8'),/\.scrollIntoView\(/);
 const nativeSource=fs.readFileSync('web/claimmd-native.js','utf8');
 assert.match(nativeSource,/Where this claim stands/);
 assert.match(nativeSource,/Test claim\$\{live/);
 assert.match(nativeSource,/synthetic_test_reviewed/);
 assert.match(fs.readFileSync('web/claims.js','utf8'),/SCTEST control number/);
 console.log('PASS Connect Claim.MD opens direct AccountKey setup without a trading-partner prerequisite');
 console.log('PASS Claim.MD setup focuses its heading without scrolling the clearinghouse workspace away');
 console.log('PASS native claim lifecycle and reviewed synthetic-test submission remain visible in the EHR');
 const originalApi=context.api;
 for(const change of ['identity','loading-host','generation']){
  let release;context.bridgeCurrent=true;context.bridgeGuard=()=>context.bridgeCurrent;
  context.api=async path=>path==='/api/v1/billing/claims'?new Promise(resolve=>release=resolve):originalApi(path);
  const pending=vm.runInContext('showEdiWorkspace(undefined,bridgeGuard)',context);await settle();assert.equal(typeof release,'function');
  if(change==='identity')context.bridgeCurrent=false;
  if(change==='loading-host')nodes.tools.firstElementChild={id:'new-workspace'};
  if(change==='generation')vm.runInContext('ediWorkspaceGeneration++',context);
  nodes.tools.innerHTML='A different workspace is now open';release({items:[]});assert.equal(await pending,false);assert.equal(workspaceHtml,'A different workspace is now open','late native reads must not replace another workspace');
 }
 context.api=originalApi;
 console.log('PASS existing-submission workspace bridge guards identity, loading host and generation before publishing awaited claim data');

})().catch(error=>{console.error(error);process.exitCode=1;});
