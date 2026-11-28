// SPDX-License-Identifier: AGPL-3.0-only
// Run with node scripts/check_chart_handoffs_browser.cjs. CHART_TEST_BROWSER may point to a Chrome executable.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const web = path.resolve(__dirname, '../web');
const origin = 'http://127.0.0.1:18095';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const staff = {user_id:id(11), tenant_id:id(12), role:'owner', display_name:'Synthetic owner', email:'staff@example.invalid'};
const people = ['Avery','River'].map((given_name,i) => ({id:id(21+i), given_name, family_name:'Example', mrn:'SYN-'+i, birth_date:'1990-01-01', status:'active'}));
const [first,second] = people;
const timestamp = '2026-11-24T17:00:00Z';
const note = {subjective:'Synthetic chart note', objective:'Synthetic observation', assessment:'Synthetic assessment', plan:'Synthetic follow-up'};
const visits = people.map((p,i) => ({id:id(50+i), patient_id:p.id, clinician_id:staff.user_id, encounter_number:7+i, version:3, status:'signed', created_at:timestamp, signed_at:timestamp, note, vitals:{}}));
const homeVisits=[0,1].map(i=>({...visits[0], id:id(56+i), appointment_id:id(70+i), encounter_number:20+i, status:'in_progress', signed_at:null}));
const claims = ['draft','submitted'].map((status,i) => ({id:id(61+i), status, patient_id:people[i].id, patient_name:people[i].given_name+' Example', control_number:'SYN-CLAIM-'+i, payer_name:'Synthetic plan', total_cents:11000, service_date:'2026-11-24', created_at:timestamp, version:2, content:{}, claimmd_position:i?{acknowledged:true}:null}));
const referrals = ['Clinic follow-up A','Clinic follow-up B'].map((requested_service,i) => ({id:id(81+i), patient_id:first.id, patient_label:'Example, Avery', mrn:first.mrn, status:'ready', version:1, overdue:true, content:{requested_service, recipient:'Synthetic practice', priority:'routine'}, history:[], events:[], documents:[]}));
const list = items => ({items, total:items.length, next_cursor:null});
const empty = {...list([]), providers:[], appointments:[], blocks:[], events:[], forms:[], orders:[], results:[], entries:[], history:[], reviews:[], acknowledgments:[], specimens:[], reports:[], variants:[], options:[]};

function apiFixture(route) {
 if (route==='/auth/me') return staff;
 if (route==='/api/v1/connect/status') return {status:'not_connected', services:{configured:false}, transport:{configured:false}};
 if (route==='/api/v1/practice/overview') return {money:{waiting_on_insurers_cents:21000,collected_today_cents:12500}, claims:{statuses:{},needs_correction:0}};
 if (route==='/api/v1/billing/collections/today') return {day:'2026-11-24',total_cents:12500,next_cursor:null,items:[
  {id:id(37),patient_id:first.id,patient_name:'Avery Example',mrn:first.mrn,source:'copay',method:'cash',amount_cents:2500},
  {id:id(38),patient_id:second.id,patient_name:'River Example',mrn:second.mrn,source:'ledger',method:'card',invoice_id:id(39),account_id:id(40),amount_cents:10000}
 ]};
 if (route==='/api/v1/billing/claims') return list(claims);
 if (route==='/api/v1/billing/era-automation') return {feeds:[],items:[],events:[]};
 if (route==='/api/v1/patients') return list(people);
 if (route==='/api/v1/schedule') return {appointments:homeVisits.map(visit=>({id:visit.appointment_id, patient_id:first.id, patient_name:'Avery Example', starts_at:timestamp, ends_at:timestamp, status:'checked_in'}))};
 if (route==='/api/v1/practice/worklist') return list(homeVisits.map(visit=>({...visit, visit_id:visit.id, patient_name:'Avery Example', mrn:first.mrn})));
 if (route==='/api/v1/referrals/worklist') return list(referrals);
 for (const [i,patient] of people.entries()) {
  const base='/api/v1/patients/'+patient.id, visit=visits[i];
  if (route===base) return patient;
  if (route===base+'/workspace') return {patient, visits:i===0?[visit,...homeVisits]:[visit], appointments:[], amendments:[], flags:[]};
  if (route===base+'/billing') return {patient, accounts:[], coverages:[], claims:[], entries:[]};
  if (route===base+'/billing/visit-summary') return {visit, state:'self_pay_collect', charges_cents:0, insurance:{insured:false}, patient:{owes_now_cents:0}};
  if (route===base+'/banner') return {patient_id:patient.id, revision:'synthetic', billing:{patient_due_cents:0}, eligibility:[], flags:{}};
  if (route===base+'/demographics') return {content:{}, items:[]};
  const byPatient=referrals.filter(r=>r.patient_id===patient.id);
  if (route===base+'/referrals') return list(byPatient);
  const referral=byPatient.find(r=>route===base+'/referrals/'+r.id);
  if (referral) return referral;
  const encounter='/api/v1/visits/'+visit.id;
  if (route===encounter) return visit;
  if (route===encounter+'/note-authorship') {
   const author={id:staff.user_id,name:staff.display_name};
   return {assigned:author, signed:author, amendments:[]};
  }
  if (route===encounter+'/diagnoses') return {visit, diagnoses:[], history:[], version:3};
  if (route===encounter+'/checkout') return {visit, events:[], checkout:{}, readiness:{issues:[]}};
 }
 // The full chart opens its other panels in the background. They have no records in this fixture.
 return empty;
}

