// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const healthHistoryDrafts=new Map(),healthHistoryStates=new Map();let healthHistoryGeneration=0;
function healthHistoryHasDrafts(){return healthHistoryDrafts.size>0;}
function clearHealthHistorySession(){healthHistoryDrafts.clear();healthHistoryStates.clear();healthHistoryGeneration++;}
function healthHistoryValues(form){const v=Object.fromEntries(new FormData(form));return {content:{kind:form.dataset.kind,title:v.title,status:v.status,verification:v.verification,onset_date:v.onset_date||null,end_date:v.end_date||null,code:v.code_system||v.code_value||v.code_display?{system:v.code_system,code:v.code_value,display:v.code_display}:null,notes:v.notes},reason:v.reason};}
function captureHealthHistoryDraft(){const form=$('health-history-form');if(!form)return;const state=healthHistoryDrafts.get(form.dataset.patient);if(!state)return;state.values=healthHistoryValues(form);}
function healthHistorySelect(name,label,values,value){return `<label>${label}<select name="${name}">${values.map(v=>`<option value="${v}" ${v===value?'selected':''}>${esc(human(v))}</option>`).join('')}</select></label>`;}
function healthHistorySummary(c){return `<p>${esc(human(c.status))} · ${esc(human(c.verification))}</p><p class="muted">${c.onset_date?'Onset / procedure date '+esc(c.onset_date):'Date not recorded'}${c.end_date?' · Ended '+esc(c.end_date):''}</p>${c.code?`<p>${esc(c.code.system)} · ${esc(c.code.code)} · ${esc(c.code.display)}</p>`:''}${c.notes?`<p class="note-text">${esc(c.notes)}</p>`:''}`;}
function showHealthHistory(){
 const panel=$('health-history-panel'),state=healthHistoryStates.get(selected);if(!panel||!state)return;const patient=selected,draft=healthHistoryDrafts.get(patient);const writable=['owner','clinician'].includes(me?.role);
 const items=state.items.filter(e=>(!state.kind||e.content.kind===state.kind)&&(!state.status||e.content.status===state.status));
 panel.innerHTML=`<div class="section-head"><h2>Surgical & dental history</h2>${writable?'<div class="actions"><button type="button" data-history-new="surgery">+ Surgical history</button><button type="button" data-history-new="dental">+ Dental issue</button></div>':''}</div><p class="muted">Recorded longitudinal history. These entries do not place procedure orders or change the problem list. Empty lists do not confirm absence of a history.</p><div class="form-grid">${healthHistorySelect('history_kind','Show history',['all','surgery','dental'],state.kind||'all')}${healthHistorySelect('history_status','Show status',['all','active','resolved','completed','entered_in_error'],state.status||'all')}</div><p>${items.length} matching entries from ${state.items.length} loaded${state.next_cursor?' · More records available':''}</p>${items.map(e=>`<article class="clinical-entry"><div class="section-head"><div><b>${esc(e.content.title)}</b><small> · ${esc(human(e.content.kind))} · v${e.version}</small></div><div class="actions">${writable?`<button type="button" data-history-edit="${esc(e.id)}">Edit</button>`:''}<button type="button" data-history-revisions="${esc(e.id)}">Revision history</button></div></div>${healthHistorySummary(e.content)}<div id="health-history-revisions-${esc(e.id)}"></div></article>`).join('')||'<p>No matching history entries recorded.</p>'}${state.next_cursor?'<button type="button" data-history-more>Load more history</button>':''}<div id="health-history-editor"></div>`;
 panel.hidden=chartSection!=='history';
 if(draft&&writable)showHealthHistoryEditor(draft);
}
function showHealthHistoryEditor(draft){
 const host=$('health-history-editor');if(!host)return;const c=draft.values.content,code=c.code||{};
 host.innerHTML=`<form id="health-history-form" data-patient="${esc(selected)}" data-kind="${esc(c.kind)}"><h3>${draft.id?'Edit':'Add'} ${esc(human(c.kind))} history</h3>${draft.current?`<section role="status"><p>The saved record changed. Compare the saved record below with your retained edits.</p><b>${esc(draft.current.content.title)}</b>${healthHistorySummary(draft.current.content)}<button type="button" data-history-rebase>Keep edits against saved version ${draft.current.version}</button></section>`:''}<div class="form-grid"><label>Description<input name="title" required maxlength="200" value="${esc(c.title)}"></label>${healthHistorySelect('status','Status',['active','resolved','completed','entered_in_error'],c.status)}${healthHistorySelect('verification','Verification',['unconfirmed','confirmed','refuted','entered_in_error'],c.verification)}<label>Onset / procedure date<input type="date" name="onset_date" value="${esc(c.onset_date)}"></label><label>End date<input type="date" name="end_date" value="${esc(c.end_date)}"></label></div><p class="muted">Optional code is recorded as supplied. No terminology lookup or validation is performed.</p><div class="form-grid"><label>Code system<input name="code_system" maxlength="200" value="${esc(code.system)}"></label><label>Code<input name="code_value" maxlength="120" value="${esc(code.code)}"></label><label>Code display<input name="code_display" maxlength="200" value="${esc(code.display)}"></label></div><label>Notes<textarea name="notes" maxlength="10000">${esc(c.notes)}</textarea></label><label>Reason / source of change<input name="reason" required maxlength="1000" value="${esc(draft.values.reason)}"></label><div class="actions"><button type="submit" ${draft.current?'disabled':''}>Save history</button><button type="button" data-history-discard>Discard unsaved history</button>${draft.id?'<button type="button" data-history-compare>Compare with current record</button>':''}</div><p class="muted">Unsaved edits remain only in this tab. Lifecycle changes retain the original revisions.</p></form>`;
}
async function renderHealthHistory(){
 const patient=selected,account=me,generation=++healthHistoryGeneration;
 let panel=$('health-history-panel');if(!panel){panel=document.createElement('section');panel.id='health-history-panel';panel.className='panel longitudinal';$('chart').insertBefore(panel,$('appointments-panel'));}
 panel.hidden=chartSection!=='history';panel.textContent='Loading surgical and dental history…';
 try{const data=await api(`/api/v1/patients/${patient}/health-history`);if(selected!==patient||me!==account||generation!==healthHistoryGeneration||$('health-history-panel')!==panel)return;healthHistoryStates.set(patient,{...data,kind:'',status:''});showHealthHistory();}
 catch(error){if(selected===patient&&me===account&&$('health-history-panel')===panel)panel.textContent=`History unavailable: ${error.message}`;}
}
document.addEventListener('input',e=>{if(e.target.closest?.('#health-history-form'))captureHealthHistoryDraft();});
document.addEventListener('change',e=>{if(!['history_kind','history_status'].includes(e.target.name))return;captureHealthHistoryDraft();const state=healthHistoryStates.get(selected);if(!state)return;state[e.target.name==='history_kind'?'kind':'status']=e.target.value==='all'?'':e.target.value;showHealthHistory();});
document.addEventListener('click',e=>{
 const b=e.target.closest?.('[data-history-new],[data-history-edit],[data-history-revisions],[data-history-more],[data-history-discard],[data-history-compare],[data-history-rebase]');if(!b)return;e.preventDefault();e.stopImmediatePropagation();
 run(async()=>{
  captureHealthHistoryDraft();const patient=selected,account=me,state=healthHistoryStates.get(patient);if(!state)return;const draft=healthHistoryDrafts.get(patient),writable=['owner','clinician'].includes(me?.role);
  if(b.hasAttribute('data-history-revisions')){const id=b.dataset.historyRevisions,host=$('health-history-revisions-'+id),data=await api(`/api/v1/patients/${patient}/health-history/${id}/revisions`);if(me!==account||selected!==patient||$('health-history-revisions-'+id)!==host)return;host.innerHTML=data.items.map(r=>`<details><summary>Version ${r.version} · ${esc(date(r.created_at))} · ${esc(r.reason)}</summary><p>Recorded by ${esc(r.actor_label||r.author_id)}</p><b>${esc(r.content.title)}</b>${healthHistorySummary(r.content)}</details>`).join('')+(data.truncated?'<p>Older revisions are omitted from this view.</p>':'');return;}
  if(b.hasAttribute('data-history-more')){const data=await api(`/api/v1/patients/${patient}/health-history?_after=${encodeURIComponent(state.next_cursor)}`);if(me!==account||selected!==patient||healthHistoryStates.get(patient)!==state)return;const ids=new Set(state.items.map(x=>x.id));state.items.push(...data.items.filter(x=>!ids.has(x.id)));state.next_cursor=data.next_cursor;captureHealthHistoryDraft();showHealthHistory();return;}
  if(!writable)return;
  if(b.hasAttribute('data-history-discard')){if(!window.confirm('Discard unsaved surgical or dental history edits?'))return;healthHistoryDrafts.delete(patient);showHealthHistory();return;}
  if(b.hasAttribute('data-history-rebase')){if(draft?.current){draft.version=draft.current.version;delete draft.current;showHealthHistoryEditor(draft);}return;}
  if(b.hasAttribute('data-history-compare')){if(!draft?.id)return;const current=await api(`/api/v1/patients/${patient}/health-history/${draft.id}`);if(me!==account||selected!==patient||healthHistoryDrafts.get(patient)!==draft)return;captureHealthHistoryDraft();draft.current=current;showHealthHistoryEditor(draft);return;}
  if(draft&&!window.confirm('Replace the unsaved history editor?'))return;
  const entry=b.dataset.historyEdit?state.items.find(x=>x.id===b.dataset.historyEdit):null;
  if(b.dataset.historyEdit&&!entry)return;
  const fresh={id:entry?.id,version:entry?.version,request_id:crypto.randomUUID(),values:{content:entry?structuredClone(entry.content):{kind:b.dataset.historyNew,title:'',status:b.dataset.historyNew==='surgery'?'completed':'active',verification:'unconfirmed',onset_date:null,end_date:null,code:null,notes:''},reason:''}};
  healthHistoryDrafts.set(patient,fresh);showHealthHistoryEditor(fresh);
 });
},true);
document.addEventListener('submit',e=>{
 const form=e.target;if(form.id!=='health-history-form')return;e.preventDefault();e.stopImmediatePropagation();
 run(async()=>{
  captureHealthHistoryDraft();const patient=form.dataset.patient,account=me,draft=healthHistoryDrafts.get(patient);if(!draft||draft.current||patient!==selected)return;
  const submitted=structuredClone(draft.values),version=draft.version;
  const saved=await api(`/api/v1/patients/${patient}/health-history${draft.id?'/'+draft.id:''}`,draft.id?'PUT':'POST',draft.id?submitted:{...submitted,request_id:draft.request_id},draft.id?version:undefined);
  if(me!==account)return;
  if(selected===patient&&$('health-history-form')===form)captureHealthHistoryDraft();
  const current=healthHistoryDrafts.get(patient);
  if(current===draft){if(JSON.stringify(draft.values)===JSON.stringify(submitted))healthHistoryDrafts.delete(patient);else{draft.id=saved.id;draft.version=saved.version;}}
  const state=healthHistoryStates.get(patient);if(state){const index=state.items.findIndex(x=>x.id===saved.id);if(index>=0)state.items[index]=saved;else state.items.push(saved);}
  if(selected===patient){showHealthHistory();notice('History saved with attributed revisions.');}
 });
},true);
