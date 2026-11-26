// SPDX-License-Identifier: AGPL-3.0-only
// Checks the encounter switcher against the local preview using synthetic, read-only responses.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const {selfPay} = require('./visit_billing_fixture.cjs');
const origin = new URL(process.env.ENCOUNTER_TEST_URL || 'http://127.0.0.1:8095').origin;
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const staff = {user_id:id(1),tenant_id:id(2),role:'owner',display_name:'Test Clinician'};
const patient = {id:id(3),given_name:'Avery',family_name:'Example',birth_date:'1980-02-03',mrn:'SYN-3'};
const appointments = ['Office visit','Follow-up visit','Procedure visit'].map((title,i)=>({
  id:id(10+i),patient_id:patient.id,clinician_id:staff.user_id,title,status:i===0?'in_progress':'completed',
  starts_at:i===0?'2026-11-23T16:00:00Z':i===1?'2026-10-08T16:00:00Z':'2026-10-08T18:00:00Z'
}));
const visits = appointments.map((a,i)=>({id:id(20+i),patient_id:patient.id,clinician_id:staff.user_id,
  encounter_number:7-i,appointment_id:a.id,created_at:a.starts_at,status:i===0?'in_progress':'signed',signed_at:i?'2026-11-25T12:00:00Z':null,
  note:{subjective:'Synthetic note for '+a.title},vitals:{},version:1}));
