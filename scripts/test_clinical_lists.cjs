// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><section id="chart"><section id="appointments-panel"></section></section>',{runScripts:'outside-only',url:'http://localhost/'});
const w=dom.window,context=dom.getInternalVMContext(),evaluate=source=>vm.runInContext(source,context);
const app=fs.readFileSync('web/app.js','utf8'),imports=fs.readFileSync('web/data-import.js','utf8');
evaluate(`const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me={role:'owner',user_id:'synthetic-reviewer',display_name:'Avery Synthetic'},frameClinicalFocus='problem',selected='synthetic-patient',activeVisit=null,workspace={clinical:{items:[],reviews:[],review_history:[]},history:[]};
const pending=[],calls=[];const run=f=>{const task=f();pending.push(task);return task;},notice=()=>{},focusClinicalSection=k=>{frameClinicalFocus=k;},selectPatient=async()=>{},api=async(...args)=>{calls.push(args);return {};};
const sheetOpen=(title,node)=>{const d=document.createElement('dialog');d.innerHTML='<div class="sheet-body"></div>';d.querySelector('div').append(node);document.body.append(d);d.close=()=>d.dispatchEvent(new Event('close'));return d;};`);
evaluate(app.slice(app.indexOf('// Chart list layout helpers.'),app.indexOf('// End chart list layout helpers.')));
evaluate(fs.readFileSync('web/display-format.js','utf8'));
evaluate('const date=displayDate;');
evaluate(imports.slice(imports.indexOf('const importedListKinds='),imports.indexOf('async function importedListAccept(')));
evaluate(fs.readFileSync('web/clinical.js','utf8'));
const panel=()=>w.document.getElementById('clinical-lists');
const render=(kind,items=[],review=null,history=[])=>{
 evaluate('chartCloseSheets()');
 w.fixture={kind,items,review,history};
 evaluate('frameClinicalFocus=fixture.kind;workspace.clinical.items=fixture.items;workspace.clinical.reviews=fixture.review?[{kind:fixture.kind,version:4,...fixture.review}]:[];workspace.history=fixture.history;renderClinical();');
 return panel();
};
const entry=(kind,id,status='active',verification='confirmed')=>({kind,id,version:1,source_history_id:'source-'+id,content:{title:'Synthetic '+id,status,verification,onset_date:'2026-11-24',end_date:'2026-11-25',codes:[{system:'ICD-10',code:'Z00.00',display:'General examination'}],detail:{kind,category:'medication',reaction:'Synthetic rash',severity:'severe',criticality:'high',dose:'10 mg',route:'Oral',frequency:'Daily',problem_type:'problem'},notes:'Synthetic clinical note'}});
const columns={problem:['Problem','ICD-10 code + name','Onset','Status','Resolved','Verification'],allergy:['Allergen','Category','Reaction','Severity / criticality','Status','Verification'],medication:['Medication','Dose / route / frequency','Start','End','Status','Verification']};
(async()=>{
 for(const [kind,title] of [['problem','Problems'],['allergy','Allergies'],['medication','Medications']]){
  let p=render(kind);
  assert.equal(p.querySelector('h2').textContent,title);
  assert.equal(p.querySelector('[data-new-clinical]').textContent,'+ Add '+kind);
  assert.equal(p.querySelector('.chart-list-note').textContent,'Not reviewed yet');
  assert.deepEqual([...p.querySelectorAll('thead th')].map(n=>n.textContent),columns[kind]);
  assert.match(p.textContent,new RegExp('No '+title.toLowerCase()+' recorded\\.'));
  assert.match(p.textContent,/Mark this list reviewed/);assert.match(p.textContent,/Review history/);
  const none=p.querySelector('[data-review-no-known]');assert.equal(none.textContent,kind==='allergy'?'No known allergies':'None known');
  none.click();
  let form=w.document.querySelector('dialog .clinical-review-form');
  assert.equal(form.elements.review_state.value,'no_known');
  form.elements.note.value='Reviewed with synthetic patient';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await Promise.all(evaluate('pending.splice(0)'));
  const call=evaluate('calls.at(-1)');assert.equal(call[0],'/api/v1/patients/synthetic-patient/clinical-review/'+kind);assert.equal(call[2].review_state,'no_known');assert.equal(call[3],1);
  evaluate('chartCloseSheets()');p.querySelector('[data-chart-detail="clinical-review"]').click();
  assert.equal(w.document.querySelector('dialog select').value,'reviewed');
  evaluate('chartCloseSheets()');p.querySelector('[data-new-clinical]').click();
  assert.equal(w.document.querySelector('dialog form').dataset.kind,kind,'Add opens native editor');
  for(const [state,expected] of [['unknown','Not reviewed yet'],['needs_review','Needs review'],['no_known','None known · reviewed Nov 24, 2026 by Jordan Synthetic'],['reviewed','Reviewed Nov 24, 2026 by Jordan Synthetic']]){
   p=render(kind,[],{review_state:state,reviewed_at:'2026-11-24T12:00:00Z',actor_label:'Jordan Synthetic'});
   assert.equal(p.querySelector('.chart-list-note').textContent,expected);
  }
  p=render(kind,[],{review_state:'reviewed',reviewed_at:'2026-11-24T12:00:00Z',reviewed_by:'other-synthetic-reviewer'});
  assert.equal(p.querySelector('.chart-list-note').textContent,'Reviewed Nov 24, 2026');
  p=render(kind,[],{review_state:'no_known',reviewed_at:'2026-11-24T12:00:00Z'});
  assert.equal(p.querySelector('.chart-list-note').textContent,'None known · reviewed Nov 24, 2026');
  p=render(kind,[],{review_state:'reviewed',reviewed_at:'2026-11-24T12:00:00Z',reviewed_by:'synthetic-reviewer'});
  assert.equal(p.querySelector('.chart-list-note').textContent,'Reviewed Nov 24, 2026 by Avery Synthetic');
  const sourceKind=kind==='problem'?'medical_problem':kind;
  p=render(kind,[],null,[{id:'import-synthetic',kind:sourceKind,data:{title:'Imported synthetic '+kind,onset:'2026-11-24'}}]);
  assert.equal(p.querySelector('.imported-list h4').textContent,'From previous system (1) → Review and add to chart');
  assert.match(p.querySelector('.imported-list small').textContent,/Nov 24, 2026/);
  assert(p.querySelector('[data-map-clinical="import-synthetic"]'));assert(p.querySelector('[data-reconcile-all="'+kind+'"]'));
  p=render(kind,[entry(kind,'old',kind==='medication'?'stopped':'resolved'),entry(kind,'current')]);
  assert.equal(p.querySelector(':scope > .chart-list-table tbody button').textContent,'Synthetic current');
  const collapsed=p.querySelector('.clinical-inactive');assert.equal(collapsed.open,false);assert.equal(collapsed.querySelector('summary').textContent,'Inactive (1)');
  assert.equal(collapsed.querySelector('tbody button').textContent,'Synthetic old');
  assert.equal(p.querySelector('tbody .status-badge.active').textContent,'Active');assert.equal(p.querySelector('tbody .status-badge.confirmed').textContent,'Confirmed');
  assert.match(p.querySelector('tbody').textContent,/From previous system/);
  if(kind==='problem')assert.match(p.querySelector('tbody').textContent,/Z00.00 General examination/);
  if(kind==='medication')assert.match(p.querySelector('tbody').textContent,/10 mg · Oral · Daily/);
  if(kind==='allergy'){assert.match(p.querySelector('tbody').textContent,/Medication/);assert.equal(p.querySelector('.clinical-high-risk').textContent,'Severe / High');}
  if(kind!=='allergy'){assert.match(p.querySelector('tbody').textContent,/Nov 24, 2026/);assert.match(p.querySelector('tbody').textContent,/Nov 25, 2026/);}
  assert.doesNotMatch(p.textContent,/2026-11-2[45]/);
  p.querySelector('tbody td:last-child').click();
  assert.equal(w.document.querySelectorAll('dialog').length,1,'row click reuses existing detail sheet');
  assert.equal(w.document.querySelector('dialog form').dataset.id,'current');assert(w.document.querySelector('dialog [data-clinical-history="current"]'));
  assert.match(w.document.querySelector('dialog').textContent,/Nov 24, 2026/);
  p=render(kind,[entry(kind,'only-old','inactive')]);assert.match(p.textContent,/No active .* recorded\./);assert.equal(p.querySelector('.clinical-inactive summary').textContent,'Inactive (1)');
 }
 let p=render('medication',[entry('medication','held','on_hold'),entry('medication','active')]);
 assert.equal(p.querySelector('tbody button').textContent,'Synthetic active','Active entries come first');
 evaluate("workspace.clinical.review_history=[{kind:'problem',review_state:'reviewed',created_at:'2026-11-24T12:00:00Z',actor_label:'Jordan Synthetic',note:'Reviewed with synthetic patient'}];renderClinical()");
 panel().querySelector('[data-chart-detail="clinical-review-history"]').click();
 assert.match(w.document.querySelector('dialog').textContent,/Problems · Reviewed/);assert.match(w.document.querySelector('dialog').textContent,/Nov 24, 2026 · Jordan Synthetic/);assert.match(w.document.querySelector('dialog').textContent,/Reviewed with synthetic patient/);
 p=render('allergy',[entry('allergy','current'),entry('allergy','unconfirmed','active','unconfirmed'),entry('allergy','refuted','active','refuted'),entry('allergy','error','active','entered_in_error'),entry('allergy','inactive','inactive')]);
 const alert=p.querySelector('.allergy-alert');assert.equal(alert.getAttribute('role'),'note');assert.match(alert.textContent,/Current allergies: Synthetic current — Synthetic rash \(confirmed\)/);assert.match(alert.textContent,/Synthetic unconfirmed/);assert.doesNotMatch(alert.textContent,/Synthetic (refuted|error|inactive)/);
 assert.equal(render('problem',[entry('allergy','current')]).querySelector('.allergy-alert'),null);
 assert.equal(render('allergy').querySelector('.allergy-alert'),null);
 evaluate("me.role='front_desk'");p=render('allergy',[entry('allergy','current')]);assert.equal(p.querySelector('[data-new-clinical]'),null);assert(p.querySelector('[data-chart-detail="clinical-review-history"]'));p.querySelector('tbody td:last-child').click();assert(w.document.querySelector('dialog [data-clinical-history]'));assert.equal(w.document.querySelector('dialog [data-edit-clinical]'),null);
 const css=fs.readFileSync('web/style.css','utf8');assert.match(css,/#clinical-lists \.allergy-alert\{[^}]*background:#fde9e7/);assert.match(css,/#clinical-lists \.clinical-high-risk\{[^}]*color:#a4231b/);
 console.log('PASS clinical lists: empty pages, review actions and states, imports, allergy alert, complete columns, formatted dates, collapsed inactive lists and detail sheets');
 dom.window.close();
})().catch(error=>{console.error(error);dom.window.close();process.exitCode=1;});
