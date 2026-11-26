// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{JSDOM}=require('jsdom');
const app=fs.readFileSync('web/app.js','utf8');
const slice=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const dom=new JSDOM('<div id="clinical-workspace"><div id="chart"></div></div><div id="tools" hidden></div><div id="frame-patient-tabs"></div><div id="frame-user-menu"></div>',{runScripts:'outside-only',url:'http://localhost/'});
const w=dom.window,c=dom.getInternalVMContext(),evaluate=source=>vm.runInContext(source,c);
w.scrollTo=({left=0,top=0})=>{w.scrollX=left;w.scrollY=top;};
w.matchMedia=()=>({matches:false});w.requestAnimationFrame=fn=>fn();
evaluate(`
const $=id=>document.getElementById(id),esc=value=>String(value??'');
let me={tenant_id:'synthetic-tenant',user_id:'synthetic-staff'},selected,workspace,activeVisit,billingPayers=[],chartSection='overview',encounterSection='visit',patientWorkspaceGeneration=0,frameClinicalFocus='problem';
const captureVisitDrafts=()=>{},setPatientDirectoryVisible=()=>{},alignChartContent=()=>window.scrollTo({top:0}),notice=()=>{};
function setPage(title){setPage.last=title;}setPage.last='Patients & encounters';
function applyChartSection(){for(const node of $('chart').querySelectorAll('[data-section]'))node.hidden=node.dataset.section!==chartSection;}
function renderChart(){
 $('chart').innerHTML='<section id="patient-banner">Synthetic '+selected+'</section><aside class="chart-context">Menu</aside><section id="overview" data-section="overview">Summary '+selected+'</section><section id="documents" data-section="documents">Files '+selected+'</section><section id="visits" data-section="visits">Encounter '+activeVisit?.id+'</section>';
 applyChartSection();
}
function run(fn){return fn();}
function showClinical(){throw Error('Patient directory must never open');}
const requests=[];
function api(path){if(path.endsWith('/workspace'))return new Promise((resolve,reject)=>requests.push({path,resolve,reject}));return Promise.resolve({items:[]});}
function answer(id){const request=requests.find(request=>request.path.includes('/'+id+'/'));requests.splice(requests.indexOf(request),1);request.resolve({patient:{id,given_name:'Synthetic',family_name:id},visits:[{id:id+'-visit',status:'in_progress'}]});}
`);
evaluate(fs.readFileSync('web/motion.js','utf8'));
evaluate(slice('// Clinical content stays in memory','async function openPatientEncounter('));
evaluate(app.slice(app.indexOf('let framePatients=[];')));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function load(id,visit){const pending=w.selectPatient(id,visit);evaluate(`answer('${id}')`);await pending;}
(async()=>{
 const first=w.selectPatient('synthetic-a','synthetic-a-visit');
 assert(w.document.querySelector('.chart-skeleton-header'));assert(w.document.querySelector('.chart-skeleton-menu'));assert(w.document.querySelector('.chart-skeleton-content'));
 assert.equal(w.document.getElementById('clinical-workspace').hidden,false);assert(!w.document.querySelector('.patient-directory-landing'));
 evaluate("answer('synthetic-a')");await first;
 evaluate("chartSection='documents';encounterSection='files';applyChartSection();");w.scrollTo({top:425});
 const files=w.document.getElementById('documents');
 await load('synthetic-b','synthetic-b-visit');
 const tab=w.document.querySelector('[data-frame-patient="synthetic-a"]'),tabB=w.document.querySelector('[data-frame-patient="synthetic-b"]');
 tab.click();
 assert.equal(w.document.getElementById('documents'),files,'cached live content restored before any response');
 assert.equal(files.hidden,false);assert.equal(evaluate('chartSection'),'documents');assert.equal(evaluate('encounterSection'),'files');assert.equal(evaluate('activeVisit.id'),'synthetic-a-visit');assert.equal(w.scrollY,425);
 assert(!w.document.querySelector('.chart-skeleton-content'));assert.equal(w.document.querySelector('[data-frame-patient="synthetic-a"]'),tab,'top bar stays mounted');
 await tick();assert.equal(w.document.getElementById('documents'),files,'delayed background read leaves cached content intact');
 evaluate("answer('synthetic-a')");await tick();assert.equal(evaluate('chartSection'),'documents');assert.equal(w.scrollY,425);
 assert.equal(w.document.querySelector('[data-frame-patient="synthetic-b"]'),tabB,'tab order stays still');
 // A slower previous destination must never overwrite the latest patient.
 const slow=w.selectPatient('synthetic-c');await load('synthetic-d');evaluate("answer('synthetic-c')");await slow;assert.equal(evaluate('selected'),'synthetic-d');
 // Async section placeholders retain their previous painted content until ready.
 w.document.getElementById('chart').innerHTML='<section id="documents">Cached files</section>';
 const retain=w.motionRetainChart(w.document.getElementById('chart'));
 w.document.getElementById('chart').innerHTML='<section id="documents"><div class="chart-section-skeleton" role="status"><span></span></div></section>';
 retain();assert.equal(w.document.querySelector('.motion-retained').textContent,'Cached files');
 w.document.querySelector('.chart-section-skeleton').outerHTML='<p>Refreshed files</p>';await tick();assert(!w.document.querySelector('.motion-retained'));assert.equal(w.document.getElementById('documents').textContent,'Refreshed files');
 w.matchMedia=()=>({matches:true});w.motionChartIn();assert(!w.document.querySelector('.motion-in'),'reduced motion adds no animation classes');
 w.matchMedia=()=>({matches:false});w.motionChartIn();assert(w.document.querySelector('.motion-in'));w.document.querySelector('.motion-in').dispatchEvent(new w.Event('animationend'));assert(!w.document.querySelector('.motion-in'));
 // Failed background reads keep the cached chart; session changes discard it.
 await load('synthetic-a');const cached=w.document.getElementById('documents');
 const failed=w.selectPatient('synthetic-a');evaluate("requests.shift().reject(Error('Synthetic network failure'))");await assert.rejects(failed);assert.equal(w.document.getElementById('documents'),cached);
 await load('synthetic-b');
 const encounterLink=w.selectPatient('synthetic-a','synthetic-a-visit');
 assert.equal(evaluate('chartSection'),'visits','explicit encounter links override the cached section immediately');
 assert.equal(w.document.getElementById('visits').hidden,false);
 evaluate("answer('synthetic-a')");await encounterLink;
 // Actual Back/Forward restores cached patients before the pending workspace response.
 evaluate("function showChartSection(key){chartSection=key;applyChartSection();}function setEncounterSection(step){encounterSection=step;}function enter(){}");
 evaluate(fs.readFileSync('web/navigation-history.js','utf8'));
 w.showChartSection('overview');w.showChartSection('documents');
 await load('synthetic-b');
 w.history.back();await new Promise(resolve=>setTimeout(resolve,30));await tick();
 assert.equal(evaluate('selected'),'synthetic-a');assert.equal(evaluate('chartSection'),'documents');assert.equal(w.document.getElementById('documents').hidden,false);
 evaluate("answer('synthetic-a')");await tick();await tick();
 w.history.forward();await new Promise(resolve=>setTimeout(resolve,30));await tick();
 assert.equal(evaluate('selected'),'synthetic-b');assert.equal(evaluate('chartSection'),'visits');assert.equal(w.document.getElementById('visits').hidden,false);
 evaluate("answer('synthetic-b')");await tick();await tick();
 w.clearFramePatients();assert.equal(evaluate('patientChartCache.size'),0);
 const history=fs.readFileSync('web/navigation-history.js','utf8');assert(!history.includes("if(!alreadyOpen)await invoke('showClinical')"));
 const css=fs.readFileSync('web/motion.css','utf8');assert.match(css,/--motion-base:160ms/);assert.match(css,/translateY\(8px\)/);assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 console.log('PASS direct tab and chart opening, instant cached section/encounter/scroll, background refresh retention, stable tabs, stale reads, session cleanup and reduced motion');
 dom.window.close();
})().catch(error=>{dom.window.close();console.error(error);process.exitCode=1;});
