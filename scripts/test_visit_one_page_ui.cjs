// SPDX-License-Identifier: AGPL-3.0-only
// The visit is one scrolling page: vitals, note, codes & charges, payment, finish. These checks
// run the real encounterWorkflow / setEncounterSection / applyChartSection / patientSectionVisible
// code from web/app.js against a stub DOM and prove: no numbered step bar remains, the old step
// keys still open the page and land on the block they name, the page stays one page when billing
// or checkout is hidden, and the Orders and Files areas take the whole screen until Back to visit.
// Synthetic data only. No browser, no network.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8'),specialty=fs.readFileSync('web/specialty-workspace.js','utf8');
 const ids=['encounter-progress','visit-editor','encounter-intake','encounter-documentation','encounter-revenue','encounter-orders-actions','visit-checkout','documents-panel','patient-intake-panel','lab-workspace','clinical-workspace','note-form'];
function fixture({billing=true,checkout=true,role='owner'}={}){
 const scrolls=[],notices=[];
 const nodes=Object.fromEntries(ids.map(id=>[id,{id,hidden:true,innerHTML:'',open:false,classList:{toggle(){}},setAttribute(){},scrollIntoView(){scrolls.push(id);}}]));
 let revenueRenders=0,filesRenders=0;
 const context=vm.createContext({console,Map,Set,Array,Object,Number,Date,structuredClone,
  document:{addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null},$:id=>nodes[id]||null,
  me:{role,user_id:'clinician-1'},chartSection:'visits',encounterSection:'visit',selected:'patient-1',visitDrafts:new Map(),insuranceAppointmentSelection:new Map(),
  esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),date:value=>value,encounterDateLabel:()=>'Synthetic visit',
  notice:(...args)=>notices.push(args),captureVisitDrafts(){},capturePrescribingDraft(){},updateDraftStatus(){},followUnchangedNote(){},canDocument:()=>true,
  captureVisitAmendmentDraft(){},currentAmendmentDraft:()=>null,updateVisitAmendmentStatus(){},
  visitNoteAuthorshipLine:()=>'',visitNoteSignedLine:()=>'Signed',visitNoteAmendmentAuthor:()=>'',visitNoteSaved(){},renderVisitNoteSource(){},renderEncounterStartBenefits(){},
  isRoomingStaff:()=>false,canRecordVisitVitals:()=>true,canDraftNote:()=>true,canSignNote:()=>true,canAmendNote:()=>false,
  workspaceResourceAllowed:resource=>resource!=='billing'||billing,
  postSignReminderMarkup:()=>'',refreshPatientChartContext(){},applyLabEncounterScope(){},documentFileNavigationChanged(){},refreshEncounterProgress(){},
  renderEncounterRevenue(){revenueRenders++;},renderEncounterFiles(){filesRenders++;void filesRenders;},renderRooming(){},renderVisitDiagnoses(){},renderVisitCheckout(){},renderPatientBillingChart(){},renderPrescribing(){},openPatientChartTab(){},startEncounterFlow(){},selectEncounter(){},closeEncounterFlow(){},
   revenueServiceDate:()=>null,rememberVisit(){},editLabOrder(){},openEncounterCharges(){},patientBannerChanged(){},
  noteSourceText:()=>'',noteSourceLine:()=>'' ,noteProcedureHint:'What was done',visitAmendmentContexts:new WeakMap(),
  noteSectionKeys:['subjective','objective','assessment','plan','procedure','started_from'],
  api:async()=>({version:1})});
 context.getRenders=()=>({revenueRenders,filesRenders});
 vm.runInContext(specialty,context,{filename:'specialty-workspace.js'});
 const extract=(startText,endText)=>{const start=app.indexOf(startText),end=app.indexOf(endText,start);assert.ok(start>=0&&end>start,'anchor moved: '+startText);return app.slice(start,end);};
 // Real navigation code: heading + action row + step keys + one-page visibility rules.
 vm.runInContext(extract('function encounterWorkflow(){','function setEncounterSection('),context,{filename:'encounter-navigation.js'});
 vm.runInContext(extract('function renderEncounterOrderActions(){','function setEncounterSection('),context,{filename:'encounter-orders-actions.js'});
 vm.runInContext(extract('function setEncounterSection(key){','function openEncounterStep('),context,{filename:'encounter-steps.js'});
 vm.runInContext(extract('function chartAreaEnabled(key){','function chartNavigation(tabs)'),context,{filename:'chart-navigation.js'});
 vm.runInContext(extract('function showChartSection(key){','function closeNavigation()'),context,{filename:'chart-show.js'});
 vm.runInContext(extract('function renderVisit(activate=true) {','function renderHistory()'),context,{filename:'encounter-render.js'});
 const evaluate=code=>vm.runInContext(code,context);
 const tabs=['overview','profile','clinical','history','documents','referrals','orders','visits','insurance','prescribing'].concat(billing?['billing']:[]).concat(checkout?['checkout']:[]);
 evaluate(`practiceWorkspaceSettings={version:4,content:{module_order:Object.keys(workspaceModuleIds),hidden_modules:[],chart_tabs:${JSON.stringify(tabs)}}}`);
 evaluate(`workspace={patient:{id:'patient-1'},appointments:[{id:'appt-1',status:'in_progress',title:'Office visit',clinician_id:'clinician-1'}],visits:[],amendments:[],clinical:{items:[]},labs:{orders:[],reports:[],acknowledgments:[]},billing:{accounts:[]},copays:[],history:null};
  activeVisit={id:'visit-1',patient_id:'patient-1',appointment_id:'appt-1',clinician_id:'clinician-1',status:'in_progress',version:3,note:null,vitals:{}};
  workspace.visits=[activeVisit];`);
 const settle=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));};
 return {evaluate,nodes,scrolls,notices,settle};
}
async function main(){
 // 1. The visit page has one scrolling page, not a numbered step bar.
 let f=fixture();
 let heading=f.evaluate('encounterWorkflow()');
 assert.match(heading,/encounter-visit-actions/,'the heading carries the visit action row');
 assert.doesNotMatch(heading,/encounter-step-tabs|Step 1|1\. Vitals/,'no numbered step bar is rendered');
 for(const label of ['Vitals','Note','Finish'])assert.ok(!new RegExp(`>(?:\\d+\\.\\s*)?${label}<`).test(heading),`"${label}" is not a step tab`);
 f.evaluate('renderVisit(false)');
 assert.equal(f.nodes['visit-editor'].hidden,false,'the visit block is open');
 assert.equal(f.nodes['encounter-intake'].hidden,false,'vitals sit on the same page');
 assert.equal(f.nodes['encounter-documentation'].hidden,false,'the note sits on the same page');
 assert.equal(f.nodes['encounter-revenue'].hidden,false,'codes & charges sit on the same page');
 assert.equal(f.nodes['visit-checkout'].hidden,false,'payment & finish sit on the same page');

 // 2. The old step keys stay accepted and land on the visit page itself.
 let steps=fixture();
 for(const [key,expectedScroll] of [['intake','encounter-intake'],['documentation','note-form'],['charges','encounter-revenue'],['checkout','visit-checkout']]){
  const g=fixture();
  g.evaluate('renderVisit(false)');g.scrolls.length=0;g.evaluate(`setEncounterSection('${key}')`);await g.settle();
  assert.equal(g.evaluate('encounterSection'),key,`"${key}" stays addressable for saved routes`);
  assert.equal(g.evaluate('encounterShows("charges")'),true,`"${key}" still answers as the visit page`);
  assert.equal(g.evaluate('chartSection'),'visits',`"${key}" stays inside the encounter`);
  assert.equal(g.nodes['visit-editor'].hidden,false,`"${key}" keeps the whole page open`);
  assert.equal(g.nodes['encounter-intake'].hidden,false,`"${key}" keeps vitals on the same page`);
  assert.equal(g.nodes['encounter-documentation'].hidden,false,`"${key}" keeps the note on the same page`);
  assert.equal(g.nodes['encounter-revenue'].hidden,false,`"${key}" keeps the charges block open`);
  assert.equal(g.nodes['visit-checkout'].hidden,false,`"${key}" keeps the payment block open`);
  if(expectedScroll)assert.ok(g.scrolls.includes(expectedScroll),`${key} did not scroll: ${JSON.stringify(g.scrolls)}`);
 }
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');g.evaluate("setEncounterSection('charges')");await g.settle();
  assert.equal(g.evaluate('encounterShows("charges")'),true,'the charges block stays answered from the charges key');
  assert.ok(g.evaluate('getRenders()').revenueRenders>=2,'the charges block is rendered when named');
 }

 // 3. Hiding billing or checkout keeps a single page: the blocks vanish, nothing re-steps.
 {
  const g=fixture({billing:false});
  g.evaluate('renderVisit(false)');
   assert.equal(g.evaluate('visitBillingAreaVisible()'),false,'the hidden billing tab removes the charges area');
  assert.equal(g.nodes['encounter-revenue'].hidden,true,'billing hidden by the practice removes the charges block');
  assert.equal(g.nodes['visit-editor'].hidden,false,'the note page is unchanged');
  assert.equal(g.nodes['visit-checkout'].hidden,false,'checkout is unaffected');
  assert.match(g.evaluate('encounterWorkflow()'),/encounter-visit-actions/,'still one page, not a step bar');
 }
 {
  const g=fixture({checkout:false});
  g.evaluate('renderVisit(false)');
  assert.equal(g.evaluate('visitCheckoutAreaVisible()'),false,'the hidden checkout tab removes the payment block');
  assert.equal(g.nodes['visit-checkout'].hidden,true,'checkout hidden by the practice removes the payment block');
  assert.equal(g.nodes['visit-editor'].hidden,false,'the rest of the page stays');
  assert.equal(g.nodes['encounter-revenue'].hidden,false,'charges are unaffected');
 }
 {
  // A role that cannot see billing sees no charges block either.
  const g=fixture({billing:false});
  assert.equal(g.evaluate('visitBillingAreaVisible()'),false,'billing hidden from the practice hides the area');
 }

 // 5. The note block never duplicates the diagnoses editor the charges block owns.
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');
  assert.doesNotMatch(g.nodes['visit-editor'].innerHTML,/id="visit-diagnoses"/,'with charges on screen the note does not draw its own diagnoses editor');
  assert.equal(g.evaluate('visitNoteOwnsDiagnoses()'),false);
  const hidden=fixture({billing:false});
  hidden.evaluate('renderVisit(false)');
  assert.match(hidden.nodes['visit-editor'].innerHTML,/id="visit-diagnoses"/,'with no charge table the note keeps the diagnoses editor');
 }

 // 7. Orders and Files are areas of their own: whole screen, single Back to visit button.
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');g.evaluate("setEncounterSection('orders')");await g.settle();
  assert.equal(g.evaluate('encounterSection'),'orders','the Orders area is its own state');
  assert.equal(g.nodes['visit-editor'].hidden,true,'the visit page steps away while Orders is open');
  assert.equal(g.nodes['encounter-revenue'].hidden,true);
  assert.equal(g.nodes['visit-checkout'].hidden,true,'checkout stays away while another area is open');
  assert.equal(g.nodes['encounter-orders-actions'].hidden,false,'the orders action panel opens');
  heading=g.evaluate('encounterWorkflow()');
  assert.match(heading,/data-encounter-back[^>]*>← Back to visit</,'the area offers Back to visit');
  assert.doesNotMatch(heading,/data-encounter-step="new-order"|data-chart-section="referrals"/,'the normal visit actions are not doubled up on the area screen');
  g.evaluate("setEncounterSection('visit')");await g.settle();
  assert.equal(g.evaluate('encounterSection'),'visit','Back to visit returns to the page');
  assert.equal(g.nodes['visit-editor'].hidden,false);
  assert.equal(g.nodes['visit-checkout'].hidden,false,'the whole page comes back');
  assert.match(g.evaluate('encounterWorkflow()'),/encounter-visit-actions/,'and the action row is back');
 }
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');g.evaluate("setEncounterSection('files')");await g.settle();
  assert.equal(g.evaluate('encounterSection'),'files','the Files area is its own state');
  assert.equal(g.nodes['visit-editor'].hidden,true);
  assert.equal(g.nodes['documents-panel'].hidden,false,'the encounter files panel opens');
  assert.ok(g.evaluate('getRenders()').filesRenders>=1,'the files area renders its list');
  assert.match(g.evaluate('encounterWorkflow()'),/data-encounter-back/,'Files offers Back to visit');
  g.evaluate("setEncounterSection('visit')");await g.settle();
  assert.equal(g.nodes['visit-editor'].hidden,false,'Back to visit leaves Files');
 }

 console.log('PASS the visit is one scrolling page; old step keys land on it; record areas take the screen until Back to visit');
}
main().catch(error=>{console.error(error.message);process.exit(1);});
