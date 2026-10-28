// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const providerSettingsBase='/api/v1/billing/provider-settings';
let providerSettingsItems=[],providerPendingPartner=false;
async function showProviderSettingsPanel(){
 if(me.role!=='owner')return;
 const data=await api(providerSettingsBase);providerSettingsItems=data.items;
 const section=document.createElement('section');section.id='native-provider-settings';section.className='billing-section';
 section.innerHTML=`<div class="section-head"><div><h3>Clearinghouse API settings</h3><p class="muted">Connect your Claim.MD account from this workspace.</p></div><button type="button" data-provider-new>+ Claim.MD connection</button></div><p class="muted">Account keys are encrypted on the server and are never shown again. Save a connection, test authentication, then enable delivery and retrieval. A successful authentication test does not verify payer enrollment or authorize a claim submission.</p>${data.credential_storage_ready?'':'<div class="notice error">Saved credentials cannot be decrypted. Restore the server’s private credential encryption key from backup before testing or enabling connections.</div>'}<div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Connection / partner</th><th>Mode</th><th>Authentication</th><th>Automation</th><th></th></tr></thead><tbody>${data.items.map(v=>`<tr><td><b>${esc(v.label)}</b><small>Claim.MD · ${esc(ediPartners.find(p=>p.id===v.partner_id)?.content.name||'Saved trading partner')}</small></td><td>${v.usage==='T'?'Test account':'Production account'}</td><td>${v.verified?'Verified with payer directory':v.last_test_at?'Not verified':'Not tested'}<small>${v.last_test_at?esc(date(v.last_test_at)):'Run a connection test after saving'}</small></td><td>${v.enabled?'Enabled':'Disabled'}</td><td><button type="button" data-provider-open="${esc(v.id)}">Settings</button></td></tr>`).join('')||'<tr><td colspan="5">No saved Claim.MD account. Add a connection to enter its AccountKey.</td></tr>'}</tbody></table></div>`;
 const previous=$('native-provider-settings');if(previous)previous.replaceWith(section);else $('edi-automation').prepend(section);
}
async function openProviderSettings(id,preferredPartner){
 const [partners,detail]=await Promise.all([api('/api/v1/billing/clearinghouses'),id?api(`${providerSettingsBase}/${id}`):Promise.resolve(null)]);
 const setting=detail?.setting;
 if(!setting&&!partners.items.some(p=>p.content.active)){
  ediPane('<section id="provider-settings-editor" class="billing-account-detail"><div class="section-head"><h2>Connect Claim.MD</h2><button type="button" data-provider-close>Close</button></div><h3>First, create your trading partner profile</h3><p>The profile holds the identifiers used in your claim files. It is separate from your Claim.MD AccountKey.</p><p>Have your enrollment or companion-guide details ready: submitter and receiver identifiers, organization, contact details, and test or production mode.</p><ol><li>Create and save an active trading partner profile.</li><li>Enter your AccountKey on the connection screen.</li><li>Test authentication, then explicitly enable delivery and retrieval.</li></ol><button type="button" class="primary" data-provider-create-partner>Create trading partner & continue</button></section>');return;
 }
 const initialPartner=partners.items.find(p=>p.id===(setting?.partner_id||preferredPartner));
 const start=setting?localTime(setting.start_at):localTime(new Date(Date.now()-86400000).toISOString());
 ediPane(`<section id="provider-settings-editor" class="billing-account-detail"><div class="section-head"><div><h2>${setting?'Claim.MD connection settings':'Connect Claim.MD'}</h2><p class="muted">Credentials and activation are restricted to practice owners.</p></div><button type="button" data-provider-close>Close</button></div><form id="provider-settings-form" data-id="${esc(setting?.id||'')}" data-version="${setting?.version||''}"><div class="form-grid"><label>Connection name<input name="label" required maxlength="120" value="${esc(setting?.label||'Claim.MD')}" autocomplete="off"></label><label>Trading partner<select name="partner_id" required ${setting?'disabled':''}><option value="">Select an active partner</option>${partners.items.filter(p=>p.content.active||p.id===setting?.partner_id).map(p=>`<option value="${esc(p.id)}" ${p.id===(setting?.partner_id||preferredPartner)?'selected':''}>${esc(p.content.name)} · ${p.content.usage==='T'?'Test':'Production'}</option>`).join('')}</select></label><label>Account mode<select name="usage" ${setting?'disabled':''}><option value="T" ${(setting?.usage||initialPartner?.content.usage)!=='P'?'selected':''}>Test account</option><option value="P" ${(setting?.usage||initialPartner?.content.usage)==='P'?'selected':''}>Production account</option></select></label><label>Claim.MD AccountKey ${setting?'(leave blank to keep saved key)':''}<input name="account_key" type="password" ${setting?'':'required'} minlength="8" maxlength="512" autocomplete="new-password" spellcheck="false" autocapitalize="off"></label><label>Discovery starts at<input name="start_at" type="datetime-local" required value="${esc(start)}"></label><label>Initial claim response ID<input name="response_id" required inputmode="numeric" pattern="[0-9]{1,20}" value="${esc(setting?.response_id||'0')}"></label><label>Polling interval (seconds)<input name="interval_seconds" type="number" min="30" max="86400" required value="${setting?.interval_seconds||60}"></label></div><p class="muted">Get your AccountKey in Claim.MD → Settings → Account Settings. Test and production use the same service endpoints; choose the mode matching your actual account and trading partner. Changing a key or discovery start creates a new route and pauses the previous route, preserving its history. Automatic remittance staging remains a separate opt-in setting; this connection never auto-posts payments.</p><p class="muted">Saving changes disables this connection. Review the saved settings and enable it explicitly. Create a separate connection to change trading partner or account mode.</p><button type="submit" class="primary">${setting?'Save connection settings':'Save encrypted credentials'}</button></form>${setting?`<section class="billing-section"><h3>Connection status</h3><p><span class="pill">${setting.enabled?'Automation enabled':'Automation disabled'}</span> <span class="pill">${setting.verified?'Authentication verified':setting.last_test_at?'Authentication not verified':'Authentication not tested'}</span></p><p class="muted">${setting.last_test_at?'Last test '+esc(date(setting.last_test_at))+'. ':''}The test queries the payer directory. It does not submit a claim or change discovery cursors.</p><div class="actions"><button type="button" data-provider-test="${esc(setting.id)}" data-version="${setting.version}">Test saved AccountKey</button><button type="button" ${!setting.enabled&&!setting.verified?'disabled':''} data-provider-activate="${esc(setting.id)}" data-enabled="${setting.enabled?'false':'true'}" data-version="${setting.version}" class="${setting.enabled?'':'primary'}">${setting.enabled?'Disable connection':'Enable delivery & retrieval'}</button></div><details class="amendment"><summary>Advanced connection identifiers</summary><p>Route: ${esc(setting.route_key)}<br>Settings record: ${esc(setting.id)}</p></details><details class="amendment"><summary>Settings history</summary>${detail.events.map(e=>`<p>v${e.version} · ${esc(e.action.replaceAll('_',' '))}<br><small>${esc(date(e.created_at))}</small></p>`).join('')}</details></section>`:''}<p class="muted">Server backups must retain both the database and its private credential encryption key. Downloaded source code and API responses exclude credentials.</p></section>`);
 $('provider-settings-form').providerSetting=setting;
}
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='provider-settings-form')return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  const data=Object.fromEntries(new FormData(form));const saved=form.providerSetting;
  data.partner_id=saved?.partner_id||data.partner_id;data.usage=saved?.usage||data.usage;
  if(!data.account_key)delete data.account_key;
  data.start_at=scheduleInstant(data.start_at);data.interval_seconds=Number(data.interval_seconds);
  const result=await api(saved?`${providerSettingsBase}/${saved.id}`:providerSettingsBase,saved?'PUT':'POST',data,saved?.version);
  form.elements.account_key.value='';delete data.account_key;
  await showEdiWorkspace();await openProviderSettings(result.id);notice('Connection saved with automation disabled. Test the saved key and explicitly enable the connection when ready.');
 });
},true);
document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!['data-provider-new','data-provider-open','data-provider-close','data-provider-test','data-provider-activate','data-provider-create-partner'].some(name=>button.hasAttribute(name)))return;
 event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  if(button.hasAttribute('data-provider-create-partner')){providerPendingPartner=true;ediPartnerEditor();$('edi-partner-form').insertAdjacentHTML('afterbegin','<div class="mapping-notice">Step 1 of 3: save an active trading partner profile. The Claim.MD credential screen will open next.</div>');return;}
  if(button.hasAttribute('data-provider-new')){await openProviderSettings();return;}
  if(button.dataset.providerOpen){await openProviderSettings(button.dataset.providerOpen);return;}
  if(button.hasAttribute('data-provider-close')){await showEdiWorkspace();return;}
  const form=$('provider-settings-form');
  if(form&&(form.elements.account_key.value||form.elements.label.value!==form.providerSetting.label||form.elements.start_at.value!==localTime(form.providerSetting.start_at)||form.elements.response_id.value!==form.providerSetting.response_id||Number(form.elements.interval_seconds.value)!==form.providerSetting.interval_seconds))throw new Error('Save the changed settings before testing or activating.');
  const id=button.dataset.providerTest||button.dataset.providerActivate;
  if(button.dataset.providerTest){const result=await api(`${providerSettingsBase}/${id}/test`,'POST',{},Number(button.dataset.version));await showEdiWorkspace();await openProviderSettings(id);notice(result.authenticated?'Claim.MD authenticated the saved key. Enable the connection separately when ready.':'Claim.MD authentication could not be verified. Check the saved key and account; no claims were sent.',!result.authenticated);return;}
  await api(`${providerSettingsBase}/${id}/activation`,'POST',{enabled:button.dataset.enabled==='true'},Number(button.dataset.version));await showEdiWorkspace();await openProviderSettings(id);notice(button.dataset.enabled==='true'?'Delivery and retrieval enabled for this saved connection.':'Connection disabled. Delivery and retrieval are paused.');
 });
},true);

async function providerPartnerCreated(partner){
 if(!providerPendingPartner)return;
 providerPendingPartner=false;await openProviderSettings(null,partner.id);
}
document.addEventListener('change',event=>{
 if(event.target.name!=='partner_id'||event.target.form?.id!=='provider-settings-form'||event.target.form.providerSetting)return;
 const partner=ediPartners.find(p=>p.id===event.target.value);
 if(partner)event.target.form.elements.usage.value=partner.content.usage;
});
