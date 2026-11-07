// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

let automationView='overview';
let automationState={installations:[],subscriptions:[],deliveries:[],invocations:[],errors:[]};
let automationEditingConnector=null;
let automationPendingAction=null;
const automationViews=[
 ['overview','Overview'],['connectors','Connectors'],['triggers','Triggers'],
 ['runs','Runs & deliveries'],['approvals','Action approvals'],['reconciliation','Reconciliation']
];
const automationOwner=()=>me?.role==='owner';
const automationStatus=value=>esc(String(value||'unknown').replaceAll('_',' '));
const automationDate=value=>value?date(value):'—';
const automationEmpty=(title,detail)=>`<div class="automation-empty"><span aria-hidden="true">◇</span><h3>${esc(title)}</h3><p>${esc(detail)}</p></div>`;
const automationBadge=value=>`<span class="status-badge ${esc(value||'unknown')}">${automationStatus(value)}</span>`;
function automationDecisionForm(kind,item){
 const pending=automationPendingAction;
 if(!pending||pending.kind!==kind||pending.id!==item.id)return '';
 return `<form class="automation-state-form" data-kind="${kind}" data-id="${esc(item.id)}" data-version="${esc(item.version)}" data-action="${esc(pending.action)}"><label>Audit reason<input name="reason" required maxlength="1000" autofocus></label><div class="actions"><button class="primary" type="submit">Confirm ${esc(pending.action)}</button><button type="button" data-automation-dismiss-action>Cancel</button></div></form>`;
}

function automationTabs(){
 return `<nav class="automation-tabs" aria-label="Automation Center sections">${automationViews.map(([key,label])=>`<button type="button" data-automation-view="${key}" aria-pressed="${automationView===key}">${esc(label)}</button>`).join('')}</nav>`;
}

