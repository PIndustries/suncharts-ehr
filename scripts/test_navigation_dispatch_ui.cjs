// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const appSource=fs.readFileSync(new URL('../web/app.js',`file://${__filename}`),'utf8');
const studioSource=fs.readFileSync(new URL('../web/workflow-studio.js',`file://${__filename}`),'utf8');

function between(source,start,end){
 const from=source.indexOf(start);assert.notEqual(from,-1,`missing ${start}`);
 const to=source.indexOf(end,from+start.length);assert.notEqual(to,-1,`missing ${end}`);
 return source.slice(from+start.length,to);
}

class DocumentFake{
 constructor(){this.listeners=new Map();this.buttons=[];this.documentElement={classList:{add(){},remove(){}}};}
 addEventListener(type,handler){const handlers=this.listeners.get(type)||[];handlers.push(handler);this.listeners.set(type,handlers);}
 dispatch(type,event){for(const handler of [...(this.listeners.get(type)||[])])handler(event);}
 querySelectorAll(selector){return selector==='button'?this.buttons:[];}
}

function button(attributes={}){
 const dataset={};
 for(const [name,value] of Object.entries(attributes))if(name.startsWith('data-'))dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
 return {
  id:attributes.id||'',type:'button',dataset,form:null,
  hasAttribute:name=>Object.hasOwn(attributes,name),
  closest:selector=>selector==='button'?this:null,
 };
}

