// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const scheduling=fs.readFileSync('web/scheduling.js','utf8'),app=fs.readFileSync('web/app.js','utf8');
function fixture(){
 const dom=new JSDOM('<main id="chart"></main>',{runScripts:'outside-only'}),w=dom.window;
 w.eval(app.slice(app.indexOf('const $'),app.indexOf('function chartOpenEditor'))+';window.$=$;window.esc=esc;');
 w.me={role:'owner',user_id:'staff',display_name:'Synthetic Clinician'};w.selected='synthetic-patient';
 w.localTime=s=>s;w.date=s=>s;w.money=n=>'$'+(n/100).toFixed(2);
 w.displayStatus=s=>({booked:'Booked',checked_in:'Checked in',completed:'Completed',in_progress:'In progress'})[s]||s;
 w.encounterNumberText=v=>v.number;w.canStartEncounterFlow=()=>true;
 w.workspace={appointments:[
  {id:'future',starts_at:'2099-11-24T12:00:00Z',status:'booked',title:'Future synthetic appointment'},
  {id:'old',starts_at:'2020-01-01T12:00:00Z',status:'checked_in',title:'Older unsigned'},
  {id:'new',starts_at:'2026-11-24T12:00:00Z',status:'completed',title:'Recent signed',category:'Follow-up',facility:'Synthetic clinic',room:'2'},
  {id:'missing',starts_at:'2025-11-24T12:00:00Z',status:'completed',title:'Missing note'}
 ],visits:[{id:'old-v',appointment_id:'old',clinician_id:'staff',status:'in_progress',number:'ENC-0007'},
 {id:'new-v',appointment_id:'new',status:'signed',signed_by:'signer',number:'ENC-2'}],billing:{accounts:[{id:'account',status:'posted',total_cents:12500,content:{visit_id:'new-v',claim_details:{rendering_provider_name:'Synthetic Provider'},lines:[{code:'99213',modifiers:'25',diagnosis_codes:['Z00.00']}]}}]}};
 w.activeVisit=w.workspace.visits[0];let requests=0;
 w.api=async()=>{requests++;return {items:[{account_id:'account',posted:true,total_cents:12500,patient_payments_cents:2500,owes_now_cents:10000,claim_status:null}]};};
 w.loadVisitNotePeople=async()=>{};w.visitNotePerson=()=> 'Synthetic Signer';
 w.eval(scheduling.slice(scheduling.indexOf('function patientEncounterHistoryEntries()'),scheduling.indexOf('async function openPatientAppointmentEditor'))+';window.setClaim=status=>{encounterBalanceCache.items[0].claim_status=status;};');
 // Scheduling permissions normally live above the isolated history helpers.
 w.canSchedule=()=>true;w.scheduleProviders=[];w.scheduleLabel=w.displayStatus;
 const mount=()=>{w.$('chart').innerHTML=w.patientAppointmentWorkspace();};
 return {w,dom,mount,requests:()=>requests};
}
(async()=>{
 const f=fixture(),{w}=f;f.mount();await w.fillChartEncounterClaims();
 assert.doesNotMatch(w.$('appointments-panel').textContent,/Claim status unavailable|Patient balance not available|Assigned clinician/);
 const panel=w.$('appointments-panel'),groups=panel.querySelectorAll('[data-encounter-group]');
 assert.equal(groups.length,2);assert.equal(groups[0].querySelector('h3').textContent,'Upcoming');
 const rows=[...panel.querySelectorAll('[data-encounter-row]')];
 assert.match(rows[0].textContent,/Future synthetic/);
 assert.match(rows[1].textContent,/Recent signed/);assert.match(rows[2].textContent,/Missing note/);assert.match(rows[3].textContent,/Older unsigned/);
 assert.match(rows[1].textContent,/Nov 24, 2026/);assert.doesNotMatch(panel.textContent,/2026-11-24|\bsigned\b/);
 assert.match(rows[1].textContent,/ENC-2.*Follow-up.*Synthetic clinic.*Room 2.*Signed by Synthetic Signer.*Synthetic Provider.*Z00.00.*99213-25/);
 assert.match(rows[1].textContent,/Patient paid \$25.00.*Patient owes \$100.00/);
 assert.equal(rows[1].querySelector('[data-chart-encounter-claim] .pill').textContent,'Not sent');
 assert(rows[1].querySelector('[data-encounter-signer]').classList.contains('muted'));
 for(const row of rows){assert.equal(row.cells[2].querySelectorAll('.pill').length,1);assert.equal(row.cells[0].style.whiteSpace,'nowrap');}
 assert.equal(rows[2].cells[4].textContent,'—');assert.equal(rows[2].cells[6].textContent,'Not sent');
 assert.equal((rows[3].cells[2].textContent.match(/In progress/g)||[]).length,1);
 assert.match(rows[2].textContent,/Note not started/);
 assert.match(rows[3].textContent,/Selected encounter.*In progress.*No charges yet/);
 assert.equal(rows[3].querySelector('[data-visit]').textContent,'Continue');assert.match(rows[3].cells[3].textContent,/Synthetic Clinician/);assert.doesNotMatch(panel.textContent,/\bYou\b/);
 assert.equal(rows[1].querySelector('[data-visit]').textContent,'Open');
 assert(rows[0].querySelector('[data-check-in="future"]'));
 assert.equal(panel.querySelector('[aria-label="Encounter count"]').textContent,'4');assert.equal(f.requests(),1);
 assert.equal(panel.querySelector('select'),null);
 assert(panel.querySelector('.encounter-list-heading [aria-label="Encounter count"]'));
 assert.equal(panel.querySelectorAll('.encounter-filter-chips button').length,4);
 const select=value=>{panel.querySelector(`[data-encounter-filter="${value}"]`).click();return rows.filter(r=>!r.hidden);};
 assert.match(rows[1].querySelector('.encounter-date').textContent,/^Nov 24, 2026 · \d{1,2}:\d{2} [AP]M$/);
 const charge=rows[1].querySelector('.encounter-charge-summary');
 assert.equal(charge.textContent,'$125.00Patient owes $100.00');
 assert.doesNotMatch(charge.textContent,/99213|Z00.00/);
 assert.match(rows[1].querySelector('details').textContent,/99213-25/);
 assert.equal(rows[1].cells.length,8);
 assert.deepEqual(select('unsigned'),[rows[3]]);assert.deepEqual(select('open'),[rows[0],rows[3]]);assert.deepEqual(select('claims'),[rows[1]]);assert.equal(select('all').length,4);
 // Refresh hydrated claims and preserve the active filter.
 w.setClaim('accepted');select('claims');await w.fillChartEncounterClaims();
 assert.equal(rows[1].querySelector('[data-chart-encounter-claim]').textContent,'Claim accepted by the payer');assert(rows.every(r=>r.hidden));
 assert.equal(groups[1].querySelector('[data-encounter-empty]').hidden,false);
 w.workspace={appointments:[],visits:[],billing:{accounts:[]}};w.activeVisit=null;f.mount();
 assert.equal(w.$('appointments-panel').querySelectorAll('th').length,8);
 assert(w.$('appointments-panel').querySelector('[data-start-encounter-flow]'));assert.match(w.$('appointments-panel').textContent,/No encounters recorded\./);
 f.dom.window.close();
 // Names resolve from provider user ids, loaded staff and the current user; unknown ids stay blank.
 const names=fixture();names.w.scheduleProviders=[{id:'provider-record',user_id:'provider-user',display_name:'Synthetic Directory Clinician'}];
 names.w.practiceAdminState={staff:{items:[{id:'practice-staff',display_name:'Synthetic Staff Clinician'}]}};
 for(const [id,expected] of [['provider-user','Synthetic Directory Clinician'],['practice-staff','Synthetic Staff Clinician'],['staff','Synthetic Clinician'],['unknown','—']]){
  names.w.workspace.appointments[1].clinician_id=id;names.mount();
  assert.equal(names.w.$('appointments-panel').querySelector('[data-visit="old-v"]').closest('tr').cells[3].textContent,expected);
 }
 assert.equal(names.w.encounterListCharges({total_cents:12500},null),'$125.00');
 assert.match(names.w.encounterListClaim({claim_status:'ready'},true),/Claim ready to send/);
 assert.match(names.w.$('appointments-panel').textContent,/ENC-0007/);names.dom.window.close();
 // Identical title and category appear once.
 const duplicate=fixture();duplicate.w.workspace.appointments[1].title='Office visit';duplicate.w.workspace.appointments[1].category='Office visit';duplicate.mount();
 assert.equal((duplicate.w.$('appointments-panel').querySelector('[data-visit="old-v"]').closest('tr').cells[2].textContent.match(/Office visit/g)||[]).length,1);duplicate.dom.window.close();
 // Signer names also hydrate when there are no billing accounts.
 const noCharges=fixture();noCharges.w.workspace.billing.accounts=[];noCharges.w.visitNotePerson=()=>'';noCharges.w.loadVisitNotePeople=async()=>{noCharges.w.visitNotePerson=()=> 'Synthetic Signer';};noCharges.mount();await noCharges.w.fillChartEncounterClaims();
 assert.match(noCharges.w.$('appointments-panel').textContent,/Signed by Synthetic Signer/);assert.equal(noCharges.requests(),0);noCharges.dom.window.close();
 const providers=fixture();providers.w.workspace.appointments[1].clinician_id='unloaded-staff';
 providers.w.workspace.visits[0].clinician_id='unloaded-staff';
 providers.w.visitNotePerson=(visit,id)=>id==='unloaded-staff'?'Synthetic Assigned Clinician':'Synthetic Signer';
 providers.mount();await providers.w.fillChartEncounterClaims();
 assert.match(providers.w.$('appointments-panel').querySelector('[data-encounter-visit="old-v"]').textContent,/Synthetic Assigned Clinician/);
 providers.dom.window.close();
 // Appointment details work on a cold chart with no schedule board mounted.
 const booking=fixture(),b=booking.w;
 b.chartSection='encounters';b.workspace.patient={id:b.selected,given_name:'Synthetic',family_name:'Patient'};
 b.api=async path=>path.endsWith('/history')?{items:[]}:path.endsWith('/demographics')?{content:{}}:{...b.workspace.appointments[0],patient_id:b.selected};
 b.chartOpenEditor=id=>{const panel=b.$(id),sheet=b.document.createElement('dialog');sheet.append(panel);b.document.body.append(sheet);};
 b.schedulePanelHtml=appointment=>`<h2>${appointment.title}</h2><button data-schedule-edit="${appointment.id}">Edit appointment</button>`;
 b.loadSchedulePanelAllergies=()=>{};b.schedulePatients=[];
 const first=scheduling.indexOf('let scheduleFocus;'),last=scheduling.indexOf('async function loadSchedulePatients()',first);
 require('node:vm').runInContext('let scheduleState,scheduleSelected;'+scheduling.slice(first,last),booking.dom.getInternalVMContext());
 await b.appointmentDetail('future',b.selected);
 assert(b.document.querySelector('dialog [data-schedule-edit="future"]'));
 booking.dom.window.close();
 // A delayed response must not fill a different chart's money or claims.
 const stale=fixture();let resolve;stale.w.api=()=>new Promise(r=>{resolve=r;});stale.mount();
 const pending=stale.w.fillChartEncounterClaims();stale.w.selected='different-synthetic-patient';resolve({items:[{account_id:'account',posted:true,total_cents:1,claim_status:'paid'}]});await pending;
 assert.doesNotMatch(stale.w.$('appointments-panel').textContent,/Insurance paid/);stale.dom.window.close();
 // Exercise the actual copay workflow and parent visibility rules for both chart pages.
 const d=new JSDOM('<main id="chart"><div id="visit-page-host"><div id="encounter-progress"></div></div><div id="appointments-panel"></div></main>',{runScripts:'outside-only'}),v=d.window;
 v.$=id=>v.document.getElementById(id);v.activeVisit=null;v.workspace={appointments:[],patient:{}};
 v.workspaceResourceAllowed=()=>true;v.chartAreaEnabled=()=>true;v.appointmentCopayCard=()=>'<section id="synthetic-copay">Copay</section>';
 v.syncPatientNextAction=()=>{};v.patientSectionVisible=()=>false;v.inRecordArea=()=>false;v.encounterSections=()=>[['visit','Overview']];v.encounterShows=()=>false;
 v.eval(app.slice(app.indexOf('function encounterWorkflow()'),app.indexOf('// The encounter is one scrolling page')));
 v.eval(app.slice(app.indexOf('function chartNavigationEncounter()'),app.indexOf('function patientWorkflowActions()')));
 v.refreshEncounterProgress=()=>{v.$('encounter-progress').innerHTML=v.encounterWorkflow();};
 v.eval(app.slice(app.indexOf('function applyChartSection()'),app.indexOf('function applyChartSection()')+app.slice(app.indexOf('function applyChartSection()')).indexOf('\nfunction ')));
 for(const section of ['encounters','visits','overview']){
  v.chartSection=section;v.applyChartSection();
  assert.equal(v.$('visit-page-host').hidden,section==='overview');assert.equal(v.$('encounter-progress').hidden,section==='overview');
  if(section!=='overview')assert(v.$('synthetic-copay'));
 }
 d.window.close();
 console.log('Encounter list tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

const css=fs.readFileSync('web/frame.css','utf8');
assert.match(css,/#appointments-panel \.encounter-date\{[^}]*white-space:nowrap;min-width:190px/);

assert.match(css,/#appointments-panel \.encounter-number\{[^}]*white-space:nowrap;min-width:110px;[^}]*word-break:normal/);
