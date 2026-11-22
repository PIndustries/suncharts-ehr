// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

let automationView='overview';
let automationState={builtins:[],installations:[],subscriptions:[],deliveries:[],invocations:[],errors:[]};
let automationEditingConnector=null;
let automationPendingAction=null;
const automationViews=[
 ['overview','Overview'],['connectors','Connections'],['triggers','Rules'],
 ['runs','Runs'],['approvals','Waiting for approval'],['reconciliation','Needs checking']
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
 // Nothing set up and nothing has ever run: one plain block that says what this is for and where to
 // start, instead of four zeros and a diagram.
 if(!installations.length&&!subscriptions.length&&!deliveries.length&&!invocations.length)return `<section class="automation-section"><div class="empty-state setup-state"><h3>Nothing is automated yet</h3><p>Automation lets SunCharts do a routine step by itself when something happens in the practice. For example: when an appointment is booked, tell another system; when a form comes back, start the next step.</p><p>You turn on a connection, add a rule that says when it should act, and anything sensitive waits for a person to approve it. Most practices do not need this to get started.</p>${automationOwner()?'<button type="button" class="primary" data-automation-view="connectors">See what can be connected</button>':'<p class="muted">The practice owner sets this up.</p>'}</div></section>`;
 return `<section class="automation-section"><div class="automation-metrics">${automationMetric('Connections turned on',enabled,'Systems SunCharts can work with')}${automationMetric('Rules turned on',active,'Events that start a step')}${automationMetric('Needs attention',attention,attention?'Someone needs to look before these continue':'Nothing is stuck',attention?'warning':'success')}${automationMetric('Recent runs',deliveries.length,'The last 100 are kept')}</div><div class="automation-overview-grid"><section class="automation-card"><div class="section-head"><div><h3>How it works</h3><p class="muted">Every step is recorded, with who approved it.</p></div></div><ol class="automation-flow"><li><b>Connection</b><span>A system SunCharts is allowed to work with</span></li><li><b>Rule</b><span>Something happens here, such as an appointment being booked</span></li><li><b>Step</b><span>What SunCharts does next, with approval where needed</span></li><li><b>Record</b><span>Whether it worked is kept</span></li></ol></section><section class="automation-card"><div class="section-head"><h3>Recent activity</h3><button type="button" data-automation-refresh>Refresh</button></div>${recent.length?`<div class="automation-activity">${recent.map(item=>`<div><span><b>${esc(item.title)}</b><small>${esc(automationDate(item.at))}</small></span>${automationBadge(item.status)}</div>`).join('')}</div>`:automationEmpty('Nothing has run yet','Turn on a connection, then add a rule that says when it should act.')}</section></div></section>`;
}

function automationConnectorEditor(){
 if(!automationOwner())return '';
 const current=automationEditingConnector;
 return `<details class="automation-editor" ${current?'open':''}><summary>${current?'Revise reviewed connector':'Install reviewed connector manifest'}</summary><form id="automation-connector-form" data-id="${esc(current?.id||'')}" data-version="${esc(current?.version||'')}"><p>Upload a connector description file. Executable scripts, arbitrary request targets and credentials are not accepted here.</p><label>Manifest file<input name="manifest" type="file" accept="application/json,.json" required></label><div class="form-grid"><label>Source repository<input name="repository_url" type="url" required placeholder="https://github.com/organization/connector"></label><label>Source revision<input name="source_revision" required maxlength="200" placeholder="Commit or signed release"></label><label>SHA-256 source digest<input name="source_digest" required minlength="64" maxlength="64" pattern="[A-Fa-f0-9]{64}"></label><label>Change reason<input name="reason" required maxlength="1000" value="${current?'Review and install a new connector revision':''}"></label></div><div class="actions"><button class="primary" type="submit">${current?'Save new revision':'Install connector'}</button>${current?'<button type="button" data-automation-cancel-edit>Cancel</button>':''}</div></form></details>`;
}

