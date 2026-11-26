// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Mount the shipped page and its real forms against a synthetic, read-only EHR.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom');

const web=path.resolve(__dirname,'../web');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const patient={id:id(21),given_name:'Avery',family_name:'Example',mrn:'SYN-21',birth_date:'1990-01-01',status:'active'};
const staff={user_id:id(11),tenant_id:id(12),role:'owner',display_name:'Synthetic clinician'};
const timestamp='2026-11-24T17:00:00Z';
const appointment={id:id(41),patient_id:patient.id,clinician_id:staff.user_id,title:'Office visit',status:'in_progress',starts_at:timestamp,ends_at:'2026-11-24T17:30:00Z'};
const encounter={id:id(51),patient_id:patient.id,appointment_id:appointment.id,clinician_id:staff.user_id,version:3,status:'in_progress',encounter_number:7,
 note:{subjective:'Synthetic clinical history',objective:'Synthetic exam',assessment:'Synthetic assessment',plan:'Original plan'},
 vitals:{systolic_mm_hg:120,diastolic_mm_hg:80}};
const account={id:id(61),patient_id:patient.id,version:1,status:'draft',total_cents:11000,
 content:{visit_id:encounter.id,service_date:'2026-11-24',currency:'USD',coverage_id:null,lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:11000,diagnosis_codes:['Z00.00']}]}};
const empty={items:[],next_cursor:null,providers:[],appointments:[],blocks:[],events:[],forms:[],orders:[],reports:[],reviews:[],acknowledgments:[],entries:[],options:[]};