async function main(){
 const failures=[];
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const document=new DocumentFake(),nodes={
  notice:{hidden:false},'shell-loading':{hidden:true},'clinical-workspace':{hidden:false},
  'patient-form':{hidden:true},tools:{hidden:false},'new-patient':{hidden:true},'toggle-directory':{hidden:true},
 };
 const location={pathname:'/',search:'?open=workflow-studio',hash:''};
 const managedButton={disabled:false,isConnected:true},restoredDisabledStates=[];document.buttons.push(managedButton);
 let pageTitle='',scheduleCalls=0,releaseSchedule,apiCalls=0,releaseApi;
 const context=vm.createContext({
  console,document,location,window:{SunChartsDialog:{restoreFocus(){restoredDisabledStates.push(managedButton.disabled);return false;}}},
  history:{replaceState(_state,_title,url){const parsed=new URL(url,'https://ehr.invalid');location.pathname=parsed.pathname;location.search=parsed.search;location.hash=parsed.hash;}},
  URL,URLSearchParams,Promise,Map,Set,Date,crypto:{randomUUID:()=> 'request-id'},
  esc:value=>String(value??''),
  busy:false,me:{role:'owner'},selected:null,activeVisit:null,cursor:null,patients:[],studioView:'overview',
  $:id=>nodes[id]||(nodes[id]={hidden:false,classList:{add(){},remove(){},toggle(){return false},contains(){return false}},setAttribute(){},focus(){},replaceChildren(){}}),
  notice(){},closeNavigation(){},setPage(value){pageTitle=value;},captureSupportDrafts(){},showChartSection(){},openEncounterStep(){},canRegisterPatient:()=>true,
  showSchedule:()=>{scheduleCalls++;return new Promise(resolve=>{releaseSchedule=resolve;});},showWorkflowStudio:async()=>{},showAutomationCenter:async()=>{},showIntegrationInbox:async()=>{},
  showAiReviewWorkspace:async()=>{},showReferralWorkspace:async()=>{},showPortalInbox:async()=>{},showFollowupWorkspace:async()=>{},
  showLabInbox:async()=>{},showSpecialtyWorklist:async()=>{},showEdiWorkspace:async()=>{},showClaimsWorkspace:async()=>{},
  showBillingQueue:async()=>{},showPracticeAdmin:async()=>{},showMigrations:async()=>{},showClinical:async()=>{},
  api:()=>{apiCalls++;return new Promise(resolve=>{releaseApi=resolve;});},captureVisitDrafts(){},rememberVisit(){},renderPatients(){},renderVisit(){},formData:()=>({}),showMigrations:async()=>{},
  confirmAction:async()=>false,signInScreen(){},locationAssign(){},studioRender(){},studioDefinitions:[],studioRuns:[],studioDispatches:[],
  studioSelected:null,studioRevisions:[],studioDraft:null,studioDirty:false,studioTestResults:null,
 });
 context.location.assign=context.locationAssign;

 vm.runInContext(between(appSource,"function notice(message, error = false) { $('notice').textContent=message; $('notice').className=`notice${error?' error':''}`; $('notice').hidden=false; }\n",'async function enter()'),context,{filename:'app-run.js'});
 const appClick=between(appSource,"document.addEventListener('click',e=>{", "\ndocument.addEventListener('keydown',e=>");
 vm.runInContext(`document.addEventListener('click',e=>{${appClick}`,context,{filename:'app-click.js'});
 const showToolSource=between(appSource,'function showTool(title) {','\nasync function showConsent()');
 vm.runInContext(`function showTool(title) {${showToolSource}`,context,{filename:'show-tool.js'});

 let appsOpened=0;
 context.showApps=async()=>{appsOpened++;};
 const studioClick=between(studioSource,"document.addEventListener('click',e=>{", "\ndocument.addEventListener('submit',e=>");
 vm.runInContext(`document.addEventListener('click',e=>{${studioClick}`,context,{filename:'workflow-studio-click.js'});

 const integrationButton=button({'data-studio-open-integrations':''});
 integrationButton.closest=selector=>selector==='button'?integrationButton:null;
 document.dispatch('click',{target:integrationButton});
 await flush();
 try{assert.equal(appsOpened,1,'a module-owned click must reach its handler instead of being swallowed by the global busy gate');}catch(error){failures.push(error.message);}

 const scheduleButton=button({id:'nav-schedule'});scheduleButton.closest=selector=>selector==='button'?scheduleButton:null;
 document.dispatch('click',{target:scheduleButton});
 try{
  assert.equal(pageTitle,'Schedule','owned navigation publishes its destination title synchronously');
  assert.match(nodes.tools.innerHTML,/Loading schedule/i,'owned navigation publishes a target loading state before awaiting reads');
  assert.equal(scheduleCalls,1);
  assert.equal(context.busy,true,'navigation remains serialized while its read is unresolved');
  document.dispatch('click',{target:scheduleButton});
  assert.equal(scheduleCalls,1,'the busy gate rejects a duplicate navigation action');
 }catch(error){failures.push(error.message);}
 releaseSchedule();await flush();

 const reconcileButton=button({'data-reconcile':'migration-1'});reconcileButton.closest=selector=>selector==='button'?reconcileButton:null;
 document.dispatch('click',{target:reconcileButton});document.dispatch('click',{target:reconcileButton});
 try{assert.equal(apiCalls,1,'the busy gate rejects a duplicate mutation while the first request is unresolved');}catch(error){failures.push(error.message);}
 releaseApi({ready_to_import:false});await flush();
 try{assert.ok(restoredDisabledStates.length>=3&&restoredDisabledStates.every(disabled=>disabled===false),'deferred dialog focus restoration runs only after shared controls are reenabled');}catch(error){failures.push(error.message);}

 context.showTool('Schedule');
 try{assert.equal(location.search,'','ordinary workspace navigation must clear a stale deep-link query before refresh');}catch(error){failures.push(error.message);}
 location.search='?open=workflow-studio';context.showTool('Workflow Studio');
 try{assert.equal(location.search,'?open=workflow-studio','Workflow Studio keeps its canonical refresh route');}catch(error){failures.push(error.message);}
 location.search='?open=automation-center';context.showTool('Automation Center');
 try{assert.equal(location.search,'?open=automation-center','Automation Center keeps its canonical refresh route');}catch(error){failures.push(error.message);}
 location.search='?oauth_request=request-1&open=workflow-studio';context.showTool('Schedule');
 try{assert.equal(location.search,'?oauth_request=request-1','ordinary navigation clears stale workspace routing without discarding an OAuth callback identifier');}catch(error){failures.push(error.message);}

 if(failures.length)throw new Error(failures.join('\n'));
 console.log('PASS delegated click routing and workspace route cleanup');
}

main().catch(error=>{console.error(`FAIL ${error.message}`);process.exitCode=1;});
