// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const clinicalLabels={problem:'Problems',allergy:'Allergies',medication:'Medications'};
const clinicalStatuses={problem:['active','inactive','resolved','recurrence','remission','entered_in_error'],allergy:['active','inactive','resolved','entered_in_error'],medication:['active','on_hold','stopped','completed','not_taken','intended','entered_in_error']};
const canDocument=()=>['owner','clinician'].includes(me.role);
const human=v=>String(v||'').replaceAll('_',' ');
function renderClinical(){
 let panel=$('clinical-lists');if(!panel){panel=document.createElement('section');panel.className='panel longitudinal chart-list-page';panel.id='clinical-lists';$('chart').insertBefore(panel,$('appointments-panel'));}
 const k=typeof frameClinicalFocus==='undefined'?'problem':frameClinicalFocus,label=clinicalLabels[k],entries=workspace.clinical.items.filter(e=>e.kind===k),review=workspace.clinical.reviews.find(r=>r.kind===k)||{version:1,review_state:'unknown'};
 const reviewForm=canDocument()?`<form class="clinical-review-form" data-kind="${k}" data-version="${review.version}">${selectField('review_state','Result',['reviewed','no_known','unknown'],'reviewed',['List reviewed','No known '+label.toLowerCase(),'Could not confirm'])}<label>Note<input name="note" required maxlength="2000" placeholder="For example: reviewed with patient"></label><button type="submit">Save review</button></form>`:'';
 const more=(canDocument()?`<button type="button" data-chart-detail="clinical-review">Mark this list reviewed</button><button type="button" data-chart-detail="clinical-review" data-review-no-known>${k==='allergy'?'No known allergies':'None known'}</button>`:'')+'<button type="button" data-chart-detail="clinical-review-history">Review history</button>';
 const reviewer=review.actor_label||review.author_label||review.reviewed_by_name||(review.reviewed_by===me.user_id?me.display_name:'');
 const reviewed=review.reviewed_at?'Reviewed '+displayDate(review.reviewed_at)+(reviewer?' by '+reviewer:''):'Reviewed';
 const reviewLine=review.review_state==='no_known'?'None known · '+reviewed[0].toLowerCase()+reviewed.slice(1):review.review_state==='reviewed'?reviewed:review.review_state==='needs_review'?'Needs review':'Not reviewed yet';
 const columns=k==='problem'?['Problem','ICD-10 code + name','Onset','Status','Resolved','Verification']:k==='allergy'?['Allergen','Category','Reaction','Severity / criticality','Status','Verification']:['Medication','Dose / route / frequency','Start','End','Status','Verification'];
 const rows=items=>items.map(e=>{
  const c=e.content,d=c.detail;
  const name=`<button type="button" class="text-button" data-chart-detail="clinical-record-${esc(e.id)}">${esc(c.title)}</button>${e.source_history_id?'<small class="clinical-source">From previous system</small>':''}`;
  const status=displayStatusPill(c.status),verification=displayStatusPill(c.verification);
  if(k==='problem')return [name,esc(c.codes.map(code=>[code.code,code.display].filter(Boolean).join(' ')).join(' · ')||'—'),esc(displayDate(c.onset_date)||'—'),status,esc(displayDate(c.end_date)||'—'),verification];
  if(k==='allergy')return [name,esc(displayStatus(d.category)||'—'),esc(d.reaction||'—'),`<span${d.criticality==='high'||d.severity==='severe'?' class="clinical-high-risk"':''}>${esc(displayStatus(d.severity)||'Unknown')} / ${esc(displayStatus(d.criticality)||'Unknown')}</span>`,status,verification];
  return [name,esc([d.dose,d.route,d.frequency].filter(Boolean).join(' · ')||'—'),esc(displayDate(c.onset_date)||'—'),esc(displayDate(c.end_date)||'—'),status,verification];
 });
 const inactive=e=>['inactive','resolved','stopped','completed','not_taken','entered_in_error'].includes(e.content.status);
 const current=entries.filter(e=>!inactive(e)).sort((a,b)=>Number(b.content.status==='active')-Number(a.content.status==='active')),past=entries.filter(inactive);
 // Keep the complete table header on an empty page without changing other lists.
 const table=chartListTable(columns,current.length?rows(current):[columns.map((_,i)=>i?'':`<span class="muted">${entries.length?'No active '+label.toLowerCase()+' recorded.':'No '+label.toLowerCase()+' recorded.'}</span>`)],'');
 const currentAllergies=k==='allergy'?entries.filter(e=>e.content.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification)):[];
 const alert=currentAllergies.length?`<div class="allergy-alert" role="note"><b>Current allergies:</b> ${currentAllergies.map(e=>`${esc(e.content.title)}${e.content.detail.reaction?' — '+esc(e.content.detail.reaction):''} (${esc(displayStatus(e.content.verification).toLowerCase())})`).join('; ')}</div>`:'';
 const imported=document.createElement('div');
 if(typeof importedListBlock==='function'){
  imported.innerHTML=importedListBlock(k);
  const heading=imported.querySelector('h4');if(heading)heading.textContent+=' → Review and add to chart';
  for(const facts of imported.querySelectorAll('small'))facts.textContent=facts.textContent.replace(/\b\d{4}-\d{2}-\d{2}\b/g,value=>displayDate(value));
 }
 panel.innerHTML=chartListHeader(label,canDocument()?`<button type="button" class="primary" data-new-clinical="${k}">+ Add ${k}</button>`:'',more)+`<div class="chart-list-note" role="status">${esc(reviewLine)}</div>`+alert+table+(past.length?`<details class="clinical-inactive"><summary>Inactive (${past.length})</summary>${chartListTable(columns,rows(past),'')}</details>`:'')+imported.innerHTML+entries.map(e=>chartRecordTemplate('clinical-record-'+e.id,`<h3>${esc(e.content.title)}</h3><p>${displayStatusPill(e.content.status)} ${displayStatusPill(e.content.verification)}${e.source_history_id?' · From previous system':''}</p><div class="actions">${canDocument()?`<button type="button" data-edit-clinical="${esc(e.id)}">Edit</button>`:''}<button type="button" data-clinical-history="${esc(e.id)}">History</button></div>${clinicalSummary(e.content)}<div id="clinical-history-${esc(e.id)}"></div>`)).join('')+chartRecordTemplate('clinical-review',reviewForm)+chartRecordTemplate('clinical-review-history',(workspace.clinical.review_history||[]).map(r=>`<article><b>${esc(clinicalLabels[r.kind])} · ${esc(displayStatus(r.review_state))}</b><p>${esc(displayDate(r.created_at))}${r.actor_label||r.author_label||r.author_id?' · '+esc(r.actor_label||r.author_label||r.author_id):''}</p><p>${esc(r.note)}</p></article>`).join('')||'<p>No reviews yet.</p>')+'<div id="clinical-editor"></div>';
}

