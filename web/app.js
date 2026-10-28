// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let chartSection='overview';
// Unsaved clinical edits live only in this tab, isolated by encounter and patient.
const visitDrafts=new Map();
function captureVisitDrafts(includeRooming=true){
 if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
 if(typeof capturePortalStaffDrafts==='function')capturePortalStaffDrafts();
 if(typeof captureSupportDrafts==='function')captureSupportDrafts();
 if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
 if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
 if(typeof captureDocumentDraft==='function')captureDocumentDraft();
 if(typeof captureReferralDraft==='function')captureReferralDraft();
 if(typeof captureOrderDiagnosisLinkDraft==='function')captureOrderDiagnosisLinkDraft();
 if(typeof captureAccountDiagnosisLinkDraft==='function')captureAccountDiagnosisLinkDraft();
 if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft();
 if(includeRooming&&typeof captureRoomingDraft==='function')captureRoomingDraft();
 if(includeRooming&&typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
 if(typeof captureCheckoutDraft==='function')captureCheckoutDraft();
 if(!activeVisit||activeVisit.status==='signed')return;
 const key=activeVisit.id, draft=visitDrafts.get(key)||{patientId:selected};
 for(const kind of ['note','vitals']){
  const form=$(kind+'-form');if(!form||form.dataset?.visitId!==key)continue;
  const values=formData(form),saved=activeVisit[kind]||{};
  const changed=Object.entries(values).some(([k,v])=>kind==='vitals'?v===''?saved[k]!=null:Number(v)!==saved[k]:v!==String(saved[k]??''));
  if(changed)draft[kind]={values,version:Number(form.dataset.version)};else delete draft[kind];
 }
 if(draft.note||draft.vitals)visitDrafts.set(key,draft);else visitDrafts.delete(key);
 updateDraftStatus();
}
function updateDraftStatus(){
 const status=$('visit-draft-status');if(!status||!activeVisit)return;
 const draft=visitDrafts.get(activeVisit.id),parts=['note','vitals'].filter(k=>draft?.[k]);
 status.textContent=parts.length?`Unsaved ${parts.join(' and ')} edits retained in this tab. Save before closing or reloading.`:'Current note and vitals match the saved record.';
 if(parts.some(k=>draft[k].version!==activeVisit.version))status.textContent+=' The saved encounter changed. Your edits are preserved; compare with the current record before saving.';
 if(parts.length)status.innerHTML+=' <button type="button" class="text-button" data-action="discard-visit-draft">Discard unsaved edits and use saved record</button>';
}

let me, patients = [], cursor, selected, workspace, activeVisit, busy = false;
async function api(path, method = 'GET', body, version) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (version !== undefined) headers['If-Match'] = `"${version}"`;
  let response;
  try { response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials:'same-origin', cache:'no-store'}); }
  catch { throw new Error(method === 'GET' ? 'Connection interrupted. Please try loading again.' : 'Connection interrupted. This change may have saved. Reload the patient before trying again.'); }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { signInScreen(); throw new Error('Please sign in to continue.'); }
  if (!response.ok) throw new Error(data.message || (response.status === 409 ? 'This visit changed. Reload it before saving.' : 'Unable to complete this action. Please check your entries.'));
  return data;
}
function signInScreen() {
  if(typeof clearPrescribingSession==='function')clearPrescribingSession();
  if(typeof clearPortalStaffSession==='function')clearPortalStaffSession();
  if(typeof clearConnectUpdatesSession==='function')clearConnectUpdatesSession();
  if(typeof clearSupportSession==='function')clearSupportSession();
  if(typeof clearConnectionStatusSession==='function')clearConnectionStatusSession();
  if(typeof clearPatientIdentitySession==='function')clearPatientIdentitySession();
  if(typeof clearReferralDeliverySession==='function')clearReferralDeliverySession();
  if(typeof clearDocumentsSession==='function')clearDocumentsSession();
  if(typeof clearReferralSession==='function')clearReferralSession();
  if(typeof resetOrderDiagnosisLinkDrafts==='function')resetOrderDiagnosisLinkDrafts();
  if(typeof resetAccountDiagnosisLinkDrafts==='function')resetAccountDiagnosisLinkDrafts();
  if(typeof clearHealthHistorySession==='function')clearHealthHistorySession();
  visitDrafts.clear();
  if(typeof roomingDrafts!=='undefined'){roomingDrafts.clear();roomingPending.clear();roomingGeneration++;}
  if(typeof visitDiagnosisDrafts!=='undefined'){visitDiagnosisDrafts.clear();visitDiagnosisStates.clear();visitDiagnosisPending.clear();visitDiagnosisGeneration++;}
  if(typeof practiceAdminGeneration!=='undefined'){practiceAdminState=null;practiceAdminGeneration++;}
  if(typeof checkoutDrafts!=='undefined'){checkoutDrafts.clear();checkoutStates.clear();checkoutGeneration++;checkoutState=undefined;checkoutContext=undefined;}
  me = undefined; patients = []; selected = undefined; workspace = undefined; activeVisit = undefined;
  closeNavigation();
  $('app').hidden = true; $('login-screen').hidden = false;
  $('patients').replaceChildren(); $('chart').replaceChildren(); $('patient-form').reset(); $('patient-form').hidden=true;
  $('search').value=''; $('notice').hidden=true; $('tools').replaceChildren(); $('tools').hidden=true;
}
function notice(message, error = false) { $('notice').textContent=message; $('notice').className=`notice${error?' error':''}`; $('notice').hidden=false; }
async function run(action) {
  if (busy) return;
  busy=true; $('notice').hidden=true;
  const buttons = Array.from(document.querySelectorAll('button'), b=>[b,b.disabled]);
  buttons.forEach(([b])=>{b.disabled=true;});
  try { await action(); } catch(e) { if (me) notice(e.message,true); else $('login-error').textContent=e.message; }
  finally { busy=false; buttons.forEach(([b,disabled])=>{if(b.isConnected)b.disabled=disabled;}); }
}
async function enter() {
  me=await api('/auth/me');
  if($('nav-portal'))$('nav-portal').hidden=!['owner','clinician','front_desk'].includes(me.role);
  $('login-screen').hidden=true; $('app').hidden=false;$('toggle-directory').hidden=false;
  $('identity').textContent=me.role.replaceAll('_',' ');
  $('sidebar-role').textContent=({owner:'Practice owner',clinician:'Clinician',front_desk:'Front desk',read_only:'Read only',nurse:'Nurse',medical_assistant:'Medical assistant'})[me.role]||me.role.replaceAll('_',' ');
  setPage('Patients & visits');
  if(typeof refreshConnectionBadge==='function')void refreshConnectionBadge();
  if(typeof startConnectUpdates==='function')void startConnectUpdates(me);
  $('nav-migration').hidden=me.role!=='owner';
  if($('nav-admin'))$('nav-admin').hidden=me.role!=='owner';
  const page=await api('/api/v1/patients'); patients=page.items; cursor=page.next_cursor; renderPatients();
  if(typeof finishConnectOnboarding==='function'&&await finishConnectOnboarding())return;
  if (new URLSearchParams(location.search).has('oauth_request')) { await showConsent(); return; }
  if (!selected) $('chart').innerHTML='<div class="panel empty"><span class="empty-mark" aria-hidden="true">⊕</span><h2>Open a patient chart</h2><p>Select a patient from the directory to review their record,<br>manage orders, or document an encounter.</p><div class="empty-shortcuts"><button type="button" data-open-schedule>View schedule</button></div></div>';
  const paymentId=new URLSearchParams(location.search).get('payment_checkout');
  if(paymentId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId)&&typeof openPaymentStatus==='function'){
    await showBillingQueue();await openPaymentStatus(paymentId);return;
  }
  if(new URLSearchParams(location.search).get('payment_settings')==='1'&&typeof openPaymentSettings==='function'){
    await showBillingQueue();await openPaymentSettings();return;
  }
  const batchId=new URLSearchParams(location.search).get('era_batch');
  if (batchId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) {
    await showClaimsWorkspace();
    await showEraBatch(batchId);
    return;
  }
  if(typeof showPracticeWorkspace==='function')await showPracticeWorkspace();
}
function renderPatients() {
  const q=$('search').value.trim().toLowerCase();
  const filtered=patients.filter(p=>`${p.given_name} ${p.family_name} ${p.mrn}`.toLowerCase().includes(q));
  $('patient-count').textContent=patients.length;
  $('patients').innerHTML=filtered.length ? filtered.map(p=>`<button class="patient-row ${p.id===selected?'selected':''}" data-patient="${esc(p.id)}">${esc(p.family_name)}, ${esc(p.given_name)}<small>${esc(p.mrn)} · ${esc(p.birth_date)}</small></button>`).join('') : '<p class="muted">No patients found.</p>';
  $('load-more').hidden=!cursor;
}
async function selectPatient(id, keepVisit) {
  captureVisitDrafts();
  // Publish one complete chart only after every patient-scoped read succeeds.
  const next=await api(`/api/v1/patients/${id}/workspace`);
  const [history,clinical,labs,billing,payers,demographics]=await Promise.all([
    api(`/api/v1/patients/${id}/history`),api(`/api/v1/patients/${id}/clinical`),
    api(`/api/v1/patients/${id}/orders`),api(`/api/v1/patients/${id}/billing`),api('/api/v1/billing/payers'),api(`/api/v1/patients/${id}/demographics`)
  ]);
  captureVisitDrafts(); // Include edits made while the chart reads were in flight.
  next.history=history.items;next.clinical=clinical;next.labs=labs;next.billing=billing;next.demographics=demographics;
  if(id!==selected)chartSection='overview';
  if(keepVisit&&activeVisit?.id!==keepVisit)chartSection='visits';
  workspace=next;billingPayers=payers.items;selected=id;
  activeVisit=keepVisit ? workspace.visits.find(v=>v.id===keepVisit) : workspace.visits.find(v=>v.status==='in_progress'&&v.clinician_id===me.user_id)||workspace.visits.find(v=>v.status==='in_progress');
  renderPatients();renderChart();
}

