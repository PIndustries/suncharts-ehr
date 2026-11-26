// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The owner's Codes & prices screen, and the charge line dropdown it feeds.
//
// The server half of this feature is built against the same contract at the same time, so every
// route here is answered by a stub that holds that contract exactly: GET /practice/code-sets always
// answers all four systems (a system with no settings row answers enabled at version 0), a PUT to
// /practice/code-sets/{system} needs the version in If-Match and answers the item, the practice's
// codes are read, created and updated with their prices and limits, and /terminology/codes answers
// disabled:true for a system the practice turned off. Nothing below is real: every code, price,
// description and date is synthetic, and no request leaves the stub.
//
// No npm packages. The markup terminology.js writes is parsed into the same small hand-written
// element stubs scripts/test_charge_table_live_ui.cjs uses, the screen is driven through the
// handlers it installs on the document, and the dropdown is driven through the row stub
// scripts/test_procedure_autocomplete_ui.cjs uses, extended with the units, modifiers and amount
// fields a real charge line carries so a pick can be read back off the row.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/terminology.js','utf8'),billingSource=fs.readFileSync('web/billing.js','utf8');
const SYSTEMS=['ICD-10-CM','HCPCS','CPT','ICD-10-PCS'];
const tick=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
const settle=async()=>{for(let n=0;n<60;n++)await new Promise(resolve=>setImmediate(resolve));};

const money=c=>'$'+(c/100).toFixed(2),dollars=c=>c==null?'':`${Math.trunc(c/100)}.${String(c%100).padStart(2,'0')}`;

