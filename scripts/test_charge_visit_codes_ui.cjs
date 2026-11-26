// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One place for the codes an encounter is billed on: the encounter's own diagnoses sit directly above its
// charge lines, entered by the very editor the encounter's Diagnoses screen uses (web/visit-diagnoses.js
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
// The encounter's saved diagnoses, and the version a save answers with. A test moves these the way the
// server would: put the diagnoses, the encounter comes back a version ahead, and reading them again
// gives what was put.
let visitVersion=3,accountVersion=7,savedAccount=null,nextChargeError=null,diagnosesEditable=true,diagnoses=[{id:'d1',code:'R51.9',display:'Headache'}];
const visitResponse=()=>({version:visitVersion,visit:{id:'visit-a',version:visitVersion,status:'in_progress'},can_edit:diagnosesEditable,diagnoses,history:[],history_truncated:false,code_system:'http://hl7.org/fhir/sid/icd-10-cm'});
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
  // A save answers the way the server does: the diagnoses carry the new version, and the encounter
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
   if(nextChargeError){const error=nextChargeError;nextChargeError=null;throw error;}
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
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&(!openForm()?.chargeDiagnosisState||openForm().chargeDiagnosisState.loading||!$('visit-diagnoses-form')))await new Promise(resolve=>setTimeout(resolve,10));
 await settle();
 return openForm();
};
// The page's own view of the live lines, read through the page's own function: a line waiting to
// be removed is not on the table, and no hand-written filter gets to decide that here.
const chargeRows=()=>vm.runInContext('chargeLiveRows',context)(openForm());
const rowNodes=()=>openForm().querySelectorAll('.billing-charge-row');
const codesOnRow=row=>row.querySelector('[name="diagnoses"]').value;
// The chips on a line, and which of them read as taken: a chip is a button, so whether it is taken
// comes off the markup the page wrote for it, not off a checkbox that is no longer there.
const ticksOnRow=row=>row.querySelectorAll('[data-charge-diagnosis]').filter(node=>String(node.getAttribute('aria-pressed'))==='true'||node.attrs['data-chip-on']!==undefined).map(node=>node.dataset.chargeDiagnosis);
// What the page's own rule sees, read through the page's own function: a line that still holds
// exactly what the encounter last gave it is allowed to keep following the encounter.
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
 const details=reason.closest('details');if(details)details.open=true;
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
 // ---- 1. the diagnoses sit above the charge lines, entered by the encounter's own editor ------
 await openTable([{code_system:'CPT',code:'99213',description:'Synthetic office visit',modifiers:'',units:1,amount_cents:15000,diagnosis_codes:[]}]);
 const editorHtml=encounterEditor.innerHTML;
 const sectionAt=editorHtml.indexOf('data-charge-diagnosis-editor'),tableAt=editorHtml.indexOf('id="billing-charge-lines"');
 assert.ok(sectionAt>=0,'the charges step carries a diagnoses section');
 assert.ok(sectionAt<tableAt,'and it sits directly above the charge lines');
 assert.ok($('visit-diagnoses'),'the section holds the diagnoses host the encounter Diagnoses screen uses');
 assert.ok(openForm()&&!openForm().contains($('visit-diagnoses')),'the diagnoses and procedures use separate forms in the same editor');
 assert.equal($('visit-diagnoses-form').tag,'form');
 assert.ok(openForm().contains($('billing-charge-lines')));
 // The section was drawn by web/visit-diagnoses.js itself, so it is that editor and not a copy:
 // its own add/remove markup, its own save form, its own wording.
 const diagnosesHtml=$('visit-diagnoses').innerHTML;
 assert.match(diagnosesHtml,/data-diagnosis-add/,`the section is drawn by the diagnoses screen's own code: ${diagnosesHtml.slice(0,200)}`);
 assert.match(diagnosesHtml,/id="visit-diagnoses-form"/);
 assert.match(diagnosesHtml,/Primary diagnosis/);
 assert.ok($('visit-diagnoses-form').querySelector('[data-diagnosis-up]').hasAttribute('disabled'),'the primary diagnosis is already first');
 assert.match(diagnosesHtml,/data-diagnosis-refresh/,'it keeps the Reload its own screen already offers');
 assert.match(diagnosesHtml,/data-terminology-combobox/,'its code boxes are the type-ahead boxes, not bare inputs');
 assert.equal($('visit-diagnoses-form').querySelectorAll('[data-diagnosis-row]').length,1,'the one saved diagnosis is on one row');
 assert.match(editorHtml.slice(sectionAt,tableAt),/<h3>Diagnoses<\/h3>/,'named in one plain word, no developer wording');
 // Headings and buttons in plain words: the section is 'Diagnoses', the lines below are