function automationMetric(label,value,detail,tone=''){
 return `<article class="automation-metric ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
}

function automationOverview(){
 const {installations,subscriptions,deliveries,invocations}=automationState;
 const enabled=installations.filter(item=>item.status==='enabled').length;
 const active=subscriptions.filter(item=>item.status==='active').length;
 const attention=deliveries.filter(item=>item.status==='dead_letter').length+invocations.filter(item=>['pending_review','needs_reconciliation','failed'].includes(item.status)).length;
 const recent=[...deliveries.map(item=>({at:item.updated_at||item.created_at,title:`${item.event_type||'Event'} delivery`,status:item.status})),...invocations.map(item=>({at:item.updated_at||item.created_at,title:`${item.connector_key} · ${item.action_key}`,status:item.status}))].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,8);
 return `<section class="automation-section"><div class="automation-metrics">${automationMetric('Enabled connectors',enabled,'Reviewed capabilities available')}${automationMetric('Active triggers',active,'Exact events being watched')}${automationMetric('Needs attention',attention,attention?'Review before work continues':'No blocked automation work',attention?'warning':'success')}${automationMetric('Recent deliveries',deliveries.length,'Latest 100 retained records')}</div><div class="automation-overview-grid"><section class="automation-card"><div class="section-head"><div><h3>Operational flow</h3><p class="muted">Every effect remains attributable and reviewable.</p></div></div><ol class="automation-flow"><li><b>Connector</b><span>Reviewed manifest, version and source</span></li><li><b>Exact trigger</b><span>A named EHR event starts work</span></li><li><b>Governed action</b><span>Policy determines authority and approval</span></li><li><b>Evidence</b><span>Delivery, failure or reconciliation is retained</span></li></ol></section><section class="automation-card"><div class="section-head"><h3>Recent activity</h3><button type="button" data-automation-refresh>Refresh</button></div>${recent.length?`<div class="automation-activity">${recent.map(item=>`<div><span><b>${esc(item.title)}</b><small>${esc(automationDate(item.at))}</small></span>${automationBadge(item.status)}</div>`).join('')}</div>`:automationEmpty('No automation activity yet','Enable a reviewed connector and configure an exact trigger to begin.')}</section></div></section>`;
}

function automationConnectorEditor(){
 if(!automationOwner())return '';
 const current=automationEditingConnector;
 return `<details class="automation-editor" ${current?'open':''}><summary>${current?'Revise reviewed connector':'Install reviewed connector manifest'}</summary><form id="automation-connector-form" data-id="${esc(current?.id||'')}" data-version="${esc(current?.version||'')}"><p>Upload a declarative connector manifest. Executable scripts, arbitrary request targets and credentials are not accepted here.</p><label>Manifest file<input name="manifest" type="file" accept="application/json,.json" required></label><div class="form-grid"><label>Source repository<input name="repository_url" type="url" required placeholder="https://github.com/organization/connector"></label><label>Source revision<input name="source_revision" required maxlength="200" placeholder="Commit or signed release"></label><label>SHA-256 source digest<input name="source_digest" required minlength="64" maxlength="64" pattern="[A-Fa-f0-9]{64}"></label><label>Change reason<input name="reason" required maxlength="1000" value="${current?'Review and install a new connector revision':''}"></label></div><div class="actions"><button class="primary" type="submit">${current?'Save new revision':'Install connector'}</button>${current?'<button type="button" data-automation-cancel-edit>Cancel</button>':''}</div></form></details>`;
}

function automationConnectors(){
 const items=automationState.installations;
 return `<section class="automation-section"><div class="section-head"><div><h3>Connector catalog</h3><p class="muted">Compiled capabilities with a reviewed source, license and immutable revision history.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${automationConnectorEditor()}${items.length?`<div class="automation-list">${items.map(item=>`<article class="automation-row"><div><h3>${esc(item.name||item.connector_id)}</h3><p><code>${esc(item.connector_id)}</code> · v${esc(item.manifest_version||'—')} · revision ${esc(item.revision)}</p><small>${esc(item.license||'License not reported')} · <a href="${esc(item.repository_url)}" target="_blank" rel="noopener noreferrer">Review source</a></small></div><div class="automation-row-actions">${automationBadge(item.status)}${automationOwner()&&item.status!=='deactivated'?`<button type="button" data-automation-connector-state="${item.status==='enabled'?'disable':'enable'}" data-id="${esc(item.id)}">${item.status==='enabled'?'Disable':'Enable'}</button><button type="button" data-automation-revise="${esc(item.id)}">Revise</button>`:''}</div>${automationDecisionForm('connector',item)}</article>`).join('')}</div>`:automationEmpty('No connectors installed','Owners can install a reviewed open connector manifest. Staff can inspect it here after installation.')}</section>`;
}

function automationTriggerForm(){
 if(!automationOwner())return '';
 const connectors=automationState.installations.filter(item=>item.status!=='deactivated');
 return `<details class="automation-editor"><summary>Add exact trigger</summary><form id="automation-trigger-form"><p>Choose a trigger declared by the reviewed connector manifest. Its exact event type and transport are derived by the server; this screen cannot override them.</p><div class="form-grid"><label>Connector<select name="connector_key" required><option value="">Choose connector</option>${connectors.map(item=>`<option value="${esc(item.connector_id)}">${esc(item.name||item.connector_id)}</option>`).join('')}</select></label><label>Manifest trigger key<input name="trigger_key" required placeholder="appointments.created"></label><label>Reason<input name="reason" required maxlength="1000"></label></div><button class="primary" type="submit">Save trigger</button></form></details>`;
}

function automationTriggers(){
 const items=automationState.subscriptions;
 return `<section class="automation-section"><div class="section-head"><div><h3>Trigger subscriptions</h3><p class="muted">Exact tenant-scoped events only—no wildcard access.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${automationTriggerForm()}${items.length?`<div class="automation-list">${items.map(item=>`<article class="automation-row"><div><h3>${esc(item.event_type)}</h3><p>${esc(item.connector_key)} · ${esc(item.trigger_key)}</p><small>${automationStatus(item.transport)} · revision ${esc(item.version)}</small></div><div class="automation-row-actions">${automationBadge(item.status)}${automationOwner()?`<button type="button" data-automation-trigger-state="${item.status==='active'?'deactivate':'activate'}" data-id="${esc(item.id)}">${item.status==='active'?'Pause':'Activate'}</button>`:''}</div>${automationDecisionForm('trigger',item)}</article>`).join('')}</div>`:automationEmpty('No exact triggers configured','Add a trigger after installing its connector. Nothing runs until an owner activates it.')}</section>`;
}

function automationRuns(){
 const items=automationState.deliveries;
 return `<section class="automation-section"><div class="section-head"><div><h3>Runs & deliveries</h3><p class="muted">Immutable events use stable idempotency keys and at-least-once delivery.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${items.length?`<div class="practice-table-wrap"><table class="practice-table"><thead><tr><th>Event</th><th>Connector</th><th>State</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.event_type||'Event')}</b><br><small>${esc(item.id)}</small></td><td>${esc(item.connector_key||'—')}<br><small>${esc(item.trigger_key||'—')}</small></td><td>${automationBadge(item.status)}</td><td>${esc(item.attempt_count||0)} / ${esc(item.max_attempts||'—')}</td><td>${esc(automationDate(item.updated_at||item.created_at))}</td></tr>`).join('')}</tbody></table></div>`:automationEmpty('No event deliveries yet','Published EHR events will appear after they match an active exact trigger.')}</section>`;
}

