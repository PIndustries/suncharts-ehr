// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/navigation-history.js','utf8');
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
function fixture(billingHub=false){
 const handlers={},events={},calls=[],drafts=new Map(),nodes={'clinical-workspace':{hidden:true},'workspace-back':{hidden:true,disabled:false},chart:{innerHTML:''}};
 let activeNav=null,entries=[{value:null,url:'/'}],index=0;
 const ctx={console,URL,JSON,Map,Promise,setTimeout,clearTimeout,me:{tenant_id:'tenant-a',user_id:'staff-a',role:'clinician'},busy:false,selected:null,activeVisit:null,workspace:null,chartSection:'overview',encounterSection:'documentation',insuranceAppointmentSelection:new Map(),billingSelected:null,labSelected:null,scrollX:0,scrollY:0,formText:'',captureCount:0,mutations:0,location:{pathname:'/',search:'',hash:''},$:id=>nodes[id],document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn),querySelector:()=>activeNav?{id:activeNav}:null},requestAnimationFrame:fn=>setImmediate(fn)};
 ctx.window=ctx;ctx.addEventListener=(type,fn)=>(events[type]??=[]).push(fn);ctx.scrollTo=point=>{ctx.scrollX=point.left||0;ctx.scrollY=point.top||0;};
 function setUrl(url){const parsed=new URL(url,'https://synthetic.test');ctx.location.pathname=parsed.pathname;ctx.location.search=parsed.search;ctx.location.hash=parsed.hash;}
 const history={get state(){return clone(entries[index].value);},replaceState(value,_,url){entries[index]={value:clone(value),url};setUrl(url);},pushState(value,_,url){entries=entries.slice(0,index+1);entries.push({value:clone(value),url});index++;setUrl(url);},back(){this.go(-1);},forward(){this.go(1);},go(offset){const next=index+offset;if(next<0||next>=entries.length)return;index=next;setUrl(entries[index].url);for(const handler of events.popstate||[])handler({state:clone(entries[index].value)});}};ctx.history=history;
 ctx.captureVisitDrafts=()=>{ctx.captureCount++;if(ctx.selected&&ctx.activeVisit&&ctx.formText)drafts.set(`${ctx.selected}:${ctx.activeVisit.id}`,ctx.formText);};
 ctx.run=async action=>{if(ctx.busy)return;ctx.busy=true;try{await action();}catch(error){calls.push(['error',error.message]);}finally{ctx.busy=false;}};
 ctx.api=async(path,method='GET')=>{calls.push([method,path]);if(method!=='GET')ctx.mutations++;return {};};
 ctx.showTool=title=>{nodes['clinical-workspace'].hidden=true;ctx.page=title;activeNav=({'Practice home':'nav-practice','Schedule':'nav-schedule','Patients & encounters':'nav-clinical','Billing':'nav-billing','Claims':'nav-claims','Integrations':'nav-apps','Support tickets':'nav-apps','Inbox':'nav-portal','Send & review':'nav-portal',Sun:null})[title]??null;};
 ctx.showPracticeWorkspace=async()=>{ctx.showTool('Practice home');await ctx.api('/practice');};
 ctx.showBillingQueue=async()=>{ctx.showTool('Billing');await ctx.api('/billing');};
 ctx.showClaimsWorkspace=async()=>{ctx.showTool('Claims');await ctx.api('/claims');};
 ctx.showApps=async()=>{ctx.showTool('Integrations');await ctx.api('/apps');};
 ctx.showPortalInbox=async()=>{ctx.showTool('Inbox');ctx.channel='patient';await ctx.api('/portal-inbox');};
 ctx.showIntegrationInbox=async(tab='communications')=>{ctx.showTool('Inbox');ctx.channel=tab;await ctx.api('/integration-inbox');};
 ctx.showOutboundWorkspace=async(provider='ringcentral')=>{ctx.showTool('Send & review');ctx.channel=provider;await ctx.api('/outbound');};
 ctx.showSunPage=async()=>{ctx.showTool('Sun');await ctx.api('/sun');};
 ctx.showSchedule=async()=>{ctx.showTool('Schedule');await ctx.api('/schedule');};
 ctx.showClinical=async()=>{ctx.captureVisitDrafts();ctx.showTool('Patients & encounters');ctx.selected=null;ctx.activeVisit=null;ctx.workspace=null;ctx.chartSection='overview';await ctx.api('/patients');nodes['clinical-workspace'].hidden=false;};
 ctx.selectPatient=async(patient,visit)=>{ctx.captureVisitDrafts();await ctx.api(`/patients/${patient}`);ctx.selected=patient;ctx.activeVisit=visit?{id:visit,status:'in_progress'}:null;ctx.claimRoute=null;ctx.fileRoute=null;ctx.workspace={patient:{id:patient},appointments:[{id:'appointment-one'},{id:'appointment-two'}],billing:{accounts:[{id:'account',content:{visit_id:visit}}]},labs:{orders:[{id:'order'}]}};ctx.formText=drafts.get(`${patient}:${visit}`)||'';};
 ctx.showChartSection=section=>{ctx.captureVisitDrafts();ctx.chartSection=section;};
 ctx.setEncounterSection=step=>{ctx.captureVisitDrafts();ctx.encounterSection=step;ctx.showChartSection('visits');};
 ctx.renderVisit=()=>{ctx.chartSection='visits';};ctx.showBillingAccount=id=>{ctx.billingSelected=id;};ctx.showOrder=id=>{ctx.labSelected=id;};
 ctx.showClaim=async id=>{await ctx.api(`/claims/${id}`);ctx.detail=['claim',id];};ctx.showEra=async id=>{await ctx.api(`/eras/${id}`);ctx.detail=['era',id];};ctx.openPaymentStatus=async id=>{ctx.showTool('Billing');await ctx.api(`/payments/${id}`);ctx.detail=['payment',id];};ctx.openPaymentSettings=async()=>{ctx.showTool('Billing');await ctx.api('/payment-settings');ctx.detail=['settings'];};
 ctx.encounterClaimRoute=()=>!nodes['clinical-workspace'].hidden&&ctx.chartSection==='visits'&&ctx.encounterSection==='charges'?ctx.claimRoute||null:null;
 ctx.showEncounterClaim=async(id,account)=>{ctx.setEncounterSection('charges');await ctx.showClaim(id);ctx.claimRoute={account,claim:id};};
 ctx.beginClaim=async account=>{ctx.setEncounterSection('charges');await ctx.api(`/accounts/${account}`);ctx.claimRoute={account,claim:null};};
 ctx.showSupportTickets=async()=>{ctx.showTool('Support tickets');await ctx.api('/support');ctx.detail=null;};
 ctx.showSupportTicket=async id=>{const identity=ctx.me;if(ctx.supportBlock)await ctx.supportBlock;if(ctx.me!==identity)return;ctx.showTool('Support tickets');await ctx.api(`/support/${id}`);ctx.detail=['support',id];};
 ctx.signInScreen=()=>{ctx.me=null;ctx.selected=null;ctx.activeVisit=null;ctx.workspace=null;ctx.formText='';drafts.clear();nodes['clinical-workspace'].hidden=true;activeNav=null;ctx.page='Sign in';};
 ctx.encounterFileRoute=()=>ctx.chartSection==='documents'||ctx.chartSection==='visits'&&ctx.encounterSection==='files'?ctx.fileRoute||null:null;
 ctx.openDocumentFile=async(id,version=1)=>{await ctx.api(`/documents/${id}/files/${version}`);ctx.fileRoute={document:id,version};};
 ctx.restoreEncounterFileRoute=async route=>ctx.openDocumentFile(route.document,route.version);
 if(billingHub){
  ctx.hubRoute=null;
  ctx.patientBillingRoute=()=>ctx.hubRoute&&(ctx.hubRoute.surface==='chart'?!nodes['clinical-workspace'].hidden&&ctx.chartSection==='billing':ctx.page==='Patient billing')?clone(ctx.hubRoute):null;
  ctx.showPatientBillingWorkspace=async options=>{ctx.captureVisitDrafts();ctx.showTool('Patient billing');ctx.hubRoute={patient:options.patientId,tab:options.tab||'overview',mode:options.mode||'recorded',surface:'global'};await ctx.api('/billing/patients/'+options.patientId);};
  ctx.changePatientBillingTab=async tab=>{ctx.hubRoute.tab=tab;await ctx.api('/billing/'+tab);};
  ctx.renderPatientBillingChart=async options=>{ctx.showChartSection('billing');ctx.hubRoute={patient:ctx.selected,tab:options.tab||'overview',mode:options.mode||'recorded',surface:'chart'};await ctx.api('/billing/patients/'+ctx.selected);};
  ctx.restorePatientBillingRoute=async route=>route.surface==='chart'?ctx.renderPatientBillingChart(route):ctx.showPatientBillingWorkspace({patientId:route.patient,tab:route.tab,mode:route.mode});
 }
 ctx.enter=async()=>ctx.showPracticeWorkspace();
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const settle=async()=>{await new Promise(r=>setTimeout(r,40));for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
 return {ctx,history,nodes,calls,drafts,handlers,settle,entries:()=>clone(entries),index:()=>index,route:()=>history.state?.sunchartsNavigation?.route};
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
test('nested navigation records one final route, captures drafts and stores only identifiers',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();const initial=f.entries().length;
 await c.run(async()=>{await c.showClinical();await c.selectPatient('patient-one','visit-one');c.setEncounterSection('charges');});
 assert.equal(f.entries().length,initial+1);assert.deepEqual(f.route(),{view:'patient',patient:'patient-one',visit:'visit-one',section:'visits',step:'charges',appointment:null,claim:null,billing:null,file:null,account:null,order:null});
 c.formText='PRIVATE UNSAVED SOAP TEXT';c.scrollY=320;c.captureVisitDrafts();await c.run(()=>c.showBillingQueue());
 const count=f.entries().length;f.history.back();await f.settle();assert.equal(c.selected,'patient-one');assert.equal(c.activeVisit.id,'visit-one');assert.equal(c.encounterSection,'charges');assert.equal(c.formText,'PRIVATE UNSAVED SOAP TEXT');assert.equal(c.scrollY,320);assert.equal(f.entries().length,count);assert.ok(c.captureCount>0);assert.doesNotMatch(JSON.stringify(f.entries()),/PRIVATE UNSAVED SOAP TEXT/);
 f.history.forward();await f.settle();assert.equal(c.page,'Billing');assert.equal(f.entries().length,count);
});
test('Patients returns to the directory and Back restores the encounter draft',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(async()=>{await c.showClinical();await c.selectPatient('patient-one','visit-one');c.setEncounterSection('documentation');});
 c.formText='UNSAVED SYNTHETIC NOTE';await c.run(()=>c.showClinical());assert.equal(c.selected,null);assert.equal(c.activeVisit,null);assert.equal(c.workspace,null);assert.equal(f.route().patient,null);assert.equal(f.drafts.get('patient-one:visit-one'),'UNSAVED SYNTHETIC NOTE');
 f.history.back();await f.settle();assert.equal(c.selected,'patient-one');assert.equal(c.activeVisit.id,'visit-one');assert.equal(c.formText,'UNSAVED SYNTHETIC NOTE');assert.equal(c.mutations,0);
 f.history.forward();await f.settle();assert.equal(c.selected,null);assert.equal(c.activeVisit,null);
});
test('Back and Forward only reload views and never replay the preceding mutation',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(async()=>{await c.api('/synthetic-change','POST');await c.showClaimsWorkspace();await c.showClaim('claim-one');});assert.equal(c.mutations,1);assert.equal(f.route().kind,'claim');f.history.back();await f.settle();f.history.forward();await f.settle();assert.deepEqual(c.detail,['claim','claim-one']);assert.equal(c.mutations,1);
});
test('browser Back queues behind busy work and in-app Back uses the same history',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(()=>c.showBillingQueue());const calls=f.calls.length;c.busy=true;
 for(const handler of f.handlers.click||[])handler({target:{closest:selector=>selector==='[data-workspace-back]'?{}:null},preventDefault(){}});
 await new Promise(r=>setTimeout(r,5));assert.equal(f.calls.length,calls);c.busy=false;await f.settle();assert.equal(c.page,'Practice home');assert.equal(f.index(),0);
});
test('an old asynchronous module cannot publish its route into a new staff session',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();let resolve;c.supportBlock=new Promise(r=>resolve=r);const pending=c.showSupportTicket('old-staff-ticket');c.signInScreen();c.me={tenant_id:'tenant-b',user_id:'staff-b',role:'owner'};await c.enter();resolve();await pending;await f.settle();assert.equal(c.page,'Practice home');assert.deepEqual(f.route(),{view:'tool',nav:'nav-practice'});assert.doesNotMatch(JSON.stringify(f.history.state),/old-staff-ticket/);
});
test('support list restores its own screen instead of the Integrations parent',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(()=>c.showSupportTickets());await c.run(()=>c.showBillingQueue());f.history.back();await f.settle();assert.equal(c.page,'Support tickets');
});
test('Sun is a navigable page and is not replaced by the previous pending route',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(()=>c.showSunPage());await c.run(()=>c.showBillingQueue());f.history.back();await f.settle();assert.equal(c.page,'Sun');
});
test('connected Inbox preserves its selected channel rather than opening patient messages',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(()=>c.showIntegrationInbox('referrals'));await c.run(()=>c.showBillingQueue());f.history.back();await f.settle();assert.equal(c.page,'Inbox');assert.equal(c.channel,'referrals');
});
test('outbound workspace preserves its provider on Back',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(()=>c.showOutboundWorkspace('gmail'));await c.run(()=>c.showBillingQueue());f.history.back();await f.settle();assert.equal(c.page,'Send & review');assert.equal(c.channel,'gmail');
});
test('insurance Back restores the selected appointment instead of later benefit context',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(async()=>{await c.showClinical();await c.selectPatient('patient-one',null);c.insuranceAppointmentSelection.set('patient-one','appointment-one');c.showChartSection('insurance');});
 c.insuranceAppointmentSelection.set('patient-one','appointment-two');for(const fn of f.handlers.change||[])fn({target:{id:'insurance-appointment'}});
 assert.equal(f.route().appointment,'appointment-two');f.history.back();await f.settle();assert.equal(c.chartSection,'insurance');assert.equal(c.insuranceAppointmentSelection.get('patient-one'),'appointment-one');
});
test('a history restore interrupted by sign-out cannot overwrite the new staff history',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(()=>c.showSupportTicket('old-staff-ticket'));await c.run(()=>c.showBillingQueue());let resolve;c.supportBlock=new Promise(r=>resolve=r);f.history.back();await new Promise(r=>setImmediate(r));c.signInScreen();c.me={tenant_id:'tenant-b',user_id:'staff-b',role:'owner'};await c.enter();resolve();await f.settle();assert.equal(c.page,'Practice home');assert.deepEqual(f.route(),{view:'tool',nav:'nav-practice'});assert.doesNotMatch(JSON.stringify(f.history.state),/old-staff-ticket/);
});
test('patient chart reads from a previous sign-in never publish into the next session',async()=>{
 const app=fs.readFileSync('web/app.js','utf8'),start=app.indexOf('async function selectPatient('),end=app.indexOf('\nconst date =',start),source=app.slice(start,end);
 for(const stage of ['workspace','related']){
  let resolve,calls=0;const gate=new Promise(r=>resolve=r),ctx={patientWorkspaceGeneration:0,me:{user_id:'old'},selected:'new-patient',workspace:{patient:{id:'new-patient'}},activeVisit:null,captureVisitDrafts(){},workspaceResourceAllowed:()=>true,
   api:async()=>{calls++;if(stage==='workspace'||calls===2)await gate;return {items:[],visits:[]};},renderChart(){throw new Error('stale chart published');},renderPatients(){throw new Error('stale directory published');}};
  vm.createContext(ctx);vm.runInContext(source,ctx);const pending=ctx.selectPatient('old-patient');await new Promise(r=>setImmediate(r));ctx.me={user_id:'new'};resolve();await pending;assert.equal(ctx.selected,'new-patient');assert.equal(ctx.workspace.patient.id,'new-patient');if(stage==='workspace')assert.equal(calls,1);
 }
});
test('Back restores claim review within its original encounter and only performs reads',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(async()=>{await c.showClinical();await c.selectPatient('patient-one','visit-one');c.setEncounterSection('charges');});await c.run(()=>c.showEncounterClaim('claim-one','account'));c.setEncounterSection('documentation');f.history.back();await f.settle();assert.equal(c.selected,'patient-one');assert.equal(c.activeVisit.id,'visit-one');assert.equal(c.encounterSection,'charges');assert.deepEqual(c.claimRoute,{account:'account',claim:'claim-one'});assert.equal(c.page,'Patients & encounters');assert.equal(c.mutations,0);
});
test('an open document editor can hold Back until its save or discard decision',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();await c.run(()=>c.showBillingQueue());c.beforeWorkspaceHistoryRestore=async()=>false;const at=f.index(),count=f.calls.length;f.history.back();await f.settle();assert.equal(f.index(),at);assert.equal(c.page,'Billing');assert.equal(f.calls.length,count);c.beforeWorkspaceHistoryRestore=async()=>true;f.history.back();await f.settle();assert.equal(c.page,'Practice home');assert.equal(f.index(),0);
});

