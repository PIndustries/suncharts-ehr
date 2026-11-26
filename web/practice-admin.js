// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let practiceAdminState,practiceAdminGeneration=0;
const practiceAdminRoles=[['owner','Practice owner'],['clinician','Clinician'],['nurse','Nurse'],['medical_assistant','Medical assistant'],['front_desk','Front desk'],['read_only','Read only']];
// What each role may do, shown beside the role choice. Front desk records vitals; the
// rest of rooming and intake, and every note, stays with clinical staff.
const practiceAdminRoleNotes={front_desk:'Front desk records vitals on an in-progress visit. Rooming intake, notes, diagnoses, orders and signing stay with clinical staff.'};
const practiceAdminKinds=[['staff','Staff accounts'],['providers','Provider directory'],['facilities','Facilities'],['rooms','Rooms']];
// Destinations keep the same event attributes and screen renderers as the former tabs.
const practiceAdminGroups=[
 ['Practice',[['details','Practice details','data-admin-tab="details"'],['facilities','Facilities','data-admin-tab="facilities"'],['rooms','Rooms','data-admin-tab="rooms"'],['visit-types','Visit types','data-admin-tab="visit-types"'],['calendar','Calendar links','data-calendar-links-admin']]],
 ['People',[['staff','Staff accounts','data-admin-tab="staff"'],['providers','Provider directory','data-admin-tab="providers"']]],
 ['Billing',[['claims','Claim connections','data-go-nav="nav-edi"'],['organizations','Billing organizations','data-billing-organizations'],['codes','Codes & prices','data-terminology-manage'],['fees','Practice fees','data-fees-manage'],['readers','Card readers','data-card-readers'],['memberships','Memberships','data-admin-tab="memberships"']]],
 ['Advanced',[['integrations','Integrations','data-go-nav="nav-apps"'],['workflows','Workflow Studio','data-go-nav="nav-workflows"'],['import','Data import','data-go-nav="nav-migration"'],['partners','Partners','data-partners-screen'],['workspace','Customize menu','data-admin-tab="workspace"']]]
];
function practiceAdminNavigation(active){
 return `<nav class="practice-admin-nav" aria-label="Practice administration">${practiceAdminGroups.map(([group,items])=>`<section class="frame-admin-group"><h3>${esc(group)}</h3>${items.map(([key,label,attribute])=>`<button type="button" ${attribute} aria-current="${key===active?'page':'false'}">${esc(label)}</button>`).join('')}</section>`).join('')}</nav>`;
}
function practiceAdminFrameMarkup(active,content){
 const [group,items]=practiceAdminGroups.find(([,items])=>items.some(([key])=>key===active))||practiceAdminGroups[0];
 const item=items.find(([key])=>key===active)?.[1]||'Practice details';
 const breadcrumb=`<p class="frame-admin-breadcrumb" aria-label="Breadcrumb">Admin / ${esc(group)} / ${esc(item)}</p>`;
 const header=active==='details'||practiceAdminKinds.some(([key])=>key===active)
  ?`<div class="section-head">${breadcrumb}<button type="button" data-admin-refresh>Refresh directory</button></div>`:breadcrumb;
 return `<div class="frame-admin">${practiceAdminNavigation(active)}<div class="frame-admin-main">${header}<div class="frame-admin-content">${content}</div></div></div>`;
}
// Move live screen nodes instead of recreating forms, listeners or in-flight status hosts.
function practiceAdminFrame(active,host=$('tools')){
 if(me?.role!=='owner'||!host||host.querySelector('.frame-admin'))return;
 const nodes=Array.from(host.childNodes);host.innerHTML=practiceAdminFrameMarkup(active,'');
 host.querySelector('.frame-admin-content').append(...nodes);
}
async function showPracticeAdmin(requestedTab=null,fresh=false){
 if(me?.role!=='owner')throw new Error('Practice owner access is required.');
 if(typeof captureVisitDrafts==='function')captureVisitDrafts();
 const generation=++practiceAdminGeneration;
 const values=await Promise.all(practiceAdminKinds.map(([kind])=>api(`/api/v1/practice/${kind}`)));
 const [billingOrganizations,clearinghouse,payers,payments]=await Promise.all([
  api('/api/v1/practice/billing-organizations').catch(()=>null),
  api('/api/v1/billing/claimmd/status').catch(()=>null),
  api('/api/v1/billing/payers').catch(()=>null),
  api('/api/v1/billing/payments/settings').catch(()=>null)
 ]);
 // Staff of a practice that signs in through SunCharts have no password: each is emailed a link that signs them in. Their sign-in status comes with the list.
 const invitations=values[0]?.sign_in==='connect'?await api('/api/v1/practice/staff/invitations'+(fresh?'?fresh=true':'')).catch(()=>null):null;
 if(generation!==practiceAdminGeneration||me?.role!=='owner')return;
 practiceAdminState={...Object.fromEntries(practiceAdminKinds.map(([k],i)=>[k,values[i]])),billingOrganizations,clearinghouse,payers,payments,invitations,tab:requestedTab||practiceAdminState?.tab||'details'};
 showTool('Practice administration');
 $('tools').innerHTML='<section id="practice-admin-panel" class="panel"></section>';$('tools').hidden=false;
 renderPracticeAdmin();
}
// Billing partner setup is a Practice administration destination, like Code lists.
function renderPartnersAdminEntry(){return me?.role==='owner'?'<button type="button" data-partners-screen>Partners</button>':'';}
function practiceAdminInput(name,label,value,max,type='text',required=false){return `<label>${esc(label)}<input name="${name}" type="${type}" maxlength="${max}" value="${esc(value||'')}" ${required?'required':''} autocomplete="${type==='password'?'new-password':'off'}"></label>`;}
function practiceAdminPatternInput(name,label,value,max,pattern,hint=''){return `<label>${esc(label)}<input name="${name}" type="text" maxlength="${max}" pattern="${pattern}" value="${esc(value||'')}" autocomplete="off">${hint?`<small class="muted">${hint}</small>`:''}</label>`;}
function practiceAdminSelect(name,label,options,value){return `<label>${esc(label)}<select name="${name}" required>${options.map(([key,label])=>`<option value="${esc(key)}" ${key===value?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;}
function practiceStaffInvited(){return practiceAdminState?.staff?.sign_in==='connect';}
function practiceAdminDay(value){const d=new Date(value);return value&&!Number.isNaN(d.getTime())?d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'';}
// "Nov 13, 3:03 PM" (with the year when it is not this year).
function practiceAdminWhen(value){const d=new Date(value);if(!value||Number.isNaN(d.getTime()))return '';const options={month:'short',day:'numeric',hour:'numeric',minute:'2-digit'};if(d.getFullYear()!==new Date().getFullYear())options.year='numeric';return d.toLocaleString(undefined,options);}
const practiceInvitationReasons={unreachable:'We could not reach SunCharts just now. Try again in a few minutes.',email_refused:'SunCharts could not use this email address. Check it for typos.',plan:'Your SunCharts plan needs attention before new staff can be added. Contact support.',busy:'Too many sign-in links were sent in the last hour. Try again later.',not_allowed:'This practice’s connection to SunCharts needs attention. Contact support.',email_not_delivered:'The email could not be delivered. Check the address, then send it again.',delivery_unknown:'We could not confirm the email went out. Send a new link.',refused:'SunCharts did not accept the request. Try again, or contact support if it keeps happening.'};
const practiceAccessOff='SunCharts turned this person’s access off. Contact support to turn it back on.';
function practiceInvitationReason(invitation){return practiceInvitationReasons[invitation?.reason]||practiceInvitationReasons.refused;}
// What the owner is told right after a sign-in link is asked for. `created` is true when the account was just added.
function practiceInvitationMessage(name,invitation,created=false){
 if(invitation?.status==='can_sign_in')return `${name} already has a SunCharts account for this practice and can sign in now.`;
 if(invitation?.status==='waiting')return invitation.reason==='partner_delivery'?`A sign-in link was created for ${name}. Your SunCharts provider will pass it on. One click on it signs them in. No password is needed.`:`We emailed ${name} a sign-in link. One click on it signs them in. No password is needed.`;
 if(invitation?.status==='access_off')return (created?`${name}’s account was saved, but no sign-in link was sent. `:'')+practiceAccessOff;
 return created?`${name}’s account was saved, but the sign-in link was not sent. ${practiceInvitationReason(invitation)} Use “Send sign-in link” in the staff list to try again.`:`The sign-in link for ${name} was not sent. ${practiceInvitationReason(invitation)}`;
}
// Sign-in status and the one useful action for a staff row on a practice that signs in through SunCharts.
function practiceStaffSignIn(row){
 if(row.disabled)return {text:'Access turned off'};
 const own=row.id===me?.user_id,invitation=practiceAdminState.invitations?.items?.find(x=>x.staff_id===row.id),status=invitation?.status||'unknown';
 const sent=practiceAdminDay(invitation?.sent_at),until=practiceAdminDay(invitation?.expires_at),active=practiceAdminWhen(invitation?.last_active_at);
 const signedIn=`${active?`Signed in · last active ${active}`:'Can sign in'}${invitation?.passkey_added===true?' · Passkey added':''}`;
 const view={can_sign_in:{text:signedIn},waiting:{text:`Link ${invitation?.reason==='partner_delivery'?'created':'sent'}${sent?' '+sent:''} · hasn’t signed in yet${until?` (link works until ${until})`:''}`,action:'Send a new link'},expired:{text:'Link expired · send a new one',action:'Send a new link'},cancelled:{text:'Link cancelled · send a new one',action:'Send a new link'},not_sent:invitation?.reason==='email_not_delivered'?{text:'Email not delivered · check the address',action:'Send sign-in link'}:{text:'Link not sent',help:practiceInvitationReason(invitation),action:'Send sign-in link'},not_invited:{text:'Not sent yet',help:'They can sign in once we email them a link.',action:'Send sign-in link'},access_off:{text:'Access turned off',help:practiceAccessOff},unknown:{text:'Sign-in status unavailable right now',help:'We’ll check again shortly.',action:'Send sign-in link'}}[status]||{text:'Sign-in status unavailable right now'};
 return own?{text:status==='can_sign_in'?view.text:'Signed in now'}:view;
}
function practiceStaffSignInCell(row){const v=practiceStaffSignIn(row);return `${esc(v.text)}${v.help?`<small>${esc(v.help)}</small>`:''}`;}
function practiceStaffAction(row){const action=practiceStaffSignIn(row).action;return action?` <button type="button" class="primary" data-staff-invite="${esc(row.id)}">${action}</button>`:'';}
// The staff list keeps itself current while someone has a link they have not used yet: every 15 seconds
// for ten minutes after a link is sent, then once a minute, and whenever the owner comes back to this tab.
// Only the sign-in column and its button are redrawn, so an open form or history panel is left alone.
let practiceStaffWatchTimer=null,practiceStaffWatchBusy=false,practiceStaffCheckedAt=0,practiceStaffLinkSentAt=0,practiceStaffLinkUsedAt=0;
function practiceStaffWatchVisible(){const s=practiceAdminState,panel=$('practice-admin-panel');return !!s&&s.tab==='staff'&&practiceStaffInvited()&&me?.role==='owner'&&!!panel&&panel.isConnected!==false&&!$('tools')?.hidden&&(typeof document==='undefined'||document.visibilityState!=='hidden');}
// Someone who has used their link but has not arrived here yet: they are on their way in.
function practiceStaffArriving(items){return (items||[]).filter(x=>x.status==='can_sign_in'&&!x.last_active_at&&x.staff_id!==me?.user_id);}
function practiceStaffWatchDelay(){
 const now=Date.now(),items=practiceAdminState?.invitations?.items||[],waiting=items.filter(x=>x.status==='waiting');
 const recent=at=>Number.isFinite(at)&&now-at<600000&&now-at>-60000;
 if(waiting.length)return recent(practiceStaffLinkSentAt)||waiting.some(x=>recent(Date.parse(x.sent_at)))?15000:60000;
 return recent(practiceStaffLinkUsedAt)&&practiceStaffArriving(items).length?15000:0;
}
function practiceStaffWatch(){
 if(practiceStaffWatchTimer!==null)clearTimeout(practiceStaffWatchTimer);practiceStaffWatchTimer=null;
 const delay=practiceStaffWatchVisible()?practiceStaffWatchDelay():0;if(delay)practiceStaffWatchTimer=setTimeout(()=>{practiceStaffWatchTimer=null;practiceStaffRecheck();},delay);
}
function practiceStaffRedraw(){
 const panel=$('practice-admin-panel');if(!panel?.querySelector)return;
 for(const row of practiceAdminState.staff.items){
  const cell=panel.querySelector(`[data-staff-signin="${row.id}"]`),action=panel.querySelector(`[data-staff-action="${row.id}"]`);
  if(cell){const html=practiceStaffSignInCell(row);if(cell.innerHTML!==html)cell.innerHTML=html;}
  if(action){const html=practiceStaffAction(row);if(action.innerHTML!==html)action.innerHTML=html;}
 }
}
async function practiceStaffRecheck(){
 const state=practiceAdminState;if(practiceStaffWatchBusy||!practiceStaffWatchVisible())return;
 practiceStaffWatchBusy=true;practiceStaffCheckedAt=Date.now();
 try{const invitations=await api('/api/v1/practice/staff/invitations');if(practiceAdminState===state&&invitations?.sign_in==='connect'&&Array.isArray(invitations.items)&&practiceStaffWatchVisible()){const waited=new Set((state.invitations?.items||[]).filter(x=>x.status==='waiting').map(x=>x.staff_id));if(practiceStaffArriving(invitations.items).some(x=>waited.has(x.staff_id)))practiceStaffLinkUsedAt=Date.now();state.invitations=invitations;practiceStaffRedraw();}}
 catch{/* A quiet check that fails says nothing; the next one tries again. */}
 finally{practiceStaffWatchBusy=false;practiceStaffWatch();}
}
function practiceStaffReturned(){if(practiceStaffWatchVisible()&&Date.now()-practiceStaffCheckedAt>5000)practiceStaffRecheck();}
// History in plain words: when, what happened and who did it. The full saved record stays under Details.
const practiceHistoryNotSent={unreachable:'SunCharts could not be reached',email_refused:'the email address was not accepted',plan:'the SunCharts plan needs attention',busy:'too many links were sent in the last hour',not_allowed:'the connection to SunCharts needs attention',email_not_delivered:'the email could not be delivered',delivery_unknown:'we could not confirm the email went out'};
function practiceHistoryWhat(kind,revision,earlier){
 const now=revision.content||{};
 if(kind==='staff'&&now.invitation_status){
  if(now.invitation_status==='waiting')return now.invitation_reason==='partner_delivery'?'Sign-in link created':'Sign-in link emailed';
  if(now.invitation_status==='can_sign_in')return 'No sign-in link needed (already has a SunCharts account)';
  if(now.invitation_status==='access_off')return 'Sign-in link not sent (SunCharts access is turned off)';
  return `Sign-in link not sent (${practiceHistoryNotSent[now.invitation_reason]||'SunCharts did not accept the request'})`;
 }
 if(!earlier)return revision.version===1?(kind==='staff'?'Account added':'Record added'):'Details updated';
 const was=earlier.content||{},changes=[];
 if(kind==='staff'){
  if(was.email!==now.email)changes.push('Email changed');
  if(was.role!==now.role)changes.push(`Role changed to ${practiceAdminRoles.find(([key])=>key===now.role)?.[1]||'another role'}`);
  if(was.disabled!==now.disabled)changes.push(now.disabled?'Access turned off':'Access turned back on');
  if(was.display_name!==now.display_name)changes.push('Name changed');
 }else if(was.active!==now.active)changes.push(now.active?'Made active again':'Made inactive');
 return changes.length?changes.map((change,i)=>i?change[0].toLowerCase()+change.slice(1):change).join(', '):'Details updated';
}
function practiceHistoryWho(id){const row=practiceAdminState.staff.items.find(x=>x.id===id);return row?(row.display_name||row.email):'someone no longer on the staff list';}
function practiceHistoryEntry(kind,revision,earlier){
 const linked=kind==='staff'&&revision.content?.invitation_status,when=practiceAdminWhen(revision.created_at)||'Date not recorded';
 return `<article class="amendment"><p><strong>${esc(when)}</strong> — ${esc(practiceHistoryWhat(kind,revision,earlier))} by ${esc(practiceHistoryWho(revision.actor_id))}</p>${!linked&&revision.reason?`<small>Reason given: ${esc(revision.reason)}</small>`:''}<details><summary>Details</summary><dl><dt>Change number</dt><dd>${esc(revision.version)}</dd><dt>Made by (staff record)</dt><dd>${esc(revision.actor_id)}</dd><dt>Note saved with it</dt><dd>${esc(revision.reason)}</dd>${Object.entries(revision.content||{}).map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details></article>`;
}
function practiceAdminLabel(kind,row){return row.display_name||row.name||row.email||row.id;}
function practiceBillingSetup(s){
 const orgs=s.billingOrganizations?.items?.filter(x=>x.active)||[],providers=s.providers.items.filter(x=>x.active),setting=s.payments?.setting;
 const address=s.facilities.items.some(x=>x.active&&((x.address_line1&&x.city&&x.state&&x.postal_code)||x.address));
 const card=setting?.mode==='suncharts_connect'&&!!setting.provider_account_id&&setting.details_submitted===true&&setting.charges_enabled===true&&setting.card_payments_active===true&&setting.payouts_enabled===true&&!(setting.requirements_past_due?.length||setting.requirements_currently_due?.length);
 const checks=[
  [orgs.some(x=>x.npi)||providers.some(x=>x.npi),'Billing NPI set','data-billing-organizations'],
  [address,'Billing address set','data-admin-tab="facilities"'],
  [orgs.some(x=>x.tax_id_last4),'Tax ID set','data-billing-organizations'],
  [s.clearinghouse?.connected===true,'Clearinghouse connected','data-go-nav="nav-edi"'],
  [s.payers?.items?.some(x=>x.content?.active),'At least one payer','data-admin-payers'],
  [providers.some(x=>x.npi),'At least one provider with NPI','data-admin-tab="providers"'],
  [card,'Card payments set up','data-payment-settings']
 ];
 return `<section class="billing-setup" aria-label="Billing setup"><h2>Getting ready to bill</h2><p class="muted">Check the practice details before billing. Open an item to review or complete it.</p><ul>${checks.map(([done,label,attribute])=>`<li><span class="frame-admin-status">${done?'Done':'Not done'}</span><button type="button" ${attribute}>${label}</button></li>`).join('')}</ul>${!s.billingOrganizations||!s.clearinghouse||!s.payers||!s.payments?'<p class="muted">Some setup details could not be checked. Open the item to check its current status.</p>':''}<p class="muted">Billing addresses come from facilities. An individual provider’s NPI can be used when the practice has no group NPI.</p></section>`;
}

function renderPracticeAdmin(){
 const s=practiceAdminState,target=$('practice-admin-panel');if(!s||!target)return;
 if(s.tab==='visit-types'){void renderPracticeVisitTypes(target);practiceStaffWatch();return;}
 if(s.tab==='details'){target.innerHTML=practiceAdminFrameMarkup('details',practiceBillingSetup(s));practiceStaffWatch();return;}
 if(s.tab==='workspace'&&typeof renderWorkspaceSettingsAdmin==='function'){renderWorkspaceSettingsAdmin(target);practiceStaffWatch();return;}
 if(typeof practiceAdminExtraRender==='function'&&practiceAdminExtraRender(s.tab,target)){practiceStaffWatch();return;}
 const kind=s.tab,items=s[kind].items,staffLabel=id=>{const row=s.staff.items.find(x=>x.id===id);return row?`${row.display_name||row.email} · ${row.email}`:'Staff identity not in loaded directory';},facilityLabel=id=>s.facilities.items.find(x=>x.id===id)?.name||'Facility not in loaded directory';
 const headers={staff:['Staff member','Role',practiceStaffInvited()?'Sign-in':'Access'],providers:['Provider','Staff account / specialty','Status'],facilities:['Facility','Address / phone','Status'],rooms:['Room','Facility','Status']};
 const cells=row=>kind==='staff'?`<td><strong>${esc(row.display_name||row.email)}</strong><small>${esc(row.email)}${row.id===me.user_id?' · Your account':''}</small></td><td>${esc(practiceAdminRoles.find(([key])=>key===row.role)?.[1]||row.role)}</td>${practiceStaffInvited()?`<td data-staff-signin="${esc(row.id)}">${practiceStaffSignInCell(row)}</td>`:`<td>${row.disabled?'Disabled':'Enabled'}</td>`}`:kind==='providers'?`<td><strong>${esc(row.display_name)}</strong><small>${esc(row.npi?'NPI '+row.npi:'NPI not recorded')}${row.taxonomy?' · Taxonomy '+esc(row.taxonomy):''}</small></td><td>${esc(staffLabel(row.id))}<small>${esc(row.specialty||'Specialty not recorded')}</small></td><td>${row.active?'Active':'Inactive'}</td>`:kind==='facilities'?`<td><strong>${esc(row.name)}</strong></td><td>${esc(row.address||'Address not recorded')}<small>${esc(row.phone||'Phone not recorded')}</small></td><td>${row.active?'Active':'Inactive'}</td>`:`<td><strong>${esc(row.name)}</strong></td><td>${esc(facilityLabel(row.facility_id))}</td><td>${row.active?'Active':'Inactive'}</td>`;
 target.innerHTML=`<section><div class="section-head"><h3>${esc(practiceAdminKinds.find(([k])=>k===kind)[1])}</h3><button type="button" class="primary" data-admin-new>Add ${esc({staff:'staff account',providers:'provider',facilities:'facility',rooms:'room'}[kind])}</button></div>${kind==='staff'?(practiceStaffInvited()?'<p class="muted">Staff sign in with their email — no password. We email each new person a link that signs them in. Changing a role or turning off access signs that person out. At least one enabled owner must remain.</p>':'<p class="muted">Changing a role, turning access on or off, or setting a new password signs that person out. At least one enabled owner must remain.</p>'):kind==='providers'?'<p class="muted">A provider profile belongs to a clinician or owner whose account is turned on. The NPI is checked for a valid format only, not that the provider is enrolled or licensed.</p>':'<p class="muted">Changing a location here does not change appointments already booked there. Turn off a facility’s rooms before turning off the facility.</p>'}<label>Search this list<input type="search" data-admin-filter placeholder="Search names, roles or locations" autocomplete="off"></label>${s[kind].has_more?'<p class="notice">Only the first 1,000 are shown here.</p>':''}<div class="practice-table-wrap"><table class="practice-table"><caption class="sr-only">${esc(practiceAdminKinds.find(([k])=>k===kind)[1])}</caption><thead><tr>${headers[kind].map(t=>`<th scope="col">${t}</th>`).join('')}<th scope="col">Actions</th></tr></thead><tbody>${items.map(row=>`<tr data-admin-row><td hidden>${esc(JSON.stringify(row))}</td>${cells(row)}<td><button type="button" data-admin-edit="${esc(row.id)}">Edit</button> <button type="button" data-admin-history="${esc(row.id)}">History</button>${kind==='staff'&&practiceStaffInvited()?`<span data-staff-action="${esc(row.id)}">${practiceStaffAction(row)}</span>`:''}</td></tr>`).join('')||'<tr><td colspan="4">No records yet. Add the first record to get started.</td></tr>'}</tbody></table></div><p data-admin-filter-empty hidden>No matching records in the loaded directory.</p><div id="practice-admin-editor"></div><div id="practice-admin-history"></div></section>`;
 target.innerHTML=practiceAdminFrameMarkup(kind,target.innerHTML);
 practiceStaffWatch();
}
function editPracticeAdmin(id){
 const s=practiceAdminState,kind=s.tab,row=id?s[kind].items.find(x=>x.id===id):null;if(id&&!row)return;
 s.editing=row||null;
 const input=(name,label,max,type='text',required=false)=>practiceAdminInput(name,label,row?.[name],max,type,required);
 let fields='';
 if(kind==='staff'){
 const invited=practiceStaffInvited(),own=row?.id===me?.user_id,roleNote=practiceAdminRoleNotes[row?.role]||'',common=`${input('display_name','Display name',200,'text',true)}${practiceAdminSelect('role','Role',practiceAdminRoles,row?.role||'front_desk')}${roleNote?`<p class="muted">${esc(roleNote)}</p>`:''}${row?practiceAdminSelect('disabled','Access',[['false','Enabled'],['true','Disabled']],String(row.disabled)):''}`;
 if(invited)fields=`${row&&own?`<p>Sign-in email: <b>${esc(row.email)}</b></p>`:input('email','Sign-in email',254,'email',true)}${common}${row?.role==='owner'?practiceAdminInput('password','Emergency password (leave blank to keep the current one)','',1024,'password',false):''}<p class="muted">${row?(own?'You sign in with this email through SunCharts.':'If you change the email, we send a sign-in link to the new address and this person signs in with the new email from then on.'):'We email this person a sign-in link. No password is needed.'}${row?.role==='owner'?' The emergency password is only for signing in when SunCharts sign-in is unavailable and emergency access has been switched on for this practice.':''}</p>`;
 else fields=`${input('email','Sign-in email',254,'email',true)}${common}${practiceAdminInput('password',row?'New password (leave blank to keep current password)':'Initial password (at least 14 characters)','',1024,'password',!row)}<p class="muted">Give this password to the staff member in person or by phone. It is not shown again.</p>`;
 }
 if(kind==='providers'){
 const choices=s.staff.items.filter(x=>!x.disabled&&['owner','clinician'].includes(x.role)&&(!s.providers.items.some(p=>p.id===x.id)||row?.id===x.id)).map(x=>[x.id,`${x.display_name||x.email} · ${x.email}`]);
 if(!row&&!choices.length){$('practice-admin-editor').innerHTML='<p class="notice">Add a clinician or owner staff account, turned on, before making its provider profile.</p>';return;}
 fields=`${row?`<p>Staff account: ${esc(s.staff.items.find(x=>x.id===row.id)?.email||row.id)}<input type="hidden" name="staff_id" value="${esc(row.id)}"></p>`:practiceAdminSelect('staff_id','Staff account',choices,choices[0]?.[0])}${input('display_name','Provider display name',200,'text',true)}${input('npi','NPI (optional)',10)}${input('specialty','Specialty',200)}${practiceAdminPatternInput('taxonomy','Taxonomy code',row?.taxonomy,10,'[0-9A-Za-z]{10}','Leave blank and it is looked up from the provider’s NPI. 10 characters, for example 207Q00000X.')}`;
 }
 if(kind==='facilities'){
 const boxes=`${row?.address&&!row?.address_line1?`<p class="muted facility-address-on-file">Address on file: ${esc(row.address)}. Enter it in the boxes below so claims can use it.</p>`:''}${input('address_line1','Street address',55)}${input('address_line2','Suite or unit',55)}${input('city','City',30)}${practiceAdminPatternInput('state','State',row?.state,2,'[A-Za-z]{2}')}${practiceAdminPatternInput('postal_code','ZIP code',row?.postal_code,10,'[0-9]{5}(-?[0-9]{4})?')}`;
 fields=input('name','Facility name',200,'text',true)+boxes+input('phone','Phone',40);
 }
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
 if(kind==='providers')values.taxonomy=(values.taxonomy||'').trim();
 if(kind==='facilities'){values.address=row?.address||'';for(const key of ['address_line1','address_line2','city','state','postal_code'])values[key]=(values[key]||'').trim();}
 form.dataset.saving='true';const controls=[...form.querySelectorAll('button,input,select')];controls.forEach(c=>c.disabled=true);
 try{
  const saved=await api(`/api/v1/practice/${kind}${row?'/'+row.id:''}`,row?'PUT':'POST',values,row?.version);
  if(['providers','facilities','staff'].includes(kind)&&typeof invalidateEncounterProviderOptions==='function')invalidateEncounterProviderOptions();
  // The edited owner may have revoked their own session. Reauthenticate before
  // refreshing so the page does not suggest the old role is still available.
  if(kind==='staff'&&row?.id===me?.user_id){me=await api('/auth/me');if(me.role!=='owner'){await enter();return;}}
  if(invited&&saved?.invitation?.status==='waiting')practiceStaffLinkSentAt=Date.now();
  if(form.isConnected){await showPracticeAdmin();const invitation=invited?saved?.invitation:null;notice(invitation?practiceInvitationMessage(saved.display_name||values.display_name,invitation,!row):'Practice record saved.',!!invitation&&!['waiting','can_sign_in'].includes(invitation.status));}
 }catch(error){if(form.isConnected){const alert=form.querySelector('[data-admin-error]');alert.textContent=error.message+' Reload before retrying if the outcome is uncertain.';alert.hidden=false;}}
 finally{if(form.elements?.password)form.elements.password.value='';delete form.dataset.saving;controls.forEach(c=>{if(c.isConnected)c.disabled=false;});}
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.closest('.practice-admin-nav')||button.closest('#practice-admin-panel')){
  if(button.dataset.adminTab){event.preventDefault();if($('practice-admin-panel')&&practiceAdminState){practiceAdminState.tab=button.dataset.adminTab;renderPracticeAdmin();}else run(()=>showPracticeAdmin(button.dataset.adminTab));return;}
  if(button.hasAttribute('data-partners-screen')){event.preventDefault();run(showPartners);return;}
  if(button.hasAttribute('data-admin-payers')){event.preventDefault();run(()=>showBillingQueue('',undefined,true));return;}
 }
 if(!button.closest('#practice-admin-panel'))return;
 if(button.hasAttribute('data-admin-refresh')){event.preventDefault();run(()=>showPracticeAdmin(null,true));return;}
 if(button.hasAttribute('data-partners-screen')){event.preventDefault();run(showPartners);return;}
 if(button.hasAttribute('data-admin-new'))editPracticeAdmin();
 if(button.dataset.adminEdit)editPracticeAdmin(button.dataset.adminEdit);
 if(button.hasAttribute('data-admin-cancel')){$('practice-admin-form')?.reset();$('practice-admin-editor').replaceChildren();practiceAdminState.editing=null;}
 if(button.dataset.staffInvite)run(async()=>{
  const state=practiceAdminState,id=button.dataset.staffInvite,row=state.staff.items.find(x=>x.id===id);if(!row)return;
  const invitation=await api(`/api/v1/practice/staff/${id}/invitation`,'POST');
  if(practiceAdminState!==state)return;
  if(invitation.version)row.version=invitation.version;
  if(invitation.status==='waiting')practiceStaffLinkSentAt=Date.now();
  state.invitations={...(state.invitations||{}),items:[...(state.invitations?.items||[]).filter(x=>x.staff_id!==id),{...invitation,staff_id:id}]};
  if(state.tab==='staff')renderPracticeAdmin();
  notice(practiceInvitationMessage(row.display_name||row.email,invitation),!['waiting','can_sign_in'].includes(invitation.status));
 });
 if(button.dataset.adminHistory)run(async()=>{
  const state=practiceAdminState,kind=state.tab,id=button.dataset.adminHistory,map={staff:'staff',providers:'provider',facilities:'facility',rooms:'room'},data=await api(`/api/v1/practice/admin-history/${map[kind]}/${id}`);
  if(!button.isConnected||practiceAdminState!==state||state.tab!==kind)return;
  $('practice-admin-history').innerHTML=`<section class="panel"><h3>History · ${esc(practiceAdminLabel(kind,state[kind].items.find(x=>x.id===id)||{}))}</h3>${data.items.map((r,i)=>practiceHistoryEntry(map[kind],r,data.items[i+1])).join('')||'<p>No changes recorded yet. Accounts set up with the practice have no earlier history.</p>'}${data.has_more?'<p>The latest 100 changes are shown. Earlier history is kept.</p>':''}</section>`;
 });
});
document.addEventListener('input',event=>{
 if(!event.target.hasAttribute('data-admin-filter'))return;
 const query=event.target.value.trim().toLocaleLowerCase(),rows=[...$('practice-admin-panel').querySelectorAll('[data-admin-row]')];for(const row of rows)row.hidden=!row.textContent.toLocaleLowerCase().includes(query);
 $('practice-admin-panel').querySelector('[data-admin-filter-empty]').hidden=!rows.length||rows.some(r=>!r.hidden);
});
document.addEventListener('submit',event=>{if(event.target.id!=='practice-admin-form')return;event.preventDefault();savePracticeAdmin(event.target).catch(e=>{const box=event.target.querySelector('[data-admin-error]');box.textContent=e.message;box.hidden=false;});});
if(typeof addEventListener==='function')addEventListener('focus',practiceStaffReturned);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){if(practiceStaffWatchTimer!==null)clearTimeout(practiceStaffWatchTimer);practiceStaffWatchTimer=null;}else practiceStaffReturned();});

