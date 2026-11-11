// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let billingOrganizationState=null;
function renderBillingOrganizationAdminEntry(){return '<button type="button" data-billing-organizations>Billing organizations</button>';}
async function showBillingOrganizations(){
 if(me?.role!=='owner')throw new Error('Only a practice owner can manage billing organizations.');
 const identity=me;showTool('Practice administration');$('tools').innerHTML='<section id="billing-organizations" class="panel"><p>Loading billing organizations…</p></section>';$('tools').hidden=false;
 const host=$('billing-organizations'),data=await api('/api/v1/practice/billing-organizations');
 if(me!==identity||$('billing-organizations')!==host)return;
 const state={identity,host,items:data.items};billingOrganizationState=state;
 host.innerHTML=`<div class="section-head"><div><h2>Billing organizations</h2><p>Use the practice’s actual billing tax identity for eligibility. Saving an identity does not verify payer enrollment.</p></div><button type="button" data-billing-org-providers>Manage providers</button></div><p class="muted">Tax IDs are encrypted and shown only by their last four digits. Changes apply to future requests; saved eligibility history remains unchanged.</p><button type="button" class="primary" data-billing-org-new>Add billing organization</button><table class="billing-table"><thead><tr><th>Name</th><th>Tax identity</th><th>Status</th><th>Actions</th></tr></thead><tbody>${data.items.map(row=>`<tr><td>${esc(row.name)}</td><td>${esc(row.tax_id_type==='E'?'EIN':'SSN')} ending ${esc(row.tax_id_last4)}</td><td>${row.active?'Active':'Inactive'}</td><td><button type="button" data-billing-org-edit="${esc(row.id)}">Edit</button> <button type="button" data-billing-org-history="${esc(row.id)}">History</button></td></tr>`).join('')||'<tr><td colspan="4">No billing organization configured. Add the verified practice tax identity before checking eligibility.</td></tr>'}</tbody></table><div id="billing-org-editor"></div><div id="billing-org-history"></div>`;
}
function billingOrganizationCurrent(state){return state&&billingOrganizationState===state&&state.identity===me&&$('billing-organizations')===state.host;}
function editBillingOrganization(id){
 const state=billingOrganizationState;if(!billingOrganizationCurrent(state))return;
 const row=id?state.items.find(item=>item.id===id):null;if(id&&!row)return;
 state.editing=row;state.requestId=crypto.randomUUID();
 $('billing-org-editor').innerHTML=`<section class="billing-section"><h3>${row?'Edit':'Add'} billing organization</h3><form id="billing-org-form"><div class="form-grid"><label>Legal billing name<input name="name" maxlength="200" required value="${esc(row?.name||'')}" autocomplete="organization"></label><label>Tax ID type<select name="tax_id_type"><option value="E" ${row?.tax_id_type!=='S'?'selected':''}>Employer identification number (EIN)</option><option value="S" ${row?.tax_id_type==='S'?'selected':''}>Social Security number (SSN)</option></select></label><label>${row?'Replace tax ID (leave blank to keep current)':'Tax ID (nine digits)'}<input name="tax_id" type="password" inputmode="numeric" pattern="[0-9]{9}" minlength="9" maxlength="9" autocomplete="new-password" ${row?'':'required'}></label><label>Status<select name="active"><option value="true" ${row?.active!==false?'selected':''}>Active</option><option value="false" ${row?.active===false?'selected':''}>Inactive</option></select></label><label>Reason for change<input name="reason" maxlength="1000" required></label></div>${row?`<p>Current ${esc(row.tax_id_type==='E'?'EIN':'SSN')} ends in ${esc(row.tax_id_last4)}. Full tax IDs are never displayed.</p>`:''}<p class="notice error" data-org-error hidden role="alert"></p><button type="submit" class="primary">Save billing organization</button> <button type="button" data-billing-org-cancel>Cancel</button></form></section>`;
}
async function saveBillingOrganization(form){
 const state=billingOrganizationState;if(!billingOrganizationCurrent(state)||$('billing-org-form')!==form||form.dataset.saving==='true')return;
 const row=state.editing,data=Object.fromEntries(new FormData(form));data.name=data.name.trim();data.reason=data.reason.trim();data.active=data.active==='true';if(!data.tax_id)delete data.tax_id;if(!row)data.request_id=state.requestId;
 form.dataset.saving='true';const button=form.querySelector('[type="submit"]');button.disabled=true;
 try{await api(`/api/v1/practice/billing-organizations${row?'/'+row.id:''}`,row?'PUT':'POST',data,row?.version);if(!billingOrganizationCurrent(state)||$('billing-org-form')!==form)return;form.elements.tax_id.value='';await showBillingOrganizations();notice('Billing organization saved. Eligibility uses the reviewed current identity.');}
 catch(error){if(billingOrganizationCurrent(state)&&$('billing-org-form')===form){const box=form.querySelector('[data-org-error]');box.textContent=error.message;box.hidden=false;}}
 finally{delete form.dataset.saving;if(button.isConnected)button.disabled=false;}
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.hasAttribute('data-billing-organizations')){event.preventDefault();run(showBillingOrganizations);return;}
 if(!button.closest('#billing-organizations'))return;
 if(button.hasAttribute('data-billing-org-providers'))run(()=>showPracticeAdmin('providers'));
 if(button.hasAttribute('data-billing-org-new'))editBillingOrganization();
 if(button.dataset.billingOrgEdit)editBillingOrganization(button.dataset.billingOrgEdit);
 if(button.hasAttribute('data-billing-org-cancel')){$('billing-org-form')?.reset();$('billing-org-editor').replaceChildren();}
 if(button.dataset.billingOrgHistory)run(async()=>{const state=billingOrganizationState,id=button.dataset.billingOrgHistory,data=await api(`/api/v1/practice/billing-organizations/${id}/history`);if(!billingOrganizationCurrent(state)||!button.isConnected)return;$('billing-org-history').innerHTML=`<h3>Billing organization history</h3>${data.items.map(item=>`<article class="amendment"><b>Revision ${esc(item.version)} · ${esc(item.content.name)}</b><p>${esc(item.reason)}</p><p>${esc(item.content.tax_id_type)} ending ${esc(item.content.tax_id_last4)} · ${item.content.active?'Active':'Inactive'}</p><small>${esc(date(item.created_at))} · ${esc(item.actor_id)}</small></article>`).join('')}`;});
});
document.addEventListener('submit',event=>{if(event.target.id!=='billing-org-form')return;event.preventDefault();run(()=>saveBillingOrganization(event.target));});