// ---- the hand-written DOM (the slice these screens use) ---------------------------------------
const PROP_ALIAS={colspan:'colSpan'};
const VOID_TAGS=new Set(['input','br','img','meta','link','hr','source']);
const insideSelect={depth:0};
function parseMarkup(html){
 const stack=[],roots=[],re=/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;let last=0,match;
 const top=()=>stack.length?stack[stack.length-1]:null;
 const push=node=>{let depth=stack.length;while(depth>0&&stack[depth-1].autoClose)depth--;const parent=depth?stack[depth-1]:null;if(parent){parent.children.push(node);node.parent=parent;}else roots.push(node);};
 while((match=re.exec(html))){
  const text=html.slice(last,match.index);if(text&&top())top()._text+=text;last=re.lastIndex;
  const[whole,tagRaw,attrText,selfClose]=match,tag=tagRaw.toLowerCase();
  if(whole.startsWith('</')){for(let i=stack.length-1;i>=0;i--)if(stack[i].tag===tag){stack.length=i;break;}continue;}
  const node=makeNode(tag);
  for(const part of attrText.trim()==='/'?[]:attrText.match(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)||[]){
   const m=/^([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?$/.exec(part.trim());if(!m)continue;
   const name=m[1].toLowerCase(),value=m[2]!==undefined?m[2]:m[3]!==undefined?m[3]:true;
   if(value===true){node.attrs[name]=true;if(name==='open')node.open=true;if(name==='hidden')node.hidden=true;if(name==='checked')node.checked=true;if(name==='disabled')node.disabled=true;}
   else{node.attrs[name]=String(value);node.dataset[camel(name)]=String(value);if(name==='value')node._value=String(value);if(name==='name')node.name=String(value);if(name==='checked')node.checked=String(value)!=='false';if(PROP_ALIAS[name])node[PROP_ALIAS[name]]=String(value);}
  }
  push(node);
  if(tag==='select')insideSelect.depth++;
  if(['p','option','li'].includes(tag))node.autoClose=true;
  if(!selfClose&&!VOID_TAGS.has(tag))stack.push(node);
 }
 if(top())top()._text+=html.slice(last);
 return roots;
}
function camel(name){return name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());}
const dashed=key=>key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
let uid=0;
function makeNode(tag){
 const node={_id:++uid,tag:tag||'fragment',attrs:Object.create(null),dataset:Object.create(null),children:[],_text:'',parent:null,_value:'',open:false,hidden:false,checked:false,disabled:false,isConnected:true};
 Object.defineProperty(node,'value',{get:()=>node.tag==='select'?(node.children[node.selectSelected??0]?.attrs.value??''):node._value,set:v=>{node._value=String(v);}});
 Object.defineProperty(node,'textContent',{get(){return node._text+node.children.map(child=>child.textContent).join('');},set(t){node._text=String(t);node.children.length=0;}});
 Object.defineProperty(node,'innerHTML',{get(){return (node._text||'')+node.children.map(child=>child.outerHTML).join('');},set(html){for(const child of node.children){child.parent=null;child.isConnected=false;}node.children=[];node._text='';for(const child of parseMarkup(String(html)))insertChild(node,child);}});
 Object.defineProperty(node,'outerHTML',{get(){return serialize(node);}});
 Object.defineProperty(node,'firstElementChild',{get(){return node.children[0]??null;}});
 Object.defineProperty(node,'lastElementChild',{get(){return node.children.at(-1)??null;}});
 Object.defineProperty(node,'elements',{get(){const list=[];for(const f of queryAll(node,'input,select,textarea'))if(!list.some(seen=>seen.name===(f.attrs.name||'')))list.push({name:f.attrs.name||'',node:f});const proxy=list.slice();for(const e of list)if(!(e.name in proxy))proxy[e.name]=e.node;return proxy;}});
 node.setAttribute=(name,value)=>{name=String(name).toLowerCase();node.attrs[name]=String(value);node.dataset[camel(name)]=String(value);if(name==='value')node._value=String(value);if(name==='name')node.name=String(value);};
 node.getAttribute=name=>{const v=node.attrs[String(name).toLowerCase()];return v===undefined?null:v===true?'':v;};
 node.hasAttribute=name=>String(name).toLowerCase() in node.attrs;
 node.removeAttribute=name=>{delete node.attrs[String(name).toLowerCase()];};
 node.closest=selector=>{const parts=String(selector).trim().split(/\s+/);let at=node;while(at){if(parts.every((part,i)=>i===parts.length-1?matchesSimple(at,part):queryAll(at,parts.slice(i).join(' ')).length))return at;at=at.parent;}return null;};
 node.contains=other=>{let at=other;while(at){if(at===node)return true;at=at.parent;}return false;};
 node.querySelector=selector=>queryAll(node,selector)[0]||null;
 node.querySelectorAll=selector=>queryAll(node,selector);
 node.append=(...parts)=>{for(const part of parts)if(typeof part==='string')node._text+=part;else{part.parent?.children.splice(part.parent.children.indexOf(part),1);insertChild(node,part);}};
 node.replaceChildren=(...parts)=>{for(const child of node.children){child.parent=null;child.isConnected=false;}node.children=[];node._text='';node.append(...parts);};
 node.remove=()=>{if(!node.parent)return;const at=node.parent.children.indexOf(node);if(at>=0)node.parent.children.splice(at,1);node.parent=null;node.isConnected=false;};
 node.insertAdjacentHTML=(where,html)=>{for(const child of parseMarkup(String(html))){insertChild(node,child);}};
 node.focus=()=>{};node.scrollIntoView=()=>{};
 node.dispatchEvent=event=>{let at=node;while(at){for(const fn of handlers[event.type]||[])fn({...event,target:at});at=at.parent;}return true;};
 node.matches=selector=>matchesSimple(node,selector);
 return node;
}
function insertChild(parent,child){child.parent=parent;parent.children.push(child);}
function matchesSimple(node,selector){return String(selector).split(',').some(one=>matchOne(node,one.trim()));}
function matchOne(node,selector){
 const not=/:not\(([^)]+)\)/.exec(selector);
 if(not&&matchOne(node,not[1]))return false;
 if(not)selector=selector.replace(not[0],'');
 const classes=selector.match(/\.[\w-]+/g)||[];let rest=selector.replace(/\.[\w-]+/g,'');
 const ids=selector.match(/#[\w-]+/g)||[];rest=rest.replace(/#[\w-]+/g,'');
 const attribs=rest.match(/\[[^\]]+\]/g)||[];rest=rest.replace(/\[[^\]]+\]/g,'');
 if(!/^(\*|[a-zA-Z][\w-]*)?$/.test(rest))return false;
 if(rest&&rest!=='*'&&node.tag!==rest.toLowerCase())return false;
 if(!ids.every(id=>node.attrs.id===id.slice(1)))return false;
 const classNames=String(node.attrs.class||'').split(/\s+/);
 if(!classes.every(name=>classNames.includes(name.slice(1))))return false;
 return attribs.every(expression=>{
  const m=/^\[([:\w-]+)(?:\s*(=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(expression.trim());
  const name=m[1].toLowerCase();
  if(!(name in node.attrs))return false;
  if(m[2]===undefined)return true;
  const want=m[3]!==undefined?m[3]:m[4]!==undefined?m[4]:m[5]||'';
  return String(node.attrs[name]===true?'':node.attrs[name])===want;});
}
function queryAll(node,selector){
 const parts=String(selector).trim().split(/\s+/);
 if(parts.length<2){const out=[];collect(node,selector,out);return out;}
 const out=[];collect(node,parts.at(-1),out);
 return out.filter(candidate=>{let at=candidate.parent;for(let i=parts.length-2;i>=0;i--){let found=false;while(at){if(matchesSimple(at,parts[i])){found=true;break;}at=at.parent;}if(!found)return false;}return true;});
}
function collect(node,selector,out){for(const child of node.children){if(matchesSimple(child,selector))out.push(child);collect(child,selector,out);}}
function serialize(node){
 const attrs=Object.entries(node.attrs).map(([name,value])=>value===true?` ${name}`:` ${name}="${value}"`).join('');
 if(node.tag==='input'){const attrs2=node._value!==''?attrs.replace(/\svalue="[^"]*"/,'')+` value="${node._value}"`:attrs;return `<input${attrs2}${node.checked?' checked':''}>`;}
 const inner=(node._text||'')+node.children.map(child=>child.outerHTML).join('');
 return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}
const handlers={};
const documentStub={documentElement:makeNode('html'),activeElement:null,createElement:tag=>makeNode(String(tag).toLowerCase()),addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);},querySelector:()=>null,querySelectorAll:()=>[]};
function dispatch(type,target){const event={type,target,detail:{},bubbles:true,cancelable:true,defaultPrevented:false,preventDefault(){event.defaultPrevented=true;}};for(const fn of handlers[type]||[])fn(event);return event;}
const click=node=>dispatch('click',node);
const type=(node,value)=>{node.value=value;dispatch('input',node);};
const change=(node,value)=>{if(value!==undefined)node.value=value;dispatch('change',node);};
const host=html=>{const node=makeNode('div');node.innerHTML=html;return node;};

// ---- the contract, held by a stub server -----------------------------------------------------
function server({sets={CPT:{enabled:true,version:4},'ICD-10-CM':{enabled:true,version:2}},codes=[],catalog=[{code:'99213',system:'CPT',display:'Synthetic office visit'},{code:'J0000',system:'HCPCS',display:'Synthetic injection'}]}={}){
 const state={sets,codes,calls:[],audited:[]};
 const releaseOf=system=>({id:`release-${system}`,system,edition:'Synthetic 2026',effective_start:'2026-01-01',effective_end:'2026-12-31',source_name:'Synthetic source',code_count:catalog.filter(item=>item.system===system).length,rights:'public_use'});
 const setRow=system=>({system,enabled:state.sets[system]?.enabled!==false,version:state.sets[system]?.version??0,installed:catalog.some(item=>item.system===system)});
 const api=async(path,method='GET',body,version)=>{
  state.calls.push({path,method,body,version});
  const url=new URL(path,'http://stub'),q=url.searchParams;
  if(url.pathname==='/api/v1/practice/code-sets')return {items:SYSTEMS.map(setRow)};
  const set=/^\/api\/v1\/practice\/code-sets\/([^/]+)$/.exec(url.pathname);
  if(set&&method==='PUT'){
   const system=decodeURIComponent(set[1]),known=state.sets[system];
   if(version!==(known?.version??0))throw new Error('This code set changed elsewhere. Reload it before saving.');
   state.sets[system]={enabled:!!body.enabled,version:(known?.version??0)+1};
   state.audited.push('practice.code_set.updated');return setRow(system);
  }
  if(url.pathname==='/api/v1/practice/codes'&&method==='GET'){
   const needle=(q.get('q')||'').toLowerCase();
   return {items:state.codes.filter(item=>!needle||item.code.toLowerCase().startsWith(needle)||item.display.toLowerCase().includes(needle)).map(item=>({...item}))};
  }
  if(url.pathname==='/api/v1/practice/codes'&&method==='POST'){
   if(state.codes.some(item=>item.system===body.system&&item.code===body.code))throw new Error('This code is already in your list.');
   const item={id:`code-${state.codes.length+1}`,system:body.system,code:body.code,display:body.display,enabled:body.enabled,price_cents:body.price_cents??null,default_units:body.default_units,modifiers:body.modifiers??'',version:1};
   state.codes.push(item);state.audited.push('practice.code.created');return {...item};
  }
  const code=/^\/api\/v1\/practice\/codes\/([^/]+)$/.exec(url.pathname);
  if(code&&method==='PUT'){
   const item=state.codes.find(entry=>entry.id===decodeURIComponent(code[1]));
   if(!item)throw new Error('This code is no longer in your list.');
   if(version!==item.version)throw new Error('This code changed elsewhere. Reload it before saving.');
   Object.assign(item,body,{version:item.version+1});state.audited.push('practice.code.updated');return {...item};
  }
  if(url.pathname==='/api/v1/terminology/releases')return {items:[...new Set(catalog.map(item=>item.system))].map(releaseOf),next_cursor:null};
  if(url.pathname==='/api/v1/terminology/codes'){
   const system=q.get('system'),needle=(q.get('q')||'').toUpperCase();
   if(state.sets[system]?.enabled===false)return {items:[],release:null,next_cursor:null,disabled:true,service_date:q.get('service_date')};
   return {items:catalog.filter(item=>item.system===system&&(item.code.startsWith(needle)||item.display.toUpperCase().includes(needle))).map(item=>({...item,...releaseOf(item.system),billable:true,active:true})),release:releaseOf(system),next_cursor:null};
  }
  if(/\/procedure-codes$/.test(url.pathname)){
   const needle=(q.get('q')||'').toUpperCase();
   const mine=state.codes.filter(item=>item.enabled&&['CPT','HCPCS'].includes(item.system)&&item.code.toUpperCase().startsWith(needle))
    .map(item=>({code:item.code,system:item.system,display:item.display,price_cents:item.price_cents,default_units:item.default_units,modifiers:item.modifiers,practice_code:true}));
   return {items:[...mine,...mine.length?[]:[{code:'99214',system:'CPT',display:'Synthetic earlier visit'}]]};
  }
  throw new Error('the stub has no answer for '+path);
 };
 return {state,api};
}

// ---- 1 + 2. the screen ----------------------------------------------------------------------
function screen({sets,codeItems=[],catalog}={}){
 for(const name of Object.keys(handlers))delete handlers[name];
 const srv=server({sets:sets||{CPT:{enabled:true,version:4},'ICD-10-CM':{enabled:true,version:2}},codes:codeItems.map(item=>({...item})),catalog});
 const tools=host('<section id="tools"></section>').children[0];
 const nodes={tools};
 const timers=new Map();let token=0;
 const context=vm.createContext({console,Object,Array,String,Number,Boolean,Math,JSON,Date,Intl,RegExp,Error,Promise,Symbol,Map,Set,WeakMap,WeakSet,URL,URLSearchParams,encodeURIComponent,decodeURIComponent,parseInt,parseFloat,isNaN,
  document:documentStub,$:id=>nodes[id]??null,me:{role:'owner'},selected:'patient-1',
  esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  crypto:{randomUUID:()=>'synthetic-request-1'},api:srv.api,
  showTool:title=>{context.shownTitle=title;},notice:(message,error)=>{context.noticed={message,error};},
  run:async fn=>{try{await fn();}catch(error){context.runError=error;}},
  setTimeout:(fn,ms)=>{const id=++token;timers.set(id,{fn,ms});return id;},clearTimeout:id=>{timers.delete(id);},
  Event:class{constructor(name,options){this.type=name;Object.assign(this,options);}}});
 vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
 vm.runInContext(source,context);
 const open=async()=>{await context.showTerminologyCatalogs();await settle();};
 const rows=()=>tools.querySelectorAll('[data-code-row]');
 const rowFor=id=>rows().find(row=>row.dataset.codeRowId===id);
 const toggleFor=system=>tools.querySelector(`[data-code-set-toggle="${system}"]`);
 const setStatus=system=>tools.querySelector(`[data-code-set-status="${system}"]`);
 const rowStatus=id=>rowFor(id)?.querySelector('[data-code-status]');
 const flush=async()=>{const pending=[...timers.values()];timers.clear();for(const timer of pending)timer.fn();await settle();};
 return {context,srv,tools,open,rows,rowFor,toggleFor,setStatus,rowStatus,flush,settle,
  codeRow:()=>tools.querySelector('[data-practice-code-rows]'),searchBox:()=>tools.querySelector('[data-code-search]'),filterBox:()=>tools.querySelector('[data-code-filter]'),
  addStatus:()=>tools.querySelector('[data-code-add-status]'),addResults:()=>tools.querySelector('[data-code-add-results]'),emptyNote:()=>tools.querySelector('[data-practice-code-empty]')};
}

// ---- the dropdown harness -------------------------------------------------------------------
// The charge row as web/billing.js draws it, reduced to the fields a pick writes: the one visible
// box, the two hidden fields the line submits, and the units, modifiers and amount a practice price
// fills in. web/billing.js is loaded only to read the amount field back the way the table does.
function chargeFixture({practice=[],amount='',catalog=true,disabled=[],disableBilled=false}){
 for(const name of Object.keys(handlers))delete handlers[name];
 const item={code:'90001',display:'Synthetic procedure one',system:'CPT',edition:'Synthetic 2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic source'};
 let note=null;
 const form={isConnected:true,dataset:{patient:'patient-1',id:'account-1',version:'3'},elements:{service_date:{value:'2026-11-07'},visit_id:{value:'visit-1'}}};
 const fields={};
 const names=['procedure','code','description','code_system','units','modifiers','amount'];
 const row={isConnected:true,dataset:{},closest:()=>form,querySelector(selector){
  if(selector==='[data-terminology-selection]')return note;
  if(selector==='[data-terminology-combobox]')return fields.procedure;
  for(const name of names)if(selector.includes(`[name="${name}"]`))return fields[name];
  return null;},append(value){note=value;}};
 for(const name of names){
  const attributes={};
  const value=name==='code_system'?'CPT':name==='code'?'manual':name==='description'?'Manual description':name==='units'?'1':name==='amount'?amount:'';
 const field={name,value,isConnected:true,disabled:false,readOnly:false,
   setAttribute:(k,v)=>attributes[k]=String(v),removeAttribute:k=>delete attributes[k],getAttribute:k=>attributes[k],focus(){},
   matches(selector){return (name==='procedure'&&selector.includes('[data-terminology-combobox]'))||selector.includes(`[name="${name}"]`);},
   closest(selector){if(selector.includes('billing-charge-row'))return row;if(selector==='form')return form;if(selector==='.terminology-combobox')return hosts.procedure;return null;},
   hasAttribute(){return false;},dispatchEvent(e){announced(e.type,name);send(e.type,field);}};
  fields[name]=field;
 }
 const status={textContent:''};
 const list={id:'list-procedure',innerHTML:'',replaceChildren(){this.innerHTML='';},querySelector(){return {scrollIntoView(){}};}};
 const popup={hidden:true,querySelector:s=>s==='[data-terminology-status]'?status:list};
 const hosts={procedure:{querySelector:s=>({'[data-terminology-popup]':popup,'[data-terminology-results]':list,'[data-terminology-status]':status,'[data-terminology-combobox]':fields.procedure})[s],popup,list,status}};
 const calls=[],timers=new Map();let token=0;
 // Counting the input events a pick announces is how the test knows autosave would be woken.
 const announcedNames=[],announced=(type,name)=>{if(type==='input')announcedNames.push(name);};
 const response=async path=>{
  if(path.includes('/procedure-codes?'))return {items:practice.length?practice:[],disabled:disableBilled===true};
  const system=new URL(path,'http://stub').searchParams.get('system');
  if(!catalog)return {items:[],release:null,next_cursor:null};
  if(disabled.includes(system))return {items:[],release:null,next_cursor:null,disabled:true,service_date:'2026-11-07'};
  return {items:[{...item,code:'G0001',system:'HCPCS',display:'Synthetic HCPCS service'}],release:{id:item.release_id},next_cursor:null};
 };
 // Each fixture installs its own handlers, so one charge row's typing cannot reach another's page.
 const own={},localDocument={addEventListener:(name,fn)=>{(own[name]??=[]).push(fn);},createElement:()=>({dataset:{},className:'',textContent:'',remove(){}}),querySelector:()=>null,querySelectorAll:()=>[]};
 // Like the browser's capture listeners: the page stops propagation when it has handled a key, so
 // each fixture's dispatcher honours it too.
 const send=(type,target,extra={})=>{let stopped=false;const event={type,target,detail:{},bubbles:true,cancelable:true,defaultPrevented:false,preventDefault(){event.defaultPrevented=true;},stopPropagation(){stopped=true;},stopImmediatePropagation(){stopped=true;},...extra};for(const fn of own[type]||[]){fn(event);if(stopped)break;}return event;};
 const vmContext=vm.createContext({console,Object,Array,String,Number,Boolean,Math,JSON,Date,Intl,RegExp,Error,Promise,Symbol,Map,Set,WeakMap,WeakSet,URLSearchParams,encodeURIComponent,
  me:{role:'owner'},selected:'patient-1',activeVisit:{id:'visit-1'},workspace:{appointments:[]},chartSection:'visits',encounterSection:'charges',
  esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  document:localDocument,Event:class{constructor(name,options){this.type=name;Object.assign(this,options);}},
  api:async(path,method='GET',body)=>{calls.push({path,method,body});return response(path,method,body);},
  setTimeout:(fn,ms)=>{const id=++token;timers.set(id,{fn,ms});return id;},clearTimeout:id=>{timers.delete(id);}});
 vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),vmContext);
 vm.runInContext(source,vmContext);
  const readAmount=()=>{
   // Exactly what web/billing.js chargeRowAmountCents reads: dollars and cents, no symbol.
   const text=String(fields.amount.value||'').replace(/[$\s]/g,'');
   if(!text)return null;
   if(!/^\d+(\.\d{1,2})?$/.test(text))throw new Error('the amount field holds something the charge table cannot read: '+text);
   const [whole,fraction='']=text.split('.');
   return Number(whole)*100+Number(fraction.padEnd(2,'0'));
  };
  const harness={fields,row,box:fields.procedure,list,status,calls,readAmount,own,send,context:vmContext,
   announced:()=>announcedNames.slice(),
   line:()=>({shown:fields.procedure.value,code:fields.code.value,description:fields.description.value}),
   async flush(){const pending=[...timers.values()];timers.clear();for(const timer of pending)timer.fn();await tick();},
   async type(value){fields.procedure.value=value;announced('input','procedure');send('input',fields.procedure);await harness.flush();}};
  return harness;
}
function diagnosisFixture({disabled}){
 const form={isConnected:true,dataset:{patient:'patient-1'},elements:{service_date:{value:'2026-11-07'},visit_id:{value:'visit-1'}}};
 const fields={};
 const row={isConnected:true,dataset:{},closest:()=>form,matches:selector=>selector.includes('data-diagnosis-row'),querySelector(selector){for(const name of ['code','display'])if(selector.includes(`[name="${name}"]`))return fields[name];return null;},append(){}};
 for(const name of ['code','display']){
  const attributes={};
  fields[name]={name,value:'',isConnected:true,disabled:false,readOnly:false,
   _terminologyAttach:{scope:'diagnosis',system:'ICD-10-CM'},
   setAttribute:(k,v)=>attributes[k]=String(v),removeAttribute:k=>delete attributes[k],getAttribute:k=>attributes[k],focus(){},
   matches(selector){return selector.includes('[data-terminology-combobox]')||selector.includes(`[name="${name}"]`);},
   closest(selector){if(selector.includes('data-diagnosis-row'))return row;if(selector==='form')return form;if(selector==='.terminology-combobox')return hosts[name];return null;},
   hasAttribute(){return false;},dispatchEvent(e){send(e.type,fields[name]);}};
 }
 const status={textContent:''};
 // The list keeps its own text, so renderTerminologyCombobox's assignment is read back and the
 // keyboard handler can find the option it moves the caret onto.
 const store={html:''};
 const list={id:'list-display',get innerHTML(){return store.html;},set innerHTML(html){store.html=String(html);},replaceChildren(){store.html='';},querySelector(){return {scrollIntoView(){}};}};
 const popup={hidden:true,querySelector:s=>s==='[data-terminology-status]'?status:list};
 const hosts={};for(const name of ['code','display'])hosts[name]={querySelector:s=>({'[data-terminology-popup]':popup,'[data-terminology-results]':list,'[data-terminology-status]':status,'[data-terminology-combobox]':fields[name]})[s],popup,list,status};
 const timers=new Map();let token=0;
 const own={},localDocument={addEventListener:(name,fn)=>{(own[name]??=[]).push(fn);},createElement:()=>({dataset:{},className:'',textContent:'',remove(){}}),querySelector:()=>null,querySelectorAll:()=>[]};
 // Like the browser's capture listeners: the page stops propagation when it has handled a key, so
 // each fixture's dispatcher honours it too.
 const send=(type,target,extra={})=>{let stopped=false;const event={type,target,detail:{},bubbles:true,cancelable:true,defaultPrevented:false,preventDefault(){event.defaultPrevented=true;},stopPropagation(){stopped=true;},stopImmediatePropagation(){stopped=true;},...extra};for(const fn of own[type]||[]){fn(event);if(stopped)break;}return event;};
 const context=vm.createContext({console,Object,Array,String,Number,Boolean,Math,JSON,Date,Intl,RegExp,Error,Promise,Symbol,Map,Set,WeakMap,WeakSet,URLSearchParams,encodeURIComponent,
  me:{role:'owner'},selected:'patient-1',activeVisit:{id:'visit-1'},workspace:{appointments:[]},visitDiagnosisStates:new Map([['visit-1',{service_date:'2026-11-07'}]]),chartSection:'visits',encounterSection:'diagnoses',
  esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  document:localDocument,Event:class{constructor(name,options){this.type=name;Object.assign(this,options);}},
  api:async path=>disabled?{items:[],release:null,next_cursor:null,disabled:true,service_date:'2026-11-07'}:{items:[],release:{id:'release-1'},next_cursor:null},
  setTimeout:(fn,ms)=>{const id=++token;timers.set(id,{fn,ms});return id;},clearTimeout:id=>{timers.delete(id);}});
 vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
 vm.runInContext(source,context);
 const harness={context,fields,list,status,box:fields.display,send,
  async flush(){const pending=[...timers.values()];timers.clear();for(const timer of pending)timer.fn();await tick();},
  async type(value){fields.display.value=value;send('input',fields.display);await harness.flush();}};
 return harness;
}
// Keyboard selection, the way staff take a match: down the list, then Enter.
async function pick(f,index){
 for(let n=0;n<=index;n++)f.send('keydown',f.box,{key:'ArrowDown'});
 f.send('keydown',f.box,{key:'Enter'});
 await tick();
}
(async()=>{
 // 1. Code sets: the screen is renamed, all four systems are offered, installed state is shown,
//    and a switch saves at once with the version it read.
 let f=screen({codeItems:[],catalog:[{code:'99213',system:'CPT',display:'Synthetic office visit'},{code:'J0000',system:'HCPCS',display:'Synthetic injection'}]});
 await f.open();
 assert.equal(f.context.shownTitle,'Codes & prices','the page title is Codes & prices');
 assert.match(f.tools.innerHTML,/<h2[^>]*>Codes &amp; prices<\/h2>/,'the heading says Codes & prices');
 assert.match(f.tools.innerHTML,/Refresh codes and prices/);
 for(const system of SYSTEMS)assert.ok(f.toggleFor(system),`every system has a switch (${system})`);
 assert.match(f.tools.innerHTML,/ICD-10-PCS[\s\S]*?Not installed[\s\S]*?/,'ICD-10-PCS says it is not installed');
 assert.match(f.tools.innerHTML,/CPT[\s\S]*?Installed/,'CPT says it is installed');
 assert.equal(f.toggleFor('CPT').checked,true,'a system with no decision taken yet is on');
 assert.equal(f.toggleFor('CPT').dataset.codeSetVersion,'4','the switch carries the version it read');
 assert.equal(f.toggleFor('HCPCS').dataset.codeSetVersion,'0','a system with no settings row starts at version 0');
 assert.match(f.tools.innerHTML,/<summary>Installed code lists<\/summary>/,'the installed lists, CPT install and import are folded into one closed section');
 assert.ok(f.tools.innerHTML.indexOf('data-installed-code-lists')>f.tools.innerHTML.indexOf('data-practice-codes'),'the folded section sits below My codes');
 assert.match(f.tools.innerHTML,/data-cpt-section[\s\S]*?CPT codes installed/,'the CPT install section is still there, reporting the installed edition');
 assert.doesNotMatch(f.tools.innerHTML,/id="terminology-import-form"|type="file"/,'no file to choose: lists install themselves and CPT installs with the license box');
 assert.match(f.tools.innerHTML,/Installed versions/,'the installed-versions list is still there');
 // Flipping a switch saves straight away with If-Match on the version it read.
 const cpt=f.toggleFor('CPT');cpt.checked=false;change(cpt);await f.settle();
 const setPut=f.srv.state.calls.find(call=>call.method==='PUT');
 assert.equal(setPut.path,'/api/v1/practice/code-sets/CPT');
 assert.deepEqual(JSON.parse(JSON.stringify(setPut.body)),{enabled:false});
 assert.equal(setPut.version,4,'the save carries the version it read as If-Match');
  assert.ok(f.srv.state.audited.includes('practice.code_set.updated'),'the server records the audit event with the change');
  assert.equal(cpt.dataset.codeSetVersion,'5','the switch now holds the version the server answered');
 // Turning a set off asks nothing and says what it means.
 assert.equal(f.setStatus('ICD-10-CM').textContent,'','a switch that was not touched says nothing');
 const icd=f.toggleFor('ICD-10-CM');icd.checked=false;change(icd);await f.settle();
 assert.equal(f.setStatus('ICD-10-CM').textContent,'Turned off: staff will not see these codes in lookups.','turning a set off says what staff will notice');
 icd.checked=true;change(icd);await f.settle();
 assert.equal(f.setStatus('ICD-10-CM').textContent,'','turning it back on clears the message');
 // A version that moved elsewhere is the server's words, kept on the switch.
 const hcpcs=f.toggleFor('HCPCS');hcpcs.checked=false;hcpcs.dataset.codeSetVersion='9';change(hcpcs);await f.settle();
 assert.match(f.setStatus('HCPCS').textContent,/changed elsewhere/);
 // 2. My codes: the table, saved on change and on leaving a field, in clinic words.
 f=screen({codeItems:[{id:'code-1',system:'CPT',code:'99213',display:'Synthetic office visit',enabled:true,price_cents:12000,default_units:1,modifiers:'',version:3},
  {id:'code-2',system:'HCPCS',code:'J0000',display:'Synthetic injection',enabled:true,price_cents:null,default_units:2,modifiers:'25',version:1}]});
 await f.open();
 assert.match(f.tools.innerHTML,/<h3>My codes<\/h3>/);
 assert.match(f.tools.innerHTML,/Find a code to add/);
 assert.match(f.tools.innerHTML,/placeholder="Code or name"/,'the search box asks for a code or a name');
 for(const heading of ['On','Code','Description','Price','Units','Modifiers'])assert.match(f.tools.innerHTML,new RegExp(`<th>${heading}</th>`),`the table has a ${heading} column`);
 assert.ok(f.filterBox(),'there is a filter over the table');
 assert.equal(f.rows().length,2);
 const priceOf=id=>f.rowFor(id).querySelector('[name="price"]');
 assert.equal(priceOf('code-1').value,'120.00','the price shows in dollars');
 assert.equal(priceOf('code-2').value,'','a code with no price shows no price');
 assert.equal(f.rowFor('code-1').querySelector('[name="enabled"]').checked,true);
 assert.equal(f.rowFor('code-1').querySelector('[name="units"]').value,'1');
 assert.equal(f.rowFor('code-1').querySelector('[name="modifiers"]').value,'');
  // A price edit saves on change, at the version the row shows.
 change(priceOf('code-1'),'145.50');await f.settle();
  const firstPut=f.srv.state.calls.filter(call=>call.path==='/api/v1/practice/codes/code-1').at(-1);
  assert.equal(firstPut.method,'PUT');  assert.equal(Number(firstPut.version),3,'the row saves at the version it shows as If-Match');
  assert.deepEqual(JSON.parse(JSON.stringify(firstPut.body)),{display:'Synthetic office visit',enabled:true,price_cents:14550,default_units:1,modifiers:''});
 assert.equal(f.rowStatus('code-1').textContent,'Saved');
 assert.ok(f.srv.state.audited.includes('practice.code.updated'));
 assert.equal(priceOf('code-1').value,'145.50','the row keeps the price the server answered');
 // Leaving a field saves too.
  const unitsOf=id=>f.rowFor(id).querySelector('[name="units"]');
  const displayOf=id=>f.rowFor(id).querySelector('[name="display"]');
  displayOf('code-1').value='Synthetic longer office visit';dispatch('focusout',displayOf('code-1'));await f.settle();
 assert.match(f.srv.state.calls.filter(call=>call.path==='/api/v1/practice/codes/code-1').at(-1).body.display,/longer/);
 assert.equal(f.rowStatus('code-1').textContent,'Saved');
 // A price the practice cannot read is refused in words, before anything is sent.
  const calls=f.srv.state.calls.length;
  change(priceOf('code-1'),'1.999');await f.settle();
 assert.match(f.rowStatus('code-1').textContent,/dollars, up to two decimal places/);
 assert.equal(f.srv.state.calls.length,calls,'a price that is not dollars never reaches the server');
 change(priceOf('code-1'),'120');await f.settle();assert.equal(f.rowStatus('code-1').textContent,'Saved');
 change(unitsOf('code-1'),'0');await f.settle();
 assert.match(f.rowStatus('code-1').textContent,/units between 1 and 9999/i);
 change(unitsOf('code-1'),'1');await f.settle();
 // Modifiers follow the contract: up to four two-character codes, single spaces.
  const modifiersOf=id=>f.rowFor(id).querySelector('[name="modifiers"]');
  change(modifiersOf('code-1'),'25 LT 99');await f.settle();
 assert.equal(f.rowStatus('code-1').textContent,'Saved');
 assert.equal(f.srv.state.codes.find(item=>item.id==='code-1').modifiers,'25 LT 99');
  change(modifiersOf('code-1'),'25  LT');await f.settle();
 assert.match(f.rowStatus('code-1').textContent,/two-character/);
 // Turning a code off is how it leaves the dropdowns; nothing is deleted.
  const onOf=id=>f.rowFor(id).querySelector('[name="enabled"]');
  onOf('code-2').checked=false;change(onOf('code-2'));await f.settle();
 const offPut=f.srv.state.calls.filter(call=>call.path==='/api/v1/practice/codes/code-2').at(-1);
 assert.equal(offPut.method,'PUT');assert.equal(offPut.body.enabled,false);
 assert.equal(f.srv.state.codes.find(item=>item.id==='code-2').enabled,false);
 assert.ok(!f.srv.state.calls.some(call=>call.method==='DELETE'),'there is no delete anywhere on this screen');
 // The filter works over the rows on screen without asking the server again.
 const onTwo=onOf('code-2');onTwo.checked=true;change(onTwo);await f.settle();
 assert.equal(f.rowFor('code-2').querySelector('[name="enabled"]').checked,true,'turning the code back on saved');
  const reads=f.srv.state.calls.filter(call=>call.path.startsWith('/api/v1/practice/codes?')).length;
  type(f.filterBox(),'injection');
 assert.equal(f.rowFor('code-1').hidden,true,'the other code is hidden');
 assert.equal(f.rowFor('code-2').hidden,false);
 assert.equal(f.emptyNote().hidden,true);
 assert.equal(f.srv.state.calls.filter(call=>call.path.startsWith('/api/v1/practice/codes?')).length,reads,'filtering is local to the screen');
  type(f.filterBox(),'nothing like this');
 assert.equal(f.rowFor('code-1').hidden,true);assert.equal(f.rowFor('code-2').hidden,true);assert.equal(f.emptyNote().hidden,false,'a filter that matches nothing says so');
  type(f.filterBox(),'');
 assert.equal(f.rowFor('code-1').hidden,false);assert.equal(f.emptyNote().hidden,true);
 // Searching the installed lists as you type.
 f=screen({codeItems:[],catalog:[{code:'99213',system:'CPT',display:'Synthetic office visit'},{code:'J0000',system:'HCPCS',display:'Synthetic injection'}]});
 await f.open();
 assert.match(f.addStatus().textContent,/at least two characters/);
 type(f.searchBox(),'9');await f.flush();
 assert.equal(f.srv.state.calls.some(call=>call.path.includes('/terminology/codes?')),false,'one character does not search');
  type(f.searchBox(),'99');await f.flush();await new Promise(r=>setTimeout(r,320));
 const searched=f.srv.state.calls.filter(call=>call.path.includes('/terminology/codes?'));
 assert.ok(searched.length,'typing searches the installed lists');
 assert.deepEqual([...new Set(searched.map(call=>new URL(call.path,'http://stub').searchParams.get('system')))].sort(),['CPT','HCPCS','ICD-10-CM'],'CPT, HCPCS and ICD-10-CM are searched');
 for(const call of searched)assert.match(new URL(call.path,'http://stub').searchParams.get('service_date'),/^\d{4}-\d{2}-\d{2}$/,'today is the service date');
 assert.match(f.addResults().innerHTML,/99213/);assert.match(f.addResults().innerHTML,/>Add</,'a result carries an Add button');
 // Adding creates the practice code, on and with no price.
const addButton=f.addResults().querySelector('[data-code-add-code="99213"]');
 click(addButton);await f.settle();
 const post=f.srv.state.calls.find(call=>call.method==='POST'&&call.path==='/api/v1/practice/codes');
 assert.deepEqual(JSON.parse(JSON.stringify(post.body)),{request_id:'synthetic-request-1',system:'CPT',code:'99213',display:'Synthetic office visit',enabled:true,price_cents:null,default_units:1,modifiers:''});
 assert.equal(f.srv.state.codes.length,1);
 assert.ok(f.srv.state.audited.includes('practice.code.created'));
 assert.match(f.codeRow().innerHTML,/99213/,'the new code appears in the table below');
 assert.equal(f.rowFor('code-1')?.querySelector('[name="price"]').value,'','a new code has no price yet');
 assert.match(f.addStatus().textContent,/added/);
 // The same code again is the server's plain answer, kept on screen.
 f.srv.state.calls.length=0;
 click(addButton);await f.settle();
 assert.match(f.addStatus().textContent,/already in your list/);
 assert.equal(f.srv.state.codes.length,1);
 // An empty table says what to do next.
 f=screen({codeItems:[]});await f.open();
 assert.match(f.codeRow().textContent,/No codes yet/);

 // ---- 3 + 4. the charge line dropdown ------------------------------------------------------
 // Driven through the row stub scripts/test_procedure_autocomplete_ui.cjs uses, with the units,
 // modifiers and amount fields a real charge line carries added to it.
 // A practice code with a price comes first, shows its price on the right, and a pick fills the
 // line: code, description, units, modifiers and the amount for the whole line.
 f=chargeFixture({practice:[{code:'99213',system:'CPT',display:'Synthetic office visit',price_cents:12000,default_units:2,modifiers:'25',practice_code:true}],amount:'',catalog:true});
 await f.type('992');
 assert.match(f.status.textContent===undefined?f.list.innerHTML:f.status.textContent,/.*/);
 assert.match(f.list.innerHTML,/data-terminology-price>\$120\.00</,'the practice price is shown on the right of the item');
 assert.ok(f.list.innerHTML.indexOf('99213')<f.list.innerHTML.indexOf('G0001'),'the practice’s codes come before the code lists');
 await pick(f,0);
 assert.deepEqual(f.line(),{shown:'99213',code:'99213',description:'Synthetic office visit'});
 assert.equal(f.fields.units.value,'2','the practice’s default units go on the line');
 assert.equal(f.fields.modifiers.value,'25','and its modifiers');
 assert.equal(f.fields.amount.value,'240.00','the amount is the price times those units, formatted as the amount field is read');
 assert.equal(f.readAmount(),24000,'the charge table reads that back as the right number of cents');
 assert.ok(f.announced().includes('amount'),'the amount announces itself so autosave runs');
 assert.ok(f.announced().includes('units')&&f.announced().includes('modifiers'),'so do units and modifiers');
 assert.equal(f.calls.filter(call=>call.method!=='GET').length,0,'a dropdown pick never saves anything by itself');
 // One unit prices the line at the price.
 f=chargeFixture({practice:[{code:'99213',system:'CPT',display:'Synthetic office visit',price_cents:12000,default_units:1,modifiers:'',practice_code:true}],amount:'88.88',catalog:true});
 await f.type('992');await pick(f,0);
 assert.equal(f.fields.amount.value,'120.00');assert.equal(f.readAmount(),12000);
 // A code with no price leaves the amount alone but still brings its units.
 f=chargeFixture({practice:[{code:'99213',system:'CPT',display:'Synthetic office visit',price_cents:null,default_units:3,modifiers:'',practice_code:true}],amount:'88.88',catalog:true});
 await f.type('992');await pick(f,0);
 assert.equal(f.fields.amount.value,'88.88','a code with no price leaves the amount staff typed');
 assert.ok(!f.announced().includes('amount'),'and does not disturb it');
 assert.equal(f.fields.units.value,'3');
 // A catalog pick leaves the amount alone and shows the code list, never a price.
 f=chargeFixture({practice:[],amount:'88.88',catalog:true});
 await f.type('900');
 assert.doesNotMatch(f.list.innerHTML,/data-terminology-price/,'a code list item shows no price');
 assert.match(f.list.innerHTML,/Synthetic 2026/,'and still says which code list it came from');
 await pick(f,0);
 assert.equal(f.fields.amount.value,'88.88','a catalog pick does not touch the amount');
 assert.ok(!f.announced().includes('amount'),'and nothing announces it');
 assert.equal(f.fields.units.value,'1');
 // A code typed by hand leaves the amount alone too.
 f=chargeFixture({practice:[],amount:'88.88',catalog:false});
 f.box.value='99213: Typed by hand';f.send('input',f.box);await f.flush();f.send('focusout',f.box,{relatedTarget:null});
 assert.deepEqual(f.line(),{shown:'99213',code:'99213',description:'Typed by hand'});
 assert.equal(f.fields.amount.value,'88.88');
 assert.ok(!f.announced().includes('amount'),'a code typed by hand leaves the amount alone');
 // 4. A code set turned off is answered disabled, and said in clinic words.
 f=chargeFixture({practice:[],disabled:['CPT','HCPCS'],catalog:true,disableBilled:true});
 await f.type('99');
 assert.match(f.status.textContent,/Procedure codes are turned off for this practice\. Type the code by hand\./);
 assert.equal(f.box.value,'99','what staff typed is left alone');
 assert.equal(f.list.innerHTML,'');
 // With practice codes still on, the box keeps working even with both lists off.
 f=chargeFixture({practice:[{code:'99213',system:'CPT',display:'Synthetic office visit',price_cents:12000,default_units:1,modifiers:'',practice_code:true}],disabled:['CPT','HCPCS'],catalog:true});
 await f.type('99');
 assert.match(f.list.innerHTML,/99213/,'the practice’s own codes still answer');
 assert.doesNotMatch(f.status.textContent,/turned off/);
 // A diagnosis system turned off is answered the same way, named by system.
 f=diagnosisFixture({disabled:true});
 await f.type('R5');
 assert.match(f.status.textContent,/ICD-10-CM codes are turned off for this practice\. Type the code by hand\./);
 assert.equal(f.fields.code.value,'','nothing is filled in on the other box of the row');
 // A system that is simply not installed still says what it always said.
 f=diagnosisFixture({disabled:false});
 await f.type('R5');
 assert.match(f.status.textContent,/No match in the code list/);
 console.log('PASS Codes & prices: four code-set switches saved with If-Match and audit, My codes table saved on change and blur with plain wording and limits, search-as-you-type plus Add, practice price/units/modifiers filled on a practice pick only, turned-off code sets answered in clinic words');
})().catch(error=>{console.error(error);process.exitCode=1;});
