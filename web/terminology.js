// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let terminologyGeneration=0,terminologyImport=null,terminologyImportRevision=0;
const terminologyPickers=new Map();
const terminologySystems=['ICD-10-CM','ICD-10-PCS','HCPCS','CPT'];
const terminologySystem=value=>({'ICD10CM':'ICD-10-CM','ICD10PCS':'ICD-10-PCS','HCPCS':'HCPCS','CPT':'CPT'})[String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'')]||null;
const terminologyLookupButton=scope=>`<button type="button" data-terminology-open="${scope}">${scope==='diagnosis'?'Find ICD-10-CM diagnosis':'Find procedure code'}</button>`;
const terminologyCatalogButton=()=>me?.role==='owner'?'<button type="button" data-terminology-manage>Terminology catalogs</button>':'';
function renderTerminologyAdminEntry(){return me?.role==='owner'?'<button type="button" data-terminology-manage>Code catalogs</button>':'';}
function terminologyReleaseLabel(value){return `${value.system||''} · ${value.edition||'Edition not recorded'} · effective ${value.effective_start||'date not recorded'}${value.effective_end?` through ${value.effective_end}`:' onward'}`;}
function terminologySnapshotMarkup(snapshot){return snapshot?`<p class="muted" data-terminology-selection>Recorded catalog: ${esc(terminologyReleaseLabel(snapshot))}. ${esc(snapshot.source_name||'')}</p>`:'';}
function terminologyContextCurrent(state){return state.generation===terminologyGeneration&&state.account===me&&state.host.isConnected&&state.row.isConnected&&state.form.isConnected&&state.patient===selected&&(state.scope!=='diagnosis'||state.visit===activeVisit?.id);}
function clearTerminologySession(){terminologyGeneration++;for(const state of terminologyPickers.values())state.host.remove();terminologyPickers.clear();terminologyImport=null;terminologyImportRevision++;}
function terminologyServiceDate(scope,form){
 if(scope==='procedure')return form.elements.service_date?.value||'';
 const visit=typeof activeVisit!=='undefined'?activeVisit:null,stored=typeof visitDiagnosisStates!=='undefined'?visitDiagnosisStates.get(visit?.id):null;if(stored?.service_date)return stored.service_date;
 const appointment=typeof workspace!=='undefined'?workspace.appointments?.find(item=>item.id===visit?.appointment_id):null,timestamp=appointment?.starts_at||visit?.created_at;
 if(!timestamp)return '';
 return typeof localTime==='function'?localTime(timestamp).slice(0,10):String(timestamp).slice(0,10);
}
function terminologyPickerStatus(state,text,error=false){const status=state.host.querySelector('[data-terminology-status]');status.textContent=text;status.className=`muted${error?' error':''}`;}
function terminologyPickerCurrentDate(state){return state.host.querySelector('[data-terminology-date]').value;}
function terminologyPickerMarkup(state){
 const allowed=state.scope==='diagnosis'?['ICD-10-CM']:['CPT','HCPCS'];
 return `<div class="section-head"><h4>${state.scope==='diagnosis'?'Find an encounter diagnosis':'Find a procedure or service code'}</h4><button type="button" data-terminology-close>Close lookup</button></div><p class="muted">Search installed catalogs. Choosing a code fills this row for review; save the encounter or charge account separately.</p><div class="form-grid"><label>Catalog system<select data-terminology-system>${allowed.map(system=>`<option value="${system}" ${system===state.system?'selected':''}>${system}</option>`).join('')}</select></label><label>Service date<input type="date" data-terminology-date value="${esc(state.serviceDate)}" required></label><label>Catalog release<select data-terminology-release><option value="">Latest release effective on this date</option></select></label><label>Code or description<input data-terminology-query maxlength="200" autocomplete="off" value="${esc(state.query)}" placeholder="Enter a code or a description"></label></div><button type="button" data-terminology-search>Search catalog</button><p data-terminology-status role="status" aria-live="polite">Loading catalog releases…</p><div data-terminology-results></div>`;
}
async function openTerminologyPicker(button){
 const scope=button.dataset.terminologyOpen,row=button.closest(scope==='diagnosis'?'[data-diagnosis-row]':'.billing-charge-row'),form=row?.closest('form');if(!row||!form)return;
 const existing=row.querySelector('[data-terminology-picker]');if(existing){existing.querySelector('[data-terminology-query]')?.focus();return;}
 const host=document.createElement('section');host.className='amendment';host.dataset.terminologyPicker='';host.setAttribute('aria-label','Terminology lookup');
 const system=scope==='diagnosis'?'ICD-10-CM':terminologySystem(row.querySelector('[name="code_system"]')?.value)||'CPT';
 const state={scope,row,form,host,button,system,serviceDate:terminologyServiceDate(scope,form),query:row.querySelector('[name="code"]')?.value||'',patient:selected,visit:typeof activeVisit!=='undefined'?activeVisit?.id:null,account:me,generation:terminologyGeneration,request:0,items:[],releases:[]};
 terminologyPickers.set(host,state);host.innerHTML=terminologyPickerMarkup(state);row.append(host);host.querySelector('[data-terminology-query]').focus();
 await loadTerminologyReleases(state);
}
async function loadTerminologyReleases(state){
 const request=++state.request,system=state.host.querySelector('[data-terminology-system]').value;
 state.items=[];state.host.querySelector('[data-terminology-results]').replaceChildren();
 try{
  const result=await api(`/api/v1/terminology/releases?${new URLSearchParams({system})}`);
  if(!terminologyContextCurrent(state)||request!==state.request)return;
  state.system=system;state.releases=result.items||[];
  state.host.querySelector('[data-terminology-release]').innerHTML='<option value="">Latest release effective on this date</option>'+state.releases.map(release=>`<option value="${esc(release.id||release.release_id)}">${esc(terminologyReleaseLabel(release))}</option>`).join('');
  terminologyPickerStatus(state,state.releases.length?'Enter at least two characters and search. Results are filtered for billable codes effective on the service date.':`No ${system} catalog is installed for this EHR. Manual entry remains available; an owner can import a suitable catalog from Practice administration → Code catalogs.`);
 }catch(error){if(terminologyContextCurrent(state)&&request===state.request)terminologyPickerStatus(state,`Catalog lookup is unavailable: ${error.message}. Existing entries are unchanged; manual entry remains available.`,true);}
}
function renderTerminologyResults(state){
 const results=state.host.querySelector('[data-terminology-results]');
 results.innerHTML=state.items.map((item,index)=>`<article class="integration-access-row"><div><b>${esc(item.code)} · ${esc(item.display)}</b><small>${esc(terminologyReleaseLabel(item))}</small><small>${esc(item.source_name||'Source not recorded')} · ${item.billable?'Billable code':'Not billable'}${item.active===false?' · Inactive':''}</small></div><button type="button" data-terminology-select="${index}" ${item.active===false||!item.billable?'disabled':''}>Use code</button></article>`).join('')+(state.nextCursor?'<button type="button" data-terminology-more>More matching codes</button>':'');
}
async function searchTerminology(state,more=false){
 const system=state.host.querySelector('[data-terminology-system]').value,serviceDate=terminologyPickerCurrentDate(state),query=state.host.querySelector('[data-terminology-query]').value.trim(),release=state.host.querySelector('[data-terminology-release]').value;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)){terminologyPickerStatus(state,'Choose the encounter or charge service date before searching.',true);return;}
 if(query.length<2){terminologyPickerStatus(state,'Enter at least two characters from a code or description.',true);return;}
 const append=more&&state.search?.system===system&&state.search?.serviceDate===serviceDate&&state.search?.query===query&&state.search?.release===release,request=++state.request,params=new URLSearchParams({system,q:query,service_date:serviceDate,billable:'true',limit:'20'});
 if(release)params.set('release_id',release);if(append&&state.nextCursor)params.set('after',state.nextCursor);
 terminologyPickerStatus(state,'Searching installed catalog…');
 try{
  const result=await api(`/api/v1/terminology/codes?${params}`);
  if(!terminologyContextCurrent(state)||request!==state.request)return;
  state.items=append?[...state.items,...(result.items||[])]:result.items||[];state.nextCursor=result.next_cursor||null;state.search={system,serviceDate,query,release};renderTerminologyResults(state);
  terminologyPickerStatus(state,state.items.length?`${state.items.length} matching code${state.items.length===1?'':'s'} shown for ${serviceDate}. Review the description and release before selecting.`:'No matching billable codes were found for this date and release. Review the date, search, or catalog. Manual entry is still available.');
 }catch(error){if(terminologyContextCurrent(state)&&request===state.request)terminologyPickerStatus(state,`Search could not finish: ${error.message}. Existing entries are unchanged.`,true);}
}
function terminologySelectionCurrent(state,item){
 const search=state.search;return terminologyContextCurrent(state)&&search&&state.host.querySelector('[data-terminology-system]').value===search.system&&terminologyPickerCurrentDate(state)===search.serviceDate&&state.host.querySelector('[data-terminology-query]').value.trim()===search.query&&state.host.querySelector('[data-terminology-release]').value===search.release&&item.active!==false&&item.billable&&(!item.effective_start||item.effective_start<=search.serviceDate)&&(!item.effective_end||item.effective_end>=search.serviceDate);
}
async function selectTerminologyCode(state,index){
 const item=state.items[index];if(!item||!terminologySelectionCurrent(state,item)){terminologyPickerStatus(state,'The lookup context changed. Search again before choosing a code.',true);return;}
 const code=state.row.querySelector('[name="code"]'),display=state.row.querySelector(state.scope==='diagnosis'?'[name="display"]':'[name="description"]'),system=state.row.querySelector('[name="code_system"]'),before=[code.value,display.value,system?.value,terminologyServiceDate(state.scope,state.form)];
 const request=++state.request,detail=await api(`/api/v1/terminology/releases/${encodeURIComponent(item.release_id)}/codes/${encodeURIComponent(item.code)}`);
 if(request!==state.request||!terminologySelectionCurrent(state,item))return;
 if(JSON.stringify(before)!==JSON.stringify([code.value,display.value,system?.value,terminologyServiceDate(state.scope,state.form)])){terminologyPickerStatus(state,'The row or service date changed while loading the code. Your edits were kept; search again before selecting.',true);return;}
 if(detail.code!==item.code||detail.release_id!==item.release_id||!terminologySelectionCurrent(state,detail)){terminologyPickerStatus(state,'The catalog entry changed. Search again before choosing a code.',true);return;}
 code.value=detail.code;display.value=detail.display;display.maxLength=state.scope==='diagnosis'?2000:10000;
 if(state.scope==='procedure')state.row.querySelector('[name="code_system"]').value=detail.system;
 state.row.dataset.catalogReleaseId=detail.release_id;state.row.dataset.catalogCode=detail.code;state.row.dataset.catalogDisplay=detail.display;state.row.dataset.catalogSystem=detail.system;
 for(const field of [code,display])field.dispatchEvent(new Event('input',{bubbles:true}));
 state.row.querySelector('[data-terminology-selection]')?.remove();
 const note=document.createElement('p');note.dataset.terminologySelection='';note.className='muted';note.textContent=`Selected from ${terminologyReleaseLabel(detail)}. Save this row to record the catalog reference. Catalog selection does not establish claim acceptance.`;state.row.append(note);
 terminologyPickers.delete(state.host);state.host.remove();display.focus();
}
async function showTerminologyCatalogs(){
 if(me?.role!=='owner')return;
 const account=me,generation=terminologyGeneration;showTool('Terminology catalogs');const host=$('tools');host.className='integration-workspace';host.innerHTML='<p class="muted" data-terminology-loading>Loading installed terminology catalogs…</p>';const loading=host.querySelector('[data-terminology-loading]');
 const result=await api('/api/v1/terminology/releases');if(account!==me||generation!==terminologyGeneration||$('tools')!==host||!loading?.isConnected)return;
 host.innerHTML=`<header class="integration-hero"><div><p class="eyebrow">THIS EHR INSTANCE</p><h2>Terminology catalogs</h2><p>Install versioned code catalogs for diagnosis and procedure lookup. Clinical records keep their recorded code and description.</p></div><button type="button" data-terminology-manage>Refresh catalogs</button></header><section class="integration-section"><h3>Installed releases</h3>${(result.items||[]).map(release=>`<article class="integration-access-row"><div><b>${esc(terminologyReleaseLabel(release))}</b><small>${esc(release.source_name)} · ${Number(release.code_count||release.entry_count||0).toLocaleString()} codes</small><small>${esc(release.rights||'')} ${release.license_valid_until?` · licensed through ${esc(release.license_valid_until)}`:''}</small></div></article>`).join('')||'<p>No terminology releases are installed. Manual code entry remains available.</p>'}${result.next_cursor?'<p class="muted">More releases are available through the terminology API.</p>':''}</section><section class="integration-section"><h3>Import a catalog release</h3><p>Choose a normalized SunCharts catalog JSON file containing its source, edition, effective dates, rights information and codes. CPT imports require a licensed source.</p><form id="terminology-import-form"><label>Catalog JSON file<input type="file" name="catalog" accept="application/json,.json" required data-terminology-file></label><div id="terminology-import-preview" role="status"></div><label>Reason for this import<input name="reason" required maxlength="1000"></label><label class="review-ack"><input type="checkbox" name="rights_attested" required> I have permission to install and use this catalog in this EHR.</label><button type="submit" class="primary">Import reviewed catalog</button></form></section>`;terminologyImport=null;
}
async function previewTerminologyImport(file){
 terminologyImport=null;const revision=++terminologyImportRevision,host=$('terminology-import-preview'),account=me,generation=terminologyGeneration;if(!file||!host)return;
 if(file.size>64*1024*1024)throw new Error('Catalog files must be 64 MiB or smaller.');
 const value=JSON.parse(await file.text());if(account!==me||generation!==terminologyGeneration||revision!==terminologyImportRevision||$('terminology-import-preview')!==host)return;
 if(!value||!Array.isArray(value.codes)||!value.codes.length||value.codes.length>150000||!terminologySystem(value.system))throw new Error('Choose a normalized catalog file with a supported system and 1 to 150,000 codes.');
 terminologyImport={value,account,generation,file};host.textContent=`${terminologyReleaseLabel(value)} · ${value.codes.length.toLocaleString()} codes · source: ${value.source_name||'not provided'} · rights: ${value.rights||'not provided'}. Nothing has been imported yet.`;
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('[data-terminology-open],[data-terminology-close],[data-terminology-search],[data-terminology-more],[data-terminology-select],[data-terminology-manage]');if(!button)return;event.preventDefault();event.stopImmediatePropagation();
 if(button.hasAttribute('data-terminology-manage')){run(showTerminologyCatalogs);return;}
 if(button.dataset.terminologyOpen){run(()=>openTerminologyPicker(button));return;}
 const host=button.closest('[data-terminology-picker]'),state=terminologyPickers.get(host);if(!state)return;
 if(button.hasAttribute('data-terminology-close')){state.request++;terminologyPickers.delete(host);host.remove();state.button.focus();return;}
 if(button.dataset.terminologySelect!==undefined){run(()=>selectTerminologyCode(state,Number(button.dataset.terminologySelect)));return;}
 run(()=>searchTerminology(state,button.hasAttribute('data-terminology-more')));
},true);
document.addEventListener('change',event=>{
 if(event.target.hasAttribute?.('data-terminology-file')){run(()=>previewTerminologyImport(event.target.files[0]));return;}
 if(event.target.hasAttribute?.('data-terminology-release')){const state=terminologyPickers.get(event.target.closest('[data-terminology-picker]'));if(state)invalidateTerminologySearch(state);return;}
 if(!event.target.hasAttribute?.('data-terminology-system'))return;
 const state=terminologyPickers.get(event.target.closest('[data-terminology-picker]'));if(state)run(()=>loadTerminologyReleases(state));
});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.hasAttribute?.('data-terminology-query')){event.preventDefault();event.stopImmediatePropagation();const state=terminologyPickers.get(event.target.closest('[data-terminology-picker]'));if(state)run(()=>searchTerminology(state));}},true);
document.addEventListener('input',event=>{
 if(event.target.matches?.('[data-terminology-query],[data-terminology-date]')){const state=terminologyPickers.get(event.target.closest('[data-terminology-picker]'));if(state)invalidateTerminologySearch(state);return;}
 if(!event.target.matches?.('[name="code"],[name="display"],[name="description"],[name="code_system"]'))return;
 const row=event.target.closest('[data-diagnosis-row],.billing-charge-row');if(!row)return;
 const code=row.querySelector('[name="code"]')?.value,display=row.querySelector('[name="display"],[name="description"]')?.value,system=row.querySelector('[name="code_system"]')?.value||'ICD-10-CM';
 if(code!==row.dataset.catalogCode||display!==row.dataset.catalogDisplay||system!==row.dataset.catalogSystem){delete row.dataset.catalogReleaseId;row.querySelector('[data-terminology-selection]')?.remove();}
});
function invalidateTerminologySearch(state){state.request++;state.items=[];state.nextCursor=null;state.host.querySelector('[data-terminology-results]').replaceChildren();terminologyPickerStatus(state,'Search again after changing the lookup. Existing row values are unchanged.');}
document.addEventListener('submit',event=>{
 const form=event.target;if(form.id!=='terminology-import-form')return;event.preventDefault();event.stopImmediatePropagation();
 run(async()=>{
  const draft=terminologyImport;if(me?.role!=='owner'||!draft||draft.account!==me||draft.generation!==terminologyGeneration||form.elements.catalog.files[0]!==draft.file)throw new Error('Choose and review the catalog file before importing.');
  if(!form.elements.rights_attested.checked)throw new Error('Confirm permission to use this catalog before importing.');
  const allowed=['system','edition','source_name','source_url','source_sha256','effective_start','effective_end','rights','license_reference','license_valid_until','codes'],body=Object.fromEntries(allowed.filter(key=>draft.value[key]!==undefined).map(key=>[key,draft.value[key]]));
  Object.assign(body,{request_id:crypto.randomUUID(),rights_attested:true,reason:form.elements.reason.value});
  await api('/api/v1/terminology/releases','POST',body);if(draft.account!==me||draft.generation!==terminologyGeneration)return;await showTerminologyCatalogs();notice('Catalog release imported into this EHR. Existing clinical and billing records were not rewritten.');
 });
},true);
