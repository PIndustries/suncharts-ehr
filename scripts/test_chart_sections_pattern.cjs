// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const app=fs.readFileSync('web/app.js','utf8');
const layoutHelpers=app.slice(app.indexOf('// Chart list layout helpers.'),app.indexOf('// End chart list layout helpers.'));
const dom=new JSDOM('<!doctype html><div id="app"><main><header class="shell-topbar"></header><div class="workspace frame-chart-open"><div id="chart"><header id="patient-banner"></header><aside class="chart-context"></aside><section id="appointments-panel"></section></div></div></main></div>',{runScripts:'outside-only',url:'http://localhost/'}),w=dom.window;
const runtimeErrors=[];w.addEventListener('error',event=>{runtimeErrors.push(event.error?.message||event.message);event.preventDefault();});
w.structuredClone=structuredClone;w.crypto.randomUUID=()=> '11111111-1111-4111-8111-111111111111';
w.eval=source=>require('node:vm').runInContext(source,dom.getInternalVMContext());
w.eval(`const $=id=>document.getElementById(id);const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');let me={role:'owner',user_id:'synthetic-staff'},selected='synthetic-patient',chartSection='clinical',activeVisit={id:'synthetic-visit',status:'in_progress',clinician_id:'synthetic-staff',vitals:{heart_rate_bpm:72,temperature_c:37,systolic_mm_hg:120,diastolic_mm_hg:80,weight_kg:70,height_cm:175,oxygen_saturation_pct:99},created_at:'2026-11-24'};const date=v=>v||'—';let frameClinicalFocus='problem';let workspace={patient:{},clinical:{items:[],reviews:[],review_history:[]},visits:[activeVisit],appointments:[],labs:{orders:[],reports:[],specimens:[],acknowledgments:[]},history:[],billing:{accounts:[],coverages:[]}};const run=f=>f();const notice=()=>{};const money=v=>'$'+Number(v/100).toFixed(2);const encounterDateLabel=v=>v.created_at;const visitVitalsSummary=v=>Object.keys(v).length?'Recorded':'';const vitalBothUnits=(key,v)=>String(v);const canRecordVisitVitals=v=>v?.status==='in_progress';const captureVisitDrafts=()=>{};const sheetOpen=(title,node)=>{const d=document.createElement('dialog');d.innerHTML='<div class="sheet-body"></div>';d.querySelector('div').append(node);document.body.append(d);d.close=()=>d.dispatchEvent(new Event('close'));return d;};`);
w.eval(layoutHelpers);
for(const file of ['display-format.js','clinical.js','health-history.js','immunizations.js','referrals.js','prescribing.js','documents.js','document-files.js','care-pathways.js','patient-billing-workspace.js'])w.eval(fs.readFileSync('web/'+file,'utf8'));
const extract=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
w.eval(extract('function renderHistory()','function encounterWorkflow()'));
w.eval(extract('let patientVitalsReadings;', 'async function loadPatientVitalsReadings('));
w.eval(extract('function patientVitalsTrend(', 'function chartAreaEnabled('));
const scheduling=fs.readFileSync('web/scheduling.js','utf8');
w.eval(scheduling.slice(scheduling.indexOf('function patientEncounterHistoryEntries()'),scheduling.indexOf('async function openPatientAppointmentEditor(')));
const revenue=fs.readFileSync('web/patient-revenue.js','utf8');
w.eval(revenue);
w.eval(fs.readFileSync('web/labs.js','utf8').split('function showOrder(')[0]);
const add=id=>{const n=w.document.createElement('section');n.id=id;w.document.getElementById('chart').append(n);return n;};
for(const id of ['health-history-panel','immunizations-panel','referrals-panel','prescribing-panel','documents-panel','care-pathways-panel'])add(id);
w.eval(`healthHistoryStates.set(selected,{items:[],status:'',kind:''});immunizationStates.set(selected,{items:[]});referralStates.set(selected,{items:[],status:''});prescribingStates.set(selected,{items:[],pharmacies:[],preference:{pharmacy_id:null}});documentStates.set(selected,{items:[],status:'active'});const scheduleProviders=[];const canStartEncounterFlow=()=>true;const canSchedule=()=>true;const billingCan=()=>true;const payerName=()=> 'Synthetic plan';const claimmdEligibilityButton=()=>'<button>Check eligibility</button>';const typeaheadInit=()=>{};pharmacyPickerMarkup=()=>'<input name="pharmacy">';const erxCanPrepare=()=>false;`);
function check(id,title,insurance=false){
 const node=w.document.getElementById(id);assert(node,title);
 const headings=[...node.querySelectorAll('h2')].filter(n=>!n.closest('[hidden]')||n.closest('[hidden]')===node);assert.equal(headings.length,1,title+' has one h2');assert.equal(headings[0].textContent,title);
 const head=node.querySelector('.chart-list-header');assert(head,title+' header');assert(head.querySelectorAll('button.primary').length<=1,title+' has one primary action');
 assert(node.querySelector('table,.chart-empty-row')||(insurance&&node.querySelector('.insurance-coverage-card')),title+' has table or empty line');
 // Record pages now retain explicit limitations and counts for their filters/pagination.
 const guidance={
  'health-history-panel':'Past surgeries and dental problems. Adding one here does not order a procedure or change the problem list. An empty list means nothing has been recorded, not that there is no history.',
  'immunizations-panel':'Vaccines given here and vaccines reported from elsewhere. Codes are saved as typed and are not checked. This list is not sent to an immunization registry. SunCharts does not determine which vaccines are due, track stock or check doses.'
 };
 for(const p of node.querySelectorAll('p'))if(p.textContent.length>120)assert.equal(p.textContent,guidance[id],title+' shows supported-contract guidance');
 if(guidance[id])assert([...node.querySelectorAll('p')].some(p=>p.textContent===guidance[id]),title+' retains its limitations');
 assert.doesNotMatch(node.textContent,/Return to the selected encounter/i,title+' has no obsolete navigation');
 const state={ 'health-history-panel':'healthHistoryStates','immunizations-panel':'immunizationStates','referrals-panel':'referralStates','documents-panel':'documentStates' }[id];
 if(id==='documents-panel'){
  const count=w.eval('documentFileItems(documentStates.get(selected)).length');
  assert.equal(node.querySelector('p[role="status"]')?.textContent,`${count} ${count===1?'file':'files'}`,title+' announces the visible result count');
 }else if(state){const count=w.eval(state+'.get(selected).items.length');assert([...node.querySelectorAll('p')].some(p=>p.textContent===(id==='immunizations-panel'?count+' loaded':count+' matching of '+count+' loaded')),title+' shows the actual loaded/filter count');}
 else assert.doesNotMatch(node.textContent,/\bloaded\b|\d+ matching of \d+/i,title+' has no unrelated counters');
 console.log('PASS '+title);
}
for(const [kind,title]of [['problem','Problems'],['allergy','Allergies'],['medication','Medications']]){
 w.eval(`frameClinicalFocus='${kind}';workspace.clinical.items=[{id:'synthetic-entry',kind:'${kind}',content:{title:'Synthetic entry',codes:[],status:'active',detail:{kind:'${kind}'}}}];renderClinical()`);check('clinical-lists',title);
 const columns={problem:['Problem','ICD-10 code + name','Onset','Status','Resolved','Verification'],allergy:['Allergen','Category','Reaction','Severity / criticality','Status','Verification'],medication:['Medication','Dose / route / frequency','Start','End','Status','Verification']}[kind];
 assert.deepEqual([...w.document.querySelectorAll('#clinical-lists thead th')].map(n=>n.textContent),columns);
 assert.equal(w.document.querySelector('#clinical-lists tbody tr').children.length,columns.length);
}
w.eval(`$('patient-vitals-history')?.remove();$('chart').insertAdjacentHTML('beforeend',patientVitalsHistory());`);check('patient-vitals-history','Vitals');assert.equal(w.document.querySelectorAll('#patient-vitals-history tbody tr').length,1);assert.equal(w.document.querySelectorAll('#patient-vitals-history tbody tr td').length,11);assert.match(w.document.getElementById('patient-vitals-history').textContent,/120\/80 mmHg/);
w.document.getElementById('appointments-panel').outerHTML=w.eval('patientAppointmentWorkspace()');check('appointments-panel','Encounters');assert.equal(w.document.querySelectorAll('#appointments-panel tbody tr').length,1);
for(const [call,id,title]of [['renderLabs()','lab-workspace','Orders & results'],['showHealthHistory()','health-history-panel','Surgical & dental history'],['showImmunizations()','immunizations-panel','Immunizations'],['showReferrals()','referrals-panel','Referrals'],['showPrescribing()','prescribing-panel','Prescribing'],['showDocuments()','documents-panel','Files'],['renderHistory()','source-history','Imported records'],['renderCarePathwayPanel()','care-pathways-panel','Practice workflows']]){
 if(title==='Practice workflows')w.eval('applyChartSection=()=>{}');
 w.eval(call);check(id,title);
}
const insurance=add('insurance-workspace');insurance.innerHTML=w.eval(`chartListHeader('Insurance & copay','<button class="primary">+ Add insurance</button>')+insuranceCoverageCard({id:'synthetic-plan',content:{member_id:'SYN-1',priority:'primary'}})`);check('insurance-workspace','Insurance & copay',true);
const billing=add('patient-billing-chart');billing.innerHTML=w.eval(`patientBillingShell({surface:'chart'})+patientBillingChartOverview({summary:{accounts:{reviewed_patient_due_cents:100,insurance_pending_cents:300},copays:{net_received_cents:200,usable_unapplied_cents:0,receipts:2}},accounts:{items:[]}},{patientId:selected})`);check('patient-billing-chart','Billing & payments');
// Totals now open Payments; retain every tile, amount and explanatory sub-line.
const billingTiles=[...billing.querySelectorAll('.patient-billing-totals > section')];
assert.equal(billingTiles.length,4);
assert.deepEqual(billingTiles.map(tile=>{
 const action=tile.querySelector('button.billing-total-action[data-hub-tab="payments"]');
 assert(action,'each total opens Payments');
 return ['span','strong','small'].map(tag=>action.querySelector(tag)?.textContent);
}),[
 ['Patient owes','$1.00','Across posted encounters. Money still with insurance is not counted'],
 ['Insurance pending','$3.00','With insurance · not included in patient owes'],
 ['Paid','$2.00','2 receipts · after refunds'],
 ['Credit','$0.00','Paid but not yet applied to an encounter']
]);
assert.equal(billing.querySelector('.patient-billing-header'),null,'patient identity is already present in the chart header');assert.deepEqual([...billing.querySelectorAll('#patient-billing-mode option')].map(n=>n.textContent),['Live payments','Test payments']);
// Nonempty native records must produce rows while keeping all existing rare actions in sheets.
w.eval(`healthHistoryStates.get(selected).items=[{id:'history-1',version:1,content:{kind:'surgery',title:'Synthetic procedure',status:'completed'}}];immunizationStates.get(selected).items=[{id:'vaccine-1',version:1,content:{vaccine_name:'Synthetic vaccine',status:'completed',record_type:'historical'}}];referralStates.get(selected).items=[{id:'referral-1',status:'draft',content:{recipient:'Synthetic clinic',requested_service:'Consultation',document_ids:[]}}];prescribingStates.get(selected).items=[{id:'rx-1',status:'draft',content:{medication_name:'Synthetic medication'}}];`);
for(const [call,id,title]of [['showHealthHistory()','health-history-panel','Surgical & dental history'],['showImmunizations()','immunizations-panel','Immunizations'],['showReferrals()','referrals-panel','Referrals'],['showPrescribing()','prescribing-panel','Prescribing']]){w.eval(call);check(id,title);assert.equal(w.document.querySelectorAll('#'+id+' tbody tr').length,1);assert(w.document.querySelector('#'+id+' template').content.querySelector('button'),'record actions retained');}
// Use real click handlers and actual navigation code; modeled geometry makes offset errors deterministic.
w.eval(extract('function chartAreaEnabled(','function syncPatientNextAction()').replace("let frameClinicalFocus='problem';",''));
w.eval(extract('function chartNavigationEncounter()', 'function patientWorkflowActions()'));
w.eval(extract('function showChartSection(','\nconst formData='));
w.eval(`syncPatientNextAction=()=>{};const chartAreaEnabledOriginal=chartAreaEnabled;refreshPatientChartContext=()=>{};renderPatientBillingChart=()=>{};renderPatientInsurance=()=>{};const loadPatientVitalsReadings=()=>{};renderReferrals=()=>{};renderPrescribing=()=>{};renderImmunizations=()=>{};renderHealthHistory=()=>{};renderCarePathways=()=>{};renderDocuments=()=>{};applyLabEncounterScope=()=>{};documentFileNavigationChanged=()=>{};const encounterSection='visit';inRecordArea=()=>true;`);
// frameClinicalFocus was already declared above; the extracted declaration is removed below.

