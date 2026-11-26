// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');
const app=source('web/app.js');
for(const file of ['web/app.js','web/patient-revenue.js','web/demographics.js','web/patient-identity.js'])new vm.Script(source(file),{filename:file});
const nodes=new Map(),listeners=new Map(),calls=[];
const node=id=>{if(!nodes.has(id))nodes.set(id,{id,dataset:{},innerHTML:'',hidden:false});return nodes.get(id);};
const context=vm.createContext({console,Date,Intl,Map,WeakMap,Promise,
 document:{getElementById:node,addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);}},
 $:node,selected:'synthetic-patient',me:{role:'owner',user_id:'synthetic-staff'},chartSection:'vitals',activeVisit:null,
 workspace:{visits:[],appointments:[],demographics:{content:{}},billing:{coverages:[],copays:[]}},
 esc:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 human:value=>String(value??'').replaceAll('_',' ').replace(/^./,c=>c.toUpperCase()),
 money:cents=>`$${(cents/100).toFixed(2)}`,
 billingCan:()=>true,payerName:()=> 'Synthetic Payer',billingPayers:[{id:'payer',content:{payer_code:'SYN123'}}],
 run:fn=>fn(),openEncounterStartFlow:async mode=>calls.push(['start',mode]),
 openVitalsForm:()=>calls.push(['form']),chartOpenEditor:()=>calls.push(['editor']),
 canRecordVisitVitals:v=>v?.status==='in_progress',
 api:async()=>({items:[]}),appointmentCopays:()=>[],loadHostedCopays:async()=>{},
 claimmdEligibilityCard:()=>'<span class="pill">Active</span>',
 claimmdEligibilityUiFor:()=>({needs:[]}),
 });
