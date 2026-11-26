// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const roomingDrafts=new Map(),roomingBaselines=new WeakMap(),roomingPending=new Map(),roomingRendered=new WeakMap();let roomingGeneration=0;
const roomingUnfinished=new Map();
const roomingChecks=[
 ['chief_complaint','Chief complaint not recorded'],
 ['medications_reviewed','Medication review not recorded'],
 ['allergies_reviewed','Allergy review not recorded']
];
const roomingOpenPanels=new Map();
let roomingPanelIdentity;
function roomingPanelKey(visit,kind){
 const identity=typeof me==='undefined'?null:me;
 if(roomingPanelIdentity!==identity){roomingOpenPanels.clear();roomingPanelIdentity=identity;}
 return JSON.stringify([selected,visit,kind]);
}
function roomingPanelOpen(visit,kind){return roomingOpenPanels.get(roomingPanelKey(visit,kind))===true;}
function roomingRememberPanel(panel){
 if(panel?.dataset.visitId===activeVisit?.id&&panel.isConnected!==false){
  roomingOpenPanels.set(roomingPanelKey(panel.dataset.visitId,panel.dataset.roomingPanel),panel.open);
 }
}
function roomingMissing(values){
 return roomingChecks.filter(([name])=>name==='chief_complaint'?!String(values[name]||'').trim():!values[name]);
}
function roomingRecordStatus(values,missing){
 if(missing.length)return missing.map(([,message])=>message).join(' · ');
 return values.status==='ready'?'Rooming complete':'Rooming recorded · Ready status not set';
}
function roomingFieldMarkup(name,label,value,locked,intake){
 const needed=!locked&&roomingMissing(intake).some(([key])=>key===name);
 const markerId='rooming-needed-'+name,labelId='rooming-field-label-'+name;
 const cue=`<span class="rooming-needed-label" id="${markerId}"${needed?'':' hidden'}>Needed</span>`;
 const caption=`<span><span id="${labelId}">${esc(label)}</span> ${cue}</span>`;
 const aria=` aria-labelledby="${labelId}"${needed?` aria-describedby="${markerId}"`:''}`;
 const control=name==='chief_complaint'
  ?`<textarea name="${name}" rows="1" maxlength="2000" ${locked?'readonly':''}${aria}>${esc(value)}</textarea>`
  :`<input type="checkbox" name="${name}" ${value?'checked':''} ${locked?'disabled':''}${aria}>`;
 return `<label data-rooming-field="${name}"${needed?' data-rooming-needed':''} class="${name==='chief_complaint'?'':'rooming-review-check'}">${name==='chief_complaint'?caption+control:control+caption}</label>`;
}
function roomingSubjectiveSource(form){
 const visit=typeof activeVisit!=='undefined'?activeVisit:null;
 const note=$('note-form');
 if(form?.dataset.roomingEditable!=='true'||!visit||visit.status==='signed'||
    form.dataset.visitId!==visit.id||form.dataset.patientId!==selected||
    visit.patient_id!==selected||note?.dataset.visitId!==visit.id||!note.elements?.subjective)return '';
 // Use the saved narrative verbatim and let the person rooming edit it as a draft.
 const text=typeof visit.note?.subjective==='string'?visit.note.subjective.trim():'';
 return text&&text.length<=form.elements.chief_complaint.maxLength?text:'';
}
function roomingPaintChecklist(form,focused=form?.ownerDocument?.activeElement){
 if(!form?.querySelector||form.dataset.roomingEditable==='false')return;
 const needs=form.querySelector('[data-rooming-needed-fields]'),completed=form.querySelector('[data-rooming-completed-fields]');
 if(!needs||!completed)return;
 const values=roomingFormValues(form),missing=roomingMissing(values),names=new Set(missing.map(([name])=>name));
 form.dataset.roomingMissingCount=String(names.size);
 const review=form.querySelector('[data-rooming-review]');
 const copy=form.querySelector('[data-rooming-use-subjective]');
 if(copy)copy.hidden=!names.has('chief_complaint')||!roomingSubjectiveSource(form);
 for(const [name] of roomingChecks){
  const field=form.elements[name],item=form.querySelector(`[data-rooming-field="${name}"]`),cue=item?.querySelector('.rooming-needed-label');
  if(!field||!item||!cue)continue;
  const needed=names.has(name);
  item.toggleAttribute('data-rooming-needed',needed);cue.hidden=!needed;
  if(needed)field.setAttribute('aria-describedby',cue.id);else field.removeAttribute('aria-describedby');
  // Keep a complaint being typed in place until blur so its caret and selection survive.
  const writing=name==='chief_complaint'&&item.contains(focused)&&item.parentNode===needs;
  const target=!review?.open&&(needed||writing)?needs:completed;
  if(item.parentNode!==target){
   const index=roomingChecks.findIndex(([key])=>key===name);
   const next=[...target.children].find(other=>roomingChecks.findIndex(([key])=>key===other.dataset.roomingField)>index);
   target.insertBefore(item,next||null);
  }
 }
 const save=form.querySelector('[type="submit"]'),state=form.querySelector('[data-rooming-checklist-state]');
 const pending=roomingPending.has(form.dataset.visitId),dirty=roomingDrafts.has(form.dataset.visitId);
 const status=pending?'saving':dirty?'changes':names.size?'missing':values.status==='ready'?'complete':'recorded';
 const labels={saving:'Saving rooming…',changes:'Rooming changes not saved',missing:'',complete:'Rooming complete',recorded:'Rooming recorded'};
 if(state.dataset.roomingChecklistState!==status)state.dataset.roomingChecklistState=status;
 if(state.textContent!==labels[status])state.textContent=labels[status];
 state.hidden=!labels[status];
 const quickStatus=form.querySelector('[data-rooming-mark-ready]');
 const nextStatus=!names.size&&values.status!=='ready'?'ready':names.size&&values.status==='ready'?'in_progress':'';
 quickStatus.hidden=!nextStatus;
 quickStatus.disabled=pending||form.dataset.roomingNeedsReview==='true';
 quickStatus.dataset.roomingMarkReady=nextStatus;
 quickStatus.textContent=nextStatus==='in_progress'?'Keep rooming in progress':'Mark rooming ready';
 const problem=form.querySelector('[data-rooming-save-error]');
 const autoSaving=typeof queueVisitNoteAutosave==='function'&&(!problem||problem.hidden);
 if(save){save.hidden=autoSaving||!(dirty||pending);save.disabled=pending||form.dataset.roomingNeedsReview==='true';}
 const actions=form.querySelector('[data-rooming-actions]');
 const destination=review?.open?review.querySelector('[data-rooming-dialog-actions]'):form.querySelector('[data-rooming-inline-actions]');
 if(destination&&actions?.parentElement!==destination){destination.append(actions,problem);}
}
function markRoomingUnfinished(visit,patient){
 roomingUnfinished.set(visit,patient);
 if(typeof encounterStepsSchedule==='function')encounterStepsSchedule();
}
function roomingValues(value){
 return {status:value.status==='ready'?'ready':'in_progress',chief_complaint:String(value.chief_complaint??''),intake_notes:String(value.intake_notes??''),medications_reviewed:!!value.medications_reviewed,allergies_reviewed:!!value.allergies_reviewed};
}
function roomingFormValues(f){
 const values=formData(f);values.medications_reviewed=!!f.elements.medications_reviewed.checked;values.allergies_reviewed=!!f.elements.allergies_reviewed.checked;
 return roomingValues(values);
}
function sameRoomingValues(a,b){return !!a&&!!b&&Object.keys(roomingValues(a)).every(key=>roomingValues(a)[key]===roomingValues(b)[key]);}
function captureRoomingDraft(){
 const f=$('rooming-form');if(!f)return;
 const values=roomingFormValues(f),baseline=roomingBaselines.get(f);
 if(!baseline)return;
 const pending=roomingPending.get(f.dataset.visitId);
 if(sameRoomingValues(values,baseline.values)&&(!pending||sameRoomingValues(values,pending))){roomingDrafts.delete(f.dataset.visitId);return;}
 roomingDrafts.set(f.dataset.visitId,{patientId:f.dataset.patientId,version:Number(f.dataset.version),values});
}
async function renderRooming(){
 const host=$('visit-rooming');if(!host||!activeVisit)return;
 const id=activeVisit.id,patient=selected,generation=++roomingGeneration,identity=typeof me==='undefined'?null:me;
 const previous=roomingRendered.get(host),locallySigned=activeVisit.status==='signed';
 const mayEdit=typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical','edit');
 const keep=previous?.id===id&&previous.patient===patient&&previous.identity===identity&&(!locallySigned||previous.signed)&&(!previous.editable||mayEdit);
 const current=()=>generation===roomingGeneration&&activeVisit?.id===id&&selected===patient&&$('visit-rooming')===host&&(typeof me==='undefined'?null:me)===identity;
 if(keep)captureRoomingDraft();
 else{
  roomingRendered.delete(host);
  if(host.dataset)for(const key of ['roomingStatus','roomingComplete','roomingRecordStatus','roomingRecordMissing'])delete host.dataset[key];
  host.hidden=false;host.innerHTML='<h3>Rooming</h3><p class="muted">Loading…</p>';
 }
 try{
  const data=await api(`/api/v1/visits/${id}/rooming`);
  if(!current())return;
  const oldForm=keep?$('rooming-form'):null,active=host.ownerDocument?.activeElement;
  const focus=oldForm?.contains?.(active)?{name:active.name,inline:!!active.closest('[data-rooming-needed-fields]'),start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}:null;
  if(keep){captureRoomingDraft();roomingRememberPanel(host.querySelector?.('[data-rooming-review]'));}
  const missing=roomingMissing(data),savedStatus=roomingRecordStatus(data,missing);
  const editable=data.can_edit&&mayEdit;
  const signed=activeVisit.status==='signed'||data.visit?.status==='signed';
  const draft=roomingDrafts.get(id),retained=draft?.patientId===patient&&!signed?draft:null,values=retained?.values||data,stale=data.version!==activeVisit.version,needsReview=!!retained&&retained.version!==data.version,locked=signed||!editable||stale;
  const key=JSON.stringify([data.version,signed,locked,needsReview,roomingValues(data),data.updated_at,data.updated_by_label,data.updated_by,data.history]);
  if(keep&&previous.key===key){
   host.querySelector?.('[data-rooming-refresh-error]')?.remove();host.hidden=previous.hidden;
   roomingPaintChecklist(oldForm);return;
  }
  const rendered={id,patient,identity,signed,editable:!locked,key,hidden:false};
  roomingRendered.set(host,rendered);
  if(host.dataset){
   host.dataset.roomingStatus=data.status;
   host.dataset.roomingComplete=String(!missing.length);
   host.dataset.roomingRecordStatus=savedStatus;
   host.dataset.roomingRecordMissing=missing.map(([,message])=>message).join(' · ');
  }
  // The signed rooming record is locked by the server.
  if(signed&&locked){
   const lines=[['Chief complaint',String(data.chief_complaint||'').trim()],['Rooming notes',String(data.intake_notes||'').trim()]].filter(([,text])=>text),reviewed=[data.medications_reviewed?'Medications reviewed':'',data.allergies_reviewed?'Allergies reviewed':''].filter(Boolean);
   host.innerHTML=lines.length||reviewed.length?`<h3>Rooming</h3><dl class="note-read">${lines.map(([label,text])=>`<dt>${esc(label)}</dt><dd class="note-text">${esc(text)}</dd>`).join('')}</dl>${reviewed.length?`<p class="muted">${esc(reviewed.join(' · '))} with the patient.</p>`:''}`:'';
   rendered.hidden=host.hidden=!host.innerHTML;return;
  }
  host.hidden=false;
  const reviewOpen=!!oldForm?.querySelector?.('[data-rooming-review]')?.open;
  const chief=roomingFieldMarkup('chief_complaint','Reason for visit',values.chief_complaint,locked,values);
  const medications=roomingFieldMarkup('medications_reviewed','Medications reviewed with patient',values.medications_reviewed,locked,values);
  const allergies=roomingFieldMarkup('allergies_reviewed','Allergies reviewed with patient',values.allergies_reviewed,locked,values);
  host.innerHTML=`<div class="section-head"><h3>Rooming</h3></div>${locked?`<p role="status">${esc(savedStatus)}</p>`:''}${needsReview?`<section role="status"><p>Someone else saved this encounter. Compare your changes with what was saved before continuing.</p><p>Saved chief complaint: ${esc(data.chief_complaint)}<br>Saved intake notes: ${esc(data.intake_notes)}<br>Saved status: ${esc(displayStatus(data.status))} · Medications ${data.medications_reviewed?'reviewed':'not reviewed'} · Allergies ${data.allergies_reviewed?'reviewed':'not reviewed'}</p>${!locked?`<button type="button" data-rooming-rebase="${data.version}">Keep my changes</button>`:''}</section>`:''}${stale?'<p role="status">This encounter was changed elsewhere. Reload it before editing; your unsaved changes are kept.</p><button type="button" data-rooming-refresh>Reload encounter</button>':''}<form id="rooming-form" data-visit-id="${esc(id)}" data-patient-id="${esc(patient)}" data-version="${retained?.version??data.version}" data-rooming-editable="${!locked}" data-rooming-needs-review="${needsReview}">${locked?'':`<p data-rooming-checklist-state role="status" hidden></p><div data-rooming-needed-fields>${chief}${medications}${allergies}</div><div class="actions rooming-links"><button type="button" data-rooming-use-subjective class="text-button" hidden>Use visit note</button><button type="button" class="text-button" data-rooming-open-details aria-haspopup="dialog">Rooming details</button></div><div data-rooming-inline-actions><div data-rooming-save-error hidden><p role="alert"></p><button type="button" data-rooming-refresh hidden>Reload encounter</button></div><div class="actions" data-rooming-actions><button type="button" data-rooming-mark-ready hidden>Mark rooming ready</button><button type="submit" ${needsReview?'disabled':''}>Save rooming</button></div></div>`}${locked?'<button type="button" class="text-button" data-rooming-open-details aria-haspopup="dialog">Rooming details</button>':''}<dialog class="sheet-dialog rooming-details-dialog" aria-labelledby="rooming-details-title" data-rooming-review><header class="sheet-head"><h2 id="rooming-details-title">Rooming details</h2><button type="button" data-rooming-close aria-label="Close rooming details">×</button></header><div class="sheet-body"><div data-rooming-completed-fields>${locked?chief+medications+allergies:''}</div><div class="rooming-text-grid"><label>Rooming notes<textarea name="intake_notes" rows="2" maxlength="10000" ${locked?'readonly':''}>${esc(values.intake_notes)}</textarea></label><label>Status<select name="status" ${locked?'disabled':''}><option value="in_progress" ${values.status==='in_progress'||values.status==='not_started'?'selected':''}>Rooming in progress</option><option value="ready" ${values.status==='ready'?'selected':''}>Ready for clinician</option></select></label></div><p class="muted">${data.updated_at?`Last saved ${esc(date(data.updated_at))} by ${esc(data.updated_by_label||data.updated_by)}`:''}</p><details><summary>Rooming and vitals history</summary>${data.history.map(r=>`<section><p>${esc(displayStatus(r.kind))} · ${esc(date(r.created_at))} · ${esc(r.actor_label||r.actor_id)}</p>${r.kind==='vitals'?`<p>${esc(Object.entries(r.snapshot.vitals||{}).map(([k,v])=>`${human(k)}: ${v}`).join(' · '))}</p>`:`<p>${esc(r.snapshot.chief_complaint)} · ${esc(displayStatus(r.snapshot.status))}</p>`}</section>`).join('')||'<p>Nothing saved yet.</p>'}</details><div data-rooming-dialog-actions></div></div></dialog></form>`;
  const form=$('rooming-form');
  if(form){
   roomingBaselines.set(form,{values:roomingValues(data),version:data.version});
   const field=focus?.name&&!locked?form.elements[focus.name]:null;
   roomingPaintChecklist(form,focus?.inline?field:null);
   if(reviewOpen)openRoomingDetails(form);
   if(field){
    const details=field.closest('details');
    const target=field.closest('dialog:not([open])')?form.querySelector('[data-rooming-open-details]'):details&&!details.open?details.querySelector('summary'):field;
    target?.focus({preventScroll:true});
    if(target===field&&Number.isInteger(focus.start)&&Number.isInteger(focus.end))field.setSelectionRange?.(focus.start,focus.end,focus.direction);
   }
  }
 }catch(e){
  if(!current())return;
  const message=`Rooming could not load: ${e.message}`;
  if(!keep||!host.ownerDocument){host.textContent=message;return;}
  let alert=host.querySelector('[data-rooming-refresh-error]');
  if(!alert){
   alert=host.ownerDocument.createElement('p');alert.dataset.roomingRefreshError='';alert.setAttribute('role','status');host.prepend(alert);
  }
  alert.textContent=message;host.hidden=false;
 }
}
for(const type of ['input','change'])document.addEventListener(type,e=>{
 const form=e.target.closest?.('#rooming-form');if(!form)return;
 const field=e.target,reviewChanged=field.type==='checkbox'&&field===form.ownerDocument?.activeElement;
 const completedHere=reviewChanged&&field.checked&&field.closest('[data-rooming-needed-fields]');
 const review=form.querySelector('[data-rooming-review]');
 // Completing the outstanding intake items also advances intake status in this save.
 if(roomingChecks.some(([name])=>name===field.name)&&form.elements.status){
  const ready=!roomingMissing(roomingFormValues(form)).length;
  if(ready&&Number(form.dataset.roomingMissingCount)>0)form.elements.status.value='ready';
  else if(!ready&&form.elements.status.value==='ready')form.elements.status.value='in_progress';
 }
 captureRoomingDraft();roomingPaintChecklist(form);
 if(completedHere&&!review?.open){
  // The checked control moved into details. Continue at the next outstanding action.
  const next=form.querySelector('[data-rooming-needed-fields] [data-rooming-needed] :is(textarea,input)')
   ||form.querySelector('[data-rooming-mark-ready]:not([hidden]):not([disabled])')
   ||form.querySelector('[data-rooming-open-details]');
  next?.focus({preventScroll:true});
 }else if(reviewChanged&&!field.checked&&field.isConnected){
  field.focus({preventScroll:true});
 }
});
document.addEventListener('focusout',e=>{
 // Wait for focus to land before moving the complaint out of its editing row.
 if(e.target.name!=='chief_complaint')return;
 const form=e.target.closest?.('#rooming-form');
 if(form)queueMicrotask(()=>{if(form.isConnected)roomingPaintChecklist(form);});
});
document.addEventListener('toggle',e=>{
 const panel=e.target;if(!panel.matches?.('[data-rooming-panel]'))return;
 roomingRememberPanel(panel);

},true);
function openRoomingDetails(form){
 const dialog=form?.querySelector('[data-rooming-review]');
 if(!dialog||dialog.open)return;
 const fields=form.querySelector('[data-rooming-needed-fields]');
 if(fields)fields.style.minHeight=fields.getBoundingClientRect().height+'px';
 const trigger=form.querySelector('[data-rooming-open-details]');
 if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
 roomingPaintChecklist(form);
 dialog.querySelector('[data-rooming-close]')?.focus({preventScroll:true});
 dialog.addEventListener('close',()=>{
  if(fields)fields.style.minHeight='';
  roomingPaintChecklist(form);
  if(trigger?.isConnected)trigger.focus({preventScroll:true});
 },{once:true});
}
document.addEventListener('click',e=>{
 const trigger=e.target.closest?.('[data-rooming-open-details],[data-rooming-close]');
 if(trigger){
  const form=trigger.closest('#rooming-form');
  if(trigger.hasAttribute('data-rooming-close'))form?.querySelector('[data-rooming-review]')?.close();
  else openRoomingDetails(form);
  return;
 }
 const copy=e.target.closest?.('[data-rooming-use-subjective]');
 if(copy){
  const form=copy.closest('#rooming-form'),text=roomingSubjectiveSource(form),field=form?.elements.chief_complaint;
  if(text&&field&&!field.value.trim()){
   field.focus({preventScroll:true});field.value=text;
   field.dispatchEvent(new Event('input',{bubbles:true}));
  }
  return;
 }
 const button=e.target.closest?.('[data-rooming-mark-ready]');if(!button)return;
 const form=button.closest('#rooming-form'),value=button.dataset.roomingMarkReady;
 if(!form||form.dataset.roomingEditable!=='true'||!['ready','in_progress'].includes(value))return;
 form.elements.status.value=value;captureRoomingDraft();roomingPaintChecklist(form);
 form.requestSubmit();
});
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-rooming-refresh],[data-rooming-rebase]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();run(async()=>{captureRoomingDraft();if(b.hasAttribute('data-rooming-rebase')){const draft=roomingDrafts.get(activeVisit.id);if(draft)draft.version=Number(b.dataset.roomingRebase);await renderRooming();return;}captureVisitDrafts();const id=activeVisit.id,v=await api(`/api/v1/visits/${id}`);if(activeVisit?.id!==id)return;rememberVisit(v);renderVisit(false);});},true);
document.addEventListener('submit',e=>{
 const f=e.target;if(f.id!=='rooming-form')return;e.preventDefault();e.stopImmediatePropagation();
 return run(()=>typeof visitNoteEnqueue==='function'?visitNoteEnqueue(()=>saveVisitRooming(f)):saveVisitRooming(f));
},true);
async function saveVisitRooming(f,{autosave=false}={}){
  captureRoomingDraft();captureVisitDrafts();
  const id=f.dataset.visitId,patient=f.dataset.patientId,submitted=roomingFormValues(f),version=Number(f.dataset.version);
  const account=typeof me==='undefined'?null:me?.user_id;
  roomingPending.set(id,submitted);roomingPaintChecklist(f);
  const problem=f.querySelector?.('[data-rooming-save-error]');if(problem)problem.hidden=true;
  let data;
  try{data=await api(`/api/v1/visits/${id}/rooming`,'PUT',submitted,version);}
  catch(error){
   if(problem&&$('rooming-form')===f&&selected===patient){
    problem.querySelector('p').textContent=error.message||'Rooming could not be saved.';
    problem.querySelector('button').hidden=error.status!==409;
    problem.hidden=false;
   }
   throw error;
  }finally{roomingPending.delete(id);roomingPaintChecklist(f);}
  if(typeof me!=='undefined'&&me?.user_id!==account)return;
  // Inputs remain usable while the request is pending. Only clear the exact
  // submitted draft; newer typing remains attached to its original version.
  const visible=$('rooming-form')===f&&activeVisit?.id===id&&selected===patient;
  const existing=roomingDrafts.get(id),latest=visible?roomingFormValues(f):existing?.values||submitted;
  const saved=roomingValues(data);
  roomingBaselines.set(f,{values:saved,version:data.version});
  if(sameRoomingValues(latest,submitted)||sameRoomingValues(latest,saved))roomingDrafts.delete(id);
  else roomingDrafts.set(id,{patientId:patient,version:existing?.version??version,values:latest});
  if(activeVisit?.id!==id||selected!==patient)return;
  roomingUnfinished.delete(id);
  rememberVisit(data.visit,'rooming');
  if(autosave&&visible){f.dataset.version=String(data.version);const draft=roomingDrafts.get(id);if(draft?.version===version)draft.version=data.version;roomingPaintChecklist(f);}
  else{await renderRooming();notice('Rooming intake saved with staff attribution.');}
}