async function fixture(browser, viewport) {
 const context=await browser.createBrowserContext();
 const page=await context.newPage();
 const requests=[], failures=[], holds=new Map(), rejected=new Set(), replies=new Map();
 await page.setViewport(viewport);
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 page.setDefaultTimeout(8000);
 page.on('pageerror', error=>failures.push(error.message));
 await page.setRequestInterception(true);
 const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.ico':'image/x-icon'};
 async function respond(request) {
  const url=new URL(request.url());
  if (url.origin!==origin) return request.abort();
  const reply=replies.get(request.method()+' '+url.pathname);
  if (request.method()!=='GET'&&!reply) {
   failures.push(request.method()+' '+url.pathname);
   return request.respond({status:405,body:'Read-only fixture'});
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
   requests.push(url.pathname);
   if (holds.has(url.pathname)) await holds.get(url.pathname).promise;
   if (request.isInterceptResolutionHandled()) return;
   if (rejected.has(request.url())) return request.respond({status:503,contentType:'application/json',body:'{"message":"Directory unavailable"}'});
   const data=reply?reply(url,request):apiFixture(url.pathname);
   return request.respond({status:200, contentType:'application/json', body:JSON.stringify(data)});
  }
  const file=path.resolve(web, '.'+(url.pathname==='/'?'/index.html':url.pathname));
  if (!file.startsWith(web+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.respond({status:404,body:''});
  const ext=path.extname(file);
  let body=fs.readFileSync(file);
  if (ext==='.html') body=body.toString().replaceAll('__ENVIRONMENT_NOTICE__','Synthetic fixture').replaceAll('__ENVIRONMENT_SHORT__','Synthetic').replaceAll('__SUN_CHARTS_BUILD__','Fixture');
  await request.respond({status:200, contentType:mime[ext]||'application/octet-stream', body});
 }
 page.on('request',request=>void respond(request).catch(error=>{if (!page.isClosed()) failures.push(error.message);}));
 function hold(route) {
  assert(!holds.has(route));
  let release;
  const promise=new Promise(resolve=>{release=resolve;});
  holds.set(route,{promise,release});
  return () => {holds.delete(route);release();};
 }
 return {page, requests, failures, hold, rejected, replies, async close(){for (const h of holds.values()) h.release();await context.close();}};
}

const shellPaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function atHash(page,hash) {
 try {await page.waitForFunction(h=>location.hash===h,{},hash);}
 catch (error) {
  const state=await page.evaluate(()=>({route:location.hash,notice:document.getElementById('notice')?.innerText}));
  throw new Error('Expected '+hash+', reached '+state.route+'. '+(state.notice||''),{cause:error});
 }
}
const workspacePath=p=>'/api/v1/patients/'+p.id+'/workspace';
const patientTab=p=>'[data-frame-patient="'+p.id+'"]';
const atPatient=(page,p)=>page.waitForFunction(id=>document.getElementById('patient-banner')?.dataset.patientId===id&&workspace?.patient?.id===id,{},p.id);

async function archivedPatientLayout({page,replies}) {
 const patient={...first,archived:true};
 const base='/api/v1/patients/'+patient.id;
 const visit=visits[0];
 replies.set('GET '+base+'/workspace',()=>({patient,visits:[visit],appointments:[],amendments:[],flags:[]}));
 replies.set('GET '+base+'/lifecycle',()=>({
  patient_id:patient.id,version:2,archived:true,can_manage:true,
  history:[{archived:true,created_at:timestamp,actor_id:staff.user_id,reason:'Synthetic duplicate chart'}]
 }));
 await page.goto(origin+'/#/patients/'+patient.id+'/encounter/'+visit.id+'/charges',{waitUntil:'load'});
 await atPatient(page,patient);
 const notice='#patient-lifecycle';
 const restore=notice+' [data-patient-lifecycle-open]';
 await page.waitForSelector(restore,{visible:true});
 await page.waitForSelector('#visit-page-host #visit-editor',{visible:true});
 const closed=await page.$eval(notice,el=>({
  height:el.getBoundingClientRect().height,
  open:el.querySelector('details').open,
  overflows:el.scrollWidth>el.clientWidth
 }));
 assert.equal(closed.open,false,'archive history is collapsed initially');
 assert.equal(closed.overflows,false,'the restore action fits at this viewport');
 assert.ok(closed.height<240,'the archive notice should fit its content, got '+closed.height+'px');
 await page.$eval(notice,el=>el.scrollIntoView({block:'center'}));
 await page.click(notice+' summary');
 assert.match(await page.$eval(notice,el=>el.innerText),/Synthetic duplicate chart/);
 const open=await page.$eval(notice,el=>el.getBoundingClientRect().height);
 assert.ok(open>closed.height&&open<320,'the notice grows only to accommodate the expanded history');
 await page.click(restore);
 await page.waitForSelector(notice+' #patient-lifecycle-form [name="confirmed"]',{visible:true});
}

async function patientSwitch({page,requests,hold}) {
 const firstRoute='#/patients/'+first.id+'/encounter/'+visits[0].id+'/charges';
 await page.goto(origin+'/'+firstRoute,{waitUntil:'load'});
 await atPatient(page,first);
 await atHash(page,firstRoute);
 await page.waitForSelector('[data-encounter-step-open="3"]',{visible:true});
 const secondRoute='#/patients/'+second.id+'/record';
 await page.evaluate(hash=>{location.hash=hash;},secondRoute);
 await atPatient(page,second);
 await atHash(page,secondRoute);
 const directoryReads=()=>requests.filter(r=>r==='/api/v1/patients').length;
 const before=directoryReads();
 const releaseFirst=hold(workspacePath(first));
 await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname===workspacePath(first)),page.click(patientTab(first))]);
 const pending=await page.evaluate(()=>({
  directoryVisible:document.getElementById('patient-directory').getClientRects().length>0,
  chart:document.getElementById('chart').innerText,
  skeletonAnimation:getComputedStyle(document.querySelector('#chart .skeleton')).animationName
 }));
 assert.equal(pending.directoryVisible,false);
 assert.match(pending.chart,/Opening chart/i);
 assert.doesNotMatch(pending.chart,/River|Synthetic chart note/);
 assert.equal(pending.skeletonAnimation,'none','reduced motion is honored');
 assert.equal(await page.$eval(patientTab(first),n=>n.getAttribute('aria-current')),'page');

 const releaseSecond=hold(workspacePath(second));
 await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname===workspacePath(second)),page.click(patientTab(second))]);
 releaseSecond();
 await atPatient(page,second);
 await atHash(page,secondRoute);
 const late=page.waitForResponse(r=>new URL(r.url()).pathname===workspacePath(first));
 releaseFirst();await late;await shellPaint(page);
 assert.equal(await page.$eval('#patient-banner',n=>n.dataset.patientId),second.id);
 const locationAndLength=()=>page.evaluate(()=>[location.hash,history.length]);
 const route=await locationAndLength(), reads=requests.filter(r=>r.endsWith('/workspace')).length;
 await page.click(patientTab(second));await shellPaint(page);
 assert.deepEqual(await locationAndLength(),route);
 assert.equal(requests.filter(r=>r.endsWith('/workspace')).length,reads);
 await page.click(patientTab(first));await atPatient(page,first);await atHash(page,firstRoute);
 assert.equal(await page.evaluate(()=>activeVisit?.id),visits[0].id);
 await page.goBack({waitUntil:'domcontentloaded'});await atPatient(page,second);await atHash(page,secondRoute);
 assert.equal(directoryReads(),before,'switching or restoring an open chart fetched the directory');
}

