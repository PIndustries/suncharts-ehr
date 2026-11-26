// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic fixture checks only: no server, processor or patient data.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,appointment,plain,DAY}=require('./test_schedule_board_ui.cjs');
const read=file=>fs.readFileSync(file,'utf8');
async function main(){
 const f=fixture(),{c,run,node,calls}=f;
 run(read('web/patient-picker.js'));
 c.picker={options:{oncreate(){}},items:[],query:'Synthetic Newperson',busy:false,error:'',cursor:null};
 assert.match(run('patientPickerListHtml(picker)'),/\+ New patient 'Synthetic Newperson'/);
 c.picker.busy=true;assert.doesNotMatch(run('patientPickerListHtml(picker)'),/data-patient-picker-create/);
 c.picker.busy=false;c.picker.error='Read failed';assert.doesNotMatch(run('patientPickerListHtml(picker)'),/data-patient-picker-create/);
 c.picker.error='';c.picker.items=[{given_name:'Synthetic',family_name:'Newperson',mrn:'SYN-1'}];
 assert.doesNotMatch(run('patientPickerListHtml(picker)'),/data-patient-picker-create/);
 const block={hidden:true,disabled:true},elements=Object.fromEntries(['new_given_name','new_family_name','title','category','starts_at','ends_at'].map(key=>[key,{value:'',focus:()=>{}}]));
 elements.starts_at.value=`${DAY}T09:00`;
 const type={value:'follow-up',dataset:{version:'2',name:'Synthetic follow-up',category:'Follow-up',minutes:'45'}};
 const form={id:'schedule-booking',dataset:{request:'synthetic-book'},elements,querySelector:selector=>selector==='[data-booking-new-patient]'?block:selector==='[data-booking-type]'?{selectedOptions:[type]}:null};
 c.form=form;c.picker={input:{isConnected:true,required:true,setAttribute(){},removeAttribute(){}},field:{value:''},popup:{hidden:false},list:{},status:{}};
 node('schedule-booking').querySelector=form.querySelector;node('schedule-booking').elements=elements;node('schedule-booking').dataset=form.dataset;
 run("scheduleNewPatient('Synthetic Newperson',picker)");
 assert.equal(block.hidden,false);assert.equal(block.disabled,false);assert.equal(elements.new_family_name.value,'Newperson');
 assert.equal(c.picker.input.required,false);
 f.load([appointment('type','09:00','09:45',{title:'Synthetic follow-up',category:'Follow-up'})]);
 run("scheduleApplyBookingType(form)");assert.equal(elements.title.value,'Synthetic follow-up');assert.equal(elements.category.value,'Follow-up');assert.equal(elements.ends_at.value,`${DAY}T09:45`);
 c.FormData=class{constructor(form){this.values=Object.entries(form.values);}[Symbol.iterator](){return this.values[Symbol.iterator]();}};
 form.values={patient_id:'',new_given_name:'Synthetic',new_family_name:'Newperson',new_birth_date:'1990-01-01',new_phone:'2025550100',new_sex:'',new_insurance_id:'synthetic-payer',new_member_id:'SYN-001',title:'Synthetic follow-up',category:'Follow-up',clinician_id:'p1',starts_at:`${DAY}T09:00`,ends_at:`${DAY}T09:45`};
 const originalApi=c.api;let bookingFails=true;
 c.api=async(url,method,body)=>{calls.push(['booking',url,method,body]);if(url==='/api/v1/patients')return {id:'synthetic-new'};if(url.endsWith('/demographics'))return method==='PUT'?{}:{content:{phone:'2025550100'}};if(url.endsWith('/coverages'))return {};if(url==='/api/v1/patients/synthetic-new')return {id:'synthetic-new',given_name:'Synthetic',family_name:'Newperson'};if(url==='/api/v1/appointments'){if(bookingFails)throw Error('Synthetic conflict');return {id:'new-booking',starts_at:body.starts_at};}return originalApi(url,method,body);};
 run('showSchedule=async()=>{};appointmentDetail=async()=>{}');
 const submit=()=>{for(const h of f.listeners.get('submit'))h.callback({target:form,preventDefault(){}});return c.pending;};
 await assert.rejects(submit(),/Synthetic conflict/);bookingFails=false;await submit();
 assert.equal(calls.filter(x=>x[0]==='booking'&&x[1]==='/api/v1/patients').length,1,'retry reuses the created patient');
 assert.deepEqual(calls.filter(x=>x[0]==='booking').slice(0,6).map(x=>x[1]),['/api/v1/patients','/api/v1/patients/synthetic-new/demographics','/api/v1/patients/synthetic-new','/api/v1/patients/synthetic-new/demographics','/api/v1/patients/synthetic-new/coverages','/api/v1/appointments']);
 assert.equal(calls.filter(x=>x[0]==='booking'&&x[1].endsWith('/coverages')).length,1,'booking retry does not duplicate insurance');
 assert.equal(run("schedulePatients.find(p=>p.id==='synthetic-new').demographics.content.phone"),'2025550100');
 c.newAppointment=appointment('phone','09:00','09:30',{patient_id:'synthetic-new'});assert.match(run("schedulePanelHtml(newAppointment,'Synthetic Newperson',[])"),/2025550100/);
 const booked=calls.filter(x=>x[0]==='booking'&&x[1]==='/api/v1/appointments').at(-1)[3];
 assert.equal(booked.patient_id,'synthetic-new');assert(!Object.keys(booked).some(k=>k.startsWith('new_')));
 // The actual editor retains slot time/provider and includes the inline registration fields.
 run("loadSchedulePatients=async()=>{};schedulePanel=html=>calls.push(['booking-markup',html]);mountScheduleBookingPatientPicker=()=>{};attachScheduleLocations=async()=>{}");
 await run(`appointmentEditor(null,null,null,'${DAY}','${DAY}T11:15','p2')`);
 const editor=calls.find(x=>x[0]==='booking-markup')[1];
 assert.match(editor,/Choose a visit type/);assert.match(editor,/Insurance \(optional\)/);assert.doesNotMatch(editor,/Office visit · Office visit/);
 assert.match(editor,/data-booking-new-patient hidden disabled/);assert.match(editor,/>Visit type<select data-booking-type>/);
 assert.match(editor,/value="p2" selected/);assert.match(editor,new RegExp(`name="starts_at"[^>]*value="${DAY}T11:15"`));
 // Recurring booking keeps its existing preview/review, using the same registered patient.
 run(read('web/appointment-workflows.js'));
 const hiddenPatient={value:''},preview={innerHTML:''};form.isConnected=true;
 form.values.repeat_frequency='weekly';form.values.repeat_count='2';form.values.repeat_interval='1';
 form.querySelector=selector=>selector==='[name="patient_id"]'?hiddenPatient:selector==='#series-preview'?preview:null;
 const bookingApi=c.api;c.api=async(url,method,body)=>{if(url.endsWith('/series/preview')){assert.equal(body.patient_id,'synthetic-new');return {existing_series_id:'synthetic-series'};}return bookingApi(url,method,body);};
 // Model the browser's hidden input participating in FormData.
 Object.defineProperty(form.values,'patient_id',{get:()=>hiddenPatient.value,enumerable:true,configurable:true});
 await run('previewRecurring(form)');assert.match(preview.innerHTML,/Open existing series/);
 const g=fixture(),a=appointment('a','09:00','09:30'),marker={appointment_id:'a',insurance:{coverage_id:'primary',status:'not_checked'},copay:{due_cents:2500,paid_cents:500}};
 g.load([a],[marker]);g.run("scheduleSelected='a';showSchedule=async()=>calls.push(['reload']);appointmentDetail=async()=>{}");
 const baseApi=g.c.api;let disconnected=false;
 g.c.api=async(url,method,body)=>{if(url.endsWith('/check-in')){g.calls.push(['check-in']);a.status='checked_in';return {};}
  if(url.endsWith('/claimmd-eligibility/check')){assert.equal(a.status,'checked_in');assert.match(g.node('schedule-panel-insurance').innerHTML,/Checking insurance…/);g.calls.push(['eligibility',url,body]);marker.insurance.status='active';return disconnected?{outcome:'needs',needs:[{kind:'claim_connection'}]}:{outcome:'checked'};}return baseApi(url,method,body);};
 await g.run('scheduleCheckIn(scheduleState.appointments[0])');
 assert(g.calls.findIndex(x=>x[0]==='check-in')<g.calls.findIndex(x=>x[0]==='eligibility'));
 assert.match(g.calls.find(x=>x[0]==='eligibility')[1],/coverages\/primary\//);
 assert.match(g.node('schedule-panel-insurance').innerHTML,/Active/);
 // A failed insurer request leaves arrival recorded and shows the existing fallback wording.
 g.c.document.createElement=()=>({textContent:''});g.node('schedule-panel-insurance').append=child=>g.calls.push(['insurance-message',child.textContent]);
 const insuranceApi=g.c.api;g.c.api=async(url,method,body)=>{if(url.endsWith('/claimmd-eligibility/check'))throw Error('Synthetic insurer outage');return insuranceApi(url,method,body);};
 a.status='booked';await g.run('scheduleCheckIn(scheduleState.appointments[0])');assert.equal(a.status,'checked_in');assert.match(g.node('schedule-panel-insurance').innerHTML,/could not confirm coverage/);g.c.api=insuranceApi;
 let html=g.run('scheduleCopayHtml(scheduleState.appointments[0])');
 assert.match(html,/Copay \$20 due/);assert.match(html,/Take payment/);assert.doesNotMatch(html,/Charge card on file/);
 g.c.savedCardsForCharge=async()=>({cards:[{setup_id:'synthetic-card',brand:'Visa',last4:'4242'}]});g.c.savedCardName=card=>card.brand+' ending '+card.last4;
 await g.run('loadScheduleCopayCards(scheduleState.appointments[0])');
 html=g.run('scheduleCopayHtml(scheduleState.appointments[0])');assert.match(html,/Charge card on file/);assert.match(html,/4242/);
 assert.match(g.run("schedulePanelHtml(scheduleState.appointments[0],'Synthetic Patient',[])"),/class="primary" data-schedule-start="a"/);
 // The existing saved-card endpoint receives the displayed remaining copay in one press.
 let charged=null,reads=0;g.c.watchSavedCardPayment=live=>{g.c.live=live;};
 g.c.api=async(url,method,body)=>{g.calls.push(['payment',url,method,body]);if(method==='POST'){charged=body;return {operation:{id:'synthetic-operation',request_id:body.request_id,status:'paid'}};}reads++;return {availability:{available:true,livemode:false},items:charged?[{id:'synthetic-operation',request_id:charged.request_id,status:'paid'}]:[]};};
 await g.run('scheduleChargeCopay(scheduleState.appointments[0])');assert.equal(charged.amount_cents,2000);assert.equal(charged.saved_card_setup_id,'synthetic-card');assert.equal(charged.livemode,false);
 await g.run('scheduleChargeCopay(scheduleState.appointments[0])');assert.equal(g.calls.filter(x=>x[0]==='payment'&&x[2]==='POST').length,1,'repeated press recovers the same operation');assert.equal(reads,2);
 // No saved card: the existing appointment payment sheet gets this copay amount.
 g.c.api=baseApi;g.c.document.createComment=()=>({parentNode:null});g.c.sheetOpen=(title,panel)=>({addEventListener(){}});g.node('appointment-copay-card').before=()=>{};
 g.c.loadHostedCopays=async()=>{};g.c.openHostedCopayEditor=async(...args)=>g.calls.push(['payment-sheet',...args]);
 await g.run('scheduleCollectCopay(scheduleState.appointments[0])');assert.deepEqual(g.calls.find(x=>x[0]==='payment-sheet'),['payment-sheet','a','insurance-hosted-copay',2000]);
 // Self-pay check-in is recorded before offering insurance; dismissing writes nothing.
 const h=fixture(),self=appointment('self','10:00','10:30');h.load([self],[{appointment_id:'self',insurance:{status:'self_pay'}}]);
 h.run("scheduleSelected='self';showSchedule=async()=>{};appointmentDetail=async()=>{}");
 await h.run('scheduleCheckIn(scheduleState.appointments[0])');
 assert.match(h.node('schedule-panel-copay').innerHTML,/No insurance on file. Self-pay visit\?/);
 assert.match(h.node('schedule-panel-copay').innerHTML,/data-add-insurance-sheet="patient-self"/);
 assert.equal(h.calls.filter(c=>c[0]==='api'&&c[2]==='POST').length,1);
 console.log('PASS self-pay prompt follows successful check-in without another mutation');
 // Explain the missing clearinghouse while retaining the successful check-in.
 g.c.api=async(url,method,body)=>{if(url.endsWith('/check-in'))return {};if(url.endsWith('/claimmd-eligibility/check'))return {outcome:'needs',needs:[{kind:'claim_connection'}]};return baseApi(url,method,body);};
 a.status='booked';await g.run('scheduleCheckIn(scheduleState.appointments[0])');
 assert(g.calls.some(x=>x[0]==='notice'&&x[1]==='Patient checked in.'&&!x[2]));
 const disconnectedMessage='Insurance not checked: the clearinghouse is not connected yet.';
 assert.match(g.node('schedule-panel-insurance').innerHTML,/Insurance not checked: the clearinghouse is not connected yet\./);
 assert.equal(g.run('scheduleInsuranceCheckMessage(scheduleState.appointments[0])'),disconnectedMessage);
 assert.match(g.run('scheduleInsuranceHtml(scheduleState.appointments[0])'),/clearinghouse is not connected yet/,'explanation survives panel rerender');
 const signedIn=g.c.me;g.c.me={...signedIn};assert.equal(g.run('scheduleInsuranceCheckMessage(scheduleState.appointments[0])'),'','other sessions do not inherit the explanation');g.c.me=signedIn;
 g.c.api=async(url,method,body)=>url.endsWith('/claimmd-eligibility/check')?{outcome:'needs',needs:[{kind:'member_id'}]}:url.endsWith('/check-in')?{}:baseApi(url,method,body);
 a.status='booked';await g.run('scheduleCheckIn(scheduleState.appointments[0])');assert.match(g.node('schedule-panel-insurance').innerHTML,/The insurer needs a little more information/);
 g.c.api=async(url,method,body)=>url.endsWith('/claimmd-eligibility/check')?{outcome:'checked'}:url.endsWith('/check-in')?{}:baseApi(url,method,body);
 a.status='booked';await g.run('scheduleCheckIn(scheduleState.appointments[0])');assert.equal(g.run('scheduleInsuranceCheckMessage(scheduleState.appointments[0])'),'','answered retry clears the explanation');
 // Exercise the actual tab routing, then both schedule and header start handlers.
 const app=read('web/app.js'),start=app.indexOf('function setEncounterSection('),end=app.indexOf('\nfunction refreshEncounterProgress',start);
 g.run("let chartSection='visits',encounterSection='charges';function encounterSections(){return [['visit','Visit'],['documentation','Note']];}function captureVisitDrafts(){}function applyChartSection(){}function alignChartContent(){}");
 g.c.invoiceTabSet=(tab)=>g.calls.push(['tab',tab]);g.run(app.slice(start,end));
 g.c.api=async()=>({id:'synthetic-encounter'});
 await g.click({scheduleStart:'a',patient:a.patient_id});assert(g.calls.some(x=>x[0]==='tab'&&x[1]==='note'));
 g.calls.length=0;g.c.button={dataset:{start:'a'}};
 const headerStart=app.slice(app.indexOf('if(button.dataset.start){'),app.indexOf('\n    if(button.dataset.visit)'));
 await g.run(`(async()=>{${headerStart}})()`);assert(g.calls.some(x=>x[0]==='tab'&&x[1]==='note'));
 assert.match(read('web/encounter-start.js'),/setEncounterSection\('visit'\)/);
 const revenue=read('web/patient-revenue.js');
 assert.match(revenue,/const encounterStepChips=\[\[1,'Visit'\],\[2,'Payment'\]\]/);
 assert.match(revenue,/data-encounter-claim-status[^\n]*data-open-signed-claim-details/,'claim details remain available inside Visit');
 assert.doesNotMatch(revenue,/data-step-continue|Continue to note|Review rooming, vitals, insurance and copay/);
 assert.match(revenue,/key==='note'\?1:key==='payments'\?2:'claim'/);
 // The floating editor stays below the top bar and patient header on short screens.
 const props=new Map();g.c.window={innerWidth:375,innerHeight:400};g.c.document.querySelector=s=>({getBoundingClientRect:()=>({bottom:s==='.shell-topbar'?60:140})});g.c.document.querySelectorAll=()=>[];
 g.c.float={classList:{contains:()=>true},style:{setProperty:(k,v)=>props.set(k,v),getPropertyValue:k=>props.get(k)}};
 g.run('placeSchedulePanel(float)');assert.equal(props.get('top'),'148px');assert.match(props.get('max-height'),/148px/);
 console.log('PASS check-in flow: inline create and book, retry recovery, encounter type duration, eligibility after check-in, quiet disconnected clearinghouse, copay buttons and amount, saved-card recovery, payment sheet, continuous encounter and bounded editor');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
