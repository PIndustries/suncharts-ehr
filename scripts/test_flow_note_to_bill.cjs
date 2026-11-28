// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic encounter only. Exercises the real note handlers and billing send chain without a server.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=file=>fs.readFileSync(`web/${file}`,'utf8'),app=read('app.js'),readRooming=read('rooming.js');
function fixture(){
 const nodes=new Map(),handlers={},requests=[],timers=new Map();let timerId=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,dataset:{},isConnected:true,hidden:false,textContent:'',innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],replaceChildren(){this.innerHTML='';}});return nodes.get(id);};
 const keys=['subjective','objective','assessment','plan','procedure'];
 const note=node('note-form');note.dataset={visitId:'visit',version:'1'};note.elements=Object.fromEntries(keys.map(key=>[key,{value:key==='procedure'?'':'Synthetic '+key}]));
 const ctx={console,URLSearchParams,URL,Date,Intl,Map,Set,WeakMap,Array,Promise,JSON,Number,String,Object,Math,encodeURIComponent,
  setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
  document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn),querySelector:()=>null,querySelectorAll:()=>[]},
  $:id=>nodes.get(id)||null,me:{user_id:'clinician',role:'owner'},selected:'patient',activeVisit:{id:'visit',version:1,status:'in_progress',clinician_id:'clinician',note:null},
  workspace:{visits:[],billing:{accounts:[]}},noteSectionKeys:keys,
  esc:value=>String(value??''),date:value=>value,money:value=>`$${(value/100).toFixed(2)}`,
  formData:form=>Object.fromEntries(Object.entries(form.elements).map(([key,field])=>[key,field.value])),
  noteMatchesSaved:(values,saved)=>saved&&keys.every(key=>values[key]===saved[key]),noteRequestBody:values=>values,
  canDraftNote:()=>true,canSignNote:()=>true,canRecordVisitVitals:()=>false,
  captureVisitDrafts(){},updateDraftStatus(){},refreshEncounterProgress(){},notice(message){ctx.message=message;},
  rememberVisit(visit){
   const previous=ctx.activeVisit.version,room=nodes.get('rooming-form');
   ctx.activeVisit=visit;note.dataset.version=String(visit.version);
   if(room&&Number(room.dataset.version)===previous)room.dataset.version=String(visit.version);
  },
  selectPatient:async()=>{if(ctx.signedVisit)ctx.activeVisit=ctx.signedVisit;},visitBillingAreaVisible:()=>true,signNextPlan:()=>({ask:'Sign',done:'Signed'}),
  confirmAction:async message=>{ctx.confirmations++;ctx.confirmationMessage=message;return true;},confirmations:0,
  billingCan:()=>true,billingBase:()=>'/api/v1/patients/patient/billing/accounts',
  encounterChargeAccount:()=>ctx.workspace.billing.accounts[0]||null,
  setEncounterSection:key=>ctx.section=key,openVisitCollect:()=>ctx.paymentOpened=true,
  run:work=>work(),crypto:{randomUUID:()=>'synthetic-request'},
  api:async(path,method='GET',body,version)=>{
   requests.push({path,method,body,version});
   if(ctx.failAt&&path.endsWith(ctx.failAt))throw new Error('Synthetic step failed');
   if(path.endsWith('/note'))return {...ctx.activeVisit,version:ctx.activeVisit.version+1,note:body};
   if(path.endsWith('/sign'))return ctx.signedVisit={...ctx.activeVisit,status:'signed',version:ctx.activeVisit.version+1};
   if(path.endsWith('/diagnoses')){
    if(method==='PUT'){ctx.diagnoses=body.diagnoses;ctx.activeVisit={...ctx.activeVisit,version:ctx.activeVisit.version+1};}
    return {diagnoses:ctx.diagnoses||[],version:ctx.activeVisit.version,can_edit:true,visit:ctx.activeVisit};
   }
   if(path.endsWith('/actions')&&body.action==='post')return {...ctx.workspace.billing.accounts[0],status:'posted',version:2};
   if(path.endsWith('/claims/prepare'))return ctx.selfPay?{outcome:'not_needed'}:{outcome:'prepared',claim_id:'claim'};
   if(path.endsWith('/claims/claim'))return {claim:{id:'claim',patient_id:'patient',account_id:'account',status:'draft',version:3},preflight_issues:ctx.preflight||[],transport:{routes:[{provider:'claim_md',route_key:'synthetic'}]}};
   if(path.endsWith('/actions')&&body.action==='ready')return {version:4};
   if(path.endsWith('/837p'))return {id:'submission',version:1};
   if(path.endsWith('/delivery'))return {submission:{id:'submission'}};
   throw new Error('Unexpected request '+path);
  }
 };
 vm.createContext(ctx);
 for(const file of ['visit-note.js','visit-diagnoses.js','fees.js','visit-review.js'])vm.runInContext(read(file),ctx);
 const billing=read('billing.js');
 vm.runInContext(billing.slice(billing.indexOf('function billingEffectiveCoverages('),billing.indexOf('function chargeDiagnosisCurrent(')),ctx);
 // Use the application's actual save and sign handlers, independent of its page bootstrapping.
 vm.runInContext(app.slice(app.indexOf('async function saveVisitNote('),app.indexOf('\nlet me, patients')),ctx);
 const start=app.indexOf("    if(['sign','sign-bill'].includes(button.dataset.action)){");
 const end=app.indexOf('\n  });\n});',start);
 vm.runInContext(`signClick=async button=>{${app.slice(start,end)}}`,ctx);
 vm.runInContext(`
 showVisitNoteAuthorship=()=>{};visitNoteBar=()=>{};visitNoteSaved=()=>{};
 showVisitDiagnoses=()=>{};visitNoteInlinePaint=()=>{};
 visitReviewOpen=()=>{openedProblems=true;};
 visitReviewPaint=()=>{};visitReviewContext=()=>({claimsAllowed:true});
 visitReviewChecks=()=>issues||[];
 visitReviewSendContext=()=>({needPost:false,needPrepare:false});
 visitReviewClaimsBase=()=>'/api/v1/billing/claims';
 loadClaimMdConnection=async()=>{};claimMdConnectionState={connected:true};
 encounterRevenueVisitUnsigned=()=>false;
 visitBillingInsurer=()=> 'Synthetic insurer';
 openEncounterClaimMdSubmit=async(id,account)=>{nativeReview={id,account};return true;};
 loadEncounterRevenueStatus=async()=>{encounterRevenueState.data={summary:{insurance:{insured:!selfPay},patient:{owes_now_cents:2500},claim:selfPay?null:{id:'claim',status:'draft'}}};};
 visitNoteBillPayment=async()=>{paymentOffered=true;};visitNoteOpenPayment=async()=>{paymentOpened=true;};
 `,ctx);
 Object.assign(ctx,{visitDrafts:new Map(),encounterRevenueState:{data:{summary:{}},review:null},selfPay:false,issues:[],paymentOpened:false,openedProblems:false,nativeReview:null,claimMdConnectionState:{connected:true},flushVisitNoteCharges:async()=>{}});
 return {ctx,note,node,nodes,handlers,requests,timers,run:code=>vm.runInContext(code,ctx),settle:async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));}};
}
async function main(){
 // The real rooming markup keeps one set of required controls and an optional details area.
 {
  const r=fixture();r.run(readRooming);const host=r.node('visit-rooming');
  r.ctx.displayStatus=String;r.ctx.human=String;
  r.ctx.api=async()=>({status:'not_started',chief_complaint:'Synthetic concern',intake_notes:'Synthetic notes',medications_reviewed:false,allergies_reviewed:false,version:1,can_edit:true,history:[]});
  await r.ctx.renderRooming();
  const dom=new (require('jsdom').JSDOM)(host.innerHTML),doc=dom.window.document;
  assert.deepEqual([...doc.querySelectorAll('[data-rooming-field] :is(textarea,input)')].map(n=>n.name),['chief_complaint','medications_reviewed','allergies_reviewed']);
  assert.deepEqual([...doc.querySelectorAll('[data-rooming-review] :is(textarea,select)')].map(n=>n.name),['intake_notes','status']);
  assert.equal(doc.querySelectorAll('#rooming-form').length,1);
  const css=read('visit-billing.css');
  assert.match(css,/#encounter-rooming-vitals \.vitals-grid\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css,/@media\(max-width:700px\)\{#encounter-rooming-vitals \.vitals-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  dom.window.close();
 }

 let f=fixture();f.node('note-save-status');
 const input={closest:selector=>selector.includes('#note-form')?f.note:null};
 for(const handler of f.handlers.input)handler({target:input});
 assert.equal(f.node('note-save-status').textContent,'Saving…');
 for(const [id,callback] of [...f.timers]){f.timers.delete(id);callback();}await f.settle();
 assert.equal(f.requests.filter(row=>row.path.endsWith('/note')).length,1,'pause in typing saves the note');
 assert.equal(f.node('note-save-status').textContent,'Saved');
 f.note.elements.plan.value='More synthetic text';
 await f.ctx.signClick({dataset:{action:'sign'}});
 assert.equal(f.ctx.confirmations,0);assert(f.requests.at(-1).path.endsWith('/sign'));
 assert(f.requests.at(-2).path.endsWith('/note'),'Sign saves unsaved typing first');
 assert(!app.includes('Save your current note before signing'));
 console.log('PASS autosave fires; Sign saves unsaved text without an extra confirmation');
 f=fixture();f.node('note-save-status');f.node('note-message');
 f.ctx.activeVisit.note=f.ctx.formData(f.note);
 for(const field of Object.values(f.note.elements))field.value='';
 await f.ctx.visitNoteFlush();
 assert.equal(f.node('note-save-status').textContent,'Not saved');
 assert.match(f.node('note-message').textContent,/Enter text in at least one note field/);
 assert.equal(f.requests.length,0,'an all-empty edit cannot replace a recorded note');
 f.note.elements.plan.value='Synthetic follow-up';
 await f.ctx.visitNoteFlush();
 assert.equal(f.node('note-save-status').textContent,'Saved');
 assert.equal(f.ctx.activeVisit.note.plan,'Synthetic follow-up');
 f=fixture();let focused=false,scrolled=false,invalid=false;
 f.note.elements.objective={value:'',focus:()=>focused=true,scrollIntoView:()=>scrolled=true,setAttribute:()=>invalid=true,removeAttribute:()=>invalid=false};
 f.node('note-message');await f.ctx.signClick({dataset:{action:'sign-bill'}});
 assert.equal(f.node('note-message').textContent,'Add Objective before signing.');assert(focused&&scrolled&&invalid);assert.equal(f.requests.length,0);
 f.note.elements.objective.value='Synthetic objective';f.note.elements.objective.closest=()=>f.note;
 f.ctx.queueVisitNoteAutosave({target:f.note.elements.objective});assert.equal(invalid,false);
 f=fixture();f.ctx.activeVisit.clinician_id='colleague';f.ctx.visitNoteAssignedName=async()=> 'Synthetic colleague';
 await f.ctx.signClick({dataset:{action:'sign'}});assert.equal(f.ctx.confirmations,1);
 assert.match(f.ctx.confirmationMessage,/encounter stays assigned to Synthetic colleague/i);
 assert.doesNotMatch(f.ctx.confirmationMessage,/signing locks the note/i);
 console.log('PASS first press identifies and focuses missing SOAP; typing clears invalid; covering confirms once');
 // Rooming and vitals share the encounter version with the note. Saving keeps the live rooming form.
 f=fixture();
 f.run(readRooming);
 const room=f.node('rooming-form');room.dataset={visitId:'visit',patientId:'patient',version:'1'};
 room.elements={chief_complaint:{value:'Synthetic concern'},intake_notes:{value:'Synthetic intake'},status:{value:'ready'},medications_reviewed:{value:'',checked:true},allergies_reviewed:{value:'',checked:true}};
 f.ctx.renderRooming=async()=>{throw new Error('Autosave must keep the live rooming form');};
 f.run(`roomingBaselines.set($('rooming-form'),{values:roomingValues({}),version:1});`);
 const vitals=f.node('vitals-form');vitals.dataset={visitId:'visit',version:'1'};vitals.elements={heart_rate_bpm:{value:'72'}};
 f.ctx.canRecordVisitVitals=()=>true;f.ctx.vitalsToForm=values=>values||{};f.ctx.vitalFromForm=(_key,value)=>Number(value);
 const original=f.ctx.api;
 f.ctx.api=async(path,method,body,version)=>{
  if(path.endsWith('/rooming')||path.endsWith('/vitals')){
   f.requests.push({path,method,body,version});assert.equal(version,f.ctx.activeVisit.version);
   const visit={...f.ctx.activeVisit,version:version+1,...(path.endsWith('/vitals')?{vitals:body}:{})};
   return path.endsWith('/rooming')?{...body,version:visit.version,visit}:visit;
  }
  return original(path,method,body,version);
 };
 // Local saves carry the version to the remaining forms, just as rememberVisit does.
 const remember=f.ctx.rememberVisit;f.ctx.rememberVisit=visit=>{remember(visit);vitals.dataset.version=String(visit.version);room.dataset.version=String(visit.version);};
 await f.ctx.visitNoteFlush();
 assert.deepEqual(f.requests.map(row=>row.path.split('/').at(-1)),['rooming','vitals','note']);
 assert.deepEqual(f.requests.map(row=>row.version),[1,2,3]);assert.equal(f.nodes.get('rooming-form'),room);
 console.log('PASS rooming, vitals and note autosave in order with current versions and keep the rooming form');


 for(const action of ['sign','sign-bill']){
  f=fixture();f.run(readRooming);
  const room=f.node('rooming-form');room.dataset={visitId:'visit',patientId:'patient',version:'1'};
  room.elements={chief_complaint:{value:''},intake_notes:{value:'Synthetic retained draft'},status:{value:'ready'},medications_reviewed:{checked:false},allergies_reviewed:{checked:false}};
  f.run(`roomingBaselines.set($('rooming-form'),{values:roomingValues({}),version:1});`);
  const original=f.ctx.api;
  f.ctx.api=async(path,...args)=>{
   if(path.endsWith('/rooming')){f.requests.push({path});throw new Error('ready for clinician requires chief complaint and medication/allergy review');}
   return original(path,...args);
  };
  await f.ctx.signClick({dataset:{action}});
  assert(f.requests.some(row=>row.path.endsWith('/sign')),'refused rooming does not block '+action);
  assert.equal(f.ctx.activeVisit.status,'signed');
  assert.equal(f.run('roomingDrafts.get("visit").values.intake_notes'),'Synthetic retained draft');
  assert.equal(f.run('roomingUnfinished.get("visit")'),'patient');
 }
 console.log('PASS refused rooming retains the draft and Rooming & vitals notice while both signing actions continue');
 for(const status of [409,503]){
  f=fixture();f.run(readRooming);
  const room=f.node('rooming-form');room.dataset={visitId:'visit',patientId:'patient',version:'1'};
  room.elements={chief_complaint:{value:'New concern'},intake_notes:{value:''},status:{value:'ready'},medications_reviewed:{checked:true},allergies_reviewed:{checked:true}};
  f.run(`roomingBaselines.set($('rooming-form'),{values:roomingValues({}),version:1});`);
  const previous=f.ctx.api;
  f.ctx.api=async(path,...args)=>{if(path.endsWith('/rooming'))throw Object.assign(new Error('Rooming save failed'),{status});return previous(path,...args);};
  await assert.rejects(()=>f.ctx.visitNoteFlush({signing:true}),/Rooming save failed/);
  assert.equal(f.ctx.activeVisit.status,'in_progress');
  assert.equal(f.run('roomingDrafts.get("visit").values.chief_complaint'),'New concern');
 }
 console.log('PASS signing waits when current intake edits could not be saved or another user changed the visit');
 {
  const ctx={me:{},fetch:async()=>({ok:false,status:422,json:async()=>({message:'ready for clinician requires chief complaint and medication/allergy review'})})};
  vm.createContext(ctx);vm.runInContext(app.slice(app.indexOf('async function api('),app.indexOf('// Why the page gave up:')),ctx);
  await assert.rejects(()=>ctx.api('/synthetic'),/^Error: Rooming not finished: add the chief complaint and tick medications and allergies reviewed\.$/);
 }



 f=fixture();await f.ctx.visitDiagnosisInlineChange({code:'R51.9',display:'Synthetic diagnosis'});
 let saved=f.requests.find(row=>row.path.endsWith('/diagnoses')&&row.method==='PUT');
 assert.equal(saved.body.diagnoses[0].code,'R51.9');assert.equal(saved.version,1);
 await f.ctx.visitDiagnosisInlineChange(null,'R51.9');
 assert.equal(f.requests.at(-1).body.diagnoses.length,0,'last chip can be removed');
 console.log('PASS inline diagnosis add and remove use the versioned diagnoses API');

 f=fixture();let added=[];
 const form=f.node('billing-account-form'),feeCheck=f.ctx.checkFee;
 Object.assign(f.ctx,{chargeLinesAppend:lines=>{added.push(...lines);return lines;},loadChargeEncounterDiagnoses:async()=>{},loadFeeContext:async()=>{},checkFee:async()=>{}});
 f.run(`chargeBundles=[{id:'bundle',name:'Synthetic bundle',lines:[{code:'12345',code_system:'CPT',description:'',units:1}]}];`);
 const button={dataset:{noteBundle:'bundle'},hasAttribute:()=>false,closest:()=>null};
 for(const handler of f.handlers.click)handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});
 await f.settle();assert.equal(added.length,1);assert.equal(added[0].code,'12345');
 const row={dataset:{chargeSystem:'HCPCS'},querySelector:selector=>({'[name="code"]':{value:'A1234'},'[name="units"]':{value:'1'},'[name="modifiers"]':{value:''}}[selector]||null)};
 form.elements={visit_id:{value:'visit'},service_date:{value:'2026-11-24'}};
 let params=new URLSearchParams(f.ctx.feeQuery(form,row,{facility_id:'facility',setting:'nonfacility'}));
 assert.equal(params.get('code_system'),'HCPCS');assert(!params.toString().includes('undefined'));
 row.dataset.chargeSystem='CPT';params=new URLSearchParams(f.ctx.feeQuery(form,row,{facility_id:'facility',setting:'nonfacility'}));assert.equal(params.get('code_system'),'CPT');

 const fields={...Object.fromEntries(['code','units','modifiers','amount'].map(name=>[name,{value:name==='code'?'A1234':name==='units'?'1':''}])),fee_facility:{value:'facility'},fee_setting:{value:'nonfacility'}};
 const feeHost={dataset:{},querySelector:()=>({hidden:false,textContent:''})};
 form.dataset.patient='patient';form.querySelector=selector=>fields[selector.match(/name="([^"]+)"/)?.[1]]||null;
 row.isConnected=true;row.querySelector=selector=>selector==='[data-fee-line]'?feeHost:fields[selector.match(/name="([^"]+)"/)?.[1]]||null;
 f.ctx.api=async path=>{f.requests.push({path});return {reason:'Synthetic price not set'};};
 await feeCheck(form,row);
 assert.equal(new URL('https://synthetic.invalid'+f.requests.at(-1).path).searchParams.get('code_system'),'CPT');
 console.log('PASS bundle click adds lines; fee quote sends the row’s own code system');

 f=fixture();f.run(read('visit-billing.js'));f.run(read('encounter-timeline.js'));
 f.ctx.draftSummary={charges_cents:18000,account:{status:'draft'},insurance:{insured:false},patient:{owes_now_cents:0}};
 assert.match(f.run('visitBillingTotalsLine(draftSummary)'),/Patient will owe.*\$180.00/);
 let chargeStep=f.run('encounterTimelineSteps(draftSummary,activeVisit,{}).find(s=>s.key==="charges")');
 assert.equal(chargeStep.label,'Charges');assert.match(chargeStep.detail,/180.00 \(not posted\)/);
 f.ctx.draftSummary.account.status='posted';assert.doesNotMatch(f.run('visitBillingTotalsLine(draftSummary)'),/Patient will owe/);
 console.log('PASS self-pay draft totals and header identify unposted charges; posted balance stays unchanged');
 function insured(){const g=fixture();g.ctx.workspace.billing.accounts=[{id:'account',version:1,status:'draft',content:{visit_id:'visit',lines:[]}}];return g;}
 // The continuous insured workflow signs and hands off from one explicit clinician choice.
 // The browser never creates a transport file or queues a separate delivery itself.
 function handoffSetup(opts={}){
  const g=insured(),seen=[],choices=[],writes=[];
  const c=g.ctx,original=c.api;
  const account=c.workspace.billing.accounts[0];
  account.total_cents=18000;account.content.coverage_id='coverage';account.content.claim_details=opts.details||{};
  const s={patient_id:'patient',visit:{id:'visit'},account,insurance:{insured:true,electronic:true,insurer:'Synthetic payer'},claim:opts.claim||null,...(opts.evidence?{claim_handoff:opts.evidence}:{})};
  c.encounterRevenueState.data={summary:s};g.node('visit-page-host').dataset.encounterSteps='';
  c.workspace.patient={id:'patient',given_name:'Synthetic',family_name:'Visit'};
  c.workspaceResourceAllowed=(resource,action)=>!opts.noClaims||resource!=='claims';
  c.confirmAction=async(text,options)=>{choices.push({text,options});return opts.confirm!==false;};
  c.visitReviewRestore=()=>{};c.encounterStepsSchedule=()=>{};
  c.loadEncounterRevenueStatus=async()=>{seen.push('refresh');};
  c.flushVisitNoteCharges=async()=>{seen.push('flush');if(opts.unpriced)throw new Error('Add the amount');};
  c.api=async(path,method,body,version)=>{
   if(path.endsWith('/claim-handoff')){
    writes.push({path,body});if(opts.lost)throw new Error('Connection closed');
    if(body.sign_version)c.signedVisit={...c.activeVisit,status:'signed',version:c.activeVisit.version+1};
    return {outcome:'queued',submission_id:'sub',job_id:'job',claim_id:'claim',signed:true,visit_id:'visit',account_id:'account',visit_version:c.signedVisit?.version||c.activeVisit.version,...opts.result};
   }
   if(path.endsWith('/claims/claim'))return {claim:{id:'claim',content:{synthetic_test:!!opts.synthetic}}};
   return original(path,method,body,version);
  };
  if(opts.signed)c.activeVisit={...c.activeVisit,status:'signed',version:5};
  const click=()=>g.ctx.signClick({dataset:{action:'sign-bill',claimHandoff:'queue'}});
  return {g,c,s,writes,choices,seen,click};
 }
 {
  const h=handoffSetup();await h.click();
  assert.equal(h.writes.length,1);const {path,body}=h.writes[0];assert.equal(path,'/api/v1/patients/patient/billing/visits/visit/claim-handoff');
  assert.equal(body.mode,'queue');assert.equal(body.account_version,1);assert.equal(body.sign_version,2);
  assert.deepEqual({...body.confirmations},{signature_on_file:true,benefits_assigned:true,release_authorized:true,routine_professional_reviewed:true,synthetic_test_reviewed:false});
  assert.equal(h.choices.length,1);assert.match(h.choices[0].text,/provider signature.*benefits are assigned.*release of information is authorized.*routine professional claim/);
  assert.equal(h.choices[0].options.detail,undefined);
  assert.match(h.c.message,/Note signed. Queued for Claim.MD/);assert.doesNotMatch(h.c.message,/sent to|delivered to/i);
  assert(!h.g.requests.some(r=>['/sign','/837p','/delivery'].some(end=>r.path.endsWith(end))));
  const cancel=handoffSetup({confirm:false});await cancel.click();assert.equal(cancel.writes.length,0);assert.equal(cancel.c.activeVisit.status,'in_progress');
  const noRole=handoffSetup({noClaims:true});await assert.rejects(noRole.click(),/claim access/);assert.equal(noRole.writes.length,0);
  const pending=handoffSetup({unpriced:true});await assert.rejects(pending.click(),/Add the amount/);assert.equal(pending.writes.length,0);
  const stopped=handoffSetup({result:{outcome:'needs_review',job_id:null,submission_id:null,issues:['Add the rendering NPI.']}});
  await stopped.click();assert.match(stopped.c.message,/Note signed\. Claim needs review\. Add the rendering NPI/);
  const lost=handoffSetup({lost:true});await lost.click();assert.match(lost.c.message,/Handoff unconfirmed/);assert.doesNotMatch(lost.c.message,/Note signed/);assert.equal(lost.writes.length,1);
  const mismatch=handoffSetup({result:{visit_id:'other'}});await mismatch.click();assert.match(mismatch.c.message,/Handoff unconfirmed/);
  for(const details of [{review_requested:true},{paper_only:true}]){
   const hold=handoffSetup({details,result:{outcome:'held',job_id:null,submission_id:null}});
   await hold.click();assert.equal(hold.writes[0].body.mode,'prepare');assert.equal(Object.keys(hold.writes[0].body.confirmations).length,0);assert.match(hold.c.message,/Claim on hold/);
  }
  for(const outcome of ['queued','waiting','delivered','blocked','recorded_externally']){
   const already=handoffSetup({signed:true,evidence:{outcome,claim_id:'claim',submission_id:'sub',job_id:'job'}});
   await already.c.visitClaimHandoff(false);assert.equal(already.writes.length,0);assert.equal(already.choices.length,0);
  }
  const resume=handoffSetup({signed:true,evidence:{outcome:'prepared',submission_id:'sub',claim_id:'claim'},claim:{id:'claim'}});
  await resume.c.visitClaimHandoff(false);assert.equal(resume.writes[0].body.sign_version,undefined);
  assert.equal(Object.keys(resume.writes[0].body.confirmations).length,0);assert.match(resume.choices[0].text,/previously reviewed/);
  const synthetic=handoffSetup({signed:true,claim:{id:'claim'},synthetic:true});
  await synthetic.c.visitClaimHandoff(false);assert.match(synthetic.choices[0].text,/synthetic.*clearinghouse charge/);
  assert.equal(synthetic.writes[0].body.confirmations.synthetic_test_reviewed,true);
  const changed=handoffSetup();changed.c.confirmAction=async()=>{changed.c.workspace.billing.accounts[0].version++;return true;};
  await assert.rejects(changed.click(),/changed during review/);assert.equal(changed.writes.length,0);
  console.log('PASS explicit sign and resumable Claim.MD handoff, existing delivery evidence, holds, scoped versions, synthetic and legal confirmations, lost response');
 }
 // Continuous encounter: signing prepares and the next step opens native review without transmitting.
 {
  const g=insured();g.node('visit-page-host').dataset.encounterSteps='';
  let paints=0;g.ctx.visitReviewRestore=()=>{paints++;};g.ctx.encounterStepsSchedule=()=>{};
  g.ctx.encounterStepOpen=()=>{throw new Error('Signing or sending must not change steps');};
  await g.ctx.signClick({dataset:{action:'sign-bill'}});
  assert.equal(g.ctx.activeVisit.status,'signed');assert(paints>0);
  assert(!g.requests.some(row=>row.path.endsWith('/837p')));
  assert.equal(g.ctx.paymentOpened,false);
  assert.equal(await g.ctx.visitReviewRun('claim',{needPost:false,needPrepare:false,quietRefresh:true}),true);
  assert.equal(g.requests.filter(row=>row.path.endsWith('/837p')||row.path.endsWith('/delivery')).length,0);
  assert.equal(g.ctx.nativeReview?.id,'claim');assert.equal(g.ctx.nativeReview?.account,'account');
  assert.equal(g.ctx.paymentOpened,false);
  const self=insured();self.node('visit-page-host').dataset.encounterSteps='';self.ctx.selfPay=true;self.ctx.visitReviewRestore=()=>{};
  await self.ctx.signClick({dataset:{action:'sign-bill'}});
  assert.equal(self.ctx.paymentOpened,false);assert(!self.requests.some(row=>row.path.endsWith('/837p')));
  console.log('PASS continuous encounter: sign prepares, Claim.MD review opens in place; self-pay uses Take payment');
 }
 f=insured();await f.ctx.signClick({dataset:{action:'sign-bill'}});
 const steps=f.requests.filter(row=>row.path.endsWith('/sign')||row.body?.action==='post'||row.path.endsWith('/claims/prepare')||row.path.endsWith('/837p')||row.path.endsWith('/delivery')).map(row=>row.body?.action==='post'?'post':row.path.split('/').at(-1));
 assert.deepEqual(steps,['sign','post','prepare']);assert.equal(f.ctx.confirmations,0);assert.equal(f.ctx.nativeReview?.id,'claim');assert(!f.ctx.paymentOffered);
 console.log('PASS clean insured encounter signs → posts → prepares → opens native review');

 f=insured();let priceFocused=false;
 f.ctx.flushVisitNoteCharges=async options=>{assert.equal(f.ctx.activeVisit.status,'signed');assert.equal(options.allowUnpriced,true);return true;};
 // selectPatient normally refreshes the signed visit.
 f.ctx.selectPatient=async()=>{f.ctx.activeVisit.status='signed';};
 f.ctx.focusUnpricedVisitCharge=()=>{priceFocused=true;};f.ctx.captureBillingChargeDraft=()=>{};
 await f.ctx.signClick({dataset:{action:'sign-bill'}});
 assert(f.requests.some(row=>row.path.endsWith('/sign')));assert(f.requests.some(row=>row.body?.action==='post'));assert(priceFocused);
 assert(!f.requests.some(row=>row.path.endsWith('/claims/prepare')));
 assert.match(read('visit-note.js'),/data-note-charge-field="amount"/);
 console.log('PASS unpriced lines do not block signing; priced lines post and missing price opens before sending');
 f=insured();f.ctx.issues=[{level:'must',text:'Synthetic claim issue'}];await f.ctx.signClick({dataset:{action:'sign-bill'}});
 assert(f.ctx.openedProblems);assert.equal(f.ctx.section,'charges');assert(!f.requests.some(row=>row.path.endsWith('/837p')));assert.equal(f.ctx.workspace.billing.accounts[0].status,'posted');
 console.log('PASS claim issues open Review & send and retain completed steps without sending');

 f=insured();f.ctx.selfPay=true;await f.ctx.signClick({dataset:{action:'sign-bill'}});
 assert(f.ctx.paymentOpened);assert(!f.requests.some(row=>row.path.endsWith('/837p')));
 console.log('PASS self-pay opens the existing payment flow');
 // The real payment helpers retain the balance and name a saved card action without charging it.
 f=fixture();const revenue=read('patient-revenue.js');f.run(revenue.slice(revenue.indexOf('async function visitNotePaymentCards(')));
 f.ctx.encounterRevenueState.data={summary:{patient:{owes_now_cents:2500}}};
 const savedTab={textContent:''};f.ctx.collectDialog={querySelector:()=>savedTab};f.ctx.savedCardsForCharge=async()=>({cards:[{setup_id:'synthetic-card'}]});
 await f.ctx.visitNoteOpenPayment();assert(f.ctx.paymentOpened);assert.equal(savedTab.textContent,'Charge card on file $25.00');
 const message=f.node('note-message');await f.ctx.visitNoteBillPayment({patient:{owes_now_cents:2500}});
 assert.match(message.innerHTML,/Claim sent to Synthetic insurer/);assert.match(message.innerHTML,/Charge card on file \$25.00/);assert.match(message.innerHTML,/Take payment/);
 console.log('PASS payment actions show the patient portion and saved-card amount');


 for(const failure of ['/sign','/actions','/claims/prepare']){
  f=insured();f.ctx.failAt=failure;
  await assert.rejects(()=>f.ctx.signClick({dataset:{action:'sign-bill'}}),/Synthetic step failed/);
  assert(!f.requests.some(row=>row.path.endsWith('/837p')),'failure never sends');
 }
 f=insured();f.ctx.preflight=['Synthetic missing detail'];await f.ctx.signClick({dataset:{action:'sign-bill'}});assert(f.ctx.openedProblems);assert(!f.requests.some(row=>row.path.endsWith('/837p')));
 console.log('PASS sign, post, prepare and final preflight failures stop the flow');
 f=fixture();let release,ran=false;
 const held=f.ctx.visitNoteEnqueue(()=>new Promise(resolve=>{release=resolve;}));await f.settle();
 const next=f.ctx.visitNoteEnqueue(()=>{ran=true;});f.ctx.selected='other-synthetic-patient';release();await held;
 await assert.rejects(next,/page changed/);assert.equal(ran,false);
 console.log('PASS queued edits cannot cross to another patient');
 f=insured();const billing=read('billing.js');f.run(billing.slice(billing.indexOf('async function flushVisitNoteCharges(')));
 f.node('billing-account-form');f.ctx.workspace.billing.accounts[0].content.lines=[{code:'12345'}];
 f.ctx.chargeLiveRows=()=>[];
 await assert.rejects(()=>f.ctx.flushVisitNoteCharges(),/No procedures are selected/);assert(f.ctx.openedProblems);
 f.ctx.chargeLiveRows=()=>[{querySelector:()=>({value:'12345'})}];f.ctx.chargeTableWaiting=()=> 'Synthetic price needed';
 await assert.rejects(()=>f.ctx.flushVisitNoteCharges(),/Synthetic price needed/);assert.equal(f.ctx.section,'charges');
 console.log('PASS empty or incomplete live charges cannot post older saved lines');
 {
  const {JSDOM}=require('jsdom');
  const dom=new JSDOM('<form id="billing-account-form"><table><tbody><tr class="billing-charge-row"><td>Code</td><td><input name="amount"></td><td>Remove</td></tr></tbody></table></form>',{runScripts:'outside-only'}),w=dom.window;
  const row=w.document.querySelector('tr'),field=row.querySelector('input');
  w.$=id=>w.document.getElementById(id);w.setEncounterSection=()=>{};
  w.chargeLiveRows=()=>[row];w.chargeRowUnsavable=()=> 'add the amount';field.scrollIntoView=()=>{};
  const billing=read('billing.js');
  w.eval(billing.slice(billing.indexOf('function focusUnpricedVisitCharge('),billing.indexOf('async function openPatientInsuranceSheet(')));
  w.eval(billing.slice(billing.lastIndexOf("document.addEventListener('input'")));
  w.focusUnpricedVisitCharge();w.focusUnpricedVisitCharge();
  assert.equal(row.querySelector('[data-sign-price-needed]'),null,'Amount cell has no warning');
  assert.equal(row.nextElementSibling.firstElementChild.colSpan,3,'warning spans every line column');
  assert.equal(w.document.querySelectorAll('[data-sign-price-row]').length,1,'repeated focus reuses warning');
  assert.match(row.nextElementSibling.textContent,/Add the amount for this line before sending/);
  field.value='430.00';field.dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(w.document.querySelectorAll('[data-sign-price-row]').length,0,'editing amount removes warning');
  dom.window.close();
 }
 console.log('PASS Edit codes amount warning uses a full-width row and clears on editing');



}
main().catch(error=>{console.error(error);process.exitCode=1;});