async function homeAndReferrals({page,requests}) {
 await page.evaluateOnNewDocument(()=>document.addEventListener('click',event=>{
  window.lastHomeAction=event.target.closest('button')?.dataset.practiceAction;
 },true));
 await page.goto(origin+'/#/home',{waitUntil:'load'});
 async function clickHome(action) {
  const selector='[data-practice-action="'+action+'"]';
  await page.waitForSelector(selector,{visible:true});
  await page.click(selector);
  assert.equal(await page.evaluate(()=>window.lastHomeAction),action,'the visible Home control receives the physical click');
 }
 await clickHome('claims-wait');await atHash(page,'#/claims/wait');
 await page.waitForFunction(()=>claimStatusFilter==='wait');
 await page.reload({waitUntil:'load'});await page.waitForFunction(()=>claimStatusFilter==='wait');await atHash(page,'#/claims/wait');
 await page.goBack({waitUntil:'domcontentloaded'});
 const directoryReads=requests.filter(r=>r==='/api/v1/patients').length;
 const collectionsRoute='#/billing/collected-today';
 await clickHome('collected');await atHash(page,collectionsRoute);
 const collections='#billing-overview-collections';
 await page.waitForSelector(collections+' [data-overview-receipt="'+id(37)+'"]',{visible:true});
 await page.waitForSelector(collections+' [data-overview-invoice="'+id(39)+'"]',{visible:true});
 assert.match(await page.$eval(collections,n=>n.innerText),/\$125\.00/);
 assert.equal(requests.filter(r=>r==='/api/v1/patients').length,directoryReads,'collections uses one practice-scoped request');
 await page.goBack({waitUntil:'domcontentloaded'});await atHash(page,'#/home');
 await page.goForward({waitUntil:'domcontentloaded'});await atHash(page,collectionsRoute);
 await page.waitForSelector(collections+' [data-overview-invoice]',{visible:true});
 await page.reload({waitUntil:'load'});await page.waitForSelector(collections+' [data-overview-receipt]',{visible:true});await atHash(page,collectionsRoute);
 await page.goBack({waitUntil:'domcontentloaded'});await clickHome('billing');await atHash(page,'#/billing/overview');
 await page.evaluate(()=>{location.hash='#/work-queue';});
 const selector='[data-referral-open-patient="'+first.id+'"][data-referral-id="'+referrals[1].id+'"]';
 await page.waitForSelector(selector,{visible:true});await page.click(selector);
 await page.waitForSelector('.chart-record-sheet',{visible:true});
 const sheet=await page.$eval('.chart-record-sheet',n=>n.innerText);
 assert.match(sheet,/Clinic follow-up B/);
 assert.doesNotMatch(sheet,/Clinic follow-up A/);
 assert.equal(await page.$eval('#patient-banner',n=>n.dataset.patientId),first.id);
}

