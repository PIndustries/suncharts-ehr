// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/specialty-workspace.js','utf8');
const handlers={},nodes={};
for(const id of ['nav-practice','nav-clinical','nav-schedule','nav-labs','nav-specialty','nav-referrals','nav-followup','nav-portal','nav-billing','nav-claims','nav-edi','nav-apps','nav-migration','nav-admin','functional-status-panel','specialty-care-panel','tools'])nodes[id]={id,hidden:false,dataset:{},innerHTML:'',append(){}};
const context=vm.createContext({console,Map,Set,Object,Number,Date,URLSearchParams,crypto:{randomUUID:()=> 'synthetic-request'},document:{addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn),querySelectorAll:()=>[]},$:id=>nodes[id],me:{role:'owner',user_id:'owner'},chartSection:'overview',selected:'patient',activeVisit:null,practiceAdminKinds:[['staff','Staff accounts']],practiceAdminState:{tab:'workspace'},esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),human:v=>String(v).replaceAll('_',' '),date:v=>v,api:async()=>({items:[]}),notice:()=>{},run:fn=>fn(),showTool:()=>{},showClinical:async()=>{},selectPatient:async()=>{},showChartSection:()=>{},applyChartSection:()=>{},FormData:class{constructor(form){this.form=form}get(key){return this.form.values?.[key]??null}},window:{}});
vm.runInContext(source,context);
vm.runInContext(`practiceWorkspaceSettings={version:2,content:{module_order:${JSON.stringify(['practice','clinical','schedule','specialty','referrals','followup','portal','labs','billing','claims','edi','apps','migration','admin'])},hidden_modules:['labs'],specialty_workspaces:['spasticity_movement'],chart_tabs:['overview','profile','functional_status','specialty_care','visits']}}`,context);
const tabs=vm.runInContext(`configuredChartTabs([['overview','Summary'],['profile','Patient details'],['immunizations','Immunizations'],['functional_status','Functional status'],['specialty_care','Specialty care'],['visits','Encounters']])`,context);
assert.equal(JSON.stringify(tabs.map(v=>v[0])),JSON.stringify(['overview','profile','functional_status','specialty_care','visits']));
vm.runInContext('applyPracticeWorkspaceSettings()',context);
assert.equal(nodes['nav-labs'].hidden,true);assert.equal(nodes['nav-specialty'].hidden,false);
const neuro=vm.runInContext(`careSummary({id:'n1',kind:'neurotoxin',status:'in_progress',version:2,updated_at:'2026-11-05T12:00:00Z',content:{medication:'<Botox>',fulfillment:'buy_and_bill',prior_authorization:'approved',next_task:'Verify <inventory>',task_due:'2026-11-10',planned_units:100,administered_units:90,wasted_units:10,hcpcs_j_code:'J0585',ndc:'00000',notes:'<review>'}})`,context);
assert.match(neuro,/&lt;Botox&gt;/);assert.match(neuro,/90 administered \/ 10 wasted \/ 100 planned/);assert.doesNotMatch(neuro,/<Botox>|<review>/);
assert.match(neuro,/Verify &lt;inventory&gt;/);assert.match(neuro,/Edit reviewed details/);
const form=vm.runInContext("careEditor({id:'pump1',version:3,kind:'baclofen_pump_refill',content:{pump_model:'Synthetic pump',medication:'Synthetic baclofen',concentration:'500 mcg/mL',refill_due:'2026-12-01',reservoir_volume_ml:'20',notes:''}})",context);assert.match(form,/Pump model/);assert.match(form,/Refill due/);assert.match(form,/data-version=\"3\"/);
console.log('PASS specialty navigation, chart configuration and escaped clinical workflow rendering');
