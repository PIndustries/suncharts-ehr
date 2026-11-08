// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/specialty-workspace.js','utf8');
const handlers={},nodes={};
for(const id of ['nav-practice','nav-clinical','nav-schedule','nav-labs','nav-specialty','nav-referrals','nav-followup','nav-portal','nav-billing','nav-claims','nav-edi','nav-apps','nav-migration','nav-admin','functional-status-panel','specialty-care-panel','tools'])nodes[id]={id,hidden:false,dataset:{},innerHTML:'',append(){}};
const context=vm.createContext({console,Map,Set,Object,Number,Date,URLSearchParams,crypto:{randomUUID:()=> 'synthetic-request'},document:{addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn),querySelectorAll:()=>[]},$:id=>nodes[id],me:{role:'owner',user_id:'owner'},chartSection:'overview',selected:'patient',activeVisit:null,practiceAdminKinds:[['staff','Staff accounts']],practiceAdminState:{tab:'workspace'},esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),human:v=>String(v).replaceAll('_',' '),date:v=>v,api:async()=>({items:[]}),notice:()=>{},run:fn=>fn(),showTool:()=>{},showClinical:async()=>{},selectPatient:async()=>{},showChartSection:()=>{},applyChartSection:()=>{},FormData:class{constructor(form){this.form=form}get(key){return this.form.values?.[key]??null}},window:{}});
vm.runInContext(source,context);
vm.runInContext(`practiceWorkspaceSettings={version:2,content:{module_order:${JSON.stringify(['practice','clinical','schedule','specialty','referrals','followup','portal','labs','billing','claims','edi','apps','migration','admin'])},hidden_modules:['labs'],chart_tabs:['overview','profile','functional_status','specialty_care','visits']}}`,context);
const tabs=vm.runInContext(`configuredChartTabs([['overview','Summary'],['profile','Patient details'],['immunizations','Immunizations'],['functional_status','Functional status'],['specialty_care','Specialty care'],['visits','Encounters']])`,context);
assert.equal(JSON.stringify(tabs.map(v=>v[0])),JSON.stringify(['overview','profile','functional_status','specialty_care','visits']));
vm.runInContext('applyPracticeWorkspaceSettings()',context);
assert.equal(nodes['nav-labs'].hidden,true);assert.equal(nodes['nav-specialty'].hidden,false);
const neuro=vm.runInContext(`careSummary({id:'n1',kind:'neurotoxin',status:'in_progress',version:2,updated_at:'2026-11-05T12:00:00Z',content:{medication:'<Botox>',fulfillment:'buy_and_bill',prior_authorization:'approved',next_task:'Verify <inventory>',task_due:'2026-11-10',planned_units:100,administered_units:90,wasted_units:10,hcpcs_j_code:'J0585',ndc:'00000',notes:'<review>'}})`,context);
assert.match(neuro,/&lt;Botox&gt;/);assert.match(neuro,/90 administered \/ 10 wasted \/ 100 planned/);assert.doesNotMatch(neuro,/<Botox>|<review>/);
assert.match(neuro,/Verify &lt;inventory&gt;/);assert.match(neuro,/Edit reviewed details/);
const form=vm.runInContext("careEditor({id:'pump1',version:3,kind:'baclofen_pump_refill',content:{pump_model:'Synthetic pump',medication:'Synthetic baclofen',concentration:'500 mcg/mL',refill_due:'2026-12-01',reservoir_volume_ml:'20',notes:''}})",context);assert.match(form,/Pump model/);assert.match(form,/Refill due/);assert.match(form,/data-version=\"3\"/);
console.log('PASS specialty navigation, chart configuration and escaped clinical workflow rendering');
// Named access policies hide denied areas without treating presentation settings as authority.
vm.runInContext(`practiceAccessPolicy={restricted:true,permissions:{clinical:{view:true,create:false},scheduling:{view:true},billing:{view:false},workflows:{view:false}},module_permissions:{clinical:{view:true},schedule:{view:true},admin:{view:false},billing:{view:false}}}; applyPracticeWorkspaceSettings()`,context);
assert.equal(nodes['nav-clinical'].hidden,false);
assert.equal(nodes['nav-billing'].hidden,true);
assert.equal(nodes['nav-admin'].hidden,true);
assert.equal(vm.runInContext("workspaceResourceAllowed('clinical','create')",context),false);
assert.equal(vm.runInContext("workspaceResourceAllowed('unmapped')",context),false);
const restrictedTabs=vm.runInContext("configuredChartTabs([['overview','Summary'],['billing','Financials'],['source','Source records'],['care_pathways','Care pathways']])",context);
assert.equal(JSON.stringify(restrictedTabs),JSON.stringify([['overview','Summary']]));
// A renamed/moved module uses text content, and removing an override restores its native parent.
const native={append(node){node.parentNode=this;}},care={append(node){node.parentNode=this;}},label={textContent:''};
nodes['nav-clinical'].parentNode=native;nodes['nav-clinical'].querySelector=()=>label;
context.document.querySelector=selector=>selector.includes('nav-care-label')?care:null;
vm.runInContext(`practiceWorkspaceSettings.content.module_labels={clinical:'<Patients & visits>'};practiceWorkspaceSettings.content.module_groups={clinical:'care'};applyPracticeWorkspaceSettings()`,context);
assert.equal(label.textContent,'<Patients & visits>');assert.equal(nodes['nav-clinical'].parentNode,care);
vm.runInContext(`practiceWorkspaceSettings.content.module_labels={};practiceWorkspaceSettings.content.module_groups={};applyPracticeWorkspaceSettings()`,context);
assert.equal(label.textContent,'Patients');assert.equal(nodes['nav-clinical'].parentNode,native);
vm.runInContext('clearWorkspaceAccessSession()',context);
assert.equal(vm.runInContext('practiceAccessPolicy',context),undefined);
console.log('PASS policy-aware module visibility, action checks, chart areas and persisted label/group restoration');

nodes['nav-workflows']={hidden:false,dataset:{}};nodes['nav-automation']={hidden:false,dataset:{}};
vm.runInContext('practiceAccessPolicy={restricted:true,module_permissions:{}};applyWorkspaceAccessVisibility()',context);
assert.equal(nodes['nav-workflows'].hidden,true);assert.equal(nodes['nav-automation'].hidden,true);
vm.runInContext('clearWorkspaceAccessSession();applyWorkspaceAccessVisibility()',context);
assert.equal(nodes['nav-workflows'].hidden,false);assert.equal(nodes['nav-automation'].hidden,false);
console.log('PASS changed account restores allowed workflow navigation');

// Built-in chart areas render independently of navigation, and only chosen areas are read.
(async()=>{
 const calls=[];context.me={role:'owner',user_id:'owner'};nodes['practice-admin-panel']={innerHTML:''};
 vm.runInContext("practiceWorkspaceSettings={version:3,content:{module_order:Object.keys(workspaceModuleIds),hidden_modules:['specialty'],chart_tabs:['overview','functional_status']}};applyPracticeWorkspaceSettings()",context);
 assert.equal(nodes['nav-specialty'].hidden,true);nodes['specialty-care-panel'].innerHTML='Preserve unselected chart state';context.api=async(...args)=>{calls.push(args);return {items:[]};};
 await vm.runInContext('renderSpecialtyPatientWorkspace()',context);assert.deepEqual(calls.map(([path])=>path),['/api/v1/patients/patient/functional-status']);assert.match(nodes['functional-status-panel'].innerHTML,/<h2>Functional status<\/h2>/);assert.equal(nodes['specialty-care-panel'].innerHTML,'Preserve unselected chart state');
 calls.length=0;vm.runInContext("practiceWorkspaceSettings.content.chart_tabs=['overview','specialty_care']",context);nodes['functional-status-panel'].innerHTML='Keep functional draft';await vm.runInContext('renderSpecialtyPatientWorkspace()',context);assert.deepEqual(calls.map(([path])=>path),['/api/v1/patients/patient/specialty-care']);assert.match(nodes['specialty-care-panel'].innerHTML,/<h2>Specialty care<\/h2>/);assert.doesNotMatch(nodes['specialty-care-panel'].innerHTML,/Spasticity & Movement/);assert.equal(nodes['functional-status-panel'].innerHTML,'Keep functional draft');
 calls.length=0;vm.runInContext("practiceWorkspaceSettings.content.chart_tabs=['overview']",context);await vm.runInContext('renderSpecialtyPatientWorkspace()',context);assert.equal(calls.length,0);
 vm.runInContext("practiceWorkspaceSettings.content.hidden_modules=[];applyPracticeWorkspaceSettings()",context);assert.equal(nodes['nav-specialty'].hidden,false,'specialty navigation follows only layout visibility and access');
 vm.runInContext("renderWorkspaceSettingsAdmin($('practice-admin-panel'))",context);assert.match(nodes['practice-admin-panel'].innerHTML,/name="tab_functional_status"/);assert.match(nodes['practice-admin-panel'].innerHTML,/name="tab_specialty_care"/);assert.doesNotMatch(nodes['practice-admin-panel'].innerHTML,/spasticity_movement|Enable Spasticity|Specialty workspace/);
 const keys=vm.runInContext('Object.keys(workspaceModuleIds)',context),values={reason:'Show independent functional status',tab_functional_status:'on'};keys.forEach((key,index)=>{values[`order_${key}`]=String(index+1);if(key!=='specialty')values[`visible_${key}`]='on';});context.form={values,dataset:{version:'3'}};context.api=async(path,method,body,version)=>{calls.push([path,method,body,version]);return {version:4,content:body.content};};await vm.runInContext('saveWorkspaceSettings(form)',context);const saved=calls.at(-1);assert.deepEqual(Array.from(saved[2].content.chart_tabs),['overview','functional_status']);assert.ok(saved[2].content.hidden_modules.includes('specialty'));assert.ok(!Object.hasOwn(saved[2].content,'specialty_workspaces'));
 // A pending read cannot render prior-patient clinical content.
 let release;context.api=()=>new Promise(resolve=>release=resolve);nodes['functional-status-panel'].innerHTML='New chart content';const pending=vm.runInContext('renderSpecialtyPatientWorkspace()',context);context.selected='different-patient';release({items:[]});await pending;assert.equal(nodes['functional-status-panel'].innerHTML,'New chart content');
 assert.doesNotMatch(source,/specialty_workspaces|spasticity_movement/);
 console.log('PASS independent built-in chart areas, explicit navigation visibility, bundle-free saves and stale-patient isolation');
})().catch(error=>{console.error(error);process.exitCode=1;});
