// SPDX-License-Identifier: AGPL-3.0-only
// Open the exact reviewed communication produced by a native workflow dispatch.
// This handoff only reads local drafts; approval and sending keep their own gates.
async function openWorkflowCommunicationDraft(provider,integrationId,draftId){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!['ringcentral','gmail'].includes(provider)||!uuid.test(integrationId)||!uuid.test(draftId))throw new Error('This workflow communication reference is invalid.');
 const account=me;if(!account||account.role==='patient')throw new Error('Sign in with a permitted staff account to review this communication.');
 showTool('Send & review');
 const host=$('tools'),loading=document.createElement('p');loading.className='muted';loading.textContent='Loading workflow communication for review…';
 host.className='integration-operations';host.replaceChildren(loading);
 const current=()=>me===account&&$('tools')===host&&!host.hidden&&host.contains(loading);
 const base=provider==='ringcentral'?`/api/v1/integrations/ringcentral/${integrationId}/outbound`:`/api/v1/integrations/${integrationId}/gmail/outbound-drafts`;
 try{
  const [detail,page]=await Promise.all([api(`${base}/${draftId}`),api(base)]);
  if(!current())return false;
  const draft=provider==='ringcentral'?detail?.draft:detail;
  if(draft?.id!==draftId||!Array.isArray(page?.items))throw new Error('The workflow communication could not be verified.');
  const items=page.items.some(item=>item.id===draftId)?page.items:[draft,...page.items];
  // The exact read endpoints enforce tenant and role access. No settings catalog
  // is needed, and follow-on review actions remain bound to this integration.
  outboundState={provider,integrations:[{id:integrationId,provider}],items,detail};
  renderOutboundWorkspace();
  return true;
 }catch(error){
  if(!current())return false;
  loading.textContent='This workflow communication could not be opened. Reload the workflow and check your access.';
  throw error;
 }
}