function automationConnectors(){
 const items=automationState.installations,builtins=automationState.builtins;
 const available=builtins.filter(item=>!item.installed);
 const builtinCards=available.length?`<section class="automation-card"><div class="section-head"><div><h3>Built into SunCharts</h3><p class="muted">Ready-made connections. They need no passwords pasted in and do not call outside websites.</p></div></div><div class="automation-list">${available.map(item=>{const manifest=item.manifest||{};return `<article class="automation-row"><div><h3>${esc(manifest.name||manifest.id)}</h3><p>${esc(manifest.description||'Built-in connection')}</p><small>${esc(manifest.license||'—')} · ${esc((manifest.triggers||[]).length)} triggers · ${esc((manifest.actions||[]).length)} actions</small></div>${automationOwner()?`<form class="automation-builtin-form" data-id="${esc(manifest.id)}"><label>Installation reason<input name="reason" required maxlength="1000" value="Install reviewed built-in connector"></label><button class="primary" type="submit">Install</button></form>`:''}</article>`}).join('')}</div></section>`:'';
 return `<section class="automation-section"><div class="section-head"><div><h3>Your connections</h3><p class="muted">The systems this practice has turned on.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${builtinCards}${automationConnectorEditor()}${items.length?`<div class="automation-list">${items.map(item=>`<article class="automation-row"><div><h3>${esc(item.name||item.connector_id)}</h3><p><code>${esc(item.connector_id)}</code> · v${esc(item.manifest_version||'—')} · revision ${esc(item.revision)}</p><small>${esc(item.license||'License not reported')} · <a href="${esc(item.repository_url)}" target="_blank" rel="noopener noreferrer">Review source</a></small></div><div class="automation-row-actions">${automationBadge(item.status)}${automationOwner()&&item.status!=='deactivated'?`<button type="button" data-automation-connector-state="${item.status==='enabled'?'disable':'enable'}" data-id="${esc(item.id)}">${item.status==='enabled'?'Disable':'Enable'}</button><button type="button" data-automation-revise="${esc(item.id)}">Revise</button>`:''}</div>${automationDecisionForm('connector',item)}</article>`).join('')}</div>`:automationEmpty('No connections yet','Turn on one of the built-in connections above.')}</section>`;
}

function automationTriggerForm(){
 if(!automationOwner())return '';
 const connectors=automationState.installations.filter(item=>item.status!=='deactivated');
 return `<details class="automation-editor"><summary>Add exact trigger</summary><form id="automation-trigger-form"><p>Choose a trigger declared by the reviewed connector manifest. Its exact event type and transport are derived by the server; this screen cannot override them.</p><div class="form-grid"><label>Connector<select name="connector_key" required><option value="">Choose connector</option>${connectors.map(item=>`<option value="${esc(item.connector_id)}">${esc(item.name||item.connector_id)}</option>`).join('')}</select></label><label>Manifest trigger key<input name="trigger_key" required placeholder="appointments.created"></label><label>Reason<input name="reason" required maxlength="1000"></label></div><button class="primary" type="submit">Save trigger</button></form></details>`;
}

function automationTriggers(){
 const items=automationState.subscriptions;
 return `<section class="automation-section"><div class="section-head"><div><h3>Rules</h3><p class="muted">Each rule watches for one kind of event in this practice only.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${automationTriggerForm()}${items.length?`<div class="automation-list">${items.map(item=>`<article class="automation-row"><div><h3>${esc(item.event_type)}</h3><p>${esc(item.connector_key)} · ${esc(item.trigger_key)}</p><small>${automationStatus(item.transport)} · revision ${esc(item.version)}</small></div><div class="automation-row-actions">${automationBadge(item.status)}${automationOwner()?`<button type="button" data-automation-trigger-state="${item.status==='active'?'deactivate':'activate'}" data-id="${esc(item.id)}">${item.status==='active'?'Pause':'Activate'}</button>`:''}</div>${automationDecisionForm('trigger',item)}</article>`).join('')}</div>`:automationEmpty('No rules yet','Add a rule after turning on its connection. Nothing runs until the practice owner turns the rule on.')}</section>`;
}