// The practice, rather than an individual patient, owns scheduling defaults and suggestions.
const practiceVisitTypesUrl='/api/v1/practice/visit-types';
async function renderPracticeVisitTypes(panel) {
 const state=practiceAdminState;
 panel.innerHTML=practiceAdminFrameMarkup('visit-types','<section data-visit-types><h2>Visit types</h2><p role="status">Loading visit types…</p></section>');
 const host=panel.querySelector('[data-visit-types]');
 const current=()=>host.isConnected&&state===practiceAdminState&&me?.role==='owner';
 try {
  const result=await api(practiceVisitTypesUrl+'?include_disabled=true');
  if(!current())return;
  const rows=result.items;
  const row=item=>`<tr><td><b>${esc(item.name)}</b>${item.category&&item.category!==item.name?`<small>${esc(item.category)}</small>`:''}</td><td>${esc(item.duration_minutes)} min</td><td>${(item.diagnoses||[]).length} diagnoses · ${(item.procedures||[]).length} procedures</td><td><button type="button" data-visit-type-edit="${esc(item.id)}">Edit</button> <button type="button" data-visit-type-toggle="${esc(item.id)}">${item.enabled?'Retire':'Restore'}</button></td></tr>`;
  const table=items=>`<div class="table-scroll"><table><thead><tr><th>Visit type</th><th>Duration</th><th>Suggested codes</th><th>Actions</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table></div>`;
  const active=rows.filter(item=>item.enabled),retired=rows.filter(item=>!item.enabled);
  host.innerHTML=`<div class="section-head"><h2>Visit types</h2><button type="button" class="primary" data-visit-type-new>Add visit type</button></div><p class="muted">Choose the appointment length and which codes to suggest for each kind of visit.</p>${active.length?table(active):'<p>No active visit types.</p>'}${retired.length?`<details data-inline><summary>Retired visit types (${retired.length})</summary>${table(retired)}</details>`:''}<p data-visit-type-message role="status"></p>`;
  host.addEventListener('click',async event=>{
   const button=event.target.closest('button');if(!button||!current())return;
   const item=rows.find(row=>row.id===(button.dataset.visitTypeEdit||button.dataset.visitTypeToggle));
   if(button.hasAttribute('data-visit-type-new')||button.hasAttribute('data-visit-type-edit')){
    editPracticeVisitType(host,item,current,()=>renderPracticeVisitTypes(panel));return;
   }
   if(!item||!button.hasAttribute('data-visit-type-toggle'))return;
   const verb=item.enabled?'Retire':'Restore';
   if(!await confirmAction(item.enabled?'Existing appointments keep their visit type. Staff can select this type again if you restore it.':'Staff will be able to select this type for new appointments.',{title:verb+' '+item.name+'?',confirmLabel:verb+' visit type'})||!current())return;
   button.disabled=true;
   try {
    const {name,category,duration_minutes,diagnoses,procedures}=item;
    await api(practiceVisitTypesUrl+'/'+encodeURIComponent(item.id),'PUT',{name,category,duration_minutes,diagnoses,procedures,enabled:!item.enabled},item.version);
    if(current())await renderPracticeVisitTypes(panel);
   }catch(error){
    if(!current())return;
    button.disabled=false;
    host.querySelector('[data-visit-type-message]').textContent=(error.status===412||error.status===409&&/changed|version/i.test(error.message))?'This visit type changed. Reopen Visit types to see its latest settings.':error.message;
   }
  });
 }catch(error){
  if(!current())return;
  host.innerHTML=`<h2>Visit types</h2><p role="alert">${esc(error.message)}</p><button type="button" data-admin-tab="visit-types">Try again</button>`;
 }
}
async function practiceVisitTypeCodeSearch(systems,query) {
 const serviceDate=localIsoDate(),ownQuery=new URLSearchParams({q:query,enabled:'true'});
 // A disabled code set also hides codes the practice has added to its own directory.
 const [sets,own,...catalogs]=await Promise.all([
  api('/api/v1/practice/code-sets'),api('/api/v1/practice/codes?'+ownQuery),
  ...systems.map(system=>api('/api/v1/terminology/codes?'+new URLSearchParams({system,q:query,service_date:serviceDate,billable:'true',active:'true',limit:'25'})))
 ]);
 const off=new Set(sets.items.filter(item=>!item.enabled).map(item=>item.system));
 const seen=new Map();
 for(const item of [...own.items.map(row=>({...row,practice:true})),...catalogs.flatMap(result=>result.items||[])]) {
  if(!systems.includes(item.system)||off.has(item.system)||!terminologyComboboxEligible(item,{system:item.system,serviceDate}))continue;
  const key=item.system+':'+item.code;
  if(!seen.has(key))seen.set(key,{...item,id:key});
 }
 return [...seen.values()];
}
function editPracticeVisitType(host,item,current,refresh) {
 const selectedCodes={diagnoses:(item?.diagnoses||[]).map(row=>({...row})),procedures:(item?.procedures||[]).map(row=>({...row}))};
 const form=document.createElement('form');
 form.id='practice-visit-type-form';
 const pickers=[['diagnoses','Suggested diagnoses','ICD-10-CM'],['procedures','Suggested procedures','CPT / HCPCS']];
 const picker=([key,title,systems])=>`<section><h4>${title}</h4><div data-visit-type-codes="${key}"></div><label>Find a ${key==='diagnoses'?'diagnosis':'procedure'}<input name="${key}_lookup" maxlength="100" id="visit-type-${key}" placeholder="Search ${systems} by code or name" autocomplete="off">${typeaheadMarkup(key+'_lookup','visit-type-'+key)}</label></section>`;
 form.innerHTML=`<div class="form-grid">${practiceAdminInput('name','Display name',item?.name,80,'text',true)}<label>Duration (minutes)<input name="duration_minutes" type="number" min="5" max="480" step="1" list="visit-type-minutes" required value="${esc(item?.duration_minutes??30)}"><datalist id="visit-type-minutes">${[15,20,30,45,60].map(value=>`<option value="${value}"></option>`).join('')}</datalist><small>5 to 480 minutes</small></label></div>${practiceAdminInput('category','Scheduling category (optional)',item?.category===item?.name?'':item?.category,100)}${pickers.map(picker).join('')}<p role="status" data-visit-type-status></p><div class="actions"><button type="submit" class="primary">Save visit type</button><button type="button" data-sheet-close>Cancel</button></div>`;
 const dialog=sheetOpen(item?'Edit visit type':'Add visit type',form,{label:true});
 const status=form.querySelector('[data-visit-type-status]'),bindings=[];
 function draw(key){
  form.querySelector('[data-visit-type-codes="'+key+'"]').innerHTML=selectedCodes[key].map((row,index)=>`<div class="integration-access-row"><span><b>${esc(row.code)}</b> · ${esc(row.description)}${row.units>1?` × ${esc(row.units)}`:''}${row.modifiers?` · ${esc(row.modifiers)}`:''}</span><button type="button" data-remove-visit-code="${key}" data-index="${index}" aria-label="Remove ${esc(row.code)}">Remove</button></div>`).join('');
 }
 for(const [key] of pickers){
  draw(key);
  const diagnosis=key==='diagnoses',input=form.elements[key+'_lookup'];
  bindings.push(attachTypeahead(input,{all:()=>[],load:q=>practiceVisitTypeCodeSearch(diagnosis?['ICD-10-CM']:['CPT','HCPCS'],q),sourceLabel:'code list',serverMatches:true,label:row=>row.code,sub:row=>row.display,
   onPick(row){
    typeaheadSetValue(input,'','');
    const existing=selectedCodes[key].some(code=>code.code===row.code&&(diagnosis||code.code_system===row.system));
    if(existing){status.textContent=row.code+' is already suggested.';return;}
    if(selectedCodes[key].length>=(diagnosis?12:20)){status.textContent=diagnosis?'Up to 12 diagnoses may be suggested.':'Up to 20 procedures may be suggested.';return;}
    selectedCodes[key].push(diagnosis?{code:row.code,description:row.display}:{code_system:row.system,code:row.code,description:row.display,units:row.default_units||1,modifiers:row.modifiers||''});
    draw(key);status.textContent=row.code+' added.';
   }}));
 }
 dialog.addEventListener('close',()=>bindings.forEach(binding=>binding?.forget()),{once:true});
 form.addEventListener('click',event=>{
  const button=event.target.closest('[data-remove-visit-code]');if(!button)return;
  const key=button.dataset.removeVisitCode;selectedCodes[key].splice(Number(button.dataset.index),1);draw(key);form.elements[key+'_lookup'].focus();
 });
 let saving=false;
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(saving||!current())return;
  for(const [key] of pickers){
   const input=form.elements[key+'_lookup'];
   if(input.value.trim()){status.textContent='Select a matching code or clear the search before saving.';input.focus();return;}
  }
  const name=form.elements.name.value.trim();
  if(!name){status.textContent='Enter a display name.';form.elements.name.focus();return;}
  const body={name,category:form.elements.category.value.trim()||name,duration_minutes:Number(form.elements.duration_minutes.value),enabled:item?.enabled??true,...selectedCodes};
  saving=true;form.querySelector('[type="submit"]').disabled=true;status.textContent='Saving…';
  try{
   await api(item?practiceVisitTypesUrl+'/'+encodeURIComponent(item.id):practiceVisitTypesUrl,item?'PUT':'POST',body,item?.version);
   if(current()){if(dialog.open)sheetClose(dialog);await refresh();}
  }catch(error){
   if(!current()||!dialog.open)return;
   saving=false;form.querySelector('[type="submit"]').disabled=false;
   status.textContent=(error.status===412||error.status===409&&/changed|version/i.test(error.message))?'This visit type changed. Cancel and reopen Visit types to review the latest settings.':error.message;
  }
 });
 form.elements.name.focus();
}
