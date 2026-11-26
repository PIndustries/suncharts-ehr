// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const source=fs.readFileSync('web/encounter-start.js','utf8');
function harness(){
 const nodes=new Map(),handlers={},calls=[],bookings=new Map(),appointments=[],visits=[];
 let lostBooking=false,lostCheckIn=false,lostStart=false,sequence=0;
 const node=id=>nodes.get(id)||(()=>{const item={id,innerHTML:'',dataset:{},hidden:false,replaceChildren(){this.innerHTML='';},scrollIntoView(){},querySelectorAll(){return [];},querySelector(){return null;}};nodes.set(id,item);return item;})();
 const identity={role:'clinician',user_id:'clinician'},patient={id:'patient',given_name:'Synthetic',family_name:'Patient'};
 const ctx={console,Date,Intl,Map,JSON,Error,crypto:{randomUUID:()=>`request-${++sequence}`},document:{addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn)},$:node,me:identity,selected:patient.id,workspace:{patient,appointments,visits,billing:{coverages:[]}},activeVisit:null,esc:v=>String(v??''),human:v=>v,date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,payerName:()=> 'Synthetic payer',localTime:v=>v.slice(0,16),scheduleInstant:v=>new Date(v+'Z').toISOString(),revenueCoverage:()=>ctx.coverage||null,revenueServiceDate:a=>a.starts_at.slice(0,10),claimmdEligibilityRows:c=>`BENEFITS:${c.id}`,showChartSection:()=>{throw Error('Opening or cancelling must preserve the chart section');},setEncounterSection:key=>ctx.step=key,notice:message=>ctx.noticeText=message,FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}},run:fn=>ctx.pending=fn(),selectPatient:async(p,v)=>{ctx.selectedVisit=v;ctx.workspace={...ctx.workspace,appointments,visits};},api:async(path,method='GET',body)=>{
  calls.push({path,method,body:body?JSON.parse(JSON.stringify(body)):body});
  if(path.endsWith('/workspace'))return {patient,appointments:appointments.map(a=>({...a})),visits:visits.map(v=>({...v}))};
  if(path==='/api/v1/appointments'){
   let saved=bookings.get(body.request_id);if(!saved){saved={...body,id:`appointment-${bookings.size+1}`,status:'booked'};bookings.set(body.request_id,saved);appointments.push(saved);}
   if(lostBooking){lostBooking=false;throw new Error('Synthetic lost booking response');}return {...saved};
  }
  if(path.endsWith('/check-in')){appointments.find(a=>path.includes(a.id)).status='checked_in';if(lostCheckIn){lostCheckIn=false;throw new Error('Synthetic lost check-in response');}return {};}
  if(path==='/api/v1/visits'){const appointment=appointments.find(a=>a.id===body.appointment_id);assert.equal(appointment.status,'checked_in');const visit={id:'visit-'+(visits.length+1),patient_id:patient.id,clinician_id:appointment.clinician_id,appointment_id:appointment.id,status:'in_progress'};visits.push(visit);appointment.status='in_progress';if(lostStart){lostStart=false;throw new Error('Synthetic lost start response');}return visit;}
  if(path.endsWith('/claimmd-eligibility'))return {items:[]};
  throw new Error('Unexpected '+path);
 }};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const form={id:'encounter-start-form',dataset:{patient:patient.id},values:{appointment_id:'',starts_at:'2026-11-10T09:30',duration:'45',title:'Office visit',category:'Office visit'}};
 return {ctx,node,form,calls,bookings,appointments,visits,handlers,lose:stage=>{if(stage==='booking')lostBooking=true;if(stage==='checkin')lostCheckIn=true;if(stage==='start')lostStart=true;}};
}
(async()=>{
 const h=harness();h.lose('booking');h.lose('checkin');h.lose('start');
 const op=h.ctx.encounterStartInput(h.form);
 await assert.rejects(h.ctx.continueEncounterStart(op),/lost booking/);
 assert.equal(h.bookings.size,1);assert.equal(h.visits.length,0);
 h.form.values.starts_at='2026-11-11T11:00';
 assert.equal(h.ctx.encounterStartInput(h.form),op,'uncertain retry must retain the reviewed body');
 await h.ctx.continueEncounterStart(op);
 assert.equal(h.bookings.size,1);assert.equal(h.visits.length,1);assert.equal(h.ctx.selectedVisit,'visit-1');assert.equal(h.ctx.step,'visit','a newly opened visit starts at rooming before the note');
 const posts=h.calls.filter(c=>c.path==='/api/v1/appointments');assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(posts[0].body.starts_at,'2026-11-10T09:30:00.000Z');assert.equal(posts[0].body.ends_at,'2026-11-10T10:15:00.000Z');
 assert.equal(h.calls.filter(c=>c.path==='/api/v1/visits').length,1,'recover committed visit without creating another');
 await h.ctx.openEncounterStartFlow();assert.match(h.node('encounter-start-editor').innerHTML,/appointment-1/);assert.match(h.node('encounter-start-editor').innerHTML,/Continue encounter/);
 h.form.values.appointment_id='appointment-1';const existing=h.ctx.encounterStartInput(h.form);await h.ctx.continueEncounterStart(existing);assert.equal(h.bookings.size,1);assert.equal(h.visits.length,1);

 {
  // An encounter is already open: the default flow continues it, the "new" intent starts another.
  const busy=harness();busy.appointments.push({id:'open-appt',patient_id:'patient',clinician_id:'clinician',title:'Open one',starts_at:'2026-11-10T09:00:00Z',status:'in_progress'},{id:'later-appt',patient_id:'patient',clinician_id:'clinician',title:'Later one',starts_at:'2026-12-01T09:00:00Z',status:'booked'});
  busy.visits.push({id:'visit-open',patient_id:'patient',clinician_id:'clinician',appointment_id:'open-appt',status:'in_progress',encounter_number:5});
  busy.ctx.encounterNumberText=v=>`ENC-${String(v.encounter_number).padStart(4,'0')}`;
  await busy.ctx.openEncounterStartFlow();let html=busy.node('encounter-start-editor').innerHTML;
  assert.match(html,/Continue encounter/);assert.match(html,/open-appt/);
  await busy.ctx.openEncounterStartFlow('new');html=busy.node('encounter-start-editor').innerHTML;
  assert.match(html,/<h3>New encounter<\/h3>/);assert.match(html,/Start encounter/);assert.doesNotMatch(html,/Continue encounter/);
  assert.doesNotMatch(html,/open-appt/,'the encounter already in progress is not offered');assert.match(html,/later-appt/);
  assert.match(html,/<option value="" selected>Walk-in/);assert.doesNotMatch(html,/id="encounter-start-new-fields" hidden/,'walk-in fields show');
  assert.match(html,/data-start-options/);assert.match(html,/data-start-insurance/);
  assert.match(html,/Visit type or title/);assert(!busy.calls.some(c=>c.method!=='GET'),'Opening makes no clinical writes');
  // In a sheet the page host is left empty so ids are not duplicated.
  const sheets=[];busy.ctx.document.querySelector=()=>null;busy.ctx.sheetOpen=(title,body)=>{sheets.push({title,body});return {dataset:{},querySelector:()=>null};};
  busy.ctx.document.createElement=()=>({set innerHTML(v){this.html=v;},get innerHTML(){return this.html;}});
  await busy.ctx.openEncounterStartFlow('new');assert.equal(sheets.length,1);assert.equal(sheets[0].title,'New encounter');assert.match(sheets[0].body.innerHTML,/id="encounter-start-form"/);assert.equal(busy.node('encounter-start-editor').innerHTML,'');assert.equal(busy.node('encounter-start-editor').hidden,true);
 }
 const cross=harness(),crossOp=cross.ctx.encounterStartInput(cross.form),original=cross.ctx.api;
 cross.ctx.api=async(...args)=>{const result=await original(...args);if(args[0]==='/api/v1/appointments')cross.ctx.selected='other-patient';return result;};
 await assert.rejects(cross.ctx.continueEncounterStart(crossOp),/Patient or sign-in changed/);
 assert.equal(cross.calls.filter(c=>c.path.endsWith('/check-in')||c.path==='/api/v1/visits').length,0,'no dependent writes after chart changes');
 cross.ctx.me={role:'front_desk',user_id:'staff'};cross.ctx.selected='patient';assert.throws(()=>cross.ctx.encounterStartInput(cross.form),/Open this patient/);

 const wrong=harness();wrong.appointments.push({id:'other-provider',patient_id:'patient',clinician_id:'other',starts_at:'2026-11-10T09:00:00Z',status:'checked_in'});wrong.form.values.appointment_id='other-provider';assert.throws(()=>wrong.ctx.encounterStartInput(wrong.form),/assigned to you/);
 const denied=harness();denied.ctx.coverage={id:'coverage',content:{payer_id:'payer',copay_cents:2500,plan_name:'Synthetic plan'}};
 denied.ctx.api=async()=>({items:[{id:'wrong-date',status:'completed',created_at:'2026-11-11T00:00:00Z',request_snapshot:{request:{service_date:'2026-11-09'}}},{id:'correct-date',status:'completed',created_at:'2026-11-10T00:00:00Z',request_snapshot:{request:{service_date:'2026-11-10'}}}]});
 await denied.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');assert.match(denied.node('encounter-benefits').innerHTML,/BENEFITS:correct-date/);assert.match(denied.node('encounter-benefits').innerHTML,/\$25\.00/);assert.doesNotMatch(denied.node('encounter-benefits').innerHTML,/BENEFITS:wrong-date/);
 assert.match(denied.node('encounter-benefits').innerHTML,/data-eligibility="Eligibility checked"/);
 denied.ctx.api=async()=>({items:[]});
 await denied.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');
 assert.match(denied.node('encounter-benefits').innerHTML,/data-eligibility="Eligibility not checked"/);
 denied.ctx.api=async()=>{throw Error('History could not load');};
 await denied.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');
 assert.match(denied.node('encounter-benefits').innerHTML,/data-eligibility="Eligibility unavailable"/);
 let resolve;denied.ctx.api=()=>new Promise(r=>resolve=r);const pending=denied.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');denied.ctx.selected='other';denied.node('encounter-benefits').innerHTML='OTHER CHART';resolve({items:[]});await pending;assert.equal(denied.node('encounter-benefits').innerHTML,'OTHER CHART');
 const absent=harness();await absent.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');assert.match(absent.node('encounter-benefits').innerHTML,/No insurance on file for this encounter date/);
 const rejected=harness(),rejectedForm=Object.assign(rejected.node('encounter-start-form'),rejected.form),field={disabled:false},submit={textContent:''};
 rejectedForm.querySelectorAll=()=>[field];rejectedForm.querySelector=()=>submit;
 rejected.ctx.api=async()=>{const error=new Error('Synthetic schedule conflict');error.status=409;throw error;};
 rejected.handlers.submit[0]({target:rejectedForm,preventDefault(){},stopImmediatePropagation(){}});await assert.rejects(rejected.ctx.pending,/schedule conflict/);
 assert.equal(field.disabled,false,'a definite booking rejection allows correcting the service time');assert.equal(submit.textContent,'Start encounter');
 const afterRejection=rejected.ctx.encounterStartInput(rejectedForm);assert.equal(afterRejection.booking.request_id,'request-2','only a definite rejection releases the old request');
 const clash=harness(),clashForm=Object.assign(clash.node('encounter-start-form'),clash.form);
 const clashField={disabled:false},options={open:false};clashForm.querySelectorAll=()=>[clashField];clashForm.querySelector=selector=>selector==='[data-start-options]'?options:{textContent:''};
 clash.ctx.api=async()=>{const error=new Error('provider, patient or room is unavailable during that time');error.status=409;throw error;};
 clash.handlers.submit[0]({target:clashForm,preventDefault(){},stopImmediatePropagation(){}});await clash.ctx.pending;assert.equal(clashField.disabled,false);assert.equal(options.open,true);
 assert.equal(clash.node('encounter-start-status').textContent,'That time overlaps another appointment for this clinician, patient or room. Choose a different time.','the clash gets one plain message');
 assert.doesNotMatch(clash.node('encounter-start-status').textContent,/not accepted/);
 const today=harness(),now=new Date(),midnight=new Date(now);midnight.setUTCHours(0,0,0,0);
 const appt=(id,status,ms)=>({id,patient_id:'patient',clinician_id:'clinician',title:id,starts_at:new Date(ms).toISOString(),status});
 const nowDay=midnight.getTime();
 today.appointments.push(appt('booked-today','booked',nowDay),appt('checked-today','checked_in',nowDay),appt('linked-booking','booked',nowDay),appt('later','booked',now.getTime()+86400000));
 today.visits.push({patient_id:'patient',appointment_id:'linked-booking'});
 await today.ctx.openEncounterStartFlow('new');
 assert.match(today.node('encounter-start-editor').innerHTML,/<option value="checked-today" selected>/);
 assert.doesNotMatch(today.node('encounter-start-editor').innerHTML,/linked-booking|value="later" selected/);
 const staffed=harness();staffed.ctx.me={role:'nurse',user_id:'nurse'};staffed.appointments.push({...appt('rooming','checked_in',nowDay),clinician_id:'physician'});
 staffed.form.values.appointment_id='rooming';const nurseOp=staffed.ctx.encounterStartInput(staffed.form);
 await Promise.all([staffed.ctx.continueEncounterStart(nurseOp),staffed.ctx.continueEncounterStart(nurseOp)]);
 assert.equal(staffed.visits.length,1);assert.equal(staffed.visits[0].clinician_id,'physician');assert.equal(staffed.bookings.size,0);
 staffed.form.values.appointment_id='';assert.throws(()=>staffed.ctx.encounterStartInput(staffed.form),/checked-in appointment/);
 const reverted=harness();reverted.ctx.me={role:'medical_assistant',user_id:'rooming'};
 reverted.appointments.push({...appt('ready','checked_in',nowDay),clinician_id:'physician'});
 reverted.form.values.appointment_id='ready';const selected=reverted.ctx.encounterStartInput(reverted.form);
 reverted.appointments[0].status='booked';
 await assert.rejects(reverted.ctx.continueEncounterStart(selected),/checked in again/);
 assert(!reverted.calls.some(c=>c.method!=='GET'));
 const multiple=harness();
 multiple.ctx.scheduleVisitTypes=async()=>[{id:'procedure',version:3,name:'Injection visit',category:'Procedure',duration_minutes:45},{id:'office',version:2,name:'Office encounter',category:'Office encounter',duration_minutes:25}];
 await multiple.ctx.openEncounterStartFlow('new');
 assert.match(multiple.node('encounter-start-editor').innerHTML,/<option value="office"[^>]*selected>Office encounter · 25 min/);
 const typed=harness();typed.ctx.scheduleVisitTypes=async()=>[{id:'type-1',version:3,name:'Injection visit',category:'Procedure',duration_minutes:45,enabled:true}];
 typed.ctx.scheduleSoleFacility=d=>d.items.length===1?d.items[0].name:'';
 const oldApi=typed.ctx.api;typed.ctx.api=(path,...rest)=>path==='/api/v1/schedule/locations'?Promise.resolve({items:[{name:'Clinic A'}]}):oldApi(path,...rest);
 await typed.ctx.openEncounterStartFlow('new');assert.match(typed.node('encounter-start-editor').innerHTML,/data-facility="Clinic A"/);assert.match(typed.node('encounter-start-editor').innerHTML,/Injection visit · 45 min/);
 typed.form.dataset.facility='Clinic A';typed.form.values.visit_type_id='type-1';typed.form.values.title='Injection visit';typed.form.values.category='Procedure';
 typed.form.elements={visit_type_id:{selectedOptions:[{value:'type-1',dataset:{version:'3'}}]}};
 const typedOp=typed.ctx.encounterStartInput(typed.form);
 assert.equal(typedOp.booking.visit_type.id,'type-1');assert.equal(typedOp.booking.visit_type.version,3);assert.equal(typedOp.booking.facility,'Clinic A');
 await Promise.all([typed.ctx.continueEncounterStart(typedOp),typed.ctx.continueEncounterStart(typedOp)]);
 assert.equal(typed.bookings.size,1);assert.equal(typed.visits.length,1);
 const cancelled=harness();let closed=0;const cancel={closest:()=>({dataset:{}})};cancelled.ctx.sheetClose=()=>closed++;
 cancelled.handlers.click[0]({target:{closest:selector=>selector.includes('data-encounter-start-cancel')?cancel:null},preventDefault(){}});
 assert.equal(closed,1);assert.equal(cancelled.calls.length,0);assert.equal(cancelled.ctx.step,undefined);
 console.log('PASS single encounter start, frozen booking replay, uncertain check-in/start recovery, own-clinician context, service-date benefits and stale chart isolation');
})().catch(error=>{console.error(error);process.exitCode=1;});
