// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/automation-center.js','utf8'),app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8'),style=fs.readFileSync('web/style.css','utf8'),lib=fs.readFileSync('src/lib.rs','utf8');
const host={innerHTML:''},handlers={};
const responses={
 '/api/v1/connector-catalog/installations':{items:[{id:'connector-1',connector_id:'org.example.messaging',name:'Synthetic messaging',status:'enabled',manifest_version:'1.2.3',revision:2,version:3,license:'Apache-2.0',repository_url:'https://example.test/source'}]},
 '/api/v1/automation/subscriptions':{items:[{id:'trigger-1',connector_key:'org.example.messaging',trigger_key:'messages.received',event_type:'suncharts.message.received',transport:'internal',status:'active',version:2}]},
 '/api/v1/automation/deliveries':{items:[{id:'delivery-1',event_type:'suncharts.message.received',connector_key:'org.example.messaging',trigger_key:'messages.received',status:'dead_letter',attempt_count:5,max_attempts:5,updated_at:'2026-11-06T12:00:00Z'}]},
 '/api/v1/automation/action-invocations':{items:[{id:'action-1',connector_key:'org.example.messaging',action_key:'send_message',action_version:'1.0.0',operation_class:'communication',approval_policy:'owner',status:'pending_review',attempt_count:0,max_attempts:1,version:1,created_at:'2026-11-06T12:00:00Z'}]}
};
const context=vm.createContext({console,Promise,URL,JSON,Date,FormData:class{},crypto:{randomUUID:()=> 'request-1'},location:{search:'',pathname:'/'},history:{replaceState:()=>{}},document:{addEventListener:(name,handler)=>(handlers[name]??=[]).push(handler)},$:id=>id==='tools'?host:null,me:{role:'owner'},esc:value=>String(value??'').replace(/[&<>"']/g,''),date:value=>String(value),api:async path=>responses[path]||{items:[]},showTool:()=>{},notice:()=>{},run:fn=>Promise.resolve().then(fn),prompt:()=>null});
vm.runInContext(source,context);
(async()=>{
 await vm.runInContext('showAutomationCenter()',context);
 for(const label of ['Automation Center','Enabled connectors','Active triggers','Needs attention','Operational flow'])assert.match(host.innerHTML,new RegExp(label));
 vm.runInContext("automationView='connectors';automationRender()",context);assert.match(host.innerHTML,/Synthetic messaging/);assert.match(host.innerHTML,/Install reviewed connector manifest/);assert.doesNotMatch(host.innerHTML,/API key|Password|Secret/);
 vm.runInContext("automationView='triggers';automationRender()",context);assert.match(host.innerHTML,/Exact tenant-scoped events/);assert.match(host.innerHTML,/derived by the server/);assert.doesNotMatch(host.innerHTML,/name="event_type"|name="transport"|configuration/);
 vm.runInContext("automationView='approvals';automationRender()",context);assert.match(host.innerHTML,/Human review|human review/i);assert.match(host.innerHTML,/Approve/);assert.match(host.innerHTML,/Reject/);
 vm.runInContext("automationView='reconciliation';automationRender()",context);assert.match(host.innerHTML,/Ambiguous external effects stop here/);assert.match(host.innerHTML,/Replay event/);assert.match(host.innerHTML,/Cancel/);
 assert.match(index,/id="nav-automation"/);assert.match(index,/src="\/automation-center.js"/);assert.match(app,/showAutomationCenter/);assert.match(style,/Automation Center/);assert.match(lib,/"\/automation-center.js"/);
 for(const path of ['/api/v1/connector-catalog/installations','/api/v1/automation/subscriptions','/api/v1/automation/deliveries','/api/v1/automation/action-invocations'])assert.ok(source.includes(path),path);
 console.log('PASS Automation Center navigation, safe manifest setup, derived triggers, approvals and reconciliation');
})().catch(error=>{console.error(error);process.exitCode=1;});
