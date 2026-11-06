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
const api=async(path,method='GET',body,version)=>{calls.push({path,method,body,version});if(path==='/api/v1/care-pathways/definitions')return {items:[definition]};if(path.endsWith('/revisions'))return {items:[{version:3,status:'draft'},{version:2,status:'active'},{version:1,status:'draft'}]};return definition;};
const context=vm.createContext({console,Map,Set,Object,Number,Date,JSON,crypto:{randomUUID:()=> 'synthetic-id'},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),querySelector:()=>null},$:id=>id==='tools'?host:null,me:{role:'owner',delegated_role:'workflow_manager'},esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),human:value=>String(value??'').replaceAll('_',' '),api,showTool:()=>{},notice:()=>{},run:fn=>Promise.resolve().then(fn),history:{replaceState:()=>{}}});
vm.runInContext(source,context);
(async()=>{
 await vm.runInContext('showWorkflowStudio()',context);
 assert.match(host.innerHTML,/Inquiry &amp; intake|Inquiry & intake/);
 assert.match(host.innerHTML,/Before the visit/);assert.match(host.innerHTML,/Day of visit/);assert.match(host.innerHTML,/After the visit/);
 assert.match(host.innerHTML,/Use patient journey template/);
 vm.runInContext("studioDraft._selectedStep='intake';studioRender()",context);assert.match(host.innerHTML,/Custom form fields/);
 assert.match(host.innerHTML,/Managing this customer workflow/);assert.match(host.innerHTML,/Publish workflow/);assert.match(host.innerHTML,/Restore/);
 assert.doesNotMatch(host.innerHTML,/Spasticity|spasticity/);
 assert.equal(vm.runInContext('studioCanPublish()',context),true);
 vm.runInContext("studioMove('follow-up','pre_visit','visit')",context);
 assert.equal(vm.runInContext("studioDraft.definition.steps.find(step=>step.key==='follow-up').phase",context),'pre_visit');
 assert.match(app,/requested==='care-pathways'\?'workflow-studio'/);assert.match(app,/get\('open'\)==='workflow-studio'/);
 assert.match(index,/id="nav-workflows"/);assert.match(index,/src="\/workflow-studio.js"/);
 assert.match(source,/action:'rollback'/);assert.match(source,/action:'activate'/);
 console.log('PASS Workflow Studio route, general phases, partner authority, template, drag move and version controls');
})().catch(error=>{console.error(error);process.exitCode=1;});
