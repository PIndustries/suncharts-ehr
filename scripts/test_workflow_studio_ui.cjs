// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/workflow-studio.js','utf8'),app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8');
const handlers={},calls=[],host={className:'',innerHTML:'',hidden:false};
const definition={id:'workflow-1',slug:'complete-patient-journey',name:'Complete patient journey',description:'General practice flow',trigger_type:'inquiry_received',status:'draft',version:3,definition:{steps:[
 {key:'intake',title:'Collect patient information',kind:'patient_form',phase:'intake',required:true,manual_approval:false,depends_on:[],form_fields:[{key:'contact',label:'Preferred contact',field_type:'choice',required:true,options:['Phone','Email']}]},
 {key:'verify',title:'Verify benefits',kind:'eligibility_query',phase:'pre_visit',required:true,manual_approval:true,assigned_role:'front_desk',depends_on:['intake'],form_fields:[]},
 {key:'visit',title:'Complete visit',kind:'clinical_template',phase:'visit',required:true,manual_approval:true,assigned_role:'clinician',depends_on:['verify'],form_fields:[]},
 {key:'follow-up',title:'Coordinate follow-up',kind:'staff_task',phase:'follow_up',required:true,manual_approval:false,assigned_role:'front_desk',depends_on:['visit'],form_fields:[]}
]}};
const runs=[{id:'run-1',definition_name:'Patient journey',status:'active',patient_display:'Sample patient',steps:[{status:'completed'},{status:'blocked'}]}];
const dispatch={id:'dispatch-1',pathway_instance_id:'run-1',step_key:'send-reminder',kind:'communication_send',status:'pending_review',version:2};
const api=async(path,method='GET',body,version)=>{calls.push({path,method,body,version});if(path==='/api/v1/care-pathways/definitions')return {items:[definition]};if(path==='/api/v1/care-pathways/instances')return {items:runs};if(path==='/api/v1/workflow-dispatches')return {items:[dispatch]};if(path==='/api/v1/workflow-dispatches/dispatch-1')return {dispatch,events:[{action:'dispatch_created',actor_id:'owner-1',created_at:'2026-11-06T12:00:00Z'}]};if(path.endsWith('/revisions'))return {items:[{version:3,status:'draft'},{version:2,status:'active'},{version:1,status:'draft'}]};return definition;};
const context=vm.createContext({console,Map,Set,Object,Number,Date,JSON,crypto:{randomUUID:()=> 'synthetic-id'},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),querySelector:()=>null},$:id=>id==='tools'?host:null,me:{role:'owner',delegated_role:'workflow_manager'},esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),human:value=>String(value??'').replaceAll('_',' '),date:value=>String(value),api,showTool:()=>{},notice:()=>{},run:fn=>Promise.resolve().then(fn),history:{replaceState:()=>{}}});
vm.runInContext(source,context);
(async()=>{
 await vm.runInContext('showWorkflowStudio()',context);
 assert.match(host.innerHTML,/Drafts/);assert.match(host.innerHTML,/Published/);assert.match(host.innerHTML,/Open runs/);assert.match(host.innerHTML,/Blocked/);
 for(const tab of ['Overview','Builder','Forms','Test sandbox','Runs','Version history'])assert.match(host.innerHTML,new RegExp(tab));
 assert.match(host.innerHTML,/Partner-managed workspace/);assert.match(host.innerHTML,/Continue building/);
 vm.runInContext("studioView='builder';studioDraft._selectedStep='intake';studioRender()",context);
 assert.match(host.innerHTML,/Inquiry &amp; intake|Inquiry & intake/);assert.match(host.innerHTML,/Before the visit/);assert.match(host.innerHTML,/Day of visit/);assert.match(host.innerHTML,/After the visit/);
 assert.match(host.innerHTML,/Rules and timing/);assert.match(host.innerHTML,/Connections/);assert.match(host.innerHTML,/Edit this form in Forms/);
 assert.match(host.innerHTML,/class="studio-graph-edges"/);assert.match(host.innerHTML,/data-edge-id="intake--verify"/);assert.match(host.innerHTML,/Approval/);assert.match(host.innerHTML,/Workflow columns/);
 assert.equal(vm.runInContext('studioDraft.definition.columns.length',context),4,'legacy definitions receive the four default columns');
 vm.runInContext("studioDraft._selectedStep='verify';studioStep().condition={field:'/coverage/active',operator:'equals',value:true};studioRender()",context);
 assert.match(host.innerHTML,/Run condition/);assert.match(host.innerHTML,/data-studio-condition-value-type/);assert.match(host.innerHTML,/value="boolean" selected/);assert.match(host.innerHTML,/If coverage.*active equals true/);assert.match(host.innerHTML,/studio-graph-edge conditional/);
 handlers.input[0]({target:{dataset:{studioConditionProperty:'value',valueType:'boolean'},value:'false',hasAttribute:()=>false}});assert.equal(vm.runInContext('studioStep().condition.value',context),false);assert.equal(vm.runInContext('typeof studioStep().condition.value',context),'boolean','editing a boolean condition preserves its JSON type');
 vm.runInContext("studioStep().condition=null;studioToggleColumn('follow_up')",context);assert.match(host.innerHTML,/1 hidden node/);assert.match(host.innerHTML,/Hidden nodes still run/);vm.runInContext("studioToggleColumn('follow_up')",context);
 vm.runInContext('studioAddColumn()',context);assert.equal(vm.runInContext('studioDraft.definition.columns.length',context),5);assert.match(host.innerHTML,/Stage 5/);
 vm.runInContext("studioMove('follow-up','stage-5')",context);assert.equal(vm.runInContext("studioDraft.definition.steps.find(step=>step.key==='follow-up').phase",context),'stage-5');
 vm.runInContext("studioDeleteColumn('stage-5')",context);assert.equal(vm.runInContext('studioDraft.definition.columns.length',context),5,'a populated column cannot be deleted');
 vm.runInContext("studioMove('follow-up','pre_visit');studioDeleteColumn('stage-5')",context);assert.equal(vm.runInContext('studioDraft.definition.columns.length',context),4);
 vm.runInContext("studioDraft.definition.steps.find(step=>step.key==='intake').depends_on=['verify']",context);assert.match(vm.runInContext('studioValidation().join(" ")',context),/cycle/);vm.runInContext("studioDraft.definition.steps.find(step=>step.key==='intake').depends_on=[]",context);
 for(const label of ['Check appointment availability','Hold an appointment slot','Book an appointment','Reschedule an appointment','Cancel an appointment','Send intake request','Send communication','Draft structured extraction','Draft a response'])assert.match(source,new RegExp(label));
 for(const trigger of ['inbound call','inbound SMS','inbound fax','referral email','external booking'])assert.match(source,new RegExp(trigger,'i'));
 vm.runInContext("studioAdd('pre_visit','ai_extract_draft')",context);assert.equal(vm.runInContext("studioStep().manual_approval",context),true);assert.match(host.innerHTML,/Integration-aware node/);
 vm.runInContext("studioView='forms';studioRender()",context);assert.match(host.innerHTML,/FORM BUILDER/);assert.match(host.innerHTML,/Form fields/);
 vm.runInContext("studioView='test';studioRender()",context);assert.match(host.innerHTML,/SAFE TEST SANDBOX/);assert.match(host.innerHTML,/does not create a patient/);
 vm.runInContext("studioTestResults={ok:true,issues:[]};studioRender()",context);assert.match(host.innerHTML,/Workflow check passed/);assert.match(host.innerHTML,/Publish workflow/);
 vm.runInContext("studioView='runs';studioRender()",context);assert.match(host.innerHTML,/Needs attention/);assert.match(host.innerHTML,/Patient details protected|Sample patient/);
 assert.match(host.innerHTML,/Runs &amp; approvals|Runs & approvals/);assert.match(host.innerHTML,/Send communication/);assert.match(host.innerHTML,/Needs review/);
 vm.runInContext(`studioSelectedDispatch=${JSON.stringify({dispatch,events:[{action:'dispatch_created',actor_id:'owner-1',created_at:'2026-11-06T12:00:00Z'}]})};studioRender()`,context);assert.match(host.innerHTML,/Approve and run native action/);assert.match(host.innerHTML,/Return for changes/);assert.match(host.innerHTML,/Attributed history/);
 vm.runInContext("me={role:'front_desk',delegated_role:'partner_admin'}",context);assert.equal(vm.runInContext('studioCanPublish()',context),true);vm.runInContext('studioRender()',context);assert.match(host.innerHTML,/Partner-managed workspace/);
 vm.runInContext("studioView='history';studioRender()",context);assert.match(host.innerHTML,/Restore as draft/);
 assert.doesNotMatch(host.innerHTML,/Spasticity|spasticity/);
 assert.equal(vm.runInContext('studioCanPublish()',context),true);
 vm.runInContext("studioMove('follow-up','pre_visit','visit')",context);
 assert.equal(vm.runInContext("studioDraft.definition.steps.find(step=>step.key==='follow-up').phase",context),'pre_visit');
 await vm.runInContext('studioSave()',context);const saveCall=calls.find(call=>call.method==='PUT'&&call.path.includes('/care-pathways/definitions/'));assert.equal(saveCall.body.definition.columns.length,4);assert.equal(saveCall.body.definition.columns[0].title,'Inquiry & intake');
 assert.match(app,/requested==='care-pathways'\?'workflow-studio'/);assert.match(app,/get\('open'\)==='workflow-studio'/);
 assert.match(index,/id="nav-workflows"/);assert.match(index,/src="\/workflow-studio.js"/);
 assert.match(source,/action:'rollback'/);assert.match(source,/action:'activate'/);
 assert.match(source,/workflow-dispatches/);assert.match(source,/downstream_review/);assert.match(source,/Confirm reviewed provider result/);
 assert.ok(calls.some(call=>call.path==='/api/v1/care-pathways/instances'));
 console.log('PASS Workflow Studio IA, guided setup, forms, sandbox, runtime, partner authority and version controls');
})().catch(error=>{console.error(error);process.exitCode=1;});