const date = s => new Date(s).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
function renderChart() {
  if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
  if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
  if(typeof captureDocumentDraft==='function')captureDocumentDraft();
  if(typeof captureReferralDraft==='function')captureReferralDraft();
  if(typeof captureOrderDiagnosisLinkDraft==='function')captureOrderDiagnosisLinkDraft();
  if(typeof captureAccountDiagnosisLinkDraft==='function')captureAccountDiagnosisLinkDraft();
  if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft();
  const p=workspace.patient;
  const allergies=workspace.clinical.items.filter(e=>e.kind==='allergy'&&e.content.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification));
  const allergyReview=workspace.clinical.reviews.find(r=>r.kind==='allergy');
  const allergyText=allergies.length?allergies.map(e=>`${e.content.title} (${e.content.verification})`).join(', '):allergyReview?.review_state==='no_known'?'No known allergies — reviewed':'Allergy status not confirmed';
  if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
  const tabs=[['overview','Summary'],['profile','Patient details'],['clinical','Clinical lists'],['prescribing','Prescribing'],['history','Surgical & dental history'],['documents','Documents'],['referrals','Referrals'],['orders','Orders & results'],['visits','Encounters'],['checkout','Checkout & AVS'],['billing','Financials'],['source','Source records']];
  const preferred=workspace.demographics?.content?.preferred_name;
  const birth=new Date(p.birth_date+'T12:00:00'),now=new Date();let age=now.getFullYear()-birth.getFullYear();if(now.getMonth()<birth.getMonth()||(now.getMonth()===birth.getMonth()&&now.getDate()<birth.getDate()))age--;
  const encounter=activeVisit?workspace.appointments.find(a=>a.id===activeVisit.appointment_id):null;
  $('chart').innerHTML=`<div class="chart-context"><div class="chart-header"><div class="avatar">${esc(p.given_name[0])}${esc(p.family_name[0])}</div><div class="patient-heading"><p class="chart-record-label">PATIENT CHART${preferred?' · Preferred name '+esc(preferred):''}</p><h2>${esc(p.family_name)}, ${esc(p.given_name)} <span class="chart-age">${age>=0?esc(age)+' years':''}</span></h2><p><span>MRN <b>${esc(p.mrn)}</b></span><span>DOB <b>${esc(p.birth_date)}</b></span></p></div><div class="chart-header-context">${activeVisit?`<span class="status-badge ${activeVisit.status==='signed'?'completed':'in_progress'}">${activeVisit.status==='signed'?'Signed encounter':'Active encounter'}</span><small>${esc(encounterDateLabel(activeVisit))}</small>`:'<span class="muted">Longitudinal record</span>'}</div><button class="quiet" data-action="reload" aria-label="Reload patient chart">↻ Refresh</button>${['owner','clinician','front_desk'].includes(me?.role)?`<button type="button" data-portal-access="${esc(selected)}">Patient portal</button>`:''}</div><div class="patient-safety ${allergies.length?'has-allergies':''}"><b>Allergies</b><span>${esc(allergyText)}</span></div><nav class="chart-tabs" aria-label="Patient chart sections">${tabs.map(([key,label])=>`<button type="button" data-chart-section="${key}" aria-pressed="${key===chartSection}">${label}</button>`).join('')}</nav></div>
  <div id="encounter-progress">${encounterWorkflow()}</div>
  ${chartOverview()}
  <section id="patient-demographics"></section>
  <div id="visit-editor"></div>
  <div id="visit-checkout"><div class="panel"><h2>Checkout & after-visit summary</h2><p>Select an encounter from Encounters to review its handoff and follow-up.</p></div></div>
  ${patientAppointmentWorkspace()}
  <div id="visits-panel" class="panel"><div class="section-head"><h2>Visits</h2><span class="pill">${workspace.visits.length}</span></div>${workspace.visits.map(v=>`<div class="timeline-row"><div><p>${v.status==='signed'?'Signed visit':'Visit in progress'}</p><small>${v.signed_at?esc(date(v.signed_at)):'Documentation in progress'}</small></div><button data-visit="${esc(v.id)}">${v.status==='signed'?'View record':'Open visit'}</button></div>`).join('')||'<p class="muted">Your first visit will appear here after check-in.</p>'}</div>`;
  if(typeof renderPrescribing==='function')void renderPrescribing(); renderClinical(); renderLabs(); renderBilling(); renderHistory(); if(typeof renderHealthHistory==='function')void renderHealthHistory(); if(typeof renderDocuments==='function')void renderDocuments(); if(typeof renderPatientIdentity==='function')void renderPatientIdentity(); if(typeof renderReferrals==='function')void renderReferrals(); if(typeof renderDemographics==='function')renderDemographics(selected,workspace.demographics); if(activeVisit) renderVisit(false); applyChartSection();
}
function canRegisterPatient(){return ['owner','clinician','front_desk'].includes(me?.role);}
function isRoomingStaff(){return ['nurse','medical_assistant'].includes(me?.role);}
function canRecordVisitVitals(v){return v?.status==='in_progress'&&(isRoomingStaff()||(['owner','clinician'].includes(me?.role)&&v.clinician_id===me.user_id));}
function renderVisit(activate=true) {
  if(activate){chartSection='visits';applyChartSection();}
  const v=activeVisit, draft=visitDrafts.get(v.id), retained=draft?.patientId===selected&&v.status!=='signed'?draft:null, note=retained?.note?.values||v.note||{}, vitals=retained?.vitals?.values||v.vitals||{}, signed=v.status==='signed', writable=['owner','clinician'].includes(me.role)&&v.clinician_id===me.user_id, locked=signed||!writable, vitalsLocked=!canRecordVisitVitals(v);
  const vitalLabels={systolic_mm_hg:'Systolic BP (mmHg)',diastolic_mm_hg:'Diastolic BP (mmHg)',heart_rate_bpm:'Heart rate (bpm)',temperature_c:'Temperature (°C)',weight_kg:'Weight (kg)',height_cm:'Height (cm)',oxygen_saturation_pct:'Oxygen saturation (%)'};
  const amendments=workspace.amendments.filter(a=>a.visit_id===v.id);
  $('visit-editor').innerHTML=`<section class="panel"><div class="section-head"><h2>${signed?'Signed clinical record':'Visit documentation'}</h2><span class="pill ${signed?'signed':''}">${signed?'Signed':'In progress'}</span></div>${signed?`<div class="signed-notice">Signed ${esc(date(v.signed_at))}. Original documentation is preserved; corrections are added below.</div>`:''}
  <div id="visit-rooming"></div><p id="visit-draft-status" class="muted" role="status"></p><h3>Vitals</h3><form id="vitals-form" data-visit-id="${v.id}" data-version="${retained?.vitals?.version??v.version}"><div class="form-grid vitals-grid">${Object.entries(vitalLabels).map(([key,label])=>`<label>${label}<input name="${key}" type="number" step="${['systolic_mm_hg','diastolic_mm_hg','heart_rate_bpm'].includes(key)?'1':'any'}" required value="${esc(vitals[key])}" ${vitalsLocked?'disabled':''}></label>`).join('')}</div>${vitalsLocked?'':'<button type="submit">Save vitals</button>'}</form>
  <section id="visit-diagnoses"></section><form id="note-form" data-visit-id="${v.id}" data-version="${retained?.note?.version??v.version}"><h3>SOAP note</h3><div class="form-grid note-grid">${['subjective','objective','assessment','plan'].map(key=>`<label>${key[0].toUpperCase()+key.slice(1)}<textarea name="${key}" required maxlength="10000" ${locked?'readonly':''}>${esc(note[key])}</textarea></label>`).join('')}</div>${locked?'':'<div class="actions"><button type="submit">Save note</button><button class="primary" type="button" data-action="sign">Sign note & close encounter</button><span class="muted">Save your note before signing. Signing completes the appointment; it does not complete billing or result follow-up.</span></div>'}</form>
  ${signed?`<h3>Amendments</h3>${amendments.map(a=>`<div class="amendment"><p><b>${esc(a.reason)}</b></p><p class="note-text">${esc(a.text)}</p><small class="muted">Recorded ${esc(date(a.created_at))}</small></div>`).join('')||'<p class="muted">No amendments.</p>'}${writable?`<form id="amendment-form"><label>Reason<input name="reason" required maxlength="1000"></label><label>Correction<textarea name="text" required maxlength="10000"></textarea></label><div class="actions"><button type="submit">Sign & append amendment</button></div></form>`:''}`:''}${!writable?'<p class="muted">Documentation is read-only. Only the assigned clinician can save, sign or amend the note. Authorized rooming staff may record intake and vitals before signing.</p>':''}</section>`;
  updateDraftStatus();refreshEncounterProgress();if(typeof renderRooming==='function')void renderRooming();if(typeof renderVisitDiagnoses==='function')void renderVisitDiagnoses();if(typeof renderVisitCheckout==='function')renderVisitCheckout();
}
function renderHistory() {
  const panel=document.createElement('section');panel.className='panel';panel.id='source-history';
  panel.innerHTML=`<h2>Imported source records</h2><p class="muted">Original source records are preserved separately from documentation authored in this EHR. Imported signatures have not been verified.</p>${workspace.history.map(r=>{const data=r.data||{};const fields=Object.entries(data).filter(([k,v])=>!['id','pid','uuid','puuid','patient_id'].includes(k)&&['string','number','boolean'].includes(typeof v));return `<details class="amendment"><summary><b>${esc(r.kind.replaceAll('_',' '))}</b> ${esc(data.title||data.name||data.description||'')}</summary><p class="muted">Source: ${esc(r.source_instance)} · Source record ${esc(r.source_id)}</p><dl>${fields.map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd class="note-text">${esc(v)}</dd>`).join('')}</dl><small class="muted">Imported ${esc(date(r.imported_at))} · Source history is read-only</small>${['insurance','billing','transaction'].includes(r.kind)&&['owner','clinician','front_desk'].includes(me.role)?`<div class="actions"><button type="button" data-map-billing="${esc(r.id)}">Review billing / insurance source</button></div>`:''}${r.kind==='claim'&&billingWrite()?`<button type="button" data-map-claim="${esc(r.id)}">Review claim mapping</button>`:''}${r.kind==='appointment'&&['owner','clinician','front_desk'].includes(me.role)?`<div class="actions"><button type="button" data-map-appointment="${esc(r.id)}">Review appointment mapping</button></div>`:''}${['lab_order','lab_result'].includes(r.kind)&&['owner','clinician'].includes(me.role)?`<div class="actions"><button type="button" data-map-lab="${esc(r.id)}">Reconcile lab source</button></div>`:''}${['medical_problem','allergy','medication'].includes(r.kind)&&['owner','clinician'].includes(me.role)?`<div class="actions"><button type="button" data-map-clinical="${esc(r.id)}">Reconcile into native chart</button></div>`:''}</details>`;}).join('')||'<p class="muted">No imported records for this patient.</p>'}`;
  $('chart').append(panel);
}
function encounterWorkflow(){
 const v=activeVisit, canWrite=['owner','clinician'].includes(me.role), appointment=v?workspace.appointments.find(a=>a.id===v.appointment_id):workspace.appointments.find(a=>['checked_in','booked'].includes(a.status));
 const confirmed=['problem','allergy','medication'].filter(kind=>['reviewed','no_known'].includes(workspace.clinical.reviews.find(r=>r.kind===kind)?.review_state)).length;
 const pending=workspace.labs.reports.filter(r=>['preliminary','final','corrected'].includes(r.status)&&!workspace.labs.acknowledgments.some(a=>a.report_id===r.id&&a.version===r.version));
 const orders=v?workspace.labs.orders.filter(o=>o.visit_id===v.id):[], accounts=v?workspace.billing.accounts.filter(a=>a.content.visit_id===v.id):[];
 const completeNote=v?.note&&['subjective','objective','assessment','plan'].every(k=>String(v.note[k]||'').trim());
 const state=v?.status==='signed'?'Signed encounter':v?'Encounter in progress':appointment?.status==='checked_in'?'Checked in':appointment?'Appointment booked':'No active encounter';
 const checkout=typeof checkoutProgress==='function'?checkoutProgress():{label:'Review checkout',complete:false};
 const diagnoses=typeof visitDiagnosisProgress==='function'?visitDiagnosisProgress():{label:'Review diagnoses',complete:false};
 const steps=[
  ['clinical','Chart review',`${confirmed}/3 lists confirmed`,confirmed===3],
  ['rooming','Rooming',!v?'Select an encounter':'Intake & handoff',false],
  ['vitals','Vitals',!v?'Select an encounter':v.vitals?'Vitals saved':'Vitals not recorded',!!v?.vitals],
  ['diagnoses','Diagnoses',diagnoses.label,diagnoses.complete],
  ['note','Documentation',!v?'Select an encounter':v.status==='signed'?'Signed':completeNote?'Draft saved':'Note incomplete',v?.status==='signed'],
  ['orders','Orders & results',`${orders.length} linked · ${pending.length} awaiting review`,false],
  ['billing','Charges',`${accounts.length} linked · ${accounts.filter(a=>a.status==='posted').length} posted`,accounts.length>0&&accounts.every(a=>a.status==='posted')],
  ['checkout','Checkout & AVS',checkout.label,checkout.complete]
 ];
 let next;
 if(!v){
  if(appointment?.status==='checked_in'&&((canWrite&&appointment.clinician_id===me.user_id)||isRoomingStaff()))next=`<button type="button" class="primary" data-start="${esc(appointment.id)}">Start encounter</button>`;
  else if(appointment?.status==='booked'&&['owner','clinician','front_desk'].includes(me.role))next=`<button type="button" class="primary" data-check-in="${esc(appointment.id)}">Check in patient</button>`;
  else next='<button type="button" data-chart-section="visits">Appointments</button>';
 }else next=`<button type="button" class="primary" data-encounter-step="${v.status==='signed'?'checkout':isRoomingStaff()?'rooming':'note'}">${v.status==='signed'?'Checkout & patient summary':isRoomingStaff()?'Room patient':'Continue note'}</button>`;
 return `<section class="encounter-workbench" aria-label="Patient encounter workflow"><div class="encounter-workbench-heading"><div><strong>${state}</strong><span>${esc(appointment?.title||'Patient workspace')}</span></div><div class="encounter-inline-actions">${v&&canWrite?'<button type="button" class="text-button" data-encounter-step="new-order">+ Order</button>':''}${v&&billingWrite()?'<button type="button" class="text-button" data-encounter-step="new-account">+ Charges</button>':''}${next}</div></div><nav class="encounter-step-strip" aria-label="Encounter work areas">${steps.map(([key,title,status,saved],i)=>`<button type="button" class="encounter-step-link ${saved?'has-saved-state':''}" data-encounter-step="${key}"><span class="encounter-step-number">${String(i+1).padStart(2,'0')}</span><span><strong>${title}</strong><small>${esc(status)}</small></span><span class="encounter-step-arrow" aria-hidden="true">›</span></button>`).join('')}</nav><details class="encounter-status-note"><summary>How encounter status is tracked</summary><p>List reviews are longitudinal chart records, not encounter sign-offs. Saved vitals do not establish rooming completion. Signing closes the appointment; orders, results and billing retain their own status. Administrative checkout records patient handoff separately. Follow-up tasks and payment balances stay open until their own completion is recorded.</p></details></section>`;
}
function refreshEncounterProgress(){if(workspace&&$('encounter-progress'))$('encounter-progress').innerHTML=encounterWorkflow();}
function openEncounterStep(step){
 if(step==='checkout'){showChartSection('checkout');if(!activeVisit){showChartSection('visits');notice('Open an encounter to review checkout.');return;}$('visit-checkout').scrollIntoView({block:'start'});return;}
 if(step==='clinical'){showChartSection('clinical');$('clinical-lists').scrollIntoView({block:'start'});return;}
 if(['orders','new-order'].includes(step)){
  showChartSection('orders');
  if(step==='new-order'&&activeVisit&&canDocument()){editLabOrder();$('lab-order-form').elements.visit_id.value=activeVisit.id;}
  $('lab-workspace').scrollIntoView({block:'start'});return;
 }
 if(['billing','new-account'].includes(step)){
  showChartSection('billing');
  if(step==='new-account'&&activeVisit&&billingWrite()){accountEditor();$('billing-account-form').elements.visit_id.value=activeVisit.id;const a=workspace.appointments.find(a=>a.id===activeVisit.appointment_id);if(a)$('billing-account-form').elements.service_date.value=localTime(a.starts_at).slice(0,10);}
  $('billing-workspace').scrollIntoView({block:'start'});return;
 }
 showChartSection('visits');
 if(activeVisit){const form=$(step==='rooming'?'visit-rooming':step==='diagnoses'?'visit-diagnoses':step==='vitals'?'vitals-form':'note-form');form.scrollIntoView({block:'start'});const field=form.querySelector('input:not(:disabled),textarea');if(field)field.focus({preventScroll:true});}
 else $('appointments-panel').scrollIntoView({block:'start'});
}
function encounterDateLabel(v){
 const timestamp=workspace.appointments.find(a=>a.id===v.appointment_id)?.starts_at||v.signed_at||v.created_at;
 return timestamp?date(timestamp):'Encounter date not recorded';
}
function chartOverview(){
 const items=workspace.clinical.items,active=e=>e.content.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification),problems=items.filter(e=>e.kind==='problem'&&active(e)),meds=items.filter(e=>e.kind==='medication'&&active(e));
 const critical=r=>r.content.observations.some(o=>['critical','critical_high','critical_low'].includes(o.flag));
 const reports=workspace.labs.reports.filter(r=>['preliminary','final','corrected'].includes(r.status)&&!workspace.labs.acknowledgments.some(a=>a.report_id===r.id&&a.version===r.version)).sort((a,b)=>Number(critical(b))-Number(critical(a)));
 const recordedVisit=activeVisit?.vitals?activeVisit:workspace.visits.find(v=>v.vitals),vitals=recordedVisit?.vitals;
 const observations=vitals?[['Blood pressure',`${vitals.systolic_mm_hg}/${vitals.diastolic_mm_hg}`,'mmHg'],['Pulse',vitals.heart_rate_bpm,'bpm'],['Temperature',vitals.temperature_c,'°C'],['Oxygen saturation',vitals.oxygen_saturation_pct,'%'],['Weight',vitals.weight_kg,'kg'],['Height',vitals.height_cm,'cm']]:[];
 const row=(title,detail)=>`<div class="chart-data-row"><strong>${esc(title)}</strong><small>${esc(detail)}</small></div>`;
 const problemRows=problems.slice(0,6).map(e=>row(e.content.title,`${e.content.verification.replaceAll('_',' ')}${e.content.onset_date?' · Onset '+e.content.onset_date:''}`)).join('');
 const medRows=meds.slice(0,6).map(e=>row(e.content.title,[e.content.detail?.dose,e.content.detail?.route,e.content.detail?.frequency].filter(Boolean).join(' · ')||'Dosing not recorded')).join('');
 return `<section id="chart-overview" class="chart-overview-workbench"><div class="chart-primary-column"><section class="panel chart-summary-section"><div class="section-head"><h2>Clinical summary</h2><button type="button" class="text-button" data-chart-section="clinical">Manage clinical lists →</button></div><div class="clinical-summary-columns"><section><h3>Active problems <span class="pill">${problems.length}</span></h3>${problemRows||'<div class="chart-empty-row">No active problems recorded.<small>Review the clinical list to confirm status.</small></div>'}${problems.length>6?'<button type="button" class="text-button" data-chart-section="clinical">View all recorded problems</button>':''}</section><section><h3>Medication statements <span class="pill">${meds.length}</span></h3>${medRows||'<div class="chart-empty-row">No active medications recorded.<small>Review the medication list to confirm status.</small></div>'}${meds.length>6?'<button type="button" class="text-button" data-chart-section="clinical">View all recorded medications</button>':''}</section></div></section><section class="panel chart-summary-section"><div class="section-head"><h2>Results awaiting review <span class="pill">${reports.length}</span></h2><button type="button" class="text-button" data-chart-section="orders">Orders & results →</button></div>${reports.length?`<table class="chart-results-table"><thead><tr><th>Report / laboratory</th><th>Status</th><th>Reported</th></tr></thead><tbody>${reports.slice(0,5).map(r=>`<tr><td><strong>${esc(r.content.accession)}</strong><small>${esc(r.content.performing_lab||'Laboratory not recorded')}</small></td><td>${critical(r)?'<span class="critical-label">Critical</span>':esc(r.status)}<small>Revision ${r.version}</small></td><td>${esc(date(r.content.reported_at))}</td></tr>`).join('')}</tbody></table>`:'<div class="chart-empty-row">No unacknowledged report revisions returned.<small>Orders and follow-up retain independent statuses.</small></div>'}<div class="chart-summary-footer">${workspace.labs.orders.length} recorded orders · ${reports.length} revisions awaiting acknowledgment</div></section></div><aside class="chart-secondary-column"><section class="panel chart-summary-section"><div class="section-head"><h2>Recorded vitals</h2><button type="button" class="text-button" data-encounter-step="vitals">Open →</button></div>${observations.length?`<dl class="chart-vital-list">${observations.map(([label,value,unit])=>`<div><dt>${label}</dt><dd>${esc(value)} <small>${unit}</small></dd></div>`).join('')}</dl><p class="chart-summary-footer">${recordedVisit.id===activeVisit?.id?'Selected encounter':'Most recent encounter with saved vitals'} · ${esc(encounterDateLabel(recordedVisit))}</p>`:'<div class="chart-empty-row">No saved vitals found.<small>Open an encounter to record observations.</small></div>'}</section><section class="panel chart-summary-section"><div class="section-head"><h2>Encounter history</h2><button type="button" class="text-button" data-chart-section="visits">View all →</button></div>${workspace.visits.slice(0,4).map(v=>`<div class="chart-history-row"><div><strong>${v.status==='signed'?'Signed encounter':'In progress'}</strong><small>${esc(encounterDateLabel(v))}</small></div><button type="button" class="quiet" data-visit="${esc(v.id)}">Open</button></div>`).join('')||'<div class="chart-empty-row">No native encounters recorded.</div>'}<p class="chart-summary-footer">${workspace.visits.length} encounters loaded${workspace.visits.length>=100?' · latest 100 shown':''}</p></section></aside></section>`;
}
function applyChartSection(){
 const groups={overview:['chart-overview'],profile:['patient-identity-panel','patient-demographics'],clinical:['clinical-lists'],prescribing:['prescribing-panel'],history:['health-history-panel'],documents:['documents-panel'],referrals:['referrals-panel'],orders:['lab-workspace'],visits:['appointments-panel','visits-panel','visit-editor'],billing:['billing-workspace'],checkout:['visit-checkout'],source:['source-history']};
 for(const [key,ids] of Object.entries(groups))for(const id of ids)if($(id))$(id).hidden=key!==chartSection;
 document.querySelectorAll('.chart-tabs button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.chartSection===chartSection)));
}
function showChartSection(key){
 if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
 if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
 if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
 if(typeof captureDocumentDraft==='function')captureDocumentDraft();
 if(typeof captureReferralDraft==='function')captureReferralDraft();
 if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft();
 if(!['overview','profile','clinical','prescribing','history','documents','referrals','orders','visits','checkout','billing','source'].includes(key))return;
 chartSection=key;applyChartSection();
}
const formData=f=>Object.fromEntries(new FormData(f));
function closeNavigation() {const wasOpen=$('sidebar').classList.contains('menu-open');$('sidebar').classList.remove('menu-open');$('nav-toggle').setAttribute('aria-expanded','false');$('nav-toggle').setAttribute('aria-label','Open navigation');if(wasOpen)$('page-title').focus({preventScroll:true});}
function setPage(title) {if(!title.startsWith('Patient portal')&&typeof leavePortalStaffWorkspace==='function')leavePortalStaffWorkspace();$('page-title').textContent=title;$('page-description').textContent=({'Practice home':'Daily schedule and clinical work needing attention','Practice overview':'Daily schedule and clinical work needing attention','Practice administration':'Staff access, providers, facilities and rooms','Patients & visits':'Patient records and encounter documentation','Schedule':'Appointments and provider availability','Appointment reminders':'Due reminders, contact readiness and delivery history','Reminder settings':'Encrypted appointment email sender configuration','Labs & results':'Clinical review queue','Billing & insurance':'Local billing worklist and insurance administration','Clearinghouse':'837P files, external delivery and acknowledgments','Claims & remittances':'Claim preparation and payer remittance review','Payment settings':'Stripe and SunCharts Payments account configuration','Payment review':'Verified checkout status and payment history','Referral delivery settings':'Receiving partners and delivery credentials','Referrals':'Referral handoffs, follow-up dates and recorded outcomes','Follow-up tasks':'Assigned work, due dates and completion history','Connected apps':'Authorized applications and access','Connect services':'Managed reminders and SunCharts support','Support tickets':'SunCharts service requests and conversation history','Data import':'Source records and import reconciliation'})[title]||'Practice workspace';const active=['Practice home','Practice overview'].includes(title)?'nav-practice':title==='Patients & visits'?'nav-clinical':['Schedule','Appointment reminders','Reminder settings'].includes(title)?'nav-schedule':title==='Labs & results'?'nav-labs':['Billing & insurance','Payment settings','Payment review'].includes(title)?'nav-billing':title==='Clearinghouse'?'nav-edi':title==='Claims & remittances'?'nav-claims':['Referrals','Referral delivery settings'].includes(title)?'nav-referrals':title.startsWith('Patient portal')?'nav-portal':title==='Follow-up tasks'?'nav-followup':['Connected apps','Connect services','Support tickets'].includes(title)?'nav-apps':title==='Data import'?'nav-migration':title==='Practice administration'?'nav-admin':null;for(const id of ['nav-practice','nav-clinical','nav-schedule','nav-labs','nav-referrals','nav-followup','nav-portal','nav-billing','nav-claims','nav-edi','nav-apps','nav-migration','nav-admin']){if(!$(id))continue;if(id===active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}closeNavigation();window.scrollTo(0,0);}
function showTool(title) {if(typeof captureSupportDrafts==='function')captureSupportDrafts();setPage(title);$('clinical-workspace').hidden=true;$('patient-form').hidden=true;$('tools').hidden=false;$('new-patient').hidden=true;$('toggle-directory').hidden=true;}
async function showClinical() {captureVisitDrafts();const page=await api('/api/v1/patients');setPage('Patients & visits');patients=page.items;cursor=page.next_cursor;renderPatients();$('tools').replaceChildren();$('tools').hidden=true;$('clinical-workspace').hidden=false;$('new-patient').hidden=!canRegisterPatient();$('toggle-directory').hidden=false;}
const scopeNames={'clinical.read':'Read clinical records','clinical.write':'Update records using your clinical permissions','billing.read':'Read insurance and billing records','billing.write':'Update insurance and local billing records','events.read':'Receive record-change notices','migration.manage':'Stage and import EHR exports','offline_access':'Stay connected while you are away'};
async function showConsent() {
  const id=new URLSearchParams(location.search).get('oauth_request');
  if(!/^[0-9a-f-]{36}$/i.test(id||''))throw new Error('This connection request is invalid. Start again from SunCharts.');
  const request=await api(`/oauth/requests/${id}`);showTool('Authorize connection');
  $('tools').innerHTML=`<p class="eyebrow">CONNECT YOUR CLINICAL TOOLS</p><h2>Allow ${esc(request.name)} to connect?</h2><p>This grants access using your account on this SunCharts EHR installation.</p>${request.redirect_uri==='https://my.suncharts.app/oauth/ehr/callback'?'<p>Connect your SunCharts workspace with access to clinical records, billing, imports and change notices allowed by your account role.</p>':`<ul>${request.scope.split(' ').map(s=>`<li>${esc(scopeNames[s]||s)}</li>`).join('')}</ul>`}<p>You can revoke access at any time in Connected apps.</p><p class="muted">Return address: ${esc(new URL(request.redirect_uri).origin)}</p><div class="actions"><button class="primary" data-consent="allow" data-request="${esc(id)}">Allow connection</button><button data-consent="deny" data-request="${esc(id)}">Decline</button></div>`;
}
async function showApps() {
  const connection=typeof refreshConnectionBadge==='function'?await refreshConnectionBadge():null;
  const onboarding=me.role==='owner'?await api('/api/v1/connect/onboarding'):null;
  const grants=await api('/api/v1/oauth/grants');const clients=me.role==='owner'?await api('/api/v1/oauth/clients'):{items:[]};showTool('Connected apps');
  $('tools').innerHTML=`<p class="eyebrow">YOUR INTEGRATIONS</p><h2>Connected apps</h2>${typeof connectStatusCard==='function'?connectStatusCard(connection):''}${me.role==='owner'?connectOnboardingCard(onboarding,connection):''}<p>Each person authorizes their own account. Revoking access also stops its live change feed.</p>${grants.items.map(g=>`<div class="timeline-row"><div><p><b>${esc(g.name)}</b></p><small>${g.revoked_at?'Access revoked':g.name==='SunCharts'?'SunCharts installation connection':esc(g.scope.split(' ').map(s=>scopeNames[s]||s).join(' · '))}</small></div>${g.revoked_at?'':`<button data-revoke="${esc(g.id)}">Revoke access</button>`}</div>`).join('')||'<p class="muted">No connected apps yet.</p>'}
  <section class="billing-section"><div class="section-head"><div><h3>SunCharts Connect services</h3><p>Managed appointment email and support tickets for connected practices.</p></div><button type="button" data-connect-services>Open Connect services</button></div><p class="muted">Prefer your own branding? Configure your practice’s Resend account in Reminder settings. The self-hosted EHR works independently.</p></section>${me.role==='owner'?`<h3>Registered applications</h3>${clients.items.map(c=>`<p>${esc(c.name)} <small class="muted">${esc(new URL(c.redirect_uri).origin)}</small> ${c.disabled?'Disabled':`<button type="button" data-disable-client="${esc(c.id)}">Disable application</button>`}</p>`).join('')}` :''}`;
}
async function showMigrations() {
  const jobs=await api('/api/v1/migrations');showTool('Data import');
  $('tools').innerHTML=`<p class="eyebrow">BRING YOUR RECORDS WITH YOU</p><h2>Data import</h2><p>Upload a SunCharts data export package. Records are staged and reconciled before import; importing does not switch your active clinical system.</p><form id="migration-form"><label>Export package<input name="package" type="file" accept="application/json,.json" required></label><div class="actions"><button class="primary" type="submit">Stage & reconcile export</button></div></form><h3>Migration snapshots</h3>${jobs.items.map(j=>`<div class="migration-job"><h3>${esc(j.source_instance)}</h3><span class="pill">${esc(j.status)}</span><p>${esc(j.manifest.source_revision)}</p><p class="muted">${Object.entries(j.manifest.expected_counts).map(([k,n])=>`${n} ${esc(k.replaceAll('_',' '))}`).join(' · ')}</p>${j.report?.errors?.length?`<p class="error">${j.report.errors.length} issue(s): ${j.report.errors.slice(0,8).map(e=>esc(e.error.replaceAll('_',' '))).join('; ')}</p>`:''}${j.manifest.limitations?.length?`<p class="muted">Export limitations: ${j.manifest.limitations.map(esc).join('; ')}</p>`:''}<div class="actions">${j.status==='collecting'?`<button data-reconcile="${esc(j.id)}">Reconcile snapshot</button>`:''}${j.status==='reconciled'?`<button class="primary" data-commit="${esc(j.id)}" data-digest="${esc(j.digest)}">Import reconciled records</button>`:''}</div><p class="muted">Historical records retain their source. Clinical cutover requires further validation.</p></div>`).join('')||'<p class="muted">No snapshots staged yet.</p>'}`;
}
async function uploadMigration(form) {
  const file=form.elements.package.files[0];if(!file||file.size>8*1024*1024)throw new Error('Choose an export package of up to 8 MB. Larger imports need the batch API.');
  const pkg=JSON.parse(await file.text());if(!pkg.manifest||!Array.isArray(pkg.items))throw new Error('The export must contain a manifest and items.');
  const job=await api('/api/v1/migrations','POST',pkg.manifest);
  // Keep batches below the API body limit, including large historical notes.
  let batch=[];for(const item of pkg.items){const next=[...batch,item];if(new TextEncoder().encode(JSON.stringify({items:next})).length>60000||next.length>50){if(!batch.length)throw new Error('A source record exceeds the batch limit. The job remains staged for review.');await api(`/api/v1/migrations/${job.id}/items`,'POST',{items:batch});batch=[item];}else{batch=next;}}
  if(batch.length)await api(`/api/v1/migrations/${job.id}/items`,'POST',{items:batch});
  const report=await api(`/api/v1/migrations/${job.id}/reconcile`,'POST');await showMigrations();notice(report.ready_to_import?'Export staged and reconciled. Review its limitations before importing.':'Export staged with unresolved issues.',!report.ready_to_import);
}
function rememberVisit(v,savedKind) {
 const previous=activeVisit;
 if(savedKind){
  const draft=visitDrafts.get(v.id);if(draft){delete draft[savedKind];for(const kind of ['note','vitals'])if(draft[kind]?.version===previous.version)draft[kind].version=v.version;if(!draft.note&&!draft.vitals)visitDrafts.delete(v.id);}
  for(const kind of ['note','vitals']){const form=$(kind+'-form');if(form?.dataset?.visitId===v.id&&Number(form.dataset.version)===previous.version)form.dataset.version=String(v.version);}
 }
 activeVisit=v; workspace.visits=workspace.visits.map(old=>old.id===v.id?v:old); if(savedKind)captureVisitDrafts(false);updateDraftStatus();refreshEncounterProgress();if(savedKind&&savedKind!=='rooming'&&typeof renderRooming==='function')void renderRooming();if(savedKind&&savedKind!=='diagnoses'&&typeof renderVisitDiagnoses==='function')void renderVisitDiagnoses();
}
document.addEventListener('submit',e=>{
  const form=e.target; if(!['login-form','patient-form','note-form','vitals-form','amendment-form','migration-form'].includes(form.id))return;
  e.preventDefault();run(async()=>{
    const data=formData(form);
    if(form.id==='login-form'){await api('/auth/login','POST',data);form.reset();await enter();return;}
    if(form.id==='migration-form'){await uploadMigration(form);return;}
    if(form.id==='patient-form'){const p=await api('/api/v1/patients','POST',data);patients.unshift(p);form.reset();form.hidden=true;await selectPatient(p.id);notice('Patient registered.');return;}
    if(form.id==='vitals-form'){Object.keys(data).forEach(k=>{data[k]=Number(data[k]);});rememberVisit(await api(`/api/v1/visits/${activeVisit.id}/vitals`,'PUT',data,Number(form.dataset.version)),'vitals');notice('Vitals saved.');return;}
    if(form.id==='note-form'){rememberVisit(await api(`/api/v1/visits/${activeVisit.id}/note`,'PUT',data,Number(form.dataset.version)),'note');notice('Note saved.');return;}
    if(form.id==='amendment-form'){const v=await api(`/api/v1/visits/${activeVisit.id}/amendments`,'POST',data,activeVisit.version);await selectPatient(selected,v.id);notice('Amendment signed and appended.');}
  });
});
document.addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button||(button.type==='submit' && button.form))return;
  if(button.id==='toggle-directory'){const collapsed=$('clinical-workspace').classList.toggle('directory-collapsed');button.setAttribute('aria-expanded',String(!collapsed));button.title=collapsed?'Show patient directory':'Hide patient directory';return;}
  if(button.dataset.chartSection){showChartSection(button.dataset.chartSection);return;}
  if(button.dataset.encounterStep){openEncounterStep(button.dataset.encounterStep);return;}
  if(button.id==='nav-toggle'){const open=$('sidebar').classList.toggle('menu-open');button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',open?'Close navigation':'Open navigation');return;}
  if(button.closest('#edi-tool')||button.dataset.ediClaim)return;
  if(button.closest('#claims-tool')||button.dataset.newClaim||button.dataset.mapClaim)return;
  if(button.closest('#billing-workspace')||button.closest('#billing-tool')||button.dataset.mapBilling)return;
  if(button.closest('#schedule-workspace')||button.dataset.mapAppointment)return;
  if(button.closest('#patient-demographics'))return;
  if(button.closest('#clinical-lists')||button.closest('#lab-workspace')||button.dataset.mapLab||button.dataset.openLabPatient||button.dataset.mapClinical)return;
  if(button.id==='new-patient'){ if(!canRegisterPatient())return; $('patient-form').hidden=false;$('patient-form').elements.mrn.focus();return; }
  if(button.id==='cancel-patient'){ $('patient-form').hidden=true;return; }
  run(async()=>{
    if(button.id==='nav-schedule'||button.hasAttribute('data-open-schedule')){await showSchedule();return;}
    if(button.id==='nav-referrals'){await showReferralWorkspace();return;}
    if(button.id==='nav-portal'){await showPortalInbox();return;}
    if(button.id==='nav-followup'){await showFollowupWorkspace();return;}
    if(button.id==='nav-labs'){await showLabInbox();return;}
    if(button.id==='nav-edi'){await showEdiWorkspace();return;}
    if(button.id==='nav-claims'){await showClaimsWorkspace();return;}
    if(button.id==='nav-billing'){await showBillingQueue();return;}
    if(button.id==='nav-admin'){await showPracticeAdmin();return;}
    if(button.id==='nav-apps'){await showApps();return;}
    if(button.id==='nav-migration'){await showMigrations();return;}
    if(button.id==='nav-clinical'){await showClinical();return;}
    if(button.dataset.consent){const d=await api(`/oauth/requests/${button.dataset.request}/decision`,'POST',{approved:button.dataset.consent==='allow'});location.assign(d.redirect_uri);return;}
    if(button.dataset.disableClient){await api(`/api/v1/oauth/clients/${button.dataset.disableClient}/disable`,'POST');await showApps();notice('Application disabled and its grants revoked.');return;}
    if(button.dataset.revoke){await api(`/api/v1/oauth/grants/${button.dataset.revoke}/revoke`,'POST');await showApps();notice('Connection access revoked.');return;}
    if(button.dataset.reconcile){const report=await api(`/api/v1/migrations/${button.dataset.reconcile}/reconcile`,'POST');await showMigrations();notice(report.ready_to_import?'Snapshot reconciled. Review the import before proceeding.':'Snapshot has unresolved counts or mappings.',!report.ready_to_import);return;}
    if(button.dataset.commit){if(!window.confirm('Import the reconciled snapshot? Original clinical records will be preserved as history. This does not switch your active EHR.'))return;await api(`/api/v1/migrations/${button.dataset.commit}/commit`,'POST',{digest:button.dataset.digest});await showMigrations();notice('Import completed. Clinical cutover remains separate.');return;}
    if(button.id==='logout'){await api('/auth/logout','POST');signInScreen();return;}
    if(button.id==='load-more'){const page=await api(`/api/v1/patients?after=${encodeURIComponent(cursor)}`);patients.push(...page.items);cursor=page.next_cursor;renderPatients();return;}
    if(button.dataset.patient){await selectPatient(button.dataset.patient);return;}
    if(button.dataset.checkIn){await api(`/api/v1/appointments/${button.dataset.checkIn}/check-in`,'POST');await selectPatient(selected);notice('Patient checked in.');return;}
    if(button.dataset.start){const v=await api('/api/v1/visits','POST',{appointment_id:button.dataset.start});await selectPatient(selected,v.id);return;}
    if(button.dataset.visit){const v=await api(`/api/v1/visits/${button.dataset.visit}`);captureVisitDrafts();rememberVisit(v);chartSection='visits';renderChart();return;}
    if(button.dataset.action==='reload'){await selectPatient(selected,activeVisit?.id);return;}
    if(button.dataset.action==='discard-visit-draft'){if(!window.confirm('Discard unsaved note and vitals edits for this encounter and use the saved record?'))return;visitDrafts.delete(activeVisit.id);renderVisit();notice('Unsaved encounter edits discarded. The saved record is shown.');return;}
    if(button.dataset.action==='sign'){
      if(typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
      if(typeof visitDiagnosisDrafts!=='undefined'&&visitDiagnosisDrafts.get(activeVisit.id)?.patientId===selected)throw new Error('Save or discard your diagnosis edits before signing.');
      const visible=formData($('note-form'));
      if(!activeVisit.note || Object.keys(visible).some(k=>visible[k]!==activeVisit.note[k]))throw new Error('Save your current note before signing.');
      const entered=formData($('vitals-form'));
      if(Object.values(entered).some(x=>x!=='') && (!activeVisit.vitals || Object.keys(entered).some(k=>Number(entered[k])!==activeVisit.vitals[k])))throw new Error('Save your current vitals before signing.');
      if(!window.confirm('Sign this note and complete the visit? Corrections will be preserved as amendments.'))return;
      const v=await api(`/api/v1/visits/${activeVisit.id}/sign`,'POST',undefined,activeVisit.version);await selectPatient(selected,v.id);notice('Visit signed and completed.');
    }
  });
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('sidebar').classList.contains('menu-open')){closeNavigation();$('nav-toggle').focus();}});
$('search').addEventListener('input',renderPatients);
// Every workspace module is deferred; initialize after all of them are loaded.
document.addEventListener('DOMContentLoaded',()=>enter().catch(()=>signInScreen()),{once:true});

document.addEventListener('input',e=>{if(e.target.closest?.('#note-form,#vitals-form'))captureVisitDrafts();});
window.addEventListener('beforeunload',e=>{captureVisitDrafts();if((typeof prescribingHaveDrafts==='function'&&prescribingHaveDrafts())||(typeof portalStaffHasDrafts==='function'&&portalStaffHasDrafts())||(typeof supportHasDrafts==='function'&&supportHasDrafts())||(typeof patientIdentityHasDrafts==='function'&&patientIdentityHasDrafts())||(typeof referralDeliveryHasDrafts==='function'&&referralDeliveryHasDrafts())||(typeof documentsHaveDrafts==='function'&&documentsHaveDrafts())||(typeof referralHasDrafts==='function'&&referralHasDrafts())||(typeof orderDiagnosisLinkDrafts!=='undefined'&&orderDiagnosisLinkDrafts.size)||(typeof accountDiagnosisLinkDrafts!=='undefined'&&accountDiagnosisLinkDrafts.size)||(typeof healthHistoryHasDrafts==='function'&&healthHistoryHasDrafts())||visitDrafts.size||(typeof visitDiagnosisDrafts!=='undefined'&&visitDiagnosisDrafts.size)||(typeof roomingDrafts!=='undefined'&&roomingDrafts.size)||(typeof checkoutDrafts!=='undefined'&&checkoutDrafts.size)){e.preventDefault();e.returnValue='';}});
