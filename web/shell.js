// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
function updateShellContext(){
 const heading=$('page-title');
 $('shell-context').textContent=heading?.textContent||'Practice workspace';
 const now=new Date();
 $('shell-date').dateTime=now.toISOString();
 $('shell-date').textContent=now.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
 $('shell-date').title=now.toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'})+' · '+Intl.DateTimeFormat().resolvedOptions().timeZone;
 $('shell-nav-dismiss').hidden=!$('sidebar').classList.contains('menu-open');
}
// Find a patient (the header button and Ctrl/⌘ K) opens a search window over whatever screen is
// showing. Typing lists matching patients; choosing one opens that patient's chart.
let shellFindDialog=null;
async function shellFindPatient(){
 if(typeof sheetOpen!=='function'||typeof patientPickerMarkup!=='function'||typeof mountPatientPicker!=='function'){
  await showClinical();
  $('clinical-workspace').classList.remove('directory-collapsed');
  $('toggle-directory').setAttribute('aria-expanded','true');
  $('toggle-directory').title='Hide patient directory';
  $('search').focus();
  $('search').select();
  return;
 }
 if(shellFindDialog?.isConnected){shellFindDialog.querySelector('[data-patient-picker-input]')?.focus();return;}
 const panel=document.createElement('div');panel.className='shell-find';
 let dialog=null;
 panel.innerHTML=patientPickerMarkup({label:'Find a patient',placeholder:'Name, date of birth or record number',onchoose:patient=>{
  if(!patient?.id)return;
  if(dialog?.isConnected)(typeof sheetClose==='function'?sheetClose(dialog):dialog.close());
  run(async()=>{await showClinical();await selectPatient(patient.id);});
 }})+'<p class="muted shell-find-hint">Type a name, a date of birth or a record number. Press Enter to open the patient.</p>';
 dialog=sheetOpen('Find a patient',panel);dialog.classList.add('shell-find-sheet');shellFindDialog=dialog;
 dialog.addEventListener('close',()=>{if(shellFindDialog===dialog)shellFindDialog=null;},{once:true});
 mountPatientPicker(panel);
 panel.querySelector('[data-patient-picker-input]')?.focus();
}
$('shell-search-shortcut').textContent=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ K':'Ctrl K';
new MutationObserver(updateShellContext).observe($('page-title'),{childList:true,subtree:true,characterData:true});
new MutationObserver(updateShellContext).observe($('sidebar'),{attributes:true,attributeFilter:['class']});
updateShellContext();
document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!['shell-find-patient','shell-nav-dismiss'].includes(button.id))return;
 event.preventDefault();event.stopImmediatePropagation();
 if(button.id==='shell-nav-dismiss'){closeNavigation();$('nav-toggle').focus();return;}
 if(me)run(shellFindPatient);
},true);
document.addEventListener('keydown',event=>{
 if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='k'&&me){
  event.preventDefault();event.stopImmediatePropagation();run(shellFindPatient);
 }
},true);
