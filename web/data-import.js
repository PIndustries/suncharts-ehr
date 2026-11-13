// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The Data import page, and the chart blocks that put imported records to use:
// contact details from the previous system and accepting a whole imported list.
const importStatusLabels={collecting:'Needs checking',reconciled:'Ready to import',imported:'Imported'};
const importKindLabels={patient:['patient','patients'],medical_problem:['problem','problems'],medication:['medication','medications'],allergy:['allergy','allergies'],encounter:['visit','visits'],soap_note:['note','notes'],vital:['set of vitals','sets of vitals'],immunization:['immunization','immunizations'],insurance:['insurance record','insurance records'],lab_result:['result','results'],procedure:['procedure','procedures'],referral:['referral','referrals'],appointment:['appointment','appointments'],document:['document','documents'],form:['other record','other records']};
const importIssueLabels={source_count_mismatch:'The file is incomplete. Upload it again.',invalid_patient_mapping:'A patient is missing a name or date of birth.',duplicate_mrn_in_export:'Two patients in the file share a record number.',mrn_collision_requires_identity_review:'A patient in the file has the same record number as a different chart here.',source_changed_since_prior_import:'A record changed since it was last imported. Ask for help before importing this file.',unmapped_patient_reference:'A record belongs to a patient who is not in the file.',patient_reference_required:'A record is not linked to a patient.',lab_order_patient_mismatch:'A result is linked to another patient\'s order.',unmapped_lab_order_reference:'A result is linked to an order that is not in the file.'};
const importCount=(n,kind)=>{const label=importKindLabels[kind]||[kind.replaceAll('_',' '),kind.replaceAll('_',' ')];return `${n} ${esc(n===1?label[0]:label[1])}`;};
const importPerson=p=>`${esc(p.given_name)} ${esc(p.family_name)}`;
const importPeople=(n,one,many)=>`${n} ${n===1?one:many}`;
function importDecisionState(p){
 if(p.decision?.action==='attach')return 'Records will go on the chart you chose.';
 if(p.decision?.action==='create')return 'A new chart will be created.';
 return 'Choose one to continue.';
}
// One imported patient who looks like a chart the clinic already has: the patient from
// the file beside each possible chart, with the two choices as buttons.
function importDecisionRow(job,p){
 const locked=job.status==='imported',attached=p.decision?.action==='attach'?p.decision.patient_id:null,create=p.decision?.action==='create';
 const choice=(pressed,attrs,label)=>`<button type="button" class="${pressed?'primary':''}" aria-pressed="${pressed}" data-import-job="${esc(job.id)}" data-import-source="${esc(p.source_id)}" ${attrs} ${locked?'disabled':''}>${label}</button>`;
 return `<li class="import-decision ${p.decision?'':'undecided'}" data-import-patient="${esc(p.source_id)}"><div class="import-decision-person"><small>In the import file</small><b>${importPerson(p)}</b><span>Born ${esc(p.birth_date)}</span></div><div class="import-decision-charts">${p.candidates.map(c=>`<div class="import-decision-chart"><div class="import-decision-person"><small>${c.match==='exact'?'Chart you already have':'Possible match'}</small><b>${importPerson(c)}</b><span>Born ${esc(c.birth_date)} · MRN ${esc(c.mrn)}${c.archived?' · Archived':''}</span></div>${choice(attached===c.patient_id,`data-import-attach="${esc(c.patient_id)}"`,'Attach to this chart')}</div>`).join('')}<div class="import-decision-chart"><span class="muted">Not the same person?</span>${choice(create,'data-import-create','Create a new chart')}</div></div><p class="import-decision-state" role="status">${importDecisionState(p)}</p></li>`;
}
function importPatients(job){
 const people=job.report?.patients||[];if(!people.length)return '';
 const by=status=>people.filter(p=>p.status===status),matches=people.filter(p=>['match','possible'].includes(p.status)),undecided=matches.filter(p=>!p.decision).length;
 const summary=[[by('new').length,'new chart','new charts'],[by('match').length,'matches a chart you already have','match charts you already have'],[by('possible').length,'possible match','possible matches'],[by('linked').length,'already imported','already imported']].filter(([n])=>n).map(([n,one,many])=>importPeople(n,one,many)).join(' · ');
 return `<section class="import-patients"><h4>Patients in this file</h4><p>${summary}</p>${matches.length?`<p class="muted">${job.status==='imported'?'These patients matched charts you already had.':'Check each match. Attach puts the imported records on the existing chart and leaves its details as they are.'}</p><ul class="import-decisions">${matches.map(p=>importDecisionRow(job,p)).join('')}</ul>`:''}${undecided&&job.status!=='imported'?`<p class="notice error" role="status">${importPeople(undecided,'patient needs','patients need')} a choice before you can import.</p>`:''}</section>`;
}
function importJobCard(j){
 const errors=j.report?.errors||[],issues=[...new Set(errors.map(e=>importIssueLabels[e.error]||'This file has a problem. Upload a fresh copy.'))],ready=j.status==='reconciled'&&j.report?.ready_to_import===true;
 return `<div class="migration-job" data-import-card="${esc(j.id)}"><div class="section-head"><h3>${esc(j.manifest.source_revision)}</h3><span class="pill">${esc(importStatusLabels[j.status]||j.status)}</span></div><p class="muted">${Object.entries(j.manifest.expected_counts).filter(([,n])=>n).map(([k,n])=>importCount(n,k)).join(' · ')}</p>${issues.length?`<div class="notice error"><b>This file cannot be imported yet.</b><ul>${issues.slice(0,8).map(v=>`<li>${esc(v)}</li>`).join('')}</ul></div>`:''}${importPatients(j)}<div class="actions">${j.status==='collecting'?`<button type="button" data-reconcile="${esc(j.id)}">Check again</button>`:''}${j.status==='reconciled'?`<button type="button" class="primary" data-commit="${esc(j.id)}" data-digest="${esc(j.digest)}" ${ready?'':'disabled'}>Import records</button>`:''}</div>${j.status==='imported'?'<p class="muted">Imported records show on each chart as records from the previous system.</p>':''}</div>`;
}
async function showMigrations(){
 const jobs=await api('/api/v1/migrations');showTool('Data import');
 $('tools').innerHTML=`<div id="data-import"><p class="eyebrow">BRING YOUR RECORDS WITH YOU</p><h2>Data import</h2><p>Bring in patient records from your previous system. Upload the import file, check the patients it found, then import.</p><form id="migration-form"><label>Import file<input name="package" type="file" accept="application/json,.json" required></label><div class="actions"><button class="primary" type="submit">Upload and check</button></div></form><h3>Your imports</h3>${jobs.items.map(importJobCard).join('')||'<p class="muted">Nothing uploaded yet.</p>'}</div>`;
}
async function uploadMigration(form){
 const file=form.elements.package.files[0];if(!file||file.size>8*1024*1024)throw new Error('Choose an import file of up to 8 MB.');
 const pkg=JSON.parse(await file.text());if(!pkg.manifest||!Array.isArray(pkg.items))throw new Error('This is not an import file.');
 const job=await api('/api/v1/migrations','POST',pkg.manifest);
 // Keep each request below the size limit, including long notes.
 let batch=[];for(const item of pkg.items){const next=[...batch,item];if(new TextEncoder().encode(JSON.stringify({items:next})).length>60000||next.length>50){if(!batch.length)throw new Error('One record in the file is too large to upload.');await api(`/api/v1/migrations/${job.id}/items`,'POST',{items:batch});batch=[item];}else{batch=next;}}
 if(batch.length)await api(`/api/v1/migrations/${job.id}/items`,'POST',{items:batch});
 const report=await api(`/api/v1/migrations/${job.id}/reconcile`,'POST');await showMigrations();importNotice(report);
}
function importNotice(report){
 if(report.errors?.length)notice('The file was uploaded but cannot be imported yet. See the list below.',true);
 else if(report.patients_needing_decision)notice(`File checked. ${importPeople(report.patients_needing_decision,'patient needs','patients need')} your choice before importing.`);
 else notice('File checked. Review the patients, then import.');
}
async function importCommit(button){
 const jobs=await api('/api/v1/migrations'),job=jobs.items.find(j=>j.id===button.dataset.commit),people=job?.report?.patients||[];
 const attached=people.filter(p=>p.decision?.action==='attach').length,created=people.filter(p=>p.status==='new'||p.decision?.action==='create').length;
 const message=`${importPeople(attached,'patient goes','patients go')} onto charts you already have. ${importPeople(created,'new chart is','new charts are')} created. This cannot be undone.`;
 if(!await confirmAction(message,{title:'Import these records?',confirmLabel:'Import records'}))return;
 await api(`/api/v1/migrations/${button.dataset.commit}/commit`,'POST',{digest:button.dataset.digest});await showMigrations();notice('Records imported.');
}

