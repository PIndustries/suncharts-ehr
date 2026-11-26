// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{JSDOM}=require('jsdom');
const app=fs.readFileSync('web/app.js','utf8'),historySource=fs.readFileSync('web/navigation-history.js','utf8');
const extract=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const patient='11111111-1111-4111-8111-111111111111',visit='22222222-2222-4222-8222-222222222222';
const dom=new JSDOM('<div id="clinical-workspace"><div id="chart"><aside class="chart-context"></aside><div id="record-context"></div><section id="clinical-lists"></section><section id="appointments-panel"></section></div></div><div id="tools" hidden></div>',{url:`http://localhost/#/patients/${patient}/encounters`,runScripts:'outside-only'});
const w=dom.window,context=dom.getInternalVMContext();
w.requestAnimationFrame=callback=>setImmediate(callback);w.scrollTo=()=>{};
const evaluate=source=>vm.runInContext(source,context);
evaluate(`
const $=id=>document.getElementById(id),esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
let selected='${patient}',activeVisit={id:'${visit}',status:'in_progress'},me={tenant_id:'synthetic-tenant',user_id:'synthetic-staff',role:'owner'},chartSection='overview',encounterSection='visit';
let workspace={patient:{id:selected},visits:[activeVisit,{id:'signed-visit',status:'signed'}],appointments:[],clinical:{items:[
 {kind:'problem',content:{status:'active'}},{kind:'problem',content:{status:'resolved'}},
 {kind:'allergy',content:{status:'active'}},{kind:'allergy',content:{status:'active',verification:'refuted'}},
 {kind:'medication',content:{status:'active'}}],reviews:[{kind:'allergy',review_state:'no_known'}]},
 labs:{reports:[{id:'report',version:2,status:'corrected'},{id:'reviewed',version:1,status:'final'},{id:'error',version:1,status:'entered_in_error'}],acknowledgments:[{report_id:'report',version:1},{report_id:'reviewed',version:1}]},billing:{coverages:[{id:'synthetic-coverage'}]}};
let patientBanner={data:{billing:{patient_due_cents:12345},eligibility:[]}};
const patientBannerCurrent=()=>true,workspaceResourceAllowed=()=>true;
const captureVisitDrafts=()=>{},syncPatientNextAction=()=>{},alignChartContent=()=>{},renderPatientBillingChart=()=>{},renderClinical=()=>{};
function setPage(){}
async function enter(){await restoreInitialWorkspaceRoute();restoreInitialWorkspaceScroll();}
function run(fn){return fn();}
function setEncounterSection(step){encounterSection=step;}
let patientLoads=0,directoryLoads=0;
async function selectPatient(id,keepVisit){patientLoads++;selected=id;workspace.patient.id=id;activeVisit=keepVisit?{id:keepVisit}:null;}
async function showClinical(){directoryLoads++;selected=null;activeVisit=null;}
async function restorePatientBillingRoute(){}
`);
evaluate(extract(app,'function chartAreaEnabled(','function syncPatientNextAction()'));
evaluate(extract(app,'function chartNavigationMarkers(','function patientWorkflowActions()'));
evaluate(extract(app,'function showChartSection(','\nconst formData='));
const keys=['overview','profile','clinical','visits','orders','referrals','prescribing','immunizations','history','insurance','billing','documents','source','care_pathways','functional_status','specialty_care'];
w.document.querySelector('.chart-context').innerHTML=evaluate(`chartNavigation(${JSON.stringify(keys.map(k=>[k,k]))})`);
const buttons=()=>[...w.document.querySelectorAll('.frame-chart-navigation button')];
assert.equal(buttons().length,23);
const paths=new Set();
for(const button of buttons()){
 const svg=button.querySelector('svg');assert(svg,'every item has an SVG');
 assert.equal(svg.getAttribute('width'),'16');assert.equal(svg.getAttribute('height'),'16');
 assert.equal(svg.getAttribute('stroke-width'),'1.5');assert.equal(svg.getAttribute('stroke'),'currentColor');
 paths.add(svg.querySelector('path').getAttribute('d'));
 assert.doesNotMatch(button.textContent,/[℞▧⋈⇣⚗⌂○✚✧♡▤↗◇◈▱◫]/);
}
assert.equal(paths.size,buttons().length,'each item has a distinct icon');
const marker=key=>w.document.querySelector(`[data-chart-markers="${key}"]`);
assert.equal(marker('problem').textContent,'1');assert(marker('problem').querySelector('.frame-nav-dot'));
assert.equal(marker('allergy').textContent,'1');assert(!marker('allergy').querySelector('.frame-nav-dot'));
assert.equal(marker('medication').textContent,'1');assert(marker('medication').querySelector('.frame-nav-dot'));
assert.equal(marker('visits').textContent,'2');assert.equal(marker('visits').querySelector('.frame-nav-dot').getAttribute('aria-label'),'1 unsigned note');assert.equal(marker('visits').querySelector('.frame-nav-dot').title,'1 unsigned note');
assert.equal(marker('orders').querySelector('.is-danger').textContent,'1','only current unacknowledged report revisions');
assert.equal(marker('billing').textContent,'$123.45');assert(marker('insurance').querySelector('.frame-nav-dot'));
const groupNames=['Care tools','Patient chart','Billing','History & records'];
assert.deepEqual([...w.document.querySelectorAll('[data-chart-group-toggle]')].map(button=>button.getAttribute('aria-label')),groupNames);
assert(w.document.querySelector('[data-chart-sidebar-group="Patient chart"] [data-chart-section="profile"]'));
assert.equal(w.document.querySelector('[data-encounter-history]').closest('[data-chart-sidebar-group]').dataset.chartSidebarGroup,'History & records');
evaluate('applyChartSection()');
// Exercise the complete history listener and actual chart section functions.
evaluate(historySource);
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
async function navigate(slug){w.history.replaceState(null,'',`#/patients/${patient}/${slug}`);w.dispatchEvent(new w.HashChangeEvent('hashchange'));await settle();}
(async()=>{
 // A fresh address is restored after sign-in, including a menu initially rendered as Summary.
 const summaryButton=w.document.querySelector('[data-chart-section="overview"]');
 summaryButton.classList.add('active','selected','default-active');summaryButton.setAttribute('aria-current','page');
 evaluate('selected=null;');await w.enter();await settle();
 assert.equal(evaluate('patientLoads'),1);assert.equal(evaluate('directoryLoads'),0);
 evaluate(`patientLoads=0;directoryLoads=0;activeVisit={id:'${visit}',status:'in_progress'};`);
 const assertSelection=key=>{
  assert.deepEqual(buttons().filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.clinicalFocus||b.dataset.chartSection),[key]);
  assert.equal(w.document.querySelectorAll('.frame-chart-navigation .active,.frame-chart-navigation .selected,.frame-chart-navigation .default-active,.frame-chart-navigation [aria-current]').length,0);
  assert.equal(w.document.getElementById('frame-chart-select').value,key);
 };
 assert.equal(evaluate('chartSection'),'encounters');assertSelection('visits');
 // Menu and banner controls call the same section handler; browser history restores that selection.
 for(const section of ['overview','encounters']){w.showChartSection(section);await settle();assertSelection(section==='encounters'?'visits':section);}
 w.history.back();await new Promise(resolve=>setTimeout(resolve,30));await settle();assertSelection('overview');
 w.history.forward();await new Promise(resolve=>setTimeout(resolve,30));await settle();assertSelection('visits');
 const banner=w.document.createElement('button');banner.dataset.chartSection='insurance';banner.addEventListener('click',()=>w.showChartSection(banner.dataset.chartSection));w.document.getElementById('chart').prepend(banner);banner.click();await settle();assertSelection('insurance');
 const routes={summary:'overview',overview:'overview',profile:'profile',record:'profile',problems:'clinical',allergies:'clinical',medications:'clinical',clinical:'clinical',vitals:'vitals',encounters:'encounters',orders:'orders',referrals:'referrals',insurance:'insurance',billing:'billing',files:'documents','imported-records':'source','care-pathways':'care_pathways',prescriptions:'prescribing',immunizations:'immunizations','surgical-dental-history':'history',assessments:'functional_status','specialty-care':'specialty_care',encounter:'visits'};
 for(const [slug,section] of Object.entries(routes)){
  await navigate(slug);assert.equal(evaluate('chartSection'),section,slug);
  const expected=section==='clinical'?({problems:'problem',allergies:'allergy',medications:'medication',clinical:'problem'}[slug]):['encounters','visits'].includes(section)?'visits':section;
  assert.deepEqual(buttons().filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.clinicalFocus||b.dataset.chartSection),[expected],slug+' highlights the visible section');
  buttons().forEach(b=>b.setAttribute('aria-pressed','false'));w.showChartSection(section);
  assert.equal(buttons().filter(b=>b.getAttribute('aria-pressed')==='true').length,1,'reopening the section repairs selection');
  const focus={problems:'problem',allergies:'allergy',medications:'medication',clinical:'problem'}[slug];
  if(focus)assert.equal(evaluate('frameClinicalFocus'),focus,slug);
  assert.equal(evaluate('activeVisit.id'),visit,slug+' preserves the selected encounter');
  assert.equal(evaluate('patientLoads'),0,slug+' does not reload the patient');
  assert.equal(evaluate('directoryLoads'),0,slug+' does not reload the directory');
  const back=w.document.getElementById('record-context');assert.equal(back.hidden,section==='visits');
  if(section!=='visits')assert.equal(back.querySelector('button').textContent,'← Return to the selected encounter');
 }
 const scoped=w.document.querySelector('[data-encounter-navigation]');
 assert(scoped,'opening a visit switches to encounter navigation');
 const current=scoped.querySelector('[data-chart-section="visits"]');
 assert.equal(current.textContent,'Current encounter');assert(!current.hasAttribute('data-encounter-history'));
 assert.deepEqual([...scoped.querySelectorAll('optgroup')].map(group=>group.label),['Care tools','Patient chart','Billing','History & records']);
 await navigate('encounters');assertSelection('encounters');
 const group=name=>[...scoped.querySelectorAll("[data-chart-sidebar-group]")].find(node=>node.dataset.chartSidebarGroup===name);
 const isOpen=name=>group(name).dataset.sidebarGroupOpen;
 assert.equal(isOpen('History & records'),'true','entering encounter history reveals its group');
 evaluate("chartSidebarGroups('Care tools',false);chartSidebarGroups('Billing',true);chartSidebarCollapsed(true)");
 const preferences=evaluate(`chartNavigation(${JSON.stringify(keys.map(k=>[k,k]))})`);
 const menu=new JSDOM(preferences).window.document;
 assert.equal(menu.querySelector('[data-chart-sidebar-toggle]').getAttribute('aria-label'),'Expand sidebar');
 assert.equal(menu.querySelector('[data-chart-sidebar-group="Care tools"] [data-chart-group-toggle]').getAttribute('aria-expanded'),'false');
 assert.equal(menu.querySelector('[data-chart-sidebar-group="Billing"] [data-chart-group-toggle]').getAttribute('aria-expanded'),'false');
 assert.equal(menu.querySelector('[data-chart-sidebar-group="Billing"]').dataset.sidebarGroupOpen,'true');
 assert(menu.querySelector('[data-chart-sidebar-group="Billing"] [data-chart-group-flyout]'));
 evaluate("me={...me,user_id:'another-staff'}");
 assert.equal(evaluate("chartSidebarCollapsed()"),true,'staff without a preference start with the icon rail');
 assert.deepEqual(JSON.parse(evaluate('JSON.stringify(chartSidebarGroups())')),['Care tools']);
 evaluate("chartSidebarCollapsed(false);me={...me,user_id:'synthetic-staff'}");
 assert.equal(evaluate("chartSidebarCollapsed()"),true);
 assert(w.document.getElementById('record-context').hidden,'the rail already has a return to the visit');
 await navigate('insurance');assertSelection('insurance');assert(scoped.isConnected,'the encounter rail is retained between chart sections');
 // Returning from a practice tool reveals the loaded chart without resetting it.
 w.document.getElementById('clinical-workspace').hidden=true;w.document.getElementById('tools').hidden=false;
 await navigate('profile');assert.equal(w.document.getElementById('clinical-workspace').hidden,false);assert.equal(w.document.getElementById('tools').hidden,true);assert.equal(evaluate('patientLoads'),0);assert.equal(evaluate('activeVisit.id'),visit);
 // Clicking each clinical list records its focus even while the clinical section stays open.
 for(const [focus,slug] of [['problem','problems'],['allergy','allergies'],['medication','medications']]){
  w.focusClinicalSection(focus);await settle();assert.equal(w.location.hash,`#/patients/${patient}/${slug}`);
 }
 w.history.back();await new Promise(resolve=>setTimeout(resolve,30));await settle();
 assert.equal(evaluate('frameClinicalFocus'),'allergy');assert.equal(w.document.querySelector('[data-clinical-focus="allergy"]').getAttribute('aria-pressed'),'true');assert.equal(evaluate('patientLoads'),0);
 w.history.forward();await new Promise(resolve=>setTimeout(resolve,30));await settle();
 assert.equal(evaluate('frameClinicalFocus'),'medication');assert.equal(evaluate('activeVisit.id'),visit);
 // Existing async chart renders refresh markers, including data that arrived after the menu.
 evaluate(`workspace.clinical.reviews.push({kind:'problem',review_state:'reviewed'});workspace.clinical.items=[];workspace.visits=[];workspace.labs.acknowledgments.push({report_id:'report',version:2});patientBanner.data.billing.patient_due_cents=0;patientBanner.data.eligibility=[{coverage_id:'synthetic-coverage',status:'completed'}];$('clinical-lists').textContent='No problems recorded.';`);
 await settle();assert.equal(marker('problem').textContent,'0');assert(!marker('problem').querySelector('.frame-nav-dot'));
 assert.equal(marker('visits').textContent,'0');assert.equal(marker('orders').textContent,'');assert.equal(marker('billing').textContent,'');assert.equal(marker('insurance').textContent,'');
 // A newly addressed patient still loads once, then opens the requested focused list.
 evaluate('selected=null;workspace=null;selectPatient=async(id)=>{patientLoads++;selected=id;workspace={patient:{id},clinical:{items:[],reviews:[]},visits:[]};activeVisit=null;};');
 await navigate('allergies');assert.equal(evaluate('patientLoads'),1);assert.equal(evaluate('directoryLoads'),0);assert.equal(evaluate('frameClinicalFocus'),'allergy');assert.equal(w.document.querySelector('[data-clinical-focus="allergy"]').getAttribute('aria-pressed'),'true');
 console.log('PASS chart SVG icons, loaded counts and review markers, section addresses, focus history and retained encounter');
 dom.window.close();
})().catch(error=>{dom.window.close();console.error(error);process.exitCode=1;});

const css=fs.readFileSync('web/frame.css','utf8');
assert.match(css,/\.frame-section-label\{[^}]*white-space:nowrap;[^}]*word-break:normal/);
assert.match(css,/\.frame-section-markers\{[^}]*flex:none;flex-wrap:nowrap/);
assert.doesNotMatch(css.match(/#chart \.frame-chart-navigation button\{([^}]+)/)[1],/overflow-wrap:anywhere|white-space:normal/);

assert.match(css,/#chart \.frame-chart-navigation button\[aria-pressed=false\]\{[^}]*background:transparent;[^}]*box-shadow:none/);
