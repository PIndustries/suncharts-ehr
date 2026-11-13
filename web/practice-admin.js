// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let practiceAdminState,practiceAdminGeneration=0;
const practiceAdminRoles=[['owner','Practice owner'],['clinician','Clinician'],['nurse','Nurse'],['medical_assistant','Medical assistant'],['front_desk','Front desk'],['read_only','Read only']];
const practiceAdminKinds=[['staff','Staff accounts'],['providers','Provider directory'],['facilities','Facilities'],['rooms','Rooms']];
async function showPracticeAdmin(requestedTab=null,fresh=false){
 if(me?.role!=='owner')throw new Error('Practice owner access is required.');
 if(typeof captureVisitDrafts==='function')captureVisitDrafts();
 const generation=++practiceAdminGeneration;
 const values=await Promise.all(practiceAdminKinds.map(([kind])=>api(`/api/v1/practice/${kind}`)));
 const billingOrganizations=await api('/api/v1/practice/billing-organizations').catch(()=>null);
 // Staff of a practice that signs in through SunCharts are invited by email; their sign-in status comes with the list.
 const invitations=values[0]?.sign_in==='connect'?await api('/api/v1/practice/staff/invitations'+(fresh?'?fresh=true':'')).catch(()=>null):null;
 if(generation!==practiceAdminGeneration||me?.role!=='owner')return;
 practiceAdminState={...Object.fromEntries(practiceAdminKinds.map(([k],i)=>[k,values[i]])),billingOrganizations,invitations,tab:requestedTab||practiceAdminState?.tab||'staff'};
 showTool('Practice administration');
 $('tools').innerHTML='<section id="practice-admin-panel" class="panel"></section>';$('tools').hidden=false;
 renderPracticeAdmin();
}
function practiceAdminInput(name,label,value,max,type='text',required=false){return `<label>${esc(label)}<input name="${name}" type="${type}" maxlength="${max}" value="${esc(value||'')}" ${required?'required':''} autocomplete="${type==='password'?'new-password':'off'}"></label>`;}
function practiceAdminSelect(name,label,options,value){return `<label>${esc(label)}<select name="${name}" required>${options.map(([key,label])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;}
function practiceStaffInvited(){return practiceAdminState?.staff?.sign_in==='connect';}
function practiceAdminDay(value){const d=new Date(value);return value&&!Number.isNaN(d.getTime())?d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'';}
const practiceInvitationReasons={unreachable:'We could not reach SunCharts just now. Try again in a few minutes.',email_refused:'SunCharts could not use this email address. Check it for typos.',plan:'Your SunCharts plan needs attention before new staff can be invited. Contact support.',busy:'Too many invitations were sent in the last hour. Try again later.',not_allowed:'This practice’s connection to SunCharts needs attention. Contact support.',email_not_delivered:'The email could not be delivered. Check the address, then send it again.',delivery_unknown:'We could not confirm the email went out. Send it again.',refused:'SunCharts did not accept the request. Try again, or contact support if it keeps happening.'};
const practiceAccessOff='This person’s SunCharts access was turned off. Contact support to turn it back on.';
function practiceInvitationReason(invitation){return practiceInvitationReasons[invitation?.reason]||practiceInvitationReasons.refused;}
// What the owner is told right after an invitation is asked for. `created` is true when the account was just added.
function practiceInvitationMessage(name,invitation,created=false){
 if(invitation?.status==='can_sign_in')return `${name} already has a SunCharts account for this practice and can sign in now.`;
 if(invitation?.status==='waiting')return invitation.reason==='partner_delivery'?`An invitation was created for ${name}. Your SunCharts provider will pass it on. They sign in with that email once they accept it.`:`We emailed ${name} an invitation. They sign in with that email once they accept it.`;
 if(invitation?.status==='access_off')return (created?`${name}’s account was saved, but no invitation was sent. `:'')+practiceAccessOff;
 return created?`${name}’s account was saved, but the invitation was not sent. ${practiceInvitationReason(invitation)} Use “Send invitation” in the staff list to try again.`:`The invitation to ${name} was not sent. ${practiceInvitationReason(invitation)}`;
}
// Sign-in status and the one useful action for a staff row on a practice that signs in through SunCharts.
function practiceStaffSignIn(row){
 if(row.disabled)return {text:'Disabled'};
 const own=row.id===me?.user_id,invitation=practiceAdminState.invitations?.items?.find(x=>x.staff_id===row.id),status=invitation?.status||'unknown';
 const sent=practiceAdminDay(invitation?.sent_at),expires=practiceAdminDay(invitation?.expires_at),wait=`waiting for them to accept${expires?` (expires ${expires})`:''}`;
 const view={can_sign_in:{text:'Can sign in'},waiting:{text:`Invitation ${invitation?.reason==='partner_delivery'?'created':'sent'}${sent?' '+sent:''} – ${wait}`,action:'Send again'},expired:{text:'Invitation expired',action:'Send again'},cancelled:{text:'Invitation cancelled',action:'Send again'},not_sent:{text:'Invitation not sent',help:practiceInvitationReason(invitation),action:'Send invitation'},not_invited:{text:'Not invited yet',help:'They cannot sign in until they accept an invitation.',action:'Send invitation'},access_off:{text:'SunCharts access turned off',help:'Contact support to turn it back on.'},unknown:{text:'Sign-in status unavailable right now',help:'Refresh the directory in a few minutes.',action:'Send invitation'}}[status]||{text:'Sign-in status unavailable right now'};
 return own?{text:status==='can_sign_in'?view.text:'Signed in now'}:view;
}
function practiceAdminLabel(kind,row){return row.display_name||row.name||row.email||row.id;}
function practiceBillingSetup(s){
 const orgs=s.billingOrganizations?.items,hasOrg=!!orgs?.some(x=>x.active),hasProvider=s.providers.items.some(x=>x.active&&x.npi);
 if(!orgs||(hasOrg&&hasProvider))return '';
 const row=(done,label,help,button)=>`<li><span class="pill ${done?'ok':'warn'}">${done?'Done':'Needed'}</span> <b>${label}</b><small>${help}</small>${done?'':button}</li>`;
 return `<section class="billing-setup notice" aria-label="Billing setup"><h3>Finish billing setup</h3><p>Insurance eligibility checks and claims need these two things.</p><ul>${row(hasOrg,'Billing organization and tax ID','The practice’s legal billing name and EIN.','<button type="button" class="primary" data-billing-organizations>Add billing organization</button>')}${row(hasProvider,'Provider with an NPI','The clinician who bills for visits.','<button type="button" class="primary" data-admin-tab="providers">Add provider</button>')}</ul></section>`;
}
function renderPracticeAdmin(){
 const s=practiceAdminState,target=$('practice-admin-panel');if(!s||!target)return;
 if(s.tab==='workspace'&&typeof renderWorkspaceSettingsAdmin==='function'){renderWorkspaceSettingsAdmin(target);return;}
 const kind=s.tab,items=s[kind].items,staffLabel=id=>{const row=s.staff.items.find(x=>x.id===id);return row?`${row.display_name||row.email} · ${row.email}`:'Staff identity not in loaded directory';},facilityLabel=id=>s.facilities.items.find(x=>x.id===id)?.name||'Facility not in loaded directory';
 const headers={staff:['Staff member','Role',practiceStaffInvited()?'Sign-in':'Access'],providers:['Provider','Staff account / specialty','Status'],facilities:['Facility','Address / phone','Status'],rooms:['Room','Facility','Status']};
 const cells=row=>kind==='staff'?`<td><strong>${esc(row.display_name||row.email)}</strong><small>${esc(row.email)}${row.id===me.user_id?' · Your account':''}</small></td><td>${esc(practiceAdminRoles.find(([key])=>key===row.role)?.[1]||row.role)}</td><td>${practiceStaffInvited()?(v=>`${esc(v.text)}${v.help?`<small>${esc(v.help)}</small>`:''}`)(practiceStaffSignIn(row)):row.disabled?'Disabled':'Enabled'}</td>`:kind==='providers'?`<td><strong>${esc(row.display_name)}</strong><small>${esc(row.npi?'NPI '+row.npi:'NPI not recorded')}</small></td><td>${esc(staffLabel(row.id))}<small>${esc(row.specialty||'Specialty not recorded')}</small></td><td>${row.active?'Active':'Inactive'}</td>`:kind==='facilities'?`<td><strong>${esc(row.name)}</strong></td><td>${esc(row.address||'Address not recorded')}<small>${esc(row.phone||'Phone not recorded')}</small></td><td>${row.active?'Active':'Inactive'}</td>`:`<td><strong>${esc(row.name)}</strong></td><td>${esc(facilityLabel(row.facility_id))}</td><td>${row.active?'Active':'Inactive'}</td>`;
 target.innerHTML=`<div class="section-head"><div><h2>Practice administration</h2><p class="muted">Staff, providers, locations and billing setup for the practice.</p></div><button type="button" data-admin-refresh>Refresh directory</button></div>${practiceBillingSetup(s)}<nav class="chart-tabs" aria-label="Practice administration">${practiceAdminKinds.map(([key,label])=>`<button type="button" data-admin-tab="${key}" aria-pressed="${key===kind}">${label} <span class="pill">${s[key].items.length}${s[key].has_more?'+':''}</span></button>`).join('')}<button type="button" data-admin-tab="workspace" aria-pressed="false">Workspace</button>${typeof renderTerminologyAdminEntry==='function'?renderTerminologyAdminEntry():''}${typeof renderFeeScheduleAdminEntry==='function'?renderFeeScheduleAdminEntry():''}${typeof renderBillingOrganizationAdminEntry==='function'?renderBillingOrganizationAdminEntry():''}${typeof renderCardReadersAdminEntry==='function'?renderCardReadersAdminEntry():''}</nav><section><div class="section-head"><h3>${esc(practiceAdminKinds.find(([k])=>k===kind)[1])}</h3><button type="button" class="primary" data-admin-new>Add ${esc({staff:'staff account',providers:'provider',facilities:'facility',rooms:'room'}[kind])}</button></div>${kind==='staff'?(practiceStaffInvited()?'<p class="muted">Staff sign in with SunCharts using their email. Each new person gets an emailed invitation and can sign in once they accept it. Changing a role or turning off access signs that person out. At least one enabled owner must remain.</p>':'<p class="muted">Changing a role, turning access on or off, or setting a new password signs that person out. At least one enabled owner must remain.</p>'):kind==='providers'?'<p class="muted">Provider profiles belong to enabled owner or clinician accounts. NPI checks validate format and checksum, not enrollment or licensure.</p>':'<p class="muted">Directory changes do not rewrite the saved location text on existing appointments. Disable all active rooms before disabling a facility.</p>'}<label>Filter loaded directory<input type="search" data-admin-filter placeholder="Search names, roles or locations" autocomplete="off"></label>${s[kind].has_more?'<p class="notice">Only the first 1,000 records are loaded. This view does not provide an exhaustive directory.</p>':''}<div class="practice-table-wrap"><table class="practice-table"><caption class="sr-only">${esc(practiceAdminKinds.find(([k])=>k===kind)[1])}</caption><thead><tr>${headers[kind].map(t=>`<th scope="col">${t}</th>`).join('')}<th scope="col">Actions</th></tr></thead><tbody>${items.map(row=>`<tr data-admin-row><td hidden>${esc(JSON.stringify(row))}</td>${cells(row)}<td><button type="button" data-admin-edit="${esc(row.id)}">Edit</button> <button type="button" data-admin-history="${esc(row.id)}">History</button>${kind==='staff'&&practiceStaffInvited()&&practiceStaffSignIn(row).action?` <button type="button" class="primary" data-staff-invite="${esc(row.id)}">${practiceStaffSignIn(row).action}</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4">No records yet. Add the first record to get started.</td></tr>'}</tbody></table></div><p data-admin-filter-empty hidden>No matching records in the loaded directory.</p><div id="practice-admin-editor"></div><div id="practice-admin-history"></div></section>`;
}
function editPracticeAdmin(id){
 const s=practiceAdminState,kind=s.tab,row=id?s[kind].items.find(x=>x.id===id):null;if(id&&!row)return;
 s.editing=row||null;
 const input=(name,label,max,type='text',required=false)=>practiceAdminInput(name,label,row?.[name],max,type,required);
 let fields='';
 if(kind==='staff'){
 const invited=practiceStaffInvited(),own=row?.id===me?.user_id,common=`${input('display_name','Display name',200,'text',true)}${practiceAdminSelect('role','Role',practiceAdminRoles,row?.role||'front_desk')}${row?practiceAdminSelect('disabled','Access',[['false','Enabled'],['true','Disabled']],String(row.disabled)):''}`;
 if(invited)fields=`${row&&own?`<p>Sign-in email: <b>${esc(row.email)}</b></p>`:input('email','Sign-in email',254,'email',true)}${common}${row?.role==='owner'?practiceAdminInput('password','Emergency password (leave blank to keep the current one)','',1024,'password',false):''}<p class="muted">${row?(own?'You sign in with this email through SunCharts.':'If you change the email, we send a new invitation to the new address and this person signs in with the new email from then on.'):'We email this person an invitation. They sign in with this email once they accept it. No password is needed.'}${row?.role==='owner'?' The emergency password is only for signing in when SunCharts sign-in is unavailable and emergency access has been switched on for this practice.':''}</p>`;
 else fields=`${input('email','Sign-in email',254,'email',true)}${common}${practiceAdminInput('password',row?'New password (leave blank to keep current password)':'Initial password (at least 14 characters)','',1024,'password',!row)}<p class="muted">Give this password to the staff member in person or by phone. It is not shown again.</p>`;
 }
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
 const invited=kind==='staff'&&practiceStaffInvited();
 if(kind==='staff'){if(!values.password)delete values.password;if(row){values.disabled=values.disabled==='true';if(values.email!==undefined&&values.email.trim().toLowerCase()===row.email)delete values.email;}else if(invited){delete values.password;}else if((values.password||'').length<14){throw new Error('The initial password must contain at least 14 characters.');}}
 else values.active=values.active==='true';
 form.dataset.saving='true';const controls=[...form.querySelectorAll('button,input,select')];controls.forEach(c=>c.disabled=true);
 try{
  const saved=await api(`/api/v1/practice/${kind}${row?'/'+row.id:''}`,row?'PUT':'POST',values,row?.version);
  // The edited owner may have revoked their own session. Reauthenticate before
  // refreshing so the page does not suggest the old role is still available.
  if(kind==='staff'&&row?.id===me?.user_id){me=await api('/auth/me');if(me.role!=='owner'){await enter();return;}}
  if(form.isConnected){await showPracticeAdmin();const invitation=invited?saved?.invitation:null;notice(invitation?practiceInvitationMessage(saved.display_name||values.display_name,invitation,!row):'Practice record saved.',!!invitation&&!['waiting','can_sign_in'].includes(invitation.status));}
 }catch(error){if(form.isConnected){const alert=form.querySelector('[data-admin-error]');alert.textContent=error.message+' Reload before retrying if the outcome is uncertain.';alert.hidden=false;}}
 finally{if(form.elements?.password)form.elements.password.value='';delete form.dataset.saving;controls.forEach(c=>{if(c.isConnected)c.disabled=false;});}
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button?.closest('#practice-admin-panel'))return;
 if(button.hasAttribute('data-admin-refresh'))run(()=>showPracticeAdmin(null,true));
 if(button.dataset.adminTab){practiceAdminState.tab=button.dataset.adminTab;renderPracticeAdmin();}
 if(button.hasAttribute('data-admin-new'))editPracticeAdmin();
 if(button.dataset.adminEdit)editPracticeAdmin(button.dataset.adminEdit);
 if(button.hasAttribute('data-admin-cancel')){$('practice-admin-form')?.reset();$('practice-admin-editor').replaceChildren();practiceAdminState.editing=null;}
 if(button.dataset.staffInvite)run(async()=>{
  const state=practiceAdminState,id=button.dataset.staffInvite,row=state.staff.items.find(x=>x.id===id);if(!row)return;
  const invitation=await api(`/api/v1/practice/staff/${id}/invitation`,'POST');
  if(practiceAdminState!==state)return;
  if(invitation.version)row.version=invitation.version;
  state.invitations={...(state.invitations||{}),items:[...(state.invitations?.items||[]).filter(x=>x.staff_id!==id),{...invitation,staff_id:id}]};
  if(state.tab==='staff')renderPracticeAdmin();
  notice(practiceInvitationMessage(row.display_name||row.email,invitation),!['waiting','can_sign_in'].includes(invitation.status));
 });
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