const patientPath='/api/v1/patients/'+patient.id;
const list=items=>({items,total:items.length,next_cursor:null});
const generic={...list([]),appointments:[],providers:[],blocks:[],events:[],forms:[],history:[],orders:[],markers:[],results:[],reviews:[],reports:[],acknowledgments:[],specimens:[],entries:[],variants:[],options:[]};
const banner='#patient-banner [data-banner-encounter]';
const switcher='#patient-banner [data-encounter-switch]';
const picker='dialog.encounter-switch-sheet[open]';
function response(url) {
 const p=url.pathname;
 if(p==='/auth/me')return staff;
 if(p==='/auth/mode')return {mode:'local'};
 if(p==='/api/v1/connect/status')return {status:'not_connected',services:{configured:false},transport:{configured:false}};
 if(p==='/api/v1/patients')return list([patient]);
 if(p===patientPath+'/workspace')return {patient,appointments,visits,amendments:[],flags:[]};
 if(p===patientPath+'/banner')return {patient_id:patient.id,revision:'test',flags:{},eligibility:[],billing:{patient_due_cents:0}};
 if(p===patientPath+'/demographics')return {content:{}};
 if(p.endsWith('/payment-profile'))return {patient_id:patient.id,livemode:false,setup_available:true,methods:{status:'available',data:list([])},payment_methods:{status:'available',data:list([])}};
 if(p===patientPath+'/billing')return {patient,coverages:[],accounts:[],claims:[],entries:[],copays:[]};
 if(p===patientPath+'/billing/visit-summary'){const v=visits.find(v=>v.id===url.searchParams.get('visit_id'))||visits[0];return selfPay({patient_id:patient.id,visit_id:v.id,appointment_id:v.appointment_id});}
 if(p===patientPath+'/intake-packets')return {patient_id:patient.id,summary:{},...list([])};
 if(p===patientPath)return patient;
 const v=visits.find(v=>p.includes(v.id));
 if(v){
  if(p==='/api/v1/visits/'+v.id)return v;
  if(p.endsWith('/rooming'))return {visit:v,version:v.version,history:[],can_edit:v.status==='in_progress',status:'ready',chief_complaint:'Synthetic',medications_reviewed:true,allergies_reviewed:true};
  if(p.endsWith('/diagnoses'))return {visit:v,diagnoses:[],history:[],can_edit:v.status==='in_progress',version:v.version};
  if(p.endsWith('/note-authorship'))return {assigned:{id:staff.user_id,name:staff.display_name},amendments:[]};
  if(p.endsWith('/checkout'))return {visit:v,version:1,events:[],releases:[],checkout:{completed:false},readiness:{issues:[]},preview_snapshot:{},followups:[]};
 }
 return generic;
}
async function waitForVisit(page,v){
 await page.waitForFunction((selector,id)=>document.querySelector(selector)?.dataset.bannerEncounter===id,{},banner,v.id);
}
async function waitForEncounterPage(page,v){
 await waitForVisit(page,v);
 const route='#/patients/'+patient.id+'/encounter/'+v.id+'/visit';
 await page.waitForFunction(expected=>location.hash===expected,{},route);
 const note='#signed-note-record[data-visit-id="'+v.id+'"] .note-read';
 await page.waitForSelector(note,{visible:true});
 const appointment=appointments.find(a=>a.id===v.appointment_id);
 assert.equal(await page.$eval(note,node=>node.querySelector('dd').textContent),'Synthetic note for '+appointment.title);
}
async function verify(browser, width){
 const page=await browser.newPage();
 try {
  await page.setViewport({width,height:900});
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.setRequestInterception(true);
  page.on('request', req=>{
   const url=new URL(req.url());
   if(url.origin!==origin)return void req.abort();
   if(req.method()!=='GET'){errors.push('Unexpected write '+req.method()+' '+url.pathname);return void req.abort();}
   if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/'))return void req.respond({status:200,contentType:'application/json',body:JSON.stringify(response(url))});
   return void req.continue();
  });
  const route='#/patients/'+patient.id+'/billing/methods';
  await page.goto(origin+'/'+route);
  await waitForVisit(page,visits[0]);
  const current=await page.$eval(banner,n=>n.innerText);
  assert.match(current,/ENC-0007/);assert.match(current,/Office visit/);assert.match(current,/Nov 23/);
  await page.click(switcher);
  await page.waitForSelector(picker+' [data-encounter-switch-pick][aria-selected="true"]');
  assert.equal(await page.$eval(picker+' [aria-selected="true"]',n=>n.dataset.encounterSwitchPick),visits[0].id);
  const columns=await page.$eval(picker,n=>[n.querySelector('.encounter-switch-side'),n.querySelector('.encounter-switch-main')].map(x=>{const b=x.getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom};}));
  if(width>700)assert.ok(columns[0].right<=columns[1].left+1,'List sits to the left of the calendar');
  else assert.ok(columns[0].bottom<=columns[1].top+1,'Narrow screen stacks the list and calendar');
  const screenshots=process.env.CHART_SCREENSHOT_DIR;
  if(screenshots&&width>700)await page.screenshot({path:path.join(screenshots,'patient-banner-switch-encounter-8095.png')});
  await page.click(picker+' [data-encounter-switch-move="-1"]');
  await page.click(picker+' [data-encounter-switch-day="2026-10-08"]');
  assert.equal(await page.$$eval(picker+' .is-on-day',rows=>rows.length),2);
  await page.click(picker+' [data-encounter-switch-pick="'+visits[1].id+'"]');
  await page.keyboard.press('Escape');
  await page.waitForSelector(picker,{hidden:true});await waitForVisit(page,visits[0]);
  await page.waitForFunction(s=>document.activeElement===document.querySelector(s),{},switcher);
  await page.click(switcher);
  await page.type(picker+' input[type="search"]','Follow-up');
  assert.equal(await page.$$eval(picker+' [data-encounter-switch-pick]',ns=>ns.length),1);
  await page.click(picker+' [data-encounter-switch-pick="'+visits[1].id+'"]');
  await page.click(picker+' [data-encounter-switch-open]');
  await page.waitForSelector(picker,{hidden:true});await waitForEncounterPage(page,visits[1]);
  assert.match(await page.$eval(banner,n=>n.innerText),/ENC-0006[\s\S]*Oct 8[\s\S]*Signed/);
  if(screenshots&&width>700)await (await page.$('#patient-banner')).screenshot({path:path.join(screenshots,'patient-banner-selected-encounter-8095.png')});
  await page.reload();await waitForEncounterPage(page,visits[1]);
  await page.click('#patient-banner [data-chart-section="insurance"]');
  await page.waitForSelector('#insurance-page-copay [data-insurance-copay-collect="'+appointments[1].id+'"]');
  await page.click(switcher);
  await page.click(picker+' [data-encounter-switch-pick="'+visits[2].id+'"]');
  await page.click(picker+' [data-encounter-switch-open]');
  await page.waitForSelector(picker,{hidden:true});await waitForEncounterPage(page,visits[2]);
  await page.click('#patient-banner [data-chart-section="insurance"]');
  await page.waitForSelector('#insurance-page-copay [data-insurance-copay-collect="'+appointments[2].id+'"]');
  assert.equal(await page.$('#insurance-page-copay [data-insurance-copay-collect="'+appointments[1].id+'"]'),null);
  assert.deepEqual(errors,[]);
  console.log('PASS '+width+'px · banner, list/calendar, two encounters on one day, cancel, focus, Visit opens from Billing and Insurance, reload, copay appointment scope');
 } finally {await page.close();}
}
(async()=>{
 const browser=await puppeteer.launch({channel:'chrome',headless:true,pipe:true,args:['--disable-background-networking','--disable-component-update','--disable-default-apps','--no-first-run']});
 try {await verify(browser,1280);await verify(browser,390);} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
