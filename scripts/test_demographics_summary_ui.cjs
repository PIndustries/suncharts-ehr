// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('web/app.js','utf8'),source=fs.readFileSync('web/demographics.js','utf8');
const summary=app.slice(app.indexOf('function chartContactSummary(){'),app.indexOf('function chartOverview(){'));
function fixture(){
 const listeners={},notices=[],nodes={phone:{textContent:'Not recorded'},email:{textContent:'Not recorded'},label:{textContent:'PATIENT CHART'},intake:{textContent:'1 intake form · 1 submitted awaiting review'}};
 const error={hidden:true,textContent:''},controls=[{isConnected:true,disabled:false},{isConnected:true,disabled:false}];
 const form={id:'demographics-form',dataset:{},isConnected:false,values:{phone:'202-555-0101',email:'audit.journey@example.test',preferred_name:'Synthetic preferred',reason:'Synthetic contact correction'},querySelector:selector=>selector==='[data-demographics-error]'?error:{focus(){}},querySelectorAll:()=>controls};
 let html='';const host={get innerHTML(){return html;},set innerHTML(value){html=value;form.isConnected=value.includes('<form id="demographics-form"');}};
 const chart={querySelector:selector=>selector==='[data-chart-contact="phone"]'?nodes.phone:selector==='[data-chart-contact="email"]'?nodes.email:selector==='.chart-record-label'?nodes.label:null};
 const initial={version:0,content:{},history:[]};
 const c=vm.createContext({console,selected:'p1',me:{user_id:'owner1',role:'owner'},workspace:{patient:{id:'p1'},demographics:initial},chartSection:'profile',document:{addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn)},$:(id)=>id==='chart'?chart:id==='patient-demographics'?host:id==='demographics-form'?form:null,esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),date:v=>v,chartAreaEnabled:()=>true,api:async()=>initial,notice:message=>notices.push(message),run:fn=>fn(),FormData:class{constructor(f){this.values=f.values;}*[Symbol.iterator](){yield*Object.entries(this.values);}},renderChart:()=>{throw Error('Contact save must not redraw unrelated chart editors');}});
 vm.runInContext(summary+'\n'+source,c);
 const run=code=>vm.runInContext(code,c);
 return {c,run,host,form,nodes,error,controls,initial,notices,async edit(){await run('renderDemographics(selected,workspace.demographics)');run('demographicsEdit()');},submit(){return Promise.all(listeners.submit.map(fn=>fn({target:form,preventDefault(){}})));}};
}
function saved(content={}){return {version:1,content:{phone:'202-555-0101',email:'audit.journey@example.test',preferred_name:'Synthetic preferred',...content},history:[]};}
(async()=>{
 let f=fixture();await f.edit();const requests=[];f.c.api=async(...args)=>{requests.push(args);return saved();};await f.submit();
 assert.equal(requests.length,1);assert.equal(requests[0][1],'PUT');assert.equal(requests[0][3],0);
 assert.equal(f.nodes.phone.textContent,'202-555-0101');assert.equal(f.nodes.email.textContent,'audit.journey@example.test');assert.equal(f.nodes.label.textContent,'PATIENT CHART · Preferred name Synthetic preferred');
 assert.equal(f.nodes.intake.textContent,'1 intake form · 1 submitted awaiting review');assert.equal(f.c.chartSection,'profile');assert.equal(f.c.workspace.demographics.version,1);assert.match(f.host.innerHTML,/Blank fields have not been collected yet/);
 console.log('PASS saved contact immediately updates existing Overview and preferred-name header without chart reload or intake reset');

 f=fixture();await f.edit();f.c.api=async()=>saved({phone:null,email:'<img src=x onerror=alert(1)>',preferred_name:null});await f.submit();
 assert.equal(f.nodes.phone.textContent,'Not recorded');assert.equal(f.nodes.email.textContent,'<img src=x onerror=alert(1)>');assert.equal(f.nodes.label.textContent,'PATIENT CHART');assert.match(f.host.innerHTML,/&lt;img/);
 assert.match(f.run('chartContactSummary()'),/data-chart-contact="phone"/);assert.match(f.run('chartContactSummary()'),/data-chart-contact="email"/);
 console.log('PASS cleared contact fields and untrusted values update as plain text');

 for(const change of ['patient','session','workspace']){
  f=fixture();await f.edit();let finish;f.c.api=()=>new Promise(resolve=>finish=resolve);const pending=f.submit();assert.ok(f.controls.every(c=>c.disabled));
  if(change==='patient')f.c.selected='p2';else if(change==='session')f.c.me={user_id:'owner1',role:'owner'};else f.c.workspace={patient:{id:'p1'},demographics:{version:8,content:{phone:'New chart'}}};
  const current=f.c.workspace;finish(saved());await pending;assert.equal(f.c.workspace,current);assert.notEqual(f.c.workspace.demographics.version,1);assert.equal(f.nodes.phone.textContent,'Not recorded');assert.equal(f.notices.length,0);
 }
 console.log('PASS late saves cannot publish into another patient, session, or reopened chart');

 f=fixture();await f.edit();let finish;f.c.api=()=>new Promise(resolve=>finish=resolve);const pending=f.submit();await f.run('renderDemographics(selected,{version:9,content:{phone:"More recent contact"},history:[]})');finish(saved());await pending;
 assert.match(f.host.innerHTML,/More recent contact/);assert.equal(f.nodes.phone.textContent,'Not recorded');assert.equal(f.notices.length,0);
 console.log('PASS a late save does not replace a newer contact view');

 f=fixture();await f.edit();f.c.api=async()=>{throw Error('Version conflict');};await f.submit();assert.equal(f.form.values.phone,'202-555-0101');assert.equal(f.form.isConnected,true);assert.equal(f.error.hidden,false);assert.match(f.error.textContent,/Version conflict.*edits remain/);assert.equal(f.nodes.phone.textContent,'Not recorded');assert.ok(f.controls.every(c=>!c.disabled));
 console.log('PASS failed contact saves retain entered values and existing Overview');

 f=fixture();f.c.api=async()=>saved();await f.run('showPatientDemographics(selected)');assert.equal(f.nodes.phone.textContent,'202-555-0101');
 f=fixture();let resolve;f.c.api=()=>new Promise(r=>resolve=r);const reading=f.run('showPatientDemographics(selected)');f.c.me={user_id:'owner1',role:'owner'};resolve(saved());await reading;assert.equal(f.c.workspace.demographics.version,0);assert.equal(f.nodes.phone.textContent,'Not recorded');
 console.log('PASS explicit contact reload updates the summary and refuses an earlier session result');
})().catch(error=>{console.error(error);process.exit(1);});