// 'Procedures', and nothing here is called an encounter, a pointer or a link.
 assert.match(editorHtml.slice(tableAt,editorHtml.indexOf('</thead>',tableAt)),/<th>Procedure<\/th><th>Modifiers<\/th><th>Units<\/th><th>Diagnoses<\/th><th>Amount<\/th>/,'the lines are headed Procedure, not Code / Description');
 assert.doesNotMatch(editorHtml.slice(sectionAt,tableAt),/>Refresh<|>Find |<h3>[^<]*(Encounter|Diagnosis Pointer|Diagnosis Link)/,'no new Refresh or Find button, and no developer wording in any heading');
 assert.doesNotMatch(editorHtml,/<h3>[^<]*(Encounter|Procedure Codes|Charge Lines)/,'the charge table is not headlined with a developer term either');
 // The encounter's diagnoses are lettered, in the encounter's order, so a charge line can name one with a
 // letter instead of making anyone read a code back.
 const lettersAt=diagnosesHtml.indexOf('charge-dx-letter');
 assert.ok(lettersAt>=0,'the first diagnosis carries its letter');
 assert.match(diagnosesHtml.slice(lettersAt,lettersAt+60),/>A<\/span>/,'and it is A, the first the encounter lists');
 assert.ok(diagnosesHtml.indexOf('charge-dx-letter')<diagnosesHtml.indexOf('data-diagnosis-remove'),'the letter is on the row it belongs to, beside its buttons');
 // A second diagnosis drawn above is lettered B in front of its own words: the editor writes the
 // letter into each row as it writes the row, so the letters cannot fall behind the list.
 const secondRow=$('visit-diagnoses').innerHTML.slice($('visit-diagnoses').innerHTML.indexOf('data-diagnosis-row'));
 assert.ok(!/data-diagnosis-remove="1"/.test(secondRow),'the encounter holds one diagnosis so far');
 assert.match(vm.runInContext('diagnosisLetterBadge(1)',ctx),/>B</,'the editor asks for B at the second row');
 assert.match(vm.runInContext('diagnosisLetterBadge(0)',ctx),/>A</,'and A at the first');
 assert.doesNotMatch(diagnosesHtml,/data-link-account-diagnoses/,'no Link visit diagnoses button anywhere near it');
 console.log('PASS one place: the encounter\u2019s own diagnoses editor, drawn by its own code, directly above the charge lines');

 // ---- 2. a saved diagnosis reaches every charge row at once, without a reload ------------
 // The table opens with the encounter's saved charge line, and the blank line an empty draft always
 // starts with: the coded line is an answer already given, the blank one is waiting for an answer.
 click(openForm().querySelector('[data-add-charge]'));await settle();
 assert.equal(chargeRows().length,2,'the table holds the saved line and a blank line below it');
 const before=openForm();
 await addDiagnosis('M79.3','Synthetic back pain');
 assert.equal(openForm(),before,'the table is the same table: nothing was reloaded or rebuilt');
 assert.equal(diagnoses.length,2,'the diagnosis is saved to the encounter');
 // An autosave that found nothing left to submit leaves the rows as typed, with a Saved line; the
 // code the clinician typed is on the screen either way.
 assert.match($('visit-diagnoses').innerHTML,/M79\.3/,'and it shows in the section above');
 assert.match($('visit-diagnoses').innerHTML,/data-diagnosis-saved|Diagnosis 2/,'the editor says it saved, or shows the row');
 // The blank line is filled by the save — both codes, in the encounter's order. The line that arrived
 // with codes already on it is left exactly where the saved draft put it.
 assert.equal(codesOnRow(chargeRows()[1]),'R51.9, M79.3','the blank line took the encounter\u2019s diagnoses the moment they saved');
 assert.deepEqual(ticksOnRow(chargeRows()[1]),['R51.9','M79.3'],'and its chips say what it carries');
 assert.match(chargeRows()[1].innerHTML,/A \(R51\.9\), B \(M79\.3\)/,'the line says it in the letters the section above shows');
 // A saved line can be explicitly unlinked. New encounter diagnoses are available for selection.
 assert.ok(!openForm().chargeSaveTimer,'defaulting only a blank service must not queue a charge save');
 assert.equal(sent.filter(call=>call.url.includes('/billing/accounts')&&call.method==='PUT').length,0,'no charge was saved behind anyone\u2019s back');
 assert.equal(codesOnRow(chargeRows()[0]),'','the saved empty diagnosis selection is preserved');
 assert.match(chargeRows()[0].innerHTML,/data-charge-diagnosis="M79\.3"/,'and the new diagnosis is offered to it as a chip');
 assert.deepEqual(ticksOnRow(chargeRows()[0]),[],'new diagnoses are available without changing the saved selection');
 // A second letter appears on every line the moment the second diagnosis saves above: the two
 // screens are one form, so nobody has to reopen or refresh anything to find it.
 assert.match(chargeRows()[0].querySelector('[data-charge-diagnoses]').innerHTML,/>A<\/span>[\s\S]*>B<\/span>/,'and the chips are lettered the same way as the list above');
 console.log('PASS a diagnosis saved above reaches every charge row at once, with no page reload and the table left open');

 // ---- 3. a line the encounter filled in follows the encounter; a line staff answered does not ----
 // The blank line from section 2 holds exactly what the encounter last gave it, so nothing on it was
 // chosen by anyone and it keeps following.
 await addDiagnosis('G89.2','Synthetic severe pain');
 assert.equal(codesOnRow(chargeRows()[1]),'R51.9, M79.3, G89.2','a line holding only what the encounter gave it takes the new diagnosis too');
 // A code typed by hand is an answer already given, and an encounter edit does not go over it.
 const blank=chargeRows()[1].querySelector('[name="diagnoses"]');
 assert.equal(blank.getAttribute('type'),'hidden','the line keeps the same field it always submitted, now filled by the chips');
 assert.ok(!/<label>Diagnoses for this service/.test(chargeRows()[1].innerHTML),'and no free-text box is offered for it');
 type(blank,'Z00.00');change(blank);await settle();
 await addDiagnosis('R07.9','Synthetic chest pain');
 assert.equal(codesOnRow(chargeRows()[1]),'Z00.00','a code entered by hand is left exactly as it was entered');
 console.log('PASS the encounter fills in a line it filled in before, and never overwrites an answer staff gave');

 // ---- 3b. a fifth diagnosis saved above is on offer to every line -----------------------
 // The encounter now lists five diagnoses while a claim line carries four: the fifth is offered as a
 // chip on every line, so the person deciding can take it on the line that needs it.
 await addDiagnosis('Z00.00','Synthetic annual exam');
 assert.ok(diagnoses.length>4,'the encounter lists more diagnoses than one line can carry');
 assert.ok(chargeRows().every(row=>row.querySelectorAll('[data-charge-diagnosis]').length===diagnoses.length),'every line offers all five as chips the moment they save');
 console.log('PASS a diagnosis saved above is offered on every line at once, as one chip per letter');

 // ---- 3c. pressing a chip is the line's own answer --------------------------------------
 // Pressed through the same click the page answers on, with the state read off the chip's own
 // markup the way a browser reads it off the button.
 const pressed=(row,code)=>{
  const chip=row.querySelectorAll('[data-charge-diagnosis]').find(node=>node.dataset.chargeDiagnosis===code);
  if(!chip)throw new Error('the line offers no chip for '+code);
  return dispatch('click',chip);
 };
 const chosen=(row,code)=>row.querySelectorAll('[data-charge-diagnosis]').some(node=>node.dataset.chargeDiagnosis===code&&String(node.getAttribute('aria-pressed'))==='true');
