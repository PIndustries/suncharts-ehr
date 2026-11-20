// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A reload keeps the chart open: the address the app already writes is read back,
// and a chart that cannot be reopened lands on the patient directory.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/navigation-history.js','utf8');
const landing=fs.readFileSync('web/app.js','utf8').match(/function patientDirectoryLanding\(\)\{\n return '([^']*)'/)[1];
const patient='22222222-2222-4222-8222-222222222222',other='55555555-5555-4555-8555-555555555555',visit='33333333-3333-4333-8333-333333333333';
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
function fixture({hash='',visits=[visit],enterLandsOnHome=false}={}){
 const handlers={},events={},calls=[],drafts=new Map();
 const nodes={'clinical-workspace':{hidden:true},'workspace-back':{hidden:true,disabled:false},chart:{innerHTML:''},tools:{innerHTML:''}};
 let activeNav=null,entries=[{value:null,url:'/'}],index=0;
 const ctx={console,URL,JSON,Map,Promise,setTimeout,clearTimeout,me:{tenant_id:'tenant-a',user_id:'staff-a',role:'clinician'},busy:false,selected:null,activeVisit:null,workspace:null,chartSection:'overview',encounterSection:'documentation',insuranceAppointmentSelection:new Map(),billingSelected:null,labSelected:null,scrollX:0,scrollY:0,formText:'',captureCount:0,mutations:0,location:{pathname:'/',search:'',hash},$:id=>nodes[id],document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn),querySelector:()=>activeNav?{id:activeNav}:null},requestAnimationFrame:fn=>setImmediate(fn)};
 ctx.window=ctx;ctx.addEventListener=(type,fn)=>(events[type]??=[]).push(fn);ctx.scrollTo=()=>{};
  ctx.patientDirectoryLanding=()=>landing;
 function setUrl(url){const parsed=new URL(url,'https://synthetic.test');ctx.location.pathname=parsed.pathname;ctx.location.search=parsed.search;ctx.location.hash=parsed.hash;}
 const history={get state(){return clone(entries[index].value);},replaceState(value,_,url){entries[index]={value:clone(value),url};setUrl(url);},pushState(value,_,url){entries=entries.slice(0,index+1);entries.push({value:clone(value),url});index++;setUrl(url);},back(){this.go(-1);},forward(){this.go(1);},go(offset){const next=index+offset;if(next<0||next>=entries.length)return;index=next;setUrl(entries[index].url);for(const handler of events.popstate||[])handler({state:clone(entries[index].value)});}};
 ctx.history=history;
 ctx.captureVisitDrafts=()=>{ctx.captureCount++;if(ctx.selected&&ctx.activeVisit&&ctx.formText)drafts.set(`${ctx.selected}:${ctx.activeVisit.id}`,ctx.formText);};
 ctx.run=async action=>{if(ctx.busy)return;ctx.busy=true;try{await action();}catch(error){calls.push(['error',error.message]);}finally{ctx.busy=false;}};
 ctx.api=async(path,method='GET')=>{calls.push([method,path]);if(method!=='GET')ctx.mutations++;return {};};
 ctx.showTool=title=>{nodes['clinical-workspace'].hidden=true;ctx.page=title;activeNav=({'Practice home':'nav-practice','Patients & encounters':'nav-clinical','Billing':'nav-billing'})[title]??null;};
 ctx.showPracticeWorkspace=async()=>{ctx.showTool('Practice home');await ctx.api('/practice');};
 ctx.showBillingQueue=async()=>{ctx.showTool('Billing');await ctx.api('/billing');};
 // The reload case: the patient and encounter the address names are opened again,
 // exactly as app.js does it after a fetch round trip.
 ctx.showClinical=async()=>{ctx.captureVisitDrafts();ctx.showTool('Patients & encounters');ctx.selected=null;ctx.activeVisit=null;ctx.workspace=null;ctx.chartSection='overview';await ctx.api('/patients');nodes['clinical-workspace'].hidden=false;};
 ctx.selectPatient=async(id,keepVisit)=>{
  ctx.captureVisitDrafts();await ctx.api(`/patients/${id}`);
  ctx.selected=id;ctx.workspace={patient:{id},appointments:[],visits:visits.map(vid=>({id:vid,status:'in_progress'})),billing:{accounts:[]},labs:{orders:[]}};
  ctx.activeVisit=keepVisit?(ctx.workspace.visits.some(v=>v.id===keepVisit)?{id:keepVisit,status:'in_progress'}:null):null;
  ctx.chartSection=keepVisit?'visits':'overview';
 };
 ctx.showChartSection=section=>{ctx.captureVisitDrafts();ctx.chartSection=section;};
 ctx.setEncounterSection=step=>{ctx.captureVisitDrafts();ctx.encounterSection=step;ctx.showChartSection('visits');};
 ctx.renderVisit=()=>{ctx.chartSection='visits';};ctx.showBillingAccount=id=>{ctx.billingSelected=id;};ctx.showOrder=id=>{ctx.labSelected=id;};
 ctx.signInScreen=()=>{ctx.me=null;ctx.selected=null;ctx.activeVisit=null;ctx.workspace=null;ctx.formText='';drafts.clear();nodes['clinical-workspace'].hidden=true;activeNav=null;ctx.page='Sign in';};
 ctx.encounterClaimRoute=()=>null;ctx.encounterFileRoute=()=>null;
  ctx.enter=async()=>ctx.showPracticeWorkspace();
  vm.createContext(ctx);vm.runInContext(source,ctx);
  // The real reload: whatever enter() leaves in the address bar says #/home.
  if(enterLandsOnHome){const real=ctx.history.replaceState.bind(ctx.history);let armed=true;ctx.history.replaceState=(value,_,url)=>{if(armed&&url!=='/'){armed=false;return real(value,_,'/#/home');}return real(value,_,url);};}
 const settle=async()=>{for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r));};
 return {ctx,history,nodes,calls,drafts,settle,entries:()=>clone(entries),directoryShown:()=>/Open a patient chart|Patient directory/.test(nodes.chart.innerHTML)};
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('reload reopens the same patient, encounter and step of that encounter',async()=>{
 const f=fixture({hash:`#/patients/${patient}/encounter/${visit}/charges`}),c=f.ctx;
 await c.enter();await f.settle();
 assert.equal(c.selected,patient);assert.equal(c.activeVisit.id,visit);assert.equal(c.chartSection,'visits');assert.equal(c.encounterSection,'charges');
 assert.equal(c.page,'Patients & encounters');assert.equal(c.mutations,0,'a reload only reads the record back');
 assert.equal(f.directoryShown(),false,'the reopened chart does not fall back to the directory');
 assert.equal(f.entries().length,1,'reopening the address on reload does not add a history entry');
 assert.equal(c.location.hash,`#/patients/${patient}/encounter/${visit}/charges`,'the address still names the reopened encounter');
});

