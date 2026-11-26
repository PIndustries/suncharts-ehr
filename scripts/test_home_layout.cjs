// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic Home and Billing fixtures; no network or patient data.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=path=>fs.readFileSync(path,'utf8'),nodes=new Map(),listeners={},calls=[];
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',outerHTML:'',hidden:false,textContent:'',setAttribute(){},focus(){calls.push('focus');},scrollIntoView(){calls.push(id);}});return nodes.get(id);};
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const c=vm.createContext({console,Date,Intl,URLSearchParams,esc,money:n=>'$'+(n/100).toFixed(2),displayStatus:s=>s,displayPerson:s=>s,displayCount:(n,s)=>`${n} ${s}`,patientPickerMatches:()=>false,patientPickerRowHtml:()=>'',me:{role:'owner'},$:node,document:{addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),querySelectorAll:()=>[]},run:fn=>fn()});
vm.runInContext(read('web/practice.js'),c);
const fixture={start:new Date(2026,10,24),schedule:{},appointments:[{id:'synthetic-appt',patient_id:'synthetic-patient',patient_name:'Synthetic <Avery>',title:'Follow-up',starts_at:'2026-11-24T14:00:00Z',ends_at:'2026-11-24T14:30:00Z',status:'in_progress'}],unfinished:{total:1,items:[{appointment_id:'synthetic-appt',visit_id:'synthetic-visit',note_saved:true}]},inbox:{items:[]},followup:{items:[]},referrals:{items:[]},overview:{claims:{by_status:{}},money:{collected_today_cents:1000,collected_month_cents:3000,charges_month_cents:5000,waiting_on_insurers_cents:2000}}};
c.fixture=fixture;vm.runInContext('practiceData=fixture;renderPracticeWorkspace()',c);
const home=node('practice-home').outerHTML,table=node('practice-worklist').innerHTML,css=read('web/practice-overview.css');
assert.match(home,/Today · Tuesday, November 24/);
for(const action of ['appointment','find-patient','today','notes','claims-send','claims-fix','collected','trends','billing','results','intake','tasks','schedule','claims','claims-wait'])assert.match(home,new RegExp(`data-practice-action="${action}"`));
const moneyWithWaiting=amount=>c.practiceMoneyMarkup({overview:{money:{waiting_on_insurers_cents:amount}}});
c.workspaceResourceAllowed=resource=>['billing','claims'].includes(resource);
assert.match(moneyWithWaiting(2000),/data-practice-action="claims-wait"[^]*\$20\.00<\/button>/);
assert.match(moneyWithWaiting(0),/data-practice-action="claims-wait"[^]*\$0\.00<\/button>/);
assert.match(moneyWithWaiting(null),/Waiting on insurers<\/dt><dd>—<\/dd>/);
assert.doesNotMatch(moneyWithWaiting(null),/data-practice-action="claims-wait"/);
c.workspaceResourceAllowed=resource=>resource==='billing';
assert.match(moneyWithWaiting(2000),/Waiting on insurers<\/dt><dd>\$20\.00<\/dd>/);
assert.doesNotMatch(moneyWithWaiting(2000),/data-practice-action="claims(?:-wait)?"/);
c.workspaceResourceAllowed=()=>true;
node('nav-claims').hidden=true;
assert.match(moneyWithWaiting(2000),/Waiting on insurers<\/dt><dd>\$20\.00<\/dd>/);
node('nav-claims').hidden=false;
assert.match(home,/id="practice-search" type="search"/);
const counts=c.practiceDashboardMarkup(fixture);
assert.equal((counts.match(/data-practice-action=/g)||[]).length,5);
assert.equal((counts.match(/<a href=/g)||[]).length,5);
assert.match(home,/data-practice-action="claims-wait"/);
assert.match(home,/data-practice-action="missing-address"/);assert.match(home,/data-practice-action="missing-phone"/);
assert.match(css,/practice-tile:focus-visible/);
assert.doesNotMatch(c.practiceDashboardMarkup({...fixture,unfinished:{total:0}}),/is-attention/);
assert.match(table,/<th scope="col">Stage<\/th>/);
assert.match(table,/class="practice-stage stage-wrap-up">Wrap-up/);
assert.match(table,/Synthetic &lt;Avery>/);
assert.deepEqual([...table.matchAll(/<th scope="col">([^<]+)/g)].map(m=>m[1]),['Time','Patient','Encounter type','Stage','Status']);
assert.doesNotMatch(home,/practice-home-links/);assert.match(home,/practice-needs[^]*data-practice-action="intake"/);
assert.doesNotMatch(home,/practice-chart|practice-journey|Last 30 days|Where patients are today|practice-queue-sidebar/);
assert.match(css,/#app #tools:has\(>.practice-home\)\{[^}]*border:0;[^}]*background:transparent;box-shadow:none/);
assert.match(css,/#app \.practice-home\{max-width:1280px;[^}]*margin-inline:auto;[^}]*border:0/);
assert.match(css,/\.practice-tile\{[^}]*border:0;border-radius:0/);
assert.match(table,/class="practice-table-wrap" tabindex="0" role="region" aria-labelledby="practice-board-title"/);
assert.match(css,/\.practice-home \.practice-table th:first-child,\.practice-home \.practice-table td:first-child\{padding-left:16px\}/);
assert.match(css,/@media\(max-width:1000px\)\{\.practice-home \.practice-board-layout\{grid-template-columns:1fr\}/);
for(const [a,v,expected]of [[{status:'booked',id:'intake'},null,'Intake'],[{status:'checked_in'},null,'Ready'],[{status:'in_progress'},null,'Encounter'],[{}, {note_saved:true},'Wrap-up'],[{status:'completed',visit_id:'claim'},null,'Claim'],[{status:'completed',visit_id:'follow'},null,'Wrap-up'],[{status:'completed',visit_id:'claim'},{note_saved:true},'Claim']]){
 c.fixture.previsit={items:[{appointment_id:'intake',status:'submitted'}]};c.fixture.claims={items:[{visit_id:'claim'}]};c.fixture.followup={items:[{visit_id:'follow'}]};assert.equal(c.practiceStage(a,v),expected);
}
for(const status of ['draft','ready','rejected','submitted','accepted','adjudicated','paid']){c.fixture.claims={items:[{visit_id:'completed',status}]};assert.equal(c.practiceStage({status:'completed',visit_id:'completed'},{note_saved:true}),['submitted','accepted','adjudicated','paid'].includes(status)?'Done':'Claim');}
assert.equal(c.practiceStage({status:'completed'},null),'Wrap-up','missing billing evidence never implies nothing to bill');
for(const [claim,expected] of [[{status:'not_sent'},'Claim'],[{status:'rejected'},'Claim'],[{status:'sent'},'Done'],[{status:'accepted'},'Done'],[null,'Done']]){
 c.fixture.markers={items:[{appointment_id:'completed-appt',charges:claim?'posted':'none',claim}]};
 assert.equal(c.practiceStage({id:'completed-appt',status:'completed'},{note_saved:true}),expected);
}
for(const [facts,expected] of [[{note:'in_progress',charges:'none',claim:null},'Wrap-up'],[{note:'not_started',charges:'none',claim:null},'Wrap-up'],[{note:'signed',charges:'draft',claim:null},'Wrap-up'],[{note:'signed',charges:'none',claim:null},'Done'],[{note:'signed',charges:'posted'},'Wrap-up'],[{note:null,charges:null,claim:null},'Wrap-up']]){
 c.fixture.markers={items:[{appointment_id:'stage-appt',...facts}]};
 assert.equal(c.practiceStage({id:'stage-appt',status:'completed'},null),expected,JSON.stringify(facts));
}
delete c.fixture.markers;
const trend=Array.from({length:30},(_,i)=>({day:`2026-11-${String(i+1).padStart(2,'0')}`,charges_cents:i*100,collected_cents:i*50}));
const chart=c.practiceTrend(trend);assert.equal((chart.match(/<rect /g)||[]).length,60);assert.doesNotMatch(chart,/polyline/);assert.match(chart,/<text[^>]*>Nov 1<\/text>/);assert.match(chart,/<text[^>]*>Nov 30<\/text>/);assert.doesNotMatch(c.practiceTrend([trend[0]]),/NaN|Infinity/);
vm.runInContext(read('web/billing-overview.js'),c);
const data={mode:'recorded',summary:{accounts:{},copays:{}},accounts:{items:[]},copays:{items:[]}};
assert.match(c.billingOverviewMarkup(data),/id="billing-overview-trends"[^]*<h3>Trends<\/h3>/);
(async()=>{
 c.showTool=()=>{};c.api=async path=>{calls.push(path);return path.startsWith('/api/v1/schedule/markers?')?{items:[{appointment_id:'synthetic-appt',charges:'posted',claim:{status:'not_sent'}}]}:path.startsWith('/api/v1/schedule?')?{appointments:[{...fixture.appointments[0],status:'completed'}]}:path==='/api/v1/practice/worklist'?{items:[],total:0}:{items:[]};};
 await c.showPracticeWorkspace();assert.match(node('practice-worklist').innerHTML,/stage-claim/);assert(calls.some(p=>p.startsWith('/api/v1/schedule/markers?from=')&&p.includes('&to=')));
 c.api=async path=>{calls.push(path);return {...fixture.overview,patients:{insured:2,self_pay:1,active:3},trend};};
 await c.loadBillingOverviewTrends({identity:c.me,generation:0,host:node('billing-overview')});
 assert.match(node('billing-overview-trends').innerHTML,/Last 30 days/);assert.match(node('billing-overview-trends').innerHTML,/Self-pay/);
 assert(calls.some(x=>x.startsWith('/api/v1/practice/overview?tz=')));
 c.api=async()=>{throw Error('Synthetic unavailable');};await c.loadBillingOverviewTrends({identity:c.me,generation:0,host:node('billing-overview')});assert.match(node('billing-overview-trends').innerHTML,/data-overview-trends-retry/);
 console.log('PASS flat Home, linked counts, stage pills, responsive theme styles, Waiting on insurers access and Billing daily-bar trends');

 const events={},entries=[];let index=-1,active,billing,dispatch;
 Object.assign(c,{window:c,location:{pathname:'/',search:'',hash:''},scrollX:0,scrollY:0,scrollTo(){},captureVisitDrafts(){},requestAnimationFrame:callback=>callback(),addEventListener:(name,fn)=>events[name]=fn});
 c.run=fn=>dispatch=fn();
 c.api=async path=>{calls.push(path);return path.startsWith('/api/v1/practice/overview?')?fixture.overview:{items:[],appointments:[]};};
 c.showTool=title=>{active=title;};
 c.document.querySelector=()=>null; // The visible Billing tab is outside the menu's route lookup.
 c.showPatientBillingWorkspace=async options=>{billing={patient:options.patientId,surface:'global',tab:options.tab};c.showTool('Billing & insurance');};
 c.patientBillingRoute=()=>active==='Billing & insurance'?billing:null;
 c.restorePatientBillingRoute=route=>c.showPatientBillingWorkspace({patientId:route.patient,tab:route.tab});
 c.showClaimsWorkspace=async options=>{calls.push(['claims',options?.filter]);c.showTool('Claims & remittances');};
 node('clinical-workspace').hidden=true;
 const go=to=>{index=to;c.location.hash=new URL(entries[index].url,'https://synthetic.test').hash;};
 c.history={get state(){return entries[index]?.state??null;},replaceState(state,_,url){if(index<0)index=0;entries[index]={state,url};go(index);},pushState(state,_,url){entries.splice(index+1);entries.push({state,url});go(entries.length-1);},back(){go(index-1);events.popstate({state:this.state});},forward(){go(index+1);events.popstate({state:this.state});}};
 vm.runInContext(read('web/navigation-history.js'),c);
 const click=async action=>{
  const button={dataset:{practiceAction:action},hasAttribute:name=>name==='data-practice-action'};
  listeners.click[0]({target:{closest:()=>button},preventDefault(){},stopImmediatePropagation(){}});
  await dispatch;
 };
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 await c.showPracticeWorkspace();assert.equal(c.location.hash,'#/home');
 await click('billing');assert.equal(c.location.hash,'#/billing/overview');assert.equal(billing.patient,null);
 c.history.back();await settle();assert.equal(c.location.hash,'#/home');assert.equal(active,'Practice overview');
 c.history.forward();await settle();assert.equal(c.location.hash,'#/billing/overview');assert.equal(active,'Billing & insurance');
 c.history.back();await settle();
 await click('claims-wait');assert.equal(c.location.hash,'#/claims/wait');assert.deepEqual(calls.at(-1),['claims','wait']);
 c.workspaceResourceAllowed=resource=>resource!=='claims';
 const before=calls.length;await click('claims-wait');assert.equal(calls.length,before);
 c.history.back();await settle();
 assert.ok(!calls.slice(before).includes('/api/v1/billing/claims'),'restricted Home reload does not read the claims list');
 c.location.hash='#/billing/overview';events.hashchange();await settle();
 assert.equal(active,'Billing & insurance');assert.equal(billing.patient,null);
 console.log('PASS Home opens practice-wide Billing with Back, Forward and direct address restoration, and opens the Waiting claims filter only with access');
})().catch(error=>{console.error(error);process.exitCode=1;});