function automationInvocationCard(item,review=false){
 const canReview=['owner','clinician'].includes(me?.role);
 return `<article class="automation-action-card"><div class="section-head"><div><h3>${esc(item.connector_key)} · ${esc(item.action_key)}</h3><p>${automationStatus(item.operation_class)} · action v${esc(item.action_version)}</p></div>${automationBadge(item.status)}</div><dl><div><dt>Requested</dt><dd>${esc(automationDate(item.created_at))}</dd></div><div><dt>Approval</dt><dd>${automationStatus(item.approval_policy)}</dd></div><div><dt>Attempts</dt><dd>${esc(item.attempt_count)} / ${esc(item.max_attempts)}</dd></div></dl>${review&&item.status==='pending_review'&&canReview?`<form class="automation-review-form" data-id="${esc(item.id)}" data-version="${esc(item.version)}"><label>Review reason<input name="reason" required maxlength="1000"></label><div class="actions"><button class="primary" name="action" value="approve">Approve</button><button name="action" value="reject">Reject</button></div></form>`:''}</article>`;
}

function automationApprovals(){
 const items=automationState.invocations.filter(item=>item.status==='pending_review');
 return `<section class="automation-section"><div class="section-head"><div><h3>Action approvals</h3><p class="muted">Clinical writes, communications and charges wait for authorized human review.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${items.length?`<div class="automation-action-grid">${items.map(item=>automationInvocationCard(item,true)).join('')}</div>`:automationEmpty('No actions waiting for approval','Actions that require review will appear here before execution.')}</section>`;
}

function automationReconciliation(){
 const invocations=automationState.invocations.filter(item=>['needs_reconciliation','failed'].includes(item.status));
 const deliveries=automationState.deliveries.filter(item=>item.status==='dead_letter');
 return `<section class="automation-section"><div class="section-head"><div><h3>Reconciliation & dead letters</h3><p class="muted">Ambiguous external effects stop here. Verify provider evidence before changing clinical state.</p></div><button type="button" data-automation-refresh>Refresh</button></div><div class="automation-reconcile-grid"><section><h3>Action reconciliation</h3>${invocations.map(item=>automationInvocationCard(item)).join('')||automationEmpty('No ambiguous actions','The runtime has not detected an action that needs manual provider verification.')}</section><section><h3>Dead-letter deliveries</h3>${deliveries.map(item=>`<article class="automation-action-card"><div class="section-head"><div><h3>${esc(item.event_type||'Event delivery')}</h3><p>${esc(item.last_error_code||'Delivery attempts exhausted')}</p></div>${automationBadge(item.status)}</div>${automationOwner()?`<form class="automation-delivery-form" data-id="${esc(item.id)}"><label>Decision reason<input name="reason" required maxlength="1000"></label><div class="actions"><button class="primary" name="action" value="replay">Replay event</button><button name="action" value="cancel">Cancel</button></div></form>`:''}</article>`).join('')||automationEmpty('No dead-letter deliveries','Exhausted deliveries will be held here instead of disappearing.')}</section></div></section>`;
}

function automationRender(){
 const views={overview:automationOverview,connectors:automationConnectors,triggers:automationTriggers,runs:automationRuns,approvals:automationApprovals,reconciliation:automationReconciliation};
 const errors=automationState.errors.length?`<div class="notice error" role="alert"><b>Some automation data could not be loaded.</b><span>${automationState.errors.map(esc).join(' · ')}</span></div>`:'';
 $('tools').innerHTML=`<div class="automation-center"><div class="automation-hero"><div><p class="eyebrow">OPERATIONS</p><h2>Automation Center</h2><p>Connect reviewed systems, react to exact EHR events and keep every sensitive action under human control.</p></div><span class="automation-safety">No scripts · No stored secrets · Audited</span></div>${automationTabs()}${errors}${views[automationView]()}</div>`;
}

