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
async function shellFindPatient(){
 await showClinical();
 $('clinical-workspace').classList.remove('directory-collapsed');
 $('toggle-directory').setAttribute('aria-expanded','true');
 $('toggle-directory').title='Hide patient directory';
 $('search').focus();
 $('search').select();
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