async function homePatientAndVisits({page,requests,rejected}) {
 const directoryReads=()=>requests.filter(route=>route==='/api/v1/patients').length;
 await page.goto(origin+'/#/home',{waitUntil:'load'});
 await page.waitForSelector('#practice-worklist [data-practice-patient]',{visible:true});
 const directoryUrl=await page.evaluate(()=>new URL(patientDirectoryQuery(),location.origin).href);
 rejected.add(directoryUrl);
 const initialReads=directoryReads();
 await page.click('#practice-worklist [data-practice-patient]');
 await atPatient(page,first);
 await page.waitForFunction(()=>chartSection==='overview');
 assert.equal(directoryReads(),initialReads);
 await page.goBack({waitUntil:'domcontentloaded'});
 await page.waitForSelector('[data-practice-visit="'+homeVisits[1].id+'"]',{visible:true});
 await page.click('[data-practice-visit="'+homeVisits[1].id+'"]');
 await atPatient(page,first);
 await page.waitForFunction(id=>chartSection==='visits'&&activeVisit?.id===id,{},homeVisits[1].id);
 assert.equal(directoryReads(),initialReads);
 await page.goBack({waitUntil:'domcontentloaded'});
 await page.waitForSelector('[data-practice-action="notes"]',{visible:true});
 await page.click('[data-practice-action="notes"]');
 await page.waitForSelector('[data-practice-visit="'+homeVisits[0].id+'"]',{visible:true});
 await page.click('[data-practice-visit="'+homeVisits[0].id+'"]');
 await atPatient(page,first);
 await page.waitForFunction(id=>chartSection==='visits'&&activeVisit?.id===id,{},homeVisits[0].id);
 assert.equal(directoryReads(),initialReads);
 await page.goBack({waitUntil:'domcontentloaded'});
 await atHash(page,'#/home/unfinished');
 const unfinishedRestored=async expectedDirectoryReads=>{
  try {await page.waitForFunction(()=>document.getElementById('practice-board-title')?.textContent==='Unfinished encounters');}
  catch(error){
   const state=await page.evaluate(()=>({route:location.hash, board:document.getElementById('practice-board-title')?.textContent, notice:document.getElementById('notice')?.innerText}));
   throw new Error('Expected Unfinished encounters, reached '+JSON.stringify(state),{cause:error});
  }
  for(const visit of homeVisits)await page.waitForSelector('[data-practice-visit="'+visit.id+'"]',{visible:true});
  assert.equal(directoryReads(),expectedDirectoryReads);
 };
 await unfinishedRestored(initialReads);
 await page.reload({waitUntil:'load'});
 await unfinishedRestored(initialReads+1);
 assert.match(await page.$eval('#patients',el=>el.textContent),/patient list could not be loaded/i);
 await page.waitForSelector('#practice-search',{visible:true});
 await page.type('#practice-search','River');
 await page.waitForSelector('#practice-patient-results [data-practice-patient="'+second.id+'"]',{visible:true});
 const lookupReads=directoryReads();
 await page.keyboard.press('Enter');
 await atPatient(page,second);
 await page.waitForFunction(()=>chartSection==='overview');
 assert.equal(directoryReads(),lookupReads);
}

