// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const providerSettingsBase='/api/v1/billing/provider-settings';
let providerSettingsItems=[];

async function showProviderSettingsPanel(){
 if(me.role!=='owner')return;
 const data=await api(providerSettingsBase);providerSettingsItems=data.items;
 const section=document.createElement('section');section.id='native-provider-settings';section.className='billing-section';
 section.innerHTML=`<div class="section-head"><div><h3>Claim.MD</h3><p class="muted">Native claim upload, status, payer directory and ERA retrieval.</p></div><button type="button" data-provider-new>Connect Claim.MD</button></div><p class="muted">Enter the AccountKey from Claim.MD Account Settings. The native API uses that key for the practice; no trading-partner profile is required.</p>${data.credential_storage_ready?'':'<div class="notice error">Saved credentials cannot be decrypted. Restore the server’s private credential encryption key from backup before testing or enabling connections.</div>'}<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Claim.MD account</th><th>Mode</th><th>Authentication</th><th>Automation</th><th></th></tr></thead><tbody>${data.items.map(v=>`<tr><td><b>${esc(v.label)}</b><small>Native Claim.MD API</small></td><td>${v.usage==='T'?'Test':'Production'}</td><td>${v.verified?'AccountKey verified':v.last_test_at?'Not verified':'Not tested'}<small>${v.last_test_at?esc(date(v.last_test_at)):'Test after saving'}</small></td><td>${v.enabled?'Delivery and retrieval enabled':'Disabled'}</td><td><button type="button" data-provider-open="${esc(v.id)}">Manage</button></td></tr>`).join('')||'<tr><td colspan="5">Claim.MD is not connected. Add the AccountKey to begin.</td></tr>'}</tbody></table></div>`;
 const previous=$('native-provider-settings');if(previous)previous.replaceWith(section);else $('edi-automation').prepend(section);
}

async function openProviderSettings(id){
 const detail=id?await api(`${providerSettingsBase}/${id}`):null;
 const setting=detail?.setting;
 const start=setting?localTime(setting.start_at):localTime(new Date(Date.now()-86400000).toISOString());
 ediPane(`<section id="provider-settings-editor" class="billing-account-detail"><div class="section-head"><div><h2>${setting?'Manage Claim.MD':'Connect Claim.MD'}</h2><p class="muted">One native connection for this practice. No sender, receiver or trading-partner form.</p></div><button type="button" data-provider-close>Close</button></div><form id="provider-settings-form" data-id="${esc(setting?.id||'')}" data-version="${setting?.version||''}"><div class="form-grid"><label>Connection name<input name="label" required maxlength="120" value="${esc(setting?.label||'Claim.MD')}" autocomplete="off"></label><label>Account mode<select name="usage" ${setting?'disabled':''}><option value="T" ${(setting?.usage||'T')==='T'?'selected':''}>Test</option><option value="P" ${setting?.usage==='P'?'selected':''}>Production</option></select></label><label>Claim.MD AccountKey ${setting?'(leave blank to keep saved key)':''}<input name="account_key" type="password" ${setting?'':'required'} minlength="8" maxlength="512" autocomplete="new-password" spellcheck="false" autocapitalize="off"></label></div><details class="amendment"><summary>Advanced retrieval settings</summary><div class="form-grid"><label>Discovery starts at<input name="start_at" type="datetime-local" required value="${esc(start)}"></label><label>Initial response ID<input name="response_id" required inputmode="numeric" pattern="[0-9]{1,20}" value="${esc(setting?.response_id||'0')}"></label><label>Polling interval (seconds)<input name="interval_seconds" type="number" min="30" max="86400" required value="${setting?.interval_seconds||60}"></label></div></details><p class="muted">The key is encrypted in this EHR instance and never shown again. SunCharts uploads Claim.MD professional-claim JSON with the AccountKey, then uses the same key for response and ERA APIs. Saving never submits a claim or posts an ERA.</p><button type="submit" class="primary">${setting?'Save settings':'Save and continue'}</button></form>${setting?`<section class="billing-section"><h3>Connection status</h3><p><span class="pill">${setting.enabled?'Automation enabled':'Automation disabled'}</span> <span class="pill">${setting.verified?'AccountKey verified':setting.last_test_at?'Authentication failed':'Not tested'}</span></p><p class="muted">The test reads Claim.MD's payer directory. It sends no claim and changes no retrieval cursor.</p><div class="actions"><button type="button" data-provider-test="${esc(setting.id)}" data-version="${setting.version}">Test AccountKey</button><button type="button" ${!setting.enabled&&!setting.verified?'disabled':''} data-provider-activate="${esc(setting.id)}" data-enabled="${setting.enabled?'false':'true'}" data-version="${setting.version}" class="${setting.enabled?'':'primary'}">${setting.enabled?'Disable':'Enable delivery & retrieval'}</button></div><details class="amendment"><summary>Technical details and history</summary><p>Route: ${esc(setting.route_key)}<br>Settings record: ${esc(setting.id)}</p>${detail.events.map(e=>`<p>v${e.version} · ${esc(e.action.replaceAll('_',' '))}<br><small>${esc(date(e.created_at))}</small></p>`).join('')}</details></section>`:''}</section>`);
 $('provider-settings-form').providerSetting=setting;
}

document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='provider-settings-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  const data=Object.fromEntries(new FormData(form));const saved=form.providerSetting;
  data.usage=saved?.usage||data.usage;if(!data.account_key)delete data.account_key;
  data.start_at=scheduleInstant(data.start_at);data.interval_seconds=Number(data.interval_seconds);
  const result=await api(saved?`${providerSettingsBase}/${saved.id}`:providerSettingsBase,saved?'PUT':'POST',data,saved?.version);
  form.elements.account_key.value='';await showEdiWorkspace();await openProviderSettings(result.id);notice('Claim.MD settings saved. Test the AccountKey, then enable the connection when ready.');
 });
},true);

document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!['data-provider-new','data-provider-open','data-provider-close','data-provider-test','data-provider-activate'].some(name=>button.hasAttribute(name)))return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  if(button.hasAttribute('data-provider-new')){await openProviderSettings();return;}
  if(button.dataset.providerOpen){await openProviderSettings(button.dataset.providerOpen);return;}
  if(button.hasAttribute('data-provider-close')){await showEdiWorkspace();return;}
  const form=$('provider-settings-form');
  if(form&&form.elements.account_key.value)throw new Error('Save the new AccountKey before testing or enabling.');
  const id=button.dataset.providerTest||button.dataset.providerActivate;
  if(button.dataset.providerTest){const result=await api(`${providerSettingsBase}/${id}/test`,'POST',{},Number(button.dataset.version));await showEdiWorkspace();await openProviderSettings(id);notice(result.authenticated?'Claim.MD verified the saved AccountKey.':'Claim.MD did not verify the saved AccountKey. No claim was sent.',!result.authenticated);return;}
  await api(`${providerSettingsBase}/${id}/activation`,'POST',{enabled:button.dataset.enabled==='true'},Number(button.dataset.version));await showEdiWorkspace();await openProviderSettings(id);notice(button.dataset.enabled==='true'?'Claim.MD delivery and retrieval enabled.':'Claim.MD delivery and retrieval disabled.');
 });
},true);
