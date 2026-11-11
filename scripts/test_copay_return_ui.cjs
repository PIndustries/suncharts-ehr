// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8'),revenue=fs.readFileSync('web/patient-revenue.js','utf8');
const opId='11111111-1111-4111-8111-111111111111',patient='22222222-2222-4222-8222-222222222222',appointment='33333333-3333-4333-8333-333333333333';
const operation={id:opId,patient_id:patient,appointment_id:appointment,status:'open',amount_cents:2500,livemode:false,receipt_id:null,created_at:'2026-11-11T19:00:00Z'};
function fixture(){
 const nodes={},calls=[],handlers={};
 for(const id of ['tools','page-title','clinical-workspace','patient-form','new-patient','toggle-directory'])nodes[id]={hidden:false,textContent:'Home',scrollIntoView(){},replaceChildren(){this.innerHTML='';}};
 Object.defineProperty(nodes.tools,'innerHTML',{set(value){this.html=value;delete nodes['copay-return-result'];if(value.includes('id="copay-return-result"'))nodes['copay-return-result']={innerHTML:value};},get(){return this.html||'';}});
 const location={pathname:'/',search:'?copay_checkout='+opId,hash:''};
 const ctx={console,Date,Intl,URL,URLSearchParams,encodeURIComponent,crypto:{randomUUID:()=> 'synthetic-request'},location,history:{state:{existing:true},replaceState(state,_title,path){this.state=state;const u=new URL(path,'https://example.test');location.pathname=u.pathname;location.search=u.search;location.hash=u.hash;calls.push(['replace-url',path]);}},document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn)},$:id=>nodes[id]??null,me:{tenant_id:'tenant',user_id:'staff',role:'owner'},selected:undefined,activeVisit:undefined,workspace:undefined,patientWorkspaceGeneration:0,patientDirectoryPreference:true,chartSection:'overview',encounterSection:'documentation',esc:s=>String(s??''),money:n=>'$'+(n/100).toFixed(2),date:String,human:String,canRegisterPatient:()=>false,billingCan:()=>true,workspaceResourceAllowed:()=>true,setPage:title=>nodes['page-title'].textContent=title,captureVisitDrafts:()=>calls.push(['capture-drafts']),renderPatients(){},renderChart:()=>calls.push(['render',ctx.selected,ctx.activeVisit?.id,ctx.chartSection]),setPatientDirectoryVisible(){},showChartSection:section=>ctx.chartSection=section,setEncounterSection:step=>ctx.encounterSection=step,notice:(...a)=>calls.push(['notice',...a]),run:fn=>ctx.pending=fn()};
 const workspace={patient:{id:patient},appointments:[{id:appointment,patient_id:patient,status:'checked_in',starts_at:'2026-11-11T19:00:00Z'}],visits:[{id:'visit',patient_id:patient,appointment_id:appointment,status:'signed'}]};
 ctx.reply=operation;
 ctx.api=async(path,method='GET',body)=>{calls.push(['api',path,method,body]);if(path.includes('/billing/copay-checkouts/'))return {operation:ctx.reply};if(path.endsWith('/workspace'))return structuredClone(workspace);if(path.endsWith('/billing'))return {accounts:[],entries:[],copays:[],coverages:[]};return {items:[]};};
 vm.createContext(ctx);vm.runInContext(revenue,ctx);
 vm.runInContext(app.slice(app.indexOf('function rememberHostedCopaySignInReturn('),app.indexOf('// Connect delivers delegated support codes')),ctx);
 vm.runInContext(app.slice(app.indexOf('function showTool('),app.indexOf("let sunReturnWorkspace=")),ctx);
 vm.runInContext(app.slice(app.indexOf('async function selectPatient('),app.indexOf('async function openPatientEncounter(')),ctx);
 return {ctx,nodes,calls,workspace,handlers};
}
const apiCalls=f=>f.calls.filter(c=>c[0]==='api');
(async()=>{
 let f=fixture(),c=f.ctx;
 c.reply={...operation,status:'paid',receipt_id:'verified-receipt'};
 await c.openHostedCopayReturn(opId);
 assert.equal(c.selected,patient);assert.equal(c.activeVisit.id,'visit');assert.equal(c.chartSection,'visits');assert.equal(c.encounterSection,'charges');
 assert.equal(c.hostedCopayStateFor(appointment).items[0].receipt_id,'verified-receipt');
 assert.equal(apiCalls(f)[0][1],'/api/v1/billing/copay-checkouts/'+opId);assert.equal(apiCalls(f)[1][1],'/api/v1/billing/copay-checkouts/'+opId+'/refresh');
 assert.equal(apiCalls(f).filter(call=>call[2]==='POST').length,1);assert.deepEqual(Object.keys(apiCalls(f)[1][3]),[],'return provides no financial assertions');
 assert.equal(c.location.search,'','resolved return is consumed so reload/back does not rerun it');assert.ok(f.calls.some(call=>call[0]==='notice'&&/verified/.test(call[1])));

 f=fixture();c=f.ctx;c.location.search+='&cancelled=true&paid=true';await c.openHostedCopayReturn(opId);
 assert.equal(c.hostedCopayStateFor(appointment).items[0].status,'open');assert.equal(c.hostedCopayStateFor(appointment).items[0].receipt_id,null);
 assert.ok(f.calls.some(call=>call[0]==='notice'&&/still awaiting payment/.test(call[1])),'success/cancel query values cannot override server evidence');
 assert.ok(apiCalls(f).every(call=>call[2]==='GET'||call[1].endsWith('/'+opId+'/refresh')),'never create checkout/receipt/account on return');

 f=fixture();c=f.ctx;f.workspace.visits=[];await c.openHostedCopayReturn(opId);assert.equal(c.activeVisit,undefined);assert.equal(c.chartSection,'insurance');assert.equal(vm.runInContext('insuranceAppointmentSelection.get(selected)',c),appointment,'an unstarted appointment is restored without creating an encounter');
 f=fixture();c=f.ctx;c.workspaceResourceAllowed=resource=>resource!=='clinical';await c.openHostedCopayReturn(opId);assert.equal(c.selected,undefined);assert.equal(apiCalls(f).some(call=>call[1].includes('/patients/')),false);assert.match(f.nodes['copay-return-result'].innerHTML,/does not include opening/);
 f=fixture();c=f.ctx;c.billingCan=()=>false;await c.openHostedCopayReturn(opId);assert.equal(apiCalls(f).length,1,'read-only staff does not reconcile or open a hidden billing panel');assert.match(f.nodes['copay-return-result'].innerHTML,/Awaiting card payment/);

 f=fixture();c=f.ctx;await c.openHostedCopayReturn('not-an-operation');assert.equal(apiCalls(f).length,0);assert.match(f.nodes['copay-return-result'].innerHTML,/invalid/);
 f=fixture();c=f.ctx;c.api=async()=>{throw Object.assign(Error('Not found'),{status:404});};await c.openHostedCopayReturn(opId);assert.equal(c.selected,undefined);assert.match(f.nodes['copay-return-result'].innerHTML,/could not be loaded with your current access/);assert.equal(f.nodes['copay-return-result'].innerHTML.includes(patient),false);
 f=fixture();c=f.ctx;const original=c.api;c.api=async(...args)=>{if(args[1]==='POST')throw Error('Timeout');return original(...args);};await c.openHostedCopayReturn(opId);assert.equal(c.selected,patient);assert.ok(f.calls.some(call=>call[0]==='notice'&&call[2]===true&&/last saved status/.test(call[1])));assert.equal(c.hostedCopayStateFor(appointment).items[0].status,'open');

 f=fixture();c=f.ctx;let finish;c.api=()=>new Promise(resolve=>finish=resolve);const loading=c.openHostedCopayReturn(opId);c.me={tenant_id:'different',role:'owner'};finish({operation});await loading;assert.equal(c.selected,undefined);assert.equal(f.calls.some(call=>call[0]==='render'),false,'late response cannot cross a sign-in/tenant change');
 f=fixture();c=f.ctx;c.api=()=>new Promise(resolve=>finish=resolve);const navigating=c.openHostedCopayReturn(opId);c.showTool('Schedule');finish({operation});await navigating;assert.equal(f.nodes['page-title'].textContent,'Schedule');assert.equal(c.selected,undefined,'late lookup cannot reopen after navigation');
 f=fixture();c=f.ctx;finish=undefined;const actualApi=c.api;c.api=(path,...args)=>path.endsWith('/workspace')?new Promise(resolve=>finish=resolve):actualApi(path,...args);const chartLoad=c.openHostedCopayReturn(opId);while(!finish||f.calls.filter(call=>call[0]==='api').length<2)await new Promise(resolve=>setImmediate(resolve));
 // The workspace request is now pending; moving to another tool must stop the
 // actual selectPatient before publishing any of that patient's data.
 c.showTool('Schedule');finish(structuredClone(f.workspace));await chartLoad;assert.equal(c.selected,undefined);assert.equal(f.calls.some(call=>call[0]==='render'),false);
 f=fixture();c=f.ctx;c.reply={...operation,id:'44444444-4444-4444-8444-444444444444'};await c.openHostedCopayReturn(opId);assert.equal(c.selected,undefined);assert.equal(apiCalls(f).length,1,'mismatched operation is not refreshed');

 // Login executes return restoration only after the normal authenticated enter.
 assert.ok(app.indexOf("me=await api('/auth/me')")<app.indexOf("await openHostedCopayReturn(new URLSearchParams"));
 f=fixture();c=f.ctx;c.me=undefined;await c.openHostedCopayReturn(opId);assert.equal(apiCalls(f).length,0);assert.match(c.location.search,/copay_checkout=/,'unauthenticated local sign-in retains the return target');
 f=fixture();c=f.ctx;c.location.hash='#code='+'s'.repeat(40)+'&issuer=https%3A%2F%2Fconnect.example.test';c.fetch=async()=>({ok:true,json:async()=>({kind:'staff'})});
 vm.runInContext(app.slice(app.indexOf('async function acceptConnectLaunch('),app.indexOf('const connectLaunchAcceptance=')),c);
 assert.equal(await c.acceptConnectLaunch(),true);assert.equal(c.location.hash,'');assert.equal(new URLSearchParams(c.location.search).get('copay_checkout'),opId,'Connect fragment acceptance preserves an existing valid operation query while stripping the secret fragment');
 const storage=new Map();c.sessionStorage={setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)??null,removeItem:k=>storage.delete(k)};
 c.location.search='?copay_checkout='+opId; c.rememberHostedCopaySignInReturn();
 const saved=JSON.parse(storage.get('suncharts.copay-return'));assert.deepEqual(Object.keys(saved).sort(),['expires','id']);assert.equal(saved.id,opId);
 // The external sign-in destroys the old query. Only the bounded opaque ID is
 // restored on the normal Connect callback; server authorization still follows.
 c.location.search='';c.location.hash='#code='+'s'.repeat(40)+'&issuer=https%3A%2F%2Fconnect.example.test';
 await c.acceptConnectLaunch();assert.equal(new URLSearchParams(c.location.search).get('copay_checkout'),opId);assert.equal(storage.size,0,'callback consumes the same-tab navigation target once');
 storage.set('suncharts.copay-return',JSON.stringify({id:opId,expires:Date.now()-1}));assert.equal(c.takeHostedCopaySignInReturn(),null);assert.equal(storage.size,0);
 storage.set('suncharts.copay-return',JSON.stringify({id:opId,expires:Date.now()+3600000}));assert.equal(c.takeHostedCopaySignInReturn(),null,'unbounded future expiry is rejected');
 storage.set('suncharts.copay-return','invalid');assert.equal(c.takeHostedCopaySignInReturn(),null);
 c.rememberHostedCopaySignInReturn();c.clearHostedCopaySignInReturn();assert.equal(storage.size,0);assert.equal(c.location.search,'','explicit sign-out removes the return target');
 console.log('PASS checkout return: verified refresh, exact patient/appointment, unpaid/cancel, read-only scopes, stale session/navigation, failures and login retention');
})().catch(error=>{console.error(error);process.exitCode=1;});
