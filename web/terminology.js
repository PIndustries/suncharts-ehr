// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let terminologyGeneration=0,terminologyImport=null,terminologyImportRevision=0;
const terminologyPickers=new Map();
const terminologyComboboxes=new Map(),terminologyApplying=new WeakSet();
let terminologyFieldId=0;
const terminologySystems=['ICD-10-CM','ICD-10-PCS','HCPCS','CPT'];
const terminologySystem=value=>({'ICD10CM':'ICD-10-CM','ICD10PCS':'ICD-10-PCS','HCPCS':'HCPCS','CPT':'CPT'})[String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'')]||null;
// Procedures are found by typing in the procedure box itself, so no line carries a separate lookup button.
const terminologyLookupButton=()=>'';
const terminologyCatalogButton=()=>me?.role==='owner'?'<button type="button" data-terminology-manage>Code lists</button>':'';
function renderTerminologyAdminEntry(){return me?.role==='owner'?'<button type="button" data-terminology-manage>Code lists</button>':'';}
function terminologyReleaseLabel(value){return `${value.system||''} · ${value.edition||'Edition not recorded'} · effective ${value.effective_start||'date not recorded'}${value.effective_end?` through ${value.effective_end}`:' onward'}`;}
function terminologySnapshotMarkup(snapshot){return snapshot?`<p class="muted" data-terminology-selection>Recorded from the ${esc(terminologyReleaseLabel(snapshot))} code list. ${esc(snapshot.source_name||'')}</p>`:'';}
function terminologyContextCurrent(state){return state.generation===terminologyGeneration&&state.account===me&&state.host.isConnected&&state.row.isConnected&&state.form.isConnected&&state.patient===selected&&(state.scope!=='diagnosis'||state.visit===activeVisit?.id);}
function clearTerminologySession(){terminologyGeneration++;for(const state of terminologyPickers.values())state.host.remove();terminologyPickers.clear();for(const state of terminologyComboboxes.values())closeTerminologyCombobox(state);terminologyComboboxes.clear();terminologyImport=null;terminologyImportRevision++;}