// The browser bug: the address the page was loaded with is read before enter() runs, because
// enter() shows Home and its remember() overwrites the address with #/home first.
test('a real reload where enter() leaves #/home in the address still reopens the loaded chart',async()=>{
 const f=fixture({hash:`#/patients/${patient}/encounter/${visit}/documentation`,enterLandsOnHome:true}),c=f.ctx;
 await c.enter();await f.settle();
 assert.equal(c.selected,patient,'the loaded patient is opened');
 assert.equal(c.activeVisit?.id,visit,'the loaded visit is opened');
 assert.equal(c.chartSection,'visits');assert.equal(c.encounterSection,'documentation','the loaded step is shown');
 assert.equal(c.location.hash,`#/patients/${patient}/encounter/${visit}/documentation`,'the final address is the loaded one, not #/home');
 assert.equal(c.page,'Patients & encounters');assert.equal(c.mutations,0,'the reopen only reads the record back');
});

test('a reload loaded on #/home or no address behaves as before',async()=>{
 for(const hash of ['#/home','']){
  const f=fixture({hash,enterLandsOnHome:true}),c=f.ctx;
  await c.enter();await f.settle();
  assert.equal(c.page,'Practice home',`loaded address ${hash||'(none)'} stays on Home`);
  assert.equal(c.selected,null);assert.equal(c.activeVisit,null);
  assert.equal(c.location.hash,'#/home');
  assert.equal(c.mutations,0);
 }
});

test('reload whose encounter was deleted keeps the chart and drops the dead step',async()=>{
 const f=fixture({hash:`#/patients/${patient}/encounter/${visit}/documentation`,visits:[]}),c=f.ctx;
 await c.enter();await f.settle();
 // The patient is still open and their record is shown; only the encounter that
 // was deleted is gone, so the encounter step is dropped rather than reported.
 assert.equal(c.selected,patient,'the patient stays open');
 assert.equal(c.activeVisit,null,'the deleted encounter is not opened');
 assert.equal(c.chartSection,'overview');
 assert.equal(f.directoryShown(),false,'this is the patient record, not the fallback prompt');
 assert.equal(f.calls.filter(call=>call[0]==='error').length,0,'a deleted encounter is not announced as a failure');
 assert.equal(c.location.hash,`#/patients/${patient}/overview`,'the address drops the encounter it cannot open');
 assert.equal(c.mutations,0,'recovery uses reads only');
});