function clinicalSummary(c){return `<p class="muted">${c.onset_date?'Onset/start '+esc(displayDate(c.onset_date)):'Onset/start unknown'}${c.end_date?' · Ended '+esc(displayDate(c.end_date)):''}</p>${c.detail.kind==='allergy'?`<p>Category: ${esc(c.detail.category)} · Reaction: ${esc(c.detail.reaction||'unknown')} · Severity: ${esc(c.detail.severity)} · Criticality: ${esc(c.detail.criticality)}</p>`:c.detail.kind==='medication'?`<p>${[['Dose',c.detail.dose],['Route',c.detail.route],['Frequency',c.detail.frequency],['Indication',c.detail.indication]].map(([k,v])=>`${k}: ${esc(v||'unknown')}`).join(' · ')}</p>`:`<p>Type: ${esc(human(c.detail.problem_type))}</p>`}${c.codes.length?`<p>${c.codes.map(c=>`${esc(c.system)}: ${esc(c.code)} ${esc(c.display)}`).join(' · ')}</p>`:''}${c.notes?`<p class="note-text">${esc(c.notes)}</p>`:''}`;}
function selectField(name,label,values,current,labels){return `<label>${label}<select name="${name}">${values.map((v,i)=>`<option value="${v}" ${v===current?'selected':''}>${esc(labels?labels[i]:human(v))}</option>`).join('')}</select></label>`;}
function codeRow(c={}){return `<div class="coding-row"><label>Code system<input name="code_system" maxlength="200" placeholder="e.g. http://snomed.info/sct" value="${esc(c.system)}"></label><label>Code<input name="code_value" maxlength="120" value="${esc(c.code)}"></label><label>Display<input name="code_display" maxlength="200" value="${esc(c.display)}"></label><button type="button" data-remove-code>Remove code</button></div>`;}
function editClinical(k,entry,mapping){
 focusClinicalSection(k);
 const c=entry?.content||mapping?.content||{title:'',status:'active',verification:'unconfirmed',codes:[],detail:{kind:k,problem_type:'problem',category:'other',severity:'unknown',criticality:'unknown'}};
 const d=c.detail;let detail='';
 if(k==='problem')detail=selectField('problem_type','Problem type',['problem','diagnosis','health_concern'],d.problem_type);
 if(k==='allergy')detail=`${selectField('category','Category',['medication','food','environment','biologic','other'],d.category)}<label>Reaction<input name="reaction" maxlength="2000" value="${esc(d.reaction)}"></label>${selectField('severity','Reaction severity',['unknown','mild','moderate','severe'],d.severity)}${selectField('criticality','Future risk / criticality',['unknown','low','high'],d.criticality)}`;
 if(k==='medication')detail=['dose','route','frequency','indication'].map(key=>`<label>${key[0].toUpperCase()+key.slice(1)}<input name="${key}" maxlength="500" value="${esc(d[key])}"></label>`).join('');
 chartOpenEditor('clinical-editor','Clinical entry').innerHTML=`<form id="clinical-entry-form" class="clinical-editor" data-kind="${k}" data-id="${esc(entry?.id||'')}" data-version="${entry?.version||''}" data-source="${esc(entry?.source_history_id||mapping?.source_history_id||'')}"><h3>${mapping?'Reconcile imported':entry?'Edit':'Add'} ${k}</h3>${k==='medication'?'<p class="muted">Medication list documentation. This does not prescribe, dispense or send an eRx.</p>':''}${mapping?`<div class="mapping-notice"><b>From previous system. Check before saving.</b><ul>${mapping.issues.map(v=>`<li>${esc(v)}</li>`).join('')}</ul><details><summary>Original source fields</summary><dl>${Object.entries(mapping.source_data).map(([k,v])=>`<dt>${esc(k)}</dt><dd class="note-text">${esc(typeof v==='object'?JSON.stringify(v):v)}</dd>`).join('')}</dl></details></div>`:''}<div class="form-grid"><label>Name / clinical description<input name="title" required maxlength="200" value="${esc(c.title)}"></label>${selectField('status','Clinical status',clinicalStatuses[k],c.status)}${selectField('verification','Verification',['unconfirmed','confirmed','refuted','entered_in_error'],c.verification)}<label>Onset / start date<input type="date" name="onset_date" value="${esc(c.onset_date)}"></label><label>End date<input type="date" name="end_date" value="${esc(c.end_date)}"></label>${detail}</div><h3>Terminology codes</h3><p class="muted">Enter the source system and code. Codes are saved as typed and are not checked against a code list.</p><div id="clinical-codes">${(c.codes.length?c.codes:[{}]).map(codeRow).join('')}</div><button type="button" data-add-code>Add code</button><label>Clinical notes<textarea name="notes" maxlength="10000">${esc(c.notes)}</textarea></label>${mapping?'<input type="hidden" name="reason" value="Reconciled from previous system records">':'<label>Reason / source of this change<input name="reason" required maxlength="1000" placeholder="Required so each change is explained"></label>'}<div class="actions"><button type="submit" class="primary">${mapping?'Save reconciled entry':'Save '+k}</button><button type="button" data-cancel-clinical>Cancel</button></div></form>`;
 $('clinical-entry-form').elements.title.focus({preventScroll:true});
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-add-code')){$('clinical-codes').insertAdjacentHTML('beforeend',codeRow());return;}
 if(b.hasAttribute('data-remove-code')){b.closest('.coding-row').remove();return;}
 if(b.hasAttribute('data-cancel-clinical')){$('clinical-editor').replaceChildren();return;}
 if(!b.dataset.newClinical&&!b.dataset.editClinical&&!b.dataset.clinicalHistory&&!b.dataset.mapClinical)return;
 run(async()=>{
 if(b.dataset.newClinical)editClinical(b.dataset.newClinical);
 if(b.dataset.editClinical){const entry=workspace.clinical.items.find(e=>e.id===b.dataset.editClinical);editClinical(entry.kind,entry);}
 if(b.dataset.mapClinical){const mapping=await api(`/api/v1/patients/${selected}/history/${b.dataset.mapClinical}/mapping`);if(mapping.native_entry_id){const entry=workspace.clinical.items.find(e=>e.id===mapping.native_entry_id);if(!entry)throw new Error('Reload the chart to view the existing reconciled entry.');editClinical(entry.kind,entry);}else editClinical(mapping.content.detail.kind,null,mapping);}
 if(b.dataset.clinicalHistory){const revisions=await api(`/api/v1/patients/${selected}/clinical/${b.dataset.clinicalHistory}/revisions`);$(`clinical-history-${b.dataset.clinicalHistory}`).innerHTML=revisions.items.map(r=>`<details class="amendment"><summary>Version ${r.version} · ${esc(date(r.created_at))} · ${esc(r.reason)}</summary><p class="muted">Recorded by ${esc(r.author_id)}</p><b>${esc(r.content.title)}</b><p>${esc(human(r.content.status))} · ${esc(r.content.verification)}</p>${clinicalSummary(r.content)}</details>`).join('');}
 });
});
document.addEventListener('submit',e=>{
 const f=e.target;if(f.id!=='clinical-entry-form'&&!f.classList.contains('clinical-review-form'))return;e.preventDefault();
 run(async()=>{
 const data=new FormData(f),k=f.dataset.kind;
 if(f.classList.contains('clinical-review-form')){await api(`/api/v1/patients/${selected}/clinical-review/${k}`,'POST',{review_state:data.get('review_state'),note:data.get('note')},Number(f.dataset.version));await selectPatient(selected,activeVisit?.id);notice('Clinical list review recorded.');return;}
 const codes=data.getAll('code_system').map((system,i)=>({system,code:data.getAll('code_value')[i],display:data.getAll('code_display')[i]})).filter(c=>c.system||c.code||c.display);
 const detail={kind:k};for(const key of k==='problem'?['problem_type']:k==='allergy'?['category','reaction','severity','criticality']:['dose','route','frequency','indication'])detail[key]=data.get(key);
 const content={title:data.get('title'),status:data.get('status'),verification:data.get('verification'),onset_date:data.get('onset_date')||null,end_date:data.get('end_date')||null,notes:data.get('notes'),codes,detail};
 const path=`/api/v1/patients/${selected}/clinical${f.dataset.id?'/'+f.dataset.id:''}`;
 await api(path,f.dataset.id?'PUT':'POST',{content,reason:data.get('reason'),source_history_id:f.dataset.source||null},f.dataset.id?Number(f.dataset.version):undefined);
 await selectPatient(selected,activeVisit?.id);notice('Entry saved. The list needs review.');
 });
});
