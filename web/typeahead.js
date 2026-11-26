// SPDX-License-Identifier: AGPL-3.0-only
// Type-as-you-go picker shared by the payer and pharmacy steps. Matches appear while the
// person types, so nobody has to press a Find or Search button. The visible box carries the
// name in plain words; the hidden field carries the id the form submits.
/* global esc, human, payerName */
'use strict';
const typeaheadStates=new WeakMap(),typeaheadHosts=new WeakMap(),typeaheadLive=new Set(),typeaheadRendered=new WeakSet(),typeaheadProviders=new Map();
let typeaheadSequence=0;
// typeaheadProvide(name,provider) — how a screen registers the records its picker boxes offer:
// 'typeaheadPayerChoices', 'typeaheadCoverageOptions', 'typeaheadPharmacyChoices' or
// 'typeaheadBatchPayerOptions', each returning the rows to search through.
function typeaheadProvide(name,provider){if(typeof provider==='function')typeaheadProviders.set(name,provider);return provider;}
// The picker's own markup, to sit inside the field's <label> next to the name box.
function typeaheadMarkup(name,id,idValue=''){
 return `<input type="hidden" name="${name}_id" data-typeahead-id value="${esc(idValue||'')}"><div class="typeahead-suggestions" data-typeahead-host><p id="${id}-status" data-typeahead-status role="status" aria-live="polite"></p><ul id="${id}-list" role="listbox" aria-label="Matching choices" data-typeahead-results hidden></ul></div>`;
}
function typeaheadIdFor(input){return input.id||`typeahead-${++typeaheadSequence}`;}
// The picker's popup is drawn as the name box's next sibling, inside the same <label> or
// <fieldset>. Either way the box and its results belong to one enclosing block, which is what
// the picker reads its list, status line and hidden id out of.
function typeaheadHostFor(input){return input.closest?.('[data-typeahead-host]')||input.parentElement;}
function typeaheadFormFor(input){
 if(input.form)return input.form;
 for(let current=input;current;current=current.parentElement)if(current.tagName==='FORM')return current;
 return null;
}
function typeaheadRows(state){return Array.from(state.list.children).filter(row=>row.dataset.typeaheadIndex!==undefined);}
function typeaheadOptionMarkup(state,item,index){
 const second=state.sub?String(state.sub(item)||'').trim():'';
 return `<li id="${state.list.id}-option-${index}" role="option" aria-selected="false" data-typeahead-index="${index}"><b>${esc(state.label(item)||'')}</b>${second?`<small>${esc(second)}</small>`:''}</li>`;
}
function typeaheadOpen(state){
 state.input.setAttribute('aria-expanded','true');
 if(state.list.hidden){state.list.hidden=false;state.status.hidden=true;}
}
function typeaheadHide(state){
 state.list.hidden=true;state.list.innerHTML='';state.status.textContent='';state.status.hidden=false;
 state.input.setAttribute('aria-expanded','false');state.input.removeAttribute('aria-activedescendant');
}
function typeaheadClose(state){
 clearTimeout(state.timer);state.timer=null;state.request++;state.pending=null;
 state.items=[];state.active=-1;typeaheadHide(state);
 state.input.removeAttribute('aria-busy');
}
// The small line above the results: how many matched, or why nothing did. The list itself is
// a separate node so a screen-reader already reading it is not disturbed by the counter.
function typeaheadStatus(state,message){
 if(message===undefined){typeaheadHide(state);return;}
 typeaheadOpen(state);state.status.hidden=false;state.status.textContent=message;
}
function typeaheadResults(state,message){
 if(message===undefined){typeaheadHide(state);return;}
 typeaheadOpen(state);
 // The count is read out through the live status line; the list is labelled with the same words
 // and left visible, so staff can see what is on offer while a screen reader reads it out.
 state.status.hidden=false;state.status.textContent=message||'';
 if(message)state.list.setAttribute('aria-label',message);else state.list.removeAttribute('aria-label');
}
function typeaheadMark(state){
 const rows=typeaheadRows(state);
 rows.forEach((row,index)=>row.setAttribute('aria-selected',String(index===state.active)));
 if(state.active<0||!rows[state.active]){state.input.removeAttribute('aria-activedescendant');return;}
 state.input.setAttribute('aria-activedescendant',`${state.list.id}-option-${state.active}`);
 rows[state.active].scrollIntoView?.({block:'nearest'});
}
function typeaheadShow(state,items,notice){
 state.items=items.slice(0,state.limit);
 // The list opens with nothing picked. Staff move to a row with ↑ and ↓ (or the mouse) and
 // press Enter; the first row is not silently the choice.
 state.active=-1;
 state.list.innerHTML=state.items.map((item,index)=>typeaheadOptionMarkup(state,item,index)).join('');
 for(const row of typeaheadRows(state))if(!typeaheadRendered.has(row)){row.setAttribute('role','option');typeaheadRendered.add(row);}
 typeaheadResults(state,notice);typeaheadMark(state);
}
const typeaheadNone='Nothing matches that yet. Keep typing a little more, or clear the box and start again.';
function typeaheadMatchNotice(state){
 return state.input.value.trim()?'Use ↑ and ↓, then Enter.':'Keep typing to narrow the list, or use ↑ and ↓ to choose one.';
}
function typeaheadScore(query,item,state){
 const name=String(state.label(item)||'').trim().toLowerCase(),second=String(state.sub?.(item)||'').trim().toLowerCase();
 if(!query)return 4;
 if(name===query)return 0;
 if(name.startsWith(query))return 1;
 if(name.includes(query))return 2;
 if(second&&second.includes(query))return 3;
 return -1;
}
function typeaheadSort(state,query,items){
 const scored=(items||[]).map(item=>({item,score:typeaheadScore(query,item,state)})).filter(row=>row.score>=0);
 scored.sort((a,b)=>a.score-b.score||String(state.label(a.item)||'').localeCompare(String(state.label(b.item)||'')));
 return scored.map(row=>row.item);
}
function typeaheadQuery(state){return state.input.value.trim().toLowerCase();}
async function typeaheadFetch(state,query){
 const request=state.request;
 state.input.setAttribute('aria-busy','true');
 try{
  const returned=await state.load(query);
  if(request!==state.request||!state.input.isConnected)return;
  state.input.removeAttribute('aria-busy');state.pending=null;
  const items=Array.isArray(returned)?returned:[],matches=state.serverMatches?items:typeaheadSort(state,query,items);
  if(!matches.length){typeaheadClose(state);typeaheadStatus(state,typeaheadNone);return;}
  typeaheadShow(state,matches,`${matches.length} match${matches.length===1?'':'es'} from the ${state.sourceLabel}. ${typeaheadMatchNotice(state)}`);
 }catch(error){
  if(request!==state.request||!state.input.isConnected)return;
  state.input.removeAttribute('aria-busy');state.pending=null;
  typeaheadClose(state);typeaheadStatus(state,`The ${state.sourceLabel} could not be searched just now: ${error.message}. What you typed is still here.`);
 }
}
// Matches come from the records already on screen. When nothing on screen matches and the
// screen knows how to ask its own service, that search runs on its own after a short pause.
// What the records on screen offer for what has been typed. An empty box lists everything, so a
// screen never has to pre-load a full list just so staff can see their options.
function typeaheadKnown(state,query){
 let items=[];
 try{items=state.all()||[];}catch{return null;}
 if(!Array.isArray(items))return null;
 return typeaheadSort(state,query,items);
}
function typeaheadRefresh(state,immediate=false){
 if(!state.input.isConnected||state.input.disabled||state.input.readOnly){typeaheadClose(state);return;}
 // A box still holding the name it was drawn with lists everything when opened, that name first:
 // staff came to reconsider a value, and a list of one looks like nothing to change. Once they
 // type, it filters down again, so the full list is never in the way.
 const query=state.picked&&state.input.value===state.picked?'':typeaheadQuery(state);
 clearTimeout(state.timer);state.timer=null;
 const known=typeaheadKnown(state,query);
 if(known!==null){
  state.request++;state.pending=null;
  if(known.length){typeaheadShow(state,known,`${known.length} match${known.length===1?'':'es'}. ${typeaheadMatchNotice(state)}`);return;}
  if(!query){typeaheadClose(state);return;}
  if(!state.load){typeaheadClose(state);typeaheadStatus(state,typeaheadNone);return;}
 }
 if(!query){state.request++;typeaheadClose(state);return;}
 state.pending=true;const request=++state.request;
 typeaheadStatus(state,'Searching for that…');
 state.timer=setTimeout(()=>{state.timer=null;if(state.pending===true&&state.request===request)void typeaheadFetch(state,query);},immediate?0:200);
}
function typeaheadCommit(state,item){
 if(!item)return;
 state.request++;clearTimeout(state.timer);state.timer=null;state.pending=null;
 // The label is the only thing this writes back into the box, so the edit that follows is
 // never mistaken for the person changing their mind.
 state.picking=true;
 try{
  state.input.value=state.label(item)||'';state.idField.value=item.id;state.picked=state.input.value;
 }finally{state.picking=false;}
 typeaheadClose(state);
 state.onPick?.(item);
}
// Fills the pair from elsewhere on the screen (a saved record, a choice made in another step).
function typeaheadSetValue(input,id,label){
 const state=typeaheadStates.get(input);if(!state)return;
 typeaheadClose(state);
 state.picking=true;
 try{
  state.idField.value=id||'';
  state.input.value=label!==undefined?label:(id?String(state.label(state.all().find(row=>row.id===id)||{})||''):'');
  state.picked=state.input.value;
 }finally{state.picking=false;}
}
// Fills a box a screen drew itself — a plain name input plus a hidden field of its own — so a
// choice made elsewhere on the page still lands on the pair the form submits.
function typeaheadFill(name,id,label){
 const input=document.querySelector(`[name="${name}_name"]`)||document.getElementById(`${name}-name`);
 if(!input)return false;
 const hidden=document.querySelector(`[name="${name}_id"]`);
 const state=typeaheadStates.get(input);
 if(state){typeaheadSetValue(input,id,label);return true;}
 if(hidden)hidden.value=id||'';
 input.value=label||'';
 return true;
}
// Typing a name that matches exactly one record, then tabbing or clicking away, chooses it.
function typeaheadTabPick(state){
 const query=typeaheadQuery(state);
 if(state.idField.value||!query||state.picked===state.input.value)return;
 const exact=typeaheadSort(state,query,state.all()).filter(item=>String(state.label(item)||'').trim().toLowerCase()===query);
 if(exact.length===1)typeaheadCommit(state,exact[0]);
}
function typeaheadFocus(state){if(state.list.hidden)typeaheadRefresh(state);}
function typeaheadBlur(state){typeaheadTabPick(state);typeaheadClose(state);}
function typeaheadKeydown(state,event){
 if(event.isComposing)return;
 if(event.key==='Escape'){if(!state.list.hidden){event.preventDefault();event.stopPropagation();typeaheadClose(state);}return;}
 if(event.key==='Tab'){typeaheadTabPick(state);typeaheadClose(state);return;}
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){
  event.preventDefault();
  const rows=typeaheadRows(state);
  if(state.list.hidden||!rows.length){typeaheadRefresh(state,true);return;}
  // Nothing is highlighted to begin with, so the first press lands on the first row from the
  // top going down, and on the last row coming up from the bottom. From a highlighted row the
  // arrow moves on and wraps at either end.
  const forward=event.key==='ArrowDown';
  if(state.active<0)state.active=forward?0:rows.length-1;
  else state.active=forward?(state.active+1)%rows.length:(state.active+rows.length-1)%rows.length;
  typeaheadMark(state);return;
 }
 if(event.key!=='Enter'||state.list.hidden||!typeaheadRows(state).length)return;
 event.preventDefault();event.stopPropagation();
 if(state.active>=0)typeaheadCommit(state,state.items[state.active]);
}
function typeaheadInput(state){
 if(state.pending){state.pending=null;state.request++;}
 if(!state.picking)state.idField.value='';
 typeaheadRefresh(state);
}
// attachTypeahead(input,{load,label,sub,onPick}) — load(query) returns the items to offer,
// from records already on screen or from the search that screen already uses. label and sub
// are the name and the small second line (payer ID, city). onPick runs after a choice.
function attachTypeahead(input,options={}){
 if(!input||input.tagName!=='INPUT')return null;
 const existing=typeaheadStates.get(input);if(existing)return existing;
 const host=typeaheadHostFor(input),list=host?.querySelector?.('[data-typeahead-results]'),status=host?.querySelector?.('[data-typeahead-status]');
 // A screen that redraws this box is a new box. Forget the old binding so staff type into the
 // picker, never into a plain text field the page quietly replaced.
 const previous=typeaheadHosts.get(host)||typeaheadHosts.get(input);
 if(previous&&previous.list!==list)previous.forget();
 if(!list||!status)return null;
 const form=typeaheadFormFor(input),name=input.name||'value';
 let idField=input.dataset.typeaheadSelf==='true'?input:(form?.elements?.[`${name}_id`]||host.querySelector('[data-typeahead-id]')||null);
 if(!idField){idField=document.createElement('input');idField.type='hidden';idField.name=`${name}_id`;input.insertAdjacentElement('afterend',idField);}
 input.id=typeaheadIdFor(input);
 input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');
 input.setAttribute('aria-controls',list.id);input.setAttribute('aria-describedby',status.id);
 input.setAttribute('autocomplete','off');input.setAttribute('spellcheck','false');
 if(options.clearable)input.required=false;
 if(!input.getAttribute('placeholder'))input.setAttribute('placeholder','Start typing a name');
 const state={input,idField,list,status,host,form,
  load:typeof options.load==='function'?options.load:null,
  all:typeof options.all==='function'?options.all:(options.load?null:(()=>[])),
  label:options.label||(item=>String(item?.name??'')),sub:options.sub||null,onPick:options.onPick||null,
  sourceLabel:options.sourceLabel||'insurance company list',serverMatches:options.serverMatches===true,
  limit:options.limit||12,request:0,timer:null,items:[],active:-1,pending:null,picked:'',
  onInput:()=>typeaheadInput(state),onFocus:()=>typeaheadFocus(state),onBlur:()=>typeaheadBlur(state),
  onKeydown:event=>typeaheadKeydown(state,event),onSubmit:()=>typeaheadTabPick(state)};
 typeaheadStates.set(input,state);typeaheadHosts.set(host,state);typeaheadHosts.set(input,state);typeaheadLive.add(state);
 // A box drawn already holding a name — a saved preference, a value carried over from another
 // step — is a decided value, so opening it lists everything to choose from, that name first.
 if(input.value)state.picked=input.value;
 input.addEventListener('input',state.onInput);
 input.addEventListener('focus',state.onFocus);
 input.addEventListener('blur',state.onBlur);
 input.addEventListener('keydown',state.onKeydown);
 form?.addEventListener?.('submit',state.onSubmit);
 // Called when the screen replaces this markup: forgets the binding so the new box is wired
 // fresh and the detached nodes are not kept alive.
 state.forget=()=>{
  input.removeEventListener('input',state.onInput);input.removeEventListener('focus',state.onFocus);
  input.removeEventListener('blur',state.onBlur);input.removeEventListener('keydown',state.onKeydown);
  state.form?.removeEventListener?.('submit',state.onSubmit);
  typeaheadStates.delete(input);
  if(typeaheadHosts.get(host)===state)typeaheadHosts.delete(host);
  if(typeaheadHosts.get(input)===state)typeaheadHosts.delete(input);
  typeaheadLive.delete(state);
 };
 // A node the page no longer holds is a stale binding, not an existing one.
 const disconnect=()=>{state.forget();return true;};
 // A box drawn with a saved id but no name gets its name back from the records on screen.
 if(!input.value&&idField.value){
  const item=(state.all?.()||[]).find(row=>row.id===idField.value);
  if(item){input.value=state.label(item)||'';state.picked=input.value;}
 }
 return state;
}
// A screen hands the picker a function returning the records it owns, by calling typeaheadProvide
// as it renders. The screen is written first and knows what it holds; the picker never reaches
// into another file's scope, and a screen that is not on the page simply offers nothing.
function typeaheadSource(name,fallback,...args){
 const provider=typeaheadProviders.get(name);
 if(typeof provider!=='function')return fallback;
 try{const items=provider(...args);return Array.isArray(items)?items:fallback;}catch{return fallback;}
}
function typeaheadPayers(){return typeaheadSource('typeaheadPayerChoices',[]);}
// The payer records, for a screen that needs to name one outside its own picker box.
function typeaheadPayerOptions(){return typeaheadPayers();}
function typeaheadCoverages(){return typeaheadSource('typeaheadCoverageOptions',[]);}
function typeaheadBatchPayers(){return typeaheadSource('typeaheadBatchPayerOptions',[]);}
function typeaheadPharmacies(name,savedId){return typeaheadSource('typeaheadPharmacyOptions',[],name,savedId);}
// Wires up every picker box drawn into the page. Called by each screen right after its
// Wires up every picker box drawn into the page. Called by each screen right after its
// render, and once at load; boxes already wired are left alone. A screen may hand this a host
// it has not finished drawing, or one that is not a node at all, so a missing answer is simply
// "no boxes here" rather than a failed render.
function typeaheadBoxes(root){
 const scope=root&&root.querySelectorAll?root:document;
 const found=scope.querySelectorAll?.('[data-typeahead-payer],[data-typeahead-pharmacy],[data-typeahead-coverage],[data-typeahead-batch]');
 return Array.from(found||[]);
}
function typeaheadInit(root){
 for(const input of typeaheadBoxes(root)){
  if(typeaheadStates.has(input))continue;
  if(input.hasAttribute('data-typeahead-payer'))attachTypeahead(input,{all:typeaheadPayers,label:item=>item?.content?.name||'',sub:item=>[item?.content?.payer_code||'Insurance company ID not recorded',item?.content?.active===false?'Not active':null].filter(Boolean).join(' · ')});
  else attachTypeahead(input,{all:input.hasAttribute('data-typeahead-batch')?typeaheadBatchPayers:input.hasAttribute('data-typeahead-coverage')?typeaheadCoverages:(()=>typeaheadPharmacies(input.getAttribute('data-typeahead-pharmacy-box')||input.name.replace(/_name$/,''),input.getAttribute('data-typeahead-saved'))),clearable:input.getAttribute('data-typeahead-pharmacy')==='optional',label:item=>item?.name||'',sub:item=>item?.detail||''});
 }
}
if(typeof document.addEventListener==='function'){
 document.addEventListener('pointerdown',event=>{if(event.target.closest?.('[data-typeahead-index]'))event.preventDefault();});
 document.addEventListener('click',event=>{
   const row=event.target?.closest?.('[data-typeahead-index]');if(!row)return;
   // The row's block holds the name box, so the click resolves to the box it belongs to.
   const block=row.closest('[data-typeahead-host]')?.parentElement||row.parentElement;
   const state=typeaheadHosts.get(block)||typeaheadStates.get(block?.querySelector('[data-typeahead-payer],[data-typeahead-pharmacy],[data-typeahead-coverage],[data-typeahead-batch]'));if(!state)return;
  event.preventDefault();event.stopPropagation();
  typeaheadCommit(state,state.items[Number(row.dataset.typeaheadIndex)]);
 },true);
 if(typeof MutationObserver!=='undefined'){
  // A safety net for any screen that forgets to call typeaheadInit after its own render.
  // The picker writes only into its own results list, so mutations inside a wired host are
  // the list redrawing itself and must never be treated as freshly drawn markup.
  const observer=new MutationObserver(records=>{
   for(const record of records)for(const node of record.addedNodes){
    if(node.nodeType!==1||node.closest?.('[data-typeahead-host]'))continue;
    sweep();
    if(node.matches?.('[data-typeahead-payer],[data-typeahead-pharmacy],[data-typeahead-coverage],[data-typeahead-batch]')||node.querySelector?.('[data-typeahead-payer],[data-typeahead-pharmacy],[data-typeahead-coverage],[data-typeahead-batch]'))typeaheadInit(node);
   }
  });
  // A picker remembers the results list it writes into. When a screen throws that markup away
  // the binding must go with it, so the replacement box is wired afresh.
  const stale=node=>node?.isConnected===false;
  const sweep=()=>{for(const state of [...typeaheadLive])if(stale(state.list)||stale(state.input))state.forget();};
  const start=()=>{typeaheadInit(document);observer.observe(document.body,{childList:true,subtree:true});};
  if(document.readyState==='complete')start();
  else document.addEventListener('DOMContentLoaded',start,{once:true});
 }
}
if(typeof window!=='undefined'){
 window.attachTypeahead=attachTypeahead;window.typeaheadInit=typeaheadInit;window.typeaheadSetValue=typeaheadSetValue;window.typeaheadFill=typeaheadFill;window.typeaheadMarkup=typeaheadMarkup;
 window.typeaheadPayerOptions=typeaheadPayerOptions;
 // Registers a screen's records with the picker: typeaheadProvide('typeaheadPayerChoices',fn).
 window.typeaheadProvide=typeaheadProvide;
}
