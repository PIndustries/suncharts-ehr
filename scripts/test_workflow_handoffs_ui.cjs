// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/care-pathways.js','utf8'),calls=[],reads=[],nodes={},responses=new Map();
const coverage=(id='coverage-1',content={})=>({id,content:{status:'active',effective_date:'2026-01-01',priority:'primary',payer_id:'payer-1',member_id:'Synthetic member',...content}});
const defaultApi=async(path,method)=>{assert.ok(!method||method==='GET','navigation only reads records');reads.push(path);if(!responses.has(path))throw new Error(`Unexpected read ${path}`);return responses.get(path);};
const context=vm.createContext({
 console,Map,Set,WeakMap,Date,encodeURIComponent,me:{role:'owner'},selected:null,activeVisit:undefined,chartSection:'overview',workspace:{billing:{accounts:[],coverages:[coverage()]}},
 document:{addEventListener(){}},$:id=>nodes[id]||null,esc:value=>String(value??''),human:value=>String(value??''),date:value=>value,payerName:value=>value,
 workspaceResourceAllowed:()=>true,workspaceChartTabEnabled:()=>true,
 showClinical:async()=>calls.push(['clinical']),selectPatient:async(patient,visit)=>{calls.push(['patient',patient,visit]);context.selected=patient;context.activeVisit=visit===null?undefined:{id:visit||'unrelated-active-visit'};},showChartSection:key=>{calls.push(['chart',key]);context.chartSection=key;},
 renderSpecialtyPatientWorkspace:async options=>calls.push(['specialty',JSON.parse(JSON.stringify(options.target))]),
 openClaimmdEligibility:async(coverage,options)=>{assert.equal(options.isCurrent(),true);calls.push(['eligibility',coverage.id,options.serviceDate,JSON.parse(JSON.stringify(options.history?.items.map(check=>check.id)||null)),!!options.readOnly]);},
 openBillingEditor:html=>{calls.push(['billing-editor',html]);nodes['journey-eligibility-coverage']={elements:{coverage:{value:''}}};},
 showSchedule:async()=>calls.push(['schedule']),appointmentDetail:async id=>calls.push(['appointment',id]),
 showClaimsWorkspace:async()=>calls.push(['claims']),showClaim:async id=>calls.push(['claim',id]),
 showFollowupWorkspace:async()=>calls.push(['global-followup']),openWorkflowIntakePacket:async id=>calls.push(['packet',id]),showPrevisit:async()=>calls.push(['previsit']),
 openPaymentStatus:async id=>calls.push(['payment',id]),showBillingAccount:id=>calls.push(['account',id]),
 studioOpenRunDispatch:async(id,instance)=>calls.push(['dispatch',id,instance]),
 api:defaultApi,
});
vm.runInContext(source,context);const run=code=>vm.runInContext(code,context),plain=value=>JSON.parse(JSON.stringify(value));
run('journeyRememberReturn=()=>{}');
function fixture(resource,kind='staff_task',options={}){
 calls.length=0;reads.length=0;responses.clear();context.api=defaultApi;context.workspace.billing.coverages=[coverage()];delete nodes['journey-eligibility-coverage'];
 responses.set('/api/v1/appointments/appointment-1',{id:'appointment-1',patient_id:'patient-1',starts_at:'2026-11-08T01:00:00Z'});
 responses.set('/api/v1/previsit/settings',{profile:{booking_timezone:'America/Chicago'}});
 responses.set('/api/v1/patients/patient-1/coverages/coverage-1/claimmd-eligibility',{items:[{id:'eligibility-1',patient_id:'patient-1',coverage_id:'coverage-1',request_snapshot:{request:{service_date:'2026-11-07'}}}]});
 const step={step_key:'step',kind,title:'Synthetic native work',state:'ready',required:true,version:1,...options.step};
 const item={id:'run-1',patient_id:'patient-1',appointment_id:'appointment-1',visit_id:'visit-1',definition_version:5,status:'active',definition:{steps:[{key:'step',kind,native:{resource},form_fields:options.fields||[]}]},steps:[step],...options.item};
 const [module,chart]=({appointment_booked:['schedule','visits'],check_in:['schedule','visits'],signed_visit:['clinical','visits'],functional_status:['specialty','functional_status'],neurotoxin:['specialty','specialty_care'],baclofen_pump_refill:['specialty','specialty_care'],stretching_program:['specialty','specialty_care'],care_coordination:['specialty','specialty_care'],eligibility:['billing','billing'],payment:['billing','billing'],order:['clinical','orders'],referral:['referrals','referrals'],intake_reviewed:['previsit','care_pathways'],follow_up:['followup','care_pathways'],claim_review:['claims','care_pathways'],claim_submitted:['claims','care_pathways'],claim_accepted:['claims','care_pathways']})[resource];
 const proof={step_key:'step',resource,status:'verified',ready:true,resource_id:`${resource}-1`,action:{module,chart_section:chart,patient_id:item.patient_id,appointment_id:item.appointment_id,visit_id:item.visit_id,resource_id:`${resource}-1`},...options.proof};
 const readiness={instance_id:item.id,definition_version:item.definition_version,steps:[proof]};
 Object.assign(context,{fixtureItem:item,fixtureStep:step,fixtureReadiness:readiness});run('patientPathways=[fixtureItem];pathwayReadiness=fixtureReadiness');
 return {item,step,proof,readiness};
}
async function main(){
 for(const [resource,section] of [['signed_visit','visits'],['functional_status','functional_status'],['neurotoxin','specialty_care'],['baclofen_pump_refill','specialty_care'],['stretching_program','specialty_care'],['care_coordination','specialty_care'],['eligibility','billing'],['order','orders'],['referral','referrals'],['follow_up','checkout']]){
  fixture(resource);await run("journeyOpenNative('run-1','step')");
  const expected=[['clinical'],['patient','patient-1','visit-1'],['chart',section]];
  if(section==='specialty_care')expected.push(['specialty',{patient_id:'patient-1',visit_id:'visit-1',kind:resource,resource_id:`${resource}-1`}]);
  if(resource==='eligibility')expected.push(['eligibility','coverage-1','2026-11-07',['eligibility-1'],true]);
  assert.deepEqual(calls,expected,`${resource} opens the linked patient and encounter's native work`);
 }
 for(const resource of ['claim_review','claim_submitted','claim_accepted']){
  fixture(resource);await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls,[['claims'],['claim',`${resource}-1`]]);
 }
 for(const resource of ['check_in','appointment_booked']){
  fixture(resource);await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls,[['schedule'],['appointment','appointment-1']]);
 }
 for(const resource of ['signed_visit','functional_status','neurotoxin','order','referral','follow_up','payment']){
  fixture(resource,'staff_task',{item:{visit_id:null},proof:{ready:false,status:'missing',resource_id:null,action:{module:resource==='payment'?'billing':resource==='follow_up'?'followup':'clinical',patient_id:'patient-1',appointment_id:'appointment-1',visit_id:null}}});
  assert.match(run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)'),/Open appointment to start encounter/);
  await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls,[['schedule'],['appointment','appointment-1']],`${resource} never selects another active encounter when this appointment has no visit`);
 }
 fixture('intake_reviewed','patient_form');await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls,[['packet','intake_reviewed-1']]);
 fixture('payment','payment_request');await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls,[['payment','payment-1']],'a payment proof ID opens payment review, never an account with that ID');
 context.workspace.billing.accounts=[{id:'account-1',content:{visit_id:'visit-1'}}];
 fixture('payment','payment_request',{proof:{ready:false,status:'missing',resource_id:null,action:{module:'billing',patient_id:'patient-1',visit_id:'visit-1',chart_section:'billing'}}});await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls,[['clinical'],['patient','patient-1','visit-1'],['chart','billing'],['account','account-1']],'a new payment opens the one account linked to this encounter');
 context.workspace.billing.accounts.push({id:'account-2',visit_id:'visit-1'});calls.length=0;await run("journeyOpenNative('run-1','step')");assert.ok(!calls.some(([name])=>name==='account'),'ambiguous accounts remain an explicit patient billing choice');

 const fields=[{key:'goal',label:'Patient goal',field_type:'long_text'}];
 let f=fixture('intake_reviewed','patient_form',{fields,item:{appointment_id:null,visit_id:null},proof:{ready:false,status:'missing',resource_id:null,action:{module:'previsit',patient_id:'patient-1',appointment_id:'booked-by-dispatch'}}});
 assert.equal(run('journeyAppointmentId(fixtureItem,fixtureReadiness)'),'booked-by-dispatch');
 assert.match(run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)'),/data-journey-issue="step"/);
 assert.doesNotMatch(run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)'),/Book an appointment before issuing/);
 for(const invalidate of [()=>f.readiness.definition_version++,()=>f.readiness.instance_id='another-run',()=>f.proof.action.patient_id='another-patient']){
  const before=JSON.stringify(f.readiness);invalidate();assert.equal(run('journeyAppointmentId(fixtureItem,fixtureReadiness)'),null);assert.doesNotMatch(run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)'),/data-journey-issue=/);Object.assign(f.readiness,JSON.parse(before));f.proof=f.readiness.steps[0];
 }
 context.me={role:'nurse'};assert.doesNotMatch(run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)'),/data-journey-issue=/,'only native intake-writing roles get an issuance action');context.me={role:'owner'};

 f=fixture('appointment_booked','appointment_booking',{item:{appointment_id:null,visit_id:null},proof:{ready:false,status:'missing',resource_id:null,action:{module:'schedule',patient_id:'patient-1'}}});
 let card=run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)');assert.match(card,/data-journey-booking="step"/);assert.doesNotMatch(card,/data-journey-open=/,'unbooked workflows use their reviewed dispatch instead of an unlinked generic editor');
 await assert.rejects(run("journeyOpenNative('run-1','step')"),/Prepare booking from this workflow/);assert.equal(calls.length,0);
 f.step.state='awaiting_approval';f.step.evidence={workflow_dispatch_id:'booking-review-1'};
 card=run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)');assert.match(card,/Open native action review/);await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls,[['dispatch','booking-review-1','run-1']]);

 fixture('functional_status','clinical_template');context.workspaceChartTabEnabled=key=>key!=='functional_status';
 assert.match(run('pathwayStepCard(fixtureStep,fixtureItem,fixtureReadiness)'),/hidden in the practice workspace/);assert.equal(run("journeyCanNavigate(journeyNativeAction(fixtureItem,fixtureStep,fixtureReadiness.steps[0]))"),false);
 await assert.rejects(run("journeyOpenNative('run-1','step')"),/hidden in the practice workspace/);assert.equal(calls.length,0,'disabled areas are rejected before leaving the journey or changing patient');
 context.workspaceChartTabEnabled=()=>true;context.workspaceResourceAllowed=()=>false;await assert.rejects(run("journeyOpenNative('run-1','step')"),/Your role cannot open/);assert.equal(calls.length,0);
 context.workspaceResourceAllowed=()=>true;context.fixtureReadiness.steps[0].action.patient_id='another-patient';await assert.rejects(run("journeyOpenNative('run-1','step')"),/linked context changed/);assert.equal(calls.length,0);
 const missingEligibility={ready:false,status:'missing',resource_id:null,action:{module:'billing',patient_id:'patient-1',appointment_id:'appointment-1',visit_id:null,chart_section:'billing'}};
 fixture('eligibility','eligibility_query',{item:{visit_id:null},proof:missingEligibility});await run("journeyOpenNative('run-1','step')");
 assert.deepEqual(calls,[['clinical'],['patient','patient-1',null],['chart','billing'],['eligibility','coverage-1','2026-11-07',null,false]],'a pre-visit check has no unrelated active encounter and uses the appointment date in the clinic timezone');assert.equal(context.activeVisit,undefined);
 fixture('eligibility','eligibility_query',{proof:missingEligibility});context.workspace.billing.coverages=[coverage('expired',{end_date:'2026-11-06'}),coverage('future',{effective_date:'2026-11-08'}),coverage()];await run("journeyOpenNative('run-1','step')");assert.equal(calls.at(-1)[1],'coverage-1');
 fixture('eligibility','eligibility_query',{proof:missingEligibility});context.workspace.billing.coverages.push(coverage('coverage-2',{priority:'secondary'}));await run("journeyOpenNative('run-1','step')");
 assert.equal(calls.at(-1)[0],'billing-editor');assert.ok(!calls.some(call=>call[0]==='eligibility'),'multiple coverages require staff choice');
 context.choiceForm=nodes['journey-eligibility-coverage'];context.choiceForm.elements.coverage.value='coverage-2';await run('journeyChooseEligibility(choiceForm)');assert.deepEqual(calls.at(-1),['eligibility','coverage-2','2026-11-07',null,false]);
 context.activeVisit={id:'different-visit'};await assert.rejects(run('journeyChooseEligibility(choiceForm)'),/patient or encounter changed/);
 fixture('eligibility');context.workspace.billing.coverages=[coverage('coverage-2'),coverage('coverage-1',{status:'inactive'})];responses.set('/api/v1/patients/patient-1/coverages/coverage-2/claimmd-eligibility',{items:[]});await run("journeyOpenNative('run-1','step')");assert.deepEqual(calls.at(-1),['eligibility','coverage-1','2026-11-07',['eligibility-1'],true],'existing evidence opens its own coverage even when another is currently active');
 fixture('eligibility');responses.get('/api/v1/patients/patient-1/coverages/coverage-1/claimmd-eligibility').items[0].request_snapshot.request.service_date='2026-11-08';await assert.rejects(run("journeyOpenNative('run-1','step')"),/linked eligibility response could not be found/);assert.ok(!calls.some(call=>call[0]==='eligibility'));
 fixture('eligibility');responses.get('/api/v1/appointments/appointment-1').patient_id='different-patient';await assert.rejects(run("journeyOpenNative('run-1','step')"),/appointment no longer matches/);
 fixture('eligibility','eligibility_query',{proof:missingEligibility});let release;const blocked=new Promise(resolve=>{release=resolve;});context.api=async(path,method)=>{if(path==='/api/v1/previsit/settings')await blocked;return defaultApi(path,method);};const opening=run("journeyOpenNative('run-1','step')");await new Promise(resolve=>setImmediate(resolve));context.selected='different-patient';release();await opening;assert.ok(!calls.some(call=>call[0]==='eligibility'||call[0]==='billing-editor'),'late reads cannot open a prior patient form');
 await nativeDestinationChecks();
 console.log('PASS journey handoffs, exact specialty record/type and eligibility coverage/date, explicit coverage selection, no unrelated encounter, stale response and hidden-area guards');
}
async function nativeDestinationChecks(){
 const panel={innerHTML:''},requests=[],specialty=vm.createContext({console,Map,Set,Date,crypto:{randomUUID:()=> 'synthetic-request'},document:{addEventListener(){}},$:id=>id==='specialty-care-panel'?panel:null,me:{role:'owner'},selected:'patient-1',activeVisit:{id:'visit-1'},esc:String,human:String,date:String,applyChartSection(){},api:async()=>new Promise(resolve=>requests.push(resolve))});
 vm.runInContext(fs.readFileSync('web/specialty-workspace.js','utf8'),specialty);vm.runInContext("practiceWorkspaceSettings={content:{chart_tabs:['specialty_care']}}",specialty);
 const treatment=(id,kind='baclofen_pump_refill',visit='visit-1')=>({id,kind,patient_id:'patient-1',visit_id:visit,status:'planned',version:1,content:{pump_model:id}});
 specialty.target={patient_id:'patient-1',visit_id:'visit-1',kind:'baclofen_pump_refill',resource_id:'exact-pump'};
 const generic=vm.runInContext('renderSpecialtyPatientWorkspace()',specialty),targeted=vm.runInContext('renderSpecialtyPatientWorkspace({target})',specialty);
 requests[1]({items:[treatment('exact-pump'),treatment('unrelated-pump','baclofen_pump_refill','visit-2'),treatment('other-type','care_coordination')]});await targeted;assert.match(panel.innerHTML,/exact-pump/);assert.doesNotMatch(panel.innerHTML,/unrelated-pump|other-type|Create specialty workflow/);
 requests[0]({items:[treatment('older-response')]});await generic;assert.doesNotMatch(panel.innerHTML,/older-response/,'earlier generic chart load cannot overwrite the exact record');
 for(const kind of ['neurotoxin','baclofen_pump_refill','stretching_program','care_coordination']){specialty.target={patient_id:'patient-1',visit_id:'visit-1',kind};const creating=vm.runInContext('renderSpecialtyPatientWorkspace({target})',specialty);requests.at(-1)({items:[]});await creating;assert.match(panel.innerHTML,new RegExp(`option value="${kind}" selected`));assert.match(panel.innerHTML,/<details class="clinical-editor" open>/);}
 specialty.target={patient_id:'patient-1',visit_id:'visit-1',kind:'baclofen_pump_refill',resource_id:'wrong-visit'};const mismatch=vm.runInContext('renderSpecialtyPatientWorkspace({target})',specialty);requests.at(-1)({items:[treatment('wrong-visit','baclofen_pump_refill','visit-2')]});await assert.rejects(mismatch,/no longer matches/);
 specialty.target={patient_id:'patient-1',visit_id:'visit-1',kind:'baclofen_pump_refill'};const ambiguous=vm.runInContext('renderSpecialtyPatientWorkspace({target})',specialty);requests.at(-1)({items:[treatment('pump-a'),treatment('pump-b')]});await ambiguous;assert.match(panel.innerHTML,/More than one matching record/);assert.doesNotMatch(panel.innerHTML,/Create specialty workflow/);

 const editor={},eligibility=vm.createContext({console,Date,crypto:{randomUUID:()=> 'synthetic-request'},document:{addEventListener(){}},$:()=>editor,selected:'patient-1',me:{role:'owner'},workspace:{patient:{given_name:'Synthetic',family_name:'Patient'}},esc:String,human:String,date:String,payerName:String,billingWrite:()=>true,billingField:(key,label,value)=>`<input name="${key}" value="${value}">`,selectField:()=>'',openBillingEditor:html=>{editor.html=html;},api:async()=>({items:[]})});
 vm.runInContext(fs.readFileSync('web/claimmd-eligibility.js','utf8'),eligibility);eligibility.coverage=coverage();await vm.runInContext("openClaimmdEligibility(coverage,{serviceDate:'2026-11-07'})",eligibility);assert.match(editor.html,/name="service_date" value="2026-11-07"/);
 await vm.runInContext("openClaimmdEligibility(coverage,{serviceDate:'2026-11-07',history:{items:[]},readOnly:true})",eligibility);assert.doesNotMatch(editor.html,/claimmd-eligibility-form/,'review of existing evidence cannot submit a new request');
 let release;eligibility.api=async()=>new Promise(resolve=>{release=resolve;});editor.html='current';const late=vm.runInContext('openClaimmdEligibility(coverage)',eligibility);eligibility.selected='another-patient';release({items:[]});await late;assert.equal(editor.html,'current','native eligibility opener checks identity after its read');

 const app=fs.readFileSync('web/app.js','utf8'),selectSource=app.slice(app.indexOf('async function selectPatient('),app.indexOf('\nconst date =',app.indexOf('async function selectPatient(')));
 const chart=vm.createContext({captureVisitDrafts(){},api:async path=>path.endsWith('/workspace')?{visits:[{id:'unrelated',status:'in_progress',clinician_id:'clinician'}]}:{items:[]},workspaceResourceAllowed:()=>true,chartSection:'overview',selected:null,activeVisit:undefined,workspace:null,billingPayers:[],me:{user_id:'clinician'},renderPatients(){},renderChart(){}});vm.runInContext(selectSource,chart);
 await vm.runInContext("selectPatient('patient-1')",chart);assert.equal(chart.activeVisit.id,'unrelated','omitted visit retains the normal chart default');await vm.runInContext("selectPatient('patient-1',null)",chart);assert.equal(chart.activeVisit,undefined,'explicit no-encounter workflow context does not inherit a different encounter');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
