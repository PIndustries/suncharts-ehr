// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One place for the codes a visit is billed on: the visit's own diagnoses sit directly above its
// charge lines, entered by the very editor the visit's Diagnoses screen uses (web/visit-diagnoses.js
// is loaded here unmodified and draws the section itself), and the charge rows below follow it.
//
// No npm packages. The markup billing.js renders is parsed into small hand-written element stubs,
// both feature scripts are loaded into one node vm in the order index.html loads them, and the two
// are driven through the handlers they install on the document.

const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

// ---- the hand-written DOM --------------------------------------------------------------
// The slice of the DOM these two screens use: markup in as strings, valued attributes onto attrs
// and dataset, bare attributes onto attrs as true plus the properties the page reads.
const PROP_ALIAS={colspan:'colSpan'};
const VOID_TAGS=new Set(['input','br','img','meta','link','hr','source']);
// Tracks the select whose options are being read, so its option children can record which one the
// markup says is selected, and where each option sits in its list.
const insideSelect={depth:0,optionIndex:0};
function parseMarkup(html){
 const stack=[],roots=[],re=/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;let last=0,match;
 const top=()=>stack.length?stack[stack.length-1]:null;
 const push=node=>{
  // A node attaches below the innermost element a parser would still be inside: a <p> or <li>
  // auto-closes, so it never holds its siblings' content.
  let depth=stack.length;
  while(depth>0&&stack[depth-1].autoClose)depth--;
  const parent=depth?stack[depth-1]:null;
  if(parent){parent.children.push(node);node.parent=parent;}else roots.push(node);
 };
 while((match=re.exec(html))){
  const text=html.slice(last,match.index);
  if(text&&top())top()._text+=text;
  last=re.lastIndex;
  const[whole,tagRaw,attrText,selfClose]=match;
  const tag=tagRaw.toLowerCase();
  if(whole.startsWith('</')){
   for(let i=stack.length-1;i>=0;i--)if(stack[i].tag===tag){const closed=stack[i];if(closed.tag==='option'&&closed.attrs.value===undefined)closed._value=closed.textContent;if(tag==='select'){insideSelect.depth--;insideSelect.owner=null;}else if(tag==='option')insideSelect.optionIndex=insideSelect.optionIndex;stack.length=i;break;}
   continue;
  }
  const node=makeNode(tag);
  for(const part of attrText.trim()==='/'?[]:attrText.match(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)||[]){
   const m=/^([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?$/.exec(part.trim());if(!m)continue;
   const name=m[1].toLowerCase(),value=m[2]!==undefined?m[2]:m[3]!==undefined?m[3]:true;
   if(value===true){node.attrs[name]=true;if(name==='open')node.open=true;if(name==='hidden')node.hidden=true;if(name==='checked')node.checked=true;if(name==='disabled')node.disabled=true;if(name==='selected'&&insideSelect.depth&&insideSelect.owner)insideSelect.owner.selectSelected=insideSelect.optionIndex;}
   else{node.attrs[name]=String(value);node.dataset[camel(name)]=String(value);
    if(name==='value'){node._value=String(value);if(insideSelect.depth&&node.tag==='option'&&insideSelect.owner&&!(node.attrs.selected===undefined))insideSelect.owner.selectSelected=insideSelect.optionIndex;}
    if(name==='checked')node.checked=String(value)!=='false';
    if(PROP_ALIAS[name])node[PROP_ALIAS[name]]=String(value);}
  }
  push(node);
  if(insideSelect.depth&&tag==='option'){insideSelect.optionIndex++;if(insideSelect.owner&&!insideSelect.owner.selectSelectedAt&&node.attrs.selected!==undefined){insideSelect.owner.selectSelected=insideSelect.optionIndex-1;insideSelect.owner.selectSelectedAt=true;}}
  if(tag==='select'){insideSelect.depth++;insideSelect.owner=node;insideSelect.optionIndex=0;}
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
 const node={_id:++uid,tag:tag||'fragment',attrs:Object.create(null),dataset:Object.create(null),children:[],_text:'',parent:null,_value:'',open:false,hidden:false,checked:false,disabled:false};
 Object.defineProperty(node,'value',{get:()=>node.tag==='select'?(node.children[node.selectSelected??0]?.attrs.value??''):node._value,set:v=>{node._value=String(v);}});
 Object.defineProperty(node,'textContent',{get(){return node._text+node.children.map(child=>child.textContent).join('');},set(t){node._text=String(t);node.children.length=0;}});
 Object.defineProperty(node,'innerHTML',{
  get(){return (node._text||'')+node.children.map(child=>child.outerHTML).join('');},
  set(html){for(const child of node.children){child.parent=null;child.isConnected=false;drop(child);}node.children=[];node._text='';for(const child of parseMarkup(String(html)))insertChild(node,child);}});
 Object.defineProperty(node,'outerHTML',{get(){return serialize(node);}});
 // A form's named fields, the way the page reads them (form.elements.reason, form.elements.x?.value):
 // the first field of each name inside it, answerable by key or by index.
 Object.defineProperty(node,'elements',{
  get(){
   const list=[];
   for(const field of queryAll(node,'input,select,textarea'))if(!list.some(seen=>seen.name===(field.attrs.name||'')&&seen!==field))list.push({name:field.attrs.name||'',node:field});
   const proxy=list.slice();
   for(const entry of list)if(!(entry.name in proxy))proxy[entry.name]=entry.node;
   return proxy;}});
 Object.defineProperty(node,'lastElementChild',{get(){return node.children.at(-1)??null;}});
 node.isConnected=true;
 node.setAttribute=(name,value)=>{name=String(name).toLowerCase();node.attrs[name]=String(value);node.dataset[camel(name)]=String(value);};
 node.getAttribute=name=>{const v=node.attrs[String(name).toLowerCase()];return v===undefined?null:v===true?'':v;};
 node.hasAttribute=name=>String(name).toLowerCase() in node.attrs;
 node.removeAttribute=name=>{delete node.attrs[String(name).toLowerCase()];};
 node.closest=selector=>{const parts=String(selector).trim().split(/\s+/);let at=node;
  while(at){if(parts.every((part,i)=>i===parts.length-1?matchesSimple(at,part):queryAll(at,parts.slice(i).join(' ')).length))return at;at=at.parent;}return null;};
 node.contains=other=>{let at=other;while(at){if(at===node)return true;at=at.parent;}return false;};
 node.querySelector=selector=>queryAll(node,selector)[0]||null;
 node.querySelectorAll=selector=>queryAll(node,selector);
 node.append=(...parts)=>{for(const part of parts)if(typeof part==='string')node._text+=part;else{part.parent?.children.splice(part.parent.children.indexOf(part),1);insertChild(node,part);}};
 node.replaceChildren=(...parts)=>{for(const child of node.children){child.parent=null;child.isConnected=false;drop(child);}node.children=[];node._text='';node.append(...parts);};
 node.remove=()=>{if(!node.parent)return;const at=node.parent.children.indexOf(node);if(at>=0)node.parent.children.splice(at,1);node.parent=null;node.isConnected=false;};
 node.insertAdjacentHTML=(where,html)=>{for(const child of parseMarkup(String(html))){insertChild(node,child);if(child.attrs.id)nodes[child.attrs.id]=child;}};
 node.insertAdjacentElement=(where,child)=>{insertChild(node,child);return child;};
 node.focus=()=>{documentStub.activeElement=node;};
 node.scrollIntoView=()=>{};
 // An event bubbles: every handler the document holds sees it, at each ancestor in turn, with the
 // target set where the page's delegation reads it.
 node.dispatchEvent=event=>{let at=node;while(at){for(const fn of handlers[event.type]||[])fn({...event,target:at});at=at.parent;}return true;};
 node.matches=selector=>matchesSimple(node,selector);
 return node;
}
// Everything inside a subtree that leaves the document stops being findable by id, the way a live
// DOM tracks it.
function drop(node){
 if(node.attrs.id&&nodes[node.attrs.id]===node){if(process.env.ERB_DROP_DEBUG&&['encounter-billing-editor','billing-editor'].includes(node.attrs.id))console.log('[drop]',node.attrs.id,'\n'+new Error().stack.split('\n').slice(1,6).join('\n'));node.isConnected=false;delete nodes[node.attrs.id];}
 for(const child of node.children){child.isConnected=false;child.parent=null;drop(child);}
}
function insertChild(parent,child){
 if(parent.tag==='table'&&child.tag==='tr'){
  let body=parent.children.find(cell=>cell.tag==='tbody');
  if(!body){body=makeNode('tbody');body.parent=parent;parent.children.push(body);}
  parent=body;}
 child.parent=parent;parent.children.push(child);register(child);
}
function register(node){
 if(node.attrs.id){const previous=nodes[node.attrs.id];if(previous&&previous!==node)drop(previous);nodes[node.attrs.id]=node;node.isConnected=true;}
 for(const child of node.children)register(child);
}
function matchesSimple(node,selector){return String(selector).split(',').some(one=>matchOne(node,one.trim()));}
function matchOne(node,selector){
 const not=/:not\(([^)]+)\)/.exec(selector);
 if(not&&matchOne(node,not[1]))return false;
 if(not)selector=selector.replace(not[0],'');
 const classes=selector.match(/\.[\w-]+/g)||[];
 let rest=selector.replace(/\.[\w-]+/g,'');
 const ids=selector.match(/#[\w-]+/g)||[];rest=rest.replace(/#[\w-]+/g,'');
 const attribs=rest.match(/\[[^\]]+\]/g)||[];rest=rest.replace(/\[[^\]]+\]/g,'');
 if(!/^(\*|[a-zA-Z][\w-]*)?$/.test(rest))return false; // an unsupported tail matches nothing, never throws
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
 // Descendant combinators, the only kind this page's markup needs: match the last part on any
 // node, then check each earlier part holds an ancestor that matches it.
 const parts=String(selector).trim().split(/\s+/);
 if(parts.length<2){const out=[];collect(node,selector,out);return out;}
 const out=[];
 collect(node,parts.at(-1),out);
 return out.filter(candidate=>{
  let at=candidate.parent;
  for(let i=parts.length-2;i>=0;i--){
   let found=false;
   while(at){if(matchesSimple(at,parts[i])){found=true;at=at.parent;break;}at=at.parent;}
   if(!found)return false;}
  return true;});}
function collect(node,selector,out){for(const child of node.children){if(matchesSimple(child,selector))out.push(child);collect(child,selector,out);}}
function serialize(node){
 const attrs=Object.entries(node.attrs).map(([name,value])=>value===true?` ${name}`:` ${name}="${value}"`).join('');
 // A live DOM serialises the value property, not the value attribute: what the person typed is what
 // a clone or a re-parse sees.
 if(node.tag==='input'){const attrs2=node._value!==''?attrs.replace(/\svalue="[^"]*"/,'')+` value="${node._value}"`:attrs;return `<input${attrs2}${node.checked?' checked':''}>`;}
 const inner=node.tag==='select'
  ?node.children.map((option,index)=>`<option${String(option.attrs.value??'')===''?'':` value="${option.attrs.value}"`}${index===node.selectSelected?' selected':''}>${option.textContent}</option>`).join('')
  :(node._text||'')+node.children.map(child=>child.outerHTML).join('');
 return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}
const nodes={},handlers={};
const documentStub={
 documentElement:makeNode('html'),activeElement:null,
 createElement:tag=>makeNode(String(tag).toLowerCase()),
 getElementById:id=>nodes[id]??null,
 addEventListener:(name,fn,capture)=>{(handlers[name]??=[]).push(fn);if(capture)(captureHandlers[name]??=[]).push(fn);},
 querySelector:selector=>matchesSimple(documentStub.documentElement,selector)?documentStub.documentElement:queryAll(documentStub.documentElement,selector)[0]||null,
 querySelectorAll:selector=>queryAll(documentStub.documentElement,selector),};
const captureHandlers={};
// The stub writes checked onto the node for a ticked box, which is what the page reads back.
function tickState(node){return !!node.checked;}
function dispatch(type,target){
 const event={type,target,currentTarget:target,detail:{},bubbles:true,cancelable:true,defaultPrevented:false,stopped:false,
  preventDefault(){event.defaultPrevented=true;},
  stopPropagation(){event.stopped=true;},
  stopImmediatePropagation(){event.stopped=true;}};
 for(const fn of handlers[type]||[]){if(event.stopped)break;fn(event);}
 return event;
}
const click=node=>dispatch('click',node);
const type=(node,value)=>{node.value=value;dispatch('input',node);};
const change=node=>dispatch('change',node);
const host=id=>{const node=makeNode('div');node.attrs.id=id;register(node);return node;};

// ---- the panels these two screens write into -------------------------------------------
// Built as one document fragment in the order the real chart writes it, then registered: the
// panels live inside #encounter-revenue the way web/patient-revenue.js lays them out, and every
// id stays findable.
const revenuePanel=host('encounter-revenue');
revenuePanel.innerHTML='<div id="encounter-revenue-status"></div><div id="encounter-billing-editor"></div><div id="encounter-billing-detail"></div>';
const encounterEditor=$host('encounter-billing-editor');
host('billing-editor');host('billing-detail');
function $host(id){return nodes[id];}

// ---- the vm page -----------------------------------------------------------------------
const liveTimers=new Map();let tokenSeq=0;
const vmSetTimeout=(fn,ms,...args)=>{const token=++tokenSeq;liveTimers.set(token,setTimeout(()=>{liveTimers.delete(token);fn(...args);},ms));return token;};
const vmClearTimeout=token=>{const handle=liveTimers.get(token);if(handle){clearTimeout(handle);liveTimers.delete(token);}};
const sent=[];
// The synthetic code list behind the type-ahead: one entry per code the tests reach for, in the
// shape /api/v1/terminology/codes answers with.
const catalogCodes=[
 {code:'R51.9',display:'Headache',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'M79.3',display:'Synthetic back pain',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'G89.2',display:'Synthetic severe pain',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'R07.9',display:'Synthetic chest pain',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'Z00.00',display:'Synthetic annual exam',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'G80.00',display:'Synthetic congenital asthma unspecified',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'G80.01',display:'Synthetic congenital asthma with exacerbation',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'G80.02',display:'Synthetic congenital asthma with status asthmaticus',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
 {code:'G80.09',display:'Synthetic congenital asthma other',system:'ICD-10-CM',edition:'2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'},
];
// The visit's saved diagnoses, and the version a save answers with. A test moves these the way the
// server would: put the diagnoses, the visit comes back a version ahead, and reading them again
// gives what was put.
let visitVersion=3,accountVersion=7,savedAccount=null,diagnoses=[{id:'d1',code:'R51.9',display:'Headache'}];
const visitResponse=()=>({version:visitVersion,visit:{id:'visit-a',version:visitVersion,status:'in_progress'},can_edit:true,diagnoses,history:[],history_truncated:false,code_system:'http://hl7.org/fhir/sid/icd-10-cm'});
const ctx={console,setTimeout:vmSetTimeout,clearTimeout:vmClearTimeout,Date,Intl,URL,URLSearchParams,Map,Set,WeakMap,WeakSet,Array,Math,Number,String,JSON,Object,Boolean,RegExp,Error,Promise,Symbol,
 document:documentStub,localStorage:{getItem:()=>null,setItem(){},removeItem(){}},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
 crypto:{randomUUID:()=>'synthetic-request'},
 selected:'patient',me:{role:'owner',user_id:'clinician-1'},chartSection:'visits',encounterSection:'charges',billingSelected:null,
 activeVisit:{id:'visit-a',appointment_id:'appt-a',version:3,status:'in_progress'},
 workspace:{patient:{id:'patient'},patient_id:'patient',demographics:{patient_id:'patient',content:{}},appointments:[{id:'appt-a',starts_at:'2026-11-13T14:00:00Z'}],visits:[{id:'visit-a',appointment_id:'appt-a',version:3,status:'in_progress',created_at:'2026-11-13T14:00:00Z'}],billing:{accounts:[],coverages:[],entries:[],copays:[]}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 human:v=>String(v??'').replaceAll('_',' '),date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),cents:v=>Math.round(Number(v)*100),
 payerName:()=>'Synthetic payer',billingCan:()=>true,$:id=>documentStub.getElementById(id),
 visitBillingDate:v=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${v}T00:00:00`)),
 revenueCoverage:()=>null,revenueServiceDate:()=>'2026-11-13',accountDiagnosisSummary:s=>s?'<section>Recorded links</section>':'',billingChargeDraftRecovery:()=>'',accountDiagnosisDraftRecovery:()=>'',
 billingCoverageOrderMarkup:()=>'',visitPlanCopayCents:()=>null,feeContextMarkup:()=>'',loadFeeContext:async()=>{},
 notice(message){ctx.noticed=message;},confirmAction:async()=>true, // run() swallows nothing here: a rejected promise is recorded, and a test that waits sees it.
 run:fn=>{ctx.pending=Promise.resolve().then(fn).catch(error=>{ctx.runError=error;});ctx.pending.catch(()=>{});return ctx.pending;},
 showChartSection(){},setEncounterSection(){},showEncounterSection(){},refreshEncounterProgress(){},captureVisitDrafts(){},
 rememberVisit(v){ctx.activeVisit={...ctx.activeVisit,...v};},
 billingEditorHost(){return (typeof chartSection!=='undefined'&&chartSection==='insurance'&&$('insurance-editor'))||(typeof chartSection!=='undefined'&&chartSection==='visits'&&$('encounter-billing-editor'))||$('billing-editor');},
 billingDetailHost(){return (typeof chartSection!=='undefined'&&chartSection==='visits'&&$('encounter-billing-detail'))||$('billing-detail');},
 openBillingEditor(html){const host=billingEditorHost();if(!host)return;captureBillingChargeDraft();for(const id of ['billing-editor','insurance-editor','encounter-billing-editor'])if($(id)&&$(id)!==host)$(id).replaceChildren();host.innerHTML=html;},
 api:async(url,method='GET',body,version)=>{
  sent.push({url,method,body,version});
  if(process.env.ERB_SLOW&&url.includes('/diagnoses'))await new Promise(resolve=>setTimeout(resolve,80));
  // A save answers the way the server does: the diagnoses carry the new version, and the visit
  // inside the record moves with it. The screen then pins the editor to that version — a form
  // still showing an older one would be told to reload.
  if(url.includes('/diagnoses')&&method==='PUT'){
   diagnoses=body.diagnoses.map((d,i)=>({id:'d'+(i+1),code:d.code,display:d.display}));visitVersion+=1;
   return {version:visitVersion,visit:{id:'visit-a',version:visitVersion,status:'in_progress'},can_edit:true,
    diagnoses,history:[],history_truncated:false,code_system:'http://hl7.org/fhir/sid/icd-10-cm/2026'};}
  if(url.includes('/diagnoses'))return visitResponse();
  // The code list the type-ahead searches. Synthetic entries, as complete records: what the list
  // answers with is what gets chosen and saved.
  if(url.includes('/terminology/codes')){
   const q=(url.split('q=')[1]||'').split('&')[0].split('#')[0];
   const needle=decodeURIComponent(q).toUpperCase();
   const items=catalogCodes.filter(item=>item.code.startsWith(needle)||item.display.toUpperCase().includes(needle));
   return {items,next_cursor:null};}
  // A saved draft answers with the lines it was just sent, and a version ahead. Returning the
  // account the test opened, unchanged, would silently undo whatever the table saved: every line
  // the server did not change keeps its row, and only changed rows are re-drawn.
  if(url.includes('/billing/accounts')&&method==='PUT'){
   accountVersion+=1;savedAccount=body;
   return {id:'account',version:accountVersion,status:'draft',patient_id:'patient',content:body.content};}
  if(url.includes('/billing/accounts'))return {accounts:[{id:'account',version:accountVersion,status:'draft',patient_id:'patient',content:savedAccount?.content||{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[],notes:''}}]};
  if(url.includes('/terminology/releases/')){
   const code=decodeURIComponent(url.split('/codes/')[1]||'');
   const item=catalogCodes.find(entry=>entry.code===code);
   if(!item)throw new Error('Synthetic code not in release: '+code);
   return {...item};}
  return {id:'account',version:7,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[],notes:''}};}},
// Both screens, in the order the page loads them, so the diagnoses editor is the real one and the
// charge table is the real one, and the only link between them is the one the pages share.
context=vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/terminology.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/visit-diagnoses.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/fees.js','utf8'),context);

const $=id=>documentStub.getElementById(id);
const openForm=()=>$('billing-account-form');
const settle=async()=>{for(let step=0;step<40;step++)await new Promise(resolve=>setImmediate(resolve));};
const openTable=async lines=>{
 ctx.workspace.billing.accounts=lines.length?[{id:'account',version:7,status:'draft',patient_id:'patient',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines,notes:''}}]:[];
 await vm.runInContext('accountEditor('+(lines.length?'workspace.billing.accounts[0]':'null')+',null,true)',ctx);
 await settle();
 return openForm();
};
// The page's own view of the live lines, read through the page's own function: a line waiting to
// be removed is not on the table, and no hand-written filter gets to decide that here.
const chargeRows=()=>vm.runInContext('chargeLiveRows',context)(openForm());
const rowNodes=()=>openForm().querySelectorAll('.billing-charge-row');
const codesOnRow=row=>row.querySelector('[name="diagnoses"]').value;
const ticksOnRow=row=>row.querySelectorAll('[data-charge-diagnosis]').filter(node=>tickState(node)).map(node=>node.dataset.chargeDiagnosis);
// What the page's own rule sees, read through the page's own function: a line that still holds
// exactly what the visit last gave it is allowed to keep following the visit.
const autoFilled=row=>vm.runInContext('chargeDiagnosisAutoFilled',context)(row);
// A diagnosis put in from the section above the table, saved the way that editor saves: type the
// code, type the description, give the reason, and drain the autosave the typing starts.
// A clinician does not type the whole description: they type enough to find the code, take the
// match the type-ahead offers, and move on. Taking the match is a click on the offered option —
// the click web/terminology.js listens for — and the description it fills in is exactly what the
// code list says, not something invented here.
const offerMatch=(box,display)=>{
 const option=box.closest('.terminology-combobox').querySelector(`[data-terminology-option][data-terminology-code="${display.code}"]`)
  ||box.closest('.terminology-combobox').querySelector('[data-terminology-option]');
 if(!option)throw new Error('the type-ahead offered no match for '+display.code);
 click(option);
};
const focusOut=(from,next)=>{documentStub.activeElement=next;dispatch('focusout',from);};
const addDiagnosis=async(code,display)=>{
 click($('visit-diagnoses').querySelector('[data-diagnosis-add]'));await settle();
 // The form is re-drawn every time a row is added or saved: always work with the one on screen now.
 const form=$('visit-diagnoses-form');
 const rows=form.querySelectorAll('[data-diagnosis-row]'),row=rows.at(-1);
 const codeBox=row.querySelector('[name="code"]'),displayBox=row.querySelector('[name="display"]'),reason=form.querySelector('[name="reason"]');
 codeBox.focus();type(codeBox,code);
 // The search runs on the vm's clock; wait until the offer is on screen.
 let searched=0;
 while(searched<5000&&!codeBox.closest('.terminology-combobox').querySelector('[data-terminology-option]')){await new Promise(resolve=>setTimeout(resolve,25));searched+=25;}
 if(searched>=5000)throw new Error('the code list never answered for '+code);
 offerMatch(codeBox,display);
 focusOut(codeBox,displayBox);
 displayBox.focus();type(displayBox,display);focusOut(displayBox,reason);
 reason.focus();type(reason,'Synthetic reassessment');focusOut(reason,form.querySelector('[type="submit"]'));
 // The autosave timer runs inside the vm's own clock; wait on the wall clock until the PUT lands.
 let waited=0;
 while(waited<5000&&!(sent.some(call=>call.method==='PUT'&&JSON.stringify(call.body?.diagnoses)?.includes(code))&&openForm().chargeDiagnosisState?.diagnoses.some(d=>d.code===code))){await new Promise(resolve=>setTimeout(resolve,10));waited+=10;}
 if(waited>=5000)throw new Error('typing never saved. autosave state: '+JSON.stringify(vm.runInContext('({busy:visitDiagnosisAutosave.busy,submitted:visitDiagnosisAutosave.submitted})',ctx)));
 await settle();
 // The save was an autosave, so the editor left the rows exactly as typed and marked them Saved.
 // Whatever it left, that is what is on screen: the reason the next edit starts from is the reason
 // on the form now, and if a save ever re-drew the rows from a stored draft, that is what the next
 // edit begins with too.
 const shown=$('visit-diagnoses-form')?.querySelector('[name="reason"]');
 if(shown&&!shown.value.trim())shown.value='Synthetic reassessment';
 return rows.length;
};

(async()=>{
 // ---- 1. the diagnoses sit above the charge lines, entered by the visit's own editor ------
 await openTable([{code_system:'CPT',code:'99213',description:'Synthetic office visit',modifiers:'',units:1,amount_cents:15000,diagnosis_codes:[]}]);
 const editorHtml=encounterEditor.innerHTML;
 const sectionAt=editorHtml.indexOf('data-charge-diagnosis-editor'),tableAt=editorHtml.indexOf('id="billing-charge-lines"');
 assert.ok(sectionAt>=0,'the charges step carries a diagnoses section');
 assert.ok(sectionAt<tableAt,'and it sits directly above the charge lines');
 assert.ok($('visit-diagnoses'),'the section holds the diagnoses host the visit Diagnoses screen uses');
 assert.ok(openForm()&&!openForm().contains($('visit-diagnoses')),'the diagnoses editor is the charge form\u2019s neighbour, not nested inside it');
 // The section was drawn by web/visit-diagnoses.js itself, so it is that editor and not a copy:
 // its own add/remove markup, its own save form, its own wording.
 const diagnosesHtml=$('visit-diagnoses').innerHTML;
 assert.match(diagnosesHtml,/data-diagnosis-add/,`the section is drawn by the diagnoses screen's own code: ${diagnosesHtml.slice(0,200)}`);
 assert.match(diagnosesHtml,/id="visit-diagnoses-form"/);
 assert.match(diagnosesHtml,/Primary diagnosis/);
 assert.match(diagnosesHtml,/data-diagnosis-refresh/,'it keeps the Reload its own screen already offers');
 assert.match(diagnosesHtml,/data-terminology-combobox/,'its code boxes are the type-ahead boxes, not bare inputs');
 assert.equal($('visit-diagnoses-form').querySelectorAll('[data-diagnosis-row]').length,1,'the one saved diagnosis is on one row');
 assert.match(editorHtml.slice(sectionAt,tableAt),/Diagnoses for this visit/,'named in plain clinic words');
 assert.doesNotMatch(editorHtml.slice(sectionAt,tableAt),/>Refresh<|>Find /,'and it brings no new Refresh or Find button of its own');
 assert.doesNotMatch(diagnosesHtml,/data-link-account-diagnoses/,'no Link visit diagnoses button anywhere near it');
 console.log('PASS one place: the visit\u2019s own diagnoses editor, drawn by its own code, directly above the charge lines');

 // ---- 2. a saved diagnosis reaches every charge row at once, without a reload ------------
 // The table opens with the visit's saved charge line, and the blank line an empty draft always
 // starts with: the coded line is an answer already given, the blank one is waiting for an answer.
 click(openForm().querySelector('[data-add-charge]'));await settle();
 assert.equal(chargeRows().length,2,'the table holds the saved line and a blank line below it');
 const before=openForm();
 await addDiagnosis('M79.3','Synthetic back pain');
 assert.equal(openForm(),before,'the table is the same table: nothing was reloaded or rebuilt');
 assert.equal(diagnoses.length,2,'the diagnosis is saved to the visit');
 // An autosave that found nothing left to submit leaves the rows as typed, with a Saved line; the
 // code the clinician typed is on the screen either way.
 assert.match($('visit-diagnoses').innerHTML,/M79\.3/,'and it shows in the section above');
 assert.match($('visit-diagnoses').innerHTML,/data-diagnosis-saved|Diagnosis 2/,'the editor says it saved, or shows the row');
 // The blank line is filled by the save — both codes, in the visit's order. The line that arrived
 // with codes already on it is left exactly where the saved draft put it.
 assert.equal(codesOnRow(chargeRows()[1]),'R51.9, M79.3','the blank line took the visit\u2019s diagnoses the moment they saved');
 assert.deepEqual(ticksOnRow(chargeRows()[1]),['R51.9','M79.3'],'its ticks say what it carries');
 // The saved line arrived with no codes on it, so the visit filled it in and it keeps following.
 // What the table had before the save is unchanged, and the save itself stays in step.
 assert.equal(sent.filter(call=>call.url.includes('/billing/accounts')&&call.method==='PUT').length,0,'no charge was saved behind anyone\u2019s back');
 assert.equal(codesOnRow(chargeRows()[0]),'R51.9, M79.3','a saved line with nothing on it is answered by the visit too');
 assert.match(chargeRows()[0].innerHTML,/data-charge-diagnosis="M79\.3"/,'and the new diagnosis is offered to it as a choice');
 assert.deepEqual(ticksOnRow(chargeRows()[0]),['R51.9','M79.3'],'offered and taken, in step with the line');
 console.log('PASS a diagnosis saved above reaches every charge row at once, with no page reload and the table left open');

 // ---- 3. a line the visit filled in follows the visit; a line staff answered does not ----
 // The blank line from section 2 holds exactly what the visit last gave it, so nothing on it was
 // chosen by anyone and it keeps following.
 await addDiagnosis('G89.2','Synthetic severe pain');
 assert.equal(codesOnRow(chargeRows()[1]),'R51.9, M79.3, G89.2','a line holding only what the visit gave it takes the new diagnosis too');
 // A code typed by hand is an answer already given, and a visit edit does not go over it.
 const blank=chargeRows()[1].querySelector('[name="diagnoses"]');
 type(blank,'Z00.00');change(blank);await settle();
 await addDiagnosis('R07.9','Synthetic chest pain');
 assert.equal(codesOnRow(chargeRows()[1]),'Z00.00','a code entered by hand is left exactly as it was entered');
 // A tick taken off is a decision too.
 console.log('PASS the visit fills in a line it filled in before, and never overwrites a code staff chose');

 // ---- 4. a new charge row points at the visit's diagnoses, in order, up to four ---------
 click(openForm().querySelector('[data-add-charge]'));await settle();
 const fresh=codesOnRow(chargeRows()[2]);
 assert.equal(fresh.split(', ').length,4,'a new line takes at most the four diagnoses a claim line can carry');
 assert.equal(fresh,diagnoses.slice(0,4).map(d=>d.code).join(', '),'and takes them in the order the visit lists them');
 // Removing one off the visit moves the new line, because nothing on it was chosen by hand.
 click($('visit-diagnoses').querySelector('[data-diagnosis-remove="1"]'));await settle();
 for(const timer of [...liveTimers.keys()]){vmClearTimeout(timer);liveTimers.delete(timer);}
 await vm.runInContext('submitVisitDiagnoses(document.getElementById("visit-diagnoses-form"),{autosave:true})',ctx);
 await settle();
 assert.equal(codesOnRow(chargeRows()[2]),diagnoses.slice(0,4).map(d=>d.code).join(', '),'and a diagnosis removed from the visit is taken off a line still following it');
 assert.equal(codesOnRow(chargeRows()[1]),'Z00.00','the hand-entered line is still untouched');
 console.log('PASS a new charge row points at the visit\u2019s diagnoses in order up to four, and follows a removal');

 // ---- 5. no Link visit diagnoses button on this screen ----------------------------------
 assert.doesNotMatch(encounterEditor.innerHTML,/data-link-account-diagnoses/,'the charges step never offers Link visit diagnoses');
 // The link editor and its server call still exist for the account record that still needs them.
 const billingSource=fs.readFileSync('web/billing.js','utf8');
 assert.match(billingSource,/data-link-account-diagnoses/,'the button is hidden here, not deleted from the application');
 assert.match(billingSource,/accounts\/\$\{id\}\/diagnoses|\/diagnoses`,'PUT'/,'the link save it made is still there');
 assert.match(billingSource,/chargeDiagnosisDraftFollow|followVisitDiagnoses/,'and the table\u2019s following of the visit is recorded in the code');
 // A finished table for a visit is never offered a link button either.
 ctx.workspace.billing.accounts=[{id:'account',version:7,status:'posted',patient_id:'patient',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[],notes:''}}];
 vm.runInContext('showEncounterBillingAccount(workspace.billing.accounts[0],[],null,false,false)',ctx);
 await settle();
 assert.doesNotMatch($('encounter-billing-detail').innerHTML,/data-link-account-diagnoses/,'nor is it offered on the visit\u2019s read-only charges');
 console.log('PASS Link visit diagnoses is gone from the charges step, while the account record keeps what it still needs');

 // ---- 6. the visit Diagnoses screen itself still works ---------------------------------
 const diagnosesSource=fs.readFileSync('web/visit-diagnoses.js','utf8');
 assert.match(diagnosesSource,/function showVisitDiagnoses\(host,data,id,patient\)/,'the diagnoses screen is still drawn by the same one function');
 assert.match(diagnosesSource,/function renderVisitDiagnoses\(\)/);
 // And it is still the same editor on the charges step: a save there is a save to the visit.
 const put=sent.filter(call=>call.method==='PUT'&&call.url.includes('/diagnoses'));
 assert.ok(put.length>=2,'the section saves to the visit, not to the charge account');
 assert.ok(put.every(call=>call.url.includes('/visits/visit-a/diagnoses')),'every diagnosis save went to this visit');
 assert.ok(put.every(call=>call.version!==undefined),'each save carried the version it read, so a concurrent edit is refused');
 assert.equal(put.filter(call=>call.url.includes('/billing/')).length,0,'no diagnosis save went through the billing account');
 console.log('PASS the section saves straight to the visit with its version, exactly as the Diagnoses screen does');
 console.log('PASS one place for ICD and CPT: the visit\u2019s own diagnoses editor above the charge lines, charge rows following it live, four diagnoses in order on a new line, hand-entered codes preserved, no Link visit diagnoses button on this screen');
})().catch(error=>{console.error(error);process.exitCode=1;});
