// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let terminologyGeneration=0,terminologyImport=null,terminologyImportRevision=0;
const terminologyPickers=new Map();
// The owner's Codes & prices screen. Codes here are the practice's own list: the charge line's
// dropdown offers these first, at the price written next to them, and a code list turned off here
// stops answering lookups for everybody.
const practiceCodes={sets:[],items:[],status:'',addStatus:'',searchTimer:null,searchRequest:0,search:[],loaded:false};
const terminologyComboboxes=new Map(),terminologyApplying=new WeakSet();
let terminologyFieldId=0;
const terminologySystems=['ICD-10-CM','ICD-10-PCS','HCPCS','CPT'];
const terminologySystem=value=>({'ICD10CM':'ICD-10-CM','ICD10PCS':'ICD-10-PCS','HCPCS':'HCPCS','CPT':'CPT'})[String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'')]||null;
// Procedures are found by typing in the procedure box itself, so no line carries a separate lookup button.
const terminologyLookupButton=()=>'';
const terminologyCatalogButton=()=>me?.role==='owner'?'<button type="button" data-terminology-manage>Codes &amp; prices</button>':'';
function renderTerminologyAdminEntry(){return me?.role==='owner'?'<button type="button" data-terminology-manage>Codes &amp; prices</button>':'';}
function terminologyReleaseLabel(value){return `${value.system||''} · ${value.edition||'Edition not recorded'} · effective ${value.effective_start||'date not recorded'}${value.effective_end?` through ${value.effective_end}`:' onward'}`;}
function terminologySnapshotMarkup(snapshot){return snapshot?`<p class="muted" data-terminology-selection>Recorded from the ${esc(terminologyReleaseLabel(snapshot))} code list. ${esc(snapshot.source_name||'')}</p>`:'';}
function terminologyContextCurrent(state){return state.generation===terminologyGeneration&&state.account===me&&state.host.isConnected&&state.row.isConnected&&state.form.isConnected&&state.patient===selected&&(state.scope!=='diagnosis'||state.visit===activeVisit?.id);}
function clearTerminologySession(){terminologyGeneration++;for(const state of terminologyPickers.values())state.host.remove();terminologyPickers.clear();for(const state of terminologyComboboxes.values())closeTerminologyCombobox(state);terminologyComboboxes.clear();terminologyImport=null;terminologyImportRevision++;practiceCodesReset();}

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
// Choosing one of the practice's own codes fills what the practice recorded with it: the default
// units, the modifiers, and the amount for the whole line (the price per unit times those units),
// written the way the amount field is read back by the charge table.
function terminologyPracticeLineFields(row,item){
 const fields=[];
 const units=row.querySelector('[name="units"]'),unitsValue=Math.trunc(Number(item.default_units));
 if(units&&unitsValue>=1&&unitsValue<=9999){units.value=String(unitsValue);fields.push(units);}
 const modifiers=row.querySelector('[name="modifiers"]');
 if(modifiers&&typeof item.modifiers==='string'){modifiers.value=item.modifiers;fields.push(modifiers);}
 const amount=row.querySelector('[name="amount"]'),price=Math.trunc(Number(item.price_cents));
 // Number(null) is 0, so a code with no price of its own is caught here and the amount is
 // left as staff left it.
 if(amount&&item.price_cents!=null&&Number.isSafeInteger(price)&&price>=0){amount.value=terminologyDollars(price*(Math.trunc(Number(units?.value))||1));fields.push(amount);}
 return fields;
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
// A price is only ever shown as dollars and cents; anything the server does not answer with a
// usable number of cents simply shows no price.
function terminologyDollars(value){const cents=Math.trunc(Number(value));return Number.isSafeInteger(cents)&&cents>=0?`${Math.trunc(cents/100)}.${String(cents%100).padStart(2,'0')}`:'';}
function renderTerminologyCombobox(state){
 // A code the practice keeps on its own list shows its price on the right; a code list shows
 // which list it came from.
 state.list.innerHTML=state.items.map((item,index)=>{const price=item.practice&&item.price_cents!=null?terminologyDollars(item.price_cents):'';return `<li id="${state.list.id}-option-${index}" role="option" aria-selected="${index===state.active}" data-terminology-option="${index}"><span><b>${esc(item.code)}</b> ${esc(item.display)}</span>${price?`<small data-terminology-price>$${price}</small>`:item.practice?'':`<small>${esc(terminologyReleaseLabel(item))}</small>`}</li>`;}).join('');
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
  // The practice's own codes come first, in the order the practice's list answers them; a code
  // list only fills a gap the practice list leaves, and never overwrites a code already there.
  const practice=(items,source)=>{for(const raw of items||[]){const item={...raw,practice:source==='practice',source};if(!terminologyComboboxEligible(item,search))continue;const key=item.code.toUpperCase(),known=seen.get(key);if(!known||(source==='catalog'&&known.source!=='catalog'))seen.set(key,item);}};
  practice(mine?.items,'practice');
  practice([...(cpt?.items||[]),...(hcpcs?.items||[])],'catalog');
  const query=values.query.toUpperCase();
  // What was typed head-on first, then the practice's own order; nothing else outranks it.
  state.input.removeAttribute('aria-busy');state.items=[...seen.entries()].map(([key,item],index)=>({item,index,lead:key.startsWith(query)?1:0})).sort((a,b)=>b.lead-a.lead||a.index-b.index).map(entry=>entry.item).slice(0,8);state.active=-1;renderTerminologyCombobox(state);
  terminologyComboboxStatus(state,state.items.length?'':mine&&mine.disabled===true?'Procedure codes are turned off for this practice. Type the code by hand.':'No match. Keep typing, or type the code and leave the box to use it as typed.');
}
async function searchTerminologyCombobox(state,request,values){
 if(!terminologyComboboxCurrent(state,request,values))return;
 try{
  const params=new URLSearchParams({system:values.system,q:values.query,service_date:values.serviceDate,billable:'true',active:'true',limit:'8'}),result=await api(`/api/v1/terminology/codes?${params}`);
  if(!terminologyComboboxCurrent(state,request,values))return;
   state.input.removeAttribute('aria-busy');state.items=(result.items||[]).filter(item=>terminologyComboboxEligible(item,values));state.search=values;state.active=-1;renderTerminologyCombobox(state);
   terminologyComboboxStatus(state,result.disabled===true?`${values.system} codes are turned off for this practice. Type the code by hand.`:state.items.length?`${state.items.length} matches. Use ↑ and ↓, then Enter, or select a result.${result.next_cursor?' Keep typing to narrow the list.':''}`:result.release===null?`No ${values.system} code list is installed for ${values.serviceDate}. Type a reviewed code and description yourself. A practice owner can install an authorized list under Codes & prices.`:'No match in the code list. Keep typing or enter a reviewed code and description yourself.');
 }catch(error){if(terminologyComboboxCurrent(state,request,values)){state.input.removeAttribute('aria-busy');terminologyComboboxStatus(state,`The code list search is not available right now: ${error.message}. Your entries are unchanged; you can still type the code in by hand.`);}}
}
async function selectTerminologyCombobox(state,index){
 const values=state.search,item=state.items[index],request=++state.request;state.pendingPick=null;
 const check=values&&state.scope==='procedure'?{...values,procedure:true}:values;
 if(!values||!terminologyComboboxCurrent(state,request,values)||!terminologyComboboxEligible(item,check)){closeTerminologyCombobox(state);return;}
  if(item.practice){
   const visible=terminologyFillFields(state.scope,state.row,item.code,item.display),system=state.row.querySelector('[name="code_system"]');
   terminologyApplying.add(state.row);
   try{
    if(system&&item.system)system.value=item.system;
    state.row.querySelector('[data-terminology-selection]')?.remove();
    // The practice's own line: its units, its modifiers and its price, put on the row in the shape
    // the row's own fields expect them. A code with no price leaves the amount alone.
    const filled=[visible,system];
    if(state.scope==='procedure'){for(const field of terminologyPracticeLineFields(state.row,item))filled.push(field);}
    closeTerminologyCombobox(state);
    for(const field of filled)field?.dispatchEvent(new Event('input',{bubbles:true}));
   }finally{terminologyApplying.delete(state.row);}
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
   terminologyPickerStatus(state,state.releases.length?'Enter at least two characters and search. Results are filtered for billable codes effective on the service date.':`No ${system} code list is installed here. You can still type the code in by hand. An owner can import a suitable list under Practice administration → Codes &amp; prices.`);
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
// The owner's Codes & prices screen: which code sets staff may look up, the practice's own codes
// and their prices, and — folded away underneath — the installed code lists and the file import.
const CODE_SET_SYSTEMS=['ICD-10-CM','HCPCS','CPT','ICD-10-PCS'];
// This file is also loaded by UI tests that stub only what the screen under test touches, so the
// debounce is reached for defensively rather than assumed.
const scheduleLater=(fn,delay)=>typeof setTimeout==='function'?setTimeout(fn,delay):0;
const cancelLater=handle=>{if(handle&&typeof clearTimeout==='function')clearTimeout(handle);};
function practiceCodesReset(){practiceCodes.sets=[];practiceCodes.items=[];practiceCodes.status='';practiceCodes.addStatus='';practiceCodes.search=[];practiceCodes.loaded=false;cancelLater(practiceCodes.searchTimer);practiceCodes.searchTimer=null;practiceCodes.searchRequest++;}
function practiceCodesCurrent(host){return host?.isConnected&&$('tools')===host;}
function practiceCodesSetRow(set){
 return `<div class="integration-access-row" data-code-set-row="${esc(set.system)}"><div><b>${esc(set.system)}</b><small>${set.installed?'Installed':'Not installed'}</small></div><label class="check"><input type="checkbox" data-code-set-toggle="${esc(set.system)}" data-code-set-version="${esc(set.version)}" ${set.enabled?'checked':''}> ${set.enabled?'Staff can look these codes up':'Turned off'}</label><small data-code-set-status="${esc(set.system)}" role="status"></small></div>`;
}
function practiceCodesMarkup(sets,releases){
 return `<section class="integration-section" data-code-sets><h3>Code sets</h3><p>Turn a code set off and staff stop seeing these codes in lookups. Nothing recorded is changed.</p>${CODE_SET_SYSTEMS.map(system=>practiceCodesSetRow(sets.find(set=>set.system===system)||{system,enabled:true,version:0,installed:false})).join('')}</section>`;
}
function practiceCodesAddRow(item){
 const key=`${item.system} ${item.code}`.replace(/[^A-Za-z0-9]/g,'-');
 return `<article class="integration-access-row" data-code-add-row="${esc(key)}"><div><b>${esc(item.code)}</b> · ${esc(item.display)}<small>${esc(item.system)}</small></div><button type="button" data-code-add="${esc(key)}" data-code-add-system="${esc(item.system)}" data-code-add-code="${esc(item.code)}" data-code-add-display="${esc(item.display)}">Add</button></article>`;
}
function practiceCodesMyCodesMarkup(){
 return `<section class="integration-section" data-practice-codes><h3>My codes</h3><p>The codes this practice charges for, with the price staff see when they pick one on a charge line. Turning a code off takes it out of the dropdowns; nothing recorded is deleted.</p><label>Find a code to add<input type="search" data-code-search placeholder="Code or name" autocomplete="off" maxlength="200"></label><p class="muted" data-code-add-status role="status">Type at least two characters to search the installed code lists.</p><div data-code-add-results></div><div class="practice-table-wrap"><table class="practice-table"><caption class="sr-only">The practice’s codes</caption><thead><tr><th>On</th><th>Code</th><th>Description</th><th>Price</th><th>Units</th><th>Modifiers</th></tr></thead><tbody data-practice-code-rows>${practiceCodes.items.map(practiceCodeRowMarkup).join('')||'<tr><td colspan="6">No codes yet. Find one above and add it.</td></tr>'}</tbody></table></div><label>Filter these codes<input type="search" data-code-filter placeholder="Code, description or modifier" autocomplete="off"></label><p class="muted" data-practice-code-empty hidden>No codes match this filter.</p></section>`;
}
function practiceCodeRowMarkup(item){
 const price=item.price_cents==null?'':terminologyDollars(item.price_cents);
 return `<tr data-code-row="${esc(item.id)}" data-code-row-id="${esc(item.id)}" data-code-row-version="${esc(item.version??0)}" data-code-row-system="${esc(item.system)}" data-code-row-code="${esc(item.code)}"><td><label class="check"><input type="checkbox" name="enabled" ${item.enabled?'checked':''}> On</label></td><td><b>${esc(item.code)}</b><small>${esc(item.system)}</small></td><td><input name="display" value="${esc(item.display)}" maxlength="1000"></td><td><input name="price" inputmode="decimal" value="${esc(price)}" placeholder="No price"></td><td><input name="units" type="number" min="1" max="9999" step="1" value="${esc(item.default_units)}"></td><td><input name="modifiers" value="${esc(item.modifiers||'')}" maxlength="11" placeholder="26"></td><td><small data-code-status="${esc(item.id)}" role="status"></small></td></tr>`;
}
function practiceCodesCatalogsMarkup(releases){
 // Public code lists install themselves and CPT installs with the license box, so there is no
 // file to choose here: the owner only reads what is installed.
 return `${terminologyCptSection(releases.items||[])}<details class="integration-section" data-installed-code-lists><summary>Installed code lists</summary><section class="integration-section"><h3>Installed versions</h3>${(releases.items||[]).map(release=>`<article class="integration-access-row"><div><b>${esc(terminologyReleaseLabel(release))}</b><small>${esc(release.source_name)} · ${Number(release.code_count||release.entry_count||0).toLocaleString()} codes</small></div></article>`).join('')||'<p>No code lists are installed yet. They install themselves within a few minutes.</p>'}${releases.next_cursor?'<p class="muted">More code list versions are available.</p>':''}</section></details>`;
}
async function showTerminologyCatalogs(){
 if(me?.role!=='owner')return;
 const account=me,generation=terminologyGeneration;showTool('Codes & prices');const host=$('tools');host.className='integration-workspace';host.innerHTML='<p class="muted" data-terminology-loading>Loading your codes and prices…</p>';const loading=host.querySelector('[data-terminology-loading]');
 const [sets,result,codes]=await Promise.all([
  api('/api/v1/practice/code-sets').catch(()=>null),
  api('/api/v1/terminology/releases').catch(()=>({items:[]})),
  api('/api/v1/practice/codes').catch(()=>null)]);
 if(account!==me||generation!==terminologyGeneration||$('tools')!==host||!loading?.isConnected)return;
 practiceCodes.sets=sets?.items||[];practiceCodes.items=codes?.items||[];practiceCodes.loaded=true;
 host.innerHTML=`<header class="integration-hero"><div><p class="eyebrow">THIS PRACTICE</p><h2>Codes &amp; prices</h2><p>Choose which code sets staff can look up, keep the codes you charge for, and set the price each one starts a charge line at. Clinical records keep the code and description recorded with them.</p></div><button type="button" data-terminology-manage>Refresh codes and prices</button></header>${practiceCodesMarkup(practiceCodes.sets,result)}${practiceCodesMyCodesMarkup()}${practiceCodesCatalogsMarkup(result)}`;terminologyImport=null;
}
async function saveCodeSet(system,enabled,version,status,toggle){
 status.textContent='Saving…';
 try{
  const item=await api(`/api/v1/practice/code-sets/${encodeURIComponent(system)}`,'PUT',{enabled},version);
  const set=practiceCodes.sets.find(entry=>entry.system===system);
  if(set&&item&&typeof item.version==='number'){set.version=item.version;set.enabled=!!item.enabled;}
  // The switch keeps the version the server answered, so the next flip saves against it.
  if(toggle&&item&&item.version!==undefined)toggle.dataset.codeSetVersion=String(item.version);
  if(toggle&&item)toggle.checked=!!item.enabled;
  status.textContent=enabled?'':'Turned off: staff will not see these codes in lookups.';
 }catch(error){status.textContent=error.message;}
}
async function loadPracticeCodeSearch(host,query){
 const request=++practiceCodes.searchRequest,systems=['CPT','HCPCS','ICD-10-CM'],serviceDate=new Date().toISOString().slice(0,10);
 const answers=await Promise.all(systems.map(system=>api(`/api/v1/terminology/codes?${new URLSearchParams({system,q:query,service_date:serviceDate,billable:'true',limit:'20'})}`).catch(()=>null)));
 if(request!==practiceCodes.searchRequest||!practiceCodesCurrent(host))return;
 const seen=new Set(),items=[];
 for(const answer of answers)for(const item of answer?.items||[]){const key=`${item.system}:${item.code}`.toUpperCase();if(seen.has(key))continue;seen.add(key);items.push(item);}
 practiceCodes.search=items;
 const results=host.querySelector('[data-code-add-results]'),status=host.querySelector('[data-code-add-status]');
 if(!items.length){results.innerHTML='';status.textContent='No installed code list has a match. You can still add the code by hand below.';return;}
 results.innerHTML=items.slice(0,60).map(practiceCodesAddRow).join('');
 status.textContent=`${items.length} match${items.length===1?'':'es'}. Adding puts the code in your list with no price yet.`;
}
async function addPracticeCode(button,host){
 const status=host.querySelector('[data-code-add-status]'),account=me;
 status.textContent='Adding…';
 try{
  const item=await api('/api/v1/practice/codes','POST',{request_id:crypto.randomUUID(),system:button.dataset.codeAddSystem,code:button.dataset.codeAddCode,display:button.dataset.codeAddDisplay,enabled:true,price_cents:null,default_units:1,modifiers:''});
  if(account!==me||!practiceCodesCurrent(host))return;
  if(!practiceCodes.items.some(entry=>entry.id===item.id))practiceCodes.items.push(item);
  renderPracticeCodeRows(host);
  host.querySelector(`[data-code-add="${button.dataset.codeAdd}"]`)?.setAttribute('disabled','');
  status.textContent=`${item.code} added. Set its price when you know it.`;
 }catch(error){if(account===me)status.textContent=error.message;}
}
function renderPracticeCodeRows(host){
 const rows=host.querySelector('[data-practice-code-rows]');if(!rows)return;
 rows.innerHTML=practiceCodes.items.map(practiceCodeRowMarkup).join('')||'<tr><td colspan="6">No codes yet. Find one above and add it.</td></tr>';
 filterPracticeCodes(host);
}
function filterPracticeCodes(host){
 const needle=(host.querySelector('[data-code-filter]')?.value||'').trim().toLowerCase();
 const rows=[...host.querySelectorAll('[data-code-row]')];let shown=0;
 for(const row of rows){
  const text=`${row.dataset.codeRowSystem} ${row.dataset.codeRowCode} ${row.querySelector('[name="display"]')?.value||''} ${row.querySelector('[name="modifiers"]')?.value||''}`.toLowerCase();
  const match=!needle||text.includes(needle);row.hidden=!match;if(match)shown++;
 }
 const empty=host.querySelector('[data-practice-code-empty]');if(empty)empty.hidden=shown>0;
}
function practiceCodePriceCents(value){
 const text=String(value??'').trim().replace(/[$\s]/g,'');
 if(text==='')return null;
 if(!/^\d+(\.\d{1,2})?$/.test(text))return undefined;
 const [whole,fraction='']=text.split('.'),cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 return Number.isSafeInteger(cents)&&cents<=10000000?cents:undefined;
}
function practiceCodeModifiersValid(value){return value===''||/^[A-Z0-9]{2}( [A-Z0-9]{2}){0,3}$/.test(value);}
function practiceCodeStatus(row){return row.querySelector(`[data-code-status="${row.dataset.codeRowId}"]`)||row.querySelector('[data-code-status]');}
async function savePracticeCode(host,row){
 const status=practiceCodeStatus(row),account=me,version=Number(row.dataset.codeRowVersion||0);
 const display=row.querySelector('[name="display"]').value.trim(),price=practiceCodePriceCents(row.querySelector('[name="price"]').value),
  units=Math.trunc(Number(row.querySelector('[name="units"]').value)),modifiers=(row.querySelector('[name="modifiers"]')?.value||'').trim(),
  enabled=!!row.querySelector('[name="enabled"]').checked;
 if(!display){status.textContent='Enter the description.';return;}
 if(price===undefined){status.textContent='Enter the price in dollars, up to two decimal places.';return;}
 if(!(units>=1&&units<=9999)){status.textContent='Enter units between 1 and 9999.';return;}
 if(!practiceCodeModifiersValid(modifiers)){status.textContent='Modifiers are up to four two-character codes, separated by single spaces.';return;}
 status.textContent='Saving…';
 try{
  const item=await api(`/api/v1/practice/codes/${encodeURIComponent(row.dataset.codeRowId)}`,'PUT',{display,enabled,price_cents:price,default_units:units,modifiers},version);
  if(account!==me||!practiceCodesCurrent(host))return;
  Object.assign(item,{});const index=practiceCodes.items.findIndex(entry=>entry.id===item.id);if(index>=0)practiceCodes.items[index]=item;
  row.dataset.codeRowVersion=String(item.version??'0');
  row.querySelector('[name="display"]').value=item.display;row.querySelector('[name="price"]').value=item.price_cents==null?'':terminologyDollars(item.price_cents);
  row.querySelector('[name="units"]').value=String(item.default_units);row.querySelector('[name="modifiers"]').value=item.modifiers||'';row.querySelector('[name="enabled"]').checked=!!item.enabled;
  status.textContent='Saved';
 }catch(error){if(account===me)status.textContent=error.message;}
}

// CPT is licensed by the AMA, so it is never shipped. A practice that holds a CPT license says
// so here and the server fetches the official CMS file and installs CPT for this practice only.
function terminologyCptSection(releases){
 const installed=releases.find(release=>release.system==='CPT');
 if(installed)return `<section class="integration-section" data-cpt-section><h3>CPT codes</h3><p>CPT codes installed: ${esc(installed.edition)}, ${Number(installed.code_count||0).toLocaleString()} codes.</p></section>`;
 return `<section class="integration-section" data-cpt-section><h3>CPT codes</h3><p>CPT codes and descriptions are licensed by the American Medical Association. If your practice holds a CPT license, install them here and the procedure box will find every CPT code as staff type.</p><form id="terminology-cpt-form"><label class="review-ack"><input type="checkbox" name="license_attested" required> Our practice holds a current CPT license from the American Medical Association</label><p role="status" data-cpt-status></p><button type="submit" class="primary">Install CPT codes</button></form></section>`;
}
async function installTerminologyCpt(form){
 const fields=form.elements,status=form.querySelector('[data-cpt-status]'),button=form.querySelector('button[type="submit"]'),account=me;
 if(!fields.license_attested.checked){status.textContent='Confirm that your practice holds a CPT license.';return;}
 button.disabled=true;button.textContent='Installing… this takes up to a minute';status.textContent='';
 try{
  const result=await api('/api/v1/terminology/cpt-install','POST',{request_id:crypto.randomUUID(),license_attested:true});
  if(account!==me)return;
  status.textContent=`Installed ${Number(result.release?.code_count||0).toLocaleString()} CPT codes.`;
  await showTerminologyCatalogs();
 }catch(error){
  if(account!==me)return;
  status.textContent=error.message;button.disabled=false;button.textContent='Install CPT codes';
 }
}
document.addEventListener('submit',event=>{
  const form=event.target;if(form?.id!=='terminology-cpt-form')return;
  event.preventDefault();event.stopImmediatePropagation();void installTerminologyCpt(form);
});
// Codes & prices: the switches, the search-as-you-type, the Add buttons and the price table.
function practiceCodesHost(){if(typeof $!=='function')return null;const host=$('tools');return host?.querySelector('[data-practice-codes]')?host:null;}
function practiceCodesSilent(){let text='';return {set textContent(value){text=String(value);},get textContent(){return text;}};}
document.addEventListener('change',event=>{
  const toggle=event.target.closest?.('[data-code-set-toggle]');
  if(toggle){const host=practiceCodesHost(),status=host?.querySelector(`[data-code-set-status="${toggle.dataset.codeSetToggle}"]`)||practiceCodesSilent();void saveCodeSet(toggle.dataset.codeSetToggle,toggle.checked,Number(toggle.dataset.codeSetVersion)||0,status,toggle);return;}
  const row=event.target.closest?.('[data-code-row]'),host=practiceCodesHost();
  if(!row||!host)return;
  if(event.target.name==='enabled'){void savePracticeCode(host,row);return;}
  if(['display','price','units','modifiers'].includes(event.target.name))void savePracticeCode(host,row);
});
document.addEventListener('focusout',event=>{
  const row=event.target.closest?.('[data-code-row]'),host=practiceCodesHost();
  if(!row||!host)return;
  if(!['display','price','units','modifiers'].includes(event.target.name))return;
  void savePracticeCode(host,row);
});
document.addEventListener('input',event=>{
  if(event.target.matches?.('[data-code-filter]')){const host=practiceCodesHost();if(host)filterPracticeCodes(host);return;}
  if(!event.target.matches?.('[data-code-search]'))return;
  const host=practiceCodesHost(),query=event.target.value.trim();
  if(!host)return;
  cancelLater(practiceCodes.searchTimer);
  if(query.length<2){practiceCodes.searchRequest++;practiceCodes.search=[];host.querySelector('[data-code-add-results]').innerHTML='';host.querySelector('[data-code-add-status]').textContent='Type at least two characters to search the installed code lists.';return;}
  practiceCodes.searchTimer=scheduleLater(()=>{practiceCodes.searchTimer=null;void loadPracticeCodeSearch(host,query);},200);
});

async function previewTerminologyImport(file){
 terminologyImport=null;const revision=++terminologyImportRevision,host=$('terminology-import-preview'),account=me,generation=terminologyGeneration;if(!file||!host)return;
  if(file.size>64*1024*1024)throw new Error('Code list files must be 64 MiB or smaller.');
  const value=JSON.parse(await file.text());if(account!==me||generation!==terminologyGeneration||revision!==terminologyImportRevision||$('terminology-import-preview')!==host)return;
  if(!value||!Array.isArray(value.codes)||!value.codes.length||value.codes.length>150000||!terminologySystem(value.system))throw new Error('Choose a valid code list file with a supported system and 1 to 150,000 codes.');
 terminologyImport={value,account,generation,file};host.textContent=`${terminologyReleaseLabel(value)} · ${value.codes.length.toLocaleString()} codes · source: ${value.source_name||'not provided'} · rights: ${value.rights||'not provided'}. Nothing has been imported yet.`;
}
document.addEventListener('click',event=>{
 const add=event.target.closest?.('[data-code-add]');
 if(add){event.preventDefault();const host=practiceCodesHost();if(host)run(()=>addPracticeCode(add,host));return;}
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
