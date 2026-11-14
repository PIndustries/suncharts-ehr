// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function organizeWorkspaceNavigation(){
 const navigation=$('workspace-navigation');if(!navigation||typeof document.createElement!=='function'||navigation.dataset.organized==='true')return;
 const items={home:$('nav-practice'),schedule:$('nav-schedule'),queue:$('nav-followup'),messages:$('nav-portal'),communications:$('nav-communications'),patients:$('nav-clinical'),clinical:$('nav-labs'),specialty:$('nav-specialty'),referrals:$('nav-referrals'),billing:$('nav-billing'),claims:$('nav-claims'),clearinghouse:$('nav-edi'),workflows:$('nav-workflows'),automation:$('nav-automation'),aiReview:$('nav-ai-review'),admin:$('nav-admin'),apps:$('nav-apps'),migration:$('nav-migration')};
 const labels={home:'Home',schedule:'Schedule',queue:'Work queue',messages:'Inbox',communications:'Communications',patients:'Patients',clinical:'Orders & results',specialty:'Specialty care',referrals:'Referrals',billing:'Patient billing',claims:'Insurance claims',clearinghouse:'Claim lifecycle',workflows:'Workflow Studio',automation:'Automation Center',aiReview:'Sun review',admin:'Practice administration',apps:'Integrations',migration:'Data import'};
 for(const [key,item] of Object.entries(items)){const label=item?.querySelector('span');if(label)label.textContent=labels[key];}
 const groups=[['Today',['home','schedule','queue','messages']],['Care',['patients','clinical','specialty','referrals']],['Revenue',['billing','claims','clearinghouse']],['Manage',['workflows','admin','apps']]];
 navigation.replaceChildren();
 for(const [label,keys] of groups){const group=document.createElement('div');group.className=`nav-group${label==='Care'?' nav-group-primary':''}`;group.setAttribute('role','group');const id=`nav-${label.toLowerCase()}-label`;group.setAttribute('aria-labelledby',id);const heading=document.createElement('p');heading.className='nav-group-label';heading.id=id;heading.textContent=label;group.append(heading,...keys.map(key=>items[key]).filter(Boolean));if(label==='Manage'){group.append(navigationMoreTools(items));const customize=document.createElement('button');customize.id='nav-customize';customize.className='nav-customize';customize.type='button';customize.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6"/></svg><span>Customize navigation</span>';group.append(customize);}navigation.append(group);}
 navigation.dataset.organized='true';
}
function navigationMoreTools(items){
 const details=document.createElement('details');details.className='nav-more';const summary=document.createElement('summary');summary.textContent='More tools';const body=document.createElement('div');body.append(...['automation','aiReview','migration'].map(key=>items[key]).filter(Boolean));details.append(summary,body);return details;
}

// Only an opaque navigation ID may cross the explicit same-tab Connect sign-in.
// Never store payment status, patient identifiers/content, or handoff credentials.
function rememberHostedCopaySignInReturn(){
 const id=new URLSearchParams(location.search).get('copay_checkout');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.copay-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takeHostedCopaySignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.copay-return');sessionStorage.removeItem('suncharts.copay-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearHostedCopaySignInReturn(){
 try{sessionStorage.removeItem('suncharts.copay-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('copay_checkout'))return;query.delete('copay_checkout');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

function rememberPatientPaymentSetupSignInReturn(){
 const id=new URLSearchParams(location.search).get('payment_setup');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.payment-setup-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takePatientPaymentSetupSignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.payment-setup-return');sessionStorage.removeItem('suncharts.payment-setup-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearPatientPaymentSetupSignInReturn(){
 try{sessionStorage.removeItem('suncharts.payment-setup-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('payment_setup'))return;query.delete('payment_setup');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

function rememberPatientMembershipSignInReturn(){
 const id=new URLSearchParams(location.search).get('payment_membership');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.membership-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takePatientMembershipSignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.membership-return');sessionStorage.removeItem('suncharts.membership-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearPatientMembershipSignInReturn(){
 try{sessionStorage.removeItem('suncharts.membership-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('payment_membership'))return;query.delete('payment_membership');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

function rememberInvoiceCheckoutSignInReturn(){
 const id=new URLSearchParams(location.search).get('invoice_checkout');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))return;
 try{sessionStorage.setItem('suncharts.invoice-checkout-return',JSON.stringify({id,expires:Date.now()+600000}));}catch{}
}
function takeInvoiceCheckoutSignInReturn(){
 try{
  const raw=sessionStorage.getItem('suncharts.invoice-checkout-return');sessionStorage.removeItem('suncharts.invoice-checkout-return');const value=JSON.parse(raw||'null');
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id||'')&&Number.isFinite(value.expires)&&value.expires>Date.now()&&value.expires<=Date.now()+600000?value.id:null;
 }catch{return null;}
}
function clearInvoiceCheckoutSignInReturn(){
 try{sessionStorage.removeItem('suncharts.invoice-checkout-return');}catch{}
 const query=new URLSearchParams(location.search);if(!query.has('invoice_checkout'))return;query.delete('invoice_checkout');
 history.replaceState(history.state,'',location.pathname+(query.size?'?'+query.toString():'')+location.hash);
}

// Connect delivers delegated support codes in the fragment so they never reach an HTTP log.
// Remove it before making any request, then exchange through this EHR's same-origin server.
async function acceptConnectLaunch(){
 const support=location.pathname==='/api/v1/connect/support/accept';
 // Current Connect launches onto the public shell so older EHR servers do not
 // reject the browser's initial GET before JavaScript can consume the fragment.
 // The legacy acceptance path remains supported for existing launch links.
 const identity=location.pathname==='/api/v1/connect/identity/accept'||location.pathname==='/';
 // A screen address (#/claims, #/patients/…) is not a Connect launch; leave it for navigation.
 if((!support&&!identity)||!location.hash||location.hash.startsWith('#/'))return false;
 let code,issuer;
 try{
  const input=new URLSearchParams(location.hash.slice(1));
  code=input.get('code');issuer=input.get('issuer');
  const requested=input.get('next');
  const next=requested==='claimmd'?'claimmd':requested==='care-pathways'?'workflow-studio':null;
  const returnQuery=new URLSearchParams();
  if(next)returnQuery.set('open',next);
  const savedCopayReturn=takeHostedCopaySignInReturn();
  const copayReturn=new URLSearchParams(location.search).get('copay_checkout')??savedCopayReturn;
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(copayReturn||''))returnQuery.set('copay_checkout',copayReturn);
  const savedSetupReturn=takePatientPaymentSetupSignInReturn();
  const setupReturn=new URLSearchParams(location.search).get('payment_setup')??savedSetupReturn;
  if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupReturn||''))returnQuery.set('payment_setup',setupReturn);
  for(const [key,saved] of [['payment_membership',takePatientMembershipSignInReturn()],['invoice_checkout',takeInvoiceCheckoutSignInReturn()]]){const id=new URLSearchParams(location.search).get(key)??saved;if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))returnQuery.set(key,id);}
  history.replaceState(null,'',returnQuery.size?'/?'+returnQuery.toString():'/');
  let issuerUrl;
  try{issuerUrl=new URL(issuer);}catch{throw new Error('This support sign-in link is invalid or incomplete.');}
  const loopback=issuerUrl.protocol==='http:'&&['127.0.0.1','::1'].includes(issuerUrl.hostname);
  if(!code||code.length<32||code.length>256||issuerUrl.origin!==issuer||(!loopback&&issuerUrl.protocol!=='https:'))throw new Error('This support sign-in link is invalid or incomplete.');
  const response=await fetch(support?'/api/v1/connect/support/accept':'/api/v1/connect/identity/accept',{method:'POST',headers:{'Content-Type':'application/json','X-SunCharts-Identity-Handoff':'1'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({code,issuer})});
  if(!response.ok)throw new Error('This Connect sign-in link expired, was already used, or was revoked.');
  const accepted=await response.json().catch(()=>({}));
  if(accepted.kind==='patient'){location.replace('/patient-portal');return new Promise(()=>{});}
  return true;
 }finally{code=undefined;issuer=undefined;}
}
const connectLaunchAcceptance=acceptConnectLaunch();
let chartSection='overview',encounterSection='documentation',patientDirectoryPreference=storedPatientDirectoryPreference();
// The patient list stays out of the way of an open chart unless this device asked to keep it.
function storedPatientDirectoryPreference(){try{return localStorage.getItem('suncharts.patientDirectory.besideChart')==='shown';}catch{return false;}}
function rememberPatientDirectoryPreference(visible){patientDirectoryPreference=Boolean(visible);try{localStorage.setItem('suncharts.patientDirectory.besideChart',visible?'shown':'hidden');}catch{}}
let patientWorkspaceGeneration=0;
function setPatientDirectoryVisible(visible){
 $('clinical-workspace')?.classList.toggle('directory-collapsed',!visible);
 const button=$('toggle-directory');if(!button)return;
 button.textContent=visible?'Hide patients':'Show patients';
 button.setAttribute('aria-expanded',String(Boolean(visible)));
 button.title=visible?'Hide patient directory':'Show patient directory';
 button.setAttribute('aria-label',button.title);
}
function patientDirectoryLanding(){
 return '<section class="panel empty patient-directory-landing"><h2>Patient directory</h2><p>Choose a patient from the list, or search by name or MRN.</p></section>';
}
// Unsaved clinical edits live only in this tab, isolated by encounter and patient.
const visitDrafts=new Map();
// Note text sections in display order. Procedure is optional; the first four are required.
const noteSectionKeys=['subjective','objective','assessment','plan','procedure'];
const noteProcedureHint='Procedure performed, site, medication and dose, lot number, guidance, tolerance, complications';
// The earlier note a draft was started from, as stable text so the form, the retained draft and the saved note compare equal.
function noteSourceText(value){
 let source=value;
 if(typeof source==='string'){if(!source)return '';try{source=JSON.parse(source);}catch{return '';}}
 if(!source?.visit_id)return '';
 return JSON.stringify({visit_id:String(source.visit_id),version:Number(source.version),sections:noteSectionKeys.filter(key=>(source.sections||[]).includes(key))});
}
function noteFieldText(key,value){return key==='started_from'?noteSourceText(value):key==='procedure'&&!String(value??'').trim()?'':String(value??'');}
function noteMatchesSaved(values,saved){return Boolean(saved)&&[...noteSectionKeys,'started_from'].every(key=>noteFieldText(key,values[key])===noteFieldText(key,saved[key]));}
// The saved note as one comparable text: its sections and where it was started from, not who saved it.
function noteSavedText(note){return JSON.stringify([...noteSectionKeys,'started_from'].map(key=>noteFieldText(key,note?.[key])));}
function noteSaverName(note){const by=note?.saved_by;return by?by.name||(by.support?'Support staff':'a staff member'):'';}
// Who may write, sign and correct a visit note. The server enforces the same rule.
function clinicalAccess(action){return typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical',action);}
function canDraftNote(v){return v?.status==='in_progress'&&['owner','clinician','nurse','medical_assistant'].includes(me?.role)&&clinicalAccess('edit');}
function canSignNote(){return ['owner','clinician'].includes(me?.role)&&!me?.delegated&&clinicalAccess('edit');}
function canAmendNote(v){return v?.status==='signed'&&['owner','clinician'].includes(me?.role)&&!me?.delegated&&clinicalAccess('create');}
function noteRequestBody(values){
 const body=Object.fromEntries(noteSectionKeys.slice(0,4).map(key=>[key,values[key]])),source=noteSourceText(values.started_from);
 if(String(values.procedure??'').trim())body.procedure=values.procedure;
 if(source)body.started_from=JSON.parse(source);
 return body;
}
function noteDay(value){const day=new Date(value);return Number.isNaN(day.getTime())?'':day.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});}
// The visit date comes from the saved note when it names the same earlier visit, otherwise from what is already loaded.
function noteSourceDay(source,saved){
 const known=typeof visitNoteSourceDate==='function'?visitNoteSourceDate(source.visit_id):null,row=workspace?.visits?.find(visit=>visit.id===source.visit_id);
 const stamp=(saved?.visit_id===source.visit_id?saved.visit_date:null)||known||(row?workspace.appointments?.find(a=>a.id===row.appointment_id)?.starts_at||row.signed_at:null);
 return stamp?noteDay(stamp):'';
}
function noteSourceLine(text,signed,saved){
 if(!text)return '';
 const day=noteSourceDay(JSON.parse(text),saved),from=day?`the visit on ${day}`:'an earlier visit';
 return signed?`Started from ${from}.`:`Started from ${from}. Review every section before signing.`;
}
const visitAmendmentDrafts=new Map(),visitAmendmentContexts=new WeakMap();
let visitAmendmentOwner;
function clearVisitAmendmentDrafts(){visitAmendmentDrafts.clear();visitAmendmentOwner=me;}
function amendmentContextKey(context){return JSON.stringify([context.tenantId,context.patientId,context.visitId]);}
function currentAmendmentDraft(visit=activeVisit){
 if(visitAmendmentOwner!==me)clearVisitAmendmentDrafts();
 return visit?visitAmendmentDrafts.get(amendmentContextKey({tenantId:me?.tenant_id,patientId:selected,visitId:visit.id})):undefined;
}
function visitAmendmentsHaveDrafts(){if(visitAmendmentOwner!==me)clearVisitAmendmentDrafts();return visitAmendmentDrafts.size>0;}
function amendmentValues(form){const values=formData(form);return {reason:values.reason||'',text:values.text||''};}
function sameAmendmentValues(a,b){return a.reason===b.reason&&a.text===b.text;}
function captureVisitAmendmentDraft(){
 if(visitAmendmentOwner!==me)clearVisitAmendmentDrafts();
 const form=$('amendment-form'),context=form&&visitAmendmentContexts.get(form);
 if(!context||context.identity!==me||context.tenantId!==me?.tenant_id)return;
 const values=amendmentValues(form),key=amendmentContextKey(context);
 if(values.reason||values.text)visitAmendmentDrafts.set(key,{...context,values});else visitAmendmentDrafts.delete(key);
 updateVisitAmendmentStatus();
}
function currentAmendmentContext(form){
 const context=form&&visitAmendmentContexts.get(form);
 return context&&context.identity===me&&context.tenantId===me?.tenant_id&&context.patientId===selected&&context.visitId===activeVisit?.id&&canAmendNote(activeVisit)&&$('amendment-form')===form?context:null;
}
function updateVisitAmendmentStatus(){
 const form=$('amendment-form'),context=currentAmendmentContext(form),status=$('amendment-draft-status');if(!context||!status)return;
 const draft=visitAmendmentDrafts.get(amendmentContextKey(context)),stale=context.version!==activeVisit.version;
 status.textContent=stale?'The saved encounter changed. Review the signed note and amendment history, then confirm the current version before signing this correction.':draft?'Unsaved correction retained in this tab. Sign the amendment before closing or reloading.':'The original note stays unchanged. This correction will be signed and appended to its history.';
 const review=$('amendment-review-current');if(review){review.hidden=!stale;review.dataset.version=String(activeVisit.version);}
 const discard=$('amendment-discard');if(discard)discard.hidden=!draft;
 const submit=$('amendment-submit');if(submit)submit.disabled=stale;
}
function focusVisitAmendment(){
 const form=$('amendment-form');if(!currentAmendmentContext(form))return;
 setEncounterSection('documentation');form.scrollIntoView({block:'center'});form.elements.reason.focus();
}
function reviewVisitAmendmentVersion(button){
 const form=$('amendment-form'),context=currentAmendmentContext(form);
 if(!context||Number(button.dataset.version)!==activeVisit.version)return;
 captureVisitAmendmentDraft();context.version=activeVisit.version;form.dataset.version=String(context.version);
 const draft=visitAmendmentDrafts.get(amendmentContextKey(context));if(draft)draft.version=context.version;
 updateVisitAmendmentStatus();form.elements.text.focus();
}
async function discardVisitAmendmentDraft(){
 const form=$('amendment-form'),context=currentAmendmentContext(form);if(!context)return;
 captureVisitAmendmentDraft();const key=amendmentContextKey(context),draft=visitAmendmentDrafts.get(key);if(!draft)return;
 if(!await confirmAction('Only this unsaved correction will be removed. The signed note and recorded amendments stay unchanged.',{title:'Discard unsaved correction?',confirmLabel:'Discard correction',tone:'danger'}))return;
 if(!currentAmendmentContext(form)||context.identity!==me)return;
 if(!sameAmendmentValues(amendmentValues(form),draft.values))throw new Error('Your correction changed. Review it before discarding.');
 form.elements.reason.value='';form.elements.text.value='';visitAmendmentDrafts.delete(key);renderVisit(false);focusVisitAmendment();
}
async function submitVisitAmendment(form){
 const context=currentAmendmentContext(form);if(!context)throw new Error('Open the signed encounter before signing this correction.');
 if(context.version!==activeVisit.version)throw new Error('Review the changed encounter and confirm its current version before signing this correction.');
 captureVisitAmendmentDraft();
 const submitted=amendmentValues(form),key=amendmentContextKey(context),version=context.version;
 const visit=await api(`/api/v1/visits/${context.visitId}/amendments`,'POST',submitted,version);
 if(context.identity!==me||context.tenantId!==me?.tenant_id)return;
 if(visit.id!==context.visitId||visit.patient_id!==context.patientId)throw new Error('The saved amendment returned an unexpected encounter. Reload the original chart.');
 const visibleForm=$('amendment-form'),visibleContext=currentAmendmentContext(visibleForm),visible=visibleContext&&amendmentContextKey(visibleContext)===key;
 const retained=visitAmendmentDrafts.get(key),latest=visible?amendmentValues(visibleForm):retained?.values||submitted;
 if(sameAmendmentValues(latest,submitted)){
  visitAmendmentDrafts.delete(key);
  if(visible){visibleForm.elements.reason.value='';visibleForm.elements.text.value='';}
 }else{
  visitAmendmentDrafts.set(key,{...context,version:(retained?.version??version)===version?visit.version:retained.version,values:latest});
 }
 if(!visible)return;
 visibleContext.version=visitAmendmentDrafts.get(key)?.version??visit.version;visibleForm.dataset.version=String(visibleContext.version);
 await selectPatient(context.patientId,context.visitId);
 if(context.identity===me&&selected===context.patientId&&activeVisit?.id===context.visitId)notice('Amendment signed and appended. The original note is unchanged.');
}
function captureVisitDrafts(includeRooming=true){
 captureVisitAmendmentDraft();
 if(typeof captureClaimDraft==='function')captureClaimDraft();
 if(typeof captureBillingChargeDraft==='function')captureBillingChargeDraft();
 if(typeof capturePatientPaymentPlanDrafts==='function')capturePatientPaymentPlanDrafts();
 if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
 if(typeof capturePortalStaffDrafts==='function')capturePortalStaffDrafts();
 if(typeof captureSupportDrafts==='function')captureSupportDrafts();
 if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
 if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
 if(typeof captureDocumentDraft==='function')captureDocumentDraft();
 if(typeof captureReferralDraft==='function')captureReferralDraft();
 if(typeof captureOrderDiagnosisLinkDraft==='function')captureOrderDiagnosisLinkDraft();
 if(typeof captureAccountDiagnosisLinkDraft==='function')captureAccountDiagnosisLinkDraft();
 if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft(); if(typeof captureImmunizationDraft==='function')captureImmunizationDraft();
 if(includeRooming&&typeof captureRoomingDraft==='function')captureRoomingDraft();
 if(includeRooming&&typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
 if(typeof captureCheckoutDraft==='function')captureCheckoutDraft();
 if(!activeVisit||activeVisit.status==='signed')return;
 const key=activeVisit.id, draft=visitDrafts.get(key)||{patientId:selected};
 for(const kind of ['note','vitals']){
  const form=$(kind+'-form');if(!form||form.dataset?.visitId!==key)continue;
  const values=formData(form),saved=activeVisit[kind]||{};
  const changed=Object.entries(values).some(([k,v])=>kind==='vitals'?v===''?saved[k]!=null:Number(v)!==saved[k]:noteFieldText(k,v)!==noteFieldText(k,saved[k]));
  if(changed)draft[kind]={values,version:Number(form.dataset.version),...(kind==='note'?{base:draft.note?.base??noteSavedText(saved)}:{})};else delete draft[kind];
 }
 if(draft.note||draft.vitals)visitDrafts.set(key,draft);else visitDrafts.delete(key);
 updateDraftStatus();
}
// Saving vitals, intake or diagnoses moves the visit's shared version without touching the note text, so the note being written still applies to the current record.
function followUnchangedNote(){
 const draft=visitDrafts.get(activeVisit?.id),form=$('note-form');
 if(!draft?.note||draft.note.version===activeVisit.version||draft.note.base!==noteSavedText(activeVisit.note))return;
 draft.note.version=activeVisit.version;if(form?.dataset?.visitId===activeVisit.id)form.dataset.version=String(activeVisit.version);
}
function updateDraftStatus(){
 if(!activeVisit)return;
 followUnchangedNote();
 const draft=visitDrafts.get(activeVisit.id),status=$('visit-draft-status'),conflict=$('note-conflict'),copy=$('note-saved-copy');
 const parts=['note','vitals'].filter(k=>draft?.[k]),noteChanged=Boolean(draft?.note)&&draft.note.version!==activeVisit.version,by=activeVisit.note?.saved_by;
 const changed=noteChanged?`${noteSaverName(activeVisit.note)||'Someone else'} saved this note${by?.at?' on '+date(by.at):''} while you were writing. Nothing was overwritten. Your text is still here and has not been saved.`:'';
 // The choice sits with the note itself, where the person is writing.
 if(conflict&&conflict.isConnected!==false){conflict.hidden=!noteChanged;conflict.innerHTML=noteChanged?`<p>${esc(changed)}</p><div class="actions"><button type="button" data-action="show-saved-note" aria-controls="note-saved-copy">See the saved note</button><button type="button" data-action="keep-note-draft">Keep my text</button><button type="button" data-action="discard-visit-draft">Use the saved note</button></div>`:'';}
 if(copy&&copy.isConnected!==false&&!noteChanged){copy.hidden=true;copy.innerHTML='';}
 if(!status)return;
 status.textContent=parts.length?`Unsaved ${parts.join(' and ')} edits retained in this tab. Save before closing or reloading.`:'';
 if(noteChanged)status.textContent+=' '+changed;
 if(draft?.vitals&&draft.vitals.version!==activeVisit.version)status.textContent+=' The saved encounter changed. Your edits are preserved; compare with the current record before saving.';
 if(parts.length)status.innerHTML+=' <button type="button" class="text-button" data-action="discard-visit-draft">Discard unsaved edits and use saved record</button>';
}
// The saved note, read-only, beside the text still being written.
function showSavedNoteCopy(){
 const copy=$('note-saved-copy');if(!copy||!activeVisit)return;
 if(!copy.hidden){copy.hidden=true;copy.innerHTML='';return;}
 const note=activeVisit.note||{},by=note.saved_by;
 copy.innerHTML=`<h4>Saved note${by?.at?` · ${esc(noteSaverName(note))}, ${esc(date(by.at))}`:''}</h4>${noteSectionKeys.filter(key=>String(note[key]??'').trim()).map(key=>`<p class="muted">${key[0].toUpperCase()+key.slice(1)}</p><p class="note-text">${esc(note[key])}</p>`).join('')||'<p class="muted">The saved note is empty.</p>'}<p class="muted">Copy anything you need into your text, then choose Keep my text and save.</p>`;
 copy.hidden=false;
}
// An explicit choice: the text in this tab replaces the saved note on the next save.
function keepNoteDraft(){
 const draft=visitDrafts.get(activeVisit?.id),form=$('note-form');if(!draft?.note||form?.dataset?.visitId!==activeVisit.id)return;
 draft.note.version=activeVisit.version;draft.note.base=noteSavedText(activeVisit.note);form.dataset.version=String(activeVisit.version);updateDraftStatus();
 notice('Your text is kept. Save note to replace the saved note with it.');
}
// Saves the note. If the visit moved on, the current record is loaded first: a change that left the note text alone is retried once, a change to the note itself is shown and never overwritten.
 async function saveVisitNote(form,data){
 // A draft is kept with any section filled; a note with nothing in it says so beside the buttons.
 if(!hasVisitNoteText(form)){showVisitNoteMessage('Write something in the note before saving.');return;}
 hideVisitNoteMessage();
 const id=activeVisit.id,identity=me;
 for(let attempt=0;;attempt++){
  try{rememberVisit(await api(`/api/v1/visits/${id}/note`,'PUT',noteRequestBody(data),Number(form.dataset.version)),'note');break;}
  catch(error){
   if(error.status!==409||error.code!=='conflict'||me!==identity||activeVisit?.id!==id)throw error;
   const opened=activeVisit,current=await api(`/api/v1/visits/${id}`);
   if(me!==identity||activeVisit?.id!==id)return;
   if(current.status==='signed'){rememberVisit(current);throw new Error('This note was signed while you were writing, so your text was not saved. Copy anything you still need, then reload the patient.');}
   const held=visitDrafts.get(id)||{patientId:selected},base=held.note?.base??noteSavedText(opened.note);
   held.note={values:held.note?.values||data,version:held.note?.version??Number(form.dataset.version),base};visitDrafts.set(id,held);
   rememberVisit(current);
   if(attempt===0&&Number(form.dataset.version)===current.version)continue;
   throw new Error(`${noteSaverName(current.note)||'Someone else'} saved this note while you were writing. Nothing was overwritten and your text is still here.`);
  }
 }
 if(typeof visitNoteSaved==='function')visitNoteSaved(activeVisit);else notice('Note saved.');
}

let me, patients = [], cursor, selected, workspace, activeVisit, busy = false;
async function api(path, method = 'GET', body, version) {
  const requestIdentity = me;
  const headers = {};
  if(me?.tenant_id&&me?.user_id)headers['X-SunCharts-Staff-Context']=`${me.tenant_id}:${me.user_id}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (version !== undefined) headers['If-Match'] = `"${version}"`;
  let response;
  try { response = await fetch(path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials:'same-origin', cache:'no-store'}); }
  catch { throw new Error(method === 'GET' ? 'Connection interrupted. Please try loading again.' : 'Connection interrupted. This change may have saved. Reload the patient before trying again.'); }
  const data = await response.json().catch(() => ({}));
  if(me!==requestIdentity)throw new Error('Staff account changed. Sign in again to continue.');
  if(response.status===409&&data.message==='Staff account changed. Sign in again to continue.'){signInScreen();$('login-error').textContent=data.message;throw new Error(data.message);}
  if (response.status === 401) { signInScreen(); throw new Error('Please sign in to continue.'); }
  if (!response.ok) { const error=new Error(data.message || (response.status === 409 ? 'This visit changed. Reload it before saving.' : 'Unable to complete this action. Please check your entries.'));error.status=response.status;error.code=data.error;throw error; }
  // A save anywhere may change what the open chart's banner shows.
  if(method!=='GET'&&typeof patientBannerChanged==='function')patientBannerChanged();
  return data;
}
function signInScreen() {
  if(typeof clearClaimDrafts==='function')clearClaimDrafts();
  if(typeof clearBillingChargeDrafts==='function')clearBillingChargeDrafts();
  if(typeof clearWorkspaceAccessSession==='function')clearWorkspaceAccessSession();
  if(typeof clearStudioAccessSession==='function')clearStudioAccessSession();
  if(typeof clearStudioWorkspaceSession==='function')clearStudioWorkspaceSession();
  if(typeof clearSunSession==='function')clearSunSession();
  if(typeof clearCardReadersSession==='function')clearCardReadersSession();
 if(typeof clearTerminologySession==='function')clearTerminologySession();
  if(typeof clearSunEventsSession==='function')clearSunEventsSession();
  if(typeof clearPrescribingSession==='function')clearPrescribingSession();
  if(typeof clearPortalStaffSession==='function')clearPortalStaffSession();
  if(typeof clearConnectUpdatesSession==='function')clearConnectUpdatesSession();
  if(typeof clearSupportSession==='function')clearSupportSession();
  if(typeof clearConnectionStatusSession==='function')clearConnectionStatusSession();
  if(typeof clearPatientIdentitySession==='function')clearPatientIdentitySession();
  if(typeof clearPatientLifecycleSession==='function')clearPatientLifecycleSession();
  if(typeof clearPatientBannerSession==='function')clearPatientBannerSession();
  if(typeof clearReferralDeliverySession==='function')clearReferralDeliverySession();
  if(typeof clearDocumentsSession==='function')clearDocumentsSession();
  if(typeof clearReferralSession==='function')clearReferralSession();
  if(typeof resetOrderDiagnosisLinkDrafts==='function')resetOrderDiagnosisLinkDrafts();
  if(typeof resetAccountDiagnosisLinkDrafts==='function')resetAccountDiagnosisLinkDrafts();
  if(typeof clearHealthHistorySession==='function')clearHealthHistorySession(); if(typeof clearImmunizationSession==='function')clearImmunizationSession();
  visitDrafts.clear();
  if(typeof clearVisitNoteSession==='function')clearVisitNoteSession();
  clearVisitAmendmentDrafts();
  if(typeof roomingDrafts!=='undefined'){roomingDrafts.clear();roomingPending.clear();roomingGeneration++;}
  if(typeof visitDiagnosisDrafts!=='undefined'){visitDiagnosisDrafts.clear();visitDiagnosisStates.clear();visitDiagnosisPending.clear();visitDiagnosisGeneration++;}
  if(typeof practiceAdminGeneration!=='undefined'){practiceAdminState=null;practiceAdminGeneration++;}
  if(typeof checkoutDrafts!=='undefined'){checkoutDrafts.clear();checkoutStates.clear();checkoutGeneration++;checkoutState=undefined;checkoutContext=undefined;}
  patientWorkspaceGeneration++;patientDirectoryPreference=storedPatientDirectoryPreference();
  me = undefined; patients = []; selected = undefined; workspace = undefined; activeVisit = undefined;
  closeNavigation();
  $('app').hidden = true; $('login-screen').hidden = false;
  $('login-error').textContent='';
  $('patients').replaceChildren(); $('chart').replaceChildren(); $('patient-form').reset(); $('patient-form').hidden=true;
  $('search').value=''; $('notice').hidden=true; $('tools').replaceChildren(); $('tools').hidden=true;
  void refreshSignInMode();
}
async function refreshSignInMode(){
 try{
  const mode=await fetch('/auth/mode',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject());
  const connected=mode.mode==='connect';$('local-login-fields').hidden=connected;$('connect-login').hidden=!connected;
  for(const input of $('local-login-fields').querySelectorAll('input'))input.required=!connected;
  if(connected){$('connect-login').href=mode.staff_sign_in_url;$('login-description').textContent='Use your SunCharts Connect passkey or emailed sign-in link.';$('login-connect-state').hidden=false;$('login-connect-state').textContent='Connected to SunCharts Connect · authorization is checked in real time.';}
  else{$('connect-login').href='#';$('login-description').textContent='Sign in to your self-hosted SunCharts EHR.';$('login-connect-state').hidden=true;$('login-connect-state').textContent='';}
 }catch{$('login-connect-state').hidden=false;$('login-connect-state').textContent='Unable to verify Connect status. Try again shortly.';}
}
function notice(message, error = false) { $('notice').textContent=message; $('notice').className=`notice${error?' error':''}`; $('notice').hidden=false; }
async function run(action) {
  if (busy) return;
  busy=true; $('notice').hidden=true;
  $('shell-loading').hidden=false;
  document.documentElement?.classList.add('app-busy');
  const buttons = Array.from(document.querySelectorAll('button'), b=>[b,b.disabled]);
  buttons.forEach(([b])=>{b.disabled=true;});
  try { await action(); } catch(e) { if (me) notice(e.message,true); else $('login-error').textContent=e.message; }
  finally { busy=false;$('shell-loading').hidden=true;document.documentElement?.classList.remove('app-busy');buttons.forEach(([b,disabled])=>{if(b.isConnected)b.disabled=disabled;});window.SunChartsDialog?.restoreFocus(); }
}
async function enter() {
  me=await api('/auth/me');
  if(typeof initSun==='function')initSun();
  if(typeof startSunEvents==='function')startSunEvents(me);
  organizeWorkspaceNavigation();
  if(typeof loadPracticeWorkspaceSettings==='function')await loadPracticeWorkspaceSettings();
  if($('nav-portal'))$('nav-portal').hidden=!['owner','clinician','front_desk'].includes(me.role)||$('nav-portal').dataset.workspaceHidden==='true';
  if($('nav-communications'))$('nav-communications').hidden=!['owner','clinician','nurse','medical_assistant','front_desk'].includes(me.role);
  if($('nav-ai-review'))$('nav-ai-review').hidden=!['owner','clinician','nurse','medical_assistant','front_desk'].includes(me.role);
  $('login-screen').hidden=true; $('app').hidden=false;$('toggle-directory').hidden=false;setPatientDirectoryVisible(true);
  const roleLabel=me.delegated_role==='partner_admin'
    ?'Partner administrator (delegated)'
    :me.delegated_role==='workflow_manager'?'Partner workflow manager'
    :({owner:'Practice owner',clinician:'Clinician',front_desk:'Front desk',read_only:'Read only',nurse:'Nurse',medical_assistant:'Medical assistant',partner_support:'Partner support · read only'})[me.role]||me.role.replaceAll('_',' ');
  const userLabel=me.display_name||me.email||'Signed-in user';
  $('sidebar-user').textContent=userLabel;
  $('sidebar-user').title=me.email||userLabel;
  $('sidebar-role').textContent=roleLabel;
  $('identity-name').textContent=userLabel;
  $('identity-role').textContent=roleLabel;
  $('identity').title=me.email&&me.email!==userLabel?`${userLabel} · ${me.email} · ${roleLabel}`:`${userLabel} · ${roleLabel}`;
  $('identity').setAttribute('aria-label',`Signed in as ${userLabel}, ${roleLabel}`);
  setPage('Patients & encounters');
  if(typeof refreshConnectionBadge==='function')void refreshConnectionBadge();
  if(typeof startConnectUpdates==='function')void startConnectUpdates(me);
  $('nav-migration').hidden=me.role!=='owner'||$('nav-migration').dataset.workspaceHidden==='true';
  if($('nav-admin'))$('nav-admin').hidden=me.role!=='owner';
  if(typeof applyWorkspaceAccessVisibility==='function')applyWorkspaceAccessVisibility();
  if(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical')){
    const page=await api(typeof patientDirectoryQuery==='function'?patientDirectoryQuery():'/api/v1/patients'); patients=page.items; cursor=page.next_cursor;
  }else{patients=[];cursor=null;}
  renderPatients();
  if(me.role==='partner_support')notice('Delegated partner support session. Clinical and administrative changes are disabled.');
  if(typeof finishConnectOnboarding==='function'&&await finishConnectOnboarding())return;
  if (new URLSearchParams(location.search).has('oauth_request')) { await showConsent(); return; }
  if (!selected) $('chart').innerHTML='<div class="panel empty"><span class="empty-mark" aria-hidden="true">⊕</span><h2>Open a patient chart</h2><p>Select a patient from the directory to review their record,<br>manage orders, or document an encounter.</p><div class="empty-shortcuts"><button type="button" data-open-schedule>View schedule</button></div></div>';
  if(new URLSearchParams(location.search).has('payment_membership')&&typeof openPatientMembershipReturn==='function'){await openPatientMembershipReturn(new URLSearchParams(location.search).get('payment_membership'));return;}
  if(new URLSearchParams(location.search).has('invoice_checkout')&&typeof openInvoiceCheckoutReturn==='function'){await openInvoiceCheckoutReturn(new URLSearchParams(location.search).get('invoice_checkout'));return;}
  if(new URLSearchParams(location.search).has('payment_setup')&&typeof openPatientPaymentSetupReturn==='function'){
    await openPatientPaymentSetupReturn(new URLSearchParams(location.search).get('payment_setup'));return;
  }
  if(new URLSearchParams(location.search).has('copay_checkout')&&typeof openHostedCopayReturn==='function'){
    await openHostedCopayReturn(new URLSearchParams(location.search).get('copay_checkout'));return;
  }
  const paymentId=new URLSearchParams(location.search).get('payment_checkout');
  if(paymentId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId)&&typeof openPaymentStatus==='function'){
    await showBillingQueue();await openPaymentStatus(paymentId);return;
  }
  if(new URLSearchParams(location.search).get('payment_settings')==='1'&&typeof openPaymentSettings==='function'){
    await showBillingQueue();await openPaymentSettings();return;
  }
  if(new URLSearchParams(location.search).get('open')==='claimmd'&&typeof showEdiWorkspace==='function'){
    await showEdiWorkspace();return;
  }
  if(new URLSearchParams(location.search).get('open')==='sun'&&typeof showSunPage==='function'){await showSunPage();return;}
  if(new URLSearchParams(location.search).get('open')==='workflow-studio'&&typeof showWorkflowStudio==='function'){
    await showWorkflowStudio();return;
  }
  if(new URLSearchParams(location.search).get('open')==='automation-center'&&typeof showAutomationCenter==='function'){
    await showAutomationCenter();return;
  }
  const batchId=new URLSearchParams(location.search).get('era_batch');
  if (batchId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) {
    await showClaimsWorkspace();
    await showEraBatch(batchId);
    return;
  }
  if(typeof showPracticeWorkspace==='function'&&(typeof workspaceModuleAllowed!=='function'||workspaceModuleAllowed('practice')))await showPracticeWorkspace();
  else if(typeof showAllowedWorkspaceLanding==='function')await showAllowedWorkspaceLanding();
}
function renderPatients() {
  const q=$('search').value.trim().toLowerCase();
  const filtered=patients.filter(p=>`${p.given_name} ${p.family_name} ${p.mrn}`.toLowerCase().includes(q));
  $('patient-count').textContent=patients.length;
  $('patients').innerHTML=filtered.length ? filtered.map(p=>`<button class="patient-row ${p.id===selected?'selected':''}" data-patient="${esc(p.id)}">${esc(p.family_name)}, ${esc(p.given_name)}<small>${esc(displayBirthDate(p.birth_date))} · <span class="record-id">MRN ${esc(p.mrn)}</span>${p.archived?' · Archived':''}</small></button>`).join('') : '<p class="muted">No patients found.</p>';
  $('load-more').hidden=!cursor;
}
async function selectPatient(id, keepVisit, stillCurrent=()=>true) {
  const openingIdentity=me;
  const openingGeneration=++patientWorkspaceGeneration;
  captureVisitDrafts();
  // Publish one complete chart only after every patient-scoped read succeeds.
  const next=await api(`/api/v1/patients/${id}/workspace`);
  if(me!==openingIdentity||openingGeneration!==patientWorkspaceGeneration||!stillCurrent())return;
  const allowed=resource=>typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);
  const sourceAllowed=['clinical','billing','claims','migration'].every(allowed);
  const [history,clinical,labs,billing,payers,demographics]=await Promise.all([
    sourceAllowed?api(`/api/v1/patients/${id}/history`):Promise.resolve(null),api(`/api/v1/patients/${id}/clinical`),
    api(`/api/v1/patients/${id}/orders`),allowed('billing')?api(`/api/v1/patients/${id}/billing`):Promise.resolve(null),allowed('billing')?api('/api/v1/billing/payers'):Promise.resolve({items:[]}),api(`/api/v1/patients/${id}/demographics`)
  ]);
  if(me!==openingIdentity||openingGeneration!==patientWorkspaceGeneration||!stillCurrent())return;
  captureVisitDrafts(); // Include edits made while the chart reads were in flight.
  next.history=history?.items??null;next.clinical=clinical;next.labs=labs;next.billing=billing;next.demographics=demographics;
  if(id!==selected){chartSection='overview';encounterSection=['nurse','medical_assistant'].includes(me?.role)?'intake':'documentation';}
  if(keepVisit&&activeVisit?.id!==keepVisit){chartSection='visits';encounterSection=['nurse','medical_assistant'].includes(me?.role)?'intake':'documentation';}
  workspace=next;billingPayers=payers.items;selected=id;
  activeVisit=keepVisit===null ? undefined : keepVisit ? workspace.visits.find(v=>v.id===keepVisit) : workspace.visits.find(v=>v.status==='in_progress'&&v.clinician_id===me.user_id)||workspace.visits.find(v=>v.status==='in_progress');
  renderPatients();renderChart();
  setPatientDirectoryVisible(patientDirectoryPreference===true);
}

async function openPatientEncounter(id){
 const openingIdentity=me,openingPatient=selected,openingWorkspace=workspace;
 if(!openingPatient||!openingWorkspace?.visits?.some(visit=>visit.id===id))throw new Error('Choose an encounter from this patient’s history.');
 const openingGeneration=++patientWorkspaceGeneration;
 captureVisitDrafts();
 const visit=await api(`/api/v1/visits/${id}`);
 if(me!==openingIdentity||selected!==openingPatient||workspace!==openingWorkspace||openingGeneration!==patientWorkspaceGeneration)return;
 if(visit.id!==id||visit.patient_id!==openingPatient)throw new Error('This encounter does not belong to the selected patient.');
 captureVisitDrafts();rememberVisit(visit);chartSection='visits';encounterSection=isRoomingStaff()?'intake':'documentation';renderChart();
}

const date = s => new Date(s).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
function renderChart() {
  captureVisitAmendmentDraft();
  if(typeof capturePatientLifecycleDraft==='function')capturePatientLifecycleDraft();
  if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
  if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
  if(typeof captureDocumentDraft==='function')captureDocumentDraft();
  if(typeof captureReferralDraft==='function')captureReferralDraft();
  if(typeof captureOrderDiagnosisLinkDraft==='function')captureOrderDiagnosisLinkDraft();
  if(typeof captureAccountDiagnosisLinkDraft==='function')captureAccountDiagnosisLinkDraft();
  if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft(); if(typeof captureImmunizationDraft==='function')captureImmunizationDraft();
  if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
  let tabs=[['overview','Summary'],['profile','Patient details'],['clinical','Clinical lists'],['care_pathways','Care pathways'],['prescribing','Prescribing'],['immunizations','Immunizations'],['functional_status','Functional status'],['specialty_care','Specialty care'],['history','Surgical & dental history'],['documents','Documents'],['referrals','Referrals'],['orders','Orders & results'],['visits','Encounters'],['checkout','Checkout & AVS'],['billing','Financials'],['source','Source records']];
  if(typeof configuredChartTabs==='function')tabs=configuredChartTabs(tabs);
  if(tabs.some(([key])=>key==='billing'))tabs.splice(tabs.findIndex(([key])=>key==='billing'),0,['insurance','Insurance']);
  $('chart').innerHTML=`<section id="patient-banner" class="patient-banner" aria-label="Patient summary">${typeof patientBannerMarkup==='function'?patientBannerMarkup():''}</section><div class="chart-context">${chartNavigation(tabs)}</div>
  <section id="patient-lifecycle" class="panel" hidden></section>
  <div id="encounter-progress">${encounterWorkflow()}</div>
  <div id="encounter-start-editor"></div>
  ${chartOverview()}
  <section id="patient-demographics"></section>
  <section id="patient-intake-panel" class="panel" tabindex="-1" hidden></section>
  <section id="functional-status-panel" class="panel" hidden></section>
  <section id="specialty-care-panel" class="panel" hidden></section>
  <section id="care-pathways-panel" class="panel care-pathways-panel" hidden></section>
  <div id="record-context"></div>
  <div id="visit-editor"></div>
  <section id="encounter-revenue" class="panel" hidden></section>
  <section id="encounter-orders-actions" class="panel" hidden></section>
  <div id="visit-checkout"><div class="panel"><h2>Checkout & after-visit summary</h2><p>Select an encounter from Encounters to review its handoff and follow-up.</p></div></div>
  ${patientAppointmentWorkspace()}`;
  if(typeof renderPrescribing==='function')void renderPrescribing(); renderClinical(); renderLabs(); renderBilling(); renderHistory(); if(typeof renderHealthHistory==='function')void renderHealthHistory(); if(typeof renderImmunizations==='function')void renderImmunizations(); if(typeof renderDocuments==='function')void renderDocuments(); if(typeof renderPatientIdentity==='function')void renderPatientIdentity(); if(typeof renderPatientLifecycle==='function')void renderPatientLifecycle(); if(typeof renderReferrals==='function')void renderReferrals(); if(typeof renderDemographics==='function')renderDemographics(selected,workspace.demographics); if(typeof renderPatientIntakePackets==='function')void renderPatientIntakePackets(); if(typeof renderSpecialtyPatientWorkspace==='function')void renderSpecialtyPatientWorkspace(); if(typeof renderCarePathways==='function'&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('workflows')))void renderCarePathways(); if(typeof renderPatientInsurance==='function')void renderPatientInsurance(); if(activeVisit) renderVisit(false); applyChartSection(); if(typeof patientBannerChartRendered==='function')void patientBannerChartRendered();
}
function canRegisterPatient(){return ['owner','clinician','front_desk'].includes(me?.role)&&(typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed('clinical','create'));}
function isRoomingStaff(){return ['nurse','medical_assistant'].includes(me?.role);}
function canRecordVisitVitals(v){return v?.status==='in_progress'&&(isRoomingStaff()||(['owner','clinician'].includes(me?.role)&&(v.clinician_id===me.user_id||!me?.delegated)));}
function renderVisit(activate=true) {
  captureVisitAmendmentDraft();
  if(activate){chartSection='visits';}
  followUnchangedNote();
  const v=activeVisit, draft=visitDrafts.get(v.id), retained=draft?.patientId===selected&&v.status!=='signed'?draft:null, note=retained?.note?.values||v.note||{}, noteSource=noteSourceText(retained?.note?.values?retained.note.values.started_from:v.note?.started_from), vitals=retained?.vitals?.values||v.vitals||{}, signed=v.status==='signed', canDraft=canDraftNote(v), canSign=canSignNote(), canAmend=canAmendNote(v), locked=signed||!canDraft, vitalsLocked=!canRecordVisitVitals(v);
  const correction=canAmend?currentAmendmentDraft(v):null, authorship=typeof visitNoteAuthorshipLine==='function'?visitNoteAuthorshipLine(v):'', supportSession=Boolean(me.delegated);
  const vitalLabels={systolic_mm_hg:'Systolic BP (mmHg)',diastolic_mm_hg:'Diastolic BP (mmHg)',heart_rate_bpm:'Heart rate (bpm)',temperature_c:'Temperature (°C)',weight_kg:'Weight (kg)',height_cm:'Height (cm)',oxygen_saturation_pct:'Oxygen saturation (%)'};
  const amendments=workspace.amendments.filter(a=>a.visit_id===v.id);
  $('visit-editor').innerHTML=`<section class="panel"><div class="section-head"><h2>${signed?'Signed clinical record':'Visit documentation'}</h2><span class="pill ${signed?'signed':''}">${signed?'Signed':'In progress'}</span></div>${signed?`<div class="signed-notice" id="signed-note-help"><strong>Signed note — read-only.</strong> <span id="note-signed-by">${esc(typeof visitNoteSignedLine==='function'?visitNoteSignedLine(v):`Signed ${date(v.signed_at)}.`)}</span> The original SOAP note and vitals cannot be overwritten.${canAmend?' Add a signed correction to this encounter, or start a new encounter for a new visit.<div class="actions"><button type="button" data-action="focus-amendment" aria-controls="amendment-form">Add a signed correction</button></div>':supportSession?' A clinician at the practice must sign any correction.':' A clinician can add a correction.'}</div>`:''}
  <p id="visit-draft-status" class="muted" role="status"></p><div id="encounter-intake"><div class="encounter-context-links"><button type="button" data-chart-section="insurance">Review insurance & copay</button><button type="button" data-chart-section="clinical">Review allergies & medications</button><button type="button" data-chart-section="documents">Review patient documents</button></div><div id="encounter-benefits" class="billing-section"></div><div id="visit-rooming"></div><h3>Vitals</h3><form id="vitals-form" data-visit-id="${v.id}" data-version="${retained?.vitals?.version??v.version}"><div class="form-grid vitals-grid">${Object.entries(vitalLabels).map(([key,label])=>`<label>${label}<input name="${key}" type="number" step="${['systolic_mm_hg','diastolic_mm_hg','heart_rate_bpm'].includes(key)?'1':'any'}" required value="${esc(vitals[key])}" ${vitalsLocked?'disabled':''}></label>`).join('')}</div>${vitalsLocked?'':'<button type="submit">Save vitals</button>'}</form>
  </div><div id="encounter-documentation"><section id="visit-diagnoses"></section><form id="note-form" data-visit-id="${v.id}" data-version="${retained?.note?.version??v.version}"${signed?' aria-describedby="signed-note-help"':''}><h3>${signed?'SOAP note — signed original':'SOAP note'}</h3><p id="note-authorship" class="note-authorship muted"${authorship?'':' hidden'}>${esc(authorship)}</p>${locked?'':'<div id="note-conflict" class="notice error note-conflict" role="alert" hidden></div><div id="note-saved-copy" class="note-saved-copy" hidden></div>'}${locked?'':`<div id="note-previous" class="note-previous" hidden></div><input type="hidden" name="started_from" value="${esc(noteSource)}">`}<div class="form-grid note-grid">${noteSectionKeys.filter(key=>key!=='procedure'||!locked||String(note.procedure??'').trim()).map(key=>{const label=key[0].toUpperCase()+key.slice(1);return `<div class="note-section${key==='procedure'?' note-procedure':''}"><label>${label}<textarea name="${key}" maxlength="10000" ${locked?'readonly':key==='procedure'?`placeholder="${esc(noteProcedureHint)}"`:''}>${esc(note[key])}</textarea></label>${locked?'':`<button type="button" class="text-button note-same" id="note-same-${key}" data-note-same="${key}" aria-label="Same as last visit: ${label}" hidden>Same as last visit</button>`}</div>`;}).join('')}</div>${noteSource||!locked?`<p id="note-source-line" class="note-source muted"${noteSource?'':' hidden'}>${esc(noteSourceLine(noteSource,signed,v.note?.started_from))}</p>`:''}<div id="note-message" class="note-message muted" role="status" hidden></div>${locked?'':`<div class="actions"><button type="submit">Save note</button>${canSign?'<button class="primary" type="button" data-action="sign">Sign encounter note</button><span class="muted">Save your note before signing. Then review procedures and charges, complete checkout, and submit the reviewed claim.</span>':`<span id="note-sign-help" class="muted">${supportSession?'You can draft this note. A clinician at the practice must sign it.':'You can draft this note. A clinician signs it.'}</span>`}</div>`}</form>
  ${signed?`<h3>Amendment history</h3>${amendments.map(a=>`<div class="amendment"><p><b>${esc(a.reason)}</b></p><p class="note-text">${esc(a.text)}</p><small class="muted">Recorded ${esc(date(a.created_at))}<span id="amendment-author-${esc(a.id)}">${esc(typeof visitNoteAmendmentAuthor==='function'?visitNoteAmendmentAuthor(v,a):'')}</span></small></div>`).join('')||'<p class="muted">No amendments.</p>'}${canAmend?`<form id="amendment-form" data-visit-id="${esc(v.id)}" data-patient-id="${esc(selected)}" data-version="${correction?.version??v.version}" aria-describedby="amendment-draft-status"><h3>Add a signed correction</h3><p id="amendment-draft-status" class="muted" role="status"></p><button id="amendment-review-current" type="button" data-action="review-amendment-version" hidden>I reviewed the current record — keep my correction</button><label>Reason<input name="reason" required maxlength="1000" value="${esc(correction?.values.reason||'')}"></label><label>Correction<textarea name="text" required maxlength="10000">${esc(correction?.values.text||'')}</textarea></label><div class="actions"><button id="amendment-submit" type="submit">Sign & append amendment</button><button id="amendment-discard" type="button" data-action="discard-amendment-draft" class="quiet" hidden>Discard unsaved correction</button></div></form>`:''}`:''}${!signed&&!canDraft?'<p id="note-read-only" class="muted">You can read this note. Clinical staff write it and a clinician signs it.</p>':''}</div></section>`;
  if(canAmend){const form=$('amendment-form');if(form)visitAmendmentContexts.set(form,{identity:me,tenantId:me.tenant_id,patientId:selected,visitId:v.id,version:correction?.version??v.version});updateVisitAmendmentStatus();}
  updateDraftStatus();if(!locked&&typeof renderVisitNoteSource==='function')void renderVisitNoteSource();if(typeof renderVisitNoteAuthorship==='function')void renderVisitNoteAuthorship();refreshEncounterProgress();if(typeof renderRooming==='function')void renderRooming();if(typeof renderVisitDiagnoses==='function')void renderVisitDiagnoses();if(typeof renderVisitCheckout==='function')renderVisitCheckout();if(typeof renderEncounterRevenue==='function')void renderEncounterRevenue();renderEncounterOrderActions();if(typeof renderEncounterStartBenefits==='function')void renderEncounterStartBenefits('encounter-benefits',revenueServiceDate(workspace.appointments.find(a=>a.id===v.appointment_id)));if(encounterSection==='files'&&typeof renderEncounterFiles==='function')void renderEncounterFiles();applyChartSection();
}
function renderHistory() {
  if(workspace.history===null)return;
  const panel=document.createElement('section');panel.className='panel';panel.id='source-history';
  panel.innerHTML=`<h2>Records from previous system</h2><p class="muted">These records came from your previous system and are kept as they were. They were not signed in SunCharts.</p>${typeof importedContactBlock==='function'?importedContactBlock():''}${workspace.history.map(r=>{const data=r.data||{};const fields=Object.entries(data).filter(([k,v])=>!['id','pid','uuid','puuid','patient_id'].includes(k)&&['string','number','boolean'].includes(typeof v));return `<details class="amendment"><summary><b>${esc(r.kind.replaceAll('_',' '))}</b> ${esc(data.title||data.name||data.description||'')}</summary><p class="muted">From previous system: ${esc(r.source_instance)}</p><dl>${fields.map(([k,v])=>`<dt>${esc(k.replaceAll('_',' '))}</dt><dd class="note-text">${esc(v)}</dd>`).join('')}</dl><small class="muted">Imported ${esc(date(r.imported_at))} · Read only</small>${['insurance','billing','transaction'].includes(r.kind)&&['owner','clinician','front_desk'].includes(me.role)?`<div class="actions"><button type="button" data-map-billing="${esc(r.id)}">${r.kind==='insurance'&&r.source_data?.coverage?'Add as coverage':'Review billing / insurance source'}</button></div>`:''}${r.kind==='claim'&&billingWrite()?`<button type="button" data-map-claim="${esc(r.id)}">Review claim mapping</button>`:''}${r.kind==='appointment'&&['owner','clinician','front_desk'].includes(me.role)?`<div class="actions"><button type="button" data-map-appointment="${esc(r.id)}">Review appointment mapping</button></div>`:''}${['lab_order','lab_result'].includes(r.kind)&&['owner','clinician'].includes(me.role)?`<div class="actions"><button type="button" data-map-lab="${esc(r.id)}">Reconcile lab source</button></div>`:''}${['medical_problem','allergy','medication'].includes(r.kind)&&['owner','clinician'].includes(me.role)?`<div class="actions"><button type="button" data-map-clinical="${esc(r.id)}">Review and add to chart</button></div>`:''}</details>`;}).join('')||'<p class="muted">No imported records for this patient.</p>'}`;
  $('chart').append(panel);
}
function encounterWorkflow(){
 const v=activeVisit,appointment=v?workspace.appointments.find(a=>a.id===v.appointment_id):workspace.appointments.find(a=>['checked_in','booked'].includes(a.status));
 if(!v&&workspace.patient?.archived)return '<section class="panel encounter-empty"><h2>Archived patient chart</h2><p>Review existing encounter history, or restore the patient before starting a new encounter.</p></section>';
 if(!v)return `<section class="panel encounter-empty"><h2>Start the encounter</h2><p>Start from an appointment or enter the service date and time for an unscheduled visit.</p>${typeof canStartEncounterFlow==='function'&&canStartEncounterFlow()?'<button type="button" class="primary" data-start-encounter-flow>Start encounter</button>':''}<button type="button" data-chart-section="insurance">Review insurance & copay</button>${appointment?.status==='checked_in'&&(isRoomingStaff()||(['owner','clinician'].includes(me.role)&&appointment.clinician_id===me.user_id))?` <button type="button" class="primary" data-start="${esc(appointment.id)}">Start encounter</button>`:''}</section>`;
 const steps=encounterSections();
 const runs=typeof patientPathways==='undefined'?[]:patientPathways.filter(item=>item.patient_id===selected&&item.status==='active'&&(!item.appointment_id||item.appointment_id===v.appointment_id));
 return `<section class="encounter-workspace-heading"><div class="section-head"><div><p class="eyebrow">SELECTED ENCOUNTER</p><h2>${esc(appointment?.title||'Office visit')}</h2><p class="muted">${esc(encounterDateLabel(v))} · ${v.status==='signed'?'Signed clinical record':'In progress'}</p></div><div class="encounter-selection"><button type="button" data-encounter-history>Encounter history</button>${typeof canStartEncounterFlow==='function'&&canStartEncounterFlow()?'<button type="button" data-start-encounter-flow>+ New encounter</button>':''}<label>Switch encounter<select id="encounter-picker">${workspace.visits.map(row=>`<option value="${esc(row.id)}" ${row.id===v.id?'selected':''}>${esc(encounterDateLabel(row))} · ${row.status==='signed'?'Signed':'In progress'}</option>`).join('')}</select></label>${runs.length&&chartAreaEnabled('care_pathways')?'<button type="button" data-chart-section="care_pathways">Practice workflow</button>':''}${typeof supportHelpButton==='function'?supportHelpButton('visit'):''}</div></div><nav class="encounter-step-tabs" aria-label="Encounter work">${steps.map(([key,label],index)=>`<button type="button" data-encounter-section="${key}" aria-pressed="${encounterSection===key}"><span>${index+1}</span>${label}</button>`).join('')}</nav></section>`;
}
function encounterSections(){
 const canView=resource=>typeof workspaceResourceAllowed!=='function'||workspaceResourceAllowed(resource);
 return [['intake','Rooming'],['documentation','Notes & diagnoses (ICD-10)'],...(chartAreaEnabled('billing')&&canView('billing')?[['charges','Procedures (CPT/HCPCS) & billing']]:[]),...(chartAreaEnabled('orders')&&canView('clinical')?[['orders','Orders & prescriptions']]:[]),...(chartAreaEnabled('documents')&&canView('clinical')?[['files','Files & voice']]:[]),...(chartAreaEnabled('checkout')?[['checkout','Checkout & AVS']]:[])];
}
function renderEncounterOrderActions(){
 const host=$('encounter-orders-actions');if(!host||!activeVisit)return;
 host.innerHTML=`<div class="section-head"><div><h2>Prescriptions & referrals</h2><p class="muted">Order medication or coordinate a referral for the selected encounter.</p></div><div class="actions">${chartAreaEnabled('prescribing')?'<button type="button" data-chart-section="prescribing">Prescriptions</button>':''}${chartAreaEnabled('referrals')?'<button type="button" data-chart-section="referrals">Referrals</button>':''}</div></div>`;
}
function setEncounterSection(key){
 if(!activeVisit){showChartSection('visits');return;}
 if(!encounterSections().some(([step])=>step===key))return;
 captureVisitDrafts();encounterSection=key;showChartSection('visits');
 if(key==='charges'&&typeof renderEncounterRevenue==='function')void renderEncounterRevenue();
 if(key==='files'&&typeof renderEncounterFiles==='function')void renderEncounterFiles();
}
function refreshEncounterProgress(){if(workspace&&$('encounter-progress'))$('encounter-progress').innerHTML=encounterWorkflow();}
function openEncounterStep(step){
 if(step==='checkout'){setEncounterSection('checkout');return;}
 if(step==='clinical'){showChartSection('clinical');return;}
 if(['orders','new-order'].includes(step)){
  setEncounterSection('orders');
  if(step==='new-order'&&activeVisit&&canDocument()){editLabOrder();$('lab-order-form').elements.visit_id.value=activeVisit.id;}
  return;
 }
 if(['billing','new-account'].includes(step)){
  setEncounterSection('charges');
  if(typeof openEncounterCharges==='function')openEncounterCharges();
  return;
 }
 setEncounterSection(step==='vitals'||step==='rooming'?'intake':'documentation');
 const host=$(step==='diagnoses'?'visit-diagnoses':step==='vitals'?'vitals-form':step==='note'?'note-form':'visit-editor');host?.scrollIntoView({block:'start'});
}
function encounterDateLabel(v){
 const timestamp=workspace.appointments.find(a=>a.id===v.appointment_id)?.starts_at||v.signed_at||v.created_at;
 return timestamp?date(timestamp):'Encounter date not recorded';
}
// The banner shows who the chart is for and what is under way; nothing else to refresh here.
function refreshPatientChartContext(){if(typeof renderPatientBanner==='function')renderPatientBanner();}
function chartContactSummary(){
 if(typeof workspaceResourceAllowed==='function'&&!workspaceResourceAllowed('clinical'))return '';
 const contact=workspace.demographics?.content||{},canDetails=chartAreaEnabled('profile');
 return `<section class="panel chart-summary-section patient-contact-summary"><div class="section-head"><h2>Contact details</h2>${canDetails?'<button type="button" class="text-button" data-chart-section="profile">View / edit contact</button>':''}</div><dl><div><dt>Phone</dt><dd data-chart-contact="phone">${esc(contact.phone||'Not recorded')}</dd></div><div><dt>Email</dt><dd data-chart-contact="email">${esc(contact.email||'Not recorded')}</dd></div></dl><div class="chart-summary-footer"><span id="patient-intake-summary" role="status">Loading intake forms…</span>${chartAreaEnabled('documents')?'<button type="button" class="text-button" data-patient-intakes-open>View submitted intake forms</button>':''}</div></section>`;
}
function refreshChartContactSummary(){
 const chart=$('chart'),contact=workspace.demographics?.content||{};
 for(const key of ['phone','email']){const selector=`[data-chart-contact="${key}"]`,values=chart?.querySelectorAll?[...chart.querySelectorAll(selector)]:[chart?.querySelector(selector)];for(const value of values)if(value)value.textContent=contact[key]||'Not recorded';}
 if(typeof renderPatientBanner==='function')renderPatientBanner();
}
function chartOverview(){
 const items=workspace.clinical.items,active=e=>e.content.status==='active'&&!['refuted','entered_in_error'].includes(e.content.verification),problems=items.filter(e=>e.kind==='problem'&&active(e)),meds=items.filter(e=>e.kind==='medication'&&active(e));
 const critical=r=>r.content.observations.some(o=>['critical','critical_high','critical_low'].includes(o.flag));
 const reports=workspace.labs.reports.filter(r=>['preliminary','final','corrected'].includes(r.status)&&!workspace.labs.acknowledgments.some(a=>a.report_id===r.id&&a.version===r.version)).sort((a,b)=>Number(critical(b))-Number(critical(a)));
 // A measurement that was not taken is left out; the card never prints an empty or "undefined" value.
 const measured=value=>value!==undefined&&value!==null&&value!==''&&!(typeof value==='number'&&!Number.isFinite(value)),hasVitals=v=>Boolean(v?.vitals)&&Object.values(v.vitals).some(measured);
 const recordedVisit=hasVitals(activeVisit)?activeVisit:workspace.visits.find(hasVitals),vitals=recordedVisit?.vitals;
 const observations=vitals?[['Blood pressure',measured(vitals.systolic_mm_hg)&&measured(vitals.diastolic_mm_hg)?`${vitals.systolic_mm_hg}/${vitals.diastolic_mm_hg}`:undefined,'mmHg'],['Pulse',vitals.heart_rate_bpm,'bpm'],['Temperature',vitals.temperature_c,'°C'],['Oxygen saturation',vitals.oxygen_saturation_pct,'%'],['Weight',vitals.weight_kg,'kg'],['Height',vitals.height_cm,'cm']].filter(([,value])=>measured(value)):[];
 const row=(title,detail)=>`<div class="chart-data-row"><strong>${esc(title)}</strong><small>${esc(detail)}</small></div>`;
 const problemRows=problems.slice(0,6).map(e=>row(e.content.title,`${displayStatus(e.content.verification)}${e.content.onset_date?' · Since '+displayDate(e.content.onset_date):''}`)).join('');
 const medRows=meds.slice(0,6).map(e=>row(e.content.title,[e.content.detail?.dose,e.content.detail?.route,e.content.detail?.frequency].filter(Boolean).join(' · ')||'No dose recorded')).join('');
 return `${patientWorkflowActions()}<section id="chart-overview" class="chart-overview-workbench"><div class="chart-primary-column"><section class="panel chart-summary-section"><div class="section-head"><h2>Clinical summary</h2><div class="clinical-summary-links" aria-label="Clinical record"><button type="button" class="text-button" data-clinical-focus="allergy">Allergies</button><button type="button" class="text-button" data-clinical-focus="problem">Problems</button><button type="button" class="text-button" data-clinical-focus="medication">Medications</button></div></div><div class="clinical-summary-columns"><section><h3>Active problems <span class="pill">${problems.length}</span></h3>${problemRows||'<div class="chart-empty-row">No problems recorded. <button type="button" class="text-button" data-clinical-focus="problem">Add problem</button></div>'}${problems.length>6?'<button type="button" class="text-button" data-chart-section="clinical">View all recorded problems</button>':''}</section><section><h3>Medications <span class="pill">${meds.length}</span></h3>${medRows||'<div class="chart-empty-row">No medications recorded. <button type="button" class="text-button" data-clinical-focus="medication">Add medication</button></div>'}${meds.length>6?'<button type="button" class="text-button" data-chart-section="clinical">View all recorded medications</button>':''}</section></div></section><section class="panel chart-summary-section"><div class="section-head"><h2>Results to review <span class="pill">${reports.length}</span></h2><button type="button" class="text-button" data-chart-section="orders">Orders & results →</button></div>${reports.length?`<table class="chart-results-table"><thead><tr><th>Report</th><th>Status</th><th>Reported</th></tr></thead><tbody>${reports.slice(0,5).map(r=>`<tr><td><strong>${esc(r.content.accession)}</strong><small>${esc(r.content.performing_lab||'Laboratory not recorded')}</small></td><td>${critical(r)?'<span class="critical-label">Critical</span>':esc(displayStatus(r.status))}</td><td>${esc(date(r.content.reported_at))}</td></tr>`).join('')}</tbody></table>`:'<div class="chart-empty-row">No results to review.</div>'}${workspace.labs.orders.length?`<div class="chart-summary-footer">${displayCount(workspace.labs.orders.length,'order')} on file</div>`:''}</section></div><aside class="chart-secondary-column">${chartContactSummary()}<section class="panel chart-summary-section"><div class="section-head"><h2>Latest vitals</h2><button type="button" class="text-button" data-encounter-step="vitals">Open →</button></div>${observations.length?`<dl class="chart-vital-list">${observations.map(([label,value,unit])=>`<div><dt>${label}</dt><dd>${esc(value)} <small>${unit}</small></dd></div>`).join('')}</dl><p class="chart-summary-footer">${recordedVisit.id===activeVisit?.id?'This visit':'Last recorded'} · ${esc(encounterDateLabel(recordedVisit))}</p>`:'<div class="chart-empty-row">No vitals recorded yet.</div>'}</section><section class="panel chart-summary-section"><div class="section-head"><h2>Encounter history</h2><button type="button" class="text-button" data-encounter-history>View all →</button></div>${patientEncounterHistoryRows(4,true)}</section></aside></section>`;
}
function chartAreaEnabled(key){
 return typeof workspaceChartTabEnabled!=='function'||workspaceChartTabEnabled(key==='insurance'?'billing':key);
}
function patientSectionVisible(key){
 if(!chartAreaEnabled(key))return false;
 if(key===chartSection)return true;
 return chartSection==='visits'&&Boolean(activeVisit)&&((key==='orders'&&encounterSection==='orders')||(key==='checkout'&&encounterSection==='checkout')||(key==='documents'&&encounterSection==='files'));
}
function applyChartSection(){
 if(!chartAreaEnabled(chartSection))chartSection='overview';
 if(typeof encounterSection!=='undefined'&&typeof encounterSections==='function'&&!encounterSections().some(([key])=>key===encounterSection))encounterSection='documentation';
 const groups={overview:['chart-overview','patient-next-action'],profile:['patient-identity-panel','patient-demographics'],clinical:['clinical-lists'],care_pathways:['care-pathways-panel'],prescribing:['prescribing-panel'],immunizations:['immunizations-panel'],functional_status:['functional-status-panel'],specialty_care:['specialty-care-panel'],history:['health-history-panel'],documents:['documents-panel','patient-intake-panel'],referrals:['referrals-panel'],orders:['lab-workspace'],insurance:['insurance-workspace'],billing:['billing-workspace'],checkout:['visit-checkout'],source:['source-history']};
 for(const [key,ids] of Object.entries(groups))for(const id of ids)if($(id))$(id).hidden=!patientSectionVisible(key);
 const inEncounter=chartSection==='visits',hasVisit=typeof activeVisit!=='undefined'&&Boolean(activeVisit),step=typeof encounterSection==='undefined'?'documentation':encounterSection;
 if($('appointments-panel'))$('appointments-panel').hidden=!inEncounter;
 if($('visit-editor'))$('visit-editor').hidden=!(inEncounter&&hasVisit&&['intake','documentation'].includes(step));
 if($('encounter-intake'))$('encounter-intake').hidden=step!=='intake';
 if($('encounter-documentation'))$('encounter-documentation').hidden=step!=='documentation';
 if($('encounter-revenue'))$('encounter-revenue').hidden=!(inEncounter&&hasVisit&&step==='charges'&&chartAreaEnabled('billing'));
 if($('encounter-orders-actions'))$('encounter-orders-actions').hidden=!(inEncounter&&hasVisit&&step==='orders'&&chartAreaEnabled('orders'));
 if($('encounter-progress')){$('encounter-progress').hidden=!inEncounter;if(inEncounter&&typeof refreshEncounterProgress==='function')refreshEncounterProgress();}
 const primary=['overview','visits','insurance','billing','documents'];
 if(typeof applyLabEncounterScope==='function')applyLabEncounterScope();
 if(typeof documentFileNavigationChanged==='function')documentFileNavigationChanged();
 document.querySelectorAll('.chart-tabs button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.chartSection===chartSection)));
 const record=$('patient-record-navigation');if(record){record.classList.toggle('active',!primary.includes(chartSection));if(primary.includes(chartSection))record.open=false;}
 const context=$('record-context');if(context){context.hidden=!hasVisit||primary.includes(chartSection);context.innerHTML='<button type="button" data-chart-section="visits">← Return to selected encounter</button>';}
 if(typeof refreshPatientChartContext==='function')refreshPatientChartContext();
 if(chartSection==='billing'&&typeof renderPatientBillingChart==='function')void renderPatientBillingChart();
}
function chartNavigation(tabs){
 const available=new Map(tabs),main=[['overview','Overview'],['visits','Encounter'],['insurance','Insurance'],['billing','Billing'],['documents','Files']].filter(([key])=>available.has(key)),mainKeys=new Set(main.map(([key])=>key));
 const names={billing:'Account summary',profile:'Contact & demographics',clinical:'Problems, allergies & medications',history:'Surgical & dental history',care_pathways:'Practice workflows',functional_status:'Function & assessments',source:'Imported records'};
 const records=tabs.filter(([key])=>!mainKeys.has(key)&&key!=='checkout');
 const button=([key,label])=>`<button type="button" aria-label="${esc(label)}" data-chart-section="${key}" aria-pressed="${key===chartSection}">${esc(label)}</button>`;
 return `<nav class="chart-tabs patient-workspace-tabs" aria-label="Patient workspace"><div class="chart-tab-row chart-primary-tabs">${main.map(button).join('')}${records.length?`<details class="patient-record-navigation" id="patient-record-navigation"><summary>Patient record</summary><div>${records.map(([key,label])=>button([key,names[key]||label])).join('')}</div></details>`:''}</div></nav>`;
}
function patientWorkflowActions(){
 if(workspace.patient?.archived&&!activeVisit)return '<section class="patient-next-action"><div><b>Archived patient chart</b><p>Review the encounter history below. Restore the patient to book or start a new visit.</p></div></section>';
 const v=activeVisit,appointment=v?workspace.appointments.find(a=>a.id===v.appointment_id):workspace.appointments.find(a=>['checked_in','booked'].includes(a.status));
 let action=typeof canStartEncounterFlow==='function'&&canStartEncounterFlow()?'<button type="button" class="primary" data-start-encounter-flow>Start encounter</button>':'<button type="button" class="primary" data-chart-section="visits">Appointments & encounters</button>',detail='Review insurance, then start from an appointment or enter the service date and time.';
 if(v){action=`<button type="button" class="primary" data-chart-section="visits">${v.status==='signed'?'Review encounter':'Continue encounter'}</button>`;detail=`${encounterDateLabel(v)} · ${v.status==='signed'?'Review procedures, checkout and billing for this visit.':'Continue the selected visit, diagnoses and procedures.'}`;}
 else if(appointment?.status==='checked_in'&&(isRoomingStaff()||(['owner','clinician'].includes(me?.role)&&appointment.clinician_id===me.user_id))){action=`<button type="button" class="primary" data-start="${esc(appointment.id)}">Start encounter</button>`;detail='The patient is checked in and ready for their encounter.';}
 else if(appointment?.status==='booked'&&['owner','clinician','front_desk'].includes(me?.role)){action=`<button type="button" class="primary" data-check-in="${esc(appointment.id)}">Check in patient</button>`;detail='Review insurance and copay before starting the visit.';}
 return `<section id="patient-next-action" class="patient-next-action"><div><b>${v?'Current encounter':'Visit preparation'}</b><p>${esc(detail)}</p></div><div class="actions">${!v&&chartAreaEnabled('insurance')?'<button type="button" data-chart-section="insurance">Insurance & copay</button>':''}${action}</div></section>`;
}
function showChartSection(key){
 if(!['overview','profile','clinical','care_pathways','prescribing','immunizations','functional_status','specialty_care','history','documents','referrals','orders','visits','checkout','insurance','billing','source'].includes(key))return;
 if(!chartAreaEnabled(key)){notice('This chart area is hidden in the practice workspace.',true);return;}
 if(typeof workspaceResourceAllowed==='function'){
  const resources=['billing','insurance'].includes(key)?['billing']:key==='source'?['clinical','billing','claims','migration']:key==='care_pathways'?['workflows']:['clinical'];
  if(!resources.every(resource=>workspaceResourceAllowed(resource))){notice('Your role does not have access to this chart area.',true);return;}
 }
 if(typeof captureVisitDrafts==='function')captureVisitDrafts();
 if(typeof capturePrescribingDraft==='function')capturePrescribingDraft();
 if(typeof capturePatientIdentityDraft==='function')capturePatientIdentityDraft();
 if(typeof captureReferralDeliveryDraft==='function')captureReferralDeliveryDraft();
 if(typeof captureDocumentDraft==='function')captureDocumentDraft();
 if(typeof captureReferralDraft==='function')captureReferralDraft();
 if(typeof captureHealthHistoryDraft==='function')captureHealthHistoryDraft(); if(typeof captureImmunizationDraft==='function')captureImmunizationDraft();
 if(key==='checkout'){if(activeVisit)encounterSection='checkout';key='visits';}
 if(key==='orders'&&activeVisit&&chartSection==='visits'){encounterSection='orders';key='visits';}
 const recordMenu=$('patient-record-navigation');if(recordMenu)recordMenu.open=false;
 chartSection=key;applyChartSection();
 if(key==='insurance'&&typeof renderPatientInsurance==='function')void renderPatientInsurance();
 if(key==='documents'&&typeof renderEncounterFiles==='function')renderEncounterFiles();
}

const formData=f=>Object.fromEntries(new FormData(f));
function closeNavigation() {const wasOpen=$('sidebar').classList.contains('menu-open');$('sidebar').classList.remove('menu-open');$('nav-toggle').setAttribute('aria-expanded','false');$('nav-toggle').setAttribute('aria-label','Open navigation');if(wasOpen)$('page-title').focus({preventScroll:true});}
function setPage(title) {
 if(title!=='Sun'&&$('tools')?.classList.contains('sun-page'))$('tools').className='panel';
 if(title!=='Sun'&&typeof sunPanelView!=='undefined'&&sunPanelView==='page'){sunPanelView='chat';if(typeof mountSunWorkspace==='function')mountSunWorkspace();}
 if(!title.startsWith('Patient portal')&&typeof leavePortalStaffWorkspace==='function')leavePortalStaffWorkspace();
 const descriptions={
  'Practice home':'Today’s schedule, unfinished encounters and clinical work needing attention',
  'Practice overview':'Today’s schedule, unfinished encounters and clinical work needing attention',
  'Practice administration':'Manage staff access, providers, facilities and rooms',
  'Terminology catalogs':'Manage dated diagnosis and procedure code catalogs for this practice',
  'Patients & encounters':'Find a patient, review their chart and continue encounter work',
  'Schedule':'Book appointments, manage provider availability and follow reminders',
  'Pre-visit readiness':'Review public bookings, patient forms and visit preparation',
  'Appointment reminders':'Review due reminders, contact readiness and delivery history',
  'Reminder settings':'Configure appointment delivery and sender identity',
  'Labs & results':'Review ordered tests, reported results and acknowledgment work',
  'Specialty care':'Review functional status and specialty treatment worklists',
  'Workflow Studio':'Design intake, visit and follow-up pathways with reusable modules',
  'Automation Center':'Operate reviewed connectors, exact triggers and governed actions',
  'Billing & insurance':'Manage coverage, charges, balances and patient payments',
  'Clearinghouse':'Verify coverage, submit reviewed claims and reconcile payer responses',
  'Claim lifecycle':'Verify coverage, submit reviewed claims and reconcile payer responses',
  'Claims & remittances':'Prepare claims, post remittances and resolve corrections',
  'Payment settings':'Configure Stripe or SunCharts Payments for this practice',
  'Payment review':'Review checkout status and verified payment history',
  'Referral delivery settings':'Configure receiving partners and delivery credentials',
  'Referrals':'Coordinate referral handoffs, follow-up dates and outcomes',
  'Follow-up tasks':'Work assigned tasks by due date and completion status',
  'Integrations':'Configure this EHR instance’s communications, scheduling partners, AI and authorized applications',
  'Inbox':'Review patient messages, calls, texts, faxes and referral email in one place',
  'Communications':'Review calls, text messages, faxes and referral email in the Inbox',
  'Send & review':'Prepare and review calls, text messages, faxes and email before sending',
  'AI review':'Generate and review clinic-owned AI drafts before they affect workflow',
  'Sun':'Ask questions, navigate and review answers in your practice workspace',
  'Sun review':'Prepare and review Sun drafts using your practice’s AI provider',
  'Connect services':'Manage reminders and SunCharts support services',
  'Support tickets':'Track SunCharts service requests and replies',
  'Data import':'Bring in patient records from your previous system'
 };
 const today=['Practice home','Practice overview','Schedule','Pre-visit readiness','Appointment reminders','Reminder settings','Follow-up tasks','Inbox','Patient portal inbox','Communications','Send & review'];
 const care=['Patients & encounters','Labs & results','Specialty care','Referrals','Referral delivery settings'];
 const revenue=['Billing & insurance','Payment settings','Payment review','Claims & remittances','Clearinghouse','Claim connections'];
 const manage=['Sun','Workflow Studio','Automation Center','AI review','Sun review','Practice administration','Terminology catalogs','Integrations','Connect services','Support tickets','Data import'];
 $('page-title').textContent=title;
 $('page-description').textContent=descriptions[title]||'Practice workspace';
 $('workspace-section').textContent=(today.includes(title)||title.startsWith('Patient portal'))?'TODAY':care.includes(title)?'CARE':revenue.includes(title)?'REVENUE':manage.includes(title)?'MANAGE':'PRACTICE';
 const active=['Practice home','Practice overview'].includes(title)?'nav-practice':title==='Workflow Studio'?'nav-workflows':title==='Automation Center'?'nav-automation':['AI review','Sun review'].includes(title)?'nav-ai-review':['Inbox','Communications','Send & review'].includes(title)||title.startsWith('Patient portal')?'nav-portal':title==='Patients & encounters'?'nav-clinical':title==='Pre-visit readiness'?'nav-previsit':['Schedule','Appointment reminders','Reminder settings'].includes(title)?'nav-schedule':title==='Labs & results'?'nav-labs':title==='Specialty care'?'nav-specialty':['Billing & insurance','Payment settings','Payment review'].includes(title)?'nav-billing':['Clearinghouse','Claim connections','Claim lifecycle'].includes(title)?'nav-edi':title==='Claims & remittances'?'nav-claims':['Referrals','Referral delivery settings'].includes(title)?'nav-referrals':title==='Follow-up tasks'?'nav-followup':['Integrations','Connect services','Support tickets'].includes(title)?'nav-apps':title==='Data import'?'nav-migration':['Practice administration','Terminology catalogs'].includes(title)?'nav-admin':null;
 for(const id of ['nav-practice','nav-workflows','nav-automation','nav-ai-review','nav-communications','nav-clinical','nav-schedule','nav-previsit','nav-labs','nav-specialty','nav-referrals','nav-followup','nav-portal','nav-billing','nav-claims','nav-edi','nav-apps','nav-migration','nav-admin']){if(!$(id))continue;if(id===active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}
 const activeItem=active?$(active):null,activeMore=activeItem?.closest?.('.nav-more');
 document.querySelectorAll?.('#workspace-navigation .nav-more').forEach(more=>{
  more.open=more===activeMore;
  const summary=more.querySelector?.('summary');
  if(summary)summary.textContent=more===activeMore?`More tools · ${activeItem?.textContent?.trim()||'Current'}`:'More tools';
 });
 closeNavigation();window.scrollTo(0,0);
}
function showTool(title) {
 if(typeof captureSupportDrafts==='function')captureSupportDrafts();
 const query=new URLSearchParams(location.search);
 const keep={open:({'Sun':'sun','Workflow Studio':'workflow-studio','Automation Center':'automation-center','Claim connections':'claimmd','Claim lifecycle':'claimmd','Clearinghouse':'claimmd'})[title],era_batch:title==='Claims & remittances',payment_checkout:title==='Payment review',payment_settings:title==='Payment settings',copay_checkout:title==='Card payment status'};
 for(const key of Object.keys(keep))if(query.has(key)&&(!keep[key]||(key==='open'&&query.get(key)!==keep[key])))query.delete(key);
 const search=query.size?'?'+query.toString():'';
 if(search!==location.search)history.replaceState(null,'',location.pathname+search+location.hash);
 setPage(title);$('clinical-workspace').hidden=true;$('patient-form').hidden=true;$('tools').hidden=false;$('new-patient').hidden=true;$('toggle-directory').hidden=true;
}
let sunReturnWorkspace='nav-practice';
async function showSunPage(){
 if(!me||me.role==='patient')return;
 const openingAccount=me,openingGeneration=typeof sunGeneration==='undefined'?null:sunGeneration,openingPage=$('page-title')?.textContent;
 const inStudio=String($('tools')?.className||'').split(/\s+/).includes('workflow-studio')&&!$('tools')?.hidden;
 if($('page-title')?.textContent!=='Sun'&&((typeof sunDirtyPage!=='undefined'&&sunDirtyPage)||(inStudio&&((typeof studioDirty!=='undefined'&&studioDirty)||(typeof studioWorkspaceDirty!=='undefined'&&studioWorkspaceDirty))))){
  if(!(await confirmAction('Open the Sun page? Unsaved changes on this page may be lost.',{title:'Open Sun page',confirmLabel:'Open Sun page'})))return;
 }
 if(me!==openingAccount||openingPage!==$('page-title')?.textContent||(typeof sunGeneration!=='undefined'&&openingGeneration!==sunGeneration))return;
 if(typeof sunDirtyPage!=='undefined')sunDirtyPage=false;
 if($('page-title')?.textContent!=='Sun')sunReturnWorkspace=document.querySelector('#workspace-navigation [aria-current="page"]')?.id||'nav-practice';
 const presentationAnswer=typeof sunCapturePresentationAnswer==='function'?sunCapturePresentationAnswer('page'):null;
 // Keep the same transcript and listeners when switching presentations.
 const panel=$('sun-panel');if(panel)document.body.append(panel);
 showTool('Sun');sunPanelView='page';
 $('tools').className='sun-page';$('tools').innerHTML='<div id="sun-page-root"></div>';
 const query=new URLSearchParams(location.search);query.set('open','sun');history.replaceState(null,'',location.pathname+'?'+query.toString()+location.hash);
 await openSun();
 if(typeof sunRestorePresentationAnswer==='function')sunRestorePresentationAnswer(presentationAnswer);
}
function returnSunToChat(){
 if($('page-title')?.textContent==='Sun'){
  const available=button=>button&&!button.hidden&&!button.disabled&&button.dataset.workspaceHidden!=='true';
  const previous=$(sunReturnWorkspace),target=available(previous)?previous:$('nav-practice');
  if(busy||!available(target)){if(typeof sunStatus==='function')sunStatus('Finish the current action before returning to the floating chat.');return false;}
  const presentationAnswer=typeof sunCapturePresentationAnswer==='function'?sunCapturePresentationAnswer('chat'):null;
  sunPanelView='chat';mountSunWorkspace();target.click();
  if(typeof sunRestorePresentationAnswer==='function')sunRestorePresentationAnswer(presentationAnswer);
 }else{sunPanelView='chat';mountSunWorkspace();}
 return true;
}
async function showClinical() {
 const openingIdentity=me,openingGeneration=++patientWorkspaceGeneration;
 captureVisitDrafts();showTool('Patients & encounters');
 selected=undefined;activeVisit=undefined;workspace=undefined;chartSection='overview';
 $('chart').innerHTML=patientDirectoryLanding();setPatientDirectoryVisible(true);
 $('tools').innerHTML='<p class="muted" role="status">Loading patient directory…</p>';
 const page=await api(typeof patientDirectoryQuery==='function'?patientDirectoryQuery():'/api/v1/patients');if(me!==openingIdentity||openingGeneration!==patientWorkspaceGeneration)return;
 patients=page.items;cursor=page.next_cursor;renderPatients();$('tools').replaceChildren();$('tools').hidden=true;
 $('clinical-workspace').hidden=false;$('new-patient').hidden=!canRegisterPatient();$('toggle-directory').hidden=false;
 $('search')?.focus({preventScroll:true});
}
const scopeNames={'clinical.read':'Read clinical records','clinical.write':'Update records using your clinical permissions','billing.read':'Read insurance and billing records','billing.write':'Update insurance and local billing records','events.read':'Receive record-change notices','migration.manage':'Stage and import EHR exports','offline_access':'Stay connected while you are away'};
async function showConsent() {
  const id=new URLSearchParams(location.search).get('oauth_request');
  if(!/^[0-9a-f-]{36}$/i.test(id||''))throw new Error('This connection request is invalid. Start again from SunCharts.');
  const request=await api(`/oauth/requests/${id}`);showTool('Authorize connection');
  $('tools').innerHTML=`<p class="eyebrow">CONNECT YOUR CLINICAL TOOLS</p><h2>Allow ${esc(request.name)} to connect?</h2><p>This grants access using your account on this SunCharts EHR installation.</p>${['https://connect.suncharts.app/oauth/ehr/callback','https://my.suncharts.app/oauth/ehr/callback'].includes(request.redirect_uri)?'<p>Connect your SunCharts workspace with access to clinical records, billing, imports and change notices allowed by your account role.</p>':`<ul>${request.scope.split(' ').map(s=>`<li>${esc(scopeNames[s]||s)}</li>`).join('')}</ul>`}<p>You can revoke access at any time in Integrations.</p><p class="muted">Return address: ${esc(new URL(request.redirect_uri).origin)}</p><div class="actions"><button class="primary" data-consent="allow" data-request="${esc(id)}">Allow connection</button><button data-consent="deny" data-request="${esc(id)}">Decline</button></div>`;
}
async function showApps() {
  const connection=typeof refreshConnectionBadge==='function'?await refreshConnectionBadge():null;
  const onboarding=me.role==='owner'?await api('/api/v1/connect/onboarding'):null;
  const grants=await api('/api/v1/oauth/grants');const clients=me.role==='owner'?await api('/api/v1/oauth/clients'):{items:[]};
  if(typeof showInstanceIntegrations==='function')return showInstanceIntegrations({connection,onboarding,grants,clients});
  showTool('Integrations');
  $('tools').innerHTML=`<p class="eyebrow">YOUR INTEGRATIONS</p><h2>Integrations</h2>${typeof connectStatusCard==='function'?connectStatusCard(connection):''}${me.role==='owner'?connectOnboardingCard(onboarding,connection):''}<p>Each person authorizes their own account. Revoking access also stops its live change feed.</p>${grants.items.map(g=>`<div class="timeline-row"><div><p><b>${esc(g.name)}</b></p><small>${g.revoked_at?'Access revoked':g.name==='SunCharts'?'SunCharts installation connection':esc(g.scope.split(' ').map(s=>scopeNames[s]||s).join(' · '))}</small></div>${g.revoked_at?'':`<button data-revoke="${esc(g.id)}">Revoke access</button>`}</div>`).join('')||'<p class="muted">No authorized applications yet.</p>'}
  <section class="billing-section"><div class="section-head"><div><h3>SunCharts Connect services</h3><p>Managed appointment email and support tickets for connected practices.</p></div><button type="button" data-connect-services>Open Connect services</button></div><p class="muted">Prefer your own branding? Configure your practice’s Resend account in Reminder settings. The self-hosted EHR works independently.</p></section>${me.role==='owner'?`<h3>Registered applications</h3>${clients.items.map(c=>`<p>${esc(c.name)} <small class="muted">${esc(new URL(c.redirect_uri).origin)}</small> ${c.disabled?'Disabled':`<button type="button" data-disable-client="${esc(c.id)}">Disable application</button>`}</p>`).join('')}` :''}`;
}
function rememberVisit(v,savedKind) {
 const previous=activeVisit;
 if(savedKind){
  const draft=visitDrafts.get(v.id);if(draft){delete draft[savedKind];for(const kind of ['note','vitals'])if(draft[kind]?.version===previous.version)draft[kind].version=v.version;if(!draft.note&&!draft.vitals)visitDrafts.delete(v.id);}
  for(const kind of ['note','vitals']){const form=$(kind+'-form');if(form?.dataset?.visitId===v.id&&Number(form.dataset.version)===previous.version)form.dataset.version=String(v.version);}
 }
 activeVisit=v; workspace.visits=workspace.visits.map(old=>old.id===v.id?v:old); if(savedKind)captureVisitDrafts(false);updateDraftStatus();if(typeof showVisitNoteAuthorship==='function')showVisitNoteAuthorship();refreshEncounterProgress();if(savedKind&&savedKind!=='rooming'&&typeof renderRooming==='function')void renderRooming();if(savedKind&&savedKind!=='diagnoses'&&typeof renderVisitDiagnoses==='function')void renderVisitDiagnoses();
}
document.addEventListener('submit',e=>{
  const form=e.target; if(!['login-form','patient-form','note-form','vitals-form','amendment-form','migration-form'].includes(form.id))return;
  e.preventDefault();run(async()=>{
    const data=formData(form);
    if(form.id==='login-form'){await api('/auth/login','POST',data);form.reset();await enter();return;}
    if(form.id==='migration-form'){await uploadMigration(form);return;}
    if(form.id==='patient-form'){
      const contactKeys=['administrative_gender','email','phone','address_line1','address_line2','city','region','postal_code','country'];
      const contact=Object.fromEntries(contactKeys.map(key=>[key,data[key]||null]));contactKeys.forEach(key=>delete data[key]);
      const p=await api('/api/v1/patients','POST',data);patients.unshift(p);let contactError=null;
      if(Object.values(contact).some(Boolean))try{await api(`/api/v1/patients/${p.id}/demographics`,'PUT',{content:{preferred_name:null,pronouns:null,language:null,administrative_gender:contact.administrative_gender,phone:contact.phone,email:contact.email,address:{line1:contact.address_line1,line2:contact.address_line2,city:contact.city,region:contact.region,postal_code:contact.postal_code,country:contact.country},emergency_contact:null},reason:'Contact details recorded during patient registration'},0);}catch(error){contactError=error;}
      form.reset();form.hidden=true;await selectPatient(p.id);notice(contactError?`Patient ${p.mrn} was created, but contact details need review: ${contactError.message}`:`Patient registered with MRN ${p.mrn}.`,Boolean(contactError));return;
    }
    if(form.id==='vitals-form'){Object.keys(data).forEach(k=>{data[k]=Number(data[k]);});rememberVisit(await api(`/api/v1/visits/${activeVisit.id}/vitals`,'PUT',data,Number(form.dataset.version)),'vitals');notice('Vitals saved.');return;}
    if(form.id==='note-form'){await saveVisitNote(form,data);return;}
    if(form.id==='amendment-form'){await submitVisitAmendment(form);}
  });
});
document.addEventListener('click',e=>{
  if(e.target.closest?.('#connect-login')?.id==='connect-login'){rememberHostedCopaySignInReturn();rememberPatientPaymentSetupSignInReturn();rememberPatientMembershipSignInReturn();rememberInvoiceCheckoutSignInReturn();return;}
  const button=e.target.closest('button');if(!button||(button.type==='submit' && button.form))return;
  if(button.dataset.action==='focus-amendment'){if(!busy)focusVisitAmendment();return;}
  if(button.dataset.action==='show-saved-note'){if(!busy)showSavedNoteCopy();return;}
  if(button.dataset.action==='keep-note-draft'){if(!busy)keepNoteDraft();return;}
  if(button.dataset.action==='review-amendment-version'){if(!busy)reviewVisitAmendmentVersion(button);return;}
  if(button.id==='toggle-directory'){const show=$('clinical-workspace').classList.contains('directory-collapsed');setPatientDirectoryVisible(show);if(selected&&workspace)rememberPatientDirectoryPreference(show);return;}
  if(button.hasAttribute('data-encounter-history')){showChartSection('visits');const history=$('patient-encounter-history');if(history){history.open=true;history.scrollIntoView({block:'start'});}return;}
  if(button.dataset.clinicalFocus){showChartSection('clinical');if(chartSection!=='clinical')return;const label=({allergy:'Allergies',problem:'Problems',medication:'Medications'})[button.dataset.clinicalFocus];const section=Array.from($('clinical-lists')?.querySelectorAll('.clinical-domain')||[]).find(node=>node.querySelector('h3')?.textContent===label);section?.scrollIntoView({block:'start'});return;}
  if(button.dataset.chartSection){showChartSection(button.dataset.chartSection);return;}
  if(button.dataset.encounterSection){setEncounterSection(button.dataset.encounterSection);return;}
  if(button.dataset.encounterStep){openEncounterStep(button.dataset.encounterStep);return;}
  if(button.id==='nav-toggle'){const open=$('sidebar').classList.toggle('menu-open');button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',open?'Close navigation':'Open navigation');return;}
  if(button.closest('#edi-tool')||button.dataset.ediClaim)return;
  if(button.closest('#claims-tool')||button.closest('#encounter-claims')||button.dataset.newClaim||button.dataset.mapClaim)return;
  if(button.closest('#billing-workspace')||button.closest('#billing-tool')||button.dataset.mapBilling)return;
  if(button.closest('#schedule-workspace')||button.dataset.mapAppointment)return;
  if(button.closest('#patient-demographics'))return;
  if(button.dataset.importSource||button.dataset.useContact||button.dataset.reconcileAll||button.dataset.importFilesAdd||button.dataset.importFilesRetry)return;
  if(button.closest('#clinical-lists')||button.closest('#lab-workspace')||button.dataset.mapLab||button.dataset.openLabPatient||button.dataset.mapClinical)return;
  if(button.id==='new-patient'){ if(!canRegisterPatient())return; $('patient-form').hidden=false;$('patient-form').elements.given_name.focus();return; }
  if(button.id==='cancel-patient'){ $('patient-form').reset();$('patient-form').hidden=true;return; }
  // Module handlers must be allowed to claim their own actions without this
  // listener briefly acquiring the shared busy gate and swallowing the click.
  const navigationTitles={'nav-schedule':'Schedule','nav-workflows':'Workflow Studio','nav-automation':'Automation Center','nav-communications':'Inbox','nav-ai-review':'Sun review','nav-referrals':'Referrals','nav-portal':'Inbox','nav-followup':'Follow-up tasks','nav-labs':'Labs & results','nav-specialty':'Specialty care','nav-edi':'Claim lifecycle','nav-claims':'Claims & remittances','nav-billing':'Billing & insurance','nav-admin':'Practice administration','nav-apps':'Integrations','nav-migration':'Data import','nav-clinical':'Patients & encounters','nav-customize':'Practice administration'};
  const navigationTitle=navigationTitles[button.id]||(button.hasAttribute('data-open-schedule')?'Schedule':null);
  const ownsAction=navigationTitle||['logout','load-more'].includes(button.id)||['data-consent','data-disable-client','data-revoke','data-reconcile','data-commit','data-patient','data-check-in','data-start','data-visit'].some(name=>button.hasAttribute(name))||['reload','discard-visit-draft','discard-amendment-draft','sign'].includes(button.dataset.action);
  if(!ownsAction)return;
  run(async()=>{
    if(navigationTitle){captureVisitDrafts();showTool(navigationTitle);$('tools').innerHTML=`<p class="muted" role="status">Loading ${esc(navigationTitle.toLowerCase())}…</p>`;}
    if(button.id==='nav-schedule'||button.hasAttribute('data-open-schedule')){await showSchedule();return;}
    if(button.id==='nav-workflows'){studioView='overview';await showWorkflowStudio();return;}
    if(button.id==='nav-automation'){await showAutomationCenter();return;}
    if(button.id==='nav-communications'){await showIntegrationInbox();return;}
    if(button.id==='nav-ai-review'){await showAiReviewWorkspace();return;}
    if(button.id==='nav-referrals'){await showReferralWorkspace();return;}
    if(button.id==='nav-portal'){await showPortalInbox();return;}
    if(button.id==='nav-followup'){await showFollowupWorkspace();return;}
    if(button.id==='nav-labs'){await showLabInbox();return;}
    if(button.id==='nav-specialty'){await showSpecialtyWorklist();return;}
    if(button.id==='nav-edi'){await showEdiWorkspace();return;}
    if(button.id==='nav-claims'){await showClaimsWorkspace();return;}
    if(button.id==='nav-billing'){await showBillingQueue();return;}
    if(button.id==='nav-customize'){await showPracticeAdmin('workspace');return;}
    if(button.id==='nav-admin'){await showPracticeAdmin();return;}
    if(button.id==='nav-apps'){await showApps();return;}
    if(button.id==='nav-migration'){await showMigrations();return;}
    if(button.id==='nav-clinical'){await showClinical();return;}
    if(button.dataset.consent){const d=await api(`/oauth/requests/${button.dataset.request}/decision`,'POST',{approved:button.dataset.consent==='allow'});location.assign(d.redirect_uri);return;}
    if(button.dataset.disableClient){await api(`/api/v1/oauth/clients/${button.dataset.disableClient}/disable`,'POST');await showApps();notice('Application disabled and its grants revoked.');return;}
    if(button.dataset.revoke){await api(`/api/v1/oauth/grants/${button.dataset.revoke}/revoke`,'POST');await showApps();notice('Connection access revoked.');return;}
    if(button.dataset.reconcile){const report=await api(`/api/v1/migrations/${button.dataset.reconcile}/reconcile`,'POST');await showMigrations();if(typeof importNotice==='function')importNotice(report);return;}
    if(button.dataset.commit){await importCommit(button);return;}
    if(button.id==='logout'){await api('/auth/logout','POST');clearHostedCopaySignInReturn();clearPatientPaymentSetupSignInReturn();clearPatientMembershipSignInReturn();clearInvoiceCheckoutSignInReturn();signInScreen();return;}
    if(button.id==='load-more'){const page=await api(typeof patientDirectoryQuery==='function'?patientDirectoryQuery(cursor):`/api/v1/patients?after=${encodeURIComponent(cursor)}`);patients.push(...page.items);cursor=page.next_cursor;renderPatients();return;}
    if(button.dataset.patient){await selectPatient(button.dataset.patient);return;}
    if(button.dataset.checkIn){await api(`/api/v1/appointments/${button.dataset.checkIn}/check-in`,'POST');await selectPatient(selected);showChartSection('visits');notice('Patient checked in.');return;}
    if(button.dataset.start){const v=await api('/api/v1/visits','POST',{appointment_id:button.dataset.start});await selectPatient(selected,v.id);return;}
    if(button.dataset.visit){await openPatientEncounter(button.dataset.visit);return;}
    if(button.dataset.action==='reload'){await selectPatient(selected,activeVisit?.id);return;}
    if(button.dataset.action==='discard-amendment-draft'){await discardVisitAmendmentDraft();return;}
    if(button.dataset.action==='discard-visit-draft'){if(!await confirmAction('The unsaved note and vitals edits in this tab will be removed and the saved record will be shown.',{title:'Discard encounter edits?',confirmLabel:'Discard edits',tone:'danger'}))return;visitDrafts.delete(activeVisit.id);if(typeof visitNoteSaved==='function')visitNoteSaved(activeVisit);renderVisit();notice('Unsaved encounter edits discarded. The saved record is shown.');return;}
    if(button.dataset.action==='sign'){
      if(!canSignNote())throw new Error('A clinician must sign this note.');
      const noteForm=$('note-form');
      // Subjective, Objective, Assessment and Plan must have text before the sign question appears.
      const missing=noteMissingForSign(noteForm);
      if(missing.length){refuseVisitNoteSigning(noteForm,missing);return;}
      if(typeof captureVisitDiagnosisDraft==='function')captureVisitDiagnosisDraft();
      if(typeof visitDiagnosisDrafts!=='undefined'&&visitDiagnosisDrafts.get(activeVisit.id)?.patientId===selected)throw new Error('Save or discard your diagnosis edits before signing.');
      const visible=formData(noteForm);
      if(!noteMatchesSaved(visible,activeVisit.note))throw new Error('Save your current note before signing.');
      const entered=formData($('vitals-form'));
      if(Object.values(entered).some(x=>x!=='') && (!activeVisit.vitals || Object.keys(entered).some(k=>Number(entered[k])!==activeVisit.vitals[k])))throw new Error('Save your current vitals before signing.');
      const signing=activeVisit,signer=me;
      if(signing.clinician_id!==me.user_id){
        // Covering a colleague's visit: one clear question. The visit itself is not reassigned.
        const name=(typeof visitNoteAssignedName==='function'?await visitNoteAssignedName(signing):'')||'the assigned clinician';
        if(me!==signer||activeVisit!==signing)return;
        if(!await confirmAction(`Signing locks the note and records you as the signer. The visit stays assigned to ${name}. Check the rendering provider on the claim if you saw the patient.`,{eyebrow:'COVERING A VISIT',title:`Sign as yourself for ${name}’s visit?`,confirmLabel:'Sign',cancelLabel:'Cancel'}))return;
      }else if(!await confirmAction('Signing locks the clinical note. Continue to charges and checkout after signing. Later corrections are preserved as signed amendments.',{title:'Sign encounter note?',confirmLabel:'Sign note'}))return;
      if(me!==signer||activeVisit!==signing)return;
      const v=await api(`/api/v1/visits/${activeVisit.id}/sign`,'POST',undefined,activeVisit.version);if(typeof clearVisitNoteSession==='function')clearVisitNoteSession();await selectPatient(selected,v.id);setEncounterSection(chartAreaEnabled('billing')?'charges':'checkout');notice('Encounter signed. Review procedures and charges, then complete checkout.');
    }
  });
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('sidebar').classList.contains('menu-open')){closeNavigation();$('nav-toggle').focus();}});
$('search').addEventListener('input',renderPatients);
// Every workspace module is deferred; initialize after all of them are loaded.
document.addEventListener('DOMContentLoaded',()=>connectLaunchAcceptance.then(()=>enter()).catch(error=>{signInScreen();if(error.message!=='Please sign in to continue.')$('login-error').textContent=error.message;}),{once:true});

document.addEventListener('input',e=>{if(e.target.closest?.('#note-form,#vitals-form'))captureVisitDrafts();else if(e.target.closest?.('#amendment-form'))captureVisitAmendmentDraft();});
window.addEventListener('beforeunload',e=>{captureVisitDrafts();if(visitAmendmentsHaveDrafts()||(typeof patientPaymentPlansHaveDrafts==='function'&&patientPaymentPlansHaveDrafts())||(typeof patientLifecycleHasDrafts==='function'&&patientLifecycleHasDrafts())||(typeof billingChargeHasDrafts==='function'&&billingChargeHasDrafts())||(typeof prescribingHaveDrafts==='function'&&prescribingHaveDrafts())||(typeof portalStaffHasDrafts==='function'&&portalStaffHasDrafts())||(typeof supportHasDrafts==='function'&&supportHasDrafts())||(typeof patientIdentityHasDrafts==='function'&&patientIdentityHasDrafts())||(typeof referralDeliveryHasDrafts==='function'&&referralDeliveryHasDrafts())||(typeof documentsHaveDrafts==='function'&&documentsHaveDrafts())||(typeof referralHasDrafts==='function'&&referralHasDrafts())||(typeof orderDiagnosisLinkDrafts!=='undefined'&&orderDiagnosisLinkDrafts.size)||(typeof accountDiagnosisLinkDrafts!=='undefined'&&accountDiagnosisLinkDrafts.size)||(typeof healthHistoryHasDrafts==='function'&&healthHistoryHasDrafts())||(typeof immunizationHasDrafts==='function'&&immunizationHasDrafts())||visitDrafts.size||(typeof visitDiagnosisDrafts!=='undefined'&&visitDiagnosisDrafts.size)||(typeof roomingDrafts!=='undefined'&&roomingDrafts.size)||(typeof checkoutDrafts!=='undefined'&&checkoutDrafts.size)){e.preventDefault();e.returnValue='';}});

document.addEventListener('change',event=>{if(event.target.id!=='encounter-picker')return;const id=event.target.value;run(()=>openPatientEncounter(id));});

// Change notes never block saving. Every save is already recorded with who made it and when, so
// the note is optional: note fields are not required, most are tucked away, and a standard note is
// filled in when one is left blank. Notes that carry meaning for staff (cancelling, rescheduling,
// appeals, archiving, revoking, closing) stay visible but are still optional.
(()=>{
 if(typeof document==='undefined'||typeof document.querySelectorAll!=='function'||typeof MutationObserver!=='function')return;
 const selector='input[name="reason"],textarea[name="reason"]';
 const keepVisible=/cancel|reschedul|appeal|archiv|revok|close|reopen|refund|void/i;
 function prepare(field){
  if(field.dataset.optionalNote)return;field.dataset.optionalNote='1';
  field.removeAttribute('required');field.removeAttribute('minlength');
  const label=field.closest('label');
  if(label&&keepVisible.test(label.textContent||'')){if(!field.placeholder)field.placeholder='Optional';return;}
  const holder=label&&label.querySelectorAll('input,textarea,select').length===1?label:field;
  holder.hidden=true;holder.style.display='none';
 }
 function prepareAll(root){if(root.matches?.(selector))prepare(root);root.querySelectorAll?.(selector).forEach(prepare);}
 function standardNote(form,button){
  const action=(button?.textContent||form.querySelector('button[type="submit"],button:not([type])')?.textContent||'Saved').trim().replace(/\s+/g,' ').slice(0,80);
  return `${action||'Saved'} - no note entered`;
 }
 function fill(form,button){form?.querySelectorAll?.(selector).forEach(field=>{if(!field.value.trim())field.value=standardNote(form,button);});}
 // Runs before the browser validates and before any form handler reads the note.
 document.addEventListener('click',event=>{const button=event.target.closest?.('button,input[type="submit"]');const form=button?.form||button?.closest?.('form');if(form&&(button.type||'submit')==='submit')fill(form,button);},true);
 document.addEventListener('submit',event=>fill(event.target,event.submitter),true);
 const start=()=>{prepareAll(document.body);new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)prepareAll(node);}).observe(document.body,{childList:true,subtree:true});};
 if(document.body)start();else document.addEventListener('DOMContentLoaded',start);
})();
