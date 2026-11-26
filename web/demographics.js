// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// This profile never changes the immutable MRN/name/DOB patient identity.
let demographicsView;
const demographicsFields=[['preferred_name','Preferred name',100],['pronouns','Pronouns',100],['language','Preferred language',100],['phone','Phone',40],['email','Email',254]];
function demographicsSummary(profile) {
 const c=profile.content||{},a=c.address,e=c.emergency_contact;
 const line=(label,value)=>`<div class="summary-line"><b>${esc(label)}</b><span>${esc(value||'Not recorded')}</span></div>`;
 const editable=['owner','clinician','front_desk'].includes(me.role);
 const card=(title,part,body)=>`<section class="panel profile-card"><div class="section-head"><h2>${title}</h2>${editable?`<button type="button" data-demographics-edit="${part}">Edit</button>`:''}</div>${body}</section>`;
 const pharmacy=typeof prescribingStates!=='undefined'?prescribingStates.get(selected):null;
 const intake=typeof patientIntakeState!=='undefined'&&patientIntakeState?.patient===selected?patientIntakeState:null;
 const latest=intake?.items?.[0];
 return `<p class="muted">${profile.version===0?'No contact details yet. ':''}Blank fields have not been collected yet.</p><div class="profile-cards">${card('Contact','contact',line('Preferred name',c.preferred_name)+line('Pronouns',c.pronouns)+line('Gender',c.administrative_gender?human(c.administrative_gender):null)+line('Mobile',c.phone)+line('Email',c.email)+line('Language',c.language))}${card('Address','address',line('Address',a?[a.line1,a.line2,a.city,a.region,a.postal_code,a.country].filter(Boolean).join(', '):null))}${card('Emergency contact','emergency',line('Name',e?.name)+line('Relationship',e?.relationship)+line('Phone',e?.phone))}<section class="panel profile-card"><div class="section-head"><h2>Preferred pharmacy</h2><button type="button" data-profile-pharmacy>Edit</button></div>${line('Pharmacy',pharmacy?rxPharmacyLabel(pharmacy,pharmacy.preference.pharmacy_id):null)}</section>${editable?`<section class="panel profile-card"><div class="section-head"><h2>Patient portal</h2><details data-inline data-menu><summary>More ▾</summary><div class="frame-add-items"><button type="button" data-portal-access="${esc(selected)}">Manage portal access</button></div></details></div><span id="profile-portal-status" class="pill">${esc(typeof patientBanner!=='undefined'&&patientBanner.patient===selected?displayStatus(patientBanner.data?.flags?.portal_status)||'Not recorded':'Not recorded')}</span></section>`:''}${typeof chartAreaEnabled==='function'&&chartAreaEnabled('documents')?`<section class="panel profile-card"><div class="section-head"><h2>Intake forms</h2><button type="button" data-profile-intakes>Send an intake form</button></div><span id="profile-intake-status" class="pill">${esc(latest?.status?displayStatus(latest.status):'No intake form sent yet.')}</span><button type="button" data-patient-intakes-open>Open intake forms</button></section>`:''}</div><details><summary>Change history</summary>${(profile.history||[]).map(r=>`<div class="amendment"><b>Revision ${r.version}</b><p>${esc(r.reason)}</p><small>${esc(date(r.created_at))} · ${esc(r.author_label||r.author_id||'Earlier registration')}</small><details><summary>Saved contact values</summary><dl>${Object.entries(r.content||{}).map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd>${esc(v&&typeof v==='object'?Object.values(v).filter(Boolean).join(' · '):v||'Not recorded')}</dd>`).join('')}</dl></details></div>`).join('')||'<p class="muted">No saved revisions.</p>'}${profile.history_truncated?'<p class="muted">Only the most recent 50 revisions are shown. Earlier revisions remain retained.</p>':''}</details>`;
}
async function renderDemographics(patientId, profile=undefined) {
 const data=profile||await api(`/api/v1/patients/${patientId}/demographics`);
 if(selected!==patientId)return '';
 if(demographicsSheet?.isConnected)sheetClose(demographicsSheet);
 demographicsView={patientId,profile:data};
 const html=demographicsSummary(data),target=$('patient-demographics');
 if(target)target.innerHTML=html;
 return html;
}
async function showPatientDemographics(patientId) {
 const identity=me,chartWorkspace=workspace,target=$('patient-demographics');
 const profile=await api(`/api/v1/patients/${patientId}/demographics`);
 if(selected!==patientId||me!==identity||workspace!==chartWorkspace||$('patient-demographics')!==target)return;
 workspace.demographics=profile;await renderDemographics(patientId,profile);
 if(typeof refreshChartContactSummary==='function')refreshChartContactSummary();
}
let demographicsSheet;
function demographicsEdit(part='contact') {
 if(!demographicsView||demographicsView.patientId!==selected)return;
 const {profile}=demographicsView,c=profile.content||{},a=c.address||{},e=c.emergency_contact||{};
 const input=(key,label,max,value,type='text')=>`<label>${esc(label)}<input name="${key}" type="${type}" maxlength="${max}" value="${esc(value||'')}" autocomplete="off"></label>`;
 const editor=document.createElement('div');editor.id='profile-contact-editor';editor.innerHTML=`<section class="panel"><h2>Edit contact details</h2><p class="muted">Blank means not recorded. This replaces the contact profile; it does not change MRN, legal name or birth date.</p><form id="demographics-form"><fieldset><legend>Patient contact</legend><div class="chart-summary-grid">${demographicsFields.map(([k,label,max])=>input(k,label,max,c[k],k==='email'?'email':'text')).join('')}<label>Administrative gender<select name="administrative_gender"><option value="">Not recorded</option>${['female','male','other','unknown'].map(v=>`<option value="${v}" ${v===c.administrative_gender?'selected':''}>${v}</option>`).join('')}</select></label></div></fieldset><fieldset><legend>Address</legend><div class="chart-summary-grid">${[['line1','Address line 1',200],['line2','Address line 2',200],['city','City',100],['region','State / region',100],['postal_code','Postal code',32],['country','Country (two-letter code)',2]].map(([k,label,max])=>input('address_'+k,label,max,a[k])).join('')}</div></fieldset><fieldset><legend>Emergency contact</legend><p class="muted">A name is required when other emergency contact details are provided.</p><div class="chart-summary-grid">${[['name','Contact name',200],['relationship','Relationship',100],['phone','Contact phone',40]].map(([k,label,max])=>input('emergency_'+k,label,max,e[k])).join('')}</div></fieldset><label>Reason for update<input name="reason" maxlength="1000" required autocomplete="off"></label><p class="notice error" data-demographics-error hidden role="alert"></p><div class="actions"><button type="submit" class="primary">Save contact details</button><button type="button" data-demographics-cancel>Cancel</button><button type="button" data-demographics-reload>Discard edits and reload</button></div></form></section>`;
 demographicsSheet=sheetOpen('Edit '+part,editor);
 const form=$('demographics-form');
 const groups={contact:['preferred_name','pronouns','language','phone','email','administrative_gender'],address:['address_'],emergency:['emergency_']};
 for(const field of form.querySelectorAll('input,select'))if(field.name!=='reason'&&!groups[part].some(key=>field.name===key||field.name.startsWith(key)))field.closest('label').hidden=true;
 for(const fieldset of form.querySelectorAll('fieldset'))fieldset.hidden=!Array.from(fieldset.querySelectorAll('label')).some(label=>!label.hidden);
 form.querySelector('label:not([hidden]) input,label:not([hidden]) select')?.focus();
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||!button.closest('#patient-demographics,#profile-contact-editor'))return;
 if(button.hasAttribute('data-demographics-edit'))demographicsEdit(button.getAttribute('data-demographics-edit')||'contact');
 if(button.hasAttribute('data-demographics-cancel'))sheetClose(demographicsSheet);
 if(button.hasAttribute('data-demographics-reload')&&demographicsView)run(async()=>{sheetClose(demographicsSheet);await showPatientDemographics(demographicsView.patientId);});
});
document.addEventListener('submit',async event=>{
 if(event.target.id!=='demographics-form'||demographicsSheet?.dataset?.closing)return;
 event.preventDefault();if(event.target.dataset.saving==='true')return;if(!demographicsView||selected!==demographicsView.patientId)return;
 const form=event.target,view=demographicsView,{patientId,profile}=view,identity=me,chartWorkspace=workspace,target=$('patient-demographics'),data=Object.fromEntries(new FormData(form)),content={};
 const sameChart=()=>selected===patientId&&me===identity&&workspace===chartWorkspace&&$('patient-demographics')===target;
 const current=()=>sameChart()&&demographicsView===view&&form.isConnected;
 for(const [key]of demographicsFields)content[key]=data[key]||null;
 content.administrative_gender=data.administrative_gender||null;
 content.address=Object.fromEntries(['line1','line2','city','region','postal_code','country'].map(k=>[k,data['address_'+k]||null]));
 content.emergency_contact=Object.fromEntries(['name','relationship','phone'].map(k=>[k,data['emergency_'+k]||null]));
 form.dataset.saving='true';const controls=Array.from(form.querySelectorAll('button,input,select,textarea'));controls.forEach(b=>{b.disabled=true;});
 try {
  const saved=await api(`/api/v1/patients/${patientId}/demographics`,'PUT',{content,reason:data.reason},profile.version);
  if(current()){sheetClose(demographicsSheet);workspace.demographics=saved;await renderDemographics(patientId,saved);if(!sameChart())return;if(typeof refreshChartContactSummary==='function')refreshChartContactSummary();if(typeof patientIdentityStates!=='undefined'&&patientIdentityStates.has(patientId))showPatientIdentity(patientIdentityStates.get(patientId));notice('Contact details saved.');}
 }catch(error){if(current()){const box=form.querySelector('[data-demographics-error]');box.textContent=error.message+' Your edits remain here. If the outcome is uncertain, reload before saving again.';box.hidden=false;}}
 finally{delete form.dataset.saving;controls.forEach(b=>{if(b.isConnected)b.disabled=false;});}
});

let profilePharmacySheet;
function profilePharmacyRefresh(){
 if(!profilePharmacySheet?.isConnected)return;
 const form=$('prescribing-preference-form');if(!form||profilePharmacySheet.contains(form))return;
 const section=form.closest('.clinical-entry');
 profilePharmacySheet.profileReturn={parent:section.parentNode,next:section.nextSibling,hidden:false};profilePharmacySheet.profileNode=section;
 profilePharmacySheet.querySelector('.sheet-body').replaceChildren(section);
}
function profileMoveEditor(title,node){
 if(!node)return;
 const parent=node.parentNode,next=node.nextSibling,hidden=node.hidden;node.hidden=false;
 const dialog=sheetOpen(title,node);
 dialog.profileNode=node;dialog.profileReturn={parent,next,hidden};
 dialog.addEventListener('close',()=>{const {parent,next,hidden}=dialog.profileReturn,node=dialog.profileNode;if(parent.isConnected){parent.insertBefore(node,next?.parentNode===parent?next:null);node.hidden=hidden;}});
 return dialog;
}
document.addEventListener('click',event=>{
 if(event.target.closest?.('[data-profile-pharmacy]')){
  const form=$('prescribing-preference-form');
  profilePharmacySheet=profileMoveEditor('Preferred pharmacy',form?.closest('.clinical-entry'));
 }
 if(event.target.closest?.('[data-profile-intakes]'))profileMoveEditor('Intake forms',$('patient-intake-panel'));
});