function fixture({signed=false,allowBillingWrites=false}={}){
 const visit=signed?{...encounter,status:'signed',signed_at:timestamp,signed_by:staff.user_id}:encounter;
 const visitPath='/api/v1/visits/'+visit.id,patientPath='/api/v1/patients/'+patient.id;
 const accountPath=patientPath+'/billing/accounts/'+account.id;
 let currentAccount=structuredClone(account);
 const calls=[],errors=[];
 const console=new VirtualConsole();
 console.on('jsdomError',error=>errors.push(error.cause?.message||error.message));
 const dom=new JSDOM(fs.readFileSync(path.join(web,'index.html'),'utf8'),{
  runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console,
  url:'http://127.0.0.1:18095/#/patients/'+patient.id+'/encounter/'+visit.id+'/note',
 });
 const w=dom.window,document=w.document;
 w.scrollTo=()=>{};
 w.matchMedia=()=>({matches:false,addListener(){},addEventListener(){},removeEventListener(){}});
 w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.HTMLElement.prototype.scrollTo=function(options){this.scrollTop=options.top||0;};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 function read(route){
  if(route==='/auth/me')return staff;
  if(route==='/auth/mode')return {mode:'local'};
  if(route==='/api/v1/connect/status')return {status:'not_connected'};
  if(route==='/api/v1/patients')return {...empty,items:[patient]};
  if(route===patientPath)return patient;
  if(route===patientPath+'/workspace')return {patient,appointments:[appointment],visits:[visit],amendments:[],flags:[]};
  if(route===patientPath+'/billing')return {accounts:[currentAccount],coverages:[],entries:[],claims:[],copays:[]};
  if(route===patientPath+'/billing/visit-summary'){
   const posted=currentAccount.status==='posted',total=currentAccount.total_cents;
   return {visit,account:currentAccount,state:posted?'self_pay_collect':signed?'post_charges':'sign_visit',charges_cents:total,insurance:{insured:false},patient:{owes_now_cents:posted?total:0,copay_due_cents:0},receipts:[]};
  }
  if(route===patientPath+'/banner')return {patient_id:patient.id,revision:'synthetic',billing:{patient_due_cents:0},eligibility:[],flags:[]};
  if(route===patientPath+'/demographics')return {patient_id:patient.id,content:{}};
  if(route===visitPath)return visit;
  if(route===visitPath+'/diagnoses')return {visit,diagnoses:[{code:'Z00.00',display:'Preventive visit',rank:1}],version:visit.version,can_edit:!signed,history:[]};
  if(route===visitPath+'/rooming')return {visit_id:visit.id,version:visit.version,status:'in_progress',chief_complaint:'Synthetic concern'};
  if(route===visitPath+'/note-authorship')return {assigned:{id:staff.user_id,name:staff.display_name},signed:signed?{id:staff.user_id,name:staff.display_name,at:timestamp}:null,amendments:[]};
  if(route.endsWith('/checkout'))return {visit,version:1,events:[],checkout:{completed:false},readiness:{issues:[]},preview_digest:'synthetic',followups:[],releases:[],current_avs:null};
  return empty;
 }
 w.fetch=async(url,options={})=>{
  const route=new URL(url,w.location).pathname,method=options.method||'GET';
  calls.push({route,method});
  if(allowBillingWrites&&method==='POST'&&route===accountPath+'/actions'){
   assert.equal(JSON.parse(options.body).action,'post');
   currentAccount={...currentAccount,status:'posted',version:currentAccount.version+1};
   return {status:200,ok:true,json:async()=>currentAccount};
  }
  if(allowBillingWrites&&(method==='PUT'&&route===accountPath||method==='POST'&&route===accountPath+'/corrections')){
   const {content,reason}=JSON.parse(options.body);
   assert.equal(reason,method==='PUT'?'Edited charges':'Charge correction');
   currentAccount={...currentAccount,content,total_cents:content.lines.reduce((sum,line)=>sum+line.amount_cents,0),version:currentAccount.version+1};
   return {status:200,ok:true,json:async()=>currentAccount};
  }
  return method==='GET'?{status:200,ok:true,json:async()=>read(route)}:{status:405,ok:false,json:async()=>({message:'Read-only synthetic fixture'})};
 };
 const run=source=>vm.runInContext(source,dom.getInternalVMContext());
 for(const element of document.querySelectorAll('script[src]')){
  const filename=path.join(web,element.getAttribute('src'));
  vm.runInContext(fs.readFileSync(filename,'utf8'),dom.getInternalVMContext(),{filename});
 }
 const find=selector=>document.querySelector(selector);
 const wait=async(work,message)=>{
  for(let tick=0;tick<80;tick++){
   const result=work();if(result)return result;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail(message+' '+errors.join(' / ')+' '+(find('#notice')?.textContent||''));
 };
 const ready=()=>wait(()=>find('#visit-page-host[data-encounter-one-page][data-steps-visible="true"]'),'the real chart has opened its encounter');
 return {w,dom,document,run,find,wait,ready,calls,errors};
}
async function close(fixture){
 // Let the last render's resolved API promises finish before JSDOM clears document.
 await new Promise(resolve=>setTimeout(resolve,30));
 fixture.dom.window.close();
}

(async()=>{
 const f=fixture();
 try{
  const host=await f.ready(),find=f.find;
  const sections=()=>[...host.querySelectorAll('.encounter-step:not([hidden])')].map(node=>node.dataset.encounterSection);
  assert.equal(host.dataset.stepViewed,'2');
  await f.wait(()=>find('[data-encounter-step-open="3"]')?.hidden,'self-pay has no Claim step');
  assert.deepEqual(sections(),['note','coding','payment','wrap-up']);
  assert.equal(find('#encounter-step-payment .visit-billing-more [data-encounter-charges]'),null);
  assert.ok(find('#encounter-step-payment [data-add-insurance-sheet]'));
  assert.equal(find('[data-step-primary]'),null);
  const note=find('#note-form'),plan=note.elements.plan;
  assert.equal(plan.value,'Original plan');
  assert.equal(note.querySelector('[data-action="sign-bill"]').textContent,'Sign & bill');
  assert.equal(find('[data-encounter-section="note"]').querySelector('[data-open-encounter-coding]'),null,'the note starts with documentation and the progress rail provides Coding');
  assert.ok(find('[data-encounter-section="coding"]'),'Coding stays available on this visit');
  const rooming=find('[data-encounter-rooming]');
  assert.equal(rooming.open,false);
  rooming.querySelector('summary').click();
  assert.equal(rooming.open,true);
  assert.equal(find('dialog[open]'),null,'Rooming opens in the encounter');
  assert.match(find('#visit-vitals-summary').textContent,/120\/80/);
  find('[data-action="edit-vitals"]').click();
  assert.equal(find('#vitals-form').elements.systolic_mm_hg.value,'120');
  assert.equal(f.document.querySelectorAll('#vitals-form').length,1);

  plan.value='Unsaved treatment plan';
  f.run('captureVisitDrafts()');
  find('[data-encounter-step-open="6"]').click();
  await f.wait(()=>find('#encounter-step-coding #visit-diagnoses-form'),'combined coding loads real diagnoses');
  assert.ok(find('#encounter-step-coding [data-encounter-coding] #billing-charge-lines'));
  assert.equal(f.document.querySelectorAll('#visit-diagnoses').length,1);
  assert.equal(f.document.querySelectorAll('#billing-account-form').length,1);
  const coding=find('#billing-account-form'),chip=find('[data-encounter-step-open="6"]');
  assert.equal(coding.querySelector('[data-add-charge]').textContent,'+ Add procedure');
  assert.equal(coding.querySelector('[data-charge-copay]').textContent,'Self-pay');
  assert.match(coding.querySelector('[data-charge-pays]').textContent,/Payment shows the remaining balance/);
  find('[data-encounter-step-open="4"]').click();
  f.run("setEncounterSection('charges');encounterStepsSync();");
  assert.equal(host.dataset.stepViewed,'6');
  assert.equal(find('#billing-account-form'),coding);
  assert.equal(find('[data-encounter-step-open="6"]'),chip);
  assert.equal(find('#note-form'),note);
  assert.equal(plan.value,'Unsaved treatment plan');
  assert.equal(find('[data-step-payment] [data-visit-collect]'),null);
  f.run("setEncounterSection('files');encounterStepsSync();setEncounterSection('coding');");
  assert.equal(host.dataset.stepViewed,'6','the signed-note reminder can return from another record area');

  f.run("workspaceChartTabEnabled=key=>key!=='billing';renderVisit(false);encounterStepsSync();");
  assert.deepEqual(sections(),['note','wrap-up']);
  assert.ok(find('#encounter-step-note #visit-diagnoses'));
  assert.equal(f.document.querySelectorAll('#visit-diagnoses').length,1,'coding access changes leave one diagnoses editor');
  assert.equal(find('#note-form [data-action="sign"]').textContent,'Sign note');
  assert.equal(find('[data-action="sign-bill"]'),null);
  assert.equal(find('#note-form').elements.plan.value,'Unsaved treatment plan');
  for(const area of ['files','orders']){
   f.run(`setEncounterSection('${area}');encounterStepsSync();`);
   assert.deepEqual(sections(),[],area+' opens its existing record area');
   assert.equal(find('#encounter-stepper').hidden,true);
   f.run("setEncounterSection('visit');encounterStepsSync();");
   assert.deepEqual(sections(),['note','wrap-up']);
  }
  assert.deepEqual(f.calls.filter(call=>call.method!=='GET'),[]);
  assert.deepEqual(f.errors,[]);
 }finally{await close(f);}
 const signed=fixture({signed:true,allowBillingWrites:true});
 try{
  const host=await signed.ready();
  assert.equal(host.dataset.stepViewed,'2');
  await signed.wait(()=>signed.find('#encounter-step-coding [data-step-self-pay-post] [data-visit-post-charges]'),'a signed self-pay draft posts from Coding');
  signed.run("setEncounterSection('claim');encounterStepsSync();");
  assert.equal(host.dataset.stepViewed,'6');
  assert.match(signed.find('#encounter-step-note .note-read').textContent,/Synthetic clinical history/);
  assert.equal(signed.find('#note-form [data-action^="sign"]'),null);
  assert.ok(signed.find('#encounter-step-wrap-up #visit-checkout'));
  assert.deepEqual(signed.calls.filter(call=>call.method!=='GET'),[]);
  signed.run("confirmAction=async()=>true;");
  const draftAmount=signed.find('#encounter-step-coding [name="amount"]');
  draftAmount.value='120.00';
  draftAmount.dispatchEvent(new signed.w.Event('input',{bubbles:true}));
  signed.find('[data-step-self-pay-post] [data-visit-post-charges]').click();
  await signed.wait(()=>signed.find('#visit-page-host').dataset.stepViewed==='4'&&signed.find('[data-step-payment] [data-visit-collect]'),'posting opens Payment with the updated balance');
  assert.match(signed.find('#encounter-step-payment .visit-billing-totals').textContent,/Patient owes now\$120.00/);
  assert.deepEqual(signed.calls.filter(call=>call.method!=='GET').map(call=>[call.method,call.route.split('/').pop()]),[['PUT',account.id],['POST','actions']]);
  assert.ok(signed.find('#encounter-step-payment [data-visit-statement]'));
  assert.ok(signed.find('#encounter-step-payment [data-new-ledger]'));
  assert.ok(signed.find('#encounter-step-payment [data-visit-history="payments"]'));
  signed.find('[data-encounter-step-open="6"]').click();
  const correction=await signed.wait(()=>signed.find('#encounter-step-coding #billing-account-form[data-mode="correction"]'),'posted charges open as a correction');
  const save=correction.querySelector('[data-save-encounter-coding]');
  assert.equal(correction.dataset.autosave,'off');
  assert.equal(save.textContent,'Save charge correction');
  assert.equal(correction.querySelector('[data-charge-copay]').textContent,'Self-pay');
  assert.doesNotMatch(correction.querySelector('[data-charge-pays]').textContent,/insurer|copay/i);
  const amount=correction.querySelector('[name="amount"]');
  amount.value='125.00';
  amount.dispatchEvent(new signed.w.Event('input',{bubbles:true}));
  assert.equal(correction.chargeSaveTimer,undefined);
  save.click();
  await signed.wait(()=>correction.dataset.version==='4','explicit save uses the charge correction endpoint');
  assert.deepEqual(signed.calls.filter(call=>call.method!=='GET').map(call=>[call.method,call.route.split('/').pop()]),[['PUT',account.id],['POST','actions'],['POST','corrections']]);
  assert.deepEqual(signed.errors,[]);
 }finally{await close(signed);}
 console.log('PASS the mounted self-pay page keeps one Coding form and opens legacy Charges and Claim links there');
})().catch(error=>{console.error(error);process.exitCode=1;});
