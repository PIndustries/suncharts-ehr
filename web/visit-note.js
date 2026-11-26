// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// "Same as last encounter": brings the text of the patient's most recent signed note into the
// note being written. The earlier note is only read. Loaded text and undo steps live in
// this tab only and are dropped when the signed-in person changes.
const visitNoteSources=new Map(),visitNoteUndo=new Map(),visitNotePeople=new Map();
function clearVisitNoteSession(){if(visitNoteCopySheet?.dialog.open)sheetClose(visitNoteCopySheet.dialog);visitNoteSources.clear();visitNoteUndo.clear();visitNotePeople.clear();clearTimeout(visitNoteSaveTimer);clearTimeout(visitNoteSearchTimer);visitNoteSearches.clear();}
function visitNoteSaved(visit){if(!visit)return;visitNoteUndo.delete(visit.id);visitNoteBar(visit.id);if($('note-message')?.isConnected!==false)showVisitNoteMessage('Note saved.');showVisitNoteAuthorship();}
// Messages shown beside Save note and Sign note, where the person just clicked.
function showVisitNoteMessage(message){
 const host=$('note-message');if(!host||host.isConnected===false)return;
 host.textContent=message;host.hidden=!message;
}
function hideVisitNoteMessage(){const host=$('note-message');if(host&&host.isConnected!==false){host.textContent='';host.hidden=true;}}
// A draft needs at least some text; signing needs Subjective, Objective, Assessment and Plan.
function hasVisitNoteText(form){return noteSectionKeys.some(key=>String(form?.elements[key]?.value??'').trim());}
function noteMissingForSign(form){return noteSectionKeys.slice(0,4).filter(key=>!String(form?.elements[key]?.value??'').trim());}
function refuseVisitNoteSigning(form,missing){
 showVisitNoteMessage(`Add ${visitNoteNames(missing)} before signing.`);
 $('note-message')?.classList?.add('note-sign-error');
 for(const key of missing)form.elements[key]?.setAttribute?.('aria-invalid','true');
 const field=form?.elements?.[missing[0]];
 // Scroll only the encounter pane, leaving the fixed bars in place.
 if(typeof encounterStepOpen==='function')encounterStepOpen(1,false);
 const pane=field?.closest?.('.frame-content')||document.querySelector?.('#app > main');
 if(pane?.scrollBy){const box=field.getBoundingClientRect(),top=Math.max(pane.getBoundingClientRect().top,document.querySelector('.shell-topbar')?.getBoundingClientRect().bottom||0,$('patient-banner')?.getBoundingClientRect().bottom||0);pane.scrollBy({top:box.top-top-24,behavior:'instant'});}
 else field?.scrollIntoView?.({block:'center'});
 field?.focus?.({preventScroll:true});
}
// Names of the people on a note: who the encounter is assigned to, who signed it and who corrected it.
// The signed-in person is known already; anyone else is asked for once per saved version.
function visitNotePersonIds(visit){return [visit.clinician_id,visit.signed_by,...(workspace?.amendments||[]).filter(a=>a.visit_id===visit.id).map(a=>a.author_id)].filter(Boolean);}
function visitNotePerson(visit,id){
 if(id&&id===me?.user_id&&me.display_name)return me.display_name;
 const entry=visitNotePeople.get(visit.id);return entry?.identity===me?entry.names[id]||'':'';
}
function visitNoteAuthorshipLine(visit){
 const parts=[],assigned=visitNotePerson(visit,visit.clinician_id),by=visit.note?.saved_by;
 if(visit.status!=='signed'&&visit.clinician_id!==me?.user_id&&canDraftNote(visit)&&assigned)parts.push(`Drafting for ${assigned}`);
 if(by?.at)parts.push(`Last saved by ${noteSaverName(visit.note)}, ${date(by.at)}`);
 return parts.join(' · ');
}
function visitNoteSignedLine(visit){
 const signer=visitNotePerson(visit,visit.signed_by),assigned=visitNotePerson(visit,visit.clinician_id);
 if(!signer)return `Signed ${date(visit.signed_at)}.`;
 return `Signed by ${signer}, ${date(visit.signed_at)}.${visit.signed_by!==visit.clinician_id&&assigned?` Visit assigned to ${assigned}.`:''}`;
}
function visitNoteAmendmentAuthor(visit,amendment){const name=visitNotePerson(visit,amendment.author_id);return name?` by ${name}`:'';}
function showVisitNoteAuthorship(){
 const visit=activeVisit;if(!visit)return;
 const line=$('note-authorship'),signed=$('note-signed-by');
 if(line&&line.isConnected!==false){const text=visitNoteAuthorshipLine(visit);line.textContent=text;line.hidden=!text;}
 if(signed&&signed.isConnected!==false&&visit.status==='signed')signed.textContent=visitNoteSignedLine(visit);
 for(const amendment of (workspace?.amendments||[]).filter(a=>a.visit_id===visit.id)){const author=$('amendment-author-'+amendment.id);if(author&&author.isConnected!==false)author.textContent=visitNoteAmendmentAuthor(visit,amendment);}
}
async function loadVisitNotePeople(visit){
 const identity=me;let entry=visitNotePeople.get(visit.id);
 if(!entry||entry.identity!==identity||entry.version!==visit.version){
  entry={identity,version:visit.version,names:entry?.identity===identity?entry.names:{},pending:null};visitNotePeople.set(visit.id,entry);
  entry.pending=api(`/api/v1/visits/${visit.id}/note-authorship`).then(data=>{
   const names={[data.assigned.id]:data.assigned.name};if(data.signed)names[data.signed.id]=data.signed.name;
   for(const amendment of data.amendments||[])names[amendment.author_id]=amendment.author_name;
   entry.names=names;
  },()=>{}).finally(()=>{entry.pending=null;});
 }
 if(entry.pending)await entry.pending;
 return me===identity&&visitNotePeople.get(visit.id)===entry?entry:null;
}
async function renderVisitNoteAuthorship(){
 const visit=activeVisit;if(!visit||!visitNotePersonIds(visit).some(id=>id!==me?.user_id))return;
 if(await loadVisitNotePeople(visit)&&activeVisit?.id===visit.id)showVisitNoteAuthorship();
}
async function visitNoteAssignedName(visit){await loadVisitNotePeople(visit);return visitNotePerson(visit,visit.clinician_id);}
function visitNoteSourceDate(visitId){for(const entry of visitNoteSources.values())if(entry.source?.visit_id===visitId)return entry.source.visit_date;return null;}
function visitNoteCurrent(visitId){const form=$('note-form');return activeVisit?.id===visitId&&canDraftNote(activeVisit)&&form?.isConnected!==false&&form?.dataset?.visitId===visitId?form:null;}
function visitNoteLabel(key){return key[0].toUpperCase()+key.slice(1);}
function visitNoteNames(keys){const names=keys.map(visitNoteLabel);return names.length>1?`${names.slice(0,-1).join(', ')} and ${names.at(-1)}`:names[0]||'';}
function visitNoteFrom(source){const day=noteDay(source.visit_date);return (source.own??source.same_clinician)?`your visit on ${day}`:source.clinician_name?`${source.clinician_name}’s visit on ${day}`:`another clinician’s visit on ${day}`;}
function visitNoteValues(form){return Object.fromEntries(noteSectionKeys.map(key=>[key,String(form.elements[key]?.value??'')]));}
function visitNoteBar(visitId,message=''){
 const host=$('note-previous'),form=visitNoteCurrent(visitId),entry=visitNoteSources.get(visitId);if(!host||!form||!entry||entry.identity!==me)return;
 const source=entry.source,undo=visitNoteUndo.get(visitId)?.length;
 host.hidden=false;
 if(entry.failed){host.innerHTML='<span class="muted">Previous note unavailable.</span><button type="button" class="text-button" data-note-retry>Try again</button>';return;}
 if(!source){host.hidden=true;host.innerHTML='';return;}
 host.innerHTML=`<button type="button" class="text-button" data-note-copy-open aria-haspopup="dialog">Copy from previous note</button><span id="note-previous-status" class="note-previous-status" role="status">${esc(message)}</span>${undo?'<button type="button" class="text-button" data-note-undo>Undo</button>':''}`;
 if(visitNoteCopySheet?.visit===visitId){const status=visitNoteCopySheet.node.querySelector('[data-note-copy-status]');if(status&&message)status.textContent=message;}
}
let visitNoteCopySheet=null;
function visitNoteCopyMarkup(source){
 const available=noteSectionKeys.filter(key=>source?.note?.[key]?.trim());
 const fields=available.map(key=>`<section class="note-copy-section"><div class="section-head"><strong>${visitNoteLabel(key)}</strong><button type="button" data-note-same="${key}">Copy ${visitNoteLabel(key)}</button></div><p>${esc(source.note[key])}</p></section>`).join('');
 return `<p class="muted">From ${esc(visitNoteFrom(source))}</p>${fields}<p data-note-copy-status role="status"></p><div class="actions"><button type="button" class="primary" data-note-same="all">Copy all sections</button></div>`;
}
function openVisitNoteCopy(){
 const visit=activeVisit?.id,entry=visitNoteSources.get(visit),form=visitNoteCurrent(visit);
 if(!entry?.source||!form||entry.identity!==me||entry.patientId!==selected||visitNoteCopySheet?.dialog.open)return;
 const node=document.createElement('div'),sheet={visit,patient:selected,identity:me,node};
 node.innerHTML=visitNoteCopyMarkup(entry.source);
 sheet.dialog=sheetOpen('Copy from previous note',node,{className:'chart-record-sheet note-copy-sheet',label:true});visitNoteCopySheet=sheet;
 sheet.dialog.addEventListener('close',()=>{
  if(visitNoteCopySheet===sheet)visitNoteCopySheet=null;
  if(me!==sheet.identity||selected!==sheet.patient||!visitNoteCurrent(visit))return;
  const field=sheet.applied&&sheet.applied!=='all'&&$('note-form')?.elements[sheet.applied];
  (field||$('note-previous')?.querySelector('[data-note-copy-open]'))?.focus?.({preventScroll:true});
 },{once:true});
}
function visitNoteSourceUpdated(form){
 const line=$('note-source-line'),text=noteSourceText(form.elements.started_from?.value);
 if(line){line.textContent=noteSourceLine(text,false,activeVisit?.note?.started_from);line.hidden=!text;}
 captureVisitDrafts(false);
 if(form.elements.plan?.dispatchEvent)form.elements.plan.dispatchEvent(new Event('input',{bubbles:true}));
}
async function renderVisitNoteSource(){
 const visit=activeVisit,identity=me;if(!visit||visit.status==='signed'||!visitNoteCurrent(visit.id))return;
 let entry=visitNoteSources.get(visit.id);
 if(!entry||entry.identity!==identity||entry.patientId!==selected){
  entry={identity,patientId:selected,source:null,failed:false,pending:null};visitNoteSources.set(visit.id,entry);
  entry.pending=api(`/api/v1/visits/${visit.id}/previous-note`).then(data=>{entry.source=data.source||null;},()=>{entry.failed=true;}).finally(()=>{entry.pending=null;});
 }
 if(entry.pending)await entry.pending;
 if(me===identity&&visitNoteSources.get(visit.id)===entry)visitNoteBar(visit.id);
}
// Sections that already have text are never replaced without an explicit choice.
async function applyVisitNoteSource(which){
 const visitId=activeVisit?.id,entry=visitNoteSources.get(visitId),source=entry?.source;let form=visitNoteCurrent(visitId);
 if(!form||!source||entry.identity!==me||entry.patientId!==selected)return;
 const offered=(which==='all'?noteSectionKeys:[which]).filter(key=>source.note[key]?.trim()),wanted=offered.filter(key=>visitNoteValues(form)[key]!==source.note[key]);if(!offered.length)return;
 if(!wanted.length){visitNoteBar(visitId,'This already matches the last visit. Nothing was changed.');return;}
 let replace=false;const written=wanted.filter(key=>visitNoteValues(form)[key].trim());
 if(written.length){
  const from=`From ${visitNoteFrom(source)}.`;
  if(which==='all'){
   const answer=await confirmAction('Replace what you have written, or fill only the empty sections?',{eyebrow:'YOUR NOTE HAS TEXT',title:'Same as last encounter',detail:`${from} You have written in ${visitNoteNames(written)}.`,confirmLabel:'Fill empty sections',alternateLabel:'Replace what I wrote',cancelLabel:'Cancel'});
   if(!answer)return;replace=answer==='alternate';
  }else{
   if(!await confirmAction(`Replace what you have written in ${visitNoteLabel(which)}?`,{eyebrow:'THIS SECTION HAS TEXT',title:'Same as last encounter',detail:from,confirmLabel:'Replace',cancelLabel:'Cancel',initialFocus:'cancel'}))return;replace=true;
  }
 }
 form=visitNoteCurrent(visitId);if(!form||visitNoteSources.get(visitId)!==entry||entry.identity!==me||entry.patientId!==selected)return;
 const before=visitNoteValues(form),changes={};
 for(const key of wanted){if(before[key]===source.note[key]||(before[key].trim()&&!replace))continue;changes[key]={before:before[key],after:source.note[key]};}
 const keys=Object.keys(changes);
 if(!keys.length){visitNoteBar(visitId,'Every section already has text. Nothing was changed.');return;}
 const sourceBefore=noteSourceText(form.elements.started_from.value),earlier=sourceBefore?JSON.parse(sourceBefore):null;
 for(const key of keys)form.elements[key].value=changes[key].after;
 form.elements.started_from.value=noteSourceText({visit_id:source.visit_id,version:source.version,sections:[...(earlier?.visit_id===source.visit_id?earlier.sections:[]),...keys]});
 const steps=visitNoteUndo.get(visitId)||[];steps.push({changes,sourceBefore,visitId:source.visit_id,version:source.version});visitNoteUndo.set(visitId,steps);
 visitNoteSourceUpdated(form);
 visitNoteBar(visitId,`${visitNoteNames(keys)} brought in. Review before signing.`);return true;
}
// Undo puts back only the sections that still hold exactly what was brought in.
function undoVisitNoteSource(){
 const visitId=activeVisit?.id,form=visitNoteCurrent(visitId),steps=visitNoteUndo.get(visitId);if(!form||!steps?.length)return;
 const step=steps.pop(),kept=[];if(!steps.length)visitNoteUndo.delete(visitId);
 for(const [key,change] of Object.entries(step.changes)){if(String(form.elements[key].value)===change.after)form.elements[key].value=change.before;else kept.push(key);}
 const earlier=step.sourceBefore?JSON.parse(step.sourceBefore):null;
 form.elements.started_from.value=kept.length?noteSourceText({visit_id:step.visitId,version:step.version,sections:[...(earlier?.visit_id===step.visitId?earlier.sections:[]),...kept]}):step.sourceBefore;
 visitNoteSourceUpdated(form);
 visitNoteBar(visitId,kept.length?`${visitNoteNames(kept)} kept because you edited ${kept.length>1?'them':'it'} afterwards. The rest was put back.`:'Put back as it was.');
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button');if(!button?.dataset||typeof busy!=='undefined'&&busy)return;
 if(Object.hasOwn(button.dataset,'noteCopyOpen')){openVisitNoteCopy();return;}
 if(button.dataset.noteSame){
  const which=button.dataset.noteSame,sheet=visitNoteCopySheet;
  if(sheet&&(sheet.identity!==me||sheet.patient!==selected||sheet.visit!==activeVisit?.id||sheet.busy))return;
  if(sheet)sheet.busy=true;
  void applyVisitNoteSource(which).then(applied=>{
   if(applied&&sheet&&sheet===visitNoteCopySheet){sheet.applied=which;sheetClose(sheet.dialog);}
  }).catch(error=>notice(error.message,true)).finally(()=>{if(sheet)sheet.busy=false;});
 }
 else if(Object.hasOwn(button.dataset,'noteUndo'))undoVisitNoteSource();
 else if(Object.hasOwn(button.dataset,'noteRetry')&&activeVisit){visitNoteSources.delete(activeVisit.id);void renderVisitNoteSource();}
});

