// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8'),index=fs.readFileSync('web/index.html','utf8'),css=fs.readFileSync('web/frame.css','utf8');
const extract=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert(a>=0&&b>a);return app.slice(a,b);};
const nodes=new Map();
class Element{
 constructor(id=''){this.children=[];this.dataset={};this.attributes={};this.hidden=false;this.textContent='';this.label={textContent:''};if(id)this.id=id;}
 set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
 append(...items){for(const item of items){if(item.parent)item.parent.children=item.parent.children.filter(n=>n!==item);item.parent=this;this.children.push(item);}}
 prepend(...items){for(const item of items.reverse()){this.append(item);this.children.unshift(this.children.pop());}}
 replaceChildren(...items){this.children=[];this.append(...items);}
 contains(item){return this.children.includes(item)||this.children.some(child=>child.contains?.(item));}
 getAttribute(key){return this.attributes[key];}focus(){this.focused=true;}setAttribute(key,value){this.attributes[key]=value;}removeAttribute(key){delete this.attributes[key];}
 querySelector(selector){return selector==='span'?this.label:selector==='.frame-user-panel'?this.panel:selector==='.theme-control'?theme:null;}
 set innerHTML(value){this.html=value;if(value.includes('class="frame-user-panel"')){this.panel=new Element('frame-user-panel');this.panel.hidden=true;const toggle=new Element('frame-user-toggle');toggle.setAttribute('aria-expanded','false');toggle.closest=selector=>selector==='button'?toggle:null;this.append(toggle,this.panel);}}get innerHTML(){return this.html||'';}
 after(item){this.following=item;}
}
for(const [,id]of index.matchAll(/id="([^"]+)"/g))new Element(id);
const bar=new Element(),actions=new Element(),theme=new Element(),header=new Element(),wordmark=new Element(),account=new Element(),source=new Element();
const selectors={'.shell-topbar':bar,'.shell-topbar-actions':actions,'.workspace-header':header,'.sidebar-brand .wordmark':wordmark,'.sidebar-account':account,'.sidebar-source':source};
const listeners={};
const context=vm.createContext({console,Map,Set,Array,document:{createElement:()=>new Element(),querySelector:selector=>selectors[selector],querySelectorAll:()=>[],addEventListener:(type,handler)=>(listeners[type]??=[]).push(handler)},$:id=>nodes.get(id),esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),selected:null,chartSection:'overview',setPage:Object.assign(()=>{},{last:'Patients & encounters'}),chartAreaEnabled:()=>true,workspaceResourceAllowed:()=>true});
vm.runInContext(extract('function organizeWorkspaceNavigation(){','// Only an opaque'),context);
context.organizeWorkspaceNavigation();
const top=nodes.get('workspace-navigation').children[0];
assert.deepEqual(top.children.map(n=>n.id),['nav-practice','nav-schedule','nav-clinical','frame-billing','nav-admin']);
assert.deepEqual(top.children.map(n=>n.id==='frame-billing'?n.textContent:n.label.textContent),['Home','Schedule','Patients','Billing','Admin']);
assert.equal(bar.children[1],nodes.get('workspace-navigation'));assert.equal(nodes.get('nav-followup').parent,nodes.get('frame-user-menu').panel);assert.equal(nodes.get('nav-portal').parent,nodes.get('frame-user-menu').panel);
assert.deepEqual(nodes.get('frame-billing-tabs').children.map(n=>n.id),['nav-claims','nav-insurance-payments','nav-billing']);
console.log('PASS five top items in order, Billing tabs, user-menu destinations');
vm.runInContext(app.slice(app.indexOf('let framePatients=[];')),context);
assert.match(nodes.get('frame-user-menu').innerHTML,/<button[^>]*aria-haspopup="true"[^>]*aria-expanded="false"/);
const toggle=nodes.get('frame-user-toggle'),panel=nodes.get('frame-user-panel');
const click=target=>listeners.click.forEach(fn=>fn({target}));
click(toggle);assert.equal(toggle.getAttribute('aria-expanded'),'true');assert.equal(panel.hidden,false);
listeners.keydown.forEach(fn=>fn({key:'Escape'}));assert.equal(panel.hidden,true);assert.equal(toggle.focused,true);
click(toggle);click({closest:()=>null});assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(panel.hidden,true);
click(toggle);click(toggle);assert.equal(panel.hidden,true);
assert.equal(nodes.get('frame-build-context').parent,panel,'the running build and environment belong in the account menu');
assert.match(index,/class="frame-build-version">Build __SUN_CHARTS_BUILD__<\/span>/);
assert.equal(nodes.get('frame-support').parent,panel);assert.equal(nodes.get('logout').textContent,'Sign out');assert.equal(theme.parent,panel);
assert.match(css,/@media\(max-width:1199px\)/);assert.match(css,/frame-user-panel\[hidden\]\{display:none\}/);
console.log('PASS accessible user button, toggle, Escape, outside click, Support, Appearance and Sign out');
context.showClinical=async()=>{context.selected=null;context.setPage.last='Patients & encounters';nodes.get('clinical-workspace').hidden=false;};
context.selectPatient=async id=>{context.selected=id;context.frameOpenPatient({id,given_name:'Avery',family_name:'Synthetic'});};
(async()=>{
 for(let i=0;i<6;i++)await context.selectPatient('synthetic-'+i);
 const ids=()=>[...nodes.get('frame-patient-tabs').innerHTML.matchAll(/data-frame-patient="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(ids(),['synthetic-1','synthetic-2','synthetic-3','synthetic-4','synthetic-5']);
 await context.selectPatient('synthetic-2');assert.deepEqual(ids(),['synthetic-1','synthetic-2','synthetic-3','synthetic-4','synthetic-5']);
 assert.match(nodes.get('frame-patient-tabs').innerHTML,/data-frame-patient="synthetic-2" aria-current="page"/);
 assert.match(nodes.get('frame-patient-tabs').innerHTML,/title="Synthetic, Avery"/);
 for(const title of ['Practice overview','Schedule','Billing & insurance','Practice administration']){context.setPage.last=title;nodes.get('clinical-workspace').hidden=true;context.framePage(title);assert.doesNotMatch(nodes.get('frame-patient-tabs').innerHTML,/frame-patient-tab active/);}
 context.setPage.last='Patients & encounters';nodes.get('clinical-workspace').hidden=false;context.frameRenderPatients();assert.match(nodes.get('frame-patient-tabs').innerHTML,/frame-patient-tab active/);
 context.selected=null;context.frameRenderPatients();assert.doesNotMatch(nodes.get('frame-patient-tabs').innerHTML,/frame-patient-tab active/);context.selected='synthetic-2';
 assert.match(css,/max-width:220px/);assert.match(css,/\.frame-patient-name\{[^}]*text-overflow:ellipsis/);
 await context.frameClosePatient('synthetic-2');assert.equal(context.selected,'synthetic-5');assert(!ids().includes('synthetic-2'));
 await context.frameClosePatient('synthetic-1');assert.equal(context.selected,'synthetic-5');
 context.clearFramePatients();assert.deepEqual(ids(),[]);
 console.log('PASS patient tabs open, focus, cap at five, close and clear on sign-out');
 const billing=fs.readFileSync('web/billing.js','utf8');context.billingQueueStatus='';
 vm.runInContext(billing.slice(billing.indexOf('async function showBillingQueue('),billing.indexOf('function payerEditor(')),context);
 let openedClaims=false;context.run=fn=>{context.pendingNavigation=fn();};
 context.showTool=title=>{context.setPage.last=title;nodes.get('clinical-workspace').hidden=true;context.framePage(title);};
 nodes.get('nav-claims').click=()=>{openedClaims=true;context.showTool('Claims & remittances');};
 await context.selectPatient('synthetic-billing');
 click({closest:selector=>selector==='button'?{id:'frame-billing',dataset:{},closest:()=>null}:null});
 assert.equal(openedClaims,true);
 assert.match(nodes.get('frame-patient-tabs').innerHTML,/data-frame-patient="synthetic-billing"/);assert.doesNotMatch(nodes.get('frame-patient-tabs').innerHTML,/frame-patient-tab active/);context.clearFramePatients();
 console.log('PASS top-bar Billing opens practice Claims and deactivates the open chart');
 vm.runInContext(extract('function openPatientEncounterList(){','function showChartSection('),context);
 const keys=['overview','profile','clinical','visits','orders','referrals','prescribing','immunizations','history','insurance','billing','documents','source','care_pathways'];
 const html=context.chartNavigation(keys.map(key=>[key,key]));
 assert.deepEqual([...html.matchAll(/data-chart-section="([^"]+)"/g)].map(m=>m[1]),['orders','prescribing','referrals','overview','profile','vitals','insurance','billing','visits','documents','immunizations','history','source','care_pathways']);
 assert.deepEqual([...html.matchAll(/data-clinical-focus="([^"]+)"/g)].map(m=>m[1]),['problem','allergy','medication']);
 assert.doesNotMatch(html,/Problems, allergies &amp; medications/);
 assert.match(html,/title="Problems" aria-label="Problems"/);
 assert.deepEqual([...html.matchAll(/class="frame-chart-group-label">([^<]+)/g)].map(m=>m[1]),['Care tools','Patient chart','Billing','History &amp; records']);
 context.workspaceResourceAllowed=resource=>resource!=='billing';const restricted=context.chartNavigation(keys.map(key=>[key,key]));assert.doesNotMatch(restricted,/data-chart-section="(insurance|billing)"/);
 assert.match(css,/@media\(max-width:900px\)/);assert.match(css,/@media\(max-width:600px\)/);assert.match(css,/\.frame-chart-items\{display:none\}/);
 console.log('PASS chart panel groups, section order, permission checks and responsive modes');
 // Clinical destinations replace the list and align the shared content, without scrolling a subsection.
 const scrolled=[],rendered=[];context.showChartSection=key=>{context.chartSection=key;};context.applyChartSection=()=>{};context.alignChartContent=()=>scrolled.push('content');context.renderClinical=()=>rendered.push(context.chartSection);
 new Element('clinical-lists');
 for(const kind of ['problem','allergy','medication'])context.focusClinicalSection(kind);
 assert.equal(scrolled.length,3);assert(rendered.every(key=>key==='clinical'));
 context.showChartSection=()=>{};context.chartSection='overview';context.focusClinicalSection('problem');assert.equal(scrolled.length,3,'denied navigation never scrolls');
 assert.match(css,/white-space:normal;overflow-wrap:anywhere/);
 assert.match(css,/shell-topbar\{[^}]*flex-wrap:nowrap[^}]*height:auto/);
 assert.match(css,/#workspace-navigation\{[^}]*flex-wrap:nowrap/);
 assert.match(css,/frame-primary\{[^}]*flex:none;flex-wrap:nowrap/);
 assert.match(css,/frame-patient-tabs\{[^}]*flex-wrap:nowrap[^}]*min-width:0[^}]*overflow-x:auto/);
 assert.match(css,/frame-patient-tab\{[^}]*flex:1 0 140px;min-width:140px;max-width:220px/);
 assert.match(css,/@media\(max-width:899px\)\{\s*#app \.shell-topbar\{flex-wrap:wrap\}/,'wrapping only below 900px');
 assert.match(css,/#app \.frame-chart-open #chart\{[^}]*display:flow-root/,'chart contains the full floated panel height');
 assert.match(css,/#chart>\.chart-context\{position:sticky;[^}]*overflow-y:auto;[^}]*float:left;margin-left:-220px;width:204px/);
 assert.doesNotMatch(css,/#chart>\.chart-context\{[^}]*position:absolute/);
 console.log('PASS single-row desktop tabs, bounded scrolling strip and chart panel height containment');
 assert.match(css,/#app>main\{[^}]*padding:0 20px 176px/);
 const historyCalls=[],encounterList=new Element('patient-encounter-history');encounterList.scrollIntoView=()=>historyCalls.push('scrolled');
 context.showChartSection=key=>{context.chartSection=key;};context.invoiceTabSet=(key,remember)=>historyCalls.push([key,remember]);
 context.openPatientEncounterList();assert.equal(encounterList.open,undefined);assert.equal(context.chartSection,'encounters');assert.deepEqual(historyCalls,[]);
 assert.match(html,/data-chart-section="visits" data-encounter-history/);
 context.me={role:'owner',user_id:'synthetic-clinician'};context.workspace={appointments:[],visits:[],patient:{},clinical:{items:[]}};context.encounterDateLabel=()=> 'Synthetic encounter';context.canStartEncounterFlow=()=>true;
 context.activeVisit={id:'synthetic-encounter',status:'in_progress'};
 const next=new Element('patient-next-action'),bar=new Element('encounter-bar');bar.dataset.visitId='synthetic-encounter';
 const step={outerHTML:'<div class="visit-billing-status"><div><span class="eyebrow">Next step</span><p>Check the charges</p></div><button data-encounter-charges>Check the charges</button></div>'};
 bar.querySelector=selector=>selector==='.visit-billing-status'?step:null;
 context.chartSection='overview';context.syncPatientNextAction();
 assert.equal(next.hidden,false);assert.equal(bar.hidden,true,'encounter bar does not duplicate the Summary box');
 assert.match(next.innerHTML,/Next step/);assert.match(next.innerHTML,/data-encounter-charges/);assert.match(next.innerHTML,/Continue encounter/);
 assert.doesNotMatch(next.innerHTML,/Before the encounter|Start encounter|Current encounter/);
 assert.equal((context.patientWorkflowActions().match(/id="patient-next-action"/g)||[]).length,1);
 bar.dataset.visitId='another-encounter';context.syncPatientNextAction();
 assert.match(next.innerHTML,/Current encounter/);assert.doesNotMatch(next.innerHTML,/Check the charges|Before the encounter/,'stale bar cannot supply another encounter’s step');
 bar.dataset.visitId='synthetic-encounter';bar.hidden=true;context.syncPatientNextAction();assert.match(next.innerHTML,/Check the charges/,'Summary reads its matching step even while the encounter page is hidden');
 context.chartSection='visits';context.syncPatientNextAction();assert.equal(next.hidden,true);assert.equal(bar.hidden,false);
 context.chartSection='clinical';context.syncPatientNextAction();assert.equal(next.hidden,true);assert.equal(bar.hidden,true);
 context.chartSection='overview';context.workspace.visits=[context.activeVisit];context.activeVisit=null;context.syncPatientNextAction();
 assert.match(next.innerHTML,/data-visit="synthetic-encounter">Continue encounter/);assert.doesNotMatch(next.innerHTML,/Before the encounter/,'an open encounter in the chart is not pre-encounter');
 context.workspace.visits=[];context.syncPatientNextAction();
 assert.equal(next.hidden,false);assert.equal(bar.hidden,true);assert.match(next.innerHTML,/Before the encounter/);assert.match(next.innerHTML,/Insurance & copay/);assert.match(next.innerHTML,/Start encounter/);assert.doesNotMatch(next.innerHTML,/Check the charges|Continue encounter/);
 context.activeVisit={id:'synthetic-encounter',status:'in_progress'};context.chartSection='visits';context.inRecordArea=()=>false;
 console.log('PASS Summary encounter next step and Continue, stale/loading fallback, and no-open-encounter preparation');
 vm.runInContext(extract('function encounterWorkflow(){','function encounterSections()'),context);
 const encounter=context.encounterWorkflow();
 assert.doesNotMatch(encounter,/Switch encounter|New encounter|Get help with this encounter/);
 assert.match(encounter,/<details class="frame-add-menu" data-menu><summary>Add ▾<\/summary>/);
 for(const attr of ['data-encounter-step="prescription"','data-encounter-step="new-order"','data-chart-section="referrals"','data-encounter-section="files"'])assert(encounter.includes(attr),attr);
 context.chartAreaEnabled=()=>false;assert.equal(context.encounterAddMenu(),'','no empty Add menu when all destinations are hidden');context.chartAreaEnabled=()=>true;
 assert.match(nodes.get('frame-user-menu').innerHTML,/data-support-help>Help<\/button>/);
 const scheduling=fs.readFileSync('web/scheduling.js','utf8');
 context.chartListHeader=(title,primary='',more='')=>'<h2>'+title+'</h2>'+primary+more;context.chartListTable=()=>'';context.scheduleProviders=[];context.patientEncounterHistoryEntries=()=>[];context.patientEncounterHistoryRows=()=>'';context.canSchedule=()=>false;
 vm.runInContext(scheduling.slice(scheduling.indexOf('function patientAppointmentWorkspace(){'),scheduling.indexOf('async function openPatientAppointmentEditor(')),context);
 assert.match(context.patientAppointmentWorkspace(),/data-start-encounter-flow="new">\+ New encounter/);
 context.canStartEncounterFlow=()=>false;assert.doesNotMatch(context.patientAppointmentWorkspace(),/data-start-encounter-flow/);
 console.log('PASS clinical section replacement, full tab tooltip, summary deduplication and encounter Add menu / relocated actions');
 const revenue=fs.readFileSync('web/patient-revenue.js','utf8'),listeners=[],opened=[];
 const routeStart=revenue.indexOf('// A button whose work lands in another area'),routeEnd=revenue.indexOf(" document.addEventListener('keydown'",routeStart);
 vm.runInNewContext(revenue.slice(routeStart,routeEnd),{document:{addEventListener:(type,fn)=>listeners.push(fn)},setTimeout:fn=>fn(),encounterCodesEditorOpen:()=>opened.push('codes'),billingPartSet:part=>opened.push(part)});
 const summaryButton={dataset:{},closest:selector=>selector.split(',').includes('#patient-next-action'),hasAttribute:attr=>attr==='data-encounter-charges'};
 listeners[0]({target:{closest:()=>summaryButton}});assert.deepEqual(opened,['codes'],'Summary charges action uses the same visible editor routing as the encounter bar');
 console.log('PASS Summary charges button routes to the visible editor');
 const history=fs.readFileSync('web/navigation-history.js','utf8');vm.runInContext(history.slice(history.indexOf(' const navSlugs='),history.indexOf(' function state(')),context);
 for(const slug of ['home','schedule','patients','claims','billing','practice','work-queue','inbox','orders','referrals','integrations','data-import','claim-connections'])assert(context.routeFromAddress('#/'+slug),slug);
 const id='11111111-1111-4111-8111-111111111111';
 for(const section of ['overview','encounter','insurance','billing','files','orders','record','clinical','care-pathways','prescriptions','referrals','encounters','vitals','immunizations','surgical-dental-history','imported-records'])assert.equal(context.routeFromAddress(`#/patients/${id}/${section}`).patient,id);
 console.log('PASS practice and chart hash routes still resolve');
 const backSource=history.slice(history.indexOf(' function backControl()'),history.indexOf(' function replace(value)'));
 const backContext=vm.createContext({$:id=>nodes.get(id),current:null,restoring:false});vm.runInContext(backSource,backContext);
 for(const route of [{view:'tool'},{view:'screen'},{view:'patient',patient:null},{view:'patientBilling',billing:{patient:null}}]){backContext.current={index:3,route};backContext.backControl();assert.equal(nodes.get('workspace-back').hidden,true);}
 backContext.current={index:3,route:{view:'detail'}};backContext.backControl();assert.equal(nodes.get('workspace-back').hidden,false);
 assert.match(css,/#chart \.patient-banner-visit \.patient-banner-text\{white-space:normal;overflow:visible/);

 const bannerTest=fs.readFileSync('scripts/test_patient_banner_ui.cjs','utf8');const bannerContext=vm.createContext({require,process,console,setImmediate});
 vm.runInContext(bannerTest.slice(0,bannerTest.indexOf('(async()=>{')),bannerContext);
 const healthy=await vm.runInContext(`(async()=>{const f=fixture();f.c.workspace.clinical.reviews=[{kind:'allergy',review_state:'no_known'}];f.c.workspace.demographics.content.administrative_gender='female';f.c.workspace.billing.coverages=[coverage('cov-a','primary','payer-a')];f.c.answer.eligibility=[check('cov-a','completed','1')];return f.open();})()`,bannerContext);
 const visibleHeader=healthy.slice(0,healthy.indexOf('<details class="patient-banner-more"'));
 assert.match(visibleHeader,/MRN SYN-1001/);assert.match(visibleHeader,/1990 \(36\)/);assert.match(visibleHeader,/>Female</);assert.match(visibleHeader,/Synthetic Health Plan/);assert.match(healthy,/patient-banner-bottom/);assert.match(healthy,/No known allergies/);
 assert.match(healthy,/patient-banner-pill/);assert.match(css,/#chart \.patient-banner-top\{flex-wrap:wrap\}/);
 assert.match(revenue,/function invoiceTabsMarkup\(\)\{return '';\}/);
 // Details is nested in More: opening it must keep its containing menu open.
 vm.runInContext(`{const f=fixture({now:NOW});const details={dataset:{bannerPop:'details'},open:true,contains:()=>false};const more={dataset:{bannerPop:'more'},open:true,contains:node=>node===details};f.host.querySelectorAll=()=>[more,details];f.listeners.toggle[0]({target:details});assert.equal(more.open,true);assert.match(f.markup(),/patient-banner-more[^>]* open/);}`,bannerContext);
 // The encounter page owns its timeline and primary next step.
 vm.runInContext(`{const f=fixture();f.c.activeVisit={id:'synthetic-encounter',status:'in_progress'};f.c.chartSection='visits';assert.match(f.c.patientBannerPrimary(),/New encounter/);f.c.chartSection='overview';assert.match(f.c.patientBannerPrimary(),/New encounter/);}`,bannerContext);
 assert.match(css,/#chart:not\(\.frame-encounter-open\) \.patient-banner-timeline\{display:none\}/);
 assert.match(revenue,/class="\$\{any\?'text-button':'secondary'\}" data-codes-strip-edit/);
 console.log('PASS two-line patient header with visible status chips and encounter steps');
})().catch(error=>{console.error(error);process.exitCode=1;});