function terminologyComboboxMarkup(scope,prefix,name,label,max,placeholder,value,system,options={}){return `<div class="terminology-combobox"><label for="${prefix}-${name}">${label}</label><input id="${prefix}-${name}" name="${name}" type="text" value="${esc(value||'')}" maxlength="${max}" ${options.required===false?'':'required '}autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${prefix}-${name}-list" aria-describedby="${prefix}-${name}-status" data-terminology-combobox data-terminology-scope="${scope}"${system?` data-terminology-system="${esc(system)}"`:''} placeholder="${placeholder}"><div class="terminology-suggestions" data-terminology-popup hidden><p id="${prefix}-${name}-status" data-terminology-status role="status" aria-live="polite"></p><ul id="${prefix}-${name}-list" role="listbox" aria-label="${scope==='diagnosis'?'Matching diagnoses':'Matching procedure codes'}" data-terminology-results></ul></div></div>`;}
// One procedure box per charge line. The code and the description the form submits are kept on
// the row as hidden fields under the same names the charge table and the code-list picker read, so
// a single type-ahead answers for both: a choice fills them, a code typed by hand fills them on
// leaving the box, and the box itself always shows the picked line as 'CODE: description'.
function terminologyHiddenField(name,value,max){return `<input type="hidden" name="${name}" value="${esc(value||'')}" maxlength="${max}">`;}
function terminologyProcedureDisplay(line={}){return line.code&&line.description?`${line.code}: ${line.description}`:line.code||line.description||'';}
function terminologyProcedureFields(line={}){
 const prefix=`terminology-field-${++terminologyFieldId}`;
 return terminologyComboboxMarkup('procedure',prefix,'procedure','Procedure',10000,'Type a CPT/HCPCS code or procedure name',terminologyProcedureDisplay(line),'',{required:false})+terminologyHiddenField('code',line.code,100)+terminologyHiddenField('description',line.description,10000);
}
function terminologyDiagnosisFields(row={}){
 const prefix=`terminology-field-${++terminologyFieldId}`;
 return [['code','Code',8,'ICD-10-CM code or diagnosis name'],['display','Description',2000,'Diagnosis name or code']].map(([name,label,max,placeholder])=>terminologyComboboxMarkup('diagnosis',prefix,name,label,max,placeholder,row[name],'ICD-10-CM')).join('');
}
function terminologyAttachCombobox(input,{system,scope}){
 if(!input||!scope)return;
 input._terminologyAttach={scope,system:system||''};
 input.setAttribute?.('data-terminology-combobox','');input.setAttribute?.('data-terminology-scope',scope);
 if(system)input.setAttribute?.('data-terminology-system',system);
}
function clearTerminologyComboboxMarkup(copy){
 copy.querySelectorAll('[data-terminology-popup]').forEach(popup=>{popup.hidden=true;popup.querySelector('[data-terminology-status]').textContent='';popup.querySelector('[data-terminology-results]').replaceChildren();});
 copy.querySelectorAll('[data-terminology-combobox]').forEach(input=>{input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');input.removeAttribute('aria-busy');});
}
function terminologyRowScope(row){return row?.matches?.('[data-diagnosis-row]')?'diagnosis':'procedure';}
function terminologyFieldPair(scope){return scope==='diagnosis'?{code:'code',text:'display'}:{code:'code',text:'description'};}
// A procedure row carries one visible box; its query is what is typed there, and the code and
// description the row submits are read straight out of the row's own hidden fields.
function terminologyVisibleField(scope,row){return scope==='diagnosis'?row.querySelector('[name="display"]'):row.querySelector('[data-terminology-combobox]');}
function terminologyDisplayText(scope,code,description){return scope==='procedure'&&description?`${code}: ${description}`:code||description||'';}
function terminologyFillFields(scope,row,code,description){
 const visible=terminologyVisibleField(scope,row);
 if(visible&&scope==='procedure')visible.value=terminologyDisplayText(scope,code,description);
 else if(visible)visible.value=description;
 const hidden=terminologyFieldPair(scope);
 for(const [name,value] of [[hidden.code,code],[hidden.text,description]]){const field=row.querySelector(`[name="${name}"]`);if(field&&field!==visible)field.value=value;}
 return visible;
}
function terminologyComboboxContext(state){
 return state.generation===terminologyGeneration&&state.account===me&&state.patient===selected&&state.visit===(typeof activeVisit==='undefined'?null:activeVisit?.id||null)&&state.view===terminologyComboboxView()&&state.input.isConnected&&state.row.isConnected&&state.form.isConnected&&!state.input.closest('[hidden]')&&!state.input.disabled&&!state.input.readOnly&&(!state.form.dataset.patient||state.form.dataset.patient===selected);
}
function terminologyComboboxView(){return `${typeof chartSection==='undefined'?'':chartSection}:${typeof encounterSection==='undefined'?'':encounterSection}`;}
function terminologyComboboxValues(state){
 const pair=terminologyFieldPair(state.scope);
 return {query:state.input.value.trim(),system:state.system||(state.scope==='procedure'?terminologySystem(state.row.querySelector('[name="code_system"]')?.value):'')||'',serviceDate:terminologyServiceDate(state.scope,state.form),visit:state.form.elements.visit_id?.value||'',account:state.form.dataset.id||'',version:state.form.dataset.version||'',code:state.row.querySelector(`[name="${pair.code}"]`)?.value||'',description:state.row.querySelector(`[name="${pair.text}"]`)?.value||''};
}
function terminologyComboboxCurrent(state,request,values){
 return terminologyComboboxContext(state)&&request===state.request&&JSON.stringify(values)===JSON.stringify(terminologyComboboxValues(state));
}
function closeTerminologyCombobox(state){
 clearTimeout(state.timer);state.timer=null;state.request++;state.items=[];state.active=-1;state.search=null;
 state.popup.hidden=true;state.list.replaceChildren();state.status.textContent='';state.input.setAttribute('aria-expanded','false');state.input.removeAttribute('aria-activedescendant');state.input.removeAttribute('aria-busy');
}
function terminologyComboboxState(input){
 for(const [field,state] of terminologyComboboxes){if(!terminologyComboboxContext(state)){closeTerminologyCombobox(state);terminologyComboboxes.delete(field);}}
 let state=terminologyComboboxes.get(input);if(state)return state;
 const row=input.closest('[data-diagnosis-row],.billing-charge-row'),host=input.closest('.terminology-combobox');if(!row||!host||input.disabled||input.readOnly)return null;const form=typeof row?.closest==='function'?row.closest('form'):null;if(!form||!form.elements||!form.dataset)return null;
 const scope=terminologyRowScope(row),attach=input._terminologyAttach&&input._terminologyAttach.scope===scope?input._terminologyAttach:{system:input.getAttribute?.('data-terminology-scope')===scope?input.getAttribute?.('data-terminology-system')||'':''};
 state={input,row,form,host,scope,system:attach.system,popup:host.querySelector('[data-terminology-popup]'),list:host.querySelector('[data-terminology-results]'),status:host.querySelector('[data-terminology-status]'),generation:terminologyGeneration,account:me,patient:selected,visit:typeof activeVisit==='undefined'?null:activeVisit?.id||null,view:terminologyComboboxView(),request:0,timer:null,items:[],active:-1,search:null};
 terminologyComboboxes.set(input,state);return state;
}
function terminologyComboboxStatus(state,message){
 state.popup.hidden=false;state.input.setAttribute('aria-expanded','true');state.status.textContent=message;
}
function terminologyComboboxEligible(item,values){
 if(item&&item.practice===true)return typeof item.code==='string'&&item.code!==''&&typeof item.display==='string';
 if(values.procedure)return item&&['CPT','HCPCS'].includes(item.system)&&terminologyComboboxEligible(item,{...values,procedure:false,system:item.system});
 return item&&typeof item.code==='string'&&typeof item.display==='string'&&item.release_id&&item.system===values.system&&item.billable===true&&item.active!==false&&(!item.effective_start||item.effective_start<=values.serviceDate)&&(!item.effective_end||item.effective_end>=values.serviceDate);
}
function renderTerminologyCombobox(state){
 state.list.innerHTML=state.items.map((item,index)=>`<li id="${state.list.id}-option-${index}" role="option" aria-selected="${index===state.active}" data-terminology-option="${index}"><span><b>${esc(item.code)}</b> ${esc(item.display)}</span>${item.practice?'':`<small>${esc(terminologyReleaseLabel(item))}</small>`}</li>`).join('');
 if(state.active<0)state.input.removeAttribute('aria-activedescendant');
 else{const id=`${state.list.id}-option-${state.active}`;state.input.setAttribute('aria-activedescendant',id);state.list.querySelector(`[data-terminology-option="${state.active}"]`)?.scrollIntoView?.({block:'nearest'});}
}
function scheduleTerminologyCombobox(input,immediate=false){
 if(terminologyApplying.has(input.closest('[data-diagnosis-row],.billing-charge-row')))return;
 const state=terminologyComboboxState(input);if(!state)return;
 for(const other of terminologyComboboxes.values())if(other!==state)closeTerminologyCombobox(other);
 closeTerminologyCombobox(state);const values=terminologyComboboxValues(state);
 const allowed=state.scope==='diagnosis'?['ICD-10-CM']:['CPT','HCPCS'];
 if(state.scope!=='procedure'&&!allowed.includes(values.system)){terminologyComboboxStatus(state,state.scope==='diagnosis'?'This diagnosis needs the ICD-10-CM code list. You can still type the code in by hand.':'Choose CPT or HCPCS to search the installed procedure code lists. You can still type the code in by hand.');return;}
 if(state.scope!=='procedure'&&!/^\d{4}-\d{2}-\d{2}$/.test(values.serviceDate)){terminologyComboboxStatus(state,'Enter the service date before searching the code list.');return;}
 if(values.query.length<2){terminologyComboboxStatus(state,'Type at least two characters from a code or name.');return;}
 if(values.query.length>200){terminologyComboboxStatus(state,'Use up to 200 characters to search. Your full description remains available for manual entry.');return;}
 const request=state.request;terminologyComboboxStatus(state,'Searching the code list…');state.input.setAttribute('aria-busy','true');
 state.timer=setTimeout(()=>{state.timer=null;(state.scope==='procedure'?searchProcedureCombobox:searchTerminologyCombobox)(state,request,values);},immediate?0:(state.scope==='diagnosis'?150:250));
}
// A procedure is found by typing: the codes this practice already bills (its fee schedules and
// earlier charges, with the words they were billed under) come first, then any installed CPT or
// HCPCS code list. Nothing has to be chosen before searching.
async function searchProcedureCombobox(state,request,values){
 if(!terminologyComboboxCurrent(state,request,values))return;
 const dated=/^\d{4}-\d{2}-\d{2}$/.test(values.serviceDate),list=system=>dated?api(`/api/v1/terminology/codes?${new URLSearchParams({system,q:values.query,service_date:values.serviceDate,billable:'true',active:'true',limit:'8'})}`).catch(()=>null):Promise.resolve(null);
 const own=selected?api(`/api/v1/patients/${encodeURIComponent(selected)}/procedure-codes?${new URLSearchParams({q:values.query})}`).catch(()=>null):Promise.resolve(null);
 const [mine,cpt,hcpcs]=await Promise.all([own,list('CPT'),list('HCPCS')]);
 if(!terminologyComboboxCurrent(state,request,values))return;
 const search={...values,procedure:true},seen=new Map();state.search=values;
 for(const item of (mine?.items||[]).map(item=>({...item,practice:true})))if(terminologyComboboxEligible(item,search))seen.set(item.code.toUpperCase(),item);
 for(const item of [...(cpt?.items||[]),...(hcpcs?.items||[])]){if(!terminologyComboboxEligible(item,search))continue;const key=item.code.toUpperCase(),known=seen.get(key);if(!known||(known.practice&&!known.display))seen.set(key,item);}
 const query=values.query.toUpperCase();
 state.input.removeAttribute('aria-busy');state.items=[...seen.values()].sort((a,b)=>(b.code.toUpperCase().startsWith(query)-a.code.toUpperCase().startsWith(query))).slice(0,8);state.active=-1;renderTerminologyCombobox(state);
 terminologyComboboxStatus(state,state.items.length?'':'No match. Keep typing, or type the code and leave the box to use it as typed.');
}
async function searchTerminologyCombobox(state,request,values){
 if(!terminologyComboboxCurrent(state,request,values))return;
 try{
  const params=new URLSearchParams({system:values.system,q:values.query,service_date:values.serviceDate,billable:'true',active:'true',limit:'8'}),result=await api(`/api/v1/terminology/codes?${params}`);
  if(!terminologyComboboxCurrent(state,request,values))return;
  state.input.removeAttribute('aria-busy');state.items=(result.items||[]).filter(item=>terminologyComboboxEligible(item,values));state.search=values;state.active=-1;renderTerminologyCombobox(state);
  terminologyComboboxStatus(state,state.items.length?`${state.items.length} matches. Use ↑ and ↓, then Enter, or select a result.${result.next_cursor?' Keep typing to narrow the list.':''}`:result.release===null?`No ${values.system} code list is installed for ${values.serviceDate}. Type a reviewed code and description yourself. A practice owner can install an authorized list under Code lists.`:'No match in the code list. Keep typing or enter a reviewed code and description yourself.');
 }catch(error){if(terminologyComboboxCurrent(state,request,values)){state.input.removeAttribute('aria-busy');terminologyComboboxStatus(state,`The code list search is not available right now: ${error.message}. Your entries are unchanged; you can still type the code in by hand.`);}}
}
async function selectTerminologyCombobox(state,index){
 const values=state.search,item=state.items[index],request=++state.request;state.pendingPick=null;
 const check=values&&state.scope==='procedure'?{...values,procedure:true}:values;
 if(!values||!terminologyComboboxCurrent(state,request,values)||!terminologyComboboxEligible(item,check)){closeTerminologyCombobox(state);return;}
 if(item.practice){
  const visible=terminologyFillFields(state.scope,state.row,item.code,item.display),system=state.row.querySelector('[name="code_system"]');
  terminologyApplying.add(state.row);
  try{if(system&&item.system)system.value=item.system;state.row.querySelector('[data-terminology-selection]')?.remove();closeTerminologyCombobox(state);for(const field of [visible,system])field?.dispatchEvent(new Event('input',{bubbles:true}));}finally{terminologyApplying.delete(state.row);}
  state.input.focus();return;
 }
 state.input.setAttribute('aria-busy','true');terminologyComboboxStatus(state,'Checking the code you selected…');
 try{
  const detail=await api(`/api/v1/terminology/releases/${encodeURIComponent(item.release_id)}/codes/${encodeURIComponent(item.code)}`);
  if(!terminologyComboboxCurrent(state,request,values))return;
  if(detail.release_id!==item.release_id||detail.code!==item.code||!terminologyComboboxEligible(detail,check)){state.input.removeAttribute('aria-busy');terminologyComboboxStatus(state,'This code is no longer available for this service date. Search again; your entries were kept.');return;}
  const visible=terminologyFillFields(state.scope,state.row,detail.code,detail.display),system=state.row.querySelector('[name="code_system"]');
  terminologyApplying.add(state.row);
  try{
   if(system)system.value=detail.system;
   Object.assign(state.row.dataset,{catalogReleaseId:detail.release_id,catalogCode:detail.code,catalogDisplay:detail.display,catalogSystem:detail.system});
   state.row.querySelector('[data-terminology-selection]')?.remove();
   const note=document.createElement('p');note.dataset.terminologySelection='';note.className='muted';note.textContent=`Selected from ${terminologyReleaseLabel(detail)}.${state.scope==='diagnosis'?' Saving this list records which code list it came from.':' Save the charge account to record which code list this came from.'}`;state.row.append(note);
   for(const other of terminologyComboboxes.values())if(other.row===state.row)closeTerminologyCombobox(other);
   for(const field of [visible,system])field?.dispatchEvent(new Event('input',{bubbles:true}));
  }finally{terminologyApplying.delete(state.row);}
  state.input.focus();
 }catch(error){if(terminologyComboboxCurrent(state,request,values)){state.input.removeAttribute('aria-busy');terminologyComboboxStatus(state,`The selected code could not be checked: ${error.message}. Your entries were kept.`);}}
}
function terminologyBoxParts(text){
 // The box holds 'CODE: description'; a code typed on its own is held as a code with no
 // description yet.
 const value=String(text||''),split=value.indexOf(':');
 return split<0?{code:value.trim(),description:''}:{code:value.slice(0,split).trim(),description:value.slice(split+1).trim()};
}
// One of the results on screen is exactly the code that was typed. Leaving the box on that code
// takes the listing, description and all; a code the list has no answer for is kept as typed.
function terminologyExactCodeIndex(state){
 if(state.popup.hidden||!state.items.length||state.search?.query!==state.input.value.trim())return -1;
 const wanted=state.input.value.trim().toUpperCase(),matches=state.items.filter(item=>item.code.toUpperCase()===wanted);
 return matches.length===1?state.items.indexOf(matches[0]):-1;
}
function terminologyAutoPickIndex(state){return terminologyExactCodeIndex(state);}
function terminologyManualCode(state){
 // Nothing was chosen from the list, so what is in the box is what the row submits. A code alone
 // fills the code only and leaves the description for whoever is entering the charge; a code and a
 // description, written the way the box shows them, fill both.
 if(!state||state.scope!=='procedure')return;
 const pair=terminologyFieldPair(state.scope),code=state.row.querySelector(`[name="${pair.code}"]`),description=state.row.querySelector(`[name="${pair.text}"]`);
 if(!code)return;
 const {code:typed,description:detail}=terminologyBoxParts(state.input.value);
 if(!typed||code.value===typed&&(description?.value||'')===detail)return;
 terminologyApplying.add(state.row);
 try{terminologyFillFields(state.scope,state.row,typed,detail);}finally{terminologyApplying.delete(state.row);}
 state.input.dispatchEvent(new Event('input',{bubbles:true}));
}
document.addEventListener('focusin',event=>{
 if(!event.target.matches?.('[data-terminology-combobox]'))return;
 const row=event.target.closest('[data-diagnosis-row],.billing-charge-row');
 if(row?.dataset.catalogReleaseId&&row.querySelector('[name="code"]')?.value===row.dataset.catalogCode&&(row.querySelector('[name="display"]')?.value||row.querySelector('[name="description"]')?.value)===row.dataset.catalogDisplay)return;
 scheduleTerminologyCombobox(event.target);
});
document.addEventListener('focusout',event=>{
 const state=terminologyComboboxes.get(event.target);if(!state)return;
 if(event.relatedTarget?.closest?.('.terminology-combobox')===state.host)return;
 const index=terminologyAutoPickIndex(state);if(state.pendingPick!==null&&state.pendingPick!==undefined){state.pendingPick=null;return;}if(index>=0){event.preventDefault();void selectTerminologyCombobox(state,index);return;}closeTerminologyCombobox(state);terminologyManualCode(state);
});
document.addEventListener('pointerdown',event=>{if(event.target.closest?.('[data-terminology-option]'))event.preventDefault();});
document.addEventListener('click',event=>{
 const option=event.target?.closest?.('[data-terminology-option]');if(!option)return;
 const input=option.closest('.terminology-combobox')?.querySelector('[data-terminology-combobox]'),state=terminologyComboboxes.get(input);if(!state)return;
 event.preventDefault();event.stopImmediatePropagation();selectTerminologyCombobox(state,Number(option.dataset.terminologyOption));
},true);
document.addEventListener('keydown',event=>{
 if(!event.target.matches?.('[data-terminology-combobox]')||event.isComposing)return;
 const state=terminologyComboboxes.get(event.target);
 if(event.key==='Escape'){if(state&&!state.popup.hidden){event.preventDefault();event.stopImmediatePropagation();closeTerminologyCombobox(state);}return;}
 if(event.key==='Tab'){if(state){const index=terminologyAutoPickIndex(state);if(index>=0){state.pendingPick=index;void selectTerminologyCombobox(state,index);}else closeTerminologyCombobox(state);}return;}
 if(['ArrowDown','ArrowUp'].includes(event.key)){
  event.preventDefault();event.stopImmediatePropagation();
  if(!state||state.popup.hidden){scheduleTerminologyCombobox(event.target,true);return;}
  if(state.items.length){state.active=event.key==='ArrowDown'?(state.active+1)%state.items.length:(state.active<=0?state.items.length-1:state.active-1);renderTerminologyCombobox(state);}return;
 }
 if(event.key==='Enter'&&state&&!state.popup.hidden){event.preventDefault();event.stopImmediatePropagation();if(state.active>=0)selectTerminologyCombobox(state,state.active);}
},true);
document.addEventListener('input',event=>{
 if(event.target.matches?.('[data-terminology-combobox]')){if(!event.isComposing)scheduleTerminologyCombobox(event.target);return;}
 if(!event.target.matches?.('[name="code_system"],[name="service_date"],[name="visit_id"]'))return;
 const form=event.target.closest('form');for(const state of terminologyComboboxes.values())if(state.form===form)closeTerminologyCombobox(state);
});
document.addEventListener('compositionend',event=>{if(event.target.matches?.('[data-terminology-combobox]'))scheduleTerminologyCombobox(event.target);});
document.addEventListener('change',event=>{
 if(!event.target.matches?.('[name="code_system"],[name="service_date"],[name="visit_id"]'))return;
 const form=event.target.closest('form');for(const state of terminologyComboboxes.values())if(state.form===form)closeTerminologyCombobox(state);
});
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
 return `<div class="section-head"><h4>${state.scope==='diagnosis'?'Find a diagnosis':'Find a procedure'}</h4><button type="button" data-terminology-close>Close</button></div><div class="form-grid"><label>Search by code or name<input data-terminology-query maxlength="200" autocomplete="off" value="${esc(state.query)}" placeholder="Enter a code or a name"></label></div><button type="button" data-terminology-search>Search</button><details><summary>More options</summary><div class="form-grid"><label>Code system<select data-terminology-system>${allowed.map(system=>`<option value="${system}" ${system===state.system?'selected':''}>${system}</option>`).join('')}</select></label><label>Service date<input type="date" data-terminology-date value="${esc(state.serviceDate)}" required></label><label>Code list version<select data-terminology-release><option value="">Latest version effective on this date</option></select></div></details><p data-terminology-status role="status" aria-live="polite">Loading code list versions…</p><div data-terminology-results></div>`;
}
async function openTerminologyPicker(button){
 const scope=button.dataset.terminologyOpen,row=button.closest(scope==='diagnosis'?'[data-diagnosis-row]':'.billing-charge-row'),form=row?.closest('form');if(!row||!form||scope!=='procedure')return;
  const host=document.createElement('section');host.className='amendment';host.dataset.terminologyPicker='';host.setAttribute('aria-label','Terminology lookup');
 const system=scope==='diagnosis'?'ICD-10-CM':terminologySystem(row.querySelector('[name="code_system"]')?.value)||'CPT';
 const state={scope,row,form,host,button,system,serviceDate:terminologyServiceDate(scope,form),query:row.querySelector('[name="code"]')?.value||row.querySelector('[data-terminology-combobox]')?.value||'',patient:selected,visit:typeof activeVisit!=='undefined'?activeVisit?.id:null,account:me,generation:terminologyGeneration,request:0,items:[],releases:[]};
  terminologyPickers.set(host,state);host.innerHTML=terminologyPickerMarkup(state);row.append(host);host.querySelector('[data-terminology-query]').focus();
  await loadTerminologyReleases(state);
  if(state.query.trim().length>=2&&terminologyContextCurrent(state))await searchTerminology(state);
}
async function loadTerminologyReleases(state){
 const request=++state.request,system=state.host.querySelector('[data-terminology-system]').value;
 state.items=[];state.host.querySelector('[data-terminology-results]').replaceChildren();
 try{
  const result=await api(`/api/v1/terminology/releases?${new URLSearchParams({system})}`);
  if(!terminologyContextCurrent(state)||request!==state.request)return;
  state.system=system;state.releases=result.items||[];
  state.host.querySelector('[data-terminology-release]').innerHTML='<option value="">Latest release effective on this date</option>'+state.releases.map(release=>`<option value="${esc(release.id||release.release_id)}">${esc(terminologyReleaseLabel(release))}</option>`).join('');
   terminologyPickerStatus(state,state.releases.length?'Enter at least two characters and search. Results are filtered for billable codes effective on the service date.':`No ${system} code list is installed here. You can still type the code in by hand. An owner can import a suitable list under Practice administration → Code lists.`);
  }catch(error){if(terminologyContextCurrent(state)&&request===state.request)terminologyPickerStatus(state,`The code search is not available right now: ${error.message}. Existing entries are unchanged; you can still type the code in by hand.`,true);}
}
function renderTerminologyResults(state){
 const results=state.host.querySelector('[data-terminology-results]');
 results.innerHTML=state.items.map((item,index)=>`<article class="integration-access-row"><div><b>${esc(item.code)} · ${esc(item.display)}</b></div><button type="button" data-terminology-select="${index}" title="${esc(`${terminologyReleaseLabel(item)} · ${item.source_name||'Source not recorded'} · ${item.billable?'Billable code':'Not billable'}${item.active===false?' · Inactive':''}`)}" ${item.active===false||!item.billable?'disabled':''}>Use this</button></article>`).join('')+(state.nextCursor?'<button type="button" data-terminology-more>More matching codes</button>':'');
}
async function searchTerminology(state,more=false){
 const system=state.host.querySelector('[data-terminology-system]').value,serviceDate=terminologyPickerCurrentDate(state),query=state.host.querySelector('[data-terminology-query]').value.trim(),release=state.host.querySelector('[data-terminology-release]').value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)){terminologyPickerStatus(state,'Choose the visit or charge service date before searching.',true);return;}
 if(query.length<2){terminologyPickerStatus(state,'Enter at least two characters from a code or description.',true);return;}
 const append=more&&state.search?.system===system&&state.search?.serviceDate===serviceDate&&state.search?.query===query&&state.search?.release===release,request=++state.request,params=new URLSearchParams({system,q:query,service_date:serviceDate,billable:'true',limit:'20'});
 if(release)params.set('release_id',release);if(append&&state.nextCursor)params.set('after',state.nextCursor);
  terminologyPickerStatus(state,'Searching the code list…');
 try{
  const result=await api(`/api/v1/terminology/codes?${params}`);
  if(!terminologyContextCurrent(state)||request!==state.request)return;
  state.items=append?[...state.items,...(result.items||[])]:result.items||[];state.nextCursor=result.next_cursor||null;state.search={system,serviceDate,query,release};renderTerminologyResults(state);
   terminologyPickerStatus(state,state.items.length?`${state.items.length} found.`:'No matching billable codes were found for this date and code list version. Check the date, the search, or the list. You can still type the code in by hand.');
 }catch(error){if(terminologyContextCurrent(state)&&request===state.request)terminologyPickerStatus(state,`Search could not finish: ${error.message}. Existing entries are unchanged.`,true);}
}
function terminologySelectionCurrent(state,item){
 const search=state.search;return terminologyContextCurrent(state)&&search&&state.host.querySelector('[data-terminology-system]').value===search.system&&terminologyPickerCurrentDate(state)===search.serviceDate&&state.host.querySelector('[data-terminology-query]').value.trim()===search.query&&state.host.querySelector('[data-terminology-release]').value===search.release&&item.active!==false&&item.billable&&(!item.effective_start||item.effective_start<=search.serviceDate)&&(!item.effective_end||item.effective_end>=search.serviceDate);
}
async function selectTerminologyCode(state,index){
 const item=state.items[index];if(!item||!terminologySelectionCurrent(state,item)){terminologyPickerStatus(state,'The lookup context changed. Search again before choosing a code.',true);return;}
 const pair=terminologyFieldPair(state.scope),code=state.row.querySelector(`[name="${pair.code}"]`),display=state.row.querySelector(`[name="${pair.text}"]`),visible=terminologyVisibleField(state.scope,state.row),system=state.row.querySelector('[name="code_system"]'),before=[code.value,display.value,system?.value,terminologyServiceDate(state.scope,state.form)];
 const request=++state.request,detail=await api(`/api/v1/terminology/releases/${encodeURIComponent(item.release_id)}/codes/${encodeURIComponent(item.code)}`);
 if(request!==state.request||!terminologySelectionCurrent(state,item))return;
 if(JSON.stringify(before)!==JSON.stringify([code.value,display.value,system?.value,terminologyServiceDate(state.scope,state.form)])){terminologyPickerStatus(state,'The row or service date changed while loading the code. Your edits were kept; search again before selecting.',true);return;}
 if(detail.code!==item.code||detail.release_id!==item.release_id||!terminologySelectionCurrent(state,detail)){terminologyPickerStatus(state,'This code changed since the search. Search again before choosing a code.',true);return;}
 const filled=terminologyFillFields(state.scope,state.row,detail.code,detail.display);
 if(display)display.maxLength=state.scope==='diagnosis'?2000:10000;
 if(state.scope==='procedure')system.value=detail.system;
 state.row.dataset.catalogReleaseId=detail.release_id;state.row.dataset.catalogCode=detail.code;state.row.dataset.catalogDisplay=detail.display;state.row.dataset.catalogSystem=detail.system;
 for(const field of new Set([code,display,filled].filter(Boolean)))field.dispatchEvent(new Event('input',{bubbles:true}));
 state.row.querySelector('[data-terminology-selection]')?.remove();
 const note=document.createElement('p');note.dataset.terminologySelection='';note.className='muted';note.textContent=`Selected from ${terminologyReleaseLabel(detail)}. Save this row to record which code list it came from. Choosing a code here does not mean the claim will be accepted.`;state.row.append(note);
 terminologyPickers.delete(state.host);state.host.remove();(filled||display).focus();
}
async function showTerminologyCatalogs(){
 if(me?.role!=='owner')return;
  const account=me,generation=terminologyGeneration;showTool('Code lists');const host=$('tools');host.className='integration-workspace';host.innerHTML='<p class="muted" data-terminology-loading>Loading the installed code lists…</p>';const loading=host.querySelector('[data-terminology-loading]');
 const result=await api('/api/v1/terminology/releases');if(account!==me||generation!==terminologyGeneration||$('tools')!==host||!loading?.isConnected)return;
  host.innerHTML=`<header class="integration-hero"><div><p class="eyebrow">THIS EHR INSTANCE</p><h2>Code lists</h2><p>Install dated diagnosis and procedure code lists for lookups. Clinical records keep the code and description recorded with them.</p></div><button type="button" data-terminology-manage>Refresh code lists</button></header><section class="integration-section"><h3>Installed versions</h3>${(result.items||[]).map(release=>`<article class="integration-access-row"><div><b>${esc(terminologyReleaseLabel(release))}</b><small>${esc(release.source_name)} · ${Number(release.code_count||release.entry_count||0).toLocaleString()} codes</small><small>${esc(release.rights||'')} ${release.license_valid_until?` · licensed through ${esc(release.license_valid_until)}`:''}</small></div></article>`).join('')||'<p>No code lists are installed yet. You can still type codes in by hand.</p>'}${result.next_cursor?'<p class="muted">More code list versions are available.</p>':''}</section><section class="integration-section"><h3>Import a code list</h3><p>Choose a SunCharts code list data file with its source, edition, effective dates, rights information and codes. CPT imports require a licensed source.</p><form id="terminology-import-form"><label>Code list data file<input type="file" name="catalog" accept="application/json,.json" required data-terminology-file></label><div id="terminology-import-preview" role="status"></div><label>Reason for this import<input name="reason" required maxlength="1000"></label><label class="review-ack"><input type="checkbox" name="rights_attested" required> I have permission to install and use this code list in this EHR.</label><button type="submit" class="primary">Import reviewed code list</button></form></section>`;terminologyImport=null;
}
async function previewTerminologyImport(file){
 terminologyImport=null;const revision=++terminologyImportRevision,host=$('terminology-import-preview'),account=me,generation=terminologyGeneration;if(!file||!host)return;
  if(file.size>64*1024*1024)throw new Error('Code list files must be 64 MiB or smaller.');
  const value=JSON.parse(await file.text());if(account!==me||generation!==terminologyGeneration||revision!==terminologyImportRevision||$('terminology-import-preview')!==host)return;
  if(!value||!Array.isArray(value.codes)||!value.codes.length||value.codes.length>150000||!terminologySystem(value.system))throw new Error('Choose a valid code list file with a supported system and 1 to 150,000 codes.');
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
   const draft=terminologyImport;if(me?.role!=='owner'||!draft||draft.account!==me||draft.generation!==terminologyGeneration||form.elements.catalog.files[0]!==draft.file)throw new Error('Choose and review the code list file before importing.');
   if(!form.elements.rights_attested.checked)throw new Error('Confirm permission to use this code list before importing.');
  const allowed=['system','edition','source_name','source_url','source_sha256','effective_start','effective_end','rights','license_reference','license_valid_until','codes'],body=Object.fromEntries(allowed.filter(key=>draft.value[key]!==undefined).map(key=>[key,draft.value[key]]));
  Object.assign(body,{request_id:crypto.randomUUID(),rights_attested:true,reason:form.elements.reason.value});
   await api('/api/v1/terminology/releases','POST',body);if(draft.account!==me||draft.generation!==terminologyGeneration)return;await showTerminologyCatalogs();notice('The code list was imported into this EHR. Existing clinical and billing records were not rewritten.');
 });
},true);