// Serialize the three encounter saves: all share the encounter's version.
let visitNoteSaveQueue=Promise.resolve(),visitNoteSaveTimer=null;
function visitNoteEnqueue(work){
 const id=activeVisit?.id,patient=selected,identity=me;
 const task=visitNoteSaveQueue.then(()=>{if(activeVisit?.id!==id||selected!==patient||me!==identity)throw new Error('This page changed. Open the encounter again.');return work();});
 visitNoteSaveQueue=task.catch(()=>{});return task;
}
function visitNoteSaveStatus(text){const host=$('note-save-status');if(host)host.textContent=text;}
function queueVisitNoteAutosave(event){
 const form=event.target?.closest?.('#note-form,#vitals-form,#rooming-form');
 if(form?.id==='note-form'&&event.target.value?.trim()){event.target.removeAttribute?.('aria-invalid');if($('note-message')?.classList?.contains('note-sign-error')){const missing=noteMissingForSign(form);if(missing.length)showVisitNoteMessage(`Add ${visitNoteNames(missing)} before signing.`);else{$('note-message').classList.remove('note-sign-error');hideVisitNoteMessage();}}}
 if(!form||event.isComposing||event.target.readOnly||event.target.disabled||activeVisit?.status==='signed')return;
 if(form.id==='vitals-form'&&typeof visitVitalsFeedback==='function')visitVitalsFeedback(form);
 // Inline searches and chip edits have their own save paths.
 if(event.target.closest?.('[data-note-inline]'))return;
 clearTimeout(visitNoteSaveTimer);visitNoteSaveStatus('Saving…');
 const id=activeVisit.id,identity=me;
 visitNoteSaveTimer=setTimeout(()=>{
  visitNoteSaveTimer=null;
  if(activeVisit?.id!==id||me!==identity)return;
  void visitNoteFlush().catch(error=>{visitNoteSaveStatus('Not saved');showVisitNoteMessage(error.message);});
 },600);
}
document.addEventListener('input',queueVisitNoteAutosave);
document.addEventListener('change',queueVisitNoteAutosave);
document.addEventListener('compositionend',queueVisitNoteAutosave);
document.addEventListener('invalid',event=>{
 const form=event.target?.closest?.('#vitals-form');
 if(form&&typeof visitVitalsFeedback==='function')visitVitalsFeedback(form,{validateValues:true});
},true);
async function visitNoteSaveInputs({signing=false,focusVitals=false}={}){
 const visit=activeVisit?.id,identity=me,patient=selected;
 let roomingRefused=false,vitalsNeedReview=false;
 const current=()=>activeVisit?.id===visit&&me===identity&&selected===patient&&activeVisit.status!=='signed';
 while(current()){
  let changed=false;
  const room=$('rooming-form');
  if(room&&!roomingRefused&&typeof captureRoomingDraft==='function'){
   captureRoomingDraft();
   if(roomingDrafts.has(visit)){
    try{
     if(Number(room.dataset.version)!==activeVisit.version)throw new Error('Review the rooming changes before saving.');
     await saveVisitRooming(room,{autosave:true});changed=true;
    }catch(error){
     const incompleteReady=room.elements.status.value==='ready'&&typeof roomingMissing==='function'&&roomingMissing(roomingFormValues(room)).length>0;
     const readinessRejected=error.status===422||error.status===400||(!error.status&&error.message==='ready for clinician requires chief complaint and medication/allergy review');
     if(!signing||!current()||error.signedOut||!incompleteReady||!readinessRejected)throw error;
     roomingRefused=true;markRoomingUnfinished(visit,patient);
    }
   }
  }
  if(!current())return;
  const vitals=$('vitals-form');
  if(signing&&vitals?.dataset.visitId!==visit&&visitDrafts.get(visit)?.vitals)throw new Error('Open vitals to review your unsaved measurements before signing.');
  if(vitals?.dataset.visitId===visit&&canRecordVisitVitals(activeVisit)){
   const values=formData(vitals),saved=vitalsToForm(activeVisit.vitals);
   const issue=typeof visitVitalsFeedback==='function'?visitVitalsFeedback(vitals,{validateValues:true}):null;
   const changedVitals=issue?.field.validity?.badInput||Object.entries(values).some(([key,value])=>String(value)!==String(saved[key]??''));
   vitalsNeedReview=Boolean(issue&&changedVitals);
   if(issue&&(focusVitals||signing&&changedVitals)){
    focusVisitVitalsIssue(issue.field);throw new Error(issue.message);
   }
   if(!issue&&changedVitals){
    const measured=Object.fromEntries(Object.entries(values).filter(([,value])=>value!=='').map(([key,value])=>[key,vitalFromForm(key,value)]));
    if(!Object.keys(measured).length)throw new Error('Enter at least one measurement, or restore the saved vitals.');
    const savedVisit=await api(`/api/v1/visits/${visit}/vitals`,'PUT',measured,Number(vitals.dataset.version));
    if(!current())return;rememberVisit(savedVisit,'vitals');changed=true;
   }
  }
  if(!current())return;
  const form=$('note-form');
  if(form&&canDraftNote(activeVisit)&&!noteMatchesSaved(formData(form),activeVisit.note)&&hasVisitNoteText(form)){
   await saveVisitNote(form,formData(form));changed=true;
  }
  if(!changed)break;
 }
 if(current())visitNoteSaveStatus(vitalsNeedReview?'Vitals need review':'Saved');
}
function visitNoteFlush({signing=false,focusVitals=false}={}){
 clearTimeout(visitNoteSaveTimer);visitNoteSaveTimer=null;
 const id=activeVisit?.id,identity=me;
 return visitNoteEnqueue(async()=>{
  if(activeVisit?.id!==id||me!==identity)throw new Error('This page changed. Open the encounter again.');
  visitNoteSaveStatus('Saving…');await visitNoteSaveInputs({signing,focusVitals});
  if(activeVisit?.id!==id||me!==identity)throw new Error('This page changed. Open the encounter again.');
  if(typeof visitDiagnosisAutosave!=='undefined'){
   clearTimeout(visitDiagnosisAutosave.timer);
   while(visitDiagnosisAutosave.busy)await new Promise(resolve=>setTimeout(resolve,30));
   const form=$('visit-diagnoses-form');
   if(form&&visitDiagnosisDrafts.has(id)){
    if(!visitDiagnosisReady(form))throw new Error('Review the diagnosis edits before signing.');
    const submitted=visitDiagnosisFormValues(form);visitDiagnosisPending.set(id,submitted);
    await finishVisitDiagnosisSave(form,submitted,me,false);
   }
  }
 });
}
function visitNoteInlineDiagnosesMarkup(){return '<section data-note-inline="diagnoses"><h4>Diagnoses</h4><div id="note-diagnosis-chips" class="actions"></div><label>ICD-10 search<input data-note-code-search="diagnosis" autocomplete="off" placeholder="Search, then Enter to add"></label><div id="note-diagnosis-results" class="actions" role="status"></div><button type="button" data-note-suggest hidden>Suggest diagnoses</button><span data-note-suggest-status role="status"></span><div id="note-diagnosis-suggestions" class="actions"></div></section>';}
function visitNoteInlineProceduresMarkup(){return '<section data-note-inline="procedures"><h4>Procedures</h4><div id="note-bundles" class="actions"></div><label>Practice code search<input data-note-code-search="procedure" autocomplete="off" placeholder="Search, then Enter to add"></label><div id="note-procedure-results" class="actions" role="status"></div><div id="note-procedure-chips"></div><p class="muted">From the last encounter — choose to add:</p><div id="note-previous-procedures" class="actions"></div></section>';}
const visitNoteSearches=new Map();
let visitNoteSearchTimer=null;
async function visitNoteInlineMount(){
 const id=activeVisit?.id,identity=me;
 if(typeof chargeBundlesLoad==='function')await chargeBundlesLoad();
 if(activeVisit?.id!==id||me!==identity)return;
 if(typeof encounterChargeTableInline==='function')encounterChargeTableInline();
 const bundles=$('note-bundles');if(bundles)bundles.innerHTML=(typeof chargeBundles==='undefined'?[]:chargeBundles||[]).map(bundle=>`<button type="button" data-note-bundle="${esc(bundle.id)}">${esc(bundle.name)}</button>`).join('');
 visitNoteInlinePaint();
 const prior=typeof chargeEarlierAccount==='function'?chargeEarlierAccount(id,typeof revenueServiceDate==='function'?revenueServiceDate():''):null;
 const host=$('note-previous-procedures');
 if(host){
  host.noteLines=prior?.content?.lines?.map(chargeLineProposed)||[];
  host.innerHTML=host.noteLines.map((line,i)=>`<button type="button" data-note-previous-procedure="${i}">+ ${esc(line.code)}${line.modifiers?' · '+esc(line.modifiers):''} × ${line.units}</button>`).join('');
  const choices=host.closest?.('[data-previous-procedure-choices]');
  if(choices)choices.hidden=!host.noteLines.length||encounterChargeAccount()?.status==='posted';
 }
}
function visitNoteInlinePaint(){
 const id=activeVisit?.id,rows=typeof visitDiagnosisStates==='undefined'?[]:visitDiagnosisStates.get(id)?.diagnoses||[];
 const host=$('note-diagnosis-chips');if(host)host.innerHTML=rows.map((row,i)=>`<span class="badge">${String.fromCharCode(65+i)} · ${esc(row.code)} · ${esc(row.display)} <button type="button" data-note-remove-diagnosis="${esc(row.code)}" aria-label="Remove ${esc(row.code)}">×</button></span>`).join('');
 const chips=$('note-procedure-chips'),form=$('billing-account-form');
 if(chips&&!form&&typeof encounterChargeAccount==='function')chips.innerHTML=(encounterChargeAccount()?.content?.lines||[]).map(line=>`<span class="badge">${esc(line.code)} × ${line.units}</span>`).join('');
 if(chips&&form&&typeof chargeLiveRows==='function')chips.innerHTML=chargeLiveRows(form).map((row,i)=>{const line=chargeRowValue(row);if(!line.code)return '';return `<div class="actions"><b>${esc(line.code)}</b><span>${line.amount_cents==null?`Price needed <label>Amount<input inputmode="decimal" aria-label="Amount for ${esc(line.code)}" data-note-charge-index="${i}" data-note-charge-field="amount" value=""></label>`:money(line.amount_cents)}</span><label>Modifiers<input data-note-charge-index="${i}" data-note-charge-field="modifiers" value="${esc(line.modifiers||'')}" maxlength="100"></label><label>Units<input type="number" min="1" max="1000" data-note-charge-index="${i}" data-note-charge-field="units" value="${line.units}"></label><button type="button" data-note-remove-procedure="${i}">×</button></div>`;}).join('');
 if(typeof visitNoteSuggestPaint==='function')visitNoteSuggestPaint();
}
async function visitNoteAddProcedures(lines){
 if(!billingCan('create'))throw new Error('You do not have permission to change charges.');
 if(encounterChargeAccount()?.status==='posted')throw new Error('Charges are posted. Add a correction from Billing.');
 if(!$('billing-account-form'))encounterChargeTableInline();
 const form=$('billing-account-form');if(!form)throw new Error('Open Charges & claim to add procedures.');
 const added=chargeLinesAppend(lines);
 if(!added.length)throw new Error('These charges could not be added. Review Charges & claim.');
 await loadChargeEncounterDiagnoses(form);
 if(typeof loadFeeContext==='function')await loadFeeContext(form);
 for(const row of added)if(typeof checkFee==='function')await checkFee(form,row,true);
 visitNoteInlinePaint();
}
async function visitNoteSearch(input){
 const kind=input.dataset.noteCodeSearch,id=activeVisit?.id,identity=me,query=input.value.trim();
 if(!query)return;
 const params=kind==='diagnosis'?new URLSearchParams({system:'ICD-10-CM',q:query,service_date:terminologyServiceDate('diagnosis',$('note-form')),billable:'true',active:'true',limit:'12'}):new URLSearchParams({q:query});
 const result=await api(kind==='diagnosis'?`/api/v1/terminology/codes?${params}`:`/api/v1/patients/${encodeURIComponent(selected)}/procedure-codes?${params}`);
 if(activeVisit?.id!==id||identity!==me||!input.isConnected||input.value.trim()!==query)return;
 visitNoteSearches.set(kind,{id,identity,input,query,items:result.items||[]});
 const host=$(`note-${kind}-results`);if(host)host.innerHTML=(result.items||[]).map((item,i)=>`<button type="button" data-note-search-pick="${kind}" data-note-search-index="${i}">+ ${esc(item.code)}${kind==='diagnosis'?' · '+esc(item.display||''):''}</button>`).join('')||'No matching codes.';
}
async function visitNoteSearchPick(kind,index=0){
 const state=visitNoteSearches.get(kind),item=state?.items[index];
 if(!item||state.id!==activeVisit?.id||state.identity!==me||state.query!==state.input.value.trim())return;
 if(kind==='diagnosis')await visitDiagnosisInlineChange(item);
 else await visitNoteAddProcedures([{...item,code_system:item.code_system||item.system||chargeCodeSystem(item),description:item.display||item.description||item.code,units:item.default_units||item.units||1,...(item.price_cents!=null?{amount_cents:item.price_cents*(item.default_units||item.units||1)}:{}),diagnosis_codes:[]}]);
 state.input.value='';$(`note-${kind}-results`).replaceChildren();visitNoteSearches.delete(kind);
}
document.addEventListener('input',event=>{
 const input=event.target;
 if(!input.dataset?.noteCodeSearch)return;
 clearTimeout(visitNoteSearchTimer);visitNoteSearchTimer=setTimeout(()=>void visitNoteSearch(input).catch(error=>showVisitNoteMessage(error.message)),250);
});
document.addEventListener('keydown',event=>{
 if(event.key!=='Enter'||!event.target.dataset?.noteCodeSearch)return;
 event.preventDefault();clearTimeout(visitNoteSearchTimer);
 void visitNoteEnqueue(async()=>{await visitNoteSearch(event.target);await visitNoteSearchPick(event.target.dataset.noteCodeSearch);}).catch(error=>showVisitNoteMessage(error.message));
});
document.addEventListener('change',event=>{
 const input=event.target,index=input.dataset?.noteChargeIndex;if(index==null)return;
 const form=$('billing-account-form'),row=chargeLiveRows(form)[Number(index)],field=row?.querySelector(`[name="${input.dataset.noteChargeField}"]`);
 if(!field)return;field.value=input.value;field.dispatchEvent(new Event('change',{bubbles:true}));
 captureBillingChargeDraft();scheduleChargeAutosave(form);
});
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button'),data=button?.dataset;if(!data)return;
 let work=null;
 if(data.noteBundle)work=()=>visitNoteAddProcedures((chargeBundles||[]).find(bundle=>bundle.id===data.noteBundle)?.lines||[]);
 else if(data.notePreviousProcedure!=null)work=async()=>{await visitNoteAddProcedures([$('note-previous-procedures').noteLines[Number(data.notePreviousProcedure)]]);button.disabled=true;};
 else if(data.noteSearchPick)work=()=>visitNoteSearchPick(data.noteSearchPick,Number(data.noteSearchIndex));
 else if(data.noteRemoveDiagnosis)work=()=>visitDiagnosisInlineChange(null,data.noteRemoveDiagnosis);
 else if(data.noteRemoveProcedure!=null)work=()=>{const form=$('billing-account-form'),row=chargeLiveRows(form)[Number(data.noteRemoveProcedure)];row?.querySelector('[data-remove-charge]')?.click();visitNoteInlinePaint();};
 if(work){event.preventDefault();void visitNoteEnqueue(work).catch(error=>showVisitNoteMessage(error.message));}
});
