// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');

const app=fs.readFileSync('web/app.js','utf8');
const visitNote=fs.readFileSync('web/visit-note.js','utf8');
function extract(source,start,end){
 const first=source.indexOf(start),last=source.indexOf(end,first);
 assert(first>=0&&last>first);
 return source.slice(first,last);
}
function fixture({role='front_desk',status='in_progress',edit=true,vitals={}}={}){
 const dom=new JSDOM('<main><details open data-rooming-panel="vitals"><summary>Vitals</summary></details><p id="note-save-status"></p></main>',{runScripts:'outside-only'});
 const w=dom.window,doc=w.document,writes=[];
 w.$=id=>doc.getElementById(id);
 w.esc=String;
 w.selected='synthetic-patient';
 w.me={role,user_id:'synthetic-clinician'};
 w.activeVisit={id:'synthetic-visit',status,version:1,vitals};
 w.clinicalAccess=action=>action==='edit'&&edit;
 w.formData=form=>Object.fromEntries(new w.FormData(form));
 w.api=async(path,method,values,version)=>{
  writes.push({path,method,values,version});
  return {...w.activeVisit,vitals:values,version:version+1};
 };
 w.rememberVisit=visit=>{w.activeVisit=visit;w.$('vitals-form').dataset.version=String(visit.version);};
 w.eval(extract(app,'function isRoomingStaff()','// A signed note reads as a record:'));
 w.eval(extract(app,'function canRecordVisitVitals(v)','function renderVisit('));
 doc.querySelector('details').insertAdjacentHTML('beforeend',w.visitVitalsBlockMarkup(w.activeVisit,null,!w.canRecordVisitVitals(w.activeVisit)));
 w.eval(extract(visitNote,'// Serialize the three encounter saves:','function visitNoteInlineDiagnosesMarkup('));
 const field=name=>w.$('vitals-form').elements.namedItem(name);
 const hint=name=>doc.querySelector(`[data-vital-issue="${name}"]`);
 const type=(name,value)=>{
  const input=field(name);input.focus();input.value=value;
  input.dispatchEvent(new w.Event('input',{bubbles:true}));
 };
 const invalid=()=>[...doc.querySelectorAll('#vitals-form [aria-invalid="true"]')].map(input=>input.name);
 return {w,doc,dom,writes,field,hint,type,invalid};
}
const systolic='systolic_mm_hg',diastolic='diastolic_mm_hg',oxygen='oxygen_saturation_pct';

(async()=>{
 const f=fixture(),{w,doc,field,hint,type,invalid,writes}=f;
 try{
  const save=()=>w.visitNoteFlush({focusVitals:true});
  assert.deepEqual(invalid(),[]);
  assert([...doc.querySelectorAll('[data-vital-issue]')].every(issue=>issue.hidden));
  await save();assert.equal(writes.length,0,'optional blank vitals are quiet');
  type(systolic,'120');
  assert.equal(doc.activeElement,field(systolic),'typing does not move focus');
  assert.deepEqual(invalid(),[diastolic]);
  assert.match(hint(diastolic).textContent,/diastolic blood pressure/);
  assert.equal(field(diastolic).getAttribute('aria-describedby'),hint(diastolic).id);
  await w.visitNoteFlush();assert.equal(doc.activeElement,field(systolic),'autosave does not move focus');
  await assert.rejects(save,/Enter diastolic blood pressure/);
  assert.equal(doc.activeElement,field(diastolic));
  assert.equal(writes.length,0,'a half-reading has no server write');
  type(systolic,'');assert.deepEqual(invalid(),[]);
  assert.equal(hint(diastolic).hidden,true);
  type(diastolic,'80');
  assert.deepEqual(invalid(),[systolic]);
  await assert.rejects(()=>w.visitNoteFlush({signing:true}),/Enter systolic blood pressure/);
  assert.equal(doc.activeElement,field(systolic));
  type(systolic,'120');
  assert.deepEqual(invalid(),[]);
  await save();
  assert.equal(JSON.stringify(writes[0].values),'{"systolic_mm_hg":120,"diastolic_mm_hg":80}');
  type(oxygen,'101');await assert.rejects(save,/outside supported recording ranges/i);
  assert.deepEqual(invalid(),[oxygen]);
  assert.equal(doc.activeElement,field(oxygen));
  assert.equal(writes.length,1);
  type(oxygen,'');
  type('temperature_c','98.6');await save();
  assert.equal(writes[1].values.temperature_c,37,'US entry is converted to metric');
 }finally{f.dom.window.close();}

 const compact=fixture({vitals:{heart_rate_bpm:72}});
 try{
  assert(compact.doc.querySelector('[data-action="edit-vitals"]'));
  assert.equal(compact.w.$('vitals-form'),null);
  compact.w.openVitalsForm();
  assert.equal(compact.field('heart_rate_bpm').value,'72');
  assert.equal(compact.doc.activeElement,compact.field(systolic));
 }finally{compact.dom.window.close();}

 for(const options of [{role:'read_only'},{edit:false},{status:'signed'}]){
  const locked=fixture(options);
  try{
   assert.equal(locked.w.canRecordVisitVitals(locked.w.activeVisit),false);
   assert(locked.field(systolic).disabled);
   locked.type(systolic,'120');
   await locked.w.visitNoteFlush({focusVitals:true});
   assert.deepEqual(locked.invalid(),[]);
   assert.equal(locked.writes.length,0);
  }finally{locked.dom.window.close();}
 }
 console.log('PASS optional vitals, paired blood pressure feedback, keyboard focus, existing range validation, units and permissions');
})().catch(error=>{console.error(error);process.exitCode=1;});
