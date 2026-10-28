// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let practiceAdminState,practiceAdminGeneration=0;
const practiceAdminRoles=[['owner','Practice owner'],['clinician','Clinician'],['nurse','Nurse'],['medical_assistant','Medical assistant'],['front_desk','Front desk'],['read_only','Read only']];
const practiceAdminKinds=[['staff','Staff accounts'],['providers','Provider directory'],['facilities','Facilities'],['rooms','Rooms']];
async function showPracticeAdmin(){
 if(me?.role!=='owner')throw new Error('Practice owner access is required.');
 if(typeof captureVisitDrafts==='function')captureVisitDrafts();
 const generation=++practiceAdminGeneration;
 const values=await Promise.all(practiceAdminKinds.map(([kind])=>api(`/api/v1/practice/${kind}`)));
 if(generation!==practiceAdminGeneration||me?.role!=='owner')return;
 practiceAdminState={...Object.fromEntries(practiceAdminKinds.map(([k],i)=>[k,values[i]])),tab:practiceAdminState?.tab||'staff'};
 showTool('Practice administration');
 $('tools').innerHTML='<section id="practice-admin-panel" class="panel"></section>';$('tools').hidden=false;
 renderPracticeAdmin();
}
function practiceAdminInput(name,label,value,max,type='text',required=false){return `<label>${esc(label)}<input name="${name}" type="${type}" maxlength="${max}" value="${esc(value||'')}" ${required?'required':''} autocomplete="${type==='password'?'new-password':'off'}"></label>`;}
function practiceAdminSelect(name,label,options,value){return `<label>${esc(label)}<select name="${name}" required>${options.map(([key,label])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;}
function practiceAdminLabel(kind,row){return row.display_name||row.name||row.email||row.id;}
function renderPracticeAdmin(){
 const s=practiceAdminState,target=$('practice-admin-panel');if(!s||!target)return;
 const kind=s.tab,items=s[kind].items,staffLabel=id=>{const row=s.staff.items.find(x=>x.id===id);return row?`${row.display_name||row.email} · ${row.email}`:'Staff identity not in loaded directory';},facilityLabel=id=>s.facilities.items.find(x=>x.id===id)?.name||'Facility not in loaded directory';
 const headers={staff:['Staff member','Role','Access'],providers:['Provider','Staff account / specialty','Status'],facilities:['Facility','Address / phone','Status'],rooms:['Room','Facility','Status']};
 const cells=row=>kind==='staff'?`<td><strong>${esc(row.display_name||row.email)}</strong><small>${esc(row.email)}${row.id===me.user_id?' · Your account':''}</small></td><td>${esc(practiceAdminRoles.find(([key])=>key===row.role)?.[1]||row.role)}</td><td>${row.disabled?'Disabled':'Enabled'}</td>`:kind==='providers'?`<td><strong>${esc(row.display_name)}</strong><small>${esc(row.npi?'NPI '+row.npi:'NPI not recorded')}</small></td><td>${esc(staffLabel(row.id))}<small>${esc(row.specialty||'Specialty not recorded')}</small></td><td>${row.active?'Active':'Inactive'}</td>`:kind==='facilities'?`<td><strong>${esc(row.name)}</strong></td><td>${esc(row.address||'Address not recorded')}<small>${esc(row.phone||'Phone not recorded')}</small></td><td>${row.active?'Active':'Inactive'}</td>`:`<td><strong>${esc(row.name)}</strong></td><td>${esc(facilityLabel(row.facility_id))}</td><td>${row.active?'Active':'Inactive'}</td>`;
 target.innerHTML=`<div class="section-head"><div><h2>Practice administration</h2><p class="muted">Manage local staff access and the practice directory.</p></div><button type="button" data-admin-refresh>Refresh directory</button></div><nav class="chart-tabs" aria-label="Practice administration">${practiceAdminKinds.map(([key,label])=>`<button type="button" data-admin-tab="${key}" aria-pressed="${key===kind}">${label} <span class="pill">${s[key].items.length}${s[key].has_more?'+':''}</span></button>`).join('')}</nav><section><div class="section-head"><h3>${esc(practiceAdminKinds.find(([k])=>k===kind)[1])}</h3><button type="button" class="primary" data-admin-new>Add ${esc({staff:'staff account',providers:'provider',facilities:'facility',rooms:'room'}[kind])}</button></div>${kind==='staff'?'<p class="muted">Role changes, enabling/disabling access and password resets revoke existing browser sessions and delegated grants. At least one enabled owner must remain.</p>':kind==='providers'?'<p class="muted">Provider profiles belong to enabled owner or clinician accounts. NPI checks validate format and checksum, not enrollment or licensure.</p>':'<p class="muted">Directory changes do not rewrite the saved location text on existing appointments. Disable all active rooms before disabling a facility.</p>'}<label>Filter loaded directory<input type="search" data-admin-filter placeholder="Search names, roles or locations" autocomplete="off"></label>${s[kind].has_more?'<p class="notice">Only the first 1,000 records are loaded. This view does not provide an exhaustive directory.</p>':''}<div class="practice-table-wrap"><table class="practice-table"><caption class="sr-only">${esc(practiceAdminKinds.find(([k])=>k===kind)[1])}</caption><thead><tr>${headers[kind].map(t=>`<th scope="col">${t}</th>`).join('')}<th scope="col">Actions</th></tr></thead><tbody>${items.map(row=>`<tr data-admin-row><td hidden>${esc(JSON.stringify(row))}</td>${cells(row)}<td><button type="button" data-admin-edit="${esc(row.id)}">Edit</button> <button type="button" data-admin-history="${esc(row.id)}">History</button></td></tr>`).join('')||'<tr><td colspan="4">No records yet. Add the first record to get started.</td></tr>'}</tbody></table></div><p data-admin-filter-empty hidden>No matching records in the loaded directory.</p><div id="practice-admin-editor"></div><div id="practice-admin-history"></div></section>`;
}
function editPracticeAdmin(id){
 const s=practiceAdminState,kind=s.tab,row=id?s[kind].items.find(x=>x.id===id):null;if(id&&!row)return;
 s.editing=row||null;
 const input=(name,label,max,type='text',required=false)=>practiceAdminInput(name,label,row?.[name],max,type,required);
 let fields='';
 if(kind==='staff')fields=`${row?`<p>Sign-in email: <b>${esc(row.email)}</b></p>`:input('email','Sign-in email',254,'email',true)}${input('display_name','Display name',200,'text',true)}${practiceAdminSelect('role','Role',practiceAdminRoles,row?.role||'front_desk')}${row?practiceAdminSelect('disabled','Access',[['false','Enabled'],['true','Disabled']],String(row.disabled)):''}${practiceAdminInput('password',row?'New password (leave blank to keep current password)':'Initial password (at least 14 characters)','',1024,'password',!row)}<p class="muted">Share initial credentials securely with the staff member. Passwords are never shown again. This preview does not send invitations or require a first-login password change.</p>`;
 if(kind==='providers'){
 const choices=s.staff.items.filter(x=>!x.disabled&&['owner','clinician'].includes(x.role)&&(!s.providers.items.some(p=>p.id===x.id)||row?.id===x.id)).map(x=>[x.id,`${x.display_name||x.email} · ${x.email}`]);
 if(!row&&!choices.length){$('practice-admin-editor').innerHTML='<p class="notice">Add an enabled clinician or owner staff account before creating its provider profile.</p>';return;}
 fields=`${row?`<p>Staff account: ${esc(s.staff.items.find(x=>x.id===row.id)?.email||row.id)}<input type="hidden" name="staff_id" value="${esc(row.id)}"></p>`:practiceAdminSelect('staff_id','Staff account',choices,choices[0]?.[0])}${input('display_name','Provider display name',200,'text',true)}${input('npi','NPI (optional)',10)}${input('specialty','Specialty',200)}`;
 }
 if(kind==='facilities')fields=input('name','Facility name',200,'text',true)+input('address','Address',1000)+input('phone','Phone',40);
 if(kind==='rooms'){
 const choices=s.facilities.items.filter(x=>x.active||x.id===row?.facility_id).map(x=>[x.id,x.name+(x.active?'':' (inactive)')]);
 if(!choices.length){$('practice-admin-editor').innerHTML='<p class="notice">Add an active facility before creating a room.</p>';return;}
 fields=practiceAdminSelect('facility_id','Facility',choices,row?.facility_id||choices[0][0])+input('name','Room name',100,'text',true);
 }
 if(kind!=='staff')fields+=practiceAdminSelect('active','Directory status',[['true','Active'],['false','Inactive']],String(row?.active??true));
 $('practice-admin-editor').innerHTML=`<section class="panel"><h3>${row?'Edit':'Add'} ${esc({staff:'staff account',providers:'provider',facilities:'facility',rooms:'room'}[kind])}</h3><form id="practice-admin-form"><div class="chart-summary-grid">${fields}</div>${practiceAdminInput('reason','Reason for change','',1000,'text',true)}<p role="alert" data-admin-error class="notice error" hidden></p><div class="actions"><button type="submit" class="primary">${row?'Save changes':'Create record'}</button><button type="button" data-admin-cancel>Cancel</button></div></form></section>`;
 $('practice-admin-editor').scrollIntoView({block:'nearest'});$('practice-admin-form').querySelector('input:not([type="hidden"]),select')?.focus();
}
async function savePracticeAdmin(form){
 if(form.dataset.saving==='true')return;
 const s=practiceAdminState,kind=s.tab,row=s.editing,values=Object.fromEntries(new FormData(form));
 if(kind==='staff'){if(row){values.disabled=values.disabled==='true';if(!values.password)delete values.password;}else if(values.password.length<14){throw new Error('The initial password must contain at least 14 characters.');}}
 else values.active=values.active==='true';
 form.dataset.saving='true';const controls=[...form.querySelectorAll('button,input,select')];controls.forEach(c=>c.disabled=true);
 try{
  await api(`/api/v1/practice/${kind}${row?'/'+row.id:''}`,row?'PUT':'POST',values,row?.version);
  // The edited owner may have revoked their own session. Reauthenticate before
  // refreshing so the page does not suggest the old role is still available.
  if(kind==='staff'&&row?.id===me?.user_id){me=await api('/auth/me');if(me.role!=='owner'){await enter();return;}}
  if(form.isConnected){await showPracticeAdmin();notice('Practice record saved.');}
 }catch(error){if(form.isConnected){const alert=form.querySelector('[data-admin-error]');alert.textContent=error.message+' Reload before retrying if the outcome is uncertain.';alert.hidden=false;}}
 finally{if(form.elements.password)form.elements.password.value='';delete form.dataset.saving;controls.forEach(c=>{if(c.isConnected)c.disabled=false;});}
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button?.closest('#practice-admin-panel'))return;
 if(button.hasAttribute('data-admin-refresh'))run(showPracticeAdmin);
 if(button.dataset.adminTab){practiceAdminState.tab=button.dataset.adminTab;renderPracticeAdmin();}
 if(button.hasAttribute('data-admin-new'))editPracticeAdmin();
 if(button.dataset.adminEdit)editPracticeAdmin(button.dataset.adminEdit);
 if(button.hasAttribute('data-admin-cancel')){$('practice-admin-form')?.reset();$('practice-admin-editor').replaceChildren();practiceAdminState.editing=null;}
 if(button.dataset.adminHistory)run(async()=>{
  const state=practiceAdminState,kind=state.tab,id=button.dataset.adminHistory,map={staff:'staff',providers:'provider',facilities:'facility',rooms:'room'},data=await api(`/api/v1/practice/admin-history/${map[kind]}/${id}`);
  if(!button.isConnected||practiceAdminState!==state||state.tab!==kind)return;
  $('practice-admin-history').innerHTML=`<section class="panel"><h3>Revision history · ${esc(practiceAdminLabel(kind,state[kind].items.find(x=>x.id===id)||{}))}</h3>${data.items.map(r=>`<article class="amendment"><strong>Revision ${esc(r.version)}</strong><p>${esc(r.reason)}</p><small>${esc(date(r.created_at))} · Staff ${esc(r.actor_id)}</small><details><summary>Saved values</summary><dl>${Object.entries(r.content).map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details></article>`).join('')||'<p>No administrative revisions recorded. Existing bootstrap accounts have no creation revision.</p>'}${data.has_more?'<p>Latest 100 revisions shown. Earlier history remains retained.</p>':''}</section>`;
 });
});
document.addEventListener('input',event=>{
 if(!event.target.hasAttribute('data-admin-filter'))return;
 const query=event.target.value.trim().toLocaleLowerCase(),rows=[...$('practice-admin-panel').querySelectorAll('[data-admin-row]')];for(const row of rows)row.hidden=!row.textContent.toLocaleLowerCase().includes(query);
 $('practice-admin-panel').querySelector('[data-admin-filter-empty]').hidden=!rows.length||rows.some(r=>!r.hidden);
});
document.addEventListener('submit',event=>{if(event.target.id!=='practice-admin-form')return;event.preventDefault();savePracticeAdmin(event.target).catch(e=>{const box=event.target.querySelector('[data-admin-error]');box.textContent=e.message;box.hidden=false;});});