const evaluate=code=>vm.runInContext(code,context);
evaluate(source('web/display-format.js'));
evaluate('const date=displayDateTime;');
evaluate(app.slice(app.indexOf('function chartListHeader('),app.indexOf('function chartRecordTemplate(')));
evaluate(app.slice(app.indexOf('const VITAL_US_UNITS='),app.indexOf('function visitVitalsSummary(')));
evaluate(app.slice(app.indexOf('let patientVitalsReadings;'),app.indexOf('function chartAreaEnabled(')));
evaluate(source('web/patient-revenue.js'));
evaluate(source('web/demographics.js'));
evaluate(source('web/patient-identity.js'));
evaluate("hostedCopayPanel=(appointment,id)=>appointment?`<section id=\"${id}\">Collect copay</section>`:'';loadHostedCopays=async()=>{};");
const markup=()=>evaluate('patientVitalsHistory()');
async function main(){
 let html=markup();
 assert.match(html,/\+ Record vitals/);assert.match(html,/No vitals recorded\./);
 for(const col of ['Date','BP','Pulse','Temperature','Respiratory rate','SpO2','Weight','Height','BMI','Pain','Recorded by'])assert.ok(html.includes(`<th scope="col">${col}</th>`));
 // Exercise the actual Record vitals click branch, including signed and absent encounters.
 const clickLine=app.split('\n').find(line=>line.includes("if(target?.hasAttribute('data-chart-record-vitals'))"));
 evaluate(`function recordClick(target){${clickLine}}`);
 context.button={hasAttribute:()=>true};
 await evaluate('recordClick(button)');assert.deepEqual(calls,[['start','new']]);calls.length=0;
 context.activeVisit={status:'signed'};await evaluate('recordClick(button)');assert.deepEqual(calls,[['start','new']]);calls.length=0;
 context.activeVisit={status:'in_progress'};await evaluate('recordClick(button)');assert.deepEqual(calls,[['form'],['editor']]);
 const vitals={systolic_mm_hg:120,diastolic_mm_hg:80,heart_rate_bpm:72,temperature_c:37,weight_kg:70,height_cm:175,oxygen_saturation_pct:98,respiratory_rate_per_min:16,pain_score:0};
 context.workspace.visits=[{id:'visit',appointment_id:'appointment',vitals}];
 context.workspace.appointments=[{id:'appointment',starts_at:'2026-11-24T15:00:00Z',status:'checked_in',title:'Synthetic visit'}];
 context.api=async url=>({history:[{kind:'vitals',created_at:'2026-11-24T15:00:00Z',actor_label:'Synthetic Nurse',snapshot:{vitals}},{kind:'vitals',created_at:'2026-11-20T15:00:00Z',actor_label:'Synthetic Assistant',snapshot:{vitals:{...vitals,weight_kg:68,heart_rate_bpm:70}}}]});
 await evaluate('loadPatientVitalsReadings()');html=markup();
 for(const text of ['Nov 24, 2026','120/80 mmHg','72 bpm','98 %','16 breaths/min','0 /10','98.6 °F (37 °C)','154.3 lb (70 kg)','68.9 in (175 cm)','22.9 kg/m²','Synthetic Nurse','Synthetic Assistant'])assert.ok(html.includes(text),text);
 assert.ok(html.indexOf('Nov 24, 2026')<html.indexOf('Nov 20, 2026'));
 assert.equal((html.match(/<svg /g)||[]).length,3);assert.equal((html.match(/<polyline /g)||[]).length,4);assert.doesNotMatch(html,/NaN|Infinity|undefined|2026-11-24/);
 assert.match(evaluate("patientVitalsTrend('Pulse', [{when:'2026-11-24',vitals:{heart_rate_bpm:0}}], ['heart_rate_bpm'])"),/more readings needed/);
 // A late request must not repaint another patient's chart.
 let resolve;context.api=()=>new Promise(done=>{resolve=done;});
 const pending=evaluate('loadPatientVitalsReadings()');context.selected='other-patient';node('patient-vitals-history').outerHTML='unchanged';resolve({history:[]});await pending;assert.equal(node('patient-vitals-history').outerHTML,'unchanged');context.selected='synthetic-patient';
 context.api=async()=>{throw Error('synthetic offline');};await evaluate('loadPatientVitalsReadings()');assert.match(markup(),/Some earlier readings could not be loaded/);
 context.api=async()=>({history:Array.from({length:100},(_,i)=>({kind:'vitals',created_at:'2026-11-24T15:00:00Z',actor_label:'Synthetic Nurse',snapshot:{vitals:{heart_rate_bpm:70+i}}}))});
 await evaluate('loadPatientVitalsReadings()');assert.match(markup(),/Earlier readings may be missing/);
 assert.match(evaluate("patientVitalsTrend('BP', [{when:'2026-11-24',vitals:{systolic_mm_hg:120,diastolic_mm_hg:80}}], ['systolic_mm_hg','diastolic_mm_hg'])"),/more readings needed/);
 const coverage={id:'coverage',version:1,content:{payer_id:'payer',status:'active',priority:'primary',plan_name:'Synthetic Plan',member_id:'SYN-MEMBER',group_number:'SYN-GROUP',subscriber_name:'Synthetic Holder',relationship:'child',subscriber_birth_date:'1980-03-12',effective_date:'2026-01-01',end_date:'2026-12-31',copay_cents:2500,verification:'manually_verified',notes:'Synthetic notes'}};
 context.workspace.billing.coverages=[coverage,{id:'prior',version:1,content:{...coverage.content,status:'inactive',plan_name:'Synthetic Prior'}}];context.coverage=coverage;
 evaluate("eligibilityState().items.set('coverage',{history:{items:[{created_at:'2026-11-23T15:00:00Z',status:'completed'}]}})");
 html=evaluate('insuranceCoverageCard(coverage)');
 for(const text of ['Synthetic Plan','SYN-MEMBER','SYN-GROUP','$25.00','Synthetic Holder','Child','Mar 12, 1980','SYN123','Jan 1, 2026','Dec 31, 2026','Nov 23, 2026','Synthetic notes','pill green','>Active</span>','data-edit-coverage','data-coverage-open'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/1980-03-12|2026-01-01/);
 context.claimmdEligibilityUiFor=()=>({needs:[{kind:'claim_connection'}]});evaluate("eligibilityState().items.set('coverage',{history:{items:[]}})");assert.match(evaluate("insuranceEligibilityMarkup(eligibilityState().items.get('coverage'),'coverage','2026-11-24')"),/Not checked.*the clearinghouse is not connected yet/);
 context.chartSection='insurance';context.activeVisit=null;
 context.api=async()=>({items:[{id:'card',content_type:'image/png',content:{category:'insurance',status:'active',title:'Synthetic front'}},{id:'private',content_type:'image/png',content:{category:'identity',status:'active',title:'Identity'}}]});
 // Keep eligibility requests isolated from the synthetic document response.
 evaluate('loadInsuranceEligibility=()=>{};insuranceAutoEligibility=()=>{};');
 evaluate('renderPatientInsurance()');await evaluate('loadInsuranceCardImages()');html=node('insurance-workspace').innerHTML;
 assert.match(html,/For the visit on Nov 24, 2026/);assert.match(html,/<select id="insurance-appointment">/);
 assert.match(html,/<details class="insurance-supporting-records"><summary>Inactive &amp; prior \(1\)/);assert.match(html,/Current insurance/);assert.match(html,/\+ Add insurance/);
 assert.match(html,/id="insurance-page-copay"/);assert.match(html,/data-insurance-copay-status role="status">\$25\.00 copay due/);
 assert.equal((html.match(/data-insurance-copay-collect=/g)||[]).length,1);
 assert.doesNotMatch(html,/data-record-copay|data-reader-copay|data-saved-card-copay|data-collect-card-copay/);
 assert.match(node('insurance-card-images').innerHTML,/<img.*documents\/card\/preview/);assert.doesNotMatch(node('insurance-card-images').innerHTML,/Identity/);
 context.workspace.appointments.push({id:'next-appointment',starts_at:'2026-11-25T15:00:00Z',status:'booked',title:'Synthetic next visit'});
 const change={target:{id:'insurance-appointment',value:'next-appointment'}};
 for(const listener of listeners.get('change')||[])listener(change);
 assert.match(node('insurance-workspace').innerHTML,/For the visit on Nov 25, 2026/);
 assert.equal(evaluate("readerCopaySlot('insurance-page-hosted-copay')").id,'insurance-page-hosted-copay-reader');
 const readerClick=source('web/patient-revenue.js').split('\n').find(line=>line.includes('if(button.dataset.readerCopay)'));
 context.openReaderCopayEditor=async(...args)=>calls.push(args);
 evaluate(`function readerClick(button,event){${readerClick}}`);
 context.readerButton={dataset:{readerCopay:'next-appointment'},closest:()=>({id:'insurance-page-hosted-copay'})};context.clickEvent={preventDefault(){}};
 evaluate('readerClick(readerButton,clickEvent)');assert.deepEqual(calls.at(-1),['next-appointment','insurance-page-hosted-copay']);
 let finishCards;context.api=()=>new Promise(done=>{finishCards=done;});
 const loadingCards=evaluate('loadInsuranceCardImages()');node('insurance-card-images').innerHTML='other chart';context.selected='other-patient';finishCards({items:[]});await loadingCards;assert.equal(node('insurance-card-images').innerHTML,'other chart');context.selected='synthetic-patient';context.api=async()=>({items:[]});
 context.workspace.billing.coverages=[];evaluate('renderPatientInsurance()');html=node('insurance-workspace').innerHTML;assert.match(html,/No insurance recorded for this visit date/);assert.match(html,/Inactive &amp; prior \(0\)/);assert.match(html,/\+ Add insurance/);
 context.profile={version:0,content:{pronouns:'they/them'},history:[]};html=evaluate('demographicsSummary(profile)');
 assert.match(html,/Pronouns.*they\/them/);assert.match(html,/No contact details yet/);assert.match(html,/Blank fields have not been collected yet/);assert.match(html,/<\/div><details><summary>Change history/);assert.doesNotMatch(html,/<summary>More ▾<\/summary><details><summary>Change history/);
 context.chartSection='profile';context.workspace.demographics.content={pronouns:'they/them'};
 context.identityData={patient:{mrn:'SYN-1',given_name:'Synthetic',family_name:'Patient',birth_date:'1980-03-12'},version:1,can_edit:true,history:[{version:1,created_at:'2026-11-24',actor_label:'Synthetic Staff',reason:'Synthetic correction',snapshot:{birth_date:'1980-03-12'}}]};
 evaluate('showPatientIdentity(identityData)');html=node('patient-identity-panel').innerHTML;assert.match(html,/Pronouns.*they\/them/);assert.match(html,/Mar 12, 1980/);assert.match(html,/<details><summary>Change history/);assert.match(html,/Synthetic correction/);assert.match(html,/data-profile-identity/);
 const css=source('web/frame.css');assert.match(css,/\.pill.green\{[^}]*background:/);assert.match(css,/\.pill.amber\{[^}]*background:/);
 console.log('Vitals, insurance and profile regression checks passed (synthetic fixtures only).');
}
main().catch(error=>{console.error(error);process.exitCode=1;});

// The shared return link precedes every section, including Vitals.
const renderChart=app.slice(app.indexOf("$('chart').innerHTML=`<section id=\"patient-banner\""),app.indexOf('// Keep the header and left panel mounted'));
assert(renderChart.indexOf('id="record-context"')<renderChart.indexOf('${patientVitalsHistory()}'));
assert(renderChart.indexOf('id="record-context"')<renderChart.indexOf('${chartOverview()}'));
// Vendor names may remain in protocol comparisons and comments, never in display copy.
for(const file of fs.readdirSync(path.join(root,'web')).filter(name=>name.endsWith('.js'))){
 new vm.Script(source('web/'+file),{filename:file});
 const lines=source('web/'+file).split('\n').filter(line=>!line.trimStart().startsWith('//')&&!line.includes("guide_reference!==")&&!line.includes('enable and verify a Claim.MD connection/.test'));
 assert.doesNotMatch(lines.join('\n'),/Claim\.MD|ClaimMD|CLAIM\.MD/,file);
}
