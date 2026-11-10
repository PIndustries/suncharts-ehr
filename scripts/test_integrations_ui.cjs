// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/integrations.js','utf8'),app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8'),style=fs.readFileSync('web/style.css','utf8'),lib=fs.readFileSync('src/lib.rs','utf8');
const handlers={},nodes={tools:{className:'',innerHTML:''},'integration-editor':{innerHTML:'',replaceChildren(){this.innerHTML='';}}},calls=[];
class FixtureFormData{constructor(form){this.values=Object.entries(form.values);}[Symbol.iterator](){return this.values[Symbol.iterator]();}}
const api=async(path,method='GET',body,version)=>{
 calls.push({path,method,body,version});
 if(path==='/api/v1/integrations')return {credential_storage_ready:true,items:[{id:'ring-1',provider:'ringcentral',label:'Clinic RingCentral',status:'pending',enabled:true,credential_stored:true,last_test_at:'2026-11-07',last_test_result:'credential_storage_verified',version:2,config:{}},{id:'gmail-1',provider:'gmail',label:'Clinic Gmail',status:'connected',enabled:true,credential_stored:true,last_test_at:'2026-11-07',last_test_result:'oauth_account_verified',version:3,config:{}},{id:'claude-1',provider:'claude',label:'Clinic Claude',status:'configured',enabled:false,credential_stored:true,credential_hint:'…1234',version:2,config:{model:'clinic-selected'}},{id:'erebine-1',provider:'erebine',label:'Clinic Erebine',status:'configured',enabled:false,credential_stored:true,credential_hint:'DO-NOT-DISPLAY',version:1,config:{model:'clinic-erebine-model',project_id:'synthetic-project'}}]};
 if(path==='/api/v1/previsit/settings')return {profile:{enabled:true,public_slug:'new-patients'}};
 if(path==='/api/v1/billing/payments/settings')return {setting:{mode:'suncharts_connect',verified:false,details_submitted:true,charges_enabled:false,payouts_enabled:false}};
 if(path.endsWith('/erebine/models'))return {models:[{id:'clinic-erebine-model'},{id:'second-model',name:'Second <model>'}]};
 return {items:[]};
};
const context=vm.createContext({console,Map,Set,URL,URLSearchParams,Object,Number,Date,JSON,location:{origin:'https://clinic.example',assign:()=>{}},document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:id=>nodes[id]||null,me:{role:'owner'},esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),human:value=>String(value??'').replaceAll('_',' '),date:value=>String(value),scopeNames:{'scheduling.read':'Read scheduling'},api,showTool:()=>{},connectStatusCard:()=>'<div>Platform identity connected</div>',notice:()=>{},run:fn=>Promise.resolve().then(fn),showPrevisit:async()=>{},showApps:async()=>{}});
const sunShared=fs.readFileSync('web/sun.js','utf8');vm.runInContext(sunShared.slice(sunShared.indexOf('function sunPrivacyPipeline('),sunShared.indexOf('function sunInvalidatePrivacyReview(')),context);
vm.runInContext(source,context);
context.FormData=FixtureFormData;
(async()=>{
 await vm.runInContext("showInstanceIntegrations({connection:{},onboarding:{},grants:{items:[{id:'grant-1',name:'HealthClinics',scope:'scheduling.read'}]},clients:{items:[{id:'client-1',name:'HealthClinics scheduling',redirect_uri:'https://healthclinics.example/oauth/callback',disabled:false}]}})",context);
 const html=nodes.tools.innerHTML;
 for(const label of ['SunCharts Payments','Stripe Connect','Patient payments','Clinic payouts','SunCharts online booking','HealthClinics','RingCentral','Gmail referrals','Claude','Erebine','Sun assistance','Authorized applications'])assert.match(html,new RegExp(label));
 assert.match(html,/data-payment-settings/);
 assert.match(html,/Setup incomplete/);
 assert.match(html,/never asks for a Stripe secret key/);
 assert.match(html,/HealthClinics.*reads availability and writes appointments|External partners use this instance.*authorized API/s);
 assert.match(html,/Credentials, tokens, workflow settings and audit history remain inside this EHR instance/);
 assert.match(html,/clinic supplies and governs its own provider account/i);
 assert.match(html,/Open booking page/);
 assert.match(html,/Enabled · awaiting provider/);
 assert.match(html,/Local credential storage checked 2026-11-07 · provider access not tested/);
 assert.match(html,/Connected/);
 assert.match(html,/Provider check recorded 2026-11-07/);
 assert.doesNotMatch(html,/HealthClinics API key|Connect stores vendor credentials/);
 vm.runInContext("integrationEditor('healthclinics')",context);
 assert.match(nodes['integration-editor'].innerHTML,/HealthClinics connects to SunCharts/);
 assert.match(nodes['integration-editor'].innerHTML,/does not sign in to or pull from HealthClinics/);
 assert.match(nodes['integration-editor'].innerHTML,/name="oauth_client_id"/);
 assert.match(nodes['integration-editor'].innerHTML,/HealthClinics scheduling/);
 vm.runInContext("integrationEditor('claude')",context);
 assert.match(nodes['integration-editor'].innerHTML,/Anthropic API key/);
 assert.match(nodes['integration-editor'].innerHTML,/clinic-selected/);
 assert.match(nodes['integration-editor'].innerHTML,/clinic controls its provider agreement, data-use configuration and charges/);
 vm.runInContext("integrationEditor('erebine')",context);
 const erebineEditor=nodes['integration-editor'].innerHTML;
 assert.match(erebineEditor,/Erebine API key/);assert.match(erebineEditor,/Encrypted API key saved/);assert.doesNotMatch(erebineEditor,/DO-NOT-DISPLAY/);
 assert.match(erebineEditor,/name="project_id" required/);assert.match(erebineEditor,/name="model" required/);assert.match(erebineEditor,/name="workspace_id"/);assert.match(erebineEditor,/name="endpoint_slug"/);
 assert.match(erebineEditor,/type="password"[^>]+value=""/);assert.doesNotMatch(erebineEditor,/name="base_url"/);
 nodes['integration-settings-form']={values:{secret:'synthetic-key',project_id:'synthetic-project',model:'',workspace_id:'',endpoint_slug:''}};
 nodes['erebine-model-options']={innerHTML:''};nodes['erebine-model-status']={textContent:''};nodes['erebine-test-status']={textContent:''};
 context.modelButton={form:nodes['integration-settings-form'],dataset:{erebineModels:''}};
 await vm.runInContext('loadErebineModels(modelButton)',context);
 const discovery=calls.at(-1);assert.equal(discovery.path,'/api/v1/integrations/erebine/models');assert.equal(discovery.method,'POST');assert.equal(discovery.body.credential,'synthetic-key');assert.deepEqual(Object.keys(discovery.body.config),['project_id']);
 assert.match(nodes['erebine-model-options'].innerHTML,/clinic-erebine-model/);assert.match(nodes['erebine-model-options'].innerHTML,/Second &lt;model&gt;/);assert.doesNotMatch(nodes['erebine-model-options'].innerHTML,/synthetic-key/);
 nodes['integration-settings-form'].values.secret='';context.modelButton.dataset.erebineModels='erebine-1';
 await vm.runInContext('loadErebineModels(modelButton)',context);assert.equal(calls.at(-1).path,'/api/v1/integrations/erebine-1/erebine/models');assert.equal(calls.at(-1).method,'GET');
 await vm.runInContext("testErebineConnection('erebine-1')",context);assert.match(nodes['erebine-test-status'].textContent,/saved model is listed/);assert.match(nodes['erebine-test-status'].textContent,/verify inference/);
 assert.match(index,/src="\/integrations.js"/);assert.match(index,/id="nav-apps"[\s\S]*Integrations/);
 assert.match(app,/showInstanceIntegrations/);assert.match(style,/Instance integrations/);assert.match(lib,/"\/integrations\.js"/);
 assert.match(erebineEditor,/Enable workflow design proposals/);assert.doesNotMatch(erebineEditor,/name="workflow_design" checked/);
 vm.runInContext("integrationRecord('erebine').capabilities=['draft_response','workflow_design'];integrationEditor('erebine')",context);assert.match(nodes['integration-editor'].innerHTML,/name="workflow_design" checked/);
 let savePending;context.run=fn=>{savePending=Promise.resolve().then(fn);return savePending;};
 for(const enabled of [false,true]){
  const form={id:'integration-settings-form',dataset:{provider:'erebine'},values:{label:'Clinic Erebine',secret:'',project_id:'synthetic-project',model:'clinic-erebine-model',...(enabled?{workflow_design:'on'}:{})}};
  for(const handler of handlers.submit)handler({target:form,preventDefault(){},stopImmediatePropagation(){}});await savePending;
  const saved=calls.filter(call=>call.path==='/api/v1/integrations/erebine-1'&&call.method==='PUT').at(-1);assert.equal(saved.body.capabilities.includes('workflow_design'),enabled,'workflow design is an explicit connection opt-in');assert.equal(saved.body.credential,undefined,'capability edits do not resend a stored secret');
 }

 assert.match(source,/config\.oauth_client_id=values\.oauth_client_id/);
 assert.match(source,/integrations\/ringcentral\/\$\{item\.id\}\/oauth\/start/);
 assert.match(source,/integrations\/\$\{item\.id\}\/gmail\/oauth\/start/);
 assert.match(source,/redirect_uri:`\$\{location\.origin\}\$\{callback\}`/);
 assert.match(source,/\/actions`,'POST',\{action\}/);
 assert.doesNotMatch(source,/auth_type:integrationDefinitions|settings,reason/);
 console.log('PASS instance-local integrations, Claude/Erebine setup, secret-safe model discovery and account check');
})().catch(error=>{console.error(error);process.exitCode=1;});