// Letters the encounter lists that this line has not taken, read off the chips the page drew.
const chargeDiagnosisFree=row=>row.querySelectorAll('[data-charge-diagnosis]').map(node=>node.dataset.chargeDiagnosis).filter(code=>!ticksOnRow(row).includes(code));
 const line=chargeRows().at(-1);
 const held=chargeDiagnosisFree(line);
 assert.ok(held.length,'one of them is offered to this line and not yet taken: '+held.join(', '));
 const spare=held[0];
 const had=codesOnRow(line);
 pressed(line,spare);
 assert.equal(codesOnRow(line),[...had.split(', ').filter(Boolean),spare].join(', '),'pressing a letter adds that diagnosis to the line');
 assert.ok(chosen(line,spare),'and the chip shows as taken');
 assert.ok(line.querySelector('[name="diagnoses"]').value.includes(spare),'the code itself is on the field the line submits');
 pressed(line,spare);
 assert.equal(codesOnRow(line),had,'pressing it again takes it back off');
 // From here the line has answered for itself: a further diagnosis saved above does not move it.
 const beforePress=codesOnRow(line);
 await addDiagnosis('G80.01','Synthetic congenital asthma with exacerbation');
 assert.equal(codesOnRow(line),beforePress,'a line someone pressed a chip on is left exactly as they left it');
 assert.ok(chargeDiagnosisFree(line).includes('G80.01'),'while its letter is still offered, unpressed, for anyone who wants it');
 console.log('PASS a chip press writes the codes the line submits, comes back off, and makes the line the person\u2019s own answer');

 // ---- 4. a new charge row points at the encounter's diagnoses, in order, up to four ---------
 click(openForm().querySelector('[data-add-charge]'));await settle();
 const fresh=codesOnRow(chargeRows()[2]);
 assert.equal(fresh.split(', ').length,4,'a new line takes at most the four diagnoses a claim line can carry');
 assert.equal(fresh,diagnoses.slice(0,4).map(d=>d.code).join(', '),'and takes them in the order the encounter lists them');
 // Removing one off the encounter moves the new line, because nothing on it was chosen by hand.
 click($('visit-diagnoses').querySelector('[data-diagnosis-remove="1"]'));await settle();
 for(const timer of [...liveTimers.keys()]){vmClearTimeout(timer);liveTimers.delete(timer);}
 await vm.runInContext('submitVisitDiagnoses(document.getElementById("visit-diagnoses-form"),{autosave:true})',ctx);
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&openForm().chargeDiagnosisState?.version!==visitVersion)await new Promise(resolve=>setTimeout(resolve,10));
 await settle();
 assert.equal(codesOnRow(chargeRows()[2]),diagnoses.slice(0,4).map(d=>d.code).join(', '),'and a diagnosis removed from the encounter is taken off a line still following it');
 assert.equal(codesOnRow(chargeRows()[1]),'Z00.00','the hand-entered line is still untouched');
 // The four letters a new line took are shown as taken, in the encounter's order.
 assert.deepEqual(ticksOnRow(chargeRows()[2]),diagnoses.slice(0,4).map(d=>d.code),'and the chips show exactly those four as taken');
 // A fifth letter is refused: a claim line carries four. The words are the claim rule, not a code.
 const following=chargeRows()[2],offered=following.querySelectorAll('[data-charge-diagnosis]').length;
 assert.ok(offered>4,'the encounter now lists more diagnoses than one line can carry: '+offered);
 const fifth=following.querySelectorAll('[data-charge-diagnosis]').find(node=>!ticksOnRow(following).includes(node.dataset.chargeDiagnosis));
 ctx.noticed=undefined;
 pressed(following,fifth.dataset.chargeDiagnosis);
 assert.equal(codesOnRow(following),diagnoses.slice(0,4).map(d=>d.code).join(', '),'the fifth is not written onto the line');
 assert.equal(ctx.noticed,'A line can point to 4 diagnoses.','and the reason is said in clinic words: '+ctx.noticed);
 assert.ok(ticksOnRow(following).length<=4,'the line never ends up holding more than four');
 console.log('PASS a new charge row points at the encounter\u2019s diagnoses in order up to four, follows a removal, and refuses a fifth in words');

 // Clear the last pointer while the previous change is being saved. The newer choice survives
 // the server reply, the follow-up save, and a new editor built from the saved lines.
 const first=chargeRows()[0],chosenCode=first.querySelector('[data-charge-diagnosis]').dataset.chargeDiagnosis;
 const chipLetter=()=>first.querySelectorAll('[data-charge-diagnosis]').find(chip=>chip.dataset.chargeDiagnosis===chosenCode).querySelector('.charge-dx-chip-letter');
 click(chipLetter());
 assert.equal(codesOnRow(first),chosenCode,'clicking the visible letter selects the diagnosis');
 const originalApi=ctx.api;
 let releaseSave;
 ctx.api=(url,method,...args)=>method==='PUT'&&url.includes('/billing/accounts')
  ?new Promise(resolve=>{releaseSave=()=>resolve(originalApi(url,method,...args));})
  :originalApi(url,method,...args);
 const pending=ctx.saveChargeTable(openForm());
 assert.equal(typeof releaseSave,'function','the first selection is being saved');
 click(chipLetter());
 assert.equal(codesOnRow(first),'');
 await ctx.refreshChargeEncounterDiagnoses(openForm());
 assert.deepEqual(ticksOnRow(first),[],'an encounter refresh preserves the manual empty selection');
 ctx.api=originalApi;releaseSave();await pending;
 assert.equal(codesOnRow(chargeRows()[0]),'','the older save cannot restore its diagnosis');
 await ctx.saveChargeTable(openForm());
 assert.equal(savedAccount.content.lines[0].diagnosis_codes.length,0);
 await openTable(savedAccount.content.lines);
 await ctx.refreshChargeEncounterDiagnoses(openForm());
 assert.equal(codesOnRow(chargeRows()[0]),'');
 assert.deepEqual(ticksOnRow(chargeRows()[0]),[]);
 console.log('PASS an explicit empty diagnosis selection survives a delayed save, redraw and encounter refresh');

 // ---- 5. no Link visit diagnoses button on this screen ----------------------------------
 assert.doesNotMatch(encounterEditor.innerHTML,/data-link-account-diagnoses/,'the charges step never offers Link visit diagnoses');
 // The link editor and its server call still exist for the account record that still needs them.
 const billingSource=fs.readFileSync('web/billing.js','utf8');
 assert.match(billingSource,/data-link-account-diagnoses/,'the button is hidden here, not deleted from the application');
 assert.match(billingSource,/accounts\/\$\{id\}\/diagnoses|\/diagnoses`,'PUT'/,'the link save it made is still there');
 assert.match(billingSource,/chargeDiagnosisDraftFollow|followVisitDiagnoses/,'and the table\u2019s following of the encounter is recorded in the code');
 // A finished table for an encounter is never offered a link button either.
 ctx.workspace.billing.accounts=[{id:'account',version:7,status:'posted',patient_id:'patient',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[],notes:''}}];
 vm.runInContext('showEncounterBillingAccount(workspace.billing.accounts[0],[],null,false,false)',ctx);
 await settle();
 assert.doesNotMatch($('encounter-billing-detail').innerHTML,/data-link-account-diagnoses/,'nor is it offered on the encounter\u2019s read-only charges');
 console.log('PASS Link visit diagnoses is gone from the charges step, while the account record keeps what it still needs');

 // ---- 6. the encounter Diagnoses screen itself still works ---------------------------------
 const diagnosesSource=fs.readFileSync('web/visit-diagnoses.js','utf8');
 assert.match(diagnosesSource,/function showVisitDiagnoses\(host,data,id,patient\)/,'the diagnoses screen is still drawn by the same one function');
 assert.match(diagnosesSource,/function renderVisitDiagnoses\(/);
 // And it is still the same editor on the charges step: a save there is a save to the encounter.
 const put=sent.filter(call=>call.method==='PUT'&&call.url.includes('/diagnoses'));
 assert.ok(put.length>=2,'the section saves to the encounter, not to the charge account');
 assert.ok(put.every(call=>call.url.includes('/visits/visit-a/diagnoses')),'every diagnosis save went to this encounter');
 assert.ok(put.every(call=>call.version!==undefined),'each save carried the version it read, so a concurrent edit is refused');
 assert.equal(put.filter(call=>call.url.includes('/billing/')).length,0,'no diagnosis save went through the billing account');
 console.log('PASS the section saves straight to the encounter with its version, exactly as the Diagnoses screen does');

 const coding=await openTable([{code_system:'CPT',code:'99213',description:'Synthetic office visit',modifiers:'',units:1,amount_cents:15000,diagnosis_codes:[diagnoses[0].code]}]);
 const diagnosisForm=$('visit-diagnoses-form');
 const display=diagnosisForm.querySelector('[name="display"]');
 const amount=chargeRows()[0].querySelector('[name="amount"]');
 amount.name='amount';
 const beforeCodingSave=sent.length;
 type(display,'Revised synthetic description');
 type(diagnosisForm.querySelector('[name="reason"]'),'Synthetic reassessment');
 type(amount,'170.00');
 nextChargeError=new Error('Synthetic charge write failed');
 await ctx.flushVisitCodeDiagnoses(diagnosisForm);
 const current=()=>ctx.activeVisit.id==='visit-a';
 await assert.rejects(ctx.flushEncounterProcedures(coding,current),/Procedure changes could not be saved|Synthetic charge write failed/);
 const writes=()=>sent.slice(beforeCodingSave).filter(call=>call.method==='PUT');
 assert.deepEqual(writes().map(call=>call.url),['/api/v1/visits/visit-a/diagnoses','/api/v1/patients/patient/billing/accounts/account']);
 assert.match(coding.querySelector('[data-charge-status]').textContent,/Synthetic charge write failed/);
 assert.equal(amount.value,'170.00','the failed procedure value stays in the same form');
 await ctx.flushEncounterProcedures(coding,current);
 assert.equal(writes().filter(call=>call.url.includes('/diagnoses')).length,1,'a retry does not save the successful diagnosis a second time');
 assert.equal(writes().at(-1).body.content.lines[0].amount_cents,17000);
 const currentVisit=ctx.activeVisit,committed=sent.length;
 ctx.activeVisit={...currentVisit,id:'visit-b'};
 await ctx.saveChargeTable(coding);
 assert.equal(sent.length,committed,'the old charge form cannot save into another open encounter');
 ctx.activeVisit=currentVisit;
 console.log('PASS the autosave retry preserves partial success and does not write after switching encounters');
 vm.runInContext(fs.readFileSync('web/visit-note.js','utf8'),context);
 ctx.me={role:'owner'};ctx.workspaceResourceAllowed=()=>true;ctx.activeVisit=ctx.workspace.visits[0];ctx.encounterChargeAccount=()=>ctx.encounterChargeAccountFor(ctx.activeVisit.id);
 let priorError;ctx.showVisitNoteMessage=message=>{priorError=message;};
 const prior={id:'old',patient_id:'patient',status:'posted',content:{visit_id:'previous',service_date:'2026-10-02',lines:[{code:'99214',description:'Synthetic earlier service',units:2,modifiers:'25',amount_cents:75000,diagnosis_codes:['OLD']}]}};
 ctx.workspace.visits.push({id:'previous',patient_id:'patient'},{id:'other-visit',patient_id:'other-patient'});
 ctx.workspace.billing.accounts=[prior,{...prior,id:'other',patient_id:'other-patient',content:{...prior.content,visit_id:'other-visit',service_date:'2026-11-11',lines:[{code:'99999',description:'Another patient’s procedure'}]}}];
 vm.runInContext('accountEditor(null,null,true)',ctx);await settle();
 encounterEditor.insertAdjacentHTML('afterbegin',ctx.visitNoteInlineProceduresMarkup());
 await ctx.visitNoteInlineMount();
 const choices=$('note-previous-procedures');assert(choices);assert.deepEqual(Array.from(choices.noteLines,line=>line.code),['99214']);
 assert.equal(choices.noteLines[0].amount_cents,null);assert.equal(choices.noteLines[0].diagnosis_codes.length,0);
 assert.ok(chargeRows().every(row=>!row.querySelector('[name="code"]').value),'opening the chooser never adds a prior service');
 const button=choices.querySelector('[data-note-previous-procedure]');click(button);await settle();assert.equal(priorError,undefined);
 assert.equal(chargeRows()[0].querySelector('[name="code"]').value,'99214');assert.equal(chargeRows()[0].querySelector('[name="units"]').value,'2');
 console.log('PASS an explicit prior-service choice uses this patient’s earlier visit and excludes the earlier price and diagnoses');
 console.log('PASS one encounter editor: the encounter\u2019s diagnoses lettered A, B, C above the lines, one chip per letter on every line writing the codes the line submits, four to a line with the limit said in words, one row per procedure with the totals under the lines, and no Link visit diagnoses button on this screen');
})().catch(error=>{console.error(error);process.exitCode=1;});
