// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('web/provider-settings.js','utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture({role='owner',partners=[{id:'partner-1',content:{active:true,name:'Synthetic Partner',usage:'T'}}],settings=[],ready=true,detail=null}={}){
 const nodes={},handlers={},calls=[];let html='';
 nodes['edi-automation']={prepend:section=>{html=section.innerHTML;}};
 nodes['provider-settings-form']={providerSetting:null,elements:{account_key:{value:''}}};
 const context={me:{role},ediPartners:partners,console,Date,esc:escape,date:value=>value,localTime:()=> '2026-10-24T12:00',document:{createElement:()=>({innerHTML:''}),addEventListener:(kind,fn,capture)=>{assert.equal(capture,kind==='change'?undefined:true);handlers[kind]=fn;}},$:id=>nodes[id],api:async(path,...args)=>{calls.push({path,args});if(path==='/api/v1/billing/provider-settings')return {items:settings,credential_storage_ready:ready};if(path==='/api/v1/billing/clearinghouses')return {items:partners};return detail;},ediPane:value=>{html=value;},run:fn=>{context.pending=fn();},showEdiWorkspace:async()=>{},notice:()=>{},scheduleInstant:()=> '2026-10-24T12:00:00Z',FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}}};
 vm.createContext(context);vm.runInContext(source,context);
 return {context,nodes,handlers,calls,html:()=>html,call:code=>vm.runInContext(code,context)};
}
(async()=>{
 let f=fixture({settings:[{id:'setting-1',partner_id:'partner-1',label:'<script>unsafe</script>',route_key:'internal-route-only',usage:'T',verified:false,enabled:false}],ready:false});
 await f.call('showProviderSettingsPanel()');assert.match(f.html(),/&lt;script&gt;/);assert(!f.html().includes('<script>'));assert(!f.html().includes('internal-route-only'));assert.match(f.html(),/Saved credentials cannot be decrypted/);
 console.log('PASS provider directory escapes metadata and reports key recovery state');
 f=fixture({role:'clinician'});await f.call('showProviderSettingsPanel()');assert.equal(f.calls.length,0);
 console.log('PASS provider credential controls do not request owner-only data for clinicians');
 f=fixture({partners:[]});await f.call('openProviderSettings()');assert.match(f.html(),/data-provider-create-partner/);assert(!f.html().includes('name="account_key"'));
 console.log('PASS missing partner leads to a working setup action before credential entry');
 const setting={id:'setting-1',partner_id:'partner-1',label:'Synthetic account',usage:'T',start_at:'2026-10-24T12:00:00Z',response_id:'0',interval_seconds:60,enabled:false,verified:false,version:1,route_key:'internal-route',account_key:'SHOULD-NEVER-BE-PREFILLED'};
 f=fixture({detail:{setting,events:[]}});await f.call('openProviderSettings("setting-1")');assert.match(f.html(),/type="password"/);assert(!f.html().includes('SHOULD-NEVER-BE-PREFILLED'));assert.match(f.html(),/disabled data-provider-activate/);assert.match(f.html(),/Advanced connection identifiers/);
 console.log('PASS saved credentials never prefill and unverified activation stays disabled');
 f=fixture();const secret='synthetic-entered-key-not-real';const form={id:'provider-settings-form',providerSetting:null,values:{label:'Synthetic',partner_id:'partner-1',usage:'T',account_key:secret,start_at:'2026-10-24T12:00',response_id:'0',interval_seconds:'60'},elements:{account_key:{value:secret}}};
 let sent;
 f.context.api=async(path,method,body)=>{if(method==='POST'){sent=JSON.parse(JSON.stringify(body));return {id:'setting-1'};}if(path==='/api/v1/billing/clearinghouses')return {items:[{id:'partner-1',content:{name:'Synthetic',active:true,usage:'T'}}]};return {setting,events:[]};};
 f.handlers.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});await f.context.pending;assert.equal(sent.account_key,secret);assert.equal(form.elements.account_key.value,'');assert.equal(sent.interval_seconds,60);
 console.log('PASS credential submission uses the native API and clears the entered password after save');
})().catch(error=>{console.error(error);process.exitCode=1;});