async function chartAppointmentArrival({page,hold,replies,requests,failures}) {
 const chart='#/patients/'+first.id+'/encounters';
 const appointments=['Insured visit','Self-pay visit','Delayed same-chart arrival','Delayed other-chart arrival','Missed visit'].map((title,i)=>({
  id:id(71+i+10),title,category:'Office visit',patient_id:first.id,clinician_id:staff.user_id,
  starts_at:'2026-11-24T1'+i+':00:00Z',ends_at:'2026-11-24T1'+i+':30:00Z',status:'booked',version:1
 }));
 const base=a=>'/api/v1/appointments/'+a.id;
 const coverage=id(100),checks=[];
 for(const a of appointments){
  replies.set('GET '+base(a),()=>a);
  replies.set('GET '+base(a)+'/history',()=>list([]));
  replies.set('POST '+base(a)+'/check-in',()=>{
   assert.equal(a.status,'booked','each arrival posts once');
   a.status='checked_in';a.version++;return a;
  });
  replies.set('POST '+base(a)+'/actions',(_url,request)=>{
   const {action,reason}=JSON.parse(request.postData());assert.equal(reason,'Synthetic scheduling change');
   a.status=action==='cancel'?'cancelled':'no_show';a.version++;return a;
  });
 }
 replies.set('GET '+workspacePath(first),()=>({...apiFixture(workspacePath(first)),appointments}));
 replies.set('GET /api/v1/schedule/markers',url=>{
  if(!url.searchParams.has('provider'))return list([]);
  const a=appointments.find(item=>item.starts_at===url.searchParams.get('from'));
  assert.equal(url.searchParams.get('to'),a.ends_at);
  assert.equal(url.searchParams.get('provider'),staff.user_id);
  const insured=a===appointments[0];
  return list([{appointment_id:a.id,patient_id:first.id,insurance:insured?{status:checks.length?'active':'not_checked',coverage_id:coverage}:{status:'self_pay'},copay:{due_cents:insured?2500:0,paid_cents:0}}]);
 });
 const eligibility='/api/v1/patients/'+first.id+'/coverages/'+coverage+'/claimmd-eligibility/check';
 replies.set('POST '+eligibility,(_url,request)=>{
  const body=JSON.parse(request.postData());checks.push({appointment:body.appointment_id,automatic:body.automatic});return {outcome:'checked'};
 });
 const intake='/api/v1/patients/'+first.id+'/intake-forms';
 replies.set('POST '+intake,(_url,request)=>{
  assert.equal(JSON.parse(request.postData()).appointment_id,appointments[0].id);
  return {intake_url:'/intake?token=synthetic-arrival',expires_at:timestamp,practice_name:'Synthetic practice'};
 });
 await page.goto(origin+'/'+chart,{waitUntil:'load'});
 try {await atPatient(page,first);}catch(error){
  const state=await page.evaluate(()=>({route:location.hash,notice:document.getElementById('notice')?.textContent}));
  throw new Error('Chart arrival fixture did not load. '+JSON.stringify({state,failures}),{cause:error});
 }
 const [insured,selfPay,otherAppointment,delayed,missed]=appointments;
 const clickRow=async (key,a)=>{
  const selector='#appointments-panel [data-'+key+'="'+a.id+'"]';
  await page.waitForFunction(()=>!busy&&!document.querySelector('dialog[open]'));
  await page.waitForSelector(selector,{visible:true});
  await page.$eval(selector,button=>button.scrollIntoView({block:'center',inline:'center'}));
  await page.click(selector);
 };
 await clickRow('chart-appointment',insured);
 const checkIn='#schedule-detail [data-board-action="check-in"]';
 const detail='#schedule-detail .schedule-encounter-details';
 await page.waitForSelector(checkIn,{visible:true});
 await page.click(detail+' > summary');
 await page.click(detail+' [data-board-action="check-eligibility"]');
 await page.waitForFunction(()=>!busy&&document.getElementById('notice')?.textContent==='Insurance is active.');
 assert.equal(await page.evaluate(()=>location.hash),chart);
 await page.click(detail+' > summary');
 await page.click(detail+' [data-board-action="send-intake"]');
 await page.waitForSelector(detail+' [data-board-action="copy-link"]',{visible:true});
 assert.equal(await page.$eval('#schedule-detail [data-schedule-intake-link]',el=>el.value),origin+'/intake?token=synthetic-arrival');
 await page.waitForFunction(()=>!busy);
 await page.waitForSelector(checkIn,{visible:true});await page.click(checkIn);
 const ready=a=>'#schedule-detail [data-schedule-start="'+a.id+'"]';
 await page.waitForSelector(ready(insured),{visible:true});
 await page.waitForFunction(()=>!busy);
 assert.match(await page.$eval('#schedule-panel-copay',el=>el.innerText),/Copay \$25 due/);
 assert.deepEqual(checks,[{appointment:insured.id,automatic:false},{appointment:insured.id,automatic:true}]);
 assert.equal(await page.$eval('#schedule-detail [data-schedule-status]',el=>el.selectedOptions[0].textContent),'Checked in');
 assert.equal(await page.evaluate(()=>location.hash),chart);
 await page.click('#schedule-detail [data-schedule-close]');
 await page.waitForSelector('#appointments-panel [data-start="'+insured.id+'"]',{visible:true});

 await clickRow('check-in',selfPay);
 await page.waitForSelector(ready(selfPay),{visible:true});
 await page.waitForFunction(()=>!busy);
 assert.match(await page.$eval('#schedule-panel-copay',el=>el.innerText),/Self-pay visit\?/);
 await page.click('#schedule-panel-copay [data-self-pay-dismiss]');
 assert.equal(await page.$eval('#schedule-panel-copay',el=>el.innerText),'');
 assert.equal(checks.length,2,'self-pay creates no eligibility request');
 const closeAs=async(a,action,status)=>{
  const select='#schedule-detail [data-schedule-status]';
  await page.select(select,action);
  await page.type('#schedule-action [name="reason"]','Synthetic scheduling change');
  await page.click('#schedule-action button[type="submit"]');
  try{await page.waitForFunction(status=>!busy&&document.querySelector('#schedule-detail [data-schedule-status]')?.selectedOptions[0]?.textContent===status,{},status);}
  catch(error){
   const state=await page.evaluate(()=>({busy,notice:document.getElementById('notice')?.textContent,visible:document.querySelector('#schedule-detail [data-schedule-status]')?.selectedOptions[0]?.textContent,reason:document.querySelector('#schedule-action [name=reason]')?.value}));
   throw new Error('Expected '+status+' '+JSON.stringify({state,posted:a.status,failures}),{cause:error});
  }
  assert.equal(await page.evaluate(()=>location.hash),chart);
  await page.click('#schedule-detail [data-schedule-close]');
  assert.match(await page.$eval('#appointments-panel [data-chart-appointment="'+a.id+'"]',el=>el.closest('tr').innerText),new RegExp(status,'i'));
 };
 await closeAs(selfPay,'cancel','Cancelled');
 await clickRow('chart-appointment',missed);
 await page.waitForSelector('#schedule-detail [data-schedule-status]',{visible:true});
 await closeAs(missed,'no_show','No-show');

 const otherPath=base(otherAppointment)+'/check-in',releaseOther=hold(otherPath);
 const clickHeld=async(a,path)=>{
  // Delay the responses independently of layout. The physical row and sheet buttons are covered above.
  try{await page.waitForFunction(()=>!busy&&!document.querySelector('dialog[open]'));await Promise.all([page.waitForRequest(r=>new URL(r.url()).pathname===path),page.$eval('#appointments-panel [data-check-in="'+a.id+'"]',button=>button.click())]);}
  catch(error){
   const state=await page.evaluate(id=>({busy,notice:document.getElementById('notice')?.textContent,disabled:document.querySelector('#appointments-panel [data-check-in="'+id+'"]')?.disabled,dialogs:document.querySelectorAll('dialog[open]').length}),a.id);
   throw new Error('Expected chart check-in for '+a.title+' '+JSON.stringify({state,failures}),{cause:error});
  }
 };
 await clickHeld(otherAppointment,otherPath);
 await page.evaluate((a,p)=>appointmentDetail(a,p),insured.id,first.id);
 releaseOther();await page.waitForFunction(()=>!busy);
 await page.waitForSelector(ready(insured),{visible:true});
 assert.equal(await page.$(ready(otherAppointment)),null,'a late arrival cannot replace another appointment');
 await page.click('#schedule-detail [data-schedule-close]');

 const delayedPath=base(delayed)+'/check-in',release=hold(delayedPath);
 await clickHeld(delayed,delayedPath);
 await page.evaluate(id=>frameSelectPatient(id),second.id);
 await atPatient(page,second);release();await page.waitForFunction(()=>!busy);
 assert.equal(await page.$('dialog #schedule-detail'),null);
 assert.equal(await page.evaluate(()=>workspace.patient.id),second.id);
 assert.equal(requests.filter(path=>path.endsWith('/check-in')).length,4);
}

