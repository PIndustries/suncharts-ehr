// SPDX-License-Identifier: AGPL-3.0-only
// Fixture-only checks: no browser or live server access.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const root=path.resolve(__dirname,'..');
function fixture(){
 const nodes=new Map(),listeners=new Map(),calls=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',scrollIntoView(){},querySelector(){return null;},replaceChildren(){this.innerHTML='';}});return nodes.get(id);};
 const c=vm.createContext({Date,Intl,crypto:{randomUUID:()=> 'request-1'},console,
  document:{getElementById:node,addEventListener(name,callback,capture){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push({callback,capture});}},
  localTime:value=>{const d=new Date(value),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;},
  date:value=>new Date(value).toISOString(),esc:value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
  $:node,me:{role:'clinician',user_id:'provider-1'},selected:'off-page-patient',
  activeVisit:{id:'visit-1',appointment_id:'appointment-1',status:'in_progress'},
  workspace:{visits:[{id:'visit-1',appointment_id:'appointment-1',status:'in_progress',created_at:'2026-10-25T14:00:00Z'}],patient:{id:'off-page-patient',family_name:'Example',given_name:'Synthetic',mrn:'SYN-PINNED'},appointments:[{id:'appointment-1',title:'Synthetic follow-up',category:'Follow-up',facility:'Synthetic clinic',room:'4',clinician_id:'provider-1',status:'in_progress',starts_at:'2026-10-25T14:00:00Z'}]},
  FormData:class{constructor(form){this.values=form.values;}[Symbol.iterator](){return this.values[Symbol.iterator]();}},
  showChartSection:section=>calls.push(['section',section]),
  notice:message=>calls.push(['notice',message]),
  selectPatient:async(patient,visit)=>calls.push(['select',patient,visit]),
  api:async(url,method='GET',body)=>{calls.push(['api',url,method,body]);if(url==='/api/v1/schedule/providers')return {items:[{id:'provider-1',label:'Synthetic Clinician'}]};if(url==='/api/v1/appointments'&&method==='POST')return {id:'saved-appointment',starts_at:body.starts_at};throw Error('Unexpected fixture API '+url);},
  run:action=>{c.lastRun=action();}
 });
 const evaluate=code=>vm.runInContext(code,c);
 evaluate(fs.readFileSync(path.join(root,'web/scheduling.js'),'utf8'));
 return {c,evaluate,node,listeners,calls};
}
async function main(){
 const f=fixture();
 let html=f.evaluate('patientAppointmentWorkspace()');
 assert.match(html,/data-chart-book="off-page-patient"/);
 assert.match(html,/Synthetic follow-up/);assert.match(html,/Follow-up/);assert.match(html,/Synthetic clinic · Room 4/);
 assert.match(html,/<details id="patient-encounter-history" >/); // History is collapsed during the active encounter.
 assert.doesNotMatch(html,/id="booking-form"/);assert.match(html,/data-visit="visit-1">Continue encounter/);assert.doesNotMatch(html,/data-history-appointment="appointment-1"/,'linked appointments appear once as their encounter');
 await f.evaluate("openPatientAppointmentEditor('off-page-patient')");
 html=f.node('chart-booking-editor').innerHTML;
 assert.match(html,/data-chart-patient="off-page-patient" data-chart-visit="visit-1"/);
 assert.match(html,/<input type="hidden" name="patient_id" value="off-page-patient">/);
 assert.match(html,/Example, Synthetic/);assert.doesNotMatch(html,/id="schedule-patient-search"|<select id="schedule-patient"/);
 const startValue=html.match(/name="starts_at"[^>]*value="([^"]+)"/)[1],endValue=html.match(/name="ends_at"[^>]*value="([^"]+)"/)[1];
 const suggestedStart=new Date(startValue),suggestedEnd=new Date(endValue);
 assert(suggestedStart.getTime()>Date.now());assert.equal(suggestedStart.getMinutes()%30,0);assert.equal(suggestedEnd-suggestedStart,30*60000);
 for(const field of ['clinician_id','title','category','starts_at','ends_at','facility','room','notes','reason'])assert.match(html,new RegExp('name="'+field+'"'));
 assert.match(html,/Synthetic Clinician/);
 assert.equal(f.calls.filter(call=>call[0]==='api').length,1); // Opening the form only reads providers.
 assert.equal(f.calls.filter(call=>call[0]==='select').length,0); // No chart rerender or draft clearing.
 assert.match(f.evaluate('patientAppointmentWorkspace()'),/Synthetic Clinician/);
 await f.evaluate("appointmentEditor(null,{patient_id:'off-page-patient',source:{id:'source-1',source_instance:'Synthetic source',data:{starts_at:'2027-02-01T14:00:00Z',ends_at:'2027-02-01T14:45:00Z'}}},{patient_id:'off-page-patient',visit_id:'visit-1'})");
 html=f.node('chart-booking-editor').innerHTML;
 assert.match(html,new RegExp('name="starts_at"[^>]*value="'+f.c.localTime('2027-02-01T14:00:00Z')+'"'));
 assert.match(html,new RegExp('name="ends_at"[^>]*value="'+f.c.localTime('2027-02-01T14:45:00Z')+'"'));
 await f.evaluate("appointmentEditor({id:'existing-appt',patient_id:'off-page-patient',clinician_id:'provider-1',starts_at:'2027-03-01T16:00:00Z',ends_at:'2027-03-01T17:00:00Z'},null,{patient_id:'off-page-patient',visit_id:'visit-1'})");
 html=f.node('chart-booking-editor').innerHTML;
 assert.match(html,new RegExp('name="starts_at"[^>]*value="'+f.c.localTime('2027-03-01T16:00:00Z')+'"'));
 assert.match(html,new RegExp('name="ends_at"[^>]*value="'+f.c.localTime('2027-03-01T17:00:00Z')+'"'));

 const capture=f.listeners.get('click').find(item=>item.capture===true).callback;
 let prevented=false,stopped=false;
 capture({target:{closest:()=>({dataset:{},hasAttribute:name=>name==='data-chart-book-close'})},preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});
 assert(prevented&&stopped);assert.equal(f.node('chart-booking-editor').innerHTML,'');
 f.c.me.role='read_only';assert.doesNotMatch(f.evaluate('patientAppointmentWorkspace()'),/data-chart-book=/);
 await assert.rejects(f.evaluate("openPatientAppointmentEditor('off-page-patient')"),/Open the patient chart/);
 f.c.me.role='front_desk';assert.match(f.evaluate('patientAppointmentWorkspace()'),/data-chart-book=/);
 f.c.me.role='clinician';
 const form={id:'schedule-booking',dataset:{request:'request-1',chartPatient:'off-page-patient',chartVisit:'visit-1'},values:Object.entries({patient_id:'off-page-patient',clinician_id:'provider-1',title:'Synthetic return',category:'Follow-up',starts_at:'2026-10-26T14:00',ends_at:'2026-10-26T14:30',facility:'Synthetic clinic',room:'4',notes:'Synthetic visit only',reason:'Synthetic follow-up booking',repeat_frequency:'none',repeat_interval:'1',repeat_count:'4'})};
 const submit=f.listeners.get('submit')[0].callback;
 submit({target:form,preventDefault(){}});await f.c.lastRun;
 const post=f.calls.find(call=>call[0]==='api'&&call[2]==='POST');
 assert.equal(post[3].repeat_frequency,undefined);assert.equal(post[3].repeat_interval,undefined);assert.equal(post[3].repeat_count,undefined);
 assert.equal(post[1],'/api/v1/appointments');assert.equal(post[3].patient_id,'off-page-patient');assert.equal(post[3].clinician_id,'provider-1');assert.equal(post[3].category,'Follow-up');assert.equal(post[3].room,'4');assert.equal(post[3].request_id,'request-1');
 assert.deepEqual(f.calls.find(call=>call[0]==='select'),['select','off-page-patient','visit-1']);
 const postsBefore=f.calls.filter(call=>call[0]==='api'&&call[2]==='POST').length;
 f.c.selected='another-patient';submit({target:form,preventDefault(){}});
 await assert.rejects(f.c.lastRun,/Patient context changed/);
 assert.equal(f.calls.filter(call=>call[0]==='api'&&call[2]==='POST').length,postsBefore);

 // Appointment and encounter records form one history without losing orphan records.
 const h=fixture();h.evaluate(`workspace.appointments.push(
 {id:'appointment-complete',title:'Completed return',clinician_id:'provider-1',status:'completed',starts_at:'2026-10-24T14:00:00Z'},
 {id:'appointment-booked',title:'Next appointment',clinician_id:'provider-1',status:'booked',starts_at:'2026-10-28T14:00:00Z'},
 {id:'appointment-unlinked',title:'Historic appointment',clinician_id:'provider-1',status:'completed',starts_at:'2026-10-22T14:00:00Z'});
 workspace.visits.push({id:'visit-complete',appointment_id:'appointment-complete',status:'signed',created_at:'2026-10-24T14:05:00Z',signed_at:'2026-10-26T14:00:00Z'},
 {id:'visit-orphan',appointment_id:'missing-appointment',status:'signed',created_at:'2026-10-23T14:00:00Z'});`);
 const entries=JSON.parse(JSON.stringify(h.evaluate('patientEncounterHistoryEntries()')));
 assert.deepEqual(entries.map(row=>row.visit?.id||row.appointment.id),['appointment-booked','visit-1','visit-complete','visit-orphan','appointment-unlinked'],'history sorts by service date instead of later signature date');
 const timeline=h.evaluate('patientAppointmentWorkspace()');
 assert.equal([...timeline.matchAll(/data-history-visit="visit-complete"/g)].length,1);assert.doesNotMatch(timeline,/data-history-appointment="appointment-complete"/);assert.match(timeline,/data-visit="visit-complete">Open completed encounter/);assert.match(timeline,/Completed · Signed/);assert.match(timeline,/data-visit="visit-orphan"/);assert.match(timeline,/data-history-appointment="appointment-unlinked"/);assert.match(timeline,/No visit note was started/);assert.match(timeline,/data-check-in="appointment-booked"/);
 h.c.me.role='read_only';assert.doesNotMatch(h.evaluate('patientAppointmentWorkspace()'),/data-check-in=|data-start=|data-chart-book=/);assert.match(h.evaluate('patientAppointmentWorkspace()'),/data-visit="visit-complete"/);assert.equal(h.calls.length,0,'history rendering performs no mutation or fetch');
 h.c.activeVisit=null;assert.match(h.evaluate('patientAppointmentWorkspace()'),/<details id="patient-encounter-history" open>/);
 console.log('PASS chart booking: full editor, pinned patient, actual provider, roles, no opening rerender, capture close, native POST, visit-preserving return and stale-context rejection');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