test('Back and Forward restore file and exact version in encounter and shared patient documents without writes',async()=>{
 for(const section of ['visits','documents']){
  const f=fixture(),c=f.ctx;await c.enter();await c.run(async()=>{await c.showClinical();await c.selectPatient('patient-one','visit-one');if(section==='visits')c.setEncounterSection('files');else c.showChartSection('documents');});await c.run(()=>c.openDocumentFile('document-one',2));await c.run(()=>c.openDocumentFile('document-two',1));f.history.back();await f.settle();assert.equal(c.chartSection,section);assert.deepEqual(c.fileRoute,{document:'document-one',version:2});f.history.forward();await f.settle();assert.deepEqual(c.fileRoute,{document:'document-two',version:1});assert.equal(c.mutations,0);
 }
});

test('patient billing hub Back restores exact selected patient/tab using reads and retains encounter drafts',async()=>{
 const f=fixture(true),c=f.ctx;await c.enter();await c.run(async()=>{await c.showClinical();await c.selectPatient('patient-one','visit-one');c.setEncounterSection('documentation');});
 c.formText='UNSAVED SYNTHETIC SOAP';await c.run(()=>c.renderPatientBillingChart({tab:'invoices'}));await c.run(()=>c.changePatientBillingTab('payments'));
 f.history.back();await f.settle();assert.equal(c.selected,'patient-one');assert.equal(c.activeVisit.id,'visit-one');assert.equal(c.hubRoute.tab,'invoices');assert.equal(c.formText,'UNSAVED SYNTHETIC SOAP');
 await c.run(()=>c.showPatientBillingWorkspace({patientId:'billing-only-patient',tab:'methods',mode:'test'}));await c.run(()=>c.changePatientBillingTab('subscriptions'));const prior=f.calls.length;f.history.back();await f.settle();
 assert.deepEqual(c.hubRoute,{patient:'billing-only-patient',tab:'methods',mode:'test',surface:'global'});assert.ok(f.calls.slice(prior).every(call=>call[0]==='GET'&&call[1].startsWith('/billing/')),'global billing history never loads clinical chart');assert.equal(c.mutations,0);assert.doesNotMatch(JSON.stringify(f.entries()),/UNSAVED SYNTHETIC SOAP/);
});

test('every screen has a readable address and a pasted address opens that screen with reads only',async()=>{
 let f=fixture(),c=f.ctx;await c.enter();
 await c.run(()=>c.showClaimsWorkspace());assert.equal(c.location.hash,'#/claims');
 await c.run(()=>c.showBillingQueue());assert.equal(c.location.hash,'#/billing');
 f.history.back();await f.settle();assert.equal(c.location.hash,'#/claims');assert.equal(c.page,'Claims');
 assert.doesNotMatch(JSON.stringify(f.entries()),/[A-Z][a-z]+, [A-Z][a-z]+/,'addresses and history carry no names');
 f=fixture();c=f.ctx;c.location.hash='#/claims';await c.enter();await f.settle();assert.equal(c.page,'Claims');assert.equal(c.mutations,0);
 f=fixture();c=f.ctx;c.location.hash='#/not-a-screen/../../x';await c.enter();await f.settle();assert.equal(c.mutations,0);assert.notEqual(c.page,'Claims');
});

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+error.message);}}if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
