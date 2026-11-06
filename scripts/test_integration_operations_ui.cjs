// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/integrations.js','utf8'),app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8'),style=fs.readFileSync('web/style.css','utf8');
const host={className:'',innerHTML:''},handlers={};
const integrations=[
 {id:'ring-1',provider:'ringcentral',label:'Practice phones',enabled:true,status:'connected',credential_stored:true,version:3,capabilities:['voice']},
 {id:'gmail-1',provider:'gmail',label:'Referral inbox',enabled:true,status:'connected',credential_stored:true,version:4,capabilities:['referral_email']},
 {id:'claude-1',provider:'claude',label:'Clinic Claude',enabled:true,status:'connected',credential_stored:true,version:2,capabilities:['draft_summary']}
];
const api=async path=>{
 if(path==='/api/v1/integrations')return {items:integrations,credential_storage_ready:true};
 if(path==='/api/v1/patients')return {items:[{id:'patient-1',given_name:'Jamie',family_name:'Sample',mrn:'S100'}]};
 if(path==='/api/v1/integrations/ringcentral/ring-1/inbox')return {items:[{id:'event-1',event_kind:'call',status:'pending_review',occurred_at:'2026-11-06T12:00:00Z',event_uri:'/telephony/sessions'}]};
 if(path==='/api/v1/integrations/gmail-1/gmail/referrals')return {items:[{id:'referral-1',sender:'referrer@example.test',subject:'New referral',snippet:'Synthetic referral',status:'new',attachment_count:1}]};
 if(path==='/api/v1/ai/drafts')return {items:[{id:'draft-1',purpose:'draft_summary',status:'draft',model:'clinic-model',step_key:'review-referral',pathway_instance_id:'path-1'}]};
 return {items:[]};
};
const context=vm.createContext({console,Map,Set,URL,URLSearchParams,Object,Number,Date,JSON,crypto:{randomUUID:()=> 'request-1'},location:{origin:'https://clinic.example',assign:()=>{}},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:id=>id==='tools'?host:null,me:{role:'owner',delegated_role:'partner_admin'},esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),human:value=>String(value??'').replaceAll('_',' '),date:value=>String(value),scopeNames:{},api,showTool:()=>{},notice:()=>{},run:fn=>Promise.resolve().then(fn),showPrevisit:async()=>{},showApps:async()=>{}});
vm.runInContext(source,context);
(async()=>{
 await vm.runInContext("showIntegrationInbox('communications')",context);
 assert.match(host.innerHTML,/Intake inbox/);assert.match(host.innerHTML,/Communications/);assert.match(host.innerHTML,/Referral email/);assert.match(host.innerHTML,/telephony\/sessions/);
 vm.runInContext("integrationInboxState.detail={type:'communications',integration:'ring-1',event:{id:'event-1',event_kind:'call',status:'pending_review'},payload:{body:{direction:'Inbound'}}};renderIntegrationInbox()",context);
 assert.match(host.innerHTML,/Review communication/i);assert.match(host.innerHTML,/Link to patient/);assert.match(host.innerHTML,/Jamie, Sample|Sample, Jamie/);
 vm.runInContext("integrationInboxState.tab='referrals';integrationInboxState.detail={type:'referrals',integration:'gmail-1',id:'referral-1',status:'new',sender:'referrer@example.test',subject:'New referral',body_text:'Synthetic referral details',attachments:[{filename:'referral.pdf',mime_type:'application\/pdf',size_bytes:1200}]};renderIntegrationInbox()",context);
 assert.match(host.innerHTML,/referral\.pdf/);assert.match(host.innerHTML,/Link referral/);assert.match(host.innerHTML,/Dismiss/);
 await vm.runInContext('showAiReviewWorkspace()',context);
 assert.match(host.innerHTML,/Human review is mandatory/);assert.match(host.innerHTML,/Generate a reviewed draft/);assert.match(host.innerHTML,/Clinic Claude/);
 vm.runInContext("aiReviewState.detail={draft:{id:'draft-1',purpose:'draft_summary',status:'draft',version:2,content:'Synthetic draft for review',pathway_instance_id:'path-1',step_key:'review-referral'}};renderAiReview()",context);
 assert.match(host.innerHTML,/Draft only/);assert.match(host.innerHTML,/Workflow context/);assert.match(host.innerHTML,/Approve reviewed draft/);assert.match(host.innerHTML,/Reject draft/);
 for(const path of ['/api/v1/integrations/ringcentral/${item.id}/oauth/start','/api/v1/integrations/${item.id}/gmail/oauth/start','/api/v1/integrations/${item.id}/gmail/watch','/api/v1/ai/drafts/${button.dataset.aiDraft}'])assert.ok(source.includes(path),path);
 assert.match(source,/transport:'websocket'/);assert.match(source,/Outbound polling \(recommended\)/);assert.match(source,/new TextEncoder\(\)\.encode\(values\.source_text\)\.length>65536/);
 assert.match(index,/id="nav-communications"/);assert.match(index,/id="nav-ai-review"/);assert.match(app,/showIntegrationInbox/);assert.match(app,/showAiReviewWorkspace/);assert.match(style,/Integration operations/);
 console.log('PASS adapter setup, communications and referral queues, Claude draft review, workflow context and delegated partner UI authority');
})().catch(error=>{console.error(error);process.exitCode=1;});
