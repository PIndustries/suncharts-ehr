// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const deliverySource=fs.readFileSync('web/delivery.js','utf8');

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={click:[],submit:[]},calls=[],order=[];let statusFailure=false,legacyFailure=false,optionalFailure=false;
let workspaceHtml='',providerHtml='';
const nodes={};
const manualSection={hidden:false,insertAdjacentHTML(){}};
const partnerHeading={textContent:'Trading partners',closest:()=>manualSection};
const emptyRow={textContent:'No generated submissions. Release a reviewed claim packet, then choose Generate X12 837P.'};
const connectionNotice={outerHTML:'',insertAdjacentHTML(){}};
const ediTool={
 querySelectorAll(selector){return selector==='h3'?[partnerHeading]:selector==='.table-empty'?[emptyRow]:[];},
 querySelector(selector){return selector==='.mapping-notice'?connectionNotice:null;},
};
nodes.tools={hidden:false,set innerHTML(value){workspaceHtml=value;if(value.includes('id="edi-tool"')){providerHtml='';nodes['edi-tool']=ediTool;nodes['edi-automation']={prepend(section){providerHtml=section.innerHTML;},insertAdjacentHTML(_position,html){providerHtml+=html;}};nodes['edi-detail']={set innerHTML(html){providerHtml=html;},get innerHTML(){return providerHtml;},scrollIntoView(){}};}},get innerHTML(){return workspaceHtml;}};
nodes['provider-settings-form']={providerSetting:null,elements:{account_key:{value:''}}};

const context={
 console,Date,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},me:{role:'owner'},
 esc:escape,human:value=>value,date:value=>value,localTime:()=> '2026-11-05T12:00',
 billingWrite:()=>true,billingField:()=>'',selectField:()=>'',sourceNotice:()=>'',claimHistory:()=>'',
 $:id=>nodes[id],
 document:{
  createElement:()=>({id:'',className:'',innerHTML:''}),
  addEventListener:(kind,handler)=>{(handlers[kind]||=[]).push(handler);},
 },
 api:async path=>{
  calls.push(path);
  if(path==='/api/v1/billing/claimmd/status'){if(statusFailure)throw new Error('synthetic status outage');return {provider:'claim_md',configured:false,connected:false,connections:[]};}
  if(['/api/v1/billing/clearinghouses','/api/v1/billing/submissions','/api/v1/billing/clearinghouse-sources'].includes(path)&&legacyFailure)throw new Error('synthetic legacy outage');
  if(path==='/api/v1/billing/clearinghouses')return {items:[]};
  if(path==='/api/v1/billing/submissions')return {items:[],next_cursor:null};
  if(path==='/api/v1/billing/clearinghouse-sources')return {items:[]};
  if(path==='/api/v1/billing/provider-settings')return {items:[],credential_storage_ready:true};
  throw new Error(`Unexpected API ${path}`);
 },
 showTool:title=>{order.push(`show:${title}`);},
 showDeliveryPanels:async()=>{order.push('delivery');if(optionalFailure)throw new Error('synthetic delivery outage');},
 showClaimMdExtended:async()=>{order.push('extended');if(optionalFailure)throw new Error('synthetic extended outage');},
 run:action=>{context.pending=action();},notice:()=>{},scheduleInstant:value=>value,
 FormData:class{constructor(form){return Object.entries(form.values||{})[Symbol.iterator]();}},
};
vm.createContext(context);
for(const file of ['web/claimmd-native.js','web/provider-settings.js','web/clearinghouse.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});

(async()=>{
 assert.match(deliverySource,/\$\('edi-automation'\)\.insertAdjacentHTML\('beforeend'/);
 assert.doesNotMatch(deliverySource,/\$\('edi-automation'\)\.innerHTML=/);
 await vm.runInContext('showEdiWorkspace()',context);
 assert.equal(order[0],'show:Clearinghouse','workspace must become visible before any API work');
 assert.match(connectionNotice.outerHTML,/Claim\.MD is not connected/);
 assert.match(connectionNotice.outerHTML,/data-provider-new/);
 assert.match(connectionNotice.outerHTML,/No trading-partner profile is required/);
 assert.match(providerHtml,/Claim\.MD is not connected/);
 assert(order.indexOf('delivery')>0,'legacy delivery panels load after native settings');
 assert(calls.indexOf('/api/v1/billing/provider-settings')<calls.indexOf('/api/v1/billing/delivery/routes')||!calls.includes('/api/v1/billing/delivery/routes'));
 console.log('PASS Clearinghouse renders native Claim.MD zero state before optional legacy panels');

 statusFailure=true;connectionNotice.outerHTML='';await vm.runInContext('showEdiWorkspace()',context);
 assert.match(connectionNotice.outerHTML,/data-provider-new/);
 assert.match(providerHtml,/Claim\.MD is not connected/);
 console.log('PASS Claim.MD status refresh failure cannot blank or block AccountKey setup');

 statusFailure=false;legacyFailure=true;optionalFailure=true;connectionNotice.outerHTML='';await vm.runInContext('showEdiWorkspace()',context);
 assert.match(workspaceHtml,/manual clearinghouse history is temporarily unavailable/);
 assert.match(connectionNotice.outerHTML,/data-provider-new/);
 assert.match(providerHtml,/Claim\.MD is not connected/);
 assert.match(providerHtml,/Delivery and acknowledgment panels are temporarily unavailable/);
 assert.match(providerHtml,/Additional Claim\.MD account activity is temporarily unavailable/);
 console.log('PASS legacy and optional API outages preserve native Claim.MD setup with section warnings');

 const button={dataset:{},hasAttribute:name=>name==='data-provider-new',closest:selector=>selector==='button'?button:null};
 const event={target:{closest:selector=>selector==='button'?button:null},preventDefault(){},stopImmediatePropagation(){}};
 for(const handler of handlers.click)handler(event);
 await context.pending;
 assert.match(providerHtml,/name="account_key"/);
 assert.match(providerHtml,/No sender, receiver or trading-partner form/);
 assert.doesNotMatch(providerHtml,/Create trading partner/);
 console.log('PASS Connect Claim.MD opens direct AccountKey setup without a trading-partner prerequisite');
})().catch(error=>{console.error(error);process.exitCode=1;});