test('a pasted address for a chart this person cannot open also falls back to the list',async()=>{
 const f=fixture({hash:`#/patients/${other}/encounter/${visit}/charges`}),c=f.ctx;
 // The record read fails, exactly as it does for a chart outside this person’s access.
 const workspaceReads=()=>f.calls.filter(call=>call[0]==='GET'&&call[1].startsWith('/patients/')).length;
 c.selectPatient=async id=>{await c.api(`/patients/${id}`);throw new Error('Not found');};
 await c.enter();await f.settle();
 assert.equal(f.directoryShown(),true);assert.equal(c.selected,undefined);assert.equal(c.activeVisit,undefined);assert.equal(c.workspace,undefined);assert.equal(c.chartSection,'overview');
 assert.ok(workspaceReads()>0,'the fallback follows an access check rather than a guess');
 assert.equal(f.calls.filter(call=>call[0]==='error').length,0,'an inaccessible chart is not announced as a failure');
 assert.equal(c.mutations,0);
});

test('a reload whose patient is gone leaves the patient list ready to use',async()=>{
 const f=fixture({hash:`#/patients/${patient}/encounter/${visit}/charges`}),c=f.ctx;
 // The patient was deleted: that record will not load, while other charts still do.
 const openChart=c.selectPatient;
 c.selectPatient=async(id,keepVisit)=>{if(id===patient)throw new Error('Not found');return openChart(id,keepVisit);};
 await c.enter();await f.settle();
 assert.equal(f.directoryShown(),true);assert.equal(c.selected,undefined);
 // Staff are not stranded: opening any listed patient still works from here.
 await c.run(async()=>{await c.showClinical();await c.selectPatient(other,visit);c.setEncounterSection('charges');});
 assert.equal(c.selected,other);assert.equal(c.activeVisit.id,visit);assert.equal(c.chartSection,'visits');assert.equal(c.encounterSection,'charges');
});

test('the address carries only identifiers and never a patient name',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();
 await c.run(async()=>{await c.showClinical();await c.selectPatient(patient,visit);c.setEncounterSection('charges');});
 assert.equal(c.location.hash,`#/patients/${patient}/encounter/${visit}/charges`);
 assert.doesNotMatch(c.location.hash,/[A-Z][a-z]+, [A-Z][a-z]+/,'the address carries no patient name');
 assert.doesNotMatch(c.location.hash,/MRN|SOAP|note/i,'the address carries no record content');
 // The directory row and the chart banner do show the name; none of it may reach
 // the address, the saved history, or the screen left up after a failed reload.
 f.nodes.chart.innerHTML=`<button data-patient="${patient}">Doe, Jane<small>MRN A-1</small></button>`;
 f.nodes['clinical-workspace'].innerHTML='Doe, Jane';
 assert.doesNotMatch(f.history.state.sunchartsNavigation.url,/[A-Z][a-z]+, [A-Z][a-z]+/,'the saved address carries no name');
 assert.equal(JSON.stringify(f.entries()).includes('Doe'),false,'saved history carries no name');
  // A reload whose encounter is gone keeps the record, and names no patient either way.
  const gone=fixture({hash:c.location.hash,visits:[]});
  await gone.ctx.enter();await gone.settle();
  assert.equal(gone.nodes.chart.innerHTML.includes('Doe'),false,'the recovered chart names no patient beyond the record itself');
  assert.equal(JSON.stringify(gone.entries()).includes('Doe'),false,'its saved history names no patient');
  // A reload whose patient cannot be opened leaves the chart pane on its prompt.
  const missing=fixture({hash:c.location.hash});
  missing.ctx.selectPatient=async()=>{throw new Error('Not found');};
  await missing.ctx.enter();await missing.settle();
  assert.match(missing.nodes.chart.innerHTML,/Open a patient chart/,'an unavailable chart invites staff to choose a patient');
  assert.equal(missing.nodes.chart.innerHTML.includes('Doe'),false,'that screen names no patient');
  assert.equal(JSON.stringify(missing.entries()).includes('Doe'),false,'its saved history names no patient');
});

test('sign-out clears the chart address so the next person never reopens it',async()=>{
 const f=fixture(),c=f.ctx;await c.enter();
 await c.run(async()=>{await c.showClinical();await c.selectPatient(patient,visit);c.setEncounterSection('charges');});
 assert.equal(c.location.hash,`#/patients/${patient}/encounter/${visit}/charges`);
 c.signInScreen();
 // The next person to sign in on this machine gets their own landing screen.
 c.me={tenant_id:'tenant-b',user_id:'staff-b',role:'owner'};await c.enter();await f.settle();
 assert.equal(c.selected,null);assert.equal(c.activeVisit,null);
 assert.equal(JSON.stringify(f.entries()).includes(patient),false,'the previous person’s chart is not left in the address or history');
});

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+error.message);}}if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
