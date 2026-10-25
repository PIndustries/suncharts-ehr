// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// This profile never changes the immutable MRN/name/DOB patient identity.
let demographicsView;
const demographicsFields=[['preferred_name','Preferred name',100],['pronouns','Pronouns',100],['language','Preferred language',100],['phone','Phone',40],['email','Email',254]];
function demographicsSummary(profile) {
 const c=profile.content||{},a=c.address,e=c.emergency_contact;
 const line=(label,value)=>`<div class="summary-line"><b>${esc(label)}</b><span>${esc(value||'Not recorded')}</span></div>`;
 return `<section class="panel"><div class="section-head"><h2>Contact & demographics</h2>${['owner','clinician','front_desk'].includes(me.role)?'<button type="button" data-demographics-edit>Edit contact details</button>':''}</div><p class="muted">${profile.version===0?'Contact details have not been recorded.':'Saved profile · revision '+profile.version} · A missing field means unknown.</p><div class="chart-summary-grid"><div>${demographicsFields.map(([k,label])=>line(label,c[k])).join('')}</div><div>${line('Administrative gender',c.administrative_gender)}${line('Address',a?[a.line1,a.line2,a.city,a.region,a.postal_code,a.country].filter(Boolean).join(', '):null)}${line('Emergency contact',e?[e.name,e.relationship,e.phone].filter(Boolean).join(' · '):null)}</div></div><p class="muted">Core identity (MRN, name and birth date) is unchanged. Contact data is not delivery verification, consent or a guarantor record.</p><details><summary>Contact revision history</summary>${(profile.history||[]).map(r=>`<div class="amendment"><b>Revision ${r.version}</b><p>${esc(r.reason)}</p><small>${esc(date(r.created_at))} · Author ${esc(r.author_id)}</small><details><summary>Saved contact values</summary><dl>${Object.entries(r.content||{}).map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd>${esc(v&&typeof v==='object'?Object.values(v).filter(Boolean).join(' · '):v||'Not recorded')}</dd>`).join('')}</dl></details></div>`).join('')||'<p class="muted">No saved revisions.</p>'}${profile.history_truncated?'<p class="muted">Only the most recent 50 revisions are shown. Earlier revisions remain retained.</p>':''}</details></section>`;
}
async function renderDemographics(patientId, profile=undefined) {
 const data=profile||await api(`/api/v1/patients/${patientId}/demographics`);
 if(selected!==patientId)return '';
 demographicsView={patientId,profile:data};
 const html=demographicsSummary(data),target=$('patient-demographics');
 if(target)target.innerHTML=html;
 return html;
}
async function showPatientDemographics(patientId) {
 const profile=await api(`/api/v1/patients/${patientId}/demographics`);
 if(selected!==patientId)return;
 workspace.demographics=profile;await renderDemographics(patientId,profile);
}
function demographicsEdit() {
 if(!demographicsView||demographicsView.patientId!==selected)return;
 const {profile}=demographicsView,c=profile.content||{},a=c.address||{},e=c.emergency_contact||{};
 const input=(key,label,max,value,type='text')=>`<label>${esc(label)}<input name="${key}" type="${type}" maxlength="${max}" value="${esc(value||'')}" autocomplete="off"></label>`;
 $('patient-demographics').innerHTML=`<section class="panel"><h2>Edit contact details</h2><p class="muted">Blank means not recorded. This replaces the contact profile; it does not change MRN, legal name or birth date.</p><form id="demographics-form"><fieldset><legend>Patient contact</legend><div class="chart-summary-grid">${demographicsFields.map(([k,label,max])=>input(k,label,max,c[k],k==='email'?'email':'text')).join('')}<label>Administrative gender<select name="administrative_gender"><option value="">Not recorded</option>${['female','male','other','unknown'].map(v=>`<option value="${v}" ${v===c.administrative_gender?'selected':''}>${v}</option>`).join('')}</select></label></div></fieldset><fieldset><legend>Address</legend><div class="chart-summary-grid">${[['line1','Address line 1',200],['line2','Address line 2',200],['city','City',100],['region','State / region',100],['postal_code','Postal code',32],['country','Country (two-letter code)',2]].map(([k,label,max])=>input('address_'+k,label,max,a[k])).join('')}</div></fieldset><fieldset><legend>Emergency contact</legend><p class="muted">A name is required when other emergency contact details are provided.</p><div class="chart-summary-grid">${[['name','Contact name',200],['relationship','Relationship',100],['phone','Contact phone',40]].map(([k,label,max])=>input('emergency_'+k,label,max,e[k])).join('')}</div></fieldset><label>Reason for update<input name="reason" maxlength="1000" required autocomplete="off"></label><p class="notice error" data-demographics-error hidden role="alert"></p><div class="actions"><button type="submit" class="primary">Save contact details</button><button type="button" data-demographics-cancel>Cancel</button><button type="button" data-demographics-reload>Discard edits and reload</button></div></form></section>`;
 $('demographics-form').querySelector('input').focus();
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||!button.closest('#patient-demographics'))return;
 if(button.hasAttribute('data-demographics-edit'))demographicsEdit();
 if(button.hasAttribute('data-demographics-cancel')&&demographicsView)renderDemographics(demographicsView.patientId,demographicsView.profile);
 if(button.hasAttribute('data-demographics-reload')&&demographicsView)run(()=>showPatientDemographics(demographicsView.patientId));
});
document.addEventListener('submit',async event=>{
 if(event.target.id!=='demographics-form')return;
 event.preventDefault();if(event.target.dataset.saving==='true')return;if(!demographicsView||selected!==demographicsView.patientId)return;
 const form=event.target,{patientId,profile}=demographicsView,data=Object.fromEntries(new FormData(form)),content={};
 for(const [key]of demographicsFields)content[key]=data[key]||null;
 content.administrative_gender=data.administrative_gender||null;
 content.address=Object.fromEntries(['line1','line2','city','region','postal_code','country'].map(k=>[k,data['address_'+k]||null]));
 content.emergency_contact=Object.fromEntries(['name','relationship','phone'].map(k=>[k,data['emergency_'+k]||null]));
 form.dataset.saving='true';const controls=Array.from(form.querySelectorAll('button'));controls.forEach(b=>{b.disabled=true;});
 try {
  const saved=await api(`/api/v1/patients/${patientId}/demographics`,'PUT',{content,reason:data.reason},profile.version);
  if(selected===patientId){workspace.demographics=saved;await renderDemographics(patientId,saved);notice('Contact details saved.');}
 }catch(error){if(selected===patientId&&form.isConnected){const box=form.querySelector('[data-demographics-error]');box.textContent=error.message+' Your edits remain here. If the outcome is uncertain, reload before saving again.';box.hidden=false;}}
 finally{delete form.dataset.saving;controls.forEach(b=>{if(b.isConnected)b.disabled=false;});}
});
