// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let documentOfficeAvailability=null,documentOfficeSession=null,documentOfficeApi=null;
function documentOfficeOrigin(value){try{const url=new URL(value);return url.origin===value.replace(/\/$/,'')&&!url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))?url.origin:null;}catch{return null;}}
async function loadDocumentOfficeAvailability(force=false){
 if(!force&&documentOfficeAvailability?.account===me)return documentOfficeAvailability;
 const account=me,state={account,loading:true};documentOfficeAvailability=state;
 try{const result=await api('/api/v1/documents/office-availability');if(me!==account||documentOfficeAvailability!==state)return null;state.available=result.available===true&&Boolean(documentOfficeOrigin(result.editor_origin));state.editor_origin=documentOfficeOrigin(result.editor_origin);state.reason=result.reason||(!state.available?'The practice’s Office editor service is not configured.':null);}catch{if(me!==account||documentOfficeAvailability!==state)return null;state.available=false;state.reason='Office editor availability could not be checked. Try again.';}
 state.loading=false;if(documentStates.has(selected))showDocuments();return state;
}
function documentOfficeMarkup(entry,view){
 if(documentOfficeAvailability?.account!==me){void loadDocumentOfficeAvailability();return '<p role="status">Checking the practice’s Office editor…</p>';}
 const service=documentOfficeAvailability;if(service.loading)return '<p role="status">Checking the practice’s Office editor…</p>';
 if(!service.available)return `<section class="mapping-notice"><h3>Office editor unavailable</h3><p>${esc(service.reason)}</p><p>The Word or Excel original remains available to download. No file has been sent to an editor.</p><button type="button" data-office-check>Check editor again</button></section>`;
 const latest=view.file.version===(entry.file_version||1),canEdit=latest&&entry.content.status==='active'&&documentCanEdit(entry);
 return `<section class="document-office-start"><h3>${entry.content_type.includes('spreadsheet')?'Excel workbook':'Word document'}</h3><p>Open the practice’s document editor to view this file${canEdit?' or edit it with its original formatting':''}.</p><div class="actions"><button type="button" data-office-open="view">Open read-only preview</button>${canEdit?'<button type="button" class="primary" data-office-open="edit">Edit in Office</button>':''}</div><p class="muted">${canEdit?'Use Save to EHR in the editor window to confirm a new saved file version. ':''}Earlier versions and the original remain available in file history.</p></section>`;
}
function officeSessionCurrent(s){return documentOfficeSession===s&&me===s.account;}
function officeStatus(s,message,error=false){if(!officeSessionCurrent(s))return;const node=$('document-office-status');if(node){node.textContent=message;node.classList.toggle('error',error);}const close=document.querySelector?.('#document-office-modal [data-office-discard]');if(close)close.textContent=s.saveRequest?'Close editor (save may complete)':'Close without saving';}
function officeSetBusy(s,busy){s.busy=busy;if(!officeSessionCurrent(s))return;const editor=$('document-office-stage');if(editor)editor.inert=busy;for(const button of document.querySelectorAll('#document-office-modal [data-office-save],#document-office-modal [data-office-close],#document-office-modal [data-office-discard]'))button.disabled=busy||(!s.ready&&(button.hasAttribute('data-office-save')||(s.mode==='edit'&&button.hasAttribute('data-office-close'))));if(busy)$('document-office-status')?.focus();}
function officeEnsureDialog(s){
 let modal=$('document-office-modal');if(modal)return modal;modal=document.createElement('dialog');modal.id='document-office-modal';modal.className='document-office-modal';
 modal.innerHTML=`<header><div><h2>${esc(s.title)}</h2><p>${esc(s.patientLabel)} · ${s.mode==='edit'?'Editing':'Read-only'} · Starting from file version ${s.baseVersion}</p></div><div class="actions">${s.mode==='edit'?'<button type="button" class="primary" data-office-save>Save to EHR</button>':''}<button type="button" data-office-refresh>Check saved status</button><button type="button" data-office-close>${s.mode==='edit'?'Save & close':'Close preview'}</button>${s.mode==='edit'?'<button type="button" data-office-discard>Close without saving</button>':''}</div></header><p id="document-office-status" tabindex="-1" role="status">Opening secure document editor…</p>${s.mode==='edit'?'<p class="document-office-save-note">Use <b>Save to EHR</b> above to store a confirmed file version. The editor toolbar’s Save button alone does not confirm an EHR version.</p>':''}<div id="document-office-stage"><div id="document-office-editor"></div></div>`;
 modal.addEventListener('cancel',event=>{event.preventDefault();officeStatus(s,'Use Save & close, or explicitly close without saving.');});document.body.append(modal);modal.showModal();return modal;
}
function loadOfficeApi(origin){
 if(documentOfficeApi){if(documentOfficeApi.origin!==origin)return Promise.reject(new Error('The Office editor origin changed. Reload the application before opening another editor.'));return documentOfficeApi.promise;}
 const state={origin};state.promise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=origin+'/web-apps/apps/api/documents/api.js';script.referrerPolicy='no-referrer';script.onload=()=>window.DocsAPI?.DocEditor?resolve(window.DocsAPI):reject(new Error('The Office editor API did not load.'));script.onerror=()=>{if(documentOfficeApi===state)documentOfficeApi=null;script.remove?.();reject(new Error('The Office editor service could not be reached.'));};document.head.append(script);});documentOfficeApi=state;return state.promise;
}
async function openDocumentOffice(mode){
 if(!['view','edit'].includes(mode))return;if(documentOfficeSession){$('document-office-modal')?.showModal();return;}
 const patient=selected,account=me,view=currentFileView(),entry=documentStates.get(patient)?.items.find(d=>d.id===view?.id);if(!view?.file||!entry||!entry.content_type.startsWith('application/vnd.openxmlformats'))return;
 if(mode==='edit'&&(!documentCanEdit(entry)||entry.content.status!=='active'||view.file.version!==(entry.file_version||1)))return;
 const service=await loadDocumentOfficeAvailability();if(!service?.available||me!==service.account||me!==account||selected!==patient||currentFileView()!==view)return;
 const s={account:me,patient:selected,document:entry.id,title:entry.content.title,patientLabel:typeof workspace!=='undefined'&&workspace.patient?`${workspace.patient.family_name}, ${workspace.patient.given_name} · MRN ${workspace.patient.mrn}`:'Selected patient',baseVersion:view.file.version,currentVersion:view.file.version,mode,requestId:crypto.randomUUID(),dirty:mode==='edit',busy:true,ready:false,editorPending:false,editGeneration:0,saveEditGeneration:null,saveRequest:null};documentOfficeSession=s;officeEnsureDialog(s);officeSetBusy(s,true);
 try{const result=await api(`/api/v1/patients/${s.patient}/documents/${s.document}/office-sessions`,'POST',{request_id:s.requestId,base_version:s.baseVersion,mode});if(!officeSessionCurrent(s))return;
  const origin=documentOfficeOrigin(result.editor_origin);if(!origin||origin!==service.editor_origin)throw new Error('The editor response did not match the configured service.');s.id=result.session_id;s.currentVersion=result.current_version||s.baseVersion;
  const lib=await loadOfficeApi(origin);if(!officeSessionCurrent(s))return;
  const config={...result.config,events:{onDocumentStateChange:event=>{if(!officeSessionCurrent(s)||typeof event?.data!=='boolean')return;s.editorPending=event.data;if(event.data){s.editGeneration++;s.dirty=true;officeStatus(s,'Edits have not been confirmed in the EHR. Use Save to EHR.');}},onDocumentReady:()=>{if(officeSessionCurrent(s)){s.ready=true;officeSetBusy(s,s.busy);officeStatus(s,s.mode==='edit'?'Document ready. Use Save to EHR to store a file version.':'Read-only preview ready.');}},onError:()=>officeStatus(s,'The Office editor reported an error. Keep this window open and check saved status before closing.',true),onAppReady:()=>officeStatus(s,'Editor loaded. Waiting for the document…')}};
  s.editor=new lib.DocEditor('document-office-editor',config);officeSetBusy(s,false);
 }catch(error){if(officeSessionCurrent(s)){officeSetBusy(s,false);s.openError=true;officeStatus(s,error.message,true);}}
}
async function refreshDocumentOfficeSession(s=documentOfficeSession){
 if(!s?.id||!officeSessionCurrent(s))return null;const result=await api(`/api/v1/patients/${s.patient}/documents/${s.document}/office-sessions/${s.id}`);if(!officeSessionCurrent(s))return null;
 if(s.saveRequest&&result.save_request_id===s.saveRequest.request_id&&result.status==='saved'){
  s.currentVersion=result.current_version;s.dirty=s.editorPending||s.editGeneration!==s.saveEditGeneration;s.saveRequest=null;s.saved=true;const entry=documentStates.get(s.patient)?.items.find(d=>d.id===s.document);if(entry)entry.file_version=Math.max(entry.file_version||1,result.current_version);officeStatus(s,s.dirty?`File version ${result.current_version} was saved. Newer editor changes still need Save to EHR.`:`Saved to EHR as file version ${result.current_version}. Earlier versions are preserved.`);
 }else if(result.status==='needs_review'){officeStatus(s,result.last_error||'The saved version could not be confirmed. Your editor remains open for review.',true);}
 else if(result.status==='saving')officeStatus(s,'Saving to the EHR… Waiting for the document service’s verified callback.');
 else if(!s.dirty)officeStatus(s,`Confirmed EHR file version ${s.currentVersion}.`);
 return result;
}
async function saveDocumentOffice(){
 const s=documentOfficeSession;if(!s||s.mode!=='edit'||!s.id||s.busy||!officeSessionCurrent(s))return false;if(!s.ready){officeStatus(s,'Wait for the document to finish loading before saving.',true);return false;}
 officeSetBusy(s,true);officeStatus(s,'Waiting for the editor to send pending changes… Keep this window open.');
 try{for(let n=0;s.editorPending&&n<40;n++){await new Promise(resolve=>setTimeout(resolve,250));if(!officeSessionCurrent(s))return false;}if(s.editorPending){officeStatus(s,'The editor has not sent its latest changes yet. Wait for its connection, then try Save to EHR again.',true);return false;}if(!s.saveRequest){s.saveRequest={request_id:crypto.randomUUID(),expected_version:s.currentVersion};s.saveEditGeneration=s.editGeneration;}officeStatus(s,'Saving to the EHR… Keep this window open.');await api(`/api/v1/patients/${s.patient}/documents/${s.document}/office-sessions/${s.id}/save`,'POST',s.saveRequest);if(!officeSessionCurrent(s))return false;
  for(let n=0;n<40;n++){const result=await refreshDocumentOfficeSession(s);if(!officeSessionCurrent(s))return false;if(!s.saveRequest&&result?.status==='saved')return !s.dirty;if(result?.status==='needs_review'||result?.status==='closed')return false;await new Promise(resolve=>setTimeout(resolve,500));}
  officeStatus(s,'The save is still pending. Keep the editor open and use Check saved status. Retrying Save to EHR uses the same request.',true);return false;
 }catch(error){if(officeSessionCurrent(s))officeStatus(s,'Save was not confirmed: '+error.message+'. Keep the editor open and check saved status.',true);return false;}
 finally{if(officeSessionCurrent(s))officeSetBusy(s,false);}
}
function officeDiscardCopy(s){return s.saveRequest?{title:'Close while a save is pending?',message:'A save has already been requested and may still complete after you close. Closing does not cancel that save. Later editor changes that were not included will be discarded.',label:'Close editor'}:{title:'Close without saving?',message:'Only file versions already confirmed by the EHR remain saved. Unsaved editor changes will be discarded.',label:'Discard and close'};}
function confirmOfficeDiscard(s){
 return new Promise(resolve=>{
  const modal=$('document-office-modal');if(!modal){resolve(false);return;}
  const copy=officeDiscardCopy(s),review=document.createElement('section');review.className='document-office-discard-review notice';review.setAttribute('role','alertdialog');review.setAttribute('aria-label',copy.title);
  review.innerHTML=`<h3>${esc(copy.title)}</h3><p>${esc(copy.message)}</p><div class="actions"><button type="button" data-office-discard-cancel>Keep editing</button><button type="button" data-office-discard-confirm>${esc(copy.label)}</button></div>`;
  modal.insertBefore(review,$('document-office-stage'));$('document-office-stage').inert=true;
  const finish=value=>{review.remove();if($('document-office-stage'))$('document-office-stage').inert=s.busy;s.discardConfirm=null;resolve(value);};s.discardConfirm=finish;
  review.querySelector('[data-office-discard-cancel]').addEventListener('click',()=>finish(false),{once:true});review.querySelector('[data-office-discard-confirm]').addEventListener('click',()=>finish(true),{once:true});review.querySelector('[data-office-discard-cancel]').focus();
 });
}
function destroyDocumentOffice(s=documentOfficeSession){if(!s)return;s.discardConfirm?.(false);s.editor?.destroyEditor?.();if(documentOfficeSession===s)documentOfficeSession=null;const modal=$('document-office-modal');modal?.close();modal?.remove();}
async function closeDocumentOffice(discard=false){
 const s=documentOfficeSession;if(!s||s.busy)return;
 if(discard&&s.mode==='edit'&&(s.dirty||s.saveRequest)&&!s.openError){if(!await confirmOfficeDiscard(s))return;if(!officeSessionCurrent(s))return;}
 else if(s.mode==='edit'&&!s.openError&&(s.dirty||s.saveRequest)&&!await saveDocumentOffice())return;
 if(!officeSessionCurrent(s))return;destroyDocumentOffice(s);if(selected===s.patient&&documentStates.get(selected)?.items.some(d=>d.id===s.document))await openDocumentFile(s.document,s.currentVersion);
}
function clearDocumentOfficeSession(){destroyDocumentOffice();documentOfficeAvailability=null;}
function documentOfficeHasDrafts(){return Boolean(documentOfficeSession?.mode==='edit');}
const previousWorkspaceHistoryRestore=globalThis.beforeWorkspaceHistoryRestore;
globalThis.beforeWorkspaceHistoryRestore=async function(){if(documentOfficeSession){officeStatus(documentOfficeSession,'Close this editor after saving, or explicitly discard changes, before going back.');return false;}return typeof previousWorkspaceHistoryRestore==='function'?previousWorkspaceHistoryRestore():true;};
document.addEventListener('click',event=>{const b=event.target.closest?.('[data-office-open],[data-office-check],[data-office-save],[data-office-refresh],[data-office-close],[data-office-discard]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();run(async()=>{if(b.hasAttribute('data-office-check'))return loadDocumentOfficeAvailability(true);if(b.hasAttribute('data-office-open'))return openDocumentOffice(b.dataset.officeOpen);if(b.hasAttribute('data-office-save'))return saveDocumentOffice();if(b.hasAttribute('data-office-refresh'))return refreshDocumentOfficeSession();if(b.hasAttribute('data-office-discard'))return closeDocumentOffice(true);if(b.hasAttribute('data-office-close'))return closeDocumentOffice();});},true);
window.addEventListener('beforeunload',event=>{if(documentOfficeHasDrafts()){event.preventDefault();event.returnValue='';}});
