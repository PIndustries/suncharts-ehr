// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// "Same as last visit": brings the text of the patient's most recent signed note into the
// note being written. The earlier note is only read. Loaded text and undo steps live in
// this tab only and are dropped when the signed-in person changes.
const visitNoteSources=new Map(),visitNoteUndo=new Map(),visitNotePeople=new Map();
function clearVisitNoteSession(){visitNoteSources.clear();visitNoteUndo.clear();visitNotePeople.clear();}
function visitNoteSaved(visit){if(!visit)return;visitNoteUndo.delete(visit.id);visitNoteBar(visit.id);if($('note-message')?.isConnected!==false)showVisitNoteMessage('Note saved.');showVisitNoteAuthorship();}
// Messages shown beside Save note and Sign encounter note, where the person just clicked.
function showVisitNoteMessage(message){
 const host=$('note-message');if(!host||host.isConnected===false)return;
 host.textContent=message;host.hidden=!message;
}
function hideVisitNoteMessage(){const host=$('note-message');if(host&&host.isConnected!==false){host.textContent='';host.hidden=true;}}
// A draft needs at least some text; signing needs Subjective, Objective, Assessment and Plan.
function hasVisitNoteText(form){return noteSectionKeys.some(key=>String(form?.elements[key]?.value??'').trim());}
function noteMissingForSign(form){return noteSectionKeys.slice(0,4).filter(key=>!String(form?.elements[key]?.value??'').trim());}
function refuseVisitNoteSigning(form,missing){
 showVisitNoteMessage(`Fill in ${visitNoteNames(missing)} before signing.`);
 form?.elements?.[missing[0]]?.focus?.();
}
// Names of the people on a note: who the visit is assigned to, who signed it and who corrected it.
// The signed-in person is known already; anyone else is asked for once per saved version.
function visitNotePersonIds(visit){return [visit.clinician_id,visit.signed_by,...(workspace?.amendments||[]).filter(a=>a.visit_id===visit.id).map(a=>a.author_id)].filter(Boolean);}
function visitNotePerson(visit,id){
 if(id&&id===me?.user_id&&me.display_name)return me.display_name;
 const entry=visitNotePeople.get(visit.id);return entry?.identity===me?entry.names[id]||'':'';
}
function visitNoteAuthorshipLine(visit){
 const parts=[],assigned=visitNotePerson(visit,visit.clinician_id),by=visit.note?.saved_by;
 if(visit.clinician_id!==me?.user_id&&canDraftNote(visit)&&assigned)parts.push(`Drafting for ${assigned}`);
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
function visitNoteCurrent(visitId){const form=$('note-form');return activeVisit?.id===visitId&&activeVisit.status!=='signed'&&form?.isConnected!==false&&form?.dataset?.visitId===visitId?form:null;}
function visitNoteLabel(key){return key[0].toUpperCase()+key.slice(1);}
function visitNoteNames(keys){const names=keys.map(visitNoteLabel);return names.length>1?`${names.slice(0,-1).join(', ')} and ${names.at(-1)}`:names[0]||'';}
function visitNoteFrom(source){const day=noteDay(source.visit_date);return (source.own??source.same_clinician)?`your visit on ${day}`:source.clinician_name?`${source.clinician_name}’s visit on ${day}`:`another clinician’s visit on ${day}`;}
function visitNoteValues(form){return Object.fromEntries(noteSectionKeys.map(key=>[key,String(form.elements[key]?.value??'')]));}
function visitNoteBar(visitId,message=''){
 const host=$('note-previous'),form=visitNoteCurrent(visitId),entry=visitNoteSources.get(visitId);if(!host||!form||!entry||entry.identity!==me)return;
 const source=entry.source,undo=visitNoteUndo.get(visitId)?.length;
 for(const key of noteSectionKeys){const link=$('note-same-'+key);if(link)link.hidden=!source||!source.note[key].trim();}
 host.hidden=false;
 if(entry.failed){host.innerHTML='<span class="muted">The last note could not be checked.</span><button type="button" class="text-button" data-note-retry>Try again</button>';return;}
 if(!source){host.innerHTML='<span class="muted">No earlier signed note for this patient.</span>';return;}
 const empty=Object.values(visitNoteValues(form)).every(text=>!text.trim());
 host.innerHTML=`<button type="button" class="${empty?'primary':''}" data-note-same="all">Same as last visit</button><span class="muted">From ${esc(visitNoteFrom(source))}</span><span id="note-previous-status" class="note-previous-status" role="status">${esc(message)}</span>${undo?'<button type="button" class="text-button" data-note-undo>Undo</button>':''}`;
 // Replacing the bar removes the button that was just used; keep keyboard focus in the bar.
 if(message&&typeof document!=='undefined'&&(!document.activeElement||document.activeElement===document.body))host.querySelector?.('[data-note-undo],[data-note-same]')?.focus?.({preventScroll:true});
}
function visitNoteSourceUpdated(form){
 const line=$('note-source-line'),text=noteSourceText(form.elements.started_from?.value);
 if(line){line.textContent=noteSourceLine(text,false,activeVisit?.note?.started_from);line.hidden=!text;}
 captureVisitDrafts(false);
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
 if(!form||!source||entry.identity!==me)return;
 const offered=(which==='all'?noteSectionKeys:[which]).filter(key=>source.note[key]?.trim()),wanted=offered.filter(key=>visitNoteValues(form)[key]!==source.note[key]);if(!offered.length)return;
 if(!wanted.length){visitNoteBar(visitId,'This already matches the last visit. Nothing was changed.');return;}
 let replace=false;const written=wanted.filter(key=>visitNoteValues(form)[key].trim());
 if(written.length){
  const from=`From ${visitNoteFrom(source)}.`;
  if(which==='all'){
   const answer=await confirmAction('Replace what you have written, or fill only the empty sections?',{eyebrow:'YOUR NOTE HAS TEXT',title:'Same as last visit',detail:`${from} You have written in ${visitNoteNames(written)}.`,confirmLabel:'Fill empty sections',alternateLabel:'Replace what I wrote',cancelLabel:'Cancel'});
   if(!answer)return;replace=answer==='alternate';
  }else{
   if(!await confirmAction(`Replace what you have written in ${visitNoteLabel(which)}?`,{eyebrow:'THIS SECTION HAS TEXT',title:'Same as last visit',detail:from,confirmLabel:'Replace',cancelLabel:'Cancel',initialFocus:'cancel'}))return;replace=true;
  }
 }
 form=visitNoteCurrent(visitId);if(!form||visitNoteSources.get(visitId)!==entry||entry.identity!==me)return;
 const before=visitNoteValues(form),changes={};
 for(const key of wanted){if(before[key]===source.note[key]||(before[key].trim()&&!replace))continue;changes[key]={before:before[key],after:source.note[key]};}
 const keys=Object.keys(changes);
 if(!keys.length){visitNoteBar(visitId,'Every section already has text. Nothing was changed.');return;}
 const sourceBefore=noteSourceText(form.elements.started_from.value),earlier=sourceBefore?JSON.parse(sourceBefore):null;
 for(const key of keys)form.elements[key].value=changes[key].after;
 form.elements.started_from.value=noteSourceText({visit_id:source.visit_id,version:source.version,sections:[...(earlier?.visit_id===source.visit_id?earlier.sections:[]),...keys]});
 const steps=visitNoteUndo.get(visitId)||[];steps.push({changes,sourceBefore,visitId:source.visit_id,version:source.version});visitNoteUndo.set(visitId,steps);
 visitNoteSourceUpdated(form);
 visitNoteBar(visitId,`${visitNoteNames(keys)} brought in. Review before signing.`);
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
 if(button.dataset.noteSame)void applyVisitNoteSource(button.dataset.noteSame).catch(error=>notice(error.message,true));
 else if(Object.hasOwn(button.dataset,'noteUndo'))undoVisitNoteSource();
 else if(Object.hasOwn(button.dataset,'noteRetry')&&activeVisit){visitNoteSources.delete(activeVisit.id);void renderVisitNoteSource();}
});
