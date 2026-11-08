// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/integrations.js','utf8'),app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8'),style=fs.readFileSync('web/style.css','utf8');
const host={className:'',innerHTML:''},handlers={},calls=[],pending=[],extraNodes={},refreshHooks={};
class FixtureFormData{constructor(form){this.values=Object.entries(form.values);}[Symbol.iterator](){return this.values[Symbol.iterator]();}}
const integrations=[
 {id:'ring-1',provider:'ringcentral',label:'Practice phones',enabled:true,status:'connected',credential_stored:true,version:3,capabilities:['voice']},
 {id:'gmail-1',provider:'gmail',label:'Referral inbox',enabled:true,status:'connected',credential_stored:true,version:4,capabilities:['referral_email']},
 {id:'claude-1',provider:'claude',label:'Clinic Claude',model:'clinic-claude-model',enabled:true,status:'connected',credential_stored:true,version:2,capabilities:['draft_summary']},
 {id:'erebine-1',provider:'erebine',label:'Clinic Erebine',model:'clinic-erebine-model',enabled:true,status:'connected',credential_stored:true,version:1,capabilities:['structured_extraction','draft_response']}
];
const api=async(path,method='GET',body)=>{
 calls.push({path,method,body});
 if(path==='/api/v1/integrations')return {items:integrations,credential_storage_ready:true};
 if(path==='/api/v1/ai/privacy/preview')return {id:'review-preview',expires_at:new Date(Date.now()+900000).toISOString(),requires_approval:true,provider:'erebine',model:'clinic-erebine-model',instruction:body.instruction,source_text:'Sanitized source [PERSON_1]',redaction_count:1,warnings:[]};if(path==='/api/v1/ai/connections')return {items:integrations.filter(item=>['claude','erebine'].includes(item.provider))};
 if(path==='/api/v1/patients')return {items:[{id:'patient-1',given_name:'Jamie',family_name:'Sample',mrn:'S100'}]};
 if(path==='/api/v1/integrations/ringcentral/ring-1/inbox')return {items:[{id:'event-1',event_kind:'call',status:'pending_review',occurred_at:'2026-11-06T12:00:00Z',event_uri:'/telephony/sessions'}]};
 if(path==='/api/v1/integrations/gmail-1/gmail/referrals')return {items:[{id:'referral-1',sender:'referrer@example.test',subject:'New referral',snippet:'Synthetic referral',status:'new',attachment_count:1}]};
 if(path==='/api/v1/integrations/ringcentral/ring-1/outbound')return {items:[{id:'ring-draft-1',kind:'sms',status:'draft',created_at:'2026-11-06T12:00:00Z'}]};
 if(path==='/api/v1/integrations/gmail-1/gmail/outbound-drafts')return {items:[{id:'gmail-draft-1',subject:'Referral follow-up',to:['review@example.test'],status:'approved',version:2,created_at:'2026-11-06T12:00:00Z'}]};
 if(path==='/api/v1/ai/drafts')return {items:[{id:'draft-1',purpose:'draft_summary',status:'draft',model:'clinic-model',step_key:'review-referral',pathway_instance_id:'path-1'}]};
 if(path==='/api/v1/ai/drafts/sun-draft-1')return {draft:{id:'sun-draft-1',integration_id:'erebine-1',provider:'erebine',model:'clinic-erebine-model',purpose:'structured_extraction',status:'draft',version:1,content:'Synthetic linked Sun draft.'}};
 return {items:[]};
};
const context=vm.createContext({console,Map,Set,URL,URLSearchParams,Object,Number,Date,JSON,crypto:{randomUUID:()=> 'request-1'},location:{origin:'https://clinic.example',assign:()=>{}},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:id=>id==='tools'?host:null,me:{role:'owner',delegated_role:'partner_admin'},esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),human:value=>String(value??'').replaceAll('_',' '),date:value=>String(value),scopeNames:{},api,showTool:()=>{},notice:()=>{},run:fn=>Promise.resolve().then(fn),showPrevisit:async()=>{},showApps:async()=>{}});
context.registerSunRefreshHook=(name,hook)=>{refreshHooks[name]=hook;};
const sunShared=fs.readFileSync('web/sun.js','utf8');vm.runInContext(sunShared.slice(sunShared.indexOf('function sunPrivacyPipeline('),sunShared.indexOf('function sunInvalidatePrivacyReview(')),context);
vm.runInContext(source,context);
context.FormData=FixtureFormData;context.TextEncoder=TextEncoder;
context.$=id=>id==='tools'?host:extraNodes[id]||null;
context.run=fn=>{const task=Promise.resolve().then(fn);pending.push(task);return task;};
(async()=>{
 await vm.runInContext("showIntegrationInbox('communications')",context);
 assert.match(host.innerHTML,/Inbox/);assert.match(host.innerHTML,/Patient messages/);assert.match(host.innerHTML,/Calls, texts &amp; faxes/);assert.match(host.innerHTML,/Call, text or fax/);assert.match(host.innerHTML,/Connection settings/);assert.match(host.innerHTML,/Referral email/);assert.match(host.innerHTML,/telephony\/sessions/);
 vm.runInContext("integrationInboxState.detail={type:'communications',integration:'ring-1',event:{id:'event-1',event_kind:'call',status:'pending_review'},payload:{body:{direction:'Inbound'}}};renderIntegrationInbox()",context);
 assert.match(host.innerHTML,/Review communication/i);assert.match(host.innerHTML,/Link to patient/);assert.match(host.innerHTML,/Jamie, Sample|Sample, Jamie/);
 vm.runInContext("integrationInboxState.tab='referrals';integrationInboxState.detail={type:'referrals',integration:'gmail-1',id:'referral-1',status:'new',sender:'referrer@example.test',subject:'New referral',body_text:'Synthetic referral details',attachments:[{filename:'referral.pdf',mime_type:'application\/pdf',size_bytes:1200}]};renderIntegrationInbox()",context);
 assert.match(host.innerHTML,/referral\.pdf/);assert.match(host.innerHTML,/Link referral/);assert.match(host.innerHTML,/Dismiss/);
 const beforeReview=calls.length;context.me={role:'clinician'};
 await vm.runInContext('showAiReviewWorkspace()',context);
 assert.deepEqual(calls.slice(beforeReview).map(call=>call.path).sort(),['/api/v1/ai/connections','/api/v1/ai/drafts']);
 assert.match(host.innerHTML,/Sun review/);assert.match(host.innerHTML,/Human review is mandatory/);assert.match(host.innerHTML,/Prepare a reviewed draft/);assert.match(host.innerHTML,/Clinic Claude/);assert.match(host.innerHTML,/Clinic Erebine/);assert.match(host.innerHTML,/clinic-claude-model/);
 extraNodes['ai-connection-model']={innerHTML:''};const aiPurpose={value:'draft_summary',innerHTML:''};
 const changeEvent={target:{matches:selector=>selector==='[data-ai-connection]',value:'erebine-1',form:{elements:{purpose:aiPurpose}}}};
 handlers.change.forEach(handler=>handler(changeEvent));
 assert.match(extraNodes['ai-connection-model'].innerHTML,/Erebine/);assert.match(extraNodes['ai-connection-model'].innerHTML,/clinic-erebine-model/);assert.match(aiPurpose.innerHTML,/structured_extraction/);assert.doesNotMatch(aiPurpose.innerHTML,/draft_summary/);
 const generateEvent={target:{id:'ai-generate-form',values:{integration_id:'erebine-1',purpose:'structured_extraction',instruction:'Extract only the given facts.',source_text:'Synthetic source only.',pathway_instance_id:'',step_key:''}},preventDefault(){},stopImmediatePropagation(){}};
 extraNodes['ai-generate-form']=generateEvent.target;generateEvent.target.elements={privacy_approved:{checked:false}};extraNodes['ai-privacy-preview']={innerHTML:''};handlers.submit.forEach(handler=>handler(generateEvent));await Promise.all(pending.splice(0));
 assert.equal(calls.filter(call=>call.path==='/api/v1/ai/drafts'&&call.method==='POST').length,0,'preview does not execute the provider');assert.match(extraNodes['ai-privacy-preview'].innerHTML,/Sanitized source \[PERSON_1\]/);await assert.rejects(vm.runInContext('aiExecutePrivacy()',context),/approval box/);generateEvent.target.elements.privacy_approved.checked=true;await vm.runInContext('aiExecutePrivacy()',context);
 const generated=calls.find(call=>call.path==='/api/v1/ai/drafts'&&call.method==='POST');assert.equal(generated.body.integration_id,'erebine-1');assert.equal(generated.body.purpose,'structured_extraction');assert.equal(generated.body.source_text,'Synthetic source only.');assert.equal(generated.body.model,undefined);assert.equal(generated.body.privacy_preview_id,'review-preview');assert.equal(generated.body.privacy_approved,true);
 vm.runInContext("aiReviewState.detail={draft:{id:'draft-1',integration_id:'erebine-1',provider:'erebine',model:'clinic-erebine-model',purpose:'draft_summary',status:'draft',version:2,content:'Synthetic draft for review',pathway_instance_id:'path-1',step_key:'review-referral'}};renderAiReview()",context);
 assert.match(host.innerHTML,/Draft only/);assert.match(host.innerHTML,/Workflow context/);assert.match(host.innerHTML,/Approve reviewed draft/);assert.match(host.innerHTML,/Reject draft/);
 assert.match(host.innerHTML,/<dt>Provider<\/dt><dd>Erebine/);assert.match(host.innerHTML,/<dt>Model used<\/dt><dd>clinic-erebine-model/);assert.match(host.innerHTML,/<dt>Connection<\/dt><dd>Clinic Erebine/);
 await vm.runInContext("openSunDraft('sun-draft-1')",context);assert.match(host.innerHTML,/Synthetic linked Sun draft/);assert.match(host.innerHTML,/Approve reviewed draft/);
 const beforeStale=host.innerHTML;await vm.runInContext('refreshSunReview([],{isCurrent:()=>false})',context);assert.equal(host.innerHTML,beforeStale);assert.ok(refreshHooks['sun-review']);host.querySelectorAll=()=>[{value:'Unsubmitted review note'}];assert.equal(refreshHooks['sun-review'].dirty(),true);host.querySelectorAll=()=>[];
 vm.runInContext("aiReviewState.integrations=[];aiReviewState.detail=null;renderAiReview()",context);assert.match(host.innerHTML,/Ask your practice administrator/);assert.doesNotMatch(host.innerHTML,/data-open-integrations/);
 await vm.runInContext("showOutboundWorkspace('ringcentral')",context);assert.match(host.innerHTML,/Send &amp; review|Send & review/);assert.match(host.innerHTML,/Nothing sends automatically/);assert.match(host.innerHTML,/Send SMS/);assert.match(host.innerHTML,/Draft queue/);
 vm.runInContext("outboundState.detail={draft:{id:'ring-draft-1',kind:'sms',status:'draft'},payload:{recipient:'+15551234567',sender:'+15557654321',text:'Synthetic reviewed reminder'},events:[]};renderOutboundWorkspace()",context);assert.match(host.innerHTML,/Approve recipient and content/);assert.match(host.innerHTML,/Synthetic reviewed reminder/);
 vm.runInContext("outboundState.detail={draft:{id:'ring-draft-1',kind:'sms',status:'needs_review',last_error:'Provider response was ambiguous'},payload:{recipient:'+15551234567',sender:'+15557654321',text:'Synthetic reviewed reminder'},events:[]};renderOutboundWorkspace()",context);assert.match(host.innerHTML,/Verify before reconciling/);assert.match(host.innerHTML,/RingCentral provider ID/);assert.match(host.innerHTML,/never retries the send/);
 await vm.runInContext("showOutboundWorkspace('gmail')",context);assert.match(host.innerHTML,/Create a Gmail draft/);assert.match(host.innerHTML,/Referral follow-up/);
 vm.runInContext("outboundState.detail={id:'gmail-draft-1',subject:'Referral follow-up',to_addresses:['review@example.test'],cc_addresses:[],body_text:'Synthetic reviewed reply',status:'approved',version:2,attachments:[]};renderOutboundWorkspace()",context);assert.match(host.innerHTML,/Separate send gate/);assert.match(host.innerHTML,/Send approved email/);
 vm.runInContext("outboundState.detail={id:'gmail-draft-1',subject:'Referral follow-up',to_addresses:['review@example.test'],cc_addresses:[],body_text:'Synthetic reviewed reply',status:'needs_review',last_error:'Gmail response was ambiguous',version:3,attachments:[]};renderOutboundWorkspace()",context);assert.match(host.innerHTML,/Verify in Sent mail/);assert.match(host.innerHTML,/Verify existing sent message/);assert.match(host.innerHTML,/never retries the send/);
 for(const path of ['/api/v1/integrations/ringcentral/${item.id}/oauth/start','/api/v1/integrations/${item.id}/gmail/oauth/start','/api/v1/integrations/${item.id}/gmail/watch','/api/v1/ai/drafts/${button.dataset.aiDraft}'])assert.ok(source.includes(path),path);
 assert.match(source,/transport:'websocket'/);assert.match(source,/Outbound polling \(recommended\)/);assert.match(source,/new TextEncoder\(\)\.encode\(values\.source_text\)\.length>65536/);
 assert.match(source,/confirmed_recipient/);assert.match(source,/expected_version/);assert.match(source,/Provider acceptance does not prove delivery or call connection/);
 assert.match(source,/outbound\/\$\{form\.dataset\.id\}\/reconcile/);assert.match(source,/provider_id:values\.provider_id/);assert.match(source,/action:'reconcile',reason:values\.reason,expected_version:Number\(form\.dataset\.version\)/);
 assert.match(index,/id="nav-communications"/);assert.match(index,/id="nav-ai-review"/);assert.match(app,/showIntegrationInbox/);assert.match(app,/showAiReviewWorkspace/);assert.match(style,/Integration operations/);
 console.log('PASS adapter operations, staff-safe Sun catalog, Claude/Erebine choice, draft submission, provenance and mandatory review');
})().catch(error=>{console.error(error);process.exitCode=1;});
