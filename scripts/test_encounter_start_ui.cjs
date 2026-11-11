// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/encounter-start.js','utf8');
function harness(){
 const nodes=new Map(),handlers={},calls=[],bookings=new Map(),appointments=[],visits=[];
 let lostBooking=false,lostCheckIn=false,lostStart=false,sequence=0;
 const node=id=>nodes.get(id)||(()=>{const item={id,innerHTML:'',dataset:{},hidden:false,replaceChildren(){this.innerHTML='';},scrollIntoView(){},querySelectorAll(){return [];},querySelector(){return null;}};nodes.set(id,item);return item;})();
 const identity={role:'clinician',user_id:'clinician'},patient={id:'patient',given_name:'Synthetic',family_name:'Patient'};
 const ctx={console,Date,Intl,Map,JSON,Error,crypto:{randomUUID:()=>`request-${++sequence}`},document:{addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn)},$:node,me:identity,selected:patient.id,workspace:{patient,appointments,visits,billing:{coverages:[]}},activeVisit:null,esc:v=>String(v??''),human:v=>v,date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,payerName:()=> 'Synthetic payer',localTime:v=>v.slice(0,16),scheduleInstant:v=>new Date(v+'Z').toISOString(),revenueCoverage:()=>ctx.coverage||null,revenueServiceDate:a=>a.starts_at.slice(0,10),claimmdEligibilityRows:c=>`BENEFITS:${c.id}`,showChartSection:()=>{},setEncounterSection:key=>ctx.step=key,notice:message=>ctx.noticeText=message,FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}},run:fn=>ctx.pending=fn(),selectPatient:async(p,v)=>{ctx.selectedVisit=v;ctx.workspace={...ctx.workspace,appointments,visits};},api:async(path,method='GET',body)=>{
  calls.push({path,method,body:body?JSON.parse(JSON.stringify(body)):body});
  if(path.endsWith('/workspace'))return {patient,appointments:appointments.map(a=>({...a})),visits:visits.map(v=>({...v}))};
  if(path==='/api/v1/appointments'){
   let saved=bookings.get(body.request_id);if(!saved){saved={...body,id:`appointment-${bookings.size+1}`,status:'booked'};bookings.set(body.request_id,saved);appointments.push(saved);}
   if(lostBooking){lostBooking=false;throw new Error('Synthetic lost booking response');}return {...saved};
  }
  if(path.endsWith('/check-in')){appointments.find(a=>path.includes(a.id)).status='checked_in';if(lostCheckIn){lostCheckIn=false;throw new Error('Synthetic lost check-in response');}return {};}
  if(path==='/api/v1/visits'){const appointment=appointments.find(a=>a.id===body.appointment_id);assert.equal(appointment.status,'checked_in');const visit={id:'visit-'+(visits.length+1),patient_id:patient.id,clinician_id:identity.user_id,appointment_id:appointment.id,status:'in_progress'};visits.push(visit);appointment.status='in_progress';if(lostStart){lostStart=false;throw new Error('Synthetic lost start response');}return visit;}
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
 assert.equal(h.bookings.size,1);assert.equal(h.visits.length,1);assert.equal(h.ctx.selectedVisit,'visit-1');assert.equal(h.ctx.step,'intake');
 const posts=h.calls.filter(c=>c.path==='/api/v1/appointments');assert.equal(posts.length,2);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(posts[0].body.starts_at,'2026-11-10T09:30:00.000Z');assert.equal(posts[0].body.ends_at,'2026-11-10T10:15:00.000Z');
 assert.equal(h.calls.filter(c=>c.path==='/api/v1/visits').length,1,'recover committed visit without creating another');
 await h.ctx.openEncounterStartFlow();assert.match(h.node('encounter-start-editor').innerHTML,/appointment-1/);assert.match(h.node('encounter-start-editor').innerHTML,/Continue encounter/);
 h.form.values.appointment_id='appointment-1';const existing=h.ctx.encounterStartInput(h.form);await h.ctx.continueEncounterStart(existing);assert.equal(h.bookings.size,1);assert.equal(h.visits.length,1);

 const cross=harness(),crossOp=cross.ctx.encounterStartInput(cross.form),original=cross.ctx.api;
 cross.ctx.api=async(...args)=>{const result=await original(...args);if(args[0]==='/api/v1/appointments')cross.ctx.selected='other-patient';return result;};
 await assert.rejects(cross.ctx.continueEncounterStart(crossOp),/Patient or sign-in changed/);
 assert.equal(cross.calls.filter(c=>c.path.endsWith('/check-in')||c.path==='/api/v1/visits').length,0,'no dependent writes after chart changes');
 cross.ctx.me={role:'front_desk',user_id:'staff'};cross.ctx.selected='patient';assert.throws(()=>cross.ctx.encounterStartInput(cross.form),/Open this patient/);

 const wrong=harness();wrong.appointments.push({id:'other-provider',patient_id:'patient',clinician_id:'other',starts_at:'2026-11-10T09:00:00Z',status:'checked_in'});wrong.form.values.appointment_id='other-provider';assert.throws(()=>wrong.ctx.encounterStartInput(wrong.form),/assigned to you/);
 const denied=harness();denied.ctx.coverage={id:'coverage',content:{payer_id:'payer',copay_cents:2500,plan_name:'Synthetic plan'}};
 denied.ctx.api=async()=>({items:[{id:'wrong-date',status:'completed',created_at:'2026-11-11T00:00:00Z',request_snapshot:{request:{service_date:'2026-11-09'}}},{id:'correct-date',status:'completed',created_at:'2026-11-10T00:00:00Z',request_snapshot:{request:{service_date:'2026-11-10'}}}]});
 await denied.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');assert.match(denied.node('encounter-benefits').innerHTML,/BENEFITS:correct-date/);assert.match(denied.node('encounter-benefits').innerHTML,/\$25\.00/);assert.doesNotMatch(denied.node('encounter-benefits').innerHTML,/BENEFITS:wrong-date/);
 let resolve;denied.ctx.api=()=>new Promise(r=>resolve=r);const pending=denied.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');denied.ctx.selected='other';denied.node('encounter-benefits').innerHTML='OTHER CHART';resolve({items:[]});await pending;assert.equal(denied.node('encounter-benefits').innerHTML,'OTHER CHART');
 const absent=harness();await absent.ctx.renderEncounterStartBenefits('encounter-benefits','2026-11-10');assert.match(absent.node('encounter-benefits').innerHTML,/does not establish that the patient is uninsured/);
 const rejected=harness(),rejectedForm=Object.assign(rejected.node('encounter-start-form'),rejected.form),field={disabled:false},submit={textContent:''};
 rejectedForm.querySelectorAll=()=>[field];rejectedForm.querySelector=()=>submit;
 rejected.ctx.api=async()=>{const error=new Error('Synthetic schedule conflict');error.status=409;throw error;};
 rejected.handlers.submit[0]({target:rejectedForm,preventDefault(){},stopImmediatePropagation(){}});await assert.rejects(rejected.ctx.pending,/schedule conflict/);
 assert.equal(field.disabled,false,'a definite booking rejection allows correcting the service time');assert.equal(submit.textContent,'Start encounter');
 const afterRejection=rejected.ctx.encounterStartInput(rejectedForm);assert.equal(afterRejection.booking.request_id,'request-2','only a definite rejection releases the old request');
 console.log('PASS single encounter start, frozen booking replay, uncertain check-in/start recovery, own-clinician context, service-date benefits and stale chart isolation');
})().catch(error=>{console.error(error);process.exitCode=1;});