const chart=w.document.getElementById('chart'),banner=w.document.getElementById('patient-banner'),bar=w.document.querySelector('.shell-topbar');
Object.defineProperties(banner,{offsetTop:{value:0},offsetHeight:{value:70}});
bar.getBoundingClientRect=()=>({top:0,bottom:58,height:58});
banner.getBoundingClientRect=()=>({top:58,bottom:128,height:70});
chart.getBoundingClientRect=()=>({top:70-w.scrollY});
w.scrollTo=({top})=>{w.scrollY=top;};
let scrolling=0;w.HTMLElement.prototype.scrollIntoView=()=>{scrolling++;};
const keys=['problem','allergy','medication','vitals','encounters','orders','referrals','prescribing','immunizations','history','insurance','billing','documents','source','care_pathways','functional_status','specialty_care','overview','profile'];
const nav=w.document.querySelector('.chart-context');
nav.innerHTML=keys.map(key=>`<button data-test-section="${key}">${key}</button>`).join('');
nav.addEventListener('click',event=>w.showChartSection(event.target.dataset.testSection));
for(const button of nav.querySelectorAll('button')){
 w.scrollY=900;button.click();
 assert.equal(w.scrollY,900,button.textContent+' preserves window scroll');
 assert(bar.getBoundingClientRect().top>=0&&bar.getBoundingClientRect().bottom<=800,'top bar visible');
 assert(banner.getBoundingClientRect().top>=0&&banner.getBoundingClientRect().bottom<=800,'patient header visible');
 assert.equal(scrolling,0,'no scrollIntoView while changing sections');
}
const css=fs.readFileSync('web/frame.css','utf8');
assert.match(css,/shell-topbar\{[^}]*position:sticky;top:0/);
assert.match(css,/#chart>#patient-banner\{[^}]*position:sticky;top:var\(--frame-top-height/);
assert.match(css,/#chart>\.chart-context\{position:sticky;[^}]*overflow-y:auto/);
assert.match(app,/Return to the selected encounter/);
assert.doesNotMatch(app,/section\?\.scrollIntoView/);
console.log('PASS all chart navigation clicks: unchanged window scroll, retained headers and no scrollIntoView');
// Opening an editable row reuses one sheet and the native form; no empty modal appears on list render.
w.eval("focusClinicalSection('medication');renderClinical()");
w.document.querySelector('#clinical-lists tbody button').click();
assert.equal(w.document.querySelectorAll('dialog').length,1);
assert(w.document.querySelector('dialog #clinical-entry-form'),'clinical row opens its native edit form');
w.chartCloseSheets();
w.eval("showChartSection('history');showHealthHistory()");
w.document.querySelector('#health-history-panel tbody button').click();
assert.equal(w.document.querySelectorAll('dialog').length,1);
assert(w.document.querySelector('dialog #health-history-form'),'history row opens its native edit form');
w.chartCloseSheets();
console.log('PASS row editing reuses one sheet and native forms');
assert.deepEqual(runtimeErrors,[],'delegated chart actions complete without runtime errors');
dom.window.close();
// Run with --browser for real viewport geometry; the regular run exercises native renderers and actions.
if(process.argv.includes('--browser'))void(async()=>{
 const puppeteer=require('puppeteer-core'),os=require('node:os'),path=require('node:path');
 const executablePath=process.env.CHART_TEST_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'suncharts-chart-test-'));
 let browser;
 try{
  browser=await puppeteer.launch({executablePath,headless:true,userDataDir:profile,args:['--no-sandbox']});
  const page=await browser.newPage();
  const styles=[...fs.readFileSync('web/index.html','utf8').matchAll(/href="\/([^\"]+\.css)"/g)].map(m=>fs.readFileSync('web/'+m[1],'utf8')).join('\n');
  const setup=`const $=id=>document.getElementById(id),esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');let selected='synthetic-patient',me={role:'owner'},chartSection='overview',encounterSection='visit',activeVisit=null;let workspace={visits:[],clinical:{items:[],reviews:[],review_history:[]},billing:{}};const date=String,notice=()=>{},captureVisitDrafts=()=>{},capturePrescribingDraft=()=>{},syncPatientNextAction=()=>{},workspaceResourceAllowed=()=>true,patientWorkflowActionContent=()=>'',renderPatientBillingChart=()=>{},encounterDateLabel=()=>'',visitVitalsSummary=()=>'',canRecordVisitVitals=()=>false;window.sectionScrollCalls=0;Element.prototype.scrollIntoView=function(){window.sectionScrollCalls++};`;
  const navigationSource=extract('function chartAreaEnabled(','function syncPatientNextAction()')+extract('function chartNavigation(tabs){','function patientWorkflowActionContent()')+extract('function showChartSection(','\nconst formData=');
  const helper=layoutHelpers;
  const clinical=fs.readFileSync('web/clinical.js','utf8');
  for(const width of [1440,1024,768,390]){
   await page.setViewport({width,height:900});
   const ids=['chart-overview','patient-identity-panel','functional-status-panel','specialty-care-panel','patient-vitals-history','appointments-panel','lab-workspace','referrals-panel','prescribing-panel','immunizations-panel','health-history-panel','insurance-workspace','billing-workspace','documents-panel','source-history','care-pathways-panel'];
   const panels=ids.map(id=>`<section class="panel" id="${id}"><h2 tabindex="-1">Synthetic section</h2><div style="height:1400px"></div></section>`).join('');
   await page.setContent(`<style>${styles}</style><div id="app" class="shell"><main><header class="shell-topbar"><strong>SunCharts</strong><div>Home · Schedule · Patients · Billing · Admin</div><div class="frame-patient-tabs"><button>Patient one</button><button>Patient two</button></div></header><div class="workspace frame-chart-open"><div id="chart" class="chart"><header id="patient-banner" class="patient-banner"><div class="patient-banner-top"><strong>Synthetic patient</strong><button>Continue encounter</button></div></header><aside class="chart-context"></aside><div id="chart-content-top" aria-hidden="true"></div>${panels}</div></div></main></div>`);
   await page.addScriptTag({content:setup+helper+navigationSource+clinical});
   await page.evaluate(()=>{
    const tabs=['overview','profile','clinical','visits','orders','referrals','prescribing','immunizations','history','billing','insurance','documents','source','care_pathways','functional_status','specialty_care'].map(key=>[key,key]);
    document.querySelector('.chart-context').innerHTML=chartNavigation(tabs);
    document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.clinicalFocus)focusClinicalSection(b.dataset.clinicalFocus);else if(b.hasAttribute('data-encounter-history'))openPatientEncounterList();else if(b.dataset.chartSection)showChartSection(b.dataset.chartSection);});
    applyChartSection();chartStickySizes();
   });
   const buttons=await page.$$('.frame-chart-navigation button');
   for(let i=0;i<buttons.length;i++){
    // Programmatic DOM click avoids the automation library scrolling the window to its click target.
    await page.evaluate(index=>{document.querySelector('main').scrollTop=700;document.querySelectorAll('.frame-chart-navigation button')[index].click();},i);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const result=await page.evaluate(()=>{const bar=document.querySelector('.shell-topbar').getBoundingClientRect(),banner=document.getElementById('patient-banner').getBoundingClientRect();return {y:window.scrollY,target:chartContentTop(),bar:[bar.top,bar.bottom],banner:[banner.top,banner.bottom],calls:window.sectionScrollCalls,height:innerHeight};});
    assert.equal(result.y,0,`width ${width} item ${i}: window stays fixed ${JSON.stringify(result)}`);
    for(const rect of [result.bar,result.banner])assert(rect[0]>=-1&&rect[1]<=result.height,`width ${width}: sticky header visible`);
    assert.equal(result.calls,0,'section changes never call scrollIntoView');
   }
   console.log(`PASS real viewport: ${width}px, every left-panel section, both sticky headers, fixed window`);
  }
 }finally{await browser?.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
