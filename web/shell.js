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
// Global search is independent of the patient-only pickers embedded in forms.
let shellFindDialog=null;
async function shellFindPatient(){return openGlobalSearch();}
function openGlobalSearch(){
 if(shellFindDialog?.isConnected){shellFindDialog.querySelector('[data-global-query]')?.focus();return;}
 const identity=me,panel=document.createElement('div');panel.className='global-search';
 panel.innerHTML='<label for="global-search-query">Search</label><input id="global-search-query" data-global-query type="search" autocomplete="off" maxlength="150" placeholder="Patients, records, pages and actions" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="global-search-results"><div id="global-search-results" role="listbox" aria-label="Search results"></div><p data-global-status role="status" aria-live="polite">Type at least 2 characters.</p>';
 const dialog=sheetOpen('Search',panel);dialog.classList.add('global-search-sheet');dialog.setAttribute('aria-label','Search');shellFindDialog=dialog;
 const input=panel.querySelector('[data-global-query]'),results=panel.querySelector('#global-search-results'),status=panel.querySelector('[data-global-status]');
 let timer,generation=0,groups=[],choices=[],active=-1;
 const current=()=>dialog.isConnected&&!dialog.dataset.closing&&shellFindDialog===dialog&&me===identity;
 const close=()=>{clearTimeout(timer);generation++;if(shellFindDialog===dialog)shellFindDialog=null;sheetClose(dialog);};
 dialog.addEventListener('close',()=>{clearTimeout(timer);generation++;groups=[];choices=[];results.replaceChildren();input.value='';if(shellFindDialog===dialog)shellFindDialog=null;},{once:true});
 function highlight(index){
  active=index;results.querySelectorAll('[data-global-choice]').forEach((node,i)=>{node.setAttribute('aria-selected',String(i===active));if(i===active){input.setAttribute('aria-activedescendant',node.id);node.scrollIntoView?.({block:'nearest'});}});
  if(active<0)input.removeAttribute('aria-activedescendant');
 }
 function render(){
  choices=[];
  results.innerHTML=groups.filter(g=>g.items.length).map(g=>`<section role="group" aria-label="${esc(g.label)}"><h3>${esc(g.label)}</h3>${g.items.map(item=>{const i=choices.push(item)-1;return `<button type="button" role="option" tabindex="-1" id="global-choice-${i}" data-global-choice="${i}" aria-selected="false"><strong>${esc(item.title||'Record')}</strong><small>${esc(item.detail||'')}</small></button>`;}).join('')}${g.more?`<button type="button" data-global-more="${esc(g.key)}">Show all ${esc(g.label.toLowerCase())} · next results</button>`:''}</section>`).join('');
  if(!choices.length){status.textContent=`Nothing matches “${input.value.trim()}”`;if(canRegisterPatient()){choices.push({kind:'actions',id:'new-patient'});results.innerHTML='<button type="button" role="option" id="global-choice-0" data-global-choice="0" aria-selected="false">New patient</button>';}}
  else status.textContent=`${choices.length} results. Use arrow keys and Enter to open.`;
  highlight(choices.length?0:-1);
 }
 async function load(key){
  const request=++generation,query=input.value.trim(),previous=groups.find(g=>g.key===key);
  status.textContent='Searching…';
  try{
   const data=await api('/api/v1/search?'+new URLSearchParams({q:query,limit:5,...(key?{group:key,offset:previous.offset+previous.items.length}:{})}));
   if(!current()||request!==generation||input.value.trim()!==query)return;
   if(key){const next=data.groups.find(g=>g.key===key);groups=groups.map(g=>g.key===key?next:g);}else groups=data.groups;
   render();
  }catch(error){if(current()&&request===generation){groups=[];choices=[];results.replaceChildren();status.textContent='Search could not be loaded. Try again.';}}
 }
 input.addEventListener('input',()=>{
  clearTimeout(timer);generation++;groups=[];choices=[];active=-1;results.replaceChildren();input.removeAttribute('aria-activedescendant');
  if(me!==identity){close();return;}
  status.textContent=input.value.trim().length<2?'Type at least 2 characters.':'Searching…';
  if(input.value.trim().length>=2)timer=setTimeout(()=>load(),150);
 });
 dialog.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();return;}
  if(event.target!==input)return;
  if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(choices.length)highlight((active+(event.key==='ArrowDown'?1:active<0?0:-1)+choices.length)%choices.length);}
  if(event.key==='Enter'){event.preventDefault();if(active>=0&&choices[active]&&current()){const item=choices[active];close();run(()=>openGlobalSearchResult(item,identity));}}
 });
 results.addEventListener('click',event=>{
  const choice=event.target.closest('[data-global-choice]'),more=event.target.closest('[data-global-more]');
  if(!current())return;
  if(choice){const item=choices[Number(choice.dataset.globalChoice)];if(item){close();run(()=>openGlobalSearchResult(item,identity));}}
  else if(more)void load(more.dataset.globalMore);
 });
 input.focus();
}
async function openGlobalSearchResult(item,identity=me){
 if(me!==identity)return;
 if(item.kind==='actions'){
  if(item.id==='schedule')return showSchedule();
  if(item.id==='billing')return showPatientBillingWorkspace({patientId:null,tab:'overview'});
  if(item.id==='billing-setup')return showBillingOrganizations();
  if(item.id==='new-appointment'){await showSchedule();if(me===identity)await appointmentEditor();return;}
  if(item.id==='new-patient'){await showClinical();if(me===identity&&canRegisterPatient()){$('patient-form').hidden=false;$('patient-form').elements.given_name.focus();}return;}
 }
 if(item.kind==='claims'){await showClaimsWorkspace();if(me===identity)return showClaim(item.id);return;}
 if(item.kind==='appointments'){
  const ap=await api(`/api/v1/appointments/${item.id}`);if(me!==identity)return;
  await showSchedule();if(me!==identity)return;scheduleDate=scheduleDayKey(new Date(ap.starts_at));await showSchedule();if(me===identity)await appointmentDetail(item.id);return;
 }
 await selectPatient(item.patient_id);if(me!==identity||selected!==item.patient_id)return;
 if(item.kind==='encounters'){
  if(!workspace.visits.some(v=>v.id===item.id)){const visit=await api(`/api/v1/visits/${item.id}`);if(me!==identity||selected!==item.patient_id)return;if(visit.patient_id!==selected)throw new Error('Encounter does not belong to this patient.');workspace.visits.push(visit);}
  return openPatientEncounter(item.id);
 }
 if(item.kind==='files'){
  showChartSection('documents');await renderDocuments();if(me!==identity||selected!==item.patient_id)return;
  const record=await api(`/api/v1/patients/${selected}/documents/${item.id}`);if(me!==identity||selected!==item.patient_id)return;
  const state=documentStates.get(selected);if(!state.items.some(d=>d.id===item.id))state.items.push(record);state.status='';state.category='';state.fileSearch='';return openDocumentFile(item.id);
 }
 if(item.kind==='payments'){
  if(item.source==='ledger'){showChartSection('billing');return openEncounterBillingAccount(item.account_id);}
  const data=await api(`/api/v1/billing/copay-receipts/${item.id}`);if(me!==identity||selected!==item.patient_id)return;return showCopayReceipt(item.id,data.receipt.appointment_id);
 }
 if(item.kind==='orders'){const labs=await api(`/api/v1/patients/${selected}/orders`);if(me!==identity||selected!==item.patient_id)return;workspace.labs=labs;showChartSection('orders');showOrder(item.id);return;}
 if(item.kind==='referrals'){
  showChartSection('referrals');await renderReferrals();if(me!==identity||selected!==item.patient_id)return;
  const record=await api(`/api/v1/patients/${selected}/referrals/${item.id}`);if(me!==identity||selected!==item.patient_id)return;
  const state=referralStates.get(selected);if(!state.items.some(r=>r.id===item.id))state.items.push(record);state.status='';showReferrals();
  const source=$('referral-record-'+item.id),host=document.createElement('div');host.append(source.content.cloneNode(true));sheetOpen('Referral',host);
 }
}
$('shell-search-shortcut').textContent=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ K':'Ctrl K';
new MutationObserver(updateShellContext).observe($('page-title'),{childList:true,subtree:true,characterData:true});
new MutationObserver(updateShellContext).observe($('sidebar'),{attributes:true,attributeFilter:['class']});
updateShellContext();
$('shell-find-patient').addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();if(me)run(shellFindPatient);});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!['shell-find-patient','shell-nav-dismiss'].includes(button.id))return;
 event.preventDefault();event.stopImmediatePropagation();
 if(button.id==='shell-nav-dismiss'){closeNavigation();$('nav-toggle').focus();return;}
 if(me)run(shellFindPatient);
},true);
document.addEventListener('keydown',event=>{
 if($('app')?.hasAttribute('inert'))return;
 if(event.key==='Enter'&&event.target.closest?.('#shell-find-patient')&&me){event.preventDefault();event.stopImmediatePropagation();run(shellFindPatient);return;}
 if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='k'&&me){
  event.preventDefault();event.stopImmediatePropagation();run(shellFindPatient);
 }
},true);