function automationRuns(){
 const items=automationState.deliveries;
 return `<section class="automation-section"><div class="section-head"><div><h3>Runs</h3><p class="muted">Each time a rule fired and whether its step went through. A step is retried if it fails, and never done twice.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${items.length?`<div class="practice-table-wrap"><table class="practice-table"><thead><tr><th>Event</th><th>Connector</th><th>State</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.event_type||'Event')}</b><br><small>${esc(item.id)}</small></td><td>${esc(item.connector_key||'—')}<br><small>${esc(item.trigger_key||'—')}</small></td><td>${automationBadge(item.status)}</td><td>${esc(item.attempt_count||0)} / ${esc(item.max_attempts||'—')}</td><td>${esc(automationDate(item.updated_at||item.created_at))}</td></tr>`).join('')}</tbody></table></div>`:automationEmpty('No runs yet','Runs appear here once something happens that a rule is watching for.')}</section>`;
}

function automationInvocationCard(item,review=false){
 const canReview=['owner','clinician'].includes(me?.role);
 return `<article class="automation-action-card"><div class="section-head"><div><h3>${esc(item.connector_key)} · ${esc(item.action_key)}</h3><p>${automationStatus(item.operation_class)} · action v${esc(item.action_version)}</p></div>${automationBadge(item.status)}</div><dl><div><dt>Requested</dt><dd>${esc(automationDate(item.created_at))}</dd></div><div><dt>Approval</dt><dd>${automationStatus(item.approval_policy)}</dd></div><div><dt>Attempts</dt><dd>${esc(item.attempt_count)} / ${esc(item.max_attempts)}</dd></div></dl>${review&&item.status==='pending_review'&&canReview?`<form class="automation-review-form" data-id="${esc(item.id)}" data-version="${esc(item.version)}"><label>Review reason<input name="reason" required maxlength="1000"></label><div class="actions"><button class="primary" name="action" value="approve">Approve</button><button name="action" value="reject">Reject</button></div></form>`:''}</article>`;
}

function automationApprovals(){
 const items=automationState.invocations.filter(item=>item.status==='pending_review');
 return `<section class="automation-section"><div class="section-head"><div><h3>Waiting for approval</h3><p class="muted">Anything that would change a chart, message a patient or add a charge waits here for a person to approve it.</p></div><button type="button" data-automation-refresh>Refresh</button></div>${items.length?`<div class="automation-action-grid">${items.map(item=>automationInvocationCard(item,true)).join('')}</div>`:automationEmpty('Nothing is waiting for approval','Steps that need a person to approve them appear here first.')}</section>`;
}

function automationReconciliation(){
 const invocations=automationState.invocations.filter(item=>['needs_reconciliation','failed'].includes(item.status));
 const deliveries=automationState.deliveries.filter(item=>item.status==='dead_letter');
 return `<section class="automation-section"><div class="section-head"><div><h3>Needs checking</h3><p class="muted">Steps where SunCharts cannot tell whether the other system received them stop here. Check with that system before changing anything in the chart.</p></div><button type="button" data-automation-refresh>Refresh</button></div><div class="automation-reconcile-grid"><section><h3>Action reconciliation</h3>${invocations.map(item=>automationInvocationCard(item)).join('')||automationEmpty('Nothing needs checking','No step is waiting for someone to confirm it with the other system.')}</section><section><h3>Dead-letter deliveries</h3>${deliveries.map(item=>`<article class="automation-action-card"><div class="section-head"><div><h3>${esc(item.event_type||'Event delivery')}</h3><p>${esc(item.last_error_code||'Delivery attempts exhausted')}</p></div>${automationBadge(item.status)}</div>${automationOwner()?`<form class="automation-delivery-form" data-id="${esc(item.id)}"><label>Decision reason<input name="reason" required maxlength="1000"></label><div class="actions"><button class="primary" name="action" value="replay">Replay event</button><button name="action" value="cancel">Cancel</button></div></form>`:''}</article>`).join('')||automationEmpty('No failed runs','A run that keeps failing is held here instead of being lost.')}</section></div></section>`;
}

function automationRender(){
 const views={overview:automationOverview,connectors:automationConnectors,triggers:automationTriggers,runs:automationRuns,approvals:automationApprovals,reconciliation:automationReconciliation};
 const errors=automationState.errors.length?`<div class="notice error" role="alert"><b>Some automation data could not be loaded.</b><span>${automationState.errors.map(esc).join(' · ')}</span></div>`:'';
 $('tools').innerHTML=`<div class="automation-center"><div class="automation-hero"><div><h2>Automation Center</h2><p>Have SunCharts do routine steps when something happens in the practice, such as telling another system that an appointment was booked. Anything sensitive waits for a person to approve it.</p></div><span class="automation-safety">Every action is recorded</span></div>${automationTabs()}${errors}${views[automationView]()}</div>`;
}

async function automationLoad(){
 const requests=[['builtins','/api/v1/connector-catalog/builtins'],['installations','/api/v1/connector-catalog/installations'],['subscriptions','/api/v1/automation/subscriptions'],['deliveries','/api/v1/automation/deliveries'],['invocations','/api/v1/automation/action-invocations']];
 const results=await Promise.allSettled(requests.map(([,path])=>api(path)));
 const next={builtins:[],installations:[],subscriptions:[],deliveries:[],invocations:[],errors:[]};
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
 if(form.id==='automation-connector-form'){event.preventDefault();run(async()=>{const data=new FormData(form),file=data.get('manifest');let manifest;try{manifest=JSON.parse(await file.text());}catch{throw new Error('Choose a valid connector file.');}const body={manifest,provenance:{repository_url:data.get('repository_url'),source_revision:data.get('source_revision'),source_digest:data.get('source_digest')},reason:data.get('reason')};if(form.dataset.id)await api(`/api/v1/connector-catalog/installations/${form.dataset.id}`,'PUT',body,Number(form.dataset.version));else await api('/api/v1/connector-catalog/installations','POST',{request_id:crypto.randomUUID(),...body});automationEditingConnector=null;notice('Reviewed connector manifest saved.');await automationLoad();});return;}
 if(form.classList.contains('automation-builtin-form')){event.preventDefault();run(async()=>{const data=new FormData(form);await api(`/api/v1/connector-catalog/builtins/${encodeURIComponent(form.dataset.id)}/install`,'POST',{request_id:crypto.randomUUID(),reason:data.get('reason')});notice('Built-in connector installed. Review it, then enable it when ready.');await automationLoad();});return;}
 if(form.id==='automation-trigger-form'){event.preventDefault();run(async()=>{const data=new FormData(form);await api('/api/v1/automation/subscriptions','POST',{connector_key:data.get('connector_key'),trigger_key:data.get('trigger_key'),reason:data.get('reason')});notice('Exact trigger saved from the reviewed manifest. Activate it when review is complete.');await automationLoad();});return;}
 if(form.classList.contains('automation-review-form')){event.preventDefault();run(async()=>{const data=new FormData(form),action=event.submitter?.value;if(!['approve','reject'].includes(action))throw new Error('Choose approve or reject.');await api(`/api/v1/automation/action-invocations/${form.dataset.id}/actions`,'POST',{action,reason:data.get('reason')},Number(form.dataset.version));notice(action==='approve'?'Action approved for governed execution.':'Action rejected.');await automationLoad();});return;}
 if(form.classList.contains('automation-delivery-form')){event.preventDefault();run(async()=>{const data=new FormData(form),action=event.submitter?.value;if(!['replay','cancel'].includes(action))throw new Error('Choose replay or cancel.');await api(`/api/v1/automation/deliveries/${form.dataset.id}/actions`,'POST',{action,reason:data.get('reason')});notice(action==='replay'?'A new replay delivery was created.':'Delivery cancelled.');await automationLoad();});}
});
