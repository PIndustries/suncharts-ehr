// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8'),specialty=fs.readFileSync('web/specialty-workspace.js','utf8');
const ids=['chart-overview','patient-next-action','patient-identity-panel','patient-demographics','clinical-lists','functional-status-panel','specialty-care-panel','encounter-progress','practice-admin-panel','patient-record-navigation','record-context','appointments-panel','visits-panel','visit-editor','encounter-intake','encounter-documentation','encounter-revenue','encounter-orders-actions','documents-panel','lab-workspace','insurance-workspace','billing-workspace','visit-checkout'];
const nodes=Object.fromEntries(ids.map(id=>[id,{id,hidden:true,innerHTML:'',open:false,classList:{toggle(){}}}])),notices=[],calls=[];
let captured=0;
const context=vm.createContext({console,Map,Set,Array,Object,Number,Date,
 document:{addEventListener(){},querySelectorAll:()=>[]},$:id=>nodes[id]||null,
 me:{role:'owner',user_id:'clinician-1'},chartSection:'overview',encounterSection:'documentation',practiceAdminKinds:[],selected:'patient-1',visitDrafts:new Map(),
 esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),date:value=>value,encounterDateLabel:()=> 'Synthetic visit',
 notice:(...args)=>notices.push(args),capturePrescribingDraft:()=>captured++,captureVisitDrafts:()=>captured++,updateDraftStatus(){},canDocument:()=>true,
 isRoomingStaff:()=>false,canRecordVisitVitals:()=>true,
 FormData:class{constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}},
 api:async(path,method,body,version)=>{calls.push({path,method,body,version});return {version:version+1,content:structuredClone(body.content)};},
});
vm.runInContext(specialty,context,{filename:'specialty-workspace.js'});
const extract=(startText,endText)=>{const start=app.indexOf(startText),end=app.indexOf(endText,start);assert.ok(start>=0&&end>start);return app.slice(start,end);};
vm.runInContext(extract('function encounterWorkflow(){','function openEncounterStep('),context,{filename:'encounter-navigation.js'});
vm.runInContext(extract('function chartAreaEnabled(key){','\nconst formData='),context,{filename:'chart-navigation.js'});
vm.runInContext(extract('function renderVisit(activate=true) {','function renderHistory()'),context,{filename:'encounter-render.js'});
const evaluate=source=>vm.runInContext(source,context),plain=value=>JSON.parse(JSON.stringify(value));
const configured=['overview','visits','billing','documents','profile','clinical','history','orders','checkout','functional_status','specialty_care'];
const setTabs=tabs=>evaluate(`practiceWorkspaceSettings={version:4,content:{module_order:Object.keys(workspaceModuleIds),hidden_modules:[],chart_tabs:${JSON.stringify(tabs)}}}`);
async function main(){
 evaluate(`workspace={appointments:[{id:'appt-1',status:'booked',title:'Office visit',clinician_id:'clinician-1'}],visits:[],amendments:[],billing:{accounts:[]}};activeVisit=null;billingCan=()=>true`);
 setTabs(configured);
 let actions=evaluate('patientWorkflowActions()');
 assert.match(actions,/data-check-in="appt-1">Check in patient/);
 assert.match(actions,/data-chart-section="insurance">Insurance & copay/);
 assert.doesNotMatch(actions,/Prepare charges for claim|Open patient billing|data-patient-create-claim/,'the overview offers a concrete next visit action instead of three repeated workflow launchers');
 evaluate(`workspace.appointments[0].status='checked_in'`);actions=evaluate('patientWorkflowActions()');
 assert.match(actions,/data-start="appt-1">Start encounter/);

 // Primary tasks remain visible; supporting longitudinal areas share one record menu.
 let tabs=plain(evaluate('configuredChartTabs(Object.entries(chartTabLabels))'));tabs.splice(tabs.findIndex(([key])=>key==='billing'),0,['insurance','Insurance']);context.tabs=tabs;
 const html=evaluate('chartNavigation(tabs)'),primaryHtml=html.split('<details')[0];
 assert.deepEqual([...primaryHtml.matchAll(/data-chart-section="([^"]+)"/g)].map(match=>match[1]),['overview','visits','insurance']);
 assert.match(html,/<summary>Patient record<\/summary>/);assert.match(html,/data-chart-section="billing"[^>]*>Account summary/);assert.match(html,/data-chart-section="documents"[^>]*>Shared documents/);
 assert.match(html,/data-chart-section="profile"[^>]*>Demographics/);
 assert.match(html,/data-chart-section="clinical"[^>]*>Problems, allergies &amp; medications/);
 assert.doesNotMatch(html,/data-chart-section="checkout"/,'checkout belongs to the selected encounter');
 assert.doesNotMatch(html,/chart-workflow-tabs/,'the old second row no longer duplicates encounter work');

 // Refreshes on Insurance must retain the tab; it inherits Billing configuration and access.
 evaluate("chartSection='insurance';configuredChartTabs(Object.entries(chartTabLabels))");
 assert.equal(evaluate('chartSection'),'insurance');
 evaluate("showChartSection('insurance')");assert.equal(nodes['insurance-workspace'].hidden,false);assert.equal(nodes['billing-workspace'].hidden,true);

 evaluate(`activeVisit={id:'visit-1',appointment_id:'appt-1',clinician_id:'clinician-1',status:'in_progress',version:1,note:{subjective:'Retained note'},vitals:{}};workspace.visits=[activeVisit];chartSection='visits';encounterSection='documentation'`);
 const encounter=evaluate('encounterWorkflow()');
 assert.match(encounter,/id="encounter-picker"/);assert.match(encounter,/Note &amp; ICD-10|Note & ICD-10/);assert.match(encounter,/Billing &amp; claim|Billing & claim/);assert.match(encounter,/Files &amp; voice|Files & voice/);
 assert.doesNotMatch(encounter,/Open encounter|Continue encounter/,'selected encounter renders its local steps directly');
 evaluate('renderVisit(false)');assert.match(nodes['visit-editor'].innerHTML,/SOAP note/);assert.match(nodes['visit-editor'].innerHTML,/Retained note/);
 assert.equal(nodes['visit-editor'].hidden,false);assert.equal(nodes['encounter-documentation'].hidden,false);assert.equal(nodes['encounter-intake'].hidden,true);assert.equal(nodes['appointments-panel'].hidden,true);
 const before=captured;evaluate("setEncounterSection('intake')");assert.ok(captured>before,'changing steps captures drafts');assert.equal(nodes['encounter-intake'].hidden,false);assert.equal(nodes['encounter-documentation'].hidden,true);
 evaluate("setEncounterSection('charges')");assert.equal(nodes['encounter-revenue'].hidden,false);assert.equal(nodes['visit-editor'].hidden,true);
 evaluate("setEncounterSection('orders')");assert.equal(nodes['lab-workspace'].hidden,false);assert.equal(nodes['encounter-orders-actions'].hidden,false);assert.equal(nodes['encounter-revenue'].hidden,true);
 evaluate("setEncounterSection('checkout')");assert.equal(nodes['visit-checkout'].hidden,false);assert.equal(nodes['lab-workspace'].hidden,true);
 evaluate("setEncounterSection('files')");assert.equal(nodes['documents-panel'].hidden,false);assert.equal(nodes['visit-checkout'].hidden,true);
 evaluate("showChartSection('documents');showChartSection('visits')");assert.equal(evaluate('encounterSection'),'files','returning from record review preserves the selected encounter step');

 // Hidden current steps cannot leave a blank encounter workspace.
 evaluate("encounterSection='charges';practiceWorkspaceSettings.content.chart_tabs=practiceWorkspaceSettings.content.chart_tabs.filter(key=>key!=='billing');applyChartSection()");
 assert.equal(evaluate('encounterSection'),'documentation');assert.equal(nodes['visit-editor'].hidden,false);assert.equal(nodes['encounter-revenue'].hidden,true);
 const beforeBlocked=captured;evaluate("showChartSection('insurance')");assert.equal(evaluate('chartSection'),'visits');assert.equal(captured,beforeBlocked);assert.deepEqual(notices.at(-1),['This chart area is hidden in the practice workspace.',true]);
 setTabs(configured);evaluate("practiceAccessPolicy={restricted:true,permissions:{clinical:{view:true},billing:{view:false}}};encounterSection='charges';applyChartSection()");
 assert.equal(evaluate('encounterSection'),'documentation');assert.equal(nodes['encounter-revenue'].hidden,true);assert(!plain(evaluate('encounterSections()')).some(([key])=>key==='charges'));
 evaluate("showChartSection('insurance')");assert.notEqual(evaluate('chartSection'),'insurance');
 evaluate('practiceAccessPolicy=null');

 // Legacy configuration writes still retain selected record areas and their order.
 const selected=['billing','functional_status','specialty_care','overview','visits','clinical','documents','source'],values={reason:'Synthetic chart visibility change'};
 for(const key of selected)values[`tab_${key}`]='on';
 plain(evaluate('Object.keys(workspaceModuleIds)')).forEach((key,index)=>{values[`order_${key}`]=index+1;if(key!=='specialty')values[`visible_${key}`]='on';});
 context.form={dataset:{version:'4'},values};await evaluate('saveWorkspaceSettings(form)');
 const savedOrder=[...configured.filter(key=>selected.includes(key)),...selected.filter(key=>!configured.includes(key))];assert.deepEqual(plain(calls.at(-1).body.content.chart_tabs),savedOrder);
 evaluate("practiceWorkspaceSettings.content.chart_tabs=['overview','functional_status'];chartSection='overview';applyChartSection()");
 evaluate("showChartSection('specialty_care')");assert.equal(evaluate('chartSection'),'overview');assert.equal(nodes['specialty-care-panel'].hidden,true);
 evaluate("showChartSection('functional_status')");assert.equal(nodes['functional-status-panel'].hidden,false);
 evaluate("practiceWorkspaceSettings.content.chart_tabs=['overview'];applyChartSection()");assert.equal(evaluate('chartSection'),'overview');assert.equal(nodes['functional-status-panel'].hidden,true);
 evaluate("practiceWorkspaceSettings.content.chart_tabs=['overview','specialty_care'];practiceAccessPolicy={restricted:true,permissions:{clinical:{view:false}}};showChartSection('specialty_care')");
 assert.equal(evaluate('chartSection'),'overview');assert.equal(nodes['specialty-care-panel'].hidden,true);assert.deepEqual(notices.at(-1),['Your role does not have access to this chart area.',true]);
 console.log('PASS encounter workspace, insurance navigation, draft-preserving local steps, supporting record menu and permission/configuration guards');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