async function automationLoad(){
 const requests=[['installations','/api/v1/connector-catalog/installations'],['subscriptions','/api/v1/automation/subscriptions'],['deliveries','/api/v1/automation/deliveries'],['invocations','/api/v1/automation/action-invocations']];
 const results=await Promise.allSettled(requests.map(([,path])=>api(path)));
 const next={installations:[],subscriptions:[],deliveries:[],invocations:[],errors:[]};
 results.forEach((result,index)=>{const [key]=requests[index];if(result.status==='fulfilled')next[key]=result.value.items||[];else next.errors.push(`${automationViews.find(([view])=>view===(key==='installations'?'connectors':key==='subscriptions'?'triggers':key==='deliveries'?'runs':'approvals'))?.[1]||key}: ${result.reason.message}`);});
 automationState=next;automationRender();
}

async function showAutomationCenter(){
 showTool('Automation Center');history.replaceState(null,'','/?open=automation-center');
 $('tools').innerHTML='<div class="automation-loading" aria-busy="true"><span></span><p>Loading automation operations…</p></div>';
 await automationLoad();
}

document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.automationView){automationView=button.dataset.automationView;automationRender();return;}
 if(button.hasAttribute('data-automation-refresh')){run(automationLoad);return;}
 if(button.dataset.automationConnectorState){automationPendingAction={kind:'connector',id:button.dataset.id,action:button.dataset.automationConnectorState};automationRender();return;}
 if(button.dataset.automationTriggerState){automationPendingAction={kind:'trigger',id:button.dataset.id,action:button.dataset.automationTriggerState};automationRender();return;}
 if(button.hasAttribute('data-automation-dismiss-action')){automationPendingAction=null;automationRender();return;}
 if(button.dataset.automationRevise){automationEditingConnector=automationState.installations.find(item=>item.id===button.dataset.automationRevise)||null;automationRender();return;}
 if(button.hasAttribute('data-automation-cancel-edit')){automationEditingConnector=null;automationRender();}
});

document.addEventListener('submit',event=>{
 const form=event.target;
 if(form.classList.contains('automation-state-form')){event.preventDefault();run(async()=>{const reason=new FormData(form).get('reason'),kind=form.dataset.kind,path=kind==='connector'?`/api/v1/connector-catalog/installations/${form.dataset.id}/actions`:`/api/v1/automation/subscriptions/${form.dataset.id}/actions`;await api(path,'POST',{action:form.dataset.action,reason},Number(form.dataset.version));automationPendingAction=null;notice(kind==='connector'?'Connector state updated.':'Trigger state updated.');await automationLoad();});return;}
 if(form.id==='automation-connector-form'){event.preventDefault();run(async()=>{const data=new FormData(form),file=data.get('manifest');let manifest;try{manifest=JSON.parse(await file.text());}catch{throw new Error('Choose a valid JSON connector manifest.');}const body={manifest,provenance:{repository_url:data.get('repository_url'),source_revision:data.get('source_revision'),source_digest:data.get('source_digest')},reason:data.get('reason')};if(form.dataset.id)await api(`/api/v1/connector-catalog/installations/${form.dataset.id}`,'PUT',body,Number(form.dataset.version));else await api('/api/v1/connector-catalog/installations','POST',{request_id:crypto.randomUUID(),...body});automationEditingConnector=null;notice('Reviewed connector manifest saved.');await automationLoad();});return;}
 if(form.id==='automation-trigger-form'){event.preventDefault();run(async()=>{const data=new FormData(form);await api('/api/v1/automation/subscriptions','POST',{connector_key:data.get('connector_key'),trigger_key:data.get('trigger_key'),reason:data.get('reason')});notice('Exact trigger saved from the reviewed manifest. Activate it when review is complete.');await automationLoad();});return;}
 if(form.classList.contains('automation-review-form')){event.preventDefault();run(async()=>{const data=new FormData(form),action=event.submitter?.value;if(!['approve','reject'].includes(action))throw new Error('Choose approve or reject.');await api(`/api/v1/automation/action-invocations/${form.dataset.id}/actions`,'POST',{action,reason:data.get('reason')},Number(form.dataset.version));notice(action==='approve'?'Action approved for governed execution.':'Action rejected.');await automationLoad();});return;}
 if(form.classList.contains('automation-delivery-form')){event.preventDefault();run(async()=>{const data=new FormData(form),action=event.submitter?.value;if(!['replay','cancel'].includes(action))throw new Error('Choose replay or cancel.');await api(`/api/v1/automation/deliveries/${form.dataset.id}/actions`,'POST',{action,reason:data.get('reason')});notice(action==='replay'?'A new replay delivery was created.':'Delivery cancelled.');await automationLoad();});}
});