// --- on the chart --------------------------------------------------------------------------
const importedContactFields=[['phone','Phone'],['email','Email'],['address','Address'],['administrative_gender','Gender'],['language','Language']];
const importedContactText=(field,value)=>field==='address'&&value?[value.line1,value.line2,value.city,value.region,value.postal_code,value.country].filter(Boolean).join(', '):String(value||'');
// Contact details the previous system held, beside the imported records. A value can be
// copied into the chart only where the chart has nothing yet.
function importedContactBlock(){
 const record=(workspace.history||[]).find(r=>r.source_data?.contact&&typeof r.source_data.contact==='object');if(!record)return '';
 const imported=record.source_data.contact,native=workspace.demographics?.content||{},canEdit=['owner','clinician','front_desk'].includes(me.role);
 const rows=importedContactFields.map(([field,label])=>{const text=importedContactText(field,imported[field]);if(!text)return null;const current=importedContactText(field,native[field]);return {field,label,text,current};}).filter(Boolean);
 if(!rows.length||rows.every(r=>r.current===r.text))return '';
 return `<section class="imported-contact" id="imported-contact"><h3>From previous system</h3><p class="muted">Contact details from the previous system. Use them to fill empty fields on this chart.</p>${rows.map(r=>`<div class="summary-line imported-contact-row"><b>${esc(r.label)}</b><span>${esc(r.text)}</span>${r.current?`<small class="muted">${r.current===r.text?'Same as the chart':'Chart has '+esc(r.current)}</small>`:canEdit?`<button type="button" data-use-contact="${esc(r.field)}" data-record="${esc(record.id)}">Use this</button>`:''}</div>`).join('')}</section>`;
}
async function importedContactUse(button){
 const patient=selected,chart=workspace,label=importedContactFields.find(([field])=>field===button.dataset.useContact)?.[1]||'Value';
 const saved=await api(`/api/v1/patients/${patient}/history/${button.dataset.record}/use-contact`,'POST',{field:button.dataset.useContact});
 if(selected!==patient||workspace!==chart)return;
 workspace.demographics=saved;
 if(typeof renderDemographics==='function')await renderDemographics(patient,saved);
 if(typeof refreshChartContactSummary==='function')refreshChartContactSummary();
 const block=$('imported-contact');if(block)block.outerHTML=importedContactBlock();
 notice(`${label} added to the chart.`);
}
const importedListKinds={problem:['medical_problem','problems'],medication:['medication','medications']};
function importedListPending(kind){
 const source=importedListKinds[kind]?.[0];if(!source||!Array.isArray(workspace.history))return [];
 const reconciled=new Set(workspace.clinical.items.map(e=>e.source_history_id).filter(Boolean)),names=new Set(workspace.clinical.items.filter(e=>e.kind===kind).map(e=>String(e.content.title||'').trim().toLowerCase()));
 return workspace.history.filter(r=>r.kind===source&&!reconciled.has(r.id)).map(r=>({record:r,onChart:names.has(String(r.data?.title||'').trim().toLowerCase())}));
}
// A patient's imported problems or medications that are not on the chart's list yet,
// shown for review with one button to accept them all.
function importedListBlock(kind){
 if(!['owner','clinician'].includes(me.role))return '';
 const pending=importedListPending(kind);if(!pending.length)return '';
 const plural=importedListKinds[kind][1],ready=pending.filter(p=>!p.onChart).length;
 return `<div class="imported-list" data-imported-list="${kind}"><h4>From previous system (${pending.length})</h4><p class="muted">Review these ${plural}, then add them to this chart. Each one stays marked as coming from the previous system.</p><ul>${pending.map(({record:r,onChart})=>{const d=r.data||{},facts=[d.codes,d.onset||d.started?`Started ${d.onset||d.started}`:'',d.resolved||d.stopped?`Ended ${d.resolved||d.stopped}`:'',d.status].filter(Boolean);return `<li><div><b>${esc(d.title||'No name recorded')}</b>${facts.length?`<small>${esc(facts.join(' · '))}</small>`:''}${onChart?'<small class="muted">Already on this list. Review it on its own.</small>':''}</div><button type="button" data-map-clinical="${esc(r.id)}">Review</button></li>`;}).join('')}</ul>${ready?`<div class="actions"><button type="button" class="primary" data-reconcile-all="${kind}">Reconcile all ${plural}</button></div>`:''}</div>`;
}
async function importedListAccept(kind){
 const patient=selected,ids=importedListPending(kind).filter(p=>!p.onChart).map(p=>p.record.id);if(!ids.length)return;
 const plural=importedListKinds[kind][1],done=await api(`/api/v1/patients/${patient}/clinical-reconcile/${kind}`,'POST',{history_ids:ids});
 if(selected!==patient)return;
 await selectPatient(patient,activeVisit?.id);
 notice(`${importPeople(done.created.length,importedListKinds[kind][1].slice(0,-1),plural)} added to the chart.${done.needs_review.length?` ${importPeople(done.needs_review.length,'entry needs','entries need')} a closer look. Use Review.`:''}`);
}
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 const d=button.dataset;
 if(d.useContact){run(()=>importedContactUse(button));return;}
 if(d.reconcileAll){run(()=>importedListAccept(d.reconcileAll));return;}
 // "Check again" and "Import records" run through the shared handler in app.js.
 if(d.importSource&&(d.importAttach||button.hasAttribute('data-import-create'))){run(async()=>{await api(`/api/v1/migrations/${d.importJob}/patient-decisions`,'POST',d.importAttach?{source_id:d.importSource,action:'attach',patient_id:d.importAttach}:{source_id:d.importSource,action:'create'});await showMigrations();});}
});
