// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const connectOnboardingApi='/api/v1/connect/onboarding';
function connectOnboardingCard(data,connection){
 const p=data?.pending;
 if(p?.status==='completed')return '<section class="connect-onboarding"><h3>SunCharts connection set up</h3><p>Check the live status above for current connectivity. Your practice connection is set up. Manage appointment email and support in Connect services.</p><details><summary>Set up a different connection</summary><p>You will review and approve the practice connection again.</p><button type="button" data-connect-start>Reconnect to SunCharts</button></details></section>';
 const pending=p&&!['completed','cancelled','denied','failed'].includes(p.status);
 return `<section class="connect-onboarding"><h3>Connect to SunCharts</h3><p>Sign in at connect.suncharts.app, choose your practice and approve the connection. Your EHR opens a secure outbound connection and sets up clinical access, managed appointment email and support automatically. No public EHR address or inbound firewall port is needed.</p><p class="muted">No client secrets, installation tokens or email keys to copy. Your practice’s permissions and patient reminder consent still apply.</p>${!data?.available?`<p class="notice">${esc(data?.reason||'This installation is not ready to connect. Check its connection configuration.')}</p>`:''}${pending?`<p>Connection setup: ${esc(String(p.status).replaceAll('_',' '))}. ${p.expires_at?'Expires '+esc(date(p.expires_at))+'.':''}</p>`:''}<div class="actions">${pending?`<button class="primary" type="button" data-connect-resume ${['expired','cancelling'].includes(p.status)?'disabled':''}>Continue connection</button><button type="button" data-connect-cancel>${p.status==='cancelling'?'Retry cancellation':'Cancel setup'}</button>`:`<button class="primary" type="button" data-connect-start ${data?.available?'':'disabled'}>Connect to SunCharts</button>`}</div></section>`;
}
function connectAuthorizationDestination(value,expectedOrigin='https://connect.suncharts.app'){
 const expected=new URL(expectedOrigin);
 const loopback=expected.protocol==='http:'&&['127.0.0.1','[::1]'].includes(expected.hostname);
 if(!['https://connect.suncharts.app','https://my.suncharts.app'].includes(expected.origin)&&!loopback)throw new Error('Unexpected SunCharts service configuration.');
 const url=new URL(value);
 if(url.origin!==expected.origin||url.pathname!=='/connect/ehr'||url.username||url.password||url.hash)throw new Error('SunCharts returned an invalid authorization address. Start the connection again.');
 return url.href;
}
async function finishConnectOnboarding(){
 const query=new URLSearchParams(location.search),id=query.get('connect_onboarding');
 if(!id)return false;
 // The callback already stored the one-use code on the server. Keep only its
 // non-secret intent identifier in the browser until completion succeeds.
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('Invalid connection request. Start again from Connected apps.');
 await showApps();
 try{
  const data=await api(connectOnboardingApi),p=data.pending;
  if(!p||p.id!==id)throw new Error('This connection belongs to another session or has expired. Start again from Connected apps.');
  if(['denied','cancelled','expired','failed'].includes(p.status))throw new Error('Connection setup was not completed. You can start again from Connected apps.');
  const result=await api(`${connectOnboardingApi}/${id}/complete`,'POST',{},p.version);
  if((result.pending||result).status!=='completed')throw new Error('Connection setup is still pending. Choose Continue connection to check it again.');
  query.delete('connect_onboarding');history.replaceState(null,'',location.pathname+(query.size?'?'+query:'')+location.hash);
  const connection=await refreshConnectionBadge(true).catch(()=>null);await showApps();
  notice(connection?.status==='connected'?'Connected to SunCharts. Managed email and support are ready when included with your practice’s service.':'Authorization completed. Open connection details to check managed service availability.');
 }catch(error){notice(error.message,true);}
 return true;
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');
 if(!button||!['data-connect-start','data-connect-resume','data-connect-cancel'].some(a=>button.hasAttribute(a)))return;
 event.preventDefault();event.stopImmediatePropagation();run(async()=>{
  let data=await api(connectOnboardingApi);
  if(button.hasAttribute('data-connect-cancel')){
   if(!data.pending)throw new Error('No pending connection. Refresh Connected apps.');
   await api(`${connectOnboardingApi}/${data.pending.id}/cancel`,'POST',{},data.pending.version);
   const query=new URLSearchParams(location.search);query.delete('connect_onboarding');history.replaceState(null,'',location.pathname+(query.size?'?'+query:'')+location.hash);
   await showApps();notice('Connection setup cancelled.');return;
  }
  if(button.hasAttribute('data-connect-start')||data.pending?.status==='preparing')data=await api(connectOnboardingApi,'POST',{});
  const p=data.pending||data;
  if(['callback_received','exchanged','completing'].includes(p.status)){
   const query=new URLSearchParams(location.search);query.set('connect_onboarding',p.id);history.replaceState(null,'',location.pathname+'?'+query);await finishConnectOnboarding();return;
  }
  location.assign(connectAuthorizationDestination(data.authorization_url||p.authorization_url,p.cloud_origin||data.cloud_origin));
 });
},true);