async function emptyCoverageLayout({page}) {
 await page.goto(origin+'/#/claims',{waitUntil:'load'});
 const queue='[data-coverage-worklist]';
 await page.waitForFunction(selector=>document.querySelector(selector)?.innerText.includes('No posted charges need this review.'),{},queue);
 const {height,overflow}=await page.$eval(queue,el=>({height:el.getBoundingClientRect().height,overflow:el.scrollWidth>el.clientWidth}));
 assert.ok(height<100,'an empty insurance queue is a compact status, got '+height+'px');
 assert.equal(overflow,false);
}

async function insurancePaymentQueue({page,replies,requests}) {
 const base='/api/v1/billing/remittances';
 const payments=['staged','reconciled','posted'].map((status,i)=>({id:id(115+i),payer_id:id(114),payer_name:'Synthetic insurer',trace:'QUEUE-'+i,status,version:1,payment_date:'2026-11-24',total_paid_cents:12500,claim_count:0}));
 const [staged,reconciled,posted]=payments;
 replies.set('GET '+base,url=>url.searchParams.get('needs_review')!=='true'?list(payments):url.searchParams.has('after')?list([reconciled]):{items:[staged],next_cursor:staged.id});
 replies.set('GET '+base+'/'+reconciled.id,()=>({remittance:{...reconciled,document_hash:'a'.repeat(64),matches:[],document:{claims:[],currency:'USD',payment_date:reconciled.payment_date,payer_code:'SYNTHETIC',total_paid_cents:12500}},issues:[],postings:[],ready_to_post:true}));
 replies.set('GET '+base+'/'+reconciled.id+'/provider-adjustments',()=>({status:'reconciled',adjustments:[],reviews:[]}));
 await page.goto(origin+'/#/work-queue',{waitUntil:'load'});
 const group='[data-queue-kind="remittances"]',row=id=>'[data-queue-remittance="'+id+'"]';
 await page.waitForSelector(group,{visible:true});await page.click(group);
 await page.waitForSelector(row(staged.id),{visible:true});assert.equal(await page.$(row(posted.id)),null);
 await page.click('[data-queue-more-remittances]');await page.waitForSelector(row(reconciled.id),{visible:true});
 const reads=requests.filter(path=>path==='/api/v1/patients').length;
 await page.click(row(reconciled.id));await atHash(page,'#/remittances/'+reconciled.id);
 assert.match(await page.$eval('#claims-detail',el=>el.innerText),/QUEUE-1/);
 assert.equal(requests.filter(path=>path==='/api/v1/patients').length,reads);
 await page.goBack({waitUntil:'domcontentloaded'});await atHash(page,'#/work-queue/remittances');
 await page.waitForSelector(row(reconciled.id),{visible:true});
 await page.reload({waitUntil:'load'});await page.waitForSelector(row(staged.id),{visible:true});
 assert.equal(await page.$eval(group,el=>el.getAttribute('aria-pressed')),'true');
}

async function main() {
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'suncharts-chart-handoffs-'));
 let browser;
 try {
  const target=process.env.CHART_TEST_BROWSER?{executablePath:process.env.CHART_TEST_BROWSER}:{channel:'chrome'};
  browser=await puppeteer.launch({...target, headless:true, pipe:true, userDataDir:profile, args:['--disable-background-networking','--disable-component-update','--disable-default-apps','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND']});
  for (const viewport of [{width:1280,height:900},{width:390,height:844,isMobile:true,hasTouch:true}]) {
   for (const check of [archivedPatientLayout,emptyCoverageLayout,patientSwitch,homeAndReferrals,homePatientAndVisits,chartAppointmentArrival,insurancePaymentQueue]) {
    if(process.argv[2]&&process.argv[2]!==check.name)continue;
    const test=await fixture(browser,viewport);
    try {await check(test);assert.deepEqual(test.failures,[]);console.log('PASS '+check.name+' at '+viewport.width+' × '+viewport.height);}
    finally {await test.close();}
   }
  }
 } finally {try {if(browser) await browser.close();} finally {fs.rmSync(profile,{recursive:true,force:true});}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
