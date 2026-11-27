// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic fixtures exercise Home's real event dispatcher, directory queries and history wrapper.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=file=>fs.readFileSync(file,'utf8');
async function main(){
 const nodes=new Map(),listeners={},events={},calls=[],entries=[];
 let activeNav='nav-practice',patientBillingRoute=null;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,hidden:id==='clinical-workspace',value:'',innerHTML:'',outerHTML:'',textContent:'',setAttribute(){},focus(){},scrollIntoView(){},insertAdjacentHTML(_where,html){this.innerHTML=html;}});return nodes.get(id);};
 const c={console,Date,Intl,URLSearchParams,URL,Map,Set,WeakSet,Promise,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),
 me:{tenant_id:'synthetic-tenant',user_id:'synthetic-staff',role:'owner'},$:node,selected:null,activeVisit:null,workspace:null,chartSection:'overview',patients:[],cursor:null,
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),money:n=>'$'+(n/100).toFixed(2),displayStatus:s=>s,displayPerson:s=>s,displayCount:(n,s)=>`${n} ${s}`,displayBirthDate:s=>s,displayDate:s=>s,invoicePaymentMethod:s=>s,
 localTime:value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T00:00`;},
 document:{addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn),querySelectorAll:()=>[],querySelector:()=>({id:activeNav})},
 location:{pathname:'/',search:'',hash:''},captureVisitDrafts(){},scrollTo(){},addEventListener:(type,fn)=>(events[type]??=[]).push(fn),
 showTool:title=>{activeNav=title.startsWith('Billing')?'nav-billing':title.startsWith('Claims')?'nav-claims':'nav-practice';patientBillingRoute=null;node('clinical-workspace').hidden=true;node('tools').hidden=false;},
 run:fn=>{c.pending=Promise.resolve().then(fn);return c.pending;},
 api:async path=>{calls.push(path);return {items:[],next_cursor:null};},
 patientBillingRoute:()=>patientBillingRoute,
 showPatientBillingWorkspace:async options=>{calls.push(['billing',options]);c.showTool('Billing');patientBillingRoute={patient:options.patientId,tab:options.tab,surface:'global'};},
 showClaimsWorkspace:async({filter}={})=>{calls.push(['claims-filter',filter]);c.showTool('Claims');},
 selectPatient:async(patient,visit,_stillCurrent,destination)=>{
  calls.push(['patient',patient,visit,destination.section,destination.step]);
  c.selected=patient;c.chartSection=destination.section;c.activeVisit=visit?{id:visit}:null;c.workspace={patient:{id:patient}};
  node('clinical-workspace').hidden=false;
 },
 showClinical:async()=>{calls.push(vm.runInContext('patientDirectoryQuery()',c));node('clinical-workspace').hidden=false;},
 };
 c.window=c;
 c.history={state:null,replaceState(state,_,url){this.state=state;c.location.hash=new URL(url,'https://synthetic.test').hash;},pushState(state,_,url){entries.push({state,url});this.replaceState(state,_,url);},back(){}};
 vm.createContext(c);
 vm.runInContext(read('web/practice.js'),c);vm.runInContext(read('web/patient-lifecycle.js'),c);vm.runInContext(read('web/billing-overview.js'),c);
 const app=read('web/app.js');vm.runInContext(app.slice(app.indexOf('function renderPatients()'),app.indexOf('async function selectPatient(')),c);
 vm.runInContext(app.slice(app.indexOf('async function frameSelectPatient('),app.indexOf('async function frameClosePatient(')),c);
 const home={start:new Date(),schedule:{},appointments:[],unfinished:{total:1,items:[{patient_id:'synthetic-patient',visit_id:'synthetic-visit',patient_name:'Synthetic Example',created_at:'2026-11-25T12:00:00Z'}]},overview:{money:{},patients:{}},inbox:{items:[]},followup:{items:[]},referrals:{items:[]}};
 c.fixture=home;vm.runInContext('practiceData=fixture',c);
 // The production history wrapper tracks the supported Billing entry point.
 c.showPracticeWorkspace=async()=>c.showTool('Home');
 vm.runInContext(read('web/navigation-history.js'),c);await c.showPracticeWorkspace();
 assert.equal(c.location.hash,'#/home');
 async function click(action){
  const dataset=typeof action==='string'?{practiceAction:action}:action;
  const button={dataset,hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()))};
  const event={target:{closest:selector=>selector==='button,a[data-practice-action]'?button:null},preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
  for(const fn of listeners.click)fn(event);
  await c.pending;assert(event.prevented&&event.stopped);
 }
 for(const action of ['claims-send','claims-fix','claims-wait']){
  const filter=action.slice('claims-'.length);
  await click(action);assert.equal(c.location.hash,`#/claims/${filter}`);
  assert.deepEqual(calls.at(-1),['claims-filter',{'claims-send':'send','claims-fix':'fix','claims-wait':'wait'}[action]]);
 }
 await click('billing');assert.equal(c.location.hash,'#/billing/overview');assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['billing',{patientId:null,tab:'overview'}]);
 assert.equal(c.history.state.sunchartsNavigation.route.view,'patientBilling');
 assert(entries.some(entry=>entry.url==='/#/billing/overview'));
 await click('notes');assert.match(node('practice-worklist').innerHTML,/Unfinished patient encounters across all dates/);assert.match(node('practice-worklist').innerHTML,/synthetic-visit/);
 await click('today');assert.match(node('practice-worklist').innerHTML,/No active appointments today/);
 for(const missing of ['address','phone']){
  await click('missing-'+missing);
  assert.equal(calls.at(-1),'/api/v1/patients?status=active&missing='+missing);
  assert.equal(vm.runInContext("patientDirectoryQuery('synthetic-cursor')",c),`/api/v1/patients?status=active&missing=${missing}&after=synthetic-cursor`);
  c.renderPatients();assert.match(node('patients').innerHTML,new RegExp(`Showing: missing ${missing} ·`));assert.match(node('patients').innerHTML,/data-directory-missing-clear/);
 }
 await c.openMissingPatients('');c.renderPatients();assert.doesNotMatch(node('patients').innerHTML,/Showing: missing/);assert.equal(calls.at(-1),'/api/v1/patients?status=active');
 await click({practicePatient:'synthetic-patient'});
 assert.deepEqual(calls.at(-1),['patient','synthetic-patient',undefined,'overview',undefined]);
 await click({practiceVisit:'synthetic-visit',practiceVisitPatient:'synthetic-patient'});
 assert.deepEqual(calls.at(-1),['patient','synthetic-patient','synthetic-visit','visits','visit']);
 await c.showPracticeWorkspace();
 c.patientPickerMatches=()=>true;
 vm.runInContext("practicePatients=[{id:'synthetic-keyboard-patient'}];practiceQuery='synthetic'",c);
 const enter={key:'Enter',target:node('practice-search'),preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
 for(const handler of listeners.keydown)handler(enter);
 await c.pending;assert(enter.prevented&&enter.stopped);
 assert.deepEqual(calls.at(-1),['patient','synthetic-keyboard-patient',undefined,'overview',undefined]);
 c.selected=null;c.activeVisit=null;
 // The Home amount opens the server-paged collections screen and retains its route.
 c.api=async path=>{
  calls.push(path);
  assert.match(path,/^\/api\/v1\/billing\/collections\/today\?/);
  return {day:'2026-11-25',total_cents:2900,next_cursor:'next',items:[{id:'receipt',source:'copay',amount_cents:900,patient_name:'Synthetic Example',patient_id:'patient-a'},{id:'payment',source:'ledger',party:'insurer',amount_cents:2000,account_id:'account',patient_name:'Synthetic Example',patient_id:'patient-a'}]};
 };
 await click('collected');assert.equal(c.location.hash,'#/billing/collected-today');
 assert.match(node('billing-collections-list').innerHTML,/\$29\.00 collected/);assert.match(node('billing-collections-list').innerHTML,/data-overview-receipt="receipt"/);assert.match(node('billing-collections-list').innerHTML,/data-account="account"/);assert.match(node('billing-collections-list').innerHTML,/data-collections-after="next"/);
 // Guard the tenant scope and filter-before-pagination contract of the server query.
 const postgres=read('src/postgres.rs'),query=postgres.slice(postgres.indexOf('async fn patients('),postgres.indexOf('async fn workspace('));
 const predicates=read('src/patient_lifecycle.rs');
 assert.match(query,/p\.tenant_id=\$1/);assert.match(query,/d\.tenant_id=p\.tenant_id AND d\.patient_id=p\.id/);
 assert.match(query,/field\.predicate\(\)[^]*AND \{predicate\}\s*ORDER BY p\.id LIMIT 51/);
 assert.match(query,/\.bind\(a\.tenant_id\)\s*\.bind\(after\)\s*\.bind\(status\.archived\(\)\)/);
 assert.match(predicates,/MISSING_ADDRESS: &str = "coalesce\(btrim\(d\.content->'address'->>'line1'\),''\)=''"/);
 assert.match(predicates,/MISSING_PHONE: &str = "coalesce\(btrim\(d\.content->>'phone'\),''\)=''"/);
 console.log('PASS Home count dispatch, unfinished encounters, missing-contact paging and clear, waiting claims, Billing address and today’s recorded payment list');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
